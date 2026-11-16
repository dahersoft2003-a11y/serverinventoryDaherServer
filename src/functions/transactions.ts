import {
  reconcileCustomerBalanceInternal,
  updateCustomerBalanceInternal,
  updateCustomerInternal,
} from "../controllers/customer.controller";
import { createPaymentInternal } from "../controllers/payments.controller";
import {
  adjustProductQuantityInternal,
  assertProductAvailableForSellInternal,
  createOrUpdateProductInternal,
  getProductByIdInternal,
  resetProductsCache,
  updateQuantityOnSell,
} from "../controllers/products.controller";
import {
  getPurchaseByIdInternal,
  updatePurchaseInternal,
} from "../controllers/purchases.controller";
import { createReturnInternal } from "../controllers/returns.controller";
import {
  getReturnableProductFromSellInternal,
  createSellInternal,
  returnProductsFromSellInternal,
} from "../controllers/sells.controller";
import { updateSupplierBalanceInternal } from "../controllers/suppliers.controller";
import { createTransferInternal } from "../controllers/transfer.controller";
import { updateAccountBalanceInternal } from "../controllers/account.controller";
import { createJournalEntryInternal } from "../controllers/journalEntries.controller";
import { Payment } from "../types/payment";
import { prepareDriverRefundPayments } from "../utils/driverCommission";
import { applyCashPartySettlement } from "../utils/cashPartySettlement";
import { normalizeCashPaymentMoney } from "../utils/cashPaymentInput";
import { createHash, randomUUID } from "crypto";
import { Product, ProductPriceType } from "../types/product";
import { purchase } from "../types/purchase";
import { sell } from "../types/sell";
import { database } from "../firebaseConfig";
import { get, ref, update, runTransaction } from "firebase/database";
import {
  buildInvoiceMoneyBreakdown,
  normalizeCurrency,
  roundMoney,
  toMoneyNumber,
} from "../utils/money";
import {
  calculateSaleReturn,
  CustomerReturnType,
  SaleReturnLineInput,
} from "../utils/saleReturn";
import { applyProductPurchaseSettlement } from "../utils/productPurchaseSettlement";
import { applyProductSaleSettlement } from "../utils/productSaleSettlement";
type SellStockUpdater = (product: sell["products"][number]) => Promise<void>;
type LedgerEntry = {
  accountId?: string;
  entryType: "debit" | "credit";
  amount?: number;
  currency?: "SYP";
};
const standardPriceTypes: ProductPriceType[] = [
  "payPrice",
  "wholesalePrice",
  "superWholesalePrice",
  "sellPrice",
];
const normalizeSelectedPriceType = (value: unknown): ProductPriceType => {
  const next = String(value || "custom");
  return [...standardPriceTypes, "custom"].includes(next as ProductPriceType)
    ? (next as ProductPriceType)
    : "custom";
};
const toFiniteNumber = (value: unknown, fallback = 0) => {
  const next = Number(value);
  return Number.isFinite(next) ? next : fallback;
};
const hasSubmittedValue = (value: unknown) => {
  return value !== undefined && value !== null && String(value).trim() !== "";
};
const stripUndefinedFields = <T extends Record<string, any>>(value: T): T =>
  Object.fromEntries(
    Object.entries(value).filter(([, entryValue]) => entryValue !== undefined),
  ) as T;
const getSubmittedDiscountAmount = (invoice: {
  discount?: unknown;
  discountAmount?: unknown;
  discountPercent?: unknown;
}) => {
  if (hasSubmittedValue(invoice.discountAmount)) {
    return toFiniteNumber(invoice.discountAmount);
  }
  if (hasSubmittedValue(invoice.discount)) {
    return toFiniteNumber(invoice.discount);
  }
  if (hasSubmittedValue(invoice.discountPercent)) {
    return 0;
  }
  return toFiniteNumber(invoice.discount);
};
const getSubmittedDiscountPercent = (invoice: { discountPercent?: unknown }) =>
  toFiniteNumber(invoice.discountPercent);
const assertInvoiceDiscountIsValid = ({
  subtotal: subtotalAmount,
  discountPercent,
  discountAmount: fixedDiscountAmount,
}: {
  subtotal: number;
  discountPercent: number;
  discountAmount: number;
}) => {
  if (discountPercent < 0 || discountPercent > 100) {
    throw new Error("Discount percent must be between 0 and 100");
  }
  if (fixedDiscountAmount < 0) {
    throw new Error("Discount amount cannot be negative");
  }
  if (subtotalAmount <= 0) {
    if (discountPercent > 0 || fixedDiscountAmount > 0) {
      throw new Error("Discount must be less than invoice subtotal");
    }
    return;
  }
  const percentDiscountAmount = roundMoney(subtotalAmount * (discountPercent / 100));
  const discountAmount = roundMoney(percentDiscountAmount + fixedDiscountAmount);
  if (discountAmount >= subtotalAmount) {
    throw new Error("Discount must be less than invoice subtotal");
  }
};
const normalizePaymentStatus = (value: unknown): "cash" | "part" | "debt" => {
  return value === "cash" || value === "part" || value === "debt" ? value : "debt";
};
const buildMoneyFromSubmittedInvoice = ({
  totalPrice: totalAmount,
  subtotal: subtotalAmount,
  paymentStatus,
  currency,
  partValue,
  remainingDebt,
  discount: discountAmount,
  discountAmount: fixedDiscountAmount,
  discountPercent,
}: {
  totalPrice: number;
  subtotal?: number;
  paymentStatus: unknown;
  currency: unknown;
  partValue?: unknown;
  remainingDebt?: unknown;
  discount?: number;
  discountAmount?: number;
  discountPercent?: number;
}) => {
  const status = normalizePaymentStatus(paymentStatus);
  const paymentCurrency = normalizeCurrency(currency);
  const safeTotalAmount = roundMoney(Math.max(toMoneyNumber(totalAmount), 0));
  const submittedRemainingAmount = toMoneyNumber(remainingDebt, NaN);
  const paidAmount =
    status === "cash"
      ? safeTotalAmount
      : status === "part" && Number.isFinite(submittedRemainingAmount)
        ? Math.max(safeTotalAmount - submittedRemainingAmount, 0)
        : status === "part"
          ? roundMoney(toMoneyNumber(partValue))
          : 0;
  const partOriginal = roundMoney(Math.min(Math.max(paidAmount, 0), safeTotalAmount));
  return buildInvoiceMoneyBreakdown({
    totalPrice: safeTotalAmount,
    subtotal: subtotalAmount,
    paymentStatus: status,
    currency: paymentCurrency,
    partValue: partOriginal,
    discount: discountAmount,
    discountAmount: fixedDiscountAmount,
    discountPercent,
  });
};
const resolveProductPrice = (
  stockProduct: Product,
  selectedPriceType: ProductPriceType,
  submittedPrice: number,
) => {
  if (selectedPriceType === "custom") {
    return submittedPrice;
  }
  const stockPrice = toFiniteNumber(stockProduct[selectedPriceType]);
  return stockPrice > 0
    ? stockPrice
    : submittedPrice > 0
      ? submittedPrice
      : toFiniteNumber(stockProduct.sellPrice);
};
const normalizeSellProductFromStock = (
  rawProduct: sell["products"][number],
  stockProduct: Product,
): sell["products"][number] => {
  const selectedPriceType = normalizeSelectedPriceType(rawProduct.selectedPriceType);
  const sellPrice = resolveProductPrice(
    stockProduct,
    selectedPriceType,
    toFiniteNumber(rawProduct.sellPrice),
  );
  if (sellPrice <= 0) {
    throw new Error(`Invalid sell price for ${stockProduct.code}`);
  }
  return {
    ...rawProduct,
    category: stockProduct.category || rawProduct.category || "",
    code: stockProduct.code || rawProduct.code,
    id: stockProduct.id || rawProduct.id,
    name: stockProduct.name || rawProduct.name,
    payPrice: toFiniteNumber(
      stockProduct.payPrice,
      toFiniteNumber(rawProduct.payPrice),
    ),
    wholesalePrice:
      stockProduct.wholesalePrice === undefined
        ? rawProduct.wholesalePrice
        : toFiniteNumber(stockProduct.wholesalePrice),
    superWholesalePrice:
      stockProduct.superWholesalePrice === undefined
        ? rawProduct.superWholesalePrice
        : toFiniteNumber(stockProduct.superWholesalePrice),
    quantity: toFiniteNumber(
      stockProduct.quantity,
      toFiniteNumber(rawProduct.quantity),
    ),
    sellPrice,
    selectedPriceType,
    unit: stockProduct.unit || rawProduct.unit || "",
    updatedDate: stockProduct.updatedDate || rawProduct.updatedDate || "",
    warehouse: stockProduct.warehouse || rawProduct.warehouse,
    qty: toFiniteNumber(rawProduct.qty),
  };
};
const postLedgerEntries = async (entries: LedgerEntry[]) => {
  for (const entry of entries) {
    const amount = Number(entry.amount || 0);
    if (!entry.accountId || amount <= 0) {
      continue;
    }
    await updateAccountBalanceInternal({
      accountId: entry.accountId,
      entryType: entry.entryType,
      amount,
      currency: entry.currency,
    });
  }
};
const assertAccountCanTransact = async (
  accountId: string | undefined,
  label: string,
) => {
  if (!accountId) {
    throw new Error(`${label} account is required`);
  }
  const accountSnapshot = await get(ref(database, `accounts/${accountId}`));
  if (!accountSnapshot.exists()) {
    throw new Error(`${label} account was not found`);
  }
  const account = accountSnapshot.val();
  if (account?.allowTransactions === false) {
    throw new Error(`${label} account does not allow transactions`);
  }
};
const toJournalLines = (entries: LedgerEntry[], note: string) => {
  return entries
    .filter((entry) => entry.accountId && Number(entry.amount || 0) > 0)
    .map((entry) => ({
      accountId: entry.accountId as string,
      debit: entry.entryType === "debit" ? Number(entry.amount || 0) : 0,
      credit: entry.entryType === "credit" ? Number(entry.amount || 0) : 0,
      currency: entry.currency || "SYP",
      amount: Number(entry.amount || 0),
      note,
    }));
};
export const handlePurchase = async ({
  newPurchase,
  newProduct,
}: {
  newPurchase: purchase;
  newProduct: Product;
}) => {
  const quantity = Number(newProduct.quantity);
  const price = Number(newProduct.payPrice);
  if (
    !newProduct.id ||
    !Number.isFinite(quantity) ||
    quantity <= 0 ||
    !Number.isFinite(price) ||
    price <= 0
  ) {
    throw new Error("اختر منتجًا موجودًا وكمية وسعر شراء صحيحين");
  }
  const expectedTotal = roundMoney(quantity * price);
  if (
    !Number.isFinite(expectedTotal) ||
    expectedTotal <= 0 ||
    roundMoney(Number(newPurchase.totalPrice)) !== expectedTotal
  ) {
    throw new Error("إجمالي الفاتورة لا يطابق الكمية وسعر الشراء");
  }
  if (
    !["cash", "part", "debt"].includes(newPurchase.paymentStatus) ||
    !["SYP"].includes(newPurchase.currency)
  ) {
    throw new Error("حالة الدفع أو العملة غير صالحة");
  }
  const purchaseStatus = normalizePaymentStatus(newPurchase.paymentStatus);
  const purchaseMoney = buildMoneyFromSubmittedInvoice({
    totalPrice: expectedTotal,
    paymentStatus: purchaseStatus,
    currency: newPurchase.currency,
    partValue: newPurchase.partValue ?? newPurchase.amount,
    remainingDebt: newPurchase.remainingDebt,
  });
  if (
    purchaseStatus === "part" &&
    (purchaseMoney.paidAmount <= 0 ||
      purchaseMoney.paidAmount >= purchaseMoney.totalPrice)
  ) {
    throw new Error(
      "Partial purchase payment must be greater than zero and less than invoice total",
    );
  }
  const paidOriginal =
    purchaseStatus === "part"
      ? roundMoney(Number(newPurchase.partValue))
      : purchaseMoney.paidAmount;
  const remainingOriginal = roundMoney(purchaseMoney.totalPrice - paidOriginal);
  if (
    !Number.isFinite(paidOriginal) ||
    paidOriginal < 0 ||
    remainingOriginal < 0 ||
    (purchaseStatus === "part" && (paidOriginal <= 0 || remainingOriginal <= 0)) ||
    (purchaseStatus === "cash" && paidOriginal !== purchaseMoney.totalPrice) ||
    (purchaseStatus === "debt" && paidOriginal !== 0) ||
    roundMoney(roundMoney(paidOriginal)) !== purchaseMoney.paidAmount
  ) {
    throw new Error("مبلغ الدفع لا يطابق حالة فاتورة الشراء");
  }
  const purchaseId = randomUUID();
  const context = {
    purchaseId,
    productId: newProduct.id,
    paymentId: randomUUID(),
    journalId: randomUUID(),
    requestKey: `product_purchase_${newPurchase.requestId || purchaseId}`,
    fingerprint: createHash("sha256")
      .update(JSON.stringify({ newPurchase, newProduct }))
      .digest("hex"),
    now: new Date().toISOString(),
  };
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(String(newPurchase.requestId || purchaseId))) {
    throw new Error("معرف طلب الشراء غير صالح");
  }
  const purchaseData: purchase = {
    ...newPurchase,
    id: purchaseId,
    date: context.now,
    name: newProduct.name,
    code: newProduct.code,
    warehouse: newProduct.warehouse,
    quantity,
    payPrice: price,
    paymentStatus: purchaseStatus,
    currency: purchaseMoney.currency,
    amount: purchaseMoney.totalPrice,
    totalPrice: purchaseMoney.totalPrice,
    paidAmount: purchaseMoney.paidAmount,
    remainingDebt: purchaseMoney.remainingDebt,
    partValue: paidOriginal,
  };
  const rootRef = ref(database);
  const seed = await get(rootRef);
  let transactionError: Error | null = null;
  const result = await runTransaction(
    rootRef,
    (current: any) => {
      try {
        transactionError = null;
        return applyProductPurchaseSettlement(
          current || seed.val() || {},
          purchaseData,
          newProduct,
          context,
        ).state;
      } catch (error: any) {
        transactionError = error;
        return;
      }
    },
    { applyLocally: false },
  );
  if (!result.committed) throw transactionError || new Error("تعذر إتمام الشراء");
  resetProductsCache?.();
  const state = result.snapshot.val();
  const savedId =
    state.financialRequests?.[context.requestKey]?.purchaseId || purchaseId;
  return state.purchases[savedId] as purchase;
};
export const handleBulkPurchase = async ({
  newPurchase,
}: {
  newPurchase: purchase;
}) => {
  const products = Array.isArray(newPurchase.products) ? newPurchase.products : [];
  if (!products.length || products.length > 200) {
    throw new Error("فاتورة الشراء تحتاج بين منتج واحد و200 منتج");
  }
  const items: Product[] = products.map((product) => ({
    id: product.id,
    name: product.name,
    code: product.code,
    category: product.category,
    warehouse: product.warehouse,
    unit: product.unit,
    quantity: Number(product.quantity),
    payPrice: Number(product.payPrice),
    wholesalePrice:
      product.wholesalePrice === undefined ? undefined : Number(product.wholesalePrice),
    superWholesalePrice:
      product.superWholesalePrice === undefined
        ? undefined
        : Number(product.superWholesalePrice),
    sellPrice: product.sellPrice === undefined ? undefined : Number(product.sellPrice),
    alertQuantity: product.alertQuantity,
  }));
  let rawTotal = 0;
  for (let index = 0; index < items.length; index++) {
    const item = items[index];
    const lineTotal = item.quantity * Number(item.payPrice);
    if (
      !item.id ||
      !Number.isFinite(lineTotal) ||
      lineTotal <= 0 ||
      productLineTotalMismatch(products[index].lineTotal, lineTotal)
    ) {
      throw new Error("أحد أسطر فاتورة الشراء غير صالح");
    }
    rawTotal += lineTotal;
  }
  const totalPrice = roundMoney(rawTotal);
  if (roundMoney(Number(newPurchase.totalPrice)) !== totalPrice) {
    throw new Error("إجمالي الفاتورة لا يطابق أسعار وكميات المنتجات");
  }
  if (
    !["cash", "part", "debt"].includes(newPurchase.paymentStatus) ||
    !["SYP"].includes(newPurchase.currency)
  ) {
    throw new Error("حالة الدفع أو العملة غير صالحة");
  }
  const purchaseStatus = normalizePaymentStatus(newPurchase.paymentStatus);
  const money = buildMoneyFromSubmittedInvoice({
    totalPrice: totalPrice,
    paymentStatus: purchaseStatus,
    currency: newPurchase.currency,
    partValue: newPurchase.partValue ?? newPurchase.amount,
    remainingDebt: newPurchase.remainingDebt,
  });
  const paidOriginal =
    purchaseStatus === "part"
      ? roundMoney(Number(newPurchase.partValue))
      : money.paidAmount;
  const remainingOriginal = roundMoney(money.totalPrice - paidOriginal);
  if (
    !Number.isFinite(paidOriginal) ||
    paidOriginal < 0 ||
    remainingOriginal < 0 ||
    (purchaseStatus === "part" &&
      (money.paidAmount <= 0 ||
        money.remainingDebt <= 0 ||
        paidOriginal <= 0 ||
        remainingOriginal <= 0)) ||
    roundMoney(roundMoney(paidOriginal)) !== money.paidAmount
  ) {
    throw new Error("المدفوع والمتبقي لا يطابقان الفاتورة");
  }
  const purchaseId = randomUUID();
  const context = {
    purchaseId,
    productId: "",
    paymentId: randomUUID(),
    journalId: randomUUID(),
    requestKey: `product_purchase_${newPurchase.requestId || purchaseId}`,
    fingerprint: createHash("sha256")
      .update(JSON.stringify({ newPurchase, items }))
      .digest("hex"),
    now: new Date().toISOString(),
  };
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(String(newPurchase.requestId || purchaseId))) {
    throw new Error("معرف طلب الشراء غير صالح");
  }
  const purchaseData: purchase = {
    ...newPurchase,
    id: purchaseId,
    date: context.now,
    name: newPurchase.name || `فاتورة شراء (${items.length})`,
    code: newPurchase.code || `PINV-${Date.now()}`,
    warehouse: Array.from(new Set(items.map((item) => item.warehouse))).join(", "),
    quantity: items.reduce((sum, item) => sum + item.quantity, 0),
    payPrice: 0,
    paymentStatus: purchaseStatus,
    currency: money.currency,
    totalPrice: money.totalPrice,
    amount: money.totalPrice,
    paidAmount: money.paidAmount,
    remainingDebt: money.remainingDebt,
    partValue: paidOriginal,
    products: items.map((item) => ({
      ...item,
      lineTotal: item.quantity * Number(item.payPrice),
    })) as purchase["products"],
  };
  const rootRef = ref(database);
  const seed = await get(rootRef);
  let transactionError: Error | null = null;
  const result = await runTransaction(
    rootRef,
    (current: any) => {
      try {
        transactionError = null;
        return applyProductPurchaseSettlement(
          current || seed.val() || {},
          purchaseData,
          items,
          context,
        ).state;
      } catch (error: any) {
        transactionError = error;
        return;
      }
    },
    { applyLocally: false },
  );
  if (!result.committed)
    throw transactionError || new Error("تعذر إتمام فاتورة الشراء");
  resetProductsCache?.();
  const state = result.snapshot.val();
  const savedId =
    state.financialRequests?.[context.requestKey]?.purchaseId || purchaseId;
  return state.purchases[savedId] as purchase;
};
const productLineTotalMismatch = (submitted: unknown, calculated: number) =>
  submitted !== undefined && roundMoney(Number(submitted)) !== roundMoney(calculated);
export const handleSell = async ({
  newSell,
  stockUpdater,
}: {
  newSell: sell;
  stockUpdater?: SellStockUpdater;
}) => {
  if (!stockUpdater) {
    const sellId = randomUUID();
    const requestId = String(newSell.requestId || sellId);
    if (!/^[A-Za-z0-9_-]{8,128}$/.test(requestId))
      throw new Error("معرف طلب البيع غير صالح");
    const context = {
      sellId,
      paymentId: randomUUID(),
      journalId: randomUUID(),
      requestKey: `product_sale_${requestId}`,
      fingerprint: createHash("sha256").update(JSON.stringify(newSell)).digest("hex"),
      now: new Date().toISOString(),
    };
    const rootRef = ref(database);
    const seed = await get(rootRef);
    let transactionError: Error | null = null;
    const result = await runTransaction(
      rootRef,
      (current: any) => {
        try {
          transactionError = null;
          return applyProductSaleSettlement(
            current || seed.val() || {},
            newSell,
            context,
          ).state;
        } catch (error: any) {
          transactionError = error;
          return;
        }
      },
      { applyLocally: false },
    );
    if (!result.committed)
      throw transactionError || new Error("تعذر إتمام فاتورة البيع");
    resetProductsCache?.();
    const state = result.snapshot.val();
    const savedId = state.financialRequests?.[context.requestKey]?.sellId || sellId;
    return state.sells[savedId] as sell;
  }
  try {
    let productsForSell: sell["products"] = newSell.products.map((product) => ({
      ...product,
      qty: toFiniteNumber(product.qty),
      quantity: toFiniteNumber(product.quantity),
      sellPrice: toFiniteNumber(product.sellPrice),
      payPrice: toFiniteNumber(product.payPrice),
      selectedPriceType: normalizeSelectedPriceType(product.selectedPriceType),
    }));
    if (!stockUpdater) {
      const normalizedProducts: sell["products"] = [];
      for (const product of productsForSell) {
        const stockProduct = await assertProductAvailableForSellInternal(
          product.id,
          product.warehouse,
          product.qty,
          product.code,
        );
        normalizedProducts.push(normalizeSellProductFromStock(product, stockProduct));
      }
      productsForSell = normalizedProducts;
    }
    const subtotal = productsForSell.reduce(
      (sum, product) =>
        sum + toFiniteNumber(product.sellPrice) * toFiniteNumber(product.qty),
      0,
    );
    const fixedDiscountAmount = getSubmittedDiscountAmount(newSell);
    const discountPercent = getSubmittedDiscountPercent(newSell);
    assertInvoiceDiscountIsValid({
      subtotal: subtotal,
      discountPercent,
      discountAmount: fixedDiscountAmount,
    });
    const sellStatus = normalizePaymentStatus(newSell.paymentStatus);
    const sellMoney = buildInvoiceMoneyBreakdown({
      subtotal: subtotal,
      paymentStatus: sellStatus,
      currency: newSell.currency,
      partValue: newSell.partValue,
      discountAmount: fixedDiscountAmount,
      discountPercent,
    });
    const totalPrice = sellMoney.totalPrice;
    const paidAmount = sellMoney.paidAmount;
    if (totalPrice <= 0) {
      throw new Error("Sell invoice total must be greater than zero");
    }
    if (sellStatus === "part" && (paidAmount <= 0 || paidAmount >= totalPrice)) {
      throw new Error(
        "Partial payment must be greater than zero and less than invoice total",
      );
    }
    const accountPreflight: Array<Promise<void>> = [
      assertAccountCanTransact(newSell.salesAccountId, "Sales"),
    ];
    if (paidAmount > 0) {
      accountPreflight.push(
        assertAccountCanTransact(newSell.paymentAccountId, "Payment"),
      );
    }
    if (sellMoney.remainingDebt > 0) {
      accountPreflight.push(
        assertAccountCanTransact(newSell.receivableAccountId, "Receivable"),
      );
    }
    await Promise.all(accountPreflight);
    const sellToStore: sell = {
      ...newSell,
      products: productsForSell,
      originalProducts: productsForSell.map((product) => ({ ...product })),
      originalTotal: sellMoney.totalPrice,
      originalSubtotal: sellMoney.subtotal,
      originalDiscount: sellMoney.discount,
      paymentStatus: sellStatus,
      currency: sellMoney.currency,
      subtotal: sellMoney.subtotal,
      totalPrice: sellMoney.totalPrice,
      paidAmount: sellMoney.paidAmount,
      remainingDebt: sellMoney.remainingDebt,
      amount: sellMoney.totalPrice,
      partValue: sellMoney.paidAmount,
      discountType: sellMoney.discountType,
      discountPercent: sellMoney.discountPercent,
      discountPercentAmount: sellMoney.discountPercentAmount,
      discountAmount: sellMoney.discountAmount,
      discount: sellMoney.discount,
    };
    const stockUpdatedProducts: sell["products"] = [];
    if (!stockUpdater) {
      for (const product of productsForSell) {
        await updateQuantityOnSell(
          product.id,
          product.warehouse,
          product.qty,
          product.code,
        );
        stockUpdatedProducts.push(product);
      }
    }
    let sellData: sell;
    try {
      sellData = await createSellInternal(sellToStore);
    } catch (createError) {
      if (!stockUpdater) {
        await Promise.all(
          stockUpdatedProducts
            .slice()
            .reverse()
            .map((product) =>
              adjustProductQuantityInternal(
                product.id,
                product.warehouse,
                product.qty,
                product.code,
              ).catch((rollbackError) => {
                console.error("Failed to rollback sell stock update", rollbackError);
              }),
            ),
        );
      }
      throw createError;
    }
    if (stockUpdater) {
      for (const product of productsForSell) {
        await stockUpdater(product);
      }
    }
    await updateCustomerInternal(sellData.customerId, sellData);
    const sellLedgerEntries: LedgerEntry[] = [
      {
        accountId: sellData.paymentAccountId,
        entryType: "debit",
        amount: paidAmount,
        currency: sellMoney.currency,
      },
      {
        accountId: sellData.receivableAccountId,
        entryType: "debit",
        amount: sellData.remainingDebt,
        currency: sellMoney.currency,
      },
      {
        accountId: sellData.salesAccountId,
        entryType: "credit",
        amount: sellData.totalPrice,
        currency: sellMoney.currency,
      },
    ];
    await postLedgerEntries(sellLedgerEntries);
    await createJournalEntryInternal({
      date: sellData.date,
      description: `قيد بيع ${sellData.products?.[0]?.name || sellData.id}`,
      referenceType: "sell",
      referenceId: sellData.id,
      lines: toJournalLines(
        sellLedgerEntries,
        `قيد بيع ${sellData.products?.[0]?.name || sellData.id}`,
      ),
    });
    if (sellData.remainingDebt === 0) {
      await createPaymentInternal({
        type: "income",
        customerId: sellData.customerId,
        sellId: sellData.id,
        ...(sellData.driverId
          ? { collectorId: sellData.driverId, vehicleId: sellData.vehicleId }
          : {}),
        paymentAccountId: sellData.paymentAccountId,
        receivableAccountId: sellData.receivableAccountId,
        salesAccountId: sellData.salesAccountId,
        amount: sellData.paidAmount ?? sellData.totalPrice,
        note: "دفع كامل ثمن بيع",
        currency: sellData.currency,
      });
    } else if (sellData.remainingDebt < sellData.totalPrice) {
      await createPaymentInternal({
        type: "income",
        customerId: sellData.customerId,
        sellId: sellData.id,
        ...(sellData.driverId
          ? { collectorId: sellData.driverId, vehicleId: sellData.vehicleId }
          : {}),
        paymentAccountId: sellData.paymentAccountId,
        receivableAccountId: sellData.receivableAccountId,
        salesAccountId: sellData.salesAccountId,
        amount: paidAmount,
        note: "دفعة من ثمن بيع",
        currency: sellData.currency,
      });
    }
    return sellData;
  } catch (err) {
    console.log(err);
    throw err;
  }
};
const settleCashPartyAtomic = async (
  paymentData: Payment,
  partyType: "customer" | "supplier",
) => {
  if (
    partyType === "customer"
      ? !paymentData.customerId || paymentData.supplierId
      : !paymentData.supplierId || paymentData.customerId
  )
    throw new Error("نوع الطرف لا يطابق مسار الدفعة");
  const now = new Date().toISOString();
  const normalized = normalizeCashPaymentMoney(paymentData);
  const payment: Payment = {
    ...normalized,
    id: randomUUID(),
    date: now,
    settlementMethod: "cash",
    collectionSource: "management",
    commissionRate: 0,
    commissionAmount: 0,
  };
  const hash = (value: string) => createHash("sha256").update(value).digest("hex");
  const request = payment.requestId
    ? {
        requestKey: `cash_${hash(`${payment.createdBy || ""}:${payment.requestId}`)}`,
        fingerprint: hash(
          JSON.stringify({
            partyType,
            customerId: payment.customerId,
            supplierId: payment.supplierId,
            sellId: payment.sellId,
            purchaseId: payment.purchaseId,
            paymentAccountId: payment.paymentAccountId,
            receivableAccountId: payment.receivableAccountId,
            payableAccountId: payment.payableAccountId,
            currency: payment.currency,
            amount: payment.amount,
            note: payment.note || "",
          }),
        ),
      }
    : undefined;
  const journalId = randomUUID();
  const rootRef = ref(database);
  const seed = await get(rootRef);
  if (!seed.exists()) throw new Error("بيانات المشروع غير متاحة");
  let output: ReturnType<typeof applyCashPartySettlement> | undefined;
  const transaction = await runTransaction(
    rootRef,
    (current) => {
      output = applyCashPartySettlement(
        current || seed.val(),
        payment,
        journalId,
        request,
      );
      return output.state;
    },
    { applyLocally: false },
  );
  if (!transaction.committed || !output) throw new Error("تعذر تسجيل الدفعة");
  const { state: _state, ...result } = output;
  return result;
};
export const customerPayment = (paymentData: Payment) =>
  settleCashPartyAtomic(paymentData, "customer");
export const supplierPayment = (paymentData: Payment) =>
  settleCashPartyAtomic(paymentData, "supplier");
export const handleSupplierReturn = async (newReturn: {
  productCode: string;
  supplierId: string;
  warehouse: string;
  qty: number;
  returnValue: number;
  referenceId: string;
  partValue: number;
  productId: string;
  returnType: "debt" | "cash" | "part";
  reason: string;
  inventoryAccountId?: string;
  payableAccountId?: string;
  paymentAccountId?: string;
}) => {
  const returnQty = Math.abs(Number(newReturn.qty || 0));
  const returnType = normalizePaymentStatus(newReturn.returnType);
  if (!returnQty) {
    throw new Error("Return quantity must be greater than zero");
  }
  if (returnType !== newReturn.returnType) {
    throw new Error("Invalid supplier return type");
  }
  const purchaseData = await getPurchaseByIdInternal(newReturn.referenceId);
  if (!purchaseData) {
    throw new Error("Purchase invoice was not found");
  }
  if (purchaseData.supplierId !== newReturn.supplierId) {
    throw new Error("Return supplier does not match the purchase invoice");
  }
  if (returnQty > toFiniteNumber(purchaseData.quantity)) {
    throw new Error("Return quantity is greater than purchase invoice quantity");
  }
  const returnValue = roundMoney(toFiniteNumber(newReturn.returnValue));
  if (returnValue <= 0) {
    throw new Error("Return value must be greater than zero");
  }
  const paymentAmount =
    returnType === "cash"
      ? returnValue
      : returnType === "part"
        ? roundMoney(Math.max(toFiniteNumber(newReturn.partValue), 0))
        : 0;
  if (returnType === "part" && (paymentAmount <= 0 || paymentAmount >= returnValue)) {
    throw new Error(
      "Partial supplier return amount must be greater than zero and less than return total",
    );
  }
  const payableReturnAmount = roundMoney(Math.max(returnValue - paymentAmount, 0));
  await Promise.all([
    assertAccountCanTransact(newReturn.inventoryAccountId, "Inventory"),
    paymentAmount > 0
      ? assertAccountCanTransact(newReturn.paymentAccountId, "Payment")
      : Promise.resolve(),
    payableReturnAmount > 0
      ? assertAccountCanTransact(newReturn.payableAccountId, "Payable")
      : Promise.resolve(),
  ]);
  const returnCurrency = normalizeCurrency(purchaseData.currency);
  await createReturnInternal({
    ...newReturn,
    qty: returnQty,
    returnValue,
    type: "purchase-return",
  });
  if (paymentAmount > 0) {
    await createPaymentInternal(
      stripUndefinedFields({
        type: "return",
        supplierId: newReturn.supplierId,
        paymentAccountId: newReturn.paymentAccountId,
        payableAccountId: newReturn.payableAccountId,
        amount: paymentAmount,
        note: `Supplier return (${newReturn.productCode})`,
        currency: returnCurrency,
      }) as Payment,
    );
  }
  let balanceChange = 0;
  if (returnType === "debt") {
    balanceChange = -returnValue;
  } else if (returnType === "part") {
    balanceChange = -payableReturnAmount;
  }
  const balanceSYPChange = roundMoney(balanceChange);
  await updateSupplierBalanceInternal(
    newReturn.supplierId,
    balanceChange,
    balanceSYPChange,
  );
  const supplierReturnLedgerEntries: LedgerEntry[] = [
    {
      accountId: newReturn.paymentAccountId,
      entryType: "debit",
      amount: paymentAmount,
      currency: returnCurrency,
    },
    {
      accountId: newReturn.payableAccountId,
      entryType: "debit",
      amount: payableReturnAmount,
      currency: returnCurrency,
    },
    {
      accountId: newReturn.inventoryAccountId,
      entryType: "credit",
      amount: returnValue,
      currency: returnCurrency,
    },
  ];
  await postLedgerEntries(supplierReturnLedgerEntries);
  await createJournalEntryInternal({
    date: new Date().toISOString(),
    description: `Supplier return for purchase ${newReturn.referenceId}`,
    referenceType: "supplier-return",
    referenceId: newReturn.referenceId,
    lines: toJournalLines(
      supplierReturnLedgerEntries,
      `Supplier return for purchase ${newReturn.referenceId}`,
    ),
  });
  const updatedQuantity = roundMoney(toFiniteNumber(purchaseData.quantity) - returnQty);
  await updatePurchaseInternal(newReturn.referenceId, {
    quantity: updatedQuantity,
  });
  return { success: true, message: "Supplier return completed successfully" };
};
export const handleCustomerReturn = async (newReturn: {
  productCode: string;
  products?: Array<{
    productCode?: string;
    code?: string;
    productId?: string;
    warehouse: string;
    qty: number;
  }>;
  customerId: string;
  warehouse: string;
  qty: number;
  returnValue: number;
  referenceId: string;
  productId: string;
  returnType: "debt" | "cash" | "part";
  partValue: number;
  reason: string;
  paymentAccountId?: string;
  receivableAccountId?: string;
  salesAccountId?: string;
  refundPaidByDriverId?: string;
}) => {
  const returnQty = Math.abs(Number(newReturn.qty || 0));
  if (!returnQty) {
    throw new Error("كمية الإرجاع غير صحيحة");
  }
  const returnableProduct = await getReturnableProductFromSellInternal(
    newReturn.referenceId,
    newReturn.productCode,
    newReturn.warehouse,
  );
  if (!returnableProduct) {
    throw new Error("المنتج غير موجود في فاتورة البيع");
  }
  if (returnQty > returnableProduct.qty) {
    throw new Error("كمية الإرجاع أكبر من الكمية المتبقية في الفاتورة");
  }
  const originalSellSnap = await get(ref(database, `sells/${newReturn.referenceId}`));
  const originalSell = originalSellSnap.exists()
    ? (originalSellSnap.val() as sell)
    : null;
  const returnCurrency = normalizeCurrency(originalSell?.currency);
  const returnValue = returnQty * returnableProduct.sellPrice;
  const refundedCash =
    newReturn.returnType === "cash"
      ? returnValue
      : newReturn.returnType === "part"
        ? newReturn.partValue
        : 0;
  await createReturnInternal({
    ...newReturn,
    qty: returnQty,
    returnValue,
    type: "sale-return",
  });
  if (refundedCash > 0) {
    await createPaymentInternal(
      stripUndefinedFields({
        type: "return",
        customerId: newReturn.customerId,
        paymentAccountId: newReturn.paymentAccountId,
        receivableAccountId: newReturn.receivableAccountId,
        salesAccountId: newReturn.salesAccountId,
        amount: -(newReturn.returnType === "cash"
          ? returnValue
          : newReturn.returnType === "part"
            ? newReturn.partValue
            : 0),
        note: `اعادة منتجات من الزبون (${newReturn.productCode} عدد ${newReturn.qty})`,
        currency: returnCurrency,
      }) as Payment,
    );
  }
  const receivableReturnAmount = Math.max(returnValue - refundedCash, 0);
  await postLedgerEntries([
    {
      accountId: newReturn.salesAccountId,
      entryType: "debit",
      amount: returnValue,
      currency: returnCurrency,
    },
    {
      accountId: newReturn.paymentAccountId,
      entryType: "credit",
      amount: refundedCash,
      currency: returnCurrency,
    },
    {
      accountId: newReturn.receivableAccountId,
      entryType: "credit",
      amount: receivableReturnAmount,
      currency: returnCurrency,
    },
  ]);
  if (newReturn.returnType === "debt") {
    const updatedCustomer = await updateCustomerBalanceInternal(
      newReturn.customerId,
      returnValue,
      roundMoney(returnValue),
    );
    if (!updatedCustomer) {
      throw new Error("الزبون غير موجود لتحديث الرصيد");
    }
  } else if (newReturn.returnType === "part") {
    const updatedCustomer = await updateCustomerBalanceInternal(
      newReturn.customerId,
      returnValue - newReturn.partValue,
      roundMoney(returnValue - newReturn.partValue),
    );
    if (!updatedCustomer) {
      throw new Error("الزبون غير موجود لتحديث الرصيد");
    }
  } else {
    const updatedCustomer = await updateCustomerBalanceInternal(
      newReturn.customerId,
      0,
      0,
    );
    if (!updatedCustomer) {
      throw new Error("الزبون غير موجود لتحديث الرصيد");
    }
  }
  await returnProductsFromSellInternal(newReturn.referenceId, [
    {
      code: newReturn.productCode,
      warehouse: newReturn.warehouse,
      qty: returnQty,
    },
  ]);
  return { success: true, message: "تمت عملية الإرجاع بنجاح" };
};
export const handleCustomerReturnSafe = async (newReturn: {
  productCode?: string;
  products?: Array<{
    productCode?: string;
    code?: string;
    productId?: string;
    warehouse: string;
    qty: number;
  }>;
  customerId: string;
  warehouse?: string;
  qty?: number;
  returnValue?: number;
  referenceId: string;
  productId?: string;
  returnType: "debt" | "cash" | "part";
  partValue?: number;
  reason?: string;
  paymentAccountId?: string;
  receivableAccountId?: string;
  salesAccountId?: string;
  refundPaidByDriverId?: string;
}) => {
  const returnType = (
    ["cash", "debt", "part"].includes(String(newReturn.returnType))
      ? newReturn.returnType
      : "cash"
  ) as CustomerReturnType;
  const returnedProducts: SaleReturnLineInput[] = Array.isArray(newReturn.products)
    ? newReturn.products.map((product) => ({
        productId: product.productId,
        code: product.code || product.productCode,
        productCode: product.productCode || product.code,
        warehouse: product.warehouse,
        qty: product.qty,
      }))
    : [
        {
          productId: newReturn.productId,
          code: newReturn.productCode,
          productCode: newReturn.productCode,
          warehouse: String(newReturn.warehouse || ""),
          qty: Number(newReturn.qty || 0),
        },
      ];
  const originalSellSnap = await get(ref(database, `sells/${newReturn.referenceId}`));
  if (!originalSellSnap.exists()) {
    throw new Error("Sell invoice was not found");
  }
  const originalSell = originalSellSnap.val() as sell;
  if (originalSell.customerId !== newReturn.customerId) {
    throw new Error("Return customer does not match the sell invoice");
  }
  const calculation = calculateSaleReturn({
    sellData: originalSell,
    returnedProducts,
    returnType,
    partValueAmount: newReturn.partValue,
  });
  if (!newReturn.salesAccountId) {
    throw new Error("Sales account is required for customer returns");
  }
  if (calculation.cashRefundAmount > 0 && !newReturn.paymentAccountId) {
    throw new Error("Payment account is required for cash refunds");
  }
  if (calculation.receivableCreditAmount > 0 && !newReturn.receivableAccountId) {
    throw new Error("Receivable account is required for debt return credits");
  }
  const assertAccountCanTransact = async (
    accountId: string | undefined,
    label: string,
  ) => {
    if (!accountId) return;
    const accountSnapshot = await get(ref(database, `accounts/${accountId}`));
    if (!accountSnapshot.exists()) {
      throw new Error(`${label} account was not found`);
    }
    const account = accountSnapshot.val();
    if (account?.allowTransactions === false) {
      throw new Error(`${label} account does not allow transactions`);
    }
  };
  await Promise.all([
    assertAccountCanTransact(newReturn.salesAccountId, "Sales"),
    calculation.cashRefundAmount > 0
      ? assertAccountCanTransact(newReturn.paymentAccountId, "Payment")
      : Promise.resolve(),
    calculation.receivableCreditAmount > 0
      ? assertAccountCanTransact(newReturn.receivableAccountId, "Receivable")
      : Promise.resolve(),
  ]);
  const customerSnapshot = await get(ref(database, `customer/${newReturn.customerId}`));
  if (!customerSnapshot.exists()) {
    throw new Error("Customer was not found");
  }
  let allocatedReturnCredit = 0;
  let allocatedReturnCash = 0;
  for (const [index, returnedLine] of calculation.returnedLines.entries()) {
    const originalLine = originalSell.products.find(
      (product) =>
        product.id === returnedLine.productId &&
        product.warehouse === returnedLine.warehouse,
    );
    const last = index === calculation.returnedLines.length - 1;
    const credit = last
      ? roundMoney(calculation.receivableCreditAmount - allocatedReturnCredit)
      : roundMoney(
          (calculation.receivableCreditAmount * returnedLine.netValueAmount) /
            calculation.returnValueAmount,
        );
    const cash = last
      ? roundMoney(calculation.cashRefundAmount - allocatedReturnCash)
      : roundMoney(
          (calculation.cashRefundAmount * returnedLine.netValueAmount) /
            calculation.returnValueAmount,
        );
    allocatedReturnCredit = roundMoney(allocatedReturnCredit + credit);
    allocatedReturnCash = roundMoney(allocatedReturnCash + cash);
    await createReturnInternal({
      productCode: returnedLine.code,
      productId: returnedLine.productId,
      warehouse: returnedLine.warehouse,
      qty: returnedLine.qty,
      returnValue: returnedLine.netValueAmount,
      type: "sale-return",
      referenceId: newReturn.referenceId,
      reason: newReturn.reason || "",
      productName: originalLine?.name || "",
      payPriceAmount: toMoneyNumber(originalLine?.payPrice),
      sellPriceAmount: returnedLine.sellPrice,
      ...(originalSell.driverId ? { driverId: originalSell.driverId } : {}),
      ...(originalSell.vehicleId ? { vehicleId: originalSell.vehicleId } : {}),
      cashRefundAmount: cash,
      receivableCreditAmount: credit,
      currency: calculation.currency,
    });
  }
  if (calculation.cashRefundAmount > 0) {
    const refunds = await prepareDriverRefundPayments(
      newReturn.referenceId,
      calculation.cashRefundAmount,
      calculation.currency,
      newReturn.refundPaidByDriverId,
    );
    for (const refund of refunds)
      await createPaymentInternal(
        stripUndefinedFields({
          ...refund,
          customerId: newReturn.customerId,
          sellId: newReturn.referenceId,
          paymentAccountId: newReturn.paymentAccountId,
          receivableAccountId: newReturn.receivableAccountId,
          salesAccountId: newReturn.salesAccountId,
          note: `Customer return (${calculation.returnedLines.length} product line)`,
        }) as Payment,
      );
  }
  const returnLedgerEntries: LedgerEntry[] = [
    {
      accountId: newReturn.salesAccountId,
      entryType: "debit",
      amount: calculation.returnValueAmount,
      currency: calculation.currency,
    },
    {
      accountId: newReturn.paymentAccountId,
      entryType: "credit",
      amount: calculation.cashRefundAmount,
      currency: calculation.currency,
    },
    {
      accountId: newReturn.receivableAccountId,
      entryType: "credit",
      amount: calculation.receivableCreditAmount,
      currency: calculation.currency,
    },
  ];
  await postLedgerEntries(returnLedgerEntries);
  await createJournalEntryInternal({
    date: new Date().toISOString(),
    description: `Customer return for sell ${newReturn.referenceId}`,
    referenceType: "customer-return",
    referenceId: newReturn.referenceId,
    lines: toJournalLines(
      returnLedgerEntries,
      `Customer return for sell ${newReturn.referenceId}`,
    ),
  });
  if (calculation.receivableCreditAmount > 0 || calculation.receivableCreditSYP > 0) {
    await updateCustomerBalanceInternal(
      newReturn.customerId,
      calculation.receivableCreditAmount,
      calculation.receivableCreditSYP,
    );
  }
  await update(
    ref(database, `sells/${newReturn.referenceId}`),
    calculation.updatedSell,
  );
  await reconcileCustomerBalanceInternal(newReturn.customerId);
  return {
    success: true,
    message: "Customer return completed successfully",
    data: calculation,
  };
};
export const warehouseTransfer = async (transferData: {
  productId: string;
  oldWarehouse: string;
  newWarehouse: string;
  amount: number;
  currency: string;
  quantity: number;
  note: string;
  newSellPrice?: number;
  paymentStatus?: "cash" | "debt" | "part";
  partValue?: number;
  expenseAccountId?: string;
  paymentAccountId?: string;
  payableAccountId?: string;
}) => {
  try {
    const product = await getProductByIdInternal(transferData.productId);
    if (product?.message) {
      return product.message;
    }
    const currentStock = Number(product.product.quantity || 0);
    const stockAfter = currentStock - transferData.quantity;
    if (stockAfter < 0) {
      throw new Error("الكمية غير كافية في المستودع");
    }
    await createTransferInternal({
      productId: transferData.productId,
      code: product.product.code,
      name: product.product.name,
      oldWarehouse: transferData.oldWarehouse,
      newWarehouse: transferData.newWarehouse,
      quantity: transferData.quantity,
      amount: transferData.amount,
      currency: transferData.currency,
      stockBefore: currentStock,
      stockAfter,
      fromProductId: transferData.productId,
      unitCostAmount: Number(product.product.payPrice || 0),
      performedBy: "admin",
      referenceId: `TR-${Date.now()}`,
      note: transferData.note,
    });
    await updateQuantityOnSell(
      transferData.productId,
      transferData.oldWarehouse,
      transferData.quantity,
      product.product.code,
    );
    await createOrUpdateProductInternal({
      ...product.product,
      warehouse: transferData.newWarehouse,
      quantity: transferData.quantity,
      sellPrice: transferData.newSellPrice || product.product.sellPrice,
    });
    const transferCurrency = normalizeCurrency(transferData.currency);
    const transferAmountOriginal = Math.max(toFiniteNumber(transferData.amount), 0);
    const transferAmountAmount = roundMoney(transferAmountOriginal);
    if (transferAmountAmount > 0) {
      const paymentStatus = transferData.paymentStatus || "cash";
      const paidOriginal =
        paymentStatus === "cash"
          ? transferAmountOriginal
          : paymentStatus === "part"
            ? Number(transferData.partValue || 0)
            : 0;
      const paidAmount = roundMoney(paidOriginal);
      const payableAmount = Math.max(transferAmountAmount - paidAmount, 0);
      if (paidAmount > 0) {
        await createPaymentInternal({
          type: "expense",
          supplierId: "transfer",
          expenseAccountId: transferData.expenseAccountId,
          paymentAccountId: transferData.paymentAccountId,
          currency: transferCurrency,
          amount: -paidOriginal,
          note:
            `نقل ${product.product.name} // ${transferData.note}` ||
            `Transfer: ${product.product.name || transferData.productId}`,
        });
      }
      await postLedgerEntries([
        {
          accountId: transferData.expenseAccountId,
          entryType: "debit",
          amount: transferAmountAmount,
          currency: transferCurrency,
        },
        {
          accountId: transferData.paymentAccountId,
          entryType: "credit",
          amount: paidAmount,
          currency: transferCurrency,
        },
        {
          accountId: transferData.payableAccountId,
          entryType: "credit",
          amount: payableAmount,
          currency: transferCurrency,
        },
      ]);
    }
  } catch (err) {
    console.log(err);
    return err;
  }
};

import {
  updateCustomerBalanceInternal,
  updateCustomerInternal,
} from "../controllers/customer.controller";
import { createPaymentInternal } from "../controllers/payments.controller";
import {
  assertProductAvailableForSellInternal,
  createOrUpdateProductInternal,
  getProductByIdInternal,
  updateQuantityOnSell,
} from "../controllers/products.controller";
import {
  createPurchaseInternal,
  getPurchaseByIdInternal,
  updatePurchaseInternal,
} from "../controllers/purchases.controller";
import { createReturnInternal } from "../controllers/returns.controller";
import {
  getReturnableProductFromSellInternal,
  createSellInternal,
  returnProductsFromSellInternal,
} from "../controllers/sells.controller";
import {
  updateSupplierBalanceInternal,
  updateSupplierInternal,
} from "../controllers/suppliers.controller";
import { createTransferInternal } from "../controllers/transfer.controller";
import { updateAccountBalanceInternal } from "../controllers/account.controller";
import { createJournalEntryInternal } from "../controllers/journalEntries.controller";
import { Payment } from "../types/payment";
import { Product, ProductPriceType } from "../types/product";
import { purchase } from "../types/purchase";
import { sell } from "../types/sell";
import { database } from "../firebaseConfig";
import { get, ref, update } from "firebase/database";
import {
  buildInvoiceMoneyBreakdown,
  buildPaymentMoneyBreakdown,
  normalizeCurrency,
  normalizeExchangeRate,
  originalToUSD,
  roundMoney,
  toMoneyNumber,
  usdToOriginal,
  usdToSYPForPaymentCurrency,
} from "../utils/money";

type SellStockUpdater = (product: sell["products"][number]) => Promise<void>;

type LedgerEntry = {
  accountId?: string;
  entryType: "debit" | "credit";
  amount?: number;
  currency?: "USD" | "SYP";
  exchangeRate?: number;
  amountOriginal?: number;
  amountSYP?: number;
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

const getSubmittedDiscountAmount = (invoice: {
  discount?: unknown;
  discountAmountUSD?: unknown;
  discountAmount?: unknown;
  discountPercent?: unknown;
}) => {
  if (hasSubmittedValue(invoice.discountAmountUSD)) {
    return toFiniteNumber(invoice.discountAmountUSD);
  }

  if (hasSubmittedValue(invoice.discountAmount)) {
    return toFiniteNumber(invoice.discountAmount);
  }

  if (hasSubmittedValue(invoice.discountPercent)) {
    return 0;
  }

  return toFiniteNumber(invoice.discount);
};

const getSubmittedDiscountPercent = (invoice: {
  discountPercent?: unknown;
}) => toFiniteNumber(invoice.discountPercent);

const assertInvoiceDiscountIsValid = ({
  subtotalUSD,
  discountPercent,
  discountAmountUSD,
}: {
  subtotalUSD: number;
  discountPercent: number;
  discountAmountUSD: number;
}) => {
  if (discountPercent < 0 || discountPercent > 100) {
    throw new Error("Discount percent must be between 0 and 100");
  }

  if (discountAmountUSD < 0) {
    throw new Error("Discount amount cannot be negative");
  }

  if (subtotalUSD <= 0) {
    if (discountPercent > 0 || discountAmountUSD > 0) {
      throw new Error("Discount must be less than invoice subtotal");
    }

    return;
  }

  const percentDiscountUSD = roundMoney(subtotalUSD * (discountPercent / 100));
  const discountUSD = roundMoney(percentDiscountUSD + discountAmountUSD);

  if (discountUSD >= subtotalUSD) {
    throw new Error("Discount must be less than invoice subtotal");
  }
};

const normalizePaymentStatus = (
  value: unknown,
): "cash" | "part" | "debt" => {
  return value === "cash" || value === "part" || value === "debt"
    ? value
    : "debt";
};

const buildMoneyFromSubmittedInvoice = ({
  totalUSD,
  subtotalUSD,
  paymentStatus,
  currency,
  exchangeRate,
  partValue,
  remainingDebt,
  discountUSD,
  discountAmountUSD,
  discountPercent,
}: {
  totalUSD: number;
  subtotalUSD?: number;
  paymentStatus: unknown;
  currency: unknown;
  exchangeRate: unknown;
  partValue?: unknown;
  remainingDebt?: unknown;
  discountUSD?: number;
  discountAmountUSD?: number;
  discountPercent?: number;
}) => {
  const status = normalizePaymentStatus(paymentStatus);
  const paymentCurrency = normalizeCurrency(currency);
  const normalizedExchangeRate = normalizeExchangeRate(
    paymentCurrency,
    exchangeRate,
  );
  const safeTotalUSD = roundMoney(Math.max(toMoneyNumber(totalUSD), 0));
  const submittedRemainingUSD = toMoneyNumber(remainingDebt, NaN);
  const paidUSD =
    status === "cash"
      ? safeTotalUSD
      : status === "part" && Number.isFinite(submittedRemainingUSD)
        ? Math.max(safeTotalUSD - submittedRemainingUSD, 0)
        : status === "part"
          ? originalToUSD(
              toMoneyNumber(partValue),
              paymentCurrency,
              normalizedExchangeRate,
            )
          : 0;
  const partOriginal = usdToOriginal(
    Math.min(Math.max(paidUSD, 0), safeTotalUSD),
    paymentCurrency,
    normalizedExchangeRate,
  );

  return buildInvoiceMoneyBreakdown({
    totalUSD: safeTotalUSD,
    subtotalUSD,
    paymentStatus: status,
    currency: paymentCurrency,
    exchangeRate: normalizedExchangeRate,
    partValue: partOriginal,
    discountUSD,
    discountAmountUSD,
    discountPercent,
  });
};

const normalizePaymentForStorage = (paymentData: Payment): Payment => {
  const paymentCurrency = normalizeCurrency(
    paymentData.paymentCurrency || paymentData.currency,
  );
  const money = buildPaymentMoneyBreakdown({
    amount: paymentData.amount,
    amountUSD: paymentData.amountUSD,
    currency: paymentCurrency,
    exchangeRate: paymentData.exchangeRate,
    amountOriginal: paymentData.amountOriginal ?? paymentData.amount_base,
  });

  return {
    ...paymentData,
    currency: paymentCurrency,
    paymentCurrency,
    exchangeRate: money.exchangeRate,
    amount: money.amountUSD,
    amount_base: money.amountBase,
    amountUSD: money.amountUSD,
    amountSYP: money.amountSYP,
    amountOriginal: money.amountOriginal,
    balanceSYPChange: paymentData.balanceSYPChange ?? money.amountSYP,
  };
};

const getLegacyInvoiceOriginalAmount = (invoiceData: {
  totalOriginal?: number;
  totalUSD?: number;
  totalPrice?: number;
  currency?: string;
  paymentCurrency?: "USD" | "SYP";
  exchangeRate?: number;
}) => {
  if (invoiceData.totalOriginal !== undefined) {
    return toFiniteNumber(invoiceData.totalOriginal);
  }

  const currency = normalizeCurrency(
    invoiceData.paymentCurrency || invoiceData.currency,
  );
  const exchangeRate = normalizeExchangeRate(currency, invoiceData.exchangeRate);
  return usdToOriginal(
    toFiniteNumber(invoiceData.totalUSD, toFiniteNumber(invoiceData.totalPrice)),
    currency,
    exchangeRate,
  );
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
  const selectedPriceType = normalizeSelectedPriceType(
    rawProduct.selectedPriceType,
  );
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
    payPrice: toFiniteNumber(stockProduct.payPrice, toFiniteNumber(rawProduct.payPrice)),
    wholesalePrice:
      stockProduct.wholesalePrice === undefined
        ? rawProduct.wholesalePrice
        : toFiniteNumber(stockProduct.wholesalePrice),
    superWholesalePrice:
      stockProduct.superWholesalePrice === undefined
        ? rawProduct.superWholesalePrice
        : toFiniteNumber(stockProduct.superWholesalePrice),
    quantity: toFiniteNumber(stockProduct.quantity, toFiniteNumber(rawProduct.quantity)),
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
      exchangeRate: entry.exchangeRate,
      amountOriginal: entry.amountOriginal,
      amountSYP: entry.amountSYP,
    });
  }
};

const toJournalLines = (entries: LedgerEntry[], note: string) => {
  return entries
    .filter((entry) => entry.accountId && Number(entry.amount || 0) > 0)
    .map((entry) => ({
      accountId: entry.accountId as string,
      debit: entry.entryType === "debit" ? Number(entry.amount || 0) : 0,
      credit: entry.entryType === "credit" ? Number(entry.amount || 0) : 0,
      currency: entry.currency || "USD",
      exchangeRate: entry.exchangeRate || 1,
      amountUSD: Number(entry.amount || 0),
      amountSYP: Number(entry.amountSYP || 0),
      amountOriginal:
        entry.amountOriginal === undefined
          ? Number(entry.amount || 0)
          : Number(entry.amountOriginal || 0),
      note,
    }));
};

const applyCustomerPaymentToSell = async (paymentData: Payment) => {
  if (!paymentData.sellId) return null;

  const amount = Math.abs(
    toFiniteNumber(paymentData.amountUSD, toFiniteNumber(paymentData.amount)),
  );

  if (amount <= 0) {
    throw new Error("Invoice payment amount must be greater than zero");
  }

  const sellRef = ref(database, `sells/${paymentData.sellId}`);
  const sellSnapshot = await get(sellRef);

  if (!sellSnapshot.exists()) {
    throw new Error("Sell invoice not found");
  }

  const sellData: sell = sellSnapshot.val();

  if (paymentData.customerId && sellData.customerId !== paymentData.customerId) {
    throw new Error("Payment customer does not match invoice customer");
  }

  const invoiceCurrency = normalizeCurrency(
    sellData.paymentCurrency || sellData.currency,
  );
  const invoiceExchangeRate = normalizeExchangeRate(
    invoiceCurrency,
    sellData.exchangeRate,
  );
  const currentRemainingDebt = toFiniteNumber(
    sellData.remainingUSD,
    toFiniteNumber(sellData.remainingDebt),
  );

  if (currentRemainingDebt <= 0) {
    throw new Error("Invoice is already fully paid");
  }

  if (amount > currentRemainingDebt) {
    throw new Error(
      `Payment amount is greater than invoice remaining debt. Remaining: ${currentRemainingDebt}`,
    );
  }

  const nextRemainingDebt = roundMoney(currentRemainingDebt - amount);
  const nextPaidAmount = roundMoney(
    toFiniteNumber(sellData.totalUSD, toFiniteNumber(sellData.totalPrice)) -
      nextRemainingDebt,
  );
  const nextPaidOriginal = usdToOriginal(
    nextPaidAmount,
    invoiceCurrency,
    invoiceExchangeRate,
  );
  const nextPaymentStatus: sell["paymentStatus"] =
    nextRemainingDebt === 0 ? "cash" : "part";
  const paymentSYPChange =
    invoiceCurrency === "SYP"
      ? usdToOriginal(amount, invoiceCurrency, invoiceExchangeRate)
      : 0;

  paymentData.balanceSYPChange = paymentSYPChange;

  await update(sellRef, {
    remainingDebt: nextRemainingDebt,
    remainingUSD: nextRemainingDebt,
    remainingSYP: usdToSYPForPaymentCurrency(
      nextRemainingDebt,
      invoiceCurrency,
      invoiceExchangeRate,
    ),
    remainingOriginal: usdToOriginal(
      nextRemainingDebt,
      invoiceCurrency,
      invoiceExchangeRate,
    ),
    paidUSD: nextPaidAmount,
    paidSYP: usdToSYPForPaymentCurrency(
      nextPaidAmount,
      invoiceCurrency,
      invoiceExchangeRate,
    ),
    paidOriginal: nextPaidOriginal,
    paymentStatus: nextPaymentStatus,
    partValue: nextPaidOriginal,
    updatedAt: new Date().toISOString(),
  });

  return {
    ...sellData,
    remainingDebt: nextRemainingDebt,
    remainingUSD: nextRemainingDebt,
    remainingSYP: usdToSYPForPaymentCurrency(
      nextRemainingDebt,
      invoiceCurrency,
      invoiceExchangeRate,
    ),
    remainingOriginal: usdToOriginal(
      nextRemainingDebt,
      invoiceCurrency,
      invoiceExchangeRate,
    ),
    paidUSD: nextPaidAmount,
    paidSYP: usdToSYPForPaymentCurrency(
      nextPaidAmount,
      invoiceCurrency,
      invoiceExchangeRate,
    ),
    paidOriginal: nextPaidOriginal,
    paymentStatus: nextPaymentStatus,
    partValue: nextPaidOriginal,
  };
};

const applySupplierPaymentToPurchase = async (paymentData: Payment) => {
  if (!paymentData.purchaseId) return null;

  const rawAmount = toFiniteNumber(
    paymentData.amountUSD,
    toFiniteNumber(paymentData.amount),
  );
  const amount = Math.abs(rawAmount);

  if (rawAmount >= 0 || amount <= 0) {
    throw new Error("Supplier invoice payment amount must reduce supplier debt");
  }

  const purchaseRef = ref(database, `purchases/${paymentData.purchaseId}`);
  const purchaseSnapshot = await get(purchaseRef);

  if (!purchaseSnapshot.exists()) {
    throw new Error("Purchase invoice not found");
  }

  const purchaseData: purchase = purchaseSnapshot.val();

  if (
    paymentData.supplierId &&
    purchaseData.supplierId !== paymentData.supplierId
  ) {
    throw new Error("Payment supplier does not match purchase invoice supplier");
  }

  const invoiceCurrency = normalizeCurrency(
    purchaseData.paymentCurrency || purchaseData.currency,
  );
  const invoiceExchangeRate = normalizeExchangeRate(
    invoiceCurrency,
    purchaseData.exchangeRate,
  );
  const currentRemainingDebt = toFiniteNumber(
    purchaseData.remainingUSD,
    toFiniteNumber(purchaseData.remainingDebt),
  );

  if (currentRemainingDebt <= 0) {
    throw new Error("Purchase invoice is already fully paid");
  }

  if (amount > currentRemainingDebt) {
    throw new Error(
      `Payment amount is greater than purchase invoice remaining debt. Remaining: ${currentRemainingDebt}`,
    );
  }

  const nextRemainingDebt = roundMoney(currentRemainingDebt - amount);
  const nextPaidAmount = roundMoney(
    toFiniteNumber(
      purchaseData.totalUSD,
      toFiniteNumber(purchaseData.totalPrice),
    ) - nextRemainingDebt,
  );
  const nextPaidOriginal = usdToOriginal(
    nextPaidAmount,
    invoiceCurrency,
    invoiceExchangeRate,
  );
  const nextPaymentStatus = nextRemainingDebt === 0 ? "cash" : "part";
  const paymentSYPChange =
    invoiceCurrency === "SYP"
      ? -usdToOriginal(amount, invoiceCurrency, invoiceExchangeRate)
      : 0;

  paymentData.balanceSYPChange = paymentSYPChange;

  await update(purchaseRef, {
    remainingDebt: nextRemainingDebt,
    remainingUSD: nextRemainingDebt,
    remainingSYP: usdToSYPForPaymentCurrency(
      nextRemainingDebt,
      invoiceCurrency,
      invoiceExchangeRate,
    ),
    remainingOriginal: usdToOriginal(
      nextRemainingDebt,
      invoiceCurrency,
      invoiceExchangeRate,
    ),
    paidUSD: nextPaidAmount,
    paidSYP: usdToSYPForPaymentCurrency(
      nextPaidAmount,
      invoiceCurrency,
      invoiceExchangeRate,
    ),
    paidOriginal: nextPaidOriginal,
    paymentStatus: nextPaymentStatus,
    paidAmount: nextPaidAmount,
    partValue: nextPaidOriginal,
    updatedAt: new Date().toISOString(),
  });

  return {
    ...purchaseData,
    remainingDebt: nextRemainingDebt,
    remainingUSD: nextRemainingDebt,
    remainingSYP: usdToSYPForPaymentCurrency(
      nextRemainingDebt,
      invoiceCurrency,
      invoiceExchangeRate,
    ),
    remainingOriginal: usdToOriginal(
      nextRemainingDebt,
      invoiceCurrency,
      invoiceExchangeRate,
    ),
    paidUSD: nextPaidAmount,
    paidSYP: usdToSYPForPaymentCurrency(
      nextPaidAmount,
      invoiceCurrency,
      invoiceExchangeRate,
    ),
    paidOriginal: nextPaidOriginal,
    paymentStatus: nextPaymentStatus,
    paidAmount: nextPaidAmount,
    partValue: nextPaidOriginal,
  };
};

export const handlePurchase = async ({
  newPurchase,
  newProduct,
}: {
  newPurchase: purchase;
  newProduct: Product;
}) => {
  const purchaseStatus = normalizePaymentStatus(newPurchase.paymentStatus);
  const submittedTotal = toFiniteNumber(
    newPurchase.totalPrice,
    toFiniteNumber(newPurchase.payPrice) * toFiniteNumber(newPurchase.quantity),
  );
  const purchaseMoney = buildMoneyFromSubmittedInvoice({
    totalUSD: submittedTotal,
    paymentStatus: purchaseStatus,
    currency: newPurchase.currency,
    exchangeRate: newPurchase.exchangeRate,
    partValue: newPurchase.partValue ?? newPurchase.amount_base,
    remainingDebt: newPurchase.remainingDebt,
  });

  if (purchaseMoney.totalUSD <= 0) {
    throw new Error("Purchase invoice total must be greater than zero");
  }

  if (
    purchaseStatus === "part" &&
    (purchaseMoney.paidUSD <= 0 || purchaseMoney.paidUSD >= purchaseMoney.totalUSD)
  ) {
    throw new Error(
      "Partial purchase payment must be greater than zero and less than invoice total",
    );
  }

  const purchaseData = await createPurchaseInternal({
    ...newPurchase,
    paymentStatus: purchaseStatus,
    currency: purchaseMoney.paymentCurrency,
    paymentCurrency: purchaseMoney.paymentCurrency,
    priceCurrency: purchaseMoney.priceCurrency,
    exchangeRate: purchaseMoney.exchangeRate,
    amount_base: purchaseMoney.totalOriginal,
    totalPrice: purchaseMoney.totalUSD,
    totalUSD: purchaseMoney.totalUSD,
    totalSYP: purchaseMoney.totalSYP,
    totalOriginal: purchaseMoney.totalOriginal,
    paidUSD: purchaseMoney.paidUSD,
    paidSYP: purchaseMoney.paidSYP,
    paidOriginal: purchaseMoney.paidOriginal,
    remainingDebt: purchaseMoney.remainingUSD,
    remainingUSD: purchaseMoney.remainingUSD,
    remainingSYP: purchaseMoney.remainingSYP,
    remainingOriginal: purchaseMoney.remainingOriginal,
    partValue: purchaseMoney.paidOriginal,
  });

  await createOrUpdateProductInternal(newProduct);
  await updateSupplierInternal(purchaseData.supplierId, purchaseData);

  const paidAmount = toFiniteNumber(
    purchaseData.paidUSD,
    purchaseData.totalPrice - purchaseData.remainingDebt,
  );
  const purchaseLedgerEntries: LedgerEntry[] = [
    {
      accountId: purchaseData.inventoryAccountId,
      entryType: "debit",
      amount: purchaseData.totalPrice,
      currency: purchaseMoney.paymentCurrency,
      exchangeRate: purchaseMoney.exchangeRate,
      amountOriginal: purchaseMoney.totalOriginal,
      amountSYP: purchaseMoney.totalSYP,
    },
    {
      accountId: purchaseData.paymentAccountId,
      entryType: "credit",
      amount: paidAmount,
      currency: purchaseMoney.paymentCurrency,
      exchangeRate: purchaseMoney.exchangeRate,
      amountOriginal: purchaseMoney.paidOriginal,
      amountSYP: purchaseMoney.paidSYP,
    },
    {
      accountId: purchaseData.payableAccountId,
      entryType: "credit",
      amount: purchaseData.remainingDebt,
      currency: purchaseMoney.paymentCurrency,
      exchangeRate: purchaseMoney.exchangeRate,
      amountOriginal: purchaseMoney.remainingOriginal,
      amountSYP: purchaseMoney.remainingSYP,
    },
  ];

  await postLedgerEntries(purchaseLedgerEntries);

  await createJournalEntryInternal({
    date: purchaseData.date,
    description: `قيد شراء ${purchaseData.name || purchaseData.code}`,
    referenceType: "purchase",
    referenceId: purchaseData.id,
    lines: toJournalLines(
        purchaseLedgerEntries,
      `قيد شراء ${purchaseData.name || purchaseData.code}`
    ),
  });

  if (paidAmount > 0) {
    await createPaymentInternal({
      type: "expense",
      supplierId: purchaseData.supplierId,
      purchaseId: purchaseData.id,
      paymentAccountId: purchaseData.paymentAccountId,
      payableAccountId: purchaseData.payableAccountId,
      amount: -paidAmount,
      amountUSD: -paidAmount,
      amountSYP: -purchaseMoney.paidSYP,
      amountOriginal: -purchaseMoney.paidOriginal,
      note:
        purchaseData.remainingDebt === 0
          ? `${newProduct.name} دفع كامل ثمن شراء`
          : `${newProduct.name} دفعة من ثمن شراء`,
      currency: purchaseData.currency,
      paymentCurrency: purchaseData.paymentCurrency,
      exchangeRate: purchaseData.exchangeRate,
      amount_base: -purchaseMoney.paidOriginal,
    });
  }

  return purchaseData;
};

export const handleBulkPurchase = async ({
  newPurchase,
}: {
  newPurchase: purchase;
}) => {
  const products = Array.isArray(newPurchase.products)
    ? newPurchase.products
    : [];

  if (!products.length) {
    throw new Error("Purchase invoice must include at least one product");
  }

  const totalPrice = products.reduce(
    (sum, product) =>
      sum +
      Number(product.lineTotal || Number(product.payPrice || 0) * Number(product.quantity || 0)),
    0
  );
  const purchaseStatus = normalizePaymentStatus(newPurchase.paymentStatus);
  const purchaseMoney = buildMoneyFromSubmittedInvoice({
    totalUSD: totalPrice,
    paymentStatus: purchaseStatus,
    currency: newPurchase.currency,
    exchangeRate: newPurchase.exchangeRate,
    partValue: newPurchase.partValue ?? newPurchase.amount_base,
    remainingDebt: newPurchase.remainingDebt,
  });

  if (purchaseMoney.totalUSD <= 0) {
    throw new Error("Purchase invoice total must be greater than zero");
  }

  if (
    purchaseStatus === "part" &&
    (purchaseMoney.paidUSD <= 0 || purchaseMoney.paidUSD >= purchaseMoney.totalUSD)
  ) {
    throw new Error(
      "Partial purchase payment must be greater than zero and less than invoice total",
    );
  }

  const purchaseData = await createPurchaseInternal({
    ...newPurchase,
    name: newPurchase.name || `Purchase invoice (${products.length})`,
    code: newPurchase.code || `PINV-${Date.now()}`,
    warehouse:
      newPurchase.warehouse ||
      Array.from(new Set(products.map((product) => product.warehouse))).join(", "),
    quantity:
      newPurchase.quantity ||
      products.reduce((sum, product) => sum + Number(product.quantity || 0), 0),
    payPrice: newPurchase.payPrice || 0,
    paymentStatus: purchaseStatus,
    currency: purchaseMoney.paymentCurrency,
    paymentCurrency: purchaseMoney.paymentCurrency,
    priceCurrency: purchaseMoney.priceCurrency,
    exchangeRate: purchaseMoney.exchangeRate,
    totalPrice: purchaseMoney.totalUSD,
    amount_base: purchaseMoney.totalOriginal,
    totalUSD: purchaseMoney.totalUSD,
    totalSYP: purchaseMoney.totalSYP,
    totalOriginal: purchaseMoney.totalOriginal,
    paidUSD: purchaseMoney.paidUSD,
    paidSYP: purchaseMoney.paidSYP,
    paidOriginal: purchaseMoney.paidOriginal,
    remainingDebt: purchaseMoney.remainingUSD,
    remainingUSD: purchaseMoney.remainingUSD,
    remainingSYP: purchaseMoney.remainingSYP,
    remainingOriginal: purchaseMoney.remainingOriginal,
    partValue: purchaseMoney.paidOriginal,
    products: products.map((product) => ({
      ...product,
      lineTotal:
        product.lineTotal ||
        Number(product.payPrice || 0) * Number(product.quantity || 0),
    })),
  });

  for (const product of products) {
    await createOrUpdateProductInternal({
      id: product.id || "",
      name: product.name,
      code: product.code,
      category: product.category,
      warehouse: product.warehouse,
      payPrice: Number(product.payPrice || 0),
      wholesalePrice: Number(product.wholesalePrice || 0),
      superWholesalePrice: Number(product.superWholesalePrice || 0),
      sellPrice: Number(product.sellPrice || 0),
      unit: product.unit,
      quantity: Number(product.quantity || 0),
      alertQuantity:
        product.alertQuantity === undefined
          ? undefined
          : Number(product.alertQuantity || 0),
      updatedDate: "",
    });
  }

  await updateSupplierInternal(purchaseData.supplierId, purchaseData);

  const paidAmount = toFiniteNumber(
    purchaseData.paidUSD,
    purchaseData.totalPrice - purchaseData.remainingDebt,
  );
  const note = `قيد فاتورة شراء ${purchaseData.code}`;

  const purchaseLedgerEntries: LedgerEntry[] = [
    {
      accountId: purchaseData.inventoryAccountId,
      entryType: "debit",
      amount: purchaseData.totalPrice,
      currency: purchaseMoney.paymentCurrency,
      exchangeRate: purchaseMoney.exchangeRate,
      amountOriginal: purchaseMoney.totalOriginal,
      amountSYP: purchaseMoney.totalSYP,
    },
    {
      accountId: purchaseData.paymentAccountId,
      entryType: "credit",
      amount: paidAmount,
      currency: purchaseMoney.paymentCurrency,
      exchangeRate: purchaseMoney.exchangeRate,
      amountOriginal: purchaseMoney.paidOriginal,
      amountSYP: purchaseMoney.paidSYP,
    },
    {
      accountId: purchaseData.payableAccountId,
      entryType: "credit",
      amount: purchaseData.remainingDebt,
      currency: purchaseMoney.paymentCurrency,
      exchangeRate: purchaseMoney.exchangeRate,
      amountOriginal: purchaseMoney.remainingOriginal,
      amountSYP: purchaseMoney.remainingSYP,
    },
  ];

  await postLedgerEntries(purchaseLedgerEntries);

  await createJournalEntryInternal({
    date: purchaseData.date,
    description: note,
    referenceType: "purchase",
    referenceId: purchaseData.id,
    lines: toJournalLines(
      purchaseLedgerEntries,
      note
    ),
  });

  if (paidAmount > 0) {
    await createPaymentInternal({
      type: "expense",
      supplierId: purchaseData.supplierId,
      purchaseId: purchaseData.id,
      paymentAccountId: purchaseData.paymentAccountId,
      payableAccountId: purchaseData.payableAccountId,
      amount: -paidAmount,
      amountUSD: -paidAmount,
      amountSYP: -purchaseMoney.paidSYP,
      amountOriginal: -purchaseMoney.paidOriginal,
      note:
        purchaseData.remainingDebt === 0
          ? "دفع كامل ثمن فاتورة شراء"
          : "دفعة من ثمن فاتورة شراء",
      currency: purchaseData.currency,
      paymentCurrency: purchaseData.paymentCurrency,
      exchangeRate: purchaseData.exchangeRate,
      amount_base: -purchaseMoney.paidOriginal,
    });
  }

  return purchaseData;
};

export const handleSell = async ({
  newSell,
  stockUpdater,
}: {
  newSell: sell;
  stockUpdater?: SellStockUpdater;
}) => {
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
        );

        normalizedProducts.push(
          normalizeSellProductFromStock(product, stockProduct),
        );
      }

      productsForSell = normalizedProducts;
    }

    const subtotal = productsForSell.reduce(
      (sum, product) =>
        sum + toFiniteNumber(product.sellPrice) * toFiniteNumber(product.qty),
      0,
    );
    const discountAmountUSD = getSubmittedDiscountAmount(newSell);
    const discountPercent = getSubmittedDiscountPercent(newSell);
    assertInvoiceDiscountIsValid({
      subtotalUSD: subtotal,
      discountPercent,
      discountAmountUSD,
    });
    const sellStatus = normalizePaymentStatus(newSell.paymentStatus);
    const sellMoney = buildInvoiceMoneyBreakdown({
      subtotalUSD: subtotal,
      paymentStatus: sellStatus,
      currency: newSell.currency,
      exchangeRate: newSell.exchangeRate,
      partValue: newSell.partValue,
      discountAmountUSD,
      discountPercent,
    });
    const totalPrice = sellMoney.totalUSD;
    const paidAmount = sellMoney.paidUSD;

    if (totalPrice <= 0) {
      throw new Error("Sell invoice total must be greater than zero");
    }

    if (
      sellStatus === "part" &&
      (paidAmount <= 0 || paidAmount >= totalPrice)
    ) {
      throw new Error(
        "Partial payment must be greater than zero and less than invoice total",
      );
    }

    const sellData = await createSellInternal({
      ...newSell,
      products: productsForSell,
      paymentStatus: sellStatus,
      currency: sellMoney.paymentCurrency,
      paymentCurrency: sellMoney.paymentCurrency,
      priceCurrency: sellMoney.priceCurrency,
      subtotalUSD: sellMoney.subtotalUSD,
      totalPrice: sellMoney.totalUSD,
      totalUSD: sellMoney.totalUSD,
      totalSYP: sellMoney.totalSYP,
      totalOriginal: sellMoney.totalOriginal,
      paidUSD: sellMoney.paidUSD,
      paidSYP: sellMoney.paidSYP,
      paidOriginal: sellMoney.paidOriginal,
      remainingDebt: sellMoney.remainingUSD,
      remainingUSD: sellMoney.remainingUSD,
      remainingSYP: sellMoney.remainingSYP,
      remainingOriginal: sellMoney.remainingOriginal,
      exchangeRate: sellMoney.exchangeRate,
      amount_base: sellMoney.totalOriginal,
      partValue: sellMoney.paidOriginal,
      discountType: sellMoney.discountType,
      discountPercent: sellMoney.discountPercent,
      discountPercentUSD: sellMoney.discountPercentUSD,
      discountAmountUSD: sellMoney.discountAmountUSD,
      discountUSD: sellMoney.discountUSD,
      discountSYP: sellMoney.discountSYP,
      discountOriginal: sellMoney.discountOriginal,
      discount: sellMoney.discountUSD,
    });

    for (const product of productsForSell) {
      if (stockUpdater) {
        await stockUpdater(product);
      } else {
        await updateQuantityOnSell(product.id, product.warehouse, product.qty);
      }
    }

    await updateCustomerInternal(sellData.customerId, sellData);
    const sellLedgerEntries: LedgerEntry[] = [
      {
        accountId: sellData.paymentAccountId,
        entryType: "debit",
        amount: paidAmount,
        currency: sellMoney.paymentCurrency,
        exchangeRate: sellMoney.exchangeRate,
        amountOriginal: sellMoney.paidOriginal,
        amountSYP: sellMoney.paidSYP,
      },
      {
        accountId: sellData.receivableAccountId,
        entryType: "debit",
        amount: sellData.remainingDebt,
        currency: sellMoney.paymentCurrency,
        exchangeRate: sellMoney.exchangeRate,
        amountOriginal: sellMoney.remainingOriginal,
        amountSYP: sellMoney.remainingSYP,
      },
      {
        accountId: sellData.salesAccountId,
        entryType: "credit",
        amount: sellData.totalPrice,
        currency: sellMoney.paymentCurrency,
        exchangeRate: sellMoney.exchangeRate,
        amountOriginal: sellMoney.totalOriginal,
        amountSYP: sellMoney.totalSYP,
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
        `قيد بيع ${sellData.products?.[0]?.name || sellData.id}`
      ),
    });

    if (sellData.remainingDebt === 0) {
      await createPaymentInternal({
        type: "income",
        customerId: sellData.customerId,
        sellId: sellData.id,
        paymentAccountId: sellData.paymentAccountId,
        receivableAccountId: sellData.receivableAccountId,
        salesAccountId: sellData.salesAccountId,
        amount: sellData.paidUSD ?? sellData.totalPrice,
        amountUSD: sellData.paidUSD ?? sellData.totalPrice,
        amountSYP: sellData.paidSYP ?? 0,
        amountOriginal: sellData.paidOriginal ?? sellData.totalPrice,
        note: "دفع كامل ثمن بيع",
        currency: sellData.currency,
        paymentCurrency: sellData.paymentCurrency,
        exchangeRate: sellData.exchangeRate,
        amount_base: sellData.paidOriginal ?? sellData.amount_base,
      });
    } else if (sellData.remainingDebt < sellData.totalPrice) {
      await createPaymentInternal({
        type: "income",
        customerId: sellData.customerId,
        sellId: sellData.id,
        paymentAccountId: sellData.paymentAccountId,
        receivableAccountId: sellData.receivableAccountId,
        salesAccountId: sellData.salesAccountId,
        amount: paidAmount,
        amountUSD: paidAmount,
        amountSYP: sellData.paidSYP ?? 0,
        amountOriginal: sellData.paidOriginal ?? paidAmount,
        note: "دفعة من ثمن بيع",
        currency: sellData.currency,
        paymentCurrency: sellData.paymentCurrency,
        exchangeRate: sellData.exchangeRate,
        amount_base: sellData.paidOriginal ?? sellData.partValue ?? paidAmount,
      });
    }

    return sellData;
  } catch (err) {
    console.log(err);
    throw err;
  }
};

export const customerPayment = async (paymentData: Payment) => {
  const normalizedPayment = normalizePaymentForStorage(paymentData);
  const updatedSell = await applyCustomerPaymentToSell(normalizedPayment);
  const data = await createPaymentInternal(normalizedPayment);
  const ledgerAmount = Math.abs(
    toFiniteNumber(data.amountUSD, toFiniteNumber(data.amount)),
  );
  const paymentCurrency = normalizeCurrency(data.paymentCurrency || data.currency);
  const paymentOriginalAmount = Math.abs(
    toFiniteNumber(
      data.amountOriginal,
      toFiniteNumber(data.amount_base, ledgerAmount),
    ),
  );
  const paymentSYPAmount =
    paymentCurrency === "SYP"
      ? Math.abs(toFiniteNumber(data.amountSYP, paymentOriginalAmount))
      : 0;
  const paymentLedgerEntries: LedgerEntry[] = [
    {
      accountId: data.paymentAccountId,
      entryType: "debit",
      amount: ledgerAmount,
      currency: paymentCurrency,
      exchangeRate: data.exchangeRate,
      amountOriginal: paymentOriginalAmount,
      amountSYP: paymentSYPAmount,
    },
    {
      accountId: data.receivableAccountId,
      entryType: "credit",
      amount: ledgerAmount,
      currency: paymentCurrency,
      exchangeRate: data.exchangeRate,
      amountOriginal: paymentOriginalAmount,
      amountSYP: paymentSYPAmount,
    },
  ];

  if (data.customerId) {
    await updateCustomerInternal(data.customerId, undefined, data);
  }

  await postLedgerEntries(paymentLedgerEntries);

  await createJournalEntryInternal({
    date: data.date,
    description: data.note || "قيد دفعة عميل",
    referenceType: "payment",
    referenceId: data.id,
    lines: toJournalLines(
      paymentLedgerEntries,
      data.note || "قيد دفعة عميل"
    ),
  });

  return { payment: data, sell: updatedSell };
};

export const supplierPayment = async (paymentData: Payment) => {
  const normalizedPayment = normalizePaymentForStorage(paymentData);
  const updatedPurchase = await applySupplierPaymentToPurchase(normalizedPayment);
  const data = await createPaymentInternal(normalizedPayment);
  const ledgerAmount = Math.abs(
    toFiniteNumber(data.amountUSD, toFiniteNumber(data.amount)),
  );
  const paymentCurrency = normalizeCurrency(data.paymentCurrency || data.currency);
  const paymentOriginalAmount = Math.abs(
    toFiniteNumber(
      data.amountOriginal,
      toFiniteNumber(data.amount_base, ledgerAmount),
    ),
  );
  const paymentSYPAmount =
    paymentCurrency === "SYP"
      ? Math.abs(toFiniteNumber(data.amountSYP, paymentOriginalAmount))
      : 0;
  const paymentLedgerEntries: LedgerEntry[] = [
    {
      accountId: data.payableAccountId,
      entryType: "debit",
      amount: ledgerAmount,
      currency: paymentCurrency,
      exchangeRate: data.exchangeRate,
      amountOriginal: paymentOriginalAmount,
      amountSYP: paymentSYPAmount,
    },
    {
      accountId: data.paymentAccountId,
      entryType: "credit",
      amount: ledgerAmount,
      currency: paymentCurrency,
      exchangeRate: data.exchangeRate,
      amountOriginal: paymentOriginalAmount,
      amountSYP: paymentSYPAmount,
    },
  ];

  if (data.supplierId) {
    await updateSupplierInternal(data.supplierId, undefined, data);
  }

  await postLedgerEntries(paymentLedgerEntries);

  await createJournalEntryInternal({
    date: data.date,
    description: data.note || "قيد دفعة مورد",
    referenceType: "payment",
    referenceId: data.id,
    lines: toJournalLines(
      paymentLedgerEntries,
      data.note || "قيد دفعة مورد"
    ),
  });

  return { payment: data, purchase: updatedPurchase };
};

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
  try {
    const returnQty = Math.abs(Number(newReturn.qty || 0));

    if (!returnQty) {
      throw new Error("كمية الإرجاع غير صحيحة");
    }

    await createReturnInternal({
      ...newReturn,
      qty: returnQty,
      type: "purchase-return",
    });

    const purchaseData = await getPurchaseByIdInternal(newReturn.referenceId);
    const returnCurrency = normalizeCurrency(
      purchaseData?.paymentCurrency || purchaseData?.currency,
    );
    const returnExchangeRate = normalizeExchangeRate(
      returnCurrency,
      purchaseData?.exchangeRate,
    );

    const paymentAmount =
      newReturn.returnType === "cash"
        ? newReturn.returnValue
        : newReturn.returnType === "part"
        ? newReturn.partValue
        : 0;
    const paymentOriginal = usdToOriginal(
      paymentAmount,
      returnCurrency,
      returnExchangeRate,
    );

    await createPaymentInternal({
      type: "return",
      supplierId: newReturn.supplierId,
      paymentAccountId: newReturn.paymentAccountId,
      payableAccountId: newReturn.payableAccountId,
      amount: paymentAmount,
      amountUSD: paymentAmount,
      amountSYP: usdToSYPForPaymentCurrency(
        paymentAmount,
        returnCurrency,
        returnExchangeRate,
      ),
      amountOriginal: paymentOriginal,
      note: `اعادة منتجات للمورد (${newReturn.productCode})`,
      currency: returnCurrency,
      paymentCurrency: returnCurrency,
      exchangeRate: returnExchangeRate,
      amount_base: paymentOriginal,
    });

    let balanceChange = 0;
    if (newReturn.returnType === "debt") {
      balanceChange = -newReturn.returnValue;
    } else if (newReturn.returnType === "part") {
      balanceChange = -(newReturn.returnValue - newReturn.partValue);
    }

    const balanceSYPChange =
      returnCurrency === "SYP"
        ? usdToOriginal(balanceChange, returnCurrency, returnExchangeRate)
        : 0;

    await updateSupplierBalanceInternal(
      newReturn.supplierId,
      balanceChange,
      balanceSYPChange,
    );

    const payableReturnAmount = Math.max(
      newReturn.returnValue - paymentAmount,
      0,
    );
    await postLedgerEntries([
      {
        accountId: newReturn.paymentAccountId,
        entryType: "debit",
        amount: paymentAmount,
        currency: returnCurrency,
        exchangeRate: returnExchangeRate,
        amountOriginal: paymentOriginal,
        amountSYP: usdToSYPForPaymentCurrency(
          paymentAmount,
          returnCurrency,
          returnExchangeRate,
        ),
      },
      {
        accountId: newReturn.payableAccountId,
        entryType: "debit",
        amount: payableReturnAmount,
        currency: returnCurrency,
        exchangeRate: returnExchangeRate,
        amountOriginal: usdToOriginal(
          payableReturnAmount,
          returnCurrency,
          returnExchangeRate,
        ),
        amountSYP: usdToSYPForPaymentCurrency(
          payableReturnAmount,
          returnCurrency,
          returnExchangeRate,
        ),
      },
      {
        accountId: newReturn.inventoryAccountId,
        entryType: "credit",
        amount: newReturn.returnValue,
        currency: returnCurrency,
        exchangeRate: returnExchangeRate,
        amountOriginal: usdToOriginal(
          newReturn.returnValue,
          returnCurrency,
          returnExchangeRate,
        ),
        amountSYP: usdToSYPForPaymentCurrency(
          newReturn.returnValue,
          returnCurrency,
          returnExchangeRate,
        ),
      },
    ]);

    const updatedQuantity = Math.max(
      Number(purchaseData?.quantity || 0) - returnQty,
      0
    );

    await updatePurchaseInternal(newReturn.referenceId, {
      quantity: updatedQuantity,
    });

    return { success: true, message: "تمت عملية الإرجاع بنجاح" };
  } catch (error) {
    console.error("خطأ في عملية إرجاع المورد:", error);
    return { success: false, message: "فشلت عملية الإرجاع", error };
  }
};

export const handleCustomerReturn = async (newReturn: {
  productCode: string;
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
}) => {
  const returnQty = Math.abs(Number(newReturn.qty || 0));
  if (!returnQty) {
    throw new Error("كمية الإرجاع غير صحيحة");
  }

  const returnableProduct = await getReturnableProductFromSellInternal(
    newReturn.referenceId,
    newReturn.productCode,
    newReturn.warehouse
  );

  if (!returnableProduct) {
    throw new Error("المنتج غير موجود في فاتورة البيع");
  }

  if (returnQty > returnableProduct.qty) {
    throw new Error("كمية الإرجاع أكبر من الكمية المتبقية في الفاتورة");
  }

  const originalSellSnap = await get(
    ref(database, `sells/${newReturn.referenceId}`),
  );
  const originalSell = originalSellSnap.exists()
    ? (originalSellSnap.val() as sell)
    : null;
  const returnCurrency = normalizeCurrency(
    originalSell?.paymentCurrency || originalSell?.currency,
  );
  const returnExchangeRate = normalizeExchangeRate(
    returnCurrency,
    originalSell?.exchangeRate,
  );
  const returnValue = returnQty * returnableProduct.sellPrice;
  const refundedCash =
    newReturn.returnType === "cash"
      ? returnValue
      : newReturn.returnType === "part"
      ? newReturn.partValue
      : 0;
  const refundedOriginal = usdToOriginal(
    refundedCash,
    returnCurrency,
    returnExchangeRate,
  );

  await createReturnInternal({
    ...newReturn,
    qty: returnQty,
    returnValue,
    type: "sale-return",
  });

  await createPaymentInternal({
    type: "return",
    customerId: newReturn.customerId,
    paymentAccountId: newReturn.paymentAccountId,
    receivableAccountId: newReturn.receivableAccountId,
    salesAccountId: newReturn.salesAccountId,
    amount:
      -(newReturn.returnType === "cash"
        ? returnValue
        : newReturn.returnType === "part"
        ? newReturn.partValue
        : 0),
    amountUSD: -refundedCash,
    amountSYP: -usdToSYPForPaymentCurrency(
      refundedCash,
      returnCurrency,
      returnExchangeRate,
    ),
    amountOriginal: -refundedOriginal,
    note: `اعادة منتجات من الزبون (${newReturn.productCode} عدد ${newReturn.qty})`,
    currency: returnCurrency,
    paymentCurrency: returnCurrency,
    exchangeRate: returnExchangeRate,
    amount_base: -refundedOriginal,
  });

  const receivableReturnAmount = Math.max(returnValue - refundedCash, 0);
  await postLedgerEntries([
    {
      accountId: newReturn.salesAccountId,
      entryType: "debit",
      amount: returnValue,
      currency: returnCurrency,
      exchangeRate: returnExchangeRate,
      amountOriginal: usdToOriginal(
        returnValue,
        returnCurrency,
        returnExchangeRate,
      ),
      amountSYP: usdToSYPForPaymentCurrency(
        returnValue,
        returnCurrency,
        returnExchangeRate,
      ),
    },
    {
      accountId: newReturn.paymentAccountId,
      entryType: "credit",
      amount: refundedCash,
      currency: returnCurrency,
      exchangeRate: returnExchangeRate,
      amountOriginal: refundedOriginal,
      amountSYP: usdToSYPForPaymentCurrency(
        refundedCash,
        returnCurrency,
        returnExchangeRate,
      ),
    },
    {
      accountId: newReturn.receivableAccountId,
      entryType: "credit",
      amount: receivableReturnAmount,
      currency: returnCurrency,
      exchangeRate: returnExchangeRate,
      amountOriginal: usdToOriginal(
        receivableReturnAmount,
        returnCurrency,
        returnExchangeRate,
      ),
      amountSYP: usdToSYPForPaymentCurrency(
        receivableReturnAmount,
        returnCurrency,
        returnExchangeRate,
      ),
    },
  ]);

  if (newReturn.returnType === "debt") {
    const updatedCustomer = await updateCustomerBalanceInternal(
      newReturn.customerId,
      returnValue,
      returnCurrency === "SYP"
        ? usdToOriginal(returnValue, returnCurrency, returnExchangeRate)
        : 0,
    );
    if (!updatedCustomer) {
      throw new Error("الزبون غير موجود لتحديث الرصيد");
    }
  } else if (newReturn.returnType === "part") {
    const updatedCustomer = await updateCustomerBalanceInternal(
      newReturn.customerId,
      returnValue - newReturn.partValue,
      returnCurrency === "SYP"
        ? usdToOriginal(
            returnValue - newReturn.partValue,
            returnCurrency,
            returnExchangeRate,
          )
        : 0,
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

export const warehouseTransfer = async (transferData: {
  productId: string;
  oldWarehouse: string;
  newWarehouse: string;
  exchangeRate: number;
  amount_base: number;
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
      performedBy: "admin",
      referenceId: `TR-${Date.now()}`,
      note: transferData.note,
    });

    await updateQuantityOnSell(
      transferData.productId,
      transferData.oldWarehouse,
      transferData.quantity
    );

    await createOrUpdateProductInternal({
      ...product.product,
      warehouse: transferData.newWarehouse,
      quantity: transferData.quantity,
      sellPrice: transferData.newSellPrice || product.product.sellPrice,
    });

    const transferCurrency = normalizeCurrency(transferData.currency);
    const transferExchangeRate = normalizeExchangeRate(
      transferCurrency,
      transferData.exchangeRate,
    );
    const transferAmountOriginal = Math.max(toFiniteNumber(transferData.amount), 0);
    const transferAmountUSD = originalToUSD(
      transferAmountOriginal,
      transferCurrency,
      transferExchangeRate,
    );

    if (transferAmountUSD > 0) {
      const paymentStatus = transferData.paymentStatus || "cash";
      const paidOriginal =
        paymentStatus === "cash"
          ? transferAmountOriginal
          : paymentStatus === "part"
          ? Number(transferData.partValue || 0)
          : 0;
      const paidAmount = originalToUSD(
        paidOriginal,
        transferCurrency,
        transferExchangeRate,
      );
      const payableAmount = Math.max(transferAmountUSD - paidAmount, 0);
      const payableOriginal = Math.max(transferAmountOriginal - paidOriginal, 0);

      if (paidAmount > 0) {
        await createPaymentInternal({
        type: "expense",
        supplierId: "transfer",
        expenseAccountId: transferData.expenseAccountId,
        paymentAccountId: transferData.paymentAccountId,
        currency: transferCurrency,
        paymentCurrency: transferCurrency,
        exchangeRate: transferExchangeRate,
        amount_base: -paidOriginal,
        amount: Number(-paidAmount),
        amountUSD: -paidAmount,
        amountSYP: -usdToSYPForPaymentCurrency(
          paidAmount,
          transferCurrency,
          transferExchangeRate,
        ),
        amountOriginal: -paidOriginal,
        note:
          `نقل ${product.product.name} // ${transferData.note}` ||
          `Transfer: ${product.product.name || transferData.productId}`,
        });
      }

      await postLedgerEntries([
        {
          accountId: transferData.expenseAccountId,
          entryType: "debit",
          amount: transferAmountUSD,
          currency: transferCurrency,
          exchangeRate: transferExchangeRate,
          amountOriginal: transferAmountOriginal,
          amountSYP: usdToSYPForPaymentCurrency(
            transferAmountUSD,
            transferCurrency,
            transferExchangeRate,
          ),
        },
        {
          accountId: transferData.paymentAccountId,
          entryType: "credit",
          amount: paidAmount,
          currency: transferCurrency,
          exchangeRate: transferExchangeRate,
          amountOriginal: paidOriginal,
          amountSYP: usdToSYPForPaymentCurrency(
            paidAmount,
            transferCurrency,
            transferExchangeRate,
          ),
        },
        {
          accountId: transferData.payableAccountId,
          entryType: "credit",
          amount: payableAmount,
          currency: transferCurrency,
          exchangeRate: transferExchangeRate,
          amountOriginal: payableOriginal,
          amountSYP: usdToSYPForPaymentCurrency(
            payableAmount,
            transferCurrency,
            transferExchangeRate,
          ),
        },
      ]);
    }
  } catch (err) {
    console.log(err);
    return err;
  }
};

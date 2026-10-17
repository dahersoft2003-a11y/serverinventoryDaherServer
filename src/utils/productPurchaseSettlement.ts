import { Product } from "../types/product";
import { purchase } from "../types/purchase";
import { Payment } from "../types/payment";
import { JournalEntry, JournalEntryLine } from "../types/journalEntry";
import { applyFinanceJournal, FinanceState } from "./goodsSettlement";
import { roundMoney, toMoneyNumber } from "./money";
import { weightedPurchaseCost } from "./productCost";

export type ProductPurchaseContext = {
  purchaseId: string;
  productId: string;
  paymentId: string;
  journalId: string;
  requestKey: string;
  fingerprint: string;
  now: string;
};

export const applyProductPurchaseSettlement = (
  original: FinanceState,
  invoice: purchase,
  item: Product | Product[],
  context: ProductPurchaseContext,
) => {
  const state: FinanceState = JSON.parse(JSON.stringify(original || {}));
  const previous = state.financialRequests?.[context.requestKey];
  if (previous) {
    if (previous.fingerprint !== context.fingerprint) {
      throw new Error("معرف طلب الشراء مستخدم لعملية مختلفة");
    }
    const saved = state.purchases?.[previous.purchaseId] as purchase | undefined;
    if (!saved) throw new Error("فاتورة الشراء السابقة غير مكتملة");
    return { state, purchase: saved, duplicate: true };
  }

  const items = Array.isArray(item) ? item : [item];
  if (!items.length) throw new Error("فاتورة الشراء تحتاج منتجًا واحدًا على الأقل");
  let quantity = 0;
  let total = 0;
  for (const product of items) {
    const lineQuantity = Number(product.quantity);
    const unitPrice = Number(product.payPrice);
    if (!Number.isFinite(lineQuantity) || lineQuantity <= 0 || !Number.isFinite(unitPrice) || unitPrice <= 0) {
      throw new Error("كمية الشراء وسعره يجب أن يكونا أكبر من صفر");
    }
    for (const price of [product.wholesalePrice, product.superWholesalePrice, product.sellPrice]) {
      if (price !== undefined && (!Number.isFinite(Number(price)) || Number(price) < 0)) {
        throw new Error("سعر المنتج غير صالح");
      }
    }
    quantity += lineQuantity;
    total += lineQuantity * unitPrice;
  }
  total = roundMoney(total);
  if (!Number.isFinite(total) || total <= 0 || roundMoney(toMoneyNumber(invoice.totalPrice)) !== total || Number(invoice.quantity) !== quantity ||
      !Array.isArray(item) && Number(invoice.payPrice) !== Number(item.payPrice)) {
    throw new Error("إجمالي الفاتورة لا يطابق الكمية وسعر الشراء");
  }
  const paid = roundMoney(toMoneyNumber(invoice.paidUSD));
  const remaining = roundMoney(toMoneyNumber(invoice.remainingUSD, invoice.remainingDebt));
  if (paid < 0 || remaining < 0 || roundMoney(paid + remaining) !== total) {
    throw new Error("المدفوع والمتبقي لا يساويان إجمالي الفاتورة");
  }
  if (invoice.paymentStatus === "cash" && (paid !== total || remaining !== 0) ||
      invoice.paymentStatus === "debt" && (paid !== 0 || remaining !== total) ||
      invoice.paymentStatus === "part" && (paid <= 0 || remaining <= 0)) {
    throw new Error("حالة الدفع لا تطابق مبالغ الفاتورة");
  }

  const supplier = state.supplier?.[invoice.supplierId];
  if (!supplier) throw new Error("المورد غير موجود");
  const accountIds = [invoice.inventoryAccountId, invoice.payableAccountId, ...(paid > 0 ? [invoice.paymentAccountId] : [])];
  if (accountIds.some((id) => !id) || new Set(accountIds).size !== accountIds.length) {
    throw new Error("اختر حسابات مخزون وموردين ودفع مختلفة");
  }
  const expectedAccounts = [
    [invoice.inventoryAccountId, "Inventory", "Asset"],
    [invoice.payableAccountId, "AccountsPayable", "Liability"],
    ...(paid > 0 ? [[invoice.paymentAccountId, "CashOrBank", "Asset"]] : []),
  ];
  for (const [id, category, type] of expectedAccounts) {
    const account = state.accounts?.[id as string];
    if (!account || account.isActive === false || account.allowTransactions === false || account.type !== type ||
        (category === "CashOrBank" ? !["Cash", "Bank"].includes(account.category) : account.category !== category)) {
      throw new Error("حساب الشراء غير موجود أو نوعه غير مناسب");
    }
  }

  if (state.purchases?.[context.purchaseId] || state.journalEntries?.[context.journalId] || state.payment?.[context.paymentId]) {
    throw new Error("معرف عملية الشراء مستخدم مسبقًا");
  }
  const seen = new Set<string>();
  for (const product of items) {
    const warehouseKey = Object.keys(state.products || {}).find(
      (key) => key.trim().toLowerCase() === String(product.warehouse || "").trim().toLowerCase(),
    );
    if (!warehouseKey || !product.id) throw new Error("المنتج غير موجود في قائمة المستودع");
    const identity = `${warehouseKey}/${product.id}`;
    if (seen.has(identity)) throw new Error("المنتج مكرر في فاتورة الشراء");
    seen.add(identity);
    const current = state.products[warehouseKey]?.[product.id] as Product | undefined;
    if (!current || current.code !== product.code || String(current.warehouse || warehouseKey).trim().toLowerCase() !== String(product.warehouse || "").trim().toLowerCase()) {
      throw new Error("بيانات المنتج تغيرت؛ أعد اختيار المنتج من القائمة");
    }
    const currentQuantity = Number(current.quantity || 0);
    const reservedQuantity = Number(current.reservedQuantity || 0);
    if (!Number.isFinite(currentQuantity) || currentQuantity < 0 || !Number.isFinite(reservedQuantity) || reservedQuantity < 0 || reservedQuantity > currentQuantity) {
      throw new Error("رصيد المنتج الحالي غير صالح");
    }
    state.products[warehouseKey][product.id] = JSON.parse(JSON.stringify({
      ...current,
      ...product,
      id: product.id,
      name: product.name || current.name,
      category: product.category ?? current.category,
      unit: product.unit ?? current.unit,
      wholesalePrice: product.wholesalePrice ?? current.wholesalePrice,
      superWholesalePrice: product.superWholesalePrice ?? current.superWholesalePrice,
      sellPrice: product.sellPrice ?? current.sellPrice,
      alertQuantity: product.alertQuantity ?? current.alertQuantity,
      warehouse: current.warehouse || warehouseKey,
      quantity: currentQuantity + Number(product.quantity),
      reservedQuantity,
      payPrice: weightedPurchaseCost(currentQuantity, Number(current.payPrice || 0), Number(product.quantity), Number(product.payPrice)),
      updatedDate: context.now,
    }));
  }
  state.purchases ||= {};
  const storedInvoice = JSON.parse(JSON.stringify(invoice)) as purchase;
  state.purchases[context.purchaseId] = storedInvoice;
  state.supplier[invoice.supplierId] = {
    ...supplier,
    balance: roundMoney(toMoneyNumber(supplier.balance) + remaining),
    balanceUSD: roundMoney(toMoneyNumber(supplier.balanceUSD, supplier.balance) + remaining),
    balanceSYP: roundMoney(toMoneyNumber(supplier.balanceSYP) + toMoneyNumber(invoice.remainingSYP)),
    purchases: [...(supplier.purchases || []), context.purchaseId],
    updatedDate: context.now,
  };

  const currency = invoice.paymentCurrency || "USD";
  const rate = invoice.exchangeRate || 1;
  const line = (accountId: string, debit: number, credit: number, originalAmount: number): JournalEntryLine => ({
    accountId,
    accountName: state.accounts[accountId].name || accountId,
    debit,
    credit,
    currency,
    exchangeRate: rate,
    amountUSD: debit || credit,
    amountOriginal: originalAmount,
    amountSYP: currency === "SYP" ? originalAmount : 0,
  });
  const lines: JournalEntryLine[] = [line(invoice.inventoryAccountId, total, 0, toMoneyNumber(invoice.totalOriginal))];
  if (paid > 0) lines.push(line(invoice.paymentAccountId!, 0, paid, toMoneyNumber(invoice.paidOriginal)));
  if (remaining > 0) lines.push(line(invoice.payableAccountId, 0, remaining, toMoneyNumber(invoice.remainingOriginal)));
  applyFinanceJournal(state, {
    id: context.journalId,
    date: context.now,
    description: `قيد شراء ${invoice.name || invoice.code}`,
    referenceType: "purchase",
    referenceId: context.purchaseId,
    createdBy: "",
    lines,
  } as JournalEntry);

  if (paid > 0) {
    state.payment ||= {};
    state.payment[context.paymentId] = {
      id: context.paymentId,
      date: context.now,
      type: "expense",
      supplierId: invoice.supplierId,
      purchaseId: context.purchaseId,
      paymentAccountId: invoice.paymentAccountId,
      payableAccountId: invoice.payableAccountId,
      amount: -paid,
      amountUSD: -paid,
      amountSYP: -toMoneyNumber(invoice.paidSYP),
      amountOriginal: -toMoneyNumber(invoice.paidOriginal),
      amount_base: -toMoneyNumber(invoice.paidOriginal),
      currency,
      paymentCurrency: currency,
      exchangeRate: rate,
      collectionSource: "management",
      note: remaining === 0 ? `${invoice.name} دفع كامل ثمن شراء` : `${invoice.name} دفعة من ثمن شراء`,
    } as Payment;
  }
  state.financialRequests ||= {};
  state.financialRequests[context.requestKey] = { purchaseId: context.purchaseId, fingerprint: context.fingerprint };
  return { state, purchase: storedInvoice, duplicate: false };
};

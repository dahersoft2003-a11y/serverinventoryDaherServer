import { sell } from "../types/sell";
import { Payment } from "../types/payment";
import { JournalEntry, JournalEntryLine } from "../types/journalEntry";
import { FinanceState, applyFinanceJournal } from "./goodsSettlement";
import { buildInvoiceMoneyBreakdown, roundMoney, toMoneyNumber } from "./money";

export type ProductSaleContext = {
  sellId: string;
  paymentId: string;
  journalId: string;
  requestKey: string;
  fingerprint: string;
  now: string;
};

const validNumber = (value: unknown, label: string, positive = false) => {
  const number = Number(value);
  if (!Number.isFinite(number) || (positive ? number <= 0 : number < 0)) {
    throw new Error(`${label} غير صالح`);
  }
  return number;
};

export const applyProductSaleSettlement = (original: FinanceState, input: sell, context: ProductSaleContext) => {
  const state: FinanceState = JSON.parse(JSON.stringify(original || {}));
  const previous = state.financialRequests?.[context.requestKey];
  if (previous) {
    if (previous.fingerprint !== context.fingerprint) throw new Error("معرف طلب البيع مستخدم لعملية مختلفة");
    const saved = state.sells?.[previous.sellId] as sell | undefined;
    if (!saved) throw new Error("فاتورة البيع السابقة غير مكتملة");
    return { state, sell: saved, duplicate: true };
  }
  if (!input.customerId || !Object.prototype.hasOwnProperty.call(state.customer || {}, input.customerId)) {
    throw new Error("العميل غير موجود");
  }
  if (!Array.isArray(input.products) || input.products.length === 0 || input.products.length > 200) {
    throw new Error("فاتورة البيع تحتاج منتجاً واحداً على الأقل وبحد أقصى 200 منتج");
  }
  if (!["cash", "part", "debt"].includes(input.paymentStatus)) throw new Error("حالة الدفع غير صالحة");
  if (!["USD", "SYP"].includes(input.currency)) throw new Error("عملة الدفع غير صالحة");
  if (input.currency === "SYP") validNumber(input.exchangeRate, "سعر الصرف", true);
  if (input.paymentStatus === "part") validNumber(input.partValue, "الدفعة الجزئية", true);
  const seen = new Set<string>();
  const products = input.products.map((line) => {
    const qty = validNumber(line.qty, "كمية البيع", true);
    const warehouseKey = Object.keys(state.products || {}).find(
      (key) => key.trim().toLowerCase() === String(line.warehouse || "").trim().toLowerCase(),
    );
    const current = warehouseKey && Object.prototype.hasOwnProperty.call(state.products[warehouseKey] || {}, line.id)
      ? state.products[warehouseKey][line.id] : undefined;
    if (!warehouseKey || !current || !line.id || current.code !== line.code) throw new Error("المنتج غير موجود في المستودع أو تغير رمزه");
    const identity = `${warehouseKey}/${line.id}`;
    if (seen.has(identity)) throw new Error("المنتج مكرر في فاتورة البيع");
    seen.add(identity);
    const stock = validNumber(current.quantity, "رصيد المنتج");
    const reserved = validNumber(current.reservedQuantity || 0, "الكمية المحجوزة");
    if (reserved > stock || qty > stock - reserved) throw new Error(`الكمية المتاحة غير كافية للمنتج ${line.code}`);
    const selectedPriceType = line.selectedPriceType || "custom";
    if (!["custom", "payPrice", "wholesalePrice", "superWholesalePrice", "sellPrice"].includes(selectedPriceType)) {
      throw new Error("نوع سعر البيع غير صالح");
    }
    const submittedPrice = validNumber(line.sellPrice, "سعر البيع", true);
    const currentPrice = selectedPriceType === "custom" ? submittedPrice : Number(current[selectedPriceType]);
    const sellPrice = Number.isFinite(currentPrice) && currentPrice > 0 ? currentPrice : submittedPrice;
    if (sellPrice <= 0) throw new Error("سعر البيع غير صالح");
    state.products[warehouseKey][line.id] = { ...current, quantity: stock - qty, updatedDate: context.now };
    return {
      ...line, id: line.id, warehouse: current.warehouse || warehouseKey, code: current.code,
      name: current.name, category: current.category || line.category || "", unit: current.unit || line.unit || "",
      payPrice: toMoneyNumber(current.payPrice), quantity: stock, qty, sellPrice, selectedPriceType,
      wholesalePrice: current.wholesalePrice, superWholesalePrice: current.superWholesalePrice,
      updatedDate: current.updatedDate || line.updatedDate || "",
    };
  });
  const subtotal = roundMoney(products.reduce((sum, line) => sum + line.sellPrice * line.qty, 0));
  const percent = input.discountPercent === undefined ? 0 : validNumber(input.discountPercent, "نسبة الحسم");
  const amount = input.discountAmountUSD === undefined ?
    (input.discountPercent === undefined ? validNumber(input.discount || 0, "قيمة الحسم") : 0) :
    validNumber(input.discountAmountUSD, "قيمة الحسم");
  if (percent > 100 || roundMoney(subtotal * percent / 100 + amount) >= subtotal) throw new Error("الحسم يجب أن يكون أقل من قيمة الفاتورة");
  const money = buildInvoiceMoneyBreakdown({
    subtotalUSD: subtotal, paymentStatus: input.paymentStatus, currency: input.currency,
    exchangeRate: input.exchangeRate, partValue: input.partValue, discountPercent: percent,
    discountAmountUSD: amount,
  });
  if (money.totalUSD <= 0 || input.paymentStatus === "part" && (money.paidUSD <= 0 || money.remainingUSD <= 0)) {
    throw new Error("مبلغ البيع أو الدفعة الجزئية غير صالح");
  }
  const paidOriginal = input.paymentStatus === "part" ? roundMoney(Number(input.partValue)) : money.paidOriginal;
  if (input.paymentStatus === "part" && (paidOriginal >= money.totalOriginal ||
    Math.abs(paidOriginal / money.exchangeRate - money.paidUSD) > 0.001)) {
    throw new Error("الدفعة الجزئية لا تطابق إجمالي الفاتورة");
  }
  const remainingOriginal = roundMoney(money.totalOriginal - paidOriginal);
  const accountIds = [input.salesAccountId, ...(money.paidUSD > 0 ? [input.paymentAccountId] : []),
    ...(money.remainingUSD > 0 ? [input.receivableAccountId] : [])];
  if (accountIds.some((id) => !id) || new Set(accountIds).size !== accountIds.length) throw new Error("اختر حسابات بيع ودفع وذمم مختلفة");
  for (const [id, category, type] of [
    [input.salesAccountId, "SalesRevenue", "Revenue"],
    ...(money.paidUSD > 0 ? [[input.paymentAccountId, "CashOrBank", "Asset"]] : []),
    ...(money.remainingUSD > 0 ? [[input.receivableAccountId, "AccountsReceivable", "Asset"]] : []),
  ]) {
    const account = Object.prototype.hasOwnProperty.call(state.accounts || {}, id as string) ? state.accounts[id as string] : undefined;
    if (!account || account.isActive === false || account.allowTransactions === false || account.type !== type ||
      (category === "CashOrBank" ? !["Cash", "Bank"].includes(account.category) :
        category === "SalesRevenue" ? false : account.category !== category)) {
      throw new Error("حساب البيع أو القبض أو العملاء غير موجود أو نوعه غير مناسب");
    }
  }
  if (state.sells?.[context.sellId] || state.journalEntries?.[context.journalId] || state.payment?.[context.paymentId]) {
    throw new Error("معرف عملية البيع مستخدم سابقاً");
  }
  const stored: sell = JSON.parse(JSON.stringify({
    ...input, id: context.sellId, date: context.now, products, originalProducts: products,
    originalTotalUSD: money.totalUSD, originalSubtotalUSD: money.subtotalUSD, originalDiscountUSD: money.discountUSD,
    paymentCurrency: money.paymentCurrency, priceCurrency: money.priceCurrency, currency: money.paymentCurrency,
    exchangeRate: money.exchangeRate, subtotalUSD: money.subtotalUSD, totalPrice: money.totalUSD,
    totalUSD: money.totalUSD, totalSYP: money.totalSYP, totalOriginal: money.totalOriginal,
    paidUSD: money.paidUSD, paidSYP: money.paymentCurrency === "SYP" ? paidOriginal : 0, paidOriginal,
    remainingDebt: money.remainingUSD, remainingUSD: money.remainingUSD,
    remainingSYP: money.paymentCurrency === "SYP" ? remainingOriginal : 0, remainingOriginal,
    amount_base: money.totalOriginal, partValue: paidOriginal, discountType: money.discountType,
    discountPercent: money.discountPercent, discountPercentUSD: money.discountPercentUSD,
    discountAmountUSD: money.discountAmountUSD, discountUSD: money.discountUSD,
    discountSYP: money.discountSYP, discountOriginal: money.discountOriginal, discount: money.discountUSD,
  }));
  state.sells ||= {};
  state.sells[context.sellId] = stored;
  const customer = state.customer[input.customerId];
  state.customer[input.customerId] = {
    ...customer, balance: roundMoney(toMoneyNumber(customer.balance) - money.remainingUSD),
    balanceUSD: roundMoney(toMoneyNumber(customer.balanceUSD, customer.balance) - money.remainingUSD),
    balanceSYP: roundMoney(toMoneyNumber(customer.balanceSYP) - (money.paymentCurrency === "SYP" ? remainingOriginal : 0)),
    purchases: [...new Set([...(Array.isArray(customer.purchases) ? customer.purchases : []), context.sellId])], updatedDate: context.now,
  };
  const line = (accountId: string, debit: number, credit: number, originalAmount: number): JournalEntryLine => ({
    accountId, accountName: state.accounts[accountId].name || accountId, debit, credit,
    currency: money.paymentCurrency, exchangeRate: money.exchangeRate,
    amountUSD: debit || credit, amountOriginal: originalAmount,
    amountSYP: money.paymentCurrency === "SYP" ? originalAmount : 0,
  });
  const lines: JournalEntryLine[] = [];
  if (money.paidUSD > 0) lines.push(line(input.paymentAccountId!, money.paidUSD, 0, paidOriginal));
  if (money.remainingUSD > 0) lines.push(line(input.receivableAccountId!, money.remainingUSD, 0, remainingOriginal));
  lines.push(line(input.salesAccountId!, 0, money.totalUSD, money.totalOriginal));
  applyFinanceJournal(state, {
    id: context.journalId, date: context.now, description: `قيد بيع ${products[0].name || context.sellId}`,
    referenceType: "sell", referenceId: context.sellId, createdBy: "", lines,
  } as JournalEntry);
  if (money.paidUSD > 0) {
    state.payment ||= {};
    state.payment[context.paymentId] = {
      id: context.paymentId, date: context.now, type: "income", customerId: input.customerId,
      sellId: context.sellId, paymentAccountId: input.paymentAccountId,
      receivableAccountId: input.receivableAccountId, salesAccountId: input.salesAccountId,
      ...(input.driverId ? { collectorId: input.driverId, vehicleId: input.vehicleId } : {}),
      amount: money.paidUSD, amountUSD: money.paidUSD,
      amountSYP: money.paymentCurrency === "SYP" ? paidOriginal : 0,
      amountOriginal: paidOriginal, amount_base: paidOriginal, currency: money.paymentCurrency,
      paymentCurrency: money.paymentCurrency, exchangeRate: money.exchangeRate,
      note: money.remainingUSD === 0 ? "دفع كامل ثمن بيع" : "دفعة من ثمن بيع",
    } as Payment;
  }
  state.financialRequests ||= {};
  state.financialRequests[context.requestKey] = { sellId: context.sellId, fingerprint: context.fingerprint };
  return { state, sell: stored, duplicate: false };
};

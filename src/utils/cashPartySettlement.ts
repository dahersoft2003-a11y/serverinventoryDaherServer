import { Payment } from "../types/payment";
import { JournalEntryLine } from "../types/journalEntry";
import { applyFinanceJournal, FinanceState, reconcileGoodsCustomerState } from "./goodsSettlement";
import { normalizeCurrency, normalizeExchangeRate, roundMoney, toMoneyNumber, usdToOriginal } from "./money";

/** Keeps legacy cash receipts atomic with newly introduced goods settlements. */
export const applyCashPartySettlement = (original: FinanceState, payment: Payment, journalId: string) => {
  const state: FinanceState = JSON.parse(JSON.stringify(original));
  const invalidKey = (key: string) => !key || /[.#$\/\[\]]/.test(key) || Object.prototype.hasOwnProperty.call(Object.prototype, key);
  if (!payment.id || invalidKey(payment.id) || invalidKey(journalId) || payment.settlementMethod === "goods" || state.payment?.[payment.id]) throw new Error("سند نقدي صالح وفريد مطلوب");
  if (Boolean(payment.customerId) === Boolean(payment.supplierId)) throw new Error("اختر طرفًا واحدًا للدفعة");
  const customer = Boolean(payment.customerId);
  if (customer && payment.purchaseId || !customer && payment.sellId) throw new Error("نوع الفاتورة لا يطابق الطرف");
  const partyId = String(payment.customerId || payment.supplierId || "");
  if (invalidKey(partyId)) throw new Error("معرف الطرف غير صالح");
  const partyKey = customer ? "customer" : "supplier";
  const party = state[partyKey]?.[partyId];
  if (!party) throw new Error("الطرف غير موجود");
  const signedAmount = roundMoney(toMoneyNumber(payment.amountUSD, payment.amount));
  const amount = Math.abs(signedAmount);
  if (!Number.isFinite(amount) || amount <= 0) throw new Error("المبلغ يجب أن يكون أكبر من صفر");
  const cashAccountId = payment.paymentAccountId || "";
  const partyAccountId = (customer ? payment.receivableAccountId : payment.payableAccountId) || "";
  if (invalidKey(cashAccountId) || invalidKey(partyAccountId) || cashAccountId === partyAccountId) throw new Error("اختر حسابي نقد وذمم مختلفين");
  for (const id of [cashAccountId, partyAccountId]) {
    const account = state.accounts?.[id];
    if (!account || account.allowTransactions === false || account.isActive === false) throw new Error("الحساب غير موجود أو لا يسمح بالحركات");
  }
  if (state.accounts[cashAccountId].type !== "Asset" || !["Cash", "Bank"].includes(state.accounts[cashAccountId].category)) throw new Error("اختر حساب نقد أو بنك");
  if (state.accounts[partyAccountId].category !== (customer ? "AccountsReceivable" : "AccountsPayable") || state.accounts[partyAccountId].type !== (customer ? "Asset" : "Liability")) throw new Error("اختر حساب ذمم مناسبًا للطرف");
  const positive = signedAmount > 0;
  const row: Payment = { ...payment, type: positive ? "income" : "expense", settlementMethod: "cash", balanceUSDChange: signedAmount };
  const currency = normalizeCurrency(payment.paymentCurrency || payment.currency);
  const exchangeRate = normalizeExchangeRate(currency, payment.exchangeRate);
  const originalAmount = Math.abs(toMoneyNumber(payment.amountOriginal, toMoneyNumber(payment.amount_base, amount)));
  row.balanceSYPChange = currency === "SYP" ? (positive ? originalAmount : -originalAmount) : 0;
  const invoiceId = customer ? payment.sellId : payment.purchaseId;
  let invoice: any;
  let partyCurrency = currency;
  let partyRate = exchangeRate;
  let partyOriginal = originalAmount;
  if (invoiceId) {
    if (Object.prototype.hasOwnProperty.call(Object.prototype, invoiceId) || (customer ? !positive : positive)) throw new Error("اتجاه الدفعة لا يسدد هذه الفاتورة");
    const collection = customer ? "sells" : "purchases";
    const current = state[collection]?.[invoiceId];
    if (!current || (customer ? current.customerId : current.supplierId) !== partyId) throw new Error("الفاتورة غير موجودة أو تخص طرفًا آخر");
    const remaining = toMoneyNumber(current.remainingUSD, current.remainingDebt);
    if (amount > remaining || remaining <= 0) throw new Error("المبلغ أكبر من المتبقي في الفاتورة");
    const invoiceCurrency = normalizeCurrency(current.paymentCurrency || current.currency);
    const rate = normalizeExchangeRate(invoiceCurrency, current.exchangeRate);
    partyCurrency = invoiceCurrency;
    partyRate = rate;
    partyOriginal = usdToOriginal(amount, invoiceCurrency, rate);
    const nextRemaining = roundMoney(remaining - amount);
    const paid = roundMoney(toMoneyNumber(current.totalUSD, current.totalPrice) - nextRemaining);
    invoice = {
      ...current, remainingDebt: nextRemaining, remainingUSD: nextRemaining, remainingOriginal: usdToOriginal(nextRemaining, invoiceCurrency, rate),
      remainingSYP: invoiceCurrency === "SYP" ? usdToOriginal(nextRemaining, invoiceCurrency, rate) : 0,
      paidUSD: paid, paidOriginal: usdToOriginal(paid, invoiceCurrency, rate), paidSYP: invoiceCurrency === "SYP" ? usdToOriginal(paid, invoiceCurrency, rate) : 0,
      paymentStatus: nextRemaining === 0 ? "cash" : "part", partValue: usdToOriginal(paid, invoiceCurrency, rate), updatedAt: payment.date,
      ...(customer ? {} : { paidAmount: paid }),
    };
    state[collection][invoiceId] = invoice;
    row.balanceSYPChange = invoiceCurrency === "SYP" ? (positive ? 1 : -1) * usdToOriginal(amount, invoiceCurrency, rate) : 0;
  }
  state.payment ||= {};
  state.payment[payment.id] = row;
  if (customer) reconcileGoodsCustomerState(state, partyId);
  else state.supplier[partyId] = { ...party, balance: roundMoney(toMoneyNumber(party.balanceUSD, party.balance) + signedAmount), balanceUSD: roundMoney(toMoneyNumber(party.balanceUSD, party.balance) + signedAmount), balanceSYP: roundMoney(toMoneyNumber(party.balanceSYP) + toMoneyNumber(row.balanceSYPChange)), updatedDate: payment.date };
  const line = (accountId: string, debit: number, credit: number, lineCurrency = currency, lineRate = exchangeRate, lineOriginal = originalAmount): JournalEntryLine => ({ accountId, accountName: state.accounts[accountId].name || accountId, debit, credit, currency: lineCurrency, exchangeRate: lineRate, amountUSD: amount, amountOriginal: lineOriginal, amountSYP: lineCurrency === "SYP" ? lineOriginal : 0 });
  applyFinanceJournal(state, { id: journalId, date: payment.date || new Date().toISOString(), description: payment.note || "دفعة على حساب الطرف", referenceId: payment.id, referenceType: "payment", createdBy: payment.createdBy || "", lines: [line(cashAccountId, positive ? amount : 0, positive ? 0 : amount), line(partyAccountId, positive ? 0 : amount, positive ? amount : 0, partyCurrency, partyRate, partyOriginal)] });
  return { state, payment: row, ...(customer ? { sell: invoice } : { purchase: invoice }) };
};

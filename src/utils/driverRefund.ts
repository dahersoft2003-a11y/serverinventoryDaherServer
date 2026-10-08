import type { Payment } from "../types/payment";
import { normalizeCurrency, normalizeExchangeRate, roundMoney, toMoneyNumber, usdToOriginal } from "./money";

export const allocateDriverRefundPayments = (
  payments: Record<string, any>[], sellId: string, cashRefundUSD: number, currencyValue: string, exchangeRateValue: number, refundPaidByDriverId?: string,
): Payment[] => {
  const currency = normalizeCurrency(currencyValue);
  const exchangeRate = normalizeExchangeRate(currency, exchangeRateValue);
  let remainingUSD = roundMoney(cashRefundUSD);
  if (remainingUSD <= 0) return [];
  const receipts = payments.filter(p => p.sellId === sellId && p.type === "income" && p.settlementMethod !== "goods" && toMoneyNumber(p.amountUSD, toMoneyNumber(p.amount)) > 0).sort((a, b) => String(a.date || "").localeCompare(String(b.date || "")) || String(a.id).localeCompare(String(b.id)));
  const results: Payment[] = [];
  for (const original of receipts) {
    if (remainingUSD <= 0) break;
    const prior = payments.filter(p => p.originalPaymentId === original.id && p.type === "return");
    const originalUSD = toMoneyNumber(original.amountUSD, toMoneyNumber(original.amount));
    const priorRefundUSD = prior.reduce((sum, p) => sum + Math.abs(toMoneyNumber(p.amountUSD, toMoneyNumber(p.amount))), 0);
    const available = roundMoney(Math.max(0, originalUSD - priorRefundUSD));
    const amountUSD = roundMoney(Math.min(remainingUSD, available));
    if (amountUSD <= 0) continue;
    const confirmed = Boolean(original.collectorId && original.commissionRate !== undefined && original.commissionUSD !== undefined);
    const previousCommission = prior.reduce((sum, p) => sum + Math.abs(toMoneyNumber(p.commissionUSD)), 0);
    const commissionUSD = confirmed ? amountUSD === available ? roundMoney(Math.max(0, toMoneyNumber(original.commissionUSD) - previousCommission)) : roundMoney(amountUSD * toMoneyNumber(original.commissionRate) / 100) : 0;
    const amountOriginal = usdToOriginal(amountUSD, currency, exchangeRate);
    results.push({ type: "return", customerId: original.customerId, sellId, currency, paymentCurrency: currency, exchangeRate, amount: -amountUSD, amountUSD: -amountUSD, amountOriginal: -amountOriginal, amount_base: -amountOriginal, amountSYP: currency === "SYP" ? -amountOriginal : 0, note: "رد نقد من تحصيل سابق", date: new Date().toISOString(), settlementMethod: "cash", collectionSource: "refund", originalPaymentId: original.id,
      ...(original.collectorId ? { collectorId: original.collectorId, collectorName: original.collectorName || original.collectorId } : {}),
      ...(confirmed ? { commissionRate: original.commissionRate, commissionUSD: -commissionUSD, commissionOriginal: -usdToOriginal(commissionUSD, currency, exchangeRate) } : {}),
      ...(original.vehicleId ? { vehicleId: original.vehicleId } : {}), ...(refundPaidByDriverId ? { refundPaidByDriverId } : {}) } as Payment);
    remainingUSD = roundMoney(remainingUSD - amountUSD);
  }
  if (remainingUSD > 0) {
    // Legacy receipts may have no invoice link. Keep the unknown portion out of confirmed commissions.
    const original = usdToOriginal(remainingUSD, currency, exchangeRate);
    results.push({ type: "return", sellId, currency, paymentCurrency: currency, exchangeRate, amount: -remainingUSD, amountUSD: -remainingUSD, amount_base: -original, amountOriginal: -original, amountSYP: currency === "SYP" ? -original : 0, date: new Date().toISOString(), note: "رد نقد من تحصيل قديم مجهول المحصّل", settlementMethod: "cash", collectionSource: "unknown", ...(refundPaidByDriverId ? { refundPaidByDriverId } : {}) } as Payment);
  }
  return results;
};

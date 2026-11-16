import type { Payment } from "../types/payment";
import { normalizeCurrency, roundMoney, toMoneyNumber } from "./money";
export const allocateDriverRefundPayments = (
  payments: Record<string, any>[],
  sellId: string,
  cashRefundAmount: number,
  currencyValue: string,
  refundPaidByDriverId?: string,
): Payment[] => {
  const currency = normalizeCurrency(currencyValue);
  let remainingAmount = roundMoney(cashRefundAmount);
  if (remainingAmount <= 0) return [];
  const receipts = payments
    .filter(
      (p) =>
        p.sellId === sellId &&
        p.type === "income" &&
        p.settlementMethod !== "goods" &&
        toMoneyNumber(p.amount, toMoneyNumber(p.amount)) > 0,
    )
    .sort(
      (a, b) =>
        String(a.date || "").localeCompare(String(b.date || "")) ||
        String(a.id).localeCompare(String(b.id)),
    );
  const results: Payment[] = [];
  for (const original of receipts) {
    if (remainingAmount <= 0) break;
    const prior = payments.filter(
      (p) => p.originalPaymentId === original.id && p.type === "return",
    );
    const originalAmount = toMoneyNumber(
      original.amount,
      toMoneyNumber(original.amount),
    );
    const priorRefundAmount = prior.reduce(
      (sum, p) => sum + Math.abs(toMoneyNumber(p.amount, toMoneyNumber(p.amount))),
      0,
    );
    const available = roundMoney(Math.max(0, originalAmount - priorRefundAmount));
    const amountValue = roundMoney(Math.min(remainingAmount, available));
    if (amountValue <= 0) continue;
    const confirmed = Boolean(
      original.collectorId &&
      original.commissionRate !== undefined &&
      original.commissionAmount !== undefined,
    );
    const previousCommission = prior.reduce(
      (sum, p) => sum + Math.abs(toMoneyNumber(p.commissionAmount)),
      0,
    );
    const commissionAmount = confirmed
      ? amountValue === available
        ? roundMoney(
            Math.max(0, toMoneyNumber(original.commissionAmount) - previousCommission),
          )
        : roundMoney((amountValue * toMoneyNumber(original.commissionRate)) / 100)
      : 0;
    results.push({
      type: "return",
      customerId: original.customerId,
      sellId,
      currency,
      amount: -amountValue,
      note: "رد نقد من تحصيل سابق",
      date: new Date().toISOString(),
      settlementMethod: "cash",
      collectionSource: "refund",
      originalPaymentId: original.id,
      ...(original.collectorId
        ? {
            collectorId: original.collectorId,
            collectorName: original.collectorName || original.collectorId,
          }
        : {}),
      ...(confirmed
        ? {
            commissionRate: original.commissionRate,
            commissionAmount: -commissionAmount,
          }
        : {}),
      ...(original.vehicleId ? { vehicleId: original.vehicleId } : {}),
      ...(refundPaidByDriverId ? { refundPaidByDriverId } : {}),
    } as Payment);
    remainingAmount = roundMoney(remainingAmount - amountValue);
  }
  if (remainingAmount > 0) {
    // Legacy receipts may have no invoice link. Keep the unknown portion out of confirmed commissions.
    results.push({
      type: "return",
      sellId,
      currency,
      amount: -remainingAmount,
      date: new Date().toISOString(),
      note: "رد نقد من تحصيل قديم مجهول المحصّل",
      settlementMethod: "cash",
      collectionSource: "unknown",
      ...(refundPaidByDriverId ? { refundPaidByDriverId } : {}),
    } as Payment);
  }
  return results;
};

import { Payment } from "../types/payment";

/** Financial attribution and goods movement fields are assigned by the server. */
export const sanitizeCashPaymentInput = (raw: any): Payment => {
  if (!raw || typeof raw !== "object") throw new Error("بيانات الدفعة مطلوبة");
  if (raw.settlementMethod === "goods" || raw.type === "goods") throw new Error("استخدم مسار التسوية بالبضاعة لتحديث المخزون والحساب معًا");
  const clean = { ...raw };
  for (const key of ["id", "date", "collectorId", "collectorName", "commissionRate", "commissionUSD", "commissionOriginal", "collectionSource", "originalPaymentId", "refundPaidByDriverId", "driverMovementId", "driverId", "stockDriverId", "stockVehicleId", "goodsItems", "goodsDirection", "goodsCostUSD", "goodsDifferenceUSD", "balanceUSDChange", "balanceSYPChange", "reversalOf", "reversedBy", "status", "createdBy", "actorId", "actorName", "journalEntryId"]) delete clean[key];
  return { ...clean, settlementMethod: "cash", collectionSource: "management" } as Payment;
};

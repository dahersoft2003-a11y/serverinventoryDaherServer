import { Payment } from "../types/payment";
import { normalizeCurrency, roundMoney } from "./money";
const submitted = (value: unknown) => value !== undefined && value !== null;
const cashNumber = (value: unknown, label: string) => {
  if (
    (typeof value !== "number" && typeof value !== "string") ||
    String(value).trim() === ""
  )
    throw new Error(`${label} يجب أن يكون رقمًا صالحًا`);
  const number = Number(value);
  if (!Number.isFinite(number) || Math.abs(number) > 1e12)
    throw new Error(`${label} يجب أن يكون رقمًا صالحًا`);
  return number;
};
/** One signed amount, always in Syrian lira. */
export const normalizeCashPaymentMoney = (payment: Payment): Payment => {
  const currency = normalizeCurrency(payment.currency);
  if (
    submitted(payment.requestId) &&
    !/^[A-Za-z0-9_-]{8,128}$/.test(String(payment.requestId))
  )
    throw new Error("معرف طلب الدفعة غير صالح");
  const amount = roundMoney(cashNumber(payment.amount, "مبلغ الدفعة"));
  if (!amount) throw new Error("مبلغ الدفعة يجب أن يكون أكبر من صفر");
  return { ...payment, currency, amount, type: amount > 0 ? "income" : "expense" };
};
/** Financial attribution and goods movement fields are assigned by the server. */
export const sanitizeCashPaymentInput = (raw: any): Payment => {
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw new Error("بيانات الدفعة مطلوبة");
  if (raw.settlementMethod === "goods" || raw.type === "goods")
    throw new Error("استخدم مسار التسوية بالبضاعة لتحديث المخزون والحساب معًا");
  const clean = { ...raw };
  for (const key of [
    "id",
    "date",
    "collectorId",
    "collectorName",
    "commissionRate",
    "commissionAmount",
    "collectionSource",
    "originalPaymentId",
    "refundPaidByDriverId",
    "driverMovementId",
    "driverId",
    "vehicleId",
    "stockDriverId",
    "stockVehicleId",
    "goodsItems",
    "goodsDirection",
    "goodsCostAmount",
    "goodsDifferenceAmount",
    "balanceChange",
    "reversalOf",
    "reversedBy",
    "status",
    "createdBy",
    "actorId",
    "actorName",
    "journalEntryId",
    "adjustmentSourceSellId",
  ])
    delete clean[key];
  for (const key of [
    "customerId",
    "supplierId",
    "sellId",
    "purchaseId",
    "paymentAccountId",
    "receivableAccountId",
    "payableAccountId",
    "requestId",
  ]) {
    const value = clean[key];
    if (value === undefined || value === null || value === "") {
      delete clean[key];
      continue;
    }
    if (
      typeof value !== "string" ||
      value.length > 200 ||
      /[.#$\/\[\]]/.test(value) ||
      Object.prototype.hasOwnProperty.call(Object.prototype, value)
    )
      throw new Error("معرف الطرف أو الفاتورة أو الحساب غير صالح");
    clean[key] = value.trim();
  }
  if (
    submitted(clean.requestId) &&
    !/^[A-Za-z0-9_-]{8,128}$/.test(String(clean.requestId))
  )
    throw new Error("معرف طلب الدفعة غير صالح");
  clean.note = String(clean.note || "")
    .trim()
    .slice(0, 2000);
  return {
    ...clean,
    settlementMethod: "cash",
    collectionSource: "management",
  } as Payment;
};

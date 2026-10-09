import { Payment } from "../types/payment";
import { normalizeCurrency, normalizeExchangeRate, originalToUSD, roundMoney, usdToOriginal } from "./money";

const submitted = (value: unknown) => value !== undefined && value !== null;
const cashNumber = (value: unknown, label: string) => {
  if ((typeof value !== "number" && typeof value !== "string") || String(value).trim() === "") throw new Error(`${label} يجب أن يكون رقمًا صالحًا`);
  const number = Number(value);
  if (!Number.isFinite(number) || Math.abs(number) > 1e12) throw new Error(`${label} يجب أن يكون رقمًا صالحًا`);
  return number;
};

/** The cash direction comes from the signed USD amount; the tender value is authoritative. */
export const normalizeCashPaymentMoney = (payment: Payment): Payment => {
  if (submitted(payment.requestId) && !/^[A-Za-z0-9_-]{8,128}$/.test(String(payment.requestId))) throw new Error("معرف طلب الدفعة غير صالح");
  const currencyValue = String(payment.paymentCurrency ?? payment.currency ?? "").trim().toUpperCase();
  if (!["USD", "SYP", "SYR"].includes(currencyValue)) throw new Error("اختر عملة الدفعة: USD أو SYP");
  const currency = normalizeCurrency(currencyValue);
  if (submitted(payment.paymentCurrency) && submitted(payment.currency) && normalizeCurrency(payment.currency) !== currency) throw new Error("عملة الدفعة غير متطابقة");
  const exchangeRate = currency === "USD" ? 1 : normalizeExchangeRate(currency, cashNumber(payment.exchangeRate, "سعر الصرف"));
  const values = Object.fromEntries(["amountUSD", "amount", "amountOriginal", "amount_base", "amountSYP"].filter(key => submitted((payment as any)[key])).map(key => [key, cashNumber((payment as any)[key], "مبلغ الدفعة")])) as Record<string, number>;
  const directionAmount = [values.amountUSD, values.amount, values.amountOriginal, values.amount_base].find(value => value !== undefined && value !== 0);
  if (!directionAmount) throw new Error("مبلغ الدفعة يجب أن يكون أكبر من صفر");
  const sign = directionAmount > 0 ? 1 : -1;
  // Older forms sent a positive tender magnitude even for outgoing cash.
  for (const value of [values.amountUSD, values.amount]) {
    if (value !== undefined && value !== 0 && Math.sign(value) !== sign) throw new Error("اتجاه مبلغ الدفعة غير متطابق");
  }
  const originalValue = values.amountOriginal ?? values.amount_base ?? (values.amountUSD !== undefined ? usdToOriginal(values.amountUSD, currency, exchangeRate) : values.amount ?? 0);
  if (originalValue < 0 && sign > 0) throw new Error("اتجاه مبلغ الدفعة غير متطابق");
  const amountOriginal = roundMoney(Math.abs(originalValue)) * sign;
  const amountUSD = originalToUSD(amountOriginal, currency, exchangeRate);
  if (!amountOriginal || !amountUSD || !Number.isFinite(amountUSD) || Math.abs(amountUSD) > 1e12) throw new Error("مبلغ الدفعة يجب أن يكون أكبر من صفر وضمن الدقة المعتمدة");
  return Object.fromEntries(Object.entries({
    ...payment, currency, paymentCurrency: currency, exchangeRate,
    type: sign > 0 ? "income" : "expense", amount: amountUSD, amountUSD,
    amountOriginal, amount_base: amountOriginal, amountSYP: currency === "SYP" ? amountOriginal : 0,
  }).filter(([, value]) => value !== undefined)) as unknown as Payment;
};

/** Financial attribution and goods movement fields are assigned by the server. */
export const sanitizeCashPaymentInput = (raw: any): Payment => {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("بيانات الدفعة مطلوبة");
  if (raw.settlementMethod === "goods" || raw.type === "goods") throw new Error("استخدم مسار التسوية بالبضاعة لتحديث المخزون والحساب معًا");
  const clean = { ...raw };
  for (const key of ["id", "date", "collectorId", "collectorName", "commissionRate", "commissionUSD", "commissionOriginal", "collectionSource", "originalPaymentId", "refundPaidByDriverId", "driverMovementId", "driverId", "vehicleId", "stockDriverId", "stockVehicleId", "goodsItems", "goodsDirection", "goodsCostUSD", "goodsDifferenceUSD", "balanceUSDChange", "balanceSYPChange", "reversalOf", "reversedBy", "status", "createdBy", "actorId", "actorName", "journalEntryId", "adjustmentSourceSellId"]) delete clean[key];
  for (const key of ["customerId", "supplierId", "sellId", "purchaseId", "paymentAccountId", "receivableAccountId", "payableAccountId", "requestId"]) {
    const value = clean[key];
    if (value === undefined || value === null || value === "") { delete clean[key]; continue; }
    if (typeof value !== "string" || value.length > 200 || /[.#$\/\[\]]/.test(value) || Object.prototype.hasOwnProperty.call(Object.prototype, value)) throw new Error("معرف الطرف أو الفاتورة أو الحساب غير صالح");
    clean[key] = value.trim();
  }
  if (submitted(clean.requestId) && !/^[A-Za-z0-9_-]{8,128}$/.test(String(clean.requestId))) throw new Error("معرف طلب الدفعة غير صالح");
  clean.note = String(clean.note || "").trim().slice(0, 2000);
  return { ...clean, settlementMethod: "cash", collectionSource: "management" } as Payment;
};

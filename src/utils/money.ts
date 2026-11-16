export type SupportedCurrency = "SYP";
export type CurrencyCode = SupportedCurrency;
export type PaymentStatus = "cash" | "part" | "debt";
export type DiscountType = "none" | "amount" | "percent" | "mixed";
export const PRICE_CURRENCY = "SYP" as const;
export const toMoneyNumber = (value: unknown, fallback = 0) => {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
};
// Unit costs may be fractional. Monetary totals retain the existing 3-digit precision.
export const roundMoney = (value: number, precision = 3) => {
  const factor = 10 ** precision;
  return Math.round((value + Number.EPSILON) * factor) / factor;
};
export const normalizeCurrency = (value?: unknown): SupportedCurrency => {
  if (value != null && value !== "" && String(value).trim().toUpperCase() !== "SYP") {
    throw new Error("العملة المعتمدة هي الليرة السورية فقط");
  }
  return "SYP";
};
export type InvoiceMoneyBreakdown = {
  currency: SupportedCurrency;
  subtotal: number;
  totalPrice: number;
  paidAmount: number;
  remainingDebt: number;
  discountType: DiscountType;
  discountPercent: number;
  discountPercentAmount: number;
  discountAmount: number;
  discount: number;
};
export const buildInvoiceMoneyBreakdown = (input: {
  totalPrice?: number;
  subtotal?: unknown;
  paymentStatus: PaymentStatus;
  currency?: unknown;
  partValue?: unknown;
  discount?: unknown;
  discountAmount?: unknown;
  discountPercent?: unknown;
}): InvoiceMoneyBreakdown => {
  normalizeCurrency(input.currency);
  const supplied = (value: unknown) =>
    value !== undefined && value !== null && String(value).trim() !== "";
  const structured = supplied(input.discountAmount) || supplied(input.discountPercent);
  const legacyDiscount = Math.max(toMoneyNumber(input.discount), 0);
  const subtotal = roundMoney(
    Math.max(
      supplied(input.subtotal)
        ? toMoneyNumber(input.subtotal)
        : toMoneyNumber(input.totalPrice) + legacyDiscount,
      0,
    ),
  );
  const discountPercent = roundMoney(Math.max(toMoneyNumber(input.discountPercent), 0));
  const discountAmount = roundMoney(
    Math.max(structured ? toMoneyNumber(input.discountAmount) : legacyDiscount, 0),
  );
  const discountPercentAmount = roundMoney((subtotal * discountPercent) / 100);
  const discount = roundMoney(discountPercentAmount + discountAmount);
  const totalPrice = roundMoney(
    supplied(input.subtotal) || structured
      ? Math.max(subtotal - discount, 0)
      : Math.max(toMoneyNumber(input.totalPrice), 0),
  );
  const paidAmount =
    input.paymentStatus === "cash"
      ? totalPrice
      : input.paymentStatus === "part"
        ? roundMoney(Math.min(totalPrice, Math.max(toMoneyNumber(input.partValue), 0)))
        : 0;
  return {
    currency: "SYP",
    subtotal,
    totalPrice,
    paidAmount,
    remainingDebt: roundMoney(totalPrice - paidAmount),
    discountPercent,
    discountPercentAmount,
    discountAmount,
    discount,
    discountType:
      discountAmount > 0 && discountPercent > 0
        ? "mixed"
        : discountPercent > 0
          ? "percent"
          : discountAmount > 0
            ? "amount"
            : "none",
  };
};
export const buildInvoiceMoney = buildInvoiceMoneyBreakdown;
export type PaymentMoneyBreakdown = {
  currency: SupportedCurrency;
  amount: number;
};
export const buildPaymentMoneyBreakdown = (input: {
  amount: unknown;
  currency?: unknown;
}): PaymentMoneyBreakdown => ({
  currency: normalizeCurrency(input.currency),
  amount: roundMoney(toMoneyNumber(input.amount)),
});
export const formatMoney = (value: unknown, _currency?: string) =>
  `${toMoneyNumber(value).toLocaleString("ar-SY", { maximumFractionDigits: 3 })} ل.س`;
export const getRecordCurrency = (_record?: unknown): SupportedCurrency => "SYP";

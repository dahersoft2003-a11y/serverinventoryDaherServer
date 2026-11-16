export const MONEY_SCHEMA = "syp-v1";

/** Reject legacy monetary payloads rather than interpreting old values as lira. */
export const assertSypPayload = (value: unknown): void => {
  if (!value || typeof value !== "object") return;
  for (const [key, item] of Object.entries(value)) {
    if (
      /USD|SYP$|SYPChange$|exchangeRate|amount_base|amountOriginal|priceCurrency|paymentCurrency/i.test(
        key,
      )
    ) {
      throw new Error("صيغة العملية قديمة؛ أعد إدخال المبلغ بالليرة السورية");
    }
    if (key === "currency" && item !== "SYP")
      throw new Error("العملة المعتمدة هي الليرة السورية فقط");
    if (item && typeof item === "object") assertSypPayload(item);
  }
};

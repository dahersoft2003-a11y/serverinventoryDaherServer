export type SupportedCurrency = "USD" | "SYP";

export const PRICE_CURRENCY = "USD" as const;

export const toMoneyNumber = (value: unknown, fallback = 0) => {
  const next = Number(value);
  return Number.isFinite(next) ? next : fallback;
};

export const roundMoney = (value: number, precision = 3) => {
  const factor = 10 ** precision;
  return Math.round((value + Number.EPSILON) * factor) / factor;
};

export const normalizeCurrency = (value: unknown): SupportedCurrency => {
  const currency = String(value || "USD").trim().toUpperCase();
  return currency === "SYP" || currency === "SYR" ? "SYP" : "USD";
};

export const normalizeExchangeRate = (
  currency: SupportedCurrency,
  value: unknown,
) => {
  if (currency === "USD") {
    return 1;
  }

  const rate = toMoneyNumber(value);
  if (rate <= 0) {
    throw new Error("Exchange rate must be greater than zero");
  }

  if (rate > 1_000_000_000) {
    throw new Error("Exchange rate is too large");
  }

  return rate;
};

export const originalToUSD = (
  amountOriginal: number,
  currency: SupportedCurrency,
  exchangeRate: number,
) => {
  if (currency === "USD") {
    return roundMoney(amountOriginal);
  }

  return roundMoney(amountOriginal / exchangeRate);
};

export const usdToOriginal = (
  amountUSD: number,
  currency: SupportedCurrency,
  exchangeRate: number,
) => {
  if (currency === "USD") {
    return roundMoney(amountUSD);
  }

  return roundMoney(amountUSD * exchangeRate);
};

export const usdToSYPForPaymentCurrency = (
  amountUSD: number,
  currency: SupportedCurrency,
  exchangeRate: number,
) => {
  return currency === "SYP" ? usdToOriginal(amountUSD, currency, exchangeRate) : 0;
};

export type PaymentStatus = "cash" | "part" | "debt";
export type DiscountType = "none" | "amount" | "percent" | "mixed";

const hasSubmittedValue = (value: unknown) => {
  return value !== undefined && value !== null && String(value).trim() !== "";
};

const deriveDiscountType = (
  discountAmountUSD: number,
  discountPercent: number,
): DiscountType => {
  if (discountAmountUSD > 0 && discountPercent > 0) return "mixed";
  if (discountPercent > 0) return "percent";
  if (discountAmountUSD > 0) return "amount";
  return "none";
};

export type InvoiceMoneyBreakdown = {
  priceCurrency: typeof PRICE_CURRENCY;
  paymentCurrency: SupportedCurrency;
  exchangeRate: number;
  subtotalUSD: number;
  totalUSD: number;
  totalSYP: number;
  totalOriginal: number;
  paidUSD: number;
  paidSYP: number;
  paidOriginal: number;
  remainingUSD: number;
  remainingSYP: number;
  remainingOriginal: number;
  discountType: DiscountType;
  discountPercent: number;
  discountPercentUSD: number;
  discountAmountUSD: number;
  discountUSD: number;
  discountSYP: number;
  discountOriginal: number;
};

export const buildInvoiceMoneyBreakdown = ({
  totalUSD,
  subtotalUSD,
  paymentStatus,
  currency,
  exchangeRate,
  partValue,
  discountUSD = 0,
  discountAmountUSD,
  discountPercent,
}: {
  totalUSD?: number;
  subtotalUSD?: unknown;
  paymentStatus: PaymentStatus;
  currency: unknown;
  exchangeRate: unknown;
  partValue?: unknown;
  discountUSD?: unknown;
  discountAmountUSD?: unknown;
  discountPercent?: unknown;
}): InvoiceMoneyBreakdown => {
  const paymentCurrency = normalizeCurrency(currency);
  const normalizedExchangeRate = normalizeExchangeRate(
    paymentCurrency,
    exchangeRate,
  );
  const hasSubtotal = hasSubmittedValue(subtotalUSD);
  const hasStructuredDiscount =
    hasSubmittedValue(discountAmountUSD) || hasSubmittedValue(discountPercent);
  const safeLegacyDiscountUSD = roundMoney(
    Math.max(toMoneyNumber(discountUSD), 0),
  );
  const safeSubtotalUSD = hasSubtotal
    ? roundMoney(Math.max(toMoneyNumber(subtotalUSD), 0))
    : roundMoney(
        Math.max(toMoneyNumber(totalUSD), 0) + safeLegacyDiscountUSD,
      );
  const safeDiscountPercent = roundMoney(
    Math.max(toMoneyNumber(discountPercent), 0),
  );
  const safeDiscountAmountUSD = roundMoney(
    Math.max(
      hasStructuredDiscount
        ? toMoneyNumber(discountAmountUSD)
        : safeLegacyDiscountUSD,
      0,
    ),
  );
  const discountPercentUSD = roundMoney(
    safeSubtotalUSD * (safeDiscountPercent / 100),
  );
  const safeDiscountUSD = roundMoney(
    discountPercentUSD + safeDiscountAmountUSD,
  );
  const safeTotalUSD = hasSubtotal || hasStructuredDiscount
    ? roundMoney(Math.max(safeSubtotalUSD - safeDiscountUSD, 0))
    : roundMoney(Math.max(toMoneyNumber(totalUSD), 0));
  const partOriginal = toMoneyNumber(partValue);
  const paidUSD =
    paymentStatus === "cash"
      ? safeTotalUSD
      : paymentStatus === "part"
        ? Math.min(
            safeTotalUSD,
            Math.max(
              originalToUSD(
                partOriginal,
                paymentCurrency,
                normalizedExchangeRate,
              ),
              0,
            ),
          )
        : 0;
  const roundedPaidUSD = roundMoney(paidUSD);
  const remainingUSD = roundMoney(Math.max(safeTotalUSD - roundedPaidUSD, 0));

  return {
    priceCurrency: PRICE_CURRENCY,
    paymentCurrency,
    exchangeRate: normalizedExchangeRate,
    subtotalUSD: safeSubtotalUSD,
    totalUSD: safeTotalUSD,
    totalSYP: usdToSYPForPaymentCurrency(
      safeTotalUSD,
      paymentCurrency,
      normalizedExchangeRate,
    ),
    totalOriginal: usdToOriginal(
      safeTotalUSD,
      paymentCurrency,
      normalizedExchangeRate,
    ),
    paidUSD: roundedPaidUSD,
    paidSYP: usdToSYPForPaymentCurrency(
      roundedPaidUSD,
      paymentCurrency,
      normalizedExchangeRate,
    ),
    paidOriginal: usdToOriginal(
      roundedPaidUSD,
      paymentCurrency,
      normalizedExchangeRate,
    ),
    remainingUSD,
    remainingSYP: usdToSYPForPaymentCurrency(
      remainingUSD,
      paymentCurrency,
      normalizedExchangeRate,
    ),
    remainingOriginal: usdToOriginal(
      remainingUSD,
      paymentCurrency,
      normalizedExchangeRate,
    ),
    discountType: deriveDiscountType(
      safeDiscountAmountUSD,
      safeDiscountPercent,
    ),
    discountPercent: safeDiscountPercent,
    discountPercentUSD,
    discountAmountUSD: safeDiscountAmountUSD,
    discountUSD: safeDiscountUSD,
    discountSYP: usdToSYPForPaymentCurrency(
      safeDiscountUSD,
      paymentCurrency,
      normalizedExchangeRate,
    ),
    discountOriginal: usdToOriginal(
      safeDiscountUSD,
      paymentCurrency,
      normalizedExchangeRate,
    ),
  };
};

export type PaymentMoneyBreakdown = {
  paymentCurrency: SupportedCurrency;
  exchangeRate: number;
  amountUSD: number;
  amountSYP: number;
  amountOriginal: number;
  amountBase: number;
};

export const buildPaymentMoneyBreakdown = ({
  amount,
  amountUSD,
  currency,
  exchangeRate,
  amountOriginal,
}: {
  amount: unknown;
  amountUSD?: unknown;
  currency: unknown;
  exchangeRate: unknown;
  amountOriginal?: unknown;
}): PaymentMoneyBreakdown => {
  const paymentCurrency = normalizeCurrency(currency);
  const normalizedExchangeRate = normalizeExchangeRate(
    paymentCurrency,
    exchangeRate,
  );
  const hasAmountOriginal =
    amountOriginal !== undefined && amountOriginal !== null;
  const hasAmountUSD = amountUSD !== undefined && amountUSD !== null;
  const sourceAmountOriginal = hasAmountOriginal
    ? toMoneyNumber(amountOriginal)
    : hasAmountUSD
      ? usdToOriginal(
          toMoneyNumber(amountUSD),
          paymentCurrency,
          normalizedExchangeRate,
        )
      : toMoneyNumber(amount);

  const normalizedAmountUSD = hasAmountOriginal
    ? originalToUSD(
        sourceAmountOriginal,
        paymentCurrency,
        normalizedExchangeRate,
      )
    : hasAmountUSD
      ? roundMoney(toMoneyNumber(amountUSD))
      : originalToUSD(
          sourceAmountOriginal,
          paymentCurrency,
          normalizedExchangeRate,
        );
  const amountSYP =
    paymentCurrency === "SYP" ? roundMoney(sourceAmountOriginal) : 0;

  return {
    paymentCurrency,
    exchangeRate: normalizedExchangeRate,
    amountUSD: normalizedAmountUSD,
    amountSYP,
    amountOriginal: roundMoney(sourceAmountOriginal),
    amountBase: roundMoney(sourceAmountOriginal),
  };
};

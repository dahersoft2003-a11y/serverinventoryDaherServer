import { sell } from "../types/sell";
import {
  buildInvoiceMoneyBreakdown,
  normalizeCurrency,
  normalizeExchangeRate,
  roundMoney,
  toMoneyNumber,
  usdToOriginal,
  usdToSYPForPaymentCurrency,
} from "./money";

export type CustomerReturnType = "cash" | "debt" | "part";

export type SaleReturnLineInput = {
  productId?: string;
  code?: string;
  productCode?: string;
  warehouse: string;
  qty: number;
};

export type SaleReturnLineResult = {
  productId: string;
  code: string;
  warehouse: string;
  qty: number;
  sellPrice: number;
  grossValueUSD: number;
  netValueUSD: number;
};

export type SaleReturnCalculation = {
  updatedSell: sell;
  oldTotalUSD: number;
  newTotalUSD: number;
  oldPaidUSD: number;
  newPaidUSD: number;
  oldRemainingUSD: number;
  newRemainingUSD: number;
  returnValueUSD: number;
  cashRefundUSD: number;
  cashRefundOriginal: number;
  cashRefundSYP: number;
  receivableCreditUSD: number;
  receivableCreditOriginal: number;
  receivableCreditSYP: number;
  paymentCurrency: "USD" | "SYP";
  exchangeRate: number;
  returnedLines: SaleReturnLineResult[];
};

const hasValue = (value: unknown) =>
  value !== undefined && value !== null && String(value).trim() !== "";

const clamp = (value: number, min: number, max: number) =>
  Math.min(Math.max(value, min), max);

const getProductSubtotal = (products: sell["products"]) =>
  roundMoney(
    products.reduce(
      (sum, product) =>
        sum +
        toMoneyNumber(product.sellPrice) * toMoneyNumber(product.qty),
      0,
    ),
  );

const getStoredDiscountAmountUSD = (invoice: sell) => {
  if (hasValue(invoice.discountAmountUSD)) {
    return toMoneyNumber(invoice.discountAmountUSD);
  }

  if (hasValue((invoice as any).discountAmount)) {
    return toMoneyNumber((invoice as any).discountAmount);
  }

  if (hasValue(invoice.discountPercent)) {
    return 0;
  }

  return toMoneyNumber(invoice.discount);
};

const getDiscountInputsForSubtotal = (invoice: sell, subtotalUSD: number) => {
  const discountPercent = clamp(toMoneyNumber(invoice.discountPercent), 0, 100);
  const discountPercentUSD = roundMoney(subtotalUSD * (discountPercent / 100));
  const maxFixedDiscountUSD = Math.max(subtotalUSD - discountPercentUSD, 0);
  const discountAmountUSD = clamp(
    toMoneyNumber(getStoredDiscountAmountUSD(invoice)),
    0,
    maxFixedDiscountUSD,
  );

  return {
    discountPercent,
    discountAmountUSD,
  };
};

const matchesReturnLine = (
  product: sell["products"][number],
  line: SaleReturnLineInput,
) => {
  const requestedProductId = String(line.productId || "").trim();
  const requestedCode = String(line.code || line.productCode || "").trim();
  const requestedWarehouse = String(line.warehouse || "").trim();

  if (requestedProductId && product.id === requestedProductId) {
    return true;
  }

  return (
    Boolean(requestedCode && requestedWarehouse) &&
    product.code === requestedCode &&
    product.warehouse === requestedWarehouse
  );
};

const allocateNetReturnValues = (
  lines: Omit<SaleReturnLineResult, "netValueUSD">[],
  returnValueUSD: number,
): SaleReturnLineResult[] => {
  const grossTotal = roundMoney(
    lines.reduce((sum, line) => sum + line.grossValueUSD, 0),
  );
  let remainingNetValue = returnValueUSD;

  return lines.map((line, index) => {
    const netValueUSD =
      index === lines.length - 1
        ? remainingNetValue
        : grossTotal > 0
          ? roundMoney(returnValueUSD * (line.grossValueUSD / grossTotal))
          : 0;

    remainingNetValue = roundMoney(remainingNetValue - netValueUSD);

    return {
      ...line,
      netValueUSD,
    };
  });
};

export const calculateSaleReturn = ({
  sellData,
  returnedProducts,
  returnType,
  partValueUSD = 0,
}: {
  sellData: sell;
  returnedProducts: SaleReturnLineInput[];
  returnType: CustomerReturnType;
  partValueUSD?: number;
}): SaleReturnCalculation => {
  if (!Array.isArray(returnedProducts) || returnedProducts.length === 0) {
    throw new Error("At least one returned product is required");
  }

  const paymentCurrency = normalizeCurrency(
    sellData.paymentCurrency || sellData.currency,
  );
  const exchangeRate = normalizeExchangeRate(
    paymentCurrency,
    sellData.exchangeRate,
  );
  const currentProducts = (sellData.products || []).map((product) => ({
    ...product,
    qty: toMoneyNumber(product.qty),
    sellPrice: toMoneyNumber(product.sellPrice),
  }));
  const updatedProducts = currentProducts.map((product) => ({ ...product }));
  const oldSubtotalUSD = getProductSubtotal(currentProducts);
  const oldDiscountInputs = getDiscountInputsForSubtotal(
    sellData,
    oldSubtotalUSD,
  );
  const oldCalculatedMoney = buildInvoiceMoneyBreakdown({
    subtotalUSD: oldSubtotalUSD,
    paymentStatus: "debt",
    currency: paymentCurrency,
    exchangeRate,
    discountAmountUSD: oldDiscountInputs.discountAmountUSD,
    discountPercent: oldDiscountInputs.discountPercent,
  });
  const oldTotalUSD = roundMoney(
    Math.max(
      toMoneyNumber(
        sellData.totalUSD,
        toMoneyNumber(sellData.totalPrice, oldCalculatedMoney.totalUSD),
      ),
      0,
    ),
  );
  const oldRemainingUSD = clamp(
    roundMoney(
      toMoneyNumber(
        sellData.remainingUSD,
        toMoneyNumber(sellData.remainingDebt),
      ),
    ),
    0,
    oldTotalUSD,
  );
  const oldPaidUSD = clamp(
    roundMoney(
      toMoneyNumber(sellData.paidUSD, oldTotalUSD - oldRemainingUSD),
    ),
    0,
    oldTotalUSD,
  );
  const rawReturnedLines: Omit<SaleReturnLineResult, "netValueUSD">[] = [];

  for (const line of returnedProducts) {
    const returnQty = roundMoney(Math.abs(toMoneyNumber(line.qty)));
    const product = updatedProducts.find((item) => matchesReturnLine(item, line));

    if (!returnQty) {
      throw new Error("Return quantity must be greater than zero");
    }

    if (!product) {
      throw new Error("Returned product was not found in the sell invoice");
    }

    const currentQty = roundMoney(toMoneyNumber(product.qty));
    if (returnQty > currentQty) {
      throw new Error("Return quantity is greater than invoice remaining quantity");
    }

    product.qty = roundMoney(currentQty - returnQty);

    rawReturnedLines.push({
      productId: product.id,
      code: product.code,
      warehouse: product.warehouse,
      qty: returnQty,
      sellPrice: product.sellPrice,
      grossValueUSD: roundMoney(returnQty * product.sellPrice),
    });
  }

  const nextProducts = updatedProducts.filter(
    (product) => toMoneyNumber(product.qty) > 0,
  );
  const newSubtotalUSD = getProductSubtotal(nextProducts);
  const newDiscountInputs = getDiscountInputsForSubtotal(
    sellData,
    newSubtotalUSD,
  );
  const newMoney = buildInvoiceMoneyBreakdown({
    subtotalUSD: newSubtotalUSD,
    paymentStatus: "debt",
    currency: paymentCurrency,
    exchangeRate,
    discountAmountUSD: newDiscountInputs.discountAmountUSD,
    discountPercent: newDiscountInputs.discountPercent,
  });
  const newTotalUSD = newMoney.totalUSD;

  if (newTotalUSD > oldTotalUSD) {
    throw new Error("Return calculation would increase invoice total");
  }

  const returnValueUSD = roundMoney(oldTotalUSD - newTotalUSD);
  if (returnValueUSD <= 0) {
    throw new Error("Return value must be greater than zero");
  }

  const cashRefundUSD =
    returnType === "cash"
      ? returnValueUSD
      : returnType === "part"
        ? roundMoney(Math.max(toMoneyNumber(partValueUSD), 0))
        : 0;

  if (returnType === "part" && (cashRefundUSD <= 0 || cashRefundUSD >= returnValueUSD)) {
    throw new Error("Partial return cash amount must be greater than zero and less than return total");
  }

  if (cashRefundUSD > returnValueUSD) {
    throw new Error("Cash return amount is greater than return total");
  }

  if (cashRefundUSD > oldPaidUSD) {
    throw new Error("Cash return amount is greater than the amount paid on this invoice");
  }

  const receivableCreditUSD = roundMoney(returnValueUSD - cashRefundUSD);
  const newPaidUSD = roundMoney(
    Math.min(Math.max(oldPaidUSD - cashRefundUSD, 0), newTotalUSD),
  );
  const newRemainingUSD = roundMoney(Math.max(newTotalUSD - newPaidUSD, 0));
  const newPaymentStatus: sell["paymentStatus"] =
    newRemainingUSD === 0 ? "cash" : newPaidUSD > 0 ? "part" : "debt";
  const newPaidOriginal = usdToOriginal(
    newPaidUSD,
    paymentCurrency,
    exchangeRate,
  );
  const returnedLines = allocateNetReturnValues(
    rawReturnedLines,
    returnValueUSD,
  );

  return {
    updatedSell: {
      ...sellData,
      products: nextProducts,
      paymentStatus: newPaymentStatus,
      currency: paymentCurrency,
      paymentCurrency,
      priceCurrency: "USD",
      exchangeRate,
      amount_base: newMoney.totalOriginal,
      subtotalUSD: newMoney.subtotalUSD,
      totalPrice: newTotalUSD,
      totalUSD: newTotalUSD,
      totalSYP: newMoney.totalSYP,
      totalOriginal: newMoney.totalOriginal,
      paidUSD: newPaidUSD,
      paidSYP: usdToSYPForPaymentCurrency(
        newPaidUSD,
        paymentCurrency,
        exchangeRate,
      ),
      paidOriginal: newPaidOriginal,
      remainingDebt: newRemainingUSD,
      remainingUSD: newRemainingUSD,
      remainingSYP: usdToSYPForPaymentCurrency(
        newRemainingUSD,
        paymentCurrency,
        exchangeRate,
      ),
      remainingOriginal: usdToOriginal(
        newRemainingUSD,
        paymentCurrency,
        exchangeRate,
      ),
      partValue: newPaidOriginal,
      discountType: newMoney.discountType,
      discountPercent: newMoney.discountPercent,
      discountPercentUSD: newMoney.discountPercentUSD,
      discountAmountUSD: newMoney.discountAmountUSD,
      discountUSD: newMoney.discountUSD,
      discountSYP: newMoney.discountSYP,
      discountOriginal: newMoney.discountOriginal,
      discount: newMoney.discountUSD,
      updatedAt: new Date().toISOString(),
    },
    oldTotalUSD,
    newTotalUSD,
    oldPaidUSD,
    newPaidUSD,
    oldRemainingUSD,
    newRemainingUSD,
    returnValueUSD,
    cashRefundUSD,
    cashRefundOriginal: usdToOriginal(
      cashRefundUSD,
      paymentCurrency,
      exchangeRate,
    ),
    cashRefundSYP: usdToSYPForPaymentCurrency(
      cashRefundUSD,
      paymentCurrency,
      exchangeRate,
    ),
    receivableCreditUSD,
    receivableCreditOriginal: usdToOriginal(
      receivableCreditUSD,
      paymentCurrency,
      exchangeRate,
    ),
    receivableCreditSYP: usdToSYPForPaymentCurrency(
      receivableCreditUSD,
      paymentCurrency,
      exchangeRate,
    ),
    paymentCurrency,
    exchangeRate,
    returnedLines,
  };
};

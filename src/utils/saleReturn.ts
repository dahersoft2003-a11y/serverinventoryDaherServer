import { sell } from "../types/sell";
import {
  buildInvoiceMoneyBreakdown,
  normalizeCurrency,
  roundMoney,
  toMoneyNumber,
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
  grossValueAmount: number;
  netValueAmount: number;
};
export type SaleReturnCalculation = {
  updatedSell: sell;
  oldTotalAmount: number;
  newTotalAmount: number;
  oldPaidAmount: number;
  newPaidAmount: number;
  oldRemainingAmount: number;
  newRemainingAmount: number;
  returnValueAmount: number;
  cashRefundAmount: number;
  cashRefundOriginal: number;
  cashRefundSYP: number;
  receivableCreditAmount: number;
  receivableCreditOriginal: number;
  receivableCreditSYP: number;
  currency: "SYP";
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
        sum + toMoneyNumber(product.sellPrice) * toMoneyNumber(product.qty),
      0,
    ),
  );
const getStoredDiscountAmountAmount = (invoice: sell) => {
  if (hasValue(invoice.discountAmount)) {
    return toMoneyNumber(invoice.discountAmount);
  }
  if (hasValue((invoice as any).discount)) {
    return toMoneyNumber((invoice as any).discount);
  }
  if (hasValue(invoice.discountPercent)) {
    return 0;
  }
  return toMoneyNumber(invoice.discount);
};
const getDiscountInputsForSubtotal = (invoice: sell, subtotalAmount: number) => {
  const discountPercent = clamp(toMoneyNumber(invoice.discountPercent), 0, 100);
  const discountPercentAmount = roundMoney(subtotalAmount * (discountPercent / 100));
  const maxFixedDiscountAmount = Math.max(subtotalAmount - discountPercentAmount, 0);
  const fixedDiscountAmount = clamp(
    toMoneyNumber(getStoredDiscountAmountAmount(invoice)),
    0,
    maxFixedDiscountAmount,
  );
  return {
    discountPercent,
    discountAmount: fixedDiscountAmount,
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
  lines: Omit<SaleReturnLineResult, "netValueAmount">[],
  returnValueAmount: number,
): SaleReturnLineResult[] => {
  const grossTotal = roundMoney(
    lines.reduce((sum, line) => sum + line.grossValueAmount, 0),
  );
  let remainingNetValue = returnValueAmount;
  return lines.map((line, index) => {
    const netValueAmount =
      index === lines.length - 1
        ? remainingNetValue
        : grossTotal > 0
          ? roundMoney(returnValueAmount * (line.grossValueAmount / grossTotal))
          : 0;
    remainingNetValue = roundMoney(remainingNetValue - netValueAmount);
    return {
      ...line,
      netValueAmount,
    };
  });
};
export const calculateSaleReturn = ({
  sellData,
  returnedProducts,
  returnType,
  partValueAmount = 0,
}: {
  sellData: sell;
  returnedProducts: SaleReturnLineInput[];
  returnType: CustomerReturnType;
  partValueAmount?: number;
}): SaleReturnCalculation => {
  if (!Array.isArray(returnedProducts) || returnedProducts.length === 0) {
    throw new Error("At least one returned product is required");
  }
  const paymentCurrency = normalizeCurrency(sellData.currency);
  const currentProducts = (sellData.products || []).map((product) => ({
    ...product,
    qty: toMoneyNumber(product.qty),
    sellPrice: toMoneyNumber(product.sellPrice),
  }));
  const updatedProducts = currentProducts.map((product) => ({ ...product }));
  const oldSubtotalAmount = getProductSubtotal(currentProducts);
  const oldDiscountInputs = getDiscountInputsForSubtotal(sellData, oldSubtotalAmount);
  const oldCalculatedMoney = buildInvoiceMoneyBreakdown({
    subtotal: oldSubtotalAmount,
    paymentStatus: "debt",
    currency: paymentCurrency,
    discountAmount: oldDiscountInputs.discountAmount,
    discountPercent: oldDiscountInputs.discountPercent,
  });
  const oldTotalAmount = roundMoney(
    Math.max(
      toMoneyNumber(
        sellData.totalPrice,
        toMoneyNumber(sellData.totalPrice, oldCalculatedMoney.totalPrice),
      ),
      0,
    ),
  );
  const oldRemainingAmount = clamp(
    roundMoney(
      toMoneyNumber(sellData.remainingDebt, toMoneyNumber(sellData.remainingDebt)),
    ),
    0,
    oldTotalAmount,
  );
  const oldPaidAmount = clamp(
    roundMoney(toMoneyNumber(sellData.paidAmount, oldTotalAmount - oldRemainingAmount)),
    0,
    oldTotalAmount,
  );
  const rawReturnedLines: Omit<SaleReturnLineResult, "netValueAmount">[] = [];
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
      grossValueAmount: roundMoney(returnQty * product.sellPrice),
    });
  }
  const nextProducts = updatedProducts.filter(
    (product) => toMoneyNumber(product.qty) > 0,
  );
  const newSubtotalAmount = getProductSubtotal(nextProducts);
  const newDiscountInputs = getDiscountInputsForSubtotal(sellData, newSubtotalAmount);
  const newMoney = buildInvoiceMoneyBreakdown({
    subtotal: newSubtotalAmount,
    paymentStatus: "debt",
    currency: paymentCurrency,
    discountAmount: newDiscountInputs.discountAmount,
    discountPercent: newDiscountInputs.discountPercent,
  });
  const newTotalAmount = newMoney.totalPrice;
  if (newTotalAmount > oldTotalAmount) {
    throw new Error("Return calculation would increase invoice total");
  }
  const returnValueAmount = roundMoney(oldTotalAmount - newTotalAmount);
  if (returnValueAmount <= 0) {
    throw new Error("Return value must be greater than zero");
  }
  const cashRefundAmount =
    returnType === "cash"
      ? returnValueAmount
      : returnType === "part"
        ? roundMoney(Math.max(toMoneyNumber(partValueAmount), 0))
        : 0;
  if (
    returnType === "part" &&
    (cashRefundAmount <= 0 || cashRefundAmount >= returnValueAmount)
  ) {
    throw new Error(
      "Partial return cash amount must be greater than zero and less than return total",
    );
  }
  if (cashRefundAmount > returnValueAmount) {
    throw new Error("Cash return amount is greater than return total");
  }
  if (cashRefundAmount > oldPaidAmount) {
    throw new Error(
      "Cash return amount is greater than the amount paid on this invoice",
    );
  }
  const receivableCreditAmount = roundMoney(returnValueAmount - cashRefundAmount);
  const newPaidAmount = roundMoney(
    Math.min(Math.max(oldPaidAmount - cashRefundAmount, 0), newTotalAmount),
  );
  const newRemainingAmount = roundMoney(Math.max(newTotalAmount - newPaidAmount, 0));
  const newPaymentStatus: sell["paymentStatus"] =
    newRemainingAmount === 0 ? "cash" : newPaidAmount > 0 ? "part" : "debt";
  const newPaidOriginal = roundMoney(newPaidAmount);
  const returnedLines = allocateNetReturnValues(rawReturnedLines, returnValueAmount);
  return {
    updatedSell: {
      ...sellData,
      products: nextProducts,
      paymentStatus: newPaymentStatus,
      currency: paymentCurrency,
      amount: newMoney.totalPrice,
      subtotal: newMoney.subtotal,
      totalPrice: newTotalAmount,
      paidAmount: newPaidAmount,
      remainingDebt: newRemainingAmount,
      partValue: newPaidOriginal,
      discountType: newMoney.discountType,
      discountPercent: newMoney.discountPercent,
      discountPercentAmount: newMoney.discountPercentAmount,
      discountAmount: newMoney.discountAmount,
      discount: newMoney.discount,
      updatedAt: new Date().toISOString(),
    },
    oldTotalAmount,
    newTotalAmount,
    oldPaidAmount,
    newPaidAmount,
    oldRemainingAmount,
    newRemainingAmount,
    returnValueAmount,
    cashRefundAmount,
    cashRefundOriginal: roundMoney(cashRefundAmount),
    cashRefundSYP: roundMoney(cashRefundAmount),
    receivableCreditAmount,
    receivableCreditOriginal: roundMoney(receivableCreditAmount),
    receivableCreditSYP: roundMoney(receivableCreditAmount),
    currency: paymentCurrency,
    returnedLines,
  };
};

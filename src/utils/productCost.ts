/** Average the cost of stock already on hand with the cost of a new receipt. */
export const weightedPurchaseCost = (
  currentQuantity: number,
  currentUnitCost: number,
  receivedQuantity: number,
  receivedUnitCost: number,
) => {
  const totalQuantity = currentQuantity + receivedQuantity;
  if (!Number.isFinite(totalQuantity) || totalQuantity <= 0) {
    throw new Error("Invalid purchase quantity");
  }
  if ([currentQuantity, currentUnitCost, receivedQuantity, receivedUnitCost].some((value) => !Number.isFinite(value) || value < 0)) {
    throw new Error("Invalid purchase cost");
  }
  return Math.round(((currentQuantity * currentUnitCost + receivedQuantity * receivedUnitCost) / totalQuantity) * 1e6) / 1e6;
};

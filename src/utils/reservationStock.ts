import type { Product } from "../types/product";

type ReservationChange =
  | { type: "reserve"; quantity: number }
  | { type: "release"; quantity: number }
  | { type: "settle"; quantity: number; soldQuantity: number };

export const calculateReservationStock = (product: Product, change: ReservationChange): Product => {
  const currentQuantity = Number(product.quantity || 0);
  const currentReserved = Number(product.reservedQuantity || 0);
  const quantity = Number(change.quantity);
  if (!Number.isFinite(currentQuantity) || currentQuantity < 0 || !Number.isFinite(currentReserved) || currentReserved < 0) {
    throw new Error("Invalid product stock or reserved quantity");
  }
  if (!Number.isFinite(quantity) || quantity <= 0) throw new Error("Invalid reservation quantity");

  if (change.type === "reserve") {
    const availableQuantity = currentQuantity - currentReserved;
    if (quantity > availableQuantity) throw new Error(`Insufficient available quantity. Available: ${availableQuantity}, requested: ${quantity}`);
    return { ...product, reservedQuantity: currentReserved + quantity };
  }

  if (quantity > currentReserved) throw new Error(`Reserved quantity is lower than requested release. Reserved: ${currentReserved}, release: ${quantity}`);
  if (change.type === "release") return { ...product, reservedQuantity: Math.max(currentReserved - quantity, 0) };

  const soldQuantity = Number(change.soldQuantity);
  if (!Number.isFinite(soldQuantity) || soldQuantity < 0) throw new Error("Invalid reserved stock settlement");
  if (soldQuantity > quantity) throw new Error("Used quantity cannot exceed reserved quantity");
  if (soldQuantity > currentQuantity) throw new Error(`Insufficient quantity. Quantity: ${currentQuantity}, requested: ${soldQuantity}`);
  return { ...product, quantity: currentQuantity - soldQuantity, reservedQuantity: Math.max(currentReserved - quantity, 0) };
};

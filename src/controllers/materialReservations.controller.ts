import { Request, Response } from "express";
import { get, ref, set, update } from "firebase/database";
import { v4 as uuidv4 } from "uuid";
import { database } from "../firebaseConfig";
import { handleSell } from "../functions/transactions";
import {
  releaseReservedQuantityInternal,
  reserveProductQuantityInternal,
  settleReservedQuantityOnSellInternal,
} from "./products.controller";
import {
  MaterialReservation,
  MaterialReservationItem,
} from "../types/materialReservation";
import { Product } from "../types/product";
import { sell } from "../types/sell";
import { getCurrentUserFromRequest } from "../utils/currentUser";

const RESERVATIONS_PATH = "materialReservations";

type CloseReservationItemPayload = {
  id?: string;
  productId?: string;
  warehouse?: string;
  usedQty?: number | string;
  qty?: number | string;
};

const toNumber = (value: unknown, fallback = 0) => {
  const next = Number(value);
  return Number.isFinite(next) ? next : fallback;
};

const hasSubmittedValue = (value: unknown) =>
  value !== undefined && value !== null && String(value).trim() !== "";

const calculateDiscount = (source: any, subtotal: number) => {
  const discountPercent = toNumber(source.discountPercent);
  const discountAmountUSD = hasSubmittedValue(source.discountAmountUSD)
    ? toNumber(source.discountAmountUSD)
    : hasSubmittedValue(source.discountAmount)
      ? toNumber(source.discountAmount)
      : hasSubmittedValue(source.discountPercent)
        ? 0
      : toNumber(source.discount);

  if (discountPercent < 0 || discountPercent > 100) {
    throw new Error("Invalid discount percent");
  }

  if (discountAmountUSD < 0) {
    throw new Error("Invalid discount amount");
  }

  if (subtotal <= 0) {
    if (discountPercent > 0 || discountAmountUSD > 0) {
      throw new Error("Invalid discount");
    }

    return {
      discount: 0,
      discountPercent: 0,
      discountPercentUSD: 0,
      discountAmountUSD: 0,
    };
  }

  const discountPercentUSD = Number(
    (subtotal * (discountPercent / 100)).toFixed(3),
  );
  const discount = Number((discountPercentUSD + discountAmountUSD).toFixed(3));

  if (discount >= subtotal) {
    throw new Error("Invalid discount");
  }

  return {
    discount,
    discountPercent,
    discountPercentUSD,
    discountAmountUSD,
  };
};

const nowIso = () => new Date().toISOString();

const stripUndefined = <T>(value: T): T => {
  if (Array.isArray(value)) {
    return value.map(stripUndefined) as T;
  }

  if (value && typeof value === "object") {
    return Object.entries(value as Record<string, unknown>).reduce(
      (cleaned, [key, entryValue]) => {
        if (entryValue !== undefined) {
          cleaned[key] = stripUndefined(entryValue);
        }

        return cleaned;
      },
      {} as Record<string, unknown>,
    ) as T;
  }

  return value;
};

const itemKey = (productId: string, warehouse: string) =>
  `${warehouse}::${productId}`;

const getActorName = (req: Request) => {
  const user = getCurrentUserFromRequest(req);
  return user?.username || user?.userId || "system";
};

const getProduct = async (productId: string, warehouse: string) => {
  const productSnapshot = await get(ref(database, `products/${warehouse}/${productId}`));

  if (!productSnapshot.exists()) {
    throw new Error("Product not found");
  }

  const product = productSnapshot.val() as Product;

  return {
    ...product,
    id: product.id || productId,
    quantity: Number(product.quantity || 0),
    reservedQuantity: Number(product.reservedQuantity || 0),
  };
};

const normalizeReservationItem = async (
  rawItem: Record<string, any>,
  requestedByProduct: Map<string, number>,
): Promise<MaterialReservationItem> => {
  const productId = String(rawItem.productId || rawItem.id || "");
  const warehouse = String(rawItem.warehouse || "");
  const reservedQty = toNumber(rawItem.reservedQty ?? rawItem.qty);

  if (!productId || !warehouse || reservedQty <= 0) {
    throw new Error("Invalid reservation item");
  }

  const product = await getProduct(productId, warehouse);
  const key = itemKey(productId, warehouse);
  const alreadyRequested = requestedByProduct.get(key) || 0;
  const availableQuantity =
    Number(product.quantity || 0) -
    Number(product.reservedQuantity || 0) -
    alreadyRequested;

  if (reservedQty > availableQuantity) {
    throw new Error(
      `Insufficient available quantity for ${product.code}. Available: ${availableQuantity}, requested: ${reservedQty}`,
    );
  }

  requestedByProduct.set(key, alreadyRequested + reservedQty);

  return {
    id: productId,
    productId,
    name: product.name,
    code: product.code,
    category: product.category,
    warehouse,
    unit: product.unit,
    payPrice: toNumber(product.payPrice),
    wholesalePrice: toNumber(product.wholesalePrice),
    superWholesalePrice: toNumber(product.superWholesalePrice),
    sellPrice: toNumber(rawItem.sellPrice, toNumber(product.sellPrice)),
    reservedQty,
  };
};

const getReservationById = async (id: string) => {
  const reservationSnapshot = await get(ref(database, `${RESERVATIONS_PATH}/${id}`));

  if (!reservationSnapshot.exists()) {
    return null;
  }

  return reservationSnapshot.val() as MaterialReservation;
};

const getRelatedNames = async () => {
  const [customersSnapshot, usersSnapshot] = await Promise.all([
    get(ref(database, "customer")),
    get(ref(database, "users")),
  ]);

  return {
    customers: customersSnapshot.exists()
      ? (customersSnapshot.val() as Record<string, any>)
      : {},
    users: usersSnapshot.exists()
      ? (usersSnapshot.val() as Record<string, any>)
      : {},
  };
};

const enrichReservation = (
  reservation: MaterialReservation,
  relatedNames: Awaited<ReturnType<typeof getRelatedNames>>,
) => ({
  ...reservation,
  customerName: relatedNames.customers[reservation.customerId]?.name || "",
  technicianName:
    reservation.technicianName ||
    relatedNames.users[reservation.technicianId || ""]?.username ||
    reservation.technicianId ||
    "",
});

const validateSellPayment = ({
  paymentStatus,
  totalPrice,
  currency,
  exchangeRate,
  partValue,
  paymentAccountId,
  receivableAccountId,
  salesAccountId,
}: {
  paymentStatus: sell["paymentStatus"];
  totalPrice: number;
  currency: string;
  exchangeRate: number;
  partValue: number;
  paymentAccountId?: string;
  receivableAccountId?: string;
  salesAccountId?: string;
}) => {
  if (!salesAccountId) {
    throw new Error("Sales account is required");
  }

  if ((paymentStatus === "cash" || paymentStatus === "part") && !paymentAccountId) {
    throw new Error("Payment account is required");
  }

  if ((paymentStatus === "debt" || paymentStatus === "part") && !receivableAccountId) {
    throw new Error("Receivable account is required");
  }

  if (!currency) {
    throw new Error("Currency is required");
  }

  if (currency !== "USD" && exchangeRate <= 0) {
    throw new Error("Exchange rate must be greater than zero");
  }

  const paidAmount =
    paymentStatus === "cash"
      ? totalPrice
      : paymentStatus === "part"
      ? currency === "USD"
        ? partValue
        : Number((partValue / exchangeRate).toFixed(3))
      : 0;

  if (paymentStatus === "part" && (paidAmount <= 0 || paidAmount >= totalPrice)) {
    throw new Error("Partial payment must be greater than zero and less than invoice total");
  }

  return paidAmount;
};

const sendError = (res: Response, error: any, fallbackMessage: string) => {
  console.error(fallbackMessage, error);
  res.status(400).json({ message: error?.message || fallbackMessage });
};

export const getAllMaterialReservations = async (_req: Request, res: Response) => {
  try {
    const snapshot = await get(ref(database, RESERVATIONS_PATH));
    const reservations = snapshot.exists()
      ? (Object.values(snapshot.val()) as MaterialReservation[])
      : [];
    const relatedNames = await getRelatedNames();

    res.json(
      reservations
        .map((reservation) => enrichReservation(reservation, relatedNames))
        .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))),
    );
  } catch (error: any) {
    sendError(res, error, "Failed to fetch material reservations");
  }
};

export const getMaterialReservation = async (req: Request, res: Response) => {
  try {
    const reservation = await getReservationById(req.params.id);

    if (!reservation) {
      return res.status(404).json({ message: "Reservation not found" });
    }

    const relatedNames = await getRelatedNames();
    res.json(enrichReservation(reservation, relatedNames));
  } catch (error: any) {
    sendError(res, error, "Failed to fetch material reservation");
  }
};

export const createMaterialReservation = async (req: Request, res: Response) => {
  try {
    const { customerId, technicianId, technicianName, note } = req.body;
    const rawItems = Array.isArray(req.body.items) ? req.body.items : [];

    if (!customerId) {
      return res.status(400).json({ message: "Customer is required" });
    }

    if (!technicianName && !technicianId) {
      return res.status(400).json({ message: "Technician is required" });
    }

    if (!rawItems.length) {
      return res.status(400).json({ message: "At least one item is required" });
    }

    const requestedByProduct = new Map<string, number>();
    const items: MaterialReservationItem[] = [];

    for (const rawItem of rawItems) {
      items.push(await normalizeReservationItem(rawItem, requestedByProduct));
    }

    const id = uuidv4();
    const now = nowIso();
    const reservation: MaterialReservation = {
      id,
      customerId: String(customerId),
      technicianId: technicianId ? String(technicianId) : undefined,
      technicianName: String(technicianName || technicianId || ""),
      status: "reserved",
      items,
      note: note ? String(note) : undefined,
      totalReservedQty: items.reduce((sum, item) => sum + item.reservedQty, 0),
      createdAt: now,
      updatedAt: now,
      createdBy: getActorName(req),
      updatedBy: getActorName(req),
    };

    const reservedProducts: Array<{
      productId: string;
      warehouse: string;
      reservedQty: number;
    }> = [];

    try {
      for (const [key, reservedQty] of requestedByProduct) {
        const [warehouse, productId] = key.split("::");
        await reserveProductQuantityInternal(productId, warehouse, reservedQty);
        reservedProducts.push({ productId, warehouse, reservedQty });
      }

      await set(
        ref(database, `${RESERVATIONS_PATH}/${id}`),
        stripUndefined(reservation),
      );
    } catch (error) {
      await Promise.all(
        reservedProducts.map(({ productId, warehouse, reservedQty }) =>
          releaseReservedQuantityInternal(productId, warehouse, reservedQty).catch(
            (releaseError) =>
              console.error("Failed to rollback reserved quantity", releaseError),
          ),
        ),
      );

      throw error;
    }

    res.json({ message: "Reservation created", data: reservation });
  } catch (error: any) {
    sendError(res, error, "Failed to create material reservation");
  }
};

export const closeMaterialReservation = async (req: Request, res: Response) => {
  try {
    const reservation = await getReservationById(req.params.id);

    if (!reservation) {
      return res.status(404).json({ message: "Reservation not found" });
    }

    if (reservation.status !== "reserved") {
      return res.status(400).json({ message: "Reservation is not open" });
    }

    const closeItems = Array.isArray(req.body.items)
      ? (req.body.items as CloseReservationItemPayload[])
      : [];
    const usedByProduct = new Map<string, number>();

    for (const item of closeItems) {
      const productId = String(item.productId || item.id || "");
      const warehouse = String(item.warehouse || "");

      if (!productId || !warehouse) continue;

      usedByProduct.set(
        itemKey(productId, warehouse),
        toNumber(item.usedQty ?? item.qty),
      );
    }

    const settledItems = reservation.items.map((item) => {
      const key = itemKey(item.productId, item.warehouse);
      const usedQty = usedByProduct.has(key)
        ? toNumber(usedByProduct.get(key))
        : toNumber(item.usedQty);

      if (usedQty < 0 || usedQty > item.reservedQty) {
        throw new Error(`Invalid used quantity for ${item.code}`);
      }

      const returnedQty = item.reservedQty - usedQty;

      return {
        ...item,
        usedQty,
        returnedQty,
        lineTotal: Number((usedQty * Number(item.sellPrice || 0)).toFixed(3)),
      };
    });

    const soldItems = settledItems.filter((item) => Number(item.usedQty || 0) > 0);
    const zeroUsedItems = settledItems.filter(
      (item) => Number(item.usedQty || 0) === 0,
    );
    const sellPatch = req.body.sell || {};
    const totalBeforeDiscount = soldItems.reduce(
      (sum, item) => sum + Number(item.lineTotal || 0),
      0,
    );
    const {
      discount,
      discountPercent,
      discountPercentUSD,
      discountAmountUSD,
    } = calculateDiscount(sellPatch, totalBeforeDiscount);
    const totalPrice = Number((totalBeforeDiscount - discount).toFixed(3));
    let sellData: sell | undefined;

    if (soldItems.length) {
      const paymentStatus = ["cash", "part", "debt"].includes(
        String(sellPatch.paymentStatus),
      )
        ? (sellPatch.paymentStatus as sell["paymentStatus"])
        : "cash";
      const currency = String(sellPatch.currency || "USD");
      const exchangeRate = currency === "USD" ? 1 : toNumber(sellPatch.exchangeRate);
      const partValue = toNumber(sellPatch.partValue);
      const paidAmount = validateSellPayment({
        paymentStatus,
        totalPrice,
        currency,
        exchangeRate,
        partValue,
        paymentAccountId: sellPatch.paymentAccountId,
        receivableAccountId: sellPatch.receivableAccountId,
        salesAccountId: sellPatch.salesAccountId,
      });
      const releaseByProduct = new Map(
        soldItems.map((item) => [
          itemKey(item.productId, item.warehouse),
          item.reservedQty,
        ]),
      );
      const newSell: sell = {
        customerId: reservation.customerId,
        totalPrice,
        products: soldItems.map((item) => ({
          category: item.category || "",
          code: item.code,
          id: item.productId,
          name: item.name,
          payPrice: toNumber(item.payPrice),
          quantity: item.reservedQty,
          sellPrice: toNumber(item.sellPrice),
          unit: item.unit || "",
          updatedDate: "",
          warehouse: item.warehouse,
          qty: toNumber(item.usedQty),
        })),
        paymentStatus,
        remainingDebt: paymentStatus === "cash" ? 0 : totalPrice - paidAmount,
        paymentAccountId:
          paymentStatus === "debt" ? undefined : sellPatch.paymentAccountId,
        receivableAccountId:
          paymentStatus === "cash" ? undefined : sellPatch.receivableAccountId,
        salesAccountId: sellPatch.salesAccountId,
        currency,
        exchangeRate,
        amount_base: totalPrice * exchangeRate,
        partValue,
        subtotalUSD: totalBeforeDiscount,
        discountType:
          discountPercent > 0 && discountAmountUSD > 0
            ? "mixed"
            : discountPercent > 0
              ? "percent"
              : discountAmountUSD > 0
                ? "amount"
                : "none",
        discountPercent,
        discountPercentUSD,
        discountAmountUSD,
        discount,
      };

      sellData = await handleSell({
        newSell,
        stockUpdater: async (product) => {
          const releaseQty =
            releaseByProduct.get(itemKey(product.id, product.warehouse)) ||
            Number(product.qty || 0);

          await settleReservedQuantityOnSellInternal(
            product.id,
            product.warehouse,
            Number(product.qty || 0),
            releaseQty,
          );
        },
      });
    }

    for (const item of zeroUsedItems) {
      await releaseReservedQuantityInternal(
        item.productId,
        item.warehouse,
        item.reservedQty,
      );
    }

    const closedAt = nowIso();
    const updates: Partial<MaterialReservation> = {
      status: "closed",
      items: settledItems,
      sellId: sellData?.id,
      totalUsedQty: settledItems.reduce(
        (sum, item) => sum + Number(item.usedQty || 0),
        0,
      ),
      totalReturnedQty: settledItems.reduce(
        (sum, item) => sum + Number(item.returnedQty || 0),
        0,
      ),
      totalPrice,
      discount,
      discountPercent,
      discountPercentUSD,
      discountAmountUSD,
      closedAt,
      updatedAt: closedAt,
      updatedBy: getActorName(req),
    };

    await update(
      ref(database, `${RESERVATIONS_PATH}/${reservation.id}`),
      stripUndefined(updates),
    );

    res.json({
      message: "Reservation closed",
      data: { ...reservation, ...updates },
      sell: sellData,
    });
  } catch (error: any) {
    sendError(res, error, "Failed to close material reservation");
  }
};

export const cancelMaterialReservation = async (req: Request, res: Response) => {
  try {
    const reservation = await getReservationById(req.params.id);

    if (!reservation) {
      return res.status(404).json({ message: "Reservation not found" });
    }

    if (reservation.status !== "reserved") {
      return res.status(400).json({ message: "Only open reservations can be cancelled" });
    }

    for (const item of reservation.items) {
      await releaseReservedQuantityInternal(
        item.productId,
        item.warehouse,
        item.reservedQty,
      );
    }

    const cancelledAt = nowIso();
    const updates: Partial<MaterialReservation> = {
      status: "cancelled",
      cancelledAt,
      updatedAt: cancelledAt,
      updatedBy: getActorName(req),
    };

    await update(
      ref(database, `${RESERVATIONS_PATH}/${reservation.id}`),
      stripUndefined(updates),
    );

    res.json({
      message: "Reservation cancelled",
      data: { ...reservation, ...updates },
    });
  } catch (error: any) {
    sendError(res, error, "Failed to cancel material reservation");
  }
};

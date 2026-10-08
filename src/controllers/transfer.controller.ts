import { ref, push, get } from "firebase/database";
import { database } from "../firebaseConfig";

interface CreateTransferInput {
  productId: string;
  code: string;
  name: string;

  oldWarehouse: string;
  newWarehouse: string;

  quantity: number;
  amount: number;
  currency: string;

  stockBefore: number;
  stockAfter: number;

  performedBy?: string; // userId أو name
  referenceId?: string; // رقم الفاتورة أو العملية

  note?: string;
  fromProductId?: string;
  toProductId?: string;
  unitCostUSD?: number;
  fromDriverId?: string;
  toDriverId?: string;
  fromVehicleId?: string;
  toVehicleId?: string;
}

export const createTransferInternal = async (data: CreateTransferInput) => {
  try {
    const warehousesSnapshot = await get(ref(database, "warehouses"));
    const warehouses = Object.entries(warehousesSnapshot.exists() ? warehousesSnapshot.val() : {}) as Array<[string, any]>;
    const matchWarehouse = (value: string) => warehouses.find(([key, warehouse]) => [key, warehouse.id, warehouse.name].some(candidate => String(candidate || "").trim().toLowerCase() === String(value || "").trim().toLowerCase()));
    const from = matchWarehouse(data.oldWarehouse);
    const to = matchWarehouse(data.newWarehouse);
    const transferRef = await push(ref(database, "warehouseTransfers"), {
      productId: data.productId,
      productCode: data.code,
      productName: data.name,

      fromWarehouse: data.oldWarehouse,
      toWarehouse: data.newWarehouse,

      quantity: Number(data.quantity),
      cost: Number(data.amount || 0),
      currency: data.currency || "USD",

      stockBefore: Number(data.stockBefore),
      stockAfter: Number(data.stockAfter),

      performedBy: data.performedBy || "system",
      referenceId: data.referenceId || null,

      note: data.note || "",
      createdAt: Date.now(),
      date: new Date().toISOString(),
      fromProductId: data.fromProductId || data.productId,
      toProductId: data.toProductId || data.productId,
      unitCostUSD: Number(data.unitCostUSD || 0),
      fromWarehouseId: from?.[1].id || from?.[0] || "",
      toWarehouseId: to?.[1].id || to?.[0] || "",
      fromVehicleId: data.fromVehicleId || (from?.[1].type === "vehicle" ? from[1].id || from[0] : ""),
      toVehicleId: data.toVehicleId || (to?.[1].type === "vehicle" ? to[1].id || to[0] : ""),
      fromDriverId: data.fromDriverId ?? (from?.[1].type === "vehicle" ? from[1].driverId || "" : ""),
      toDriverId: data.toDriverId ?? (to?.[1].type === "vehicle" ? to[1].driverId || "" : ""),
    });

    return {
      success: true,
      transferId: transferRef.key,
    };
  } catch (error) {
    console.error("❌ createTransferInternal error:", error);
    throw error;
  }
};

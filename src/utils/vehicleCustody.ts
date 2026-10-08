import type { FinanceState } from "./goodsSettlement";
import { roundMoney, toMoneyNumber } from "./money";
import { validDriverKey } from "./driverFinanceMutations";

export const applyVehicleLoad = (original: FinanceState, input: { vehicleId: string; sourceWarehouseId?: string; sourceWarehouse: string; items: any[]; requestId: string; note: string }, context: { actorId: string; now: string; loadId: string; fingerprint: string }) => {
  const state = JSON.parse(JSON.stringify(original)) as FinanceState;
  validDriverKey(input.vehicleId, "السيارة"); validDriverKey(input.requestId, "معرف الطلب"); validDriverKey(input.sourceWarehouseId, "المستودع", true);
  if (state.users?.[context.actorId]?.role !== "admin") throw new Error("Admin permission is required");
  const duplicate = state.vehicleLoadRequests?.[input.requestId];
  if (duplicate) { if (duplicate.fingerprint !== context.fingerprint || duplicate.actorId !== context.actorId) throw new Error("معرف الطلب مستخدم لعملية تحميل مختلفة"); return state; }
  const vehicle = state.warehouses?.[input.vehicleId];
  if (!vehicle || vehicle.type !== "vehicle" || vehicle.isActive === false) throw new Error("Vehicle not found or inactive");
  const sourceEntry = Object.entries(state.warehouses || {}).find(([key, w]: [string, any]) => input.sourceWarehouseId ? key === input.sourceWarehouseId || w.id === input.sourceWarehouseId : [key, w.id, w.name].some(value => String(value || "").trim().toLowerCase() === input.sourceWarehouse.trim().toLowerCase())) as [string, any] | undefined;
  if (!sourceEntry || sourceEntry[1].isActive === false || sourceEntry[0] === input.vehicleId) throw new Error("Valid source warehouse is required");
  const [sourceId, source] = sourceEntry;
  const sourceKey = Object.keys(state.products || {}).find(key => key.trim().toLowerCase() === String(source.name).trim().toLowerCase()) || source.name;
  const sourceProducts = state.products?.[sourceKey] || state.products?.[sourceId] || {};
  const targetKey = Object.keys(state.products || {}).find(key => key.trim().toLowerCase() === String(vehicle.name).trim().toLowerCase()) || vehicle.name;
  state.products ||= {}; state.products[targetKey] ||= {};
  const targetProducts = state.products[targetKey];
  const items = new Map<string, { quantity: number; sellPrice?: number }>();
  for (const item of input.items) {
    const id = String(item.productId || item.id || ""); const quantity = Number(item.quantity ?? item.qty);
    validDriverKey(id, "الصنف");
    if (!Number.isFinite(quantity) || quantity <= 0 || quantity > 1e12) throw new Error("Invalid load item");
    if (roundMoney(quantity) <= 0) throw new Error("كمية التحميل أصغر من الدقة المعتمدة");
    const prior = items.get(id);
    const sellPrice = item.sellPrice === undefined || item.sellPrice === "" ? prior?.sellPrice : Number(item.sellPrice);
    if (sellPrice !== undefined && (!Number.isFinite(sellPrice) || sellPrice <= 0)) throw new Error("سعر المبيع يجب أن يكون موجبًا");
    items.set(id, { quantity: roundMoney(toMoneyNumber(prior?.quantity) + quantity), sellPrice });
  }
  if (!items.size || items.size > 500) throw new Error("At least one product is required (maximum 500)");
  state.warehouseTransfers ||= {};
  let index = 0;
  for (const [productId, item] of items) {
    const sourceProduct = sourceProducts[productId];
    if (!sourceProduct) throw new Error(`Product ${productId} not found in source warehouse`);
    const sourceQuantity = toMoneyNumber(sourceProduct.quantity);
    const reserved = toMoneyNumber(sourceProduct.reservedQuantity);
    if (sourceQuantity < 0 || reserved < 0 || reserved > sourceQuantity) throw new Error("كمية المخزون أو الحجز غير صالحة؛ راجع الصنف");
    const available = sourceQuantity - reserved;
    if (item.quantity > available) throw new Error(`Insufficient quantity for ${sourceProduct.code}. Available: ${available}, requested: ${item.quantity}`);
    const match = Object.entries(targetProducts).find(([, p]: [string, any]) => p.code === sourceProduct.code) as [string, any] | undefined;
    const targetId = match?.[0] || `${context.loadId}_${index}`;
    const previous = match?.[1];
    const sellPrice = item.sellPrice || toMoneyNumber(previous?.sellPrice) || toMoneyNumber(sourceProduct.sellPrice);
    if (sellPrice <= 0) throw new Error(`سعر المبيع مطلوب للمنتج ${sourceProduct.code}`);
    const oldQuantity = toMoneyNumber(previous?.quantity);
    if (oldQuantity < 0 || toMoneyNumber(previous?.reservedQuantity) < 0) throw new Error("مخزون السيارة أو حجزه غير صالح");
    const newQuantity = roundMoney(oldQuantity + item.quantity);
    const unitCostUSD = toMoneyNumber(sourceProduct.payPrice);
    if (unitCostUSD < 0 || toMoneyNumber(previous?.payPrice) < 0) throw new Error("تكلفة المخزون غير صالحة");
    const nextCost = newQuantity > 0 ? roundMoney((oldQuantity * toMoneyNumber(previous?.payPrice) + item.quantity * unitCostUSD) / newQuantity, 6) : unitCostUSD;
    targetProducts[targetId] = { ...sourceProduct, ...previous, id: targetId, warehouse: vehicle.name, quantity: newQuantity, payPrice: nextCost, reservedQuantity: toMoneyNumber(previous?.reservedQuantity), sellPrice, updatedDate: context.now };
    sourceProducts[productId] = { ...sourceProduct, quantity: roundMoney(sourceQuantity - item.quantity), updatedDate: context.now };
    const transferId = `${context.loadId}_${index++}`;
    state.warehouseTransfers[transferId] = { id: transferId, productId, fromProductId: productId, toProductId: targetId, productCode: sourceProduct.code, productName: sourceProduct.name, fromWarehouse: source.name, toWarehouse: vehicle.name, fromWarehouseId: source.id || sourceId, toWarehouseId: vehicle.id || input.vehicleId, fromVehicleId: source.type === "vehicle" ? source.id || sourceId : "", toVehicleId: vehicle.id || input.vehicleId, fromDriverId: source.type === "vehicle" ? source.driverId || "" : "", toDriverId: vehicle.driverId || "", quantity: item.quantity, unitCostUSD, cost: 0, currency: "USD", stockBefore: sourceQuantity, stockAfter: roundMoney(sourceQuantity - item.quantity), performedBy: context.actorId, referenceId: context.loadId, requestId: input.requestId, note: input.note || "Vehicle load", date: context.now, createdAt: Date.parse(context.now) };
  }
  const actualSourceKey = state.products[sourceKey] ? sourceKey : sourceId;
  state.products[actualSourceKey] = sourceProducts;
  state.vehicleLoadRequests ||= {}; state.vehicleLoadRequests[input.requestId] = { id: context.loadId, actorId: context.actorId, fingerprint: context.fingerprint, createdAt: context.now };
  return state;
};

export const applyVehicleCustodyChange = (original: FinanceState, vehicleId: string, updates: any, context: { actorId: string; now: string; transferId: string }) => {
  const state = JSON.parse(JSON.stringify(original)) as FinanceState;
  validDriverKey(vehicleId, "السيارة");
  if (state.users?.[context.actorId]?.role !== "admin") throw new Error("Admin permission is required");
  const vehicle = state.warehouses?.[vehicleId];
  if (!vehicle || vehicle.type !== "vehicle") throw new Error("Vehicle not found");
  const previousId = vehicle.driverId || "";
  const nextId = updates.driverId === undefined ? previousId : updates.driverId || "";
  validDriverKey(nextId, "السائق", true);
  if (nextId && (!state.users?.[nextId] || state.users[nextId].role === "admin")) throw new Error("Driver not found");
  const next = { ...vehicle, ...updates };
  if (previousId !== nextId) {
    const products = state.products?.[vehicle.name] || state.products?.[vehicleId] || {};
    state.warehouseTransfers ||= {};
    let index = 0;
    for (const [id, p] of Object.entries(products) as Array<[string, any]>) {
      if (toMoneyNumber(p.quantity) <= 0) continue;
      const transferId = `${context.transferId}_${index++}`;
      state.warehouseTransfers[transferId] = { id: transferId, type: "custody-change", productId: p.id || id, fromProductId: p.id || id, toProductId: p.id || id, productCode: p.code || "", productName: p.name || "", quantity: toMoneyNumber(p.quantity), unitCostUSD: toMoneyNumber(p.payPrice), fromWarehouse: vehicle.name, toWarehouse: vehicle.name, fromWarehouseId: vehicleId, toWarehouseId: vehicleId, fromVehicleId: vehicleId, toVehicleId: vehicleId, fromDriverId: previousId, toDriverId: nextId, cost: 0, currency: "USD", stockBefore: p.quantity, stockAfter: p.quantity, performedBy: context.actorId, referenceId: context.transferId, note: "نقل عهدة البضاعة عند تغيير سائق السيارة", date: context.now, createdAt: Date.parse(context.now) };
    }
    if (previousId && state.users?.[previousId]?.vehicleId === vehicleId) { state.users[previousId].vehicleId = ""; state.users[previousId].vehicleName = ""; state.users[previousId].updatedAt = context.now; }
    if (nextId) { state.users[nextId].vehicleId = vehicleId; state.users[nextId].vehicleName = vehicle.name; state.users[nextId].updatedAt = context.now; }
  }
  state.warehouses[vehicleId] = next;
  return state;
};

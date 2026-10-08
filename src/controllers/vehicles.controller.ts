import { Request, Response } from "express";
import { get, push, ref, set, update, runTransaction } from "firebase/database";
import { v4 as uuidv4 } from "uuid";
import { database } from "../firebaseConfig";
import { createTransferInternal } from "./transfer.controller";
import {
  resetProductsCache,
  resolveProductsWarehouseKey,
} from "./products.controller";
import { handleSell } from "../functions/transactions";
import { Product } from "../types/product";
import { sell } from "../types/sell";
import { Warehouse } from "../types/warehouse";
import { requireFinanceUser } from "../utils/financeAuth";
import { randomUUID, createHash } from "crypto";
import { applyVehicleCustodyChange, applyVehicleLoad } from "../utils/vehicleCustody";
import {
  getCurrentUserFromRequest,
  type CurrentUser,
} from "../utils/currentUser";

const WAREHOUSES_PATH = "warehouses";
const PRODUCTS_PATH = "products";
const USERS_PATH = "users";
const SELLS_PATH = "sells";
const INVALID_WAREHOUSE_PATH_CHARS = /[.#$\/\[\]]/;

type VehicleWarehouse = Warehouse & {
  type: "vehicle";
};

type UserVehicleRecord = {
  id?: string;
  _id?: string;
  username?: string;
  vehicleId?: string;
  vehicleName?: string;
};

const toNumber = (value: unknown, fallback = 0) => {
  const next = Number(value);
  return Number.isFinite(next) ? next : fallback;
};

const hasSubmittedValue = (value: unknown) =>
  value !== undefined && value !== null && String(value).trim() !== "";

const normalizeLookupValue = (value: unknown) => {
  if (typeof value !== "string" && typeof value !== "number") return "";
  return String(value).trim();
};

const getLookupKeys = (...values: unknown[]) =>
  Array.from(
    new Set(
      values
        .map((value) => normalizeLookupValue(value).toLowerCase())
        .filter(Boolean),
    ),
  );

const matchesLookupKey = (value: unknown, keys: string[]) => {
  const lookupValue = normalizeLookupValue(value).toLowerCase();
  return Boolean(lookupValue && keys.includes(lookupValue));
};

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
    throw new Error("Discount percent must be between 0 and 100");
  }

  if (discountAmountUSD < 0) {
    throw new Error("Discount amount cannot be negative");
  }

  const discountPercentUSD = Number(
    (subtotal * (discountPercent / 100)).toFixed(3),
  );
  const discount = Number((discountPercentUSD + discountAmountUSD).toFixed(3));

  if (discount >= subtotal) {
    throw new Error("Discount must be less than invoice subtotal");
  }

  return {
    discount,
    discountPercent,
    discountPercentUSD,
    discountAmountUSD,
  };
};

const todayKey = () =>
  new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Damascus" });

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

const getDateKey = (value: unknown) => {
  if (!value) return "";

  const date = new Date(String(value));
  if (Number.isNaN(date.getTime())) return "";

  return date.toLocaleDateString("en-CA", { timeZone: "Asia/Damascus" });
};

const getAllWarehouses = async (): Promise<Warehouse[]> => {
  const snapshot = await get(ref(database, WAREHOUSES_PATH));
  return snapshot.exists() ? (Object.values(snapshot.val()) as Warehouse[]) : [];
};

const getVehicleWarehouses = async ({
  activeOnly = false,
}: {
  activeOnly?: boolean;
} = {}): Promise<VehicleWarehouse[]> =>
  (await getAllWarehouses())
    .filter((warehouse) => warehouse.type === "vehicle")
    .map((warehouse) => ({
      ...warehouse,
      type: "vehicle" as const,
      isActive: warehouse.isActive !== false,
    }))
    .filter((warehouse) => !activeOnly || warehouse.isActive !== false);

const getVehicleById = async (id: string) => {
  const snapshot = await get(ref(database, `${WAREHOUSES_PATH}/${id}`));

  if (!snapshot.exists()) return null;

  const warehouse = snapshot.val() as Warehouse;
  if (warehouse.type !== "vehicle") return null;

  return { ...warehouse, type: "vehicle" as const };
};

const getProductsForWarehouse = async (warehouseName: string) => {
  const snapshot = await get(ref(database, `${PRODUCTS_PATH}/${warehouseName}`));

  return snapshot.exists()
    ? (Object.values(snapshot.val()) as Product[]).map((product) => ({
        ...product,
        quantity: toNumber(product.quantity),
        reservedQuantity: toNumber(product.reservedQuantity),
        payPrice: toNumber(product.payPrice),
        wholesalePrice: toNumber(product.wholesalePrice),
        superWholesalePrice: toNumber(product.superWholesalePrice),
        sellPrice: toNumber(product.sellPrice),
        warehouse: product.warehouse || warehouseName,
      }))
    : [];
};

const getSalesForWarehouse = async (warehouseName: string, date = todayKey()) => {
  const snapshot = await get(ref(database, SELLS_PATH));
  const sales = snapshot.exists() ? (Object.values(snapshot.val()) as sell[]) : [];

  return sales.filter((sale) => {
    if (date && getDateKey(sale.date) !== date) return false;

    return Array.isArray(sale.products)
      ? sale.products.some((product) => product.warehouse === warehouseName)
      : false;
  });
};

const summarizeVehicle = async (vehicle: VehicleWarehouse, date?: string) => {
  const [products, sales] = await Promise.all([
    getProductsForWarehouse(vehicle.name),
    getSalesForWarehouse(vehicle.name, date || todayKey()),
  ]);

  const totalQuantity = products.reduce(
    (sum, product) => sum + toNumber(product.quantity),
    0,
  );
  const stockCostValue = products.reduce(
    (sum, product) => sum + toNumber(product.quantity) * toNumber(product.payPrice),
    0,
  );
  const stockSellValue = products.reduce(
    (sum, product) => sum + toNumber(product.quantity) * toNumber(product.sellPrice),
    0,
  );
  const salesTotal = sales.reduce(
    (sum, sale) => sum + toNumber(sale.totalPrice),
    0,
  );

  return {
    vehicle,
    products,
    sales,
    totals: {
      productsCount: products.length,
      totalQuantity,
      stockCostValue,
      stockSellValue,
      salesCount: sales.length,
      salesTotal,
    },
  };
};

const requireAdmin = async (req: Request, res: Response) => {
  let currentUser;
  try { currentUser = await requireFinanceUser(req); } catch {
    res.status(401).json({ message: "Unauthorized" });
    return null;
  }

  if (currentUser.role !== "admin") {
    res.status(403).json({ message: "Admin permission is required" });
    return null;
  }

  return currentUser;
};

const getUserRecord = async (userKey: string) => {
  const snapshot = await get(ref(database, `${USERS_PATH}/${userKey}`));
  return snapshot.exists() ? (snapshot.val() as UserVehicleRecord) : null;
};

const attachVehicleToUser = async (vehicle: VehicleWarehouse) => {
  if (!vehicle.driverId) return;

  await update(ref(database, `${USERS_PATH}/${vehicle.driverId}`), {
    vehicleId: vehicle.id,
    vehicleName: vehicle.name,
    updatedAt: new Date().toISOString(),
  }).catch((error) => {
    console.error("Failed to attach vehicle to user", error);
  });
};

const clearVehicleFromUser = async (
  userKey: string | undefined,
  vehicle: VehicleWarehouse,
) => {
  if (!userKey) return;

  const userRecord = await getUserRecord(userKey);
  if (!userRecord) return;

  const isLinkedToVehicle =
    matchesLookupKey(userRecord.vehicleId, getLookupKeys(vehicle.id)) ||
    matchesLookupKey(userRecord.vehicleName, getLookupKeys(vehicle.name));

  if (!isLinkedToVehicle) return;

  await update(ref(database, `${USERS_PATH}/${userKey}`), {
    vehicleId: null,
    vehicleName: null,
    updatedAt: new Date().toISOString(),
  }).catch((error) => {
    console.error("Failed to clear vehicle from previous user", error);
  });
};

const getUserRecordForCurrentUser = async (
  currentUser: CurrentUser,
): Promise<UserVehicleRecord | null> => {
  const directUserKeys = Array.from(
    new Set(
      [currentUser.userId, currentUser.username]
        .map(normalizeLookupValue)
        .filter(Boolean),
    ),
  );

  for (const userKey of directUserKeys) {
    const userSnapshot = await get(ref(database, `${USERS_PATH}/${userKey}`));
    if (userSnapshot.exists()) return userSnapshot.val() as UserVehicleRecord;
  }

  const identityKeys = getLookupKeys(currentUser.userId, currentUser.username);
  const usersSnapshot = await get(ref(database, USERS_PATH));
  if (!usersSnapshot.exists()) return null;

  const users = usersSnapshot.val() as Record<string, UserVehicleRecord>;
  const matchingUser = Object.entries(users).find(
    ([key, user]) =>
      matchesLookupKey(key, identityKeys) ||
      matchesLookupKey(user.id, identityKeys) ||
      matchesLookupKey(user._id, identityKeys) ||
      matchesLookupKey(user.username, identityKeys),
  );

  return matchingUser?.[1] || null;
};

const getCurrentUserVehicles = async (currentUser: CurrentUser) => {
  const userRecord = await getUserRecordForCurrentUser(currentUser);
  const vehicles = await getVehicleWarehouses({ activeOnly: true });
  const identityKeys = getLookupKeys(
    currentUser.userId,
    currentUser.username,
    userRecord?.id,
    userRecord?._id,
    userRecord?.username,
  );
  const vehicleIdKeys = getLookupKeys(userRecord?.vehicleId);
  const vehicleNameKeys = getLookupKeys(userRecord?.vehicleName);

  const linkedVehicles = vehicles.filter(
    (vehicle) =>
      matchesLookupKey(vehicle.id, vehicleIdKeys) ||
      matchesLookupKey(vehicle.name, vehicleNameKeys),
  );
  const driverVehicles = vehicles.filter(
    (vehicle) =>
      matchesLookupKey(vehicle.driverId, identityKeys) ||
      matchesLookupKey(vehicle.driverName, identityKeys),
  );
  const vehiclesById = new Map<string, VehicleWarehouse>();

  [...linkedVehicles, ...driverVehicles].forEach((vehicle) => {
    vehiclesById.set(vehicle.id || vehicle.name, vehicle);
  });

  return Array.from(vehiclesById.values());
};

const getCurrentUserVehicleSelection = async (
  currentUser: CurrentUser,
  ...requestedValues: unknown[]
) => {
  const vehicles = await getCurrentUserVehicles(currentUser);
  const requestedKeys = getLookupKeys(...requestedValues);
  const selectedVehicle = requestedKeys.length
    ? vehicles.find(
        (vehicle) =>
          matchesLookupKey(vehicle.id, requestedKeys) ||
          matchesLookupKey(vehicle.name, requestedKeys),
      ) || null
    : vehicles[0] || null;

  return {
    vehicle: selectedVehicle,
    vehicles,
  };
};

export const getAllVehicles = async (req: Request, res: Response) => {
  if (!await requireAdmin(req, res)) return;

  try {
    const date = String(req.query.date || todayKey());
    const vehicles = await getVehicleWarehouses();
    const summaries = await Promise.all(
      vehicles.map((vehicle) => summarizeVehicle(vehicle, date)),
    );

    res.json({ data: summaries });
  } catch (error: any) {
    console.error("Error fetching vehicles:", error);
    res.status(error.message === "UNAUTHORIZED" ? 401 : error.message === "FORBIDDEN" ? 403 : 500).json({ message: error.message || "Failed to fetch vehicles" });
  }
};

export const getMyVehicleDashboard = async (req: Request, res: Response) => {
  try {
    const currentUser = await requireFinanceUser(req);
    if (!currentUser) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    const selection = await getCurrentUserVehicleSelection(
      currentUser,
      req.query.vehicleId,
      req.query.vehicleName,
    );

    if (!selection.vehicles.length) {
      return res.status(404).json({ message: "No vehicle assigned to this driver" });
    }

    if (!selection.vehicle) {
      return res.status(403).json({ message: "Vehicle is not assigned to this driver" });
    }

    const date = String(req.query.date || todayKey());
    const summaries = await Promise.all(
      selection.vehicles.map((vehicle) => summarizeVehicle(vehicle, date)),
    );
    const selectedSummary =
      summaries.find(
        (summary) => summary.vehicle.id === selection.vehicle?.id,
      ) || summaries[0];

    res.json({ data: selectedSummary, vehicles: summaries });
  } catch (error: any) {
    console.error("Error fetching driver vehicle:", error);
    res.status(error.message === "UNAUTHORIZED" ? 401 : error.message === "FORBIDDEN" ? 403 : 500).json({ message: error.message || "Failed to fetch vehicle" });
  }
};

export const getMyVehicleDiagnostics = async (req: Request, res: Response) => {
  try {
    const currentUser = await requireFinanceUser(req);
    if (!currentUser) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    const userRecord = await getUserRecordForCurrentUser(currentUser);
    const activeVehicles = await getCurrentUserVehicles(currentUser);
    const allVehicleSummaries = (await getVehicleWarehouses()).map((vehicle) => ({
      id: vehicle.id,
      name: vehicle.name,
      isActive: vehicle.isActive !== false,
      driverId: vehicle.driverId || "",
      driverName: vehicle.driverName || "",
    }));

    res.json({
      currentUser,
      userRecordFound: Boolean(userRecord),
      userVehicleId: userRecord?.vehicleId || "",
      userVehicleName: userRecord?.vehicleName || "",
      matchedActiveVehicles: activeVehicles.map((vehicle) => ({
        id: vehicle.id,
        name: vehicle.name,
        driverId: vehicle.driverId || "",
        driverName: vehicle.driverName || "",
      })),
      allVehicles: currentUser.role === "admin" ? allVehicleSummaries : undefined,
    });
  } catch (error: any) {
    console.error("Error fetching vehicle diagnostics:", error);
    res.status(500).json({
      message: error.message || "Failed to fetch vehicle diagnostics",
    });
  }
};

export const createVehicle = async (req: Request, res: Response) => {
  const currentUser = await requireAdmin(req, res);
  if (!currentUser) return;

  try {
    const name = String(req.body.name || "").trim();

    if (!name) {
      return res.status(400).json({ message: "Vehicle warehouse name is required" });
    }

    if (INVALID_WAREHOUSE_PATH_CHARS.test(name)) {
      return res.status(400).json({
        message: "Vehicle warehouse name cannot contain . # $ / [ ]",
      });
    }

    const warehouses = await getAllWarehouses();
    const nameExists = warehouses.some(
      (warehouse) => warehouse.name.trim().toLowerCase() === name.toLowerCase(),
    );

    if (nameExists) {
      return res.status(400).json({ message: "Warehouse name already exists" });
    }

    const id = uuidv4();
    const now = new Date().toLocaleString();
    const vehicle: VehicleWarehouse = stripUndefined({
      id,
      name,
      location: String(req.body.location || ""),
      isActive: true,
      type: "vehicle",
      plateNumber: req.body.plateNumber ? String(req.body.plateNumber) : "",
      driverId: req.body.driverId ? String(req.body.driverId) : "",
      driverName: req.body.driverName ? String(req.body.driverName) : "",
      defaultPaymentAccountId: req.body.defaultPaymentAccountId
        ? String(req.body.defaultPaymentAccountId)
        : "",
      defaultReceivableAccountId: req.body.defaultReceivableAccountId
        ? String(req.body.defaultReceivableAccountId)
        : "",
      defaultSalesAccountId: req.body.defaultSalesAccountId
        ? String(req.body.defaultSalesAccountId)
        : "",
      createdDate: now,
      updatedDate: now,
    });

    await set(ref(database, `${WAREHOUSES_PATH}/${id}`), vehicle);

    await attachVehicleToUser(vehicle);

    res.json({ message: "Vehicle created", data: vehicle });
  } catch (error: any) {
    console.error("Error creating vehicle:", error);
    res.status(error.message === "UNAUTHORIZED" ? 401 : error.message === "FORBIDDEN" ? 403 : 500).json({ message: error.message || "Failed to create vehicle" });
  }
};

export const updateVehicle = async (req: Request, res: Response) => {
  if (!await requireAdmin(req, res)) return;

  try {
    const vehicle = await getVehicleById(req.params.id);
    if (!vehicle) {
      return res.status(404).json({ message: "Vehicle not found" });
    }

    const updates: Partial<VehicleWarehouse> = stripUndefined({
      location:
        req.body.location === undefined ? vehicle.location : String(req.body.location),
      isActive:
        req.body.isActive === undefined ? vehicle.isActive : Boolean(req.body.isActive),
      plateNumber:
        req.body.plateNumber === undefined
          ? vehicle.plateNumber
          : String(req.body.plateNumber),
      driverId:
        req.body.driverId === undefined ? vehicle.driverId : String(req.body.driverId),
      driverName:
        req.body.driverName === undefined
          ? vehicle.driverName
          : String(req.body.driverName),
      defaultPaymentAccountId:
        req.body.defaultPaymentAccountId === undefined
          ? vehicle.defaultPaymentAccountId
          : String(req.body.defaultPaymentAccountId),
      defaultReceivableAccountId:
        req.body.defaultReceivableAccountId === undefined
          ? vehicle.defaultReceivableAccountId
          : String(req.body.defaultReceivableAccountId),
      defaultSalesAccountId:
        req.body.defaultSalesAccountId === undefined
          ? vehicle.defaultSalesAccountId
          : String(req.body.defaultSalesAccountId),
      updatedDate: new Date().toLocaleString(),
    });

    const actor = await requireFinanceUser(req);
    const context = { actorId: actor.userId, now: new Date().toISOString(), transferId: randomUUID() };
    const root = ref(database);
    const initialSnapshot = await get(root);
    if (!initialSnapshot.exists()) throw new Error("Vehicle state not found");
    const transaction = await runTransaction(root, (state) => applyVehicleCustodyChange(state || initialSnapshot.val(), vehicle.id, updates, context), { applyLocally: false });
    if (!transaction.committed) throw new Error("Vehicle update could not be committed");
    const updatedVehicle = { ...vehicle, ...updates };

    res.json({ message: "Vehicle updated", data: updatedVehicle });
  } catch (error: any) {
    console.error("Error updating vehicle:", error);
    res.status(error.message === "UNAUTHORIZED" ? 401 : error.message === "FORBIDDEN" ? 403 : 500).json({ message: error.message || "Failed to update vehicle" });
  }
};

export const loadVehicle = async (req: Request, res: Response) => {
  const currentUser = await requireAdmin(req, res);
  if (!currentUser) return;
  try {
    const requestId = String(req.body.requestId || randomUUID());
    if (!/^[A-Za-z0-9_-]{8,128}$/.test(requestId)) throw new Error("Invalid load request id");
    const input = {
      vehicleId: req.params.id,
      sourceWarehouseId: String(req.body.sourceWarehouseId || "").trim(),
      sourceWarehouse: String(req.body.sourceWarehouse || "").trim(),
      items: Array.isArray(req.body.items) ? req.body.items : [],
      requestId,
      note: String(req.body.note || "").trim().slice(0, 2000),
    };
    const context = { actorId: currentUser.userId, now: new Date().toISOString(), loadId: randomUUID(), fingerprint: createHash("sha256").update(JSON.stringify(input)).digest("hex") };
    const root = ref(database);
    const initialSnapshot = await get(root);
    if (!initialSnapshot.exists()) throw new Error("Vehicle state not found");
    const transaction = await runTransaction(root, (state) => applyVehicleLoad(state || initialSnapshot.val(), input, context), { applyLocally: false });
    if (!transaction.committed) throw new Error("Vehicle loading could not be committed");
    resetProductsCache();
    const vehicle = await getVehicleById(req.params.id);
    if (!vehicle) throw new Error("Vehicle not found");
    res.json({ message: "Vehicle loaded", data: await summarizeVehicle(vehicle, todayKey()) });
  } catch (error: any) {
    res.status(error.message === "UNAUTHORIZED" ? 401 : error.message === "FORBIDDEN" ? 403 : 400).json({ message: error.message || "Failed to load vehicle" });
  }
};

export const createMyVehicleSale = async (req: Request, res: Response) => {
  try {
    const currentUser = await requireFinanceUser(req);
    if (!currentUser) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    const rawSell = req.body.newSell || req.body;
    const selection = await getCurrentUserVehicleSelection(
      currentUser,
      rawSell.vehicleId,
      rawSell.vehicleName,
      rawSell.sourceWarehouse,
    );

    if (!selection.vehicles.length) {
      return res.status(404).json({ message: "No vehicle assigned to this driver" });
    }

    if (!selection.vehicle) {
      return res.status(403).json({ message: "Vehicle is not assigned to this driver" });
    }

    const vehicle = selection.vehicle;
    if (vehicle.isActive === false) {
      return res.status(400).json({ message: "Vehicle is inactive" });
    }

    const rawProducts = Array.isArray(rawSell.products) ? rawSell.products : [];

    if (!rawSell.customerId) {
      return res.status(400).json({ message: "Customer is required" });
    }

    if (!rawProducts.length) {
      return res.status(400).json({ message: "At least one product is required" });
    }

    const vehicleProducts = await getProductsForWarehouse(vehicle.name);
    const productsById = new Map(vehicleProducts.map((product) => [product.id, product]));
    const products: sell["products"] = rawProducts.map((rawProduct: any) => {
      const productId = String(rawProduct.id || rawProduct.productId || "");
      const stockProduct = productsById.get(productId);
      const qty = toNumber(rawProduct.qty ?? rawProduct.quantity);

      if (!stockProduct) {
        throw new Error("Product is not available in this vehicle");
      }

      if (qty <= 0) {
        throw new Error(`Invalid quantity for ${stockProduct.code}`);
      }

      const stockSellPrice = toNumber(stockProduct.sellPrice);
      if (stockSellPrice <= 0) {
        throw new Error(
          `سعر المبيع مطلوب للمنتج ${stockProduct.code}. عدل سعر المنتج في السيارة قبل البيع.`,
        );
      }

      return {
        category: stockProduct.category || "",
        code: stockProduct.code,
        id: stockProduct.id || productId,
        name: stockProduct.name,
        payPrice: toNumber(stockProduct.payPrice),
        quantity: toNumber(stockProduct.quantity),
        sellPrice: stockSellPrice,
        wholesalePrice: toNumber(stockProduct.wholesalePrice),
        superWholesalePrice: toNumber(stockProduct.superWholesalePrice),
        selectedPriceType: "sellPrice",
        unit: stockProduct.unit || "",
        updatedDate: stockProduct.updatedDate || "",
        warehouse: vehicle.name,
        qty,
      };
    });

    const subtotal = products.reduce(
      (sum, product) => sum + product.qty * product.sellPrice,
      0,
    );
    const {
      discount,
      discountPercent,
      discountPercentUSD,
      discountAmountUSD,
    } = calculateDiscount(rawSell, subtotal);
    const totalPrice = Number((subtotal - discount).toFixed(3));
    const paymentStatus = ["cash", "part", "debt"].includes(
      String(rawSell.paymentStatus),
    )
      ? (rawSell.paymentStatus as sell["paymentStatus"])
      : "cash";
    const currency = String(rawSell.currency || "USD");
    const exchangeRate = currency === "USD" ? 1 : toNumber(rawSell.exchangeRate);
    const partValue = toNumber(rawSell.partValue);
    const paidAmount =
      paymentStatus === "cash"
        ? totalPrice
        : paymentStatus === "part"
        ? currency === "USD"
          ? partValue
          : Number((partValue / exchangeRate).toFixed(3))
        : 0;

    if (!rawSell.salesAccountId && !vehicle.defaultSalesAccountId) {
      return res.status(400).json({ message: "Sales account is required" });
    }

    if (
      (paymentStatus === "cash" || paymentStatus === "part") &&
      !rawSell.paymentAccountId &&
      !vehicle.defaultPaymentAccountId
    ) {
      return res.status(400).json({ message: "Payment account is required" });
    }

    if (
      (paymentStatus === "debt" || paymentStatus === "part") &&
      !rawSell.receivableAccountId &&
      !vehicle.defaultReceivableAccountId
    ) {
      return res.status(400).json({ message: "Receivable account is required" });
    }

    if (currency !== "USD" && exchangeRate <= 0) {
      return res.status(400).json({ message: "Exchange rate must be greater than zero" });
    }

    if (paymentStatus === "part" && (paidAmount <= 0 || paidAmount >= totalPrice)) {
      return res.status(400).json({
        message: "Partial payment must be greater than zero and less than invoice total",
      });
    }

    const newSell: sell = {
      customerId: String(rawSell.customerId),
      products,
      totalPrice,
      paymentStatus,
      remainingDebt: paymentStatus === "cash" ? 0 : totalPrice - paidAmount,
      paymentAccountId:
        paymentStatus === "debt"
          ? undefined
          : rawSell.paymentAccountId || vehicle.defaultPaymentAccountId,
      receivableAccountId:
        paymentStatus === "cash"
          ? undefined
          : rawSell.receivableAccountId || vehicle.defaultReceivableAccountId,
      salesAccountId: rawSell.salesAccountId || vehicle.defaultSalesAccountId,
      currency,
      exchangeRate,
      amount_base: totalPrice * exchangeRate,
      partValue,
      subtotalUSD: subtotal,
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
      vehicleId: vehicle.id,
      vehicleName: vehicle.name,
      driverId: currentUser.userId,
      driverName: currentUser.username,
      sourceWarehouse: vehicle.name,
    };

    const result = await handleSell({ newSell });
    res.json({ message: "Vehicle sale created", data: result });
  } catch (error: any) {
    console.error("Error creating vehicle sale:", error);
    res.status(error.message === "UNAUTHORIZED" ? 401 : error.message === "FORBIDDEN" ? 403 : 400).json({ message: error.message || "Failed to create vehicle sale" });
  }
};

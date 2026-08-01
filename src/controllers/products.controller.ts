import e, { Request, Response } from "express";
import { Product } from "../types/product";
import { ref, get, set, push, remove ,update } from "firebase/database";
import { database } from "../firebaseConfig";
import { getCurrentUserFromRequest } from "../utils/currentUser";

let productsCache: any = null;
let lastFetch = 0;
let compareTime = 120_000

const priceFields = [
  "payPrice",
  "wholesalePrice",
  "superWholesalePrice",
  "sellPrice",
] as const;

const fullPricingPermissions = new Set([
  "sell-product",
  "driver-sales",
  "purchases",
  "quotations",
  "vehicles",
]);

const fetchReset = () => {
  lastFetch = Date.now() - compareTime;
}

export const resetProductsCache = fetchReset;

const normalizeAlertQuantity = (value: unknown) => {
  if (value === undefined || value === null || value === "") return undefined;

  const numericValue = Number(value);
  return Number.isFinite(numericValue) && numericValue >= 0
    ? numericValue
    : undefined;
};

const normalizePrice = (value: unknown) => {
  if (value === undefined || value === null || value === "") return undefined;

  const numericValue = Number(value);
  return Number.isFinite(numericValue) && numericValue >= 0
    ? numericValue
    : undefined;
};

const withNormalizedPriceFields = (product: Product): Product => {
  const normalizedProduct: Product = { ...product };

  priceFields.forEach((field) => {
    const normalizedPrice = normalizePrice(product[field]);

    if (normalizedPrice === undefined) {
      delete normalizedProduct[field];
    } else {
      normalizedProduct[field] = normalizedPrice;
    }
  });

  return normalizedProduct;
};

const withNormalizedAlertQuantity = (product: Product): Product => {
  const alertQuantity = normalizeAlertQuantity(product.alertQuantity);
  const normalizedProduct: Product = { ...product };

  if (alertQuantity === undefined) {
    delete normalizedProduct.alertQuantity;
  } else {
    normalizedProduct.alertQuantity = alertQuantity;
  }

  return normalizedProduct;
};

const withNormalizedStockFields = (product: Product): Product => ({
  ...withNormalizedPriceFields(withNormalizedAlertQuantity(product)),
  quantity: Number(product.quantity || 0),
  reservedQuantity: Number(product.reservedQuantity || 0),
});

const normalizeWarehouseName = (value: unknown) => String(value || "").trim();

export const resolveProductsWarehouseKey = async (warehouseName: string) => {
  const normalizedWarehouseName = normalizeWarehouseName(warehouseName);

  if (!normalizedWarehouseName) return "";

  const productsSnapshot = await get(ref(database, "products"));

  if (!productsSnapshot.exists()) {
    return normalizedWarehouseName;
  }

  const productsByWarehouse = productsSnapshot.val() as Record<string, unknown>;
  const matchingKey = Object.keys(productsByWarehouse).find(
    (warehouseKey) =>
      normalizeWarehouseName(warehouseKey).toLowerCase() ===
      normalizedWarehouseName.toLowerCase(),
  );

  return matchingKey || normalizedWarehouseName;
};

const normalizeProductRecord = (
  productId: string,
  warehouseName: string,
  product: Partial<Product> | null | undefined,
): Product => {
  const normalizedProduct = product || {};

  return {
    ...normalizedProduct,
    id: normalizedProduct.id || productId,
    warehouse: normalizeWarehouseName(
      normalizedProduct.warehouse || warehouseName,
    ),
    category: normalizedProduct.category || "",
    quantity: Number(normalizedProduct.quantity || 0),
    reservedQuantity: Number(normalizedProduct.reservedQuantity || 0),
  } as Product;
};

const stripRestrictedPriceFields = (product: any) => {
  const sanitizedProduct = { ...product };

  priceFields.forEach((field) => {
    delete sanitizedProduct[field];
  });

  return sanitizedProduct;
};

const shouldHideRestrictedPrices = (req: Request) => {
  const currentUser = getCurrentUserFromRequest(req);
  const pricingMode = String(req.query.pricing || "full");

  if (currentUser?.role === "admin") return false;

  if (pricingMode === "table") return true;

  const permissions = currentUser?.permissions || [];
  const canSeeFullPricing = permissions.some((permission) =>
    fullPricingPermissions.has(permission),
  );

  return !canSeeFullPricing;
};

export const getAll = async (req: Request, res: Response) => {
  try {
    if (productsCache && Date.now() - lastFetch < compareTime) {
      return res.json(
        shouldHideRestrictedPrices(req)
          ? productsCache.map(stripRestrictedPriceFields)
          : productsCache,
      );
    }

    const snapshot = await get(ref(database, "products"));

    const products = snapshot.exists()
      ? Object.entries(snapshot.val()).flatMap(([warehouseName, items]: any) =>
          Object.entries(items || {}).map(([id, product]: any) =>
            normalizeProductRecord(id, warehouseName, product),
          ),
        )
      : [];

    // تحديث الكاش
    productsCache = products;
    lastFetch = Date.now();

    res.json(
      shouldHideRestrictedPrices(req)
        ? products.map(stripRestrictedPriceFields)
        : products,
    );
  } catch (error) {
    console.error("❌ خطأ في جلب المنتجات:", error);
    res.status(500).json({ message: "حدث خطأ أثناء جلب المنتجات" });
  }
};


// ✅ جلب منتج واحد حسب id + المشتريات والمبيعات
export const getProductById = async (req: Request, res: Response) => {
  try {
    const { id } = req.body;
    if (!id) return res.status(400).json({ message: "product id is required" });

    const productsSnapshot = await get(ref(database, "products"));
    if (!productsSnapshot.exists())
      return res.status(404).json({ message: "المنتج غير موجود" });

    const warehouses = productsSnapshot.val();
    let foundProduct: any = null;
    let foundWarehouse: string | null = null;

    for (const warehouse in warehouses) {
      for (const productId in warehouses[warehouse]) {
        const p = warehouses[warehouse][productId];
        if (p.id === id) {
          foundProduct = p;
          foundWarehouse = warehouse;
          break;
        }
      }
      if (foundProduct) break;
    }

    if (!foundProduct)
      return res.status(404).json({ message: "❌ المنتج غير موجود" });

    const transfersSnapshot = await get(ref(database, "warehouseTransfers"));
    const transfersData = transfersSnapshot.exists()
      ? transfersSnapshot.val()
      : {};

    const transfers = Object.values(transfersData)
      .filter(
        (t: any) =>
          t.productId === foundProduct.id ||
          t.productCode === foundProduct.code,
      )
      .map((t: any) => ({
        ...t,
        type: "transfer", // لتمييزها في الواجهة
      }));

    // جلب المشتريات
    const purchasesSnapshot = await get(ref(database, "purchases"));
    const purchasesData = purchasesSnapshot.exists()
      ? purchasesSnapshot.val()
      : {};
    const supplierSnapshot = await get(ref(database, "supplier"));
    const supplierData = supplierSnapshot.exists()
      ? supplierSnapshot.val()
      : {};

    const purchases = Object.values(purchasesData)
      .filter((p: any) => {
        if (Array.isArray(p.products)) {
          return p.products.some(
            (product: any) =>
              product.code === foundProduct.code &&
              product.warehouse === foundProduct.warehouse,
          );
        }

        return (
          p.code === foundProduct.code &&
          p.warehouse === foundProduct.warehouse
        );
      })
      .map((p: any) => {
        const matchedProduct = Array.isArray(p.products)
          ? p.products.find(
              (product: any) =>
                product.code === foundProduct.code &&
                product.warehouse === foundProduct.warehouse,
            )
          : null;

        return {
          ...p,
          name: matchedProduct?.name || p.name,
          code: matchedProduct?.code || p.code,
          warehouse: matchedProduct?.warehouse || p.warehouse,
          quantity: matchedProduct?.quantity || p.quantity,
          payPrice: matchedProduct?.payPrice || p.payPrice,
          wholesalePrice:
            matchedProduct?.wholesalePrice || p.wholesalePrice,
          superWholesalePrice:
            matchedProduct?.superWholesalePrice || p.superWholesalePrice,
          totalPrice:
            matchedProduct?.lineTotal ||
            (matchedProduct
              ? Number(matchedProduct.payPrice || 0) *
                Number(matchedProduct.quantity || 0)
              : p.totalPrice),
          supplierName: supplierData[p.supplierId]?.name || "مورد غير معروف",
        };
      });

    // جلب المبيعات
    const sellsSnapshot = await get(ref(database, "sells"));
    const sellsData = sellsSnapshot.exists() ? sellsSnapshot.val() : {};
    const customerSnapshot = await get(ref(database, "customer"));
    const customerData = customerSnapshot.exists()
      ? customerSnapshot.val()
      : {};

    const sells = Object.values(sellsData)
      .filter((sell: any) =>
        sell.products?.some(
          (prod: any) =>
            prod.code === foundProduct.code &&
            prod.warehouse === foundProduct.warehouse,
        ),
      )
      .map((sell: any) => {
        const matchedProduct = sell.products.find(
          (prod: any) =>
            prod.code === foundProduct.code &&
            prod.warehouse === foundProduct.warehouse,
        );
        return {
          ...sell,
          totalPrice: matchedProduct
            ? matchedProduct.sellPrice * matchedProduct.qty
            : 0,
          quantity: matchedProduct ? matchedProduct.qty : 0,
          customerName: customerData[sell.customerId]?.name || "زبون غير معروف",
        };
      });

    const hideRestrictedPrices = shouldHideRestrictedPrices(req);
    const productResponse = hideRestrictedPrices
      ? stripRestrictedPriceFields(foundProduct)
      : foundProduct;
    const purchasesResponse = hideRestrictedPrices
      ? purchases.map(
          ({
            payPrice,
            wholesalePrice,
            superWholesalePrice,
            sellPrice,
            totalPrice,
            ...purchase
          }: any) => purchase,
        )
      : purchases;
    const sellsResponse = hideRestrictedPrices
      ? sells.map(({ totalPrice, ...sell }: any) => sell)
      : sells;

    res.json({
      product: productResponse,
      purchases: purchasesResponse,
      sells: sellsResponse,
      transfers,
    });
  } catch (error) {
    console.error("❌ خطأ في جلب المنتج:", error);
    res.status(500).json({ message: "حدث خطأ أثناء جلب المنتج" });
  }
};

export const create = async (req: Request, res: Response) => {
  try {
    const newProduct: Product = req.body;

    const warehouseName = normalizeWarehouseName(newProduct.warehouse);

    if (!warehouseName)
      return res.status(400).json({ message: "warehouse is required" });

    const NowDate = new Date().toLocaleString();
    const warehouseKey = await resolveProductsWarehouseKey(warehouseName);

    const warehouseRef = ref(database, `products/${warehouseKey}`);
    const newRef = push(warehouseRef);

    const productData: Product = {
      ...withNormalizedStockFields({ ...newProduct, warehouse: warehouseName }),
      id: newRef.key!,
      updatedDate: NowDate,
    };

    await set(newRef, productData);

    fetchReset();

    res.json({
      message: "تم إنشاء المنتج بنجاح",
      data: productData,
    });
  } catch (error) {
    console.error("❌ خطأ أثناء إنشاء المنتج:", error);
    res.status(500).json({ message: "حدث خطأ أثناء إنشاء المنتج" });
  }
};

// ✅ تحديث كمية المنتج بعد بيع داخليًا
export const updateQuantityOnSell = async (
  productId: string,
  warehouse: string,
  soldQuantity: number,
): Promise<Product | null> => {
  const warehouseKey = await resolveProductsWarehouseKey(warehouse);
  const productRef = ref(database, `products/${warehouseKey}/${productId}`);
  const snapshot = await get(productRef);
  if (!snapshot.exists()) return null;

  const existingProduct: Product = snapshot.val();
  const currentQuantity = Number(existingProduct.quantity || 0);
  const reservedQuantity = Number(existingProduct.reservedQuantity || 0);
  const availableQuantity = currentQuantity - reservedQuantity;

  if (availableQuantity < soldQuantity) {
    throw new Error(
      `Insufficient available quantity. Available: ${availableQuantity}, requested: ${soldQuantity}`,
    );
  }

  fetchReset();

  const newQuantity = currentQuantity - soldQuantity;
  existingProduct.quantity = newQuantity;
  existingProduct.updatedDate = new Date().toLocaleString();
  await set(productRef, existingProduct);

  return existingProduct;
};

export const assertProductAvailableForSellInternal = async (
  productId: string,
  warehouse: string,
  soldQuantity: number,
) => {
  const warehouseKey = await resolveProductsWarehouseKey(warehouse);
  const productRef = ref(database, `products/${warehouseKey}/${productId}`);
  const snapshot = await get(productRef);

  if (!snapshot.exists()) {
    throw new Error("Product not found");
  }

  const product: Product = snapshot.val();
  const availableQuantity =
    Number(product.quantity || 0) - Number(product.reservedQuantity || 0);

  if (availableQuantity < Number(soldQuantity || 0)) {
    throw new Error(
      `Insufficient available quantity. Available: ${availableQuantity}, requested: ${soldQuantity}`,
    );
  }

  return product;
};

export const reserveProductQuantityInternal = async (
  productId: string,
  warehouse: string,
  quantityToReserve: number,
): Promise<Product> => {
  const reserveQty = Number(quantityToReserve || 0);

  if (!productId || !warehouse || reserveQty <= 0) {
    throw new Error("Invalid reservation quantity");
  }

  const warehouseKey = await resolveProductsWarehouseKey(warehouse);
  const productRef = ref(database, `products/${warehouseKey}/${productId}`);
  const snapshot = await get(productRef);

  if (!snapshot.exists()) {
    throw new Error("Product not found");
  }

  const product: Product = snapshot.val();
  const currentQuantity = Number(product.quantity || 0);
  const currentReserved = Number(product.reservedQuantity || 0);
  const availableQuantity = currentQuantity - currentReserved;

  if (availableQuantity < reserveQty) {
    throw new Error(
      `Insufficient available quantity. Available: ${availableQuantity}, requested: ${reserveQty}`,
    );
  }

  const updatedProduct: Product = {
    ...product,
    reservedQuantity: currentReserved + reserveQty,
    updatedDate: new Date().toLocaleString(),
  };

  await set(productRef, updatedProduct);
  fetchReset();

  return updatedProduct;
};

export const releaseReservedQuantityInternal = async (
  productId: string,
  warehouse: string,
  quantityToRelease: number,
): Promise<Product> => {
  const releaseQty = Number(quantityToRelease || 0);

  if (!productId || !warehouse || releaseQty <= 0) {
    throw new Error("Invalid reserved quantity release");
  }

  const warehouseKey = await resolveProductsWarehouseKey(warehouse);
  const productRef = ref(database, `products/${warehouseKey}/${productId}`);
  const snapshot = await get(productRef);

  if (!snapshot.exists()) {
    throw new Error("Product not found");
  }

  const product: Product = snapshot.val();
  const currentReserved = Number(product.reservedQuantity || 0);

  if (releaseQty > currentReserved) {
    throw new Error(
      `Reserved quantity is lower than requested release. Reserved: ${currentReserved}, release: ${releaseQty}`,
    );
  }

  const updatedProduct: Product = {
    ...product,
    reservedQuantity: Math.max(currentReserved - releaseQty, 0),
    updatedDate: new Date().toLocaleString(),
  };

  await set(productRef, updatedProduct);
  fetchReset();

  return updatedProduct;
};

export const settleReservedQuantityOnSellInternal = async (
  productId: string,
  warehouse: string,
  soldQuantity: number,
  reservedQuantityToRelease: number,
): Promise<Product> => {
  const soldQty = Number(soldQuantity || 0);
  const releaseQty = Number(reservedQuantityToRelease || 0);

  if (!productId || !warehouse || soldQty < 0 || releaseQty <= 0) {
    throw new Error("Invalid reserved stock settlement");
  }

  if (soldQty > releaseQty) {
    throw new Error("Used quantity cannot exceed reserved quantity");
  }

  const warehouseKey = await resolveProductsWarehouseKey(warehouse);
  const productRef = ref(database, `products/${warehouseKey}/${productId}`);
  const snapshot = await get(productRef);

  if (!snapshot.exists()) {
    throw new Error("Product not found");
  }

  const product: Product = snapshot.val();
  const currentQuantity = Number(product.quantity || 0);
  const currentReserved = Number(product.reservedQuantity || 0);

  if (releaseQty > currentReserved) {
    throw new Error(
      `Reserved quantity is lower than requested release. Reserved: ${currentReserved}, release: ${releaseQty}`,
    );
  }

  if (soldQty > currentQuantity) {
    throw new Error(
      `Insufficient quantity. Quantity: ${currentQuantity}, requested: ${soldQty}`,
    );
  }

  const updatedProduct: Product = {
    ...product,
    quantity: currentQuantity - soldQty,
    reservedQuantity: Math.max(currentReserved - releaseQty, 0),
    updatedDate: new Date().toLocaleString(),
  };

  await set(productRef, updatedProduct);
  fetchReset();

  return updatedProduct;
};

export const updateProduct = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const updatedFields = req.body;

    const snapshot = await get(ref(database, "products"));
    if (!snapshot.exists())
      return res.status(404).json({ message: "المنتج غير موجود" });

    const warehouses = snapshot.val();

    fetchReset();

    for (const warehouse in warehouses) {
      for (const productId in warehouses[warehouse]) {
        if (productId === id) {
          const newData = {
            ...warehouses[warehouse][productId],
            ...updatedFields,
            quantity:
              updatedFields.quantity === undefined
                ? Number(warehouses[warehouse][productId].quantity || 0)
                : Number(updatedFields.quantity || 0),
            reservedQuantity:
              updatedFields.reservedQuantity === undefined
                ? Number(
                    warehouses[warehouse][productId].reservedQuantity || 0,
                  )
                : Number(updatedFields.reservedQuantity || 0),
            updatedDate: new Date().toLocaleString(),
          };

          if ("alertQuantity" in updatedFields) {
            const alertQuantity = normalizeAlertQuantity(updatedFields.alertQuantity);

            if (alertQuantity === undefined) {
              delete newData.alertQuantity;
            } else {
              newData.alertQuantity = alertQuantity;
            }
          }

          await set(
            ref(database, `products/${warehouse}/${productId}`),
            newData,
          );

          return res.json({ message: "تم تحديث المنتج", data: newData });
        }
      }
    }

    res.status(404).json({ message: "المنتج غير موجود" });
  } catch (error) {
    console.error("❌ خطأ أثناء تحديث المنتج:", error);
    res.status(500).json({ message: "حدث خطأ أثناء تحديث المنتج" });
  }
};

export const deleteProduct = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    const snapshot = await get(ref(database, "products"));
    if (!snapshot.exists())
      return res.status(404).json({ message: "المنتج غير موجود" });

    const warehouses = snapshot.val();

    for (const warehouse in warehouses) {
      for (const productId in warehouses[warehouse]) {
        if (productId === id) {
          await remove(ref(database, `products/${warehouse}/${productId}`));
          fetchReset();
          return res.json({ message: "تم حذف المنتج" });
        }
      }
    }

    fetchReset();

    res.status(404).json({ message: "المنتج غير موجود" });
  } catch (error) {
    console.error("❌ خطأ أثناء حذف المنتج:", error);
    res.status(500).json({ message: "حدث خطأ أثناء حذف المنتج" });
  }
};

export const createOrUpdateProductInternal = async (
  newProduct: Product,
): Promise<Product> => {
  const NowDate = new Date().toLocaleString();
  const warehouseName = normalizeWarehouseName(newProduct.warehouse);

  if (!warehouseName) {
    throw new Error("warehouse is required");
  }

  const warehouseKey = await resolveProductsWarehouseKey(warehouseName);
  const warehousePath = `products/${warehouseKey}`;
  const warehouseRef = ref(database, warehousePath);

  // 1) قراءة كل المنتجات داخل نفس المستودع
  const snapshot = await get(warehouseRef);

  if (snapshot.exists()) {
    const products = snapshot.val();

    // 2) البحث عن منتج بنفس code
    for (const productId in products) {
      const existingProduct: Product = products[productId];

      if (existingProduct.code === newProduct.code) {
        const alertQuantity = normalizeAlertQuantity(newProduct.alertQuantity);
        // تحديث المنتج
        const updatedProduct: Product = {
          ...existingProduct,
          ...newProduct,
          warehouse: warehouseName,
          quantity:
            Number(existingProduct.quantity || 0) +
            Number(newProduct.quantity || 0),
          reservedQuantity: Number(existingProduct.reservedQuantity || 0),
          updatedDate: NowDate,
          id: productId, // مهم جداً: المفتاح من الـ DB
        };

        updatedProduct.alertQuantity =
          alertQuantity === undefined
            ? existingProduct.alertQuantity
            : alertQuantity;

        // حفظ التحديث
        await set(
          ref(database, `${warehousePath}/${productId}`),
          updatedProduct,
        );
        fetchReset();
        return updatedProduct;
      }
    }
  }

  // 3) إذا لم يوجد منتج بنفس code → نقوم بالإنشاء
  const newRef = push(warehouseRef);

  const productToAdd: Product = {
    ...withNormalizedStockFields({ ...newProduct, warehouse: warehouseName }),
    updatedDate: NowDate,
    id: newRef.key!, // id هو مفتاح push في Firebase
  };

  await set(newRef, productToAdd);

  fetchReset();

  return productToAdd;
};

// ✅ جلب منتج واحد حسب id + المشتريات والمبيعات
export const getProductByIdInternal = async (id: string) => {
  try {
    if (!id) return { message: "product id is required" };

    const productsSnapshot = await get(ref(database, "products"));
    if (!productsSnapshot.exists()) return { message: "المنتج غير موجود" };

    const warehouses = productsSnapshot.val();
    let foundProduct: any = null;
    let foundWarehouse: string | null = null;

    for (const warehouse in warehouses) {
      for (const productId in warehouses[warehouse]) {
        const p = warehouses[warehouse][productId];
        if (p.id === id) {
          foundProduct = p;
          foundWarehouse = warehouse;
          break;
        }
      }
      if (foundProduct) break;
    }

    if (!foundProduct) return { message: "❌ المنتج غير موجود" };

    return { product: foundProduct };
  } catch (error) {
    console.error("❌ خطأ في جلب المنتج:", error);
    return { message: "حدث خطأ أثناء جلب المنتج" };
  }
};

export const getByWarehouse = async (req: Request, res: Response) => {
  try {
    const { warehouse } = req.body;
    const warehouseKey = await resolveProductsWarehouseKey(String(warehouse || ""));
    console.log(warehouse)

    const productsSnapshot = await get(ref(database, `products/${warehouseKey}`));

    if (!productsSnapshot.exists()) {
      return res.json({ products: [] });
    }

    const data = productsSnapshot.val();
    const products = Object.entries(data).map(([id, product]: any) =>
      normalizeProductRecord(id, warehouseKey, product),
    );

    res.json({ products });
  } catch (error) {
    console.error("❌ خطأ في جلب المنتجات:", error);
    res
      .status(500)
      .json({ products: [], message: "حدث خطأ أثناء جلب المنتجات" });
  }
};


export const bulkUpdatePrices = async (req: Request, res: Response) => {
  try {
    const {
      productIds,
      percentageIncrease,
      priceType,
    }: {
      productIds: string[];
      percentageIncrease: number;
      priceType:
        | "sellPrice"
        | "payPrice"
        | "wholesalePrice"
        | "superWholesalePrice";
    } = req.body;

    if (!productIds?.length) {
      return res.status(400).json({
        message: "لم يتم تحديد المنتجات",
      });
    }

    if (percentageIncrease <= 0) {
      return res.status(400).json({
        message: "نسبة الزيادة غير صحيحة",
      });
    }

    const snapshot = await get(ref(database, "products"));

    if (!snapshot.exists()) {
      return res.status(404).json({
        message: "المنتجات غير موجودة",
      });
    }

    const productsData = snapshot.val();

    const updates: any = {};

    for (const warehouse in productsData) {
      const warehouseProducts = productsData[warehouse];

      for (const productId in warehouseProducts) {
        const product = warehouseProducts[productId];

        if (!productIds.includes(product.id)) continue;

        const currentPrice = Number(product[priceType] || 0);

        const newPrice =
          currentPrice +
          currentPrice * (percentageIncrease / 100);

        updates[`products/${warehouse}/${productId}/${priceType}`] =
          Number(newPrice.toFixed(2));

        updates[`products/${warehouse}/${productId}/updatedDate`] =
          new Date().toLocaleString();
      }
    }

    await update(ref(database), updates);

    fetchReset();

    return res.status(200).json({
      message: "تم تحديث الأسعار بنجاح",
    });
  } catch (error) {
    console.error("❌ خطأ في تحديث الأسعار:", error);

    return res.status(500).json({
      message: "حدث خطأ أثناء تحديث الأسعار",
    });
  }
};

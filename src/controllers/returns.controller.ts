import { Request, Response } from "express";
import { getDatabase, ref, get, set, update } from "firebase/database";
import { v4 as uuidv4 } from "uuid";
import { resolveProductsWarehouseKey } from "./products.controller";

export interface ReturnData {
  productCode: string;
  productId: string;
  warehouse: string;
  qty: number;
  returnValue?: number;
  type: "sale-return" | "purchase-return";
  referenceId?: string | null;
  reason?: string;
}

export interface ReturnRecord extends ReturnData {
  id: string;
  createdDate: string;
}

// ✅ helper لتطبيق التعديل على الكمية
function applyReturnToProduct(
  product: any,
  type: "sale-return" | "purchase-return",
  qty: number
) {
  if (type === "sale-return") {
    product.quantity += qty;
  } else if (type === "purchase-return") {
    if (product.quantity < qty) {
      throw new Error("❌ الكمية غير كافية في المخزون للإرجاع");
    }
    product.quantity -= qty;
  } else {
    throw new Error("❌ نوع الإرجاع غير صحيح (sale-return | purchase-return)");
  }
}

// ✅ get all returns
export const getAllReturns = async (_req: Request, res: Response) => {
  try {
    const db = getDatabase();
    const returnsRef = ref(db, "returns");
    const snapshot = await get(returnsRef);

    const returns = snapshot.exists() ? Object.values(snapshot.val()) : [];
    res.json(returns);
  } catch (error: any) {
    res.status(500).json({
      message: "❌ خطأ في جلب بيانات الإرجاعات",
      error: error.message,
    });
  }
};

// ✅ get return by id
export const getReturnById = async (req: Request, res: Response) => {
  const { id } = req.params;
  if (!id) return res.status(400).json({ message: "❌ return id is required" });

  try {
    const db = getDatabase();
    const returnRef = ref(db, `returns/${id}`);
    const snapshot = await get(returnRef);

    if (!snapshot.exists()) {
      return res.status(404).json({ message: "❌ عملية الإرجاع غير موجودة" });
    }

    res.json(snapshot.val());
  } catch (error: any) {
    res
      .status(500)
      .json({ message: "❌ خطأ في جلب عملية الإرجاع", error: error.message });
  }
};

// ✅ create return (customer return or purchase return)
export const createReturn = async (req: Request, res: Response) => {
  const { productCode, warehouse, qty, type, referenceId, reason } = req.body;

  if (!productCode || !warehouse || !qty || !type) {
    return res
      .status(400)
      .json({ message: "❌ productCode, warehouse, qty, type مطلوبة" });
  }

  try {
    const db = getDatabase();
    const warehouseKey = await resolveProductsWarehouseKey(warehouse);
    const productRef = ref(db, `products/${warehouseKey}/${productCode}`);
    const productSnap = await get(productRef);

    if (!productSnap.exists()) {
      return res
        .status(404)
        .json({ message: "❌ المنتج غير موجود في المستودع" });
    }

    const product = productSnap.val();

    applyReturnToProduct(product, type, qty);
    product.updatedDate = new Date().toLocaleString();

    // ✅ تحديث المنتج بعد التعديل
    await update(productRef, product);

    // ✅ إنشاء سجل الإرجاع
    const returnId = uuidv4();
    const now = new Date().toLocaleString();

    const returnRecord: ReturnRecord = {
      id: returnId,
      productCode,
      productId: product.productID,
      warehouse,
      qty,
      type,
      referenceId: referenceId || null,
      reason: reason || "",
      createdDate: now,
    };

    await set(ref(db, `returns/${returnId}`), returnRecord);

    res.json({
      message: "✅ تم تسجيل عملية الإرجاع",
      data: { returnRecord, product },
    });
  } catch (error: any) {
    res
      .status(500)
      .json({ message: "❌ خطأ أثناء إنشاء الإرجاع", error: error.message });
  }
};

// ✅ create return internal (للاستخدام داخل النظام)
export const createReturnInternal = async (newReturn: ReturnData) => {
  try {
    const db = getDatabase();
    const warehouseKey = await resolveProductsWarehouseKey(newReturn.warehouse);
    const productRef = ref(
      db,
      `products/${warehouseKey}/${newReturn.productId}`
    );
    const productSnap = await get(productRef);

    if (!productSnap.exists()) {
      throw new Error("❌ المنتج غير موجود في المستودع");
    }

    const product = productSnap.val();
    const now = new Date().toLocaleString();

    applyReturnToProduct(product, newReturn.type, newReturn.qty);
    product.updatedDate = now;

    await update(productRef, product);

    const id = uuidv4();
    const returnRecord: ReturnRecord = {
      ...newReturn,
      id,
      createdDate: now,
    };

    await set(ref(db, `returns/${id}`), returnRecord);

    return { returnRecord, product };
  } catch (error: any) {
    throw new Error(
      `❌ خطأ أثناء تنفيذ createReturnInternal: ${error.message}`
    );
  }
};

import { Request, Response } from "express";
import { v4 as uuidv4 } from "uuid";
import { purchase } from "../types/purchase";
import { ref, get, set, remove } from "firebase/database";
import { createOrUpdateProductInternal } from "./products.controller";
import { database } from "../firebaseConfig";
// ✅ الحصول على جميع عمليات الشراء
export const getAllPurchases = async (_req: Request, res: Response) => {
  try {
    const dbRef = ref(database, "purchases");
    const snapshot = await get(dbRef);
    const purchases = snapshot.exists() ? Object.values(snapshot.val()) : [];
    res.json(purchases);
  } catch (error: any) {
    console.error("Error fetching purchases:", error);
    res.status(500).json({ error: error.message });
  }
};
// ✅ إنشاء عملية شراء جديدة (API)
export const createPurchase = async (req: Request, res: Response) => {
  try {
    const {
      supplierId,
      products,
      totalPrice,
      paymentStatus,
      remainingDebt,
      code,
      warehouse,
      quantity,
      payPrice,
      name,
      currency,
      amount: amount_base,
      inventoryAccountId,
      payableAccountId,
      paymentAccountId,
    } = req.body;
    const id = uuidv4();
    const NowDate = new Date().toLocaleString();
    // التحقق من الحقول المطلوبة
    if (!supplierId) {
      return res.status(400).json({ error: "معرف المورد مطلوب" });
    }
    if (!inventoryAccountId) {
      return res.status(400).json({ error: "معرف حساب المخزون مطلوب" });
    }
    if (!payableAccountId) {
      return res.status(400).json({ error: "معرف حساب الدائن مطلوب" });
    }
    const purchaseData: purchase = {
      id,
      supplierId,
      code,
      warehouse,
      quantity,
      payPrice,
      totalPrice,
      paymentStatus,
      remainingDebt,
      date: NowDate,
      name: name.trim(),
      currency,
      amount: amount_base,
      inventoryAccountId,
      payableAccountId,
      paymentAccountId,
    };
    // ✅ حفظ عملية الشراء في قاعدة البيانات
    await set(ref(database, `purchases/${id}`), purchaseData);
    // ✅ تحديث المخزون لكل منتج تمت إضافته
    if (Array.isArray(products)) {
      for (const p of products) {
        await createOrUpdateProductInternal(p);
      }
    }
    res.json({ message: "✅ تم تسجيل عملية الشراء", data: purchaseData });
  } catch (error: any) {
    console.error("Error creating purchase:", error);
    res.status(500).json({ error: error.message });
  }
};
// ✅ إنشاء عملية شراء داخلية (بدون استجابة HTTP)
export const createPurchaseInternal = async (
  newPurchase: purchase,
): Promise<purchase> => {
  const id = uuidv4();
  const NowDate = new Date().toLocaleString();
  const purchaseData: purchase = {
    ...newPurchase,
    id,
    date: NowDate,
  };
  await set(ref(database, `purchases/${id}`), purchaseData);
  return purchaseData;
};
// ✅ حذف عملية شراء
export const deletePurchase = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const dbRef = ref(database, `purchases/${id}`);
    const snapshot = await get(dbRef);
    if (!snapshot.exists()) {
      return res.status(404).json({ message: "❌ عملية الشراء غير موجودة" });
    }
    await remove(dbRef);
    res.json({ message: "✅ تم حذف عملية الشراء" });
  } catch (error: any) {
    console.error("Error deleting purchase:", error);
    res.status(500).json({ error: error.message });
  }
};
// ✅ حذف عملية شراء داخليًا
export const deletePurchaseInternal = async (id: string): Promise<boolean> => {
  const dbRef = ref(database, `purchases/${id}`);
  const snapshot = await get(dbRef);
  if (!snapshot.exists()) return false;
  await remove(dbRef);
  return true;
};
// ✅ جلب عملية شراء واحدة داخليًا
export const getPurchaseByIdInternal = async (id: string): Promise<purchase | null> => {
  const dbRef = ref(database, `purchases/${id}`);
  const snapshot = await get(dbRef);
  return snapshot.exists() ? snapshot.val() : null;
};
// ✅ جلب جميع عمليات الشراء داخليًا
export const getAllPurchasesInternal = async (): Promise<purchase[]> => {
  const dbRef = ref(database, "purchases");
  const snapshot = await get(dbRef);
  return snapshot.exists() ? Object.values(snapshot.val()) : [];
};
// ✅ تعديل عملية شراء (API خارجي)
export const updatePurchase = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const updatedData: Partial<purchase> = req.body;
    const dbRef = ref(database, `purchases/${id}`);
    const snapshot = await get(dbRef);
    if (!snapshot.exists()) {
      return res.status(404).json({ message: "❌ عملية الشراء غير موجودة" });
    }
    const existingPurchase: purchase = snapshot.val();
    // تحديث المخزون إذا تم تمرير منتجات جديدة
    if ("products" in updatedData && Array.isArray((updatedData as any).products)) {
      for (const p of (updatedData as any).products) {
        await createOrUpdateProductInternal(p);
      }
    }
    const newPurchaseData: purchase = {
      ...existingPurchase,
      ...updatedData,
      date: existingPurchase.date,
    };
    await set(dbRef, newPurchaseData);
    res.json({ message: "✅ تم تعديل عملية الشراء", data: newPurchaseData });
  } catch (error: any) {
    console.error("Error updating purchase:", error);
    res.status(500).json({ error: error.message });
  }
};
// ✅ تعديل عملية شراء داخليًا (Internal)
export const updatePurchaseInternal = async (
  id: string,
  updatedData: Partial<purchase>,
): Promise<purchase | null> => {
  const dbRef = ref(database, `purchases/${id}`);
  const snapshot = await get(dbRef);
  if (!snapshot.exists()) return null;
  const existingPurchase: purchase = snapshot.val();
  const newPurchaseData: purchase = {
    ...existingPurchase,
    ...updatedData,
    date: existingPurchase.date,
  };
  await set(dbRef, newPurchaseData);
  return newPurchaseData;
};

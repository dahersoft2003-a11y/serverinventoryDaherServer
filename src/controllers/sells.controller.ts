import { Request, Response } from "express";
import { ref, get, set, update, remove, push } from "firebase/database";
import { v4 as uuidv4 } from "uuid";
import { sell } from "../types/sell";
import { Payment } from "../types/payment";
import { database } from "../firebaseConfig";
import {
  calculateSaleReturn,
  CustomerReturnType,
} from "../utils/saleReturn";
import { resolveProductsWarehouseKey } from "./products.controller";

// 🧩 جلب جميع فواتير البيع
export const getAllSells = async (_req: Request, res: Response) => {
  try {
    const snapshot = await get(ref(database, "sells"));
    const data = snapshot.exists() ? snapshot.val() : {};
    const sells = Object.values(data);
    res.json(sells);
  } catch (error) {
    console.error("❌ خطأ في جلب فواتير البيع:", error);
    res.status(500).json({ message: "حدث خطأ أثناء جلب فواتير البيع" });
  }
};

// 🧾 إنشاء فاتورة بيع جديدة
export const createSell = async (req: Request, res: Response) => {
  try {
    const id = uuidv4();
    const NowDate = new Date().toLocaleString();

    const newSell: sell = {
      ...req.body,
      id,
      date: NowDate,
    };

    await set(ref(database, `sells/${id}`), newSell);

    res.json({ message: "✅ تم تسجيل فاتورة البيع", data: newSell });
  } catch (error) {
    console.error("❌ خطأ أثناء إنشاء فاتورة البيع:", error);
    res.status(500).json({ message: "حدث خطأ أثناء إنشاء فاتورة البيع" });
  }
};

// 🗑️ حذف فاتورة بيع
export const deleteSell = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const sellRef = ref(database, `sells/${id}`);
    const snapshot = await get(sellRef);

    if (!snapshot.exists()) {
      return res.status(404).json({ message: "❌ فاتورة البيع غير موجودة" });
    }

    await remove(sellRef);
    res.json({ message: "✅ تم حذف فاتورة البيع" });
  } catch (error) {
    console.error("❌ خطأ أثناء حذف فاتورة البيع:", error);
    res.status(500).json({ message: "حدث خطأ أثناء حذف فاتورة البيع" });
  }
};

// ✅ internal helper (للاستخدام داخل functions/transactions.ts)
export const createSellInternal = async (newSell: sell): Promise<sell> => {
  try {
    const id = uuidv4();
    const NowDate = new Date().toLocaleString();

    const sellData: sell = {
      ...newSell,
      id,
      date: NowDate,
    };

    await set(ref(database, `sells/${id}`), sellData);
    return sellData;
  } catch (error) {
    console.error("❌ خطأ أثناء إنشاء فاتورة بيع داخلية:", error);
    throw error;
  }
};

// 🧾 جلب فاتورة بيع حسب ID
export const getSellById = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const snapshot = await get(ref(database, `sells/${id}`));

    if (!snapshot.exists()) {
      return res.status(404).json({ message: "❌ فاتورة البيع غير موجودة" });
    }

    const sellData = snapshot.val();

    // جلب بيانات الزبون
    const customerSnap = await get(
      ref(database, `customer/${sellData.customerId}`)
    );
    const customerData = customerSnap.exists() ? customerSnap.val() : {};

    res.json({ ...sellData, customerName: customerData.name || "" });
  } catch (error) {
    console.error("❌ خطأ أثناء جلب الفاتورة:", error);
    res.status(500).json({ message: "حدث خطأ أثناء جلب الفاتورة" });
  }
};

// 🧩 تحديث فاتورة بيع
export const updateSellById = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const updateData = req.body?.data;

    // ✅ Validation أساسي
    if (!id) {
      return res.status(400).json({ message: "معرف الفاتورة غير صالح" });
    }

    if (!updateData || !Array.isArray(updateData.products)) {
      return res.status(400).json({ message: "بيانات التحديث غير صالحة" });
    }

    const sellRef = ref(database, `sells/${id}`);
    const snapshot = await get(sellRef);

    if (!snapshot.exists()) {
      return res.status(404).json({ message: "❌ فاتورة البيع غير موجودة" });
    }

    const sellData = snapshot.val();
    const oldTotalPrice = Number(sellData.totalPrice || 0);

    // =========================
    // 🧾 تعديل المخزون
    // =========================

    // 1️⃣ استرجاع الكميات القديمة
    for (const oldP of sellData.products || []) {
      if (!oldP?.warehouse || !oldP?.code || !oldP?.qty) continue;

      const oldWarehouseKey = await resolveProductsWarehouseKey(oldP.warehouse);
      const qtyPath = `products/${oldWarehouseKey}/${oldP.id}/quantity`;
      const qtyRef = ref(database, qtyPath);
      const qtySnap = await get(qtyRef);

      if (!qtySnap.exists()) {
        return res.status(400).json({
          message: `المنتج غير موجود في المخزون: ${oldP.code}`,
        });
      }

      const currentQty = Number(qtySnap.val());
      const restoredQty = currentQty + Number(oldP.qty);

      await set(qtyRef, restoredQty);
    }

    // 2️⃣ خصم الكميات الجديدة
    for (const newP of updateData.products) {
      if (!newP?.warehouse || !newP?.code || !newP?.qty) {
        return res.status(400).json({
          message: "بيانات منتج غير صالحة",
        });
      }

      const newWarehouseKey = await resolveProductsWarehouseKey(newP.warehouse);
      const qtyPath = `products/${newWarehouseKey}/${newP.id}/quantity`;
      const qtyRef = ref(database, qtyPath);
      const qtySnap = await get(qtyRef);
        
      if (!qtySnap.exists()) {
        return res.status(400).json({
          message: `المنتج غير موجود في المخزون: ${newP.code}`,
        });
      }

      const currentQty = Number(qtySnap.val());
      const reservedSnap = await get(
        ref(database, `products/${newWarehouseKey}/${newP.id}/reservedQuantity`)
      );
      const reservedQty = Number(reservedSnap.exists() ? reservedSnap.val() : 0);
      const availableQty = currentQty - reservedQty;
      const newQty = currentQty - Number(newP.qty);

      if (Number(newP.qty) > availableQty) {
        return res.status(400).json({
          message: `❌ الكمية غير كافية للمنتج ${newP.code}`,
        });
      }

      await set(qtyRef, newQty);
    }

    // =========================
    // 🔢 تحديث الفاتورة
    // =========================

    sellData.products = updateData.products;

    const newTotalPrice = sellData.products.reduce(
      (sum: number, p: any) =>
        sum + Number(p.sellPrice || 0) * Number(p.qty || 0),
      0
    );

    sellData.totalPrice = newTotalPrice;
    sellData.updatedAt = new Date().toISOString();

    // =========================
    // 💰 تحديث رصيد العميل
    // =========================

    const customerRef = ref(database, `customer/${sellData.customerId}`);
    const customerSnap = await get(customerRef);

    if (!customerSnap.exists()) {
      return res.status(400).json({
        message: "العميل غير موجود",
      });
    }

    const customer = customerSnap.val();
    const currentBalance = Number(customer.balance || 0);
    console.log(currentBalance, oldTotalPrice, newTotalPrice);
    const newBalance = currentBalance + (oldTotalPrice - newTotalPrice);

    await update(customerRef, {
      balance: newBalance,
    });

    // =========================
    // 🧾 تسجيل حركة مالية
    // =========================

    const paymentId = uuidv4();

    const payment: Payment = {
      id: paymentId,
      type: "sell_edit",
      customerId: sellData.customerId,
      sellId: id,
      currency: sellData.currency || "",
      exchangeRate: 1,
      amount_base: newTotalPrice,
      amount: newTotalPrice,
      note: `تعديل على فاتورة بيع - ${id}`,
      date: new Date().toISOString(),
    };

    await set(ref(database, `payment/${paymentId}`), payment);

    // =========================
    // 💾 حفظ الفاتورة
    // =========================

    await update(sellRef, sellData);

    return res.json({
      message: "✅ تم تحديث الفاتورة بنجاح",
      sell: sellData,
    });
  } catch (error: any) {
    console.error("❌ خطأ أثناء تحديث فاتورة البيع:", error);

    return res.status(500).json({
      message: "حدث خطأ أثناء تحديث الفاتورة",
      error: error?.message,
    });
  }
};

// 🗑️ حذف فاتورة بيع بالكامل مع إرجاع المخزون وتعديل الرصيد
export const deleteSellById = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const sellRef = ref(database, `sells/${id}`);
    const snapshot = await get(sellRef);

    if (!snapshot.exists()) {
      return res.status(404).json({ message: "❌ فاتورة البيع غير موجودة" });
    }

    const sellData = snapshot.val();

    // 🧩 استرجاع الكميات في المخزون
    const productsSnap = await get(ref(database, "products"));
    const products = productsSnap.exists() ? productsSnap.val() : {};

    for (const p of sellData.products || []) {
      const warehouse = p.warehouse;
      const quantity = Number(p.qty || p.quantity || 0);

      if (!warehouse || !quantity || !products[warehouse]) continue;

      let productId = p.id || p.productId;

      if (!products[warehouse][productId] && p.code) {
        productId = Object.keys(products[warehouse]).find(
          (key) => products[warehouse][key]?.code === p.code
        );
      }

      if (productId && products[warehouse][productId]) {
        products[warehouse][productId].quantity =
          Number(products[warehouse][productId].quantity || 0) + quantity;
        products[warehouse][productId].updatedDate = new Date().toLocaleString();
      }
    }

    await update(ref(database, "products"), products);

    // 💰 تعديل رصيد الزبون
    const customerRef = ref(database, `customer/${sellData.customerId}`);
    const customerSnap = await get(customerRef);
    if (customerSnap.exists()) {
      const customer = customerSnap.val();
      customer.balance =
        Number(customer.balance || 0) + Number(sellData.remainingDebt || 0);
      await update(customerRef, customer);
    }

    // 🧾 تسجيل العملية كدفعة حذف
    const paymentId = uuidv4();
    const payment: Payment = {
      type: "sell_delete",
      customerId: sellData.customerId,
      sellId: sellData.id,
      currency: sellData.currency || "",
      exchangeRate: 1,
      amount_base: 0,
      amount: 0,
      note: `حذف فاتورة بيع - ${sellData.id}`,
      id: paymentId,
      date: new Date().toLocaleString(),
    };
    await set(ref(database, `payment/${paymentId}`), payment);

    // حذف الفاتورة
    await remove(sellRef);

    res.json({
      message: `✅ تم حذف الفاتورة ${id} وإرجاع المخزون وتحديث رصيد الزبون.`,
    });
  } catch (error) {
    console.error("❌ خطأ أثناء حذف فاتورة البيع:", error);
    res.status(500).json({ message: "حدث خطأ أثناء حذف فاتورة البيع" });
  }
};

export const returnProductsFromSellInternal = async (
  sellId: string,
  returnedProducts: {
    productId?: string;
    code: string;
    warehouse: string;
    qty: number;
  }[],
  options: {
    returnType?: CustomerReturnType;
    partValueUSD?: number;
  } = {}
): Promise<{
  updatedSell: sell;
  totalRefund: number;
  calculation: ReturnType<typeof calculateSaleReturn>;
} | null> => {
  const sellRef = ref(database, `sells/${sellId}`);
  const sellSnap = await get(sellRef);
  if (!sellSnap.exists()) return null;

  const sellData: sell = sellSnap.val();
  const calculation = calculateSaleReturn({
    sellData,
    returnedProducts,
    returnType: options.returnType || "debt",
    partValueUSD: options.partValueUSD,
  });

  await update(sellRef, calculation.updatedSell);

  return {
    updatedSell: calculation.updatedSell,
    totalRefund: calculation.returnValueUSD,
    calculation,
  };
};


// جلب المبيعات حسب المستودع والتاريخ
export const getReturnableProductFromSellInternal = async (
  sellId: string,
  code: string,
  warehouse: string
): Promise<{ qty: number; sellPrice: number } | null> => {
  const sellRef = ref(database, `sells/${sellId}`);
  const sellSnap = await get(sellRef);
  if (!sellSnap.exists()) return null;

  const sellData: sell = sellSnap.val();
  const product = sellData.products.find(
    (p) => p.code === code && p.warehouse === warehouse
  );

  if (!product) return null;

  return {
    qty: Number(product.qty || 0),
    sellPrice: Number(product.sellPrice || 0),
  };
};

export const getSalesByWarehouseAndDate = async (
  req: Request,
  res: Response,
) => {
  try {
    let { warehouse, date } = req.body;
    if (!warehouse) {
      return res.status(400).json({ message: "warehouse مطلوب" });
    }
    if (!date) {
      date = new Date().toLocaleDateString("en-CA", {
        timeZone: "Asia/Damascus",
      });
    }

    const snapshot = await get(ref(database, "sells"));

    if (!snapshot.exists()) {
      return res.json({ sales: [] });
    }

    const salesArray = Object.values(snapshot.val());

    const filteredSales = salesArray.filter((sale: any) => {
      if (!sale.date || !sale.products) return false;

      const saleDate = new Date(sale.date).toLocaleDateString("en-CA", {
        timeZone: "Asia/Damascus",
      });

      const sameDate = saleDate === date;

      const hasWarehouseProduct = sale.products.some(
        (product: any) => product.warehouse === warehouse,
      );

      return sameDate && hasWarehouseProduct;
    });

    res.json({ sales: filteredSales });
  } catch (error) {
    console.error("❌ خطأ في جلب المبيعات:", error);
    res.status(500).json({ sales: [], message: "خطأ في السيرفر" });
  }
};

export const addAfterSellDiscountInternal = async ({sellId, discount}: {sellId: string, discount: number}) => {
  try {
    if (!sellId || discount == null) {
      return { message: "sellId و discount مطلوبان" };
    }
    
    const sellRef = ref(database, `sells/${sellId}`);
    const sellSnap = await get(sellRef);
    if (!sellSnap.exists()) {
      return { message: "فاتورة البيع غير موجودة" };
    }

    const sellData: sell = sellSnap.val();
    sellData.discount = discount;
    sellData.totalPrice = (sellData.totalPrice || 0) - discount;

    await update(sellRef, sellData);

    return { message: "✅ تم إضافة الخصم بعد البيع", data: sellData };
  } catch (error) {
    console.error("❌ خطأ في إضافة الخصم بعد البيع:", error);
    return { message: "حدث خطأ أثناء إضافة الخصم" };
  }

}

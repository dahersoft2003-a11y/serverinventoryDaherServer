import { v4 as uuidv4 } from "uuid";
import { Supplier } from "../types/supplier";
import { Request, Response } from "express";
import { purchase } from "../types/purchase";
import { Payment } from "../types/payment";
import { ref, get, set, update, remove } from "firebase/database";
import { database } from "../firebaseConfig";
import { Customer } from "../types/customer";
import { normalizeCurrency, toMoneyNumber } from "../utils/money";

// ✅ جلب جميع الموردين
export const getAll = async (_req: Request, res: Response) => {
  try {
    const snapshot = await get(ref(database, "supplier"));
    const suppliers = snapshot.exists() ? Object.values(snapshot.val()) : [];
    res.json(suppliers);
  } catch (error) {
    console.error("❌ خطأ في جلب الموردين:", error);
    res.status(500).json({ message: "حدث خطأ أثناء جلب الموردين" });
  }
};

// ✅ إنشاء أو تحديث مورد
export const create = async (req: Request, res: Response) => {
  try {
    const now = new Date().toLocaleString();
    const newSupplier: Supplier = req.body;
    const id = uuidv4();

    const SupplierToAdd: Supplier = {
      ...newSupplier,
      id,
      createdDate: now,
      updatedDate: now,
    };
    await set(ref(database, `supplier/${id}`), SupplierToAdd);

    res.json({ message: "✅ تم إنشاء المورد", data: SupplierToAdd });
  } catch (error) {
    console.error("❌ خطأ أثناء إنشاء المورد:", error);
    res.status(500).json({ message: "حدث خطأ أثناء إنشاء المورد" });
  }
};

// إنشاء مورد داخلي
export const createSupplierInternal = async (
  newSupplier: Omit<Supplier, "id" | "createdDate" | "updatedDate">
): Promise<Supplier> => {
  const id = uuidv4();
  const now = new Date().toLocaleString();
  const supplier: Supplier = {
    ...newSupplier,
    id,
    createdDate: now,
    updatedDate: now,
  };
  await set(ref(database, `supplier/${id}`), supplier);
  return supplier;
};

export const updateSupplierInfo = async (
  req: Request,
  res: Response
): Promise<Supplier | null> => {
  const { id } = req.params;
  const updates = req.body;

  const dbRef = ref(database, `supplier/${id}`);
  const snapshot = await get(dbRef);
  if (!snapshot.exists()) {
    res.status(404).json({ error: "Supplier not found" });
    return null;
  }

  const supplier = snapshot.val() as Supplier;
  const now = new Date().toLocaleString();

  let updatedSupplier: Supplier = {
    ...supplier,
    updatedDate: now,
    name: updates.name,
    number: updates.number,
    defaultPaymentAccountId:
      updates.defaultPaymentAccountId ?? supplier.defaultPaymentAccountId,
    defaultPayableAccountId:
      updates.defaultPayableAccountId ?? supplier.defaultPayableAccountId,
    defaultInventoryAccountId:
      updates.defaultInventoryAccountId ?? supplier.defaultInventoryAccountId,
  };
  await update(dbRef, updatedSupplier);
  res.json({ message: "✅ تم تحديث بيانات المورد", data: updatedSupplier });
  return updatedSupplier;
};

// تحديث مورد داخلي (مع شراء أو دفعة)
export const updateSupplierInternal = async (
  id: string,
  sellUpdates?: purchase,
  paymentUpdates?: Payment
): Promise<Supplier | null> => {

  console.log(id, sellUpdates, paymentUpdates);

  const supplierId = typeof id === "string" ? id : (id as any).id;
  if (!supplierId) throw new Error("Invalid supplier id");
  const supplierRef = ref(database, `supplier/${supplierId}`);
  const snapshot = await get(supplierRef);
  if (!snapshot.exists()) return null;

  const supplier = snapshot.val() as Supplier;
  const now = new Date().toLocaleString();

  if (sellUpdates) {
    const remainingUSD = toMoneyNumber(
      sellUpdates.remainingUSD,
      toMoneyNumber(sellUpdates.remainingDebt),
    );
    const remainingSYP =
      normalizeCurrency(sellUpdates.paymentCurrency || sellUpdates.currency) ===
      "SYP"
        ? toMoneyNumber(
            sellUpdates.remainingSYP,
            toMoneyNumber(sellUpdates.remainingOriginal),
          )
        : 0;
    const updatedSupplier: Supplier = {
      ...supplier,
      balance:
        toMoneyNumber(supplier.balance) + remainingUSD,
      balanceUSD:
        toMoneyNumber(supplier.balanceUSD, toMoneyNumber(supplier.balance)) +
        remainingUSD,
      balanceSYP: toMoneyNumber(supplier.balanceSYP) + remainingSYP,
      purchases: [...(supplier.purchases || []), sellUpdates.id || ""],
      updatedDate: now,
    };
    await set(supplierRef, updatedSupplier);
    return updatedSupplier;
  }

  if (paymentUpdates) {
    const amountUSD = toMoneyNumber(
      paymentUpdates.amountUSD,
      toMoneyNumber(paymentUpdates.amount),
    );
    const updatedSupplier: Supplier = {
      ...supplier,
      balance:
        toMoneyNumber(supplier.balance) + amountUSD,
      balanceUSD:
        toMoneyNumber(supplier.balanceUSD, toMoneyNumber(supplier.balance)) +
        amountUSD,
      balanceSYP:
        toMoneyNumber(supplier.balanceSYP) +
        toMoneyNumber(paymentUpdates.balanceSYPChange),
      updatedDate: now,
    };
    await set(supplierRef, updatedSupplier);
    return updatedSupplier;
  }

  return null;
};

// تحديث الرصيد داخليًا
export const updateSupplierBalanceInternal = async (
  id: string,
  amountChange: number,
  amountSYPChange = 0,
): Promise<Supplier | null> => {
  const supplierRef = ref(database, `supplier/${id}`);
  const snapshot = await get(supplierRef);
  if (!snapshot.exists()) return null;

  const supplier = snapshot.val() as Supplier;
  const updatedSupplier: Supplier = {
    ...supplier,
    balance: toMoneyNumber(supplier.balance) + toMoneyNumber(amountChange),
    balanceUSD:
      toMoneyNumber(supplier.balanceUSD, toMoneyNumber(supplier.balance)) +
      toMoneyNumber(amountChange),
    balanceSYP: toMoneyNumber(supplier.balanceSYP) + toMoneyNumber(amountSYPChange),
    updatedDate: new Date().toLocaleString(),
  };

  await set(supplierRef, updatedSupplier);
  return updatedSupplier;
};

// حذف مورد داخلي
export const deleteSupplierInternal = async (id: string): Promise<boolean> => {
  const supplierRef = ref(database, `supplier/${id}`);
  const snapshot = await get(supplierRef);
  if (!snapshot.exists()) return false;

  await remove(supplierRef);
  return true;
};

// جلب جميع الموردين داخليًا
export const getAllsupplierInternal = async (): Promise<Supplier[]> => {
  const snapshot = await get(ref(database, "supplier"));
  return snapshot.exists() ? Object.values(snapshot.val()) : [];
};

// جلب مورد واحد داخليًا
export const getSupplierByIdInternal = async (
  id: string
): Promise<Supplier | null> => {
  const snapshot = await get(ref(database, `supplier/${id}`));
  return snapshot.exists() ? (snapshot.val() as Supplier) : null;
};

// جلب مورد واحد مع المشتريات والمدفوعات
export const getSupplierById = async (req: Request, res: Response) => {
  try {
    const { id } = req.body;
    const snapshot = await get(ref(database, `supplier/${id}`));
    if (!snapshot.exists()) {
      return res.status(404).json({ error: "Supplier not found" });
    }

    const supplier = snapshot.val() as Supplier;

    const toNumber = (value: unknown) => {
      const numberValue = Number(value);
      return Number.isFinite(numberValue) ? numberValue : 0;
    };

    const getPaymentStatusLabel = (status: string) => {
      if (status === "cash") return "نقدي";
      if (status === "part") return "جزئي";
      if (status === "debt") return "دين";
      return "غير محدد";
    };

    // جلب المشتريات
    const purchasesSnapshot = await get(ref(database, "purchases"));
    const purchasesData = purchasesSnapshot.exists()
      ? purchasesSnapshot.val()
      : {};
    const purchases =
      supplier.purchases?.map(
        (purchaseId: string) => purchasesData[purchaseId]
      ) || [];

    // جلب المدفوعات
    const paymentSnapshot = await get(ref(database, "payment"));
    const paymentsData = paymentSnapshot.exists()
      ? Object.values(paymentSnapshot.val())
      : [];
    const payments = paymentsData.filter((p: any) => p.supplierId === id || p?.supplierId?.id === id );
    const paymentsByPurchase = payments.reduce(
      (grouped: Record<string, any[]>, payment: any) => {
        if (!payment?.purchaseId) return grouped;

        grouped[payment.purchaseId] = grouped[payment.purchaseId] || [];
        grouped[payment.purchaseId].push(payment);
        return grouped;
      },
      {}
    );

    const enrichedPurchases = purchases
      .filter(Boolean)
      .map((purchaseData: any) => {
        const totalPrice = toNumber(purchaseData?.totalPrice);
        const remainingDebt = toNumber(purchaseData?.remainingDebt);
        const invoicePayments = (paymentsByPurchase[purchaseData?.id] || [])
          .filter(
            (payment: any) =>
              payment?.type === "expense" && toNumber(payment?.amount) < 0
          )
          .sort(
            (a: any, b: any) =>
              new Date(b?.date || 0).getTime() -
              new Date(a?.date || 0).getTime()
          );
        const invoicePaymentsTotal = invoicePayments.reduce(
          (sum: number, payment: any) =>
            sum + Math.abs(toNumber(payment?.amount)),
          0
        );
        const paidAmount = Math.max(totalPrice - remainingDebt, 0);
        const products = Array.isArray(purchaseData?.products)
          ? purchaseData.products
          : [];

        return {
          ...purchaseData,
          paymentStatusLabel: getPaymentStatusLabel(purchaseData?.paymentStatus),
          paidAmount,
          invoicePayments,
          invoicePaymentsTotal,
          invoicePaymentsCount: invoicePayments.length,
          remainingDebt,
          productsString:
            products.length > 0
              ? products
                  .map(
                    (product: any) =>
                      `${product?.name || "منتج"} (${toNumber(
                        product?.quantity
                      )})`
                  )
                  .join(", ")
              : purchaseData?.name || purchaseData?.code || "",
        };
      });

    res.json({ data: { ...supplier, purchases: enrichedPurchases, payments } });
  } catch (error) {
    console.error("❌ خطأ أثناء جلب المورد:", error);
    res.status(500).json({ message: "حدث خطأ أثناء جلب المورد" });
  }
};

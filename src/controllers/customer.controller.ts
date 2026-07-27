import { v4 as uuidv4 } from "uuid";
import { Customer } from "../types/customer";
import { Request, Response } from "express";
import { sell } from "../types/sell";
import { Payment } from "../types/payment";
import { ref, get, set, update, remove } from "firebase/database";
import { database } from "../firebaseConfig";
import { normalizeCurrency, toMoneyNumber } from "../utils/money";

/* =========================================================
   ✅ 1. جلب جميع العملاء
   ========================================================= */
export const getAll = async (_req: Request, res: Response) => {
  try {
    const dbRef = ref(database, "customer");
    const snapshot = await get(dbRef);

    res.json(snapshot.exists() ? Object.values(snapshot.val()) : []);
  } catch (error: any) {
    console.error("Error fetching customers:", error);
    res.status(500).json({ error: error.message });
  }
};

/* =========================================================
   ✅ 2. إنشاء عميل جديد
   ========================================================= */
export const create = async (req: Request, res: Response) => {
  try {
    const now = new Date().toLocaleString();
    const id = uuidv4();

    const newCustomer: Customer = {
      ...req.body,
      id,
      createdDate: now,
      updatedDate: now,
    };

    await set(ref(database, `customer/${id}`), newCustomer);
    res.json({ message: "✅ تم إنشاء العميل", data: newCustomer });
  } catch (error: any) {
    console.error("Error creating customer:", error);
    res.status(500).json({ error: error.message });
  }
};

/* =========================================================
   ✅ 3. إنشاء عميل داخلي (للاستخدام من وحدات أخرى)
   ========================================================= */
export const createCustomerInternal = async (
  newCustomer: Omit<Customer, "id" | "createdDate" | "updatedDate">
): Promise<Customer> => {
  const id = uuidv4();
  const now = new Date().toLocaleString();

  const customer: Customer = {
    ...newCustomer,
    id,
    createdDate: now,
    updatedDate: now,
  };

  await set(ref(database, `customer/${id}`), customer);
  return customer;
};

export const updateCustomerInfo = async (
  // id: string,
  // updates: Partial<Omit<Customer, "id" | "createdDate">>
  req: Request,
  res: Response
): Promise<Customer | null> => {
  const { id } = req.params;
  const updates = req.body;

  const dbRef = ref(database, `customer/${id}`);
  const snapshot = await get(dbRef);
  if (!snapshot.exists()) {
    res.status(404).json({ error: "Customer not found" });
    return null;
  }

  const customer = snapshot.val() as Customer;
  const now = new Date().toLocaleString();

  let updatedCustomer: Customer = {
    ...customer,
    updatedDate: now,
    name: updates.name,
    number: updates.number,
    defaultPaymentAccountId:
      updates.defaultPaymentAccountId ?? customer.defaultPaymentAccountId,
    defaultReceivableAccountId:
      updates.defaultReceivableAccountId ?? customer.defaultReceivableAccountId,
    defaultSalesAccountId:
      updates.defaultSalesAccountId ?? customer.defaultSalesAccountId,
  };
  await update(dbRef, updatedCustomer);
  res.json({ message: "✅ تم تحديث بيانات العميل", data: updatedCustomer });
  return updatedCustomer;
};
/* =========================================================
   ✅ 4. تحديث بيانات العميل داخليًا
   ========================================================= */
export const updateCustomerInternal = async (
  id: string,
  sellUpdates?: sell,
  payUpdates?: Payment
): Promise<Customer | null> => {
  const dbRef = ref(database, `customer/${id}`);
  const snapshot = await get(dbRef);
  if (!snapshot.exists()) return null;

  const customer = snapshot.val() as Customer;
  const now = new Date().toLocaleString();

  let updatedCustomer: Customer = { ...customer, updatedDate: now };

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
    updatedCustomer.balance =
      toMoneyNumber(customer.balance) - remainingUSD;
    updatedCustomer.balanceUSD =
      toMoneyNumber(customer.balanceUSD, toMoneyNumber(customer.balance)) -
      remainingUSD;
    updatedCustomer.balanceSYP =
      toMoneyNumber(customer.balanceSYP) - remainingSYP;
    updatedCustomer.purchases = [
      ...(customer.purchases || []),
      sellUpdates.id || "",
    ];
  } else if (payUpdates) {
    const amountUSD = toMoneyNumber(
      payUpdates.amountUSD,
      toMoneyNumber(payUpdates.amount),
    );
    updatedCustomer.balance =
      toMoneyNumber(customer.balance) + amountUSD;
    updatedCustomer.balanceUSD =
      toMoneyNumber(customer.balanceUSD, toMoneyNumber(customer.balance)) +
      amountUSD;
    updatedCustomer.balanceSYP =
      toMoneyNumber(customer.balanceSYP) +
      toMoneyNumber(payUpdates.balanceSYPChange);
  }

  await update(dbRef, updatedCustomer);
  return updatedCustomer;
};

/* =========================================================
   ✅ 5. حذف عميل داخليًا
   ========================================================= */
export const deleteCustomerInternal = async (id: string): Promise<boolean> => {
  const dbRef = ref(database, `customer/${id}`);
  const snapshot = await get(dbRef);
  if (!snapshot.exists()) return false;

  await remove(dbRef);
  return true;
};

/* =========================================================
   ✅ 6. جلب جميع العملاء داخليًا
   ========================================================= */
export const getAllcustomerInternal = async (): Promise<Customer[]> => {
  const dbRef = ref(database, "customer");
  const snapshot = await get(dbRef);
  return snapshot.exists() ? Object.values(snapshot.val()) : [];
};

/* =========================================================
   ✅ 7. جلب عميل واحد داخليًا
   ========================================================= */
export const getCustomerByIdInternal = async (
  id: string
): Promise<Customer | null> => {
  const dbRef = ref(database, `customer/${id}`);
  const snapshot = await get(dbRef);
  return snapshot.exists() ? snapshot.val() : null;
};

/* =========================================================
   ✅ 8. جلب عميل + المشتريات + المدفوعات
   ✅ تحسين الأداء بعدم جلب كل القاعدة
   ========================================================= */
export const getCustomerById = async (req: Request, res: Response) => {
  const { id } = req.body;

  try {
    // 🔹 جلب العميل فقط
    const customerSnap = await get(ref(database, `customer/${id}`));
    if (!customerSnap.exists())
      return res.status(404).json({ error: "Customer not found" });

    const customer: Customer = customerSnap.val();

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

    const paymentsRef = ref(database, "payment");
    const paymentsSnap = await get(paymentsRef);
    const payments = paymentsSnap.exists()
      ? (Object.values(paymentsSnap.val()).filter(
          (p: any) => p.customerId === id
        ) as any[])
      : [];

    const paymentsBySell = payments.reduce(
      (grouped: Record<string, any[]>, payment: any) => {
        if (!payment?.sellId) return grouped;

        grouped[payment.sellId] = grouped[payment.sellId] || [];
        grouped[payment.sellId].push(payment);
        return grouped;
      },
      {}
    );

    const enrichSellForCustomer = (sale: any) => {
      const totalPrice = toNumber(sale?.totalPrice);
      const remainingDebt = toNumber(sale?.remainingDebt);
      const invoicePayments = (paymentsBySell[sale?.id] || [])
        .filter(
          (payment: any) =>
            payment?.type === "income" && toNumber(payment?.amount) > 0
        )
        .sort(
          (a: any, b: any) =>
            new Date(b?.date || 0).getTime() -
            new Date(a?.date || 0).getTime()
        );
      const invoicePaymentsTotal = invoicePayments.reduce(
        (sum: number, payment: any) => sum + toNumber(payment?.amount),
        0
      );
      const paidAmount = Math.max(totalPrice - remainingDebt, 0);
      const products = Array.isArray(sale?.products) ? sale.products : [];

      return {
        ...sale,
        paymentStatusLabel: getPaymentStatusLabel(sale?.paymentStatus),
        paidAmount,
        invoicePayments,
        invoicePaymentsTotal,
        invoicePaymentsCount: invoicePayments.length,
        remainingDebt,
        productsString: products
          .map((product: any) =>
            `${product?.name || "منتج"} (${toNumber(product?.qty)})`
          )
          .join(", "),
      };
    };

    // 🔹 جلب مشترياته فقط
    let purchases: sell[] = [];
    if (customer.purchases?.length) {
      const promises = customer.purchases.map(async (pid: string) => {
        const pSnap = await get(ref(database, `sells/${pid}`));
        return pSnap.exists() ? pSnap.val() : null;
      });
      purchases = (await Promise.all(promises))
        .filter(Boolean)
        .map(enrichSellForCustomer) as sell[];
    }

    res.json({
      data: {
        ...customer,
        purchases,
        payments,
      },
    });
  } catch (error: any) {
    console.error("Error fetching customer details:", error);
    res.status(500).json({ error: error.message });
  }
};

/* =========================================================
   ✅ 9. تعديل الرصيد فقط (دون جلب إضافي)
   ========================================================= */
export const updateCustomerBalanceInternal = async (
  id: string,
  amountChange: number,
  amountSYPChange = 0,
): Promise<Customer | null> => {
  const dbRef = ref(database, `customer/${id}`);
  const snapshot = await get(dbRef);
  if (!snapshot.exists()) return null;

  const customer = snapshot.val() as Customer;
  const updatedCustomer = {
    ...customer,
    balance: toMoneyNumber(customer.balance) + toMoneyNumber(amountChange),
    balanceUSD:
      toMoneyNumber(customer.balanceUSD, toMoneyNumber(customer.balance)) +
      toMoneyNumber(amountChange),
    balanceSYP: toMoneyNumber(customer.balanceSYP) + toMoneyNumber(amountSYPChange),
    updatedDate: new Date().toLocaleString(),
  };

  await update(dbRef, updatedCustomer);
  return updatedCustomer;
};

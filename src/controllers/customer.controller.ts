import { v4 as uuidv4 } from "uuid";
import { Customer } from "../types/customer";
import { Request, Response } from "express";
import { sell } from "../types/sell";
import { Payment } from "../types/payment";
import { ref, get, set, update, remove, runTransaction } from "firebase/database";
import { database } from "../firebaseConfig";
import { normalizeCurrency, roundMoney, toMoneyNumber } from "../utils/money";
import { reconcileGoodsCustomerState } from "../utils/goodsSettlement";

type CustomerBalanceReconciliation = {
  customer: Customer;
  purchases: sell[];
  payments: Payment[];
  removedPurchaseIds: string[];
  balanceUSD: number;
  balanceSYP: number;
};

const getPurchaseIds = (purchases: unknown) =>
  Array.isArray(purchases)
    ? purchases
        .map((purchaseId) => String(purchaseId || "").trim())
        .filter(Boolean)
    : [];

const sameStringList = (left: string[], right: string[]) =>
  left.length === right.length && left.every((item, index) => item === right[index]);

const getSaleRemainingUSD = (sale: Partial<sell>) =>
  roundMoney(
    toMoneyNumber(sale.remainingUSD, toMoneyNumber(sale.remainingDebt)),
  );

const getSaleRemainingSYP = (sale: Partial<sell>) => {
  const currency = normalizeCurrency(sale.paymentCurrency || sale.currency);

  if (currency !== "SYP") return 0;

  return roundMoney(
    toMoneyNumber(sale.remainingSYP, toMoneyNumber(sale.remainingOriginal)),
  );
};

const shouldCountCustomerPaymentInBalance = (payment: Partial<Payment>) =>
  !payment.sellId && (payment.type === "income" || payment.settlementMethod === "goods" || payment.type === "return-credit" || payment.type === "expense" && payment.balanceUSDChange !== undefined);

export const reconcileCustomerBalanceInternal = async (
  id: string,
): Promise<CustomerBalanceReconciliation | null> => {
  const customerRef = ref(database, `customer/${id}`);
  const [customerSnap, sellsSnap, paymentsSnap] = await Promise.all([
    get(customerRef),
    get(ref(database, "sells")),
    get(ref(database, "payment")),
  ]);

  if (!customerSnap.exists()) return null;

  const customer = customerSnap.val() as Customer;
  const sellsData = sellsSnap.exists()
    ? (sellsSnap.val() as Record<string, any>)
    : {};
  const paymentsData = paymentsSnap.exists()
    ? (paymentsSnap.val() as Record<string, any>)
    : {};

  const customerPurchases = Object.entries(sellsData)
    .map(([key, sale]) => ({ ...(sale || {}), id: sale?.id || key }) as sell)
    .filter((sale) => sale.customerId === id);
  const actualPurchaseIds = customerPurchases
    .map((sale) => String(sale.id || "").trim())
    .filter(Boolean);
  const currentPurchaseIds = getPurchaseIds(customer.purchases);
  const existingPurchaseIds = currentPurchaseIds.filter((purchaseId) =>
    actualPurchaseIds.includes(purchaseId),
  );
  const cleanPurchaseIds = Array.from(
    new Set([...existingPurchaseIds, ...actualPurchaseIds]),
  );
  const removedPurchaseIds = currentPurchaseIds.filter(
    (purchaseId) => !cleanPurchaseIds.includes(purchaseId),
  );
  const payments = Object.entries(paymentsData)
    .map(
      ([key, payment]) =>
        ({ ...(payment || {}), id: payment?.id || key }) as Payment,
    )
    .filter((payment) => payment.customerId === id);

  const invoicesBalanceUSD = customerPurchases.reduce(
    (sum, sale) => roundMoney(sum - getSaleRemainingUSD(sale)),
    0,
  );
  const invoicesBalanceSYP = customerPurchases.reduce(
    (sum, sale) => roundMoney(sum - getSaleRemainingSYP(sale)),
    0,
  );
  const directPaymentsBalanceUSD = payments
    .filter(shouldCountCustomerPaymentInBalance)
    .reduce(
      (sum, payment) =>
        roundMoney(
          sum + toMoneyNumber(payment.balanceUSDChange, toMoneyNumber(payment.amountUSD, toMoneyNumber(payment.amount))),
        ),
      0,
    );
  const directPaymentsBalanceSYP = payments
    .filter(shouldCountCustomerPaymentInBalance)
    .reduce(
      (sum, payment) =>
        roundMoney(
          sum +
            toMoneyNumber(
              payment.balanceSYPChange,
              toMoneyNumber(payment.amountSYP),
            ),
        ),
      0,
    );
  const balanceUSD = roundMoney(invoicesBalanceUSD + directPaymentsBalanceUSD);
  const balanceSYP = roundMoney(invoicesBalanceSYP + directPaymentsBalanceSYP);
  const patch = {
    balance: balanceUSD,
    balanceUSD,
    balanceSYP,
    purchases: cleanPurchaseIds,
  };
  const needsUpdate =
    roundMoney(toMoneyNumber(customer.balance)) !== patch.balance ||
    roundMoney(toMoneyNumber(customer.balanceUSD, toMoneyNumber(customer.balance))) !==
      patch.balanceUSD ||
    roundMoney(toMoneyNumber(customer.balanceSYP)) !== patch.balanceSYP ||
    !sameStringList(currentPurchaseIds, cleanPurchaseIds);
  const reconciledCustomer = {
    ...customer,
    ...patch,
    updatedDate: needsUpdate ? new Date().toLocaleString() : customer.updatedDate,
  };

  if (needsUpdate) {
    // Recompute from the transaction's current invoices and payments. Applying
    // the earlier read here could overwrite a concurrent goods settlement.
    const rootRef = ref(database);
    const seed = await get(rootRef);
    const result = await runTransaction(rootRef, (current) => {
      const source = current || seed.val();
      if (!source?.customer?.[id]) return;
      const state = { ...source, customer: { ...source.customer } };
      reconcileGoodsCustomerState(state, id);
      state.customer[id] = { ...state.customer[id], updatedDate: new Date().toISOString() };
      return state;
    }, { applyLocally: false });
    if (!result.committed) return null;
    const state = result.snapshot.val();
    const actualCustomer = state.customer[id] as Customer;
    return {
      customer: actualCustomer,
      purchases: Object.entries(state.sells || {}).map(([key, sale]: [string, any]) => ({ ...sale, id: sale.id || key }) as sell).filter((sale) => sale.customerId === id),
      payments: Object.entries(state.payment || {}).map(([key, payment]: [string, any]) => ({ ...payment, id: payment.id || key }) as Payment).filter((payment) => payment.customerId === id),
      removedPurchaseIds,
      balanceUSD: toMoneyNumber(actualCustomer.balanceUSD, actualCustomer.balance),
      balanceSYP: toMoneyNumber(actualCustomer.balanceSYP),
    };
  }

  return {
    customer: reconciledCustomer,
    purchases: customerPurchases,
    payments,
    removedPurchaseIds,
    balanceUSD,
    balanceSYP,
  };
};

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
  _sellUpdates?: sell,
  _payUpdates?: Payment
): Promise<Customer | null> => {
  // Callers have already saved their source invoice/payment. Derive the
  // balance once rather than writing a stale delta then correcting it.
  return (await reconcileCustomerBalanceInternal(id))?.customer || null;
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
  return (await reconcileCustomerBalanceInternal(id))?.customer || null;
};

/* =========================================================
   ✅ 8. جلب عميل + المشتريات + المدفوعات
   ✅ تحسين الأداء بعدم جلب كل القاعدة
   ========================================================= */
export const getCustomerById = async (req: Request, res: Response) => {
  const { id } = req.body;

  try {
    // 🔹 جلب العميل فقط
    const reconciliation = await reconcileCustomerBalanceInternal(id);
    if (!reconciliation)
      return res.status(404).json({ error: "Customer not found" });

    const customer: Customer = reconciliation.customer;

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

    const payments = reconciliation.payments;

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
            (payment?.type === "income" && toNumber(payment?.amount) > 0) || payment?.settlementMethod === "goods"
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
    const purchases = reconciliation.purchases.map(enrichSellForCustomer) as sell[];

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

import { v4 as uuidv4 } from "uuid";
import { Request, Response } from "express";
import { Payment } from "../types/payment";
import { ref, get, set, push } from "firebase/database";
import { database } from "../firebaseConfig";
import { updateAccountBalanceInternal } from "./account.controller";
import { createJournalEntryInternal } from "./journalEntries.controller";
import { prepareDriverPayment } from "../utils/driverCommission";
import { requireFinanceUser } from "../utils/financeAuth";
import { sanitizeCashPaymentInput } from "../utils/cashPaymentInput";
import {
  buildPaymentMoneyBreakdown,
  normalizeCurrency,
  toMoneyNumber,
} from "../utils/money";

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

const normalizePaymentForStorage = (paymentData: Payment): Payment => {
  const paymentCurrency = normalizeCurrency(
    paymentData.paymentCurrency || paymentData.currency,
  );
  const money = buildPaymentMoneyBreakdown({
    amount: paymentData.amount,
    amountUSD: paymentData.amountUSD,
    currency: paymentCurrency,
    exchangeRate: paymentData.exchangeRate,
    amountOriginal: paymentData.amountOriginal ?? paymentData.amount_base,
  });

  return stripUndefined({
    ...paymentData,
    currency: paymentCurrency,
    paymentCurrency,
    exchangeRate: money.exchangeRate,
    amount: money.amountUSD,
    amount_base: money.amountBase,
    amountUSD: money.amountUSD,
    amountSYP: money.amountSYP,
    amountOriginal: money.amountOriginal,
  });
};

const normalizeStoredDate = (value: unknown) => {
  if (!value || typeof value !== "string") {
    return null;
  }

  const normalized = value
    .replace(/[٠-٩]/g, (digit) => String("٠١٢٣٤٥٦٧٨٩".indexOf(digit)))
    .replace(/،/g, ",")
    .trim();

  const parsed = new Date(normalized);
  if (!Number.isNaN(parsed.getTime())) {
    return parsed;
  }

  return null;
};

// ✅ get all payments as array
export const getAll = async (_req: Request, res: Response) => {
  try {
    const dbRef = ref(database, "payment");
    const snapshot = await get(dbRef);
    const payments = snapshot.exists() ? Object.values(snapshot.val()) : [];
    res.json(payments);
  } catch (error: any) {
    console.error("Error fetching payments:", error);
    res.status(500).json({ error: error.message });
  }
};

// ✅ get month payments as array
export const getMonthPayments = async (req: Request, res: Response) => {
  try {
    const { month, year } = req.query;
    if (!month || !year) {
      return res.status(400).json({ error: "Month and year are required" });
    }

    const dbRef = ref(database, "payment");
    const snapshot = await get(dbRef);
    const payments = snapshot.exists() ? Object.values(snapshot.val()) : [];

    const filteredPayments = payments.filter((p: any) => {
      const paymentDate = normalizeStoredDate(p.date);
      if (!paymentDate) {
        return false;
      }

      return (
        paymentDate.getMonth() + 1 === Number(month) &&
        paymentDate.getFullYear() === Number(year)
      );
    });

    res.json(filteredPayments);
  } catch (error: any) {
    console.error("Error filtering payments:", error);
    res.status(500).json({ error: error.message });
  }
};

// ✅ إنشاء دفعة جديدة
export const createPayment = async (req: Request, res: Response) => {
  try {
    const actor = await requireFinanceUser(req);
    if (actor.role !== "admin") return res.status(403).json({ error: "تسجيل هذه الدفعة متاح للمدير فقط" });
    const { newPayment }: { newPayment: Payment } = req.body;

    const id = uuidv4();
    const now = new Date().toISOString();

    const payment: Payment = normalizePaymentForStorage({
      ...sanitizeCashPaymentInput(newPayment),
      collectorId: actor.userId,
      collectorName: actor.username,
      createdBy: actor.userId,
      id,
      date: now,
    });

    await set(ref(database, `payment/${id}`), payment);

    const amount = Math.abs(
      toMoneyNumber(payment.amountUSD, toMoneyNumber(payment.amount)),
    );
    const paymentCurrency = normalizeCurrency(
      payment.paymentCurrency || payment.currency,
    );
    const amountOriginal = Math.abs(
      toMoneyNumber(
        payment.amountOriginal,
        toMoneyNumber(payment.amount_base, amount),
      ),
    );
    const amountSYP =
      paymentCurrency === "SYP"
        ? Math.abs(toMoneyNumber(payment.amountSYP, amountOriginal))
        : 0;

    if (
      payment.type === "income" &&
      payment.paymentAccountId &&
      payment.salesAccountId &&
      amount > 0
    ) {
      await updateAccountBalanceInternal({
        accountId: payment.paymentAccountId,
        entryType: "debit",
        amount,
        currency: paymentCurrency,
        exchangeRate: payment.exchangeRate,
        amountOriginal,
        amountSYP,
      });

      await updateAccountBalanceInternal({
        accountId: payment.salesAccountId,
        entryType: "credit",
        amount,
        currency: paymentCurrency,
        exchangeRate: payment.exchangeRate,
        amountOriginal,
        amountSYP,
      });
    }

    if (
      payment.type === "expense" &&
      payment.paymentAccountId &&
      payment.expenseAccountId &&
      amount > 0
    ) {
      await updateAccountBalanceInternal({
        accountId: payment.expenseAccountId,
        entryType: "debit",
        amount,
        currency: paymentCurrency,
        exchangeRate: payment.exchangeRate,
        amountOriginal,
        amountSYP,
      });

      await updateAccountBalanceInternal({
        accountId: payment.paymentAccountId,
        entryType: "credit",
        amount,
        currency: paymentCurrency,
        exchangeRate: payment.exchangeRate,
        amountOriginal,
        amountSYP,
      });
    }

    if (
      payment.type === "income" &&
      payment.paymentAccountId &&
      payment.salesAccountId &&
      amount > 0
    ) {
      await createJournalEntryInternal({
        date: payment.date,
        description: payment.note || "قيد دفعة تحصيل",
        referenceType: "payment",
        referenceId: payment.id,
        lines: [
          {
            accountId: payment.paymentAccountId,
            debit: amount,
            credit: 0,
            currency: paymentCurrency,
            exchangeRate: payment.exchangeRate,
            amountUSD: amount,
            amountSYP,
            amountOriginal,
            note: payment.note,
          },
          {
            accountId: payment.salesAccountId,
            debit: 0,
            credit: amount,
            currency: paymentCurrency,
            exchangeRate: payment.exchangeRate,
            amountUSD: amount,
            amountSYP,
            amountOriginal,
            note: payment.note,
          },
        ],
      });
    }

    if (
      payment.type === "expense" &&
      payment.paymentAccountId &&
      payment.expenseAccountId &&
      amount > 0
    ) {
      await createJournalEntryInternal({
        date: payment.date,
        description: payment.note || "قيد دفعة صرف",
        referenceType: "payment",
        referenceId: payment.id,
        lines: [
          {
            accountId: payment.expenseAccountId,
            debit: amount,
            credit: 0,
            currency: paymentCurrency,
            exchangeRate: payment.exchangeRate,
            amountUSD: amount,
            amountSYP,
            amountOriginal,
            note: payment.note,
          },
          {
            accountId: payment.paymentAccountId,
            debit: 0,
            credit: amount,
            currency: paymentCurrency,
            exchangeRate: payment.exchangeRate,
            amountUSD: amount,
            amountSYP,
            amountOriginal,
            note: payment.note,
          },
        ],
      });
    }

    res.status(201).json(payment);
  } catch (error: any) {
    console.error("Error creating payment:", error);
    res.status(error.message === "UNAUTHORIZED" ? 401 : 400).json({ error: error.message || "فشل في إنشاء الدفعة" });
  }
};

// ✅ إنشاء دفعة جديدة داخليًا (بدون استجابة HTTP)
export const createPaymentInternal = async (
  newPayment: Payment
): Promise<Payment> => {
  const id = uuidv4();
  const now = new Date().toISOString();

  const payment: Payment = await prepareDriverPayment(normalizePaymentForStorage({
    ...newPayment,
    id,
    date: now,
  }));

  await set(ref(database, `payment/${id}`), payment);
  return payment;
};

import { Request, Response } from "express";
import { get, ref, update } from "firebase/database";
import { database } from "../firebaseConfig";
import { normalizeAccountBalances } from "./account.controller";
import { getCurrentUserFromRequest } from "../utils/currentUser";
import {
  buildInvoiceMoneyBreakdown,
  buildPaymentMoneyBreakdown,
  normalizeCurrency,
  originalToUSD,
  roundMoney,
  toMoneyNumber,
  usdToOriginal,
  usdToSYPForPaymentCurrency,
} from "../utils/money";

type AnyRecord = Record<string, any>;
type MigrationPatch = Record<string, any>;

const normalizePaymentStatus = (value: unknown): "cash" | "part" | "debt" => {
  return value === "cash" || value === "part" || value === "debt"
    ? value
    : "debt";
};

const getMap = async (path: string): Promise<Record<string, AnyRecord>> => {
  const snapshot = await get(ref(database, path));
  return snapshot.exists() ? snapshot.val() : {};
};

const inferExchangeRate = ({
  currency,
  exchangeRate,
  originalAmount,
  usdAmount,
}: {
  currency: "USD" | "SYP";
  exchangeRate: unknown;
  originalAmount?: unknown;
  usdAmount?: unknown;
}) => {
  if (currency === "USD") return 1;

  const providedRate = toMoneyNumber(exchangeRate);
  if (providedRate > 0) return providedRate;

  const original = Math.abs(toMoneyNumber(originalAmount));
  const usd = Math.abs(toMoneyNumber(usdAmount));
  const inferredRate = usd > 0 ? original / usd : 0;

  return inferredRate > 0 ? inferredRate : null;
};

const hasNumberChanged = (current: unknown, next: number) => {
  const currentNumber = Number(current);
  return (
    !Number.isFinite(currentNumber) ||
    roundMoney(currentNumber) !== roundMoney(next)
  );
};

const buildPatch = (current: AnyRecord, next: AnyRecord): MigrationPatch => {
  return Object.entries(next).reduce<MigrationPatch>((patch, [key, value]) => {
    if (value === undefined) return patch;

    if (typeof value === "number") {
      if (hasNumberChanged(current[key], value)) {
        patch[key] = roundMoney(value);
      }
      return patch;
    }

    if (Array.isArray(value)) {
      if (JSON.stringify(current[key] || []) !== JSON.stringify(value)) {
        patch[key] = value;
      }
      return patch;
    }

    if (current[key] !== value) {
      patch[key] = value;
    }

    return patch;
  }, {});
};

const buildInvoicePatch = (invoice: AnyRecord, kind: "sell" | "purchase") => {
  const paymentCurrency = normalizeCurrency(
    invoice.paymentCurrency || invoice.currency,
  );
  const totalUSD = Math.max(
    toMoneyNumber(invoice.totalUSD, toMoneyNumber(invoice.totalPrice)),
    0,
  );
  const exchangeRate = inferExchangeRate({
    currency: paymentCurrency,
    exchangeRate: invoice.exchangeRate,
    originalAmount: invoice.totalOriginal ?? invoice.amount_base,
    usdAmount: totalUSD,
  });

  if (!exchangeRate) {
    return {
      patch: null,
      warning: `${kind}:${invoice.id || invoice.code || "unknown"} missing exchange rate`,
    };
  }

  const status = normalizePaymentStatus(invoice.paymentStatus);
  const remainingUSD = toMoneyNumber(
    invoice.remainingUSD,
    toMoneyNumber(invoice.remainingDebt, NaN),
  );
  const paidFromRemaining = Number.isFinite(remainingUSD)
    ? totalUSD - remainingUSD
    : NaN;
  const submittedPaidUSD = toMoneyNumber(invoice.paidUSD, paidFromRemaining);
  const fallbackPaidUSD =
    status === "cash" ? totalUSD : status === "part" ? submittedPaidUSD : 0;
  const paidUSD = Math.min(Math.max(toMoneyNumber(fallbackPaidUSD), 0), totalUSD);
  const effectiveStatus =
    paidUSD >= totalUSD ? "cash" : paidUSD > 0 ? "part" : "debt";
  const partValue = usdToOriginal(paidUSD, paymentCurrency, exchangeRate);
  const discountUSD = toMoneyNumber(
    invoice.discountUSD,
    kind === "sell" ? toMoneyNumber(invoice.discount) : 0,
  );
  const subtotalUSD = toMoneyNumber(
    invoice.subtotalUSD,
    kind === "sell" ? totalUSD + discountUSD : totalUSD,
  );
  const discountPercent = kind === "sell" ? toMoneyNumber(invoice.discountPercent) : 0;
  const discountAmountUSD =
    kind === "sell"
      ? toMoneyNumber(invoice.discountAmountUSD, discountUSD)
      : 0;
  const money = buildInvoiceMoneyBreakdown({
    totalUSD,
    subtotalUSD,
    paymentStatus: effectiveStatus,
    currency: paymentCurrency,
    exchangeRate,
    partValue,
    discountUSD,
    discountPercent,
    discountAmountUSD,
  });
  const next: AnyRecord = {
    currency: money.paymentCurrency,
    paymentCurrency: money.paymentCurrency,
    priceCurrency: money.priceCurrency,
    exchangeRate: money.exchangeRate,
    totalPrice: money.totalUSD,
    amount_base: money.totalOriginal,
    totalUSD: money.totalUSD,
    totalSYP: money.totalSYP,
    totalOriginal: money.totalOriginal,
    paidUSD: money.paidUSD,
    paidSYP: money.paidSYP,
    paidOriginal: money.paidOriginal,
    remainingDebt: money.remainingUSD,
    remainingUSD: money.remainingUSD,
    remainingSYP: money.remainingSYP,
    remainingOriginal: money.remainingOriginal,
    partValue: money.paidOriginal,
    paymentStatus: effectiveStatus,
  };

  if (kind === "sell") {
    next.subtotalUSD = money.subtotalUSD;
    next.discountType = money.discountType;
    next.discountPercent = money.discountPercent;
    next.discountPercentUSD = money.discountPercentUSD;
    next.discountAmountUSD = money.discountAmountUSD;
    next.discountUSD = money.discountUSD;
    next.discountSYP = money.discountSYP;
    next.discountOriginal = money.discountOriginal;
    next.discount = money.discountUSD;
  } else {
    next.paidAmount = money.paidUSD;
  }

  return { patch: buildPatch(invoice, next), normalized: { ...invoice, ...next } };
};

const buildPaymentPatch = (payment: AnyRecord) => {
  const paymentCurrency = normalizeCurrency(
    payment.paymentCurrency || payment.currency,
  );
  const sourceOriginal = payment.amountOriginal ?? payment.amount_base;
  const sourceUSD = payment.amountUSD ?? payment.amount;
  const exchangeRate = inferExchangeRate({
    currency: paymentCurrency,
    exchangeRate: payment.exchangeRate,
    originalAmount: sourceOriginal,
    usdAmount: sourceUSD,
  });

  if (!exchangeRate) {
    return {
      patch: null,
      warning: `payment:${payment.id || payment.date || "unknown"} missing exchange rate`,
    };
  }

  const money = buildPaymentMoneyBreakdown({
    amount: payment.amount,
    amountUSD: payment.amountUSD,
    amountOriginal: sourceOriginal,
    currency: paymentCurrency,
    exchangeRate,
  });
  const next = {
    currency: money.paymentCurrency,
    paymentCurrency: money.paymentCurrency,
    exchangeRate: money.exchangeRate,
    amount: money.amountUSD,
    amount_base: money.amountBase,
    amountUSD: money.amountUSD,
    amountSYP: money.amountSYP,
    amountOriginal: money.amountOriginal,
    balanceSYPChange:
      payment.balanceSYPChange === undefined
        ? money.amountSYP
        : payment.balanceSYPChange,
  };

  return { patch: buildPatch(payment, next), normalized: { ...payment, ...next } };
};

const addPartyInvoiceBalance = (
  balances: Record<string, { usd: number; syp: number; ids: string[] }>,
  partyId: unknown,
  invoiceId: unknown,
  usdChange: number,
  sypChange: number,
) => {
  const id = String(partyId || "");
  if (!id) return;

  balances[id] = balances[id] || { usd: 0, syp: 0, ids: [] };
  balances[id].usd = roundMoney(balances[id].usd + usdChange);
  balances[id].syp = roundMoney(balances[id].syp + sypChange);

  if (invoiceId) {
    balances[id].ids.push(String(invoiceId));
  }
};

const getReturnCurrencyInfo = (
  item: AnyRecord,
  invoices: Record<string, AnyRecord>,
) => {
  const invoice = invoices[String(item.referenceId || item.sellId || item.purchaseId || "")];
  const currency = normalizeCurrency(
    item.paymentCurrency || item.currency || invoice?.paymentCurrency || invoice?.currency,
  );
  const exchangeRate =
    inferExchangeRate({
      currency,
      exchangeRate: item.exchangeRate || invoice?.exchangeRate,
      originalAmount: item.amount_base,
      usdAmount: item.returnValue ?? item.totalPrice,
    }) || 1;

  return { currency, exchangeRate };
};

const rebuildCustomerBalances = ({
  customers,
  sells,
  payments,
  returns,
}: {
  customers: Record<string, AnyRecord>;
  sells: Record<string, AnyRecord>;
  payments: Record<string, AnyRecord>;
  returns: Record<string, AnyRecord>;
}) => {
  const balances: Record<string, { usd: number; syp: number; ids: string[] }> = {};

  Object.values(sells).forEach((sell) => {
    addPartyInvoiceBalance(
      balances,
      sell.customerId,
      sell.id,
      -toMoneyNumber(sell.remainingUSD, toMoneyNumber(sell.remainingDebt)),
      -toMoneyNumber(sell.remainingSYP),
    );
  });

  Object.values(payments).forEach((payment) => {
    if (!payment.customerId || payment.sellId || payment.type !== "income") return;

    addPartyInvoiceBalance(
      balances,
      payment.customerId,
      "",
      toMoneyNumber(payment.amountUSD, toMoneyNumber(payment.amount)),
      toMoneyNumber(payment.balanceSYPChange, toMoneyNumber(payment.amountSYP)),
    );
  });

  Object.values(returns).forEach((item) => {
    const isSaleReturn =
      item.type === "sale-return" ||
      item.returnSource === "customer" ||
      Boolean(item.customerId);
    if (!isSaleReturn || !item.customerId) return;

    const returnType = item.returnType || "cash";
    const valueUSD = toMoneyNumber(item.returnValue ?? item.totalPrice);
    const cashUSD =
      returnType === "cash"
        ? valueUSD
        : returnType === "part"
          ? toMoneyNumber(item.partValue)
          : 0;
    const balanceUSDChange =
      returnType === "debt" || returnType === "part"
        ? Math.max(valueUSD - cashUSD, 0)
        : 0;
    const { currency, exchangeRate } = getReturnCurrencyInfo(item, sells);

    addPartyInvoiceBalance(
      balances,
      item.customerId,
      "",
      balanceUSDChange,
      currency === "SYP"
        ? usdToSYPForPaymentCurrency(balanceUSDChange, currency, exchangeRate)
        : 0,
    );
  });

  return Object.entries(customers).map(([id, customer]) => {
    const balance = balances[id] || { usd: 0, syp: 0, ids: [] };
    const next = {
      balance: balance.usd,
      balanceUSD: balance.usd,
      balanceSYP: balance.syp,
      purchases: Array.from(new Set(balance.ids)),
    };

    return { id, patch: buildPatch(customer, next) };
  });
};

const rebuildSupplierBalances = ({
  suppliers,
  purchases,
  payments,
  returns,
}: {
  suppliers: Record<string, AnyRecord>;
  purchases: Record<string, AnyRecord>;
  payments: Record<string, AnyRecord>;
  returns: Record<string, AnyRecord>;
}) => {
  const balances: Record<string, { usd: number; syp: number; ids: string[] }> = {};

  Object.values(purchases).forEach((purchase) => {
    addPartyInvoiceBalance(
      balances,
      purchase.supplierId,
      purchase.id,
      toMoneyNumber(purchase.remainingUSD, toMoneyNumber(purchase.remainingDebt)),
      toMoneyNumber(purchase.remainingSYP),
    );
  });

  Object.values(payments).forEach((payment) => {
    if (!payment.supplierId || payment.purchaseId || payment.type !== "expense") {
      return;
    }

    addPartyInvoiceBalance(
      balances,
      payment.supplierId,
      "",
      toMoneyNumber(payment.amountUSD, toMoneyNumber(payment.amount)),
      toMoneyNumber(payment.balanceSYPChange, toMoneyNumber(payment.amountSYP)),
    );
  });

  Object.values(returns).forEach((item) => {
    const isPurchaseReturn =
      item.type === "purchase-return" ||
      item.returnSource === "supplier" ||
      Boolean(item.supplierId);
    if (!isPurchaseReturn || !item.supplierId) return;

    const returnType = item.returnType || "cash";
    const valueUSD = toMoneyNumber(item.returnValue ?? item.totalPrice);
    const cashUSD =
      returnType === "cash"
        ? valueUSD
        : returnType === "part"
          ? toMoneyNumber(item.partValue)
          : 0;
    const balanceUSDChange =
      returnType === "debt" || returnType === "part"
        ? -Math.max(valueUSD - cashUSD, 0)
        : 0;
    const { currency, exchangeRate } = getReturnCurrencyInfo(item, purchases);

    addPartyInvoiceBalance(
      balances,
      item.supplierId,
      "",
      balanceUSDChange,
      currency === "SYP"
        ? usdToSYPForPaymentCurrency(balanceUSDChange, currency, exchangeRate)
        : 0,
    );
  });

  return Object.entries(suppliers).map(([id, supplier]) => {
    const balance = balances[id] || { usd: 0, syp: 0, ids: [] };
    const next = {
      balance: balance.usd,
      balanceUSD: balance.usd,
      balanceSYP: balance.syp,
      purchases: Array.from(new Set(balance.ids)),
    };

    return { id, patch: buildPatch(supplier, next) };
  });
};

const applyCollectionPatches = async ({
  path,
  patches,
  dryRun,
}: {
  path: string;
  patches: Array<{ id: string; patch: MigrationPatch | null }>;
  dryRun: boolean;
}) => {
  const changed = patches.filter(
    (item) => item.patch && Object.keys(item.patch).length > 0,
  );

  if (!dryRun) {
    for (const item of changed) {
      await update(ref(database, `${path}/${item.id}`), item.patch as MigrationPatch);
    }
  }

  return changed.length;
};

const runCurrencyMigrationInternal = async (dryRun: boolean) => {
  const [sells, purchases, payments, accounts, customers, suppliers, returns] =
    await Promise.all([
      getMap("sells"),
      getMap("purchases"),
      getMap("payment"),
      getMap("accounts"),
      getMap("customer"),
      getMap("supplier"),
      getMap("returns"),
    ]);

  const warnings: string[] = [];
  const normalizedSells: Record<string, AnyRecord> = {};
  const normalizedPurchases: Record<string, AnyRecord> = {};
  const normalizedPayments: Record<string, AnyRecord> = {};

  const sellPatches = Object.entries(sells).map(([id, sell]) => {
    const result = buildInvoicePatch(sell, "sell");
    if (result.warning) warnings.push(result.warning);
    normalizedSells[id] = result.normalized || sell;
    return { id, patch: result.patch };
  });

  const purchasePatches = Object.entries(purchases).map(([id, purchase]) => {
    const result = buildInvoicePatch(purchase, "purchase");
    if (result.warning) warnings.push(result.warning);
    normalizedPurchases[id] = result.normalized || purchase;
    return { id, patch: result.patch };
  });

  const paymentPatches = Object.entries(payments).map(([id, payment]) => {
    const result = buildPaymentPatch(payment);
    if (result.warning) warnings.push(result.warning);
    normalizedPayments[id] = result.normalized || payment;
    return { id, patch: result.patch };
  });

  const accountPatches = Object.entries(accounts).map(([id, account]) => ({
    id,
    patch: buildPatch(account, normalizeAccountBalances(account as any)),
  }));
  const customerPatches = rebuildCustomerBalances({
    customers,
    sells: normalizedSells,
    payments: normalizedPayments,
    returns,
  });
  const supplierPatches = rebuildSupplierBalances({
    suppliers,
    purchases: normalizedPurchases,
    payments: normalizedPayments,
    returns,
  });

  const summary = {
    dryRun,
    sells: await applyCollectionPatches({
      path: "sells",
      patches: sellPatches,
      dryRun,
    }),
    purchases: await applyCollectionPatches({
      path: "purchases",
      patches: purchasePatches,
      dryRun,
    }),
    payments: await applyCollectionPatches({
      path: "payment",
      patches: paymentPatches,
      dryRun,
    }),
    accounts: await applyCollectionPatches({
      path: "accounts",
      patches: accountPatches,
      dryRun,
    }),
    customers: await applyCollectionPatches({
      path: "customer",
      patches: customerPatches,
      dryRun,
    }),
    suppliers: await applyCollectionPatches({
      path: "supplier",
      patches: supplierPatches,
      dryRun,
    }),
    warnings,
  };

  return summary;
};

const requireAdmin = (req: Request, res: Response) => {
  const currentUser = getCurrentUserFromRequest(req);

  if (!currentUser) {
    res.status(401).json({ error: "Unauthorized" });
    return null;
  }

  if (currentUser.role !== "admin") {
    res.status(403).json({ error: "Admin permission is required" });
    return null;
  }

  return currentUser;
};

export const previewCurrencyMigration = async (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;

  try {
    const summary = await runCurrencyMigrationInternal(true);
    res.json(summary);
  } catch (error: any) {
    console.error("Currency migration preview failed:", error);
    res.status(500).json({ error: error.message });
  }
};

export const runCurrencyMigration = async (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;

  try {
    const summary = await runCurrencyMigrationInternal(false);
    res.json(summary);
  } catch (error: any) {
    console.error("Currency migration failed:", error);
    res.status(500).json({ error: error.message });
  }
};

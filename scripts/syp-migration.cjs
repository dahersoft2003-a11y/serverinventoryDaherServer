/* Offline migration: reads a Firebase export and writes a separate reviewed file.
   No network access, exchange rates, or writes to the source database. */
const fs = require("node:fs");
const crypto = require("node:crypto");
const path = require("node:path");
const SCHEMA = "syp-v1";
const round = (n) => Math.round((n + Number.EPSILON) * 1000) / 1000;
const number = (n) => typeof n === "number" && Number.isFinite(n);
const currency = (r) =>
  String(r?.paymentCurrency || r?.currency || "USD").toUpperCase();
const values = (r) => Object.values(r || {});
const pointer = (parent, key) =>
  `${parent}/${String(key).replace(/~/g, "~0").replace(/\//g, "~1")}`;
const names = {
  totalUSD: "totalPrice",
  totalSYP: "totalPrice",
  totalOriginal: "totalPrice",
  subtotalUSD: "subtotal",
  paidUSD: "paidAmount",
  paidSYP: "paidAmount",
  paidOriginal: "paidAmount",
  remainingUSD: "remainingDebt",
  remainingSYP: "remainingDebt",
  remainingOriginal: "remainingDebt",
  amountUSD: "amount",
  amountSYP: "amount",
  amountOriginal: "amount",
  amount_base: "amount",
  balanceUSD: "balance",
  balanceSYP: "balance",
  balanceUSDChange: "balanceChange",
  balanceSYPChange: "balanceChange",
  currentBalanceUSD: "currentBalance",
  currentBalanceSYP: "currentBalance",
  openingBalanceUSD: "openingBalance",
  openingBalanceSYP: "openingBalance",
  discountUSD: "discount",
  discountSYP: "discount",
  discountOriginal: "discount",
  discountAmountUSD: "discountAmount",
  discountPercentUSD: "discountPercentAmount",
  originalTotalUSD: "originalTotal",
  originalSubtotalUSD: "originalSubtotal",
  originalDiscountUSD: "originalDiscount",
  commissionUSD: "commissionAmount",
  commissionOriginal: "commissionAmount",
  lineTotalOriginal: "lineTotalAmount",
};
const target = (key) => names[key] || key.replace(/USD/g, "Amount");
const isMoney = (key) =>
  (/USD|SYP|Original$/.test(key) && !/currency/i.test(key)) ||
  /^(?:payPrice|sellPrice|wholesalePrice|superWholesalePrice|totalPrice|totalCost|totalValue|lineTotal|amount|amount_base|balance|openingBalance|currentBalance|remainingDebt|paidAmount|partValue|discount|returnValue|cost|debit|credit|settlementPrice|transferCost|transportCost)$/.test(
    key,
  );
const ignored = new Set([
  "exchangeRate",
  "priceCurrency",
  "paymentCurrency",
  "exchangeDifference",
  "finalRate",
  "realRate",
]);
const excluded = new Set([
  "exchange",
  "doneExchange",
  "invoiceDrafts",
  "invoiceDraft",
  "financialRequests",
  "ai",
  "aiReports",
  "analytics",
]);

function planMigration(source, supplied = {}) {
  if (source.system?.moneySchema === SCHEMA)
    throw new Error("This export is already migrated.");
  const rows = [],
    missing = [],
    adjustments = [];
  const approved = new Map(
    (supplied.entries || []).map((row) => [row.path, row.valueSYP]),
  );
  const dollarParty = (kind, id) => {
    const field = kind === "customer" ? "customerId" : "supplierId";
    return [
      ...values(source.sells),
      ...values(source.purchases),
      ...values(source.payment),
    ].some((r) => r[field] === id && currency(r) !== "SYP");
  };
  const dollarAccount = (id) =>
    values(source.journalEntries).some((j) =>
      (j.lines || []).some((l) => l.accountId === id && currency(l) !== "SYP"),
    );
  function amount(rowPath, record, keys, originalCurrency, context) {
    const entries = keys
      .map((key) => [key, record[key]])
      .filter(([, v]) => v !== undefined && v !== null);
    if (!entries.length) return 0;
    let preserved;
    const safe = entries.find(([key]) => /SYP/.test(key));
    const native = entries.find(
      ([key]) =>
        /Original$/.test(key) ||
        ["amount_base", "partValue", "settlementPrice", "openingCashOriginal"].includes(
          key,
        ),
    );
    const old = entries.find(([key]) => /USD/.test(key)) || entries[0];
    if (entries.every(([, v]) => Number(v) === 0)) preserved = 0;
    if (originalCurrency === "SYP") {
      if (safe && number(Number(safe[1]))) preserved = Number(safe[1]);
      else if (native && number(Number(native[1]))) preserved = Number(native[1]);
      else if (["debit", "credit"].includes(keys[0]) && record.amountSYP !== undefined)
        preserved = Number(old[1]) === 0 ? 0 : Math.abs(Number(record.amountSYP));
    }
    if (/\/(customer|supplier)\/[^/]+\/balance$/.test(rowPath)) {
      const [, kind, id] = rowPath.split("/");
      if (!dollarParty(kind, id) && record.balanceSYP !== undefined)
        preserved = Number(record.balanceSYP);
      else if (dollarParty(kind, id)) preserved = undefined;
    }
    if (/\/accounts\/[^/]+\/currentBalance$/.test(rowPath)) {
      const id = rowPath.split("/")[2];
      if (!dollarAccount(id) && record.currentBalanceSYP !== undefined)
        preserved = Number(record.currentBalanceSYP);
      else if (dollarAccount(id)) preserved = undefined;
    }
    const manual = approved.get(rowPath);
    const chosen = number(manual) ? manual : preserved;
    const row = {
      path: rowPath,
      label: record.name || record.code || context,
      originalCurrency,
      oldAmount: old[1],
      savedSYP: safe?.[1] ?? null,
      valueSYP: chosen ?? null,
      requiresManual: preserved === undefined,
    };
    rows.push(row);
    if (!number(chosen)) {
      missing.push(rowPath);
      return 0;
    }
    if (Math.abs(chosen) > 1e12) throw new Error(`Amount too large: ${rowPath}`);
    return round(chosen);
  }
  function visit(record, at = "", inherited = "USD") {
    if (!record || typeof record !== "object") return record;
    if (Array.isArray(record))
      return record.map((r, i) => visit(r, pointer(at, i), inherited));
    const originalCurrency =
      record.currency || record.paymentCurrency ? currency(record) : inherited;
    const result = {},
      groups = new Map();
    for (const [key, v] of Object.entries(record)) {
      if ((!at && excluded.has(key)) || ignored.has(key)) continue;
      if (
        key.startsWith("openingBalance") &&
        /^\/(accounts|customer|supplier)\/[^/]+$/.test(at)
      )
        continue;
      if (key === "currency") {
        result.currency = "SYP";
        continue;
      }
      if (isMoney(key) && (v === null || typeof v !== "object")) {
        const name = target(key);
        if (!groups.has(name)) groups.set(name, []);
        groups.get(name).push(key);
      } else result[key] = visit(v, pointer(at, key), originalCurrency);
    }
    for (const [key, aliases] of groups)
      result[key] = amount(pointer(at, key), record, aliases, originalCurrency, at);
    if (record.paymentCurrency || record.priceCurrency) result.currency = "SYP";
    return result;
  }
  const output = visit(source);
  for (const collection of [
    "sells",
    "purchases",
    "customer",
    "supplier",
    "accounts",
    "payment",
    "journalEntries",
    "returns",
    "quotations",
    "driverCashMovements",
  ]) {
    for (const [id, record] of Object.entries(output[collection] || {}))
      record.id ||= id;
  }
  const blockers = values(source.exchange).length
    ? ["Resolve pending exchanges in the old system before exporting."]
    : [];
  if (!missing.length) {
    for (const collection of ["sells", "purchases"])
      for (const [id, invoice] of Object.entries(output[collection] || {})) {
        if (
          !number(invoice.totalPrice) ||
          !number(invoice.remainingDebt) ||
          invoice.remainingDebt < 0 ||
          invoice.remainingDebt > invoice.totalPrice + 0.001
        )
          blockers.push(`Invalid invoice totals: /${collection}/${id}`);
        invoice.paidAmount = round(invoice.totalPrice - invoice.remainingDebt);
        invoice.partValue = invoice.paidAmount;
        invoice.currency = "SYP";
        const lines = invoice.products;
        if (Array.isArray(lines) && lines.length) {
          const subtotal = round(
            lines.reduce(
              (sum, l) =>
                sum +
                Number(l.qty ?? l.quantity ?? 0) *
                  Number(collection === "sells" ? l.sellPrice : l.payPrice),
              0,
            ),
          );
          if (
            Math.abs(subtotal - Number(invoice.discount || 0) - invoice.totalPrice) >
            0.001
          )
            blockers.push(`Line prices do not match total: /${collection}/${id}`);
        }
      }
    const net = {};
    for (const [id, journal] of Object.entries(output.journalEntries || {})) {
      const lines = journal.lines || [];
      if (
        Math.abs(
          lines.reduce(
            (sum, l) => sum + Number(l.debit || 0) - Number(l.credit || 0),
            0,
          ),
        ) > 0.001
      )
        blockers.push(`Unbalanced journal: ${id}`);
      for (const line of lines) {
        if (line.debit < 0 || line.credit < 0 || (line.debit && line.credit))
          blockers.push(`Invalid journal line: ${id}`);
        net[line.accountId] = round(
          (net[line.accountId] || 0) +
            Number(line.debit || 0) -
            Number(line.credit || 0),
        );
      }
    }
    for (const [id, a] of Object.entries(output.accounts || {})) {
      const change =
        (net[id] || 0) *
        (a.nature === "Debit" || (!a.nature && ["Asset", "Expense"].includes(a.type))
          ? 1
          : -1);
      a.openingBalance = round(Number(a.currentBalance || 0) - change);
      a.currency = "SYP";
      adjustments.push({
        path: `/accounts/${id}/openingBalance`,
        valueSYP: a.openingBalance,
      });
    }
    for (const kind of ["customer", "supplier"])
      for (const [id, party] of Object.entries(output[kind] || {})) {
        const invoices = values(
          output[kind === "customer" ? "sells" : "purchases"],
        ).filter((r) => r[kind === "customer" ? "customerId" : "supplierId"] === id);
        const direct = values(output.payment).filter(
          (r) =>
            r[kind === "customer" ? "customerId" : "supplierId"] === id &&
            !r.sellId &&
            !r.purchaseId,
        );
        const computed = round(
          (kind === "customer" ? -1 : 1) *
            invoices.reduce((s, r) => s + Number(r.remainingDebt || 0), 0) +
            direct.reduce((s, r) => s + Number(r.balanceChange ?? r.amount ?? 0), 0),
        );
        party.openingBalance = round(Number(party.balance || 0) - computed);
        party.purchases = invoices.map((r) => r.id).filter(Boolean);
        adjustments.push({
          path: `/${kind}/${id}/openingBalance`,
          valueSYP: party.openingBalance,
        });
      }
  }
  output.system = { ...output.system, moneySchema: SCHEMA };
  return {
    output,
    entries: rows,
    missing,
    blockers,
    openingBalances: adjustments,
    archivedCollections: [...excluded].filter((k) => source[k]),
  };
}
module.exports = { planMigration, SCHEMA };

if (require.main === module) {
  try {
    const [mode, input, reviewFile, outputFile] = process.argv.slice(2);
    if (
      !["preview", "prepare"].includes(mode) ||
      !input ||
      !reviewFile ||
      (mode === "prepare" && !outputFile)
    )
      throw new Error(
        "Usage: node scripts/syp-migration.cjs preview export.json review.json | prepare export.json review.json migrated.json",
      );
    const raw = fs.readFileSync(input, "utf8").replace(/^\uFEFF/, ""),
      source = JSON.parse(raw);
    const sourceHash = crypto.createHash("sha256").update(raw).digest("hex");
    const review =
      mode === "prepare"
        ? JSON.parse(fs.readFileSync(reviewFile, "utf8").replace(/^\uFEFF/, ""))
        : {};
    if (
      mode === "prepare" &&
      (review.sourceHash !== sourceHash || review.approved !== true)
    )
      throw new Error("Review must match the export and have approved:true.");
    const result = planMigration(source, review);
    const destination = mode === "preview" ? reviewFile : outputFile;
    if (
      path.resolve(destination) === path.resolve(input) ||
      (mode === "prepare" && path.resolve(destination) === path.resolve(reviewFile))
    )
      throw new Error("Output must be a separate file.");
    if (mode === "prepare" && (result.missing.length || result.blockers.length))
      throw new Error(
        JSON.stringify({ missing: result.missing, blockers: result.blockers }, null, 2),
      );
    const data =
      mode === "preview"
        ? {
            sourceHash,
            approved: false,
            entries: result.entries,
            blockers: result.blockers,
            archivedCollections: result.archivedCollections,
            instructions:
              "Fill every null valueSYP with a manually chosen lira amount. Balance fields are FINAL balances including savedSYP. Review opening balances before import.",
          }
        : result.output;
    fs.writeFileSync(destination, JSON.stringify(data, null, 2), { flag: "wx" });
    if (mode === "prepare")
      fs.writeFileSync(
        `${destination}.report.json`,
        JSON.stringify(
          {
            sourceHash,
            openingBalances: result.openingBalances,
            archivedCollections: result.archivedCollections,
          },
          null,
          2,
        ),
        { flag: "wx" },
      );
    console.log(
      JSON.stringify({
        file: destination,
        missing: result.missing.length,
        blockers: result.blockers,
        entries: result.entries.length,
      }),
    );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

// Load the real transaction orchestration against an in-memory RTDB adapter.
// No Firebase configuration, credentials or network requests are loaded.
let state;
let reads = 0;
let commits = 0;
const clone = value => JSON.parse(JSON.stringify(value));
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (parent?.filename.replace(/\\/g, "/").endsWith("/dist/functions/transactions.js")) {
    if (request.startsWith("../controllers/")) return {};
    if (request === "../firebaseConfig") return { database: {} };
    if (request === "../utils/driverCommission") return { prepareDriverPayment: () => { throw new Error("Management payments must not snapshot a driver's commission"); } };
    if (request === "firebase/database") return {
      ref: () => ({}),
      get: async () => { reads++; return { exists: () => Boolean(state), val: () => clone(state) }; },
      runTransaction: async (_ref, updater) => {
        updater(null); // Exercise the locally empty first callback.
        state = updater(clone(state)); // Exercise a transaction retry with the latest state.
        commits++;
        return { committed: true };
      },
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};
let customerPayment;
let supplierPayment;
try { ({ customerPayment, supplierPayment } = require("../dist/functions/transactions")); }
finally { Module._load = originalLoad; }

const fixture = () => ({
  customer: { c: { id: "c", balanceUSD: -100, balance: -100 } },
  supplier: { u: { id: "u", balanceUSD: 100, balance: 100 } },
  sells: { s: { id: "s", customerId: "c", totalUSD: 100, totalPrice: 100, remainingDebt: 100, currency: "USD", exchangeRate: 1 } },
  purchases: { b: { id: "b", supplierId: "u", totalUSD: 100, totalPrice: 100, remainingDebt: 100, currency: "USD", exchangeRate: 1 } },
  accounts: {
    cash: { type: "Asset", category: "Cash", nature: "Debit", currency: "USD", currentBalance: 1000 },
    ar: { type: "Asset", category: "AccountsReceivable", nature: "Debit", currency: "USD", currentBalance: 100 },
    ap: { type: "Liability", category: "AccountsPayable", nature: "Credit", currency: "USD", currentBalance: 100 },
  }, payment: {}, journalEntries: {},
});
const reset = () => { state = fixture(); reads = 0; commits = 0; };
const payload = extra => ({ type: "income", customerId: "c", paymentAccountId: "cash", receivableAccountId: "ar", currency: "USD", exchangeRate: 1, amount: 20, amountUSD: 20, amountOriginal: 20, amount_base: 20, note: "Payment", collectorId: "clerk", collectorName: "Clerk", createdBy: "clerk", ...extra });

test("real cash orchestration normalizes incoming customer and outgoing supplier payments and commits once each", async () => {
  reset();
  const incoming = await customerPayment(payload({ sellId: "s", requestId: "customer-payment-1" }));
  assert.equal(incoming.payment.collectionSource, "management"); assert.equal(incoming.payment.commissionUSD, 0);
  assert.equal(incoming.payment.collectorId, "clerk"); assert.equal(incoming.sell.remainingDebt, 80);
  const outgoing = await supplierPayment(payload({ customerId: undefined, receivableAccountId: undefined, supplierId: "u", purchaseId: "b", payableAccountId: "ap", amount: -20, amountUSD: -20, requestId: "supplier-payment-1" }));
  assert.equal(outgoing.payment.amountOriginal, -20); assert.equal(outgoing.payment.type, "expense");
  assert.equal(outgoing.purchase.remainingDebt, 80); assert.equal(state.accounts.cash.currentBalanceUSD, 1000);
  assert.equal(commits, 2); assert.equal(Object.keys(state.payment).length, 2); assert.equal(Object.keys(state.journalEntries).length, 2);
});

test("real cash orchestration keeps retries stable across generated dates and ids and scopes request ids to the actor", async () => {
  reset();
  const request = payload({ sellId: "s", requestId: "receipt-retry-1" });
  const first = await customerPayment(request);
  const second = await customerPayment(request);
  assert.equal(second.duplicate, true); assert.equal(second.payment.id, first.payment.id); assert.equal(second.payment.date, first.payment.date);
  assert.equal(state.sells.s.remainingDebt, 80); assert.equal(Object.keys(state.journalEntries).length, 1);
  await assert.rejects(() => customerPayment({ ...request, amountOriginal: 30, amount_base: 30 }), /دفعة مختلفة/);
  assert.equal(state.sells.s.remainingDebt, 80);
  await customerPayment({ ...request, collectorId: "other-clerk", createdBy: "other-clerk" });
  assert.equal(state.sells.s.remainingDebt, 60); assert.equal(Object.keys(state.payment).length, 2);
});

test("party mismatch and malformed money fail before any RTDB read or transaction", async () => {
  reset();
  await assert.rejects(() => supplierPayment(payload({})), /نوع الطرف/);
  await assert.rejects(() => customerPayment(payload({ amountOriginal: "bad" })), /رقمًا صالحًا/);
  assert.equal(reads, 0); assert.equal(commits, 0); assert.equal(Object.keys(state.payment).length, 0);
});

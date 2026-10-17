const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

let state;
let commits = 0;
const clone = (value) => JSON.parse(JSON.stringify(value));
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (parent?.filename.replace(/\\/g, "/").endsWith("/dist/functions/transactions.js")) {
    if (request.startsWith("../controllers/")) return {};
    if (request === "../firebaseConfig") return { database: {} };
    if (request === "../utils/driverCommission") return {};
    if (request === "firebase/database") return {
      ref: (_db, path) => path || "",
      get: async () => ({ exists: () => Boolean(state), val: () => clone(state) }),
      runTransaction: async (_ref, update) => {
        update(null);
        const next = update(clone(state));
        if (next === undefined) return { committed: false };
        state = next;
        commits++;
        return { committed: true, snapshot: { val: () => clone(state) } };
      },
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};
let handleSell;
try { ({ handleSell } = require("../dist/functions/transactions")); }
finally { Module._load = originalLoad; }

const fixture = () => ({
  products: { W: { p1: { id: "p1", code: "P1", name: "first", warehouse: "W", quantity: 2, reservedQuantity: 0, payPrice: 4, sellPrice: 10 },
    p2: { id: "p2", code: "P2", name: "second", warehouse: "W", quantity: 1, reservedQuantity: 0, payPrice: 5, sellPrice: 20 } } },
  customer: { c1: { id: "c1", balance: 0, balanceUSD: 0, purchases: [] } },
  accounts: { sales: { type: "Revenue", category: "SalesRevenue", nature: "Credit", currentBalanceUSD: 0 },
    cash: { type: "Asset", category: "Cash", nature: "Debit", currentBalanceUSD: 0 },
    ar: { type: "Asset", category: "AccountsReceivable", nature: "Debit", currentBalanceUSD: 0 } },
  sells: {}, payment: {}, journalEntries: {}, financialRequests: {},
});
const invoice = (extra = {}) => ({ requestId: "sale_request_1", customerId: "c1", paymentStatus: "cash", currency: "USD", exchangeRate: 1,
  partValue: 10, salesAccountId: "sales", paymentAccountId: "cash", receivableAccountId: "ar",
  products: [{ id: "p1", code: "P1", warehouse: "W", qty: 1, sellPrice: 10, selectedPriceType: "sellPrice" }], ...extra });

test("normal sale route handler commits all records once and replay after stock depletion returns same sale", async () => {
  state = fixture(); commits = 0;
  const request = { newSell: invoice({ products: [{ id: "p1", code: "P1", warehouse: "W", qty: 2, sellPrice: 10, selectedPriceType: "sellPrice" }] }) };
  const first = await handleSell(request);
  const replay = await handleSell(request);
  assert.equal(first.id, replay.id);
  assert.equal(state.products.W.p1.quantity, 0);
  assert.equal(state.accounts.cash.currentBalanceUSD, 20);
  assert.equal(Object.keys(state.sells).length, 1);
  assert.equal(Object.keys(state.payment).length, 1);
  assert.equal(commits, 2);
});

test("failed second product aborts whole invoice before stock, customer or accounting commit", async () => {
  state = fixture(); commits = 0;
  const before = clone(state);
  await assert.rejects(() => handleSell({ newSell: invoice({ products: [
    { id: "p1", code: "P1", warehouse: "W", qty: 1, sellPrice: 10 },
    { id: "p2", code: "P2", warehouse: "W", qty: 2, sellPrice: 20 },
  ] }) }), /الكمية المتاحة/);
  assert.deepEqual(state, before);
  assert.equal(commits, 0);
});

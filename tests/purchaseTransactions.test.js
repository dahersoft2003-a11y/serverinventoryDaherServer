const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
let state;
let commits = 0;
const clone = (value) => JSON.parse(JSON.stringify(value));
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (
    parent?.filename.replace(/\\/g, "/").endsWith("/dist/functions/transactions.js")
  ) {
    if (request.startsWith("../controllers/")) return {};
    if (request === "../firebaseConfig") return { database: {} };
    if (request === "../utils/driverCommission") return {};
    if (request === "firebase/database")
      return {
        ref: (_db, path) => path || "",
        get: async () => ({ exists: () => Boolean(state), val: () => clone(state) }),
        runTransaction: async (_ref, update) => {
          update(null); // Initial local state is empty; the server snapshot must still be used.
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
let handlePurchase;
let handleBulkPurchase;
try {
  ({ handlePurchase, handleBulkPurchase } = require("../dist/functions/transactions"));
} finally {
  Module._load = originalLoad;
}
const fixture = () => ({
  products: {
    W: {
      p1: {
        id: "p1",
        name: "منتج",
        code: "P1",
        warehouse: "W",
        quantity: 0,
        reservedQuantity: 0,
        payPrice: 0,
      },
      p2: {
        id: "p2",
        name: "ثان",
        code: "P2",
        warehouse: "W",
        quantity: 0,
        reservedQuantity: 0,
        payPrice: 0,
      },
    },
  },
  supplier: { s1: { id: "s1", balance: 0, purchases: [] } },
  accounts: {
    inventory: {
      id: "inventory",
      type: "Asset",
      nature: "Debit",
      category: "Inventory",
      currentBalance: 0,
    },
    payable: {
      id: "payable",
      type: "Liability",
      nature: "Credit",
      category: "AccountsPayable",
      currentBalance: 0,
    },
    cash: {
      id: "cash",
      type: "Asset",
      nature: "Debit",
      category: "Cash",
      currentBalance: 100,
    },
  },
  purchases: {},
  payment: {},
  journalEntries: {},
  financialRequests: {},
});
const item = (id = "p1", code = "P1") => ({
  id,
  name: "منتج",
  code,
  warehouse: "W",
  quantity: 2,
  payPrice: 10,
  sellPrice: 15,
});
const invoice = (extra = {}) => ({
  requestId: "purchase_request_1",
  supplierId: "s1",
  name: "منتج",
  code: "P1",
  warehouse: "W",
  quantity: 2,
  payPrice: 10,
  totalPrice: 20,
  paymentStatus: "cash",
  remainingDebt: 0,
  partValue: 20,
  currency: "SYP",
  inventoryAccountId: "inventory",
  payableAccountId: "payable",
  paymentAccountId: "cash",
  ...extra,
});
test("single-product purchase commits once and retry returns the same invoice", async () => {
  state = fixture();
  commits = 0;
  const request = { newPurchase: invoice(), newProduct: item() };
  const first = await handlePurchase(request);
  const replay = await handlePurchase(request);
  assert.equal(first.id, replay.id);
  assert.equal(state.products.W.p1.quantity, 2);
  assert.equal(state.accounts.inventory.currentBalance, 20);
  assert.equal(state.accounts.cash.currentBalance, 80);
  assert.equal(Object.keys(state.purchases).length, 1);
  assert.equal(Object.keys(state.payment).length, 1);
  assert.equal(commits, 2); // The replay commits the unchanged root snapshot.
});
test("bulk purchase validates every line before committing any accounting records", async () => {
  state = fixture();
  commits = 0;
  const products = [item(), item("p2", "P2")].map((product) => ({
    ...product,
    lineTotal: 20,
  }));
  await assert.rejects(
    () =>
      handleBulkPurchase({
        newPurchase: invoice({
          requestId: "bulk_request_1",
          products,
          totalPrice: 10,
          quantity: 4,
          payPrice: 0,
        }),
      }),
    /إجمالي/,
  );
  assert.equal(commits, 0);
  const saved = await handleBulkPurchase({
    newPurchase: invoice({
      requestId: "bulk_request_1",
      products,
      totalPrice: 40,
      quantity: 4,
      payPrice: 0,
      partValue: 40,
    }),
  });
  assert.equal(saved.totalPrice, 40);
  assert.equal(state.products.W.p1.quantity, 2);
  assert.equal(state.products.W.p2.quantity, 2);
  assert.equal(state.accounts.inventory.currentBalance, 40);
  assert.equal(state.accounts.cash.currentBalance, 60);
  assert.equal(Object.keys(state.purchases).length, 1);
});

const test = require("node:test");
const assert = require("node:assert/strict");

const firebaseModule = require.resolve("firebase/database");
const configModule = require.resolve("../dist/firebaseConfig");
let state = {};
let touched = [];
const snapshot = (value) => ({ exists: () => value !== undefined && value !== null, val: () => value });
const firebase = {
  ref: (_db, path) => path || "",
  get: async (path) => snapshot(path === "products" ? state.products : undefined),
  push: () => ({ key: "new-product" }),
  runTransaction: async (path, update) => {
    touched.push(path);
    const next = update(state.products?.W || null);
    if (next === undefined) return { committed: false, snapshot: snapshot(state.products?.W) };
    state.products ||= {};
    state.products.W = next;
    return { committed: true, snapshot: snapshot(next) };
  },
};
require.cache[firebaseModule] = { id: firebaseModule, filename: firebaseModule, loaded: true, exports: firebase };
require.cache[configModule] = { id: configModule, filename: configModule, loaded: true, exports: { database: {} } };
const { createCatalogProduct } = require("../dist/controllers/products.controller");
const response = () => ({ code: 200, status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } });
const product = (extra = {}) => ({ name: "منتج", code: "P1", category: "صنف", warehouse: "W", unit: "قطعة", payPrice: 10, quantity: 99, reservedQuantity: 15, ...extra });

test("catalog creation stores zero stock and no purchase or financial records", async () => {
  state = {}; touched = [];
  const res = response();
  await createCatalogProduct({ body: product() }, res);
  assert.equal(res.code, 201);
  assert.equal(state.products.W["new-product"].quantity, 0);
  assert.equal(state.products.W["new-product"].reservedQuantity, 0);
  assert.equal(state.products.W["new-product"].payPrice, 10);
  assert.deepEqual(touched, ["products/W"]);
  assert.equal(state.purchases, undefined);
  assert.equal(state.payment, undefined);
  assert.equal(state.accounts, undefined);
});

test("duplicate product code in the same warehouse is rejected without changing the list", async () => {
  state = { products: { W: { existing: { code: "p1", quantity: 4 } } } }; touched = [];
  const before = JSON.stringify(state);
  const res = response();
  await createCatalogProduct({ body: product({ code: " P1 " }) }, res);
  assert.equal(res.code, 409);
  assert.equal(JSON.stringify(state), before);
});

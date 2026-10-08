const test = require('node:test');
const assert = require('node:assert/strict');

// Exercise controller transaction callbacks with in-memory Firebase substitutes.
// The real database module is never initialized or called by these tests.
const firebaseModule = require.resolve('firebase/database');
const configModule = require.resolve('../dist/firebaseConfig');
let seed;
let latest;
let firstProposed;
const snapshot = (value) => ({ exists: () => value != null, val: () => value });
const fakeFirebase = {
  ref: (_database, path) => path || '',
  get: async (path) => snapshot(path === 'products' ? { W: { p1: seed } } : path === 'products/W' ? { p1: seed } : seed),
  runTransaction: async (_path, callback) => {
    firstProposed = callback(null);
    const committed = callback(latest);
    latest = committed;
    return { committed: true, snapshot: snapshot(committed) };
  },
};
require.cache[firebaseModule] = { id: firebaseModule, filename: firebaseModule, loaded: true, exports: fakeFirebase };
require.cache[configModule] = { id: configModule, filename: configModule, loaded: true, exports: { database: {} } };
const { reserveProductQuantityInternal, releaseReservedQuantityInternal, settleReservedQuantityOnSellInternal, createOrUpdateProductInternal, updateProduct } = require('../dist/controllers/products.controller');

test('reservation callback retries after a concurrent goods delivery using latest stock and cost', async () => {
  seed = { id: 'p1', quantity: 20, reservedQuantity: 2, payPrice: 4 };
  latest = { ...seed, quantity: 10, payPrice: 4.8 };
  const result = await reserveProductQuantityInternal('p1', 'W', 5);
  assert.equal(firstProposed.quantity, 20);
  assert.equal(result.quantity, 10);
  assert.equal(result.reservedQuantity, 7);
  assert.equal(result.payPrice, 4.8);
});
test('release callback preserves a concurrent goods receipt rather than replacing the product snapshot', async () => {
  seed = { id: 'p1', quantity: 20, reservedQuantity: 7, payPrice: 4 };
  latest = { ...seed, quantity: 30, payPrice: 4.333333 };
  const result = await releaseReservedQuantityInternal('p1', 'W', 5);
  assert.equal(result.quantity, 30);
  assert.equal(result.reservedQuantity, 2);
  assert.equal(result.payPrice, 4.333333);
});
test('reserved sale retry respects concurrent goods delivery and consumes the current quantity once', async () => {
  seed = { id: 'p1', quantity: 20, reservedQuantity: 7, payPrice: 4 };
  latest = { ...seed, quantity: 12, payPrice: 4.8 };
  const result = await settleReservedQuantityOnSellInternal('p1', 'W', 3, 5);
  assert.equal(result.quantity, 9);
  assert.equal(result.reservedQuantity, 2);
  assert.equal(result.payPrice, 4.8);
});
test('reservation callback rejects a request that only the stale snapshot can fulfill', async () => {
  seed = { id: 'p1', quantity: 20, reservedQuantity: 2, payPrice: 4 };
  latest = { ...seed, quantity: 10 };
  await assert.rejects(() => reserveProductQuantityInternal('p1', 'W', 9), /Insufficient available/);
  assert.equal(latest.quantity, 10);
  assert.equal(latest.reservedQuantity, 2);
});
test('purchase merge adds quantity to the latest stock and preserves current reservations', async () => {
  seed = { id: 'p1', code: 'P1', warehouse: 'W', quantity: 20, reservedQuantity: 2, payPrice: 4 };
  latest = { ...seed, quantity: 10, reservedQuantity: 7, payPrice: 4.8 };
  const result = await createOrUpdateProductInternal({ code: 'P1', warehouse: 'W', name: 'صنف', quantity: 5, payPrice: 6 });
  assert.equal(result.quantity, 15);
  assert.equal(result.reservedQuantity, 7);
  assert.equal(result.payPrice, 6);
  assert.equal(result.id, 'p1');
  assert.equal('alertQuantity' in result, false);
});
test('purchase merge keeps current cost when the purchase payload does not specify a cost', async () => {
  seed = { id: 'p1', code: 'P1', warehouse: 'W', quantity: 20, reservedQuantity: 2, payPrice: 4 };
  latest = { ...seed, quantity: 30, payPrice: 4.333333 };
  const result = await createOrUpdateProductInternal({ code: 'P1', warehouse: 'W', name: 'صنف', quantity: 5 });
  assert.equal(result.quantity, 35);
  assert.equal(result.payPrice, 4.333333);
});
test('metadata edit merges current stock and cost when concurrent goods movement changed them', async () => {
  seed = { id: 'p1', code: 'P1', warehouse: 'W', name: 'old', quantity: 20, reservedQuantity: 2, payPrice: 4 };
  latest = { ...seed, quantity: 10, reservedQuantity: 7, payPrice: 4.8 };
  const response = { status() { return this; }, json(body) { this.body = body; return this; } };
  await updateProduct({ params: { id: 'p1' }, body: { name: 'new' } }, response);
  assert.equal(response.body.data.name, 'new');
  assert.equal(response.body.data.quantity, 10);
  assert.equal(response.body.data.reservedQuantity, 7);
  assert.equal(response.body.data.payPrice, 4.8);
});

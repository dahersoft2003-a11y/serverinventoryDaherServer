const test = require('node:test');
const assert = require('node:assert/strict');
const { calculateReservationStock } = require('../dist/utils/reservationStock');

const product = (overrides = {}) => ({ id: 'p1', quantity: 20, reservedQuantity: 2, payPrice: 4, name: 'صنف', ...overrides });

test('reservation uses the latest delivered stock and preserves current cost', () => {
  const latest = product({ quantity: 10, payPrice: 4.8 });
  const result = calculateReservationStock(latest, { type: 'reserve', quantity: 5 });
  assert.equal(result.quantity, 10);
  assert.equal(result.reservedQuantity, 7);
  assert.equal(result.payPrice, 4.8);
  assert.equal(latest.reservedQuantity, 2);
});
test('reservation retry refuses stock that became unavailable after goods delivery', () => {
  const firstRead = product();
  assert.equal(calculateReservationStock(firstRead, { type: 'reserve', quantity: 9 }).reservedQuantity, 11);
  const afterGoods = product({ quantity: 10 });
  assert.throws(() => calculateReservationStock(afterGoods, { type: 'reserve', quantity: 9 }), /Insufficient available/);
  assert.equal(afterGoods.quantity, 10);
  assert.equal(afterGoods.reservedQuantity, 2);
});
test('release preserves quantity and updated cost after a concurrent goods receipt', () => {
  const latest = product({ quantity: 30, reservedQuantity: 7, payPrice: 4.333333 });
  const result = calculateReservationStock(latest, { type: 'release', quantity: 5 });
  assert.equal(result.quantity, 30);
  assert.equal(result.reservedQuantity, 2);
  assert.equal(result.payPrice, 4.333333);
});
test('settled reservation consumes sold stock and releases unused reserved quantity once', () => {
  const result = calculateReservationStock(product({ quantity: 12, reservedQuantity: 7 }), { type: 'settle', quantity: 5, soldQuantity: 3 });
  assert.equal(result.quantity, 9);
  assert.equal(result.reservedQuantity, 2);
  assert.throws(() => calculateReservationStock(result, { type: 'settle', quantity: 5, soldQuantity: 3 }), /Reserved quantity is lower/);
});
test('reservation settlement rejects invalid or exhausted stock without mutating source', () => {
  const latest = product({ quantity: 4, reservedQuantity: 5 });
  const before = JSON.stringify(latest);
  assert.throws(() => calculateReservationStock(latest, { type: 'settle', quantity: 5, soldQuantity: 5 }), /Insufficient quantity/);
  assert.throws(() => calculateReservationStock(latest, { type: 'settle', quantity: 2, soldQuantity: 3 }), /Used quantity/);
  assert.equal(JSON.stringify(latest), before);
});
test('nonfinite requests and negative stock or reservation data are rejected', () => {
  assert.throws(() => calculateReservationStock(product(), { type: 'reserve', quantity: Infinity }), /Invalid reservation/);
  assert.throws(() => calculateReservationStock(product(), { type: 'settle', quantity: 1, soldQuantity: NaN }), /Invalid reserved stock/);
  assert.throws(() => calculateReservationStock(product({ reservedQuantity: -1 }), { type: 'reserve', quantity: 1 }), /Invalid product stock/);
  assert.throws(() => calculateReservationStock(product({ quantity: -1 }), { type: 'release', quantity: 1 }), /Invalid product stock/);
});

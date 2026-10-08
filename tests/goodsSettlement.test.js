const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeGoodsPaymentInput, applyGoodsPayment, reverseGoodsPayment, reconcileGoodsCustomerState } = require('../dist/utils/goodsSettlement');

const fixture = () => ({
  warehouses: { w1: { id: 'w1', name: 'المستودع', type: 'standard', isActive: true }, v1: { id: 'v1', name: 'السيارة', type: 'vehicle', driverId: 'driver1', isActive: true } },
  products: { 'المستودع': { p1: { id: 'p1', name: 'صنف', code: 'P1', quantity: 20, reservedQuantity: 2, payPrice: 4 } }, 'السيارة': { p1: { id: 'p1', name: 'صنف', code: 'P1', quantity: 20, payPrice: 4 } } },
  customer: { c1: { id: 'c1', name: 'زبون', balance: -100, balanceUSD: -100, purchases: ['s1'] } },
  supplier: { u1: { id: 'u1', name: 'مورد', balance: 100, balanceUSD: 100, purchases: ['b1'] } },
  sells: { s1: { id: 's1', customerId: 'c1', totalPrice: 100, remainingDebt: 100, currency: 'USD', exchangeRate: 1 } },
  purchases: { b1: { id: 'b1', supplierId: 'u1', totalPrice: 100, remainingDebt: 100, currency: 'USD', exchangeRate: 1 } },
  accounts: {
    ar: { id: 'ar', name: 'العملاء', type: 'Asset', nature: 'Debit', category: 'AccountsReceivable', currentBalance: 100, allowTransactions: true },
    ap: { id: 'ap', name: 'الموردون', type: 'Liability', nature: 'Credit', category: 'AccountsPayable', currentBalance: 100, allowTransactions: true },
    inv: { id: 'inv', name: 'المخزون', type: 'Asset', nature: 'Debit', category: 'Inventory', currentBalance: 80, allowTransactions: true },
    diff: { id: 'diff', name: 'فرق التسوية', type: 'Revenue', nature: 'Credit', category: 'Other', currentBalance: 0, allowTransactions: true },
  }, payment: {}, journalEntries: {},
});
const input = (overrides = {}) => normalizeGoodsPaymentInput({ requestId: 'request_001', partyType: 'customer', customerId: 'c1', goodsDirection: 'receive', warehouse: 'w1', items: [{ productId: 'p1', quantity: 10, settlementPrice: 5 }], currency: 'USD', exchangeRate: 1, note: 'اختبار', partyAccountId: 'ar', inventoryAccountId: 'inv', differenceAccountId: 'diff', ...overrides });
const context = (suffix = '1') => ({ id: `payment${suffix}`, journalId: `journal${suffix}`, requestKey: `request${suffix}`, fingerprint: `fingerprint${suffix}`, actorId: 'admin', actorName: 'مدير', now: '2026-10-08T09:00:00.000Z' });
const balanced = (result) => {
  const lines = result.state.journalEntries[result.payment.journalEntryId].lines;
  assert.equal(lines.reduce((sum, line) => sum + line.debit, 0), lines.reduce((sum, line) => sum + line.credit, 0));
};

test('customer receiving goods reduces debt, snapshots agreed price and weighted inventory cost', () => {
  const source = fixture();
  const result = applyGoodsPayment(source, input(), context());
  assert.equal(result.state.customer.c1.balanceUSD, -50);
  assert.equal(result.state.products['المستودع'].p1.quantity, 30);
  assert.equal(result.state.products['المستودع'].p1.payPrice, 4.333333);
  assert.equal(result.payment.amountUSD, 50);
  assert.equal(result.payment.goodsItems[0].lineTotalOriginal, 50);
  assert.equal(source.products['المستودع'].p1.quantity, 20);
  balanced(result);
});
test('customer delivery consumes stock and decreases credit using historic book cost', () => {
  const source = fixture(); source.sells = {}; source.customer.c1.balance = 100;
  source.payment.credit = { customerId: 'c1', type: 'income', amount: 100 };
  const result = applyGoodsPayment(source, input({ goodsDirection: 'deliver' }), context());
  assert.equal(result.state.customer.c1.balanceUSD, 50);
  assert.equal(result.state.products['المستودع'].p1.quantity, 10);
  assert.equal(result.payment.amountUSD, -50);
  assert.equal(result.payment.goodsCostUSD, 40);
  assert.equal(result.state.accounts.diff.currentBalanceUSD, 10);
  balanced(result);
});
test('supplier delivery reduces payable, supplier receipt increases payable', () => {
  const data = { partyType: 'supplier', customerId: undefined, supplierId: 'u1', partyAccountId: 'ap' };
  const delivered = applyGoodsPayment(fixture(), input({ ...data, goodsDirection: 'deliver' }), context());
  assert.equal(delivered.state.supplier.u1.balanceUSD, 50);
  const received = applyGoodsPayment(fixture(), input(data), context());
  assert.equal(received.state.supplier.u1.balanceUSD, 150);
  balanced(delivered); balanced(received);
});
test('invoice-linked customer settlement is counted once after reconciliation and currency uses original invoice rate', () => {
  const source = fixture();
  source.sells.s1 = { ...source.sells.s1, currency: 'SYP', exchangeRate: 10000, remainingSYP: 1000000 };
  const result = applyGoodsPayment(source, input({ sellId: 's1' }), context());
  assert.equal(result.sell.remainingDebt, 50);
  assert.equal(result.state.customer.c1.balanceUSD, -50);
  assert.equal(result.state.customer.c1.balanceSYP, -500000);
  assert.equal(result.payment.balanceSYPChange, 500000);
  reconcileGoodsCustomerState(result.state, 'c1');
  assert.equal(result.state.customer.c1.balanceUSD, -50);
});
test('linked supplier delivery reduces invoice remaining once', () => {
  const result = applyGoodsPayment(fixture(), input({ partyType: 'supplier', customerId: undefined, supplierId: 'u1', partyAccountId: 'ap', goodsDirection: 'deliver', purchaseId: 'b1' }), context());
  assert.equal(result.purchase.remainingDebt, 50);
  assert.equal(result.state.supplier.u1.balanceUSD, 50);
});
test('SYP agreed prices are converted using settlement historical exchange rate', () => {
  const result = applyGoodsPayment(fixture(), input({ currency: 'SYP', exchangeRate: 10000, items: [{ productId: 'p1', quantity: 10, settlementPrice: 50000 }] }), context());
  assert.equal(result.payment.amountOriginal, 500000);
  assert.equal(result.payment.amountUSD, 50);
  assert.equal(result.state.customer.c1.balanceSYP, 500000);
  balanced(result);
});
test('missing difference account and stock reserved overflow abort every update', () => {
  const source = fixture(); const before = JSON.stringify(source);
  assert.throws(() => applyGoodsPayment(source, input({ goodsDirection: 'deliver', differenceAccountId: undefined }), context()), /فرق القيمة/);
  assert.throws(() => applyGoodsPayment(source, input({ goodsDirection: 'deliver', items: [{ productId: 'p1', quantity: 19, settlementPrice: 5 }] }), context()), /غير كافية/);
  assert.equal(JSON.stringify(source), before);
});
test('idempotent request returns same record and different payload fingerprint is rejected', () => {
  const first = applyGoodsPayment(fixture(), input(), context());
  const retry = applyGoodsPayment(first.state, input(), context());
  assert.equal(retry.payment.id, first.payment.id);
  assert.equal(retry.state.products['المستودع'].p1.quantity, 30);
  assert.equal(Object.keys(retry.state.payment).length, 1);
  assert.throws(() => applyGoodsPayment(first.state, input(), { ...context(), fingerprint: 'changed' }), /عملية مختلفة/);
});
test('next overlapping settlement validates latest stock and leaves prior committed operation intact', () => {
  const first = applyGoodsPayment(fixture(), input({ goodsDirection: 'deliver' }), context());
  assert.throws(() => applyGoodsPayment(first.state, input({ goodsDirection: 'deliver' }), context('2')), /غير كافية/);
  assert.equal(first.state.products['المستودع'].p1.quantity, 10);
});
test('reverse receipt restores invoice, balances and journal; second reverse rejected', () => {
  const first = applyGoodsPayment(fixture(), input({ sellId: 's1' }), context());
  const reversal = reverseGoodsPayment(first.state, first.payment.id, 'reverse001', '', context('2'));
  assert.equal(reversal.state.products['المستودع'].p1.quantity, 20);
  assert.equal(reversal.state.products['المستودع'].p1.payPrice, 4);
  assert.equal(reversal.state.customer.c1.balanceUSD, -100);
  assert.equal(reversal.sell.remainingDebt, 100);
  assert.equal(reversal.state.accounts.inv.currentBalanceUSD, 80);
  assert.equal(reversal.payment.amountUSD, -50);
  assert.equal(reversal.state.payment.payment1.status, 'reversed');
  assert.throws(() => reverseGoodsPayment(reversal.state, 'payment1', 'reverse002', '', context('3')), /معكوس سابقًا/);
  balanced(reversal);
});
test('reversing delivery restores original cost, difference and party amount', () => {
  const first = applyGoodsPayment(fixture(), input({ goodsDirection: 'deliver' }), context());
  const reversed = reverseGoodsPayment(first.state, first.payment.id, 'reverse001', '', context('2'));
  assert.equal(reversed.state.products['المستودع'].p1.quantity, 20);
  assert.equal(reversed.state.products['المستودع'].p1.payPrice, 4);
  assert.equal(reversed.state.accounts.diff.currentBalanceUSD, 0);
  assert.equal(reversed.state.customer.c1.balanceUSD, -100);
});
test('receipt reversal fails if goods consumed or custody changed', () => {
  const received = applyGoodsPayment(fixture(), input(), context());
  received.state.products['المستودع'].p1.quantity = 5;
  assert.throws(() => reverseGoodsPayment(received.state, 'payment1', 'reverse001', '', context('2')), /غير كافية/);
  const vehicle = applyGoodsPayment(fixture(), input({ warehouse: 'v1' }), context());
  assert.equal(vehicle.payment.stockDriverId, 'driver1');
  vehicle.state.warehouses.v1.driverId = 'driver2';
  assert.throws(() => reverseGoodsPayment(vehicle.state, 'payment1', 'reverse001', '', context('2')), /تغيرت عهدة/);
});
test('invoice overpayment and invalid account abort all state changes', () => {
  const source = fixture(); const original = JSON.stringify(source);
  assert.throws(() => applyGoodsPayment(source, input({ sellId: 's1', items: [{ productId: 'p1', quantity: 10, settlementPrice: 15 }] }), context()), /أكبر من المتبقي/);
  source.accounts.ar.allowTransactions = false;
  assert.throws(() => applyGoodsPayment(source, input(), context()), /لا يسمح/);
  delete source.accounts.ar.allowTransactions;
  source.accounts.ar.allowTransactions = true;
  assert.equal(JSON.stringify(source), original);
});
test('invalid quantity, unsupported currency, cross party invoice, duplicated items rejected', () => {
  assert.throws(() => input({ items: [{ productId: 'p1', quantity: NaN, settlementPrice: 5 }] }), /رقمًا موجبًا/);
  assert.throws(() => input({ currency: 'EUR' }), /العملة/);
  assert.throws(() => input({ goodsDirection: 'deliver', sellId: 's1' }), /تسديد فاتورة/);
  assert.throws(() => input({ items: [{ productId: 'p1', quantity: 1, settlementPrice: 5 }, { productId: 'p1', quantity: 1, settlementPrice: 5 }] }), /المتكرر/);
});

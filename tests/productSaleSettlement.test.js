const test = require("node:test");
const assert = require("node:assert/strict");
const { applyProductSaleSettlement } = require("../dist/utils/productSaleSettlement");
const { applyProductPurchaseSettlement } = require("../dist/utils/productPurchaseSettlement");

const copy = (value) => JSON.parse(JSON.stringify(value));
const fixture = () => ({
  products: { W: {
    p1: { id: "p1", code: "P1", name: "first", warehouse: "W", category: "c", unit: "u", quantity: 5, reservedQuantity: 1, payPrice: 4, sellPrice: 10 },
    p2: { id: "p2", code: "P2", name: "second", warehouse: "W", category: "c", unit: "u", quantity: 3, reservedQuantity: 0, payPrice: 3, sellPrice: 20 },
  } },
  customer: { c1: { id: "c1", balance: 0, balanceUSD: 0, balanceSYP: 0, purchases: [] } },
  accounts: {
    sales: { id: "sales", type: "Revenue", category: "SalesRevenue", nature: "Credit", currentBalanceUSD: 0 },
    cash: { id: "cash", type: "Asset", category: "Cash", nature: "Debit", currentBalanceUSD: 0 },
    ar: { id: "ar", type: "Asset", category: "AccountsReceivable", nature: "Debit", currentBalanceUSD: 0 },
  }, sells: {}, payment: {}, journalEntries: {}, financialRequests: {},
});
const context = () => ({ sellId: "sale-1", paymentId: "pay-1", journalId: "journal-1", requestKey: "sale_req", fingerprint: "hash", now: "2026-01-01T00:00:00.000Z" });
const line = (id, code, qty, sellPrice) => ({ id, code, warehouse: "W", qty, sellPrice, selectedPriceType: "sellPrice" });
const invoice = (extra = {}) => ({ customerId: "c1", products: [line("p1", "P1", 2, 10)], paymentStatus: "cash", currency: "USD", exchangeRate: 1,
  partValue: 20, salesAccountId: "sales", paymentAccountId: "cash", receivableAccountId: "ar", ...extra });

test("cash single-product sale updates stock, journal, payment, and customer in one state", () => {
  const result = applyProductSaleSettlement(fixture(), invoice(), context());
  assert.equal(result.state.products.W.p1.quantity, 3);
  assert.equal(result.sell.totalUSD, 20);
  assert.equal(result.state.customer.c1.balanceUSD, 0);
  assert.equal(result.state.accounts.cash.currentBalanceUSD, 20);
  assert.equal(result.state.accounts.sales.currentBalanceUSD, 20);
  assert.equal(Object.keys(result.state.payment).length, 1);
  assert.equal(Object.keys(result.state.journalEntries).length, 1);
});

test("multi-product partial sale with discount balances original SYP amounts", () => {
  const request = invoice({
    products: [line("p1", "P1", 2, 10), line("p2", "P2", 1, 20)],
    paymentStatus: "part", currency: "SYP", exchangeRate: 1000, partValue: 10000,
    discountAmountUSD: 5, discountPercent: 0,
  });
  const result = applyProductSaleSettlement(fixture(), request, context());
  assert.equal(result.sell.totalUSD, 35);
  assert.equal(result.sell.paidUSD, 10);
  assert.equal(result.sell.remainingUSD, 25);
  assert.equal(result.sell.paidSYP, 10000);
  assert.equal(result.sell.remainingSYP, 25000);
  assert.equal(result.state.customer.c1.balanceUSD, -25);
  assert.equal(result.state.customer.c1.balanceSYP, -25000);
  assert.equal(result.state.accounts.cash.currentBalanceUSD, 10);
  assert.equal(result.state.accounts.ar.currentBalanceUSD, 25);
  assert.equal(result.state.accounts.sales.currentBalanceUSD, 35);
  assert.equal(result.state.products.W.p2.quantity, 2);
});

test("debt sale has no cash payment and rejects unavailable catalog product", () => {
  const debt = applyProductSaleSettlement(fixture(), invoice({ paymentStatus: "debt", partValue: 0, paymentAccountId: undefined }), context());
  assert.equal(debt.state.customer.c1.balanceUSD, -20);
  assert.equal(Object.keys(debt.state.payment).length, 0);
  const empty = fixture(); empty.products.W.p1.quantity = 0; empty.products.W.p1.reservedQuantity = 0;
  assert.throws(() => applyProductSaleSettlement(empty, invoice(), context()), /الكمية المتاحة/);
});

test("duplicate line, missing stock, wrong account, and invalid discount leave input unchanged", () => {
  const cases = [
    invoice({ products: [line("p1", "P1", 2, 10), line("p1", "P1", 1, 10)] }),
    invoice({ products: [line("p1", "P1", 5, 10)] }),
    invoice({ salesAccountId: "cash" }),
    invoice({ discountAmountUSD: 20 }),
    invoice({ products: [] }),
    invoice({ products: [line("p1", "P1", -1, 10)] }),
    invoice({ products: [line("p1", "P1", Number.NaN, 10)] }),
    invoice({ paymentStatus: "part", partValue: 0 }),
    invoice({ paymentStatus: "part", partValue: 20 }),
    invoice({ currency: "SYP", exchangeRate: 0 }),
    invoice({ customerId: "missing" }),
  ];
  for (const request of cases) {
    const state = fixture(); const before = copy(state);
    assert.throws(() => applyProductSaleSettlement(state, request, context()));
    assert.deepEqual(state, before);
  }
});

test("standard selling price uses current stock price; custom price uses approved entered price", () => {
  const changed = fixture(); changed.products.W.p1.sellPrice = 12;
  const standard = applyProductSaleSettlement(changed, invoice(), context());
  assert.equal(standard.sell.totalUSD, 24);
  const custom = applyProductSaleSettlement(changed, invoice({ products: [{ ...line("p1", "P1", 2, 7), selectedPriceType: "custom" }] }), context());
  assert.equal(custom.sell.totalUSD, 14);
});

test("same request returns saved invoice without selling twice; changed request fails", () => {
  const first = applyProductSaleSettlement(fixture(), invoice(), context());
  const second = applyProductSaleSettlement(first.state, invoice(), context());
  assert.equal(second.duplicate, true);
  assert.equal(second.state.products.W.p1.quantity, 3);
  assert.equal(Object.keys(second.state.sells).length, 1);
  assert.throws(() => applyProductSaleSettlement(first.state, invoice(), { ...context(), fingerprint: "other" }), /معرف طلب البيع/);
});

test("catalog product stays at zero, purchase increases it, then sale reduces it with matching balances", () => {
  const initial = fixture();
  initial.products.W.p1.quantity = 0;
  initial.products.W.p1.reservedQuantity = 0;
  initial.supplier = { s1: { id: "s1", balance: 0, balanceUSD: 0, purchases: [] } };
  initial.accounts.inventory = { type: "Asset", category: "Inventory", nature: "Debit", currentBalanceUSD: 0 };
  initial.accounts.payable = { type: "Liability", category: "AccountsPayable", nature: "Credit", currentBalanceUSD: 0 };
  const purchased = applyProductPurchaseSettlement(initial, {
    id: "purchase-1", supplierId: "s1", name: "first", code: "P1", warehouse: "W", quantity: 3,
    payPrice: 4, totalPrice: 12, totalUSD: 12, totalOriginal: 12, paidUSD: 0, remainingUSD: 12,
    remainingDebt: 12, paymentStatus: "debt", paymentCurrency: "USD", currency: "USD", exchangeRate: 1,
    inventoryAccountId: "inventory", payableAccountId: "payable",
  }, { id: "p1", code: "P1", warehouse: "W", name: "first", quantity: 3, payPrice: 4 }, {
    purchaseId: "purchase-1", productId: "p1", paymentId: "purchase-payment", journalId: "purchase-journal",
    requestKey: "purchase-request", fingerprint: "purchase-hash", now: "2026-01-01T00:00:00.000Z",
  });
  assert.equal(purchased.state.products.W.p1.quantity, 3);
  const sold = applyProductSaleSettlement(purchased.state, invoice({ paymentStatus: "debt", partValue: 0, paymentAccountId: undefined }), context());
  assert.equal(sold.state.products.W.p1.quantity, 1);
  assert.equal(sold.state.supplier.s1.balanceUSD, 12);
  assert.equal(sold.state.customer.c1.balanceUSD, -20);
  assert.equal(sold.state.accounts.ar.currentBalanceUSD, 20);
});

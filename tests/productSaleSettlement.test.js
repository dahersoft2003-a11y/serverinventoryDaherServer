const test = require("node:test");
const assert = require("node:assert/strict");
const { applyProductSaleSettlement } = require("../dist/utils/productSaleSettlement");
const {
  applyProductPurchaseSettlement,
} = require("../dist/utils/productPurchaseSettlement");
const copy = (value) => JSON.parse(JSON.stringify(value));
const fixture = () => ({
  products: {
    W: {
      p1: {
        id: "p1",
        code: "P1",
        name: "first",
        warehouse: "W",
        category: "c",
        unit: "u",
        quantity: 5,
        reservedQuantity: 1,
        payPrice: 4,
        sellPrice: 10,
      },
      p2: {
        id: "p2",
        code: "P2",
        name: "second",
        warehouse: "W",
        category: "c",
        unit: "u",
        quantity: 3,
        reservedQuantity: 0,
        payPrice: 3,
        sellPrice: 20,
      },
    },
  },
  customer: { c1: { id: "c1", balance: 0, purchases: [] } },
  accounts: {
    sales: {
      id: "sales",
      type: "Revenue",
      category: "SalesRevenue",
      nature: "Credit",
      currentBalance: 0,
    },
    cash: {
      id: "cash",
      type: "Asset",
      category: "Cash",
      nature: "Debit",
      currentBalance: 0,
    },
    ar: {
      id: "ar",
      type: "Asset",
      category: "AccountsReceivable",
      nature: "Debit",
      currentBalance: 0,
    },
  },
  sells: {},
  payment: {},
  journalEntries: {},
  financialRequests: {},
});
const context = () => ({
  sellId: "sale-1",
  paymentId: "pay-1",
  journalId: "journal-1",
  requestKey: "sale_req",
  fingerprint: "hash",
  now: "2026-01-01T00:00:00.000Z",
});
const line = (id, code, qty, sellPrice) => ({
  id,
  code,
  warehouse: "W",
  qty,
  sellPrice,
  selectedPriceType: "sellPrice",
});
const invoice = (extra = {}) => ({
  customerId: "c1",
  products: [line("p1", "P1", 2, 10)],
  paymentStatus: "cash",
  currency: "SYP",
  partValue: 20,
  salesAccountId: "sales",
  paymentAccountId: "cash",
  receivableAccountId: "ar",
  ...extra,
});
test("cash single-product sale updates stock, journal, payment, and customer in one state", () => {
  const result = applyProductSaleSettlement(fixture(), invoice(), context());
  assert.equal(result.state.products.W.p1.quantity, 3);
  assert.equal(result.sell.totalPrice, 20);
  assert.equal(result.state.customer.c1.balance, 0);
  assert.equal(result.state.accounts.cash.currentBalance, 20);
  assert.equal(result.state.accounts.sales.currentBalance, 20);
  assert.equal(Object.keys(result.state.payment).length, 1);
  assert.equal(Object.keys(result.state.journalEntries).length, 1);
});
test("multi-product partial sale and discount use lira throughout", () => {
  const request = invoice({
    products: [line("p1", "P1", 2, 10), line("p2", "P2", 1, 20)],
    paymentStatus: "part",
    currency: "SYP",
    partValue: 10,
    discountAmount: 5,
    discountPercent: 0,
  });
  const result = applyProductSaleSettlement(fixture(), request, context());
  assert.equal(result.sell.totalPrice, 35);
  assert.equal(result.sell.paidAmount, 10);
  assert.equal(result.sell.remainingDebt, 25);
  assert.equal(result.state.customer.c1.balance, -25);
  assert.equal(result.state.accounts.cash.currentBalance, 10);
  assert.equal(result.state.accounts.ar.currentBalance, 25);
  assert.equal(result.state.accounts.sales.currentBalance, 35);
});
test("debt sale has no cash payment and rejects unavailable catalog product", () => {
  const debt = applyProductSaleSettlement(
    fixture(),
    invoice({ paymentStatus: "debt", partValue: 0, paymentAccountId: undefined }),
    context(),
  );
  assert.equal(debt.state.customer.c1.balance, -20);
  assert.equal(Object.keys(debt.state.payment).length, 0);
  const empty = fixture();
  empty.products.W.p1.quantity = 0;
  empty.products.W.p1.reservedQuantity = 0;
  assert.throws(
    () => applyProductSaleSettlement(empty, invoice(), context()),
    /الكمية المتاحة/,
  );
});
test("duplicate line, missing stock, wrong account, and invalid discount leave input unchanged", () => {
  const cases = [
    invoice({ products: [line("p1", "P1", 2, 10), line("p1", "P1", 1, 10)] }),
    invoice({ products: [line("p1", "P1", 5, 10)] }),
    invoice({ salesAccountId: "cash" }),
    invoice({ discountAmount: 20 }),
    invoice({ products: [] }),
    invoice({ products: [line("p1", "P1", -1, 10)] }),
    invoice({ products: [line("p1", "P1", Number.NaN, 10)] }),
    invoice({ paymentStatus: "part", partValue: 0 }),
    invoice({ paymentStatus: "part", partValue: 20 }),
    invoice({ currency: "USD" }),
    invoice({ customerId: "missing" }),
  ];
  for (const request of cases) {
    const state = fixture();
    const before = copy(state);
    assert.throws(() => applyProductSaleSettlement(state, request, context()));
    assert.deepEqual(state, before);
  }
});
test("standard selling price uses current stock price; custom price uses approved entered price", () => {
  const changed = fixture();
  changed.products.W.p1.sellPrice = 12;
  const standard = applyProductSaleSettlement(changed, invoice(), context());
  assert.equal(standard.sell.totalPrice, 24);
  const custom = applyProductSaleSettlement(
    changed,
    invoice({ products: [{ ...line("p1", "P1", 2, 7), selectedPriceType: "custom" }] }),
    context(),
  );
  assert.equal(custom.sell.totalPrice, 14);
});
test("same request returns saved invoice without selling twice; changed request fails", () => {
  const first = applyProductSaleSettlement(fixture(), invoice(), context());
  const second = applyProductSaleSettlement(first.state, invoice(), context());
  assert.equal(second.duplicate, true);
  assert.equal(second.state.products.W.p1.quantity, 3);
  assert.equal(Object.keys(second.state.sells).length, 1);
  assert.throws(
    () =>
      applyProductSaleSettlement(first.state, invoice(), {
        ...context(),
        fingerprint: "other",
      }),
    /معرف طلب البيع/,
  );
});
test("catalog product stays at zero, purchase increases it, then sale reduces it with matching balances", () => {
  const initial = fixture();
  initial.products.W.p1.quantity = 0;
  initial.products.W.p1.reservedQuantity = 0;
  initial.supplier = { s1: { id: "s1", balance: 0, purchases: [] } };
  initial.accounts.inventory = {
    type: "Asset",
    category: "Inventory",
    nature: "Debit",
    currentBalance: 0,
  };
  initial.accounts.payable = {
    type: "Liability",
    category: "AccountsPayable",
    nature: "Credit",
    currentBalance: 0,
  };
  const purchased = applyProductPurchaseSettlement(
    initial,
    {
      id: "purchase-1",
      supplierId: "s1",
      name: "first",
      code: "P1",
      warehouse: "W",
      quantity: 3,
      payPrice: 4,
      totalPrice: 12,
      paidAmount: 0,
      remainingDebt: 12,
      paymentStatus: "debt",
      currency: "SYP",
      inventoryAccountId: "inventory",
      payableAccountId: "payable",
    },
    { id: "p1", code: "P1", warehouse: "W", name: "first", quantity: 3, payPrice: 4 },
    {
      purchaseId: "purchase-1",
      productId: "p1",
      paymentId: "purchase-payment",
      journalId: "purchase-journal",
      requestKey: "purchase-request",
      fingerprint: "purchase-hash",
      now: "2026-01-01T00:00:00.000Z",
    },
  );
  assert.equal(purchased.state.products.W.p1.quantity, 3);
  const sold = applyProductSaleSettlement(
    purchased.state,
    invoice({ paymentStatus: "debt", partValue: 0, paymentAccountId: undefined }),
    context(),
  );
  assert.equal(sold.state.products.W.p1.quantity, 1);
  assert.equal(sold.state.supplier.s1.balance, 12);
  assert.equal(sold.state.customer.c1.balance, -20);
  assert.equal(sold.state.accounts.ar.currentBalance, 20);
});

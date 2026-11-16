const test = require("node:test");
const assert = require("node:assert/strict");
const {
  applyProductPurchaseSettlement,
} = require("../dist/utils/productPurchaseSettlement");
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
    },
  },
  supplier: { s1: { id: "s1", balance: 0, purchases: [] } },
  accounts: {
    inventory: {
      id: "inventory",
      name: "مخزون",
      type: "Asset",
      nature: "Debit",
      category: "Inventory",
      currentBalance: 0,
    },
    payable: {
      id: "payable",
      name: "موردون",
      type: "Liability",
      nature: "Credit",
      category: "AccountsPayable",
      currentBalance: 0,
    },
    cash: {
      id: "cash",
      name: "صندوق",
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
const context = (n) => ({
  purchaseId: `purchase${n}`,
  productId: "p1",
  paymentId: `payment${n}`,
  journalId: `journal${n}`,
  requestKey: `product_purchase_${n}`,
  fingerprint: `fingerprint${n}`,
  now: "2026-10-17T00:00:00.000Z",
});
const item = (quantity = 3, payPrice = 10) => ({
  id: "p1",
  name: "منتج",
  code: "P1",
  warehouse: "W",
  quantity,
  payPrice,
  wholesalePrice: 12,
  superWholesalePrice: 13,
  sellPrice: 15,
});
const invoice = (status = "cash", paidAmount = 30, overrides = {}) => ({
  id: "purchase1",
  date: "2026-10-17T00:00:00.000Z",
  supplierId: "s1",
  name: "منتج",
  code: "P1",
  warehouse: "W",
  quantity: 3,
  payPrice: 10,
  totalPrice: 30,
  paidAmount,
  remainingDebt: 30 - paidAmount,
  paymentStatus: status,
  currency: "SYP",
  inventoryAccountId: "inventory",
  payableAccountId: "payable",
  ...(paidAmount > 0 ? { paymentAccountId: "cash" } : {}),
  ...overrides,
});
test("cash purchase of a zero-stock catalog product posts matching stock, cash and journal", () => {
  const before = fixture();
  const result = applyProductPurchaseSettlement(
    before,
    invoice(),
    item(),
    context("one"),
  );
  const state = result.state;
  assert.equal(before.products.W.p1.quantity, 0);
  assert.equal(state.products.W.p1.quantity, 3);
  assert.equal(state.products.W.p1.payPrice, 10);
  assert.equal(state.accounts.inventory.currentBalance, 30);
  assert.equal(state.accounts.cash.currentBalance, 70);
  assert.equal(state.accounts.payable.currentBalance, 0);
  assert.equal(state.supplier.s1.balance, 0);
  assert.equal(state.payment.paymentone.amount, -30);
  const lines = state.journalEntries.journalone.lines;
  assert.equal(
    lines.reduce((sum, line) => sum + line.debit, 0),
    30,
  );
  assert.equal(
    lines.reduce((sum, line) => sum + line.credit, 0),
    30,
  );
});
test("debt and partial purchases credit only the unpaid lira portion", () => {
  const debt = applyProductPurchaseSettlement(
    fixture(),
    invoice("debt", 0),
    item(),
    context("debt"),
  ).state;
  assert.equal(debt.supplier.s1.balance, 30);
  assert.equal(debt.accounts.payable.currentBalance, 30);
  assert.equal(Object.keys(debt.payment).length, 0);
  const partial = applyProductPurchaseSettlement(
    fixture(),
    invoice("part", 10),
    item(),
    context("part"),
  ).state;
  assert.equal(partial.supplier.s1.balance, 20);
  assert.equal(partial.accounts.inventory.currentBalance, 30);
  assert.equal(partial.accounts.cash.currentBalance, 90);
  assert.equal(partial.accounts.payable.currentBalance, 20);
  assert.equal(partial.payment.paymentpart.amount, -10);
});
test("a later purchase uses weighted stock cost and retry does not double-post", () => {
  const first = applyProductPurchaseSettlement(
    fixture(),
    invoice(),
    item(),
    context("first"),
  ).state;
  const secondInvoice = invoice("cash", 40, {
    id: "purchase2",
    quantity: 2,
    payPrice: 20,
    totalPrice: 40,
    remainingDebt: 0,
  });
  const second = applyProductPurchaseSettlement(
    first,
    secondInvoice,
    item(2, 20),
    context("second"),
  ).state;
  assert.equal(second.products.W.p1.quantity, 5);
  assert.equal(second.products.W.p1.payPrice, 14);
  assert.equal(second.accounts.inventory.currentBalance, 70);
  const replay = applyProductPurchaseSettlement(
    second,
    secondInvoice,
    item(2, 20),
    context("second"),
  );
  assert.equal(replay.duplicate, true);
  assert.equal(replay.state.products.W.p1.quantity, 5);
  assert.equal(replay.state.accounts.inventory.currentBalance, 70);
  assert.equal(Object.keys(replay.state.purchases).length, 2);
});
test("invalid totals, accounts and product identity leave stock and balances untouched", () => {
  const before = fixture();
  const copy = JSON.stringify(before);
  assert.throws(
    () =>
      applyProductPurchaseSettlement(
        before,
        invoice("cash", 30, { totalPrice: 1 }),
        item(),
        context("bad-total"),
      ),
    /إجمالي/,
  );
  assert.throws(
    () =>
      applyProductPurchaseSettlement(
        before,
        invoice("cash", 30, { inventoryAccountId: "cash" }),
        item(),
        context("bad-account"),
      ),
    /حسابات/,
  );
  assert.throws(
    () =>
      applyProductPurchaseSettlement(
        before,
        invoice(),
        { ...item(), code: "OTHER" },
        context("bad-item"),
      ),
    /بيانات المنتج/,
  );
  assert.equal(JSON.stringify(before), copy);
});
test("multi-product invoice updates every selected catalog product in one balanced purchase", () => {
  const before = fixture();
  before.products.W.p2 = {
    id: "p2",
    name: "ثان",
    code: "P2",
    warehouse: "W",
    quantity: 2,
    reservedQuantity: 0,
    payPrice: 5,
  };
  const items = [
    item(3, 10),
    { id: "p2", name: "ثان", code: "P2", warehouse: "W", quantity: 2, payPrice: 10 },
  ];
  const multiInvoice = invoice("cash", 50, {
    quantity: 5,
    payPrice: 0,
    totalPrice: 50,
    remainingDebt: 0,
    products: items.map((product) => ({
      ...product,
      lineTotal: product.quantity * product.payPrice,
    })),
  });
  const state = applyProductPurchaseSettlement(
    before,
    multiInvoice,
    items,
    context("bulk"),
  ).state;
  assert.equal(state.products.W.p1.quantity, 3);
  assert.equal(state.products.W.p2.quantity, 4);
  assert.equal(state.products.W.p2.payPrice, 7.5);
  assert.equal(state.accounts.inventory.currentBalance, 50);
  assert.equal(state.accounts.cash.currentBalance, 50);
  assert.equal(Object.keys(state.purchases).length, 1);
  assert.equal(Object.keys(state.journalEntries).length, 1);
  assert.equal(
    JSON.stringify(before.products.W.p2),
    JSON.stringify({
      id: "p2",
      name: "ثان",
      code: "P2",
      warehouse: "W",
      quantity: 2,
      reservedQuantity: 0,
      payPrice: 5,
    }),
  );
});

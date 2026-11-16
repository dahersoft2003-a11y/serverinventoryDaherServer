const test = require("node:test");
const assert = require("node:assert/strict");
const { applyCashPartySettlement } = require("../dist/utils/cashPartySettlement");
const { sanitizeCashPaymentInput } = require("../dist/utils/cashPaymentInput");
const {
  applyGoodsPayment,
  normalizeGoodsPaymentInput,
  reconcileGoodsCustomerState,
} = require("../dist/utils/goodsSettlement");
const { buildPaymentMoneyBreakdown } = require("../dist/utils/money");
const now = "2026-10-08T12:00:00.000Z";
const fixture = () => ({
  warehouses: { w: { id: "w", name: "depot", type: "standard", isActive: true } },
  products: {
    depot: {
      p: {
        id: "p",
        name: "Product",
        code: "P",
        quantity: 20,
        reservedQuantity: 2,
        payPrice: 4,
        sellPrice: 5,
      },
    },
  },
  customer: { c: { id: "c", name: "Customer", balance: -100 } },
  supplier: { u: { id: "u", name: "Supplier", balance: 100 } },
  sells: {
    s: {
      id: "s",
      customerId: "c",
      totalPrice: 100,
      remainingDebt: 100,
      currency: "SYP",
    },
  },
  purchases: {
    b: {
      id: "b",
      supplierId: "u",
      totalPrice: 100,
      remainingDebt: 100,
      currency: "SYP",
    },
  },
  accounts: {
    cash: {
      id: "cash",
      name: "Cash",
      type: "Asset",
      nature: "Debit",
      category: "Cash",
      currentBalance: 1000,
      currency: "SYP",
      allowTransactions: true,
    },
    ar: {
      id: "ar",
      name: "AR",
      type: "Asset",
      nature: "Debit",
      category: "AccountsReceivable",
      currentBalance: 100,
      currency: "SYP",
      allowTransactions: true,
    },
    ap: {
      id: "ap",
      name: "AP",
      type: "Liability",
      nature: "Credit",
      category: "AccountsPayable",
      currentBalance: 100,
      currency: "SYP",
      allowTransactions: true,
    },
    inv: {
      id: "inv",
      name: "Inventory",
      type: "Asset",
      nature: "Debit",
      category: "Inventory",
      currentBalance: 80,
      currency: "SYP",
      allowTransactions: true,
    },
    diff: {
      id: "diff",
      name: "Difference",
      type: "Revenue",
      nature: "Credit",
      category: "Other",
      currentBalance: 0,
      currency: "SYP",
      allowTransactions: true,
    },
  },
  payment: {},
  journalEntries: {},
});
const cash = (extra = {}) => ({
  id: "cash1",
  type: "income",
  customerId: "c",
  sellId: "s",
  paymentAccountId: "cash",
  receivableAccountId: "ar",
  currency: "SYP",
  amount: 20,
  date: now,
  note: "Receipt",
  settlementMethod: "cash",
  ...extra,
});
const supplierCash = (extra = {}) =>
  cash({
    type: "expense",
    customerId: undefined,
    sellId: undefined,
    supplierId: "u",
    purchaseId: "b",
    receivableAccountId: undefined,
    payableAccountId: "ap",
    amount: -20,
    ...extra,
  });
const goods = (extra = {}) =>
  normalizeGoodsPaymentInput({
    requestId: "goods-request123",
    partyType: "customer",
    customerId: "c",
    sellId: "s",
    goodsDirection: "receive",
    warehouse: "w",
    items: [{ productId: "p", quantity: 10, settlementPrice: 5 }],
    currency: "SYP",
    note: "Goods settlement",
    partyAccountId: "ar",
    inventoryAccountId: "inv",
    differenceAccountId: "diff",
    ...extra,
  });
const ctx = (id = "goods1") => ({
  id,
  journalId: `${id}-journal`,
  requestKey: `${id}-request`,
  fingerprint: id,
  actorId: "admin",
  actorName: "admin",
  now,
});
const journalBalanced = (state, id) => {
  const lines = state.journalEntries[id].lines;
  assert.equal(
    lines.reduce((sum, l) => sum + l.debit, 0),
    lines.reduce((sum, l) => sum + l.credit, 0),
  );
};
test("linked customer cash receipt changes debt, paid amounts, customer and accounts together once", () => {
  const original = fixture();
  const r = applyCashPartySettlement(original, cash(), "journal1");
  assert.equal(r.sell.remainingDebt, 80);
  assert.equal(r.sell.paidAmount, 20);
  assert.equal(r.sell.paymentStatus, "part");
  assert.equal(r.state.customer.c.balance, -80);
  assert.equal(r.state.accounts.cash.currentBalance, 1020);
  assert.equal(r.state.accounts.ar.currentBalance, 80);
  reconcileGoodsCustomerState(r.state, "c");
  assert.equal(r.state.customer.c.balance, -80);
  assert.equal(original.sells.s.remainingDebt, 100);
  journalBalanced(r.state, "journal1");
});
test("linked supplier cash payment reduces payable and increases invoice paid once", () => {
  const r = applyCashPartySettlement(fixture(), supplierCash(), "journal1");
  assert.equal(r.purchase.remainingDebt, 80);
  assert.equal(r.purchase.paidAmount, 20);
  assert.equal(r.purchase.paidAmount, 20);
  assert.equal(r.state.supplier.u.balance, 80);
  assert.equal(r.state.accounts.cash.currentBalance, 980);
  assert.equal(r.state.accounts.ap.currentBalance, 80);
  assert.equal(r.payment.amount, -20);
  journalBalanced(r.state, "journal1");
});
test("large lira cash payment reduces the same lira invoice and ledger", () => {
  const s = fixture();
  s.sells.s.totalPrice = 1000000;
  s.sells.s.remainingDebt = 1000000;
  s.customer.c.balance = -1000000;
  s.accounts.ar.currentBalance = 1000000;
  const r = applyCashPartySettlement(s, cash({ amount: 400000 }), "journal1");
  assert.equal(r.sell.remainingDebt, 600000);
  assert.equal(r.sell.paidAmount, 400000);
  assert.equal(r.state.customer.c.balance, -600000);
  assert.equal(r.state.accounts.cash.currentBalance, 401000);
  assert.equal(r.state.accounts.ar.currentBalance, 600000);
  journalBalanced(r.state, "journal1");
});
test("supplier lira payment updates cash and payable by the entered amount", () => {
  const s = fixture();
  s.purchases.b.totalPrice = 1000000;
  s.purchases.b.remainingDebt = 1000000;
  s.supplier.u.balance = 1000000;
  s.accounts.ap.currentBalance = 1000000;
  s.accounts.cash.currentBalance = 600000;
  const r = applyCashPartySettlement(s, supplierCash({ amount: -400000 }), "journal1");
  assert.equal(r.purchase.remainingDebt, 600000);
  assert.equal(r.purchase.paidAmount, 400000);
  assert.equal(r.state.supplier.u.balance, 600000);
  assert.equal(r.state.accounts.cash.currentBalance, 200000);
  assert.equal(r.state.accounts.ap.currentBalance, 600000);
  journalBalanced(r.state, "journal1");
});
test("small lira payment has the same effect on a large lira balance", () => {
  const s = fixture();
  s.sells.s.totalPrice = 1000000;
  s.sells.s.remainingDebt = 1000000;
  s.customer.c.balance = -1000000;
  s.accounts.ar.currentBalance = 1000000;
  const r = applyCashPartySettlement(s, cash(), "journal1");
  assert.equal(r.sell.remainingDebt, 999980);
  assert.equal(r.state.accounts.ar.currentBalance, 999980);
  assert.equal(r.state.accounts.cash.currentBalance, 1020);
});
test("legacy currency invoice is rejected before mutation", () => {
  const s = fixture();
  s.sells.s.currency = "USD";
  const before = JSON.stringify(s);
  assert.throws(() => applyCashPartySettlement(s, cash(), "j"));
  assert.equal(JSON.stringify(s), before);
});
test("atomic validation failure leaves input invoice, accounts, payments and parties unchanged", () => {
  const s = fixture();
  const before = JSON.stringify(s);
  assert.throws(
    () => applyCashPartySettlement(s, cash({ amount: 200 }), "journal1"),
    /المتبقي/,
  );
  assert.throws(
    () =>
      applyCashPartySettlement(s, cash({ paymentAccountId: "missing" }), "journal1"),
    /الحساب/,
  );
  assert.throws(
    () => applyCashPartySettlement(s, cash({ customerId: "unknown" }), "journal1"),
    /الطرف/,
  );
  assert.throws(
    () => applyCashPartySettlement(s, cash({ amount: -20 }), "journal1"),
    /اتجاه الدفعة/,
  );
  assert.equal(JSON.stringify(s), before);
});
test("sequential customer cash and goods settlements see each other's latest invoice and accounts", () => {
  const cashFirst = applyCashPartySettlement(fixture(), cash(), "cash-journal");
  const goodsSecond = applyGoodsPayment(cashFirst.state, goods(), ctx());
  assert.equal(goodsSecond.sell.remainingDebt, 30);
  assert.equal(goodsSecond.sell.paidAmount, 70);
  assert.equal(goodsSecond.state.customer.c.balance, -30);
  assert.equal(goodsSecond.state.accounts.ar.currentBalance, 30);
  const goodsFirst = applyGoodsPayment(fixture(), goods(), ctx());
  const cashSecond = applyCashPartySettlement(goodsFirst.state, cash(), "cash-journal");
  assert.equal(cashSecond.sell.remainingDebt, 30);
  assert.equal(cashSecond.sell.paidAmount, 70);
  assert.equal(cashSecond.state.customer.c.balance, -30);
  assert.equal(cashSecond.state.accounts.ar.currentBalance, 30);
  assert.equal(cashSecond.state.accounts.cash.currentBalance, 1020);
  assert.equal(Object.keys(cashSecond.state.payment).length, 2);
  assert.throws(
    () =>
      applyCashPartySettlement(goodsFirst.state, cash({ amount: 60 }), "cash-journal"),
    /المتبقي/,
  );
  assert.equal(goodsFirst.sell.remainingDebt, 50);
});
test("sequential supplier cash and goods payments cannot overwrite remaining payable", () => {
  const cashFirst = applyCashPartySettlement(fixture(), supplierCash(), "cash-journal");
  const goodsSecond = applyGoodsPayment(
    cashFirst.state,
    goods({
      partyType: "supplier",
      customerId: undefined,
      sellId: undefined,
      supplierId: "u",
      purchaseId: "b",
      partyAccountId: "ap",
      goodsDirection: "deliver",
    }),
    ctx(),
  );
  assert.equal(goodsSecond.purchase.remainingDebt, 30);
  assert.equal(goodsSecond.state.supplier.u.balance, 30);
  assert.equal(goodsSecond.state.accounts.ap.currentBalance, 30);
  assert.equal(goodsSecond.state.accounts.cash.currentBalance, 980);
  assert.equal(goodsSecond.state.products.depot.p.quantity, 10);
});
test("direct customer outgoing cash retains balance effect through reconciliation and uses expense type", () => {
  const s = fixture();
  s.sells = {};
  s.payment.credit = { id: "credit", type: "income", customerId: "c", amount: 100 };
  const r = applyCashPartySettlement(
    s,
    cash({ sellId: undefined, amount: -20, type: "income" }),
    "journal1",
  );
  assert.equal(r.payment.type, "expense");
  assert.equal(r.state.customer.c.balance, 80);
  reconcileGoodsCustomerState(r.state, "c");
  assert.equal(r.state.customer.c.balance, 80);
  assert.equal(r.state.accounts.cash.currentBalance, 980);
});
test("invalid party combinations, wrong invoice kind, wrong account categories and prototype ids denied", () => {
  const s = fixture();
  assert.throws(() =>
    applyCashPartySettlement(s, cash({ supplierId: "u" }), "journal1"),
  );
  assert.throws(() =>
    applyCashPartySettlement(
      s,
      cash({ sellId: undefined, purchaseId: "b" }),
      "journal1",
    ),
  );
  assert.throws(() =>
    applyCashPartySettlement(s, cash({ paymentAccountId: "inv" }), "journal1"),
  );
  assert.throws(() =>
    applyCashPartySettlement(s, cash({ receivableAccountId: "ap" }), "journal1"),
  );
  assert.throws(() =>
    applyCashPartySettlement(s, cash({ id: "__proto__" }), "journal1"),
  );
});
test("cash input strips forged collector, commission, reversal and goods metadata and denies goods route bypass", () => {
  const forged = cash({
    id: "forged",
    date: "1900-01-01",
    collectorId: "driver",
    collectorName: "fake",
    commissionRate: 100,
    commissionAmount: 999,
    collectionSource: "driver",
    originalPaymentId: "original",
    refundPaidByDriverId: "driver",
    driverMovementId: "movement",
    driverId: "driver",
    stockDriverId: "driver",
    stockVehicleId: "vehicle",
    goodsItems: [{ productId: "p", quantity: 10 }],
    goodsDirection: "deliver",
    goodsCostAmount: 100,
    goodsDifferenceAmount: 100,
    balanceChange: 999,
    reversalOf: "original",
    reversedBy: "fake",
    status: "reversed",
    createdBy: "fake",
    actorId: "fake",
    actorName: "fake",
    journalEntryId: "forged",
  });
  const clean = sanitizeCashPaymentInput(forged);
  for (const field of [
    "id",
    "date",
    "collectorId",
    "collectorName",
    "commissionRate",
    "commissionAmount",
    "originalPaymentId",
    "refundPaidByDriverId",
    "driverMovementId",
    "driverId",
    "stockDriverId",
    "stockVehicleId",
    "goodsItems",
    "goodsDirection",
    "goodsCostAmount",
    "goodsDifferenceAmount",
    "balanceChange",
    "reversalOf",
    "reversedBy",
    "status",
    "createdBy",
    "actorId",
    "actorName",
    "journalEntryId",
  ])
    assert.equal(Object.hasOwn(clean, field), false, field);
  assert.equal(clean.collectionSource, "management");
  assert.equal(clean.settlementMethod, "cash");
  assert.equal(clean.customerId, "c");
  assert.equal(clean.amount, 20);
  assert.throws(
    () => sanitizeCashPaymentInput({ ...cash(), settlementMethod: "goods" }),
    /التسوية بالبضاعة/,
  );
  assert.throws(
    () => sanitizeCashPaymentInput({ ...cash(), type: "goods" }),
    /التسوية بالبضاعة/,
  );
});
test("lira normalization preserves the signed payment", () => {
  const r = buildPaymentMoneyBreakdown({ amount: -400000, currency: "SYP" });
  assert.deepEqual(r, { amount: -400000, currency: "SYP" });
});
test("direct supplier cash receipt increases its balance toward zero without touching an invoice", () => {
  const s = fixture();
  s.supplier.u.balance = -100;
  s.supplier.u.balance = -100;
  const r = applyCashPartySettlement(
    s,
    supplierCash({ purchaseId: undefined, amount: 20 }),
    "journal1",
  );
  assert.equal(r.state.supplier.u.balance, -80);
  assert.equal(r.payment.type, "income");
  assert.equal(r.state.accounts.cash.currentBalance, 1020);
  assert.equal(r.state.purchases.b.remainingDebt, 100);
  journalBalanced(r.state, "journal1");
});
test("cash request retry returns the saved receipt without another journal, balance or invoice change", () => {
  const request = { requestKey: "cash_request", fingerprint: "same-request" };
  const first = applyCashPartySettlement(
    fixture(),
    cash({ requestId: "cash-request-1" }),
    "journal1",
    request,
  );
  const before = JSON.stringify(first.state);
  const retry = applyCashPartySettlement(
    first.state,
    cash({ id: "retry-id", requestId: "cash-request-1" }),
    "retry-journal",
    request,
  );
  assert.equal(retry.duplicate, true);
  assert.equal(retry.payment.id, "cash1");
  assert.equal(retry.sell.remainingDebt, 80);
  assert.equal(Object.keys(retry.state.payment).length, 1);
  assert.equal(Object.keys(retry.state.journalEntries).length, 1);
  assert.equal(JSON.stringify(retry.state), before);
  assert.throws(
    () =>
      applyCashPartySettlement(first.state, cash({ id: "retry-id" }), "retry-journal", {
        ...request,
        fingerprint: "changed-value",
      }),
    /دفعة مختلفة/,
  );
  assert.equal(JSON.stringify(first.state), before);
});

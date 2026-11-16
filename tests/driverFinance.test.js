const test = require("node:test");
const assert = require("node:assert/strict");
const {
  buildDriverStatement,
  snapshotDriverCommission,
  commissionRateAt,
} = require("../dist/utils/driverFinanceCalc");
const { allocateDriverRefundPayments } = require("../dist/utils/driverRefund");
const {
  applyDriverCollection,
  applyDriverMovement,
  normalizeDriverRequest,
} = require("../dist/utils/driverFinanceMutations");
const {
  applyVehicleLoad,
  applyVehicleCustodyChange,
} = require("../dist/utils/vehicleCustody");
const now = "2026-10-08T12:00:00.000Z";
const context = (id = "new", actorId = "admin") => ({
  id,
  journalId: `${id}-journal`,
  actorId,
  actorName: actorId,
  now,
  fingerprint: id,
});
const state = () => ({
  users: {
    admin: { username: "admin", role: "admin" },
    one: { username: "one", role: "driver", commissionRate: 10, vehicleId: "v1" },
    two: { username: "two", role: "driver", commissionRate: 20, vehicleId: "v2" },
  },
  warehouses: {
    depot: { id: "depot", name: "depot", type: "standard", isActive: true },
    v1: {
      id: "v1",
      name: "truck1",
      type: "vehicle",
      driverId: "one",
      defaultPaymentAccountId: "custody",
      defaultReceivableAccountId: "ar",
      isActive: true,
    },
    v2: { id: "v2", name: "truck2", type: "vehicle", driverId: "two", isActive: true },
  },
  accounts: {
    treasury: {
      id: "treasury",
      name: "treasury",
      type: "Asset",
      nature: "Debit",
      category: "Cash",
      currentBalance: 500,
      currency: "SYP",
    },
    custody: {
      id: "custody",
      name: "custody",
      type: "Asset",
      nature: "Debit",
      category: "Cash",
      currentBalance: 0,
      currency: "SYP",
    },
    ar: {
      id: "ar",
      name: "ar",
      type: "Asset",
      nature: "Debit",
      category: "AccountsReceivable",
      currentBalance: 100,
      currency: "SYP",
    },
    expense: {
      id: "expense",
      name: "expense",
      type: "Expense",
      nature: "Debit",
      category: "OperatingExpense",
      currentBalance: 0,
      currency: "SYP",
    },
  },
  products: {
    depot: {
      p: {
        id: "p",
        code: "A",
        name: "A",
        quantity: 10,
        reservedQuantity: 2,
        payPrice: 5,
        sellPrice: 10,
      },
    },
    truck1: {
      p1: { id: "p1", code: "A", name: "A", quantity: 0, payPrice: 5, sellPrice: 10 },
    },
  },
  customer: { c: { id: "c", name: "Customer", balance: -100 } },
  sells: {
    s: {
      id: "s",
      customerId: "c",
      driverId: "one",
      vehicleId: "v1",
      date: "2026-10-01T08:00:00.000Z",
      totalPrice: 100,
      remainingDebt: 100,
      paidAmount: 0,
      currency: "SYP",
      paymentAccountId: "custody",
      receivableAccountId: "ar",
      products: [
        {
          id: "p1",
          code: "A",
          name: "A",
          warehouse: "truck1",
          qty: 10,
          payPrice: 5,
          sellPrice: 10,
        },
      ],
    },
  },
  payment: {},
  returns: {},
  warehouseTransfers: {},
  driverCashMovements: {},
});
const report = (s, extra = {}) =>
  buildDriverStatement({
    driverId: "one",
    dateFrom: "2026-10-01",
    dateTo: "2026-10-08",
    users: s.users,
    warehouses: s.warehouses,
    products: s.products,
    sells: s.sells,
    payments: s.payment,
    returns: s.returns,
    transfers: s.warehouseTransfers,
    movements: s.driverCashMovements,
    customers: s.customer,
    generatedAt: now,
    ...extra,
  });
const collectInput = (extra = {}) =>
  normalizeDriverRequest(
    {
      requestId: "receipt-12345",
      driverId: "one",
      customerId: "c",
      sellId: "s",
      amount: 40,
      currency: "SYP",
      ...extra,
    },
    "collection",
    true,
    "admin",
    now,
  );
const movementInput = (extra = {}) =>
  normalizeDriverRequest(
    {
      requestId: "movement-12345",
      driverId: "one",
      type: "remittance",
      amount: 20,
      currency: "SYP",
      sourceAccountId: "custody",
      destinationAccountId: "treasury",
      ...extra,
    },
    "movement",
    true,
    "admin",
    now,
  );
test("independent rates use effective history and freeze collection snapshots", () => {
  const s = state();
  s.users.one.commissionRateHistory = [
    { rate: 10, effectiveFrom: "2026-01-01T00:00:00Z", createdAt: "2026-01-01" },
    { rate: 15, effectiveFrom: "2026-10-10T00:00:00Z", createdAt: now },
  ];
  const payment = { type: "income", customerId: "c", amount: 200, date: now };
  assert.equal(commissionRateAt(s.users.one, now), 10);
  const one = snapshotDriverCommission(payment, "one", s.users.one);
  const two = snapshotDriverCommission(payment, "two", s.users.two);
  assert.equal(one.commissionAmount, 20);
  assert.equal(two.commissionAmount, 40);
  s.users.one.commissionRate = 90;
  assert.deepEqual(snapshotDriverCommission(one, "one", s.users.one), one);
  assert.equal(commissionRateAt(s.users.one, "2026-10-11T00:00:00Z"), 15);
});
test("later receipt atomically reduces invoice and customer debt, posts ledger and snapshot", () => {
  const s = state();
  const result = applyDriverCollection(s, collectInput(), context());
  assert.equal(s.sells.s.remainingDebt, 100);
  assert.equal(result.sell.remainingDebt, 60);
  assert.equal(result.state.customer.c.balance, -60);
  assert.equal(result.state.accounts.custody.currentBalance, 40);
  assert.equal(result.state.accounts.ar.currentBalance, 60);
  assert.equal(result.payment.commissionAmount, 4);
  assert.equal(report(result.state).summary.cashClosingAmount, 40);
  assert.equal(report(result.state).summary.commissionClosingAmount, 4);
  assert.equal(
    result.state.journalEntries["new-journal"].lines.reduce(
      (sum, l) => sum + l.debit - l.credit,
      0,
    ),
    0,
  );
});
test("retry receipt has no duplicate payment, debt or accounts effect; request reuse rejected", () => {
  const first = applyDriverCollection(state(), collectInput(), context());
  const retry = applyDriverCollection(first.state, collectInput(), context());
  assert.equal(retry.duplicate, true);
  assert.equal(Object.keys(retry.state.payment).length, 1);
  assert.equal(retry.state.accounts.custody.currentBalance, 40);
  assert.throws(
    () => applyDriverCollection(first.state, collectInput(), context("different")),
    /معرف الطلب/,
  );
});
test("rejects overpayment, foreign-driver receipt, and forged accounts before mutation", () => {
  const s = state();
  assert.throws(
    () => applyDriverCollection(s, collectInput({ amount: 200 }), context()),
    /أكبر من المتبقي/,
  );
  const input = collectInput({ driverId: "two" });
  assert.throws(
    () => applyDriverCollection(s, input, context("foreign", "two")),
    /لا تخص السائق/,
  );
  assert.throws(
    () =>
      applyDriverCollection(
        s,
        collectInput({ paymentAccountId: "treasury" }),
        context("wrong", "one"),
      ),
    /خارج صلاحية/,
  );
  assert.equal(s.accounts.ar.currentBalance, 100);
});
test("large lira collection keeps custody and commission in lira", () => {
  const s = state();
  s.sells.s.totalPrice = 1000000;
  s.sells.s.remainingDebt = 1000000;
  s.customer.c.balance = -1000000;
  s.accounts.ar.currentBalance = 1000000;
  const result = applyDriverCollection(s, collectInput({ amount: 400000 }), context());
  assert.equal(result.payment.amount, 400000);
  assert.equal(result.payment.commissionAmount, 40000);
  const r = report(result.state);
  assert.equal(r.summary.cashClosingByCurrency.SYP, 400000);
  assert.equal(r.summary.cashClosingAmount, 400000);
  assert.equal(result.state.accounts.ar.currentBalance, 600000);
});
test("remittance lowers custody, advances increase it, and payout source controls cash effect", () => {
  const collection = applyDriverCollection(
    state(),
    collectInput({ amount: 100 }),
    context("receipt"),
  );
  const remittance = applyDriverMovement(
    collection.state,
    movementInput(),
    context("hand-over"),
  );
  assert.equal(report(remittance.state).summary.cashClosingAmount, 80);
  assert.equal(
    Object.values(remittance.state.payment).filter((p) => p.type === "expense").length,
    0,
  );
  const advance = applyDriverMovement(
    remittance.state,
    movementInput({
      requestId: "advance-12345",
      type: "advance",
      amount: 50,
      sourceAccountId: "treasury",
      destinationAccountId: "custody",
    }),
    context("advance"),
  );
  assert.equal(report(advance.state).summary.cashClosingAmount, 130);
  const payout = applyDriverMovement(
    advance.state,
    movementInput({
      requestId: "payout-12345",
      type: "commission_payout",
      amount: 5,
      payoutSource: "treasury",
      sourceAccountId: "treasury",
      expenseAccountId: "expense",
    }),
    context("payout"),
  );
  assert.equal(report(payout.state).summary.cashClosingAmount, 130);
  assert.equal(report(payout.state).summary.commissionClosingAmount, 5);
  const custodyPayout = applyDriverMovement(
    payout.state,
    movementInput({
      requestId: "payout-cash-12345",
      type: "commission_payout",
      amount: 5,
      payoutSource: "driver_cash",
      expenseAccountId: "expense",
    }),
    context("custody-payout"),
  );
  assert.equal(report(custodyPayout.state).summary.cashClosingAmount, 125);
  assert.equal(report(custodyPayout.state).summary.commissionClosingAmount, 0);
  assert.throws(
    () =>
      applyDriverMovement(
        custodyPayout.state,
        movementInput({
          requestId: "overpay-12345",
          type: "commission_payout",
          amount: 1,
          payoutSource: "treasury",
          sourceAccountId: "treasury",
          expenseAccountId: "expense",
        }),
        context("overpay"),
      ),
    /مستحقات/,
  );
});
test("refund reverses original rates across multiple collectors; treasury refund keeps driver cash", () => {
  const s = state();
  s.payment = {
    p1: {
      id: "p1",
      type: "income",
      customerId: "c",
      sellId: "s",
      date: "2026-10-01T09:00:00Z",
      amount: 50,
      collectorId: "one",
      collectorName: "one",
      commissionRate: 10,
      commissionAmount: 5,
      currency: "SYP",
      collectionSource: "driver",
    },
    p2: {
      id: "p2",
      type: "income",
      customerId: "c",
      sellId: "s",
      date: "2026-10-02T09:00:00Z",
      amount: 50,
      collectorId: "two",
      collectorName: "two",
      commissionRate: 20,
      commissionAmount: 10,
      currency: "SYP",
      collectionSource: "driver",
    },
  };
  const refunds = allocateDriverRefundPayments(
    Object.values(s.payment),
    "s",
    70,
    "SYP",
  );
  assert.equal(refunds.length, 2);
  assert.equal(refunds[0].commissionAmount, -5);
  assert.equal(refunds[1].commissionAmount, -4);
  refunds.forEach(
    (r, i) => (s.payment[`refund${i}`] = { ...r, id: `refund${i}`, date: now }),
  );
  const r = report(s);
  assert.equal(r.summary.cashClosingAmount, 50);
  assert.equal(r.summary.commissionClosingAmount, 0);
  const remaining = allocateDriverRefundPayments(
    Object.values(s.payment),
    "s",
    30,
    "SYP",
    "two",
  );
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].commissionAmount, -6);
});
test("legacy unknown collector excluded from confirmed cash and commission; goods never earn commission", () => {
  const s = state();
  s.payment.old = {
    id: "old",
    type: "income",
    sellId: "s",
    customerId: "c",
    date: now,
    amount: 20,
    currency: "SYP",
  };
  s.payment.goods = {
    id: "goods",
    type: "income",
    settlementMethod: "goods",
    sellId: "s",
    date: now,
    amount: 20,
    goodsItems: [],
    goodsDirection: "receive",
  };
  const r = report(s);
  assert.equal(r.summary.cashClosingAmount, 0);
  assert.equal(r.summary.commissionClosingAmount, 0);
  assert.equal(r.summary.unknownCollectionsAmount, 20);
  assert.equal(r.settlements.length, 1);
});
test("opening/period balances use history, current inventory remains separately dated", () => {
  const s = state();
  s.products.truck1.p1.quantity = 70;
  s.driverCashMovements.open = {
    id: "open",
    driverId: "one",
    driverName: "one",
    vehicleId: "v1",
    type: "opening",
    date: "2026-09-01T08:00:00Z",
    currency: "SYP",
    amount: 0,
    openingCashOriginal: 30,
    openingCommissionAmount: 2,
    stock: [
      { productId: "p1", productName: "A", code: "A", quantity: 20, costAmount: 5 },
    ],
  };
  const r = report(s);
  assert.equal(r.summary.cashOpeningAmount, 30);
  assert.equal(r.summary.commissionOpeningAmount, 2);
  assert.equal(r.stockBalances[0].openingQuantity, 20);
  assert.equal(r.stockBalances[0].closingQuantity, 10);
  assert.equal(r.currentStock.quantity, 70);
  assert.equal(r.currentStock.asOf, now);
});
test("fully returned line reconstructed from immutable original products; older invoice debt and period returns included", () => {
  const s = state();
  s.sells.s.date = "2026-09-01T08:00:00Z";
  s.sells.s.originalProducts = s.sells.s.products;
  s.sells.s.products = [];
  s.sells.s.originalTotal = 100;
  s.sells.s.originalSubtotal = 100;
  s.sells.s.totalPrice = 0;
  s.sells.s.totalPrice = 0;
  s.sells.s.remainingDebt = 0;
  s.returns.r = {
    id: "r",
    type: "sale-return",
    referenceId: "s",
    productId: "p1",
    productCode: "A",
    productName: "A",
    payPriceAmount: 5,
    warehouse: "truck1",
    qty: 10,
    returnValue: 100,
    cashRefundAmount: 0,
    receivableCreditAmount: 100,
    createdDate: now,
  };
  const before = report(s, { dateTo: "2026-10-07" });
  assert.equal(before.summary.outstandingDebtAmount, 100);
  assert.equal(before.outstandingInvoices.length, 1);
  assert.equal(before.sales.length, 0);
  const after = report(s);
  assert.equal(after.summary.outstandingDebtAmount, 0);
  assert.equal(after.summary.returnsAmount, 100);
  assert.equal(after.summary.salesNetAmount, -100);
  assert.equal(after.summary.costAmount, -50);
  assert.equal(after.returns.length, 1);
  assert.equal(after.stockMovements[0].quantity, 10);
});
test("future cash refund has no receivable debt restoration, future receipt restores historical debt", () => {
  const s = state();
  s.sells.s.remainingDebt = 40;
  s.sells.s.paidAmount = 60;
  s.payment.future = {
    type: "income",
    sellId: "s",
    amount: 20,
    date: "2026-10-09T08:00:00Z",
  };
  s.returns.future = {
    type: "sale-return",
    referenceId: "s",
    productCode: "A",
    warehouse: "truck1",
    qty: 1,
    returnValue: 10,
    cashRefundAmount: 10,
    receivableCreditAmount: 0,
    createdDate: "2026-10-10T08:00:00Z",
  };
  const r = report(s);
  assert.equal(r.summary.outstandingDebtAmount, 60);
});
test("vehicle load is atomic, idempotent, respects reservations and records historical owner", () => {
  const s = state();
  const input = {
    vehicleId: "v1",
    sourceWarehouseId: "depot",
    sourceWarehouse: "depot",
    requestId: "load-123456",
    items: [{ productId: "p", quantity: 8 }],
    note: "",
  };
  const ctx = { actorId: "admin", now, loadId: "load1", fingerprint: "same" };
  const loaded = applyVehicleLoad(s, input, ctx);
  assert.equal(loaded.products.depot.p.quantity, 2);
  assert.equal(loaded.products.truck1.p1.quantity, 8);
  assert.equal(loaded.warehouseTransfers.load1_0.toDriverId, "one");
  assert.equal(loaded.warehouseTransfers.load1_0.toProductId, "p1");
  assert.deepEqual(applyVehicleLoad(loaded, input, ctx), loaded);
  assert.throws(
    () =>
      applyVehicleLoad(s, { ...input, items: [{ productId: "p", quantity: 9 }] }, ctx),
    /Insufficient/,
  );
  assert.equal(s.products.depot.p.quantity, 10);
});
test("driver change transfers custody while previous sales and receipts retain their owner", () => {
  const s = state();
  s.products.truck1.p1.quantity = 5;
  const next = applyVehicleCustodyChange(
    s,
    "v1",
    { driverId: "two", driverName: "two" },
    { actorId: "admin", now, transferId: "swap" },
  );
  assert.equal(next.sells.s.driverId, "one");
  assert.equal(next.warehouseTransfers.swap_0.fromDriverId, "one");
  assert.equal(next.warehouseTransfers.swap_0.toDriverId, "two");
  assert.equal(next.users.one.vehicleId, "");
  assert.equal(next.users.two.vehicleId, "v1");
  const old = report(next);
  assert.equal(old.currentStock.quantity, 0);
  const newReport = report(next, { driverId: "two" });
  assert.equal(newReport.stockBalances[0].closingQuantity, 5);
  assert.equal(newReport.currentStock.quantity, 5);
});
test("aggregate report sums drivers with owner identities and does not reassign commissions", () => {
  const s = state();
  s.payment.one = {
    id: "one",
    type: "income",
    sellId: "s",
    customerId: "c",
    date: now,
    amount: 10,
    currency: "SYP",
    collectorId: "one",
    collectorName: "one",
    collectionSource: "driver",
    commissionRate: 10,
    commissionAmount: 1,
  };
  s.payment.two = {
    ...s.payment.one,
    id: "two",
    collectorId: "two",
    collectorName: "two",
    commissionRate: 20,
    commissionAmount: 2,
  };
  const r = report(s, { driverId: "" });
  assert.equal(r.summary.cashClosingAmount, 20);
  assert.equal(r.summary.commissionClosingAmount, 3);
  assert.equal(r.sales.length, 1);
  assert.equal(r.cashMovements[1].driverId, "two");
});
test("confirmed openings replace prior history for their field and preserve subsequent movements", () => {
  const s = state();
  s.payment.old = {
    id: "old",
    type: "income",
    sellId: "s",
    customerId: "c",
    vehicleId: "v1",
    date: "2026-10-02T08:00:00Z",
    amount: 100,
    currency: "SYP",
    collectorId: "one",
    collectionSource: "driver",
    commissionRate: 10,
    commissionAmount: 10,
  };
  s.driverCashMovements.open = {
    id: "open",
    driverId: "one",
    vehicleId: "v1",
    type: "opening",
    date: "2026-10-03T08:00:00Z",
    currency: "SYP",
    amount: 0,
    openingCashOriginal: 30,
    openingCommissionAmount: 2,
    stock: [
      { productId: "p1", productName: "A", code: "A", quantity: 4, costAmount: 5 },
    ],
  };
  s.payment.after = {
    ...s.payment.old,
    id: "after",
    date: "2026-10-04T08:00:00Z",
    amount: 20,
    commissionAmount: 2,
  };
  const r = report(s);
  assert.equal(r.summary.cashClosingAmount, 50);
  assert.equal(r.summary.commissionClosingAmount, 4);
  assert.equal(r.stockBalances[0].closingQuantity, 4);
  assert.equal(
    r.cashMovements.some((row) => row.id === "old"),
    false,
  );
  assert.equal(report(s, { dateTo: "2026-10-02" }).summary.cashClosingAmount, 100);
});
test("return after vehicle handover enters actual current custody while invoice remains old driver's", () => {
  const s = state();
  s.returns.r = {
    id: "r",
    type: "sale-return",
    referenceId: "s",
    productId: "p1",
    productCode: "A",
    warehouse: "truck1",
    qty: 1,
    returnValue: 10,
    payPriceAmount: 5,
    createdDate: now,
    custodyDriverId: "two",
    custodyVehicleId: "v1",
  };
  assert.equal(
    report(s).stockMovements.filter((r) => r.type === "customer_return").length,
    0,
  );
  const newDriver = report(s, { driverId: "two" });
  assert.equal(
    newDriver.stockMovements.filter((r) => r.type === "customer_return").length,
    1,
  );
  assert.equal(newDriver.sales.length, 0);
});
test("prototype path keys rejected in receipts, movements and vehicle loads", () => {
  assert.throws(() => collectInput({ customerId: "toString" }), /غير صالح/);
  assert.throws(() => collectInput({ requestId: "__proto__" }), /غير صالح/);
  assert.throws(() => movementInput({ sourceAccountId: "constructor" }), /غير صالح/);
  assert.throws(
    () =>
      applyVehicleLoad(
        state(),
        {
          vehicleId: "v1",
          sourceWarehouse: "depot",
          requestId: "__proto__",
          items: [{ productId: "p", quantity: 1 }],
          note: "",
        },
        { actorId: "admin", now, loadId: "load", fingerprint: "" },
      ),
    /غير صالح/,
  );
});
test("backdated custody expense cannot consume later collection or duplicate previously remitted funds", () => {
  const collected = applyDriverCollection(
    state(),
    collectInput({ amount: 100, date: "2026-10-08T11:00:00Z" }),
    context("later-receipt"),
  );
  assert.throws(
    () =>
      applyDriverMovement(
        collected.state,
        movementInput({ date: "2026-10-08T10:00:00Z" }),
        context("past-remit"),
      ),
    /النقد المتبقي/,
  );
  const handed = applyDriverMovement(
    collected.state,
    movementInput({ amount: 100, date: "2026-10-08T11:30:00Z" }),
    context("fully-handed"),
  );
  assert.throws(
    () =>
      applyDriverMovement(
        handed.state,
        movementInput({ requestId: "past-remit-12345", date: "2026-10-08T11:15:00Z" }),
        context("past-remit2"),
      ),
    /سالبة بعد حركة/,
  );
});
test("driver collection changes invoice and custody by the same lira value", () => {
  const s = state();
  s.sells.s.totalPrice = 1000000;
  s.sells.s.remainingDebt = 1000000;
  s.customer.c.balance = -1000000;
  s.accounts.ar.currentBalance = 1000000;
  const result = applyDriverCollection(s, collectInput({ amount: 400000 }), context());
  assert.equal(result.sell.remainingDebt, 600000);
  assert.equal(result.state.customer.c.balance, -600000);
  assert.equal(result.state.accounts.custody.currentBalance, 400000);
  assert.equal(result.payment.commissionAmount, 40000);
});
test("future noncash customer credit from paid invoice restores no historic invoice debt", () => {
  const s = state();
  s.sells.s.remainingDebt = 0;
  s.sells.s.remainingDebt = 0;
  s.returns.future = {
    type: "sale-return",
    referenceId: "s",
    productCode: "A",
    warehouse: "truck1",
    qty: 2,
    returnValue: 20,
    cashRefundAmount: 0,
    receivableCreditAmount: 20,
    debtReductionAmount: 0,
    createdDate: "2026-10-09T08:00:00Z",
  };
  assert.equal(report(s).summary.outstandingDebtAmount, 0);
});

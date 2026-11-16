const test = require("node:test");
const assert = require("node:assert/strict");
const { planMigration } = require("../scripts/syp-migration.cjs");
const { assertSypPayload } = require("../dist/utils/currencySchema");
const { buildInvoiceMoneyBreakdown } = require("../dist/utils/money");
const { reconcileGoodsCustomerState } = require("../dist/utils/goodsSettlement");

test("all entered amounts remain lira including partial payment and percentage discount", () => {
  const money = buildInvoiceMoneyBreakdown({
    subtotal: 100000,
    paymentStatus: "part",
    partValue: 20000,
    discountPercent: 10,
    discountAmount: 5000,
    currency: "SYP",
  });
  assert.equal(money.totalPrice, 85000);
  assert.equal(money.paidAmount, 20000);
  assert.equal(money.remainingDebt, 65000);
  assertSypPayload(money);
});
test("legacy payloads and other currencies are rejected recursively", () => {
  for (const input of [
    { currency: "USD" },
    { newSell: { currency: "SYP", totalUSD: 100 } },
    { exchangeRate: 1 },
    { draft: { amountOriginal: 12 } },
  ])
    assert.throws(() => assertSypPayload(input));
  assert.doesNotThrow(() =>
    assertSypPayload({ newSell: { currency: "SYP", totalPrice: 100 } }),
  );
});
test("migration preserves recorded lira and requires manual replacement of dollars", () => {
  const source = {
    customer: { c: { balanceUSD: -20, balanceSYP: -100000 } },
    sells: {
      s: {
        customerId: "c",
        currency: "SYP",
        totalUSD: 10,
        totalSYP: 100000,
        remainingUSD: 10,
        remainingSYP: 100000,
      },
      d: { customerId: "c", currency: "USD", totalUSD: 10, remainingUSD: 10 },
    },
    products: { W: { p: { payPrice: 0, sellPrice: 0 } } },
  };
  const preview = planMigration(source);
  assert.equal(preview.output.sells.s.totalPrice, 100000);
  assert(preview.missing.includes("/sells/d/totalPrice"));
  assert(preview.missing.includes("/customer/c/balance"));
  const entries = preview.entries.map((r) => ({
    ...r,
    valueSYP:
      r.valueSYP ??
      {
        "/customer/c/balance": -150000,
        "/sells/d/totalPrice": 50000,
        "/sells/d/remainingDebt": 50000,
      }[r.path],
  }));
  const ready = planMigration(source, { entries });
  assert.equal(ready.missing.length, 0);
  assert.equal(ready.blockers.length, 0);
  assert.equal(ready.output.customer.c.balance, -150000);
  assert.equal(ready.output.customer.c.openingBalance, 0);
  assertSypPayload(ready.output);
  assert.equal(ready.output.system.moneySchema, "syp-v1");
  reconcileGoodsCustomerState(ready.output, "c");
  assert.equal(ready.output.customer.c.balance, -150000);
  assert.equal(source.sells.d.totalUSD, 10); // Source export is immutable.
});
test("migration opening balance survives later customer reconciliation", () => {
  const source = {
    customer: { c: { balanceSYP: -80000 } },
    sells: {
      s: { customerId: "c", currency: "SYP", totalSYP: 50000, remainingSYP: 50000 },
    },
  };
  const result = planMigration(source);
  assert.equal(result.missing.length, 0);
  assert.equal(result.output.customer.c.openingBalance, -30000);
  reconcileGoodsCustomerState(result.output, "c");
  assert.equal(result.output.customer.c.balance, -80000);
});
test("migration blocks unbalanced journals, pending exchanges and repeat migration", () => {
  const result = planMigration({
    journalEntries: {
      j: {
        lines: [
          {
            accountId: "cash",
            currency: "SYP",
            debit: 10,
            credit: 0,
            amountSYP: 10000,
          },
        ],
      },
    },
    exchange: { pending: {} },
  });
  assert(result.blockers.some((x) => x.includes("journal")));
  assert(result.blockers.some((x) => x.includes("exchanges")));
  assert.throws(() => planMigration({ system: { moneySchema: "syp-v1" } }));
});
test("supplier outgoing direct payment and reviewed final balance produce a stable opening balance", () => {
  const result = planMigration({
    supplier: { s: { balanceSYP: 80000 } },
    payment: {
      p: {
        supplierId: "s",
        currency: "SYP",
        amountUSD: -2,
        amountSYP: -20000,
        type: "expense",
      },
    },
  });
  assert.equal(result.missing.length, 0);
  assert.equal(result.output.supplier.s.balance, 80000);
  assert.equal(result.output.supplier.s.openingBalance, 100000);
});

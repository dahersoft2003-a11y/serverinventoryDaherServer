const test = require("node:test");
const assert = require("node:assert/strict");
const {
  normalizeCashPaymentMoney,
  sanitizeCashPaymentInput,
} = require("../dist/utils/cashPaymentInput");
const {
  assertCashPaymentAccess,
  cashPaymentHttpError,
} = require("../dist/utils/cashPaymentAccess");
const payment = (extra = {}) => ({
  currency: "SYP",
  amount: 20,
  type: "income",
  note: "",
  ...extra,
});
test("signed SYP amounts are stored unchanged", () => {
  for (const amount of [-450, 450, 1.234]) {
    const result = normalizeCashPaymentMoney({ amount, currency: "SYP" });
    assert.equal(result.amount, amount);
    assert.equal(result.type, amount > 0 ? "income" : "expense");
  }
});
test("invalid amounts and other currencies are rejected", () => {
  for (const amount of [0, NaN, Infinity, 1e13, "bad"]) {
    assert.throws(() => normalizeCashPaymentMoney({ amount, currency: "SYP" }));
  }
  assert.throws(() => normalizeCashPaymentMoney({ amount: 100, currency: "USD" }));
});
test("cash sanitizer removes vehicle and invoice credit attribution and validates request ids", () => {
  const clean = sanitizeCashPaymentInput(
    payment({
      vehicleId: "vehicle",
      adjustmentSourceSellId: "sale",
      requestId: "cash_request_1",
    }),
  );
  assert.equal(clean.vehicleId, undefined);
  assert.equal(clean.adjustmentSourceSellId, undefined);
  assert.equal(clean.requestId, "cash_request_1");
  assert.throws(() => sanitizeCashPaymentInput([]));
  assert.throws(() => sanitizeCashPaymentInput(payment({ requestId: "bad/path" })));
  assert.throws(
    () => sanitizeCashPaymentInput(payment({ customerId: ["customer"] })),
    /معرف/,
  );
  assert.throws(
    () => sanitizeCashPaymentInput(payment({ paymentAccountId: "__proto__" })),
    /معرف/,
  );
});
test("persisted page permissions authorize finance staff and keep driver collection in its own route", () => {
  assert.doesNotThrow(() => assertCashPaymentAccess({ role: "admin" }, "customer"));
  assert.doesNotThrow(() =>
    assertCashPaymentAccess({ role: "user", permissions: ["customers"] }, "customer"),
  );
  assert.doesNotThrow(() =>
    assertCashPaymentAccess({ role: "user", permissions: ["suppliers"] }, "supplier"),
  );
  for (const [actor, party] of [
    [{ role: "user", permissions: ["customers"] }, "supplier"],
    [{ role: "user", permissions: [] }, "customer"],
    [{ role: "driver", permissions: ["customers", "suppliers"] }, "customer"],
  ])
    assert.throws(
      () => assertCashPaymentAccess(actor, party),
      (error) => error.status === 403,
    );
});
test("authentication errors map to 401 and permission errors to 403 with readable messages", () => {
  assert.deepEqual(cashPaymentHttpError(new Error("UNAUTHORIZED")), {
    status: 401,
    message: "يلزم تسجيل الدخول لإضافة الدفعة",
  });
  const forbidden = Object.assign(new Error("Denied"), { status: 403 });
  assert.deepEqual(cashPaymentHttpError(forbidden), { status: 403, message: "Denied" });
  assert.deepEqual(cashPaymentHttpError(new Error("Invalid amount")), {
    status: 400,
    message: "Invalid amount",
  });
});

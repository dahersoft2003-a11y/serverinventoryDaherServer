const test = require("node:test");
const assert = require("node:assert/strict");
const { normalizeCashPaymentMoney, sanitizeCashPaymentInput } = require("../dist/utils/cashPaymentInput");
const { assertCashPaymentAccess, cashPaymentHttpError } = require("../dist/utils/cashPaymentAccess");

const payment = (extra = {}) => ({ currency: "USD", exchangeRate: 1, amount: 20, amountUSD: 20, amountOriginal: 20, amount_base: 20, type: "income", note: "", ...extra });

test("outgoing cash keeps its direction when a form sends a positive tender magnitude", () => {
  const row = normalizeCashPaymentMoney(payment({ amount: -20, amountUSD: -20, type: "income", exchangeRate: 25000 }));
  assert.equal(row.amountUSD, -20); assert.equal(row.amountOriginal, -20); assert.equal(row.amount_base, -20);
  assert.equal(row.amountSYP, 0); assert.equal(row.type, "expense"); assert.equal(row.exchangeRate, 1);
});

test("incoming supplier cash ignores a stale expense type and becomes income", () => {
  const row = normalizeCashPaymentMoney(payment({ type: "expense", supplierId: "supplier" }));
  assert.equal(row.type, "income"); assert.equal(row.amountUSD, 20);
});

test("SYP tender is authoritative and retains small amounts with three decimal USD precision", () => {
  const row = normalizeCashPaymentMoney(payment({ currency: "SYP", paymentCurrency: "SYP", exchangeRate: 20000, amount: 0, amountUSD: 0, amountOriginal: 800, amount_base: 800 }));
  assert.equal(row.amountUSD, 0.04); assert.equal(row.amountOriginal, 800); assert.equal(row.amountSYP, 800);
  const outgoing = normalizeCashPaymentMoney(payment({ currency: "SYP", exchangeRate: 20000, amount: -99, amountUSD: -99, amountOriginal: 800, amount_base: 800 }));
  assert.equal(outgoing.amountUSD, -0.04); assert.equal(outgoing.amountSYP, -800);
});

test("legacy signed SYP originals and SYR currency remain supported", () => {
  const row = normalizeCashPaymentMoney(payment({ currency: "SYR", exchangeRate: 20000, amount: -99, amountUSD: -99, amountOriginal: -400000, amount_base: -400000 }));
  assert.equal(row.currency, "SYP"); assert.equal(row.amountUSD, -20); assert.equal(row.amountOriginal, -400000);
  const legacy = normalizeCashPaymentMoney(payment({ currency: "SYP", exchangeRate: 20000, amount: 800, amountUSD: undefined, amountOriginal: undefined, amount_base: undefined }));
  assert.equal(legacy.amountUSD, 0.04); assert.equal(legacy.amountOriginal, 800);
});

test("currency, exchange rate, amount and inconsistent signed fields fail before mutation", () => {
  for (const changes of [
    { currency: "" }, { currency: "EUR" }, { currency: "SYP", exchangeRate: 0 },
    { currency: "SYP", exchangeRate: "bad" }, { amountOriginal: "bad" }, { amountUSD: NaN },
    { amountOriginal: 0 }, { amountOriginal: null, amount_base: 0 },
    { amountUSD: 20, amount: -20 }, { amountOriginal: -20 },
    { currency: "SYP", paymentCurrency: "USD" }, { amountOriginal: true }, { amountOriginal: "" },
    { requestId: "bad/path" }, { currency: "SYP", exchangeRate: 1e-12 },
  ]) assert.throws(() => normalizeCashPaymentMoney(payment(changes)), JSON.stringify(changes));
});

test("cash sanitizer removes vehicle and invoice credit attribution and validates request ids", () => {
  const clean = sanitizeCashPaymentInput(payment({ vehicleId: "vehicle", adjustmentSourceSellId: "sale", requestId: "cash_request_1" }));
  assert.equal(clean.vehicleId, undefined); assert.equal(clean.adjustmentSourceSellId, undefined); assert.equal(clean.requestId, "cash_request_1");
  assert.throws(() => sanitizeCashPaymentInput([])); assert.throws(() => sanitizeCashPaymentInput(payment({ requestId: "bad/path" })));
  assert.throws(() => sanitizeCashPaymentInput(payment({ customerId: ["customer"] })), /معرف/);
  assert.throws(() => sanitizeCashPaymentInput(payment({ paymentAccountId: "__proto__" })), /معرف/);
});

test("persisted page permissions authorize finance staff and keep driver collection in its own route", () => {
  assert.doesNotThrow(() => assertCashPaymentAccess({ role: "admin" }, "customer"));
  assert.doesNotThrow(() => assertCashPaymentAccess({ role: "user", permissions: ["customers"] }, "customer"));
  assert.doesNotThrow(() => assertCashPaymentAccess({ role: "user", permissions: ["suppliers"] }, "supplier"));
  for (const [actor, party] of [
    [{ role: "user", permissions: ["customers"] }, "supplier"],
    [{ role: "user", permissions: [] }, "customer"],
    [{ role: "driver", permissions: ["customers", "suppliers"] }, "customer"],
  ]) assert.throws(() => assertCashPaymentAccess(actor, party), error => error.status === 403);
});

test("authentication errors map to 401 and permission errors to 403 with readable messages", () => {
  assert.deepEqual(cashPaymentHttpError(new Error("UNAUTHORIZED")), { status: 401, message: "يلزم تسجيل الدخول لإضافة الدفعة" });
  const forbidden = Object.assign(new Error("Denied"), { status: 403 });
  assert.deepEqual(cashPaymentHttpError(forbidden), { status: 403, message: "Denied" });
  assert.deepEqual(cashPaymentHttpError(new Error("Invalid amount")), { status: 400, message: "Invalid amount" });
});

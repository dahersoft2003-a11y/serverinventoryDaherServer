const test = require("node:test");
const assert = require("node:assert/strict");
const { applyCashPartySettlement } = require("../dist/utils/cashPartySettlement");
const { sanitizeCashPaymentInput } = require("../dist/utils/cashPaymentInput");
const { applyGoodsPayment, normalizeGoodsPaymentInput, reconcileGoodsCustomerState } = require("../dist/utils/goodsSettlement");
const { buildPaymentMoneyBreakdown } = require("../dist/utils/money");

const now = "2026-10-08T12:00:00.000Z";
const fixture = () => ({
  warehouses: { w: { id: "w", name: "depot", type: "standard", isActive: true } },
  products: { depot: { p: { id: "p", name: "Product", code: "P", quantity: 20, reservedQuantity: 2, payPrice: 4, sellPrice: 5 } } },
  customer: { c: { id: "c", name: "Customer", balance: -100, balanceUSD: -100 } },
  supplier: { u: { id: "u", name: "Supplier", balance: 100, balanceUSD: 100 } },
  sells: { s: { id: "s", customerId: "c", totalPrice: 100, totalUSD: 100, remainingDebt: 100, currency: "USD", exchangeRate: 1 } },
  purchases: { b: { id: "b", supplierId: "u", totalPrice: 100, totalUSD: 100, remainingDebt: 100, currency: "USD", exchangeRate: 1 } },
  accounts: {
    cash: { id: "cash", name: "Cash", type: "Asset", nature: "Debit", category: "Cash", currentBalance: 1000, currency: "USD", allowTransactions: true },
    ar: { id: "ar", name: "AR", type: "Asset", nature: "Debit", category: "AccountsReceivable", currentBalance: 100, currency: "USD", allowTransactions: true },
    ap: { id: "ap", name: "AP", type: "Liability", nature: "Credit", category: "AccountsPayable", currentBalance: 100, currency: "USD", allowTransactions: true },
    inv: { id: "inv", name: "Inventory", type: "Asset", nature: "Debit", category: "Inventory", currentBalance: 80, currency: "USD", allowTransactions: true },
    diff: { id: "diff", name: "Difference", type: "Revenue", nature: "Credit", category: "Other", currentBalance: 0, currency: "USD", allowTransactions: true },
  }, payment: {}, journalEntries: {},
});
const cash = (extra = {}) => ({ id: "cash1", type: "income", customerId: "c", sellId: "s", paymentAccountId: "cash", receivableAccountId: "ar", currency: "USD", paymentCurrency: "USD", exchangeRate: 1, amount: 20, amountUSD: 20, amountOriginal: 20, amount_base: 20, date: now, note: "Receipt", settlementMethod: "cash", ...extra });
const supplierCash = (extra = {}) => cash({ type: "expense", customerId: undefined, sellId: undefined, supplierId: "u", purchaseId: "b", receivableAccountId: undefined, payableAccountId: "ap", amount: -20, amountUSD: -20, amountOriginal: -20, amount_base: -20, ...extra });
const goods = (extra = {}) => normalizeGoodsPaymentInput({ requestId: "goods-request123", partyType: "customer", customerId: "c", sellId: "s", goodsDirection: "receive", warehouse: "w", items: [{ productId: "p", quantity: 10, settlementPrice: 5 }], currency: "USD", exchangeRate: 1, note: "Goods settlement", partyAccountId: "ar", inventoryAccountId: "inv", differenceAccountId: "diff", ...extra });
const ctx = (id = "goods1") => ({ id, journalId: `${id}-journal`, requestKey: `${id}-request`, fingerprint: id, actorId: "admin", actorName: "admin", now });
const journalBalanced = (state, id) => { const lines = state.journalEntries[id].lines; assert.equal(lines.reduce((sum, l) => sum + l.debit, 0), lines.reduce((sum, l) => sum + l.credit, 0)); };

test("linked customer cash receipt changes debt, paid amounts, customer and accounts together once", () => {
  const original = fixture(); const r = applyCashPartySettlement(original, cash(), "journal1");
  assert.equal(r.sell.remainingDebt, 80); assert.equal(r.sell.paidUSD, 20); assert.equal(r.sell.paymentStatus, "part");
  assert.equal(r.state.customer.c.balanceUSD, -80); assert.equal(r.state.accounts.cash.currentBalanceUSD, 1020); assert.equal(r.state.accounts.ar.currentBalanceUSD, 80);
  reconcileGoodsCustomerState(r.state, "c"); assert.equal(r.state.customer.c.balanceUSD, -80);
  assert.equal(original.sells.s.remainingDebt, 100); journalBalanced(r.state, "journal1");
});

test("linked supplier cash payment reduces payable and increases invoice paid once", () => {
  const r = applyCashPartySettlement(fixture(), supplierCash(), "journal1");
  assert.equal(r.purchase.remainingDebt, 80); assert.equal(r.purchase.paidUSD, 20); assert.equal(r.purchase.paidAmount, 20);
  assert.equal(r.state.supplier.u.balanceUSD, 80); assert.equal(r.state.accounts.cash.currentBalanceUSD, 980); assert.equal(r.state.accounts.ap.currentBalanceUSD, 80);
  assert.equal(r.payment.amountUSD, -20); journalBalanced(r.state, "journal1");
});

test("SYP linked cash uses exact tender originals and immutable invoice rate for customer debt", () => {
  const s = fixture(); s.sells.s.currency = "SYP"; s.sells.s.exchangeRate = 10000; s.sells.s.remainingSYP = 1000000;
  s.customer.c.balanceSYP = -1000000; s.accounts.ar.currentBalanceSYP = 1000000;
  const r = applyCashPartySettlement(s, cash({ currency: "SYP", paymentCurrency: "SYP", exchangeRate: 20000, amountOriginal: 400000, amount_base: 400000, amountSYP: 400000 }), "journal1");
  assert.equal(r.sell.remainingDebt, 80); assert.equal(r.sell.remainingSYP, 800000); assert.equal(r.sell.paidOriginal, 200000);
  assert.equal(r.state.customer.c.balanceSYP, -800000); assert.equal(r.payment.balanceSYPChange, 200000);
  assert.equal(r.state.accounts.cash.currentBalanceSYP, 400000);
  assert.equal(r.state.accounts.ar.currentBalanceSYP, 800000);
  journalBalanced(r.state, "journal1");
});

test("SYP supplier payment keeps AP invoice-currency balance separate from tender amount", () => {
  const s = fixture(); s.purchases.b.currency = "SYP"; s.purchases.b.exchangeRate = 10000; s.purchases.b.remainingSYP = 1000000;
  s.supplier.u.balanceSYP = 1000000; s.accounts.ap.currentBalanceSYP = 1000000; s.accounts.cash.currentBalanceSYP = 600000;
  const r = applyCashPartySettlement(s, supplierCash({ currency: "SYP", paymentCurrency: "SYP", exchangeRate: 20000, amountOriginal: -400000, amount_base: -400000, amountSYP: -400000 }), "journal1");
  assert.equal(r.purchase.remainingSYP, 800000); assert.equal(r.purchase.paidOriginal, 200000); assert.equal(r.state.supplier.u.balanceSYP, 800000);
  assert.equal(r.state.accounts.cash.currentBalanceSYP, 200000); assert.equal(r.state.accounts.ap.currentBalanceSYP, 800000);
  journalBalanced(r.state, "journal1");
});

test("USD tender against SYP invoice decreases AR original currency at the invoice rate", () => {
  const s = fixture(); s.sells.s.currency = "SYP"; s.sells.s.exchangeRate = 10000; s.sells.s.remainingSYP = 1000000;
  s.accounts.ar.currentBalanceSYP = 1000000;
  const r = applyCashPartySettlement(s, cash(), "journal1");
  assert.equal(r.sell.remainingSYP, 800000); assert.equal(r.state.accounts.ar.currentBalanceSYP, 800000); assert.equal(r.state.accounts.cash.currentBalanceSYP, 0);
});

test("atomic validation failure leaves input invoice, accounts, payments and parties unchanged", () => {
  const s = fixture(); const before = JSON.stringify(s);
  assert.throws(() => applyCashPartySettlement(s, cash({ amountUSD: 200 }), "journal1"), /المتبقي/);
  assert.throws(() => applyCashPartySettlement(s, cash({ paymentAccountId: "missing" }), "journal1"), /الحساب/);
  assert.throws(() => applyCashPartySettlement(s, cash({ customerId: "unknown" }), "journal1"), /الطرف/);
  assert.throws(() => applyCashPartySettlement(s, cash({ amountUSD: -20, amount: -20 }), "journal1"), /اتجاه الدفعة/);
  assert.equal(JSON.stringify(s), before);
});

test("sequential customer cash and goods settlements see each other's latest invoice and accounts", () => {
  const cashFirst = applyCashPartySettlement(fixture(), cash(), "cash-journal");
  const goodsSecond = applyGoodsPayment(cashFirst.state, goods(), ctx());
  assert.equal(goodsSecond.sell.remainingDebt, 30); assert.equal(goodsSecond.sell.paidUSD, 70); assert.equal(goodsSecond.state.customer.c.balanceUSD, -30); assert.equal(goodsSecond.state.accounts.ar.currentBalanceUSD, 30);
  const goodsFirst = applyGoodsPayment(fixture(), goods(), ctx());
  const cashSecond = applyCashPartySettlement(goodsFirst.state, cash(), "cash-journal");
  assert.equal(cashSecond.sell.remainingDebt, 30); assert.equal(cashSecond.sell.paidUSD, 70); assert.equal(cashSecond.state.customer.c.balanceUSD, -30); assert.equal(cashSecond.state.accounts.ar.currentBalanceUSD, 30);
  assert.equal(cashSecond.state.accounts.cash.currentBalanceUSD, 1020); assert.equal(Object.keys(cashSecond.state.payment).length, 2);
  assert.throws(() => applyCashPartySettlement(goodsFirst.state, cash({ amountUSD: 60 }), "cash-journal"), /المتبقي/);
  assert.equal(goodsFirst.sell.remainingDebt, 50);
});

test("sequential supplier cash and goods payments cannot overwrite remaining payable", () => {
  const cashFirst = applyCashPartySettlement(fixture(), supplierCash(), "cash-journal");
  const goodsSecond = applyGoodsPayment(cashFirst.state, goods({ partyType: "supplier", customerId: undefined, sellId: undefined, supplierId: "u", purchaseId: "b", partyAccountId: "ap", goodsDirection: "deliver" }), ctx());
  assert.equal(goodsSecond.purchase.remainingDebt, 30); assert.equal(goodsSecond.state.supplier.u.balanceUSD, 30); assert.equal(goodsSecond.state.accounts.ap.currentBalanceUSD, 30);
  assert.equal(goodsSecond.state.accounts.cash.currentBalanceUSD, 980); assert.equal(goodsSecond.state.products.depot.p.quantity, 10);
});

test("direct customer outgoing cash retains balance effect through reconciliation and uses expense type", () => {
  const s = fixture(); s.sells = {}; s.payment.credit = { id: "credit", type: "income", customerId: "c", amountUSD: 100, amount: 100 };
  const r = applyCashPartySettlement(s, cash({ sellId: undefined, amountUSD: -20, amount: -20, amountOriginal: -20, amount_base: -20, type: "income" }), "journal1");
  assert.equal(r.payment.type, "expense"); assert.equal(r.state.customer.c.balanceUSD, 80);
  reconcileGoodsCustomerState(r.state, "c"); assert.equal(r.state.customer.c.balanceUSD, 80); assert.equal(r.state.accounts.cash.currentBalanceUSD, 980);
});

test("invalid party combinations, wrong invoice kind, wrong account categories and prototype ids denied", () => {
  const s = fixture();
  assert.throws(() => applyCashPartySettlement(s, cash({ supplierId: "u" }), "journal1"));
  assert.throws(() => applyCashPartySettlement(s, cash({ sellId: undefined, purchaseId: "b" }), "journal1"));
  assert.throws(() => applyCashPartySettlement(s, cash({ paymentAccountId: "inv" }), "journal1"));
  assert.throws(() => applyCashPartySettlement(s, cash({ receivableAccountId: "ap" }), "journal1"));
  assert.throws(() => applyCashPartySettlement(s, cash({ id: "__proto__" }), "journal1"));
});

test("cash input strips forged collector, commission, reversal and goods metadata and denies goods route bypass", () => {
  const forged = cash({ id: "forged", date: "1900-01-01", collectorId: "driver", collectorName: "fake", commissionRate: 100, commissionUSD: 999, commissionOriginal: 999, collectionSource: "driver", originalPaymentId: "original", refundPaidByDriverId: "driver", driverMovementId: "movement", driverId: "driver", stockDriverId: "driver", stockVehicleId: "vehicle", goodsItems: [{ productId: "p", quantity: 10 }], goodsDirection: "deliver", goodsCostUSD: 100, goodsDifferenceUSD: 100, balanceUSDChange: 999, balanceSYPChange: 999, reversalOf: "original", reversedBy: "fake", status: "reversed", createdBy: "fake", actorId: "fake", actorName: "fake", journalEntryId: "forged" });
  const clean = sanitizeCashPaymentInput(forged);
  for (const field of ["id", "date", "collectorId", "collectorName", "commissionRate", "commissionUSD", "commissionOriginal", "originalPaymentId", "refundPaidByDriverId", "driverMovementId", "driverId", "stockDriverId", "stockVehicleId", "goodsItems", "goodsDirection", "goodsCostUSD", "goodsDifferenceUSD", "balanceUSDChange", "balanceSYPChange", "reversalOf", "reversedBy", "status", "createdBy", "actorId", "actorName", "journalEntryId"]) assert.equal(Object.hasOwn(clean, field), false, field);
  assert.equal(clean.collectionSource, "management"); assert.equal(clean.settlementMethod, "cash"); assert.equal(clean.customerId, "c"); assert.equal(clean.amountUSD, 20);
  assert.throws(() => sanitizeCashPaymentInput({ ...cash(), settlementMethod: "goods" }), /التسوية بالبضاعة/);
  assert.throws(() => sanitizeCashPaymentInput({ ...cash(), type: "goods" }), /التسوية بالبضاعة/);
});

test("money normalization uses tender originals and preserves signed SYP payment", () => {
  const money = buildPaymentMoneyBreakdown({ amount: -99, amountUSD: -99, amountOriginal: -400000, currency: "SYP", exchangeRate: 20000 });
  assert.equal(money.amountUSD, -20); assert.equal(money.amountSYP, -400000); assert.equal(money.amountOriginal, -400000);
});

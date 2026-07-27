const assert = require("node:assert/strict");
const test = require("node:test");
const { calculateSaleReturn } = require("../dist/utils/saleReturn");

const productA = {
  category: "cat",
  code: "A",
  id: "product-a",
  name: "Product A",
  payPrice: 3,
  quantity: 10,
  sellPrice: 10,
  unit: "pcs",
  updatedDate: "",
  warehouse: "main",
  qty: 10,
};

const productB = {
  ...productA,
  code: "B",
  id: "product-b",
  name: "Product B",
  sellPrice: 15,
};

const makeSell = (overrides = {}) => {
  const products = overrides.products || [productA];
  const subtotal = products.reduce(
    (sum, product) => sum + product.sellPrice * product.qty,
    0,
  );
  const total = overrides.totalPrice ?? overrides.totalUSD ?? subtotal;
  const remainingDebt =
    overrides.remainingDebt ?? overrides.remainingUSD ?? 0;
  const paidUSD = overrides.paidUSD ?? total - remainingDebt;
  const currency = overrides.currency || overrides.paymentCurrency || "USD";
  const exchangeRate = currency === "SYP" ? overrides.exchangeRate || 10000 : 1;

  return {
    id: "sell-1",
    customerId: "customer-1",
    totalPrice: total,
    paymentStatus: remainingDebt === 0 ? "cash" : paidUSD > 0 ? "part" : "debt",
    remainingDebt,
    currency,
    paymentCurrency: currency,
    exchangeRate,
    amount_base: currency === "SYP" ? total * exchangeRate : total,
    subtotalUSD: overrides.subtotalUSD ?? subtotal,
    totalUSD: total,
    totalSYP: currency === "SYP" ? total * exchangeRate : 0,
    totalOriginal: currency === "SYP" ? total * exchangeRate : total,
    paidUSD,
    paidSYP: currency === "SYP" ? paidUSD * exchangeRate : 0,
    paidOriginal: currency === "SYP" ? paidUSD * exchangeRate : paidUSD,
    remainingUSD: remainingDebt,
    remainingSYP: currency === "SYP" ? remainingDebt * exchangeRate : 0,
    remainingOriginal: currency === "SYP" ? remainingDebt * exchangeRate : remainingDebt,
    products,
    ...overrides,
  };
};

const returnA = (qty) => ({
  productId: "product-a",
  code: "A",
  warehouse: "main",
  qty,
});

const assertMoney = (actual, expected) => {
  assert.equal(Number(actual.toFixed(3)), expected);
};

test("cash USD return paid in cash reduces paid and keeps customer balance unchanged", () => {
  const result = calculateSaleReturn({
    sellData: makeSell({ totalPrice: 100, paidUSD: 100, remainingDebt: 0 }),
    returnedProducts: [returnA(2)],
    returnType: "cash",
  });

  assertMoney(result.returnValueUSD, 20);
  assertMoney(result.cashRefundUSD, 20);
  assertMoney(result.receivableCreditUSD, 0);
  assertMoney(result.updatedSell.totalPrice, 80);
  assertMoney(result.updatedSell.paidUSD, 80);
  assertMoney(result.updatedSell.remainingDebt, 0);
  assert.equal(result.updatedSell.paymentStatus, "cash");
  assert.equal(result.updatedSell.products[0].qty, 8);
});

test("cash USD return on debt creates customer credit without negative invoice debt", () => {
  const result = calculateSaleReturn({
    sellData: makeSell({ totalPrice: 100, paidUSD: 100, remainingDebt: 0 }),
    returnedProducts: [returnA(2)],
    returnType: "debt",
  });

  assertMoney(result.returnValueUSD, 20);
  assertMoney(result.cashRefundUSD, 0);
  assertMoney(result.receivableCreditUSD, 20);
  assertMoney(result.updatedSell.totalPrice, 80);
  assertMoney(result.updatedSell.paidUSD, 80);
  assertMoney(result.updatedSell.remainingDebt, 0);
});

test("part USD invoice return on debt reduces invoice remaining debt", () => {
  const result = calculateSaleReturn({
    sellData: makeSell({ totalPrice: 100, paidUSD: 40, remainingDebt: 60 }),
    returnedProducts: [returnA(2)],
    returnType: "debt",
  });

  assertMoney(result.receivableCreditUSD, 20);
  assertMoney(result.updatedSell.totalPrice, 80);
  assertMoney(result.updatedSell.paidUSD, 40);
  assertMoney(result.updatedSell.remainingDebt, 40);
  assert.equal(result.updatedSell.paymentStatus, "part");
});

test("part USD invoice return in cash reduces only the paid side", () => {
  const result = calculateSaleReturn({
    sellData: makeSell({ totalPrice: 100, paidUSD: 40, remainingDebt: 60 }),
    returnedProducts: [returnA(2)],
    returnType: "cash",
  });

  assertMoney(result.cashRefundUSD, 20);
  assertMoney(result.receivableCreditUSD, 0);
  assertMoney(result.updatedSell.totalPrice, 80);
  assertMoney(result.updatedSell.paidUSD, 20);
  assertMoney(result.updatedSell.remainingDebt, 60);
});

test("part USD invoice partial return splits cash and receivable credit once", () => {
  const result = calculateSaleReturn({
    sellData: makeSell({ totalPrice: 100, paidUSD: 40, remainingDebt: 60 }),
    returnedProducts: [returnA(2)],
    returnType: "part",
    partValueUSD: 5,
  });

  assertMoney(result.cashRefundUSD, 5);
  assertMoney(result.receivableCreditUSD, 15);
  assertMoney(result.updatedSell.totalPrice, 80);
  assertMoney(result.updatedSell.paidUSD, 35);
  assertMoney(result.updatedSell.remainingDebt, 45);
});

test("debt USD invoice return on debt reduces the full remaining debt", () => {
  const result = calculateSaleReturn({
    sellData: makeSell({ totalPrice: 100, paidUSD: 0, remainingDebt: 100 }),
    returnedProducts: [returnA(2)],
    returnType: "debt",
  });

  assertMoney(result.receivableCreditUSD, 20);
  assertMoney(result.updatedSell.totalPrice, 80);
  assertMoney(result.updatedSell.paidUSD, 0);
  assertMoney(result.updatedSell.remainingDebt, 80);
  assert.equal(result.updatedSell.paymentStatus, "debt");
});

test("debt USD invoice cannot refund cash that was never paid", () => {
  assert.throws(
    () =>
      calculateSaleReturn({
        sellData: makeSell({ totalPrice: 100, paidUSD: 0, remainingDebt: 100 }),
        returnedProducts: [returnA(2)],
        returnType: "cash",
      }),
    /greater than the amount paid/,
  );
});

test("SYP partial return updates original and SYP amounts consistently", () => {
  const result = calculateSaleReturn({
    sellData: makeSell({
      currency: "SYP",
      exchangeRate: 10000,
      totalPrice: 100,
      paidUSD: 40,
      remainingDebt: 60,
    }),
    returnedProducts: [returnA(2)],
    returnType: "part",
    partValueUSD: 5,
  });

  assertMoney(result.cashRefundUSD, 5);
  assertMoney(result.cashRefundSYP, 50000);
  assertMoney(result.receivableCreditUSD, 15);
  assertMoney(result.receivableCreditSYP, 150000);
  assertMoney(result.updatedSell.totalSYP, 800000);
  assertMoney(result.updatedSell.paidSYP, 350000);
  assertMoney(result.updatedSell.remainingSYP, 450000);
});

test("discounted invoices return the net discounted value, not gross line value", () => {
  const result = calculateSaleReturn({
    sellData: makeSell({
      totalPrice: 90,
      totalUSD: 90,
      paidUSD: 90,
      remainingDebt: 0,
      discountPercent: 10,
    }),
    returnedProducts: [returnA(2)],
    returnType: "cash",
  });

  assertMoney(result.returnValueUSD, 18);
  assertMoney(result.updatedSell.subtotalUSD, 80);
  assertMoney(result.updatedSell.discountUSD, 8);
  assertMoney(result.updatedSell.totalPrice, 72);
  assertMoney(result.updatedSell.paidUSD, 72);
});

test("batch partial return applies partValue once across all returned lines", () => {
  const result = calculateSaleReturn({
    sellData: makeSell({
      products: [{ ...productA, qty: 5 }, { ...productB, qty: 5 }],
      totalPrice: 125,
      paidUSD: 75,
      remainingDebt: 50,
    }),
    returnedProducts: [
      { productId: "product-a", code: "A", warehouse: "main", qty: 2 },
      { productId: "product-b", code: "B", warehouse: "main", qty: 2 },
    ],
    returnType: "part",
    partValueUSD: 10,
  });

  assertMoney(result.returnValueUSD, 50);
  assertMoney(result.cashRefundUSD, 10);
  assertMoney(result.receivableCreditUSD, 40);
  assertMoney(result.updatedSell.totalPrice, 75);
  assertMoney(result.updatedSell.paidUSD, 65);
  assertMoney(result.updatedSell.remainingDebt, 10);
  assert.equal(result.returnedLines.length, 2);
  assertMoney(
    result.returnedLines.reduce((sum, line) => sum + line.netValueUSD, 0),
    50,
  );
});

test("full debt return closes the invoice", () => {
  const result = calculateSaleReturn({
    sellData: makeSell({ totalPrice: 100, paidUSD: 0, remainingDebt: 100 }),
    returnedProducts: [returnA(10)],
    returnType: "debt",
  });

  assertMoney(result.returnValueUSD, 100);
  assertMoney(result.updatedSell.totalPrice, 0);
  assertMoney(result.updatedSell.paidUSD, 0);
  assertMoney(result.updatedSell.remainingDebt, 0);
  assert.equal(result.updatedSell.paymentStatus, "cash");
  assert.equal(result.updatedSell.products.length, 0);
});

test("over-return quantity is rejected", () => {
  assert.throws(
    () =>
      calculateSaleReturn({
        sellData: makeSell(),
        returnedProducts: [returnA(11)],
        returnType: "debt",
      }),
    /greater than invoice remaining quantity/,
  );
});

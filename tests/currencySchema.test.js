const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");

function load(marker) {
  const file = path.resolve(__dirname, "../dist/middleware/currencySchema.js"),
    module = { exports: {} };
  vm.runInThisContext(
    `(function(require,module,exports){${fs.readFileSync(file, "utf8")}\n})`,
    { filename: file },
  )(
    (name) => {
      if (name === "firebase/database")
        return { ref: (_db, p) => p, get: async () => ({ val: () => marker }) };
      if (name === "../firebaseConfig") return { database: {} };
      if (name === "../utils/currencySchema")
        return require("../dist/utils/currencySchema");
      return require(name);
    },
    module,
    module.exports,
  );
  return module.exports.requireSypSchema;
}
async function request(
  marker,
  method = "POST",
  header = "syp-v1",
  body = { amount: 500, currency: "SYP" },
) {
  let called = false,
    status = 200,
    data;
  await load(marker)(
    { method, body, header: () => header },
    {
      status: (n) => {
        status = n;
        return {
          json: (v) => {
            data = v;
          },
        };
      },
    },
    () => {
      called = true;
    },
  );
  return { called, status, data };
}
test("new server refuses reads and writes until reviewed database migration", async () => {
  for (const method of ["GET", "POST"]) {
    const r = await request(undefined, method);
    assert.equal(r.status, 503);
    assert.equal(r.called, false);
    assert.equal(r.data.code, "MONEY_MIGRATION_REQUIRED");
  }
});
test("old clients and legacy amounts cannot write into a migrated database", async () => {
  assert.equal((await request("syp-v1", "POST", "")).status, 400);
  assert.equal(
    (await request("syp-v1", "POST", "syp-v1", { currency: "USD", amount: 5 })).status,
    400,
  );
  assert.equal(
    (await request("syp-v1", "POST", "syp-v1", { draft: { exchangeRate: 1 } })).status,
    400,
  );
});
test("canonical lira writes and reads reach the route after migration", async () => {
  assert.equal((await request("syp-v1")).called, true);
  assert.equal((await request("syp-v1", "GET", "")).called, true);
});

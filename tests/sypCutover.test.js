const test = require("node:test");
const assert = require("node:assert/strict");
const { fingerprint, migrationUpdater, checkDeployedServer } = require("../scripts/apply-syp-migration.cjs");

test("cutover compares complete snapshots regardless of Firebase key ordering", () => {
  assert.equal(fingerprint({ b: { y: 2, x: 1 }, a: 0 }), fingerprint({ a: 0, b: { x: 1, y: 2 } }));
});
test("cutover aborts on a concurrent payment or an already migrated database", () => {
  const source = { customer: { c: { balanceSYP: -1000 } }, payment: {} };
  const ready = { customer: { c: { balance: -1000 } }, system: { moneySchema: "syp-v1" } };
  const update = migrationUpdater(source, ready);
  assert.deepEqual(update(source), ready);
  assert.deepEqual(update(null), ready);
  assert.equal(update({ ...source, payment: { p: { amountSYP: 500 } } }), undefined);
  assert.equal(update(ready), undefined);
});
test("database cutover requires the new deployed API before any write", async () => {
  const original = global.fetch;
  try {
    global.fetch = async () => ({ status: 200, json: async () => [] });
    await assert.rejects(checkDeployedServer("https://example.invalid"), /must be deployed/);
    global.fetch = async (url) => {
      assert.equal(url.pathname, "/api/account/get-account");
      return { status: 503, json: async () => ({ code: "MONEY_MIGRATION_REQUIRED" }) };
    };
    await checkDeployedServer("https://example.invalid");
  } finally { global.fetch = original; }
});

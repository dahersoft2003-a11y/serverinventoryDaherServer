/* Coordinated cutover only: the deployed API must already run the SYP version. */
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { planMigration, SCHEMA } = require("./syp-migration.cjs");

const canonical = (value) => {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
};
const fingerprint = (value) => crypto.createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""));

function validateBundle(sourceFile, reviewFile, readyFile) {
  const raw = fs.readFileSync(sourceFile, "utf8").replace(/^\uFEFF/, "");
  const source = JSON.parse(raw), review = readJson(reviewFile), ready = readJson(readyFile);
  if (review.approved !== true || review.sourceHash !== crypto.createHash("sha256").update(raw).digest("hex")) {
    throw new Error("The approved review must match the exact source export.");
  }
  const result = planMigration(source, review);
  if (result.missing.length || result.blockers.length || fingerprint(result.output) !== fingerprint(ready)) {
    throw new Error("The prepared data no longer matches the validated migration.");
  }
  require("../dist/utils/currencySchema").assertSypPayload(ready);
  return { source, ready };
}

function migrationUpdater(source, ready) {
  const expected = fingerprint(source);
  return (current) => {
    const data = current || source;
    if (data.system?.moneySchema === SCHEMA || fingerprint(data) !== expected) return undefined;
    return ready;
  };
}

async function checkDeployedServer(apiUrl) {
  const url = new URL(apiUrl);
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("Invalid API URL.");
  url.pathname = url.pathname.replace(/\/$/, "").replace(/\/api$/, "") + "/api/account/get-account";
  url.search = "";
  const response = await fetch(url, { signal: AbortSignal.timeout(20000), headers: { "X-Money-Schema": SCHEMA } });
  const body = await response.json().catch(() => null);
  if (response.status !== 503 || body?.code !== "MONEY_MIGRATION_REQUIRED") {
    throw new Error(`The SYP server must be deployed before changing the database (probe status ${response.status}).`);
  }
}

async function main() {
  const [mode, sourceFile, reviewFile, readyFile, apiUrl] = process.argv.slice(2);
  if (!["--check", "--apply"].includes(mode) || !sourceFile || !reviewFile || !readyFile || !apiUrl) {
    throw new Error("Usage: node scripts/apply-syp-migration.cjs --check|--apply source.json review.json ready.json https://your-api");
  }
  const { source, ready } = validateBundle(sourceFile, reviewFile, readyFile);
  await checkDeployedServer(apiUrl);
  require("dotenv").config({ quiet: true });
  const { database } = require("../dist/firebaseConfig");
  const { get, ref, runTransaction, goOffline } = require("firebase/database");
  let timeout;
  try {
    const rootRef = ref(database);
    const snapshot = await Promise.race([
      get(rootRef),
      new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error("Database read timed out.")), 20000); }),
    ]);
    if (!snapshot.exists() || fingerprint(snapshot.val()) !== fingerprint(source)) {
      throw new Error("Live data changed after the export. Export and review it again before cutover.");
    }
    if (mode === "--check") { console.log(JSON.stringify({ ready: true, databaseChanged: false })); return; }
    const backup = path.join(path.dirname(path.resolve(sourceFile)), `before-live-syp-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
    fs.writeFileSync(backup, JSON.stringify(snapshot.val(), null, 2), { flag: "wx" });
    const result = await runTransaction(rootRef, migrationUpdater(source, ready), { applyLocally: false });
    if (!result.committed) throw new Error("Cutover cancelled: concurrent changes or an existing migration were detected.");
    if (fingerprint(result.snapshot.val()) !== fingerprint(ready)) throw new Error("The committed snapshot needs review; do not restore over newer operations.");
    console.log(JSON.stringify({ migrated: true, schema: SCHEMA, backup }));
  } finally { clearTimeout(timeout); goOffline(database); }
}
module.exports = { fingerprint, validateBundle, migrationUpdater, checkDeployedServer };
if (require.main === module) main().catch((error) => { console.error(error.message); process.exitCode = 1; });

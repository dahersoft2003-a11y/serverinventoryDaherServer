const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const jwt = require("jsonwebtoken");

// Real login, JWT verification and persisted cash-payment access against offline RTDB.
process.env.JWT_SECRET = "offline-auth-session-test-secret";
delete process.env.JWT_EXPIRES_IN;

const { generateToken, verifyToken } = require("../dist/utils/jwt");
const { getUserFromToken } = require("../dist/utils/currentUser");
const { assertCashPaymentAccess } = require("../dist/utils/cashPaymentAccess");
let users;
let reads;
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  const parentName = parent?.filename.replace(/\\/g, "/") || "";
  if (parentName.endsWith("/dist/controllers/auth.controller.js") ||
      parentName.endsWith("/dist/utils/driverCommission.js")) {
    if (request === "../firebaseConfig") return { database: {} };
    if (request === "firebase/database") return {
      ref: (_database, path) => ({ path }),
      get: async ({ path }) => {
        reads.push(path);
        const key = path.slice("users/".length);
        const value = Object.hasOwn(users, key) ? users[key] : undefined;
        return { key, exists: () => value !== undefined, val: () => value };
      },
      set: () => { throw new Error("Login must not write to RTDB"); },
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};
let login;
let requireFinanceUser;
try {
  ({ login } = require("../dist/controllers/auth.controller"));
  ({ requireFinanceUser } = require("../dist/utils/financeAuth"));
} finally {
  Module._load = originalLoad;
}

const reset = () => {
  reads = [];
  users = {
    "cashier-01": {
      username: "موظف التحصيل محمد", password: "test password",
      role: "user", permissions: ["customers", "suppliers", "   ", 8],
    },
  };
};
const loginRequest = async body => {
  const result = { status: 200 };
  const res = {
    status: status => { result.status = status; return res; },
    json: body => { result.body = body; return res; },
  };
  await login({ body }, res);
  return result;
};
const withToken = token => ({ headers: { authorization: `Bearer ${token}` } });

test("fresh login for a renamed account uses its database key and authorizes cash payments immediately", async () => {
  reset();
  const response = await loginRequest({ username: " cashier-01 ", password: "test password" });
  assert.equal(response.status, 200);
  const token = verifyToken(response.body.token);
  assert.equal(token.userId, "cashier-01");
  assert.equal(token.username, "موظف التحصيل محمد");
  assert.equal(response.body.user.id, token.userId);
  assert.deepEqual(token.permissions, ["customers", "suppliers"]);
  assert.equal(token.exp - token.iat, 7 * 24 * 60 * 60);
  const actor = await requireFinanceUser(withToken(response.body.token));
  assert.equal(actor.userId, "cashier-01");
  assert.equal(actor.username, "موظف التحصيل محمد");
  assert.doesNotThrow(() => assertCashPaymentAccess(actor, "customer"));
  assert.doesNotThrow(() => assertCashPaymentAccess(actor, "supplier"));
  assert.deepEqual(reads, ["users/cashier-01", "users/cashier-01"]);
});

test("changing a display name after login preserves the stable identity and uses current persisted permissions", async () => {
  reset();
  const response = await loginRequest({ username: "cashier-01", password: "test password" });
  users["cashier-01"].username = "اسم معدل / ليس مفتاح قاعدة بيانات";
  users["cashier-01"].permissions = ["suppliers"];
  const actor = await requireFinanceUser(withToken(response.body.token));
  assert.equal(actor.username, users["cashier-01"].username);
  assert.throws(() => assertCashPaymentAccess(actor, "customer"));
  assert.doesNotThrow(() => assertCashPaymentAccess(actor, "supplier"));
});

test("login falls back to the database key when the stored display name is absent", async () => {
  reset();
  delete users["cashier-01"].username;
  const response = await loginRequest({ username: "cashier-01", password: "test password" });
  const token = verifyToken(response.body.token);
  assert.equal(token.userId, "cashier-01");
  assert.equal(token.username, "cashier-01");
  assert.equal((await requireFinanceUser(withToken(response.body.token))).userId, "cashier-01");
});

test("incorrect credentials and invalid usernames fail without producing a token or reading an arbitrary database path", async () => {
  reset();
  const wrongPassword = await loginRequest({ username: "cashier-01", password: "wrong" });
  assert.equal(wrongPassword.status, 401);
  assert.equal(wrongPassword.body.token, undefined);
  const missingUser = await loginRequest({ username: "absent", password: "test password" });
  assert.equal(missingUser.status, 401);
  const readCount = reads.length;
  for (const body of [undefined, {}, { username: "../cashier-01", password: "test password" },
    { username: "__proto__", password: "test password" }, { username: {}, password: "test password" },
    { username: "cashier-01", password: null }]) {
    const response = await loginRequest(body);
    assert.equal(response.status, 400);
    assert.equal(response.body.token, undefined);
  }
  assert.equal(reads.length, readCount);
});

test("expired, forged or absent tokens remain unauthorized and cannot use untrusted identity headers", async () => {
  reset();
  const expired = generateToken({ userId: "cashier-01", iat: Math.floor(Date.now() / 1000) - 8 * 24 * 60 * 60 });
  const forged = jwt.sign({ userId: "cashier-01" }, "another-offline-secret", { expiresIn: "7d" });
  for (const token of [expired, forged, "not-a-token", undefined]) {
    assert.equal(getUserFromToken(token), null);
    await assert.rejects(() => requireFinanceUser({ headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      "x-inventory-user-id": "cashier-01", "x-inventory-role": "admin",
    } }), /UNAUTHORIZED/);
  }
  assert.equal(reads.length, 0);
});

test("deleted users and stale role claims do not retain cash-payment authority", async () => {
  reset();
  const token = generateToken({ userId: "cashier-01", username: "cashier-01", role: "admin", permissions: ["customers"] });
  users["cashier-01"].permissions = [];
  const actor = await requireFinanceUser(withToken(token));
  assert.equal(actor.role, "user");
  assert.throws(() => assertCashPaymentAccess(actor, "customer"));
  delete users["cashier-01"];
  await assert.rejects(() => requireFinanceUser(withToken(token)), /UNAUTHORIZED/);
});

test("JWT lifetime can be configured in duration units or seconds and rejects invalid values", () => {
  const jwtModulePath = require.resolve("../dist/utils/jwt");
  const originalModule = require.cache[jwtModulePath];
  const originalLifetime = process.env.JWT_EXPIRES_IN;
  try {
    for (const [value, seconds] of [["12h", 43200], ["14d", 1209600], ["7200", 7200], [" 2w ", 1209600]]) {
      process.env.JWT_EXPIRES_IN = value;
      delete require.cache[jwtModulePath];
      const configured = require(jwtModulePath);
      const token = configured.verifyToken(configured.generateToken({ userId: "offline" }));
      assert.equal(token.exp - token.iat, seconds);
    }
    for (const value of ["0", "-1h", "tomorrow", "1h;unsafe", "999999999999999999999999", "999999999999999999999999d"]) {
      process.env.JWT_EXPIRES_IN = value;
      delete require.cache[jwtModulePath];
      assert.throws(() => require(jwtModulePath), /JWT_EXPIRES_IN/);
    }
  } finally {
    if (originalLifetime === undefined) delete process.env.JWT_EXPIRES_IN;
    else process.env.JWT_EXPIRES_IN = originalLifetime;
    require.cache[jwtModulePath] = originalModule;
  }
});

test("JWT loads its secret and lifetime from dotenv before any Firebase import", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wakil-auth-env-"));
  const jwtModulePath = require.resolve("../dist/utils/jwt");
  try {
    fs.writeFileSync(path.join(directory, ".env"), "JWT_SECRET=isolated-offline-env-secret\nJWT_EXPIRES_IN=3d\n");
    const environment = { ...process.env };
    delete environment.JWT_SECRET;
    delete environment.JWT_EXPIRES_IN;
    const script = `
      const assert = require("node:assert/strict");
      const tokens = require(${JSON.stringify(jwtModulePath)});
      const payload = tokens.verifyToken(tokens.generateToken({ userId: "offline" }));
      assert.equal(process.env.JWT_SECRET, "isolated-offline-env-secret");
      assert.equal(payload.exp - payload.iat, 3 * 24 * 60 * 60);
      assert.equal(Object.keys(require.cache).some(file => /firebaseConfig/.test(file)), false);
    `;
    const result = spawnSync(process.execPath, ["-e", script], { cwd: directory, env: environment, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  } finally {
    fs.unlinkSync(path.join(directory, ".env"));
    fs.rmdirSync(directory);
  }
});

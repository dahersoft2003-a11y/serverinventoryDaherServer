import { randomUUID, createHash } from "crypto";
import { Request, Response } from "express";
import { get, ref, runTransaction } from "firebase/database";
import { database } from "../firebaseConfig";
import { requireFinanceUser } from "../utils/financeAuth";
import { buildDriverStatement, dayInDamascus } from "../utils/driverFinanceCalc";
import { applyDriverCollection, applyDriverMovement, normalizeDriverRequest, validDriverKey } from "../utils/driverFinanceMutations";

const respondError = (res: Response, error: unknown) => {
  const message = error instanceof Error ? error.message : "تعذر تنفيذ العملية";
  return res.status(message === "UNAUTHORIZED" ? 401 : message === "FORBIDDEN" ? 403 : 400).json({ error: message === "UNAUTHORIZED" ? "يلزم تسجيل الدخول" : message === "FORBIDDEN" ? "ليس لديك صلاحية لهذه العملية" : message });
};
export const getDriverStatement = async (req: Request, res: Response) => {
  try {
    const actor = await requireFinanceUser(req);
    if (actor.role !== "admin" && actor.role !== "driver") {
      const userSnapshot = await get(ref(database, `users/${actor.userId}`));
      const user = userSnapshot.val();
      if (!user?.vehicleId && !user?.commissionRateHistory?.length) throw new Error("FORBIDDEN");
    }
    const driverId = validDriverKey(req.query.driverId || (actor.role === "admin" ? "" : actor.userId), "السائق", actor.role === "admin");
    if (actor.role !== "admin" && driverId !== actor.userId) throw new Error("FORBIDDEN");
    const today = dayInDamascus(new Date().toISOString());
    const dateFrom = String(req.query.dateFrom || `${today.slice(0, 7)}-01`);
    const dateTo = String(req.query.dateTo || today);
    const vehicleId = validDriverKey(req.query.vehicleId, "السيارة", true);
    if (![dateFrom, dateTo].every(d => /^\d{4}-\d{2}-\d{2}$/.test(d) && Number.isFinite(new Date(`${d}T00:00:00Z`).getTime()) && new Date(`${d}T00:00:00Z`).toISOString().slice(0, 10) === d) || dateFrom > dateTo) throw new Error("الفترة الزمنية غير صالحة");
    const paths = ["users", "warehouses", "products", "sells", "payment", "returns", "warehouseTransfers", "driverCashMovements", "customer"];
    const snapshots = await Promise.all(paths.map(path => get(ref(database, path))));
    const data = Object.fromEntries(paths.map((path, i) => [path, snapshots[i].exists() ? snapshots[i].val() : {}]));
    if (driverId && !data.users[driverId]) return res.status(404).json({ error: "السائق غير موجود" });
    const statement = buildDriverStatement({ driverId, dateFrom, dateTo, vehicleId, users: data.users, warehouses: data.warehouses, products: data.products, sells: data.sells, payments: data.payment, returns: data.returns, transfers: data.warehouseTransfers, movements: data.driverCashMovements, customers: data.customer });
    if (actor.role !== "admin") { statement.drivers = statement.drivers.filter(d => d.id === actor.userId); statement.vehicles = statement.vehicles.filter(v => v.driverId === actor.userId || statement.sales.some(s => s.vehicleId === v.id) || statement.stockBalances.some(s => s.vehicleId === v.id)); }
    return res.json(statement);
  } catch (error) { return respondError(res, error); }
};

const recordDriverOperation = async (req: Request, res: Response, kind: "collection" | "movement") => {
  try {
    const actor = await requireFinanceUser(req);
    const now = new Date().toISOString();
    const input = normalizeDriverRequest(req.body, kind, actor.role === "admin", actor.userId, now);
    // The idempotency fingerprint excludes the defaulted server date so retries are stable.
    const fingerprintInput = { ...input, date: req.body.date || "server-now" };
    const fingerprint = createHash("sha256").update(JSON.stringify(fingerprintInput)).digest("hex");
    const context = { id: randomUUID(), journalId: randomUUID(), actorId: actor.userId, actorName: actor.username, now, fingerprint };
    const root = ref(database);
    const initialSnapshot = await get(root);
    if (!initialSnapshot.exists()) throw new Error("لا توجد بيانات لبدء العملية");
    let output: any;
    const transaction = await runTransaction(root, (state) => {
      const current = state || initialSnapshot.val();
      output = kind === "collection" ? applyDriverCollection(current, input, context) : applyDriverMovement(current, input, context);
      return output.state;
    }, { applyLocally: false });
    if (!transaction.committed || !output) throw new Error("تعذر تثبيت العملية؛ أعد المحاولة بنفس معرف الطلب");
    const { state: _state, ...result } = output;
    return res.status(result.duplicate ? 200 : 201).json(result);
  } catch (error) { return respondError(res, error); }
};
export const createDriverCollection = (req: Request, res: Response) => recordDriverOperation(req, res, "collection");
export const createDriverMovement = (req: Request, res: Response) => recordDriverOperation(req, res, "movement");

import { Request, Response } from "express";
import { get, ref, remove, set, update, runTransaction } from "firebase/database";
import { database } from "../firebaseConfig";
import { InventoryUser, InventoryUserResponse } from "../types/user";
import { requireFinanceUser } from "../utils/financeAuth";
import { commissionRateAt, financialDate, dayInDamascus } from "../utils/driverFinanceCalc";
import { randomUUID } from "crypto";

const USERS_PATH = "users";
const INVALID_FIREBASE_KEY_CHARS = /[.#$\/\[\]]/;
const ARABIC_USERNAME_CHAR_PATTERN =
  /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/;

const getTimestamp = () => new Date().toISOString();

const normalizePermissions = (permissions: unknown): string[] => {
  if (!Array.isArray(permissions)) return [];

  return permissions
    .filter((permission): permission is string => typeof permission === "string")
    .map((permission) => permission.trim())
    .filter(Boolean);
};

const normalizeRole = (role: unknown) =>
  typeof role === "string" && role.trim() ? role.trim() : "user";

const toUserResponse = (
  key: string,
  user: InventoryUser,
): InventoryUserResponse => ({
  id: key,
  username: user.username || key,
  role: normalizeRole(user.role),
  permissions: normalizePermissions(user.permissions),
  vehicleId: user.vehicleId,
  vehicleName: user.vehicleName,
  createdAt: user.createdAt,
  updatedAt: user.updatedAt,
  commissionRate: commissionRateAt(user, getTimestamp()),
  commissionEffectiveFrom: user.commissionEffectiveFrom,
  commissionRateHistory: user.commissionRateHistory || [],
});

const isInvalidUsername = (username: string) =>
  !username.trim() || INVALID_FIREBASE_KEY_CHARS.test(username) || Object.prototype.hasOwnProperty.call(Object.prototype, username);

const hasArabicUsernameChars = (username: string) =>
  ARABIC_USERNAME_CHAR_PATTERN.test(username);

const requireAdmin = async (req: Request, res: Response) => {
  let currentUser;
  try { currentUser = await requireFinanceUser(req); } catch {
    res.status(401).json({ error: "Unauthorized" });
    return null;
  }

  if (currentUser.role !== "admin") {
    res.status(403).json({ error: "Admin permission is required" });
    return null;
  }

  return currentUser;
};

const commissionUpdates = (body: any, existing: InventoryUser | undefined, actorId: string, now: string): Partial<InventoryUser> => {
  if (body.commissionRateHistory !== undefined) throw new Error("سجل النسب يُنشأ على الخادم ولا يمكن تعديله مباشرة");
  if (body.commissionRate === undefined) return {};
  const rate = Number(body.commissionRate);
  if (!Number.isFinite(rate) || rate < 0 || rate > 100) throw new Error("نسبة السائق يجب أن تكون بين 0 و100");
  const effectiveFrom = body.commissionEffectiveFrom ? financialDate(body.commissionEffectiveFrom) : now;
  if (!effectiveFrom || existing && dayInDamascus(effectiveFrom) < dayInDamascus(now)) throw new Error("لا يمكن تغيير النسبة بتاريخ قديم؛ اختر اليوم أو تاريخًا لاحقًا");
  const history = Array.isArray(existing?.commissionRateHistory) ? [...existing!.commissionRateHistory!] : [];
  if (existing && !history.length && existing.commissionRate !== undefined) history.push({ id: randomUUID(), rate: existing.commissionRate, effectiveFrom: financialDate(existing.commissionEffectiveFrom || existing.createdAt) || "1970-01-01T00:00:00.000Z", createdAt: now, createdBy: actorId });
  const rateChange = { id: randomUUID(), rate, effectiveFrom, createdAt: now, createdBy: actorId };
  history.push(rateChange);
  return { commissionRate: rate, commissionEffectiveFrom: effectiveFrom, commissionRateHistory: history };
};

const getUserEntries = async () => {
  const snapshot = await get(ref(database, USERS_PATH));

  return snapshot.exists()
    ? Object.entries(snapshot.val() as Record<string, InventoryUser>)
    : [];
};

const countAdmins = (users: Array<[string, InventoryUser]>) =>
  users.filter(([, user]) => normalizeRole(user.role) === "admin").length;

export const getAllUsers = async (req: Request, res: Response) => {
  if (!await requireAdmin(req, res)) return;

  try {
    const users = (await getUserEntries()).map(([key, user]) =>
      toUserResponse(key, user),
    );

    res.json(users);
  } catch (error: any) {
    console.error("Error fetching users:", error);
    res.status(500).json({ error: error.message });
  }
};

export const createUser = async (req: Request, res: Response) => {
  const currentUser = await requireAdmin(req, res);
  if (!currentUser) return;

  const username =
    typeof req.body.username === "string" ? req.body.username.trim() : "";
  const password =
    typeof req.body.password === "string" ? req.body.password : "";
  const role = normalizeRole(req.body.role);
  const permissions =
    role === "admin" ? [] : normalizePermissions(req.body.permissions);
  const vehicleId =
    typeof req.body.vehicleId === "string" ? req.body.vehicleId.trim() : "";
  const vehicleName =
    typeof req.body.vehicleName === "string" ? req.body.vehicleName.trim() : "";

  if (isInvalidUsername(username)) {
    return res.status(400).json({
      error:
        "Username is required and cannot contain Firebase key characters: . # $ / [ ]",
    });
  }

  if (hasArabicUsernameChars(username)) {
    return res
      .status(400)
      .json({ error: "Username cannot contain Arabic characters" });
  }

  if (!password.trim()) {
    return res.status(400).json({ error: "Password is required" });
  }

  try {
    const dbRef = ref(database, `${USERS_PATH}/${username}`);
    const snapshot = await get(dbRef);

    if (snapshot.exists()) {
      return res.status(400).json({ error: "User already exists" });
    }

    const now = getTimestamp();
    const user: InventoryUser = {
      username,
      password,
      role,
      permissions,
      ...(vehicleId ? { vehicleId } : {}),
      ...(vehicleName ? { vehicleName } : {}),
      createdAt: now,
      updatedAt: now,
      ...commissionUpdates(req.body, undefined, currentUser.userId, now),
    };

    await set(dbRef, user);

    res.json({
      message: "User created successfully",
      data: toUserResponse(username, user),
    });
  } catch (error: any) {
    console.error("Error creating user:", error);
    res.status(400).json({ error: error.message });
  }
};

export const updateUser = async (req: Request, res: Response) => {
  const currentUser = await requireAdmin(req, res);
  if (!currentUser) return;

  const { id } = req.params;

  if (isInvalidUsername(id)) {
    return res.status(400).json({ error: "Invalid user id" });
  }

  try {
    const dbRef = ref(database, `${USERS_PATH}/${id}`);
    const snapshot = await get(dbRef);

    if (!snapshot.exists()) {
      return res.status(404).json({ error: "User not found" });
    }

    const existingUser = snapshot.val() as InventoryUser;
    const nextRole =
      req.body.role === undefined ? existingUser.role : normalizeRole(req.body.role);

    if (
      (currentUser.username === id || currentUser.userId === id) &&
      nextRole !== "admin"
    ) {
      return res
        .status(400)
        .json({ error: "You cannot remove admin role from your own user" });
    }

    if (normalizeRole(existingUser.role) === "admin" && nextRole !== "admin") {
      const adminCount = countAdmins(await getUserEntries());

      if (adminCount <= 1) {
        return res
          .status(400)
          .json({ error: "At least one admin user is required" });
      }
    }

    const updates: Partial<InventoryUser> = {
      role: nextRole,
      permissions:
        nextRole === "admin"
          ? []
          : req.body.permissions === undefined
            ? normalizePermissions(existingUser.permissions)
            : normalizePermissions(req.body.permissions),
      updatedAt: getTimestamp(),
      ...commissionUpdates(req.body, existingUser, currentUser.userId, getTimestamp()),
    };

    if (req.body.vehicleId !== undefined) {
      const vehicleId =
        typeof req.body.vehicleId === "string" ? req.body.vehicleId.trim() : "";

      if (vehicleId) {
        updates.vehicleId = vehicleId;
      } else {
        updates.vehicleId = "";
      }
    }

    if (req.body.vehicleName !== undefined) {
      const vehicleName =
        typeof req.body.vehicleName === "string"
          ? req.body.vehicleName.trim()
          : "";

      if (vehicleName) {
        updates.vehicleName = vehicleName;
      } else {
        updates.vehicleName = "";
      }
    }

    if (typeof req.body.password === "string" && req.body.password.trim()) {
      updates.password = req.body.password;
    }

    const rateUpdatedAt = getTimestamp();
    const transaction = await runTransaction(dbRef, (current: InventoryUser | null) => current ? {
      ...current, ...updates,
      ...commissionUpdates(req.body, current, currentUser.userId, rateUpdatedAt),
      username: current.username || id,
    } : current, { applyLocally: false });
    if (!transaction.committed || !transaction.snapshot.exists()) throw new Error("تعذر تثبيت تحديث المستخدم");
    const updatedUser = transaction.snapshot.val() as InventoryUser;

    res.json({
      message: "User updated successfully",
      data: toUserResponse(id, updatedUser),
    });
  } catch (error: any) {
    console.error("Error updating user:", error);
    res.status(400).json({ error: error.message });
  }
};

export const deleteUser = async (req: Request, res: Response) => {
  const currentUser = await requireAdmin(req, res);
  if (!currentUser) return;

  const { id } = req.params;

  if (isInvalidUsername(id)) {
    return res.status(400).json({ error: "Invalid user id" });
  }

  if (currentUser.username === id || currentUser.userId === id) {
    return res.status(400).json({ error: "You cannot delete your own user" });
  }

  try {
    const dbRef = ref(database, `${USERS_PATH}/${id}`);
    const snapshot = await get(dbRef);

    if (!snapshot.exists()) {
      return res.status(404).json({ error: "User not found" });
    }

    const existingUser = snapshot.val() as InventoryUser;

    if (normalizeRole(existingUser.role) === "admin") {
      const adminCount = countAdmins(await getUserEntries());

      if (adminCount <= 1) {
        return res
          .status(400)
          .json({ error: "At least one admin user is required" });
      }
    }

    await remove(dbRef);
    res.json({ message: "User deleted successfully" });
  } catch (error: any) {
    console.error("Error deleting user:", error);
    res.status(500).json({ error: error.message });
  }
};

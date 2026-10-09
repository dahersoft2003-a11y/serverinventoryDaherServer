import { Request, Response } from "express";
import { ref, get, set } from "firebase/database";
import { database } from "../firebaseConfig";
import { generateToken } from "../utils/jwt";
import { commissionRateAt } from "../utils/driverFinanceCalc";

const normalizePermissions = (permissions: unknown): string[] => {
  if (!Array.isArray(permissions)) return [];

  return permissions
    .filter((permission): permission is string => typeof permission === "string")
    .map((permission) => permission.trim())
    .filter(Boolean);
};

export const login = async (req: Request, res: Response) => {
  const username = typeof req.body?.username === "string" ? req.body.username.trim() : "";
  const password = req.body?.password;

  if (!username || /[.#$\/\[\]]/.test(username) ||
      Object.prototype.hasOwnProperty.call(Object.prototype, username) ||
      typeof password !== "string" || !password) {
    return res.status(400).json({ error: "أدخل اسم مستخدم وكلمة مرور صالحين" });
  }

  try {
    const dbRef = ref(database, `users/${username}`);
    const snapshot = await get(dbRef);

    if (!snapshot.exists()) {
      return res.status(401).json({ error: "المستخدم غير موجود" });
    }

    const user = snapshot.val();

    if (user.password !== password) {
      return res.status(401).json({ error: "كلمة المرور غير صحيحة" });
    }

    const userRole = user.role || "user";
    const permissions = normalizePermissions(user.permissions);
    const userId = snapshot.key || username;
    const currentUsername = typeof user.username === "string" && user.username.trim()
      ? user.username.trim()
      : userId;

    return res.json({
      message: "تم تسجيل الدخول بنجاح",
      token: generateToken({
        userId,
        username: currentUsername,
        role: userRole,
        permissions,
      }),
      user: {
        id: userId,
        username: currentUsername,
        role: userRole,
        permissions,
        vehicleId: user.vehicleId || "",
        vehicleName: user.vehicleName || "",
        commissionRate: commissionRateAt(user, new Date().toISOString()),
        commissionEffectiveFrom: user.commissionEffectiveFrom || "",
        commissionRateHistory: user.commissionRateHistory || [],
      },
    });
  } catch (error: any) {
    console.error("Login error:", error);
    return res.status(500).json({ error: "حدث خطأ أثناء تسجيل الدخول" });
  }
};

export const createUser = async (req: Request, res: Response) => {
  const { username, password, role, permissions } = req.body;

  try {
    const dbRef = ref(database, `users/${username}`);
    const snapshot = await get(dbRef);
    if (snapshot.exists()) {
      return res.status(400).json({ error: "المستخدم موجود بالفعل" });
    }

    await set(dbRef, { username, password, role, permissions });
    return res.json({ message: "تم إنشاء المستخدم بنجاح" });
  } catch (error: any) {
    console.error("Create user error:", error);
    return res.status(500).json({ error: "حدث خطأ أثناء إنشاء المستخدم" });
  }
};

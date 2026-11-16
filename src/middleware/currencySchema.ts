import { Request, Response, NextFunction } from "express";
import { get, ref } from "firebase/database";
import { database } from "../firebaseConfig";
import { assertSypPayload, MONEY_SCHEMA } from "../utils/currencySchema";

export const assertDatabaseCurrencySchema = async () => {
  const snapshot = await get(ref(database, "system/moneySchema"));
  if (snapshot.val() !== MONEY_SCHEMA)
    throw new Error(
      "يلزم إكمال ترحيل البيانات إلى الليرة السورية قبل تشغيل هذه النسخة",
    );
};
export const requireSypSchema = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    await assertDatabaseCurrencySchema();
  } catch (error: any) {
    res.status(503).json({ code: "MONEY_MIGRATION_REQUIRED", message: error.message });
    return;
  }
  if (!["GET", "HEAD", "OPTIONS"].includes(req.method)) {
    try {
      if (req.header("X-Money-Schema") !== MONEY_SCHEMA)
        throw new Error("حدّث الصفحة قبل إرسال عملية مالية جديدة");
      assertSypPayload(req.body);
    } catch (error: any) {
      res.status(400).json({ code: "INVALID_MONEY_SCHEMA", message: error.message });
      return;
    }
  }
  next();
};

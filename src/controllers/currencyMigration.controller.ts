import { Request, Response } from "express";
const retired = (_req: Request, res: Response) => {
  res
    .status(410)
    .json({ message: "استخدم أداة ترحيل الليرة مع القيم اليدوية المعتمدة" });
};
export const previewCurrencyMigration = retired;
export const runCurrencyMigration = retired;

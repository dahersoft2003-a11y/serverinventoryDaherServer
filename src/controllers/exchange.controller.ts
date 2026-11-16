import { Request, Response } from "express";
const retired = (_req: Request, res: Response) => {
  res.status(410).json({ message: "الموقع يعمل بالليرة السورية فقط" });
};
export const getAllExchange = retired;
export const getAllDoneExchange = retired;
export const createExchangeInternal = retired;
export const endExchange = retired;

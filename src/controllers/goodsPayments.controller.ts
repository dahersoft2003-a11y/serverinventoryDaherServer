import { createHash, randomUUID } from "crypto";
import { Request, Response } from "express";
import { get, ref, runTransaction } from "firebase/database";
import { database } from "../firebaseConfig";
import { resetProductsCache } from "./products.controller";
import { requireFinanceUser } from "../utils/financeAuth";
import { applyGoodsPayment, GoodsOperationContext, GoodsResult, normalizeGoodsPaymentInput, reverseGoodsPayment } from "../utils/goodsSettlement";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const perform = async (req: Request, res: Response, reverse: boolean) => {
  try {
    const actor = await requireFinanceUser(req);
    if (actor.role !== "admin") return res.status(403).json({ message: "تسجيل وعكس التسويات بالبضاعة متاحان للمدير فقط" });
    const input = reverse ? null : normalizeGoodsPaymentInput(req.body.paymentData);
    const requestId = String(input?.requestId || req.body.requestId || "");
    if (!/^[A-Za-z0-9_-]{8,128}$/.test(requestId)) throw new Error("معرف طلب فريد مطلوب");
    const originalId = String(req.params.id || "");
    if (reverse && (!originalId || /[.#$\/\[\]]/.test(originalId))) throw new Error("معرف السند غير صالح");
    const note = String(req.body.note || "").trim().slice(0, 2000);
    const context: GoodsOperationContext = {
      id: randomUUID(), journalId: randomUUID(), now: new Date().toISOString(),
      actorId: actor.userId, actorName: actor.username,
      requestKey: `goods_${hash(`${actor.userId}:${requestId}`)}`,
      fingerprint: hash(JSON.stringify(reverse ? { originalId, note } : input)),
    };
    const rootRef = ref(database);
    const initial = await get(rootRef);
    if (!initial.exists()) throw new Error("بيانات المشروع غير متاحة");
    let saved: GoodsResult | undefined;
    const result = await runTransaction(rootRef, (current) => {
      const state = current || initial.val();
      saved = reverse
        ? reverseGoodsPayment(state, originalId, requestId, note, context)
        : applyGoodsPayment(state, input!, context);
      return saved.state;
    }, { applyLocally: false });
    if (!result.committed || !saved) throw new Error("لم تُنفذ التسوية؛ أعد المحاولة");
    resetProductsCache();
    const { payment, sell, purchase } = saved;
    return res.status(201).json({ message: reverse ? "تم عكس التسوية بالبضاعة" : "تم تسجيل التسوية بالبضاعة", payment, ...(sell ? { sell } : {}), ...(purchase ? { purchase } : {}) });
  } catch (error: any) {
    const status = error.status || (["USER_REQUIRED", "UNAUTHORIZED"].includes(error.message) ? 401 : 400);
    return res.status(status).json({ message: error.message || "تعذر إتمام التسوية بالبضاعة" });
  }
};

export const createGoodsPayment = (req: Request, res: Response) => perform(req, res, false);
export const cancelGoodsPayment = (req: Request, res: Response) => perform(req, res, true);

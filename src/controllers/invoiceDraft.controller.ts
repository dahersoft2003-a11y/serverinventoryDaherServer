import { Request, Response } from "express";
import { get, ref, remove, set } from "firebase/database";
import { database } from "../firebaseConfig";
import { handleSell } from "../functions/transactions";
import { InvoiceDraft, InvoiceDraftProduct } from "../types/invoiceDraft";
import { sell } from "../types/sell";
import {
  requireCurrentUser,
  sanitizeFirebaseKey,
} from "../utils/currentUser";

const toNumber = (value: unknown, fallback = 0) => {
  const next = Number(value);
  return Number.isFinite(next) ? next : fallback;
};

const normalizePriceType = (
  value: unknown,
): InvoiceDraftProduct["selectedPriceType"] => {
  const next = String(value || "custom");

  return [
    "payPrice",
    "wholesalePrice",
    "superWholesalePrice",
    "sellPrice",
    "custom",
  ].includes(next)
    ? (next as NonNullable<InvoiceDraftProduct["selectedPriceType"]>)
    : "custom";
};

const nowIso = () => new Date().toISOString();

const stripUndefined = <T>(value: T): T => {
  if (Array.isArray(value)) {
    return value.map(stripUndefined) as T;
  }

  if (value && typeof value === "object") {
    return Object.entries(value as Record<string, unknown>).reduce(
      (cleaned, [key, entryValue]) => {
        if (entryValue !== undefined) {
          cleaned[key] = stripUndefined(entryValue);
        }

        return cleaned;
      },
      {} as Record<string, unknown>,
    ) as T;
  }

  return value;
};

export const createEmptyInvoiceDraft = (userId: string): InvoiceDraft => ({
  id: sanitizeFirebaseKey(userId),
  userId,
  customerId: "",
  products: [],
  discount: "",
  discountPercent: "",
  discountAmount: "",
  paymentStatus: "cash",
  partValue: "",
  currency: "",
  exchangeRate: 1,
  paymentAccountId: "",
  receivableAccountId: "",
  salesAccountId: "",
  version: 0,
  updatedAt: nowIso(),
});

const normalizeProduct = (product: Partial<InvoiceDraftProduct> | any) => ({
  id: String(product?.id || product?.productId || ""),
  productId: product?.productId ? String(product.productId) : undefined,
  name: String(product?.name || product?.productName || ""),
  code: String(product?.code || product?.productCode || ""),
  category: String(product?.category || ""),
  payPrice: toNumber(product?.payPrice),
  wholesalePrice: toNumber(product?.wholesalePrice),
  superWholesalePrice: toNumber(product?.superWholesalePrice),
  sellPrice: toNumber(product?.sellPrice),
  selectedPriceType: normalizePriceType(product?.selectedPriceType),
  unit: String(product?.unit || ""),
  quantity: toNumber(product?.quantity),
  warehouse: String(product?.warehouse || ""),
  updatedDate: String(product?.updatedDate || ""),
  qty: toNumber(product?.qty, 1),
  totalPrice:
    product?.totalPrice === undefined ? undefined : toNumber(product.totalPrice),
});

const normalizeDraft = (
  userId: string,
  rawDraft?: Partial<InvoiceDraft> | null,
  previousVersion = 0,
  bumpVersion = true,
): InvoiceDraft => {
  const emptyDraft = createEmptyInvoiceDraft(userId);
  const paymentStatus = String(rawDraft?.paymentStatus || emptyDraft.paymentStatus);

  return stripUndefined({
    ...emptyDraft,
    ...rawDraft,
    id: sanitizeFirebaseKey(userId),
    userId,
    customerId: String(rawDraft?.customerId || ""),
    products: Array.isArray(rawDraft?.products)
      ? rawDraft.products.map(normalizeProduct)
      : [],
    discount:
      rawDraft?.discount === undefined || rawDraft?.discount === null
        ? ""
        : String(rawDraft.discount),
    discountPercent:
      rawDraft?.discountPercent === undefined || rawDraft?.discountPercent === null
        ? ""
        : String(rawDraft.discountPercent),
    discountAmount:
      rawDraft?.discountAmount === undefined || rawDraft?.discountAmount === null
        ? ""
        : String(rawDraft.discountAmount),
    paymentStatus: ["cash", "part", "debt"].includes(paymentStatus)
      ? (paymentStatus as InvoiceDraft["paymentStatus"])
      : "cash",
    partValue:
      rawDraft?.partValue === undefined || rawDraft?.partValue === null
        ? ""
        : String(rawDraft.partValue),
    currency: String(rawDraft?.currency || ""),
    exchangeRate: toNumber(rawDraft?.exchangeRate, 1),
    paymentAccountId: String(rawDraft?.paymentAccountId || ""),
    receivableAccountId: String(rawDraft?.receivableAccountId || ""),
    salesAccountId: String(rawDraft?.salesAccountId || ""),
    version: bumpVersion ? previousVersion + 1 : previousVersion,
    updatedAt: bumpVersion ? nowIso() : String(rawDraft?.updatedAt || nowIso()),
  });
};

const getDraftRef = (userId: string) =>
  ref(database, `invoiceDrafts/${sanitizeFirebaseKey(userId)}`);

export const getInvoiceDraftInternal = async (userId: string) => {
  const snapshot = await get(getDraftRef(userId));

  if (!snapshot.exists()) {
    return createEmptyInvoiceDraft(userId);
  }

  return normalizeDraft(
    userId,
    snapshot.val(),
    Number(snapshot.val()?.version || 0),
    false,
  );
};

export const saveInvoiceDraftInternal = async (
  userId: string,
  draftPatch: Partial<InvoiceDraft>,
  updatedBy?: string,
) => {
  const snapshot = await get(getDraftRef(userId));
  const currentDraft = snapshot.exists()
    ? snapshot.val()
    : createEmptyInvoiceDraft(userId);
  const nextDraft = normalizeDraft(
    userId,
    { ...currentDraft, ...draftPatch, updatedBy },
    Number(currentDraft?.version || 0),
  );

  await set(getDraftRef(userId), nextDraft);
  return nextDraft;
};

export const clearInvoiceDraftInternal = async (userId: string) => {
  await remove(getDraftRef(userId));
  return createEmptyInvoiceDraft(userId);
};

export const getMyInvoiceDraft = async (req: Request, res: Response) => {
  try {
    const user = requireCurrentUser(req);
    const draft = await getInvoiceDraftInternal(user.userId);
    res.json({ draft });
  } catch (error: any) {
    const status = error.message === "USER_REQUIRED" ? 401 : 500;
    res.status(status).json({ message: "تعذر تحميل مسودة الفاتورة" });
  }
};

export const updateMyInvoiceDraft = async (req: Request, res: Response) => {
  try {
    const user = requireCurrentUser(req);
    const draftPatch = req.body?.draft || req.body || {};
    const draft = await saveInvoiceDraftInternal(
      user.userId,
      draftPatch,
      user.username,
    );

    res.json({ draft });
  } catch (error: any) {
    const status = error.message === "USER_REQUIRED" ? 401 : 500;
    res.status(status).json({ message: "تعذر حفظ مسودة الفاتورة" });
  }
};

export const clearMyInvoiceDraft = async (req: Request, res: Response) => {
  try {
    const user = requireCurrentUser(req);
    const draft = await clearInvoiceDraftInternal(user.userId);
    res.json({ draft });
  } catch (error: any) {
    const status = error.message === "USER_REQUIRED" ? 401 : 500;
    res.status(status).json({ message: "تعذر تفريغ مسودة الفاتورة" });
  }
};

export const checkoutMyInvoiceDraft = async (req: Request, res: Response) => {
  try {
    const user = requireCurrentUser(req);
    const newSell = req.body?.newSell as sell | undefined;

    if (!newSell) {
      return res.status(400).json({ message: "بيانات الفاتورة غير مكتملة" });
    }

    const result = await handleSell({ newSell });

    if (!result) {
      throw new Error("تعذر إنشاء فاتورة البيع");
    }

    await clearInvoiceDraftInternal(user.userId);

    res.json({
      message: "تم إنشاء الفاتورة وتفريغ المسودة بنجاح",
      data: result,
      draft: createEmptyInvoiceDraft(user.userId),
    });
  } catch (error: any) {
    const status = error.message === "USER_REQUIRED" ? 401 : 400;
    res.status(status).json({ message: error.message || "تعذر إنشاء الفاتورة" });
  }
};

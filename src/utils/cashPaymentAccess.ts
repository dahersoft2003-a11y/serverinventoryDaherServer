import type { CurrentUser } from "./currentUser";

export const assertCashPaymentAccess = (actor: CurrentUser, partyType: "customer" | "supplier") => {
  if (actor.role === "admin") return;
  if (actor.role !== "driver" && actor.permissions?.includes(partyType === "customer" ? "customers" : "suppliers")) return;
  const error = new Error(actor.role === "driver" ? "استخدم تسجيل تحصيل السائق لدفعات عهدته" : "ليس لديك صلاحية تسجيل دفعات هذا الطرف") as Error & { status: number };
  error.status = 403;
  throw error;
};

export const cashPaymentHttpError = (error: unknown) => {
  const message = error instanceof Error ? error.message : "تعذر تسجيل الدفعة";
  const status = ["UNAUTHORIZED", "USER_REQUIRED"].includes(message) ? 401 : (error as { status?: number })?.status || 400;
  return { status, message: status === 401 ? "يلزم تسجيل الدخول لإضافة الدفعة" : message };
};

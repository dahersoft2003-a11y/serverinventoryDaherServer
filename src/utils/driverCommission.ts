import { Request } from "express";
import { get, ref } from "firebase/database";
import { database } from "../firebaseConfig";
import type { CurrentUser } from "./currentUser";
import { getUserFromToken } from "./currentUser";
import type { Payment } from "../types/payment";
import type { InventoryUser } from "../types/user";
import { recordEntries, snapshotDriverCommission } from "./driverFinanceCalc";
import { allocateDriverRefundPayments } from "./driverRefund";
export { allocateDriverRefundPayments } from "./driverRefund";

export const requireFinanceUser = async (req: Request): Promise<CurrentUser> => {
  const authorization = req.headers.authorization || "";
  const tokenUser = getUserFromToken(authorization.startsWith("Bearer ") ? authorization.slice(7) : undefined);
  if (!tokenUser) throw new Error("UNAUTHORIZED");
  for (const key of Array.from(new Set([tokenUser.userId, tokenUser.username]))) {
    if (!key || /[.#$\/\[\]]/.test(key) || Object.prototype.hasOwnProperty.call(Object.prototype, key)) continue;
    const snapshot = await get(ref(database, `users/${key}`));
    if (!snapshot.exists()) continue;
    const user = snapshot.val() as InventoryUser;
    return { userId: key, username: user.username || key, role: user.role || "user", permissions: Array.isArray(user.permissions) ? user.permissions : [] };
  }
  throw new Error("UNAUTHORIZED");
};

/** collectorId must come from authenticated server context, never an untrusted request body. */
export const prepareDriverPayment = async (payment: Payment, collectorId?: string): Promise<Payment> => {
  const row = payment as Payment & Record<string, any>;
  if (row.settlementMethod === "goods") return payment;
  // A refund inherits the original receipt snapshot; an unknown legacy refund stays unknown.
  if (row.type === "return") return payment;
  if (row.collectorId && row.commissionRate !== undefined && row.commissionUSD !== undefined) return payment;
  const id = collectorId || row.collectorId;
  if (!id || /[.#$\/\[\]]/.test(id)) return { ...payment, collectionSource: row.collectionSource || "unknown" } as Payment;
  const snapshot = await get(ref(database, `users/${id}`));
  if (!snapshot.exists()) return { ...payment, collectionSource: "unknown" } as Payment;
  const user = snapshot.val() as InventoryUser;
  if (user.role === "admin" || !(user.role === "driver" || user.vehicleId || user.commissionRateHistory?.length)) return { ...payment, collectorId: id, collectorName: user.username || id, collectionSource: "management", commissionRate: 0, commissionUSD: 0, commissionOriginal: 0 } as Payment;
  return snapshotDriverCommission(payment as Payment & Record<string, any>, id, user);
};

export const prepareDriverRefundPayments = async (
  sellId: string, cashRefundUSD: number, currencyValue: string, exchangeRateValue: number, refundPaidByDriverId?: string,
): Promise<Payment[]> => {
  const snapshot = await get(ref(database, "payment"));
  const payments = recordEntries(snapshot.exists() ? snapshot.val() : {}).map(([id, row]) => ({ ...row, id: row.id || id }));
  return allocateDriverRefundPayments(payments, sellId, cashRefundUSD, currencyValue, exchangeRateValue, refundPaidByDriverId);
};


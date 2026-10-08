import type { DriverMovement, DriverStockItem } from "../types/driverFinance";
import type { InventoryUser } from "../types/user";
import type { JournalEntryLine } from "../types/journalEntry";
import { buildDriverStatement, financialDate, dayInDamascus, snapshotDriverCommission } from "./driverFinanceCalc";
import { applyFinanceJournal, reconcileGoodsCustomerState, FinanceState } from "./goodsSettlement";
import { normalizeCurrency, normalizeExchangeRate, originalToUSD, roundMoney, toMoneyNumber, usdToOriginal } from "./money";

export interface DriverOperationContext { id: string; journalId: string; actorId: string; actorName: string; now: string; fingerprint: string }
export const validDriverKey = (value: unknown, label: string, optional = false): string => {
  const key = String(value || "").trim();
  if ((optional && !key) || (key && key.length <= 200 && !/[.#$\/\[\]]/.test(key) && !Object.prototype.hasOwnProperty.call(Object.prototype, key))) return key;
  throw new Error(`${label} غير صالح`);
};
const finiteAmount = (value: unknown, label: string, signed = false) => {
  const n = Number(value);
  if (!Number.isFinite(n) || Math.abs(n) > 1e12 || (!signed && n <= 0)) throw new Error(`${label} غير صالح`);
  const amount = roundMoney(n);
  if (!signed && amount <= 0) throw new Error(`${label} أصغر من الدقة المعتمدة`);
  return amount;
};
export const normalizeDriverRequest = (raw: any, kind: "collection" | "movement", isAdmin: boolean, actorId: string, now: string) => {
  if (!raw || !/^[A-Za-z0-9_-]{8,128}$/.test(String(raw.requestId || ""))) throw new Error("معرف طلب فريد مطلوب");
  validDriverKey(raw.requestId, "معرف الطلب");
  const driverId = validDriverKey(raw.driverId || actorId, "السائق");
  if (!isAdmin && driverId !== actorId) throw new Error("FORBIDDEN");
  if (kind === "movement" && !isAdmin) throw new Error("FORBIDDEN");
  if (!["USD", "SYP"].includes(raw.currency)) throw new Error("العملة يجب أن تكون USD أو SYP");
  const currency = raw.currency as "USD" | "SYP";
  const date = raw.date ? financialDate(raw.date) : now;
  if (!date || date > now || (!isAdmin && dayInDamascus(date) !== dayInDamascus(now))) throw new Error("تاريخ الحركة غير صالح أو خارج الصلاحية");
  const common = { requestId: raw.requestId as string, driverId, currency, exchangeRate: normalizeExchangeRate(currency, raw.exchangeRate), date, note: String(raw.note || "").trim().slice(0, 2000), vehicleId: validDriverKey(raw.vehicleId, "السيارة", true) };
  if (kind === "collection") return { ...common, customerId: validDriverKey(raw.customerId, "الزبون"), sellId: validDriverKey(raw.sellId, "الفاتورة"), amountOriginal: finiteAmount(raw.amountOriginal, "قيمة التحصيل"), paymentAccountId: validDriverKey(raw.paymentAccountId, "حساب القبض", true), receivableAccountId: validDriverKey(raw.receivableAccountId, "حساب الذمم", true) };
  if (!["remittance", "commission_payout", "advance", "expense", "opening"].includes(raw.type)) throw new Error("نوع الحركة غير صالح");
  const opening = raw.type === "opening";
  if (raw.type === "commission_payout" && !["driver_cash", "treasury"].includes(raw.payoutSource)) throw new Error("حدد مصدر صرف العمولة");
  const stock: DriverStockItem[] = opening && Array.isArray(raw.stock) ? raw.stock.map((p: any) => ({ productId: validDriverKey(p.productId, "الصنف"), productName: String(p.productName || "").slice(0, 300), code: String(p.code || "").slice(0, 200), quantity: finiteAmount(p.quantity, "كمية البداية", true), costUSD: finiteAmount(p.costUSD, "تكلفة الصنف", true) })) : [];
  if (stock.some(p => p.quantity < 0 || p.costUSD < 0) || stock.length > 500 || new Set(stock.map(p => p.code || p.productId)).size !== stock.length) throw new Error("بنود مخزون البداية غير صالحة أو مكررة");
  if (stock.length && !common.vehicleId) throw new Error("حدد السيارة لعهدة بضاعة البداية");
  return { ...common, type: raw.type as DriverMovement["type"], amountOriginal: opening ? 0 : finiteAmount(raw.amountOriginal, "المبلغ"), payoutSource: raw.payoutSource === "treasury" ? "treasury" as const : "driver_cash" as const, sourceAccountId: validDriverKey(raw.sourceAccountId, "حساب المصدر", true), destinationAccountId: validDriverKey(raw.destinationAccountId, "حساب الوجهة", true), expenseAccountId: validDriverKey(raw.expenseAccountId, "حساب المصروف", true), openingCashOriginal: opening ? finiteAmount(raw.openingCashOriginal ?? 0, "النقد الافتتاحي", true) : 0, openingCommissionUSD: opening ? finiteAmount(raw.openingCommissionUSD ?? 0, "مستحقات البداية", true) : 0, stock };
};

const ensureDriver = (state: FinanceState, input: any, context: DriverOperationContext, adminOnly = false): InventoryUser => {
  const actor = state.users?.[context.actorId];
  if (!actor) throw new Error("UNAUTHORIZED");
  if ((adminOnly || input.driverId !== context.actorId) && actor.role !== "admin") throw new Error("FORBIDDEN");
  const driver = state.users?.[input.driverId] as InventoryUser;
  if (!driver || driver.role === "admin" || !(driver.role === "driver" || driver.vehicleId || driver.commissionRateHistory?.length)) throw new Error("السائق غير موجود");
  if (input.vehicleId) {
    const vehicle = state.warehouses?.[input.vehicleId];
    if (!vehicle || vehicle.type !== "vehicle") throw new Error("السيارة غير موجودة");
    if (actor.role !== "admin" && vehicle.driverId !== input.driverId) throw new Error("السيارة غير مرتبطة بالسائق");
  }
  return driver;
};

const account = (state: FinanceState, id: string, category: "cash" | "receivable" | "expense") => {
  const row = state.accounts?.[id];
  if (!row || row.isActive === false || row.allowTransactions === false) throw new Error("الحساب غير موجود أو لا يسمح بالحركات");
  if (category === "cash" && !(row.type === "Asset" && ["Cash", "Bank"].includes(row.category))) throw new Error("اختر حساب نقد أو بنك");
  if (category === "receivable" && !(row.type === "Asset" && row.category === "AccountsReceivable")) throw new Error("اختر حساب ذمم الزبائن");
  if (category === "expense" && row.type !== "Expense") throw new Error("اختر حساب مصروف");
  return row;
};
const line = (state: FinanceState, id: string, debit: number, credit: number, input: any): JournalEntryLine => ({ accountId: id, accountName: state.accounts[id].name || id, debit, credit, currency: input.currency, exchangeRate: input.exchangeRate, amountUSD: debit || credit, amountOriginal: usdToOriginal(debit || credit, input.currency, input.exchangeRate), amountSYP: input.currency === "SYP" ? usdToOriginal(debit || credit, input.currency, input.exchangeRate) : 0 });
const existingResult = (state: FinanceState, input: any, context: DriverOperationContext, kind: string) => {
  const old = state.driverFinanceRequests?.[input.requestId];
  if (!old) return null;
  if (old.actorId !== context.actorId || old.kind !== kind || old.fingerprint !== context.fingerprint) throw new Error("معرف الطلب مستخدم لحركة مختلفة");
  return kind === "collection" ? { payment: state.payment[old.id], sell: state.sells[state.payment[old.id].sellId], duplicate: true } : { movement: state.driverCashMovements[old.id], duplicate: true };
};
const saveRequest = (state: FinanceState, input: any, context: DriverOperationContext, kind: string) => { state.driverFinanceRequests ||= {}; state.driverFinanceRequests[input.requestId] = { id: context.id, actorId: context.actorId, kind, fingerprint: context.fingerprint, createdAt: context.now }; };

export const applyDriverCollection = (original: FinanceState, input: any, context: DriverOperationContext) => {
  const state: FinanceState = JSON.parse(JSON.stringify(original));
  const duplicate = existingResult(state, input, context, "collection");
  if (duplicate) return { state, ...duplicate };
  const driver = ensureDriver(state, input, context);
  const sale = state.sells?.[input.sellId];
  if (!sale || sale.customerId !== input.customerId || !state.customer?.[input.customerId]) throw new Error("الفاتورة غير موجودة أو تخص زبونًا آخر");
  if (input.date < financialDate(sale.date)) throw new Error("تاريخ التحصيل يسبق تاريخ الفاتورة");
  if (state.users[context.actorId].role !== "admin" && sale.driverId !== input.driverId) throw new Error("الفاتورة لا تخص السائق");
  const amountUSD = originalToUSD(input.amountOriginal, input.currency, input.exchangeRate);
  const remaining = toMoneyNumber(sale.remainingUSD, toMoneyNumber(sale.remainingDebt));
  if (amountUSD <= 0 || amountUSD > remaining) throw new Error("قيمة التحصيل أكبر من المتبقي في الفاتورة أو أصغر من الدقة المعتمدة");
  const vehicle = state.warehouses?.[input.vehicleId || sale.vehicleId || driver.vehicleId || ""];
  const paymentAccountId = input.paymentAccountId || sale.paymentAccountId || vehicle?.defaultPaymentAccountId || state.customer[input.customerId].defaultPaymentAccountId;
  const receivableAccountId = input.receivableAccountId || sale.receivableAccountId || vehicle?.defaultReceivableAccountId || state.customer[input.customerId].defaultReceivableAccountId;
  account(state, paymentAccountId, "cash"); account(state, receivableAccountId, "receivable");
  if (paymentAccountId === receivableAccountId) throw new Error("حساب القبض والذمم يجب أن يكونا مختلفين");
  if (state.users[context.actorId].role !== "admin") {
    const expectedPayment = sale.paymentAccountId || vehicle?.defaultPaymentAccountId || state.customer[input.customerId].defaultPaymentAccountId;
    const expectedReceivable = sale.receivableAccountId || vehicle?.defaultReceivableAccountId || state.customer[input.customerId].defaultReceivableAccountId;
    if (paymentAccountId !== expectedPayment || receivableAccountId !== expectedReceivable) throw new Error("حسابات التحصيل خارج صلاحية السائق");
  }
  const currency = normalizeCurrency(sale.paymentCurrency || sale.currency);
  const rate = normalizeExchangeRate(currency, sale.exchangeRate);
  const nextRemaining = roundMoney(remaining - amountUSD);
  const paidUSD = roundMoney(toMoneyNumber(sale.totalUSD, toMoneyNumber(sale.totalPrice)) - nextRemaining);
  const balanceSYPChange = currency === "SYP" ? usdToOriginal(amountUSD, currency, rate) : 0;
  const payment = snapshotDriverCommission({ id: context.id, requestId: input.requestId, type: "income", customerId: input.customerId, sellId: input.sellId, vehicleId: input.vehicleId || sale.vehicleId || driver.vehicleId || "", paymentAccountId, receivableAccountId, currency: input.currency, paymentCurrency: input.currency, exchangeRate: input.exchangeRate, amount: amountUSD, amountUSD, amountOriginal: input.amountOriginal, amount_base: input.amountOriginal, amountSYP: input.currency === "SYP" ? input.amountOriginal : 0, balanceSYPChange, date: input.date, note: input.note || "تحصيل السائق من فاتورة", settlementMethod: "cash", createdBy: context.actorId }, input.driverId, driver);
  state.payment ||= {}; state.payment[context.id] = payment;
  const nextSale = { ...sale, remainingDebt: nextRemaining, remainingUSD: nextRemaining, remainingOriginal: usdToOriginal(nextRemaining, currency, rate), remainingSYP: currency === "SYP" ? usdToOriginal(nextRemaining, currency, rate) : 0, paidUSD, paidOriginal: usdToOriginal(paidUSD, currency, rate), paidSYP: currency === "SYP" ? usdToOriginal(paidUSD, currency, rate) : 0, partValue: usdToOriginal(paidUSD, currency, rate), paymentStatus: nextRemaining === 0 ? "cash" : "part", updatedAt: context.now };
  state.sells[input.sellId] = nextSale;
  reconcileGoodsCustomerState(state, input.customerId);
  applyFinanceJournal(state, { id: context.journalId, date: input.date, description: payment.note, referenceId: context.id, referenceType: "payment", createdBy: context.actorId, lines: [line(state, paymentAccountId, amountUSD, 0, input), line(state, receivableAccountId, 0, amountUSD, { ...input, currency, exchangeRate: rate })] });
  saveRequest(state, input, context, "collection");
  return { state, payment, sell: nextSale, duplicate: false };
};

export const applyDriverMovement = (original: FinanceState, input: any, context: DriverOperationContext) => {
  const state: FinanceState = JSON.parse(JSON.stringify(original));
  const duplicate = existingResult(state, input, context, "movement");
  if (duplicate) return { state, ...duplicate };
  const driver = ensureDriver(state, input, context, true);
  const amountUSD = input.type === "opening" ? 0 : originalToUSD(input.amountOriginal, input.currency, input.exchangeRate);
  if (input.type !== "opening" && amountUSD <= 0) throw new Error("المبلغ أصغر من الدقة المعتمدة");
  const rowsAtDate = (rows: any, dateField = "date") => Object.fromEntries(Object.entries(rows || {}).filter(([, row]: [string, any]) => financialDate(row[dateField]) <= input.date));
  const report = buildDriverStatement({ driverId: input.driverId, dateFrom: "0001-01-01", dateTo: dayInDamascus(input.date), users: state.users || {}, warehouses: state.warehouses || {}, products: state.products || {}, sells: state.sells || {}, payments: rowsAtDate(state.payment), returns: state.returns || {}, transfers: state.warehouseTransfers || {}, movements: rowsAtDate(state.driverCashMovements), customers: state.customer || {}, generatedAt: context.now });
  const spendsCustody = ["remittance", "expense"].includes(input.type) || input.type === "commission_payout" && input.payoutSource === "driver_cash";
  if (spendsCustody && input.amountOriginal > report.summary.cashClosingByCurrency[input.currency as "USD" | "SYP"]) throw new Error("المبلغ أكبر من النقد المتبقي مع السائق بهذه العملة");
  if (input.type === "commission_payout" && amountUSD > report.summary.commissionClosingUSD) throw new Error("المبلغ أكبر من مستحقات السائق غير المصروفة");
  if (input.type !== "opening" && Object.values(state.driverCashMovements || {}).some((m: any) => m.driverId === input.driverId && m.type === "opening" && financialDate(m.date) > input.date)) throw new Error("لا تسجل حركة قبل رصيد بداية السجل المعتمد");
  const movement: DriverMovement = { id: context.id, requestId: input.requestId, driverId: input.driverId, driverName: driver.username || input.driverId, ...(input.vehicleId ? { vehicleId: input.vehicleId } : {}), type: input.type, date: input.date, currency: input.currency, exchangeRate: input.exchangeRate, amountOriginal: input.amountOriginal, amountUSD, payoutSource: input.payoutSource, note: input.note, createdBy: context.actorId, createdAt: context.now, ...(input.type === "opening" ? { openingCashOriginal: input.openingCashOriginal, openingCommissionUSD: input.openingCommissionUSD, stock: input.stock } : { sourceAccountId: input.sourceAccountId, destinationAccountId: input.destinationAccountId, expenseAccountId: input.expenseAccountId, journalEntryId: context.journalId }) };
  if (input.type === "opening") {
    const priorAll = Object.values(state.driverCashMovements || {}).filter((m: any) => m.driverId === input.driverId && m.type === "opening") as DriverMovement[];
    const prior = priorAll.filter(m => (m.vehicleId || "") === (input.vehicleId || ""));
    if (input.openingCashOriginal !== 0 && prior.some(m => m.currency === input.currency && toMoneyNumber(m.openingCashOriginal) !== 0) || input.openingCommissionUSD !== 0 && priorAll.some(m => toMoneyNumber(m.openingCommissionUSD) !== 0) || input.stock.length && prior.some(m => m.stock?.length)) throw new Error("رصيد افتتاحي مماثل مسجل؛ راجع السند الموجود لتجنب تكرار البداية");
    if (input.stock.length && state.warehouses?.[input.vehicleId]?.driverId !== input.driverId) throw new Error("بضاعة البداية يجب أن تخص السيارة المرتبطة بالسائق حاليًا");
  } else {
    account(state, input.sourceAccountId, "cash");
    const debitAccountId = ["remittance", "advance"].includes(input.type) ? input.destinationAccountId : input.expenseAccountId;
    account(state, debitAccountId, ["remittance", "advance"].includes(input.type) ? "cash" : "expense");
    if (debitAccountId === input.sourceAccountId) throw new Error("اختر حسابي مصدر ووجهة مختلفين");
    applyFinanceJournal(state, { id: context.journalId, date: input.date, description: input.note || `حركة عهدة السائق: ${input.type}`, referenceId: context.id, referenceType: "driver-movement", createdBy: context.actorId, lines: [line(state, debitAccountId, amountUSD, 0, input), line(state, input.sourceAccountId, 0, amountUSD, input)] });
    if (["commission_payout", "expense"].includes(input.type)) { state.payment ||= {}; state.payment[context.id] = { id: context.id, type: "expense", driverMovementId: context.id, paymentAccountId: input.sourceAccountId, expenseAccountId: input.expenseAccountId, currency: input.currency, paymentCurrency: input.currency, exchangeRate: input.exchangeRate, amount: -amountUSD, amountUSD: -amountUSD, amountOriginal: -input.amountOriginal, amount_base: -input.amountOriginal, amountSYP: input.currency === "SYP" ? -input.amountOriginal : 0, date: input.date, note: input.note || (input.type === "commission_payout" ? "صرف عمولة السائق" : "مصروف معتمد من عهدة السائق"), settlementMethod: "cash", collectionSource: "management", createdBy: context.actorId }; }
  }
  state.driverCashMovements ||= {}; state.driverCashMovements[context.id] = movement;
  if (input.type !== "opening") {
    const after = buildDriverStatement({ driverId: input.driverId, dateFrom: "0001-01-01", dateTo: dayInDamascus(context.now), users: state.users || {}, warehouses: state.warehouses || {}, products: state.products || {}, sells: state.sells || {}, payments: state.payment || {}, returns: state.returns || {}, transfers: state.warehouseTransfers || {}, movements: state.driverCashMovements || {}, customers: state.customer || {}, generatedAt: context.now });
    if (spendsCustody && after.cashMovements.some(row => row.date >= input.date && row.balanceByCurrency[input.currency as "USD" | "SYP"] < -0.001)) throw new Error("الحركة تجعل العهدة النقدية سالبة بعد حركة لاحقة؛ راجع تاريخها ومبلغها");
    if (input.type === "commission_payout" && after.commissionRows.some(row => row.date >= input.date && row.balanceUSD < -0.001)) throw new Error("الحركة تتجاوز المستحقات بعد صرف لاحق؛ راجع تاريخها ومبلغها");
  }
  saveRequest(state, input, context, "movement");
  return { state, movement, duplicate: false };
};

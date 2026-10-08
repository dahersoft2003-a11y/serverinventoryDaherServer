import type { DriverSummary, DriverStatement, DriverMovement, DriverCollection, DriverStockRow, DriverSale, DriverCashRow, DriverCommissionRow } from "../types/driverFinance";
import type { InventoryUser } from "../types/user";
import { normalizeCurrency, roundMoney, toMoneyNumber, usdToOriginal } from "./money";

type RecordData = Record<string, any>;
export const recordEntries = (value: any): Array<[string, RecordData]> => value && typeof value === "object" ? Object.entries(value) : [];
export const financialDate = (value: unknown): string => {
  if (!value) return "";
  const date = new Date(typeof value === "number" ? value : String(value));
  return Number.isFinite(date.getTime()) ? date.toISOString() : "";
};
export const dayInDamascus = (value: unknown): string => {
  const date = financialDate(value);
  if (!date) return "";
  return new Date(date).toLocaleDateString("en-CA", { timeZone: "Asia/Damascus" });
};

export const commissionRateAt = (driver: Pick<InventoryUser, "commissionRate" | "commissionRateHistory" | "commissionEffectiveFrom">, date: string): number => {
  const history = Array.isArray(driver.commissionRateHistory) ? driver.commissionRateHistory : [];
  const applicable = history.filter(change => financialDate(change.effectiveFrom) && financialDate(change.effectiveFrom) <= date)
    .sort((a, b) => financialDate(a.effectiveFrom).localeCompare(financialDate(b.effectiveFrom)) || a.createdAt.localeCompare(b.createdAt));
  if (history.length) return applicable.length ? toMoneyNumber(applicable[applicable.length - 1].rate) : 0;
  if (driver.commissionEffectiveFrom && financialDate(driver.commissionEffectiveFrom) > date) return 0;
  return Math.max(0, Math.min(100, toMoneyNumber(driver.commissionRate)));
};

export const snapshotDriverCommission = <T extends RecordData>(payment: T, driverId: string, driver: InventoryUser): T => {
  if (payment.settlementMethod === "goods" || payment.type !== "income" || !payment.customerId || toMoneyNumber(payment.amountUSD, toMoneyNumber(payment.amount)) <= 0) return payment;
  if (payment.collectorId && payment.commissionRate !== undefined && payment.commissionUSD !== undefined) return payment;
  const rate = commissionRateAt(driver, financialDate(payment.date) || new Date().toISOString());
  const amountUSD = toMoneyNumber(payment.amountUSD, toMoneyNumber(payment.amount));
  const original = toMoneyNumber(payment.amountOriginal, toMoneyNumber(payment.amount_base, amountUSD));
  return { ...payment, collectorId: driverId, collectorName: driver.username || driverId, collectionSource: "driver", commissionRate: rate,
    commissionUSD: roundMoney(amountUSD * rate / 100), commissionOriginal: roundMoney(original * rate / 100) };
};

export const toDriverSummary = (id: string, user: InventoryUser): DriverSummary => ({
  id, username: user.username || id, commissionRate: commissionRateAt(user, new Date().toISOString()),
  commissionEffectiveFrom: user.commissionEffectiveFrom, commissionRateHistory: user.commissionRateHistory || [],
  vehicleId: user.vehicleId, vehicleName: user.vehicleName,
});

export interface DriverReportInput {
  driverId: string;
  dateFrom: string;
  dateTo: string;
  vehicleId?: string;
  users: RecordData;
  warehouses: RecordData;
  products: RecordData;
  sells: RecordData;
  payments: RecordData;
  returns: RecordData;
  transfers: RecordData;
  movements: RecordData;
  customers: RecordData;
  generatedAt?: string;
}

export const buildDriverStatement = (input: DriverReportInput): DriverStatement => {
  const { driverId, dateFrom, dateTo, vehicleId = "" } = input;
  const generatedAt = input.generatedAt || new Date().toISOString();
  const driver = input.users[driverId] ? toDriverSummary(driverId, input.users[driverId]) : null;
  if (!driverId) {
    const driverIds = recordEntries(input.users).filter(([id, u]) => u.role !== "admin" && (u.role === "driver" || u.vehicleId || u.commissionRateHistory?.length || recordEntries(input.sells).some(([, s]) => s.driverId === id))).map(([id]) => id);
    const reports = driverIds.map(id => buildDriverStatement({ ...input, driverId: id, generatedAt }));
    const base = reports[0] || buildDriverStatement({ ...input, driverId: "__empty__", generatedAt });
    const summary = { ...base.summary };
    for (const field of Object.keys(summary) as Array<keyof DriverStatement["summary"]>) {
      if (field === "cashOpeningByCurrency" || field === "cashClosingByCurrency") summary[field] = { USD: roundMoney(reports.reduce((sum, r) => sum + r.summary[field].USD, 0)), SYP: roundMoney(reports.reduce((sum, r) => sum + r.summary[field].SYP, 0)) };
      else (summary as any)[field] = roundMoney(reports.reduce((sum, r) => sum + toMoneyNumber(r.summary[field]), 0));
    }
    const merged = { ...base, driver: null, drivers: driverIds.map(id => toDriverSummary(id, input.users[id])), filters: { driverId: "", dateFrom, dateTo, vehicleId }, summary,
      sales: reports.flatMap(r => r.sales), outstandingInvoices: reports.flatMap(r => r.outstandingInvoices), collections: reports.flatMap(r => r.collections), cashMovements: reports.flatMap(r => r.cashMovements), commissionRows: reports.flatMap(r => r.commissionRows), stockMovements: reports.flatMap(r => r.stockMovements), stockBalances: reports.flatMap(r => r.stockBalances), returns: reports.flatMap(r => r.returns), settlements: reports.flatMap(r => r.settlements), currentStock: { asOf: generatedAt, products: reports.flatMap(r => r.currentStock.products), quantity: roundMoney(reports.reduce((sum, r) => sum + r.currentStock.quantity, 0)), costUSD: roundMoney(reports.reduce((sum, r) => sum + r.currentStock.costUSD, 0)) }, warnings: Array.from(new Set(reports.flatMap(r => r.warnings))) };
    return merged;
  }
  const vehicles = recordEntries(input.warehouses).filter(([, v]) => v.type === "vehicle").map(([id, v]) => ({ id: v.id || id, name: v.name, driverId: v.driverId, driverName: v.driverName }));
  const allSales: RecordData[] = recordEntries(input.sells).map(([id, row]) => ({ ...row, id: row.id || id }));
  const allPayments: RecordData[] = recordEntries(input.payments).map(([id, row]) => ({ ...row, id: row.id || id }));
  const allReturns: RecordData[] = recordEntries(input.returns).map(([id, row]) => ({ ...row, id: row.id || id }));
  const dateIncluded = (date: unknown) => { const key = dayInDamascus(date); return Boolean(key && key >= dateFrom && key <= dateTo); };
  const before = (date: unknown) => { const key = dayInDamascus(date); return Boolean(key && key < dateFrom); };
  const until = (date: unknown) => { const key = dayInDamascus(date); return Boolean(key && key <= dateTo); };
  const vehicleIncluded = (id: unknown) => !vehicleId || String(id || "") === vehicleId;
  const driverSales = allSales.filter(s => s.driverId === driverId);
  const saleMap = new Map<string, RecordData>(allSales.map(s => [s.id, s]));
  const ownSaleIds = new Set(driverSales.map(s => s.id));
  const movements = recordEntries(input.movements).map(([id, m]) => ({ ...m, id: m.id || id })) as DriverMovement[];
  const ownMovements = movements.filter(m => m.driverId === driverId && vehicleIncluded(m.vehicleId));
  const collectionRecords = allPayments.filter(p => (p.collectorId === driverId || (p.type === "return" && p.refundPaidByDriverId === driverId) || (!p.collectorId && ownSaleIds.has(p.sellId))) && vehicleIncluded(p.vehicleId || saleMap.get(p.sellId)?.vehicleId));
  const collections: DriverCollection[] = collectionRecords.map(p => {
    const currency = normalizeCurrency(p.paymentCurrency || p.currency);
    const amountUSD = toMoneyNumber(p.amountUSD, toMoneyNumber(p.amount));
    const rate = toMoneyNumber(p.exchangeRate, 1);
    const original = toMoneyNumber(p.amountOriginal, toMoneyNumber(p.amount_base, usdToOriginal(amountUSD, currency, rate)));
    const confirmed = p.collectorId === driverId && p.commissionRate !== undefined && p.commissionUSD !== undefined && p.settlementMethod !== "goods";
    return { id: p.id, date: financialDate(p.date), sellId: p.sellId, customerId: p.customerId, customerName: input.customers[p.customerId]?.name || p.customerId || "", driverId: p.collectorId || "", driverName: p.collectorName || "غير محدد", vehicleId: p.vehicleId || saleMap.get(p.sellId)?.vehicleId, currency, exchangeRate: rate, amountOriginal: original, amountUSD,
      commissionRate: confirmed ? toMoneyNumber(p.commissionRate) : null, commissionUSD: confirmed ? toMoneyNumber(p.commissionUSD) : 0, commissionOriginal: confirmed ? toMoneyNumber(p.commissionOriginal) : 0, isRefund: p.type === "return" || amountUSD < 0, originalPaymentId: p.originalPaymentId, collectionSource: p.collectionSource || "unknown", refundPaidByDriverId: p.refundPaidByDriverId, settlementMethod: p.settlementMethod || "cash", note: p.note || "" };
  }).filter(p => p.date && until(p.date) && (p.amountUSD !== 0 || p.settlementMethod === "goods"));

  const enrichSale = (s: RecordData): DriverSale => {
    const returned = allReturns.filter(r => r.type === "sale-return" && r.referenceId === s.id);
    const returnedAllUSD = returned.reduce((sum, r) => sum + toMoneyNumber(r.returnValue), 0);
    const futureReceivableCredits = returned.filter(r => !until(r.date || r.createdDate)).reduce((sum, r) => sum + toMoneyNumber(r.debtReductionUSD, toMoneyNumber(r.receivableCreditUSD, r.returnType === "debt" ? toMoneyNumber(r.returnValue) : 0)), 0);
    const hasOriginal = Array.isArray(s.originalProducts);
    const sourceProducts = hasOriginal ? s.originalProducts : (Array.isArray(s.products) ? [...s.products] : []);
    if (!hasOriginal) for (const r of returned) {
      if (!sourceProducts.some((p: RecordData) => (p.id === r.productId || p.code === r.productCode) && p.warehouse === r.warehouse)) sourceProducts.push({ id: r.productId, code: r.productCode, name: r.productName || r.productCode, warehouse: r.warehouse, qty: 0, payPrice: toMoneyNumber(r.payPriceUSD), sellPrice: toMoneyNumber(r.sellPriceUSD, toMoneyNumber(r.returnValue) / (toMoneyNumber(r.qty) || 1)) });
    }
    const products = sourceProducts.map((p: RecordData) => {
      const originalQty = toMoneyNumber(p.qty) + (hasOriginal ? 0 : returned.filter(r => (r.productId === p.id || r.productCode === p.code) && r.warehouse === p.warehouse).reduce((sum, r) => sum + toMoneyNumber(r.qty), 0));
      return { id: p.id || "", code: p.code || "", name: p.name || "", qty: originalQty, payPrice: toMoneyNumber(p.payPrice), sellPrice: toMoneyNumber(p.sellPrice), warehouse: p.warehouse || "" };
    });
    const grossUSD = toMoneyNumber(s.originalSubtotalUSD, products.reduce((sum: number, p: RecordData) => sum + p.qty * p.sellPrice, 0));
    const originalNetUSD = toMoneyNumber(s.originalTotalUSD, toMoneyNumber(s.totalUSD, toMoneyNumber(s.totalPrice)) + returnedAllUSD);
    const returnsUSD = returned.filter(r => until(r.date || r.createdDate)).reduce((sum, r) => sum + toMoneyNumber(r.returnValue), 0);
    const returnedCost = returned.filter(r => until(r.date || r.createdDate)).reduce((sum, r) => sum + toMoneyNumber(r.qty) * toMoneyNumber(r.payPriceUSD, toMoneyNumber(products.find((p: RecordData) => p.id === r.productId || p.code === r.productCode)?.payPrice)), 0);
    const costUSD = products.reduce((sum: number, p: RecordData) => sum + p.qty * p.payPrice, 0) - returnedCost;
    const netUSD = originalNetUSD - returnsUSD;
    const laterPayments = allPayments.filter(p => p.sellId === s.id && !until(p.date)).reduce((sum, p) => sum + (p.type === "return" ? 0 : toMoneyNumber(p.balanceUSDChange, toMoneyNumber(p.amountUSD, toMoneyNumber(p.amount)))), 0);
    return { id: s.id, driverId, driverName: s.driverName || driver?.username || driverId, date: financialDate(s.date), customerId: s.customerId, customerName: input.customers[s.customerId]?.name || s.customerId || "", vehicleId: s.vehicleId, vehicleName: s.vehicleName, currency: s.paymentCurrency || s.currency || "USD", exchangeRate: toMoneyNumber(s.exchangeRate, 1), grossUSD: roundMoney(grossUSD), discountUSD: roundMoney(grossUSD - originalNetUSD), netUSD: roundMoney(netUSD), costUSD: roundMoney(costUSD), profitUSD: roundMoney(netUSD - costUSD), returnsUSD: roundMoney(returnsUSD), remainingDebtUSD: roundMoney(Math.max(0, toMoneyNumber(s.remainingUSD, toMoneyNumber(s.remainingDebt)) + laterPayments + futureReceivableCredits)), products, paymentStatus: s.paymentStatus || "debt", paymentAccountId: s.paymentAccountId, receivableAccountId: s.receivableAccountId };
  };
  const sales = driverSales.filter(s => dateIncluded(s.date) && vehicleIncluded(s.vehicleId)).map(enrichSale).sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
  const outstandingInvoices = driverSales.filter(s => until(s.date) && vehicleIncluded(s.vehicleId)).map(enrichSale).filter(s => s.remainingDebtUSD > 0);
  const returns: DriverStatement["returns"] = allReturns.filter(r => r.type === "sale-return" && saleMap.get(r.referenceId)?.driverId === driverId && dateIncluded(r.date || r.createdDate) && vehicleIncluded(r.vehicleId || saleMap.get(r.referenceId)?.vehicleId)).map(r => ({ id: r.id, date: financialDate(r.date || r.createdDate), sellId: r.referenceId, driverId, driverName: driver?.username || driverId, customerName: input.customers[saleMap.get(r.referenceId)?.customerId]?.name || "", productName: r.productName || r.productCode || "", code: r.productCode || "", qty: toMoneyNumber(r.qty), returnValue: toMoneyNumber(r.returnValue), cashRefundUSD: toMoneyNumber(r.cashRefundUSD), receivableCreditUSD: toMoneyNumber(r.receivableCreditUSD) }));
  const settlements: DriverStatement["settlements"] = allPayments.filter(p => p.settlementMethod === "goods" && (saleMap.get(p.sellId)?.driverId === driverId || p.stockDriverId === driverId) && dateIncluded(p.date) && vehicleIncluded(p.stockVehicleId || saleMap.get(p.sellId)?.vehicleId)).map(p => ({ id: p.id, date: financialDate(p.date), sellId: p.sellId, driverId, driverName: driver?.username || driverId, customerName: input.customers[p.customerId]?.name || p.customerId || "", goodsDirection: p.goodsDirection, amountUSD: toMoneyNumber(p.amountUSD, toMoneyNumber(p.amount)), items: (p.goodsItems || []).map((item: RecordData) => ({ productId: item.productId, name: item.name, code: item.code, quantity: item.quantity, settlementPriceUSD: item.settlementPriceUSD, lineTotalUSD: item.lineTotalUSD })) }));

  type CashEvent = { id: string; referenceId: string; referenceType: "payment" | "driver-movement"; date: string; type: string; currency: "USD" | "SYP"; exchangeRate: number; amountOriginal: number; amountUSD: number; note: string; vehicleId?: string };
  const cashEvents: CashEvent[] = [];
  const commissionEvents: Omit<DriverCommissionRow, "balanceUSD">[] = [];
  for (const p of collections) {
    if (p.settlementMethod !== "cash") continue;
    if ((!p.isRefund && p.driverId === driverId && p.collectionSource === "driver") || (p.isRefund && p.refundPaidByDriverId === driverId)) {
      cashEvents.push({ id: p.id, referenceId: p.id, referenceType: "payment", date: p.date, type: p.isRefund ? "refund" : "collection", currency: p.currency, exchangeRate: p.exchangeRate, amountOriginal: p.amountOriginal, amountUSD: p.amountUSD, note: p.note, vehicleId: p.vehicleId });
    }
    if (p.driverId === driverId && p.commissionRate !== null) commissionEvents.push({ id: p.id, referenceId: p.id, referenceType: "payment", date: p.date, type: p.isRefund ? "refund" : "collection", rate: p.commissionRate, basisUSD: p.amountUSD, amountUSD: p.commissionUSD });
  }
  for (const m of ownMovements.filter(m => until(m.date))) {
    const sign = m.type === "advance" ? 1 : m.type === "opening" ? 0 : -1;
    const cashUSD = m.type === "opening" ? toMoneyNumber(m.openingCashOriginal) / (m.currency === "SYP" ? m.exchangeRate : 1) : m.type === "commission_payout" && m.payoutSource === "treasury" ? 0 : sign * m.amountUSD;
    const cashOriginal = m.type === "opening" ? toMoneyNumber(m.openingCashOriginal) : m.type === "commission_payout" && m.payoutSource === "treasury" ? 0 : sign * m.amountOriginal;
    cashEvents.push({ id: m.id, referenceId: m.id, referenceType: "driver-movement", date: financialDate(m.date), type: m.type, currency: m.currency, exchangeRate: m.exchangeRate, amountOriginal: roundMoney(cashOriginal), amountUSD: roundMoney(cashUSD), note: m.note, vehicleId: m.vehicleId });
    if (m.type === "opening" && toMoneyNumber(m.openingCommissionUSD) !== 0 || m.type === "commission_payout") commissionEvents.push({ id: m.id, referenceId: m.id, referenceType: "driver-movement", date: financialDate(m.date), type: m.type, rate: null, basisUSD: 0, amountUSD: m.type === "opening" ? toMoneyNumber(m.openingCommissionUSD) : -m.amountUSD });
  }
  const cashBaselines = new Map<string, DriverMovement>();
  for (const m of ownMovements.filter(m => m.type === "opening" && toMoneyNumber(m.openingCashOriginal) !== 0 && until(m.date))) {
    const key = `${m.vehicleId || ""}:${m.currency}`;
    if (!cashBaselines.has(key) || financialDate(m.date) > financialDate(cashBaselines.get(key)!.date)) cashBaselines.set(key, m);
  }
  const confirmedCashEvents = cashEvents.filter(e => { const baseline = cashBaselines.get(`${e.vehicleId || ""}:${e.currency}`); return !baseline || e.date >= financialDate(baseline.date); });
  const commissionBaseline = ownMovements.filter(m => m.type === "opening" && toMoneyNumber(m.openingCommissionUSD) !== 0 && until(m.date)).sort((a, b) => financialDate(a.date).localeCompare(financialDate(b.date))).pop();
  const confirmedCommissionEvents = commissionEvents.filter(e => !commissionBaseline || e.date >= financialDate(commissionBaseline.date));
  cashEvents.sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
  commissionEvents.sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
  const cashOpeningByCurrency = { USD: 0, SYP: 0 };
  let cashOpeningUSD = 0;
  for (const event of confirmedCashEvents.filter(e => before(e.date))) { cashOpeningUSD += event.amountUSD; cashOpeningByCurrency[event.currency] += event.amountOriginal; }
  const cashClosingByCurrency = { ...cashOpeningByCurrency };
  let cashClosingUSD = cashOpeningUSD;
  const cashMovements: DriverCashRow[] = confirmedCashEvents.filter(e => dateIncluded(e.date)).map(e => { cashClosingUSD = roundMoney(cashClosingUSD + e.amountUSD); cashClosingByCurrency[e.currency] = roundMoney(cashClosingByCurrency[e.currency] + e.amountOriginal); return { ...e, driverId, driverName: driver?.username || driverId, balanceUSD: cashClosingUSD, balanceByCurrency: { ...cashClosingByCurrency } }; });
  const commissionOpeningUSD = roundMoney(confirmedCommissionEvents.filter(e => before(e.date)).reduce((sum, e) => sum + e.amountUSD, 0));
  let commissionClosingUSD = commissionOpeningUSD;
  const commissionRows = confirmedCommissionEvents.filter(e => dateIncluded(e.date)).map(e => { commissionClosingUSD = roundMoney(commissionClosingUSD + e.amountUSD); return { ...e, driverId, driverName: driver?.username || driverId, balanceUSD: commissionClosingUSD }; });

  const stockEvents: Omit<DriverStockRow, "balance">[] = [];
  const addStock = (data: Omit<DriverStockRow, "balance">) => { if (vehicleIncluded(data.vehicleId) && data.date && until(data.date)) stockEvents.push({ ...data, driverId, driverName: driver?.username || driverId }); };
  for (const m of ownMovements.filter(m => m.type === "opening" && m.vehicleId)) for (const [index, p] of (m.stock || []).entries()) addStock({ id: `${m.id}:${index}`, referenceId: m.id, referenceType: "driver-movement", date: financialDate(m.date), type: "opening", vehicleId: m.vehicleId!, productId: p.productId, productName: p.productName, code: p.code, quantity: p.quantity, costUSD: p.costUSD });
  for (const [id, t] of recordEntries(input.transfers)) {
    const incoming = t.toDriverId === driverId;
    const outgoing = t.fromDriverId === driverId;
    if (!incoming && !outgoing) continue;
    for (const direction of ["in", "out"]) {
      if (direction === "in" && !incoming || direction === "out" && !outgoing) continue;
      addStock({ id: `${id}:${direction}`, referenceId: t.referenceId || id, referenceType: "warehouse-transfer", date: financialDate(t.date || t.createdAt), type: direction === "in" ? "load" : "transfer_out", vehicleId: direction === "in" ? t.toVehicleId || t.vehicleId || "" : t.fromVehicleId || t.vehicleId || "", productId: direction === "in" ? t.toProductId || t.productId : t.fromProductId || t.productId, productName: t.productName || "", code: t.productCode || "", quantity: toMoneyNumber(t.quantity) * (direction === "in" ? 1 : -1), costUSD: toMoneyNumber(t.unitCostUSD) });
    }
  }
  for (const s of driverSales) {
    if (!s.vehicleId) continue;
    const returned = allReturns.filter(r => r.referenceId === s.id && r.type === "sale-return");
    for (const [index, p] of enrichSale(s).products.entries()) {
      addStock({ id: `${s.id}:${index}`, referenceId: s.id, referenceType: "sell", date: financialDate(s.date), type: "sale", vehicleId: s.vehicleId, productId: p.id, productName: p.name || "", code: p.code || "", quantity: -toMoneyNumber(p.qty), costUSD: toMoneyNumber(p.payPrice) });
    }
  }
  for (const r of allReturns) {
    const s = saleMap.get(r.referenceId);
    if (r.type !== "sale-return" || !s || (r.custodyDriverId || r.stockDriverId || s.driverId) !== driverId || !(r.custodyVehicleId || s.vehicleId)) continue;
    const p = (s.products || []).find((p: RecordData) => p.id === r.productId || p.code === r.productCode);
    addStock({ id: r.id, referenceId: r.referenceId, referenceType: "return", date: financialDate(r.date || r.createdDate), type: "customer_return", vehicleId: r.custodyVehicleId || r.vehicleId || s.vehicleId, productId: r.productId || p?.id || "", productName: r.productName || p?.name || "", code: r.productCode || p?.code || "", quantity: toMoneyNumber(r.qty), costUSD: toMoneyNumber(r.payPriceUSD, toMoneyNumber(p?.payPrice)) });
  }
  for (const p of allPayments.filter(p => p.settlementMethod === "goods" && p.stockDriverId === driverId && p.stockVehicleId)) for (const [index, item] of (p.goodsItems || p.items || []).entries()) addStock({ id: `${p.id}:${index}`, referenceId: p.id, referenceType: "payment", date: financialDate(p.date), type: p.goodsDirection === "receive" ? "goods_receive" : "goods_deliver", vehicleId: p.stockVehicleId, productId: item.productId || item.id, productName: item.productName || item.name || "", code: item.productCode || item.code || "", quantity: toMoneyNumber(item.quantity) * (p.goodsDirection === "receive" ? 1 : -1), costUSD: toMoneyNumber(item.unitCostUSD, toMoneyNumber(item.costPriceUSD)) });
  stockEvents.sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
  const stockBaselines = new Map<string, string>();
  for (const e of stockEvents.filter(e => e.type === "opening")) stockBaselines.set(`${e.vehicleId}:${e.code || e.productId}`, e.date);
  const stockBalanceMap = new Map<string, DriverStatement["stockBalances"][number]>();
  const stockMovements: DriverStockRow[] = [];
  for (const e of stockEvents) {
    const key = `${e.vehicleId}:${e.code || e.productId}`;
    if (stockBaselines.has(key) && e.date < stockBaselines.get(key)!) continue;
    const b = stockBalanceMap.get(key) || { driverId, driverName: driver?.username || driverId, vehicleId: e.vehicleId, productId: e.productId, productName: e.productName, code: e.code, openingQuantity: 0, incomingQuantity: 0, outgoingQuantity: 0, closingQuantity: 0, costUSD: e.costUSD };
    b.closingQuantity = roundMoney(b.closingQuantity + e.quantity);
    b.costUSD = e.costUSD;
    if (before(e.date)) b.openingQuantity = roundMoney(b.openingQuantity + e.quantity);
    else { if (e.quantity >= 0) b.incomingQuantity = roundMoney(b.incomingQuantity + e.quantity); else b.outgoingQuantity = roundMoney(b.outgoingQuantity - e.quantity); stockMovements.push({ ...e, balance: b.closingQuantity }); }
    stockBalanceMap.set(key, b);
  }
  const currentProducts: DriverStatement["currentStock"]["products"] = [];
  for (const v of vehicles.filter(v => v.driverId === driverId && vehicleIncluded(v.id))) for (const [key, p] of recordEntries(input.products[v.name] || input.products[v.id])) currentProducts.push({ vehicleId: v.id, warehouse: v.name, productId: p.id || key, productName: p.name || "", code: p.code || "", quantity: toMoneyNumber(p.quantity), costUSD: toMoneyNumber(p.payPrice) });
  const periodCollections = collections.filter(c => dateIncluded(c.date));
  const periodMovements = ownMovements.filter(m => dateIncluded(m.date));
  const sumSales = (field: keyof DriverSale) => roundMoney(sales.reduce((sum, s) => sum + toMoneyNumber(s[field]), 0));
  const sumMovements = (type: string) => roundMoney(periodMovements.filter(m => m.type === type).reduce((sum, m) => sum + m.amountUSD, 0));
  const unknownCollectionsUSD = roundMoney(periodCollections.filter(c => !c.driverId && c.settlementMethod === "cash").reduce((sum, c) => sum + Math.abs(c.amountUSD), 0));
  const oldInvoiceReturns = allReturns.filter(r => r.type === "sale-return" && saleMap.get(r.referenceId)?.driverId === driverId && before(saleMap.get(r.referenceId)?.date) && dateIncluded(r.date || r.createdDate) && vehicleIncluded(r.vehicleId || saleMap.get(r.referenceId)?.vehicleId));
  const oldReturnsUSD = oldInvoiceReturns.reduce((sum, r) => sum + toMoneyNumber(r.returnValue), 0);
  const oldReturnedCostUSD = oldInvoiceReturns.reduce((sum, r) => sum + toMoneyNumber(r.qty) * toMoneyNumber(r.payPriceUSD, toMoneyNumber((saleMap.get(r.referenceId)?.originalProducts || saleMap.get(r.referenceId)?.products || []).find((p: RecordData) => p.id === r.productId || p.code === r.productCode)?.payPrice)), 0);
  const salesNetUSD = roundMoney(sumSales("netUSD") - oldReturnsUSD);
  const costUSD = roundMoney(sumSales("costUSD") - oldReturnedCostUSD);
  const warnings: string[] = [];
  if (driverSales.some(s => !Array.isArray(s.originalProducts) && allReturns.some(r => r.referenceId === s.id && r.type === "sale-return"))) warnings.push("بعض الفواتير القديمة لا تحفظ نسخة الأصناف الأصلية؛ تُعاد تفاصيلها من سجلات المرتجعات المتاحة، وقد تنقص تكلفة أو خصومات أصناف قديمة أعيدت بالكامل.");
  if (unknownCollectionsUSD > 0) warnings.push("توجد تحصيلات قديمة مجهولة المحصّل؛ مستبعدة من النقد والعمولة المؤكدين.");
  if (!ownMovements.some(m => m.type === "opening" && m.stock?.length)) warnings.push("عهدة البضاعة التاريخية مبنية على الحركات الموثقة؛ أدخل رصيد بداية مؤكد عند بدء استخدام السجل.");
  if (stockBalanceMap.size && [...stockBalanceMap.values()].some(b => b.closingQuantity < 0)) warnings.push("رصيد بضاعة سالب في السجل؛ راجع الأرصدة الافتتاحية والتحويلات السابقة غير المنسوبة إلى السائق.");
  if (vehicleId) warnings.push("الأرصدة المعروضة تخص حركات السيارة المختارة؛ الحركات النقدية العامة بلا سيارة لا تدخل في هذا المرشح.");
  warnings.push("المخزون الحالي يعرض بتاريخ استخراج البيان، ورصيد نهاية الفترة يُحسب من الحركات التاريخية. الديون تعكس السداد والمرتجعات حتى نهاية الفترة.");
  return { driver, drivers: recordEntries(input.users).filter(([, u]) => u.role === "driver" || u.vehicleId || u.commissionRateHistory?.length).map(([id, u]) => toDriverSummary(id, u as InventoryUser)), vehicles, filters: { driverId, dateFrom, dateTo, vehicleId }, summary: {
    salesCount: sales.length, salesGrossUSD: sumSales("grossUSD"), discountsUSD: sumSales("discountUSD"), salesNetUSD, costUSD, profitUSD: roundMoney(salesNetUSD - costUSD), returnsUSD: roundMoney(returns.reduce((sum, r) => sum + r.returnValue, 0)), outstandingDebtUSD: roundMoney(outstandingInvoices.reduce((sum, s) => sum + s.remainingDebtUSD, 0)), cashOpeningUSD: roundMoney(cashOpeningUSD), cashClosingUSD, cashOpeningByCurrency: { USD: roundMoney(cashOpeningByCurrency.USD), SYP: roundMoney(cashOpeningByCurrency.SYP) }, cashClosingByCurrency,
    collectionsUSD: roundMoney(periodCollections.filter(c => !c.isRefund && c.driverId === driverId && c.settlementMethod === "cash").reduce((sum, c) => sum + c.amountUSD, 0)), remittancesUSD: sumMovements("remittance"), advancesUSD: sumMovements("advance"), expensesUSD: sumMovements("expense"), refundedUSD: roundMoney(periodCollections.filter(c => c.isRefund && c.refundPaidByDriverId === driverId).reduce((sum, c) => sum + Math.abs(c.amountUSD), 0)), commissionEarnedUSD: roundMoney(commissionRows.filter(c => c.referenceType === "payment").reduce((sum, c) => sum + c.amountUSD, 0)), commissionPaidUSD: sumMovements("commission_payout"), commissionOpeningUSD, commissionClosingUSD, unknownCollectionsUSD }, sales, outstandingInvoices, returns, settlements, collections: periodCollections.sort((a, b) => a.date.localeCompare(b.date)), cashMovements, commissionRows, stockMovements, stockBalances: [...stockBalanceMap.values()], currentStock: { asOf: generatedAt, products: currentProducts, quantity: roundMoney(currentProducts.reduce((sum, p) => sum + p.quantity, 0)), costUSD: roundMoney(currentProducts.reduce((sum, p) => sum + p.quantity * p.costUSD, 0)) }, generatedAt, warnings };
};

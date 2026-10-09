import { GoodsPaymentItem, Payment } from "../types/payment";
import { JournalEntry, JournalEntryLine } from "../types/journalEntry";
import { normalizeCurrency, normalizeExchangeRate, originalToUSD, roundMoney, toMoneyNumber, usdToOriginal } from "./money";

export interface GoodsPaymentInput {
  requestId: string;
  partyType: "customer" | "supplier";
  customerId?: string;
  supplierId?: string;
  goodsDirection: "receive" | "deliver";
  warehouse: string;
  items: { productId: string; quantity: number; settlementPrice: number }[];
  currency: "USD" | "SYP";
  exchangeRate: number;
  note: string;
  sellId?: string;
  purchaseId?: string;
  partyAccountId: string;
  inventoryAccountId: string;
  differenceAccountId?: string;
}

export interface GoodsOperationContext {
  id: string;
  journalId: string;
  requestKey: string;
  fingerprint: string;
  actorId: string;
  actorName: string;
  now: string;
}

export type FinanceState = Record<string, any>;
export type GoodsResult = { state: FinanceState; payment: Payment; sell?: any; purchase?: any };

const validKey = (value: unknown, label: string, optional = false) => {
  const key = String(value || "").trim();
  if ((optional && !key) || (key && !/[.#$\/\[\]]/.test(key) && key.length <= 200 && !Object.prototype.hasOwnProperty.call(Object.prototype, key))) return key;
  throw new Error(`${label} غير صالح`);
};

const positiveNumber = (value: unknown, label: string) => {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0 || number > 1e12) throw new Error(`${label} يجب أن يكون رقمًا موجبًا`);
  const rounded = roundMoney(number);
  if (rounded <= 0) throw new Error(`${label} أصغر من الدقة المعتمدة`);
  return rounded;
};

export const normalizeGoodsPaymentInput = (raw: any): GoodsPaymentInput => {
  if (!raw || !["customer", "supplier"].includes(raw.partyType)) throw new Error("نوع الطرف مطلوب");
  if (!["receive", "deliver"].includes(raw.goodsDirection)) throw new Error("اتجاه حركة البضاعة مطلوب");
  if (!["USD", "SYP"].includes(raw.currency)) throw new Error("العملة يجب أن تكون USD أو SYP");
  const requestId = String(raw.requestId || "");
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(requestId)) throw new Error("معرف طلب فريد مطلوب لإتمام التسوية");
  if (!Array.isArray(raw.items) || !raw.items.length || raw.items.length > 200) throw new Error("اختر أصناف التسوية (بحد أقصى 200 صنف)");
  const used = new Set<string>();
  const items = raw.items.map((item: any) => {
    const productId = validKey(item.productId, "معرف المنتج");
    if (used.has(productId)) throw new Error("اجمع كميات الصنف المتكرر في سطر واحد");
    used.add(productId);
    return { productId, quantity: positiveNumber(item.quantity, "الكمية"), settlementPrice: positiveNumber(item.settlementPrice, "سعر التسوية") };
  });
  const customerId = validKey(raw.customerId, "معرف الزبون", raw.partyType !== "customer");
  const supplierId = validKey(raw.supplierId, "معرف المورد", raw.partyType !== "supplier");
  if (raw.partyType === "customer" && supplierId || raw.partyType === "supplier" && customerId) throw new Error("تسوية البضاعة تخص طرفًا واحدًا");
  const sellId = validKey(raw.sellId, "معرف فاتورة البيع", true);
  const purchaseId = validKey(raw.purchaseId, "معرف فاتورة الشراء", true);
  if (sellId && (raw.partyType !== "customer" || raw.goodsDirection !== "receive") || purchaseId && (raw.partyType !== "supplier" || raw.goodsDirection !== "deliver")) {
    throw new Error("تسديد فاتورة الزبون يكون باستلام البضاعة، وتسديد فاتورة المورد يكون بتسليمها");
  }
  const accountIds = [validKey(raw.partyAccountId, "حساب الطرف"), validKey(raw.inventoryAccountId, "حساب المخزون")];
  const differenceAccountId = validKey(raw.differenceAccountId, "حساب فرق القيمة", true);
  if (differenceAccountId) accountIds.push(differenceAccountId);
  if (new Set(accountIds).size !== accountIds.length) throw new Error("اختر حسابات مختلفة للطرف والمخزون وفرق القيمة");
  return {
    requestId, partyType: raw.partyType, goodsDirection: raw.goodsDirection,
    ...(customerId ? { customerId } : {}), ...(supplierId ? { supplierId } : {}),
    warehouse: validKey(raw.warehouse, "المستودع"), items,
    currency: raw.currency, exchangeRate: normalizeExchangeRate(raw.currency, raw.exchangeRate),
    note: String(raw.note || "").trim().slice(0, 2000),
    ...(sellId ? { sellId } : {}), ...(purchaseId ? { purchaseId } : {}),
    partyAccountId: accountIds[0], inventoryAccountId: accountIds[1],
    ...(differenceAccountId ? { differenceAccountId } : {}),
  };
};

const normalizeLookup = (value: unknown) => String(value || "").normalize("NFKC").trim().toLowerCase();
const values = (collection: any): any[] => Object.values(collection || {});

const resolveWarehouse = (state: FinanceState, requested: string) => {
  const match = Object.entries(state.warehouses || {}).find(([key, warehouse]: [string, any]) =>
    [key, warehouse.id, warehouse.name].some((value) => normalizeLookup(value) === normalizeLookup(requested)),
  );
  if (!match) throw new Error("المستودع غير موجود");
  const [id, warehouse] = match as [string, any];
  if (warehouse.isActive === false) throw new Error("المستودع غير فعال");
  const warehouseKey = Object.keys(state.products || {}).find((key) => normalizeLookup(key) === normalizeLookup(warehouse.name))
    || Object.keys(state.products || {}).find((key) => [id, warehouse.id].some((value) => normalizeLookup(key) === normalizeLookup(value))) || warehouse.name;
  return { id: warehouse.id || id, warehouse, warehouseKey };
};

const getAccount = (state: FinanceState, id: string) => {
  const account = state.accounts?.[id];
  if (!account || account.isActive === false || account.allowTransactions === false) throw new Error("الحساب غير موجود أو لا يسمح بالحركات");
  return account;
};

const journalLine = (state: FinanceState, accountId: string, debit: number, credit: number, currency: "USD" | "SYP", rate: number, originalAmount?: number): JournalEntryLine => ({
  accountId, accountName: getAccount(state, accountId).name || accountId,
  debit: roundMoney(debit), credit: roundMoney(credit), currency,
  exchangeRate: rate, amountUSD: roundMoney(debit || credit),
  amountOriginal: originalAmount ?? usdToOriginal(debit || credit, currency, rate),
  amountSYP: currency === "SYP" ? originalAmount ?? usdToOriginal(debit || credit, currency, rate) : 0,
});

export const applyFinanceJournal = (state: FinanceState, entry: JournalEntry) => {
  const debit = roundMoney(entry.lines.reduce((sum, line) => sum + line.debit, 0));
  const credit = roundMoney(entry.lines.reduce((sum, line) => sum + line.credit, 0));
  if (debit !== credit) throw new Error("قيد التسوية غير متوازن");
  for (const line of entry.lines) {
    const account = getAccount(state, line.accountId);
    const debitNature = account.nature === "Debit" || (!account.nature && ["Asset", "Expense"].includes(account.type));
    const deltaUSD = roundMoney((line.debit - line.credit) * (debitNature ? 1 : -1));
    const deltaSYP = line.currency === "SYP" ? roundMoney((line.debit ? 1 : -1) * toMoneyNumber(line.amountSYP) * (debitNature ? 1 : -1)) : 0;
    const currentUSD = toMoneyNumber(account.currentBalanceUSD, account.currency === "SYP" ? 0 : toMoneyNumber(account.currentBalance));
    const currentSYP = toMoneyNumber(account.currentBalanceSYP, account.currency === "SYP" ? toMoneyNumber(account.currentBalance) : 0);
    state.accounts[line.accountId] = { ...account, currentBalance: roundMoney(currentUSD + deltaUSD), currentBalanceUSD: roundMoney(currentUSD + deltaUSD), currentBalanceSYP: roundMoney(currentSYP + deltaSYP), updatedAt: entry.date };
  }
  state.journalEntries ||= {};
  state.journalEntries[entry.id] = entry;
};

const invoiceSettlement = (state: FinanceState, payment: Payment, reverse: boolean, now: string) => {
  const invoiceId = payment.sellId || payment.purchaseId;
  if (!invoiceId) return undefined;
  const collection = payment.sellId ? "sells" : "purchases";
  const invoice = state[collection]?.[invoiceId];
  if (!invoice || (payment.customerId ? invoice.customerId !== payment.customerId : invoice.supplierId !== payment.supplierId)) throw new Error("الفاتورة غير موجودة أو تخص طرفًا آخر");
  const amount = Math.abs(toMoneyNumber(payment.amountUSD, payment.amount));
  const total = toMoneyNumber(invoice.totalUSD, toMoneyNumber(invoice.totalPrice));
  const remaining = toMoneyNumber(invoice.remainingUSD, toMoneyNumber(invoice.remainingDebt));
  const nextRemaining = roundMoney(remaining + (reverse ? amount : -amount));
  if (nextRemaining < 0 || nextRemaining > total + 0.001) throw new Error(reverse ? "لا يمكن عكس التسوية بعد تغيير قيمة الفاتورة؛ راجع حركاتها" : "قيمة التسوية أكبر من المتبقي في الفاتورة");
  const invoiceCurrency = invoice.paymentCurrency || invoice.currency;
  const rate = normalizeExchangeRate(invoiceCurrency === "SYP" ? "SYP" : "USD", invoice.exchangeRate);
  const currency = invoiceCurrency === "SYP" ? "SYP" : "USD";
  const paid = roundMoney(total - nextRemaining);
  const next = {
    ...invoice, remainingDebt: nextRemaining, remainingUSD: nextRemaining,
    remainingOriginal: usdToOriginal(nextRemaining, currency, rate), remainingSYP: currency === "SYP" ? usdToOriginal(nextRemaining, currency, rate) : 0,
    paidUSD: paid, paidOriginal: usdToOriginal(paid, currency, rate), paidSYP: currency === "SYP" ? usdToOriginal(paid, currency, rate) : 0,
    paymentStatus: nextRemaining === 0 ? "cash" : paid > 0 ? "part" : "debt", partValue: usdToOriginal(paid, currency, rate), updatedAt: now,
    ...(collection === "purchases" ? { paidAmount: paid } : {}),
  };
  state[collection][invoiceId] = next;
  payment.balanceSYPChange = currency === "SYP" ? roundMoney((reverse ? -1 : 1) * (payment.customerId ? 1 : -1) * usdToOriginal(amount, currency, rate)) : 0;
  return next;
};

export const reconcileGoodsCustomerState = (state: FinanceState, customerId: string) => {
  const customer = state.customer?.[customerId];
  if (!customer) throw new Error("الزبون غير موجود");
  const sells = Object.entries(state.sells || {}).map(([id, sale]: [string, any]) => ({ ...sale, id: sale.id || id })).filter((sale) => sale.customerId === customerId);
  const direct = values(state.payment).filter((payment) => payment.customerId === customerId && !payment.sellId && (payment.settlementMethod === "goods" || payment.type === "income" || payment.type === "return-credit" || payment.type === "expense" && payment.balanceUSDChange !== undefined));
  const balanceUSD = roundMoney(-sells.reduce((sum, sale) => sum + toMoneyNumber(sale.remainingUSD, toMoneyNumber(sale.remainingDebt)), 0) + direct.reduce((sum, payment) => sum + toMoneyNumber(payment.balanceUSDChange, toMoneyNumber(payment.amountUSD, toMoneyNumber(payment.amount))), 0));
  const balanceSYP = roundMoney(-sells.reduce((sum, sale) => sum + (normalizeCurrency(sale.paymentCurrency || sale.currency) === "SYP" ? toMoneyNumber(sale.remainingSYP, toMoneyNumber(sale.remainingOriginal)) : 0), 0) + direct.reduce((sum, payment) => sum + toMoneyNumber(payment.balanceSYPChange, toMoneyNumber(payment.amountSYP)), 0));
  state.customer[customerId] = { ...customer, balance: balanceUSD, balanceUSD, balanceSYP, purchases: sells.map((sale) => sale.id).filter(Boolean) };
};

const recordPayment = (state: FinanceState, payment: Payment, context: GoodsOperationContext, lines: JournalEntryLine[], invoice?: any): GoodsResult => {
  const partyKey = payment.customerId ? "customer" : "supplier";
  const partyId = String(payment.customerId || payment.supplierId);
  const party = state[partyKey]?.[partyId];
  if (!party) throw new Error("الطرف غير موجود");
  state.payment ||= {};
  state.payment[context.id] = payment;
  if (partyKey === "customer") reconcileGoodsCustomerState(state, partyId);
  else state.supplier[partyId] = { ...party, balance: roundMoney(toMoneyNumber(party.balanceUSD, toMoneyNumber(party.balance)) + toMoneyNumber(payment.balanceUSDChange)), balanceUSD: roundMoney(toMoneyNumber(party.balanceUSD, toMoneyNumber(party.balance)) + toMoneyNumber(payment.balanceUSDChange)), balanceSYP: roundMoney(toMoneyNumber(party.balanceSYP) + toMoneyNumber(payment.balanceSYPChange)), updatedDate: context.now };
  applyFinanceJournal(state, { id: context.journalId, date: context.now, description: payment.note || (payment.reversalOf ? "عكس دفعة بالبضاعة" : "تسوية حساب بالبضاعة"), referenceType: "goods-payment", referenceId: context.id, createdBy: context.actorId, lines });
  state.financialRequests ||= {};
  state.financialRequests[context.requestKey] = { paymentId: context.id, fingerprint: context.fingerprint };
  state.inventoryMovements ||= {};
  (payment.goodsItems || []).forEach((item, index) => {
    state.inventoryMovements[`${context.id}_${index}`] = {
      id: `${context.id}_${index}`, type: payment.goodsDirection === "receive" ? "goods-receive" : "goods-deliver", referenceId: context.id,
      productId: item.productId, code: item.code, name: item.name, warehouse: payment.warehouse,
      warehouseId: payment.warehouseId, quantityDelta: item.quantity * (payment.goodsDirection === "receive" ? 1 : -1),
      quantityBefore: item.quantityBefore, quantityAfter: item.quantityAfter, payPriceUSD: item.costPriceUSD, date: context.now,
      custodyDriverId: payment.stockDriverId || "", vehicleId: payment.stockVehicleId || "", createdBy: context.actorId,
    };
  });
  return { state, payment, ...(payment.sellId ? { sell: invoice } : payment.purchaseId ? { purchase: invoice } : {}) };
};

const previousResult = (state: FinanceState, context: GoodsOperationContext): GoodsResult | undefined => {
  const previous = state.financialRequests?.[context.requestKey];
  if (!previous) return undefined;
  if (previous.fingerprint !== context.fingerprint) throw new Error("معرف الطلب مستخدم لعملية مختلفة");
  const payment = state.payment?.[previous.paymentId] as Payment;
  if (!payment) throw new Error("سجل العملية السابقة غير مكتمل");
  return { state, payment, ...(payment.sellId ? { sell: state.sells?.[payment.sellId] } : payment.purchaseId ? { purchase: state.purchases?.[payment.purchaseId] } : {}) };
};

export const applyGoodsPayment = (sourceState: FinanceState, input: GoodsPaymentInput, context: GoodsOperationContext): GoodsResult => {
  const existing = previousResult(sourceState, context);
  if (existing) return existing;
  const state: FinanceState = JSON.parse(JSON.stringify(sourceState));
  const { id: warehouseId, warehouse, warehouseKey } = resolveWarehouse(state, input.warehouse);
  if (!state[input.partyType]?.[input.customerId || input.supplierId || ""]) throw new Error("الطرف غير موجود");
  const partyAccount = getAccount(state, input.partyAccountId);
  const inventoryAccount = getAccount(state, input.inventoryAccountId);
  if (partyAccount.category !== (input.partyType === "customer" ? "AccountsReceivable" : "AccountsPayable")) throw new Error("اختر حساب ذمم مناسبًا لنوع الطرف");
  if (inventoryAccount.category !== "Inventory") throw new Error("اختر حسابًا من فئة المخزون");
  const sign = input.goodsDirection === "receive" ? 1 : -1;
  const items: GoodsPaymentItem[] = input.items.map((item) => {
    const product = state.products?.[warehouseKey]?.[item.productId];
    if (!product) throw new Error("المنتج غير موجود في المستودع المحدد");
    const before = toMoneyNumber(product.quantity);
    const reserved = Number(product.reservedQuantity || 0);
    if (!Number.isFinite(Number(product.quantity)) || before < 0 || !Number.isFinite(reserved) || reserved < 0 || reserved > before) throw new Error("رصيد المخزون أو الكمية المحجوزة غير صالحين");
    const after = roundMoney(before + sign * item.quantity);
    if (after < 0 || sign < 0 && item.quantity > roundMoney(before - reserved)) throw new Error(`الكمية المتاحة غير كافية للمنتج ${product.name || product.code}`);
    const lineOriginal = roundMoney(item.quantity * item.settlementPrice);
    const lineUSD = originalToUSD(lineOriginal, input.currency, input.exchangeRate);
    if (lineUSD <= 0) throw new Error("قيمة الصنف بالدولار أصغر من الدقة المعتمدة");
    const unitCost = sign > 0 ? roundMoney(lineUSD / item.quantity, 6) : toMoneyNumber(product.payPrice);
    if (unitCost < 0) throw new Error("تكلفة المنتج غير صالحة");
    const costUSD = sign > 0 ? lineUSD : roundMoney(unitCost * item.quantity);
    const nextCost = sign > 0 ? roundMoney((before * toMoneyNumber(product.payPrice) + costUSD) / after, 6) : toMoneyNumber(product.payPrice);
    state.products[warehouseKey][item.productId] = { ...product, id: item.productId, warehouse: warehouseKey, quantity: after, payPrice: nextCost, updatedDate: context.now };
    return { ...item, name: product.name || "", code: product.code || "", warehouse: warehouseKey, unit: product.unit || "", settlementPriceUSD: originalToUSD(item.settlementPrice, input.currency, input.exchangeRate), costPriceUSD: unitCost, costUSD, lineTotalUSD: lineUSD, lineTotalOriginal: lineOriginal, quantityBefore: before, quantityAfter: after };
  });
  const amount = roundMoney(items.reduce((sum, item) => sum + item.lineTotalUSD, 0));
  const original = roundMoney(items.reduce((sum, item) => sum + item.lineTotalOriginal, 0));
  const cost = roundMoney(items.reduce((sum, item) => sum + item.costUSD, 0));
  const difference = roundMoney(amount - cost);
  const costOriginal = difference === 0 ? original : usdToOriginal(cost, input.currency, input.exchangeRate);
  const differenceOriginal = roundMoney(original - costOriginal);
  const lines = [journalLine(state, input.partyAccountId, sign < 0 ? amount : 0, sign > 0 ? amount : 0, input.currency, input.exchangeRate, original)];
  if (cost > 0) lines.push(journalLine(state, input.inventoryAccountId, sign > 0 ? cost : 0, sign < 0 ? cost : 0, input.currency, input.exchangeRate, costOriginal));
  if (difference !== 0) {
    if (!input.differenceAccountId) throw new Error("اختر حساب فرق القيمة لأن سعر التسوية يختلف عن تكلفة المخزون");
    lines.push(journalLine(state, input.differenceAccountId, sign * difference > 0 ? Math.abs(difference) : 0, sign * difference < 0 ? Math.abs(difference) : 0, input.currency, input.exchangeRate, Math.abs(differenceOriginal)));
  }
  const custodyDriverId = warehouse.type === "vehicle" ? String(warehouse.driverId || "") : "";
  const payment: Payment = {
    id: context.id, requestId: input.requestId, type: "goods", settlementMethod: "goods", partyType: input.partyType,
    ...(input.customerId ? { customerId: input.customerId } : { supplierId: input.supplierId }),
    ...(input.sellId ? { sellId: input.sellId } : {}), ...(input.purchaseId ? { purchaseId: input.purchaseId } : {}),
    goodsDirection: input.goodsDirection, goodsItems: items, warehouse: warehouseKey, warehouseId,
    partyAccountId: input.partyAccountId, inventoryAccountId: input.inventoryAccountId,
    ...(input.differenceAccountId ? { differenceAccountId: input.differenceAccountId } : {}),
    ...(input.partyType === "customer" ? { receivableAccountId: input.partyAccountId } : { payableAccountId: input.partyAccountId }),
    goodsCostUSD: cost, goodsDifferenceUSD: difference, amount: sign * amount, amountUSD: sign * amount,
    amountOriginal: sign * original, amount_base: sign * original, amountSYP: input.currency === "SYP" ? sign * original : 0,
    currency: input.currency, paymentCurrency: input.currency, exchangeRate: input.exchangeRate,
    balanceUSDChange: sign * amount, balanceSYPChange: input.currency === "SYP" ? sign * original : 0,
    date: context.now, note: input.note, actorId: context.actorId, actorName: context.actorName, createdBy: context.actorId,
    journalEntryId: context.journalId, status: "posted", collectionSource: "management",
    stockDriverId: custodyDriverId, stockVehicleId: warehouse.type === "vehicle" ? warehouseId : "", driverId: custodyDriverId, vehicleId: warehouse.type === "vehicle" ? warehouseId : "",
  };
  const invoice = invoiceSettlement(state, payment, false, context.now);
  if (invoice) {
    const invoiceCurrency = (invoice.paymentCurrency || invoice.currency) === "SYP" ? "SYP" : "USD";
    const invoiceRate = normalizeExchangeRate(invoiceCurrency, invoice.exchangeRate);
    lines[0] = journalLine(state, input.partyAccountId, sign < 0 ? amount : 0, sign > 0 ? amount : 0, invoiceCurrency, invoiceRate, usdToOriginal(amount, invoiceCurrency, invoiceRate));
  }
  return recordPayment(state, payment, context, lines, invoice);
};

export const reverseGoodsPayment = (sourceState: FinanceState, sourceId: string, requestId: string, note: string, context: GoodsOperationContext): GoodsResult => {
  const existing = previousResult(sourceState, context);
  if (existing) return existing;
  const state: FinanceState = JSON.parse(JSON.stringify(sourceState));
  const original = state.payment?.[sourceId] as Payment;
  if (!original || original.settlementMethod !== "goods") throw new Error("سند التسوية بالبضاعة غير موجود");
  if (original.reversedBy || original.reversalOf) throw new Error("السند معكوس سابقًا أو هو سند عكسي");
  const entry = state.journalEntries?.[original.journalEntryId || ""] as JournalEntry;
  if (!entry) throw new Error("قيد السند الأصلي غير موجود");
  const { warehouse, warehouseKey } = resolveWarehouse(state, original.warehouseId || original.warehouse || "");
  if ((original.stockDriverId || "") !== (warehouse.type === "vehicle" ? warehouse.driverId || "" : "")) throw new Error("تغيرت عهدة السيارة؛ راجع نقل العهدة قبل عكس السند");
  const direction = original.goodsDirection === "receive" ? "deliver" : "receive";
  const sign = direction === "receive" ? 1 : -1;
  const items = (original.goodsItems || []).map((item) => {
    const product = state.products?.[warehouseKey]?.[item.productId];
    if (!product) throw new Error("المنتج الأصلي غير موجود في المستودع");
    const before = toMoneyNumber(product.quantity);
    if (sign < 0 && item.quantity > roundMoney(before - toMoneyNumber(product.reservedQuantity))) throw new Error("الكمية المتاحة غير كافية لعكس السند");
    const after = roundMoney(before + sign * item.quantity);
    const stockValue = roundMoney(before * toMoneyNumber(product.payPrice) + sign * item.costUSD, 6);
    if (stockValue < -0.001 || after === 0 && Math.abs(stockValue) > 0.001) throw new Error("حركات التكلفة اللاحقة تمنع عكس السند تلقائيًا؛ راجع تقييم المخزون");
    state.products[warehouseKey][item.productId] = { ...product, quantity: after, payPrice: after > 0 ? roundMoney(Math.max(stockValue, 0) / after, 6) : toMoneyNumber(product.payPrice), updatedDate: context.now };
    return { ...item, quantityBefore: before, quantityAfter: after };
  });
  const payment: Payment = {
    ...original, id: context.id, requestId, reversalOf: sourceId, reversedBy: undefined,
    goodsDirection: direction, goodsItems: items, status: "posted", date: context.now,
    amount: -original.amount, amountUSD: -toMoneyNumber(original.amountUSD, original.amount), amountOriginal: -toMoneyNumber(original.amountOriginal), amount_base: -original.amount_base, amountSYP: -toMoneyNumber(original.amountSYP),
    balanceUSDChange: -toMoneyNumber(original.balanceUSDChange, original.amount), balanceSYPChange: -toMoneyNumber(original.balanceSYPChange),
    journalEntryId: context.journalId, actorId: context.actorId, actorName: context.actorName, createdBy: context.actorId,
    note: note.trim() || `عكس تسوية البضاعة ${sourceId}`,
  };
  delete payment.reversedBy;
  state.payment[sourceId] = { ...original, status: "reversed", reversedBy: context.id };
  const invoice = invoiceSettlement(state, payment, true, context.now);
  const lines = entry.lines.map((line) => ({ ...line, debit: line.credit, credit: line.debit }));
  return recordPayment(state, payment, context, lines, invoice);
};

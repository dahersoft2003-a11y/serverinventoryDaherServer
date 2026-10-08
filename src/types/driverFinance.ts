import type { SupportedCurrency } from "../utils/money";

export interface CommissionRateChange {
  id: string;
  rate: number;
  effectiveFrom: string;
  createdAt: string;
  createdBy: string;
}

export interface DriverSummary {
  id: string;
  username: string;
  commissionRate: number;
  commissionEffectiveFrom?: string;
  commissionRateHistory?: CommissionRateChange[];
  vehicleId?: string;
  vehicleName?: string;
}

export interface DriverStockItem {
  productId: string;
  productName: string;
  code: string;
  quantity: number;
  costUSD: number;
}

export interface DriverMovement {
  id: string;
  requestId: string;
  driverId: string;
  driverName: string;
  vehicleId?: string;
  type: "remittance" | "commission_payout" | "advance" | "expense" | "opening";
  date: string;
  currency: SupportedCurrency;
  exchangeRate: number;
  amountOriginal: number;
  amountUSD: number;
  payoutSource?: "driver_cash" | "treasury";
  sourceAccountId?: string;
  destinationAccountId?: string;
  expenseAccountId?: string;
  openingCashOriginal?: number;
  openingCommissionUSD?: number;
  stock?: DriverStockItem[];
  note: string;
  createdBy: string;
  createdAt: string;
  journalEntryId?: string;
}

export interface DriverCollection {
  id: string;
  date: string;
  sellId?: string;
  customerId?: string;
  customerName: string;
  driverId: string;
  driverName: string;
  vehicleId?: string;
  currency: SupportedCurrency;
  exchangeRate: number;
  amountOriginal: number;
  amountUSD: number;
  commissionRate: number | null;
  commissionUSD: number;
  commissionOriginal: number;
  isRefund: boolean;
  originalPaymentId?: string;
  collectionSource: string;
  refundPaidByDriverId?: string;
  settlementMethod: string;
  note: string;
}

export interface DriverCashRow {
  driverId?: string;
  driverName?: string;
  id: string;
  referenceId: string;
  referenceType: "payment" | "driver-movement";
  date: string;
  type: string;
  currency: SupportedCurrency;
  exchangeRate: number;
  amountOriginal: number;
  amountUSD: number;
  balanceUSD: number;
  balanceByCurrency: Record<SupportedCurrency, number>;
  note: string;
}

export interface DriverCommissionRow {
  driverId?: string;
  driverName?: string;
  id: string;
  referenceId: string;
  referenceType: "payment" | "driver-movement";
  date: string;
  type: string;
  rate: number | null;
  basisUSD: number;
  amountUSD: number;
  balanceUSD: number;
}

export interface DriverStockRow {
  driverId?: string;
  driverName?: string;
  id: string;
  referenceId: string;
  referenceType: string;
  date: string;
  type: string;
  vehicleId: string;
  productId: string;
  productName: string;
  code: string;
  quantity: number;
  costUSD: number;
  balance: number;
}

export interface DriverStockBalance {
  driverId?: string;
  driverName?: string;
  vehicleId: string;
  productId: string;
  productName: string;
  code: string;
  openingQuantity: number;
  incomingQuantity: number;
  outgoingQuantity: number;
  closingQuantity: number;
  costUSD: number;
}

export interface DriverSale {
  driverId: string;
  driverName: string;
  id: string;
  date: string;
  customerId: string;
  customerName: string;
  vehicleId?: string;
  vehicleName?: string;
  currency: string;
  exchangeRate: number;
  grossUSD: number;
  discountUSD: number;
  netUSD: number;
  costUSD: number;
  profitUSD: number;
  returnsUSD: number;
  remainingDebtUSD: number;
  paymentAccountId?: string;
  receivableAccountId?: string;
  products: Array<{ id: string; code: string; name: string; qty: number; payPrice: number; sellPrice: number; warehouse: string }>;
  paymentStatus: string;
}

export interface DriverStatement {
  driver: DriverSummary | null;
  drivers: DriverSummary[];
  vehicles: Array<{ id: string; name: string; driverId?: string; driverName?: string }>;
  filters: { driverId: string; dateFrom: string; dateTo: string; vehicleId: string };
  summary: {
    salesCount: number;
    salesGrossUSD: number;
    discountsUSD: number;
    salesNetUSD: number;
    costUSD: number;
    profitUSD: number;
    returnsUSD: number;
    outstandingDebtUSD: number;
    cashOpeningUSD: number;
    cashClosingUSD: number;
    cashOpeningByCurrency: Record<SupportedCurrency, number>;
    cashClosingByCurrency: Record<SupportedCurrency, number>;
    collectionsUSD: number;
    remittancesUSD: number;
    advancesUSD: number;
    expensesUSD: number;
    refundedUSD: number;
    commissionEarnedUSD: number;
    commissionPaidUSD: number;
    commissionOpeningUSD: number;
    commissionClosingUSD: number;
    unknownCollectionsUSD: number;
  };
  sales: DriverSale[];
  outstandingInvoices: DriverSale[];
  collections: DriverCollection[];
  cashMovements: DriverCashRow[];
  commissionRows: DriverCommissionRow[];
  stockMovements: DriverStockRow[];
  stockBalances: DriverStockBalance[];
  returns: Array<{ id: string; date: string; sellId: string; driverId: string; driverName: string; customerName: string; productName: string; code: string; qty: number; returnValue: number; cashRefundUSD: number; receivableCreditUSD: number }>;
  settlements: Array<{ id: string; date: string; sellId?: string; driverId: string; driverName: string; customerName: string; goodsDirection: string; amountUSD: number; items: Array<{ productId: string; name: string; code: string; quantity: number; settlementPriceUSD: number; lineTotalUSD: number }> }>;
  currentStock: { asOf: string; products: Array<DriverStockItem & { vehicleId: string; warehouse: string }>; quantity: number; costUSD: number };
  generatedAt: string;
  warnings: string[];
}

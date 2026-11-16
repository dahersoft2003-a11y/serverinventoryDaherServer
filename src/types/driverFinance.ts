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
  costAmount: number;
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
  amount: number;
  payoutSource?: "driver_cash" | "treasury";
  sourceAccountId?: string;
  destinationAccountId?: string;
  expenseAccountId?: string;
  openingCashOriginal?: number;
  openingCommissionAmount?: number;
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
  amount: number;
  commissionRate: number | null;
  commissionAmount: number;
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
  amount: number;
  balance: number;
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
  basisAmount: number;
  amount: number;
  balance: number;
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
  costAmount: number;
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
  costAmount: number;
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
  grossAmount: number;
  discount: number;
  netAmount: number;
  costAmount: number;
  profitAmount: number;
  returnsAmount: number;
  remainingDebtAmount: number;
  paymentAccountId?: string;
  receivableAccountId?: string;
  products: Array<{
    id: string;
    code: string;
    name: string;
    qty: number;
    payPrice: number;
    sellPrice: number;
    warehouse: string;
  }>;
  paymentStatus: string;
}
export interface DriverStatement {
  driver: DriverSummary | null;
  drivers: DriverSummary[];
  vehicles: Array<{
    id: string;
    name: string;
    driverId?: string;
    driverName?: string;
  }>;
  filters: {
    driverId: string;
    dateFrom: string;
    dateTo: string;
    vehicleId: string;
  };
  summary: {
    salesCount: number;
    salesGrossAmount: number;
    discountsAmount: number;
    salesNetAmount: number;
    costAmount: number;
    profitAmount: number;
    returnsAmount: number;
    outstandingDebtAmount: number;
    cashOpeningAmount: number;
    cashClosingAmount: number;
    cashOpeningByCurrency: Record<SupportedCurrency, number>;
    cashClosingByCurrency: Record<SupportedCurrency, number>;
    collectionsAmount: number;
    remittancesAmount: number;
    advancesAmount: number;
    expensesAmount: number;
    refundedAmount: number;
    commissionEarnedAmount: number;
    commissionPaidAmount: number;
    commissionOpeningAmount: number;
    commissionClosingAmount: number;
    unknownCollectionsAmount: number;
  };
  sales: DriverSale[];
  outstandingInvoices: DriverSale[];
  collections: DriverCollection[];
  cashMovements: DriverCashRow[];
  commissionRows: DriverCommissionRow[];
  stockMovements: DriverStockRow[];
  stockBalances: DriverStockBalance[];
  returns: Array<{
    id: string;
    date: string;
    sellId: string;
    driverId: string;
    driverName: string;
    customerName: string;
    productName: string;
    code: string;
    qty: number;
    returnValue: number;
    cashRefundAmount: number;
    receivableCreditAmount: number;
  }>;
  settlements: Array<{
    id: string;
    date: string;
    sellId?: string;
    driverId: string;
    driverName: string;
    customerName: string;
    goodsDirection: string;
    amount: number;
    items: Array<{
      productId: string;
      name: string;
      code: string;
      quantity: number;
      settlementPriceAmount: number;
      lineTotalAmount: number;
    }>;
  }>;
  currentStock: {
    asOf: string;
    products: Array<
      DriverStockItem & {
        vehicleId: string;
        warehouse: string;
      }
    >;
    quantity: number;
    costAmount: number;
  };
  generatedAt: string;
  warnings: string[];
}

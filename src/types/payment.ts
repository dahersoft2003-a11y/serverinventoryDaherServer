
export interface GoodsPaymentItem {
    productId: string;
    name: string;
    code: string;
    warehouse: string;
    unit?: string;
    quantity: number;
    settlementPrice: number;
    settlementPriceUSD: number;
    costPriceUSD: number;
    costUSD: number;
    lineTotalUSD: number;
    lineTotalOriginal: number;
    quantityBefore: number;
    quantityAfter: number;
}

export interface Payment {
    id?: string;
    type: string,
    supplierId?: string,
    customerId?: string,
    sellId?: string,
    purchaseId?: string,
    paymentAccountId?: string,
    receivableAccountId?: string,
    payableAccountId?: string,
    salesAccountId?: string,
    expenseAccountId?: string,
    currency: string,
    exchangeRate: number,
    amount_base: number,
    amount: number,
    paymentCurrency?: "USD" | "SYP",
    amountUSD?: number,
    amountSYP?: number,
    amountOriginal?: number,
    balanceSYPChange?: number,
    balanceUSDChange?: number,
    settlementMethod?: "cash" | "goods",
    goodsDirection?: "receive" | "deliver",
    goodsItems?: GoodsPaymentItem[],
    warehouse?: string,
    warehouseId?: string,
    partyType?: "customer" | "supplier",
    partyAccountId?: string,
    inventoryAccountId?: string,
    differenceAccountId?: string,
    goodsCostUSD?: number,
    goodsDifferenceUSD?: number,
    journalEntryId?: string,
    requestId?: string,
    actorId?: string,
    actorName?: string,
    createdBy?: string,
    status?: "posted" | "reversed",
    reversalOf?: string,
    reversedBy?: string,
    collectorId?: string,
    collectorName?: string,
    collectionSource?: "driver" | "management" | "unknown" | "refund",
    commissionRate?: number,
    commissionUSD?: number,
    commissionOriginal?: number,
    originalPaymentId?: string,
    refundPaidByDriverId?: string,
    driverMovementId?: string,
    vehicleId?: string,
    driverId?: string,
    stockDriverId?: string,
    stockVehicleId?: string,
    adjustmentSourceSellId?: string,
    date?: string,
    note: string
}

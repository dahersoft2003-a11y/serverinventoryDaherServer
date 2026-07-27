
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
    date?: string,
    note: string
}

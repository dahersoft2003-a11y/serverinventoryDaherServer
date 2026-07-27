export interface Customer {
    id: string;
    name: string;
    number?: string;
    balance: number;
    balanceUSD?: number;
    balanceSYP?: number;
    defaultPaymentAccountId?: string;
    defaultReceivableAccountId?: string;
    defaultSalesAccountId?: string;
    createdDate: string;
    updatedDate: string;
    purchases: any[]
}

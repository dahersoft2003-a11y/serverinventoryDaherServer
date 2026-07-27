export interface Supplier {
    id: string;
    name: string;
    number?: string;
    balance: number;
    balanceUSD?: number;
    balanceSYP?: number;
    defaultPaymentAccountId?: string;
    defaultPayableAccountId?: string;
    defaultInventoryAccountId?: string;
    createdDate: string;
    updatedDate: string;
    purchases: any[];
}

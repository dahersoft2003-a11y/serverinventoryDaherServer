export interface Supplier {
  openingBalance?: number;
  id: string;
  name: string;
  number?: string;
  balance: number;
  defaultPaymentAccountId?: string;
  defaultPayableAccountId?: string;
  defaultInventoryAccountId?: string;
  createdDate: string;
  updatedDate: string;
  purchases: any[];
}

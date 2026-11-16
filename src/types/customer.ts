export interface Customer {
  openingBalance?: number;
  id: string;
  name: string;
  number?: string;
  balance: number;
  defaultPaymentAccountId?: string;
  defaultReceivableAccountId?: string;
  defaultSalesAccountId?: string;
  createdDate: string;
  updatedDate: string;
  purchases: any[];
}

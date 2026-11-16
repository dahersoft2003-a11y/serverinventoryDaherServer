export interface purchase {
  id: string;
  requestId?: string;
  supplierId: string;
  name: string;
  code: string;
  warehouse: string;
  quantity: number;
  payPrice: number;
  totalPrice: number;
  products?: {
    id?: string;
    name: string;
    code: string;
    category: string;
    warehouse: string;
    quantity: number;
    payPrice: number;
    wholesalePrice?: number;
    superWholesalePrice?: number;
    sellPrice: number;
    unit: string;
    alertQuantity?: number;
    lineTotal?: number;
  }[];
  currency: string;
  amount: number;
  partValue?: number;
  paidAmount?: number;
  remainingDebt?: number;
  paymentStatus: string;
  inventoryAccountId: string;
  payableAccountId: string;
  paymentAccountId?: string;
  date: string;
}

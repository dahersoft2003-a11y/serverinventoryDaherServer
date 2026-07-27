import type { ProductPriceType } from "./product";

export type QuotationStatus =
  | "draft"
  | "sent"
  | "accepted"
  | "rejected"
  | "converted";

export interface QuotationProduct {
  id: string;
  productId?: string;
  name: string;
  code: string;
  category?: string;
  warehouse: string;
  quantity?: number;
  reservedQuantity?: number;
  qty: number;
  payPrice?: number;
  wholesalePrice?: number;
  superWholesalePrice?: number;
  sellPrice: number;
  selectedPriceType?: ProductPriceType;
  unit?: string;
  updatedDate?: string;
  alertQuantity?: number;
}

export interface Quotation {
  id?: string;
  number: string;
  customerId?: string;
  customerName: string;
  customerNumber?: string;
  products: QuotationProduct[];
  subtotal: number;
  discount: number;
  discountType?: "none" | "amount" | "percent" | "mixed";
  discountPercent?: number;
  discountPercentUSD?: number;
  discountAmountUSD?: number;
  totalPrice: number;
  currency: string;
  exchangeRate: number;
  status: QuotationStatus;
  validUntil?: string;
  note?: string;
  convertedSellId?: string;
  date?: string;
  createdAt?: string;
  updatedAt?: string;
}

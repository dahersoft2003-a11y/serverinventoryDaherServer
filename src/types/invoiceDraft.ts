import { Product, ProductPriceType } from "./product";

export type InvoicePaymentStatus = "cash" | "part" | "debt";

export type InvoiceDraftProduct = Product & {
  productId?: string;
  qty: number;
  totalPrice?: number;
  selectedPriceType?: ProductPriceType;
};

export interface InvoiceDraft {
  id?: string;
  userId: string;
  customerId: string;
  products: InvoiceDraftProduct[];
  discount: string;
  discountPercent?: string;
  discountAmount?: string;
  paymentStatus: InvoicePaymentStatus;
  partValue: string;
  currency: string;
  exchangeRate: number;
  paymentAccountId: string;
  receivableAccountId: string;
  salesAccountId: string;
  version: number;
  updatedAt: string;
  updatedBy?: string;
}

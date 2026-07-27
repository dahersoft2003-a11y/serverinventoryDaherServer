export type AccountType =
  | "Asset"
  | "Liability"
  | "Equity"
  | "Revenue"
  | "Expense";

export type AccountNature = "Debit" | "Credit";

export type AccountCategory =
  | "Cash"
  | "Bank"
  | "Inventory"
  | "AccountsReceivable"
  | "AccountsPayable"
  | "FixedAssets"
  | "Revenue"
  | "CostOfGoodsSold"
  | "OperatingExpense"
  | "Equity"
  | "Other";

export interface Account {
  id: string;

  name: string;
  code: string;

  type: AccountType;
  category?: AccountCategory;

  parentId: string | null;

  nature: AccountNature;

  openingBalance: number;
  currentBalance: number;
  openingBalanceUSD?: number;
  openingBalanceSYP?: number;
  currentBalanceUSD?: number;
  currentBalanceSYP?: number;

  currency: string;
  description?: string;

  isActive: boolean;
  isSystem: boolean;
  allowTransactions: boolean;

  createdAt: string;
  updatedAt: string;

  createdBy?: string;
  updatedBy?: string;
}

export interface JournalEntryLine {
  id?: string;
  accountId: string;
  accountName?: string;
  debit: number;
  credit: number;
  currency?: "USD" | "SYP";
  exchangeRate?: number;
  amountUSD?: number;
  amountSYP?: number;
  amountOriginal?: number;
  note?: string;
}

export interface JournalEntry {
  id: string;
  date: string;
  description: string;
  referenceType?: string;
  referenceId?: string;
  createdBy?: string;
  lines: JournalEntryLine[];
}

import type { CustomerProductAccountRow, CustomerRow, CustomerTier } from './customer.model.js';

export interface CustomerWithAccounts extends CustomerRow {
  accounts: (CustomerProductAccountRow & { productName: string; productCode: string })[];
}

export interface ListCustomersFilter {
  search?: string;
  tier?: CustomerTier;
  limit: number;
  cursor?: string;
}

export type { CustomerRow, CustomerTier, CustomerProductAccountRow };

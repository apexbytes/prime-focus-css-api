import type { ProductRow } from './product.model.js';

export interface ProductAgent {
  userId: string;
  fullName: string;
  email: string;
  grantedAt: Date;
}

export interface ProductWithAgents extends ProductRow {
  agents: ProductAgent[];
}

/**
 * The set of products a request may touch. `all` is not the same as "every id":
 * an administrator keeps access to products created after their session started.
 */
export type ProductScope = { kind: 'all' } | { kind: 'limited'; productIds: string[] };

export type { ProductRow };

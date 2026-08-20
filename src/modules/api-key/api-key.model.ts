import { index, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { instant, timestamps } from '../../db/columns.js';
import { users } from '../user/user.model.js';

/**
 * Machine credentials for Prime Focus product systems that raise tickets on a
 * customer's behalf. The secret is shown once at creation and only its hash is
 * kept; `keyPrefix` is the searchable, non-secret half used to identify a key
 * in logs and in the admin list.
 *
 * Phase 3 adds `product_id` so a key is scoped to one product.
 */
export const apiKeys = pgTable(
  'api_keys',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    keyPrefix: text('key_prefix').notNull().unique(),
    keyHash: text('key_hash').notNull(),
    scopes: text('scopes').array().notNull().default([]),
    createdByUserId: uuid('created_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    lastUsedAt: instant('last_used_at'),
    expiresAt: instant('expires_at'),
    revokedAt: instant('revoked_at'),
    ...timestamps,
  },
  (table) => [index('api_keys_revoked_at_idx').on(table.revokedAt)],
);

export type ApiKeyRow = typeof apiKeys.$inferSelect;

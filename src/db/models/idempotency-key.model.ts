import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

/**
 * Infrastructure table (not owned by a business module): the replay log behind
 * the `Idempotency-Key` header. A retried create — a flaky mobile connection, an
 * upstream product system's retry policy — must not open a second ticket or send
 * a second email.
 *
 * Infra-level tables live in `src/db/models/`; every business table lives in its
 * module's `*.model.ts`.
 */
export const idempotencyKeys = pgTable(
  'idempotency_keys',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Client-supplied key, unique per scope. */
    key: text('key').notNull(),
    /** `METHOD path` — the same key on a different endpoint is a different operation. */
    scope: text('scope').notNull(),
    /** Hash of the request body, to detect a key reused with different content. */
    requestHash: text('request_hash').notNull(),
    /** Null until the original request finishes. */
    statusCode: integer('status_code'),
    responseBody: jsonb('response_body'),
    lockedAt: timestamp('locked_at', { withTimezone: true }).defaultNow().notNull(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('idempotency_keys_scope_key_uq').on(table.scope, table.key),
    index('idempotency_keys_expires_at_idx').on(table.expiresAt),
  ],
);

export type IdempotencyKeyRow = typeof idempotencyKeys.$inferSelect;
export type NewIdempotencyKey = typeof idempotencyKeys.$inferInsert;

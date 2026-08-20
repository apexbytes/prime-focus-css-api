import { index, jsonb, pgEnum, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { instant } from '../../db/columns.js';

export const actorType = pgEnum('actor_type', ['user', 'api_key', 'system']);

/**
 * Append-only record of every state change. Written inside the same transaction
 * as the change it describes, so the trail cannot disagree with the data.
 *
 * There is deliberately no update or delete path: retention is enforced by the
 * scheduled sweep, and the API exposes reads only.
 */
export const auditLogs = pgTable(
  'audit_logs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    actorType: actorType('actor_type').notNull(),
    /** Null for `system`, or when the actor was later hard-deleted. */
    actorId: uuid('actor_id'),
    /** Denormalised label so history stays readable if the actor is removed. */
    actorLabel: text('actor_label'),
    /** `entity.verb`, e.g. `user.invited`, `role.permissions_changed`. */
    action: text('action').notNull(),
    entityType: text('entity_type').notNull(),
    entityId: text('entity_id'),
    before: jsonb('before'),
    after: jsonb('after'),
    ip: text('ip'),
    userAgent: text('user_agent'),
    /** Ties the change back to the request that made it. */
    requestId: text('request_id'),
    createdAt: instant('created_at').defaultNow().notNull(),
  },
  (table) => [
    index('audit_logs_entity_idx').on(table.entityType, table.entityId, table.createdAt.desc()),
    index('audit_logs_actor_idx').on(table.actorId, table.createdAt.desc()),
    index('audit_logs_action_idx').on(table.action),
    index('audit_logs_created_at_idx').on(table.createdAt.desc()),
  ],
);

export type AuditLogRow = typeof auditLogs.$inferSelect;
export type NewAuditLog = typeof auditLogs.$inferInsert;
export type ActorType = (typeof actorType.enumValues)[number];

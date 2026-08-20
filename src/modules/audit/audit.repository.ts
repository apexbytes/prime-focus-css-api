import { and, desc, eq, gte, lt, lte } from 'drizzle-orm';
import { db } from '../../db/client.js';
import type { Executor } from '../../db/transaction.js';
import { auditLogs, type AuditLogRow, type NewAuditLog } from './audit.model.js';
import type { AuditLogFilter } from './audit.types.js';

export async function insert(entry: NewAuditLog, exec: Executor = db): Promise<void> {
  await exec.insert(auditLogs).values(entry);
}

export async function list(filter: AuditLogFilter, exec: Executor = db): Promise<AuditLogRow[]> {
  const conditions = [
    filter.entityType ? eq(auditLogs.entityType, filter.entityType) : undefined,
    filter.entityId ? eq(auditLogs.entityId, filter.entityId) : undefined,
    filter.actorId ? eq(auditLogs.actorId, filter.actorId) : undefined,
    filter.action ? eq(auditLogs.action, filter.action) : undefined,
    filter.from ? gte(auditLogs.createdAt, filter.from) : undefined,
    filter.to ? lte(auditLogs.createdAt, filter.to) : undefined,
    // Keyset pagination on the same descending order as the index.
    filter.cursor ? lt(auditLogs.createdAt, new Date(filter.cursor)) : undefined,
  ].filter((condition) => condition !== undefined);

  return exec
    .select()
    .from(auditLogs)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(auditLogs.createdAt))
    .limit(filter.limit);
}

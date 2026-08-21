import { and, desc, eq, gte, lt, lte, sql } from 'drizzle-orm';
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

// -- retention ---------------------------------------------------------------

/**
 * Deletes the oldest audit rows past their retention period.
 *
 * A subquery-limited delete rather than a plain `delete ... where created_at <
 * cutoff`: the first run on a long-lived database would otherwise be one
 * statement holding locks over millions of rows. Batched, it is a series of
 * short transactions that the sweep can stop between.
 */
export async function deleteOlderThan(
  before: Date,
  limit: number,
  exec: Executor = db,
): Promise<number> {
  const removed = await exec.execute(sql`
    delete from audit_logs
    where id in (
      select id from audit_logs
      where created_at < ${before}
      order by created_at
      limit ${limit}
    )
  `);

  return removed.rowCount ?? 0;
}

export async function countOlderThan(before: Date, exec: Executor = db): Promise<number> {
  const [row] = await exec
    .select({ count: sql<number>`count(*)::int` })
    .from(auditLogs)
    .where(lt(auditLogs.createdAt, before));

  return row?.count ?? 0;
}

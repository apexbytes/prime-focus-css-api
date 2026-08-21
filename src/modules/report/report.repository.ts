import { and, asc, eq, gte, inArray, lte, sql } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';
import { db } from '../../db/client.js';
import type { Executor } from '../../db/transaction.js';
import { kbArticles } from '../knowledge-base/knowledge-base.model.js';
import { tickets } from '../ticket/ticket.model.js';
import { users } from '../user/user.model.js';
import {
  REPORT_VIEWS,
  reportAgentDaily,
  reportCategoryDaily,
  reportCsatDaily,
  reportKbDaily,
  reportRefreshes,
  reportSlaDaily,
  reportTicketDaily,
  type ReportRefreshRow,
  type ReportViewName,
} from './report.model.js';

/** The window and product scope every report read is filtered by. */
export interface ScopedRange {
  fromDay: string;
  toDay: string;
  /** Null means unrestricted; an empty array must match nothing. */
  productIds: string[] | null;
  productId?: string | undefined;
}

/**
 * The window and scope as conditions. Takes the columns rather than the view so
 * one function covers every view that has a day and a product.
 */
function rangeConditions(range: ScopedRange, columns: { day: PgColumn; productId: PgColumn }) {
  return [
    gte(columns.day, range.fromDay),
    lte(columns.day, range.toDay),
    range.productIds === null
      ? undefined
      : range.productIds.length === 0
        ? sql`false`
        : inArray(columns.productId, range.productIds),
    range.productId ? eq(columns.productId, range.productId) : undefined,
  ].filter((condition) => condition !== undefined);
}

export function ticketDaily(range: ScopedRange, exec: Executor = db) {
  return exec
    .select()
    .from(reportTicketDaily)
    .where(and(...rangeConditions(range, reportTicketDaily)))
    .orderBy(asc(reportTicketDaily.day));
}

export function categoryDaily(range: ScopedRange, exec: Executor = db) {
  return exec
    .select()
    .from(reportCategoryDaily)
    .where(and(...rangeConditions(range, reportCategoryDaily)))
    .orderBy(asc(reportCategoryDaily.day));
}

export function slaDaily(range: ScopedRange, exec: Executor = db) {
  return exec
    .select()
    .from(reportSlaDaily)
    .where(and(...rangeConditions(range, reportSlaDaily)))
    .orderBy(asc(reportSlaDaily.day));
}

/**
 * Agent rows joined to the account, so a report is readable without a second
 * lookup per agent. Left join: an agent deleted since is still in the numbers,
 * and dropping the row would quietly change last month's totals.
 */
export function agentDaily(range: ScopedRange, userId: string | undefined, exec: Executor = db) {
  const conditions = [
    ...rangeConditions(range, reportAgentDaily),
    userId ? eq(reportAgentDaily.userId, userId) : undefined,
  ].filter((condition) => condition !== undefined);

  return exec
    .select({
      userId: reportAgentDaily.userId,
      fullName: users.fullName,
      email: users.email,
      publicReplies: reportAgentDaily.publicReplies,
      internalNotes: reportAgentDaily.internalNotes,
      resolvedCount: reportAgentDaily.resolvedCount,
      reopenedCount: reportAgentDaily.reopenedCount,
      resolutionWallMinutesAvg: reportAgentDaily.resolutionWallMinutesAvg,
      surveysSent: reportAgentDaily.surveysSent,
      surveyResponses: reportAgentDaily.surveyResponses,
      scoreTotal: reportAgentDaily.scoreTotal,
    })
    .from(reportAgentDaily)
    .leftJoin(users, eq(users.id, reportAgentDaily.userId))
    .where(and(...conditions));
}

export function csatDaily(range: ScopedRange, exec: Executor = db) {
  return exec
    .select()
    .from(reportCsatDaily)
    .where(and(...rangeConditions(range, reportCsatDaily)))
    .orderBy(asc(reportCsatDaily.day));
}

/** Knowledge base usage is not product-scoped: a view has no product column. */
export function kbDaily(range: { fromDay: string; toDay: string }, exec: Executor = db) {
  return exec
    .select()
    .from(reportKbDaily)
    .where(and(gte(reportKbDaily.day, range.fromDay), lte(reportKbDaily.day, range.toDay)))
    .orderBy(asc(reportKbDaily.day));
}

export function articleCountsByStatus(exec: Executor = db) {
  return exec
    .select({ status: kbArticles.status, count: sql<number>`count(*)::int` })
    .from(kbArticles)
    .groupBy(kbArticles.status);
}

/**
 * Backlog: how much is open *right now*.
 *
 * The one figure that cannot come from a daily view, because it is a level and
 * not a flow — yesterday's snapshot is not today's backlog. It is still not a
 * scan: `tickets_status_idx` and `tickets_assigned_status_idx` cover both counts,
 * and the alternative (a snapshot view refreshed every 15 minutes) would report a
 * queue length that is quietly a quarter of an hour out of date.
 */
export async function backlog(
  productIds: string[] | null,
  productId: string | undefined,
  exec: Executor = db,
): Promise<{ openNow: number; unassignedNow: number }> {
  const scope =
    productIds === null
      ? sql`true`
      : productIds.length === 0
        ? sql`false`
        : inArray(tickets.productId, productIds);

  const [row] = await exec
    .select({
      openNow: sql<number>`count(*)::int`,
      unassignedNow: sql<number>`count(*) filter (where ${tickets.assignedToUserId} is null)::int`,
    })
    .from(tickets)
    .where(
      and(
        sql`${tickets.deletedAt} is null`,
        inArray(tickets.status, ['new', 'open', 'pending', 'on_hold']),
        scope,
        productId ? eq(tickets.productId, productId) : undefined,
      ),
    );

  return { openNow: row?.openNow ?? 0, unassignedNow: row?.unassignedNow ?? 0 };
}

// -- refreshing --------------------------------------------------------------

/**
 * Rebuilds one view.
 *
 * `concurrently` so a dashboard reading the view during a refresh is not blocked
 * — which is the whole reason each view carries a unique index over its grouping
 * key. It cannot run inside a transaction, so this deliberately takes the pool
 * rather than an `Executor`: handing it a transaction would fail at runtime.
 */
export async function refreshView(name: ReportViewName): Promise<number> {
  // The name comes from REPORT_VIEWS, never from a caller, so interpolating it
  // is not a parameterisation gap — an identifier cannot be a bind parameter.
  if (!REPORT_VIEWS.includes(name)) throw new Error(`unknown reporting view: ${name}`);

  await db.execute(sql.raw(`refresh materialized view concurrently ${name}`));

  const counted = await db.execute(sql.raw(`select count(*)::int as count from ${name}`));
  return Number((counted.rows[0] as { count: number } | undefined)?.count ?? 0);
}

export async function recordRefresh(
  values: typeof reportRefreshes.$inferInsert,
  exec: Executor = db,
): Promise<void> {
  await exec
    .insert(reportRefreshes)
    .values(values)
    .onConflictDoUpdate({
      target: reportRefreshes.viewName,
      set: {
        refreshedAt: values.refreshedAt ?? new Date(),
        durationMs: values.durationMs,
        rowCount: values.rowCount,
        error: values.error ?? null,
      },
    });
}

export function listRefreshes(exec: Executor = db): Promise<ReportRefreshRow[]> {
  return exec.select().from(reportRefreshes).orderBy(asc(reportRefreshes.viewName));
}

import type { Actor } from '../../common/types/actor.js';
import { env } from '../../config/index.js';
import { createModuleLogger } from '../../lib/logger/index.js';
import * as auditService from '../audit/audit.service.js';
import * as categoryService from '../category/category.service.js';
import * as productService from '../product/product.service.js';
import { REPORT_VIEWS, type ReportViewName } from './report.model.js';
import { percent, ratio, resolveRange } from './report.range.js';
import * as repository from './report.repository.js';
import type { ScopedRange } from './report.repository.js';
import type {
  AgentReport,
  AgentRow,
  CsatReport,
  OverviewReport,
  ReportMeta,
  ReportRefreshRow,
  SlaCompliance,
  SlaReport,
  VolumeBucket,
  VolumeReport,
} from './report.types.js';

const log = createModuleLogger('report');

/**
 * Resolves the window and the caller's product scope in one step.
 *
 * Every report goes through here, so a report cannot be written that forgets to
 * scope itself — the same reasoning as the explicit scope argument on every
 * ticket read. `report:view` is held by tier-2 specialists, who are
 * product-scoped, so an unscoped report would be a cross-product leak dressed
 * up as a dashboard.
 */
async function scopedRange(
  input: { from?: Date | undefined; to?: Date | undefined; productId?: string | undefined },
  actor: Actor,
): Promise<{ range: ScopedRange; meta: Omit<ReportMeta, 'refreshedAt' | 'stale'> }> {
  if (input.productId) await productService.assertAccess(actor, input.productId);

  const window = resolveRange(input, env.DEFAULT_TIMEZONE);
  const scope = await productService.scopeFor(actor);

  return {
    range: {
      fromDay: window.fromDay,
      toDay: window.toDay,
      productIds: scope.kind === 'all' ? null : scope.productIds,
      productId: input.productId,
    },
    meta: { from: window.fromDay, to: window.toDay, days: window.days },
  };
}

/**
 * Stamps a report with how old it is.
 *
 * The *oldest* refresh across the views a report reads, not the newest: a report
 * is only as fresh as its stalest input, and taking the newest would hide a view
 * that has been failing for a week behind one that succeeded a minute ago.
 */
async function freshness(
  views: readonly ReportViewName[],
): Promise<{ refreshedAt: Date | null; stale: boolean }> {
  const rows = await repository.listRefreshes();
  const relevant = rows.filter((row) => views.includes(row.viewName as ReportViewName));

  if (relevant.length < views.length) {
    // A view that has never been refreshed at all is the staleest state there is.
    return { refreshedAt: null, stale: true };
  }

  const oldest = relevant.reduce((left, right) =>
    left.refreshedAt <= right.refreshedAt ? left : right,
  );

  return {
    refreshedAt: oldest.refreshedAt,
    stale: relevant.some((row) => row.error !== null),
  };
}

async function metaFor(
  base: Omit<ReportMeta, 'refreshedAt' | 'stale'>,
  views: readonly ReportViewName[],
): Promise<ReportMeta> {
  return { ...base, ...(await freshness(views)) };
}

// -- service levels ----------------------------------------------------------

/**
 * Compliance is met ÷ (met + breached) — the running targets are excluded on
 * purpose. A ticket still inside its deadline has neither succeeded nor failed,
 * and counting it as either makes this morning's figure a function of the time
 * of day rather than of how the desk is doing.
 */
function withCompliance(totals: Omit<SlaCompliance, 'compliancePercent'>): SlaCompliance {
  return {
    ...totals,
    compliancePercent: percent(ratio(totals.met, totals.met + totals.breached)),
  };
}

function accumulate(
  into: Omit<SlaCompliance, 'compliancePercent'>,
  row: { targets: number; met: number; breached: number; running: number },
): void {
  into.targets += row.targets;
  into.met += row.met;
  into.breached += row.breached;
  into.running += row.running;
}

export async function sla(
  input: { from?: Date | undefined; to?: Date | undefined; productId?: string | undefined },
  actor: Actor,
): Promise<SlaReport> {
  const { range, meta } = await scopedRange(input, actor);
  const rows = await repository.slaDaily(range);

  const firstResponse = { targets: 0, met: 0, breached: 0, running: 0 };
  const resolution = { targets: 0, met: 0, breached: 0, running: 0 };
  const byPriority = new Map<string, Omit<SlaCompliance, 'compliancePercent'>>();
  const byDay = new Map<string, Omit<SlaCompliance, 'compliancePercent'>>();

  for (const row of rows) {
    accumulate(row.kind === 'first_response' ? firstResponse : resolution, row);

    const priorityKey = `${row.priority}:${row.kind}`;
    const priorityTotals = byPriority.get(priorityKey) ?? {
      targets: 0,
      met: 0,
      breached: 0,
      running: 0,
    };
    accumulate(priorityTotals, row);
    byPriority.set(priorityKey, priorityTotals);

    const dayTotals = byDay.get(row.day) ?? { targets: 0, met: 0, breached: 0, running: 0 };
    accumulate(dayTotals, row);
    byDay.set(row.day, dayTotals);
  }

  return {
    meta: await metaFor(meta, ['report_sla_daily']),
    firstResponse: withCompliance(firstResponse),
    resolution: withCompliance(resolution),
    byPriority: [...byPriority.entries()].map(([key, totals]) => {
      const [priority, kind] = key.split(':');
      return { priority: priority ?? '', kind: kind ?? '', ...withCompliance(totals) };
    }),
    byDay: [...byDay.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([day, totals]) => ({ day, ...withCompliance(totals) })),
  };
}

// -- volume ------------------------------------------------------------------

export async function volume(
  input: { from?: Date | undefined; to?: Date | undefined; productId?: string | undefined },
  actor: Actor,
): Promise<VolumeReport> {
  const { range, meta } = await scopedRange(input, actor);
  const [rows, categoryRows] = await Promise.all([
    repository.ticketDaily(range),
    repository.categoryDaily(range),
  ]);

  let created = 0;
  let resolved = 0;
  let reopened = 0;
  const byDay = new Map<string, { created: number; resolved: number }>();
  const byChannel = new Map<string, { created: number; resolved: number }>();
  const byPriority = new Map<string, { created: number; resolved: number }>();

  for (const row of rows) {
    created += row.createdCount;
    resolved += row.resolvedCount;
    reopened += row.reopenedCount;

    bump(byDay, row.day, row);
    bump(byChannel, row.channel, row);
    bump(byPriority, row.priority, row);
  }

  const byCategory = new Map<string, { created: number; resolved: number }>();
  for (const row of categoryRows) bump(byCategory, row.categoryId, row);

  return {
    meta: await metaFor(meta, ['report_ticket_daily', 'report_category_daily']),
    created,
    resolved,
    reopened,
    byDay: [...byDay.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([day, totals]) => ({ day, ...totals })),
    byChannel: toBuckets(byChannel),
    byPriority: toBuckets(byPriority),
    byCategory: await labelCategories(byCategory),
  };
}

function bump(
  into: Map<string, { created: number; resolved: number }>,
  key: string,
  row: { createdCount: number; resolvedCount: number },
): void {
  const totals = into.get(key) ?? { created: 0, resolved: 0 };
  totals.created += row.createdCount;
  totals.resolved += row.resolvedCount;
  into.set(key, totals);
}

function toBuckets(source: Map<string, { created: number; resolved: number }>): VolumeBucket[] {
  return [...source.entries()]
    .map(([key, totals]) => ({ key, label: key, ...totals }))
    .sort((left, right) => right.created - left.created);
}

/**
 * Category buckets carry the category's name, because a UUID in a dashboard is
 * not a report. Resolved one at a time rather than by joining in the view: the
 * name is editable, and a view would have frozen whatever it was called at
 * refresh time.
 */
async function labelCategories(
  source: Map<string, { created: number; resolved: number }>,
): Promise<VolumeBucket[]> {
  const buckets: VolumeBucket[] = [];

  for (const [categoryId, totals] of source) {
    let label = categoryId;
    try {
      label = (await categoryService.findById(categoryId))?.name ?? categoryId;
    } catch {
      // A category deleted since the refresh keeps its id as the label rather
      // than dropping the tickets that were filed under it.
    }
    buckets.push({ key: categoryId, label, ...totals });
  }

  return buckets.sort((left, right) => right.created - left.created);
}

// -- agents ------------------------------------------------------------------

export async function agents(
  input: {
    from?: Date | undefined;
    to?: Date | undefined;
    productId?: string | undefined;
    userId?: string | undefined;
    limit: number;
  },
  actor: Actor,
): Promise<AgentReport> {
  const { range, meta } = await scopedRange(input, actor);
  const rows = await repository.agentDaily(range, input.userId);

  // Summed across days and products: the view's grain is per day per product,
  // and a league table is per person.
  const totals = new Map<string, AgentRow & { scoreTotal: number }>();

  for (const row of rows) {
    const existing = totals.get(row.userId) ?? {
      userId: row.userId,
      fullName: row.fullName,
      email: row.email,
      publicReplies: 0,
      internalNotes: 0,
      resolvedCount: 0,
      reopenedCount: 0,
      resolutionWallMinutesAvg: null,
      surveysSent: 0,
      surveyResponses: 0,
      averageScore: null,
      scoreTotal: 0,
    };

    existing.publicReplies += row.publicReplies;
    existing.internalNotes += row.internalNotes;
    existing.reopenedCount += row.reopenedCount;
    existing.surveysSent += row.surveysSent;
    existing.surveyResponses += row.surveyResponses;
    existing.scoreTotal += row.scoreTotal;

    // A per-day average has to be weighted by the day's volume to survive being
    // summed; a plain mean of means would let one quiet day outweigh a busy one.
    if (row.resolutionWallMinutesAvg !== null && row.resolvedCount > 0) {
      const carried = (existing.resolutionWallMinutesAvg ?? 0) * existing.resolvedCount;
      existing.resolutionWallMinutesAvg = Math.round(
        (carried + row.resolutionWallMinutesAvg * row.resolvedCount) /
          (existing.resolvedCount + row.resolvedCount),
      );
    }
    existing.resolvedCount += row.resolvedCount;

    totals.set(row.userId, existing);
  }

  const agentRows = [...totals.values()]
    .map(({ scoreTotal, ...agent }) => ({
      ...agent,
      averageScore: agent.surveyResponses === 0 ? null : scoreTotal / agent.surveyResponses,
    }))
    .sort((left, right) => right.resolvedCount - left.resolvedCount)
    .slice(0, input.limit);

  return {
    meta: await metaFor(meta, ['report_agent_daily']),
    agents: agentRows,
  };
}

// -- satisfaction ------------------------------------------------------------

export async function csat(
  input: { from?: Date | undefined; to?: Date | undefined; productId?: string | undefined },
  actor: Actor,
): Promise<CsatReport> {
  const { range, meta } = await scopedRange(input, actor);
  const rows = await repository.csatDaily(range);

  let surveysSent = 0;
  let responses = 0;
  let scoreTotal = 0;
  let satisfied = 0;
  let dissatisfied = 0;
  const byDay = new Map<string, { surveysSent: number; responses: number; scoreTotal: number }>();

  for (const row of rows) {
    surveysSent += row.surveysSent;
    responses += row.responses;
    scoreTotal += row.scoreTotal;
    satisfied += row.satisfied;
    dissatisfied += row.dissatisfied;

    const day = byDay.get(row.day) ?? { surveysSent: 0, responses: 0, scoreTotal: 0 };
    day.surveysSent += row.surveysSent;
    day.responses += row.responses;
    day.scoreTotal += row.scoreTotal;
    byDay.set(row.day, day);
  }

  return {
    meta: await metaFor(meta, ['report_csat_daily']),
    surveysSent,
    responses,
    responseRatePercent: percent(ratio(responses, surveysSent)),
    averageScore: responses === 0 ? null : scoreTotal / responses,
    satisfactionPercent: percent(ratio(satisfied, responses)),
    dissatisfiedPercent: percent(ratio(dissatisfied, responses)),
    byDay: [...byDay.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([day, totals]) => ({
        day,
        surveysSent: totals.surveysSent,
        responses: totals.responses,
        averageScore: totals.responses === 0 ? null : totals.scoreTotal / totals.responses,
      })),
  };
}

// -- overview ----------------------------------------------------------------

export async function overview(
  input: { from?: Date | undefined; to?: Date | undefined; productId?: string | undefined },
  actor: Actor,
): Promise<OverviewReport> {
  const { range, meta } = await scopedRange(input, actor);

  const [ticketRows, slaRows, csatRows, kbRows, articleCounts, backlog, refreshes] =
    await Promise.all([
      repository.ticketDaily(range),
      repository.slaDaily(range),
      repository.csatDaily(range),
      repository.kbDaily(range),
      repository.articleCountsByStatus(),
      repository.backlog(range.productIds, range.productId),
      repository.listRefreshes(),
    ]);

  const created = sumBy(ticketRows, (row) => row.createdCount);
  const firstResponse = { targets: 0, met: 0, breached: 0, running: 0 };
  const resolution = { targets: 0, met: 0, breached: 0, running: 0 };
  for (const row of slaRows) {
    accumulate(row.kind === 'first_response' ? firstResponse : resolution, row);
  }

  const responses = sumBy(csatRows, (row) => row.responses);
  const scoreTotal = sumBy(csatRows, (row) => row.scoreTotal);
  const satisfied = sumBy(csatRows, (row) => row.satisfied);

  const suggested = sumBy(
    kbRows.filter((row) => row.source === 'suggest'),
    (row) => row.views,
  );
  const opened = sumBy(
    kbRows.filter((row) => row.source === 'direct'),
    (row) => row.views,
  );

  const byStatus = new Map(articleCounts.map((row) => [row.status, row.count]));

  return {
    meta: await metaFor(meta, [
      'report_ticket_daily',
      'report_sla_daily',
      'report_csat_daily',
      'report_kb_daily',
    ]),
    tickets: {
      created,
      resolved: sumBy(ticketRows, (row) => row.resolvedCount),
      reopened: sumBy(ticketRows, (row) => row.reopenedCount),
      ...backlog,
    },
    sla: {
      firstResponsePercent: percent(
        ratio(firstResponse.met, firstResponse.met + firstResponse.breached),
      ),
      resolutionPercent: percent(ratio(resolution.met, resolution.met + resolution.breached)),
      breached: firstResponse.breached + resolution.breached,
    },
    csat: {
      responses,
      averageScore: responses === 0 ? null : scoreTotal / responses,
      satisfactionPercent: percent(ratio(satisfied, responses)),
    },
    knowledgeBase: {
      published: byStatus.get('published') ?? 0,
      draft: (byStatus.get('draft') ?? 0) + (byStatus.get('in_review') ?? 0),
      suggested,
      opened,
      // Crude on purpose, and labelled as such: without session tracking there
      // is no way to say a suggestion *prevented* a ticket. Suggestions per
      // ticket raised is the honest proxy — it moves when the knowledge base
      // starts earning its keep, and it claims nothing more than that.
      suggestionsPerTicket: created === 0 ? null : suggested / created,
    },
    refreshes,
  };
}

function sumBy<T>(rows: readonly T[], pick: (row: T) => number): number {
  return rows.reduce((total, row) => total + pick(row), 0);
}

// -- refreshing --------------------------------------------------------------

export interface RefreshResult {
  view: string;
  rows: number;
  durationMs: number;
  error?: string;
}

/**
 * Rebuilds every reporting view.
 *
 * Each one independently, and a failure is recorded rather than thrown: one
 * broken view must not stop the other five from being current, and the error is
 * written to `report_refreshes` where `/reports/*` will report it as stale
 * instead of serving a stale number as if it were fresh.
 */
export async function refreshAll(actor?: Actor): Promise<RefreshResult[]> {
  const results: RefreshResult[] = [];

  for (const view of REPORT_VIEWS) {
    const startedAt = Date.now();

    try {
      const rows = await repository.refreshView(view);
      const durationMs = Date.now() - startedAt;

      await repository.recordRefresh({
        viewName: view,
        refreshedAt: new Date(),
        durationMs,
        rowCount: rows,
        error: null,
      });

      results.push({ view, rows, durationMs });
    } catch (error) {
      const durationMs = Date.now() - startedAt;
      const message = error instanceof Error ? error.message : 'unknown error';

      await repository
        .recordRefresh({
          viewName: view,
          refreshedAt: new Date(),
          durationMs,
          rowCount: 0,
          error: message,
        })
        .catch(() => undefined);

      log.error('reporting view refresh failed', { view, err: error });
      results.push({ view, rows: 0, durationMs, error: message });
    }
  }

  if (actor) {
    await auditService.recordSafely(
      {
        action: 'report.refreshed',
        entityType: 'report',
        after: { views: results.map((result) => result.view), failed: failures(results) },
      },
      actor,
    );
  }

  return results;
}

function failures(results: readonly RefreshResult[]): string[] {
  return results.filter((result) => result.error).map((result) => result.view);
}

export function listRefreshes(): Promise<ReportRefreshRow[]> {
  return repository.listRefreshes();
}

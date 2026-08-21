import { date, integer, pgMaterializedView, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { instant } from '../../db/columns.js';
import { kbViewSource } from '../knowledge-base/knowledge-base.model.js';
import { slaTargetKind } from '../sla/sla.model.js';
import { ticketChannel, ticketPriority } from '../ticket/ticket.model.js';

/**
 * The reporting views are declared `.existing()`: their DDL lives in the
 * migration, by hand, and `drizzle-kit` is told to leave them alone.
 *
 * That is deliberate. Each one is an aggregate with `filter` clauses, full outer
 * joins and interval arithmetic that the query builder cannot express, and a
 * reviewer reading the migration should see the SQL that actually runs rather
 * than guessing what a builder chain compiled to. Declaring them here anyway
 * buys the one thing the raw SQL cannot: a typed, filterable `select` in the
 * repository, so a renamed column is a compile error.
 *
 * Two constraints the DDL carries and this file cannot:
 *
 *  - **Every view is bucketed by local calendar day in `Africa/Harare`**, baked
 *    in as a literal. Changing `DEFAULT_TIMEZONE` therefore needs a migration to
 *    match, exactly like the knowledge base's text-search configuration. The
 *    alternative — bucketing by UTC — would file two hours of every evening's
 *    tickets under the previous day.
 *  - **Every view has a unique index over its whole grouping key, all columns
 *    `not null`**, because `refresh materialized view concurrently` needs one and
 *    a nullable key column makes that refresh unreliable. That is why category
 *    and per-agent figures are their own views rather than extra nullable
 *    dimensions on one big one.
 *
 * Durations here are **wall clock**, not working time: a materialised view
 * cannot call the SLA clock. Anything that has to answer to a service level
 * comes from `report_sla_daily`, which reads the targets the clock itself wrote.
 */

/** Volume and throughput, by product, channel and priority. */
export const reportTicketDaily = pgMaterializedView('report_ticket_daily', {
  day: date('day').notNull(),
  productId: uuid('product_id').notNull(),
  channel: ticketChannel('channel').notNull(),
  priority: ticketPriority('priority').notNull(),
  createdCount: integer('created_count').notNull(),
  answeredCount: integer('answered_count').notNull(),
  resolvedCount: integer('resolved_count').notNull(),
  reopenedCount: integer('reopened_count').notNull(),
  firstResponseWallMinutesAvg: integer('first_response_wall_minutes_avg'),
  resolutionWallMinutesAvg: integer('resolution_wall_minutes_avg'),
}).existing();

/** The same volume, cut by category. Its own view so the key stays not-null. */
export const reportCategoryDaily = pgMaterializedView('report_category_daily', {
  day: date('day').notNull(),
  productId: uuid('product_id').notNull(),
  categoryId: uuid('category_id').notNull(),
  createdCount: integer('created_count').notNull(),
  resolvedCount: integer('resolved_count').notNull(),
}).existing();

/**
 * Service-level compliance, from the targets rather than from ticket
 * timestamps — so it is measured in working time, on the business-hours
 * calendar, exactly as the clock computed it.
 */
export const reportSlaDaily = pgMaterializedView('report_sla_daily', {
  day: date('day').notNull(),
  productId: uuid('product_id').notNull(),
  priority: ticketPriority('priority').notNull(),
  kind: slaTargetKind('kind').notNull(),
  targets: integer('targets').notNull(),
  met: integer('met').notNull(),
  breached: integer('breached').notNull(),
  running: integer('running').notNull(),
}).existing();

/**
 * Agent throughput: what they said, what they finished, and what the customers
 * they finished for thought of it.
 *
 * Replies are bucketed by the day of the reply and resolutions by the day of the
 * resolution — two different grains, joined on the day, which is why the DDL is
 * a full outer join rather than one `group by`.
 */
export const reportAgentDaily = pgMaterializedView('report_agent_daily', {
  day: date('day').notNull(),
  userId: uuid('user_id').notNull(),
  productId: uuid('product_id').notNull(),
  publicReplies: integer('public_replies').notNull(),
  internalNotes: integer('internal_notes').notNull(),
  resolvedCount: integer('resolved_count').notNull(),
  reopenedCount: integer('reopened_count').notNull(),
  resolutionWallMinutesAvg: integer('resolution_wall_minutes_avg'),
  surveysSent: integer('surveys_sent').notNull(),
  surveyResponses: integer('survey_responses').notNull(),
  scoreTotal: integer('score_total').notNull(),
}).existing();

/**
 * Satisfaction at product level, including surveys for tickets nobody owned —
 * which the per-agent columns above cannot carry and which still count towards
 * what customers think of the desk.
 */
export const reportCsatDaily = pgMaterializedView('report_csat_daily', {
  day: date('day').notNull(),
  productId: uuid('product_id').notNull(),
  surveysSent: integer('surveys_sent').notNull(),
  responses: integer('responses').notNull(),
  scoreTotal: integer('score_total').notNull(),
  satisfied: integer('satisfied').notNull(),
  dissatisfied: integer('dissatisfied').notNull(),
}).existing();

/**
 * Knowledge base usage by the route the reader took.
 *
 * `suggest` counts are what deflection is measured against: articles offered
 * during ticket creation, versus tickets that got raised anyway.
 */
export const reportKbDaily = pgMaterializedView('report_kb_daily', {
  day: date('day').notNull(),
  source: kbViewSource('source').notNull(),
  views: integer('views').notNull(),
  articles: integer('articles').notNull(),
}).existing();

/**
 * When each view was last rebuilt, and how long it took.
 *
 * A real table, because a dashboard has to be able to say how stale it is. A
 * reader looking at a figure that is 14 minutes old is fine; one who cannot tell
 * whether the refresh has been failing for a week is not.
 */
export const reportRefreshes = pgTable('report_refreshes', {
  viewName: text('view_name').primaryKey(),
  refreshedAt: instant('refreshed_at').defaultNow().notNull(),
  durationMs: integer('duration_ms').notNull(),
  rowCount: integer('row_count').notNull(),
  /** Null on success; the failure message otherwise, so /reports shows it. */
  error: text('error'),
});

/** Every view the refresh job rebuilds, in the order it rebuilds them. */
export const REPORT_VIEWS = [
  'report_ticket_daily',
  'report_category_daily',
  'report_sla_daily',
  'report_agent_daily',
  'report_csat_daily',
  'report_kb_daily',
] as const;

export type ReportViewName = (typeof REPORT_VIEWS)[number];
export type ReportRefreshRow = typeof reportRefreshes.$inferSelect;

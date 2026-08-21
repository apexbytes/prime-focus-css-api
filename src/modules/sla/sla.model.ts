import { sql } from 'drizzle-orm';
import {
  boolean,
  date,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { instant, timestamps } from '../../db/columns.js';
import { products } from '../product/product.model.js';
import { ticketPriority, tickets } from '../ticket/ticket.model.js';

/**
 * One working week, as the calendar's own local time.
 *
 * Held as `jsonb` rather than a child table because the SLA clock loads a whole
 * calendar into memory to do arithmetic on it — it never queries individual
 * windows — and because `PUT /business-hours/:id` replaces the week as one
 * value. A child table would buy nothing and cost a join on every target.
 *
 * `day` is 0 = Sunday through 6 = Saturday, matching `Date.getUTCDay()`. A day
 * with no window is closed; a day may have several (a lunch break splits one).
 * `closesAt` accepts `24:00` so a 24-hour calendar is expressible.
 */
export interface BusinessHoursWindow {
  day: number;
  opensAt: string;
  closesAt: string;
}

export const businessHours = pgTable('business_hours', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull().unique(),
  /** IANA zone. Every window in `weekly` is wall-clock time in this zone. */
  timezone: text('timezone').notNull().default('Africa/Harare'),
  weekly: jsonb('weekly').$type<BusinessHoursWindow[]>().notNull(),
  /** The calendar an SLA policy gets when it names none. Exactly one is true. */
  isDefault: boolean('is_default').notNull().default(false),
  ...timestamps,
});

/**
 * Non-working days, scoped to a calendar so a team working Zimbabwe hours and a
 * team working elsewhere do not have to share a holiday list.
 *
 * A `date` rather than a timestamp: a public holiday is a local calendar day,
 * and which UTC instants that covers depends on the calendar's zone.
 */
export const holidays = pgTable(
  'holidays',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessHoursId: uuid('business_hours_id')
      .notNull()
      .references(() => businessHours.id, { onDelete: 'cascade' }),
    observedOn: date('observed_on').notNull(),
    name: text('name').notNull(),
    ...timestamps,
  },
  (table) => [
    unique('holidays_calendar_date_unique').on(table.businessHoursId, table.observedOn),
    index('holidays_calendar_idx').on(table.businessHoursId, table.observedOn),
  ],
);

/**
 * What "on time" means for one product at one priority. Unique on that pair, so
 * selecting a policy for a ticket is a lookup rather than a resolution order.
 */
export const slaPolicies = pgTable(
  'sla_policies',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    productId: uuid('product_id')
      .notNull()
      .references(() => products.id, { onDelete: 'cascade' }),
    priority: ticketPriority('priority').notNull(),
    /** Minutes of working time allowed before the first reply to the customer. */
    firstResponseMinutes: integer('first_response_minutes').notNull(),
    /** Minutes of working time allowed before the ticket is resolved. */
    resolutionMinutes: integer('resolution_minutes').notNull(),
    businessHoursId: uuid('business_hours_id')
      .notNull()
      .references(() => businessHours.id, { onDelete: 'restrict' }),
    isActive: boolean('is_active').notNull().default(true),
    ...timestamps,
  },
  (table) => [
    unique('sla_policies_product_priority_unique').on(table.productId, table.priority),
    index('sla_policies_product_idx').on(table.productId),
  ],
);

export const slaTargetKind = pgEnum('sla_target_kind', ['first_response', 'resolution']);

/**
 * A deadline attached to one ticket. Written in the same transaction as the
 * ticket, because a ticket with no target is invisible to the breach scan — it
 * would look permanently on time.
 *
 * `dueAt` is absolute and always current: pausing does not store an offset to be
 * applied later, it pushes `dueAt` forward when the clock restarts. That keeps
 * the scan a single indexed comparison instead of arithmetic per row.
 */
export const ticketSlaTargets = pgTable(
  'ticket_sla_targets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ticketId: uuid('ticket_id')
      .notNull()
      .references(() => tickets.id, { onDelete: 'cascade' }),
    /** Null once the policy it came from is deleted; the deadline still stands. */
    policyId: uuid('policy_id').references(() => slaPolicies.id, { onDelete: 'set null' }),
    kind: slaTargetKind('kind').notNull(),
    /** Copied from the policy, so editing a policy never moves a live deadline. */
    targetMinutes: integer('target_minutes').notNull(),
    businessHoursId: uuid('business_hours_id').references(() => businessHours.id, {
      onDelete: 'set null',
    }),
    startedAt: instant('started_at').notNull(),
    dueAt: instant('due_at').notNull(),
    /** Non-null exactly while the clock is stopped, waiting on someone else. */
    pausedAt: instant('paused_at'),
    /** Working minutes the clock has spent paused, for reporting. */
    pausedMinutes: integer('paused_minutes').notNull().default(0),
    /** When the obligation was met: the first reply, or the resolution. */
    satisfiedAt: instant('satisfied_at'),
    breachedAt: instant('breached_at'),
    ...timestamps,
  },
  (table) => [
    unique('ticket_sla_targets_ticket_kind_unique').on(table.ticketId, table.kind),
    // The scan's only query: live targets, soonest first. Partial, because a
    // satisfied, breached or paused target is never in the scan's result set.
    // `sla.repository.dueTargets` must filter on exactly these three columns or
    // it silently stops using this index.
    index('ticket_sla_targets_due_idx')
      .on(table.dueAt)
      .where(sql`satisfied_at is null and breached_at is null and paused_at is null`),
    index('ticket_sla_targets_ticket_idx').on(table.ticketId),
  ],
);

/**
 * A breach, recorded once, kept forever. Separate from the target so compliance
 * reporting reads an append-only table rather than inferring history from
 * whatever state a mutable row happens to be in now.
 */
export const slaBreaches = pgTable(
  'sla_breaches',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ticketId: uuid('ticket_id')
      .notNull()
      .references(() => tickets.id, { onDelete: 'cascade' }),
    targetId: uuid('target_id').references(() => ticketSlaTargets.id, { onDelete: 'set null' }),
    kind: slaTargetKind('kind').notNull(),
    dueAt: instant('due_at').notNull(),
    breachedAt: instant('breached_at').notNull(),
    /** Working minutes late at the moment the breach was detected. */
    minutesOverdue: integer('minutes_overdue').notNull(),
    createdAt: instant('created_at').defaultNow().notNull(),
  },
  (table) => [
    index('sla_breaches_ticket_idx').on(table.ticketId),
    index('sla_breaches_breached_idx').on(table.breachedAt.desc()),
  ],
);

export type BusinessHoursRow = typeof businessHours.$inferSelect;
export type HolidayRow = typeof holidays.$inferSelect;
export type SlaPolicyRow = typeof slaPolicies.$inferSelect;
export type TicketSlaTargetRow = typeof ticketSlaTargets.$inferSelect;
export type SlaBreachRow = typeof slaBreaches.$inferSelect;
export type SlaTargetKind = (typeof slaTargetKind.enumValues)[number];

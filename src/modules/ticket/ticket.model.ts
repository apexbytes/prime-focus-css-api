import { sql } from 'drizzle-orm';
import {
  index,
  integer,
  jsonb,
  pgEnum,
  pgSequence,
  pgTable,
  primaryKey,
  text,
  uuid,
} from 'drizzle-orm/pg-core';
import { instant, timestamps } from '../../db/columns.js';
import { categories } from '../category/category.model.js';
import { customers } from '../customer/customer.model.js';
import { products } from '../product/product.model.js';
import { teams } from '../team/team.model.js';
import { users } from '../user/user.model.js';

/**
 * `new` until an agent touches it; `pending` means waiting on the customer,
 * which is the state that pauses the SLA clock in Phase 4. Transitions are
 * whitelisted in ticket.service, not enforced by the database.
 */
export const ticketStatus = pgEnum('ticket_status', [
  'new',
  'open',
  'pending',
  'on_hold',
  'resolved',
  'closed',
]);

export const ticketPriority = pgEnum('ticket_priority', ['low', 'normal', 'high', 'urgent']);

/**
 * How the ticket arrived, and — for the channels a customer can reply on — the
 * transport an agent's public reply goes back out over. See
 * `conversation.service.dispatchReply`.
 *
 * `chat` and `whatsapp` arrived with Phase 8, exactly as this comment predicted:
 * a new adapter and a new enum value, no schema change to `tickets`. `phone`
 * (VoIP) is still absent because there is still no adapter for it.
 *
 * `agent`, `api` and `web_form` are *origins* rather than transports: nobody is
 * waiting on the other end of them, so a reply on one of those tickets goes out
 * by email to the address on the customer record.
 */
export const ticketChannel = pgEnum('ticket_channel', [
  'email',
  'web_form',
  'api',
  'agent',
  'chat',
  'whatsapp',
]);

/**
 * Human-facing reference numbers come from a sequence rather than a count, so
 * two concurrent creates cannot collide. Global rather than per-year: a
 * reference stays unique for the lifetime of the system.
 */
export const ticketReferenceSeq = pgSequence('ticket_reference_seq', {
  startWith: 1,
  increment: 1,
});

export const tickets = pgTable(
  'tickets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** e.g. PF-2026-000123. Quoted by customers, so it never changes. */
    reference: text('reference').notNull().unique(),
    customerId: uuid('customer_id')
      .notNull()
      .references(() => customers.id, { onDelete: 'restrict' }),
    productId: uuid('product_id')
      .notNull()
      .references(() => products.id, { onDelete: 'restrict' }),
    categoryId: uuid('category_id').references(() => categories.id, { onDelete: 'set null' }),
    subject: text('subject').notNull(),
    status: ticketStatus('status').notNull().default('new'),
    priority: ticketPriority('priority').notNull().default('normal'),
    channel: ticketChannel('channel').notNull(),
    assignedToUserId: uuid('assigned_to_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    teamId: uuid('team_id').references(() => teams.id, { onDelete: 'set null' }),
    /** Set once, on the first public agent reply; the FRT metric depends on it. */
    firstResponseAt: instant('first_response_at'),
    resolvedAt: instant('resolved_at'),
    closedAt: instant('closed_at'),
    reopenedCount: integer('reopened_count').notNull().default(0),
    lastCustomerReplyAt: instant('last_customer_reply_at'),
    lastAgentReplyAt: instant('last_agent_reply_at'),
    /** Channel-specific provenance: inbound message id, web form fields, API caller. */
    sourceMetadata: jsonb('source_metadata'),
    /** Set when an agent or a product system raised the ticket, not the customer. */
    createdByUserId: uuid('created_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    deletedAt: instant('deleted_at'),
    /**
     * Set when the retention sweep has stripped this ticket's content.
     *
     * The marker exists because the sweep's own criterion — resolved longer ago
     * than the retention period — stays true forever, so without it every run
     * would re-process every old ticket and the batch limit would never make
     * progress past the oldest few hundred.
     */
    anonymisedAt: instant('anonymised_at'),
    ...timestamps,
  },
  (table) => [
    // The agent console's default view: my product's open work, newest first.
    index('tickets_product_status_created_idx').on(
      table.productId,
      table.status,
      table.createdAt.desc(),
    ),
    index('tickets_assigned_status_idx').on(table.assignedToUserId, table.status),
    index('tickets_customer_idx').on(table.customerId, table.createdAt.desc()),
    index('tickets_status_idx').on(table.status),
    index('tickets_team_idx').on(table.teamId),
    // The retention sweep's only query: what finished long ago and still has
    // its content. Partial, so it stays small however large the table gets.
    index('tickets_retention_idx')
      .on(table.resolvedAt)
      .where(sql`anonymised_at is null and resolved_at is not null`),
  ],
);

/** Every reassignment, so "who had this and when" is answerable. */
export const ticketAssignments = pgTable(
  'ticket_assignments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ticketId: uuid('ticket_id')
      .notNull()
      .references(() => tickets.id, { onDelete: 'cascade' }),
    fromUserId: uuid('from_user_id').references(() => users.id, { onDelete: 'set null' }),
    toUserId: uuid('to_user_id').references(() => users.id, { onDelete: 'set null' }),
    assignedByUserId: uuid('assigned_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    reason: text('reason'),
    createdAt: instant('created_at').defaultNow().notNull(),
  },
  (table) => [index('ticket_assignments_ticket_idx').on(table.ticketId, table.createdAt.desc())],
);

/** Agents who want updates on a ticket they do not own. */
export const ticketWatchers = pgTable(
  'ticket_watchers',
  {
    ticketId: uuid('ticket_id')
      .notNull()
      .references(() => tickets.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: instant('created_at').defaultNow().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.ticketId, table.userId] }),
    index('ticket_watchers_user_idx').on(table.userId),
  ],
);

export type TicketRow = typeof tickets.$inferSelect;
export type NewTicket = typeof tickets.$inferInsert;
export type TicketStatus = (typeof ticketStatus.enumValues)[number];
export type TicketPriority = (typeof ticketPriority.enumValues)[number];
export type TicketChannel = (typeof ticketChannel.enumValues)[number];

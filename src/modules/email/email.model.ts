import { index, jsonb, pgEnum, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { instant, timestamps } from '../../db/columns.js';
import { ticketMessages } from '../message/message.model.js';
import { tickets } from '../ticket/ticket.model.js';

/**
 * `received` rows are the durable queue for inbound mail: the webhook persists
 * metadata and answers 200 immediately, and processing happens after. If the
 * process dies mid-parse the row survives, so nothing is lost — Phase 4 turns
 * the retry into a scheduled job instead of a fire-and-forget call.
 */
export const inboundEmailStatus = pgEnum('inbound_email_status', [
  'received',
  'processed',
  'ignored',
  'failed',
]);

export const inboundEmails = pgTable(
  'inbound_emails',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Resend's id for the received email; the idempotency key for redelivery. */
    providerEmailId: text('provider_email_id').notNull().unique(),
    /** RFC 5322 Message-ID, used for threading. */
    messageId: text('message_id'),
    fromAddress: text('from_address').notNull(),
    toAddresses: text('to_addresses').array().notNull().default([]),
    subject: text('subject'),
    status: inboundEmailStatus('status').notNull().default('received'),
    /** Populated once the email is filed onto a ticket. */
    ticketId: uuid('ticket_id').references(() => tickets.id, { onDelete: 'set null' }),
    ticketMessageId: uuid('ticket_message_id').references(() => ticketMessages.id, {
      onDelete: 'set null',
    }),
    /** Why it was ignored or could not be filed. */
    error: text('error'),
    /** The webhook envelope as received, for replay and debugging. */
    payload: jsonb('payload'),
    attempts: text('attempts'),
    receivedAt: instant('received_at').defaultNow().notNull(),
    processedAt: instant('processed_at'),
    ...timestamps,
  },
  (table) => [
    index('inbound_emails_status_idx').on(table.status, table.receivedAt),
    index('inbound_emails_message_id_idx').on(table.messageId),
  ],
);

export const outboundEmailStatus = pgEnum('outbound_email_status', ['sent', 'failed']);

/** What was sent to whom, so a thread can be reconstructed and bounces attributed. */
export const outboundEmails = pgTable(
  'outbound_emails',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ticketId: uuid('ticket_id').references(() => tickets.id, { onDelete: 'set null' }),
    ticketMessageId: uuid('ticket_message_id').references(() => ticketMessages.id, {
      onDelete: 'set null',
    }),
    toAddress: text('to_address').notNull(),
    subject: text('subject').notNull(),
    kind: text('kind').notNull(),
    providerMessageId: text('provider_message_id'),
    status: outboundEmailStatus('status').notNull(),
    error: text('error'),
    ...timestamps,
  },
  (table) => [
    index('outbound_emails_ticket_idx').on(table.ticketId),
    index('outbound_emails_provider_idx').on(table.providerMessageId),
  ],
);

/** Delivery, bounce and complaint events from the provider. */
export const emailEvents = pgTable(
  'email_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    providerMessageId: text('provider_message_id'),
    event: text('event').notNull(),
    payload: jsonb('payload'),
    occurredAt: instant('occurred_at').notNull(),
    createdAt: instant('created_at').defaultNow().notNull(),
  },
  (table) => [index('email_events_provider_idx').on(table.providerMessageId, table.occurredAt)],
);

export type InboundEmailRow = typeof inboundEmails.$inferSelect;
export type OutboundEmailRow = typeof outboundEmails.$inferSelect;

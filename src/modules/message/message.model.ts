import { boolean, index, pgEnum, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { instant, timestamps } from '../../db/columns.js';
import { customers } from '../customer/customer.model.js';
import { tickets } from '../ticket/ticket.model.js';
import { users } from '../user/user.model.js';

export const messageAuthorType = pgEnum('message_author_type', ['customer', 'agent', 'system']);

/**
 * `internal` notes are invisible to the customer and are never included in an
 * outbound reply. The distinction is enforced in the service layer and asserted
 * by tests, because leaking an internal note to a customer is the single worst
 * failure this module can have.
 */
export const messageVisibility = pgEnum('message_visibility', ['public', 'internal']);

export const ticketMessages = pgTable(
  'ticket_messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ticketId: uuid('ticket_id')
      .notNull()
      .references(() => tickets.id, { onDelete: 'cascade' }),
    authorType: messageAuthorType('author_type').notNull(),
    /** Exactly one of these is set, depending on authorType. */
    authorUserId: uuid('author_user_id').references(() => users.id, { onDelete: 'set null' }),
    authorCustomerId: uuid('author_customer_id').references(() => customers.id, {
      onDelete: 'set null',
    }),
    visibility: messageVisibility('visibility').notNull().default('public'),
    body: text('body').notNull(),
    bodyHtml: text('body_html'),
    /**
     * RFC 5322 Message-ID of the email this message came from or was sent as.
     * The anchor for threading a customer's reply back onto its ticket.
     */
    externalMessageId: text('external_message_id').unique(),
    /** In-Reply-To of an inbound email, used to find the parent ticket. */
    inReplyTo: text('in_reply_to'),
    /** True for the message that set the ticket's firstResponseAt. */
    isFirstResponse: boolean('is_first_response').notNull().default(false),
    editedAt: instant('edited_at'),
    ...timestamps,
  },
  (table) => [
    index('ticket_messages_ticket_created_idx').on(table.ticketId, table.createdAt),
    index('ticket_messages_in_reply_to_idx').on(table.inReplyTo),
  ],
);

export type TicketMessageRow = typeof ticketMessages.$inferSelect;
export type NewTicketMessage = typeof ticketMessages.$inferInsert;
export type MessageVisibility = (typeof messageVisibility.enumValues)[number];
export type MessageAuthorType = (typeof messageAuthorType.enumValues)[number];

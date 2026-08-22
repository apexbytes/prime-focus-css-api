import { index, jsonb, pgEnum, pgTable, text, unique, uuid } from 'drizzle-orm/pg-core';
import { instant, timestamps } from '../../db/columns.js';
import { customers } from '../customer/customer.model.js';
import { ticketMessages } from '../message/message.model.js';
import { products } from '../product/product.model.js';
import { ticketChannel, tickets } from '../ticket/ticket.model.js';

/**
 * How a customer is known on one channel.
 *
 * A phone number on WhatsApp, a browser session id in the chat widget, an
 * address on email. It lives here rather than on `customers` for the same
 * reason `sso_identities` lives in `sso` rather than on `users`: it is a fact
 * about a relationship with an outside system, it arrives and is revoked on
 * that system's schedule, and there is more than one of them per person.
 *
 * Unique on `(channel, identifier)`, which is the whole point: it is what makes
 * the second message from a number reach the same customer record as the first,
 * and what stops two numbers quietly becoming the same person.
 */
export const customerChannelIdentities = pgTable(
  'customer_channel_identities',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    customerId: uuid('customer_id')
      .notNull()
      .references(() => customers.id, { onDelete: 'cascade' }),
    /**
     * The same enum the ticket carries, deliberately. A second list of channel
     * names would have to agree with the first one and eventually would not —
     * the argument `event.types.ts` makes about event names. The values that
     * carry no identity (`agent`, `api`) are simply never inserted.
     */
    channel: ticketChannel('channel').notNull(),
    /** E.164 without `+` for WhatsApp; the session's visitor id for chat. */
    identifier: text('identifier').notNull(),
    /** What the channel calls them — a WhatsApp profile name, say. */
    displayName: text('display_name'),
    lastSeenAt: instant('last_seen_at'),
    ...timestamps,
  },
  (table) => [
    unique('customer_channel_identities_unique').on(table.channel, table.identifier),
    index('customer_channel_identities_customer_idx').on(table.customerId),
  ],
);

export const conversationStatus = pgEnum('conversation_status', ['open', 'closed']);

/**
 * A continuous exchange with one customer on one channel.
 *
 * Long-lived rather than per-ticket, because that is what the channels
 * themselves are: a WhatsApp thread with a number is the same thread forever,
 * and the customer sees one scrollback whatever the desk has opened and closed
 * behind it. So the row is keyed on `(channel, external_id)` and `ticket_id`
 * points at whichever ticket is currently receiving its messages — which is
 * null between a ticket closing and the customer writing again.
 *
 * The alternative, one conversation per ticket, would make "which conversation
 * does this message belong to" a most-recent-open query with a race in it, and
 * would have nowhere to keep the service window, which belongs to the thread
 * and not to any ticket in it.
 */
export const channelConversations = pgTable(
  'channel_conversations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    channel: ticketChannel('channel').notNull(),
    /**
     * The channel's own key for the thread: the customer's phone number on
     * WhatsApp, the chat session's conversation id in the widget.
     */
    externalId: text('external_id').notNull(),
    productId: uuid('product_id')
      .notNull()
      .references(() => products.id, { onDelete: 'restrict' }),
    customerId: uuid('customer_id')
      .notNull()
      .references(() => customers.id, { onDelete: 'restrict' }),
    /** The ticket messages are currently filed onto; null between tickets. */
    ticketId: uuid('ticket_id').references(() => tickets.id, { onDelete: 'set null' }),
    status: conversationStatus('status').notNull().default('open'),
    lastInboundAt: instant('last_inbound_at'),
    lastOutboundAt: instant('last_outbound_at'),
    /**
     * When the provider stops accepting a free-form reply on this thread.
     *
     * WhatsApp's 24-hour customer-service window, stored rather than computed
     * from `last_inbound_at` so the rule can differ per channel — live chat has
     * no such window, and a future channel will have its own — and so the desk
     * can be shown one date instead of doing the arithmetic in three places.
     */
    windowExpiresAt: instant('window_expires_at'),
    /** Channel-specific provenance: display name, widget page, locale. */
    metadata: jsonb('metadata'),
    ...timestamps,
  },
  (table) => [
    unique('channel_conversations_external_unique').on(table.channel, table.externalId),
    index('channel_conversations_ticket_idx').on(table.ticketId),
    index('channel_conversations_customer_idx').on(table.customerId),
    // The desk's "what is live right now" view.
    index('channel_conversations_status_idx').on(table.status, table.lastInboundAt.desc()),
  ],
);

/**
 * `received` rows are the durable queue for inbound channel messages, and the
 * reasoning is the one `inbound_emails` records: the webhook persists what it
 * was told and answers 200 straight away, because a provider that gets a 5xx
 * retries and a slow handler times out. Unlike the email path, filing is a
 * queued job from the start — the retry-across-restart that Phase 3 deferred is
 * free here, because there is no verified inline behaviour to re-prove.
 */
export const inboundChannelMessageStatus = pgEnum('inbound_channel_message_status', [
  'received',
  'processed',
  'ignored',
  'failed',
]);

export const inboundChannelMessages = pgTable(
  'inbound_channel_messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    channel: ticketChannel('channel').notNull(),
    /**
     * The provider's id for this message (`wamid.…` on WhatsApp). Unique, and
     * that constraint is the deduplication: Meta redelivers a webhook it did
     * not get a clean 200 for, and a redelivery must not become a second
     * message in the thread.
     */
    providerMessageId: text('provider_message_id').notNull().unique(),
    /** The thread key, before it has been resolved to a conversation row. */
    conversationExternalId: text('conversation_external_id').notNull(),
    /** Who sent it, in the channel's own terms. */
    fromIdentifier: text('from_identifier').notNull(),
    displayName: text('display_name'),
    body: text('body'),
    /**
     * The normalised descriptor of a file that came with the message: its
     * provider **id**, mime type and digest — never a URL, because a provider's
     * download URL lives minutes and the id lives days, so this is what makes a
     * retry tomorrow work. Its own column rather than being re-parsed out of
     * `payload` on every retry, which would put the same parsing in two places.
     */
    media: jsonb('media'),
    status: inboundChannelMessageStatus('status').notNull().default('received'),
    conversationId: uuid('conversation_id').references(() => channelConversations.id, {
      onDelete: 'set null',
    }),
    ticketId: uuid('ticket_id').references(() => tickets.id, { onDelete: 'set null' }),
    ticketMessageId: uuid('ticket_message_id').references(() => ticketMessages.id, {
      onDelete: 'set null',
    }),
    /** Why it was ignored or could not be filed. */
    error: text('error'),
    /** The webhook envelope as received, for replay and debugging. */
    payload: jsonb('payload'),
    receivedAt: instant('received_at').defaultNow().notNull(),
    processedAt: instant('processed_at'),
    ...timestamps,
  },
  (table) => [
    // The reprocess endpoint's and the operator view's only query.
    index('inbound_channel_messages_status_idx').on(table.status, table.receivedAt),
    index('inbound_channel_messages_conversation_idx').on(table.conversationId),
  ],
);

export const outboundChannelMessageStatus = pgEnum('outbound_channel_message_status', [
  'sent',
  'failed',
]);

/**
 * What left over a channel, so a thread can be reconstructed from this side and
 * a refusal can be attributed.
 *
 * A failed row matters more here than it does for email: a WhatsApp reply
 * refused for being outside the service window looks, to the agent, exactly
 * like a reply that was delivered — the message is in the ticket either way.
 * This is the record that says it never arrived.
 */
export const outboundChannelMessages = pgTable(
  'outbound_channel_messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    channel: ticketChannel('channel').notNull(),
    conversationId: uuid('conversation_id').references(() => channelConversations.id, {
      onDelete: 'set null',
    }),
    ticketId: uuid('ticket_id').references(() => tickets.id, { onDelete: 'set null' }),
    ticketMessageId: uuid('ticket_message_id').references(() => ticketMessages.id, {
      onDelete: 'set null',
    }),
    toIdentifier: text('to_identifier').notNull(),
    body: text('body').notNull(),
    kind: text('kind').notNull(),
    providerMessageId: text('provider_message_id'),
    status: outboundChannelMessageStatus('status').notNull(),
    error: text('error'),
    ...timestamps,
  },
  (table) => [
    index('outbound_channel_messages_ticket_idx').on(table.ticketId),
    index('outbound_channel_messages_provider_idx').on(table.providerMessageId),
  ],
);

export type CustomerChannelIdentityRow = typeof customerChannelIdentities.$inferSelect;
export type ChannelConversationRow = typeof channelConversations.$inferSelect;
export type InboundChannelMessageRow = typeof inboundChannelMessages.$inferSelect;
export type OutboundChannelMessageRow = typeof outboundChannelMessages.$inferSelect;
export type ConversationStatus = (typeof conversationStatus.enumValues)[number];

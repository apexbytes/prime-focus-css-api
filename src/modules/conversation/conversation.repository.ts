import { and, asc, desc, eq, inArray, isNull, lt, sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import type { Executor } from '../../db/transaction.js';
import { customers } from '../customer/customer.model.js';
import { tickets } from '../ticket/ticket.model.js';
import {
  channelConversations,
  customerChannelIdentities,
  inboundChannelMessages,
  outboundChannelMessages,
  type ChannelConversationRow,
  type CustomerChannelIdentityRow,
  type InboundChannelMessageRow,
  type OutboundChannelMessageRow,
} from './conversation.model.js';
import type { ConversationView, ListConversationsFilter } from './conversation.types.js';

// -- channel identities -------------------------------------------------------

export async function findIdentity(
  channel: string,
  identifier: string,
  exec: Executor = db,
): Promise<CustomerChannelIdentityRow | undefined> {
  const [row] = await exec
    .select()
    .from(customerChannelIdentities)
    .where(
      and(
        eq(customerChannelIdentities.channel, channel as 'whatsapp'),
        eq(customerChannelIdentities.identifier, identifier),
      ),
    )
    .limit(1);

  return row;
}

/**
 * Records an identity, or returns the one already there.
 *
 * `onConflictDoUpdate` rather than insert-or-select: two messages from the same
 * new number arriving together would otherwise race, and the loser would get a
 * unique-violation instead of the row somebody else had just written. The
 * update also keeps `last_seen_at` and the display name current, which is the
 * only place a WhatsApp profile rename ever surfaces.
 */
export async function upsertIdentity(
  values: typeof customerChannelIdentities.$inferInsert,
  exec: Executor = db,
): Promise<CustomerChannelIdentityRow> {
  const [row] = await exec
    .insert(customerChannelIdentities)
    .values(values)
    .onConflictDoUpdate({
      target: [customerChannelIdentities.channel, customerChannelIdentities.identifier],
      set: {
        lastSeenAt: values.lastSeenAt ?? new Date(),
        // A name is only overwritten by another name: a channel that stops
        // sending one must not blank what an agent already saw.
        ...(values.displayName ? { displayName: values.displayName } : {}),
      },
    })
    .returning();

  if (!row) throw new Error('channel identity upsert returned no row');
  return row;
}

export function identitiesForCustomer(
  customerId: string,
  exec: Executor = db,
): Promise<CustomerChannelIdentityRow[]> {
  return exec
    .select()
    .from(customerChannelIdentities)
    .where(eq(customerChannelIdentities.customerId, customerId))
    .orderBy(asc(customerChannelIdentities.createdAt));
}

/** Moves a merged duplicate's channel identities onto the survivor. */
export async function reassignIdentities(
  fromCustomerId: string,
  toCustomerId: string,
  exec: Executor = db,
): Promise<number> {
  const moved = await exec
    .update(customerChannelIdentities)
    .set({ customerId: toCustomerId })
    .where(eq(customerChannelIdentities.customerId, fromCustomerId))
    .returning({ id: customerChannelIdentities.id });

  return moved.length;
}

// -- conversations ------------------------------------------------------------

export async function findConversation(
  channel: string,
  externalId: string,
  exec: Executor = db,
): Promise<ChannelConversationRow | undefined> {
  const [row] = await exec
    .select()
    .from(channelConversations)
    .where(
      and(
        eq(channelConversations.channel, channel as 'whatsapp'),
        eq(channelConversations.externalId, externalId),
      ),
    )
    .limit(1);

  return row;
}

export async function findConversationById(
  id: string,
  exec: Executor = db,
): Promise<ChannelConversationRow | undefined> {
  const [row] = await exec
    .select()
    .from(channelConversations)
    .where(eq(channelConversations.id, id))
    .limit(1);

  return row;
}

export async function findConversationForTicket(
  ticketId: string,
  exec: Executor = db,
): Promise<ChannelConversationRow | undefined> {
  const [row] = await exec
    .select()
    .from(channelConversations)
    .where(eq(channelConversations.ticketId, ticketId))
    .limit(1);

  return row;
}

export async function insertConversation(
  values: typeof channelConversations.$inferInsert,
  exec: Executor = db,
): Promise<ChannelConversationRow> {
  const [row] = await exec
    .insert(channelConversations)
    .values(values)
    .onConflictDoUpdate({
      target: [channelConversations.channel, channelConversations.externalId],
      // A concurrent first message must resolve to one row, not fail. Touching
      // `updated_at` is enough to get the existing row returned.
      set: { updatedAt: new Date() },
    })
    .returning();

  if (!row) throw new Error('conversation upsert returned no row');
  return row;
}

export async function updateConversation(
  id: string,
  patch: Partial<typeof channelConversations.$inferInsert>,
  exec: Executor = db,
): Promise<void> {
  await exec.update(channelConversations).set(patch).where(eq(channelConversations.id, id));
}

/**
 * The desk's list of live threads.
 *
 * Joined to the ticket and the customer because a conversation with neither
 * name on it is a row of identifiers nobody can act on, and the alternative is
 * one query per row.
 */
export async function listConversations(
  filter: ListConversationsFilter,
  productIds: string[] | null,
  exec: Executor = db,
): Promise<ConversationView[]> {
  const conditions = [
    ...(filter.channel ? [eq(channelConversations.channel, filter.channel)] : []),
    ...(filter.status ? [eq(channelConversations.status, filter.status)] : []),
    ...(filter.productId ? [eq(channelConversations.productId, filter.productId)] : []),
    // An empty scope matches nothing, which is what an agent with no product
    // grants should see.
    ...(productIds
      ? [inArray(channelConversations.productId, productIds.length ? productIds : [''])]
      : []),
    ...(filter.cursor ? [lt(channelConversations.createdAt, new Date(filter.cursor))] : []),
  ];

  const rows = await exec
    .select({
      id: channelConversations.id,
      channel: channelConversations.channel,
      externalId: channelConversations.externalId,
      status: channelConversations.status,
      productId: channelConversations.productId,
      customerId: channelConversations.customerId,
      customerName: customers.fullName,
      ticketId: channelConversations.ticketId,
      ticketReference: tickets.reference,
      lastInboundAt: channelConversations.lastInboundAt,
      lastOutboundAt: channelConversations.lastOutboundAt,
      windowExpiresAt: channelConversations.windowExpiresAt,
      createdAt: channelConversations.createdAt,
    })
    .from(channelConversations)
    .innerJoin(customers, eq(customers.id, channelConversations.customerId))
    .leftJoin(tickets, eq(tickets.id, channelConversations.ticketId))
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(channelConversations.createdAt))
    .limit(filter.limit);

  return rows;
}

/**
 * Closes threads nobody has written on for a while.
 *
 * Not deletion: the row carries the identity mapping a returning customer is
 * matched by, and throwing it away would make somebody who writes back next
 * month a stranger. `closed` only means the next message opens a new ticket.
 */
export async function closeIdleConversations(
  idleBefore: Date,
  exec: Executor = db,
): Promise<number> {
  const closed = await exec
    .update(channelConversations)
    .set({ status: 'closed', ticketId: null })
    .where(
      and(
        eq(channelConversations.status, 'open'),
        lt(channelConversations.lastInboundAt, idleBefore),
      ),
    )
    .returning({ id: channelConversations.id });

  return closed.length;
}

/**
 * Deletes chat threads that never became a ticket, and reports whose they were.
 *
 * A visitor who opens the widget and closes the tab without typing leaves a
 * conversation, an identity and a customer behind. The session token itself is
 * swept by the retention job, but those three rows would otherwise sit there
 * until the five-year dormant-customer pass noticed them, which on a busy site
 * is years of accumulating debris with nothing in it.
 *
 * Only `chat`, and only with no ticket: a WhatsApp thread's identity is how a
 * returning customer is recognised and must outlive any single conversation,
 * whereas a chat thread's external id is one session's and is never seen again.
 * `before` is expected to be well past the session TTL, so nothing still
 * reachable by a live token is touched.
 *
 * Returns the customer ids so the caller can offer them to the customer module,
 * which owns the decision about whether each one is now an orphan.
 */
export async function deleteAbandonedChatConversations(
  before: Date,
  limit: number,
  exec: Executor = db,
): Promise<string[]> {
  const removed = await exec
    .delete(channelConversations)
    .where(
      and(
        eq(channelConversations.channel, 'chat'),
        isNull(channelConversations.ticketId),
        lt(channelConversations.createdAt, before),
        // The batch limit has to be applied by id: `delete … limit` is not
        // Postgres, so the bound is expressed as a subquery the way the audit
        // and SSO sweeps express theirs.
        inArray(
          channelConversations.id,
          db
            .select({ id: channelConversations.id })
            .from(channelConversations)
            .where(
              and(
                eq(channelConversations.channel, 'chat'),
                isNull(channelConversations.ticketId),
                lt(channelConversations.createdAt, before),
              ),
            )
            .orderBy(asc(channelConversations.createdAt))
            .limit(limit),
        ),
      ),
    )
    .returning({ customerId: channelConversations.customerId });

  return removed.map((row) => row.customerId);
}

// -- inbound ------------------------------------------------------------------

export async function insertInbound(
  values: typeof inboundChannelMessages.$inferInsert,
  exec: Executor = db,
): Promise<InboundChannelMessageRow | undefined> {
  // The unique provider id plus `onConflictDoNothing` is what makes a webhook
  // redelivery a no-op instead of a second message in the customer's thread.
  const [row] = await exec
    .insert(inboundChannelMessages)
    .values(values)
    .onConflictDoNothing({ target: inboundChannelMessages.providerMessageId })
    .returning();

  return row;
}

export async function findInboundById(
  id: string,
  exec: Executor = db,
): Promise<InboundChannelMessageRow | undefined> {
  const [row] = await exec
    .select()
    .from(inboundChannelMessages)
    .where(eq(inboundChannelMessages.id, id))
    .limit(1);

  return row;
}

export async function findInboundByProviderId(
  providerMessageId: string,
  exec: Executor = db,
): Promise<InboundChannelMessageRow | undefined> {
  const [row] = await exec
    .select()
    .from(inboundChannelMessages)
    .where(eq(inboundChannelMessages.providerMessageId, providerMessageId))
    .limit(1);

  return row;
}

export async function updateInbound(
  id: string,
  patch: Partial<typeof inboundChannelMessages.$inferInsert>,
  exec: Executor = db,
): Promise<void> {
  await exec.update(inboundChannelMessages).set(patch).where(eq(inboundChannelMessages.id, id));
}

export function listUnprocessed(
  limit: number,
  exec: Executor = db,
): Promise<InboundChannelMessageRow[]> {
  return exec
    .select()
    .from(inboundChannelMessages)
    .where(inArray(inboundChannelMessages.status, ['received', 'failed']))
    .orderBy(asc(inboundChannelMessages.receivedAt))
    .limit(limit);
}

// -- outbound -----------------------------------------------------------------

export async function insertOutbound(
  values: typeof outboundChannelMessages.$inferInsert,
  exec: Executor = db,
): Promise<OutboundChannelMessageRow> {
  const [row] = await exec.insert(outboundChannelMessages).values(values).returning();
  if (!row) throw new Error('outbound channel message insert returned no row');
  return row;
}

export function listOutboundForTicket(
  ticketId: string,
  exec: Executor = db,
): Promise<OutboundChannelMessageRow[]> {
  return exec
    .select()
    .from(outboundChannelMessages)
    .where(eq(outboundChannelMessages.ticketId, ticketId))
    .orderBy(asc(outboundChannelMessages.createdAt));
}

/**
 * Operational debris, swept on the same schedule as the webhook delivery log.
 * Neither the inbound envelopes nor the outbound records are business records —
 * the ticket thread is — so both go when they age out.
 */
export async function purgeChannelLogs(before: Date, exec: Executor = db): Promise<number> {
  // Only settled inbound rows: a `received` or `failed` one is still work the
  // reprocess endpoint can pick up, and deleting it would silently lose a
  // customer's message rather than a log line.
  const inbound = await exec.execute(sql`
    delete from inbound_channel_messages
    where created_at < ${before} and status in ('processed', 'ignored')
  `);

  const outbound = await exec.execute(sql`
    delete from outbound_channel_messages where created_at < ${before}
  `);

  return (inbound.rowCount ?? 0) + (outbound.rowCount ?? 0);
}

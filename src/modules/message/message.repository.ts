import { and, asc, eq, gt, inArray } from 'drizzle-orm';
import { db } from '../../db/client.js';
import type { Executor } from '../../db/transaction.js';
import { customers } from '../customer/customer.model.js';
import { users } from '../user/user.model.js';
import { ticketMessages, type NewTicketMessage, type TicketMessageRow } from './message.model.js';

const columns = {
  id: ticketMessages.id,
  ticketId: ticketMessages.ticketId,
  authorType: ticketMessages.authorType,
  authorUserId: ticketMessages.authorUserId,
  authorCustomerId: ticketMessages.authorCustomerId,
  visibility: ticketMessages.visibility,
  body: ticketMessages.body,
  bodyHtml: ticketMessages.bodyHtml,
  externalMessageId: ticketMessages.externalMessageId,
  isFirstResponse: ticketMessages.isFirstResponse,
  editedAt: ticketMessages.editedAt,
  createdAt: ticketMessages.createdAt,
  authorUserName: users.fullName,
  authorCustomerName: customers.fullName,
};

export function listForTicket(
  ticketId: string,
  options: { includeInternal: boolean; cursor?: string; limit: number },
  exec: Executor = db,
) {
  const conditions = [
    eq(ticketMessages.ticketId, ticketId),
    options.includeInternal ? undefined : eq(ticketMessages.visibility, 'public'),
    options.cursor ? gt(ticketMessages.createdAt, new Date(options.cursor)) : undefined,
  ].filter((condition) => condition !== undefined);

  return (
    exec
      .select(columns)
      .from(ticketMessages)
      .leftJoin(users, eq(users.id, ticketMessages.authorUserId))
      .leftJoin(customers, eq(customers.id, ticketMessages.authorCustomerId))
      .where(and(...conditions))
      // Ascending: a thread reads oldest first.
      .orderBy(asc(ticketMessages.createdAt))
      .limit(options.limit)
  );
}

export async function findById(id: string, exec: Executor = db) {
  const [row] = await exec
    .select(columns)
    .from(ticketMessages)
    .leftJoin(users, eq(users.id, ticketMessages.authorUserId))
    .leftJoin(customers, eq(customers.id, ticketMessages.authorCustomerId))
    .where(eq(ticketMessages.id, id))
    .limit(1);

  return row;
}

export async function insert(
  values: NewTicketMessage,
  exec: Executor = db,
): Promise<TicketMessageRow> {
  const [row] = await exec.insert(ticketMessages).values(values).returning();
  if (!row) throw new Error('message insert returned no row');
  return row;
}

/**
 * Finds the ticket a reply belongs to by the Message-ID it references. This is
 * the primary threading mechanism; the subject-line reference is the fallback.
 */
export async function findTicketIdByExternalMessageId(
  externalMessageId: string,
  exec: Executor = db,
): Promise<string | undefined> {
  const [row] = await exec
    .select({ ticketId: ticketMessages.ticketId })
    .from(ticketMessages)
    .where(eq(ticketMessages.externalMessageId, externalMessageId))
    .limit(1);

  return row?.ticketId;
}

export async function existsWithExternalMessageId(
  externalMessageId: string,
  exec: Executor = db,
): Promise<boolean> {
  const [row] = await exec
    .select({ id: ticketMessages.id })
    .from(ticketMessages)
    .where(eq(ticketMessages.externalMessageId, externalMessageId))
    .limit(1);

  return Boolean(row);
}

export async function markFirstResponse(id: string, exec: Executor = db): Promise<void> {
  await exec.update(ticketMessages).set({ isFirstResponse: true }).where(eq(ticketMessages.id, id));
}

// -- retention ---------------------------------------------------------------

/** What a message body says once its retention period has passed. */
export const RETENTION_BODY = '[content removed under the data retention policy]';

/**
 * Replaces the content of every message on these tickets.
 *
 * Update rather than delete: the thread's shape — who said something and when —
 * is what the audit trail and the reporting views are built on, and deleting the
 * rows would change five-year-old volume figures retroactively. Only the words
 * go.
 */
export async function anonymiseForTickets(
  ticketIds: readonly string[],
  exec: Executor = db,
): Promise<number> {
  if (ticketIds.length === 0) return 0;

  const updated = await exec
    .update(ticketMessages)
    .set({ body: RETENTION_BODY, bodyHtml: null })
    .where(inArray(ticketMessages.ticketId, [...ticketIds]))
    .returning({ id: ticketMessages.id });

  return updated.length;
}

import { and, asc, eq, inArray } from 'drizzle-orm';
import { db } from '../../db/client.js';
import type { Executor } from '../../db/transaction.js';
import {
  emailEvents,
  inboundEmails,
  outboundEmails,
  type InboundEmailRow,
  type OutboundEmailRow,
} from './email.model.js';

export async function insertInbound(
  values: typeof inboundEmails.$inferInsert,
  exec: Executor = db,
): Promise<InboundEmailRow | undefined> {
  // onConflictDoNothing makes webhook redelivery a no-op rather than a duplicate
  // ticket: Resend retries, and it warns that events can arrive more than once.
  const [row] = await exec
    .insert(inboundEmails)
    .values(values)
    .onConflictDoNothing({ target: inboundEmails.providerEmailId })
    .returning();

  return row;
}

export async function findInboundById(
  id: string,
  exec: Executor = db,
): Promise<InboundEmailRow | undefined> {
  const [row] = await exec.select().from(inboundEmails).where(eq(inboundEmails.id, id)).limit(1);
  return row;
}

export async function findInboundByProviderId(
  providerEmailId: string,
  exec: Executor = db,
): Promise<InboundEmailRow | undefined> {
  const [row] = await exec
    .select()
    .from(inboundEmails)
    .where(eq(inboundEmails.providerEmailId, providerEmailId))
    .limit(1);

  return row;
}

/** The backlog a Phase 4 job will drain; also what a retry endpoint reads. */
export function listUnprocessed(limit: number, exec: Executor = db): Promise<InboundEmailRow[]> {
  return exec
    .select()
    .from(inboundEmails)
    .where(inArray(inboundEmails.status, ['received', 'failed']))
    .orderBy(asc(inboundEmails.receivedAt))
    .limit(limit);
}

export async function updateInbound(
  id: string,
  patch: Partial<InboundEmailRow>,
  exec: Executor = db,
): Promise<void> {
  await exec.update(inboundEmails).set(patch).where(eq(inboundEmails.id, id));
}

export async function insertOutbound(
  values: typeof outboundEmails.$inferInsert,
  exec: Executor = db,
): Promise<OutboundEmailRow> {
  const [row] = await exec.insert(outboundEmails).values(values).returning();
  if (!row) throw new Error('outbound email insert returned no row');
  return row;
}

export function listOutboundForTicket(
  ticketId: string,
  exec: Executor = db,
): Promise<OutboundEmailRow[]> {
  return exec
    .select()
    .from(outboundEmails)
    .where(eq(outboundEmails.ticketId, ticketId))
    .orderBy(asc(outboundEmails.createdAt));
}

export async function insertEvent(
  values: typeof emailEvents.$inferInsert,
  exec: Executor = db,
): Promise<void> {
  await exec.insert(emailEvents).values(values);
}

export async function findOutboundByProviderId(
  providerMessageId: string,
  exec: Executor = db,
): Promise<OutboundEmailRow | undefined> {
  const [row] = await exec
    .select()
    .from(outboundEmails)
    .where(and(eq(outboundEmails.providerMessageId, providerMessageId)))
    .limit(1);

  return row;
}

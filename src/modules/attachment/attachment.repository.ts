import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import { db } from '../../db/client.js';
import type { Executor } from '../../db/transaction.js';
import { attachments, type AttachmentRow } from './attachment.model.js';

export async function insert(
  values: typeof attachments.$inferInsert,
  exec: Executor = db,
): Promise<AttachmentRow> {
  const [row] = await exec.insert(attachments).values(values).returning();
  if (!row) throw new Error('attachment insert returned no row');
  return row;
}

export async function findById(
  id: string,
  exec: Executor = db,
): Promise<AttachmentRow | undefined> {
  const [row] = await exec.select().from(attachments).where(eq(attachments.id, id)).limit(1);
  return row;
}

export function listForTicket(ticketId: string, exec: Executor = db): Promise<AttachmentRow[]> {
  return exec
    .select()
    .from(attachments)
    .where(eq(attachments.ticketId, ticketId))
    .orderBy(asc(attachments.createdAt));
}

export async function update(
  id: string,
  patch: Partial<AttachmentRow>,
  exec: Executor = db,
): Promise<AttachmentRow | undefined> {
  const [row] = await exec.update(attachments).set(patch).where(eq(attachments.id, id)).returning();
  return row;
}

export async function remove(id: string, exec: Executor = db): Promise<void> {
  await exec.delete(attachments).where(eq(attachments.id, id));
}

/** Rows whose upload never completed; a Phase 4 sweep reclaims them. */
export function listStalePending(before: Date, exec: Executor = db): Promise<AttachmentRow[]> {
  return exec
    .select()
    .from(attachments)
    .where(and(eq(attachments.status, 'pending'), isNull(attachments.uploadedAt)))
    .orderBy(asc(attachments.createdAt))
    .limit(200);
}

// -- retention ---------------------------------------------------------------

export function listForTickets(
  ticketIds: readonly string[],
  exec: Executor = db,
): Promise<AttachmentRow[]> {
  if (ticketIds.length === 0) return Promise.resolve([]);

  return exec
    .select()
    .from(attachments)
    .where(inArray(attachments.ticketId, [...ticketIds]));
}

/**
 * Removes attachment rows outright, unlike message bodies.
 *
 * Deliberate asymmetry, and it is the compliance rule rather than a shortcut: a
 * stored document is the personal data, not a description of it, so there is
 * nothing left to anonymise once the file is gone. The audit rows recording the
 * upload and the deletion stay — they have their own, longer, retention period.
 */
export async function removeForTickets(
  ticketIds: readonly string[],
  exec: Executor = db,
): Promise<number> {
  if (ticketIds.length === 0) return 0;

  const removed = await exec
    .delete(attachments)
    .where(inArray(attachments.ticketId, [...ticketIds]))
    .returning({ id: attachments.id });

  return removed.length;
}

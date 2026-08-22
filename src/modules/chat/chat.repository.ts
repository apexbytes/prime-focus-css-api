import { and, eq, isNull, lt, sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import type { Executor } from '../../db/transaction.js';
import { chatSessions, type ChatSessionRow } from './chat.model.js';

export async function insert(
  values: typeof chatSessions.$inferInsert,
  exec: Executor = db,
): Promise<ChatSessionRow> {
  const [row] = await exec.insert(chatSessions).values(values).returning();
  if (!row) throw new Error('chat session insert returned no row');
  return row;
}

/**
 * The lookup every visitor request makes.
 *
 * On the hash, and with the liveness predicate in the same statement rather than
 * checked afterwards — the same shape as the SSO login-request lookup, and for
 * the same reason: two statements leave a window, and this one runs on every
 * frame a visitor sends.
 */
export async function findLiveByTokenHash(
  tokenHash: string,
  exec: Executor = db,
): Promise<ChatSessionRow | undefined> {
  const [row] = await exec
    .select()
    .from(chatSessions)
    .where(
      and(
        eq(chatSessions.tokenHash, tokenHash),
        isNull(chatSessions.endedAt),
        sql`${chatSessions.expiresAt} > now()`,
      ),
    )
    .limit(1);

  return row;
}

export async function findById(
  id: string,
  exec: Executor = db,
): Promise<ChatSessionRow | undefined> {
  const [row] = await exec.select().from(chatSessions).where(eq(chatSessions.id, id)).limit(1);
  return row;
}

export async function findByConversationId(
  conversationId: string,
  exec: Executor = db,
): Promise<ChatSessionRow | undefined> {
  const [row] = await exec
    .select()
    .from(chatSessions)
    .where(eq(chatSessions.conversationId, conversationId))
    .limit(1);

  return row;
}

export async function update(
  id: string,
  patch: Partial<typeof chatSessions.$inferInsert>,
  exec: Executor = db,
): Promise<void> {
  await exec.update(chatSessions).set(patch).where(eq(chatSessions.id, id));
}

/**
 * Drops sessions whose token expired a while ago.
 *
 * Operational debris rather than personal data with a retention period of its
 * own: what the visitor actually said lives on the ticket, which the retention
 * sweep governs. Deleted rather than anonymised because there is nothing here
 * worth keeping once the token is dead.
 */
export async function deleteExpiredBefore(
  before: Date,
  limit: number,
  exec: Executor = db,
): Promise<number> {
  const removed = await exec.execute(sql`
    delete from chat_sessions
    where id in (
      select id from chat_sessions
      where expires_at < ${before}
      order by expires_at
      limit ${limit}
    )
  `);

  return removed.rowCount ?? 0;
}

/** Ends every session on a conversation, when the desk closes the thread. */
export async function endForConversation(
  conversationId: string,
  exec: Executor = db,
): Promise<number> {
  const ended = await exec
    .update(chatSessions)
    .set({ endedAt: new Date() })
    .where(and(eq(chatSessions.conversationId, conversationId), isNull(chatSessions.endedAt)))
    .returning({ id: chatSessions.id });

  return ended.length;
}

/** Sessions that expired without ever being ended, for the sweep's counter. */
export async function countStale(before: Date, exec: Executor = db): Promise<number> {
  const [row] = await exec
    .select({ count: sql<number>`count(*)::int` })
    .from(chatSessions)
    .where(lt(chatSessions.expiresAt, before));

  return row?.count ?? 0;
}

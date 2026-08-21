import { and, count, eq, isNotNull, isNull, lt, or, sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import type { Executor } from '../../db/transaction.js';
import { ticketSlaTargets } from '../sla/sla.model.js';
import { tickets } from '../ticket/ticket.model.js';
import { users } from '../user/user.model.js';
import { ticketLocks, type TicketLockRow } from './realtime.model.js';
import type { QueueCounts } from './realtime.types.js';

export interface LockWithHolder extends TicketLockRow {
  fullName: string;
}

/** The live lock on a ticket, if there is one. Expired rows are not live. */
export async function findLive(
  ticketId: string,
  exec: Executor = db,
): Promise<LockWithHolder | undefined> {
  const [row] = await exec
    .select({
      ticketId: ticketLocks.ticketId,
      userId: ticketLocks.userId,
      socketId: ticketLocks.socketId,
      acquiredAt: ticketLocks.acquiredAt,
      refreshedAt: ticketLocks.refreshedAt,
      expiresAt: ticketLocks.expiresAt,
      createdAt: ticketLocks.createdAt,
      updatedAt: ticketLocks.updatedAt,
      fullName: users.fullName,
    })
    .from(ticketLocks)
    .innerJoin(users, eq(users.id, ticketLocks.userId))
    .where(and(eq(ticketLocks.ticketId, ticketId), sql`${ticketLocks.expiresAt} > now()`))
    .limit(1);

  return row;
}

/**
 * Takes the lock, or refreshes it for whoever already holds it.
 *
 * One statement: the conflict clause only overwrites when the existing row has
 * expired or belongs to the same user, so two agents racing on the same ticket
 * are resolved by the database. `returning` tells the caller which of the two
 * happened without a second read.
 */
export async function acquire(
  input: { ticketId: string; userId: string; socketId: string | null; expiresAt: Date },
  exec: Executor = db,
): Promise<TicketLockRow | undefined> {
  const [row] = await exec
    .insert(ticketLocks)
    .values({
      ticketId: input.ticketId,
      userId: input.userId,
      socketId: input.socketId,
      expiresAt: input.expiresAt,
    })
    .onConflictDoUpdate({
      target: ticketLocks.ticketId,
      set: {
        userId: input.userId,
        socketId: input.socketId,
        refreshedAt: new Date(),
        expiresAt: input.expiresAt,
        // Only a genuinely new holder restarts the "since" clock the console
        // shows; a heartbeat from the same agent must not.
        acquiredAt: sql`case when ${ticketLocks.userId} = ${input.userId} then ${ticketLocks.acquiredAt} else now() end`,
      },
      // Only an expired lock, or the holder's own heartbeat, may overwrite.
      where: or(lt(ticketLocks.expiresAt, sql`now()`), eq(ticketLocks.userId, input.userId)),
    })
    .returning();

  return row;
}

/** Releases a lock the user holds. Returns false if they did not hold it. */
export async function release(
  ticketId: string,
  userId: string | null,
  exec: Executor = db,
): Promise<boolean> {
  const result = await exec
    .delete(ticketLocks)
    .where(
      userId
        ? and(eq(ticketLocks.ticketId, ticketId), eq(ticketLocks.userId, userId))
        : eq(ticketLocks.ticketId, ticketId),
    )
    .returning({ ticketId: ticketLocks.ticketId });

  return result.length > 0;
}

/** Everything a dropped connection was holding. */
export async function releaseForSocket(
  socketId: string,
  exec: Executor = db,
): Promise<{ ticketId: string; userId: string }[]> {
  return exec
    .delete(ticketLocks)
    .where(eq(ticketLocks.socketId, socketId))
    .returning({ ticketId: ticketLocks.ticketId, userId: ticketLocks.userId });
}

/** Housekeeping: rows whose holder never came back. */
export async function deleteExpired(exec: Executor = db): Promise<number> {
  const rows = await exec
    .delete(ticketLocks)
    .where(lt(ticketLocks.expiresAt, sql`now()`))
    .returning({ ticketId: ticketLocks.ticketId });

  return rows.length;
}

/**
 * Live totals for one product's queue.
 *
 * Counted straight off `tickets` rather than read from the reporting views: the
 * views are fifteen minutes stale by design, and a number that updates on a
 * websocket has to be current or it is worse than no number at all. This is a
 * level rather than a flow — the same argument that keeps the backlog figure
 * live in the report module.
 */
export async function queueCounts(productId: string, exec: Executor = db): Promise<QueueCounts> {
  const [row] = await exec
    .select({
      unassigned: count(
        sql`case when ${tickets.assignedToUserId} is null and ${tickets.status} in ('new', 'open', 'pending', 'on_hold') then 1 end`,
      ),
      open: count(sql`case when ${tickets.status} in ('new', 'open') then 1 end`),
      pending: count(sql`case when ${tickets.status} = 'pending' then 1 end`),
      onHold: count(sql`case when ${tickets.status} = 'on_hold' then 1 end`),
    })
    .from(tickets)
    .where(eq(tickets.productId, productId));

  const [breach] = await exec
    .select({ breached: count() })
    .from(ticketSlaTargets)
    .innerJoin(tickets, eq(tickets.id, ticketSlaTargets.ticketId))
    .where(
      and(
        eq(tickets.productId, productId),
        isNotNull(ticketSlaTargets.breachedAt),
        isNull(ticketSlaTargets.satisfiedAt),
      ),
    );

  return {
    productId,
    unassigned: row?.unassigned ?? 0,
    open: row?.open ?? 0,
    pending: row?.pending ?? 0,
    onHold: row?.onHold ?? 0,
    breached: breach?.breached ?? 0,
  };
}

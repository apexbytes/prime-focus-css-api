import { index, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { instant, timestamps } from '../../db/columns.js';
import { tickets } from '../ticket/ticket.model.js';
import { users } from '../user/user.model.js';

/**
 * Who is currently working a ticket.
 *
 * Advisory, not exclusive. The failure mode of a real lock is a closed laptop
 * making a customer's ticket unworkable until somebody with admin rights
 * notices, which is strictly worse than two agents occasionally overlapping —
 * so this expires on its own, is reclaimable the moment it does, and blocks no
 * write anywhere in the system. What it buys is the console being able to say
 * "Chipo is replying to this" before a second agent types the same answer.
 *
 * In Postgres rather than Redis, despite being ephemeral, for two reasons: an
 * agent who opens a ticket over plain HTTP sees the same banner as one on a
 * websocket, and a Redis flush must not silently blank it.
 *
 * The primary key on `ticket_id` is the mutual exclusion: acquiring is one
 * insert-on-conflict, so two instances racing for the same ticket resolve in
 * the database rather than in whichever service checked first.
 */
export const ticketLocks = pgTable(
  'ticket_locks',
  {
    ticketId: uuid('ticket_id')
      .primaryKey()
      .references(() => tickets.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /**
     * The connection holding it, when one is. Null for a lock taken over REST,
     * which is how the console behaves with websockets disabled — such a lock
     * is released by its expiry rather than by a disconnect.
     */
    socketId: text('socket_id'),
    acquiredAt: instant('acquired_at').defaultNow().notNull(),
    /** Moved forward by each heartbeat; `expires_at` follows it. */
    refreshedAt: instant('refreshed_at').defaultNow().notNull(),
    expiresAt: instant('expires_at').notNull(),
    ...timestamps,
  },
  (table) => [
    // The sweep of abandoned locks, and nothing else reads by expiry.
    index('ticket_locks_expiry_idx').on(table.expiresAt),
    // Releasing everything a dropped connection held.
    index('ticket_locks_socket_idx').on(table.socketId),
  ],
);

export type TicketLockRow = typeof ticketLocks.$inferSelect;

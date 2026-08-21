/**
 * Room names, in one place, because a typo in a room is silent in exactly the
 * way a typo in a queue name is: the broadcast succeeds and nobody is in the
 * room to hear it.
 *
 * Three grains, and no more. A room per ticket is what a thread view needs, a
 * room per product is what a queue view needs, and a room per user is what a
 * notification needs. Anything finer is a filter the client can apply itself.
 */
export const ROOM = {
  ticket: (ticketId: string): string => `ticket:${ticketId}`,
  product: (productId: string): string => `product:${productId}`,
  user: (userId: string): string => `user:${userId}`,
} as const;

/** Events the server sends. Client-sent names live in the gateway. */
export const REALTIME_EVENT = {
  /** A ticket's fields changed; the payload is the domain event envelope. */
  ticket: 'ticket',
  /** Somebody took, refreshed or released a lock on a ticket. */
  lock: 'ticket:lock',
  /** Somebody started or stopped typing on a ticket. */
  typing: 'ticket:typing',
  /** Queue totals for one product, after something in it changed. */
  queueCounts: 'queue:counts',
  /** A notification addressed to one user. */
  notification: 'notification',
} as const;

/** What the console renders as "somebody else is in here". */
export interface LockHolder {
  userId: string;
  fullName: string;
  acquiredAt: Date;
  expiresAt: Date;
}

/**
 * The answer to "may I edit this".
 *
 * `acquired: false` is not an error and is not returned as one: the caller is
 * told who holds it so the console can name them, and is left free to write
 * anyway. A 409 would imply the write is going to be refused, and it is not.
 */
export interface LockState {
  ticketId: string;
  acquired: boolean;
  holder: LockHolder | null;
  /** How long the client may wait before refreshing a lock it holds. */
  heartbeatSeconds: number;
}

/** Live totals for one product's queue. */
export interface QueueCounts {
  productId: string;
  unassigned: number;
  open: number;
  pending: number;
  onHold: number;
  /** Tickets whose first-response or resolution clock has already run out. */
  breached: number;
}

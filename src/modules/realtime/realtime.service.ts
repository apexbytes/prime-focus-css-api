import { env } from '../../config/index.js';
import { AppError } from '../../common/errors/index.js';
import { isUserActor, type Actor } from '../../common/types/actor.js';
import { createModuleLogger } from '../../lib/logger/index.js';
import { broadcast } from '../../lib/socket/index.js';
import type { DomainEvent } from '../event/event.types.js';
import * as productService from '../product/product.service.js';
import * as ticketService from '../ticket/ticket.service.js';
import * as repository from './realtime.repository.js';
import {
  REALTIME_EVENT,
  ROOM,
  type LockHolder,
  type LockState,
  type QueueCounts,
} from './realtime.types.js';

const log = createModuleLogger('realtime');

// -- ticket locks ------------------------------------------------------------

/**
 * Takes the lock on a ticket, or refreshes one the caller already holds.
 *
 * The access check is the ticket module's, so a lock cannot become a way to
 * learn that a ticket exists in a product the caller cannot see — it answers
 * 404 there, like every other ticket read.
 */
export async function lock(
  ticketId: string,
  actor: Actor,
  socketId: string | null = null,
): Promise<LockState> {
  const userId = requireUser(actor);
  await ticketService.requireAccessible(ticketId, actor);

  const expiresAt = new Date(Date.now() + env.TICKET_LOCK_TTL_SECONDS * 1000);
  const taken = await repository.acquire({ ticketId, userId, socketId, expiresAt });

  // No row back means the conflict clause refused: somebody else holds a lock
  // that has not expired. That is an answer, not a failure — see LockState.
  const state = await currentState(ticketId, userId);
  if (taken) {
    announceLock(ticketId, state.holder);
  }
  return state;
}

/**
 * Releases a lock the caller holds.
 *
 * Idempotent, and it does not release anybody else's: a stuck lock clears
 * itself within `TICKET_LOCK_TTL_SECONDS`, so an endpoint that could strip
 * another agent's lock would be a way to interfere with their work in exchange
 * for solving a problem that solves itself in two minutes.
 */
export async function unlock(ticketId: string, actor: Actor): Promise<LockState> {
  const userId = requireUser(actor);
  await ticketService.requireAccessible(ticketId, actor);

  const released = await repository.release(ticketId, userId);
  const state = await currentState(ticketId, userId);
  if (released) announceLock(ticketId, state.holder);

  return state;
}

/** Who holds this ticket right now, for the console's banner. */
export async function lockState(ticketId: string, actor: Actor): Promise<LockState> {
  await ticketService.requireAccessible(ticketId, actor);
  return currentState(ticketId, isUserActor(actor) ? actor.id : null);
}

/**
 * Drops everything a disconnected socket was holding.
 *
 * This is what makes the lock's short TTL tolerable in the other direction: a
 * browser tab closed properly releases immediately, and the expiry is only the
 * fallback for a connection that died without saying so.
 */
export async function releaseForSocket(socketId: string): Promise<void> {
  try {
    const released = await repository.releaseForSocket(socketId);
    for (const row of released) {
      announceLock(row.ticketId, null);
    }
  } catch (error) {
    log.warn('failed to release locks for socket', { socketId, err: error });
  }
}

/** Housekeeping for locks whose holder never came back. */
export function sweepExpiredLocks(): Promise<number> {
  return repository.deleteExpired();
}

async function currentState(ticketId: string, userId: string | null): Promise<LockState> {
  const row = await repository.findLive(ticketId);
  const holder: LockHolder | null = row
    ? {
        userId: row.userId,
        fullName: row.fullName,
        acquiredAt: row.acquiredAt,
        expiresAt: row.expiresAt,
      }
    : null;

  return {
    ticketId,
    acquired: holder !== null && holder.userId === userId,
    holder,
    heartbeatSeconds: env.TICKET_LOCK_HEARTBEAT_SECONDS,
  };
}

function requireUser(actor: Actor): string {
  if (!isUserActor(actor)) {
    throw AppError.forbidden('Only a signed-in agent can hold a ticket lock');
  }
  return actor.id;
}

// -- broadcasts --------------------------------------------------------------

function announceLock(ticketId: string, holder: LockHolder | null): void {
  broadcast(ROOM.ticket(ticketId), REALTIME_EVENT.lock, { ticketId, holder });
}

/**
 * Puts a domain event in front of whoever is looking at it.
 *
 * Both rooms in one call: an agent with the ticket open *and* the queue list
 * open is in both, and Socket.IO delivers to them once.
 */
export function emitDomainEvent(event: DomainEvent): void {
  broadcast(
    [ROOM.ticket(event.ticket.id), ROOM.product(event.productId)],
    REALTIME_EVENT.ticket,
    event,
  );

  scheduleQueueCounts(event.productId);
}

/** Somebody is typing a reply. Never persisted: it is true for four seconds. */
export function emitTyping(input: {
  ticketId: string;
  userId: string;
  fullName: string;
  isTyping: boolean;
}): void {
  broadcast(ROOM.ticket(input.ticketId), REALTIME_EVENT.typing, input);
}

/** An in-app notification, to whichever of that user's tabs are open. */
export function emitToUser(userId: string, payload: unknown): void {
  broadcast(ROOM.user(userId), REALTIME_EVENT.notification, payload);
}

/**
 * Queue totals, throttled.
 *
 * Every ticket change moves a queue count, and a busy desk changes tickets far
 * faster than anyone reads a number. Emitting per change would put two
 * aggregate queries on the transactional path for each one. So: send
 * immediately if this product has been quiet, otherwise schedule one send at
 * the end of the window. Leading *and* trailing, because dropping the trailing
 * send would leave the last change of a burst — usually the one that emptied
 * the queue — permanently unshown.
 */
const QUEUE_COUNT_INTERVAL_MS = 3_000;
const lastEmitted = new Map<string, number>();
const pending = new Set<string>();

function scheduleQueueCounts(productId: string): void {
  const since = Date.now() - (lastEmitted.get(productId) ?? 0);

  if (since >= QUEUE_COUNT_INTERVAL_MS) {
    void emitQueueCounts(productId);
    return;
  }

  if (pending.has(productId)) return;
  pending.add(productId);

  const timer = setTimeout(() => {
    pending.delete(productId);
    void emitQueueCounts(productId);
  }, QUEUE_COUNT_INTERVAL_MS - since);
  // A pending count must never be the reason a process refuses to exit.
  timer.unref();
}

export async function emitQueueCounts(productId: string): Promise<void> {
  lastEmitted.set(productId, Date.now());

  try {
    const counts = await repository.queueCounts(productId);
    broadcast(ROOM.product(productId), REALTIME_EVENT.queueCounts, counts);
  } catch (error) {
    log.warn('queue counts not broadcast', { productId, err: error });
  }
}

/**
 * The same totals over HTTP, for a console that has no websocket — a browser
 * behind a proxy that strips upgrades still needs the queue header to be right.
 */
export async function queueCounts(productId: string, actor: Actor): Promise<QueueCounts> {
  await productService.assertAccess(actor, productId);
  return repository.queueCounts(productId);
}

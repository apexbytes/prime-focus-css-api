import { env } from '../../config/index.js';
import { AppError } from '../../common/errors/index.js';
import type { UserActor } from '../../common/types/actor.js';
import { createModuleLogger } from '../../lib/logger/index.js';
import {
  attachNamespace,
  startSocketServer,
  STAFF_NAMESPACE,
  type RealtimeSocket,
} from '../../lib/socket/index.js';
import * as authService from '../auth/auth.service.js';
import * as productService from '../product/product.service.js';
import * as ticketService from '../ticket/ticket.service.js';
import * as realtimeService from './realtime.service.js';
import { ROOM } from './realtime.types.js';

const log = createModuleLogger('realtime:gateway');

/**
 * Events the client sends. The server-sent names live in `realtime.types.ts`;
 * these are here because nothing outside this file may send them.
 */
const CLIENT_EVENT = {
  subscribeTicket: 'ticket:subscribe',
  unsubscribeTicket: 'ticket:unsubscribe',
  subscribeProduct: 'product:subscribe',
  unsubscribeProduct: 'product:unsubscribe',
  lockAcquire: 'ticket:lock',
  lockRelease: 'ticket:unlock',
  typing: 'ticket:typing',
} as const;

/** Every client event answers through a callback, so a UI can show a failure. */
type Ack = (response: { ok: true; data?: unknown } | { ok: false; error: string }) => void;

/**
 * Attaches the support desk's realtime protocol to the HTTP server.
 *
 * Called from `server.ts` after `listen()`. Everything this gateway does is
 * also reachable over REST — locks, queue counts, the ticket itself — because
 * a websocket that a corporate proxy strips must degrade to a slower console,
 * not a broken one.
 */
export async function startRealtime(
  httpServer: Parameters<typeof startSocketServer>[0],
): Promise<void> {
  attachNamespace<UserActor>(STAFF_NAMESPACE, {
    authenticate: async (credential) => {
      // Staff sessions only. A product system's API key is refused outright:
      // there is no console for it to open, and the rooms here carry internal
      // ticket state that a partner integration has no business subscribing to.
      // A live-chat visitor's session token is refused for the same reason, and
      // could not reach this namespace anyway — see `chat.gateway.ts`.
      if (!credential.token) throw AppError.unauthenticated();

      const actor = await authService.actorFromAccessToken(credential.token);
      if (actor.kind !== 'user') {
        throw AppError.forbidden('Only a signed-in agent may open a realtime connection');
      }
      return actor;
    },
    onConnection: attach,
  });

  await startSocketServer(httpServer);
}

function attach(socket: RealtimeSocket<UserActor>): void {
  const actor = socket.data.identity;

  // A user's own room needs no subscription: a notification addressed to them
  // is theirs by definition, and making the client ask for it only creates a
  // window in which it is connected and not listening.
  void socket.join(ROOM.user(actor.id));

  log.debug('realtime connection', { actorId: actor.id, socketId: socket.id });

  socket.on(CLIENT_EVENT.subscribeTicket, (payload: unknown, ack?: Ack) => {
    handle(ack, async () => {
      const ticketId = requireId(payload, 'ticketId');
      // The ticket module's own check, so subscribing cannot reveal that a
      // ticket exists in a product this agent cannot see.
      await ticketService.requireAccessible(ticketId, actor);
      await socket.join(ROOM.ticket(ticketId));
      return await realtimeService.lockState(ticketId, actor);
    });
  });

  socket.on(CLIENT_EVENT.unsubscribeTicket, (payload: unknown, ack?: Ack) => {
    handle(ack, async () => {
      await socket.leave(ROOM.ticket(requireId(payload, 'ticketId')));
    });
  });

  socket.on(CLIENT_EVENT.subscribeProduct, (payload: unknown, ack?: Ack) => {
    handle(ack, async () => {
      const productId = requireId(payload, 'productId');
      await productService.assertAccess(actor, productId);
      await socket.join(ROOM.product(productId));
      // The queue header would otherwise stay blank until something changed.
      await realtimeService.emitQueueCounts(productId);
    });
  });

  socket.on(CLIENT_EVENT.unsubscribeProduct, (payload: unknown, ack?: Ack) => {
    handle(ack, async () => {
      await socket.leave(ROOM.product(requireId(payload, 'productId')));
    });
  });

  socket.on(CLIENT_EVENT.lockAcquire, (payload: unknown, ack?: Ack) => {
    handle(ack, () =>
      // The socket id is what lets a dropped connection release immediately
      // rather than waiting out the expiry.
      realtimeService.lock(requireId(payload, 'ticketId'), actor, socket.id),
    );
  });

  socket.on(CLIENT_EVENT.lockRelease, (payload: unknown, ack?: Ack) => {
    handle(ack, () => realtimeService.unlock(requireId(payload, 'ticketId'), actor));
  });

  socket.on(CLIENT_EVENT.typing, (payload: unknown, ack?: Ack) => {
    handle(ack, async () => {
      const ticketId = requireId(payload, 'ticketId');
      const isTyping = (payload as { isTyping?: unknown }).isTyping !== false;

      // Checked, not trusted: a typing indicator is a broadcast into a room,
      // and an unchecked one is a way to put your name on a ticket you cannot
      // read.
      await ticketService.requireAccessible(ticketId, actor);
      realtimeService.emitTyping({
        ticketId,
        userId: actor.id,
        fullName: actor.fullName,
        isTyping,
      });
    });
  });

  const reauth = startReauthorisation(socket, actor);

  socket.on('disconnect', (reason) => {
    clearInterval(reauth);
    void realtimeService.releaseForSocket(socket.id);
    log.debug('realtime disconnect', { actorId: actor.id, reason });
  });
}

/**
 * Keeps a long-lived socket honest.
 *
 * The REST path re-reads the user row on every request, so suspending an
 * account takes effect on its next call. A socket is authenticated once, at the
 * handshake, and would otherwise stay open all afternoon on a session that has
 * since been revoked — so the account is re-checked on a timer and a socket
 * whose user is no longer active is closed.
 *
 * The access token is *not* re-verified: it expires in fifteen minutes by
 * design, and disconnecting every agent every quarter of an hour would be a
 * denial of service dressed up as security. What has to propagate is the
 * account's state, and that is what this reads.
 */
function startReauthorisation(socket: RealtimeSocket<UserActor>, actor: UserActor): NodeJS.Timeout {
  const timer = setInterval(() => {
    void authService
      .isConnectionStillAuthorised(actor)
      .then((active) => {
        if (active) return;
        log.info('closing realtime connection: account no longer active', { actorId: actor.id });
        socket.disconnect(true);
      })
      .catch((error: unknown) => {
        // A database blip must not disconnect the whole desk; the next tick
        // tries again.
        log.warn('realtime re-authorisation check failed', { actorId: actor.id, err: error });
      });
  }, env.REALTIME_REAUTH_SECONDS * 1000);

  timer.unref();
  return timer;
}

/**
 * Runs a handler and answers the client's callback.
 *
 * Errors are reported as a message and never as a thrown exception: an
 * unhandled rejection inside a socket listener takes the process down, and one
 * agent clicking on a ticket they cannot see is not an outage.
 */
function handle(ack: Ack | undefined, run: () => Promise<unknown>): void {
  void run()
    .then((data) => ack?.(data === undefined ? { ok: true } : { ok: true, data }))
    .catch((error: unknown) => {
      const message = error instanceof AppError ? error.message : 'Request failed';
      ack?.({ ok: false, error: message });
    });
}

function requireId(payload: unknown, field: 'ticketId' | 'productId'): string {
  const value = (payload as Record<string, unknown> | null)?.[field];
  if (typeof value !== 'string' || value.length === 0) {
    throw AppError.validation(`${field} is required`);
  }
  return value;
}

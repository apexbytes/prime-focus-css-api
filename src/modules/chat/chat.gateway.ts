import { env } from '../../config/index.js';
import { AppError } from '../../common/errors/index.js';
import { createModuleLogger } from '../../lib/logger/index.js';
import { attachNamespace, startSocketServer, type RealtimeSocket } from '../../lib/socket/index.js';
import * as chatService from './chat.service.js';
import { CHAT_EVENT, CHAT_ROOM, type ChatVisitor } from './chat.types.js';

const log = createModuleLogger('chat:gateway');

/** Events a visitor's widget sends. */
const CLIENT_EVENT = {
  message: 'chat:send',
  typing: 'chat:typing',
  transcript: 'chat:transcript',
  end: 'chat:end',
} as const;

type Ack = (response: { ok: true; data?: unknown } | { ok: false; error: string }) => void;

/**
 * Attaches the live-chat protocol to its own namespace.
 *
 * Everything about this gateway is narrower than the staff one, and each
 * narrowing is the point rather than an omission:
 *
 * - **No subscribe events.** A visitor is joined to exactly one room, their own
 *   conversation, by the server at connection time. There is no client event
 *   that takes a room name, so there is nothing to pass another conversation's
 *   id to. The staff gateway needs `ticket:subscribe` because an agent moves
 *   between tickets; a visitor never does.
 * - **No ticket ids anywhere in the protocol.** The visitor's own credential
 *   resolves to a conversation, and the conversation names the ticket. A widget
 *   that could name a ticket would be a widget that could try naming somebody
 *   else's.
 * - **No lock, no queue counts, no notifications.** Those are the desk's
 *   internal state.
 * - **Its own namespace**, so none of the above is one forgotten check away
 *   from being reachable. See the note on `attachNamespace`.
 */
export async function startChat(
  httpServer: Parameters<typeof startSocketServer>[0],
): Promise<void> {
  if (!env.CHAT_ENABLED) {
    log.info('live chat is disabled; the namespace is not attached');
    return;
  }

  attachNamespace<ChatVisitor>(env.CHAT_NAMESPACE, {
    authenticate: async (credential) => {
      // A staff access token is refused here as firmly as a visitor token is
      // refused on the staff namespace. An agent belongs in the console, and
      // accepting a staff token here would create a second, weaker path to a
      // conversation's contents.
      if (credential.token || credential.apiKey) {
        throw AppError.forbidden('This namespace is for live-chat visitors');
      }

      return chatService.authenticateVisitor(credential.sessionToken);
    },
    onConnection: attach,
  });

  await startSocketServer(httpServer);
}

function attach(socket: RealtimeSocket<ChatVisitor>): void {
  const visitor = socket.data.identity;

  // Joined by the server, never on request. This is the only room this socket
  // will ever be in.
  void socket.join(CHAT_ROOM.conversation(visitor.conversationExternalId));

  log.debug('chat visitor connected', {
    sessionId: visitor.sessionId,
    productId: visitor.productId,
  });

  socket.on(CLIENT_EVENT.message, (payload: unknown, ack?: Ack) => {
    handle(ack, () => {
      const body = (payload as { body?: unknown } | null)?.body;
      if (typeof body !== 'string') throw AppError.validation('body is required');

      // The message the visitor sees is the one broadcast by the pipeline after
      // it is filed, not an echo from here: if filing failed, the visitor must
      // not be shown their message sitting in a thread the desk never received.
      return chatService.postVisitorMessage(visitor, body);
    });
  });

  socket.on(CLIENT_EVENT.typing, (payload: unknown, ack?: Ack) => {
    handle(ack, () => {
      const isTyping = (payload as { isTyping?: unknown } | null)?.isTyping !== false;
      chatService.visitorTyping(visitor, isTyping);
    });
  });

  socket.on(CLIENT_EVENT.transcript, (_payload: unknown, ack?: Ack) => {
    handle(ack, () => chatService.transcript(visitor));
  });

  socket.on(CLIENT_EVENT.end, (_payload: unknown, ack?: Ack) => {
    handle(ack, async () => {
      await chatService.endSession(visitor);
      socket.disconnect(true);
    });
  });

  const revalidate = startRevalidation(socket, visitor);

  socket.on('disconnect', (reason) => {
    clearInterval(revalidate);
    // Deliberately *not* ending the session: a visitor whose train went into a
    // tunnel should come back to their conversation, not to a dead token. The
    // session's own expiry is what ends it.
    log.debug('chat visitor disconnected', { sessionId: visitor.sessionId, reason });
  });
}

/**
 * Closes a socket whose session has expired or been ended.
 *
 * The same problem the staff gateway solves, with a sharper edge: a chat session
 * is authenticated once at handshake and would otherwise outlive its own expiry
 * for as long as the tab stays open — which for a widget left open on a desktop
 * is days. The desk must also be able to end a conversation and have it actually
 * end, so this re-reads the row rather than trusting the handshake.
 */
function startRevalidation(
  socket: RealtimeSocket<ChatVisitor>,
  visitor: ChatVisitor,
): NodeJS.Timeout {
  const timer = setInterval(
    () => {
      void chatService
        .revalidate(visitor)
        .then((live) => {
          if (live) return;
          log.debug('closing chat connection: session is over', { sessionId: visitor.sessionId });
          socket.emit(CHAT_EVENT.ended, { reason: 'expired' });
          socket.disconnect(true);
        })
        .catch((error: unknown) => {
          // A database blip must not disconnect a visitor mid-sentence.
          log.warn('chat revalidation failed', { sessionId: visitor.sessionId, err: error });
        });
    },
    // A minute: the session TTL is measured in hours, so this is about the desk
    // being able to end a conversation promptly, not about the expiry.
    60_000,
  );

  timer.unref();
  return timer;
}

/**
 * Runs a handler and answers the widget's callback.
 *
 * Errors become a message, never a thrown exception: an unhandled rejection in a
 * socket listener takes the process down, and one visitor sending an empty
 * message is not an outage.
 *
 * The handler may be synchronous, and the `Promise.resolve().then` wrapper is
 * what makes that safe: a validation error thrown before the first `await` would
 * otherwise escape the promise chain entirely and become the unhandled throw
 * this function exists to prevent.
 */
function handle(ack: Ack | undefined, run: () => unknown): void {
  void Promise.resolve()
    .then(run)
    .then((data) => ack?.(data === undefined ? { ok: true } : { ok: true, data }))
    .catch((error: unknown) => {
      const message = error instanceof AppError ? error.message : 'Request failed';
      ack?.({ ok: false, error: message });
    });
}

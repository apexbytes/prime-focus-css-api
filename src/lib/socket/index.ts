import type { Server as HttpServer } from 'node:http';
import { createAdapter } from '@socket.io/redis-adapter';
import { Server as IoServer, type Namespace, type Socket } from 'socket.io';
import { corsOrigins, env } from '../../config/index.js';
import { duplicateRedis } from '../redis/index.js';
import { createModuleLogger } from '../logger/index.js';

const log = createModuleLogger('socket');

/**
 * A connection, once the gateway has said who is on the other end.
 *
 * Generic in the identity on purpose: this file deliberately does not know what
 * a ticket, an agent or a permission is. It authenticates by calling back into
 * the module that does, and carries whatever comes back as opaque data.
 */
export interface RealtimeSocket<TIdentity> extends Socket {
  data: { identity: TIdentity };
}

/**
 * Whatever the client put in the handshake `auth` object.
 *
 * One shape for every namespace rather than a generic, because the alternative
 * is each gateway parsing `handshake.auth` itself — and the reason that parsing
 * lives here is that `auth` is `any` at the Socket.IO boundary, so exactly one
 * file should be doing the narrowing.
 */
export interface SocketCredential {
  /** A staff access token. */
  token?: string;
  apiKey?: string;
  /** A live-chat visitor's session token — see the `chat` module. */
  sessionToken?: string;
}

export interface NamespaceOptions<TIdentity> {
  /**
   * Turns a handshake credential into an identity, or throws. Runs before the
   * connection is established — an unauthenticated socket is never allowed to
   * exist, rather than being allowed to connect and then policed per event.
   */
  authenticate: (credential: SocketCredential) => Promise<TIdentity>;
  /** Wires the domain events onto a freshly authenticated socket. */
  onConnection: (socket: RealtimeSocket<TIdentity>) => void;
}

/** The staff console's namespace: the Socket.IO default. */
export const STAFF_NAMESPACE = '/';

let io: IoServer | null = null;

/**
 * Namespaces asked for, whether or not the server is up yet.
 *
 * Registration is decoupled from the server's lifecycle so the call order in
 * `server.ts` cannot matter: a gateway that registers before `listen()` is
 * applied when the server starts, and one that registers after is applied
 * immediately. The alternative is an ordering rule that is invisible until the
 * day somebody reorders two lines and one namespace silently stops accepting
 * connections.
 */
const namespaces = new Map<string, NamespaceOptions<unknown>>();

/**
 * Attaches Socket.IO to the running HTTP server.
 *
 * Called from `server.ts` after `listen()`, never from `createApp()`: a
 * Supertest run must not open a websocket server, and the app has to stay
 * importable without one. Idempotent, so several gateways may each make sure
 * the server exists before registering their namespace.
 */
export async function startSocketServer(httpServer: HttpServer): Promise<void> {
  if (!env.REALTIME_ENABLED || io) return;

  const server = new IoServer(httpServer, {
    path: env.REALTIME_PATH,
    // The same allowlist the REST API uses. A websocket is not exempt from CORS
    // just because the browser's preflight rules for it are different.
    cors: { origin: corsOrigins === '*' ? true : corsOrigins, credentials: true },
    // Long enough to survive a phone changing networks, short enough that a
    // closed laptop stops holding a ticket lock for the rest of the afternoon.
    pingTimeout: 20_000,
    pingInterval: 25_000,
  });

  await attachRedisAdapter(server);

  io = server;

  for (const [name, options] of namespaces) {
    wire(name, options);
  }

  log.info('realtime server listening', {
    path: env.REALTIME_PATH,
    namespaces: [...namespaces.keys()],
  });
}

/**
 * Declares a protocol on one namespace.
 *
 * Namespaces rather than rooms on a shared connection, because the two
 * audiences are not the same kind of caller: the staff console is a signed-in
 * member of the desk, and a live-chat visitor is a member of the public holding
 * a token for one conversation. Separate namespaces means separate handshake
 * authentication and separate event handlers, so there is no code path on which
 * a visitor's socket can be sent a staff event or join a staff room — the
 * isolation is structural rather than a check somebody has to remember.
 */
export function attachNamespace<TIdentity>(
  name: string,
  options: NamespaceOptions<TIdentity>,
): void {
  namespaces.set(name, options as NamespaceOptions<unknown>);
  if (io) wire(name, options as NamespaceOptions<unknown>);
}

function wire(name: string, options: NamespaceOptions<unknown>): void {
  const namespace = io?.of(name);
  if (!namespace) return;

  // Guard against a second `startSocketServer` — or a re-registration — stacking
  // duplicate handlers, which would authenticate twice and emit twice.
  namespace.removeAllListeners('connection');

  /**
   * Authentication runs once, in the handshake. `auth` rather than a query
   * string: a token in the URL lands in proxy logs, which is the same rule the
   * REST API follows.
   */
  namespace.use((socket, next) => {
    const auth = socket.handshake.auth as Record<string, unknown>;

    void options
      .authenticate({
        ...(typeof auth.token === 'string' ? { token: auth.token } : {}),
        ...(typeof auth.apiKey === 'string' ? { apiKey: auth.apiKey } : {}),
        ...(typeof auth.sessionToken === 'string' ? { sessionToken: auth.sessionToken } : {}),
      })
      .then((identity) => {
        (socket as RealtimeSocket<unknown>).data.identity = identity;
        next();
      })
      .catch((error: unknown) => {
        // The client is told the connection was refused and nothing else. A
        // websocket handshake is a fine place to probe for valid tokens.
        log.debug('socket authentication refused', { namespace: name, err: error });
        next(new Error('unauthorised'));
      });
  });

  namespace.on('connection', (socket) => {
    options.onConnection(socket as RealtimeSocket<unknown>);
  });
}

/**
 * Puts the room registry in Redis so a broadcast reaches every instance.
 *
 * Without it each process only knows its own sockets, so an agent connected to
 * instance A never sees a ticket updated on instance B — which looks exactly
 * like a broken feature rather than a missing dependency. Under the `memory`
 * driver the server still works, for one instance, which is the same bargain
 * the rest of the cache layer makes.
 */
async function attachRedisAdapter(server: IoServer): Promise<void> {
  const pub = duplicateRedis('socket-pub');
  const sub = duplicateRedis('socket-sub');

  if (!pub || !sub) {
    log.warn('realtime is single-instance: no Redis adapter configured');
    return;
  }

  server.adapter(createAdapter(pub, sub));
  // ioredis connects lazily; forcing it here means a misconfigured URL is a
  // boot-time warning rather than a broadcast that silently goes nowhere.
  await Promise.all([pub.ping(), sub.ping()]);
  log.info('realtime redis adapter attached');
}

/**
 * Sends an event to a room, if the realtime server is running.
 *
 * Never throws and never awaits delivery: every caller is a domain service that
 * has already committed its change, and a browser that missed a notification
 * refetches. Realtime is a courtesy on top of the REST API, never the record.
 *
 * The namespace is an explicit argument with a staff default, so sending to a
 * visitor's room is something a caller has to say it means.
 */
export function broadcast(
  room: string | string[],
  event: string,
  payload: unknown,
  namespace: string = STAFF_NAMESPACE,
): void {
  const target = resolveNamespace(namespace);
  if (!target) return;

  try {
    // An array rather than chained `to()` calls: Socket.IO delivers once to a
    // socket that is in several of the rooms, which is the whole reason a ticket
    // event can name both its ticket room and its product room.
    target.to(room).emit(event, payload);
  } catch (error) {
    log.warn('broadcast failed', { room, event, namespace, err: error });
  }
}

/** Every socket currently in a room, across instances. */
export async function socketsInRoom(
  room: string,
  namespace: string = STAFF_NAMESPACE,
): Promise<number> {
  const target = resolveNamespace(namespace);
  if (!target) return 0;

  try {
    const sockets = await target.in(room).fetchSockets();
    return sockets.length;
  } catch (error) {
    log.warn('room census failed', { room, namespace, err: error });
    return 0;
  }
}

function resolveNamespace(name: string): Namespace | null {
  if (!io) return null;
  // `of()` creates on demand, which would quietly manufacture a namespace
  // nothing is listening on if a caller mistyped one.
  return namespaces.has(name) ? io.of(name) : null;
}

export interface SocketHealth {
  state: 'ok' | 'not_configured';
  connections: number;
}

export function socketHealth(): SocketHealth {
  if (!io) return { state: 'not_configured', connections: 0 };
  return { state: 'ok', connections: io.engine.clientsCount };
}

/**
 * Releases every open connection, so the process can stop.
 *
 * Deliberately **not** `io.close()`. Socket.IO's own close also closes the HTTP
 * server it was attached to — which `server.ts` is about to close itself, and
 * the second close throws `ERR_SERVER_NOT_RUNNING`, turning a clean shutdown
 * into a failed one and a zero exit code into a one. Disconnecting the clients
 * is this layer's whole job; the listener belongs to whoever opened it.
 *
 * An open websocket keeps an HTTP server alive indefinitely, so calling this
 * first is what makes the graceful shutdown graceful rather than a wait for the
 * deadline.
 */
export function stopSocketServer(): void {
  const server = io;
  io = null;
  if (!server) return;

  // Every namespace, not just the default: a visitor's chat socket holds the
  // HTTP server open exactly as firmly as an agent's does.
  for (const name of namespaces.keys()) {
    server.of(name).disconnectSockets(true);
  }

  server.disconnectSockets(true);
  server.engine.close();
  log.info('realtime connections closed');
}

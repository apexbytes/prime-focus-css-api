import type { Server as HttpServer } from 'node:http';
import { createAdapter } from '@socket.io/redis-adapter';
import { Server as IoServer, type Socket } from 'socket.io';
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

export interface SocketServerOptions<TIdentity> {
  /**
   * Turns a handshake credential into an identity, or throws. Runs before the
   * connection is established — an unauthenticated socket is never allowed to
   * exist, rather than being allowed to connect and then policed per event.
   */
  authenticate: (credential: { token?: string; apiKey?: string }) => Promise<TIdentity>;
  /** Wires the domain events onto a freshly authenticated socket. */
  onConnection: (socket: RealtimeSocket<TIdentity>) => void;
}

let io: IoServer | null = null;

/**
 * Attaches Socket.IO to the running HTTP server.
 *
 * Called from `server.ts` after `listen()`, never from `createApp()`: a
 * Supertest run must not open a websocket server, and the app has to stay
 * importable without one.
 */
export async function startSocketServer<TIdentity>(
  httpServer: HttpServer,
  options: SocketServerOptions<TIdentity>,
): Promise<void> {
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

  /**
   * Authentication runs once, in the handshake. `auth` rather than a query
   * string: a token in the URL lands in proxy logs, which is the same rule the
   * REST API follows.
   */
  server.use((socket, next) => {
    const auth = socket.handshake.auth as { token?: unknown; apiKey?: unknown };

    void options
      .authenticate({
        token: typeof auth.token === 'string' ? auth.token : undefined,
        apiKey: typeof auth.apiKey === 'string' ? auth.apiKey : undefined,
      })
      .then((identity) => {
        (socket as RealtimeSocket<TIdentity>).data.identity = identity;
        next();
      })
      .catch((error: unknown) => {
        // The client is told the connection was refused and nothing else. A
        // websocket handshake is a fine place to probe for valid tokens.
        log.debug('socket authentication refused', { err: error });
        next(new Error('unauthorised'));
      });
  });

  server.on('connection', (socket) => {
    options.onConnection(socket as RealtimeSocket<TIdentity>);
  });

  io = server;
  log.info('realtime server listening', { path: env.REALTIME_PATH });
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
 */
export function broadcast(room: string | string[], event: string, payload: unknown): void {
  if (!io) return;

  try {
    // An array rather than chained `to()` calls: Socket.IO delivers once to a
    // socket that is in several of the rooms, which is the whole reason a ticket
    // event can name both its ticket room and its product room.
    io.to(room).emit(event, payload);
  } catch (error) {
    log.warn('broadcast failed', { room, event, err: error });
  }
}

/** Every socket currently in a room, across instances. */
export async function socketsInRoom(room: string): Promise<number> {
  if (!io) return 0;

  try {
    const sockets = await io.in(room).fetchSockets();
    return sockets.length;
  } catch (error) {
    log.warn('room census failed', { room, err: error });
    return 0;
  }
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

  server.disconnectSockets(true);
  server.engine.close();
  log.info('realtime connections closed');
}

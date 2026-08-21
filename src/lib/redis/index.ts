import { Redis, type RedisOptions } from 'ioredis';
import { cacheDriver, env } from '../../config/index.js';
import { createModuleLogger } from '../logger/index.js';

const log = createModuleLogger('redis');

/**
 * The shared Redis connection, or nothing under the `memory` driver.
 *
 * Everything above this file is written to work without it. Redis holds
 * rate-limit counters, cached lookups and the socket fan-out — state that is
 * *shared between instances*, not state the system depends on to be correct.
 * A single instance with no Redis behaves identically; two of them disagree,
 * which is why production refuses to boot without one unless the operator
 * chooses `CACHE_DRIVER=memory` on purpose.
 */
let client: Redis | null = null;
const duplicates = new Set<Redis>();

/** Connection options shared by the main client and every duplicate. */
function connectionOptions(): RedisOptions {
  return {
    connectTimeout: env.REDIS_CONNECT_TIMEOUT_MS,
    /**
     * A command issued before the socket is up waits for it, and one issued
     * during an outage fails after a single reconnect attempt rather than
     * hanging.
     *
     * Both halves are load-bearing. Disabling the offline queue outright looks
     * like the fail-fast option and is not: ioredis connects asynchronously, so
     * every command in the first few hundred milliseconds of a boot — the
     * subscriber's `subscribe`, the socket adapter's `ping`, the rate limiter
     * loading its Lua — would fail against a Redis that is perfectly healthy.
     * `maxRetriesPerRequest` is what keeps a genuine outage from turning a
     * cache read into a hang; every caller here treats an error as a miss.
     */
    maxRetriesPerRequest: 1,
    // Backs off to a ceiling instead of hammering a restarting server.
    retryStrategy: (attempt: number) => Math.min(attempt * 200, 5_000),
  };
}

/**
 * The connection, opened on first use. Returns null under the `memory` driver,
 * which is the signal every caller checks before reaching for Redis at all.
 */
export function getRedis(): Redis | null {
  if (cacheDriver === 'memory') return null;
  if (client) return client;

  client = new Redis(env.REDIS_URL ?? '', connectionOptions());

  // ioredis reports connection failures as events. Unhandled, an `error` event
  // on an EventEmitter throws and takes the process with it — so this listener
  // is load-bearing, not diagnostic.
  client.on('error', (error: Error) => log.warn('redis connection error', { err: error }));
  client.on('ready', () => log.info('redis connected'));

  return client;
}

/**
 * A second connection for a caller that needs one of its own.
 *
 * Redis puts a subscribed connection into a mode where it accepts nothing but
 * more subscriptions, so pub/sub cannot share the command connection. Every
 * duplicate is tracked here so shutdown closes it.
 */
export function duplicateRedis(role: string): Redis | null {
  const primary = getRedis();
  if (!primary) return null;

  const copy = primary.duplicate();
  copy.on('error', (error: Error) => log.warn('redis connection error', { role, err: error }));
  duplicates.add(copy);
  return copy;
}

/** Namespaces a key, so two environments can share one Redis without collision. */
export function redisKey(...parts: (string | number)[]): string {
  return `${env.REDIS_KEY_PREFIX}${parts.join(':')}`;
}

export interface RedisHealth {
  state: 'ok' | 'unavailable' | 'not_configured';
  latencyMs?: number;
  error?: string;
}

/**
 * Readiness probe. `memory` reports `not_configured` rather than `ok`, following
 * the queue's `inline` and the scanner's `none`: the process serves traffic, but
 * an operator should be able to see that nothing is shared between instances.
 *
 * A configured-but-unreachable Redis *does* fail readiness. Rate limits and
 * socket rooms silently stop being global in that state, and an instance that
 * has stopped enforcing a shared limit is not fully serving.
 */
export async function checkRedis(): Promise<RedisHealth> {
  const connection = getRedis();
  if (!connection) return { state: 'not_configured' };

  const startedAt = Date.now();
  try {
    await connection.ping();
    return { state: 'ok', latencyMs: Date.now() - startedAt };
  } catch (error) {
    return { state: 'unavailable', error: error instanceof Error ? error.message : 'unknown' };
  }
}

/** Closes every connection this module opened. Called during shutdown. */
export async function closeRedis(): Promise<void> {
  const connections = [...duplicates, ...(client ? [client] : [])];
  duplicates.clear();
  client = null;

  await Promise.all(
    connections.map(async (connection) => {
      try {
        await connection.quit();
      } catch {
        // Already gone, or never connected. Nothing left to close cleanly.
        connection.disconnect();
      }
    }),
  );
}

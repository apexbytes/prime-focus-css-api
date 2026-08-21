import type { Redis } from 'ioredis';
import { createModuleLogger } from '../logger/index.js';
import { duplicateRedis, getRedis, redisKey } from '../redis/index.js';

const log = createModuleLogger('cache:signal');

/**
 * Cross-instance cache invalidation.
 *
 * Several caches in this system are deliberately in-process rather than in
 * Redis — the role→permission map is read on every single request, and a network
 * round trip per request to save one indexed query is a bad trade. The cost of
 * keeping them local is that a permission revoked on instance A stays warm on
 * instance B until its TTL expires.
 *
 * This closes that gap without moving the caches: the instance that made the
 * change publishes a one-line message, and every instance drops the affected
 * entry. The TTL stays as the backstop for a message that never arrives, which
 * is why an outage here costs latency in propagation and nothing else.
 */
export const SIGNAL = {
  /** A role's grants changed, or roles were re-seeded. */
  permissions: 'permissions',
  /** A business-hours calendar or its holidays changed. */
  calendars: 'calendars',
} as const;

export type SignalName = (typeof SIGNAL)[keyof typeof SIGNAL];

/** Payload is an optional entity id; absent means "drop everything". */
export type SignalHandler = (id?: string) => void;

const handlers = new Map<SignalName, SignalHandler[]>();
let subscriber: Redis | null = null;

/**
 * Registers interest in a signal. Called during app assembly, like the job
 * registry: pure bookkeeping, so it is safe before anything is connected.
 */
export function onSignal(name: SignalName, handler: SignalHandler): void {
  const existing = handlers.get(name) ?? [];
  // Idempotent for repeated `createApp()` calls in a test file, which would
  // otherwise stack up one handler per app.
  if (!existing.includes(handler)) existing.push(handler);
  handlers.set(name, existing);
}

/**
 * Tells the other instances. The caller invalidates its own copy directly — it
 * has already done the work and should not wait for a round trip to see its own
 * change — so this is genuinely fan-out, and doing nothing under the `memory`
 * driver is correct rather than degraded.
 */
export async function publishSignal(name: SignalName, id?: string): Promise<void> {
  const connection = getRedis();
  if (!connection) return;

  try {
    await connection.publish(channelFor(name), id ?? '');
  } catch (error) {
    log.warn('cache signal not published', { signal: name, err: error });
  }
}

/**
 * Opens the subscriber connection. Called from `server.ts` alongside the queue,
 * never from `createApp()`: a Supertest run must not open sockets.
 */
export async function startSignals(): Promise<void> {
  if (subscriber) return;

  const connection = duplicateRedis('cache-signals');
  if (!connection) return;

  connection.on('message', (channel: string, message: string) => {
    const name = nameFor(channel);
    if (!name) return;

    for (const handler of handlers.get(name) ?? []) {
      try {
        handler(message === '' ? undefined : message);
      } catch (error) {
        log.error('cache signal handler failed', { signal: name, err: error });
      }
    }
  });

  await connection.subscribe(...Object.values(SIGNAL).map(channelFor));
  subscriber = connection;
  log.info('cache signals subscribed', { channels: Object.values(SIGNAL).length });
}

export async function stopSignals(): Promise<void> {
  const connection = subscriber;
  subscriber = null;
  if (!connection) return;

  try {
    await connection.unsubscribe();
  } catch {
    // The connection is closed by `closeRedis()` regardless.
  }
}

function channelFor(name: SignalName): string {
  return redisKey('signal', name);
}

function nameFor(channel: string): SignalName | null {
  const found = Object.values(SIGNAL).find((name) => channelFor(name) === channel);
  return found ?? null;
}

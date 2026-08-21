import { cacheDriver } from '../../config/index.js';
import { createModuleLogger } from '../logger/index.js';
import { getRedis, redisKey } from '../redis/index.js';

const log = createModuleLogger('cache');

/**
 * Shared key/value cache with a TTL.
 *
 * Redis when it is configured, a bounded in-process map when it is not. The two
 * are not equivalent and are not pretended to be: the map is per-instance, so a
 * value invalidated on one process stays warm on another. That is acceptable
 * only for values whose TTL is measured in seconds, which is the only thing this
 * cache is used for.
 *
 * Every operation swallows its own errors. A cache that can fail a request is
 * worse than no cache at all, so a Redis outage degrades to a miss.
 */
interface Entry {
  value: string;
  expiresAt: number;
}

const memory = new Map<string, Entry>();

/**
 * Ceiling on the in-process map. Without one, a cache keyed by a customer's
 * search text is a memory leak with a nice name. Eviction is oldest-inserted
 * first, which Map iteration order gives for free.
 */
const MEMORY_MAX_ENTRIES = 5_000;

export async function getJson<T>(key: string): Promise<T | null> {
  const raw = await readRaw(key);
  if (raw === null) return null;

  try {
    return JSON.parse(raw) as T;
  } catch {
    // A value written by an older shape of the code. Dropping it is the whole
    // repair: the caller recomputes and overwrites.
    return null;
  }
}

export async function setJson(key: string, value: unknown, ttlSeconds: number): Promise<void> {
  if (ttlSeconds <= 0) return;
  await writeRaw(key, JSON.stringify(value), ttlSeconds);
}

/**
 * Cache-aside in one call: return the cached value, or compute, store and
 * return it. The loader's failures are the caller's — only cache failures are
 * swallowed here.
 */
export async function remember<T>(
  key: string,
  ttlSeconds: number,
  loader: () => Promise<T>,
): Promise<T> {
  const cached = await getJson<T>(key);
  if (cached !== null) return cached;

  const value = await loader();
  await setJson(key, value, ttlSeconds);
  return value;
}

export async function forget(key: string): Promise<void> {
  const connection = getRedis();
  if (!connection) {
    memory.delete(redisKey(key));
    return;
  }

  try {
    await connection.del(redisKey(key));
  } catch (error) {
    log.warn('cache delete failed', { err: error });
  }
}

/**
 * Drops every key under a prefix — the knowledge base does this when an article
 * changes, because a suggestion cache is keyed by the customer's words and there
 * is no way to know which of them matched.
 *
 * `scan` rather than `keys`: `keys` blocks the server for the length of the
 * keyspace, and a support desk's Redis also holds the rate-limit counters.
 */
export async function forgetPrefix(prefix: string): Promise<void> {
  const pattern = `${redisKey(prefix)}*`;
  const connection = getRedis();

  if (!connection) {
    for (const key of memory.keys()) {
      if (key.startsWith(redisKey(prefix))) memory.delete(key);
    }
    return;
  }

  try {
    let cursor = '0';
    do {
      const [next, keys] = await connection.scan(cursor, 'MATCH', pattern, 'COUNT', 200);
      cursor = next;
      if (keys.length > 0) await connection.del(...keys);
    } while (cursor !== '0');
  } catch (error) {
    log.warn('cache prefix delete failed', { prefix, err: error });
  }
}

async function readRaw(key: string): Promise<string | null> {
  const namespaced = redisKey(key);
  const connection = getRedis();

  if (!connection) {
    const entry = memory.get(namespaced);
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) {
      memory.delete(namespaced);
      return null;
    }
    return entry.value;
  }

  try {
    return await connection.get(namespaced);
  } catch (error) {
    log.warn('cache read failed', { err: error });
    return null;
  }
}

async function writeRaw(key: string, value: string, ttlSeconds: number): Promise<void> {
  const namespaced = redisKey(key);
  const connection = getRedis();

  if (!connection) {
    if (memory.size >= MEMORY_MAX_ENTRIES) {
      const oldest = memory.keys().next();
      if (!oldest.done) memory.delete(oldest.value);
    }
    memory.set(namespaced, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
    return;
  }

  try {
    await connection.set(namespaced, value, 'EX', ttlSeconds);
  } catch (error) {
    log.warn('cache write failed', { err: error });
  }
}

/** Exposed for tests and for `resetDatabase()`, which invalidates everything. */
export function clearMemoryCache(): void {
  memory.clear();
}

export interface CacheStats {
  driver: typeof cacheDriver;
  memoryEntries: number;
}

export function cacheStats(): CacheStats {
  return { driver: cacheDriver, memoryEntries: memory.size };
}

import rateLimit, { ipKeyGenerator, type RateLimitRequestHandler } from 'express-rate-limit';
import { RedisStore } from 'rate-limit-redis';
import { env, OPERATIONAL_PATHS } from '../../config/index.js';
import { getRedis, redisKey } from '../../lib/redis/index.js';
import { AppError } from '../errors/index.js';
import { parseApiKey } from '../utils/crypto.js';

/**
 * Rate limiters, shared across instances when Redis is configured.
 *
 * Phase 6 changed only where the counters live. In-memory counters are correct
 * for one process and quietly generous for several: four instances behind a
 * load balancer give a caller four times the budget they were sold, which is
 * exactly the wrong direction for a limiter whose job is to make credential
 * guessing expensive.
 */
function storeFor(name: string): RedisStore | undefined {
  const connection = getRedis();
  if (!connection) return undefined;

  return new RedisStore({
    prefix: redisKey('ratelimit', name, ''),
    // The store speaks raw commands; ioredis exposes them through `call`.
    sendCommand: (...args: string[]) =>
      connection.call(args[0] as string, ...args.slice(1)) as Promise<never>,
  });
}

export function createRateLimiter(options: {
  name: string;
  windowMs: number;
  limit: number;
  skipOperational?: boolean;
  skip?: (req: Parameters<RateLimitRequestHandler>[0]) => boolean;
  keyGenerator?: (req: Parameters<RateLimitRequestHandler>[0]) => string;
}): RateLimitRequestHandler {
  const store = storeFor(options.name);

  return rateLimit({
    windowMs: options.windowMs,
    limit: options.limit,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    ...(store ? { store } : {}),
    // A Redis outage must not turn every request into a 500. The limit stops
    // being enforced until it comes back, which is the same trade the cache
    // makes and the opposite of taking the API down to protect it.
    passOnStoreError: true,
    ...(options.keyGenerator ? { keyGenerator: options.keyGenerator } : {}),
    skip: options.skipOperational
      ? (req) => (OPERATIONAL_PATHS as readonly string[]).includes(req.path)
      : options.skip,
    handler: (_req, _res, next) => {
      next(AppError.rateLimited());
    },
  });
}

/** Broad protection applied to the whole API. */
export const globalRateLimit = createRateLimiter({
  name: 'global',
  windowMs: env.RATE_LIMIT_WINDOW_MS,
  limit: env.RATE_LIMIT_MAX,
  skipOperational: true,
});

/**
 * Tight limiter for credential endpoints. Used from Phase 2 on `/auth/login`,
 * `/auth/password/forgot` and MFA verification.
 */
export const authRateLimit = createRateLimiter({
  name: 'auth',
  windowMs: env.AUTH_RATE_LIMIT_WINDOW_MS,
  limit: env.AUTH_RATE_LIMIT_MAX,
});

/**
 * A product system's own budget.
 *
 * Keyed on the API key's **prefix** — the non-secret handle the key format
 * exists to provide — so a shared Redis never holds anything replayable, and so
 * one integration's retry storm cannot consume the per-IP budget every other
 * caller behind the same NAT is sharing.
 *
 * Requests with no API key are skipped rather than lumped together: they are
 * already covered by the global limiter, and giving them a common key here
 * would make every browser share one product system's quota.
 */
export const apiKeyRateLimit = createRateLimiter({
  name: 'apikey',
  windowMs: env.API_KEY_RATE_LIMIT_WINDOW_MS,
  limit: env.API_KEY_RATE_LIMIT_MAX,
  skip: (req) => !req.get('x-api-key'),
  keyGenerator: (req) => {
    const parsed = parseApiKey(req.get('x-api-key') ?? '');
    // A malformed key is about to be rejected by `authenticate` anyway; the
    // shared bucket is there so a flood of them still costs something.
    return parsed ? `key:${parsed.prefix}` : ipKeyGenerator(req.ip ?? 'unknown');
  },
});

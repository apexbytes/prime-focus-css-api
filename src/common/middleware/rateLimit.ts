import rateLimit, { type RateLimitRequestHandler } from 'express-rate-limit';
import { env, OPERATIONAL_PATHS } from '../../config/index.js';
import { AppError } from '../errors/index.js';

/**
 * In-memory limiter. Correct for a single process; Phase 6 swaps the store for
 * Redis so limits hold across instances without touching call sites.
 */
function build(options: {
  windowMs: number;
  limit: number;
  skipOperational?: boolean;
}): RateLimitRequestHandler {
  return rateLimit({
    windowMs: options.windowMs,
    limit: options.limit,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    skip: options.skipOperational
      ? (req) => (OPERATIONAL_PATHS as readonly string[]).includes(req.path)
      : undefined,
    handler: (_req, _res, next) => {
      next(AppError.rateLimited());
    },
  });
}

/** Broad protection applied to the whole API. */
export const globalRateLimit = build({
  windowMs: env.RATE_LIMIT_WINDOW_MS,
  limit: env.RATE_LIMIT_MAX,
  skipOperational: true,
});

/**
 * Tight limiter for credential endpoints. Used from Phase 2 on `/auth/login`,
 * `/auth/password/forgot` and MFA verification.
 */
export const authRateLimit = build({ windowMs: 15 * 60 * 1000, limit: 10 });

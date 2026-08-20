import { createHash } from 'node:crypto';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { and, eq, lt } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { idempotencyKeys } from '../../db/models/idempotency-key.model.js';
import { IDEMPOTENCY_KEY_HEADER, IDEMPOTENCY_TTL_MS } from '../../config/index.js';
import { createModuleLogger } from '../../lib/logger/index.js';
import { AppError, ErrorCode } from '../errors/index.js';

const log = createModuleLogger('idempotency');

const MUTATING_METHODS = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);
const KEY_PATTERN = /^[\w.:-]{8,255}$/;

function hashBody(body: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(body ?? null))
    .digest('hex');
}

/**
 * Replays the original response for a repeated `Idempotency-Key`, so a retry
 * cannot create a second ticket or send a second email.
 *
 * Applied per-route (not globally) to the writes where duplication actually
 * costs something. The header is optional; requests without it pass straight
 * through.
 */
export function idempotency(ttlMs: number = IDEMPOTENCY_TTL_MS): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    const key = req.get(IDEMPOTENCY_KEY_HEADER);
    if (!key || !MUTATING_METHODS.has(req.method)) {
      next();
      return;
    }

    if (!KEY_PATTERN.test(key)) {
      next(
        AppError.badRequest(
          `${IDEMPOTENCY_KEY_HEADER} must be 8-255 characters of letters, digits, '.', ':', '-' or '_'`,
        ),
      );
      return;
    }

    void handle(req, res, next, key, ttlMs).catch(next);
  };
}

async function handle(
  req: Request,
  res: Response,
  next: NextFunction,
  key: string,
  ttlMs: number,
): Promise<void> {
  const scope = `${req.method} ${req.path}`;
  const requestHash = hashBody(req.body);
  const now = new Date();

  // Drop an expired record first so the key becomes reusable after its TTL.
  await db
    .delete(idempotencyKeys)
    .where(
      and(
        eq(idempotencyKeys.scope, scope),
        eq(idempotencyKeys.key, key),
        lt(idempotencyKeys.expiresAt, now),
      ),
    );

  const claimed = await db
    .insert(idempotencyKeys)
    .values({ key, scope, requestHash, expiresAt: new Date(now.getTime() + ttlMs) })
    .onConflictDoNothing()
    .returning({ id: idempotencyKeys.id });

  if (claimed.length === 0) {
    await replay(req, res, next, { scope, key, requestHash });
    return;
  }

  captureResponse(req, res, { scope, key });
  next();
}

async function replay(
  req: Request,
  res: Response,
  next: NextFunction,
  ref: { scope: string; key: string; requestHash: string },
): Promise<void> {
  const [existing] = await db
    .select()
    .from(idempotencyKeys)
    .where(and(eq(idempotencyKeys.scope, ref.scope), eq(idempotencyKeys.key, ref.key)))
    .limit(1);

  if (!existing) {
    // Deleted between the insert conflict and this read; let the caller retry.
    next(AppError.conflict('Idempotency key state changed, please retry'));
    return;
  }

  if (existing.requestHash !== ref.requestHash) {
    next(
      new AppError(
        422,
        ErrorCode.IDEMPOTENCY_KEY_REUSED,
        'This Idempotency-Key was already used with a different request body',
      ),
    );
    return;
  }

  if (existing.completedAt === null || existing.statusCode === null) {
    next(
      new AppError(
        409,
        ErrorCode.IDEMPOTENCY_KEY_IN_PROGRESS,
        'The original request is still being processed',
      ),
    );
    return;
  }

  log.info('replaying idempotent response', { scope: ref.scope, status: existing.statusCode });
  res.setHeader('idempotent-replay', 'true');
  res.status(existing.statusCode).json(existing.responseBody);
}

/**
 * Records the outcome once the response is written. A 5xx releases the key so
 * the client's retry gets a real attempt rather than a replayed failure.
 */
function captureResponse(req: Request, res: Response, ref: { scope: string; key: string }): void {
  const originalJson = res.json.bind(res);
  let capturedBody: unknown;

  res.json = (body: unknown) => {
    capturedBody = body;
    return originalJson(body);
  };

  res.on('finish', () => {
    const persist =
      res.statusCode >= 500
        ? db
            .delete(idempotencyKeys)
            .where(and(eq(idempotencyKeys.scope, ref.scope), eq(idempotencyKeys.key, ref.key)))
        : db
            .update(idempotencyKeys)
            .set({
              statusCode: res.statusCode,
              responseBody: capturedBody ?? null,
              completedAt: new Date(),
            })
            .where(and(eq(idempotencyKeys.scope, ref.scope), eq(idempotencyKeys.key, ref.key)));

    void Promise.resolve(persist).catch((error: unknown) => {
      log.error('failed to record idempotent response', { err: error, scope: ref.scope });
    });
  });
}

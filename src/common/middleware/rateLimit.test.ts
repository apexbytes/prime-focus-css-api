import express, { type Express } from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { correlationId } from './correlationId.js';
import { errorHandler } from './errorHandler.js';
import { createRateLimiter } from './rateLimit.js';

function app(limit: number, skipOperational = false): Express {
  const instance = express();
  instance.set('trust proxy', 1);
  instance.use(correlationId);
  instance.use(createRateLimiter({ windowMs: 60_000, limit, skipOperational }));
  instance.get('/healthz', (_req, res) => res.json({ ok: true }));
  instance.get('/thing', (_req, res) => res.json({ ok: true }));
  instance.use(errorHandler);
  return instance;
}

describe('rate limiter', () => {
  it('allows requests up to the limit, then refuses', async () => {
    const server = app(2);

    await request(server).get('/thing').expect(200);
    await request(server).get('/thing').expect(200);

    const blocked = await request(server).get('/thing');
    expect(blocked.status).toBe(429);
  });

  it('refuses with the standard error envelope, not the library default', async () => {
    const server = app(1);
    await request(server).get('/thing').expect(200);

    const blocked = await request(server).get('/thing');
    expect(blocked.body).toMatchObject({
      success: false,
      error: { code: 'RATE_LIMITED', message: 'Too many requests' },
    });
    expect(blocked.body.meta.requestId).toBeTypeOf('string');
  });

  it('advertises the budget in draft-8 headers', async () => {
    const response = await request(app(5)).get('/thing');
    expect(response.headers['ratelimit-policy'] ?? response.headers['ratelimit']).toBeDefined();
  });

  it('never throttles the health probes', async () => {
    // A traffic spike must not make the orchestrator think the process is dead.
    const server = app(1, true);

    await request(server).get('/healthz').expect(200);
    await request(server).get('/healthz').expect(200);
    await request(server).get('/healthz').expect(200);
  });
});

import express, { type Express } from 'express';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, pool } from '../../db/client.js';
import { idempotencyKeys } from '../../db/models/idempotency-key.model.js';
import { correlationId } from './correlationId.js';
import { errorHandler } from './errorHandler.js';
import { idempotency } from './idempotency.js';

/**
 * Integration spec: the replay guarantee only means anything against real
 * Postgres constraints, so this runs when a migrated database is available
 * (`RUN_DB_TESTS=1`) and is skipped otherwise.
 */
const enabled = process.env.RUN_DB_TESTS === '1';

function app(handler: express.RequestHandler): Express {
  const instance = express();
  instance.use(correlationId);
  instance.use(express.json());
  instance.post('/tickets', idempotency(), handler);
  instance.use(errorHandler);
  return instance;
}

describe.runIf(enabled)('idempotency middleware', () => {
  beforeEach(async () => {
    await db.delete(idempotencyKeys);
  });

  it('passes through when no key is supplied', async () => {
    const handler = vi.fn((_req, res) => res.status(201).json({ id: 'first' }));
    const server = app(handler);

    await request(server).post('/tickets').send({ subject: 'a' }).expect(201);
    await request(server).post('/tickets').send({ subject: 'a' }).expect(201);

    expect(handler).toHaveBeenCalledTimes(2);
  });

  it('runs the handler once and replays the recorded response', async () => {
    let calls = 0;
    const server = app((_req, res) => {
      calls += 1;
      res.status(201).json({ id: `ticket-${calls}` });
    });

    const first = await request(server)
      .post('/tickets')
      .set('idempotency-key', 'mobile-retry-0001')
      .send({ subject: 'Card declined' });

    const second = await request(server)
      .post('/tickets')
      .set('idempotency-key', 'mobile-retry-0001')
      .send({ subject: 'Card declined' });

    expect(calls).toBe(1);
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.body).toEqual(first.body);
    expect(second.headers['idempotent-replay']).toBe('true');
  });

  it('rejects the same key used with a different body', async () => {
    const server = app((_req, res) => res.status(201).json({ id: 'x' }));

    await request(server)
      .post('/tickets')
      .set('idempotency-key', 'reused-key-0001')
      .send({ subject: 'one' })
      .expect(201);

    const conflict = await request(server)
      .post('/tickets')
      .set('idempotency-key', 'reused-key-0001')
      .send({ subject: 'different' });

    expect(conflict.status).toBe(422);
    expect(conflict.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  it('scopes keys per endpoint', async () => {
    const instance = express();
    instance.use(correlationId);
    instance.use(express.json());
    instance.post('/tickets', idempotency(), (_req, res) =>
      res.status(201).json({ on: 'tickets' }),
    );
    instance.post('/messages', idempotency(), (_req, res) =>
      res.status(201).json({ on: 'messages' }),
    );
    instance.use(errorHandler);

    const a = await request(instance)
      .post('/tickets')
      .set('idempotency-key', 'shared-key-01')
      .send({});
    const b = await request(instance)
      .post('/messages')
      .set('idempotency-key', 'shared-key-01')
      .send({});

    expect(a.body).toEqual({ on: 'tickets' });
    expect(b.body).toEqual({ on: 'messages' });
  });

  it('releases the key after a 5xx so the retry gets a real attempt', async () => {
    let calls = 0;
    const server = app((_req, res, next) => {
      calls += 1;
      if (calls === 1) {
        next(new Error('transient failure'));
        return;
      }
      res.status(201).json({ id: 'recovered' });
    });

    const failed = await request(server)
      .post('/tickets')
      .set('idempotency-key', 'transient-key-01')
      .send({ subject: 'a' });
    expect(failed.status).toBe(500);

    // The 'finish' listener deletes the row after the response is flushed.
    await vi.waitFor(async () => {
      const rows = await db
        .select()
        .from(idempotencyKeys)
        .where(eq(idempotencyKeys.key, 'transient-key-01'));
      expect(rows).toHaveLength(0);
    });

    const retried = await request(server)
      .post('/tickets')
      .set('idempotency-key', 'transient-key-01')
      .send({ subject: 'a' });

    expect(retried.status).toBe(201);
    expect(retried.body).toEqual({ id: 'recovered' });
  });

  it('rejects a malformed key', async () => {
    const server = app((_req, res) => res.status(201).json({}));

    const response = await request(server)
      .post('/tickets')
      .set('idempotency-key', 'short')
      .send({});

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('BAD_REQUEST');
  });

  it('allows reuse once the record has expired', async () => {
    let calls = 0;
    const server = express();
    server.use(correlationId);
    server.use(express.json());
    // Zero TTL: every record is already expired when the next request arrives.
    server.post('/tickets', idempotency(0), (_req, res) => {
      calls += 1;
      res.status(201).json({ id: calls });
    });
    server.use(errorHandler);

    await request(server)
      .post('/tickets')
      .set('idempotency-key', 'expiring-key-1')
      .send({})
      .expect(201);
    const second = await request(server)
      .post('/tickets')
      .set('idempotency-key', 'expiring-key-1')
      .send({});

    expect(second.body.id).toBe(2);
  });
});

if (enabled) {
  // Release the pool so vitest can exit cleanly.
  afterAll(async () => {
    await pool.end();
  });
}

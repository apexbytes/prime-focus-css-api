import express, { type Express } from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { AppError } from '../errors/index.js';
import { correlationId } from './correlationId.js';
import { errorHandler } from './errorHandler.js';
import { notFound } from './notFound.js';

function appThatThrows(thrown: unknown): Express {
  const app = express();
  app.use(correlationId);
  app.use(express.json({ limit: '1kb' }));
  app.post('/boom', () => {
    throw thrown;
  });
  app.post('/echo', (_req, res) => res.status(201).json({ ok: true }));
  app.use(notFound);
  app.use(errorHandler);
  return app;
}

describe('errorHandler', () => {
  it('renders an AppError in the standard failure envelope', async () => {
    const response = await request(appThatThrows(AppError.notFound('Ticket not found'))).post(
      '/boom',
    );

    expect(response.status).toBe(404);
    expect(response.body).toMatchObject({
      success: false,
      error: { code: 'NOT_FOUND', message: 'Ticket not found' },
    });
    expect(response.body.meta.requestId).toBeTypeOf('string');
  });

  it('turns a ZodError into a 400 with field-level details', async () => {
    const schema = z.object({ priority: z.enum(['low', 'high']) });
    const thrown = (() => {
      try {
        schema.parse({ priority: 'urgent' });
      } catch (error) {
        return error;
      }
    })();

    const response = await request(appThatThrows(thrown)).post('/boom');

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('VALIDATION_ERROR');
    expect(response.body.error.details[0].field).toBe('priority');
  });

  it('maps a Postgres unique violation to 409 without leaking the driver message', async () => {
    const pgError = Object.assign(
      new Error('duplicate key value violates unique constraint "users_email_uq"'),
      {
        code: '23505',
      },
    );

    const response = await request(appThatThrows(pgError)).post('/boom');

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('UNIQUE_VIOLATION');
    expect(response.body.error.message).not.toContain('users_email_uq');
  });

  it('maps an unreachable dependency to 503', async () => {
    const connError = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5432'), {
      code: 'ECONNREFUSED',
    });

    const response = await request(appThatThrows(connError)).post('/boom');

    expect(response.status).toBe(503);
    expect(response.body.error.code).toBe('DEPENDENCY_FAILURE');
  });

  it('reports an unknown throw as 500 INTERNAL_ERROR', async () => {
    const response = await request(appThatThrows(new Error('kaboom'))).post('/boom');

    expect(response.status).toBe(500);
    expect(response.body.error.code).toBe('INTERNAL_ERROR');
  });

  it('rejects malformed JSON bodies with 400', async () => {
    const response = await request(appThatThrows(new Error('unused')))
      .post('/echo')
      .set('content-type', 'application/json')
      .send('{"broken":');

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('BAD_REQUEST');
  });

  it('rejects oversized bodies with 413', async () => {
    const response = await request(appThatThrows(new Error('unused')))
      .post('/echo')
      .send({ blob: 'x'.repeat(2048) });

    expect(response.status).toBe(413);
    expect(response.body.error.code).toBe('PAYLOAD_TOO_LARGE');
  });

  it('answers an unmatched route with the same envelope', async () => {
    const response = await request(appThatThrows(new Error('unused'))).post('/nowhere');

    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe('NOT_FOUND');
    expect(response.body.error.message).toContain('/nowhere');
  });
});

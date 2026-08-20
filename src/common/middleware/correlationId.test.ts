import express, { type Express } from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { getRequestId } from '../context/request-context.js';
import { correlationId } from './correlationId.js';

function app(): Express {
  const instance = express();
  instance.use(correlationId);
  instance.get('/ping', (req, res) => {
    // The ambient id must match the request-bound one, or the logger would
    // attribute lines to the wrong request.
    res.json({ requestId: req.requestId, ambient: getRequestId() });
  });
  return instance;
}

describe('correlationId', () => {
  it('generates an id and echoes it in the response header', async () => {
    const response = await request(app()).get('/ping');

    expect(response.body.requestId).toBeTypeOf('string');
    expect(response.headers['x-request-id']).toBe(response.body.requestId);
    expect(response.body.ambient).toBe(response.body.requestId);
  });

  it('adopts a caller-supplied id so traces span services', async () => {
    const response = await request(app()).get('/ping').set('x-request-id', 'gateway-abc-123');

    expect(response.body.requestId).toBe('gateway-abc-123');
  });

  it('rejects an unsafe inbound id rather than reflecting it into logs', async () => {
    const response = await request(app())
      .get('/ping')
      .set('x-request-id', 'bad id with spaces <script>');

    expect(response.body.requestId).not.toContain('script');
    expect(response.body.requestId).toMatch(/^[\w-]{36}$/);
  });

  it('rejects an over-long inbound id', async () => {
    const response = await request(app()).get('/ping').set('x-request-id', 'a'.repeat(200));

    expect(response.body.requestId).toHaveLength(36);
  });
});

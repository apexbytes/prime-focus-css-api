import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { beginShutdown, resetLifecycle } from '../../common/utils/lifecycle.js';
import { createApp } from '../../app.js';

// The probe must not need a live database to be unit-testable.
const { checkDatabaseConnection } = vi.hoisted(() => ({
  checkDatabaseConnection: vi.fn(),
}));

vi.mock('../../db/client.js', () => ({
  checkDatabaseConnection,
  db: {},
  pool: { on: vi.fn() },
  closeDatabase: vi.fn(),
}));

afterEach(() => {
  resetLifecycle();
});

describe('GET /healthz', () => {
  it('reports liveness without touching dependencies', async () => {
    const response = await request(createApp()).get('/healthz');

    expect(response.status).toBe(200);
    expect(response.body.data.status).toBe('ok');
    expect(response.body.data.service).toBe('prime-focus-css');
    expect(response.body.data.uptimeSeconds).toBeGreaterThanOrEqual(0);
    expect(checkDatabaseConnection).not.toHaveBeenCalled();
  });
});

describe('GET /readyz', () => {
  it('returns 200 when every dependency is reachable', async () => {
    checkDatabaseConnection.mockResolvedValue({ ok: true, latencyMs: 3 });

    const response = await request(createApp()).get('/readyz');

    expect(response.status).toBe(200);
    expect(response.body.data.status).toBe('ok');
    expect(response.body.data.dependencies).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'postgres', state: 'ok' })]),
    );
  });

  it('returns 503 and names the failing dependency', async () => {
    checkDatabaseConnection.mockResolvedValue({
      ok: false,
      latencyMs: 3000,
      error: 'database check timed out after 3000ms',
    });

    const response = await request(createApp()).get('/readyz');

    expect(response.status).toBe(503);
    expect(response.body.error.code).toBe('SERVICE_UNAVAILABLE');
    expect(response.body.error.details).toEqual([
      { field: 'postgres', issue: 'database check timed out after 3000ms' },
    ]);
  });

  it('fails readiness as soon as shutdown starts, while still serving traffic', async () => {
    checkDatabaseConnection.mockResolvedValue({ ok: true, latencyMs: 2 });
    beginShutdown();

    const [ready, alive] = await Promise.all([
      request(createApp()).get('/readyz'),
      request(createApp()).get('/healthz'),
    ]);

    expect(ready.status).toBe(503);
    expect(ready.body.error.details).toEqual([{ field: 'process', issue: 'shutting down' }]);
    // Liveness must stay green during a drain or the orchestrator kills the
    // container mid-request instead of letting it finish.
    expect(alive.status).toBe(200);
  });

  it('marks later-phase dependencies as not_configured rather than failing', async () => {
    checkDatabaseConnection.mockResolvedValue({ ok: true, latencyMs: 1 });

    const response = await request(createApp()).get('/readyz');
    const names = response.body.data.dependencies.map((d: { name: string }) => d.name);

    expect(names).toEqual(expect.arrayContaining(['queue', 'resend']));
    expect(response.body.data.status).toBe('ok');
  });
});

describe('GET /api/v1', () => {
  it('describes the API surface', async () => {
    const response = await request(createApp()).get('/api/v1');

    expect(response.status).toBe(200);
    expect(response.body.data.apiVersion).toBe('v1');
    expect(response.body.meta.requestId).toBeTypeOf('string');
  });
});

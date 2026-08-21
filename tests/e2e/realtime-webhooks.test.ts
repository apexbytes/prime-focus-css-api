import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { eq } from 'drizzle-orm';
import { io as connect, type Socket } from 'socket.io-client';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { closeDatabase, db } from '../../src/db/client.js';
import { startRealtime } from '../../src/modules/realtime/index.js';
import { webhookDeliveries } from '../../src/modules/webhook/webhook.model.js';
import { verify } from '../../src/modules/webhook/webhook.signature.js';
import { stopSocketServer } from '../../src/lib/socket/index.js';
import { resetDatabase } from '../helpers/db.js';
import {
  bearer,
  createActiveUser,
  grantProduct,
  productIdFor,
  signIn,
} from '../helpers/identity.js';

/**
 * Phase 6 end to end: an event leaving the system under a signature a receiver
 * can check, and two agents discovering they are both in the same ticket.
 *
 * `QUEUE_DRIVER` is `inline` under test, so `webhook.deliver` runs inside the
 * request that raised the ticket — which is what makes the delivery assertable
 * in the next line rather than eventually, and exercises the real job handler.
 */
const enabled = process.env.RUN_DB_TESTS === '1';
const app = createApp();

const ADMIN = 'rt.admin@primefocus.co.zw';
const AGENT = 'rt.agent@primefocus.co.zw';
const OTHER_AGENT = 'rt.other@primefocus.co.zw';
const CUSTOMER = 'rudo@example.co.zw';

/** A partner system, standing in for whatever a subscription points at. */
interface Receiver {
  url: string;
  received: {
    body: string;
    signature: string;
    timestamp: number;
    eventType: string;
    eventId: string;
  }[];
  /** Answered to every request until changed. */
  status: number;
  close: () => Promise<void>;
}

async function startReceiver(): Promise<Receiver> {
  const state: Pick<Receiver, 'received' | 'status'> = { received: [], status: 200 };

  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk: Buffer) => (body += chunk.toString('utf8')));
    req.on('end', () => {
      state.received.push({
        body,
        signature: String(req.headers['x-pf-signature'] ?? ''),
        timestamp: Number(req.headers['x-pf-timestamp'] ?? 0),
        eventType: String(req.headers['x-pf-event'] ?? ''),
        eventId: String(req.headers['x-pf-event-id'] ?? ''),
      });
      res.writeHead(state.status).end('ok');
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}/hook`,
    get received() {
      return state.received;
    },
    get status() {
      return state.status;
    },
    set status(value: number) {
      state.status = value;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

describe.runIf(enabled)('realtime and outbound webhooks', () => {
  let adminToken: string;
  let agentToken: string;
  let otherToken: string;
  let agentId: string;
  let walletId: string;
  let receiver: Receiver;

  beforeAll(async () => {
    receiver = await startReceiver();
  });

  afterAll(async () => {
    await receiver.close();
    await closeDatabase();
  });

  beforeEach(async () => {
    await resetDatabase();
    receiver.received.length = 0;
    receiver.status = 200;

    await createActiveUser({ email: ADMIN, roleCode: 'admin', fullName: 'Rutendo Admin' });
    const agent = await createActiveUser({
      email: AGENT,
      roleCode: 'tier1_agent',
      fullName: 'Chipo Agent',
    });
    await createActiveUser({
      email: OTHER_AGENT,
      roleCode: 'tier1_agent',
      fullName: 'Tapiwa Agent',
    });

    agentId = agent.id;
    walletId = await productIdFor('pf_wallet');
    await grantProduct(agent.id, 'pf_wallet');

    adminToken = (await signIn(app, ADMIN)).accessToken;
    agentToken = (await signIn(app, AGENT)).accessToken;
    otherToken = (await signIn(app, OTHER_AGENT)).accessToken;
  });

  // -- subscriptions ---------------------------------------------------------

  it('returns the signing secret once, and never again', async () => {
    const created = await request(app)
      .post('/api/v1/webhook-subscriptions')
      .set(...bearer(adminToken))
      .send({
        name: 'Wallet ledger',
        url: receiver.url,
        eventTypes: ['ticket.created'],
        productId: walletId,
      });

    expect(created.status).toBe(201);
    expect(created.body.data.secret).toEqual(expect.any(String));

    const read = await request(app)
      .get(`/api/v1/webhook-subscriptions/${created.body.data.id}`)
      .set(...bearer(adminToken));

    expect(read.status).toBe(200);
    expect(read.body.data.secret).toBeUndefined();
  });

  it('refuses an event name that is not in the catalogue', async () => {
    const response = await request(app)
      .post('/api/v1/webhook-subscriptions')
      .set(...bearer(adminToken))
      .send({ name: 'Typo', url: receiver.url, eventTypes: ['ticket.exploded'] });

    expect(response.status).toBe(400);
  });

  it('is refused to an agent, who cannot create an egress for ticket data', async () => {
    const response = await request(app)
      .post('/api/v1/webhook-subscriptions')
      .set(...bearer(agentToken))
      .send({ name: 'Mine', url: receiver.url, eventTypes: ['ticket.created'] });

    expect(response.status).toBe(403);
  });

  // -- delivery --------------------------------------------------------------

  it('delivers a ticket event, signed, and logs the attempt', async () => {
    const subscription = await request(app)
      .post('/api/v1/webhook-subscriptions')
      .set(...bearer(adminToken))
      .send({
        name: 'Wallet ledger',
        url: receiver.url,
        eventTypes: ['ticket.created', 'ticket.status_changed'],
        productId: walletId,
      });

    const secret = subscription.body.data.secret as string;

    const ticket = await request(app)
      .post('/api/v1/tickets')
      .set(...bearer(adminToken))
      .send({
        productId: walletId,
        subject: 'Transfer stuck as pending',
        body: 'I sent money two hours ago and it has not arrived.',
        channel: 'web_form',
        customerEmail: CUSTOMER,
        customerName: 'Rudo Moyo',
      });

    expect(ticket.status).toBe(201);

    expect(receiver.received).toHaveLength(1);
    const delivered = receiver.received[0]!;

    expect(delivered.eventType).toBe('ticket.created');
    expect(
      verify({
        body: delivered.body,
        timestamp: delivered.timestamp,
        secret,
        presented: delivered.signature,
      }),
    ).toBe(true);

    const payload = JSON.parse(delivered.body) as {
      id: string;
      type: string;
      ticket: { reference: string; subject: string };
    };
    expect(payload.type).toBe('ticket.created');
    expect(payload.ticket.reference).toBe(ticket.body.data.reference);
    // The receiver's deduplication key is the event id in the header.
    expect(payload.id).toBe(delivered.eventId);

    const log = await request(app)
      .get(`/api/v1/webhook-subscriptions/${subscription.body.data.id}/deliveries`)
      .set(...bearer(adminToken));

    expect(log.status).toBe(200);
    expect(log.body.data).toHaveLength(1);
    expect(log.body.data[0].status).toBe('succeeded');
    expect(log.body.data[0].attempts).toBe(1);
  });

  it('sends only the events a subscription asked for', async () => {
    await request(app)
      .post('/api/v1/webhook-subscriptions')
      .set(...bearer(adminToken))
      .send({ name: 'Resolutions only', url: receiver.url, eventTypes: ['ticket.resolved'] });

    const ticket = await request(app)
      .post('/api/v1/tickets')
      .set(...bearer(adminToken))
      .send({
        productId: walletId,
        subject: 'Card declined',
        body: 'My card was declined at the till.',
        channel: 'web_form',
        customerEmail: CUSTOMER,
      });

    expect(receiver.received).toHaveLength(0);

    await request(app)
      .patch(`/api/v1/tickets/${ticket.body.data.id}`)
      .set(...bearer(adminToken))
      .send({ status: 'resolved' });

    expect(receiver.received).toHaveLength(1);
    expect(receiver.received[0]!.eventType).toBe('ticket.resolved');
  });

  it('scopes a subscription to its product', async () => {
    await request(app)
      .post('/api/v1/webhook-subscriptions')
      .set(...bearer(adminToken))
      .send({
        name: 'Lending only',
        url: receiver.url,
        eventTypes: ['ticket.created'],
        productId: await productIdFor('pf_lending'),
      });

    await request(app)
      .post('/api/v1/tickets')
      .set(...bearer(adminToken))
      .send({
        productId: walletId,
        subject: 'Wallet question',
        body: 'Nothing to do with lending.',
        channel: 'web_form',
        customerEmail: CUSTOMER,
      });

    expect(receiver.received).toHaveLength(0);
  });

  it('records a rejection and leaves the delivery redeliverable', async () => {
    await request(app)
      .post('/api/v1/webhook-subscriptions')
      .set(...bearer(adminToken))
      .send({ name: 'Broken', url: receiver.url, eventTypes: ['ticket.created'] });

    receiver.status = 500;

    await request(app)
      .post('/api/v1/tickets')
      .set(...bearer(adminToken))
      .send({
        productId: walletId,
        subject: 'Statement missing',
        body: 'My March statement never arrived.',
        channel: 'web_form',
        customerEmail: CUSTOMER,
      });

    const [failed] = await db.select().from(webhookDeliveries);
    expect(failed?.status).toBe('pending');
    expect(failed?.responseStatus).toBe(500);

    receiver.status = 200;
    receiver.received.length = 0;

    const redelivered = await request(app)
      .post(`/api/v1/webhook-deliveries/${failed!.id}/redeliver`)
      .set(...bearer(adminToken));

    expect(redelivered.status).toBe(200);
    expect(receiver.received).toHaveLength(1);

    const [settled] = await db
      .select()
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.id, failed!.id));
    expect(settled?.status).toBe('succeeded');
    // The same event id, re-sent: a redelivery is the original event again, not
    // a new one describing the present.
    expect(settled?.eventId).toBe(failed!.eventId);
  });

  it('never puts a message body in a webhook payload', async () => {
    await request(app)
      .post('/api/v1/webhook-subscriptions')
      .set(...bearer(adminToken))
      .send({ name: 'Messages', url: receiver.url, eventTypes: ['ticket.message_created'] });

    const ticket = await request(app)
      .post('/api/v1/tickets')
      .set(...bearer(adminToken))
      .send({
        productId: walletId,
        subject: 'Fraud on my account',
        body: 'Somebody used my card.',
        channel: 'web_form',
        customerEmail: CUSTOMER,
      });

    const secretNote = 'Internal: customer is under investigation by the fraud team.';
    await request(app)
      .post(`/api/v1/tickets/${ticket.body.data.id}/messages`)
      .set(...bearer(adminToken))
      .send({ body: secretNote, visibility: 'internal' });

    expect(receiver.received).toHaveLength(1);
    expect(receiver.received[0]!.body).not.toContain('under investigation');
    expect(JSON.parse(receiver.received[0]!.body).data.visibility).toBe('internal');
  });

  // -- ticket locks ----------------------------------------------------------

  it('hands the lock to the first agent and names them to the second', async () => {
    const ticket = await request(app)
      .post('/api/v1/tickets')
      .set(...bearer(adminToken))
      .send({
        productId: walletId,
        subject: 'Two agents, one ticket',
        body: 'Please help.',
        channel: 'web_form',
        customerEmail: CUSTOMER,
      });

    const ticketId = ticket.body.data.id as string;

    const first = await request(app)
      .post(`/api/v1/tickets/${ticketId}/lock`)
      .set(...bearer(agentToken));

    expect(first.status).toBe(200);
    expect(first.body.data.acquired).toBe(true);
    expect(first.body.data.holder.userId).toBe(agentId);

    // The second agent has no access to this product, so the ticket does not
    // exist as far as they are concerned — a lock must not leak that it does.
    const outsider = await request(app)
      .get(`/api/v1/tickets/${ticketId}/lock`)
      .set(...bearer(otherToken));
    expect(outsider.status).toBe(404);

    const admin = await request(app)
      .get(`/api/v1/tickets/${ticketId}/lock`)
      .set(...bearer(adminToken));

    expect(admin.body.data.acquired).toBe(false);
    expect(admin.body.data.holder.fullName).toBe('Chipo Agent');

    // Releasing is idempotent and only ever releases your own.
    const released = await request(app)
      .delete(`/api/v1/tickets/${ticketId}/lock`)
      .set(...bearer(agentToken));

    expect(released.body.data.holder).toBeNull();
  });

  it('counts a product queue live', async () => {
    await request(app)
      .post('/api/v1/tickets')
      .set(...bearer(adminToken))
      .send({
        productId: walletId,
        subject: 'One in the queue',
        body: 'Waiting.',
        channel: 'web_form',
        customerEmail: CUSTOMER,
      });

    const counts = await request(app)
      .get(`/api/v1/realtime/queue-counts?productId=${walletId}`)
      .set(...bearer(agentToken));

    expect(counts.status).toBe(200);
    expect(counts.body.data.open).toBe(1);
    expect(counts.body.data.unassigned).toBe(1);
  });

  // -- the websocket itself --------------------------------------------------

  describe('over a websocket', () => {
    let server: Server;
    let origin: string;
    const sockets: Socket[] = [];

    beforeEach(async () => {
      server = createServer(app);
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      await startRealtime(server);
      origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    });

    const open = (token: string): Promise<Socket> =>
      new Promise((resolve, reject) => {
        const socket = connect(origin, {
          path: '/realtime',
          auth: { token },
          transports: ['websocket'],
          reconnection: false,
        });
        sockets.push(socket);
        socket.on('connect', () => resolve(socket));
        socket.on('connect_error', reject);
      });

    const emit = <T>(socket: Socket, event: string, payload: unknown): Promise<T> =>
      new Promise((resolve, reject) => {
        socket.emit(event, payload, (response: { ok: boolean; data?: T; error?: string }) => {
          if (response.ok) resolve(response.data as T);
          else reject(new Error(response.error));
        });
      });

    afterEach(async () => {
      for (const socket of sockets.splice(0)) socket.disconnect();
      stopSocketServer();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });

    it('refuses a connection with no credential', async () => {
      await expect(open('not-a-token')).rejects.toThrow();
    });

    it('tells everyone in the ticket room who took the lock', async () => {
      const ticket = await request(app)
        .post('/api/v1/tickets')
        .set(...bearer(adminToken))
        .send({
          productId: walletId,
          subject: 'Live collision',
          body: 'Two people are about to answer this.',
          channel: 'web_form',
          customerEmail: CUSTOMER,
        });

      const ticketId = ticket.body.data.id as string;

      const watcher = await open(adminToken);
      const worker = await open(agentToken);

      await emit(watcher, 'ticket:subscribe', { ticketId });
      await emit(worker, 'ticket:subscribe', { ticketId });

      const announced = new Promise<{ holder: { fullName: string } | null }>((resolve) => {
        watcher.on('ticket:lock', resolve);
      });

      const state = await emit<{ acquired: boolean }>(worker, 'ticket:lock', { ticketId });
      expect(state.acquired).toBe(true);

      const event = await announced;
      expect(event.holder?.fullName).toBe('Chipo Agent');

      // And the lock is released the moment the connection drops, rather than
      // when it expires.
      const cleared = new Promise<{ holder: unknown }>((resolve) => {
        watcher.on('ticket:lock', resolve);
      });
      worker.disconnect();
      expect((await cleared).holder).toBeNull();
    });

    it('refuses to subscribe to a ticket the agent cannot see', async () => {
      const ticket = await request(app)
        .post('/api/v1/tickets')
        .set(...bearer(adminToken))
        .send({
          productId: walletId,
          subject: 'Not yours',
          body: 'Private.',
          channel: 'web_form',
          customerEmail: CUSTOMER,
        });

      const outsider = await open(otherToken);
      await expect(
        emit(outsider, 'ticket:subscribe', { ticketId: ticket.body.data.id }),
      ).rejects.toThrow(/not found/i);
    });
  });
});

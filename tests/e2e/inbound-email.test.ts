import { createHmac } from 'node:crypto';
import request from 'supertest';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createApp } from '../../src/app.js';
import { closeDatabase, db } from '../../src/db/client.js';
import { readOutbox } from '../../src/lib/resend/index.js';
import { inboundEmails } from '../../src/modules/email/email.model.js';
import * as emailService from '../../src/modules/email/email.service.js';
import type {
  FetchedInboundEmail,
  InboundWebhookEvent,
} from '../../src/modules/email/email.types.js';
import { resetDatabase } from '../helpers/db.js';
import { bearer, createActiveUser, grantProduct, signIn } from '../helpers/identity.js';

const enabled = process.env.RUN_DB_TESTS === '1';
const app = createApp();

const AGENT = 'wallet.agent@primefocus.co.zw';
const CUSTOMER = 'chipo@example.co.zw';
const WALLET_INBOX = 'wallet@support.primefocus.co.zw';

let counter = 0;

/**
 * Resend's webhook carries metadata only, so the pipeline is exercised by
 * posting the envelope and stubbing the body retrieval — which is exactly the
 * shape of the real two-step contract.
 */
function envelope(overrides: Partial<InboundWebhookEvent['data']> = {}): InboundWebhookEvent {
  counter += 1;
  return {
    type: 'email.received',
    created_at: new Date().toISOString(),
    data: {
      email_id: `re_inbound_${counter}`,
      created_at: new Date().toISOString(),
      from: `Chipo Nyoni <${CUSTOMER}>`,
      to: [WALLET_INBOX],
      received_for: [WALLET_INBOX],
      message_id: `<inbound-${counter}@example.co.zw>`,
      subject: 'My transfer has not arrived',
      ...overrides,
    },
  };
}

function stubBody(body: Partial<FetchedInboundEmail>): void {
  emailService.__setInboundFetcher(async () =>
    Promise.resolve({
      text: 'I sent money two hours ago and it is still missing.',
      html: null,
      headers: { from: `Chipo Nyoni <${CUSTOMER}>` },
      subject: 'My transfer has not arrived',
      from: CUSTOMER,
      ...body,
    }),
  );
}

const WEBHOOK_SECRET = process.env.RESEND_WEBHOOK_SECRET ?? '';

/**
 * Signs the way Svix does: HMAC-SHA256 over `id.timestamp.body` with the secret
 * decoded from base64. Computed for real rather than stubbed, so these tests
 * exercise the actual verification path.
 */
function svixSignature(id: string, timestamp: string, body: string): string {
  const key = Buffer.from(WEBHOOK_SECRET.replace(/^whsec_/, ''), 'base64');
  return `v1,${createHmac('sha256', key).update(`${id}.${timestamp}.${body}`).digest('base64')}`;
}

/** Delivers an envelope and waits for the fire-and-forget processing to settle. */
async function deliver(event: InboundWebhookEvent) {
  const id = `msg_${event.data.email_id}`;
  const timestamp = String(Math.floor(Date.now() / 1000));
  // The exact bytes matter: the signature covers them, so the body is
  // serialised once and sent as a string.
  const body = JSON.stringify(event);

  const response = await request(app)
    .post('/api/v1/webhooks/resend/inbound')
    .set('content-type', 'application/json')
    .set('svix-id', id)
    .set('svix-timestamp', timestamp)
    .set('svix-signature', svixSignature(id, timestamp, body))
    .send(body);

  if (response.status === 202 && response.body.data?.inboundEmailId) {
    await vi.waitFor(async () => {
      const [row] = await db
        .select()
        .from(inboundEmails)
        .where(eq(inboundEmails.id, response.body.data.inboundEmailId as string));
      expect(row?.status).not.toBe('received');
    });
  }

  return response;
}

describe.runIf(enabled)('inbound email', () => {
  let agentToken: string;
  let agentId: string;

  beforeEach(async () => {
    await resetDatabase();
    const agent = await createActiveUser({
      email: AGENT,
      roleCode: 'tier2_specialist',
      fullName: 'Wallet Agent',
    });
    agentId = agent.id;
    await grantProduct(agent.id, 'pf_wallet');
    agentToken = (await signIn(app, AGENT)).accessToken;

    stubBody({});
  });

  afterEach(() => {
    emailService.__setInboundFetcher(null);
  });

  afterAll(async () => {
    await closeDatabase();
  });

  describe('signature verification', () => {
    it('refuses a request with no signature headers', async () => {
      const response = await request(app).post('/api/v1/webhooks/resend/inbound').send(envelope());

      expect(response.status).toBe(400);
      expect(await db.select().from(inboundEmails)).toHaveLength(0);
    });

    it('refuses a forged signature', async () => {
      const event = envelope();
      const body = JSON.stringify(event);

      const response = await request(app)
        .post('/api/v1/webhooks/resend/inbound')
        .set('content-type', 'application/json')
        .set('svix-id', 'msg_forged')
        .set('svix-timestamp', String(Math.floor(Date.now() / 1000)))
        .set('svix-signature', 'v1,YWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXoxMjM0NTY3OA==')
        .send(body);

      expect(response.status).toBe(401);
      expect(await db.select().from(inboundEmails)).toHaveLength(0);
    });

    it('refuses a body that was altered after signing', async () => {
      const event = envelope();
      const id = 'msg_tampered';
      const timestamp = String(Math.floor(Date.now() / 1000));
      const signature = svixSignature(id, timestamp, JSON.stringify(event));

      const tampered = { ...event, data: { ...event.data, from: 'attacker@evil.example' } };
      const response = await request(app)
        .post('/api/v1/webhooks/resend/inbound')
        .set('content-type', 'application/json')
        .set('svix-id', id)
        .set('svix-timestamp', timestamp)
        .set('svix-signature', signature)
        .send(JSON.stringify(tampered));

      expect(response.status).toBe(401);
    });
  });

  describe('with a valid signature', () => {
    it('opens a ticket from a new sender and routes it by recipient address', async () => {
      const response = await deliver(envelope());
      expect(response.status).toBe(202);

      const tickets = await request(app)
        .get('/api/v1/tickets')
        .set(...bearer(agentToken));

      expect(tickets.body.data).toHaveLength(1);
      expect(tickets.body.data[0].subject).toBe('My transfer has not arrived');
      expect(tickets.body.data[0].channel).toBe('email');
      // Routed to the wallet product because that is the address it was sent to.
      expect(tickets.body.data[0].productName).toBe('Prime Focus Wallet');
      expect(tickets.body.data[0].customerEmail).toBe(CUSTOMER);
    });

    it('records the customer’s message as the opening entry', async () => {
      await deliver(envelope());

      const tickets = await request(app)
        .get('/api/v1/tickets')
        .set(...bearer(agentToken));
      const messages = await request(app)
        .get(`/api/v1/tickets/${tickets.body.data[0].id}/messages`)
        .set(...bearer(agentToken));

      // Exactly one *customer* entry: the opening message is written by ticket
      // creation, so the pipeline must not add a second copy of the same email.
      // (A system note recording the acknowledgement also sits in the thread.)
      const fromCustomer = messages.body.data.filter(
        (m: { authorType: string }) => m.authorType === 'customer',
      );
      expect(fromCustomer).toHaveLength(1);
      expect(fromCustomer[0].visibility).toBe('public');
      expect(fromCustomer[0].body).toContain('sent money two hours ago');
    });

    it('threads a reply onto the existing ticket via In-Reply-To', async () => {
      await deliver(envelope());

      const tickets = await request(app)
        .get('/api/v1/tickets')
        .set(...bearer(agentToken));
      const ticketId = tickets.body.data[0].id as string;

      // The agent answers, which is what creates a Message-ID to reply to.
      await request(app)
        .post(`/api/v1/tickets/${ticketId}/messages`)
        .set(...bearer(agentToken))
        .send({ body: 'Checking with the payments team now.', visibility: 'public' })
        .expect(201);

      const sent = readOutbox().find((message) => message.kind === 'ticket_reply');
      const ourMessageId = sent?.messageId;
      expect(ourMessageId).toBeTypeOf('string');

      stubBody({
        text: 'Any update? It has been a day.',
        headers: { from: `Chipo Nyoni <${CUSTOMER}>`, 'in-reply-to': ourMessageId as string },
      });
      await deliver(envelope({ subject: 'Re: My transfer has not arrived' }));

      const after = await request(app)
        .get('/api/v1/tickets')
        .set(...bearer(agentToken));
      // Threaded, not a second ticket.
      expect(after.body.data).toHaveLength(1);

      const messages = await request(app)
        .get(`/api/v1/tickets/${ticketId}/messages`)
        .set(...bearer(agentToken));

      // Opening message, agent reply, and the customer's follow-up — the system
      // acknowledgement note is filtered out so this asserts the conversation.
      const conversation = messages.body.data.filter(
        (m: { authorType: string }) => m.authorType !== 'system',
      );
      expect(conversation).toHaveLength(3);
      expect(conversation[2].body).toContain('Any update?');
    });

    it('threads on the subject reference when headers are stripped', async () => {
      await deliver(envelope());
      const tickets = await request(app)
        .get('/api/v1/tickets')
        .set(...bearer(agentToken));
      const reference = tickets.body.data[0].reference as string;

      stubBody({ text: 'Still waiting.', headers: { from: CUSTOMER } });
      await deliver(envelope({ subject: `Re: [${reference}] My transfer has not arrived` }));

      const after = await request(app)
        .get('/api/v1/tickets')
        .set(...bearer(agentToken));
      expect(after.body.data).toHaveLength(1);
    });

    it('opens a separate ticket for an unrelated email from the same customer', async () => {
      await deliver(envelope());
      stubBody({ text: 'Different problem: my card was declined.' });
      await deliver(envelope({ subject: 'Card declined at the supermarket' }));

      const tickets = await request(app)
        .get('/api/v1/tickets')
        .set(...bearer(agentToken));

      expect(tickets.body.data).toHaveLength(2);
    });

    it('reopens a resolved ticket when the customer writes back', async () => {
      await deliver(envelope());
      const tickets = await request(app)
        .get('/api/v1/tickets')
        .set(...bearer(agentToken));
      const ticket = tickets.body.data[0];

      await request(app)
        .post(`/api/v1/tickets/${ticket.id}/assign`)
        .set(...bearer(agentToken))
        .send({ assignedToUserId: agentId })
        .expect(200);
      await request(app)
        .patch(`/api/v1/tickets/${ticket.id}`)
        .set(...bearer(agentToken))
        .send({ status: 'resolved' })
        .expect(200);

      stubBody({ text: 'This is still not fixed.', headers: { from: CUSTOMER } });
      await deliver(envelope({ subject: `Re: [${ticket.reference}] ${ticket.subject}` }));

      const after = await request(app)
        .get(`/api/v1/tickets/${ticket.id}`)
        .set(...bearer(agentToken));

      // A reply to a resolved ticket means it was not resolved.
      expect(after.body.data.status).toBe('open');
      expect(after.body.data.resolvedAt).toBeNull();

      const notifications = await request(app)
        .get('/api/v1/notifications')
        .set(...bearer(agentToken));
      expect(
        notifications.body.data.some(
          (row: { type: string }) => row.type === 'ticket.customer_replied',
        ),
      ).toBe(true);
    });

    it('ignores a webhook redelivery instead of duplicating the ticket', async () => {
      const event = envelope();
      const first = await deliver(event);
      const second = await deliver(event);

      expect(first.body.data.duplicate).toBe(false);
      expect(second.body.data.duplicate).toBe(true);

      const tickets = await request(app)
        .get('/api/v1/tickets')
        .set(...bearer(agentToken));
      expect(tickets.body.data).toHaveLength(1);
    });

    it('ignores an out-of-office reply', async () => {
      stubBody({
        text: 'I am on leave until the 3rd.',
        headers: { from: CUSTOMER, 'auto-submitted': 'auto-replied' },
      });
      const response = await deliver(envelope({ subject: 'Out of office' }));

      const [row] = await db.select().from(inboundEmails);
      expect(row?.status).toBe('ignored');
      expect(response.status).toBe(202);

      const tickets = await request(app)
        .get('/api/v1/tickets')
        .set(...bearer(agentToken));
      expect(tickets.body.data).toEqual([]);
    });

    it('ignores a bounce notification', async () => {
      stubBody({
        text: 'Delivery to the following recipient failed permanently.',
        headers: { from: 'mailer-daemon@example.com', 'x-failed-recipients': CUSTOMER },
      });
      await deliver(envelope({ subject: 'Mail delivery failed' }));

      const [row] = await db.select().from(inboundEmails);
      expect(row?.status).toBe('ignored');
    });

    it('ignores an email with no readable body', async () => {
      stubBody({ text: null, html: null });
      await deliver(envelope());

      const [row] = await db.select().from(inboundEmails);
      expect(row?.status).toBe('ignored');
      expect(row?.error).toBe('no readable body');
    });

    it('falls back to the HTML body when there is no plain text', async () => {
      stubBody({
        text: null,
        html: '<p>My <b>airtime</b> purchase failed.</p><script>alert(1)</script>',
      });
      await deliver(envelope());

      const tickets = await request(app)
        .get('/api/v1/tickets')
        .set(...bearer(agentToken));
      const messages = await request(app)
        .get(`/api/v1/tickets/${tickets.body.data[0].id}/messages`)
        .set(...bearer(agentToken));

      expect(messages.body.data[0].body).toContain('airtime');
      // Script contents must not survive into the thread.
      expect(messages.body.data[0].body).not.toContain('alert(1)');
    });

    it('parks an email it cannot route rather than guessing a product', async () => {
      const response = await deliver(
        envelope({ to: ['unknown@support.primefocus.co.zw'], received_for: [] }),
      );
      expect(response.status).toBe(202);

      const [row] = await db.select().from(inboundEmails);
      // Filing it under the wrong product would hide it from the agents who can
      // act on it, so it stays visible as a failure instead.
      expect(row?.status).toBe('failed');
      expect(row?.error).toContain('no product matches');

      const tickets = await request(app)
        .get('/api/v1/tickets')
        .set(...bearer(agentToken));
      expect(tickets.body.data).toEqual([]);
    });

    it('can retry a parked email once routing is fixed', async () => {
      await deliver(envelope({ to: ['unknown@support.primefocus.co.zw'], received_for: [] }));
      const [parked] = await db.select().from(inboundEmails);

      const backlog = await request(app)
        .get('/api/v1/email/inbound/unprocessed')
        .set(...bearer(agentToken));
      expect(backlog.body.data).toHaveLength(1);

      // Point the wallet product at the address the customer actually used.
      const products = await request(app)
        .get('/api/v1/products')
        .set(...bearer(agentToken));
      const wallet = products.body.data.find((row: { code: string }) => row.code === 'pf_wallet');

      const admin = await createActiveUser({ email: 'admin2@primefocus.co.zw', roleCode: 'admin' });
      const adminToken = (await signIn(app, admin.email, admin.password)).accessToken;
      await request(app)
        .patch(`/api/v1/products/${wallet.id}`)
        .set(...bearer(adminToken))
        .send({ supportEmail: 'unknown@support.primefocus.co.zw' })
        .expect(200);

      const retried = await request(app)
        .post(`/api/v1/email/inbound/${parked?.id}/reprocess`)
        .set(...bearer(agentToken));

      expect(retried.status).toBe(200);
      expect(retried.body.data.status).toBe('processed');

      const tickets = await request(app)
        .get('/api/v1/tickets')
        .set(...bearer(agentToken));
      expect(tickets.body.data).toHaveLength(1);
    });

    it('is idempotent when reprocessing an already-filed email', async () => {
      await deliver(envelope());
      const [row] = await db.select().from(inboundEmails);

      const again = await request(app)
        .post(`/api/v1/email/inbound/${row?.id}/reprocess`)
        .set(...bearer(agentToken));

      expect(again.body.data.status).toBe('processed');

      const tickets = await request(app)
        .get('/api/v1/tickets')
        .set(...bearer(agentToken));
      expect(tickets.body.data).toHaveLength(1);
    });
  });
});

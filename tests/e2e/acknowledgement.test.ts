import { createHmac } from 'node:crypto';
import request from 'supertest';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createApp } from '../../src/app.js';
import { closeDatabase, db } from '../../src/db/client.js';
import { readOutbox } from '../../src/lib/resend/index.js';
import { inboundEmails, outboundEmails } from '../../src/modules/email/email.model.js';
import * as emailService from '../../src/modules/email/email.service.js';
import type { InboundWebhookEvent } from '../../src/modules/email/email.types.js';
import { resetDatabase } from '../helpers/db.js';
import { bearer, createActiveUser, grantProduct, signIn } from '../helpers/identity.js';

const enabled = process.env.RUN_DB_TESTS === '1';
const app = createApp();

const AGENT = 'agent@primefocus.co.zw';
const CUSTOMER = 'tarisai@example.co.zw';
const WEBHOOK_SECRET = process.env.RESEND_WEBHOOK_SECRET ?? '';

let counter = 0;

function svixSignature(id: string, timestamp: string, body: string): string {
  const key = Buffer.from(WEBHOOK_SECRET.replace(/^whsec_/, ''), 'base64');
  return `v1,${createHmac('sha256', key).update(`${id}.${timestamp}.${body}`).digest('base64')}`;
}

describe.runIf(enabled)('ticket acknowledgement', () => {
  let agentToken: string;
  let walletId: string;

  beforeEach(async () => {
    await resetDatabase();
    const agent = await createActiveUser({
      email: AGENT,
      roleCode: 'tier2_specialist',
      fullName: 'Support Agent',
    });
    walletId = await grantProduct(agent.id, 'pf_wallet');
    agentToken = (await signIn(app, AGENT)).accessToken;
  });

  afterEach(() => {
    emailService.__setInboundFetcher(null);
  });

  afterAll(async () => {
    await closeDatabase();
  });

  function acknowledgements() {
    return readOutbox().filter((message) => message.kind === 'ticket_acknowledgement');
  }

  async function createTicket(channel: string, overrides: Record<string, unknown> = {}) {
    return request(app)
      .post('/api/v1/tickets')
      .set(...bearer(agentToken))
      .send({
        productId: walletId,
        subject: 'Transfer of $50 never arrived',
        body: 'I sent $50 to 0772000000 two hours ago and it has not arrived.',
        customerEmail: CUSTOMER,
        customerName: 'Tarisai Moyo',
        channel,
        ...overrides,
      });
  }

  it('emails the customer their reference when a query arrives through the web form', async () => {
    const created = await createTicket('web_form');
    const reference = created.body.data.reference as string;

    await vi.waitFor(() => expect(acknowledgements()).toHaveLength(1));

    const sent = acknowledgements()[0];
    expect(sent?.to).toBe(CUSTOMER);
    // The reference leads, because that is what a customer quotes back.
    expect(sent?.subject).toBe(`[${reference}] We have received your query`);
    expect(sent?.text).toContain(`Your reference is ${reference}`);
    expect(sent?.text).toContain('Prime Focus Wallet');
    // Their own words, so they can tell which query this is.
    expect(sent?.text).toContain('I sent $50 to 0772000000');
    expect(sent?.text).toContain('reply to this email');
  });

  it('acknowledges a ticket raised by a product system over the API', async () => {
    await createTicket('api');
    await vi.waitFor(() => expect(acknowledgements()).toHaveLength(1));
  });

  it('does not acknowledge a ticket an agent raised on a call', async () => {
    await createTicket('agent');

    // The customer has just been told their reference on the phone; emailing a
    // confirmation after they hang up is noise.
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(acknowledgements()).toHaveLength(0);
  });

  it('records the acknowledgement in the outbound log', async () => {
    const created = await createTicket('web_form');
    await vi.waitFor(() => expect(acknowledgements()).toHaveLength(1));

    await vi.waitFor(async () => {
      const rows = await db
        .select()
        .from(outboundEmails)
        .where(eq(outboundEmails.ticketId, created.body.data.id as string));

      expect(rows).toHaveLength(1);
      expect(rows[0]?.kind).toBe('ticket_acknowledgement');
      expect(rows[0]?.status).toBe('sent');
      expect(rows[0]?.toAddress).toBe(CUSTOMER);
    });
  });

  it('notes the send in the thread without showing it to the customer', async () => {
    const created = await createTicket('web_form');
    const id = created.body.data.id as string;
    await vi.waitFor(() => expect(acknowledgements()).toHaveLength(1));

    await vi.waitFor(async () => {
      const all = await request(app)
        .get(`/api/v1/tickets/${id}/messages`)
        .set(...bearer(agentToken));

      // Opening message + the system note.
      expect(all.body.data).toHaveLength(2);
      expect(all.body.data[1].authorType).toBe('system');
      expect(all.body.data[1].visibility).toBe('internal');
      expect(all.body.data[1].body).toContain('Acknowledgement emailed');
    });

    const customerView = await request(app)
      .get(`/api/v1/tickets/${id}/messages?includeInternal=false`)
      .set(...bearer(agentToken));

    expect(customerView.body.data).toHaveLength(1);
    expect(customerView.body.data[0].authorType).toBe('customer');
  });

  it('threads a reply to the acknowledgement onto the same ticket', async () => {
    const created = await createTicket('web_form');
    await vi.waitFor(() => expect(acknowledgements()).toHaveLength(1));

    const ourMessageId = acknowledgements()[0]?.messageId;
    expect(ourMessageId).toBeTypeOf('string');

    // The customer hits reply. Their client keeps In-Reply-To but mangles the
    // subject, so header threading is the only thing that can match it.
    emailService.__setInboundFetcher(async () =>
      Promise.resolve({
        text: 'Adding the transaction id: TXN-55231.',
        html: null,
        headers: { from: CUSTOMER, 'in-reply-to': ourMessageId as string },
        subject: 'Antwort: query received',
        from: CUSTOMER,
      }),
    );

    counter += 1;
    const event: InboundWebhookEvent = {
      type: 'email.received',
      created_at: new Date().toISOString(),
      data: {
        email_id: `re_ack_reply_${counter}`,
        created_at: new Date().toISOString(),
        from: CUSTOMER,
        to: ['wallet@support.primefocus.co.zw'],
        received_for: ['wallet@support.primefocus.co.zw'],
        message_id: `<cust-ack-reply-${counter}@example.co.zw>`,
        subject: 'Antwort: query received',
      },
    };

    const id = `msg_${event.data.email_id}`;
    const timestamp = String(Math.floor(Date.now() / 1000));
    const body = JSON.stringify(event);

    await request(app)
      .post('/api/v1/webhooks/resend/inbound')
      .set('content-type', 'application/json')
      .set('svix-id', id)
      .set('svix-timestamp', timestamp)
      .set('svix-signature', svixSignature(id, timestamp, body))
      .send(body)
      .expect(202);

    await vi.waitFor(async () => {
      const [row] = await db
        .select()
        .from(inboundEmails)
        .where(eq(inboundEmails.providerEmailId, event.data.email_id));
      expect(row?.status).toBe('processed');
    });

    // One ticket, not two: the reply landed on the original.
    const tickets = await request(app)
      .get('/api/v1/tickets')
      .set(...bearer(agentToken));
    expect(tickets.body.data).toHaveLength(1);
    expect(tickets.body.data[0].id).toBe(created.body.data.id);

    const messages = await request(app)
      .get(`/api/v1/tickets/${created.body.data.id}/messages`)
      .set(...bearer(agentToken));
    expect(messages.body.data.map((m: { body: string }) => m.body)).toContain(
      'Adding the transaction id: TXN-55231.',
    );
  });

  it('sends exactly one acknowledgement, not one per reply', async () => {
    const created = await createTicket('web_form');
    await vi.waitFor(() => expect(acknowledgements()).toHaveLength(1));

    await request(app)
      .post(`/api/v1/tickets/${created.body.data.id}/messages`)
      .set(...bearer(agentToken))
      .send({ body: 'We are on it.', visibility: 'public' })
      .expect(201);

    // The agent's reply is a ticket_reply; the acknowledgement is not repeated.
    expect(acknowledgements()).toHaveLength(1);
    expect(readOutbox().filter((m) => m.kind === 'ticket_reply')).toHaveLength(1);
  });

  it('still creates the ticket when the acknowledgement cannot be sent', async () => {
    // A mail outage must never cost us the ticket itself.
    const created = await createTicket('web_form', {
      customerEmail: CUSTOMER,
      subject: 'Delivery will fail',
    });

    expect(created.status).toBe(201);
    expect(created.body.data.reference).toBeTypeOf('string');
  });
});

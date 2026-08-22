import { createHmac } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { and, eq } from 'drizzle-orm';
import { io as connect, type Socket } from 'socket.io-client';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { env } from '../../src/config/index.js';
import { closeDatabase, db } from '../../src/db/client.js';
import { readOutbox } from '../../src/lib/resend/index.js';
import { stopSocketServer } from '../../src/lib/socket/index.js';
import { readWhatsappOutbox } from '../../src/lib/whatsapp/index.js';
import { startChat } from '../../src/modules/chat/index.js';
import {
  channelConversations,
  customerChannelIdentities,
  inboundChannelMessages,
  outboundChannelMessages,
} from '../../src/modules/conversation/conversation.model.js';
import { customers } from '../../src/modules/customer/customer.model.js';
import { ticketMessages } from '../../src/modules/message/message.model.js';
import { startRealtime } from '../../src/modules/realtime/index.js';
import { tickets } from '../../src/modules/ticket/ticket.model.js';
import { resetDatabase } from '../helpers/db.js';
import { bearer, createActiveUser, grantProduct, signIn } from '../helpers/identity.js';

/**
 * Phase 8 end to end: a customer reaching the desk on a channel that is not
 * email, and an agent answering them on it.
 *
 * The two channels are tested through their real ingress rather than by calling
 * the pipeline: the WhatsApp cases sign their own webhook the way Meta does, and
 * the live-chat cases open a real Socket.IO client against a real HTTP server.
 * A stubbed ingress would assert that our own code was called and prove nothing
 * about the signature check or the namespace isolation — which are the parts that
 * are either right or a way in.
 *
 * `whatsappTransport` resolves to `log` here (no access token is configured), so
 * what would have gone to Meta lands in an outbox the assertions read.
 */
const enabled = process.env.RUN_DB_TESTS === '1';
const app = createApp();

const ADMIN = 'oc.admin@primefocus.co.zw';
const AGENT = 'oc.agent@primefocus.co.zw';

/** Zimbabwean mobile in the shape Meta sends: E.164 with no leading plus. */
const CUSTOMER_NUMBER = '263771234567';

// -- the WhatsApp ingress, as Meta drives it ---------------------------------

interface InboundOptions {
  from?: string;
  id?: string;
  body?: string;
  profileName?: string;
  type?: string;
}

function messagesEnvelope(options: InboundOptions = {}): unknown {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'waba-1',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: { display_phone_number: '263780000000', phone_number_id: 'pn-1' },
              contacts: [
                {
                  wa_id: options.from ?? CUSTOMER_NUMBER,
                  profile: { name: options.profileName ?? 'Tendai Moyo' },
                },
              ],
              messages: [
                {
                  from: options.from ?? CUSTOMER_NUMBER,
                  id: options.id ?? 'wamid.first',
                  timestamp: String(Math.floor(Date.now() / 1000)),
                  type: options.type ?? 'text',
                  ...(options.type && options.type !== 'text'
                    ? {}
                    : { text: { body: options.body ?? 'My transfer has not arrived.' } }),
                },
              ],
            },
          },
        ],
      },
    ],
  };
}

/**
 * Posts a webhook signed the way Meta signs it.
 *
 * The signature is computed over the exact bytes sent, which is the point of
 * building the body as a string here rather than handing Supertest an object:
 * re-serialising would change nothing visible and everything about the digest.
 */
function postWhatsapp(payload: unknown, options: { signature?: string } = {}) {
  const body = JSON.stringify(payload);
  const digest = createHmac('sha256', env.WHATSAPP_APP_SECRET as string)
    .update(body)
    .digest('hex');

  return request(app)
    .post('/api/v1/webhooks/whatsapp')
    .set('content-type', 'application/json')
    .set('x-hub-signature-256', options.signature ?? `sha256=${digest}`)
    .send(body);
}

describe.skipIf(!enabled)('phase 8: omnichannel channels', () => {
  let adminToken: string;
  let agentToken: string;
  let agentId: string;
  let walletId: string;

  beforeAll(async () => {
    await resetDatabase();
  });

  afterAll(async () => {
    await closeDatabase();
  });

  beforeEach(async () => {
    await resetDatabase();

    const admin = await createActiveUser({
      email: ADMIN,
      roleCode: 'admin',
      fullName: 'Nyasha Admin',
    });
    const agent = await createActiveUser({
      email: AGENT,
      roleCode: 'tier1_agent',
      fullName: 'Chipo Agent',
    });

    agentId = agent.id;
    walletId = await grantProduct(agent.id, 'pf_wallet');
    await grantProduct(admin.id, 'pf_wallet');

    adminToken = (await signIn(app, ADMIN)).accessToken;
    agentToken = (await signIn(app, AGENT)).accessToken;
  });

  // -- WhatsApp inbound ------------------------------------------------------

  describe('an inbound WhatsApp message', () => {
    it('opens a ticket for a customer who has no email address at all', async () => {
      const received = await postWhatsapp(messagesEnvelope());

      expect(received.status).toBe(202);
      expect(received.body.data).toEqual({ accepted: 1, duplicates: 0 });

      const [ticket] = await db.select().from(tickets);
      expect(ticket?.channel).toBe('whatsapp');
      expect(ticket?.productId).toBe(walletId);
      // The subject is derived from the first line, because nobody wrote one.
      expect(ticket?.subject).toBe('My transfer has not arrived.');

      const [customer] = await db.select().from(customers);
      // The whole point of the nullable column: this person has a phone number
      // and no address, and the record says so rather than carrying a fake one.
      expect(customer?.email).toBeNull();
      expect(customer?.fullName).toBe('Tendai Moyo');
      expect(customer?.phone).toBe(`+${CUSTOMER_NUMBER}`);

      // And the number is recorded as the identity the next message matches on.
      const [identity] = await db.select().from(customerChannelIdentities);
      expect(identity?.channel).toBe('whatsapp');
      expect(identity?.identifier).toBe(CUSTOMER_NUMBER);
      expect(identity?.customerId).toBe(customer?.id);

      // The opening message is the customer's words, as the first thread entry.
      const messages = await db
        .select()
        .from(ticketMessages)
        .where(eq(ticketMessages.ticketId, ticket?.id as string));

      const opening = messages.find((row) => row.authorType === 'customer');
      expect(opening?.body).toBe('My transfer has not arrived.');
      expect(opening?.visibility).toBe('public');
    });

    it('starts the reply window and tells the customer their reference', async () => {
      await postWhatsapp(messagesEnvelope());

      const [conversation] = await db.select().from(channelConversations);
      expect(conversation?.channel).toBe('whatsapp');
      expect(conversation?.externalId).toBe(CUSTOMER_NUMBER);
      expect(conversation?.status).toBe('open');
      expect(conversation?.ticketId).not.toBeNull();

      // Meta's 24-hour rule, recorded on the thread rather than recomputed at
      // every send site.
      const hours = (conversation!.windowExpiresAt!.getTime() - Date.now()) / 3_600_000;
      expect(hours).toBeGreaterThan(23);
      expect(hours).toBeLessThanOrEqual(24);

      // The acknowledgement goes out on WhatsApp, not by email: the customer is
      // standing in a conversation.
      const [ticket] = await db.select().from(tickets);
      const acknowledgement = readWhatsappOutbox().find(
        (message) => message.kind === 'ticket_acknowledgement',
      );
      expect(acknowledgement?.to).toBe(CUSTOMER_NUMBER);
      expect(acknowledgement?.body).toContain(ticket!.reference);
      expect(readOutbox().some((message) => message.kind === 'ticket_acknowledgement')).toBe(false);
    });

    it('appends a second message from the same number to the same ticket', async () => {
      await postWhatsapp(messagesEnvelope());
      const [first] = await db.select().from(tickets);

      await postWhatsapp(
        messagesEnvelope({ id: 'wamid.second', body: 'It has been three days now.' }),
      );

      const all = await db.select().from(tickets);
      expect(all).toHaveLength(1);
      expect(all[0]?.id).toBe(first?.id);

      const messages = await db
        .select()
        .from(ticketMessages)
        .where(
          and(
            eq(ticketMessages.ticketId, first?.id as string),
            eq(ticketMessages.authorType, 'customer'),
          ),
        );

      expect(messages.map((row) => row.body)).toContain('It has been three days now.');

      // One customer, one identity — not a second record per message.
      expect(await db.select().from(customers)).toHaveLength(1);
      expect(await db.select().from(customerChannelIdentities)).toHaveLength(1);
    });

    it('refuses a webhook whose signature does not match, before recording anything', async () => {
      const refused = await postWhatsapp(messagesEnvelope(), { signature: 'sha256=deadbeef' });

      expect(refused.status).toBe(401);
      expect(await db.select().from(inboundChannelMessages)).toHaveLength(0);
      expect(await db.select().from(tickets)).toHaveLength(0);
    });

    it('treats a redelivered message as a no-op rather than a second message', async () => {
      await postWhatsapp(messagesEnvelope());
      const redelivered = await postWhatsapp(messagesEnvelope());

      expect(redelivered.body.data).toEqual({ accepted: 0, duplicates: 1 });
      expect(await db.select().from(tickets)).toHaveLength(1);
      expect(await db.select().from(inboundChannelMessages)).toHaveLength(1);
    });

    it('records a message it cannot read instead of dropping it', async () => {
      await postWhatsapp(messagesEnvelope({ type: 'image', id: 'wamid.image' }));

      const [inbound] = await db.select().from(inboundChannelMessages);
      // Visible in the operator's backlog with a reason, which is the difference
      // between a documented gap and a message that vanished.
      expect(inbound?.status).toBe('ignored');
      expect(inbound?.error).toBe('no readable body');
      expect(await db.select().from(tickets)).toHaveLength(0);
    });

    it('answers Meta’s URL verification with the bare challenge', async () => {
      const verified = await request(app)
        .get('/api/v1/webhooks/whatsapp')
        .query({
          'hub.mode': 'subscribe',
          'hub.verify_token': env.WHATSAPP_VERIFY_TOKEN as string,
          'hub.challenge': '1158201444',
        });

      expect(verified.status).toBe(200);
      // The bare string, not the response envelope: Meta compares bytes.
      expect(verified.text).toBe('1158201444');

      const wrongToken = await request(app)
        .get('/api/v1/webhooks/whatsapp')
        .query({ 'hub.mode': 'subscribe', 'hub.verify_token': 'nope', 'hub.challenge': 'x' });

      expect(wrongToken.status).toBe(403);
    });
  });

  // -- replying on the channel the customer arrived on -----------------------

  describe('an agent replying to a WhatsApp ticket', () => {
    let ticketId: string;

    beforeEach(async () => {
      await postWhatsapp(messagesEnvelope());
      const [ticket] = await db.select().from(tickets);
      ticketId = ticket!.id;
    });

    it('sends the reply over WhatsApp and not by email', async () => {
      const replied = await request(app)
        .post(`/api/v1/tickets/${ticketId}/messages`)
        .set(...bearer(agentToken))
        .send({ body: 'We are tracing the transfer now.', visibility: 'public' });

      expect(replied.status).toBe(201);

      const sent = readWhatsappOutbox().filter((message) => message.kind === 'ticket_reply');
      expect(sent).toHaveLength(1);
      expect(sent[0]?.to).toBe(CUSTOMER_NUMBER);
      expect(sent[0]?.body).toBe('We are tracing the transfer now.');

      // No email was sent, and there was no address to send one to.
      expect(readOutbox().some((message) => message.kind === 'ticket_reply')).toBe(false);

      const [outbound] = await db
        .select()
        .from(outboundChannelMessages)
        .where(eq(outboundChannelMessages.kind, 'ticket_reply'));

      expect(outbound?.status).toBe('sent');
      expect(outbound?.channel).toBe('whatsapp');
    });

    it('never puts an internal note on the channel', async () => {
      const noted = await request(app)
        .post(`/api/v1/tickets/${ticketId}/messages`)
        .set(...bearer(agentToken))
        .send({ body: 'Fraud team says this account is flagged.', visibility: 'internal' });

      expect(noted.status).toBe(201);

      // The assertion this whole phase had to keep true: changing what "reply to
      // the customer" means must not change what leaves the building.
      expect(
        readWhatsappOutbox().some((message) =>
          message.body.includes('Fraud team says this account is flagged'),
        ),
      ).toBe(false);
      expect(await db.select().from(outboundChannelMessages)).toHaveLength(1); // the acknowledgement
    });

    it('refuses a reply once the 24-hour window has closed, and says so in the thread', async () => {
      // Wind the window back rather than waiting a day. This is the state a
      // ticket is in every morning after an overnight message.
      await db
        .update(channelConversations)
        .set({ windowExpiresAt: new Date(Date.now() - 60_000) })
        .where(eq(channelConversations.ticketId, ticketId));

      const replied = await request(app)
        .post(`/api/v1/tickets/${ticketId}/messages`)
        .set(...bearer(agentToken))
        .send({ body: 'Sorry for the delay — any update on your side?', visibility: 'public' });

      // The reply is still accepted and still in the thread: it is the record of
      // what the agent said.
      expect(replied.status).toBe(201);
      expect(
        readWhatsappOutbox().some((message) => message.body.includes('Sorry for the delay')),
      ).toBe(false);

      const [failed] = await db
        .select()
        .from(outboundChannelMessages)
        .where(eq(outboundChannelMessages.status, 'failed'));

      expect(failed?.error).toContain('window has closed');

      // And the agent is told, in the one place they will actually look.
      const notes = await db
        .select()
        .from(ticketMessages)
        .where(and(eq(ticketMessages.ticketId, ticketId), eq(ticketMessages.authorType, 'system')));

      expect(notes.some((note) => note.body.includes('could not be delivered'))).toBe(true);
    });
  });

  // -- the staff view --------------------------------------------------------

  it('shows the desk its live threads, scoped to the products the agent works', async () => {
    await postWhatsapp(messagesEnvelope());

    const listed = await request(app)
      .get('/api/v1/conversations?channel=whatsapp')
      .set(...bearer(adminToken));

    expect(listed.status).toBe(200);
    expect(listed.body.data).toHaveLength(1);
    expect(listed.body.data[0]).toMatchObject({
      channel: 'whatsapp',
      externalId: CUSTOMER_NUMBER,
      status: 'open',
      customerName: 'Tendai Moyo',
    });
    expect(listed.body.data[0].ticketReference).toMatch(/^PF-/);

    // A tier-1 agent holds `channel:read` but not `channel:manage`, so the
    // operator backlog is not theirs.
    const backlog = await request(app)
      .get('/api/v1/conversations/inbound/unprocessed')
      .set(...bearer(agentToken));

    expect(backlog.status).toBe(403);
  });

  // -- live chat -------------------------------------------------------------

  describe('live chat', () => {
    let server: Server;
    let origin: string;
    const sockets: Socket[] = [];

    beforeEach(async () => {
      server = createServer(app);
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      await startRealtime(server);
      await startChat(server);
      origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    });

    afterEach(async () => {
      for (const socket of sockets.splice(0)) socket.disconnect();
      stopSocketServer();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });

    const openVisitor = (sessionToken: string): Promise<Socket> =>
      new Promise((resolve, reject) => {
        const socket = connect(`${origin}${env.CHAT_NAMESPACE}`, {
          path: env.REALTIME_PATH,
          auth: { sessionToken },
          transports: ['websocket'],
          reconnection: false,
        });
        sockets.push(socket);
        socket.on('connect', () => resolve(socket));
        socket.on('connect_error', reject);
      });

    const openStaff = (token: string, namespace = ''): Promise<Socket> =>
      new Promise((resolve, reject) => {
        const socket = connect(`${origin}${namespace}`, {
          path: env.REALTIME_PATH,
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

    async function startSession(): Promise<{ sessionToken: string; externalId: string }> {
      const started = await request(app)
        .post('/api/v1/chat/sessions')
        .send({ displayName: 'Rudo', page: '/transfers' });

      expect(started.status).toBe(201);
      return {
        sessionToken: started.body.data.sessionToken,
        externalId: started.body.data.conversationExternalId,
      };
    }

    it('turns a visitor’s first message into a ticket, and an agent’s reply into a frame', async () => {
      const session = await startSession();
      const visitor = await openVisitor(session.sessionToken);

      const filed = await emit<{ ticketId: string; created: boolean }>(visitor, 'chat:send', {
        body: 'My card was declined at the till.',
      });

      expect(filed.created).toBe(true);

      const [ticket] = await db.select().from(tickets);
      expect(ticket?.channel).toBe('chat');
      expect(ticket?.id).toBe(filed.ticketId);
      expect(ticket?.subject).toBe('My card was declined at the till.');

      // Now the desk answers, and the widget hears it without asking.
      const delivered = new Promise<{ author: string; body: string }>((resolve) => {
        visitor.on('chat:message', (frame: { author: string; body: string }) => {
          if (frame.author === 'agent') resolve(frame);
        });
      });

      const replied = await request(app)
        .post(`/api/v1/tickets/${ticket!.id}/messages`)
        .set(...bearer(agentToken))
        .send({ body: 'Let me check the authorisation log.', visibility: 'public' });

      expect(replied.status).toBe(201);
      expect((await delivered).body).toBe('Let me check the authorisation log.');
    });

    it('keeps an internal note off the visitor’s socket', async () => {
      const session = await startSession();
      const visitor = await openVisitor(session.sessionToken);
      await emit(visitor, 'chat:send', { body: 'Anyone there?' });

      const [ticket] = await db.select().from(tickets);

      const frames: unknown[] = [];
      visitor.on('chat:message', (frame: { author: string }) => {
        if (frame.author === 'agent') frames.push(frame);
      });

      await request(app)
        .post(`/api/v1/tickets/${ticket!.id}/messages`)
        .set(...bearer(agentToken))
        .send({ body: 'This visitor is on a blocked card list.', visibility: 'internal' });

      // Nothing to await on — the assertion is that nothing arrives — so give
      // the broadcast that would have happened a chance to happen.
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(frames).toHaveLength(0);
    });

    it('serves the transcript with the internal notes stripped out', async () => {
      const session = await startSession();
      const visitor = await openVisitor(session.sessionToken);
      await emit(visitor, 'chat:send', { body: 'Still waiting.' });

      const [ticket] = await db.select().from(tickets);

      await request(app)
        .post(`/api/v1/tickets/${ticket!.id}/messages`)
        .set(...bearer(agentToken))
        .send({ body: 'Escalating to the card team.', visibility: 'internal' });
      await request(app)
        .post(`/api/v1/tickets/${ticket!.id}/messages`)
        .set(...bearer(agentToken))
        .send({ body: 'We are on it.', visibility: 'public' });

      const transcript = await request(app)
        .get('/api/v1/chat/transcript')
        .set('authorization', `Bearer ${session.sessionToken}`);

      expect(transcript.status).toBe(200);
      const bodies = (transcript.body.data as { body: string }[]).map((entry) => entry.body);

      expect(bodies).toContain('Still waiting.');
      expect(bodies).toContain('We are on it.');
      expect(bodies).not.toContain('Escalating to the card team.');
    });

    it('refuses a visitor token on the staff namespace, and a staff token on the chat one', async () => {
      const session = await startSession();

      // A visitor's credential is not a staff credential. It is not even the
      // right *kind* of credential, and the staff handshake only reads `token`.
      await expect(openStaff(session.sessionToken)).rejects.toThrow();

      // And an agent cannot reach a visitor's room by pointing their own token
      // at the chat namespace.
      await expect(openStaff(agentToken, env.CHAT_NAMESPACE)).rejects.toThrow();

      // A valid visitor token on its own namespace still works, so the two
      // refusals above are about the credential and not about the namespace
      // being broken.
      const visitor = await openVisitor(session.sessionToken);
      expect(visitor.connected).toBe(true);
    });

    it('refuses a session the desk has ended', async () => {
      const session = await startSession();

      const ended = await request(app)
        .delete('/api/v1/chat/session')
        .set('authorization', `Bearer ${session.sessionToken}`);

      expect(ended.status).toBe(204);
      await expect(openVisitor(session.sessionToken)).rejects.toThrow();

      const replayed = await request(app)
        .post('/api/v1/chat/messages')
        .set('authorization', `Bearer ${session.sessionToken}`)
        .send({ body: 'let me back in' });

      expect(replayed.status).toBe(401);
    });

    it('reaps a widget that was opened and abandoned without a word', async () => {
      const abandoned = await startSession();
      const used = await startSession();

      await request(app)
        .post('/api/v1/chat/messages')
        .set('authorization', `Bearer ${used.sessionToken}`)
        .send({ body: 'I do need help actually.' });

      expect(await db.select().from(channelConversations)).toHaveLength(2);
      expect(await db.select().from(customers)).toHaveLength(2);

      // Age both threads past twice the session TTL, which is the cutoff the
      // reaper uses so nothing a live token could reach is touched.
      await db
        .update(channelConversations)
        .set({ createdAt: new Date(Date.now() - 30 * 86_400_000) });

      const { reapAbandonedChats } =
        await import('../../src/modules/conversation/conversation.service.js');
      expect(await reapAbandonedChats()).toBe(1);

      // The thread that produced a ticket survives, with its customer.
      const [surviving] = await db.select().from(channelConversations);
      expect(surviving?.externalId).toBe(used.externalId);
      expect(surviving?.ticketId).not.toBeNull();

      // The abandoned one is gone, and so is the customer it invented.
      expect(await db.select().from(customers)).toHaveLength(1);
      expect(await db.select().from(customerChannelIdentities)).toHaveLength(1);
      expect(abandoned.externalId).not.toBe(surviving?.externalId);
    });

    it('files a message posted over REST exactly as it files one over the socket', async () => {
      const session = await startSession();

      const posted = await request(app)
        .post('/api/v1/chat/messages')
        .set('authorization', `Bearer ${session.sessionToken}`)
        .send({ body: 'No websockets on this network.' });

      expect(posted.status).toBe(201);

      const [ticket] = await db.select().from(tickets);
      expect(ticket?.channel).toBe('chat');
      expect(ticket?.subject).toBe('No websockets on this network.');
    });
  });

  // -- the seams this phase had to leave intact ------------------------------

  it('skips the satisfaction survey for a customer with no address, and says why', async () => {
    await postWhatsapp(messagesEnvelope());
    const [ticket] = await db.select().from(tickets);

    await request(app)
      .post(`/api/v1/tickets/${ticket!.id}/messages`)
      .set(...bearer(agentToken))
      .send({ body: 'Traced and refunded.', visibility: 'public' });

    await request(app)
      .patch(`/api/v1/tickets/${ticket!.id}`)
      .set(...bearer(adminToken))
      .send({ status: 'resolved' });

    const { dispatch } = await import('../../src/modules/survey/survey.service.js');
    const result = await dispatch(ticket!.id);

    // Not a crash, and not an email into a black hole: a skip with a reason,
    // because the response rate is itself a reported number.
    expect(result).toEqual({ status: 'skipped', reason: 'customer has no email address' });
  });

  it('moves a WhatsApp number onto the survivor when two customers are merged', async () => {
    await postWhatsapp(messagesEnvelope());
    const [whatsappCustomer] = await db.select().from(customers);

    const survivor = await request(app)
      .post('/api/v1/customers')
      .set(...bearer(adminToken))
      .send({ email: 'tendai@example.co.zw', fullName: 'Tendai Moyo' });

    expect(survivor.status).toBe(201);

    const merged = await request(app)
      .post(`/api/v1/customers/${survivor.body.data.id}/merge`)
      .set(...bearer(adminToken))
      .send({ duplicateId: whatsappCustomer!.id });

    expect(merged.status).toBe(200);

    // Without this the next message from that number would be filed against a
    // merged-away record, and the merge would quietly undo itself.
    const [identity] = await db.select().from(customerChannelIdentities);
    expect(identity?.customerId).toBe(survivor.body.data.id);
  });

  it('still replies by email on a channel with nobody waiting on it', async () => {
    // `web_form`, because `POST /tickets` deliberately refuses `email`, `chat`
    // and `whatsapp`: those channels exist only as the origin of a ticket their
    // own inbound pipeline created, and letting an API caller claim one would
    // let it claim a conversation that does not exist.
    const raised = await request(app)
      .post('/api/v1/tickets')
      .set(...bearer(adminToken))
      .send({
        productId: walletId,
        subject: 'Statement request',
        body: 'Please send me February.',
        channel: 'web_form',
        customerEmail: 'rudo@example.co.zw',
      });

    expect(raised.status).toBe(201);

    await request(app)
      .post(`/api/v1/tickets/${raised.body.data.id}/messages`)
      .set(...bearer(agentToken))
      .send({ body: 'Attached.', visibility: 'public' });

    // The dispatcher fell back to email, so the Phase 3 path is untouched: the
    // reply is an email and nothing was recorded as a channel send.
    const emailed = readOutbox().filter((message) => message.kind === 'ticket_reply');
    expect(emailed).toHaveLength(1);
    expect(emailed[0]?.to).toBe('rudo@example.co.zw');
    expect(await db.select().from(outboundChannelMessages)).toHaveLength(0);
    expect(agentId).toBeTruthy();
  });
});

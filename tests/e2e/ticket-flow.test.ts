import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { closeDatabase } from '../../src/db/client.js';
import { readOutbox } from '../../src/lib/resend/index.js';
import { resetDatabase } from '../helpers/db.js';
import {
  bearer,
  createActiveUser,
  grantProduct,
  productIdFor,
  signIn,
} from '../helpers/identity.js';

const enabled = process.env.RUN_DB_TESTS === '1';
const app = createApp();

const ADMIN = 'admin.ops@primefocus.co.zw';
const WALLET_AGENT = 'wallet.agent@primefocus.co.zw';
const CUSTOMER = 'tendai@example.co.zw';

describe.runIf(enabled)('tickets', () => {
  let adminToken: string;
  let agentToken: string;
  let agentId: string;
  let walletId: string;

  beforeEach(async () => {
    await resetDatabase();

    await createActiveUser({ email: ADMIN, roleCode: 'admin', fullName: 'Ops Admin' });
    const agent = await createActiveUser({
      email: WALLET_AGENT,
      roleCode: 'tier1_agent',
      fullName: 'Wallet Agent',
    });
    agentId = agent.id;

    walletId = await grantProduct(agent.id, 'pf_wallet');
    adminToken = (await signIn(app, ADMIN)).accessToken;
    agentToken = (await signIn(app, WALLET_AGENT)).accessToken;
  });

  afterAll(async () => {
    await closeDatabase();
  });

  async function createTicket(token: string, overrides: Record<string, unknown> = {}) {
    return request(app)
      .post('/api/v1/tickets')
      .set(...bearer(token))
      .send({
        productId: walletId,
        subject: 'Transfer failed but money was deducted',
        body: 'I sent $50 to 0772000000 and it never arrived.',
        customerEmail: CUSTOMER,
        customerName: 'Tendai Moyo',
        ...overrides,
      });
  }

  describe('creation', () => {
    it('opens a ticket with a sequential reference and creates the customer', async () => {
      const response = await createTicket(agentToken);

      expect(response.status).toBe(201);
      expect(response.body.data.reference).toBe('PF-2026-000001');
      expect(response.body.data.status).toBe('new');
      expect(response.body.data.priority).toBe('normal');
      expect(response.body.data.customerEmail).toBe(CUSTOMER);
      expect(response.body.data.productName).toBe('Prime Focus Wallet');

      const second = await createTicket(agentToken, { subject: 'Another issue' });
      expect(second.body.data.reference).toBe('PF-2026-000002');
    });

    it('records the customer’s description as the opening message', async () => {
      const created = await createTicket(agentToken);

      const messages = await request(app)
        .get(`/api/v1/tickets/${created.body.data.id}/messages`)
        .set(...bearer(agentToken));

      // A ticket whose thread starts empty loses the actual complaint, which is
      // the one thing an agent needs to read first.
      expect(messages.body.data).toHaveLength(1);
      expect(messages.body.data[0].authorType).toBe('customer');
      expect(messages.body.data[0].visibility).toBe('public');
      expect(messages.body.data[0].body).toContain('sent $50 to 0772000000');
    });

    it('reuses an existing customer rather than duplicating them', async () => {
      await createTicket(agentToken);
      await createTicket(agentToken, { subject: 'Second query' });

      const customers = await request(app)
        .get('/api/v1/customers')
        .set(...bearer(adminToken));

      expect(
        customers.body.data.filter((row: { email: string }) => row.email === CUSTOMER),
      ).toHaveLength(1);
    });

    it('requires a customer identifier', async () => {
      const response = await request(app)
        .post('/api/v1/tickets')
        .set(...bearer(agentToken))
        .send({ productId: walletId, subject: 'No customer here', body: 'hello' });

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('refuses a category from another product', async () => {
      const lendingId = await productIdFor('pf_lending');
      const lendingCategories = await request(app)
        .get(`/api/v1/categories?productId=${lendingId}`)
        .set(...bearer(adminToken));

      const response = await createTicket(agentToken, {
        categoryId: lendingCategories.body.data[0].id,
      });

      expect(response.status).toBe(400);
      expect(response.body.error.details[0].field).toBe('categoryId');
    });

    it('accepts tags and creates them on the fly', async () => {
      const response = await createTicket(agentToken, {
        tags: ['Failed Transfer', 'urgent-review'],
      });

      expect(response.status).toBe(201);
      expect(response.body.data.tags).toEqual(
        expect.arrayContaining(['failed-transfer', 'urgent-review']),
      );
    });
  });

  describe('product scoping', () => {
    it('hides tickets from products the agent does not work', async () => {
      const lendingId = await productIdFor('pf_lending');
      await createTicket(adminToken, { productId: lendingId, subject: 'Loan query' });
      await createTicket(agentToken, { subject: 'Wallet query' });

      const asAgent = await request(app)
        .get('/api/v1/tickets')
        .set(...bearer(agentToken));

      expect(asAgent.body.data).toHaveLength(1);
      expect(asAgent.body.data[0].subject).toBe('Wallet query');

      // The administrator holds ticket:read_all_products, so sees both.
      const asAdmin = await request(app)
        .get('/api/v1/tickets')
        .set(...bearer(adminToken));
      expect(asAdmin.body.data).toHaveLength(2);
    });

    it('answers 404 for a ticket outside the agent’s products', async () => {
      const lendingId = await productIdFor('pf_lending');
      const created = await createTicket(adminToken, {
        productId: lendingId,
        subject: 'Loan query',
      });

      const response = await request(app)
        .get(`/api/v1/tickets/${created.body.data.id}`)
        .set(...bearer(agentToken));

      // 404 rather than 403: whether the ticket exists is itself information.
      expect(response.status).toBe(404);
    });

    it('refuses to create a ticket on an inaccessible product', async () => {
      const lendingId = await productIdFor('pf_lending');
      const response = await createTicket(agentToken, { productId: lendingId });

      expect(response.status).toBe(404);
    });

    it('shows nothing to an agent with no product grants', async () => {
      const stranger = await createActiveUser({
        email: 'nogrants@primefocus.co.zw',
        roleCode: 'tier1_agent',
      });
      await createTicket(agentToken);
      const strangerToken = (await signIn(app, stranger.email, stranger.password)).accessToken;

      const response = await request(app)
        .get('/api/v1/tickets')
        .set(...bearer(strangerToken));

      // An empty grant list must mean nothing, not everything.
      expect(response.status).toBe(200);
      expect(response.body.data).toEqual([]);
    });

    it('lists only the caller’s products when asked', async () => {
      const response = await request(app)
        .get('/api/v1/products?mine=true')
        .set(...bearer(agentToken));

      expect(response.body.data).toHaveLength(1);
      expect(response.body.data[0].code).toBe('pf_wallet');
    });
  });

  describe('lifecycle', () => {
    it('walks new → open → pending → resolved and stamps the timestamps', async () => {
      const created = await createTicket(agentToken);
      const id = created.body.data.id as string;

      const opened = await request(app)
        .patch(`/api/v1/tickets/${id}`)
        .set(...bearer(adminToken))
        .send({ status: 'open' });
      expect(opened.body.data.status).toBe('open');

      await request(app)
        .patch(`/api/v1/tickets/${id}`)
        .set(...bearer(adminToken))
        .send({ status: 'pending' })
        .expect(200);

      const resolved = await request(app)
        .patch(`/api/v1/tickets/${id}`)
        .set(...bearer(adminToken))
        .send({ status: 'resolved' });

      expect(resolved.body.data.status).toBe('resolved');
      expect(resolved.body.data.resolvedAt).not.toBeNull();
    });

    it('refuses an illegal transition', async () => {
      const created = await createTicket(agentToken);
      await request(app)
        .patch(`/api/v1/tickets/${created.body.data.id}`)
        .set(...bearer(adminToken))
        .send({ status: 'resolved' })
        .expect(200);

      // resolved → pending is not a legal move.
      const response = await request(app)
        .patch(`/api/v1/tickets/${created.body.data.id}`)
        .set(...bearer(adminToken))
        .send({ status: 'pending' });

      expect(response.status).toBe(400);
      expect(response.body.error.message).toContain('cannot go from resolved to pending');
    });

    it('reopens a resolved ticket and counts it', async () => {
      const created = await createTicket(agentToken);
      const id = created.body.data.id as string;

      await request(app)
        .patch(`/api/v1/tickets/${id}`)
        .set(...bearer(adminToken))
        .send({ status: 'resolved' })
        .expect(200);

      const reopened = await request(app)
        .post(`/api/v1/tickets/${id}/reopen`)
        .set(...bearer(adminToken))
        .send({ reason: 'customer says it is still broken' });

      expect(reopened.status).toBe(200);
      expect(reopened.body.data.status).toBe('open');
      expect(reopened.body.data.resolvedAt).toBeNull();
    });
  });

  describe('assignment', () => {
    it('lets an agent take an unassigned ticket', async () => {
      const created = await createTicket(agentToken);

      const response = await request(app)
        .post(`/api/v1/tickets/${created.body.data.id}/assign`)
        .set(...bearer(agentToken))
        .send({ assignedToUserId: agentId });

      expect(response.status).toBe(200);
      expect(response.body.data.assignedToUserId).toBe(agentId);
      // Taking a new ticket puts it in play.
      expect(response.body.data.status).toBe('open');
    });

    it('stops a tier-1 agent assigning work to somebody else', async () => {
      const other = await createActiveUser({
        email: 'other.agent@primefocus.co.zw',
        roleCode: 'tier1_agent',
      });
      await grantProduct(other.id, 'pf_wallet');
      const created = await createTicket(agentToken);

      const response = await request(app)
        .post(`/api/v1/tickets/${created.body.data.id}/assign`)
        .set(...bearer(agentToken))
        .send({ assignedToUserId: other.id });

      expect(response.status).toBe(403);
    });

    it('refuses to assign to an agent without product access', async () => {
      const lendingOnly = await createActiveUser({
        email: 'lending.only@primefocus.co.zw',
        roleCode: 'tier1_agent',
      });
      await grantProduct(lendingOnly.id, 'pf_lending');
      const created = await createTicket(agentToken);

      const response = await request(app)
        .post(`/api/v1/tickets/${created.body.data.id}/assign`)
        .set(...bearer(adminToken))
        .send({ assignedToUserId: lendingOnly.id });

      // Assigning work nobody can open would strand the ticket.
      expect(response.status).toBe(400);
      expect(response.body.error.details[0].field).toBe('assignedToUserId');
    });

    it('records the assignment history', async () => {
      const created = await createTicket(agentToken);
      const id = created.body.data.id as string;

      await request(app)
        .post(`/api/v1/tickets/${id}/assign`)
        .set(...bearer(adminToken))
        .send({ assignedToUserId: agentId, reason: 'wallet specialist' })
        .expect(200);
      await request(app)
        .post(`/api/v1/tickets/${id}/assign`)
        .set(...bearer(adminToken))
        .send({ assignedToUserId: null, reason: 'back to the queue' })
        .expect(200);

      const history = await request(app)
        .get(`/api/v1/tickets/${id}/assignments`)
        .set(...bearer(adminToken));

      expect(history.body.data).toHaveLength(2);
      expect(history.body.data[0].reason).toBe('back to the queue');
    });

    it('notifies the assignee', async () => {
      const created = await createTicket(agentToken);
      await request(app)
        .post(`/api/v1/tickets/${created.body.data.id}/assign`)
        .set(...bearer(adminToken))
        .send({ assignedToUserId: agentId })
        .expect(200);

      const notifications = await request(app)
        .get('/api/v1/notifications')
        .set(...bearer(agentToken));

      expect(notifications.body.data[0].type).toBe('ticket.assigned');
      expect(notifications.body.data[0].title).toContain('PF-2026-');
      expect(notifications.body.meta.unreadCount).toBe(1);
    });
  });

  describe('replies and internal notes', () => {
    it('emails a public reply to the customer', async () => {
      const created = await createTicket(agentToken);
      const reference = created.body.data.reference as string;

      const reply = await request(app)
        .post(`/api/v1/tickets/${created.body.data.id}/messages`)
        .set(...bearer(agentToken))
        .send({
          body: 'We have reversed the transfer, it should reflect within an hour.',
          visibility: 'public',
        });

      expect(reply.status).toBe(201);

      const sent = readOutbox().filter((message) => message.kind === 'ticket_reply');
      expect(sent).toHaveLength(1);
      expect(sent[0]?.to).toBe(CUSTOMER);
      // The reference in the subject is what threads the customer's reply back.
      expect(sent[0]?.subject).toContain(reference);
      expect(sent[0]?.text).toContain('reversed the transfer');
    });

    it('never emails an internal note', async () => {
      const created = await createTicket(agentToken);

      await request(app)
        .post(`/api/v1/tickets/${created.body.data.id}/messages`)
        .set(...bearer(agentToken))
        .send({
          body: 'Customer has three prior chargebacks — escalate carefully.',
          visibility: 'internal',
        })
        .expect(201);

      // The single worst failure this module could have.
      expect(readOutbox().filter((message) => message.kind === 'ticket_reply')).toHaveLength(0);
      expect(readOutbox().some((message) => message.text.includes('prior chargebacks'))).toBe(
        false,
      );
    });

    it('stamps the first response time once only', async () => {
      const created = await createTicket(agentToken);
      const id = created.body.data.id as string;

      await request(app)
        .post(`/api/v1/tickets/${id}/messages`)
        .set(...bearer(agentToken))
        .send({ body: 'Looking into this now.', visibility: 'public' })
        .expect(201);

      const afterFirst = await request(app)
        .get(`/api/v1/tickets/${id}`)
        .set(...bearer(agentToken));
      const firstResponseAt = afterFirst.body.data.firstResponseAt as string;
      expect(firstResponseAt).not.toBeNull();

      await request(app)
        .post(`/api/v1/tickets/${id}/messages`)
        .set(...bearer(agentToken))
        .send({ body: 'Update: reversal submitted.', visibility: 'public' })
        .expect(201);

      const afterSecond = await request(app)
        .get(`/api/v1/tickets/${id}`)
        .set(...bearer(agentToken));

      // FRT measures the first reply, so a later one must not move it.
      expect(afterSecond.body.data.firstResponseAt).toBe(firstResponseAt);
    });

    it('does not stamp first response for an internal note', async () => {
      const created = await createTicket(agentToken);
      await request(app)
        .post(`/api/v1/tickets/${created.body.data.id}/messages`)
        .set(...bearer(agentToken))
        .send({ body: 'Checking with the payments team.', visibility: 'internal' })
        .expect(201);

      const ticket = await request(app)
        .get(`/api/v1/tickets/${created.body.data.id}`)
        .set(...bearer(agentToken));

      expect(ticket.body.data.firstResponseAt).toBeNull();
    });

    it('requires visibility to be stated explicitly', async () => {
      const created = await createTicket(agentToken);

      const response = await request(app)
        .post(`/api/v1/tickets/${created.body.data.id}/messages`)
        .set(...bearer(agentToken))
        .send({ body: 'No visibility given' });

      // Defaulting this wrong would email a private note to a customer.
      expect(response.status).toBe(400);
      expect(response.body.error.details[0].field).toBe('body.visibility');
    });

    it('can filter internal notes out of the thread', async () => {
      const created = await createTicket(agentToken);
      const id = created.body.data.id as string;

      await request(app)
        .post(`/api/v1/tickets/${id}/messages`)
        .set(...bearer(agentToken))
        .send({ body: 'Public answer', visibility: 'public' })
        .expect(201);
      await request(app)
        .post(`/api/v1/tickets/${id}/messages`)
        .set(...bearer(agentToken))
        .send({ body: 'Private note', visibility: 'internal' })
        .expect(201);

      const all = await request(app)
        .get(`/api/v1/tickets/${id}/messages`)
        .set(...bearer(agentToken));
      const publicOnly = await request(app)
        .get(`/api/v1/tickets/${id}/messages?includeInternal=false`)
        .set(...bearer(agentToken));

      // Opening message + public reply + internal note.
      expect(all.body.data).toHaveLength(3);
      // The customer's view: their own message and the public reply, never the note.
      expect(publicOnly.body.data).toHaveLength(2);
      expect(publicOnly.body.data.map((m: { body: string }) => m.body)).not.toContain(
        'Private note',
      );
      expect(publicOnly.body.data[1].body).toBe('Public answer');
    });

    it('refuses a reply on a ticket outside the agent’s products', async () => {
      const lendingId = await productIdFor('pf_lending');
      const created = await createTicket(adminToken, { productId: lendingId });

      const response = await request(app)
        .post(`/api/v1/tickets/${created.body.data.id}/messages`)
        .set(...bearer(agentToken))
        .send({ body: 'Should not be possible', visibility: 'public' });

      expect(response.status).toBe(404);
    });
  });

  describe('macros', () => {
    it('applies field changes and returns rendered text without sending it', async () => {
      const macro = await request(app)
        .post('/api/v1/macros')
        .set(...bearer(adminToken))
        .send({
          name: 'Transfer reversed',
          productId: walletId,
          body: 'Hello {{customer.firstName}}, ticket {{ticket.reference}} has been reversed.',
          actions: { status: 'pending', priority: 'high', addTags: ['reversal'] },
        });
      expect(macro.status).toBe(201);

      const created = await createTicket(agentToken);
      const applied = await request(app)
        .post(`/api/v1/macros/${macro.body.data.id}/apply/${created.body.data.id}`)
        .set(...bearer(agentToken));

      expect(applied.status).toBe(200);
      expect(applied.body.data.body).toContain('Hello Tendai');
      expect(applied.body.data.body).toContain(created.body.data.reference);

      const ticket = await request(app)
        .get(`/api/v1/tickets/${created.body.data.id}`)
        .set(...bearer(agentToken));
      expect(ticket.body.data.status).toBe('pending');
      expect(ticket.body.data.priority).toBe('high');
      expect(ticket.body.data.tags).toContain('reversal');

      // Applying a macro must not email anybody: a mis-click has to be recoverable.
      expect(readOutbox().filter((message) => message.kind === 'ticket_reply')).toHaveLength(0);
    });

    it('refuses a macro from another product', async () => {
      const lendingId = await productIdFor('pf_lending');
      const macro = await request(app)
        .post('/api/v1/macros')
        .set(...bearer(adminToken))
        .send({ name: 'Loan macro', productId: lendingId, actions: { status: 'pending' } });

      const created = await createTicket(agentToken);
      const response = await request(app)
        .post(`/api/v1/macros/${macro.body.data.id}/apply/${created.body.data.id}`)
        .set(...bearer(agentToken));

      expect(response.status).toBe(400);
    });

    it('rejects an unknown action key rather than storing it', async () => {
      const response = await request(app)
        .post('/api/v1/macros')
        .set(...bearer(adminToken))
        .send({ name: 'Typo macro', actions: { statuss: 'pending' } });

      expect(response.status).toBe(400);
    });
  });

  describe('search and filters', () => {
    it('filters by status and finds by reference', async () => {
      const first = await createTicket(agentToken, { subject: 'Airtime not delivered' });
      await createTicket(agentToken, { subject: 'Statement request' });

      await request(app)
        .patch(`/api/v1/tickets/${first.body.data.id}`)
        .set(...bearer(adminToken))
        .send({ status: 'resolved' })
        .expect(200);

      const open = await request(app)
        .get('/api/v1/tickets?status=new')
        .set(...bearer(agentToken));
      expect(open.body.data).toHaveLength(1);
      expect(open.body.data[0].subject).toBe('Statement request');

      const byReference = await request(app)
        .get(`/api/v1/tickets?search=${first.body.data.reference}`)
        .set(...bearer(agentToken));
      expect(byReference.body.data).toHaveLength(1);
    });

    it('lists the unassigned queue', async () => {
      const mine = await createTicket(agentToken, { subject: 'Mine' });
      await createTicket(agentToken, { subject: 'Nobody’s' });

      await request(app)
        .post(`/api/v1/tickets/${mine.body.data.id}/assign`)
        .set(...bearer(agentToken))
        .send({ assignedToUserId: agentId })
        .expect(200);

      const queue = await request(app)
        .get('/api/v1/tickets?unassigned=true')
        .set(...bearer(agentToken));

      expect(queue.body.data).toHaveLength(1);
      expect(queue.body.data[0].subject).toBe('Nobody’s');
    });
  });
});

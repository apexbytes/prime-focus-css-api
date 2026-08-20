import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { closeDatabase } from '../../src/db/client.js';
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
const AGENT = 'agent@primefocus.co.zw';

describe.runIf(enabled)('attachments and customers', () => {
  let adminToken: string;
  let agentToken: string;
  let walletId: string;

  beforeEach(async () => {
    await resetDatabase();
    await createActiveUser({ email: ADMIN, roleCode: 'admin', fullName: 'Ops Admin' });
    const agent = await createActiveUser({
      email: AGENT,
      roleCode: 'tier2_specialist',
      fullName: 'Agent',
    });
    walletId = await grantProduct(agent.id, 'pf_wallet');

    adminToken = (await signIn(app, ADMIN)).accessToken;
    agentToken = (await signIn(app, AGENT)).accessToken;
  });

  afterAll(async () => {
    await closeDatabase();
  });

  async function makeTicket(): Promise<string> {
    const created = await request(app)
      .post('/api/v1/tickets')
      .set(...bearer(agentToken))
      .send({
        productId: walletId,
        subject: 'Statement request',
        body: 'Please send my March statement.',
        customerEmail: 'rudo@example.co.zw',
        customerName: 'Rudo Chikafu',
      });

    return created.body.data.id as string;
  }

  describe('attachments', () => {
    it('round-trips an upload through the API when storage is local disk', async () => {
      const ticketId = await makeTicket();

      const ticket = await request(app)
        .post(`/api/v1/tickets/${ticketId}/attachments/upload-url`)
        .set(...bearer(agentToken))
        .send({ filename: 'statement.pdf', contentType: 'application/pdf', sizeBytes: 11 });

      expect(ticket.status).toBe(201);
      // No object storage configured, so the client is pointed back at the API.
      expect(ticket.body.data.direct).toBe(false);
      expect(ticket.body.data.uploadUrl).toContain(
        `/attachments/${ticket.body.data.attachmentId}/content`,
      );

      const upload = await request(app)
        .put(`/api/v1/attachments/${ticket.body.data.attachmentId}/content`)
        .set(...bearer(agentToken))
        .set('content-type', 'application/pdf')
        .send(Buffer.from('pdf-bytes-1'));

      expect(upload.status).toBe(200);
      expect(upload.body.data.status).toBe('skipped');
      expect(upload.body.data.checksum).toBeTypeOf('string');

      const download = await request(app)
        .get(`/api/v1/attachments/${ticket.body.data.attachmentId}/download`)
        .set(...bearer(agentToken));

      expect(download.status).toBe(200);
      expect(download.headers['content-type']).toContain('application/pdf');
      expect(download.headers['content-disposition']).toContain('statement.pdf');
      // Customer documents must not be cached by any proxy in between.
      expect(download.headers['cache-control']).toBe('private, no-store');
      expect(download.body.toString()).toBe('pdf-bytes-1');
    });

    it('lists a ticket’s attachments', async () => {
      const ticketId = await makeTicket();
      const reserved = await request(app)
        .post(`/api/v1/tickets/${ticketId}/attachments/upload-url`)
        .set(...bearer(agentToken))
        .send({ filename: 'proof.png', contentType: 'image/png', sizeBytes: 9 });

      await request(app)
        .put(`/api/v1/attachments/${reserved.body.data.attachmentId}/content`)
        .set(...bearer(agentToken))
        .set('content-type', 'image/png')
        .send(Buffer.from('png-bytes'))
        .expect(200);

      const list = await request(app)
        .get(`/api/v1/tickets/${ticketId}/attachments`)
        .set(...bearer(agentToken));

      expect(list.body.data).toHaveLength(1);
      expect(list.body.data[0].filename).toBe('proof.png');
    });

    it('refuses an executable', async () => {
      const ticketId = await makeTicket();

      const response = await request(app)
        .post(`/api/v1/tickets/${ticketId}/attachments/upload-url`)
        .set(...bearer(agentToken))
        .send({
          filename: 'invoice.pdf.exe',
          contentType: 'application/octet-stream',
          sizeBytes: 10,
        });

      expect(response.status).toBe(400);
      expect(response.body.error.message).toContain('.exe');
    });

    it('refuses a file over the size cap', async () => {
      const ticketId = await makeTicket();

      const response = await request(app)
        .post(`/api/v1/tickets/${ticketId}/attachments/upload-url`)
        .set(...bearer(agentToken))
        .send({ filename: 'huge.zip', contentType: 'application/zip', sizeBytes: 999_999_999 });

      expect(response.status).toBe(400);
      expect(response.body.error.message).toContain('MB or smaller');
    });

    it('will not serve an attachment that was never uploaded', async () => {
      const ticketId = await makeTicket();
      const reserved = await request(app)
        .post(`/api/v1/tickets/${ticketId}/attachments/upload-url`)
        .set(...bearer(agentToken))
        .send({ filename: 'pending.pdf', contentType: 'application/pdf', sizeBytes: 5 });

      const response = await request(app)
        .get(`/api/v1/attachments/${reserved.body.data.attachmentId}/download`)
        .set(...bearer(agentToken));

      expect(response.status).toBe(404);
    });

    it('denies access to an attachment on another product’s ticket', async () => {
      const lendingId = await productIdFor('pf_lending');
      const lendingTicket = await request(app)
        .post('/api/v1/tickets')
        .set(...bearer(adminToken))
        .send({
          productId: lendingId,
          subject: 'Loan statement',
          body: 'Please send it.',
          customerEmail: 'loanguy@example.co.zw',
        });

      const reserved = await request(app)
        .post(`/api/v1/tickets/${lendingTicket.body.data.id}/attachments/upload-url`)
        .set(...bearer(adminToken))
        .send({ filename: 'loan.pdf', contentType: 'application/pdf', sizeBytes: 5 });

      const response = await request(app)
        .get(`/api/v1/attachments/${reserved.body.data.attachmentId}/download`)
        .set(...bearer(agentToken));

      // Access to an attachment is access to its ticket.
      expect(response.status).toBe(404);
    });

    it('rejects a second upload to the same reservation', async () => {
      const ticketId = await makeTicket();
      const reserved = await request(app)
        .post(`/api/v1/tickets/${ticketId}/attachments/upload-url`)
        .set(...bearer(agentToken))
        .send({ filename: 'once.txt', contentType: 'text/plain', sizeBytes: 4 });

      await request(app)
        .put(`/api/v1/attachments/${reserved.body.data.attachmentId}/content`)
        .set(...bearer(agentToken))
        .set('content-type', 'text/plain')
        .send(Buffer.from('once'))
        .expect(200);

      const again = await request(app)
        .put(`/api/v1/attachments/${reserved.body.data.attachmentId}/content`)
        .set(...bearer(agentToken))
        .set('content-type', 'text/plain')
        .send(Buffer.from('twice'));

      expect(again.status).toBe(409);
    });

    it('needs ticket:delete to remove one', async () => {
      const ticketId = await makeTicket();
      const reserved = await request(app)
        .post(`/api/v1/tickets/${ticketId}/attachments/upload-url`)
        .set(...bearer(agentToken))
        .send({ filename: 'gone.txt', contentType: 'text/plain', sizeBytes: 4 });

      // A tier-2 specialist does not hold ticket:delete.
      const denied = await request(app)
        .delete(`/api/v1/attachments/${reserved.body.data.attachmentId}`)
        .set(...bearer(agentToken));
      expect(denied.status).toBe(403);
    });
  });

  describe('customers', () => {
    it('creates and finds a customer', async () => {
      const created = await request(app)
        .post('/api/v1/customers')
        .set(...bearer(adminToken))
        .send({
          email: 'Nyasha@Example.co.zw',
          fullName: 'Nyasha Dube',
          phone: '+263772345678',
          tier: 'priority',
          language: 'sn',
        });

      expect(created.status).toBe(201);
      // Stored lower-cased so inbound mail matches regardless of casing.
      expect(created.body.data.email).toBe('nyasha@example.co.zw');
      expect(created.body.data.tier).toBe('priority');

      const found = await request(app)
        .get('/api/v1/customers?search=nyasha')
        .set(...bearer(adminToken));
      expect(found.body.data).toHaveLength(1);
    });

    it('refuses a duplicate email', async () => {
      await request(app)
        .post('/api/v1/customers')
        .set(...bearer(adminToken))
        .send({ email: 'dup@example.co.zw', fullName: 'First' })
        .expect(201);

      const response = await request(app)
        .post('/api/v1/customers')
        .set(...bearer(adminToken))
        .send({ email: 'DUP@example.co.zw', fullName: 'Second' });

      expect(response.status).toBe(409);
    });

    it('links a product account', async () => {
      const created = await request(app)
        .post('/api/v1/customers')
        .set(...bearer(adminToken))
        .send({ email: 'linked@example.co.zw', fullName: 'Linked Person' });

      const linked = await request(app)
        .post(`/api/v1/customers/${created.body.data.id}/accounts`)
        .set(...bearer(adminToken))
        .send({ productId: walletId, externalAccountId: 'WAL-99213', status: 'active' });

      expect(linked.status).toBe(201);
      expect(linked.body.data.accounts).toHaveLength(1);
      expect(linked.body.data.accounts[0].externalAccountId).toBe('WAL-99213');
      expect(linked.body.data.accounts[0].productCode).toBe('pf_wallet');
    });

    it('merges a duplicate and moves its tickets across', async () => {
      const survivor = await request(app)
        .post('/api/v1/customers')
        .set(...bearer(adminToken))
        .send({ email: 'real@example.co.zw', fullName: 'Real Person' });
      const duplicate = await request(app)
        .post('/api/v1/customers')
        .set(...bearer(adminToken))
        .send({ email: 'typo@example.co.zw', fullName: 'Real Persn' });

      await request(app)
        .post('/api/v1/tickets')
        .set(...bearer(agentToken))
        .send({
          productId: walletId,
          subject: 'Raised under the typo address',
          body: 'help',
          customerId: duplicate.body.data.id,
        })
        .expect(201);

      const merged = await request(app)
        .post(`/api/v1/customers/${survivor.body.data.id}/merge`)
        .set(...bearer(adminToken))
        .send({ duplicateId: duplicate.body.data.id });

      expect(merged.status).toBe(200);

      const tickets = await request(app)
        .get(`/api/v1/tickets?customerId=${survivor.body.data.id}`)
        .set(...bearer(agentToken));
      expect(tickets.body.data).toHaveLength(1);

      // The duplicate is retired, not deleted, so audit history still resolves.
      await request(app)
        .get(`/api/v1/customers/${duplicate.body.data.id}`)
        .set(...bearer(adminToken))
        .expect(404);
    });

    it('refuses to merge a customer into itself', async () => {
      const customer = await request(app)
        .post('/api/v1/customers')
        .set(...bearer(adminToken))
        .send({ email: 'self@example.co.zw', fullName: 'Self' });

      const response = await request(app)
        .post(`/api/v1/customers/${customer.body.data.id}/merge`)
        .set(...bearer(adminToken))
        .send({ duplicateId: customer.body.data.id });

      expect(response.status).toBe(400);
    });

    it('stops a tier-1 agent editing customers', async () => {
      const tier1 = await createActiveUser({
        email: 'tier1@primefocus.co.zw',
        roleCode: 'tier1_agent',
      });
      const token = (await signIn(app, tier1.email, tier1.password)).accessToken;

      // customer:read is granted, customer:manage is not.
      await request(app)
        .get('/api/v1/customers')
        .set(...bearer(token))
        .expect(200);
      const response = await request(app)
        .post('/api/v1/customers')
        .set(...bearer(token))
        .send({ email: 'nope@example.co.zw', fullName: 'Nope' });

      expect(response.status).toBe(403);
    });
  });

  describe('products', () => {
    it('grants and revokes agent access', async () => {
      const newcomer = await createActiveUser({
        email: 'newcomer@primefocus.co.zw',
        roleCode: 'tier1_agent',
      });

      const granted = await request(app)
        .post(`/api/v1/products/${walletId}/agents`)
        .set(...bearer(adminToken))
        .send({ userId: newcomer.id });

      expect(granted.status).toBe(200);
      expect(granted.body.data.agents.map((row: { userId: string }) => row.userId)).toContain(
        newcomer.id,
      );

      const revoked = await request(app)
        .delete(`/api/v1/products/${walletId}/agents/${newcomer.id}`)
        .set(...bearer(adminToken));

      expect(revoked.status).toBe(200);
      expect(revoked.body.data.agents.map((row: { userId: string }) => row.userId)).not.toContain(
        newcomer.id,
      );
    });

    it('stops an agent granting themselves access', async () => {
      const lendingId = await productIdFor('pf_lending');
      const agent = await request(app)
        .get('/api/v1/auth/me')
        .set(...bearer(agentToken));

      const response = await request(app)
        .post(`/api/v1/products/${lendingId}/agents`)
        .set(...bearer(agentToken))
        .send({ userId: agent.body.data.id });

      expect(response.status).toBe(403);
    });
  });
});

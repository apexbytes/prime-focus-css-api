import { eq } from 'drizzle-orm';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { closeDatabase, db } from '../../src/db/client.js';
import { attachments } from '../../src/modules/attachment/attachment.model.js';
import { csatSurveys } from '../../src/modules/survey/survey.model.js';
import { tickets } from '../../src/modules/ticket/ticket.model.js';
import { lastEmailTo, readOutbox } from '../../src/lib/resend/index.js';
import { resetDatabase } from '../helpers/db.js';
import {
  bearer,
  createActiveUser,
  grantProduct,
  productIdFor,
  signIn,
} from '../helpers/identity.js';

/**
 * Phase 5 end to end: an answer the customer can find before raising a ticket, a
 * question asked afterwards about how it went, and a dashboard built out of both.
 *
 * `QUEUE_DRIVER` is `inline` under test, so enqueuing runs the job — which is
 * what makes the CSAT survey observable in the next request rather than an hour
 * later, and what exercises the real `survey.dispatch` and `attachment.scan`
 * handlers instead of a stand-in.
 */
const enabled = process.env.RUN_DB_TESTS === '1';
const app = createApp();

const ADMIN = 'kb.admin@primefocus.co.zw';
const AGENT = 'kb.agent@primefocus.co.zw';
const CUSTOMER = 'tendai@example.co.zw';

describe.runIf(enabled)('deflection and insight', () => {
  let adminToken: string;
  let agentToken: string;
  let agentId: string;
  let walletId: string;
  let lendingId: string;

  beforeEach(async () => {
    await resetDatabase();

    await createActiveUser({ email: ADMIN, roleCode: 'admin', fullName: 'KB Admin' });
    const agent = await createActiveUser({
      email: AGENT,
      roleCode: 'tier1_agent',
      fullName: 'Wallet Agent',
    });

    agentId = agent.id;
    walletId = await grantProduct(agent.id, 'pf_wallet');
    lendingId = await productIdFor('pf_lending');

    adminToken = (await signIn(app, ADMIN)).accessToken;
    agentToken = (await signIn(app, AGENT)).accessToken;
  });

  afterAll(async () => {
    await closeDatabase();
  });

  // -- helpers ---------------------------------------------------------------

  async function createArticle(overrides: Record<string, unknown> = {}, token = adminToken) {
    const response = await request(app)
      .post('/api/v1/kb/articles')
      .set(...bearer(token))
      .send({
        title: 'Why a transfer can fail',
        summary: 'What to check when money leaves but does not arrive.',
        body:
          'A transfer can fail because the recipient number is wrong, because the ' +
          'daily limit is reached, or because the receiving wallet is dormant. ' +
          'Check the recipient number first.',
        keywords: ['transfer', 'limit'],
        productId: walletId,
        visibility: 'public',
        ...overrides,
      });

    expect(response.status).toBe(201);
    return response.body.data as { id: string; slug: string; status: string; version: number };
  }

  async function publish(id: string, token = adminToken) {
    const response = await request(app)
      .post(`/api/v1/kb/articles/${id}/publish`)
      .set(...bearer(token));

    expect(response.status).toBe(200);
    return response.body.data as { status: string; publishedAt: string };
  }

  async function createTicket(overrides: Record<string, unknown> = {}) {
    const response = await request(app)
      .post('/api/v1/tickets')
      .set(...bearer(adminToken))
      .send({
        productId: walletId,
        subject: 'Transfer never arrived',
        body: 'I sent $50 to my brother two hours ago and the transfer never arrived.',
        customerEmail: CUSTOMER,
        customerName: 'Tendai Moyo',
        channel: 'web_form',
        ...overrides,
      });

    expect(response.status).toBe(201);
    return response.body.data as { id: string; reference: string };
  }

  /** Reports read materialised views, so a spec has to rebuild them first. */
  async function refreshReports() {
    await request(app)
      .post('/api/v1/reports/refresh')
      .set(...bearer(adminToken))
      .expect(200);
  }

  // -- knowledge base --------------------------------------------------------

  describe('the knowledge base', () => {
    it('creates an article as a draft, whatever the author intended', async () => {
      const article = await createArticle();

      // Publishing is its own decision and its own endpoint.
      expect(article.status).toBe('draft');
      expect(article.slug).toBe('why-a-transfer-can-fail');
      expect(article.version).toBe(1);
    });

    it('gives a second article with the same title a distinct slug', async () => {
      const first = await createArticle();
      const second = await createArticle();

      expect(second.slug).toBe(`${first.slug}-2`);
    });

    it('will not publish through PATCH, only through the publish endpoint', async () => {
      const article = await createArticle();

      const response = await request(app)
        .patch(`/api/v1/kb/articles/${article.id}`)
        .set(...bearer(adminToken))
        .send({ status: 'published' });

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_ERROR');
      expect(response.body.error.details[0].issue).toContain('publish');
    });

    it('keeps a revision of what an article said before an edit', async () => {
      const article = await createArticle();

      await request(app)
        .patch(`/api/v1/kb/articles/${article.id}`)
        .set(...bearer(adminToken))
        .send({ body: 'Check the recipient number, then the daily limit, then dormancy.' })
        .expect(200);

      const revisions = await request(app)
        .get(`/api/v1/kb/articles/${article.id}/revisions`)
        .set(...bearer(adminToken))
        .expect(200);

      expect(revisions.body.data).toHaveLength(1);
      expect(revisions.body.data[0].version).toBe(1);
      expect(revisions.body.data[0].body).toContain('Check the recipient number first.');
    });

    it('finds a published article by a word only in its body', async () => {
      const article = await createArticle();
      await publish(article.id);

      const response = await request(app)
        .get('/api/v1/kb/search')
        .query({ q: 'dormant' })
        .set(...bearer(agentToken))
        .expect(200);

      expect(response.body.data).toHaveLength(1);
      expect(response.body.data[0].id).toBe(article.id);
      // ts_headline marks the terms it matched, which is what a result list shows.
      expect(response.body.data[0].excerpt).toContain('<mark>');
    });

    it('ranks a title match above a body mention', async () => {
      const titled = await createArticle({ title: 'Daily limit reached' });
      const mentioned = await createArticle({
        title: 'Dormant wallets',
        body: 'A dormant wallet cannot receive money. This is not about a daily limit at all.',
      });
      await publish(titled.id);
      await publish(mentioned.id);

      const response = await request(app)
        .get('/api/v1/kb/search')
        .query({ q: 'daily limit' })
        .set(...bearer(agentToken))
        .expect(200);

      expect(response.body.data[0].id).toBe(titled.id);
      expect(response.body.data[0].rank).toBeGreaterThan(response.body.data[1].rank);
    });

    it('does not return a draft to a search', async () => {
      await createArticle();

      const response = await request(app)
        .get('/api/v1/kb/search')
        .query({ q: 'dormant' })
        .set(...bearer(agentToken))
        .expect(200);

      expect(response.body.data).toEqual([]);
    });

    it('keeps an internal runbook out of results unless it is asked for', async () => {
      const runbook = await createArticle({
        title: 'Reversing a fraudulent transfer',
        body: 'Escalate to the fraud desk on extension 4102 before reversing anything at all.',
        visibility: 'internal',
      });
      await publish(runbook.id);

      const withoutFlag = await request(app)
        .get('/api/v1/kb/search')
        .query({ q: 'fraudulent' })
        .set(...bearer(agentToken))
        .expect(200);
      expect(withoutFlag.body.data).toEqual([]);

      const withFlag = await request(app)
        .get('/api/v1/kb/search')
        .query({ q: 'fraudulent', includeInternal: 'true' })
        .set(...bearer(agentToken))
        .expect(200);
      expect(withFlag.body.data).toHaveLength(1);
    });

    it('never suggests an internal runbook, however it is asked', async () => {
      const runbook = await createArticle({
        title: 'Reversing a fraudulent transfer',
        body: 'Escalate to the fraud desk on extension 4102 before reversing anything at all.',
        visibility: 'internal',
      });
      await publish(runbook.id);

      // `includeInternal` is not even a parameter here: suggest exists to put
      // text in front of a customer.
      const response = await request(app)
        .get('/api/v1/kb/suggest')
        .query({ subject: 'fraudulent transfer', includeInternal: 'true' })
        .set(...bearer(adminToken))
        .expect(200);

      expect(response.body.data).toEqual([]);
    });

    it('suggests an answer from what the customer was about to type', async () => {
      const article = await createArticle();
      await publish(article.id);

      const response = await request(app)
        .get('/api/v1/kb/suggest')
        .query({
          subject: 'My transfer never arrived',
          body: 'I sent money and it did not arrive. Please help, this is urgent.',
        })
        .set(...bearer(adminToken))
        .expect(200);

      expect(response.body.data).toHaveLength(1);
      expect(response.body.data[0].id).toBe(article.id);
    });

    it('suggests nothing rather than something arbitrary', async () => {
      const article = await createArticle();
      await publish(article.id);

      const response = await request(app)
        .get('/api/v1/kb/suggest')
        .query({ subject: 'Please help', body: 'Thanks, urgent issue' })
        .set(...bearer(adminToken))
        .expect(200);

      // Nothing distinctive in the query, so nothing honest to offer.
      expect(response.body.data).toEqual([]);
    });

    it('hides another product’s article from an agent who does not work it', async () => {
      const lending = await createArticle({
        productId: lendingId,
        title: 'Settlement letters',
        body: 'A settlement letter is issued once the final repayment has cleared the account.',
      });
      await publish(lending.id);

      const search = await request(app)
        .get('/api/v1/kb/search')
        .query({ q: 'settlement' })
        .set(...bearer(agentToken))
        .expect(200);
      expect(search.body.data).toEqual([]);

      // 404 rather than 403: whether it exists is itself information.
      await request(app)
        .get(`/api/v1/kb/articles/${lending.id}`)
        .set(...bearer(agentToken))
        .expect(404);
    });

    it('shows an article with no product to every agent', async () => {
      const general = await createArticle({
        productId: null,
        title: 'Reading your statement',
        body: 'Every statement shows the opening balance, the movements, and the closing balance.',
      });
      await publish(general.id);

      const response = await request(app)
        .get('/api/v1/kb/search')
        .query({ q: 'statement' })
        .set(...bearer(agentToken))
        .expect(200);

      expect(response.body.data).toHaveLength(1);
    });

    it('resolves an article by slug as well as by id, and counts the read', async () => {
      const article = await createArticle();
      await publish(article.id);

      const bySlug = await request(app)
        .get(`/api/v1/kb/articles/${article.slug}`)
        .set(...bearer(agentToken))
        .expect(200);

      expect(bySlug.body.data.id).toBe(article.id);
      expect(bySlug.body.data.viewCount).toBeGreaterThan(0);
    });

    it('moves both counters when a reader changes their vote', async () => {
      const article = await createArticle();
      await publish(article.id);

      const helpful = await request(app)
        .post(`/api/v1/kb/articles/${article.id}/feedback`)
        .set(...bearer(agentToken))
        .send({ helpful: true })
        .expect(201);
      expect(helpful.body.data.helpfulCount).toBe(1);
      expect(helpful.body.data.notHelpfulCount).toBe(0);

      const changed = await request(app)
        .post(`/api/v1/kb/articles/${article.id}/feedback`)
        .set(...bearer(agentToken))
        .send({ helpful: false, comment: 'Did not cover a dormant recipient.' })
        .expect(201);

      // One vote per person: the vote moved, it did not accumulate.
      expect(changed.body.data.helpfulCount).toBe(0);
      expect(changed.body.data.notHelpfulCount).toBe(1);
    });

    it('refuses to let a tier-1 agent write an article', async () => {
      const response = await request(app)
        .post('/api/v1/kb/articles')
        .set(...bearer(agentToken))
        .send({
          title: 'Something I made up',
          body: 'This is copy about a financial product and needs an editor.',
          visibility: 'public',
        });

      expect(response.status).toBe(403);
    });
  });

  // -- CSAT ------------------------------------------------------------------

  describe('customer satisfaction', () => {
    /** Resolving is what earns the survey; a reply first, since an unanswered
     * ticket has nothing to rate. */
    async function resolveWithReply(ticketId: string) {
      await request(app)
        .post(`/api/v1/tickets/${ticketId}/messages`)
        .set(...bearer(adminToken))
        .send({ body: 'Reversed, the money is back in your wallet.', visibility: 'public' })
        .expect(201);

      await request(app)
        .patch(`/api/v1/tickets/${ticketId}`)
        .set(...bearer(adminToken))
        .send({ status: 'resolved' })
        .expect(200);
    }

    function tokenFromSurveyEmail(): string {
      const message = lastEmailTo(CUSTOMER);
      if (!message) throw new Error('no survey email captured');

      const match = /token=([\w.-]+)/.exec(message.text);
      if (!match?.[1]) throw new Error('no survey token in the email');
      return match[1];
    }

    it('emails a survey once a replied-to ticket is resolved', async () => {
      const ticket = await createTicket();
      await resolveWithReply(ticket.id);

      const survey = await request(app)
        .get(`/api/v1/tickets/${ticket.id}/survey`)
        .set(...bearer(adminToken))
        .expect(200);

      expect(survey.body.data).not.toBeNull();
      expect(survey.body.data.sentAt).not.toBeNull();
      expect(survey.body.data.score).toBeNull();

      const email = lastEmailTo(CUSTOMER);
      expect(email?.kind).toBe('csat_survey');
      expect(email?.subject).toContain(ticket.reference);
      // Five one-click links, one per score.
      expect(email?.text).toContain('1: ');
      expect(email?.text).toContain('5: ');
    });

    it('does not survey a ticket the customer was never replied to', async () => {
      const ticket = await createTicket();

      // Closed as a duplicate without a word to the customer.
      await request(app)
        .patch(`/api/v1/tickets/${ticket.id}`)
        .set(...bearer(adminToken))
        .send({ status: 'closed' })
        .expect(200);

      const survey = await request(app)
        .get(`/api/v1/tickets/${ticket.id}/survey`)
        .set(...bearer(adminToken))
        .expect(200);

      expect(survey.body.data).toBeNull();
    });

    it('surveys a customer once, however many tickets they raise', async () => {
      const first = await createTicket();
      await resolveWithReply(first.id);

      const second = await createTicket({ subject: 'Airtime not delivered' });
      await resolveWithReply(second.id);

      const surveys = await db.select().from(csatSurveys);
      // Survey fatigue is how a response rate reaches zero.
      expect(surveys).toHaveLength(1);
      expect(surveys[0]?.ticketId).toBe(first.id);
    });

    it('does not survey twice when a resolved ticket is then closed', async () => {
      const ticket = await createTicket();
      await resolveWithReply(ticket.id);

      await request(app)
        .patch(`/api/v1/tickets/${ticket.id}`)
        .set(...bearer(adminToken))
        .send({ status: 'closed' })
        .expect(200);

      expect(await db.select().from(csatSurveys)).toHaveLength(1);
    });

    it('lets the customer read and answer the survey without an account', async () => {
      const ticket = await createTicket();
      await resolveWithReply(ticket.id);
      const token = tokenFromSurveyEmail();

      // No Authorization header anywhere below: the token is the credential.
      const prompt = await request(app).get(`/api/v1/surveys/${token}`).expect(200);
      expect(prompt.body.data.reference).toBe(ticket.reference);
      expect(prompt.body.data.score).toBeNull();

      const answered = await request(app)
        .post(`/api/v1/surveys/${token}`)
        .send({ score: 5, comment: 'Sorted in ten minutes.' })
        .expect(200);

      expect(answered.body.data.score).toBe(5);
      expect(answered.body.data.respondedAt).not.toBeNull();
    });

    it('tells the survey page nothing about the ticket beyond its subject', async () => {
      const ticket = await createTicket();
      await resolveWithReply(ticket.id);

      const prompt = await request(app)
        .get(`/api/v1/surveys/${tokenFromSurveyEmail()}`)
        .expect(200);

      // Unauthenticated and reachable by anyone holding the link.
      expect(Object.keys(prompt.body.data).sort()).toEqual([
        'comment',
        'customerName',
        'expiresAt',
        'productName',
        'reference',
        'respondedAt',
        'score',
        'subject',
      ]);
    });

    it('answers a survey once and refuses a second score', async () => {
      const ticket = await createTicket();
      await resolveWithReply(ticket.id);
      const token = tokenFromSurveyEmail();

      await request(app).post(`/api/v1/surveys/${token}`).send({ score: 5 }).expect(200);

      const again = await request(app).post(`/api/v1/surveys/${token}`).send({ score: 1 });
      expect(again.status).toBe(409);
    });

    it('gives one unhelpful answer to any bad token', async () => {
      const unknown = await request(app).get(`/api/v1/surveys/${'x'.repeat(43)}`);
      expect(unknown.status).toBe(404);
      expect(unknown.body.error.message).not.toMatch(/expired/i);
    });

    it('rejects a score outside the scale', async () => {
      const ticket = await createTicket();
      await resolveWithReply(ticket.id);
      const token = tokenFromSurveyEmail();

      await request(app).post(`/api/v1/surveys/${token}`).send({ score: 6 }).expect(400);
      await request(app).post(`/api/v1/surveys/${token}`).send({ score: 0 }).expect(400);
    });

    it('stores no usable rating link in the database', async () => {
      const ticket = await createTicket();
      await resolveWithReply(ticket.id);
      const token = tokenFromSurveyEmail();

      const [survey] = await db
        .select()
        .from(csatSurveys)
        .where(eq(csatSurveys.ticketId, ticket.id));

      expect(survey?.tokenHash).not.toContain(token);
      expect(survey?.tokenHash).toHaveLength(64);
    });
  });

  // -- attachment scanning ---------------------------------------------------

  describe('attachment scanning', () => {
    async function uploadFile(ticketId: string, filename = 'statement.pdf') {
      const reserved = await request(app)
        .post(`/api/v1/tickets/${ticketId}/attachments/upload-url`)
        .set(...bearer(adminToken))
        .send({ filename, contentType: 'application/pdf', sizeBytes: 12 })
        .expect(201);

      const { attachmentId, uploadUrl } = reserved.body.data as {
        attachmentId: string;
        uploadUrl: string;
      };

      await request(app)
        .put(new URL(uploadUrl).pathname)
        .set(...bearer(adminToken))
        .set('content-type', 'application/pdf')
        .send(Buffer.from('%PDF-1.4 xxx'))
        .expect(200);

      return attachmentId;
    }

    it('records an upload as scanned-and-skipped when no scanner is configured', async () => {
      const ticket = await createTicket();
      const attachmentId = await uploadFile(ticket.id);

      const [row] = await db.select().from(attachments).where(eq(attachments.id, attachmentId));

      // `skipped`, not `clean`: nothing looked at it, and the console must not
      // be told otherwise.
      expect(row?.status).toBe('skipped');
    });

    it('lets a skipped attachment be downloaded', async () => {
      const ticket = await createTicket();
      const attachmentId = await uploadFile(ticket.id);

      await request(app)
        .get(`/api/v1/attachments/${attachmentId}/download`)
        .set(...bearer(adminToken))
        .expect(200);
    });

    it('blocks a download while a scan has not answered', async () => {
      const ticket = await createTicket();
      const attachmentId = await uploadFile(ticket.id);

      // What a scanner outage leaves behind: bytes on file, no verdict.
      await db
        .update(attachments)
        .set({ status: 'uploaded' })
        .where(eq(attachments.id, attachmentId));

      const blocked = await request(app)
        .get(`/api/v1/attachments/${attachmentId}/download`)
        .set(...bearer(adminToken));

      expect(blocked.status).toBe(409);
    });

    it('unsticks a stuck attachment through a rescan', async () => {
      const ticket = await createTicket();
      const attachmentId = await uploadFile(ticket.id);

      await db
        .update(attachments)
        .set({ status: 'uploaded' })
        .where(eq(attachments.id, attachmentId));

      await request(app)
        .post(`/api/v1/attachments/${attachmentId}/rescan`)
        .set(...bearer(adminToken))
        .expect(202);

      // Inline driver: the job has already run and settled it.
      const [row] = await db.select().from(attachments).where(eq(attachments.id, attachmentId));
      expect(row?.status).toBe('skipped');
    });

    it('still refuses an executable before any scanner sees it', async () => {
      const ticket = await createTicket();

      const response = await request(app)
        .post(`/api/v1/tickets/${ticket.id}/attachments/upload-url`)
        .set(...bearer(adminToken))
        .send({ filename: 'invoice.exe', contentType: 'application/octet-stream', sizeBytes: 10 });

      expect(response.status).toBe(400);
    });
  });

  // -- reporting -------------------------------------------------------------

  describe('reporting', () => {
    it('reports volume once the views are rebuilt', async () => {
      await createTicket();
      await createTicket({ subject: 'Airtime not delivered', priority: 'high' });
      await refreshReports();

      const response = await request(app)
        .get('/api/v1/reports/volume')
        .set(...bearer(adminToken))
        .expect(200);

      expect(response.body.data.created).toBe(2);
      expect(response.body.data.byChannel[0]).toMatchObject({ key: 'web_form' });
      expect(response.body.data.byPriority.map((b: { key: string }) => b.key).sort()).toEqual([
        'high',
        'normal',
      ]);
    });

    it('says how stale it is, and admits when it has never been refreshed', async () => {
      await createTicket();

      const never = await request(app)
        .get('/api/v1/reports/volume')
        .set(...bearer(adminToken))
        .expect(200);

      expect(never.body.data.meta.refreshedAt).toBeNull();
      expect(never.body.data.meta.stale).toBe(true);

      await refreshReports();

      const fresh = await request(app)
        .get('/api/v1/reports/volume')
        .set(...bearer(adminToken))
        .expect(200);

      expect(fresh.body.data.meta.refreshedAt).not.toBeNull();
      expect(fresh.body.data.meta.stale).toBe(false);
    });

    it('measures SLA compliance from the targets, excluding the ones still running', async () => {
      const ticket = await createTicket();

      await request(app)
        .post(`/api/v1/tickets/${ticket.id}/messages`)
        .set(...bearer(adminToken))
        .send({ body: 'Looking at it now.', visibility: 'public' })
        .expect(201);

      await refreshReports();

      const response = await request(app)
        .get('/api/v1/reports/sla')
        .set(...bearer(adminToken))
        .expect(200);

      // The first response happened, so that clock is met at 100%.
      expect(response.body.data.firstResponse.met).toBe(1);
      expect(response.body.data.firstResponse.compliancePercent).toBe(100);
      // The resolution clock is still running: neither met nor breached, and so
      // not a percentage of anything yet.
      expect(response.body.data.resolution.running).toBe(1);
      expect(response.body.data.resolution.compliancePercent).toBeNull();
    });

    it('attributes replies and resolutions to the agent who made them', async () => {
      const ticket = await createTicket();

      await request(app)
        .post(`/api/v1/tickets/${ticket.id}/assign`)
        .set(...bearer(adminToken))
        .send({ assignedToUserId: agentId })
        .expect(200);

      await request(app)
        .post(`/api/v1/tickets/${ticket.id}/messages`)
        .set(...bearer(agentToken))
        .send({ body: 'Reversed for you.', visibility: 'public' })
        .expect(201);

      await request(app)
        .patch(`/api/v1/tickets/${ticket.id}`)
        .set(...bearer(adminToken))
        .send({ status: 'resolved' })
        .expect(200);

      await refreshReports();

      const response = await request(app)
        .get('/api/v1/reports/agents')
        .set(...bearer(adminToken))
        .expect(200);

      const agent = response.body.data.agents.find(
        (row: { userId: string }) => row.userId === agentId,
      );

      expect(agent).toBeDefined();
      expect(agent.publicReplies).toBe(1);
      expect(agent.resolvedCount).toBe(1);
      expect(agent.email).toBe(AGENT);
    });

    it('reports satisfaction as a share of the surveys actually answered', async () => {
      const ticket = await createTicket();

      await request(app)
        .post(`/api/v1/tickets/${ticket.id}/messages`)
        .set(...bearer(adminToken))
        .send({ body: 'Reversed.', visibility: 'public' })
        .expect(201);
      await request(app)
        .patch(`/api/v1/tickets/${ticket.id}`)
        .set(...bearer(adminToken))
        .send({ status: 'resolved' })
        .expect(200);

      const message = lastEmailTo(CUSTOMER);
      const token = /token=([\w.-]+)/.exec(message?.text ?? '')?.[1] as string;
      await request(app).post(`/api/v1/surveys/${token}`).send({ score: 4 }).expect(200);

      await refreshReports();

      const response = await request(app)
        .get('/api/v1/reports/csat')
        .set(...bearer(adminToken))
        .expect(200);

      expect(response.body.data.surveysSent).toBe(1);
      expect(response.body.data.responses).toBe(1);
      expect(response.body.data.responseRatePercent).toBe(100);
      expect(response.body.data.averageScore).toBe(4);
      expect(response.body.data.satisfactionPercent).toBe(100);
    });

    it('counts the backlog live rather than from a view', async () => {
      await createTicket();
      // Not refreshed: the backlog is a level, not a flow, and a snapshot from
      // fifteen minutes ago is not the queue length.
      const response = await request(app)
        .get('/api/v1/reports/overview')
        .set(...bearer(adminToken))
        .expect(200);

      expect(response.body.data.tickets.openNow).toBe(1);
      expect(response.body.data.tickets.unassignedNow).toBeGreaterThanOrEqual(0);
    });

    it('reports knowledge base usage alongside ticket volume', async () => {
      const article = await createArticle();
      await publish(article.id);

      await request(app)
        .get('/api/v1/kb/suggest')
        .query({ subject: 'My transfer never arrived and the money is gone' })
        .set(...bearer(adminToken))
        .expect(200);

      await createTicket();
      await refreshReports();

      const response = await request(app)
        .get('/api/v1/reports/overview')
        .set(...bearer(adminToken))
        .expect(200);

      expect(response.body.data.knowledgeBase.published).toBe(1);
      expect(response.body.data.knowledgeBase.suggested).toBe(1);
      expect(response.body.data.knowledgeBase.suggestionsPerTicket).toBe(1);
    });

    it('scopes a report to the products the reader works', async () => {
      // A tier-2 specialist holds report:view but is product-scoped.
      const specialist = await createActiveUser({
        email: 'kb.tier2@primefocus.co.zw',
        roleCode: 'tier2_specialist',
        fullName: 'Wallet Specialist',
      });
      await grantProduct(specialist.id, 'pf_wallet');
      const specialistToken = (await signIn(app, specialist.email)).accessToken;

      await createTicket();
      await createTicket({ productId: lendingId, subject: 'Loan not disbursed' });
      await refreshReports();

      const scoped = await request(app)
        .get('/api/v1/reports/volume')
        .set(...bearer(specialistToken))
        .expect(200);
      expect(scoped.body.data.created).toBe(1);

      const unscoped = await request(app)
        .get('/api/v1/reports/volume')
        .set(...bearer(adminToken))
        .expect(200);
      expect(unscoped.body.data.created).toBe(2);
    });

    it('refuses a report to an agent without report:view', async () => {
      await request(app)
        .get('/api/v1/reports/overview')
        .set(...bearer(agentToken))
        .expect(403);
    });

    it('refuses a refresh to somebody who may only read reports', async () => {
      const specialist = await createActiveUser({
        email: 'kb.reader@primefocus.co.zw',
        roleCode: 'tier2_specialist',
      });
      const token = (await signIn(app, specialist.email)).accessToken;

      await request(app)
        .get('/api/v1/reports/overview')
        .set(...bearer(token))
        .expect(200);
      await request(app)
        .post('/api/v1/reports/refresh')
        .set(...bearer(token))
        .expect(403);
    });
  });

  // -- digest and retention --------------------------------------------------

  describe('the morning digest', () => {
    it('emails an agent about the work waiting for them, and nobody else', async () => {
      const ticket = await createTicket();
      await request(app)
        .post(`/api/v1/tickets/${ticket.id}/assign`)
        .set(...bearer(adminToken))
        .send({ assignedToUserId: agentId })
        .expect(200);

      const { sendDailyDigest } = await import('../../src/modules/notification/index.js');
      const result = await sendDailyDigest();

      expect(result.sent).toBeGreaterThan(0);

      const digest = readOutbox().filter((mail) => mail.kind === 'notification_digest');
      const recipients = digest.map((mail) => mail.to);

      // The agent has a ticket and an assignment notification; the admin who
      // assigned it has neither, so gets no email.
      expect(recipients).toContain(AGENT);
      expect(recipients).not.toContain(ADMIN);
      expect(digest[0]?.text).toContain('Open tickets assigned to you: 1');
    });
  });

  describe('data retention', () => {
    let superToken: string;

    beforeEach(async () => {
      // `retention:run` is held only through the super_admin wildcard, so the
      // sweep needs one. That an `admin` token cannot do this is asserted below.
      const superAdmin = await createActiveUser({
        email: 'kb.super@primefocus.co.zw',
        roleCode: 'super_admin',
        fullName: 'Super Administrator',
      });
      superToken = (await signIn(app, superAdmin.email)).accessToken;
    });

    it('reports the policy and what is past it without touching anything', async () => {
      const response = await request(app)
        .get('/api/v1/retention/policy')
        .set(...bearer(adminToken))
        .expect(200);

      expect(response.body.data.auditLogYears).toBe(7);
      expect(response.body.data.ticketYears).toBe(5);
      // The audit trail has to outlive the content it describes.
      expect(new Date(response.body.data.cutoffs.auditLogsBefore).getTime()).toBeLessThan(
        new Date(response.body.data.cutoffs.ticketContentBefore).getTime(),
      );
      expect(response.body.data.pending.tickets).toBe(0);
    });

    it('dry-runs by default, so an empty POST destroys nothing', async () => {
      const ticket = await createTicket();

      // Resolved six years ago: genuinely past the five-year content period.
      await db
        .update(tickets)
        .set({ status: 'resolved', resolvedAt: sixYearsAgo() })
        .where(eq(tickets.id, ticket.id));

      const dryRun = await request(app)
        .post('/api/v1/retention/sweep')
        .set(...bearer(superToken))
        .send({})
        .expect(200);

      expect(dryRun.body.data.dryRun).toBe(true);
      expect(dryRun.body.data.ticketsAnonymised).toBe(1);

      // Nothing actually moved.
      const [untouched] = await db.select().from(tickets).where(eq(tickets.id, ticket.id));
      expect(untouched?.anonymisedAt).toBeNull();
      expect(untouched?.subject).toBe('Transfer never arrived');
    });

    it('strips the content of a ticket past its retention period', async () => {
      const ticket = await createTicket();
      await db
        .update(tickets)
        .set({ status: 'resolved', resolvedAt: sixYearsAgo() })
        .where(eq(tickets.id, ticket.id));

      const swept = await request(app)
        .post('/api/v1/retention/sweep')
        .set(...bearer(superToken))
        .send({ dryRun: false })
        .expect(200);

      expect(swept.body.data.ticketsAnonymised).toBe(1);
      expect(swept.body.data.messagesAnonymised).toBeGreaterThan(0);

      const [stripped] = await db.select().from(tickets).where(eq(tickets.id, ticket.id));
      expect(stripped?.anonymisedAt).not.toBeNull();
      expect(stripped?.subject).toContain('content removed');
      // The row survives, so five-year-old volume figures do not change.
      expect(stripped?.createdAt).toBeDefined();
    });

    it('does not sweep the same ticket twice', async () => {
      const ticket = await createTicket();
      await db
        .update(tickets)
        .set({ status: 'resolved', resolvedAt: sixYearsAgo() })
        .where(eq(tickets.id, ticket.id));

      await request(app)
        .post('/api/v1/retention/sweep')
        .set(...bearer(superToken))
        .send({ dryRun: false })
        .expect(200);

      const second = await request(app)
        .post('/api/v1/retention/sweep')
        .set(...bearer(superToken))
        .send({ dryRun: false })
        .expect(200);

      expect(second.body.data.ticketsAnonymised).toBe(0);
    });

    it('leaves a recently resolved ticket alone', async () => {
      const ticket = await createTicket();
      await request(app)
        .patch(`/api/v1/tickets/${ticket.id}`)
        .set(...bearer(adminToken))
        .send({ status: 'resolved' })
        .expect(200);

      const swept = await request(app)
        .post('/api/v1/retention/sweep')
        .set(...bearer(superToken))
        .send({ dryRun: false })
        .expect(200);

      expect(swept.body.data.ticketsAnonymised).toBe(0);
    });

    it('refuses the sweep to an administrator who is not a super administrator', async () => {
      // Running the support operation does not include permanently destroying
      // five-year-old customer records by hand. Reading the policy does.
      await request(app)
        .post('/api/v1/retention/sweep')
        .set(...bearer(adminToken))
        .send({})
        .expect(403);

      await request(app)
        .get('/api/v1/retention/policy')
        .set(...bearer(adminToken))
        .expect(200);
    });
  });
});

function sixYearsAgo(): Date {
  const date = new Date();
  date.setUTCFullYear(date.getUTCFullYear() - 6);
  return date;
}

import { eq, sql } from 'drizzle-orm';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { closeDatabase, db } from '../../src/db/client.js';
import { escalations } from '../../src/modules/escalation/escalation.model.js';
import { notifications } from '../../src/modules/notification/notification.model.js';
import { ticketSlaTargets } from '../../src/modules/sla/sla.model.js';
import { invalidateCalendarCache } from '../../src/modules/sla/sla.service.js';
import { teams } from '../../src/modules/team/team.model.js';
import { users } from '../../src/modules/user/user.model.js';
import { resetDatabase } from '../helpers/db.js';
import {
  bearer,
  createActiveUser,
  grantProduct,
  productIdFor,
  signIn,
} from '../helpers/identity.js';

/**
 * Phase 4 end to end: a ticket arrives, gets a deadline and an owner without
 * anyone touching it, the clock stops and starts as the conversation does, and a
 * missed deadline escalates on its own.
 *
 * `QUEUE_DRIVER` is `inline` under test, so enqueuing a job runs it. That is what
 * makes routing observable in the response to the next request rather than
 * whenever a worker happens to pick it up.
 */
const enabled = process.env.RUN_DB_TESTS === '1';
const app = createApp();

const ADMIN = 'sla.admin@primefocus.co.zw';
const AGENT = 'sla.agent@primefocus.co.zw';
const BUSY_AGENT = 'sla.busy@primefocus.co.zw';
const CUSTOMER = 'rudo@example.co.zw';

describe.runIf(enabled)('routing, SLA and escalation', () => {
  let adminToken: string;
  let agentToken: string;
  let agentId: string;
  let busyAgentId: string;
  let walletId: string;

  beforeEach(async () => {
    await resetDatabase();

    await createActiveUser({ email: ADMIN, roleCode: 'admin', fullName: 'SLA Admin' });
    const agent = await createActiveUser({
      email: AGENT,
      roleCode: 'tier1_agent',
      fullName: 'Available Agent',
    });
    const busy = await createActiveUser({
      email: BUSY_AGENT,
      roleCode: 'tier1_agent',
      fullName: 'Busy Agent',
    });

    agentId = agent.id;
    busyAgentId = busy.id;
    walletId = await grantProduct(agent.id, 'pf_wallet');
    await grantProduct(busy.id, 'pf_wallet');

    adminToken = (await signIn(app, ADMIN)).accessToken;
    agentToken = (await signIn(app, AGENT)).accessToken;
  });

  afterAll(async () => {
    await closeDatabase();
  });

  /** Routing only considers agents who are at their desk. */
  async function setOnline(
    userId: string,
    availability: 'online' | 'away' | 'offline' = 'online',
  ): Promise<void> {
    await db.update(users).set({ availability }).where(eq(users.id, userId));
  }

  async function createTicket(overrides: Record<string, unknown> = {}) {
    const response = await request(app)
      .post('/api/v1/tickets')
      .set(...bearer(adminToken))
      .send({
        productId: walletId,
        subject: 'Transfer never arrived',
        body: 'I sent $50 two hours ago and nothing came through.',
        customerEmail: CUSTOMER,
        customerName: 'Rudo Chikwanha',
        channel: 'web_form',
        ...overrides,
      });

    expect(response.status).toBe(201);
    return response.body.data as { id: string; reference: string; assignedToUserId: string | null };
  }

  function slaFor(ticketId: string, token = adminToken) {
    return request(app)
      .get(`/api/v1/tickets/${ticketId}/sla`)
      .set(...bearer(token));
  }

  describe('SLA targets', () => {
    it('attaches a first-response and a resolution deadline on creation', async () => {
      const ticket = await createTicket();

      const response = await slaFor(ticket.id);
      expect(response.status).toBe(200);

      const kinds = response.body.data.targets.map((target: { kind: string }) => target.kind);
      expect(kinds).toEqual(expect.arrayContaining(['first_response', 'resolution']));
      expect(response.body.data.breaches).toEqual([]);

      // `normal` priority from the seeded policy: 120 minutes to first reply.
      const first = response.body.data.targets.find(
        (target: { kind: string }) => target.kind === 'first_response',
      );
      expect(first.targetMinutes).toBe(120);
      expect(new Date(first.dueAt).getTime()).toBeGreaterThan(Date.now() - 1000);
      expect(first.satisfiedAt).toBeNull();
      expect(first.paused).toBe(false);
    });

    it('gives an urgent ticket a tighter deadline than a normal one', async () => {
      const normal = await createTicket();
      const urgent = await createTicket({ priority: 'urgent', subject: 'Account emptied' });

      const [normalSla, urgentSla] = await Promise.all([slaFor(normal.id), slaFor(urgent.id)]);

      const minutesOf = (body: any, kind: string) =>
        body.data.targets.find((target: { kind: string }) => target.kind === kind).targetMinutes;

      expect(minutesOf(urgentSla.body, 'first_response')).toBe(15);
      expect(minutesOf(normalSla.body, 'first_response')).toBe(120);
      expect(minutesOf(urgentSla.body, 'resolution')).toBeLessThan(
        minutesOf(normalSla.body, 'resolution'),
      );
    });

    it('stops the first-response clock on the first public reply', async () => {
      await setOnline(agentId);
      const ticket = await createTicket();

      await request(app)
        .post(`/api/v1/tickets/${ticket.id}/messages`)
        .set(...bearer(agentToken))
        .send({ body: 'Looking into this now.', visibility: 'public' })
        .expect(201);

      const first = (await slaFor(ticket.id)).body.data.targets.find(
        (target: { kind: string }) => target.kind === 'first_response',
      );

      expect(first.satisfiedAt).not.toBeNull();
      // The resolution clock is still running: replying is not resolving.
      const resolution = (await slaFor(ticket.id)).body.data.targets.find(
        (target: { kind: string }) => target.kind === 'resolution',
      );
      expect(resolution.satisfiedAt).toBeNull();
    });

    it('does not count an internal note as a first response', async () => {
      const ticket = await createTicket();

      await request(app)
        .post(`/api/v1/tickets/${ticket.id}/messages`)
        .set(...bearer(adminToken))
        .send({ body: 'Anyone seen this before?', visibility: 'internal' })
        .expect(201);

      const first = (await slaFor(ticket.id)).body.data.targets.find(
        (target: { kind: string }) => target.kind === 'first_response',
      );
      expect(first.satisfiedAt).toBeNull();
    });

    it('satisfies the resolution clock when the ticket is resolved', async () => {
      const ticket = await createTicket();

      await request(app)
        .patch(`/api/v1/tickets/${ticket.id}`)
        .set(...bearer(adminToken))
        .send({ status: 'resolved' })
        .expect(200);

      const resolution = (await slaFor(ticket.id)).body.data.targets.find(
        (target: { kind: string }) => target.kind === 'resolution',
      );
      expect(resolution.satisfiedAt).not.toBeNull();
    });

    it('pauses the clock while waiting on the customer, and pushes the deadline on resume', async () => {
      const ticket = await createTicket();

      const before = (await slaFor(ticket.id)).body.data.targets.find(
        (target: { kind: string }) => target.kind === 'resolution',
      );

      await request(app)
        .patch(`/api/v1/tickets/${ticket.id}`)
        .set(...bearer(adminToken))
        .send({ status: 'pending' })
        .expect(200);

      const paused = (await slaFor(ticket.id)).body.data.targets.find(
        (target: { kind: string }) => target.kind === 'resolution',
      );
      expect(paused.paused).toBe(true);
      // No countdown is meaningful while the clock is stopped.
      expect(paused.minutesRemaining).toBeNull();

      // Backdate the pause so resuming has measurable time to give back.
      await db
        .update(ticketSlaTargets)
        .set({ pausedAt: sql`now() - interval '30 minutes'` })
        .where(eq(ticketSlaTargets.ticketId, ticket.id));

      await request(app)
        .patch(`/api/v1/tickets/${ticket.id}`)
        .set(...bearer(adminToken))
        .send({ status: 'open' })
        .expect(200);

      const resumed = (await slaFor(ticket.id)).body.data.targets.find(
        (target: { kind: string }) => target.kind === 'resolution',
      );

      expect(resumed.paused).toBe(false);
      expect(resumed.pausedAt ?? null).toBeNull();
      // The deadline moved out by roughly the working time the pause cost.
      expect(new Date(resumed.dueAt).getTime()).toBeGreaterThan(new Date(before.dueAt).getTime());
    });

    it('gives a reopened ticket a fresh resolution deadline', async () => {
      const ticket = await createTicket();

      await request(app)
        .patch(`/api/v1/tickets/${ticket.id}`)
        .set(...bearer(adminToken))
        .send({ status: 'resolved' })
        .expect(200);

      await request(app)
        .post(`/api/v1/tickets/${ticket.id}/reopen`)
        .set(...bearer(adminToken))
        .send({ reason: 'Customer says it is still broken' })
        .expect(200);

      const resolution = (await slaFor(ticket.id)).body.data.targets.find(
        (target: { kind: string }) => target.kind === 'resolution',
      );
      expect(resolution.satisfiedAt).toBeNull();
      expect(resolution.breachedAt).toBeNull();
    });
  });

  describe('auto-assignment', () => {
    it('assigns a new ticket to an available agent without human input', async () => {
      await setOnline(agentId);
      const ticket = await createTicket();

      const stored = await request(app)
        .get(`/api/v1/tickets/${ticket.id}`)
        .set(...bearer(adminToken))
        .expect(200);

      expect(stored.body.data.assignedToUserId).toBe(agentId);
      expect(stored.body.data.status).toBe('open');
    });

    it('records why it chose that agent, in the assignment history', async () => {
      await setOnline(agentId);
      const ticket = await createTicket();

      const history = await request(app)
        .get(`/api/v1/tickets/${ticket.id}/assignments`)
        .set(...bearer(adminToken))
        .expect(200);

      expect(history.body.data[0].toUserId).toBe(agentId);
      expect(history.body.data[0].reason).toMatch(/auto-assigned/i);
    });

    it('leaves the ticket unassigned when nobody is online', async () => {
      // Both agents are offline by default.
      const ticket = await createTicket();

      const stored = await request(app)
        .get(`/api/v1/tickets/${ticket.id}`)
        .set(...bearer(adminToken))
        .expect(200);

      expect(stored.body.data.assignedToUserId).toBeNull();
      expect(stored.body.data.status).toBe('new');
    });

    it('prefers the less loaded of two available agents', async () => {
      await setOnline(agentId);
      await setOnline(busyAgentId);

      // Give the busy agent a backlog by hand.
      await db.execute(sql`
        update tickets set assigned_to_user_id = ${busyAgentId}, status = 'open'
        where id in (
          select id from tickets where assigned_to_user_id is null limit 0
        )
      `);

      const first = await createTicket({ subject: 'One' });
      const owner = (
        await request(app)
          .get(`/api/v1/tickets/${first.id}`)
          .set(...bearer(adminToken))
      ).body.data.assignedToUserId;

      // Whoever took the first one is now the busier of the two, so the next
      // ticket must go to the other agent.
      const second = await createTicket({ subject: 'Two' });
      const secondOwner = (
        await request(app)
          .get(`/api/v1/tickets/${second.id}`)
          .set(...bearer(adminToken))
      ).body.data.assignedToUserId;

      expect([agentId, busyAgentId]).toContain(owner);
      expect(secondOwner).not.toBe(owner);
    });

    it('does not touch a ticket that was raised with an explicit assignee', async () => {
      await setOnline(agentId);
      await setOnline(busyAgentId);

      const ticket = await createTicket({ assignedToUserId: busyAgentId, channel: 'agent' });

      const stored = await request(app)
        .get(`/api/v1/tickets/${ticket.id}`)
        .set(...bearer(adminToken))
        .expect(200);

      expect(stored.body.data.assignedToUserId).toBe(busyAgentId);
    });

    it('respects an agent’s capacity limit', async () => {
      await setOnline(agentId);
      await db.update(users).set({ maxOpenTickets: 1 }).where(eq(users.id, agentId));

      const first = await createTicket({ subject: 'Fills the quota' });
      expect(
        (
          await request(app)
            .get(`/api/v1/tickets/${first.id}`)
            .set(...bearer(adminToken))
        ).body.data.assignedToUserId,
      ).toBe(agentId);

      // The agent is now at capacity and the other agent is offline.
      const second = await createTicket({ subject: 'Must wait in the queue' });
      expect(
        (
          await request(app)
            .get(`/api/v1/tickets/${second.id}`)
            .set(...bearer(adminToken))
        ).body.data.assignedToUserId,
      ).toBeNull();
    });

    it('explains the routing decision without acting on it', async () => {
      const ticket = await createTicket();

      const preview = await request(app)
        .get(`/api/v1/tickets/${ticket.id}/routing`)
        .set(...bearer(adminToken))
        .expect(200);

      expect(preview.body.data.ruleName).toMatch(/Support Desk/i);
      expect(preview.body.data.teamId).not.toBeNull();
    });

    it('sends the ticket to the team a matching rule names', async () => {
      const [specialists] = await db
        .insert(teams)
        .values({ name: 'Chargeback specialists' })
        .returning();

      await request(app)
        .post('/api/v1/routing-rules')
        .set(...bearer(adminToken))
        .send({
          name: 'Urgent wallet tickets to the specialists',
          productId: walletId,
          priority: 'urgent',
          assignToTeamId: specialists!.id,
          sortOrder: 1,
        })
        .expect(201);

      const ticket = await createTicket({ priority: 'urgent' });

      const stored = await request(app)
        .get(`/api/v1/tickets/${ticket.id}`)
        .set(...bearer(adminToken))
        .expect(200);

      expect(stored.body.data.teamId).toBe(specialists!.id);
    });
  });

  describe('breach and escalation', () => {
    /** Puts a target past its deadline, so the scan has something to find. */
    async function overdue(ticketId: string, kind = 'first_response'): Promise<void> {
      await db
        .update(ticketSlaTargets)
        .set({ dueAt: sql`now() - interval '10 minutes'` })
        .where(
          sql`${ticketSlaTargets.ticketId} = ${ticketId} and ${ticketSlaTargets.kind} = ${kind}`,
        );
    }

    it('records a breach once, however often the scan runs', async () => {
      const ticket = await createTicket();
      await overdue(ticket.id);

      const first = await request(app)
        .post('/api/v1/sla/scan')
        .set(...bearer(adminToken))
        .expect(200);
      expect(first.body.data.breached).toBe(1);

      // The second pass must find nothing: `breachedAt` is the guard.
      const second = await request(app)
        .post('/api/v1/sla/scan')
        .set(...bearer(adminToken))
        .expect(200);
      expect(second.body.data.breached).toBe(0);

      const sla = await slaFor(ticket.id);
      expect(sla.body.data.breaches).toHaveLength(1);
      expect(sla.body.data.breaches[0].kind).toBe('first_response');
      expect(sla.body.data.breaches[0].minutesOverdue).toBeGreaterThan(0);
    });

    it('never breaches a clock that is paused', async () => {
      const ticket = await createTicket();
      await overdue(ticket.id, 'resolution');

      await request(app)
        .patch(`/api/v1/tickets/${ticket.id}`)
        .set(...bearer(adminToken))
        .send({ status: 'pending' })
        .expect(200);

      const scan = await request(app)
        .post('/api/v1/sla/scan')
        .set(...bearer(adminToken))
        .expect(200);

      expect(scan.body.data.breached).toBe(0);
      expect((await slaFor(ticket.id)).body.data.breaches).toEqual([]);
    });

    it('never breaches a clock that was already satisfied', async () => {
      await setOnline(agentId);
      const ticket = await createTicket();

      await request(app)
        .post(`/api/v1/tickets/${ticket.id}/messages`)
        .set(...bearer(agentToken))
        .send({ body: 'On it.', visibility: 'public' })
        .expect(201);

      await overdue(ticket.id);

      const scan = await request(app)
        .post('/api/v1/sla/scan')
        .set(...bearer(adminToken))
        .expect(200);

      expect(scan.body.data.breached).toBe(0);
    });

    it('notifies the owner when their ticket breaches', async () => {
      await setOnline(agentId);
      const ticket = await createTicket();
      await overdue(ticket.id);

      await request(app)
        .post('/api/v1/sla/scan')
        .set(...bearer(adminToken))
        .expect(200);

      const rows = await db.select().from(notifications).where(eq(notifications.userId, agentId));

      expect(rows.some((row) => row.type === 'sla.breached')).toBe(true);
    });

    it('escalates a breach through the seeded ladder, once', async () => {
      const ticket = await createTicket();
      await overdue(ticket.id);

      await request(app)
        .post('/api/v1/sla/scan')
        .set(...bearer(adminToken))
        .expect(200);

      // The scan hands off to the escalation pass; run it explicitly too, to
      // prove a second pass does not fire the same rung again.
      await request(app)
        .post('/api/v1/escalation-rules/run')
        .set(...bearer(adminToken))
        .expect(200);

      const history = await request(app)
        .get(`/api/v1/tickets/${ticket.id}/escalations`)
        .set(...bearer(adminToken))
        .expect(200);

      expect(history.body.data.length).toBeGreaterThan(0);
      expect(history.body.data[0].reason).toMatch(/breached|SLA/i);

      const rows = await db.select().from(escalations).where(eq(escalations.ticketId, ticket.id));

      // Two seeded rungs both apply at 100% of the first-response clock: the
      // 80% warning and the on-breach rule. Neither may fire twice.
      const keys = rows.map((row) => `${row.ruleId}:${row.targetId}`);
      expect(new Set(keys).size).toBe(keys.length);
    });

    it('raises the priority when the ladder says to', async () => {
      const ticket = await createTicket();
      await overdue(ticket.id);

      await request(app)
        .post('/api/v1/sla/scan')
        .set(...bearer(adminToken))
        .expect(200);

      const stored = await request(app)
        .get(`/api/v1/tickets/${ticket.id}`)
        .set(...bearer(adminToken))
        .expect(200);

      // The seeded on-breach rule bumps `normal` to `high`.
      expect(stored.body.data.priority).toBe('high');
    });

    it('reassigns to the specialist a rule names, and says why', async () => {
      await setOnline(agentId);
      const specialist = await createActiveUser({
        email: 'tier2@primefocus.co.zw',
        roleCode: 'tier2_specialist',
        fullName: 'Tier Two',
      });
      await grantProduct(specialist.id, 'pf_wallet');
      await setOnline(specialist.id);

      await request(app)
        .post('/api/v1/escalation-rules')
        .set(...bearer(adminToken))
        .send({
          name: 'Hand a breached first response to tier two',
          targetKind: 'first_response',
          thresholdPercent: 100,
          action: 'notify_and_reassign',
          notifyUserId: specialist.id,
          reassignToUserId: specialist.id,
          sortOrder: 1,
        })
        .expect(201);

      const ticket = await createTicket();
      await overdue(ticket.id);

      await request(app)
        .post('/api/v1/sla/scan')
        .set(...bearer(adminToken))
        .expect(200);

      const stored = await request(app)
        .get(`/api/v1/tickets/${ticket.id}`)
        .set(...bearer(adminToken))
        .expect(200);

      expect(stored.body.data.assignedToUserId).toBe(specialist.id);

      const notified = await db
        .select()
        .from(notifications)
        .where(eq(notifications.userId, specialist.id));
      expect(notified.some((row) => row.type === 'ticket.escalated')).toBe(true);
    });

    it('does nothing to a ticket that is comfortably inside its SLA', async () => {
      const ticket = await createTicket();

      await request(app)
        .post('/api/v1/escalation-rules/run')
        .set(...bearer(adminToken))
        .expect(200);

      const history = await request(app)
        .get(`/api/v1/tickets/${ticket.id}/escalations`)
        .set(...bearer(adminToken))
        .expect(200);

      expect(history.body.data).toEqual([]);
    });
  });

  describe('configuration', () => {
    it('refuses a working week with no open hours', async () => {
      const calendars = await request(app)
        .get('/api/v1/business-hours')
        .set(...bearer(adminToken))
        .expect(200);

      const response = await request(app)
        .put(`/api/v1/business-hours/${calendars.body.data[0].id}`)
        .set(...bearer(adminToken))
        .send({ weekly: [{ day: 1, opensAt: '09:00', closesAt: '09:00' }] })
        .expect(400);

      expect(response.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('refuses overlapping windows on the same day', async () => {
      const calendars = await request(app)
        .get('/api/v1/business-hours')
        .set(...bearer(adminToken))
        .expect(200);

      await request(app)
        .put(`/api/v1/business-hours/${calendars.body.data[0].id}`)
        .set(...bearer(adminToken))
        .send({
          weekly: [
            { day: 1, opensAt: '08:00', closesAt: '13:00' },
            { day: 1, opensAt: '12:00', closesAt: '17:00' },
          ],
        })
        .expect(400);
    });

    it('moves a deadline when a holiday is added, for tickets raised afterwards', async () => {
      const calendars = await request(app)
        .get('/api/v1/business-hours')
        .set(...bearer(adminToken))
        .expect(200);

      const added = await request(app)
        .post(`/api/v1/business-hours/${calendars.body.data[0].id}/holidays`)
        .set(...bearer(adminToken))
        .send({ observedOn: '2030-06-17', name: 'Test holiday' })
        .expect(201);

      expect(
        added.body.data.holidays.some(
          (holiday: { name: string }) => holiday.name === 'Test holiday',
        ),
      ).toBe(true);

      // Adding the same date twice is a conflict, not a duplicate row.
      await request(app)
        .post(`/api/v1/business-hours/${calendars.body.data[0].id}/holidays`)
        .set(...bearer(adminToken))
        .send({ observedOn: '2030-06-17', name: 'Test holiday again' })
        .expect(409);

      invalidateCalendarCache();
    });

    it('rejects a resolution target shorter than the first response', async () => {
      const response = await request(app)
        .post('/api/v1/sla-policies')
        .set(...bearer(adminToken))
        .send({
          productId: await productIdFor('pf_lending'),
          priority: 'urgent',
          firstResponseMinutes: 120,
          resolutionMinutes: 30,
        })
        .expect(400);

      expect(response.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('refuses a second policy for the same product and priority', async () => {
      await request(app)
        .post('/api/v1/sla-policies')
        .set(...bearer(adminToken))
        .send({
          productId: walletId,
          priority: 'normal',
          firstResponseMinutes: 60,
          resolutionMinutes: 600,
        })
        .expect(409);
    });

    it('refuses an escalation rule that could never do anything', async () => {
      await request(app)
        .post('/api/v1/escalation-rules')
        .set(...bearer(adminToken))
        .send({ name: 'Notifies nobody', thresholdPercent: 90, action: 'notify' })
        .expect(400);

      await request(app)
        .post('/api/v1/escalation-rules')
        .set(...bearer(adminToken))
        .send({ name: 'Reassigns nowhere', thresholdPercent: 90, action: 'reassign' })
        .expect(400);
    });

    it('keeps SLA configuration away from agents who may not manage it', async () => {
      await request(app)
        .post('/api/v1/sla-policies')
        .set(...bearer(agentToken))
        .send({
          productId: walletId,
          priority: 'low',
          firstResponseMinutes: 1,
          resolutionMinutes: 2,
        })
        .expect(403);

      // Reading is allowed: an agent needs to know what they are held to.
      await request(app)
        .get('/api/v1/sla-policies')
        .set(...bearer(agentToken))
        .expect(200);
    });

    it('lets an agent set their own availability but not their capacity', async () => {
      await request(app)
        .patch('/api/v1/users/me/availability')
        .set(...bearer(agentToken))
        .send({ availability: 'online' })
        .expect(200);

      const [row] = await db.select().from(users).where(eq(users.id, agentId));
      expect(row?.availability).toBe('online');

      await request(app)
        .patch(`/api/v1/users/${agentId}/capacity`)
        .set(...bearer(agentToken))
        .send({ maxOpenTickets: 500 })
        .expect(403);
    });

    it('stores an agent’s skills as a replaceable set', async () => {
      await request(app)
        .put(`/api/v1/users/${agentId}/skills`)
        .set(...bearer(adminToken))
        .send({ skills: [{ skill: 'chargebacks', proficiency: 5 }, { skill: 'shona' }] })
        .expect(200);

      const listed = await request(app)
        .get(`/api/v1/users/${agentId}/skills`)
        .set(...bearer(adminToken))
        .expect(200);

      expect(listed.body.data.map((row: { skill: string }) => row.skill)).toEqual([
        'chargebacks',
        'shona',
      ]);

      // Replacing drops what is not in the new set.
      await request(app)
        .put(`/api/v1/users/${agentId}/skills`)
        .set(...bearer(adminToken))
        .send({ skills: [{ skill: 'shona', proficiency: 4 }] })
        .expect(200);

      const after = await request(app)
        .get(`/api/v1/users/${agentId}/skills`)
        .set(...bearer(adminToken))
        .expect(200);

      expect(after.body.data).toHaveLength(1);
      expect(after.body.data[0].proficiency).toBe(4);
    });

    it('routes to a skill when a rule demands one', async () => {
      await setOnline(agentId);
      await setOnline(busyAgentId);

      // Only the second agent can handle chargebacks.
      await request(app)
        .put(`/api/v1/users/${busyAgentId}/skills`)
        .set(...bearer(adminToken))
        .send({ skills: [{ skill: 'chargebacks', proficiency: 5 }] })
        .expect(200);

      await request(app)
        .post('/api/v1/routing-rules')
        .set(...bearer(adminToken))
        .send({
          name: 'Chargebacks need the specialist',
          productId: walletId,
          requiredSkill: 'chargebacks',
          sortOrder: 1,
        })
        .expect(201);

      const ticket = await createTicket({ subject: 'Disputed card payment' });

      const stored = await request(app)
        .get(`/api/v1/tickets/${ticket.id}`)
        .set(...bearer(adminToken))
        .expect(200);

      expect(stored.body.data.assignedToUserId).toBe(busyAgentId);
    });
  });
});

import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createApp } from '../../src/app.js';
import { closeDatabase, db } from '../../src/db/client.js';
import { invitations } from '../../src/modules/invitation/invitation.model.js';
import { users } from '../../src/modules/user/user.model.js';
import { auditLogs } from '../../src/modules/audit/audit.model.js';
import { resetDatabase } from '../helpers/db.js';
import {
  STRONG_PASSWORD,
  bearer,
  createActiveUser,
  invitationTokenFor,
  roleIdFor,
  signIn,
} from '../helpers/identity.js';

const enabled = process.env.RUN_DB_TESTS === '1';
const app = createApp();

const ADMIN_EMAIL = 'ops.admin@primefocus.co.zw';
const INVITEE_EMAIL = 'new.agent@primefocus.co.zw';

describe.runIf(enabled)('invitations', () => {
  let adminToken: string;

  beforeEach(async () => {
    await resetDatabase();
    await createActiveUser({ email: ADMIN_EMAIL, roleCode: 'admin', fullName: 'Ops Admin' });
    adminToken = (await signIn(app, ADMIN_EMAIL)).accessToken;
  });

  afterAll(async () => {
    await closeDatabase();
  });

  async function invite(roleCode = 'tier1_agent', email = INVITEE_EMAIL) {
    return request(app)
      .post('/api/v1/invitations')
      .set(...bearer(adminToken))
      .send({ email, fullName: 'New Agent', roleId: await roleIdFor(roleCode) });
  }

  describe('sending', () => {
    it('creates the account in invited state and emails a link', async () => {
      const response = await invite();

      expect(response.status).toBe(201);
      expect(response.body.data.status).toBe('pending');
      expect(response.body.data.roleName).toBe('Tier 1 Agent');

      const [created] = await db.select().from(users).where(eq(users.email, INVITEE_EMAIL));
      expect(created?.status).toBe('invited');
      // No password until the invitee sets one.
      expect(created?.passwordHash).toBeNull();

      // The token exists only in the email, never in the API response.
      const token = invitationTokenFor(INVITEE_EMAIL);
      expect(token.length).toBeGreaterThan(20);
      expect(JSON.stringify(response.body)).not.toContain(token);
    });

    it('stores only a hash of the invitation token', async () => {
      await invite();
      const token = invitationTokenFor(INVITEE_EMAIL);

      const [row] = await db.select().from(invitations);
      expect(row?.tokenHash).toBeTypeOf('string');
      expect(row?.tokenHash).not.toBe(token);
    });

    it('records the invitation in the audit trail', async () => {
      await invite();

      const [entry] = await db.select().from(auditLogs).where(eq(auditLogs.action, 'user.invited'));
      expect(entry?.entityType).toBe('user');
      expect(entry?.actorLabel).toBe(ADMIN_EMAIL);
      expect(entry?.requestId).toBeTypeOf('string');
    });

    it('refuses an email that already has an active account', async () => {
      const response = await invite('tier1_agent', ADMIN_EMAIL);

      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe('USER_ALREADY_EXISTS');
    });

    it('re-inviting a pending address issues a new link and kills the old one', async () => {
      await invite();
      const firstToken = invitationTokenFor(INVITEE_EMAIL);

      const second = await invite();
      const secondToken = invitationTokenFor(INVITEE_EMAIL);

      expect(second.status).toBe(201);
      expect(secondToken).not.toBe(firstToken);
      // Only one account, and only one invitation row.
      expect(await db.select().from(users).where(eq(users.email, INVITEE_EMAIL))).toHaveLength(1);

      const stale = await request(app)
        .post('/api/v1/invitations/verify')
        .send({ token: firstToken });
      expect(stale.status).toBe(400);
      expect(stale.body.error.code).toBe('INVITATION_INVALID');
    });

    it('requires the user:invite permission', async () => {
      const agent = await createActiveUser({
        email: 'tier1@primefocus.co.zw',
        roleCode: 'tier1_agent',
      });
      const agentToken = (await signIn(app, agent.email, agent.password)).accessToken;

      const response = await request(app)
        .post('/api/v1/invitations')
        .set(...bearer(agentToken))
        .send({ email: 'x@primefocus.co.zw', fullName: 'X', roleId: await roleIdFor('admin') });

      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('FORBIDDEN');
    });

    it('rejects an unknown role', async () => {
      const response = await request(app)
        .post('/api/v1/invitations')
        .set(...bearer(adminToken))
        .send({
          email: INVITEE_EMAIL,
          fullName: 'New Agent',
          roleId: '00000000-0000-4000-8000-000000000000',
        });

      expect(response.status).toBe(400);
      expect(response.body.error.details[0].field).toBe('roleId');
    });
  });

  describe('acceptance', () => {
    it('previews the invitation without consuming it', async () => {
      await invite('tier2_specialist');
      const token = invitationTokenFor(INVITEE_EMAIL);

      const preview = await request(app).post('/api/v1/invitations/verify').send({ token });

      expect(preview.status).toBe(200);
      expect(preview.body.data.email).toBe(INVITEE_EMAIL);
      expect(preview.body.data.roleName).toBe('Tier 2 Specialist');

      // Still usable afterwards.
      await request(app).post('/api/v1/invitations/verify').send({ token }).expect(200);
    });

    it('sets a password, activates the account and signs the user in', async () => {
      await invite();
      const token = invitationTokenFor(INVITEE_EMAIL);

      const accepted = await request(app)
        .post('/api/v1/invitations/accept')
        .send({ token, password: STRONG_PASSWORD });

      expect(accepted.status).toBe(201);
      expect(accepted.body.data.status).toBe('authenticated');
      expect(accepted.body.data.user.status).toBe('active');
      expect(accepted.body.data.tokens.accessToken).toBeTypeOf('string');

      // The returned session works immediately — no second login, no OTP.
      const me = await request(app)
        .get('/api/v1/auth/me')
        .set(...bearer(accepted.body.data.tokens.accessToken));
      expect(me.status).toBe(200);
      expect(me.body.data.email).toBe(INVITEE_EMAIL);
    });

    it('applies the role chosen at invitation time', async () => {
      await invite('tier2_specialist');
      const token = invitationTokenFor(INVITEE_EMAIL);

      const accepted = await request(app)
        .post('/api/v1/invitations/accept')
        .send({ token, password: STRONG_PASSWORD });

      expect(accepted.body.data.user.roleCode).toBe('tier2_specialist');

      const me = await request(app)
        .get('/api/v1/auth/me')
        .set(...bearer(accepted.body.data.tokens.accessToken));
      expect(me.body.data.permissions).toContain('ticket:manage');
      expect(me.body.data.permissions).not.toContain('user:invite');
    });

    it('lets the invitee correct the name the administrator typed', async () => {
      await invite();
      const token = invitationTokenFor(INVITEE_EMAIL);

      const accepted = await request(app)
        .post('/api/v1/invitations/accept')
        .send({ token, password: STRONG_PASSWORD, fullName: 'Tendai Nyathi' });

      expect(accepted.body.data.user.fullName).toBe('Tendai Nyathi');
    });

    it('can be accepted only once', async () => {
      await invite();
      const token = invitationTokenFor(INVITEE_EMAIL);

      await request(app)
        .post('/api/v1/invitations/accept')
        .send({ token, password: STRONG_PASSWORD })
        .expect(201);

      const replay = await request(app)
        .post('/api/v1/invitations/accept')
        .send({ token, password: STRONG_PASSWORD });

      expect(replay.status).toBe(409);
      expect(replay.body.error.code).toBe('INVITATION_ALREADY_ACCEPTED');
    });

    it('rejects a password that is too short', async () => {
      await invite();
      const token = invitationTokenFor(INVITEE_EMAIL);

      const response = await request(app)
        .post('/api/v1/invitations/accept')
        .send({ token, password: 'short' });

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('rejects a password containing the email address', async () => {
      await invite();
      const token = invitationTokenFor(INVITEE_EMAIL);

      const response = await request(app)
        .post('/api/v1/invitations/accept')
        .send({ token, password: 'new.agent-is-my-password' });

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('WEAK_PASSWORD');
    });

    it('rejects an unknown token', async () => {
      const response = await request(app)
        .post('/api/v1/invitations/accept')
        .send({ token: 'x'.repeat(43), password: STRONG_PASSWORD });

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('INVITATION_INVALID');
    });

    it('rejects an expired invitation', async () => {
      await invite();
      const token = invitationTokenFor(INVITEE_EMAIL);
      await db.update(invitations).set({ expiresAt: new Date(Date.now() - 1000) });

      const response = await request(app)
        .post('/api/v1/invitations/accept')
        .send({ token, password: STRONG_PASSWORD });

      expect(response.status).toBe(410);
      expect(response.body.error.code).toBe('INVITATION_EXPIRED');
    });

    it('rejects a revoked invitation', async () => {
      const created = await invite();
      const token = invitationTokenFor(INVITEE_EMAIL);

      await request(app)
        .delete(`/api/v1/invitations/${created.body.data.id}`)
        .set(...bearer(adminToken))
        .expect(204);

      const response = await request(app)
        .post('/api/v1/invitations/accept')
        .send({ token, password: STRONG_PASSWORD });

      expect(response.status).toBe(410);
      expect(response.body.error.code).toBe('INVITATION_REVOKED');
    });

    it('cannot revoke an invitation that was already accepted', async () => {
      const created = await invite();
      const token = invitationTokenFor(INVITEE_EMAIL);
      await request(app)
        .post('/api/v1/invitations/accept')
        .send({ token, password: STRONG_PASSWORD })
        .expect(201);

      const response = await request(app)
        .delete(`/api/v1/invitations/${created.body.data.id}`)
        .set(...bearer(adminToken));

      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe('INVITATION_ALREADY_ACCEPTED');
    });
  });

  describe('resending', () => {
    it('issues a fresh token and invalidates the previous one', async () => {
      const created = await invite();
      const firstToken = invitationTokenFor(INVITEE_EMAIL);

      const resent = await request(app)
        .post(`/api/v1/invitations/${created.body.data.id}/resend`)
        .set(...bearer(adminToken));

      expect(resent.status).toBe(200);
      expect(resent.body.data.sendCount).toBe(2);

      const secondToken = invitationTokenFor(INVITEE_EMAIL);
      expect(secondToken).not.toBe(firstToken);

      await request(app).post('/api/v1/invitations/verify').send({ token: firstToken }).expect(400);
      await request(app)
        .post('/api/v1/invitations/verify')
        .send({ token: secondToken })
        .expect(200);
    });
  });

  it('offers no way to create an account without an invitation', async () => {
    const before = await db.select().from(users);

    // Whether these answer 404 or 401 is unimportant (a router with a trailing
    // authenticate guard returns 401 for unmatched paths, which leaks less).
    // What matters is that none of them succeed, and none create an account.
    for (const path of ['/api/v1/auth/register', '/api/v1/auth/signup', '/api/v1/users']) {
      const response = await request(app)
        .post(path)
        .send({ email: 'intruder@example.com', password: STRONG_PASSWORD, fullName: 'Intruder' });

      expect(response.status).toBeGreaterThanOrEqual(400);
    }

    expect(await db.select().from(users)).toHaveLength(before.length);
  });
});

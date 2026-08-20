import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { closeDatabase, db } from '../../src/db/client.js';
import { auditLogs } from '../../src/modules/audit/audit.model.js';
import { resetDatabase } from '../helpers/db.js';
import { bearer, createActiveUser, roleIdFor, signIn } from '../helpers/identity.js';

const enabled = process.env.RUN_DB_TESTS === '1';
const app = createApp();

const SUPER_EMAIL = 'root@primefocus.co.zw';
const ADMIN_EMAIL = 'admin@primefocus.co.zw';
const AGENT_EMAIL = 'agent@primefocus.co.zw';

describe.runIf(enabled)('roles, permissions and administration', () => {
  let superToken: string;
  let adminToken: string;
  let agentToken: string;
  let agentId: string;

  beforeEach(async () => {
    await resetDatabase();
    await createActiveUser({ email: SUPER_EMAIL, roleCode: 'super_admin', fullName: 'Root' });
    await createActiveUser({ email: ADMIN_EMAIL, roleCode: 'admin', fullName: 'Admin' });
    const agent = await createActiveUser({
      email: AGENT_EMAIL,
      roleCode: 'tier1_agent',
      fullName: 'Agent',
    });
    agentId = agent.id;

    superToken = (await signIn(app, SUPER_EMAIL)).accessToken;
    adminToken = (await signIn(app, ADMIN_EMAIL)).accessToken;
    agentToken = (await signIn(app, AGENT_EMAIL)).accessToken;
  });

  afterAll(async () => {
    await closeDatabase();
  });

  describe('permission enforcement', () => {
    it('gives the super administrator every permission, including future ones', async () => {
      const me = await request(app)
        .get('/api/v1/auth/me')
        .set(...bearer(superToken));

      expect(me.body.data.permissions).toContain('role:manage');
      // Seeded for Phase 5 but already grantable.
      expect(me.body.data.permissions).toContain('kb:manage');
    });

    it('stops an administrator from editing the permission model', async () => {
      // Admins run the operation; only super_admin changes what roles may do,
      // so an admin cannot widen their own access.
      const roleId = await roleIdFor('tier1_agent');
      const response = await request(app)
        .put(`/api/v1/roles/${roleId}/permissions`)
        .set(...bearer(adminToken))
        .send({ permissions: ['ticket:read', 'user:manage'] });

      expect(response.status).toBe(403);
    });

    it('stops an agent reading the audit trail', async () => {
      const response = await request(app)
        .get('/api/v1/audit-logs')
        .set(...bearer(agentToken));
      expect(response.status).toBe(403);
    });

    it('stops an agent issuing API keys', async () => {
      const response = await request(app)
        .post('/api/v1/api-keys')
        .set(...bearer(agentToken))
        .send({ name: 'sneaky', scopes: ['ticket:read'] });

      expect(response.status).toBe(403);
    });

    it('lets an agent do its own job', async () => {
      // user:read is granted, so the roster is visible.
      await request(app)
        .get('/api/v1/users')
        .set(...bearer(agentToken))
        .expect(200);
      await request(app)
        .get('/api/v1/teams')
        .set(...bearer(agentToken))
        .expect(200);
    });

    it('refuses to narrow the super administrator role', async () => {
      const roleId = await roleIdFor('super_admin');
      const response = await request(app)
        .put(`/api/v1/roles/${roleId}/permissions`)
        .set(...bearer(superToken))
        .send({ permissions: ['ticket:read'] });

      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe('SYSTEM_ROLE_IMMUTABLE');
    });

    it('applies a permission change without waiting for the token to expire', async () => {
      const roleId = await roleIdFor('tier1_agent');

      await request(app)
        .get('/api/v1/audit-logs')
        .set(...bearer(agentToken))
        .expect(403);

      await request(app)
        .put(`/api/v1/roles/${roleId}/permissions`)
        .set(...bearer(superToken))
        .send({ permissions: ['ticket:read', 'audit:read'] })
        .expect(200);

      // Same access token, new permission: the role cache is invalidated on write.
      await request(app)
        .get('/api/v1/audit-logs')
        .set(...bearer(agentToken))
        .expect(200);
    });

    it('applies a role change immediately', async () => {
      await request(app)
        .patch(`/api/v1/users/${agentId}/role`)
        .set(...bearer(adminToken))
        .send({ roleId: await roleIdFor('tier2_specialist') })
        .expect(200);

      const me = await request(app)
        .get('/api/v1/auth/me')
        .set(...bearer(agentToken));
      expect(me.body.data.roleCode).toBe('tier2_specialist');
      expect(me.body.data.permissions).toContain('ticket:manage');
    });
  });

  describe('roles', () => {
    it('creates a custom role with a subset of permissions', async () => {
      const response = await request(app)
        .post('/api/v1/roles')
        .set(...bearer(superToken))
        .send({
          code: 'quality_reviewer',
          name: 'Quality Reviewer',
          permissions: ['ticket:read', 'report:view'],
        });

      expect(response.status).toBe(201);
      expect(response.body.data.isSystem).toBe(false);
      expect(response.body.data.permissions).toEqual(['ticket:read', 'report:view']);
    });

    it('rejects a permission that does not exist', async () => {
      const response = await request(app)
        .post('/api/v1/roles')
        .set(...bearer(superToken))
        .send({ code: 'bad_role', name: 'Bad', permissions: ['ticket:teleport'] });

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('refuses to delete a seeded role', async () => {
      const response = await request(app)
        .delete(`/api/v1/roles/${await roleIdFor('admin')}`)
        .set(...bearer(superToken));

      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe('SYSTEM_ROLE_IMMUTABLE');
    });

    it('refuses to delete a role that still has holders', async () => {
      const created = await request(app)
        .post('/api/v1/roles')
        .set(...bearer(superToken))
        .send({ code: 'temp_role', name: 'Temp', permissions: ['ticket:read'] });

      await request(app)
        .patch(`/api/v1/users/${agentId}/role`)
        .set(...bearer(adminToken))
        .send({ roleId: created.body.data.id })
        .expect(200);

      const response = await request(app)
        .delete(`/api/v1/roles/${created.body.data.id}`)
        .set(...bearer(superToken));

      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe('ROLE_IN_USE');
    });
  });

  describe('account status', () => {
    it('suspends an account and cuts off its access at once', async () => {
      await request(app)
        .patch(`/api/v1/users/${agentId}/status`)
        .set(...bearer(adminToken))
        .send({ status: 'suspended' })
        .expect(200);

      const response = await request(app)
        .get('/api/v1/auth/me')
        .set(...bearer(agentToken));
      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('ACCOUNT_SUSPENDED');
    });

    it('refuses to suspend your own account', async () => {
      const me = await request(app)
        .get('/api/v1/auth/me')
        .set(...bearer(adminToken));

      const response = await request(app)
        .patch(`/api/v1/users/${me.body.data.id}/status`)
        .set(...bearer(adminToken))
        .send({ status: 'suspended' });

      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe('SELF_ACTION_FORBIDDEN');
    });

    it('refuses to suspend the last super administrator', async () => {
      const users = await request(app)
        .get('/api/v1/users')
        .set(...bearer(superToken));
      const root = users.body.data.find((row: { email: string }) => row.email === SUPER_EMAIL) as {
        id: string;
      };

      // Locking out the only account that can restore permissions would leave
      // the system unadministrable.
      const response = await request(app)
        .patch(`/api/v1/users/${root.id}/status`)
        .set(...bearer(adminToken))
        .send({ status: 'suspended' });

      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe('LAST_SUPER_ADMIN');
    });

    it('reactivates a suspended account', async () => {
      await request(app)
        .patch(`/api/v1/users/${agentId}/status`)
        .set(...bearer(adminToken))
        .send({ status: 'suspended' })
        .expect(200);

      const reactivated = await request(app)
        .patch(`/api/v1/users/${agentId}/status`)
        .set(...bearer(adminToken))
        .send({ status: 'active' });

      expect(reactivated.status).toBe(200);
      expect(reactivated.body.data.status).toBe('active');
      // A new sign-in works; the old tokens stay revoked.
      await signIn(app, AGENT_EMAIL);
    });
  });

  describe('profiles', () => {
    it('lets an agent edit their own details without user:manage', async () => {
      const response = await request(app)
        .patch('/api/v1/users/me')
        .set(...bearer(agentToken))
        .send({ fullName: 'Agent Renamed', phone: '+263771234567' });

      expect(response.status).toBe(200);
      expect(response.body.data.fullName).toBe('Agent Renamed');
    });

    it('stops an agent editing someone else', async () => {
      const users = await request(app)
        .get('/api/v1/users')
        .set(...bearer(agentToken));
      const other = users.body.data.find((row: { email: string }) => row.email === ADMIN_EMAIL) as {
        id: string;
      };

      const response = await request(app)
        .patch(`/api/v1/users/${other.id}`)
        .set(...bearer(agentToken))
        .send({ fullName: 'Hacked' });

      expect(response.status).toBe(403);
    });

    it('never exposes password hashes in the roster', async () => {
      const response = await request(app)
        .get('/api/v1/users')
        .set(...bearer(adminToken));

      expect(response.status).toBe(200);
      expect(JSON.stringify(response.body)).not.toContain('argon2');
      expect(response.body.data[0]).not.toHaveProperty('passwordHash');
    });
  });

  describe('api keys', () => {
    it('issues a key that then authenticates a product system', async () => {
      const created = await request(app)
        .post('/api/v1/api-keys')
        .set(...bearer(superToken))
        .send({ name: 'Wallet product', scopes: ['ticket:read', 'user:read'] });

      expect(created.status).toBe(201);
      expect(created.body.data.key).toMatch(/^pfc_[0-9a-f]{12}_/);

      const asKey = await request(app)
        .get('/api/v1/users')
        .set('x-api-key', created.body.data.key as string);

      expect(asKey.status).toBe(200);
    });

    it('confines a key to its scopes', async () => {
      const created = await request(app)
        .post('/api/v1/api-keys')
        .set(...bearer(superToken))
        .send({ name: 'Read-only', scopes: ['ticket:read'] });

      const response = await request(app)
        .get('/api/v1/users')
        .set('x-api-key', created.body.data.key as string);

      expect(response.status).toBe(403);
    });

    it('refuses a revoked key', async () => {
      const created = await request(app)
        .post('/api/v1/api-keys')
        .set(...bearer(superToken))
        .send({ name: 'Temporary', scopes: ['user:read'] });

      await request(app)
        .delete(`/api/v1/api-keys/${created.body.data.id}`)
        .set(...bearer(superToken))
        .expect(204);

      const response = await request(app)
        .get('/api/v1/users')
        .set('x-api-key', created.body.data.key as string);

      expect(response.status).toBe(401);
      expect(response.body.error.code).toBe('API_KEY_INVALID');
    });

    it('refuses a tampered key and a made-up one identically', async () => {
      const created = await request(app)
        .post('/api/v1/api-keys')
        .set(...bearer(superToken))
        .send({ name: 'Real', scopes: ['user:read'] });

      const tampered = `${(created.body.data.key as string).slice(0, -4)}zzzz`;
      const invented = 'pfc_aaaaaaaaaaaa_' + 'z'.repeat(43);

      const first = await request(app).get('/api/v1/users').set('x-api-key', tampered);
      const second = await request(app).get('/api/v1/users').set('x-api-key', invented);

      expect(first.status).toBe(401);
      expect(second.body.error).toEqual(first.body.error);
    });

    it('does not let an API key mint another key', async () => {
      const created = await request(app)
        .post('/api/v1/api-keys')
        .set(...bearer(superToken))
        .send({ name: 'Escalation attempt', scopes: ['api_key:manage'] });

      const response = await request(app)
        .post('/api/v1/api-keys')
        .set('x-api-key', created.body.data.key as string)
        .send({ name: 'Child key', scopes: ['ticket:read'] });

      expect(response.status).toBe(403);
    });
  });

  describe('audit trail', () => {
    it('records administrative changes with the acting user', async () => {
      await request(app)
        .patch(`/api/v1/users/${agentId}/status`)
        .set(...bearer(adminToken))
        .send({ status: 'suspended' })
        .expect(200);

      const response = await request(app)
        .get('/api/v1/audit-logs?entityType=user')
        .set(...bearer(superToken));

      expect(response.status).toBe(200);
      const suspension = response.body.data.find(
        (row: { action: string }) => row.action === 'user.suspended',
      );
      expect(suspension.actorLabel).toBe(ADMIN_EMAIL);
      expect(suspension.before).toEqual({ status: 'active' });
      expect(suspension.after).toEqual({ status: 'suspended' });
    });

    it('filters by action and paginates', async () => {
      await request(app)
        .post('/api/v1/roles')
        .set(...bearer(superToken))
        .send({ code: 'r_one', name: 'One', permissions: [] })
        .expect(201);
      await request(app)
        .post('/api/v1/roles')
        .set(...bearer(superToken))
        .send({ code: 'r_two', name: 'Two', permissions: [] })
        .expect(201);

      const response = await request(app)
        .get('/api/v1/audit-logs?action=role.created&limit=1')
        .set(...bearer(superToken));

      expect(response.body.data).toHaveLength(1);
      expect(response.body.meta.pagination.hasMore).toBe(true);
      expect(response.body.meta.pagination.nextCursor).toBeTypeOf('string');
    });

    it('is append-only over HTTP', async () => {
      const [entry] = await db.select().from(auditLogs).limit(1);
      expect(entry).toBeDefined();

      // No write surface at all: the trail is written by services, never by callers.
      await request(app)
        .post('/api/v1/audit-logs')
        .set(...bearer(superToken))
        .send({ action: 'forged' })
        .expect((response) => expect(response.status).toBeGreaterThanOrEqual(400));

      await request(app)
        .delete(`/api/v1/audit-logs/${entry?.id}`)
        .set(...bearer(superToken))
        .expect((response) => expect(response.status).toBeGreaterThanOrEqual(400));
    });
  });
});

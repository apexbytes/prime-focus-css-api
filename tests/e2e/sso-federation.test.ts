import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createApp } from '../../src/app.js';
import { closeDatabase, db } from '../../src/db/client.js';
import { users } from '../../src/modules/user/user.model.js';
import { resetDatabase } from '../helpers/db.js';
import {
  STRONG_PASSWORD,
  bearer,
  createActiveUser,
  invitationTokenFor,
  otpCodeFor,
  roleIdFor,
  signIn,
} from '../helpers/identity.js';
import {
  startFakeProvider,
  type FakeIdentity,
  type FakeProvider,
} from '../helpers/oidc-provider.js';

const enabled = process.env.RUN_DB_TESTS === '1';
const app = createApp();

const ADMIN_EMAIL = 'sso-admin@primefocus.co.zw';
const AGENT_EMAIL = 'tarisai@primefocus.co.zw';

const AGENT: FakeIdentity = {
  subject: 'google-subject-0001',
  email: AGENT_EMAIL,
  emailVerified: true,
  name: 'Tarisai M',
};

describe.runIf(enabled)('federated sign-in', () => {
  let idp: FakeProvider;
  let adminToken: string;

  beforeAll(async () => {
    idp = await startFakeProvider();
  });

  beforeEach(async () => {
    await resetDatabase();
    await createActiveUser({ email: ADMIN_EMAIL, roleCode: 'admin', fullName: 'Rudo N' });
    adminToken = (await signIn(app, ADMIN_EMAIL)).accessToken;
  });

  afterAll(async () => {
    await idp.close();
    await closeDatabase();
  });

  // -- fixtures --------------------------------------------------------------

  async function configureProvider(overrides: Record<string, unknown> = {}) {
    const response = await request(app)
      .post('/api/v1/identity-providers')
      .set(...bearer(adminToken))
      .send({
        code: 'test-idp',
        displayName: 'Test Identity Provider',
        kind: 'oidc',
        issuer: idp.issuer,
        clientId: idp.clientId,
        clientSecret: idp.clientSecret,
        allowedEmailDomains: ['primefocus.co.zw'],
        ...overrides,
      });

    expect(response.status).toBe(201);
    return response.body.data;
  }

  /** Starts a sign-in and plays the provider's part, without completing it. */
  async function authorize(
    identity: FakeIdentity,
    options: { providerCode?: string; returnPath?: string; nonce?: string; audience?: string } = {},
  ) {
    const started = await request(app)
      .post('/api/v1/auth/sso/start')
      .send({
        providerCode: options.providerCode ?? 'test-idp',
        ...(options.returnPath ? { returnPath: options.returnPath } : {}),
      });

    expect(started.status).toBe(200);
    const authorizationUrl = started.body.data.authorizationUrl as string;

    const code = idp.authorize(authorizationUrl, identity, {
      ...(options.nonce ? { nonce: options.nonce } : {}),
      ...(options.audience ? { audience: options.audience } : {}),
    });

    return {
      authorizationUrl,
      state: new URL(authorizationUrl).searchParams.get('state') as string,
      code,
    };
  }

  function callback(state: string, code: string) {
    return request(app).post('/api/v1/auth/sso/callback').send({ state, code });
  }

  async function signInThroughProvider(
    identity: FakeIdentity,
    options: Parameters<typeof authorize>[1] = {},
  ) {
    const { state, code } = await authorize(identity, options);
    return callback(state, code);
  }

  // -- the flow --------------------------------------------------------------

  describe('POST /auth/sso/start', () => {
    it('builds an authorization request with PKCE and a nonce, and no secret', async () => {
      await configureProvider();

      const started = await request(app)
        .post('/api/v1/auth/sso/start')
        .send({ providerCode: 'test-idp' });

      expect(started.status).toBe(200);
      const url = new URL(started.body.data.authorizationUrl);

      expect(url.origin).toBe(idp.issuer);
      expect(url.pathname).toBe('/authorize');
      expect(url.searchParams.get('response_type')).toBe('code');
      expect(url.searchParams.get('code_challenge_method')).toBe('S256');
      expect(url.searchParams.get('code_challenge')).toBeTruthy();
      expect(url.searchParams.get('state')).toBeTruthy();
      expect(url.searchParams.get('nonce')).toBeTruthy();
      // The verifier stays on this side; only its hash goes through the browser.
      expect(started.body.data.authorizationUrl).not.toContain(idp.clientSecret);
      expect(url.searchParams.get('code_verifier')).toBeNull();
    });

    it('does not admit that a disabled provider exists', async () => {
      await configureProvider({ isActive: false });

      const started = await request(app)
        .post('/api/v1/auth/sso/start')
        .send({ providerCode: 'test-idp' });

      expect(started.status).toBe(404);
    });

    it('refuses a return path that would leave the console', async () => {
      await configureProvider();

      const started = await request(app)
        .post('/api/v1/auth/sso/start')
        .send({ providerCode: 'test-idp', returnPath: '//evil.example.com' });

      expect(started.status).toBe(400);
      expect(started.body.error.code).toBe('VALIDATION_ERROR');
    });
  });

  describe('POST /auth/sso/callback', () => {
    it('signs an existing agent in and links the identity', async () => {
      await configureProvider();
      await createActiveUser({
        email: AGENT_EMAIL,
        roleCode: 'tier1_agent',
        fullName: 'Tarisai M',
      });

      const response = await signInThroughProvider(AGENT, { returnPath: '/tickets' });

      expect(response.status).toBe(200);
      expect(response.body.data.status).toBe('authenticated');
      expect(response.body.data.user.email).toBe(AGENT_EMAIL);
      expect(response.body.data.returnPath).toBe('/tickets');
      expect(response.body.data.provider.code).toBe('test-idp');

      // The tokens are ordinary session tokens: nothing downstream knows or
      // cares how the sign-in happened.
      const me = await request(app)
        .get('/api/v1/auth/me')
        .set(...bearer(response.body.data.tokens.accessToken));

      expect(me.status).toBe(200);
      expect(me.body.data.email).toBe(AGENT_EMAIL);

      const identities = await request(app)
        .get('/api/v1/auth/sso/identities')
        .set(...bearer(response.body.data.tokens.accessToken));

      expect(identities.status).toBe(200);
      expect(identities.body.data).toHaveLength(1);
      expect(identities.body.data[0].providerCode).toBe('test-idp');
      expect(identities.body.data[0].email).toBe(AGENT_EMAIL);
      expect(identities.body.data[0].lastLoginAt).toBeTruthy();
    });

    it('refuses to complete the same sign-in twice', async () => {
      await configureProvider();
      await createActiveUser({ email: AGENT_EMAIL, roleCode: 'tier1_agent' });

      const { state, code } = await authorize(AGENT);
      const exchangesBefore = idp.tokenRequests();
      expect((await callback(state, code)).status).toBe(200);
      expect(idp.tokenRequests()).toBe(exchangesBefore + 1);

      const replayed = await callback(state, code);
      expect(replayed.status).toBe(400);
      expect(replayed.body.error.code).toBe('SSO_STATE_INVALID');
      // Refused on the state, so the provider was never asked a second time.
      expect(idp.tokenRequests()).toBe(exchangesBefore + 1);
    });

    it('refuses a state it never issued', async () => {
      await configureProvider();

      const response = await callback('a-state-nobody-here-generated-0001', 'some-code');
      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('SSO_STATE_INVALID');
    });

    it('refuses an id_token whose nonce is not the one this sign-in asked for', async () => {
      await configureProvider();
      await createActiveUser({ email: AGENT_EMAIL, roleCode: 'tier1_agent' });

      const response = await signInThroughProvider(AGENT, {
        nonce: 'a-nonce-from-another-sign-in',
      });

      expect(response.status).toBe(401);
      expect(response.body.error.code).toBe('SSO_IDENTITY_REJECTED');
    });

    it('refuses an id_token minted for a different client', async () => {
      await configureProvider();
      await createActiveUser({ email: AGENT_EMAIL, roleCode: 'tier1_agent' });

      const response = await signInThroughProvider(AGENT, { audience: 'somebody-elses-client' });

      expect(response.status).toBe(401);
      expect(response.body.error.code).toBe('SSO_IDENTITY_REJECTED');
    });

    it('refuses an address on a domain the provider is not federated for', async () => {
      await configureProvider();
      await createActiveUser({ email: 'personal@gmail.com', roleCode: 'tier1_agent' });

      const response = await signInThroughProvider({
        subject: 'google-subject-9999',
        email: 'personal@gmail.com',
        emailVerified: true,
      });

      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('SSO_IDENTITY_REJECTED');
    });

    it('refuses an unverified address', async () => {
      await configureProvider();
      await createActiveUser({ email: AGENT_EMAIL, roleCode: 'tier1_agent' });

      const response = await signInThroughProvider({ ...AGENT, emailVerified: false });

      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('SSO_IDENTITY_REJECTED');
    });

    it('accepts a missing verification claim only from a provider configured for it', async () => {
      await configureProvider({ requireVerifiedEmail: false });
      await createActiveUser({ email: AGENT_EMAIL, roleCode: 'tier1_agent' });

      const response = await signInThroughProvider({ ...AGENT, emailVerified: undefined });

      expect(response.status).toBe(200);
      expect(response.body.data.status).toBe('authenticated');
    });

    it('creates no account for an address nobody invited', async () => {
      await configureProvider();

      const response = await signInThroughProvider({
        subject: 'google-subject-1234',
        email: 'stranger@primefocus.co.zw',
        emailVerified: true,
      });

      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('SSO_NO_ACCOUNT');
    });

    it('refuses a second subject claiming an already-linked address', async () => {
      await configureProvider();
      await createActiveUser({ email: AGENT_EMAIL, roleCode: 'tier1_agent' });

      expect((await signInThroughProvider(AGENT)).status).toBe(200);

      // Same mailbox, different person at the provider. Silently relinking here
      // is exactly how a reassigned mailbox inherits somebody's tickets.
      const impostor = await signInThroughProvider({ ...AGENT, subject: 'google-subject-0002' });

      expect(impostor.status).toBe(409);
      expect(impostor.body.error.code).toBe('SSO_IDENTITY_MISMATCH');
    });

    it('refuses a suspended account and links nothing', async () => {
      await configureProvider();
      await createActiveUser({ email: AGENT_EMAIL, roleCode: 'tier1_agent' });
      await db.update(users).set({ status: 'suspended' }).where(eq(users.email, AGENT_EMAIL));

      const response = await signInThroughProvider(AGENT);
      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('ACCOUNT_SUSPENDED');

      // Reactivated, the account has no link: the refusal rolled the whole
      // resolution back rather than leaving half of it behind.
      await db.update(users).set({ status: 'active' }).where(eq(users.email, AGENT_EMAIL));
      const second = await signInThroughProvider(AGENT);
      expect(second.status).toBe(200);
    });

    it('still asks for the emailed code when the provider is configured to', async () => {
      await configureProvider({ code: 'otp-idp', requireOtp: true });
      await createActiveUser({ email: AGENT_EMAIL, roleCode: 'tier1_agent' });

      const challenged = await signInThroughProvider(AGENT, { providerCode: 'otp-idp' });

      expect(challenged.status).toBe(200);
      expect(challenged.body.data.status).toBe('otp_required');

      const verified = await request(app)
        .post('/api/v1/auth/otp/verify')
        .send({ challengeId: challenged.body.data.challengeId, code: otpCodeFor(AGENT_EMAIL) });

      expect(verified.status).toBe(200);
      expect(verified.body.data.tokens.accessToken).toBeTruthy();
    });
  });

  // -- invited accounts ------------------------------------------------------

  describe('an invited account signing in through a provider', () => {
    async function invite(email: string) {
      const response = await request(app)
        .post('/api/v1/invitations')
        .set(...bearer(adminToken))
        .send({ email, fullName: 'Tarisai M', roleId: await roleIdFor('tier1_agent') });

      expect(response.status).toBe(201);
      return invitationTokenFor(email);
    }

    it('activates the account, closes the invitation, and sets no password', async () => {
      await configureProvider();
      const token = await invite(AGENT_EMAIL);

      const response = await signInThroughProvider(AGENT);
      expect(response.status).toBe(200);
      expect(response.body.data.user.status).toBe('active');

      // The emailed link is a live credential until something closes it.
      const stale = await request(app).post('/api/v1/invitations/verify').send({ token });
      expect(stale.status).toBe(409);
      expect(stale.body.error.code).toBe('INVITATION_ALREADY_ACCEPTED');

      const [row] = await db.select().from(users).where(eq(users.email, AGENT_EMAIL));
      expect(row?.passwordHash).toBeNull();
    });

    it('tells them where to sign in if they try a password afterwards', async () => {
      await configureProvider();
      await invite(AGENT_EMAIL);
      expect((await signInThroughProvider(AGENT)).status).toBe(200);

      const password = await request(app)
        .post('/api/v1/auth/login')
        .send({ email: AGENT_EMAIL, password: STRONG_PASSWORD });

      expect(password.status).toBe(403);
      expect(password.body.error.code).toBe('SSO_LOGIN_REQUIRED');
    });

    it('will not unlink the only way into the account', async () => {
      await configureProvider();
      await invite(AGENT_EMAIL);

      const signedIn = await signInThroughProvider(AGENT);
      const token = signedIn.body.data.tokens.accessToken as string;

      const identities = await request(app)
        .get('/api/v1/auth/sso/identities')
        .set(...bearer(token));

      const unlink = await request(app)
        .delete(`/api/v1/auth/sso/identities/${identities.body.data[0].id}`)
        .set(...bearer(token));

      expect(unlink.status).toBe(409);
      expect(unlink.body.error.code).toBe('SSO_LAST_CREDENTIAL');
    });

    it('unlinks once the account has a password of its own', async () => {
      await configureProvider();
      await createActiveUser({ email: AGENT_EMAIL, roleCode: 'tier1_agent' });

      const signedIn = await signInThroughProvider(AGENT);
      const token = signedIn.body.data.tokens.accessToken as string;

      const identities = await request(app)
        .get('/api/v1/auth/sso/identities')
        .set(...bearer(token));

      const unlink = await request(app)
        .delete(`/api/v1/auth/sso/identities/${identities.body.data[0].id}`)
        .set(...bearer(token));

      expect(unlink.status).toBe(204);
    });
  });

  // -- provider administration ----------------------------------------------

  describe('/identity-providers', () => {
    it('never returns the client secret', async () => {
      const created = await configureProvider();
      expect(created.clientSecret).toBeUndefined();

      const listed = await request(app)
        .get('/api/v1/identity-providers')
        .set(...bearer(adminToken));

      expect(listed.status).toBe(200);
      expect(JSON.stringify(listed.body)).not.toContain(idp.clientSecret);

      const one = await request(app)
        .get(`/api/v1/identity-providers/${created.id}`)
        .set(...bearer(adminToken));

      expect(one.body.data.clientId).toBe(idp.clientId);
      expect(JSON.stringify(one.body)).not.toContain(idp.clientSecret);
    });

    it('refuses an issuer that serves no OpenID configuration', async () => {
      const response = await request(app)
        .post('/api/v1/identity-providers')
        .set(...bearer(adminToken))
        .send({
          code: 'nowhere',
          displayName: 'Nowhere',
          kind: 'oidc',
          issuer: 'http://127.0.0.1:1/not-a-provider',
          clientId: 'x',
          clientSecret: 'y',
          allowedEmailDomains: ['primefocus.co.zw'],
        });

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('insists on at least one federated email domain', async () => {
      const response = await request(app)
        .post('/api/v1/identity-providers')
        .set(...bearer(adminToken))
        .send({
          code: 'wide-open',
          displayName: 'Wide Open',
          kind: 'google',
          issuer: idp.issuer,
          clientId: idp.clientId,
          clientSecret: idp.clientSecret,
          allowedEmailDomains: [],
        });

      expect(response.status).toBe(400);
    });

    it('keeps an agent out of provider configuration', async () => {
      const agent = await createActiveUser({ email: AGENT_EMAIL, roleCode: 'tier1_agent' });
      const agentToken = (await signIn(app, agent.email)).accessToken;

      const forbidden = await request(app)
        .get('/api/v1/identity-providers')
        .set(...bearer(agentToken));

      expect(forbidden.status).toBe(403);
    });

    it('offers the sign-in screen only what it needs, unauthenticated', async () => {
      await configureProvider();

      const response = await request(app).get('/api/v1/auth/sso/providers');

      expect(response.status).toBe(200);
      expect(response.body.data).toHaveLength(1);
      expect(response.body.data[0]).toEqual({
        id: expect.any(String),
        code: 'test-idp',
        displayName: 'Test Identity Provider',
        kind: 'oidc',
      });
    });

    it('will not delete a provider people still sign in through', async () => {
      const provider = await configureProvider();
      await createActiveUser({ email: AGENT_EMAIL, roleCode: 'tier1_agent' });
      expect((await signInThroughProvider(AGENT)).status).toBe(200);

      const deleted = await request(app)
        .delete(`/api/v1/identity-providers/${provider.id}`)
        .set(...bearer(adminToken));

      expect(deleted.status).toBe(409);

      // Deactivating is the reversible way to stop offering it.
      const disabled = await request(app)
        .patch(`/api/v1/identity-providers/${provider.id}`)
        .set(...bearer(adminToken))
        .send({ isActive: false });

      expect(disabled.status).toBe(200);
      expect(disabled.body.data.isActive).toBe(false);
    });

    it('rotates a client secret without ever reading it back', async () => {
      const provider = await configureProvider();

      const rotated = await request(app)
        .patch(`/api/v1/identity-providers/${provider.id}`)
        .set(...bearer(adminToken))
        .send({ clientSecret: 'a-freshly-issued-secret' });

      expect(rotated.status).toBe(200);
      expect(JSON.stringify(rotated.body)).not.toContain('a-freshly-issued-secret');

      // And the provider now rejects the exchange, because the fake IdP still
      // expects the original — which is how we know it was really replaced.
      await createActiveUser({ email: AGENT_EMAIL, roleCode: 'tier1_agent' });
      const response = await signInThroughProvider(AGENT);

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('SSO_EXCHANGE_FAILED');
    });
  });
});

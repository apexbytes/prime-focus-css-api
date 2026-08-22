import { env, ssoRedirectUrl } from '../../config/index.js';
import { getContext } from '../../common/context/request-context.js';
import { AppError, ErrorCode } from '../../common/errors/index.js';
import type { Actor, UserActor } from '../../common/types/actor.js';
import { generateSecret, hashSecret } from '../../common/utils/crypto.js';
import { withTransaction, type Executor } from '../../db/transaction.js';
import { createModuleLogger } from '../../lib/logger/index.js';
import * as oidc from '../../lib/oidc/index.js';
import * as auditService from '../audit/audit.service.js';
import * as authService from '../auth/auth.service.js';
import * as invitationService from '../invitation/invitation.service.js';
import * as userService from '../user/user.service.js';
import type { UserWithRole } from '../user/user.types.js';
import type { IdentityProviderRow } from './sso.model.js';
import { assertClaimsAcceptable, assertFederatableIssuer } from './sso.policy.js';
import * as repository from './sso.repository.js';
import type { CreateProviderBody, UpdateProviderBody } from './sso.schema.js';
import type {
  FederatedLoginResult,
  IdentityProviderView,
  PublicIdentityProvider,
  PublicSsoIdentity,
  StartedLogin,
} from './sso.types.js';

const log = createModuleLogger('sso');

// -- the sign-in flow ---------------------------------------------------------

/** What the unauthenticated sign-in screen may know: enough to draw a button. */
export async function listProvidersForSignIn(): Promise<PublicIdentityProvider[]> {
  const rows = await repository.listActiveProviders();
  return rows.map(toPublicProvider);
}

export interface StartLoginInput {
  providerId?: string | undefined;
  providerCode?: string | undefined;
  returnPath?: string | undefined;
}

/**
 * Begins a federated sign-in: builds the authorization URL and remembers what
 * has to come back.
 *
 * The `state`, the nonce and the PKCE verifier are generated here and stored
 * server-side, because this API has no session for a caller who has not signed
 * in yet. Only the `state` and the challenge travel through the browser; the
 * verifier never leaves this system, which is what makes an intercepted
 * authorization code useless to whoever caught it.
 */
export async function startLogin(input: StartLoginInput): Promise<StartedLogin> {
  const provider = await resolveActiveProvider(input);
  const discovery = await oidc.discover(provider.issuer);

  const state = generateSecret(32);
  const nonce = generateSecret(16);
  const pkce = oidc.createPkcePair();
  const expiresAt = new Date(Date.now() + env.SSO_LOGIN_REQUEST_TTL_MINUTES * 60_000);
  const context = getContext();

  await repository.insertLoginRequest({
    providerId: provider.id,
    stateHash: hashSecret(state),
    nonce,
    codeVerifier: pkce.verifier,
    redirectUri: ssoRedirectUrl,
    returnPath: input.returnPath ?? null,
    expiresAt,
    ip: context?.ip ?? null,
    userAgent: context?.userAgent ?? null,
  });

  const authorizationUrl = oidc.buildAuthorizationUrl({
    discovery,
    clientId: provider.clientId,
    redirectUri: ssoRedirectUrl,
    scopes: provider.scopes,
    state,
    nonce,
    codeChallenge: pkce.challenge,
  });

  log.info('federated sign-in started', { provider: provider.code });
  return { authorizationUrl, provider: toPublicProvider(provider), expiresAt };
}

export interface CompleteLoginInput {
  state: string;
  code: string;
}

/**
 * Completes a federated sign-in and returns the same thing a password login
 * returns.
 *
 * The order is deliberate. The `state` is claimed first, so a replay is refused
 * before this system will talk to a provider on its behalf; then the code is
 * exchanged and the `id_token` verified; then the claims are checked against the
 * provider's policy; and only then is an account looked up. Nothing about which
 * staff accounts exist is reachable without a signed assertion from a configured
 * provider.
 *
 * **No account is created here.** Accounts exist by invitation, and that does not
 * change because the authentication arrived from Google — a provider vouching for
 * an address says who somebody is, not that they work here. What a federated
 * sign-in may do is *activate* an account that was already invited, because a
 * verified assertion for the invited address proves exactly what clicking the
 * emailed link proves.
 */
export async function completeLogin(input: CompleteLoginInput): Promise<FederatedLoginResult> {
  const request = await claimLoginRequest(input.state);
  const provider = await requireUsableProvider(request.providerId);

  const discovery = await oidc.discover(provider.issuer);
  const idToken = await oidc.exchangeCode({
    discovery,
    clientId: provider.clientId,
    clientSecret: provider.clientSecret,
    redirectUri: request.redirectUri,
    code: input.code,
    codeVerifier: request.codeVerifier,
  });

  const claims = await oidc.verifyIdToken({
    idToken,
    discovery,
    clientId: provider.clientId,
    nonce: request.nonce,
  });

  const email = assertClaimsAcceptable(claims, provider);

  const user = await withTransaction(({ tx }) =>
    resolveAccount({ provider, subject: claims.subject, email }, tx),
  );

  const login = await authService.startFederatedSession({
    userId: user.id,
    providerCode: provider.code,
    requireOtp: provider.requireOtp,
  });

  return { login, returnPath: request.returnPath, provider: toPublicProvider(provider) };
}

/**
 * Claims the login request named by a `state`, once.
 *
 * A `state` that exists but is already consumed is reported as a replay rather
 * than as an unknown value: the difference matters to an operator reading logs
 * after somebody's browser history has been read.
 */
async function claimLoginRequest(state: string) {
  const stateHash = hashSecret(state);
  const request = await repository.consumeLoginRequest(stateHash);

  if (!request) {
    const seen = await repository.findLoginRequest(stateHash);
    if (seen) {
      log.warn('federated sign-in replayed', { requestId: seen.id, providerId: seen.providerId });
      throw new AppError(
        400,
        ErrorCode.SSO_STATE_INVALID,
        'This sign-in has already been completed, please start again',
      );
    }

    throw new AppError(
      400,
      ErrorCode.SSO_STATE_INVALID,
      'This sign-in is not recognised, please start again',
    );
  }

  if (request.expiresAt.getTime() <= Date.now()) {
    throw new AppError(
      400,
      ErrorCode.SSO_STATE_EXPIRED,
      'This sign-in took too long, please start again',
    );
  }

  return request;
}

/**
 * Turns a verified assertion into the staff account it belongs to, linking or
 * activating as needed.
 *
 * Matching is on the provider's subject first and the email address only when no
 * link exists yet. That order is the whole safety property: an address that
 * changes hands cannot inherit the previous holder's tickets, and a second
 * subject arriving with an already-linked address is refused rather than quietly
 * becoming a second key to the same account.
 */
async function resolveAccount(
  input: { provider: IdentityProviderRow; subject: string; email: string },
  tx: Executor,
): Promise<UserWithRole> {
  const { provider, subject, email } = input;
  const identity = await repository.findIdentityBySubject(provider.id, subject, tx);

  if (identity) {
    const user = await userService.findById(identity.userId, tx);
    if (!user) {
      // The identity's account was deleted underneath it.
      throw new AppError(403, ErrorCode.SSO_NO_ACCOUNT, 'This account no longer exists');
    }

    if (identity.email !== email) {
      // Worth a trail: it is how somebody's address changed at the provider,
      // and it is also what a takeover of a reassigned mailbox looks like.
      await auditService.record(
        {
          action: 'sso.identity_email_changed',
          entityType: 'sso_identity',
          entityId: identity.id,
          actorType: 'system',
          before: { email: identity.email },
          after: { email },
        },
        undefined,
        tx,
      );
    }

    await repository.recordIdentityLogin(identity.id, email, tx);
    return activateIfInvited(user, provider, tx);
  }

  const user = await userService.findByEmail(email, tx);
  if (!user) {
    log.warn('federated sign-in for an address with no account', { provider: provider.code });
    await authService.recordFederatedDenial(email);
    throw new AppError(
      403,
      ErrorCode.SSO_NO_ACCOUNT,
      'There is no Prime Focus support account for this address; ask an administrator for an invitation',
    );
  }

  const linkedAlready = await repository.findIdentityForUser(provider.id, user.id, tx);
  if (linkedAlready) {
    // Same address, different subject. Either the provider reissued one, or
    // somebody else now holds the mailbox. Both need a human.
    log.error('federated identity conflict', {
      provider: provider.code,
      userId: user.id,
      existingIdentityId: linkedAlready.id,
    });
    throw new AppError(
      409,
      ErrorCode.SSO_IDENTITY_MISMATCH,
      'This account is already linked to a different identity at this provider; an administrator must unlink it first',
    );
  }

  const created = await repository.insertIdentity(
    { providerId: provider.id, userId: user.id, subject, email },
    tx,
  );

  await auditService.record(
    {
      action: 'sso.identity_linked',
      entityType: 'sso_identity',
      entityId: created.id,
      actorType: 'user',
      actorId: user.id,
      actorLabel: user.email,
      after: { provider: provider.code, email },
    },
    undefined,
    tx,
  );

  log.info('federated identity linked', { provider: provider.code, userId: user.id });
  return activateIfInvited(user, provider, tx);
}

/**
 * An invited account signing in through a provider is activated on the spot,
 * with no password.
 *
 * The invitation email exists to prove control of an address; a provider's
 * verified assertion about the same address proves it at least as well. Sending
 * the invitee back to find a link so they can choose a password they will never
 * use would be friction with no security in it — and the invitation is marked
 * accepted here so its link stops working, which is the part that would
 * otherwise be a live credential nobody expected.
 */
async function activateIfInvited(
  user: UserWithRole,
  provider: IdentityProviderRow,
  tx: Executor,
): Promise<UserWithRole> {
  if (user.status === 'suspended') {
    throw new AppError(403, ErrorCode.ACCOUNT_SUSPENDED, 'This account has been suspended');
  }

  if (user.status !== 'invited') return user;

  const activated = await userService.activateWithoutPassword(user.id, tx);
  if (!activated) throw AppError.notFound('The invited account no longer exists');

  await invitationService.markAcceptedByFederation(user.id, tx);

  await auditService.record(
    {
      action: 'sso.account_activated',
      entityType: 'user',
      entityId: user.id,
      actorType: 'user',
      actorId: user.id,
      actorLabel: user.email,
      before: { status: user.status },
      after: { status: 'active', provider: provider.code },
    },
    undefined,
    tx,
  );

  log.info('invited account activated through a provider', {
    userId: user.id,
    provider: provider.code,
  });

  return { ...user, ...activated, status: 'active' };
}

// -- a user's own links -------------------------------------------------------

export async function listIdentities(actor: UserActor): Promise<PublicSsoIdentity[]> {
  const rows = await repository.listIdentitiesForUser(actor.id);

  return rows.map((row) => ({
    id: row.id,
    providerId: row.providerId,
    providerCode: row.providerCode,
    providerName: row.providerName,
    email: row.email,
    lastLoginAt: row.lastLoginAt,
    createdAt: row.createdAt,
  }));
}

/**
 * Unlinks one identity, unless it is the only way the account can be signed
 * into.
 *
 * An account activated through a provider has no password. Letting it drop its
 * last identity would leave a member of staff locked out of a support desk with
 * nothing to reset — so the answer is to set a password first, which the reset
 * flow already does.
 */
export async function unlinkIdentity(actor: UserActor, id: string): Promise<void> {
  const identity = await repository.findIdentityById(id);
  if (!identity || identity.userId !== actor.id) {
    throw AppError.notFound('Linked identity not found');
  }

  const user = await userService.requireById(actor.id);
  const remaining = (await repository.countIdentitiesForUser(actor.id)) - 1;

  if (remaining === 0 && !user.passwordHash) {
    throw new AppError(
      409,
      ErrorCode.SSO_LAST_CREDENTIAL,
      'This is the only way to sign in to this account; set a password before unlinking it',
    );
  }

  await withTransaction(async ({ tx }) => {
    await repository.deleteIdentity(id, tx);
    await auditService.record(
      {
        action: 'sso.identity_unlinked',
        entityType: 'sso_identity',
        entityId: id,
        before: { provider: identity.providerId, email: identity.email },
      },
      actor,
      tx,
    );
  });

  log.info('federated identity unlinked', { userId: actor.id, identityId: id });
}

// -- provider administration --------------------------------------------------

export async function listProviders(): Promise<IdentityProviderView[]> {
  const rows = await repository.listProviders();
  return rows.map(toView);
}

export async function getProvider(id: string): Promise<IdentityProviderView> {
  return toView(await requireProvider(id));
}

/**
 * Configures a provider.
 *
 * Two things are checked before the row exists, because both are cheaper to
 * learn now than during somebody's first sign-in: the issuer serves a usable
 * discovery document, and the email domains it may vouch for are stated. The
 * second is not a nicety — `https://accounts.google.com` is the issuer for every
 * consumer Google account in the world, and a provider with no domain list is a
 * provider that will vouch for all of them.
 */
export async function createProvider(
  input: CreateProviderBody,
  actor: Actor,
): Promise<IdentityProviderView> {
  const issuer = assertFederatableIssuer(input.issuer);
  await assertDiscoverable(issuer);

  const existing = await repository.findProviderByCode(input.code);
  if (existing) {
    throw AppError.conflict('An identity provider with this code already exists');
  }

  const created = await withTransaction(async ({ tx }) => {
    const row = await repository.insertProvider(
      {
        code: input.code,
        displayName: input.displayName,
        kind: input.kind,
        issuer,
        clientId: input.clientId,
        clientSecret: input.clientSecret,
        scopes: input.scopes,
        allowedEmailDomains: input.allowedEmailDomains,
        requireVerifiedEmail: input.requireVerifiedEmail,
        requireOtp: input.requireOtp,
        isActive: input.isActive,
        createdByUserId: actor.kind === 'user' ? actor.id : null,
      },
      tx,
    );

    // The secret is deliberately absent from the trail: an audit row is read by
    // more people than a provider's credentials should be.
    await auditService.record(
      {
        action: 'sso.provider_created',
        entityType: 'identity_provider',
        entityId: row.id,
        after: {
          code: row.code,
          kind: row.kind,
          issuer: row.issuer,
          clientId: row.clientId,
          allowedEmailDomains: row.allowedEmailDomains,
          requireVerifiedEmail: row.requireVerifiedEmail,
          requireOtp: row.requireOtp,
          isActive: row.isActive,
        },
      },
      actor,
      tx,
    );

    return row;
  });

  log.info('identity provider configured', { code: created.code, issuer: created.issuer });
  return toView(created);
}

export async function updateProvider(
  id: string,
  patch: UpdateProviderBody,
  actor: Actor,
): Promise<IdentityProviderView> {
  const before = await requireProvider(id);
  const issuer = patch.issuer === undefined ? undefined : assertFederatableIssuer(patch.issuer);

  if (issuer !== undefined && issuer !== before.issuer) {
    await assertDiscoverable(issuer);
  }

  const updated = await withTransaction(async ({ tx }) => {
    const row = await repository.updateProvider(
      id,
      {
        ...(patch.displayName !== undefined ? { displayName: patch.displayName } : {}),
        ...(issuer !== undefined ? { issuer } : {}),
        ...(patch.clientId !== undefined ? { clientId: patch.clientId } : {}),
        ...(patch.clientSecret !== undefined ? { clientSecret: patch.clientSecret } : {}),
        ...(patch.scopes !== undefined ? { scopes: patch.scopes } : {}),
        ...(patch.allowedEmailDomains !== undefined
          ? { allowedEmailDomains: patch.allowedEmailDomains }
          : {}),
        ...(patch.requireVerifiedEmail !== undefined
          ? { requireVerifiedEmail: patch.requireVerifiedEmail }
          : {}),
        ...(patch.requireOtp !== undefined ? { requireOtp: patch.requireOtp } : {}),
        ...(patch.isActive !== undefined ? { isActive: patch.isActive } : {}),
      },
      tx,
    );
    if (!row) throw AppError.notFound('Identity provider not found');

    await auditService.record(
      {
        action: 'sso.provider_updated',
        entityType: 'identity_provider',
        entityId: id,
        before: auditableFields(before),
        after: {
          ...auditableFields(row),
          // Whether it changed, never what it changed to.
          clientSecretRotated: patch.clientSecret !== undefined,
        },
      },
      actor,
      tx,
    );

    return row;
  });

  return toView(updated);
}

/**
 * Deletes a provider, and with it every link through it.
 *
 * Refused while anybody is relying on it as their only credential: deleting a
 * provider that fifteen agents sign in through, none of whom has a password, is
 * a locked desk. Deactivating it is the reversible way to stop it being offered,
 * which is why `isActive` exists.
 */
export async function removeProvider(id: string, actor: Actor): Promise<void> {
  const provider = await requireProvider(id);
  const linked = await repository.countIdentitiesForProvider(id);

  if (linked > 0) {
    throw AppError.conflict(
      `${linked} account${linked === 1 ? '' : 's'} still sign in through this provider; deactivate it instead`,
    );
  }

  await withTransaction(async ({ tx }) => {
    await auditService.record(
      {
        action: 'sso.provider_deleted',
        entityType: 'identity_provider',
        entityId: id,
        before: auditableFields(provider),
      },
      actor,
      tx,
    );
    await repository.deleteProvider(id, tx);
  });

  log.warn('identity provider deleted', { code: provider.code });
}

// -- retention ---------------------------------------------------------------

/**
 * Drops expired sign-in requests. Operational debris, like a webhook delivery
 * row: swept by the job that already runs weekly with permission to delete
 * things, not because the Act has an opinion about it.
 */
export function purgeLoginRequests(before: Date, limit: number): Promise<number> {
  return repository.deleteExpiredLoginRequests(before, limit);
}

// -- internals ---------------------------------------------------------------

async function resolveActiveProvider(input: StartLoginInput): Promise<IdentityProviderRow> {
  const provider = input.providerId
    ? await repository.findProviderById(input.providerId)
    : input.providerCode
      ? await repository.findProviderByCode(input.providerCode)
      : undefined;

  // 404 rather than 403 for a disabled one: whether a provider exists but is
  // switched off is not something an unauthenticated caller needs to know.
  if (!provider || !provider.isActive) {
    throw AppError.notFound('Identity provider not found');
  }

  return provider;
}

async function requireUsableProvider(id: string): Promise<IdentityProviderRow> {
  const provider = await repository.findProviderById(id);
  if (!provider || !provider.isActive) {
    throw new AppError(
      403,
      ErrorCode.SSO_PROVIDER_UNAVAILABLE,
      'This identity provider is no longer enabled',
    );
  }
  return provider;
}

async function requireProvider(id: string): Promise<IdentityProviderRow> {
  const provider = await repository.findProviderById(id);
  if (!provider) throw AppError.notFound('Identity provider not found');
  return provider;
}

/**
 * A misspelled issuer is a configuration error, not an outage, so it is a 400
 * with the provider's own reason attached rather than a 503 an administrator
 * would read as "try again later".
 */
async function assertDiscoverable(issuer: string): Promise<void> {
  try {
    await oidc.discover(issuer);
  } catch (error) {
    if (error instanceof AppError && error.code === ErrorCode.SSO_PROVIDER_UNAVAILABLE) {
      throw AppError.validation('This issuer does not serve a usable OpenID configuration', {
        ...(error.details ? { details: error.details } : {}),
        cause: error,
      });
    }
    throw error;
  }
}

function toPublicProvider(row: IdentityProviderRow): PublicIdentityProvider {
  return { id: row.id, code: row.code, displayName: row.displayName, kind: row.kind };
}

function toView(row: IdentityProviderRow): IdentityProviderView {
  const { clientSecret: _secret, ...rest } = row;
  return rest;
}

function auditableFields(row: IdentityProviderRow) {
  const { clientSecret: _secret, ...rest } = row;
  return rest;
}

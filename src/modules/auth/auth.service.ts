import { randomUUID } from 'node:crypto';
import { env } from '../../config/index.js';
import { getContext, setActor } from '../../common/context/request-context.js';
import { AppError, ErrorCode } from '../../common/errors/index.js';
import type { Actor, UserActor } from '../../common/types/actor.js';
import { SUPER_ADMIN_ROLE_CODE, ALL_PERMISSION_CODES } from '../../common/types/permissions.js';
import {
  burnPasswordVerify,
  generateSecret,
  hashPassword,
  hashSecret,
  parseApiKey,
  verifyPassword,
} from '../../common/utils/crypto.js';
import { withTransaction, type Executor } from '../../db/transaction.js';
import { signAccessToken, verifyAccessToken } from '../../lib/jwt/index.js';
import { createModuleLogger } from '../../lib/logger/index.js';
import {
  passwordChangedEmail,
  passwordResetEmail,
  sendEmail,
  webUrl,
} from '../../lib/resend/index.js';
import * as apiKeyService from '../api-key/api-key.service.js';
import * as auditService from '../audit/audit.service.js';
import * as mfaService from '../mfa/mfa.service.js';
import * as roleService from '../role/role.service.js';
import * as userService from '../user/user.service.js';
import type { UserWithRole } from '../user/user.types.js';
import * as repository from './auth.repository.js';
import type { AuthenticatedResult, LoginResult, PublicSession, TokenPair } from './auth.types.js';

const log = createModuleLogger('auth');

const GENERIC_CREDENTIALS_ERROR = () =>
  new AppError(401, ErrorCode.INVALID_CREDENTIALS, 'Email or password is incorrect');

// -- login --------------------------------------------------------------------

export interface LoginInput {
  email: string;
  password: string;
  /** Presented by a browser that previously passed an OTP on this device. */
  deviceToken?: string | undefined;
}

/**
 * Password check, then either a trusted-device shortcut or an emailed OTP.
 *
 * Enumeration posture: an unknown address and a wrong password are
 * indistinguishable (both generic 401, both paying the same Argon2 cost).
 * Lockout, suspension and not-yet-activated states *are* revealed, but only to a
 * caller who already supplied the correct password — except for invited accounts,
 * which have no password to check and must be told to use their invitation.
 */
export async function login(input: LoginInput): Promise<LoginResult> {
  const email = userService.normaliseEmail(input.email);
  const context = getContext();
  const attemptBase = { email, ip: context?.ip, userAgent: context?.userAgent };

  const user = await userService.findByEmail(email);

  if (!user) {
    // Equalise timing against the branch that does verify a hash.
    await burnPasswordVerify();
    await repository.recordAttempt({ ...attemptBase, outcome: 'unknown_email' });
    throw GENERIC_CREDENTIALS_ERROR();
  }

  if (!user.passwordHash) {
    await burnPasswordVerify();
    await repository.recordAttempt({
      ...attemptBase,
      userId: user.id,
      outcome: 'account_not_activated',
    });
    throw new AppError(
      403,
      ErrorCode.ACCOUNT_NOT_ACTIVATED,
      'This account has not been activated yet. Use the invitation link sent to your email.',
    );
  }

  const passwordOk = await verifyPassword(user.passwordHash, input.password);

  if (!passwordOk) {
    await registerFailedPassword(user, attemptBase);
    throw GENERIC_CREDENTIALS_ERROR();
  }

  // Only now, with the password proven, is it safe to explain the account state.
  if (user.lockedUntil && user.lockedUntil.getTime() > Date.now()) {
    await repository.recordAttempt({ ...attemptBase, userId: user.id, outcome: 'account_locked' });
    throw new AppError(
      403,
      ErrorCode.ACCOUNT_LOCKED,
      'This account is temporarily locked after repeated failed sign-ins',
      { details: [{ field: 'lockedUntil', issue: user.lockedUntil.toISOString() }] },
    );
  }

  if (user.status === 'suspended') {
    await repository.recordAttempt({
      ...attemptBase,
      userId: user.id,
      outcome: 'account_suspended',
    });
    throw new AppError(403, ErrorCode.ACCOUNT_SUSPENDED, 'This account has been suspended');
  }

  await repository.recordAttempt({ ...attemptBase, userId: user.id, outcome: 'password_ok' });

  if (input.deviceToken && (await mfaService.isDeviceTrusted(user.id, input.deviceToken))) {
    await repository.recordAttempt({ ...attemptBase, userId: user.id, outcome: 'device_trusted' });
    log.info('login via trusted device', { userId: user.id });
    return completeLogin(user, 'auth.login_trusted_device');
  }

  const challenge = await mfaService.issueLoginChallenge({
    id: user.id,
    email: user.email,
    fullName: user.fullName,
  });

  return {
    status: 'otp_required',
    challengeId: challenge.challengeId,
    expiresAt: challenge.expiresAt,
    codeLength: env.OTP_LENGTH,
    emailDelivered: challenge.emailDelivered,
  };
}

async function registerFailedPassword(
  user: UserWithRole,
  attemptBase: { email: string; ip?: string | undefined; userAgent?: string | undefined },
): Promise<void> {
  const attempts = user.failedLoginAttempts + 1;
  const shouldLock = attempts >= env.MAX_FAILED_LOGINS;
  const lockedUntil = shouldLock
    ? new Date(Date.now() + env.ACCOUNT_LOCK_MINUTES * 60_000)
    : user.lockedUntil;

  await userService.recordFailedLogin(user.id, shouldLock ? 0 : attempts, lockedUntil ?? null);
  await repository.recordAttempt({ ...attemptBase, userId: user.id, outcome: 'password_failed' });

  if (shouldLock) {
    log.warn('account locked after repeated failures', { userId: user.id, attempts });
    await auditService.recordSafely({
      action: 'auth.account_locked',
      entityType: 'user',
      entityId: user.id,
      actorType: 'system',
      after: { lockedUntil },
    });
  }
}

export interface VerifyOtpInput {
  challengeId: string;
  code: string;
  /** Skip the OTP on this device for TRUSTED_DEVICE_TTL_DAYS. */
  trustDevice?: boolean | undefined;
}

export async function verifyOtp(input: VerifyOtpInput): Promise<AuthenticatedResult> {
  const context = getContext();
  const verified = await mfaService.verifyLoginChallenge(input.challengeId, input.code);

  const user = await userService.findById(verified.userId);
  if (!user) throw GENERIC_CREDENTIALS_ERROR();

  // Re-checked after the challenge: the account may have been suspended between
  // the password step and the code arriving.
  if (user.status !== 'active') {
    throw new AppError(403, ErrorCode.ACCOUNT_SUSPENDED, 'This account is not active');
  }

  await repository.recordAttempt({
    email: user.email,
    userId: user.id,
    outcome: 'otp_ok',
    ip: context?.ip,
    userAgent: context?.userAgent,
  });

  const result = await completeLogin(user, 'auth.login_succeeded');

  if (input.trustDevice) {
    const grant = await mfaService.trustDevice(user.id, toActor(user, null));
    return { ...result, deviceToken: grant.deviceToken, deviceTrustExpiresAt: grant.expiresAt };
  }

  return result;
}

export async function resendOtp(challengeId: string) {
  const userId = await mfaService.challengeUserId(challengeId);
  const user = await userService.requireById(userId);
  return mfaService.resendLoginChallenge(challengeId, {
    id: user.id,
    email: user.email,
    fullName: user.fullName,
  });
}

async function completeLogin(user: UserWithRole, action: string): Promise<AuthenticatedResult> {
  const tokens = await issueTokens(user, randomUUID());
  await userService.recordSuccessfulLogin(user.id);
  await auditService.recordSafely(
    { action, entityType: 'user', entityId: user.id },
    toActor(user, null),
  );

  return { status: 'authenticated', tokens, user: userService.toPublicUser(user) };
}

/**
 * Signs in a user who has just accepted an invitation. No OTP: clicking a link
 * that only reached their inbox already proved control of the address, which is
 * precisely what the emailed code proves at login.
 */
export async function startSessionForActivatedUser(userId: string): Promise<AuthenticatedResult> {
  const user = await userService.requireById(userId);
  return completeLogin(user, 'auth.login_after_invitation');
}

// -- tokens -------------------------------------------------------------------

/**
 * Mints an access/refresh pair. The refresh token is opaque and stored only as a
 * hash; `familyId` ties every rotation back to the original login.
 */
async function issueTokens(user: UserWithRole, familyId: string): Promise<TokenPair> {
  const context = getContext();
  const refreshToken = generateSecret(32);

  const session = await repository.insertSession({
    userId: user.id,
    familyId,
    tokenHash: hashSecret(refreshToken),
    expiresAt: new Date(Date.now() + env.REFRESH_TOKEN_TTL_DAYS * 86_400_000),
    ip: context?.ip ?? null,
    userAgent: context?.userAgent ?? null,
  });

  const accessToken = await signAccessToken({
    sub: user.id,
    sid: session.id,
    role: user.roleCode,
  });

  return {
    accessToken,
    refreshToken,
    expiresIn: env.ACCESS_TOKEN_TTL_MINUTES * 60,
    tokenType: 'Bearer',
  };
}

/**
 * Rotates a refresh token.
 *
 * Presenting an already-rotated token means the token leaked, so the entire
 * family is revoked rather than just refusing the request — the legitimate
 * holder is forced to sign in again, and the thief gains nothing.
 */
export async function refresh(refreshToken: string): Promise<AuthenticatedResult> {
  const session = await repository.findSessionByTokenHash(hashSecret(refreshToken));

  if (!session) {
    throw new AppError(401, ErrorCode.SESSION_REVOKED, 'This session is no longer valid');
  }

  if (session.revokedAt) {
    const revoked = await repository.revokeFamily(session.familyId, 'reuse_detected');
    log.error('refresh token reuse detected', {
      userId: session.userId,
      familyId: session.familyId,
      sessionsRevoked: revoked,
    });
    await auditService.recordSafely({
      action: 'auth.refresh_reuse_detected',
      entityType: 'user',
      entityId: session.userId,
      actorType: 'system',
      after: { familyId: session.familyId, sessionsRevoked: revoked },
    });

    throw new AppError(
      401,
      ErrorCode.SESSION_REVOKED,
      'This session was revoked for security reasons, please sign in again',
    );
  }

  if (session.expiresAt.getTime() <= Date.now()) {
    throw new AppError(
      401,
      ErrorCode.SESSION_EXPIRED,
      'This session has expired, please sign in again',
    );
  }

  const user = await userService.findById(session.userId);
  if (!user || user.status !== 'active') {
    await repository.revokeFamily(session.familyId, 'user_inactive');
    throw new AppError(403, ErrorCode.ACCOUNT_SUSPENDED, 'This account is not active');
  }

  const tokens = await issueTokens(user, session.familyId);
  const rotatedInto = await repository.findSessionByTokenHash(hashSecret(tokens.refreshToken));
  if (rotatedInto) {
    await repository.markRotated(session.id, rotatedInto.id);
  }

  return { status: 'authenticated', tokens, user: userService.toPublicUser(user) };
}

// -- authentication of incoming requests --------------------------------------

/** Resolves a bearer access token to an actor, or explains why it cannot. */
export async function actorFromAccessToken(token: string): Promise<UserActor> {
  const verified = await verifyAccessToken(token);

  if (!verified.ok) {
    throw verified.reason === 'expired'
      ? new AppError(401, ErrorCode.TOKEN_EXPIRED, 'Access token has expired')
      : new AppError(401, ErrorCode.TOKEN_INVALID, 'Access token is not valid');
  }

  // The user row is read on every request so a suspension takes effect
  // immediately rather than at the end of the access token's 15-minute life.
  const user = await userService.findById(verified.claims.sub);
  if (!user) throw new AppError(401, ErrorCode.TOKEN_INVALID, 'Access token is not valid');

  if (user.status !== 'active') {
    throw new AppError(403, ErrorCode.ACCOUNT_SUSPENDED, 'This account is not active');
  }

  const session = await repository.findSessionById(verified.claims.sid);
  if (!session || session.revokedAt) {
    throw new AppError(401, ErrorCode.SESSION_REVOKED, 'This session has been signed out');
  }

  return toActor(user, verified.claims.sid, await resolvePermissions(user));
}

/**
 * Whether a connection authenticated earlier is still allowed to stay open.
 *
 * The websocket gateway calls this on a timer. It re-checks the two things that
 * change underneath a live connection — the account being suspended and the
 * session being signed out — and deliberately does not re-verify the access
 * token, which expires every fifteen minutes and would take every connected
 * agent down with it.
 */
export async function isConnectionStillAuthorised(actor: UserActor): Promise<boolean> {
  const user = await userService.findById(actor.id);
  if (!user || user.status !== 'active') return false;

  if (!actor.sessionId) return true;

  const session = await repository.findSessionById(actor.sessionId);
  return Boolean(session && !session.revokedAt);
}

export async function actorFromApiKey(presented: string): Promise<Actor> {
  const parsed = parseApiKey(presented);
  if (!parsed) throw new AppError(401, ErrorCode.API_KEY_INVALID, 'API key is not valid');

  return apiKeyService.authenticate(parsed.prefix, parsed.secret);
}

async function resolvePermissions(user: UserWithRole): Promise<readonly string[]> {
  // The wildcard role is resolved from the catalogue, so a permission added in a
  // later phase is granted without a data migration.
  if (user.roleCode === SUPER_ADMIN_ROLE_CODE) return ALL_PERMISSION_CODES;
  return roleService.permissionsForRole(user.roleId);
}

function toActor(
  user: UserWithRole,
  sessionId: string | null,
  permissions: readonly string[] = [],
): UserActor {
  return {
    kind: 'user',
    id: user.id,
    email: user.email,
    fullName: user.fullName,
    roleId: user.roleId,
    roleCode: user.roleCode,
    permissions,
    sessionId,
  };
}

// -- sessions -----------------------------------------------------------------

export async function listSessions(actor: UserActor): Promise<PublicSession[]> {
  const rows = await repository.listLiveSessions(actor.id);

  return rows.map((row) => ({
    id: row.id,
    ip: row.ip,
    userAgent: row.userAgent,
    createdAt: row.createdAt,
    lastUsedAt: row.lastUsedAt,
    expiresAt: row.expiresAt,
    current: row.id === actor.sessionId,
  }));
}

export async function revokeSession(actor: UserActor, sessionId: string): Promise<void> {
  const session = await repository.findSessionById(sessionId);
  if (!session || session.userId !== actor.id) throw AppError.notFound('Session not found');

  await repository.revokeSession(sessionId, 'user_signed_out');
  await auditService.recordSafely(
    { action: 'auth.session_revoked', entityType: 'session', entityId: sessionId },
    actor,
  );
}

export async function logout(actor: UserActor): Promise<void> {
  if (!actor.sessionId) return;
  await repository.revokeSession(actor.sessionId, 'user_signed_out');
  await auditService.recordSafely(
    { action: 'auth.logged_out', entityType: 'session', entityId: actor.sessionId },
    actor,
  );
}

export async function logoutEverywhere(actor: UserActor): Promise<{ sessionsRevoked: number }> {
  const sessionsRevoked = await repository.revokeAllForUser(actor.id, 'user_signed_out_all');
  await mfaService.revokeAllDevices(actor.id);
  await auditService.recordSafely(
    {
      action: 'auth.logged_out_everywhere',
      entityType: 'user',
      entityId: actor.id,
      after: { sessionsRevoked },
    },
    actor,
  );

  return { sessionsRevoked };
}

/** Hook handed to the user module when an account is suspended. */
export async function revokeAccess(userId: string, exec: Executor): Promise<void> {
  await repository.revokeAllForUser(userId, 'account_suspended', exec);
  await mfaService.revokeAllDevices(userId, exec);
}

// -- passwords ----------------------------------------------------------------

/**
 * Password rules: length only, plus a check that it is not a variation of the
 * user's own email. Composition rules (a digit, a symbol) push people towards
 * predictable substitutions without adding real entropy.
 */
export function assertPasswordAcceptable(password: string, email: string): void {
  if (password.length < env.PASSWORD_MIN_LENGTH) {
    throw new AppError(
      400,
      ErrorCode.WEAK_PASSWORD,
      `Password must be at least ${env.PASSWORD_MIN_LENGTH} characters`,
    );
  }

  const localPart = email.split('@')[0]?.toLowerCase() ?? '';
  const lowered = password.toLowerCase();
  if (localPart.length >= 4 && lowered.includes(localPart)) {
    throw new AppError(
      400,
      ErrorCode.WEAK_PASSWORD,
      'Password must not contain your email address',
    );
  }
}

/** Always succeeds from the caller's perspective, to avoid leaking who has an account. */
export async function requestPasswordReset(rawEmail: string): Promise<void> {
  const email = userService.normaliseEmail(rawEmail);
  const user = await userService.findByEmail(email);

  if (!user || user.status !== 'active') {
    log.info('password reset requested for unusable account', { emailKnown: Boolean(user) });
    return;
  }

  const token = generateSecret(32);
  await repository.consumeOutstandingResets(user.id);
  await repository.insertPasswordReset({
    userId: user.id,
    tokenHash: hashSecret(token),
    expiresAt: new Date(Date.now() + env.PASSWORD_RESET_TTL_MINUTES * 60_000),
    ip: getContext()?.ip ?? null,
  });

  const rendered = passwordResetEmail({
    fullName: user.fullName,
    resetUrl: webUrl('/reset-password', { token }),
    ttlMinutes: env.PASSWORD_RESET_TTL_MINUTES,
  });
  await sendEmail({ ...rendered, to: user.email, kind: 'password_reset' });

  await auditService.recordSafely({
    action: 'auth.password_reset_requested',
    entityType: 'user',
    entityId: user.id,
    actorType: 'system',
  });
}

export async function resetPassword(token: string, newPassword: string): Promise<void> {
  const record = await repository.findPasswordReset(hashSecret(token));

  if (!record || record.usedAt) {
    throw new AppError(400, ErrorCode.RESET_TOKEN_INVALID, 'This reset link is no longer valid');
  }
  if (record.expiresAt.getTime() <= Date.now()) {
    throw new AppError(400, ErrorCode.RESET_TOKEN_EXPIRED, 'This reset link has expired');
  }

  const user = await userService.requireById(record.userId);
  assertPasswordAcceptable(newPassword, user.email);
  const passwordHash = await hashPassword(newPassword);

  await withTransaction(async ({ tx, afterCommit }) => {
    await userService.setPassword(user.id, passwordHash, tx);
    await repository.markPasswordResetUsed(record.id, tx);
    // A reset is the remedy for a compromised account, so everything the
    // attacker might hold has to stop working.
    await repository.revokeAllForUser(user.id, 'password_reset', tx);
    await mfaService.revokeAllDevices(user.id, tx);

    await auditService.record(
      { action: 'auth.password_reset', entityType: 'user', entityId: user.id, actorType: 'system' },
      undefined,
      tx,
    );

    afterCommit(async () => {
      const rendered = passwordChangedEmail({ fullName: user.fullName, at: new Date() });
      await sendEmail({ ...rendered, to: user.email, kind: 'password_changed' });
    });
  });

  log.info('password reset completed', { userId: user.id });
}

export async function changePassword(
  actor: UserActor,
  currentPassword: string,
  newPassword: string,
): Promise<void> {
  const user = await userService.requireById(actor.id);
  if (!user.passwordHash || !(await verifyPassword(user.passwordHash, currentPassword))) {
    throw new AppError(400, ErrorCode.INVALID_CREDENTIALS, 'Current password is incorrect');
  }

  assertPasswordAcceptable(newPassword, user.email);
  if (await verifyPassword(user.passwordHash, newPassword)) {
    throw new AppError(
      400,
      ErrorCode.PASSWORD_REUSED,
      'New password must differ from the current one',
    );
  }

  const passwordHash = await hashPassword(newPassword);

  await withTransaction(async ({ tx, afterCommit }) => {
    await userService.setPassword(user.id, passwordHash, tx);
    // Every session except this one, and every trusted device.
    await repository.revokeAllForUser(user.id, 'password_changed', tx);
    await mfaService.revokeAllDevices(user.id, tx);

    await auditService.record(
      { action: 'auth.password_changed', entityType: 'user', entityId: user.id },
      actor,
      tx,
    );

    afterCommit(async () => {
      const rendered = passwordChangedEmail({ fullName: user.fullName, at: new Date() });
      await sendEmail({ ...rendered, to: user.email, kind: 'password_changed' });
    });
  });
}

// -- current identity ---------------------------------------------------------

export async function me(actor: UserActor) {
  const user = await userService.requireById(actor.id);
  setActor({ actorId: actor.id, actorType: 'user' });

  return {
    ...userService.toPublicUser(user),
    permissions: actor.permissions,
  };
}

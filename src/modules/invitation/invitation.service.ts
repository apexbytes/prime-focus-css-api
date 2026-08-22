import { env } from '../../config/index.js';
import { AppError, ErrorCode } from '../../common/errors/index.js';
import { isUserActor, type Actor } from '../../common/types/actor.js';
import { generateSecret, hashPassword, hashSecret } from '../../common/utils/crypto.js';
import { withTransaction, type Executor } from '../../db/transaction.js';
import { createModuleLogger } from '../../lib/logger/index.js';
import { invitationEmail, sendEmail, webUrl } from '../../lib/resend/index.js';
import * as auditService from '../audit/audit.service.js';
import * as authService from '../auth/auth.service.js';
import * as roleService from '../role/role.service.js';
import * as userService from '../user/user.service.js';
import * as repository from './invitation.repository.js';
import type { InvitationWithDetails } from './invitation.repository.js';
import type { InvitationPreview, PublicInvitation } from './invitation.types.js';

const log = createModuleLogger('invitation');

const MAX_SENDS = 5;

function statusOf(row: {
  acceptedAt: Date | null;
  revokedAt: Date | null;
  expiresAt: Date;
}): PublicInvitation['status'] {
  if (row.acceptedAt) return 'accepted';
  if (row.revokedAt) return 'revoked';
  if (row.expiresAt.getTime() <= Date.now()) return 'expired';
  return 'pending';
}

function toPublic(row: InvitationWithDetails, invitedBy: string | null = null): PublicInvitation {
  return {
    id: row.id,
    email: row.email,
    fullName: row.fullName,
    roleId: row.roleId,
    roleName: row.roleName,
    invitedBy,
    expiresAt: row.expiresAt,
    acceptedAt: row.acceptedAt,
    revokedAt: row.revokedAt,
    sendCount: row.sendCount,
    createdAt: row.createdAt,
    status: statusOf(row),
  };
}

export async function list(): Promise<PublicInvitation[]> {
  const rows = await repository.list();
  return rows.map((row) => toPublic(row));
}

export interface CreateInvitationInput {
  email: string;
  fullName: string;
  /** The role the invitee will hold; fixed at invitation time. */
  roleId: string;
}

/**
 * Creates the staff account in `invited` state and emails a one-time link.
 *
 * The user row exists immediately so the roster shows who is pending and so the
 * unique email constraint — not application logic — prevents two invitations
 * racing to create the same account.
 */
export async function invite(
  input: CreateInvitationInput,
  actor: Actor,
): Promise<PublicInvitation> {
  const email = userService.normaliseEmail(input.email);
  const role = await roleService.requireRoleById(input.roleId);

  const existing = await userService.findByEmail(email);
  if (existing) {
    if (existing.status !== 'invited') {
      throw new AppError(
        409,
        ErrorCode.USER_ALREADY_EXISTS,
        'An account already exists for this email address',
      );
    }

    // Re-inviting someone who never accepted: reuse the account, issue a new
    // token, and invalidate the old link.
    const live = await repository.findLiveForUser(existing.id);
    if (live) return resend(live.id, actor);
  }

  const token = generateSecret(32);
  const expiresAt = new Date(Date.now() + env.INVITATION_TTL_HOURS * 3_600_000);
  const inviterName = isUserActor(actor) ? actor.fullName : 'A Prime Focus administrator';

  const created = await withTransaction(async ({ tx, afterCommit }) => {
    const user = await userService.createInvited(
      { email, fullName: input.fullName, roleId: role.id },
      tx,
    );

    const invitation = await repository.insert(
      {
        userId: user.id,
        email,
        roleId: role.id,
        tokenHash: hashSecret(token),
        invitedByUserId: isUserActor(actor) ? actor.id : null,
        expiresAt,
      },
      tx,
    );

    await auditService.record(
      {
        action: 'user.invited',
        entityType: 'user',
        entityId: user.id,
        after: {
          email,
          fullName: input.fullName,
          roleCode: role.code,
          invitationId: invitation.id,
        },
      },
      actor,
      tx,
    );

    // Sent only once the account is committed, so a failed transaction cannot
    // leave a live link pointing at nothing.
    afterCommit(async () => {
      const rendered = invitationEmail({
        fullName: input.fullName,
        inviterName,
        roleName: role.name,
        acceptUrl: webUrl('/accept-invitation', { token }),
        expiresInHours: env.INVITATION_TTL_HOURS,
      });
      await sendEmail({ ...rendered, to: email, kind: 'invitation' });
    });

    return { ...invitation, roleName: role.name, fullName: user.fullName };
  });

  log.info('invitation created', { userId: created.userId, roleCode: role.code });
  return toPublic(created, inviterName);
}

/** Issues a fresh token and re-sends the email; the previous link stops working. */
export async function resend(id: string, actor: Actor): Promise<PublicInvitation> {
  const invitation = await repository.findById(id);
  if (!invitation) throw AppError.notFound('Invitation not found');

  if (invitation.acceptedAt) {
    throw new AppError(
      409,
      ErrorCode.INVITATION_ALREADY_ACCEPTED,
      'This invitation has already been accepted',
    );
  }
  if (invitation.revokedAt) {
    throw new AppError(409, ErrorCode.INVITATION_REVOKED, 'This invitation was revoked');
  }
  if (invitation.sendCount >= MAX_SENDS) {
    throw AppError.conflict(
      'This invitation has been sent too many times; revoke it and start again',
    );
  }

  const token = generateSecret(32);
  const expiresAt = new Date(Date.now() + env.INVITATION_TTL_HOURS * 3_600_000);

  await repository.refreshToken(id, hashSecret(token), expiresAt, invitation.sendCount + 1);

  const rendered = invitationEmail({
    fullName: invitation.fullName,
    inviterName: isUserActor(actor) ? actor.fullName : 'A Prime Focus administrator',
    roleName: invitation.roleName,
    acceptUrl: webUrl('/accept-invitation', { token }),
    expiresInHours: env.INVITATION_TTL_HOURS,
  });
  await sendEmail({ ...rendered, to: invitation.email, kind: 'invitation' });

  await auditService.recordSafely(
    { action: 'user.invitation_resent', entityType: 'user', entityId: invitation.userId },
    actor,
  );

  return toPublic({ ...invitation, expiresAt, sendCount: invitation.sendCount + 1 });
}

export async function revoke(id: string, actor: Actor): Promise<void> {
  const invitation = await repository.findById(id);
  if (!invitation) throw AppError.notFound('Invitation not found');
  if (invitation.acceptedAt) {
    throw new AppError(
      409,
      ErrorCode.INVITATION_ALREADY_ACCEPTED,
      'This invitation was already accepted; suspend the account instead',
    );
  }

  await withTransaction(async ({ tx }) => {
    await repository.revoke(id, tx);
    await auditService.record(
      {
        action: 'user.invitation_revoked',
        entityType: 'user',
        entityId: invitation.userId,
        before: { email: invitation.email },
      },
      actor,
      tx,
    );
  });

  log.info('invitation revoked', { invitationId: id });
}

/** Validates a token without consuming it, so the accept screen can be rendered. */
export async function preview(token: string): Promise<InvitationPreview> {
  const invitation = await requireUsable(token);

  return {
    email: invitation.email,
    fullName: invitation.fullName,
    roleName: invitation.roleName,
    expiresAt: invitation.expiresAt,
  };
}

/**
 * Consumes the invitation: the invitee sets a password and the account becomes
 * active. Tokens are issued straight away — possession of the emailed link plus a
 * freshly chosen password is exactly what the login OTP would have proven, so
 * sending them back to a login screen would add friction for no security gain.
 */
export async function accept(input: {
  token: string;
  password: string;
  fullName?: string | undefined;
}) {
  const invitation = await requireUsable(input.token);

  authService.assertPasswordAcceptable(input.password, invitation.email);
  const passwordHash = await hashPassword(input.password);

  const user = await withTransaction(async ({ tx }) => {
    const activated = await userService.activate(
      invitation.userId,
      passwordHash,
      { fullName: input.fullName },
      tx,
    );
    if (!activated) throw AppError.notFound('The invited account no longer exists');

    await repository.markAccepted(invitation.id, tx);
    await auditService.record(
      {
        action: 'user.invitation_accepted',
        entityType: 'user',
        entityId: invitation.userId,
        actorType: 'user',
        actorId: invitation.userId,
        actorLabel: invitation.email,
        after: { status: 'active' },
      },
      undefined,
      tx,
    );

    return activated;
  });

  log.info('invitation accepted', { userId: user.id });
  return authService.startSessionForActivatedUser(user.id);
}

/**
 * Closes off an invitation whose invitee signed in through an identity provider
 * instead of clicking the link.
 *
 * Without this the link would stay live for its full 72 hours after the account
 * is already active — a credential in an inbox that nobody expects to still
 * work. Silent when there is no live invitation: an account can be linked to a
 * provider long after it was activated the ordinary way.
 */
export async function markAcceptedByFederation(userId: string, exec: Executor): Promise<void> {
  const live = await repository.findLiveForUser(userId, exec);
  if (!live) return;

  await repository.markAccepted(live.id, exec);
  log.info('invitation closed by federated sign-in', { userId, invitationId: live.id });
}

async function requireUsable(token: string): Promise<InvitationWithDetails> {
  const invitation = await repository.findByTokenHash(hashSecret(token));

  if (!invitation) {
    throw new AppError(400, ErrorCode.INVITATION_INVALID, 'This invitation link is not valid');
  }
  if (invitation.acceptedAt) {
    throw new AppError(
      409,
      ErrorCode.INVITATION_ALREADY_ACCEPTED,
      'This invitation has already been used',
    );
  }
  if (invitation.revokedAt) {
    throw new AppError(410, ErrorCode.INVITATION_REVOKED, 'This invitation was revoked');
  }
  if (invitation.expiresAt.getTime() <= Date.now()) {
    throw new AppError(
      410,
      ErrorCode.INVITATION_EXPIRED,
      'This invitation has expired; ask an administrator to send a new one',
    );
  }

  return invitation;
}

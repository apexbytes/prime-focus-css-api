import { v7 as uuidv7 } from 'uuid';
import { env } from '../../config/index.js';
import { AppError, ErrorCode } from '../../common/errors/index.js';
import { getContext } from '../../common/context/request-context.js';
import type { Actor } from '../../common/types/actor.js';
import {
  generateOtp,
  generateSecret,
  hashOtp,
  hashSecret,
  secureEquals,
} from '../../common/utils/crypto.js';
import type { Executor } from '../../db/transaction.js';
import { createModuleLogger } from '../../lib/logger/index.js';
import { loginOtpEmail, sendEmail } from '../../lib/resend/index.js';
import * as auditService from '../audit/audit.service.js';
import type { TrustedDeviceRow } from './mfa.model.js';
import * as repository from './mfa.repository.js';
import type {
  ChallengeTarget,
  IssuedChallenge,
  PublicTrustedDevice,
  TrustedDeviceGrant,
} from './mfa.types.js';

const log = createModuleLogger('mfa');

const MAX_SENDS_PER_CHALLENGE = 3;

/**
 * Issues a login code and emails it.
 *
 * The code is never returned to the caller — the only way to learn it is to
 * receive the email, which is the entire point of the factor.
 */
export async function issueLoginChallenge(user: ChallengeTarget): Promise<IssuedChallenge> {
  const context = getContext();

  // A new code invalidates any previous one, so an attacker cannot keep several
  // guessable challenges alive at once.
  await repository.deleteLiveChallenges(user.id);

  const challengeId = uuidv7();
  const code = generateOtp();
  const expiresAt = new Date(Date.now() + env.OTP_TTL_MINUTES * 60_000);

  await repository.insertChallenge({
    id: challengeId,
    userId: user.id,
    codeHash: hashOtp(code, challengeId),
    expiresAt,
    ip: context?.ip ?? null,
    userAgent: context?.userAgent ?? null,
  });

  const rendered = loginOtpEmail({
    fullName: user.fullName,
    code,
    ttlMinutes: env.OTP_TTL_MINUTES,
    ip: context?.ip,
  });

  const result = await sendEmail({ ...rendered, to: user.email, kind: 'login_otp' });
  if (!result.delivered) {
    log.error('login code could not be delivered', { userId: user.id });
  }

  return { challengeId, expiresAt, emailDelivered: result.delivered };
}

/** Owner of a live challenge, so the caller can load the recipient's details. */
export async function challengeUserId(challengeId: string): Promise<string> {
  const challenge = await repository.findChallengeById(challengeId);
  if (!challenge || challenge.consumedAt) {
    throw new AppError(400, ErrorCode.OTP_INVALID, 'Unknown login challenge');
  }
  return challenge.userId;
}

export async function resendLoginChallenge(
  challengeId: string,
  user: ChallengeTarget,
): Promise<IssuedChallenge> {
  const challenge = await repository.findChallengeById(challengeId);
  if (!challenge || challenge.userId !== user.id) {
    throw new AppError(400, ErrorCode.OTP_INVALID, 'Unknown login challenge');
  }
  if (challenge.consumedAt) {
    throw new AppError(400, ErrorCode.OTP_INVALID, 'This challenge was already used');
  }
  if (challenge.expiresAt.getTime() <= Date.now()) {
    throw new AppError(400, ErrorCode.OTP_EXPIRED, 'This challenge has expired, start again');
  }

  const elapsedMs = Date.now() - challenge.lastSentAt.getTime();
  const cooldownMs = env.OTP_RESEND_COOLDOWN_SECONDS * 1000;
  if (elapsedMs < cooldownMs) {
    throw new AppError(
      429,
      ErrorCode.OTP_RESEND_COOLDOWN,
      `Wait ${Math.ceil((cooldownMs - elapsedMs) / 1000)} seconds before requesting another code`,
    );
  }

  if (challenge.sendCount >= MAX_SENDS_PER_CHALLENGE) {
    throw new AppError(
      429,
      ErrorCode.OTP_RESEND_LIMIT,
      'Too many codes requested for this login, start again',
    );
  }

  // A fresh code, not a re-send of the old one: the previous code stops working
  // the moment a replacement is issued.
  const code = generateOtp();
  await repository.replaceChallengeCode(
    challengeId,
    hashOtp(code, challengeId),
    challenge.sendCount + 1,
  );

  const rendered = loginOtpEmail({
    fullName: user.fullName,
    code,
    ttlMinutes: env.OTP_TTL_MINUTES,
    ip: getContext()?.ip,
  });
  const result = await sendEmail({ ...rendered, to: user.email, kind: 'login_otp' });

  return { challengeId, expiresAt: challenge.expiresAt, emailDelivered: result.delivered };
}

export interface VerifiedChallenge {
  userId: string;
}

/**
 * Consumes a challenge. Wrong guesses are counted in SQL and the challenge dies
 * at `OTP_MAX_ATTEMPTS`, which bounds a 6-digit code's exposure to 5 guesses out
 * of a million rather than an unlimited grind.
 */
export async function verifyLoginChallenge(
  challengeId: string,
  code: string,
): Promise<VerifiedChallenge> {
  const challenge = await repository.findChallengeById(challengeId);

  if (!challenge || challenge.consumedAt) {
    throw new AppError(401, ErrorCode.OTP_INVALID, 'That code is not valid');
  }

  if (challenge.expiresAt.getTime() <= Date.now()) {
    throw new AppError(401, ErrorCode.OTP_EXPIRED, 'That code has expired, request a new one');
  }

  if (challenge.attempts >= env.OTP_MAX_ATTEMPTS) {
    throw new AppError(
      429,
      ErrorCode.OTP_ATTEMPTS_EXCEEDED,
      'Too many incorrect codes, start the login again',
    );
  }

  if (!secureEquals(hashOtp(code, challengeId), challenge.codeHash)) {
    const attempts = await repository.incrementAttempts(challengeId);
    const remaining = Math.max(env.OTP_MAX_ATTEMPTS - attempts, 0);

    throw new AppError(401, ErrorCode.OTP_INVALID, 'That code is not valid', {
      details: [{ field: 'code', issue: `${remaining} attempts remaining` }],
      context: { challengeId, attempts },
    });
  }

  await repository.markChallengeConsumed(challengeId);
  return { userId: challenge.userId };
}

// -- trusted devices ----------------------------------------------------------

/** Best-effort human label for the device list; never parsed back. */
function deviceLabel(userAgent: string | undefined): string {
  if (!userAgent) return 'Unknown device';

  const browser = /Edg\//.test(userAgent)
    ? 'Edge'
    : /OPR\//.test(userAgent)
      ? 'Opera'
      : /Chrome\//.test(userAgent)
        ? 'Chrome'
        : /Safari\//.test(userAgent)
          ? 'Safari'
          : /Firefox\//.test(userAgent)
            ? 'Firefox'
            : 'Browser';

  const platform = /Windows/.test(userAgent)
    ? 'Windows'
    : /Android/.test(userAgent)
      ? 'Android'
      : /iPhone|iPad/.test(userAgent)
        ? 'iOS'
        : /Mac OS X/.test(userAgent)
          ? 'macOS'
          : /Linux/.test(userAgent)
            ? 'Linux'
            : 'unknown platform';

  return `${browser} on ${platform}`;
}

export async function trustDevice(userId: string, actor?: Actor): Promise<TrustedDeviceGrant> {
  const context = getContext();
  const deviceToken = generateSecret(32);
  const expiresAt = new Date(Date.now() + env.TRUSTED_DEVICE_TTL_DAYS * 86_400_000);

  const device = await repository.insertDevice({
    userId,
    tokenHash: hashSecret(deviceToken),
    label: deviceLabel(context?.userAgent),
    expiresAt,
    ip: context?.ip ?? null,
    userAgent: context?.userAgent ?? null,
  });

  await auditService.recordSafely(
    {
      action: 'mfa.device_trusted',
      entityType: 'trusted_device',
      entityId: device.id,
      after: { label: device.label, expiresAt },
    },
    actor,
  );

  return { deviceToken, expiresAt };
}

/**
 * True when this device may skip the OTP. Also refreshes `lastSeenAt`, so the
 * device list shows real usage and stale entries are recognisable.
 */
export async function isDeviceTrusted(userId: string, deviceToken: string): Promise<boolean> {
  const device = await repository.findLiveDevice(userId, hashSecret(deviceToken));
  if (!device) return false;

  await repository.touchDevice(device.id, getContext()?.ip ?? null);
  return true;
}

export async function listDevices(userId: string): Promise<PublicTrustedDevice[]> {
  const rows = await repository.listLiveDevices(userId);
  return rows.map(toPublicDevice);
}

export async function revokeDevice(userId: string, deviceId: string, actor: Actor): Promise<void> {
  const revoked = await repository.revokeDevice(userId, deviceId);
  if (!revoked) throw AppError.notFound('Trusted device not found');

  await auditService.recordSafely(
    {
      action: 'mfa.device_revoked',
      entityType: 'trusted_device',
      entityId: deviceId,
      before: { label: revoked.label },
    },
    actor,
  );
}

/** Called when a password changes or an account is suspended. */
export async function revokeAllDevices(userId: string, exec?: Executor): Promise<number> {
  const count = await repository.revokeAllDevices(userId, exec);
  if (count > 0) log.info('trusted devices revoked', { userId, count });
  return count;
}

function toPublicDevice(row: TrustedDeviceRow): PublicTrustedDevice {
  return {
    id: row.id,
    label: row.label,
    lastSeenAt: row.lastSeenAt,
    expiresAt: row.expiresAt,
    createdAt: row.createdAt,
    ip: row.ip,
  };
}

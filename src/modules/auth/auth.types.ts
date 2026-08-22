import type { PublicUser } from '../user/user.types.js';
import type { LoginAttemptRow, LoginOutcome, SessionRow } from './auth.model.js';

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  /** Seconds until the access token expires. */
  expiresIn: number;
  tokenType: 'Bearer';
}

export interface AuthenticatedResult {
  status: 'authenticated';
  tokens: TokenPair;
  user: PublicUser;
  /** Returned only when the caller asked for this device to be trusted. */
  deviceToken?: string;
  deviceTrustExpiresAt?: Date;
}

export interface ChallengeRequiredResult {
  status: 'otp_required';
  challengeId: string;
  expiresAt: Date;
  codeLength: number;
  /** False if the code could not be emailed; the client should offer a resend. */
  emailDelivered: boolean;
}

export type LoginResult = AuthenticatedResult | ChallengeRequiredResult;

export interface PublicSession {
  id: string;
  ip: string | null;
  userAgent: string | null;
  createdAt: Date;
  lastUsedAt: Date;
  expiresAt: Date;
  /** True for the session the current access token belongs to. */
  current: boolean;
}

export interface LoginAttemptFilter {
  userId?: string;
  email?: string;
  outcome?: LoginOutcome;
  from?: Date;
  to?: Date;
  limit: number;
  cursor?: string;
}

/**
 * One authentication decision. `userId` is null when nothing matched the address,
 * which is the case worth looking at rather than the one worth hiding.
 */
export interface PublicLoginAttempt {
  id: string;
  email: string;
  userId: string | null;
  outcome: LoginOutcome;
  ip: string | null;
  userAgent: string | null;
  createdAt: Date;
}

export type { LoginAttemptRow, LoginOutcome, SessionRow };

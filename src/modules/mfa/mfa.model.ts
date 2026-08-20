import { index, integer, pgEnum, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { instant, timestamps } from '../../db/columns.js';
import { users } from '../user/user.model.js';

/**
 * The second factor is a code emailed at login — not TOTP, so there is nothing
 * to enrol and no shared secret at rest. Only the code's hash is stored.
 */
export const otpPurpose = pgEnum('otp_purpose', ['login']);

export const otpChallenges = pgTable(
  'otp_challenges',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    codeHash: text('code_hash').notNull(),
    purpose: otpPurpose('purpose').notNull().default('login'),
    /** Wrong guesses; the challenge dies at OTP_MAX_ATTEMPTS. */
    attempts: integer('attempts').notNull().default(0),
    expiresAt: instant('expires_at').notNull(),
    consumedAt: instant('consumed_at'),
    lastSentAt: instant('last_sent_at').defaultNow().notNull(),
    sendCount: integer('send_count').notNull().default(1),
    ip: text('ip'),
    userAgent: text('user_agent'),
    ...timestamps,
  },
  (table) => [
    index('otp_challenges_user_idx').on(table.userId),
    index('otp_challenges_expires_at_idx').on(table.expiresAt),
  ],
);

/**
 * A device that has already passed an OTP may skip the challenge until this
 * expires. The token is a long random value held by the client and stored here
 * only as a hash, so it is a bearer credential in its own right — revocable
 * per device from `/auth/devices`.
 */
export const trustedDevices = pgTable(
  'trusted_devices',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull().unique(),
    /** Human-readable hint derived from the user agent, for the revoke list. */
    label: text('label').notNull(),
    expiresAt: instant('expires_at').notNull(),
    revokedAt: instant('revoked_at'),
    lastSeenAt: instant('last_seen_at').defaultNow().notNull(),
    ip: text('ip'),
    userAgent: text('user_agent'),
    ...timestamps,
  },
  (table) => [
    index('trusted_devices_user_idx').on(table.userId),
    index('trusted_devices_expires_at_idx').on(table.expiresAt),
  ],
);

export type OtpChallengeRow = typeof otpChallenges.$inferSelect;
export type TrustedDeviceRow = typeof trustedDevices.$inferSelect;

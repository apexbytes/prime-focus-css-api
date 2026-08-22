import { type AnyPgColumn, index, pgEnum, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { instant, timestamps } from '../../db/columns.js';
import { users } from '../user/user.model.js';

/**
 * Refresh tokens are opaque and stored only as hashes. Every rotation writes a
 * new row in the same `familyId`: if a token that was already rotated is
 * presented again, the whole family is revoked, because the only explanations
 * are token theft or a replay.
 */
export const sessions = pgTable(
  'sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** Shared by every rotation descended from one login. */
    familyId: uuid('family_id').notNull(),
    tokenHash: text('token_hash').notNull().unique(),
    expiresAt: instant('expires_at').notNull(),
    revokedAt: instant('revoked_at'),
    revokedReason: text('revoked_reason'),
    replacedBySessionId: uuid('replaced_by_session_id').references((): AnyPgColumn => sessions.id, {
      onDelete: 'set null',
    }),
    ip: text('ip'),
    userAgent: text('user_agent'),
    lastUsedAt: instant('last_used_at').defaultNow().notNull(),
    ...timestamps,
  },
  (table) => [
    index('sessions_user_idx').on(table.userId),
    index('sessions_family_idx').on(table.familyId),
    index('sessions_expires_at_idx').on(table.expiresAt),
  ],
);

export const passwordResetTokens = pgTable(
  'password_reset_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull().unique(),
    expiresAt: instant('expires_at').notNull(),
    usedAt: instant('used_at'),
    ip: text('ip'),
    ...timestamps,
  },
  (table) => [index('password_reset_tokens_user_idx').on(table.userId)],
);

/**
 * Every authentication decision, successful or not. Feeds lockout, and gives an
 * investigator the sequence of events behind a compromised account.
 */
export const loginOutcome = pgEnum('login_outcome', [
  'unknown_email',
  'password_failed',
  'password_ok',
  'account_locked',
  'account_suspended',
  'account_not_activated',
  'otp_failed',
  'otp_expired',
  'otp_ok',
  'device_trusted',
  /**
   * Federated sign-in, added in Phase 7. `password_unavailable` is its
   * counterpart on the password endpoint: an account activated through a
   * provider has no password to check, which is a fact about the account rather
   * than a failed guess.
   */
  'sso_ok',
  'sso_denied',
  'password_unavailable',
]);

export const loginAttempts = pgTable(
  'login_attempts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Recorded even when no user matches, to expose enumeration attempts. */
    email: text('email').notNull(),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    outcome: loginOutcome('outcome').notNull(),
    ip: text('ip'),
    userAgent: text('user_agent'),
    createdAt: instant('created_at').defaultNow().notNull(),
  },
  (table) => [
    index('login_attempts_email_created_idx').on(table.email, table.createdAt.desc()),
    index('login_attempts_user_idx').on(table.userId),
  ],
);

export type SessionRow = typeof sessions.$inferSelect;
export type PasswordResetTokenRow = typeof passwordResetTokens.$inferSelect;
export type LoginOutcome = (typeof loginOutcome.enumValues)[number];

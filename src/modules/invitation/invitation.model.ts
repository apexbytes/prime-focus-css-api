import { index, integer, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { instant, timestamps } from '../../db/columns.js';
import { roles } from '../role/role.model.js';
import { users } from '../user/user.model.js';

/**
 * There is no public sign-up. Staff accounts exist only because someone holding
 * `user:invite` created one, and the role is fixed at invitation time.
 *
 * Only the hash of the invitation token is stored, so a database leak cannot be
 * replayed into account takeovers.
 */
export const invitations = pgTable(
  'invitations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    email: text('email').notNull(),
    roleId: uuid('role_id')
      .notNull()
      .references(() => roles.id, { onDelete: 'restrict' }),
    tokenHash: text('token_hash').notNull().unique(),
    invitedByUserId: uuid('invited_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    expiresAt: instant('expires_at').notNull(),
    acceptedAt: instant('accepted_at'),
    revokedAt: instant('revoked_at'),
    lastSentAt: instant('last_sent_at').defaultNow().notNull(),
    sendCount: integer('send_count').notNull().default(1),
    ...timestamps,
  },
  (table) => [
    index('invitations_email_idx').on(table.email),
    index('invitations_user_idx').on(table.userId),
    index('invitations_expires_at_idx').on(table.expiresAt),
  ],
);

export type InvitationRow = typeof invitations.$inferSelect;
export type NewInvitation = typeof invitations.$inferInsert;

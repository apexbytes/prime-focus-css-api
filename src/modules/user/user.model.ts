import { index, integer, pgEnum, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { instant, timestamps } from '../../db/columns.js';
import { roles } from '../role/role.model.js';

/**
 * `invited` rows exist with no password: an invitation creates the user up front
 * so the roster shows pending staff and email uniqueness is enforced by the
 * table rather than by the invitation flow.
 */
export const userStatus = pgEnum('user_status', ['invited', 'active', 'suspended']);

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Always stored lower-cased; normalised at the validation boundary. */
    email: text('email').notNull().unique(),
    fullName: text('full_name').notNull(),
    phone: text('phone'),
    roleId: uuid('role_id')
      .notNull()
      // Deleting a role that still has holders must fail, not silently orphan
      // people into having no permissions.
      .references(() => roles.id, { onDelete: 'restrict' }),
    status: userStatus('status').notNull().default('invited'),
    /** Null until the invitation is accepted and a password is chosen. */
    passwordHash: text('password_hash'),
    passwordChangedAt: instant('password_changed_at'),
    lastLoginAt: instant('last_login_at'),
    failedLoginAttempts: integer('failed_login_attempts').notNull().default(0),
    lockedUntil: instant('locked_until'),
    /** Set instead of deleting: audit trails must keep resolving the actor. */
    deletedAt: instant('deleted_at'),
    ...timestamps,
  },
  (table) => [index('users_role_idx').on(table.roleId), index('users_status_idx').on(table.status)],
);

export type UserRow = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type UserStatus = (typeof userStatus.enumValues)[number];

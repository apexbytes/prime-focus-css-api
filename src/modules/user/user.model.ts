import { index, integer, pgEnum, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { instant, timestamps } from '../../db/columns.js';
import { roles } from '../role/role.model.js';

/**
 * `invited` rows exist with no password: an invitation creates the user up front
 * so the roster shows pending staff and email uniqueness is enforced by the
 * table rather than by the invitation flow.
 */
export const userStatus = pgEnum('user_status', ['invited', 'active', 'suspended']);

/**
 * Whether an agent is at their desk. Distinct from `status`, which is an
 * administrative fact about the account: a suspended agent is not coming back,
 * an `away` one is at lunch. Routing assigns to `online` agents only, unless
 * `ROUTING_ASSIGN_TO_AWAY_AGENTS` says otherwise.
 */
export const agentAvailability = pgEnum('agent_availability', ['online', 'away', 'offline']);

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
    /**
     * Routing state, added in Phase 4. `offline` by default: a newly invited
     * agent should not be handed work before they have ever signed in.
     */
    availability: agentAvailability('availability').notNull().default('offline'),
    /**
     * Open tickets this agent may hold before routing stops choosing them. Null
     * falls back to `DEFAULT_AGENT_MAX_OPEN_TICKETS`, so raising the default does
     * not mean rewriting every row.
     */
    maxOpenTickets: integer('max_open_tickets'),
    /** Set instead of deleting: audit trails must keep resolving the actor. */
    deletedAt: instant('deleted_at'),
    ...timestamps,
  },
  (table) => [index('users_role_idx').on(table.roleId), index('users_status_idx').on(table.status)],
);

export type UserRow = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type UserStatus = (typeof userStatus.enumValues)[number];
export type AgentAvailability = (typeof agentAvailability.enumValues)[number];

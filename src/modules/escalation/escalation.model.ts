import { boolean, index, integer, pgEnum, pgTable, text, unique, uuid } from 'drizzle-orm/pg-core';
import { instant, timestamps } from '../../db/columns.js';
import { products } from '../product/product.model.js';
import { slaTargetKind, ticketSlaTargets } from '../sla/sla.model.js';
import { teams } from '../team/team.model.js';
import { ticketPriority, tickets } from '../ticket/ticket.model.js';
import { users } from '../user/user.model.js';

/**
 * What an escalation does. Notifying and reassigning are separable because most
 * ladders warn a team lead well before they take the ticket off the agent.
 */
export const escalationAction = pgEnum('escalation_action', [
  'notify',
  'reassign',
  'notify_and_reassign',
]);

/**
 * A rung on the escalation ladder: when a ticket has consumed this much of its
 * SLA, do this.
 *
 * `thresholdPercent` is of the target, so 80 fires as a warning before the
 * deadline and 100 fires on the breach itself. Rules are evaluated in
 * `sortOrder` and each fires at most once per ticket per target — see the unique
 * constraint on `escalations`.
 */
export const escalationRules = pgTable(
  'escalation_rules',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    /** Null matches every product, so one ladder can cover the whole operation. */
    productId: uuid('product_id').references(() => products.id, { onDelete: 'cascade' }),
    priority: ticketPriority('priority'),
    /** Null applies to both the first-response and the resolution clock. */
    targetKind: slaTargetKind('target_kind'),
    thresholdPercent: integer('threshold_percent').notNull(),
    action: escalationAction('action').notNull(),
    notifyUserId: uuid('notify_user_id').references(() => users.id, { onDelete: 'set null' }),
    notifyTeamId: uuid('notify_team_id').references(() => teams.id, { onDelete: 'set null' }),
    reassignToUserId: uuid('reassign_to_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    reassignToTeamId: uuid('reassign_to_team_id').references(() => teams.id, {
      onDelete: 'set null',
    }),
    /** Bumps the ticket's priority one step, at most to `urgent`. */
    raisePriority: boolean('raise_priority').notNull().default(false),
    sortOrder: integer('sort_order').notNull().default(0),
    isActive: boolean('is_active').notNull().default(true),
    ...timestamps,
  },
  (table) => [
    index('escalation_rules_evaluation_idx').on(table.isActive, table.sortOrder),
    index('escalation_rules_product_idx').on(table.productId),
  ],
);

/**
 * An escalation that happened. Append-only, and the record that stops a rule
 * firing twice: the unique constraint is the idempotency guard for a scan that
 * runs every minute and will keep seeing the same overdue ticket.
 */
export const escalations = pgTable(
  'escalations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ticketId: uuid('ticket_id')
      .notNull()
      .references(() => tickets.id, { onDelete: 'cascade' }),
    /** Kept as history even if the rule is later deleted. */
    ruleId: uuid('rule_id').references(() => escalationRules.id, { onDelete: 'set null' }),
    targetId: uuid('target_id').references(() => ticketSlaTargets.id, { onDelete: 'set null' }),
    thresholdPercent: integer('threshold_percent').notNull(),
    action: escalationAction('action').notNull(),
    fromUserId: uuid('from_user_id').references(() => users.id, { onDelete: 'set null' }),
    toUserId: uuid('to_user_id').references(() => users.id, { onDelete: 'set null' }),
    /** Why it fired, in words, for the agent who finds it on their queue. */
    reason: text('reason').notNull(),
    triggeredAt: instant('triggered_at').defaultNow().notNull(),
    ...timestamps,
  },
  (table) => [
    // One firing per rule per target. `targetId` is never null in practice, so
    // NULL-distinctness does not weaken this in the path that matters.
    unique('escalations_rule_target_unique').on(table.ticketId, table.ruleId, table.targetId),
    index('escalations_ticket_idx').on(table.ticketId, table.triggeredAt.desc()),
  ],
);

export type EscalationRuleRow = typeof escalationRules.$inferSelect;
export type EscalationRow = typeof escalations.$inferSelect;
export type EscalationAction = (typeof escalationAction.enumValues)[number];

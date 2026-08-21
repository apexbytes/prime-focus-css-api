import { boolean, index, integer, pgTable, text, primaryKey, uuid } from 'drizzle-orm/pg-core';
import { instant, timestamps } from '../../db/columns.js';
import { categories } from '../category/category.model.js';
import { customerTier } from '../customer/customer.model.js';
import { products } from '../product/product.model.js';
import { teams } from '../team/team.model.js';
import { ticketChannel, ticketPriority } from '../ticket/ticket.model.js';
import { users } from '../user/user.model.js';

/**
 * Deterministic assignment rules, evaluated in `sortOrder` and first match wins.
 *
 * Every criterion is nullable and null means "any", so one row can be as broad
 * as "all wallet tickets go to the wallet team" or as narrow as "urgent
 * chargebacks from a VIP, in Shona, need a fluent specialist". Sentiment and
 * auto-categorisation would slot in as extra criteria on this same table — see
 * the AI note in §11 of the API doc; the interface is ready, the model is not
 * built.
 */
export const routingRules = pgTable(
  'routing_rules',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    productId: uuid('product_id').references(() => products.id, { onDelete: 'cascade' }),
    categoryId: uuid('category_id').references(() => categories.id, { onDelete: 'cascade' }),
    priority: ticketPriority('priority'),
    channel: ticketChannel('channel'),
    customerTier: customerTier('customer_tier'),
    /** ISO code matched against the customer's `language`. */
    language: text('language'),
    /**
     * Narrows the candidate agents to those holding this skill. A rule that
     * names a skill nobody has assigns nothing rather than assigning badly.
     */
    requiredSkill: text('required_skill'),
    assignToTeamId: uuid('assign_to_team_id').references(() => teams.id, { onDelete: 'set null' }),
    /** Lower runs first. Ties break on `createdAt` for a stable order. */
    sortOrder: integer('sort_order').notNull().default(0),
    isActive: boolean('is_active').notNull().default(true),
    ...timestamps,
  },
  (table) => [
    index('routing_rules_evaluation_idx').on(table.isActive, table.sortOrder),
    index('routing_rules_product_idx').on(table.productId),
  ],
);

/**
 * What an agent can handle, beyond which products they are granted. Free text
 * rather than an enum: the vocabulary belongs to the support operation, and a
 * new skill should not need a migration.
 */
export const agentSkills = pgTable(
  'agent_skills',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    skill: text('skill').notNull(),
    /** 1–5. Breaks ties between two agents who are equally free. */
    proficiency: integer('proficiency').notNull().default(3),
    createdAt: instant('created_at').defaultNow().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.skill] }),
    index('agent_skills_skill_idx').on(table.skill),
  ],
);

export type RoutingRuleRow = typeof routingRules.$inferSelect;
export type AgentSkillRow = typeof agentSkills.$inferSelect;

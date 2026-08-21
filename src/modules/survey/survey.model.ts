import { index, integer, pgTable, text, unique, uuid } from 'drizzle-orm/pg-core';
import { instant, timestamps } from '../../db/columns.js';
import { customers } from '../customer/customer.model.js';
import { products } from '../product/product.model.js';
import { teams } from '../team/team.model.js';
import { tickets } from '../ticket/ticket.model.js';
import { users } from '../user/user.model.js';

/**
 * One customer satisfaction survey, answered or not.
 *
 * Named for the survey rather than the response — the plan called this
 * `csat_responses` — because the row is created when the survey is *sent* and
 * most rows never get a score. Response rate is itself a metric, and a table
 * called `responses` full of unanswered rows would mislead everyone who reads
 * it afterwards.
 *
 * The agent, team and product are copied on at dispatch instead of being joined
 * through the ticket. A ticket reassigned three weeks later must not move a
 * score onto somebody who never touched it.
 */
export const csatSurveys = pgTable(
  'csat_surveys',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ticketId: uuid('ticket_id')
      .notNull()
      .references(() => tickets.id, { onDelete: 'cascade' }),
    customerId: uuid('customer_id')
      .notNull()
      .references(() => customers.id, { onDelete: 'cascade' }),
    productId: uuid('product_id')
      .notNull()
      .references(() => products.id, { onDelete: 'cascade' }),
    /** Who was on the ticket when it was resolved; null if nobody was. */
    ratedUserId: uuid('rated_user_id').references(() => users.id, { onDelete: 'set null' }),
    ratedTeamId: uuid('rated_team_id').references(() => teams.id, { onDelete: 'set null' }),
    /**
     * HMAC-SHA256 digest of the token in the email, keyed by `JWT_SECRET`, per
     * the rule that nothing presented as a bearer credential is stored in the
     * clear. A leaked database yields no usable rating links.
     */
    tokenHash: text('token_hash').notNull().unique(),
    sentAt: instant('sent_at'),
    expiresAt: instant('expires_at').notNull(),
    /** 1–5. Null until the customer answers, which most never will. */
    score: integer('score'),
    comment: text('comment'),
    respondedAt: instant('responded_at'),
    ...timestamps,
  },
  (table) => [
    // One survey per ticket: a customer asked twice about one query stops
    // answering, and a reopened-then-resolved ticket must not ask again.
    unique('csat_surveys_ticket_unique').on(table.ticketId),
    index('csat_surveys_product_idx').on(table.productId, table.respondedAt.desc()),
    index('csat_surveys_agent_idx').on(table.ratedUserId, table.respondedAt.desc()),
    // The cooldown check: has this customer been asked anything recently.
    index('csat_surveys_customer_idx').on(table.customerId, table.createdAt.desc()),
  ],
);

export type CsatSurveyRow = typeof csatSurveys.$inferSelect;
export type NewCsatSurvey = typeof csatSurveys.$inferInsert;

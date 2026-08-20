import { boolean, index, pgTable, primaryKey, text, uuid } from 'drizzle-orm/pg-core';
import { instant, timestamps } from '../../db/columns.js';
import { teams } from '../team/team.model.js';
import { users } from '../user/user.model.js';

/**
 * The Prime Focus product catalogue, and the tenancy axis of the whole system:
 * every ticket, category, SLA policy and knowledge base article is scoped to one
 * product.
 */
export const products = pgTable('products', {
  id: uuid('id').primaryKey().defaultRandom(),
  code: text('code').notNull().unique(),
  name: text('name').notNull(),
  description: text('description'),
  /**
   * Support address for this product, e.g. wallet@support.primefocus.co.zw.
   * Inbound mail is routed to a product by matching this.
   */
  supportEmail: text('support_email').unique(),
  defaultTeamId: uuid('default_team_id').references(() => teams.id, { onDelete: 'set null' }),
  isActive: boolean('is_active').notNull().default(true),
  ...timestamps,
});

/**
 * Which products an agent may work. Absence of a grant means no access: an agent
 * on the lending product cannot read wallet tickets.
 *
 * Administrators bypass this — see `product.service.accessibleProductIds`.
 */
export const userProducts = pgTable(
  'user_products',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    productId: uuid('product_id')
      .notNull()
      .references(() => products.id, { onDelete: 'cascade' }),
    grantedByUserId: uuid('granted_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    createdAt: instant('created_at').defaultNow().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.productId] }),
    index('user_products_product_idx').on(table.productId),
  ],
);

export type ProductRow = typeof products.$inferSelect;
export type NewProduct = typeof products.$inferInsert;

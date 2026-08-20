import { boolean, index, jsonb, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { timestamps } from '../../db/columns.js';
import { products } from '../product/product.model.js';
import { users } from '../user/user.model.js';

/**
 * A canned reply plus a set of field changes, applied in one action. `actions` is
 * jsonb because the shape follows the ticket fields an agent may set, and pinning
 * it to columns would mean a migration every time that list grows; the payload is
 * validated by a Zod schema on write.
 */
export const macros = pgTable(
  'macros',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    /** Null means the macro is available across every product. */
    productId: uuid('product_id').references(() => products.id, { onDelete: 'cascade' }),
    /** Reply text; supports {{customer.fullName}} and {{ticket.reference}}. */
    body: text('body'),
    actions: jsonb('actions').notNull().default({}),
    isActive: boolean('is_active').notNull().default(true),
    createdByUserId: uuid('created_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    ...timestamps,
  },
  (table) => [index('macros_product_idx').on(table.productId)],
);

export type MacroRow = typeof macros.$inferSelect;

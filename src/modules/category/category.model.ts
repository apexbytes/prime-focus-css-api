import {
  type AnyPgColumn,
  boolean,
  index,
  integer,
  pgTable,
  text,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { timestamps } from '../../db/columns.js';
import { products } from '../product/product.model.js';

/**
 * Product-scoped, one level of nesting in practice but modelled as a tree so a
 * deeper taxonomy needs no migration. Used for routing rules and reporting.
 */
export const categories = pgTable(
  'categories',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    productId: uuid('product_id')
      .notNull()
      .references(() => products.id, { onDelete: 'cascade' }),
    parentId: uuid('parent_id').references((): AnyPgColumn => categories.id, {
      onDelete: 'cascade',
    }),
    name: text('name').notNull(),
    description: text('description'),
    sortOrder: integer('sort_order').notNull().default(0),
    isActive: boolean('is_active').notNull().default(true),
    ...timestamps,
  },
  (table) => [
    unique('categories_product_name_unique').on(table.productId, table.name),
    index('categories_product_idx').on(table.productId),
    index('categories_parent_idx').on(table.parentId),
  ],
);

export type CategoryRow = typeof categories.$inferSelect;

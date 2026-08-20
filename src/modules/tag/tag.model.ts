import { index, pgTable, primaryKey, text, uuid } from 'drizzle-orm/pg-core';
import { instant, timestamps } from '../../db/columns.js';
import { tickets } from '../ticket/ticket.model.js';
import { users } from '../user/user.model.js';

/**
 * Free-form labels, deliberately not product-scoped: reporting often needs to
 * count the same theme (`fraud`, `airtime`) across every product.
 */
export const tags = pgTable('tags', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull().unique(),
  /** Hex colour for the agent console. */
  colour: text('colour'),
  createdByUserId: uuid('created_by_user_id').references(() => users.id, { onDelete: 'set null' }),
  ...timestamps,
});

export const ticketTags = pgTable(
  'ticket_tags',
  {
    ticketId: uuid('ticket_id')
      .notNull()
      .references(() => tickets.id, { onDelete: 'cascade' }),
    tagId: uuid('tag_id')
      .notNull()
      .references(() => tags.id, { onDelete: 'cascade' }),
    createdAt: instant('created_at').defaultNow().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.ticketId, table.tagId] }),
    index('ticket_tags_tag_idx').on(table.tagId),
  ],
);

export type TagRow = typeof tags.$inferSelect;

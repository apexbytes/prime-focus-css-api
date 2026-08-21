import { boolean, index, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { instant, timestamps } from '../../db/columns.js';
import { users } from '../user/user.model.js';

export const notifications = pgTable(
  'notifications',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** e.g. `ticket.assigned`, `ticket.customer_replied`. */
    type: text('type').notNull(),
    title: text('title').notNull(),
    body: text('body'),
    entityType: text('entity_type'),
    entityId: text('entity_id'),
    readAt: instant('read_at'),
    ...timestamps,
  },
  (table) => [
    // The console's unread badge: one indexed read per agent.
    index('notifications_user_unread_idx').on(table.userId, table.readAt, table.createdAt.desc()),
  ],
);

/** One row per user; defaults apply until they change something. */
export const notificationPreferences = pgTable('notification_preferences', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  emailOnAssignment: boolean('email_on_assignment').notNull().default(true),
  emailOnCustomerReply: boolean('email_on_customer_reply').notNull().default(true),
  emailOnMention: boolean('email_on_mention').notNull().default(true),
  /**
   * The daily digest. On by default: an agent who has notifications waiting and
   * never opens the console is exactly who the digest is for, and opting them in
   * is recoverable in one request.
   */
  emailDigest: boolean('email_digest').notNull().default(true),
  ...timestamps,
});

export type NotificationRow = typeof notifications.$inferSelect;
export type NotificationPreferencesRow = typeof notificationPreferences.$inferSelect;

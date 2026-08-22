import { index, jsonb, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { instant, timestamps } from '../../db/columns.js';
import { channelConversations } from '../conversation/conversation.model.js';
import { customers } from '../customer/customer.model.js';
import { products } from '../product/product.model.js';

/**
 * A live-chat visitor's session.
 *
 * This is the only credential in the system issued to somebody who is not a
 * member of staff, not a product system and not identified at all — a member of
 * the public who opened a widget. Three properties follow from that, and each is
 * a deliberate departure from how staff sessions work:
 *
 * - **It is stored as a digest**, like every other bearer value a client
 *   presents to this API. A leak of this table yields nothing replayable.
 * - **It is not a JWT.** A signed token would be unrevocable for its lifetime,
 *   and the whole reason this is a row is that the desk must be able to end one
 *   conversation — an abusive visitor, a session on a shared machine — without
 *   waiting out an expiry or rotating a signing key that every agent depends on.
 * - **It authorises exactly one conversation.** There is no scope, no role and
 *   no permission list, because there is nothing else it could ever be allowed
 *   to do. The `conversation_id` on the row *is* the authorisation.
 */
export const chatSessions = pgTable(
  'chat_sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** HMAC of the token the widget holds; the token itself is never stored. */
    tokenHash: text('token_hash').notNull().unique(),
    /**
     * The conversation's external id, which is this session's room name and the
     * value the widget sees. Generated here, so nothing a visitor supplies ever
     * becomes a room name.
     */
    conversationExternalId: text('conversation_external_id').notNull().unique(),
    conversationId: uuid('conversation_id').references(() => channelConversations.id, {
      onDelete: 'set null',
    }),
    productId: uuid('product_id')
      .notNull()
      .references(() => products.id, { onDelete: 'restrict' }),
    customerId: uuid('customer_id')
      .notNull()
      .references(() => customers.id, { onDelete: 'cascade' }),
    displayName: text('display_name').notNull(),
    /** What the visitor volunteered, if anything. Never trusted as identity. */
    contactEmail: text('contact_email'),
    expiresAt: instant('expires_at').notNull(),
    /** Set when the desk or the visitor ended it; refuses the token from then on. */
    endedAt: instant('ended_at'),
    lastSeenAt: instant('last_seen_at'),
    /** Where the widget was opened, for the agent's context panel. */
    metadata: jsonb('metadata'),
    ip: text('ip'),
    userAgent: text('user_agent'),
    ...timestamps,
  },
  (table) => [
    index('chat_sessions_conversation_idx').on(table.conversationId),
    // The retention sweep's only query: sessions whose token is long dead.
    index('chat_sessions_expiry_idx').on(table.expiresAt),
  ],
);

export type ChatSessionRow = typeof chatSessions.$inferSelect;

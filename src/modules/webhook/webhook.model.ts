import {
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { instant, timestamps } from '../../db/columns.js';
import { products } from '../product/product.model.js';
import { tickets } from '../ticket/ticket.model.js';
import { users } from '../user/user.model.js';

/**
 * An endpoint another Prime Focus system has asked to be told about.
 *
 * Product-scoped like everything else that reads ticket data: a null
 * `product_id` means every product and is what an internal analytics sink gets,
 * while an integration built for one product is confined to it. The scope is
 * enforced when the event is fanned out, not when it is delivered, so widening
 * a subscription never back-fills history it was not entitled to.
 */
export const webhookSubscriptions = pgTable(
  'webhook_subscriptions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    url: text('url').notNull(),
    /**
     * The HMAC key, in the clear.
     *
     * Every other secret in this system is stored as a digest, because we
     * *verify* those and never need the original. This one we **sign with**:
     * a digest cannot produce a signature, so there is nothing to hash. It is
     * generated here rather than supplied, returned exactly once at creation,
     * and never read back by any endpoint.
     */
    secret: text('secret').notNull(),
    /** Event names from the domain catalogue; an empty list matches nothing. */
    eventTypes: text('event_types').array().notNull(),
    /** Null means every product. */
    productId: uuid('product_id').references(() => products.id, { onDelete: 'cascade' }),
    description: text('description'),
    isActive: boolean('is_active').notNull().default(true),
    /**
     * Consecutive failed deliveries. Reset by any success, and the reason a
     * subscription pointing at a decommissioned host stops being retried
     * forever rather than filling the queue with work nobody will read.
     */
    consecutiveFailures: integer('consecutive_failures').notNull().default(0),
    lastSucceededAt: instant('last_succeeded_at'),
    lastFailedAt: instant('last_failed_at'),
    /** Set when the failure count tripped the limit; cleared by re-enabling. */
    disabledAt: instant('disabled_at'),
    createdByUserId: uuid('created_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    ...timestamps,
  },
  (table) => [
    // The fan-out's only query: active subscriptions, by product.
    index('webhook_subscriptions_active_idx').on(table.isActive, table.productId),
  ],
);

export const webhookDeliveryStatus = pgEnum('webhook_delivery_status', [
  'pending',
  'succeeded',
  'failed',
]);

/**
 * One attempt-set: an event, a subscription, and how it went.
 *
 * The row is written when the event is fanned out, before anything is sent —
 * the same reason `csat_surveys` is named for the survey rather than the
 * response. A delivery that was never attempted because the queue was down is
 * a fact an operator needs, and it is also what makes redelivery possible.
 */
export const webhookDeliveries = pgTable(
  'webhook_deliveries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    subscriptionId: uuid('subscription_id')
      .notNull()
      .references(() => webhookSubscriptions.id, { onDelete: 'cascade' }),
    /** The domain event's id, sent to the receiver as its deduplication key. */
    eventId: uuid('event_id').notNull(),
    eventType: text('event_type').notNull(),
    ticketId: uuid('ticket_id').references(() => tickets.id, { onDelete: 'set null' }),
    /** The exact bytes signed and sent, so a signature can be re-checked later. */
    payload: jsonb('payload').notNull(),
    status: webhookDeliveryStatus('status').notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    responseStatus: integer('response_status'),
    /** Truncated: a receiver that answers with an HTML error page is common. */
    responseBody: text('response_body'),
    error: text('error'),
    durationMs: integer('duration_ms'),
    lastAttemptAt: instant('last_attempt_at'),
    completedAt: instant('completed_at'),
    ...timestamps,
  },
  (table) => [
    // One delivery per event per subscription. The constraint is the idempotency
    // guard for a fan-out that runs twice — a retried job, or two instances
    // handling the same after-commit hook.
    unique('webhook_deliveries_event_unique').on(table.subscriptionId, table.eventId),
    index('webhook_deliveries_subscription_idx').on(table.subscriptionId, table.createdAt.desc()),
    index('webhook_deliveries_ticket_idx').on(table.ticketId),
    // The sweep of old delivery rows.
    index('webhook_deliveries_created_idx').on(table.createdAt),
  ],
);

export type WebhookSubscriptionRow = typeof webhookSubscriptions.$inferSelect;
export type NewWebhookSubscription = typeof webhookSubscriptions.$inferInsert;
export type WebhookDeliveryRow = typeof webhookDeliveries.$inferSelect;
export type WebhookDeliveryStatus = (typeof webhookDeliveryStatus.enumValues)[number];

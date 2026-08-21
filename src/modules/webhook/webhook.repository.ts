import { and, desc, eq, isNull, lt, or, sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import type { Executor } from '../../db/transaction.js';
import {
  webhookDeliveries,
  webhookSubscriptions,
  type NewWebhookSubscription,
  type WebhookDeliveryRow,
  type WebhookSubscriptionRow,
} from './webhook.model.js';

// -- subscriptions -----------------------------------------------------------

export async function insertSubscription(
  values: NewWebhookSubscription,
  exec: Executor = db,
): Promise<WebhookSubscriptionRow> {
  const [row] = await exec.insert(webhookSubscriptions).values(values).returning();
  if (!row) throw new Error('webhook subscription insert returned no row');
  return row;
}

export function listSubscriptions(exec: Executor = db): Promise<WebhookSubscriptionRow[]> {
  return exec.select().from(webhookSubscriptions).orderBy(desc(webhookSubscriptions.createdAt));
}

export async function findSubscriptionById(
  id: string,
  exec: Executor = db,
): Promise<WebhookSubscriptionRow | undefined> {
  const [row] = await exec
    .select()
    .from(webhookSubscriptions)
    .where(eq(webhookSubscriptions.id, id))
    .limit(1);
  return row;
}

export async function updateSubscription(
  id: string,
  patch: Partial<NewWebhookSubscription>,
  exec: Executor = db,
): Promise<WebhookSubscriptionRow | undefined> {
  const [row] = await exec
    .update(webhookSubscriptions)
    .set(patch)
    .where(eq(webhookSubscriptions.id, id))
    .returning();
  return row;
}

export async function deleteSubscription(id: string, exec: Executor = db): Promise<boolean> {
  const rows = await exec
    .delete(webhookSubscriptions)
    .where(eq(webhookSubscriptions.id, id))
    .returning({ id: webhookSubscriptions.id });
  return rows.length > 0;
}

/**
 * Subscriptions that want this event, for this product.
 *
 * The product test is `is null or = $product` — a subscription with no product
 * hears everything — and the event test uses the array containment operator so
 * Postgres does the matching rather than the application filtering a full list.
 */
export function matching(
  input: { eventType: string; productId: string },
  exec: Executor = db,
): Promise<WebhookSubscriptionRow[]> {
  return exec
    .select()
    .from(webhookSubscriptions)
    .where(
      and(
        eq(webhookSubscriptions.isActive, true),
        isNull(webhookSubscriptions.disabledAt),
        or(
          isNull(webhookSubscriptions.productId),
          eq(webhookSubscriptions.productId, input.productId),
        ),
        sql`${webhookSubscriptions.eventTypes} @> array[${input.eventType}]::text[]`,
      ),
    );
}

/** Records the outcome of an attempt against the subscription's own counters. */
export async function recordSubscriptionOutcome(
  id: string,
  outcome: { succeeded: boolean; disableAfter: number },
  exec: Executor = db,
): Promise<WebhookSubscriptionRow | undefined> {
  const [row] = await exec
    .update(webhookSubscriptions)
    .set(
      outcome.succeeded
        ? { consecutiveFailures: 0, lastSucceededAt: new Date() }
        : {
            consecutiveFailures: sql`${webhookSubscriptions.consecutiveFailures} + 1`,
            lastFailedAt: new Date(),
            // Trips in the same statement that increments the counter, so two
            // concurrent failures cannot both read "one short of the limit".
            disabledAt: sql`case when ${webhookSubscriptions.consecutiveFailures} + 1 >= ${outcome.disableAfter} then now() else ${webhookSubscriptions.disabledAt} end`,
          },
    )
    .where(eq(webhookSubscriptions.id, id))
    .returning();

  return row;
}

// -- deliveries --------------------------------------------------------------

/**
 * Queues a delivery, or returns nothing if this event was already queued for
 * this subscription. The unique constraint is the guard; `onConflictDoNothing`
 * turns a re-run of the fan-out into a no-op rather than an error.
 */
export async function insertDelivery(
  values: {
    subscriptionId: string;
    eventId: string;
    eventType: string;
    ticketId: string | null;
    payload: unknown;
  },
  exec: Executor = db,
): Promise<WebhookDeliveryRow | undefined> {
  const [row] = await exec
    .insert(webhookDeliveries)
    .values(values)
    .onConflictDoNothing({
      target: [webhookDeliveries.subscriptionId, webhookDeliveries.eventId],
    })
    .returning();

  return row;
}

export async function findDeliveryById(
  id: string,
  exec: Executor = db,
): Promise<WebhookDeliveryRow | undefined> {
  const [row] = await exec
    .select()
    .from(webhookDeliveries)
    .where(eq(webhookDeliveries.id, id))
    .limit(1);
  return row;
}

export function listDeliveries(
  filter: { subscriptionId: string; limit: number; cursor?: Date | undefined },
  exec: Executor = db,
): Promise<WebhookDeliveryRow[]> {
  return exec
    .select()
    .from(webhookDeliveries)
    .where(
      and(
        eq(webhookDeliveries.subscriptionId, filter.subscriptionId),
        filter.cursor ? lt(webhookDeliveries.createdAt, filter.cursor) : undefined,
      ),
    )
    .orderBy(desc(webhookDeliveries.createdAt))
    .limit(filter.limit);
}

export async function recordAttempt(
  id: string,
  attempt: {
    status: 'pending' | 'succeeded' | 'failed';
    responseStatus: number | null;
    responseBody: string | null;
    error: string | null;
    durationMs: number;
  },
  exec: Executor = db,
): Promise<WebhookDeliveryRow | undefined> {
  const [row] = await exec
    .update(webhookDeliveries)
    .set({
      status: attempt.status,
      attempts: sql`${webhookDeliveries.attempts} + 1`,
      responseStatus: attempt.responseStatus,
      responseBody: attempt.responseBody,
      error: attempt.error,
      durationMs: attempt.durationMs,
      lastAttemptAt: new Date(),
      completedAt: attempt.status === 'pending' ? null : new Date(),
    })
    .where(eq(webhookDeliveries.id, id))
    .returning();

  return row;
}

/** Puts a delivery back in the queue, for the redelivery endpoint. */
export async function resetDelivery(
  id: string,
  exec: Executor = db,
): Promise<WebhookDeliveryRow | undefined> {
  const [row] = await exec
    .update(webhookDeliveries)
    .set({ status: 'pending', error: null, completedAt: null })
    .where(eq(webhookDeliveries.id, id))
    .returning();
  return row;
}

/** The retention sweep's query: delivery rows older than the cutoff. */
export async function deleteDeliveriesBefore(
  cutoff: Date,
  limit: number,
  exec: Executor = db,
): Promise<number> {
  const rows = await exec
    .delete(webhookDeliveries)
    .where(
      sql`${webhookDeliveries.id} in (select id from ${webhookDeliveries} where created_at < ${cutoff} limit ${limit})`,
    )
    .returning({ id: webhookDeliveries.id });

  return rows.length;
}

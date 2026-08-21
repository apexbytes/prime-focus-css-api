import { AppError } from '../../common/errors/index.js';
import type { Actor } from '../../common/types/actor.js';
import { generateSecret } from '../../common/utils/crypto.js';
import { env, isProduction } from '../../config/index.js';
import { withTransaction } from '../../db/transaction.js';
import { createModuleLogger } from '../../lib/logger/index.js';
import { enqueue, JOB } from '../../lib/queue/index.js';
import * as auditService from '../audit/audit.service.js';
import { ALL_DOMAIN_EVENT_TYPES, type DomainEvent } from '../event/event.types.js';
import * as productService from '../product/product.service.js';
import * as repository from './webhook.repository.js';
import type { WebhookDeliveryRow, WebhookSubscriptionRow } from './webhook.model.js';
import {
  DELIVERY_HEADER,
  EVENT_HEADER,
  EVENT_ID_HEADER,
  sign,
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
} from './webhook.signature.js';
import type {
  CreatedWebhookSubscription,
  CreateSubscriptionInput,
  UpdateSubscriptionInput,
  WebhookSubscriptionView,
} from './webhook.types.js';

const log = createModuleLogger('webhook');

/** The event catalogue, for a console rendering the subscription form. */
export function eventTypes(): string[] {
  return [...ALL_DOMAIN_EVENT_TYPES];
}

// -- subscriptions -----------------------------------------------------------

export async function list(): Promise<WebhookSubscriptionView[]> {
  const rows = await repository.listSubscriptions();
  return rows.map(toView);
}

export async function get(id: string): Promise<WebhookSubscriptionView> {
  return toView(await requireSubscription(id));
}

export async function create(
  input: CreateSubscriptionInput,
  actor: Actor,
): Promise<CreatedWebhookSubscription> {
  assertDeliverableUrl(input.url);
  assertKnownEvents(input.eventTypes);
  if (input.productId) await productService.requireById(input.productId);

  // Generated, never supplied. A secret a caller chose is a secret that has
  // been in a chat message, and the whole value of the signature is that only
  // these two systems could have produced it.
  const secret = generateSecret(32);

  const row = await withTransaction(async ({ tx }) => {
    const created = await repository.insertSubscription(
      {
        name: input.name,
        url: input.url,
        secret,
        eventTypes: [...input.eventTypes],
        productId: input.productId ?? null,
        description: input.description ?? null,
        createdByUserId: actor.kind === 'user' ? actor.id : null,
      },
      tx,
    );

    await auditService.record(
      {
        action: 'webhook.subscription_created',
        entityType: 'webhook_subscription',
        entityId: created.id,
        // The secret is not in the audit row either. An audit trail readable by
        // administrators is not a place to store a live signing key.
        after: { name: created.name, url: created.url, eventTypes: created.eventTypes },
      },
      actor,
      tx,
    );

    return created;
  });

  log.info('webhook subscription created', {
    subscriptionId: row.id,
    events: row.eventTypes.length,
  });
  return { ...toView(row), secret };
}

export async function update(
  id: string,
  patch: UpdateSubscriptionInput,
  actor: Actor,
): Promise<WebhookSubscriptionView> {
  const before = await requireSubscription(id);

  if (patch.url) assertDeliverableUrl(patch.url);
  if (patch.eventTypes) assertKnownEvents(patch.eventTypes);
  if (patch.productId) await productService.requireById(patch.productId);

  const row = await withTransaction(async ({ tx }) => {
    const updated = await repository.updateSubscription(
      id,
      {
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.url !== undefined ? { url: patch.url } : {}),
        ...(patch.eventTypes !== undefined ? { eventTypes: [...patch.eventTypes] } : {}),
        ...(patch.productId !== undefined ? { productId: patch.productId } : {}),
        ...(patch.description !== undefined ? { description: patch.description } : {}),
        ...(patch.isActive !== undefined ? { isActive: patch.isActive } : {}),
        // Re-enabling clears the automatic disable and its counter, otherwise a
        // subscription that tripped the limit would trip again on its first
        // failure rather than getting a fresh run of attempts.
        ...(patch.isActive === true ? { disabledAt: null, consecutiveFailures: 0 } : {}),
      },
      tx,
    );
    if (!updated) throw AppError.notFound('Webhook subscription not found');

    await auditService.record(
      {
        action: 'webhook.subscription_updated',
        entityType: 'webhook_subscription',
        entityId: id,
        before: { url: before.url, eventTypes: before.eventTypes, isActive: before.isActive },
        after: { url: updated.url, eventTypes: updated.eventTypes, isActive: updated.isActive },
      },
      actor,
      tx,
    );

    return updated;
  });

  return toView(row);
}

export async function remove(id: string, actor: Actor): Promise<void> {
  const before = await requireSubscription(id);

  await withTransaction(async ({ tx }) => {
    await auditService.record(
      {
        action: 'webhook.subscription_deleted',
        entityType: 'webhook_subscription',
        entityId: id,
        before: { name: before.name, url: before.url },
      },
      actor,
      tx,
    );
    await repository.deleteSubscription(id, tx);
  });
}

async function requireSubscription(id: string): Promise<WebhookSubscriptionRow> {
  const row = await repository.findSubscriptionById(id);
  if (!row) throw AppError.notFound('Webhook subscription not found');
  return row;
}

function toView(row: WebhookSubscriptionRow): WebhookSubscriptionView {
  const { secret: _secret, ...rest } = row;
  return rest;
}

function assertKnownEvents(eventTypes: readonly string[]): void {
  const known = new Set<string>(ALL_DOMAIN_EVENT_TYPES);
  const unknown = eventTypes.filter((type) => !known.has(type));

  if (unknown.length > 0) {
    throw AppError.validation('Unknown event type', {
      details: unknown.map((type) => ({ field: 'eventTypes', issue: `${type} is not an event` })),
    });
  }
}

/**
 * Refuses the URLs that make an outbound webhook a liability.
 *
 * This process can reach things the administrator configuring a subscription
 * cannot: the cloud metadata endpoint, the database, an internal admin panel.
 * A subscription is therefore restricted to https on a host that is not
 * obviously internal.
 *
 * Stated plainly, because it is a real limit rather than a solved problem: this
 * checks the *literal* host, so a public name that resolves to a private
 * address still passes. Closing that needs resolution at connect time and a
 * pinned socket, which is worth doing the day this system talks to endpoints
 * chosen by anyone but its own administrators.
 */
const BLOCKED_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1', '169.254.169.254']);
const PRIVATE_HOST = /^(10\.|127\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/;

export function assertDeliverableUrl(raw: string): void {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw AppError.validation('Webhook URL is not a valid URL', {
      details: [{ field: 'url', issue: 'expected an absolute https URL' }],
    });
  }

  // http is allowed outside production so a developer can point one at a local
  // listener; production has no such excuse.
  const allowedProtocols = isProduction ? ['https:'] : ['https:', 'http:'];
  if (!allowedProtocols.includes(url.protocol)) {
    throw AppError.validation('Webhook URL must use https', {
      details: [{ field: 'url', issue: `${url.protocol} is not allowed` }],
    });
  }

  const host = url.hostname.toLowerCase();
  if (isProduction && (BLOCKED_HOSTS.has(host) || PRIVATE_HOST.test(host))) {
    throw AppError.validation('Webhook URL must point at an external host', {
      details: [{ field: 'url', issue: `${host} is internal to this network` }],
    });
  }
}

// -- fan-out -----------------------------------------------------------------

/**
 * Turns one domain event into a delivery per interested subscription.
 *
 * Called after commit, so the state the payload describes is already durable.
 * Failures are swallowed: a webhook that could fail the action that produced it
 * would let a partner's outage stop the support desk.
 *
 * The rows are written first and the jobs enqueued second. A delivery whose job
 * was lost is visible as `pending` in the delivery log and can be redelivered;
 * a job whose row was lost has nothing to send.
 */
export async function publish(event: DomainEvent): Promise<void> {
  try {
    const subscriptions = await repository.matching({
      eventType: event.type,
      productId: event.productId,
    });
    if (subscriptions.length === 0) return;

    for (const subscription of subscriptions) {
      const delivery = await repository.insertDelivery({
        subscriptionId: subscription.id,
        eventId: event.id,
        eventType: event.type,
        ticketId: event.ticket.id,
        payload: event,
      });

      // Nothing back means this event was already queued for this subscription.
      if (!delivery) continue;

      await enqueue(
        JOB.webhookDeliver,
        { deliveryId: delivery.id },
        { retryLimit: env.WEBHOOK_MAX_ATTEMPTS - 1 },
      );
    }
  } catch (error) {
    log.error('webhook fan-out failed', { eventType: event.type, err: error });
  }
}

// -- delivery ----------------------------------------------------------------

/**
 * Sends one delivery.
 *
 * **Throws on a retryable failure**, because that is how pg-boss is told to try
 * again with backoff. A delivery that has used its last attempt is marked
 * `failed` and returns normally: throwing there would retry past the limit the
 * operator configured.
 */
export async function deliver(deliveryId: string): Promise<void> {
  const delivery = await repository.findDeliveryById(deliveryId);
  if (!delivery) {
    log.warn('delivery not found', { deliveryId });
    return;
  }

  // A retried job whose previous attempt actually succeeded — the response was
  // lost, not the request. Sending again would duplicate the event.
  if (delivery.status === 'succeeded') return;

  const subscription = await repository.findSubscriptionById(delivery.subscriptionId);
  if (!subscription || !subscription.isActive || subscription.disabledAt) {
    await repository.recordAttempt(delivery.id, {
      status: 'failed',
      responseStatus: null,
      responseBody: null,
      error: 'subscription is not active',
      durationMs: 0,
    });
    return;
  }

  const body = JSON.stringify(delivery.payload);
  const timestamp = Math.floor(Date.now() / 1000);
  const startedAt = Date.now();

  /**
   * The attempt is made and its outcome captured *before* anything is recorded,
   * so the retry signal cannot be mistaken for a transport failure.
   *
   * An earlier version marked the failure inside the `try`, where the throw that
   * asks pg-boss to retry landed in its own `catch` and overwrote the receiver's
   * status code with "delivery failed" — losing the one field an operator needs
   * to tell a 500 from a 404 from a name that does not resolve.
   */
  let outcome: {
    ok: boolean;
    responseStatus: number | null;
    responseBody: string | null;
    error: string | null;
  };

  try {
    const response = await fetch(subscription.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        [SIGNATURE_HEADER]: sign({ body, timestamp, secret: subscription.secret }),
        [TIMESTAMP_HEADER]: String(timestamp),
        [EVENT_HEADER]: delivery.eventType,
        [EVENT_ID_HEADER]: delivery.eventId,
        [DELIVERY_HEADER]: delivery.id,
        'user-agent': 'prime-focus-css-webhooks/1',
      },
      body,
      // A receiver that never answers must not hold a queue worker open.
      signal: AbortSignal.timeout(env.WEBHOOK_TIMEOUT_MS),
    });

    outcome = {
      ok: response.ok,
      responseStatus: response.status,
      responseBody: await readSnippet(response),
      error: response.ok ? null : `receiver answered ${response.status}`,
    };
  } catch (error) {
    outcome = {
      ok: false,
      responseStatus: null,
      responseBody: null,
      error: error instanceof Error ? error.message : 'delivery failed',
    };
  }

  const durationMs = Date.now() - startedAt;

  if (outcome.ok) {
    await repository.recordAttempt(delivery.id, {
      status: 'succeeded',
      responseStatus: outcome.responseStatus,
      responseBody: outcome.responseBody,
      error: null,
      durationMs,
    });
    await repository.recordSubscriptionOutcome(subscription.id, {
      succeeded: true,
      disableAfter: env.WEBHOOK_DISABLE_AFTER_FAILURES,
    });
    return;
  }

  await failAttempt(delivery, subscription.id, {
    responseStatus: outcome.responseStatus,
    responseBody: outcome.responseBody,
    error: outcome.error ?? 'delivery failed',
    durationMs,
  });
}

async function failAttempt(
  delivery: WebhookDeliveryRow,
  subscriptionId: string,
  attempt: {
    responseStatus: number | null;
    responseBody: string | null;
    error: string;
    durationMs: number;
  },
): Promise<void> {
  const exhausted = delivery.attempts + 1 >= env.WEBHOOK_MAX_ATTEMPTS;

  await repository.recordAttempt(delivery.id, {
    status: exhausted ? 'failed' : 'pending',
    ...attempt,
  });

  // The subscription's own counter only moves on a genuinely dead delivery, so
  // one receiver hiccup does not count towards being switched off.
  if (exhausted) {
    const subscription = await repository.recordSubscriptionOutcome(subscriptionId, {
      succeeded: false,
      disableAfter: env.WEBHOOK_DISABLE_AFTER_FAILURES,
    });

    if (subscription?.disabledAt) {
      log.warn('webhook subscription disabled after repeated failures', {
        subscriptionId,
        consecutiveFailures: subscription.consecutiveFailures,
      });
    }
    return;
  }

  // Retryable: pg-boss re-queues with backoff. The delivery row already records
  // the attempt, so the log line is the exception rather than the record.
  throw new Error(`webhook delivery failed: ${attempt.error}`);
}

/** Enough of the response to diagnose a rejection, and no more. */
const RESPONSE_SNIPPET_BYTES = 1024;

async function readSnippet(response: Response): Promise<string | null> {
  try {
    const text = await response.text();
    return text.slice(0, RESPONSE_SNIPPET_BYTES) || null;
  } catch {
    return null;
  }
}

// -- delivery log ------------------------------------------------------------

export async function listDeliveries(
  subscriptionId: string,
  filter: { limit: number; cursor?: Date | undefined },
): Promise<WebhookDeliveryRow[]> {
  await requireSubscription(subscriptionId);
  return repository.listDeliveries({ subscriptionId, ...filter });
}

/**
 * Sends a delivery again by hand.
 *
 * The stored payload is re-sent verbatim rather than rebuilt from the ticket:
 * the receiver asked to be told what happened at the time, and a redelivery
 * that quietly described the present would be a different event wearing the
 * same id.
 */
export async function redeliver(deliveryId: string, actor: Actor): Promise<WebhookDeliveryRow> {
  const delivery = await repository.findDeliveryById(deliveryId);
  if (!delivery) throw AppError.notFound('Delivery not found');

  const reset = await repository.resetDelivery(deliveryId);
  if (!reset) throw AppError.notFound('Delivery not found');

  await auditService.recordSafely(
    {
      action: 'webhook.redelivered',
      entityType: 'webhook_delivery',
      entityId: deliveryId,
      after: { eventType: delivery.eventType, attempts: delivery.attempts },
    },
    actor,
  );

  await enqueue(JOB.webhookDeliver, { deliveryId }, { retryLimit: env.WEBHOOK_MAX_ATTEMPTS - 1 });

  return reset;
}

// -- retention ---------------------------------------------------------------

/**
 * Delivery rows past their retention period.
 *
 * Operational debris rather than a business record: what a partner system was
 * told is reconstructible from the tickets and the audit trail, and keeping
 * every payload forever would make this the largest table in the database
 * within a year.
 */
export function purgeDeliveries(cutoff: Date, limit: number): Promise<number> {
  return repository.deleteDeliveriesBefore(cutoff, limit);
}

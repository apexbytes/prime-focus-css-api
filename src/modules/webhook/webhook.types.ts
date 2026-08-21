import type { WebhookDeliveryRow, WebhookSubscriptionRow } from './webhook.model.js';

/**
 * A subscription as the API returns it — the whole row minus the signing
 * secret, which is shown once at creation and never again. There is no endpoint
 * that reveals it, and no `PATCH` that rotates it in place: rotating means
 * creating a subscription and deleting the old one, so the receiver has both
 * keys live during the changeover.
 */
export type WebhookSubscriptionView = Omit<WebhookSubscriptionRow, 'secret'>;

/** The one response that carries the secret. */
export interface CreatedWebhookSubscription extends WebhookSubscriptionView {
  /** Store it now: this is the only time it is returned. */
  secret: string;
}

export interface CreateSubscriptionInput {
  name: string;
  url: string;
  eventTypes: readonly string[];
  productId?: string | undefined;
  description?: string | undefined;
}

export interface UpdateSubscriptionInput {
  name?: string | undefined;
  url?: string | undefined;
  eventTypes?: readonly string[] | undefined;
  productId?: string | null | undefined;
  description?: string | null | undefined;
  /** Setting this true also clears an automatic disable. */
  isActive?: boolean | undefined;
}

export type { WebhookDeliveryRow, WebhookSubscriptionRow };

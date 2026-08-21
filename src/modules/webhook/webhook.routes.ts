import { Router } from 'express';
import { validate } from '../../common/middleware/index.js';
import { authenticate, requirePermission } from '../auth/auth.middleware.js';
import {
  createSubscription,
  deleteSubscription,
  getSubscription,
  listDeliveries,
  listEventTypes,
  listSubscriptions,
  redeliver,
  updateSubscription,
} from './webhook.controller.js';
import {
  createSubscriptionBody,
  listDeliveriesQuery,
  idParams,
  updateSubscriptionBody,
} from './webhook.schema.js';

/**
 * Mounted at /webhook-subscriptions.
 *
 * `webhook:manage` rather than `product:manage`: a subscription is an egress of
 * every product's ticket metadata to a host of the holder's choosing, which is
 * closer to issuing an API key than to editing a catalogue entry.
 */
export const webhookRouter: Router = Router();

webhookRouter.use(authenticate);

webhookRouter.get('/event-types', requirePermission('webhook:read'), listEventTypes);

webhookRouter.get('/', requirePermission('webhook:read'), listSubscriptions);
webhookRouter.post(
  '/',
  requirePermission('webhook:manage'),
  validate({ body: createSubscriptionBody }),
  createSubscription,
);

webhookRouter.get(
  '/:id',
  requirePermission('webhook:read'),
  validate({ params: idParams }),
  getSubscription,
);
webhookRouter.patch(
  '/:id',
  requirePermission('webhook:manage'),
  validate({ params: idParams, body: updateSubscriptionBody }),
  updateSubscription,
);
webhookRouter.delete(
  '/:id',
  requirePermission('webhook:manage'),
  validate({ params: idParams }),
  deleteSubscription,
);

webhookRouter.get(
  '/:id/deliveries',
  requirePermission('webhook:read'),
  validate({ params: idParams, query: listDeliveriesQuery }),
  listDeliveries,
);

/**
 * Mounted at /webhook-deliveries. Its own path because a delivery id is not
 * scoped to the subscription in the URL, and nesting it would invite a request
 * that names one subscription and redelivers another's event.
 */
export const webhookDeliveryRouter: Router = Router();

webhookDeliveryRouter.use(authenticate);
webhookDeliveryRouter.post(
  '/:id/redeliver',
  requirePermission('webhook:manage'),
  validate({ params: idParams }),
  redeliver,
);

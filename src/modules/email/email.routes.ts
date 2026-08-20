import { Router } from 'express';
import { validate } from '../../common/middleware/index.js';
import { authenticate, requirePermission } from '../auth/auth.middleware.js';
import {
  listUnprocessed,
  receiveDeliveryEvent,
  receiveInbound,
  reprocessInbound,
} from './email.controller.js';
import { deliveryWebhookBody, inboundIdParams, inboundWebhookBody } from './email.schema.js';

/**
 * Unauthenticated by design: the caller is a provider, not a user, and the Svix
 * signature is the credential. Mounted outside the global rate limiter, because
 * a burst of customer email must not be dropped as if it were abuse.
 */
export const emailWebhookRouter: Router = Router();

emailWebhookRouter.post('/inbound', validate({ body: inboundWebhookBody }), receiveInbound);
emailWebhookRouter.post('/events', validate({ body: deliveryWebhookBody }), receiveDeliveryEvent);

/** Operator tools for the inbound backlog. */
export const emailAdminRouter: Router = Router();

emailAdminRouter.use(authenticate);

emailAdminRouter.get('/inbound/unprocessed', requirePermission('ticket:manage'), listUnprocessed);
emailAdminRouter.post(
  '/inbound/:id/reprocess',
  requirePermission('ticket:manage'),
  validate({ params: inboundIdParams }),
  reprocessInbound,
);

import { Router } from 'express';
import { validate } from '../../common/middleware/index.js';
import { authenticate, requirePermission } from '../auth/auth.middleware.js';
import {
  listConversations,
  listUnprocessed,
  receiveWhatsapp,
  reprocessInbound,
  verifyWebhook,
} from './conversation.controller.js';
import {
  inboundIdParams,
  listConversationsQuery,
  whatsappWebhookBody,
} from './conversation.schema.js';

/**
 * Unauthenticated by design: the caller is Meta, not a user, and the
 * `X-Hub-Signature-256` over the raw body is the credential. Mounted outside the
 * global rate limiter for the reason the inbound email webhook is — a burst of
 * customer messages must not be dropped as if it were abuse — and that argument
 * is stronger here, because WhatsApp traffic arrives in bursts by nature.
 */
export const whatsappWebhookRouter: Router = Router();

// Meta's URL verification. A `GET` with the token in the query string, which is
// Meta's design, not this system's — see the note on `whatsappVerifyQuery`.
whatsappWebhookRouter.get('/', verifyWebhook);
whatsappWebhookRouter.post('/', validate({ body: whatsappWebhookBody }), receiveWhatsapp);

/**
 * The desk's view of live threads, and the operator tools for the inbound
 * backlog.
 *
 * Its own permission pair rather than `ticket:read`/`ticket:manage`, because a
 * conversation is not a ticket: the inbound backlog holds messages that are not
 * on a ticket yet, so there is nothing for product scoping to hang off, and
 * reading it is a channel-operations job rather than part of working a queue.
 * The list itself is still product-scoped — see `conversation.service.list`.
 */
export const conversationRouter: Router = Router();

conversationRouter.use(authenticate);

conversationRouter.get(
  '/',
  requirePermission('channel:read'),
  validate({ query: listConversationsQuery }),
  listConversations,
);

conversationRouter.get(
  '/inbound/unprocessed',
  requirePermission('channel:manage'),
  listUnprocessed,
);

conversationRouter.post(
  '/inbound/:id/reprocess',
  requirePermission('channel:manage'),
  validate({ params: inboundIdParams }),
  reprocessInbound,
);

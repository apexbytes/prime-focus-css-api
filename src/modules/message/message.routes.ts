import { Router } from 'express';
import { idempotency, validate } from '../../common/middleware/index.js';
import { authenticate, requirePermission } from '../auth/auth.middleware.js';
import { listMessages, postMessage } from './message.controller.js';
import { listMessagesQuery, postMessageBody, ticketIdParams } from './message.schema.js';

/**
 * Mounted at /tickets/:ticketId/messages.
 *
 * `mergeParams` is essential: without it Express does not pass the parent's
 * `:ticketId` down, and every handler here would see an empty params object.
 */
export const messageRouter: Router = Router({ mergeParams: true });

messageRouter.use(authenticate);

messageRouter.get(
  '/',
  requirePermission('ticket:read'),
  validate({ params: ticketIdParams, query: listMessagesQuery }),
  listMessages,
);

// Idempotent: a retried reply must not email the customer twice.
messageRouter.post(
  '/',
  requirePermission('ticket:reply'),
  idempotency(),
  validate({ params: ticketIdParams, body: postMessageBody }),
  postMessage,
);

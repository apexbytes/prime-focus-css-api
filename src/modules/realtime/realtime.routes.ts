import { Router } from 'express';
import { validate } from '../../common/middleware/index.js';
import { authenticate, requirePermission, requireUserActor } from '../auth/auth.middleware.js';
import { acquireLock, getLock, queueCounts, releaseLock } from './realtime.controller.js';
import { queueCountsQuery, ticketIdParams } from './realtime.schema.js';

/**
 * Mounted at /tickets/:ticketId/lock.
 *
 * `requireUserActor`, not just a permission: a lock names a person in the
 * console's banner, and a product system's API key has no person to name.
 */
export const ticketLockRouter: Router = Router({ mergeParams: true });

ticketLockRouter.use(authenticate, requireUserActor, requirePermission('ticket:read'));

ticketLockRouter.get('/', validate({ params: ticketIdParams }), getLock);
ticketLockRouter.post('/', validate({ params: ticketIdParams }), acquireLock);
ticketLockRouter.delete('/', validate({ params: ticketIdParams }), releaseLock);

/** Mounted at /realtime. */
export const realtimeRouter: Router = Router();

realtimeRouter.use(authenticate);
realtimeRouter.get(
  '/queue-counts',
  requirePermission('ticket:read'),
  validate({ query: queueCountsQuery }),
  queueCounts,
);

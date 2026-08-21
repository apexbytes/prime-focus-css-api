import { Router } from 'express';
import { validate } from '../../common/middleware/index.js';
import { authenticate, requirePermission, requireUserActor } from '../auth/auth.middleware.js';
import { getPolicy, runSweep } from './retention.controller.js';
import { sweepBody } from './retention.schema.js';

/**
 * Mounted at /retention.
 *
 * `retention:run` is held by no seeded role except `super_admin`, which holds it
 * through the wildcard. That is the point: an administrator runs the support
 * operation, but permanently destroying five-year-old customer records by hand is
 * not part of running it — the schedule does that, under a policy somebody
 * agreed to.
 *
 * `requireUserActor` as well, so an API key issued to a product system can never
 * reach it however generously it was scoped.
 */
export const retentionRouter: Router = Router();

retentionRouter.use(authenticate, requireUserActor);

// Reading the policy is `audit:read`: it is a compliance question, and the
// people who answer compliance questions are the ones who read the trail.
retentionRouter.get('/policy', requirePermission('audit:read'), getPolicy);

retentionRouter.post(
  '/sweep',
  requirePermission('retention:run'),
  validate({ body: sweepBody }),
  runSweep,
);

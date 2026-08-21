import { Router } from 'express';
import { validate } from '../../common/middleware/index.js';
import { authenticate, requirePermission } from '../auth/auth.middleware.js';
import { agents, csat, overview, refresh, sla, volume } from './report.controller.js';
import { agentReportQuery, reportQuery } from './report.schema.js';

/**
 * Mounted at /reports.
 *
 * `report:view` throughout, which tier-2 specialists hold — and they are
 * product-scoped, so every read below is scoped in the service. Rebuilding the
 * views is `report:refresh`, an administrator's button, because six concurrent
 * refreshes triggered from a dashboard would be a denial of service with a
 * permission attached.
 */
export const reportRouter: Router = Router();

reportRouter.use(authenticate);

reportRouter.get(
  '/overview',
  requirePermission('report:view'),
  validate({ query: reportQuery }),
  overview,
);
reportRouter.get('/sla', requirePermission('report:view'), validate({ query: reportQuery }), sla);
reportRouter.get(
  '/volume',
  requirePermission('report:view'),
  validate({ query: reportQuery }),
  volume,
);
reportRouter.get(
  '/agents',
  requirePermission('report:view'),
  validate({ query: agentReportQuery }),
  agents,
);
reportRouter.get('/csat', requirePermission('report:view'), validate({ query: reportQuery }), csat);

reportRouter.post('/refresh', requirePermission('report:refresh'), refresh);

import { Router } from 'express';
import { validate } from '../../common/middleware/index.js';
import { authenticate, requirePermission } from '../auth/auth.middleware.js';
import { listAuditLogs } from './audit.controller.js';
import { listAuditLogsQuery } from './audit.schema.js';

export const auditRouter: Router = Router();

auditRouter.get(
  '/',
  authenticate,
  requirePermission('audit:read'),
  validate({ query: listAuditLogsQuery }),
  listAuditLogs,
);

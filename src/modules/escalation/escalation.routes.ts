import { Router } from 'express';
import { validate } from '../../common/middleware/index.js';
import { authenticate, requirePermission } from '../auth/auth.middleware.js';
import {
  createEscalationRule,
  deleteEscalationRule,
  listEscalationRules,
  listTicketEscalations,
  runEscalations,
  updateEscalationRule,
} from './escalation.controller.js';
import {
  createEscalationRuleBody,
  ruleIdParams,
  updateEscalationRuleBody,
} from './escalation.schema.js';

export const escalationRuleRouter: Router = Router();

escalationRuleRouter.use(authenticate);

// Agents may read the ladder — knowing when a ticket will be taken off them is
// part of doing the job — but only `sla:manage` may change it.
escalationRuleRouter.get('/', requirePermission('ticket:read'), listEscalationRules);
escalationRuleRouter.post(
  '/',
  requirePermission('sla:manage'),
  validate({ body: createEscalationRuleBody }),
  createEscalationRule,
);
escalationRuleRouter.patch(
  '/:id',
  requirePermission('sla:manage'),
  validate({ params: ruleIdParams, body: updateEscalationRuleBody }),
  updateEscalationRule,
);
escalationRuleRouter.delete(
  '/:id',
  requirePermission('sla:manage'),
  validate({ params: ruleIdParams }),
  deleteEscalationRule,
);

escalationRuleRouter.post('/run', requirePermission('sla:manage'), runEscalations);

/** Mounted at /tickets/:ticketId/escalations. */
export const ticketEscalationRouter: Router = Router({ mergeParams: true });

ticketEscalationRouter.use(authenticate);
ticketEscalationRouter.get('/', requirePermission('ticket:read'), listTicketEscalations);

import { Router } from 'express';
import { validate } from '../../common/middleware/index.js';
import { authenticate, requirePermission } from '../auth/auth.middleware.js';
import {
  createRoutingRule,
  deleteRoutingRule,
  listAgentSkills,
  listRoutingRules,
  previewRouting,
  replaceAgentSkills,
  updateRoutingRule,
} from './routing.controller.js';
import {
  createRoutingRuleBody,
  replaceSkillsBody,
  ruleIdParams,
  updateRoutingRuleBody,
  userIdParams,
} from './routing.schema.js';

/**
 * Routing rules decide where customer work lands, so editing them is an
 * operational act guarded by `sla:manage` — the same permission that governs the
 * other side of the service-level configuration. Reading them needs only
 * `ticket:read`: an agent should be able to see why a ticket reached them.
 */
export const routingRuleRouter: Router = Router();

routingRuleRouter.use(authenticate);

routingRuleRouter.get('/', requirePermission('ticket:read'), listRoutingRules);
routingRuleRouter.post(
  '/',
  requirePermission('sla:manage'),
  validate({ body: createRoutingRuleBody }),
  createRoutingRule,
);
routingRuleRouter.patch(
  '/:id',
  requirePermission('sla:manage'),
  validate({ params: ruleIdParams, body: updateRoutingRuleBody }),
  updateRoutingRule,
);
routingRuleRouter.delete(
  '/:id',
  requirePermission('sla:manage'),
  validate({ params: ruleIdParams }),
  deleteRoutingRule,
);

/**
 * Mounted at /tickets/:ticketId/routing. `mergeParams` so the parent's ticket id
 * reaches the handler.
 */
export const ticketRoutingRouter: Router = Router({ mergeParams: true });

ticketRoutingRouter.use(authenticate);
ticketRoutingRouter.get('/', requirePermission('ticket:read'), previewRouting);

/**
 * Mounted at /users/:id/skills, because a skill is something a person has —
 * the table lives with routing since routing is what consumes it.
 */
export const agentSkillRouter: Router = Router({ mergeParams: true });

agentSkillRouter.use(authenticate);

agentSkillRouter.get(
  '/',
  requirePermission('user:read'),
  validate({ params: userIdParams }),
  listAgentSkills,
);
agentSkillRouter.put(
  '/',
  requirePermission('user:manage'),
  validate({ params: userIdParams, body: replaceSkillsBody }),
  replaceAgentSkills,
);

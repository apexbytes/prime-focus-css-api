import { Router } from 'express';
import { validate } from '../../common/middleware/index.js';
import { authenticate, requirePermission } from '../auth/auth.middleware.js';
import {
  createHoliday,
  createPolicy,
  deleteHoliday,
  getBusinessHours,
  getTicketSla,
  listBusinessHours,
  listPolicies,
  replaceBusinessHours,
  runScan,
  updatePolicy,
} from './sla.controller.js';
import {
  createHolidayBody,
  createPolicyBody,
  holidayParams,
  idParams,
  listPoliciesQuery,
  updateBusinessHoursBody,
  updatePolicyBody,
} from './sla.schema.js';

/**
 * Reading a policy is part of working a ticket — an agent needs to know what
 * they are being held to — so `ticket:read` suffices. Changing one is an
 * operational decision and needs `sla:manage`.
 */
export const slaPolicyRouter: Router = Router();

slaPolicyRouter.use(authenticate);

slaPolicyRouter.get(
  '/',
  requirePermission('ticket:read'),
  validate({ query: listPoliciesQuery }),
  listPolicies,
);
slaPolicyRouter.post(
  '/',
  requirePermission('sla:manage'),
  validate({ body: createPolicyBody }),
  createPolicy,
);
slaPolicyRouter.patch(
  '/:id',
  requirePermission('sla:manage'),
  validate({ params: idParams, body: updatePolicyBody }),
  updatePolicy,
);

export const businessHoursRouter: Router = Router();

businessHoursRouter.use(authenticate);

businessHoursRouter.get('/', requirePermission('ticket:read'), listBusinessHours);
businessHoursRouter.get(
  '/:id',
  requirePermission('ticket:read'),
  validate({ params: idParams }),
  getBusinessHours,
);
businessHoursRouter.put(
  '/:id',
  requirePermission('sla:manage'),
  validate({ params: idParams, body: updateBusinessHoursBody }),
  replaceBusinessHours,
);
businessHoursRouter.post(
  '/:id/holidays',
  requirePermission('sla:manage'),
  validate({ params: idParams, body: createHolidayBody }),
  createHoliday,
);
businessHoursRouter.delete(
  '/:id/holidays/:holidayId',
  requirePermission('sla:manage'),
  validate({ params: holidayParams }),
  deleteHoliday,
);

/** Mounted at /tickets/:ticketId/sla. */
export const ticketSlaRouter: Router = Router({ mergeParams: true });

ticketSlaRouter.use(authenticate);
ticketSlaRouter.get('/', requirePermission('ticket:read'), getTicketSla);

/** Operational surface: `POST /sla/scan`. */
export const slaRouter: Router = Router();

slaRouter.use(authenticate);
slaRouter.post('/scan', requirePermission('sla:manage'), runScan);

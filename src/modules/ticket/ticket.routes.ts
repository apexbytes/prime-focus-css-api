import { Router } from 'express';
import { idempotency, validate } from '../../common/middleware/index.js';
import { authenticate, requirePermission, requireUserActor } from '../auth/auth.middleware.js';
import { attachmentRouter } from '../attachment/attachment.routes.js';
import { messageRouter } from '../message/message.routes.js';
import {
  addTicketTag,
  assignTicket,
  createTicket,
  getTicket,
  listTickets,
  removeTicketTag,
  reopenTicket,
  ticketAssignments,
  unwatchTicket,
  updateTicket,
  watchTicket,
} from './ticket.controller.js';
import {
  addTagBody,
  assignTicketBody,
  createTicketBody,
  listTicketsQuery,
  reopenTicketBody,
  ticketIdParams,
  ticketTagParams,
  updateTicketBody,
} from './ticket.schema.js';

export const ticketRouter: Router = Router();

ticketRouter.use(authenticate);

ticketRouter.get(
  '/',
  requirePermission('ticket:read'),
  validate({ query: listTicketsQuery }),
  listTickets,
);

// Idempotent: a retrying mobile client or product system must not raise the same
// query twice.
ticketRouter.post(
  '/',
  requirePermission('ticket:reply'),
  idempotency(),
  validate({ body: createTicketBody }),
  createTicket,
);

ticketRouter.get(
  '/:id',
  requirePermission('ticket:read'),
  validate({ params: ticketIdParams }),
  getTicket,
);
ticketRouter.patch(
  '/:id',
  requirePermission('ticket:manage'),
  validate({ params: ticketIdParams, body: updateTicketBody }),
  updateTicket,
);

// The permission depends on whether the assignee is the caller, so the
// controller decides; the route only insists on a signed-in agent.
ticketRouter.post(
  '/:id/assign',
  validate({ params: ticketIdParams, body: assignTicketBody }),
  assignTicket,
);

ticketRouter.post(
  '/:id/reopen',
  requirePermission('ticket:manage'),
  validate({ params: ticketIdParams, body: reopenTicketBody }),
  reopenTicket,
);

ticketRouter.post(
  '/:id/tags',
  requirePermission('ticket:reply'),
  validate({ params: ticketIdParams, body: addTagBody }),
  addTicketTag,
);
ticketRouter.delete(
  '/:id/tags/:tagId',
  requirePermission('ticket:reply'),
  validate({ params: ticketTagParams }),
  removeTicketTag,
);

ticketRouter.post(
  '/:id/watch',
  requireUserActor,
  requirePermission('ticket:read'),
  validate({ params: ticketIdParams }),
  watchTicket,
);
ticketRouter.delete(
  '/:id/watch',
  requireUserActor,
  requirePermission('ticket:read'),
  validate({ params: ticketIdParams }),
  unwatchTicket,
);

ticketRouter.get(
  '/:id/assignments',
  requirePermission('ticket:read'),
  validate({ params: ticketIdParams }),
  ticketAssignments,
);

// Sub-resources. Mounted here so the ticket id stays in the path where it
// belongs, rather than being repeated as a query parameter.
ticketRouter.use('/:ticketId/messages', messageRouter);
ticketRouter.use('/:ticketId/attachments', attachmentRouter);

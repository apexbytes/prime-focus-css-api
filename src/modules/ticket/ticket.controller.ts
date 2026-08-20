import type { Request, Response } from 'express';
import { AppError } from '../../common/errors/index.js';
import { isUserActor, type Actor } from '../../common/types/actor.js';
import { sendNoContent, sendSuccess } from '../../common/utils/response.js';
import * as ticketService from './ticket.service.js';
import type {
  AddTagBody,
  AssignTicketBody,
  CreateTicketBody,
  ListTicketsQuery,
  ReopenTicketBody,
  UpdateTicketBody,
} from './ticket.schema.js';

function actorOf(req: Request): Actor {
  if (!req.actor) throw AppError.unauthenticated();
  return req.actor;
}

export async function listTickets(req: Request, res: Response): Promise<void> {
  const query = req.query as unknown as ListTicketsQuery;
  const { items, hasMore } = await ticketService.list(query, actorOf(req));

  sendSuccess(res, items, {
    pagination: {
      limit: query.limit,
      hasMore,
      nextCursor: hasMore ? (items.at(-1)?.createdAt.toISOString() ?? null) : null,
    },
  });
}

export async function getTicket(req: Request, res: Response): Promise<void> {
  sendSuccess(res, await ticketService.get(req.params.id as string, actorOf(req)));
}

export async function createTicket(req: Request, res: Response): Promise<void> {
  const ticket = await ticketService.create(req.body as CreateTicketBody, actorOf(req));
  sendSuccess(res, ticket, { status: 201 });
}

export async function updateTicket(req: Request, res: Response): Promise<void> {
  sendSuccess(
    res,
    await ticketService.updateFields(
      req.params.id as string,
      req.body as UpdateTicketBody,
      actorOf(req),
    ),
  );
}

/**
 * Taking an unowned ticket is `ticket:assign_self`; assigning to anyone else is
 * `ticket:assign`. The check is here rather than in the route because it depends
 * on the body.
 */
export async function assignTicket(req: Request, res: Response): Promise<void> {
  const actor = actorOf(req);
  const body = req.body as AssignTicketBody;

  const assigningSelf = isUserActor(actor) && body.assignedToUserId === actor.id;
  const held = new Set(actor.kind === 'system' ? [] : actor.permissions);

  if (!held.has('ticket:assign') && !(assigningSelf && held.has('ticket:assign_self'))) {
    throw AppError.forbidden(
      assigningSelf
        ? 'You do not have permission to take tickets'
        : 'You do not have permission to assign tickets to other people',
    );
  }

  sendSuccess(
    res,
    await ticketService.assign(req.params.id as string, body.assignedToUserId, body.reason, actor),
  );
}

export async function reopenTicket(req: Request, res: Response): Promise<void> {
  const { reason } = req.body as ReopenTicketBody;
  sendSuccess(res, await ticketService.reopen(req.params.id as string, reason, actorOf(req)));
}

export async function addTicketTag(req: Request, res: Response): Promise<void> {
  const { name } = req.body as AddTagBody;
  sendSuccess(res, await ticketService.addTag(req.params.id as string, name, actorOf(req)));
}

export async function removeTicketTag(req: Request, res: Response): Promise<void> {
  sendSuccess(
    res,
    await ticketService.removeTag(
      req.params.id as string,
      req.params.tagId as string,
      actorOf(req),
    ),
  );
}

export async function watchTicket(req: Request, res: Response): Promise<void> {
  await ticketService.watch(req.params.id as string, actorOf(req));
  sendNoContent(res);
}

export async function unwatchTicket(req: Request, res: Response): Promise<void> {
  await ticketService.unwatch(req.params.id as string, actorOf(req));
  sendNoContent(res);
}

export async function ticketAssignments(req: Request, res: Response): Promise<void> {
  await ticketService.requireAccessible(req.params.id as string, actorOf(req));
  sendSuccess(res, await ticketService.assignmentHistory(req.params.id as string));
}

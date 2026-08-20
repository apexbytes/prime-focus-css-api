import type { Request, Response } from 'express';
import { AppError } from '../../common/errors/index.js';
import type { Actor } from '../../common/types/actor.js';
import { sendSuccess } from '../../common/utils/response.js';
import * as messageService from './message.service.js';
import type { ListMessagesQuery, PostMessageBody } from './message.schema.js';

function actorOf(req: Request): Actor {
  if (!req.actor) throw AppError.unauthenticated();
  return req.actor;
}

export async function listMessages(req: Request, res: Response): Promise<void> {
  const query = req.query as unknown as ListMessagesQuery;
  const { items, hasMore } = await messageService.listForTicket(
    req.params.ticketId as string,
    { includeInternal: query.includeInternal, cursor: query.cursor, limit: query.limit },
    actorOf(req),
  );

  sendSuccess(res, items, {
    pagination: {
      limit: query.limit,
      hasMore,
      nextCursor: hasMore ? (items.at(-1)?.createdAt.toISOString() ?? null) : null,
    },
  });
}

export async function postMessage(req: Request, res: Response): Promise<void> {
  const body = req.body as PostMessageBody;
  const message = await messageService.postAgentMessage(
    { ticketId: req.params.ticketId as string, ...body },
    actorOf(req),
  );

  sendSuccess(res, message, { status: 201 });
}

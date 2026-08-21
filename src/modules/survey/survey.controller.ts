import type { Request, Response } from 'express';
import { AppError } from '../../common/errors/index.js';
import type { Actor } from '../../common/types/actor.js';
import { sendSuccess } from '../../common/utils/response.js';
import * as surveyService from './survey.service.js';
import type { ListSurveysQuery, RespondBody } from './survey.schema.js';

function actorOf(req: Request): Actor {
  if (!req.actor) throw AppError.unauthenticated();
  return req.actor;
}

// -- public, token-authenticated ---------------------------------------------

export async function getSurvey(req: Request, res: Response): Promise<void> {
  sendSuccess(res, await surveyService.prompt(req.params.token as string));
}

export async function respondToSurvey(req: Request, res: Response): Promise<void> {
  sendSuccess(
    res,
    await surveyService.respond(req.params.token as string, req.body as RespondBody),
  );
}

// -- staff -------------------------------------------------------------------

export async function listSurveys(req: Request, res: Response): Promise<void> {
  const query = req.query as unknown as ListSurveysQuery;
  const items = await surveyService.list(query, actorOf(req));

  sendSuccess(res, items, {
    pagination: {
      limit: query.limit,
      hasMore: items.length === query.limit,
      nextCursor:
        items.length === query.limit ? (items.at(-1)?.createdAt.toISOString() ?? null) : null,
    },
  });
}

/** The CSAT panel on one ticket: asked, answered, and what they said. */
export async function getTicketSurvey(req: Request, res: Response): Promise<void> {
  sendSuccess(res, await surveyService.forTicket(req.params.ticketId as string, actorOf(req)));
}

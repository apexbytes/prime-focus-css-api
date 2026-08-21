import type { Request, Response } from 'express';
import { AppError } from '../../common/errors/index.js';
import type { Actor } from '../../common/types/actor.js';
import { sendNoContent, sendSuccess } from '../../common/utils/response.js';
import * as escalationService from './escalation.service.js';
import type { CreateEscalationRuleBody, UpdateEscalationRuleBody } from './escalation.schema.js';

function actorOf(req: Request): Actor {
  if (!req.actor) throw AppError.unauthenticated();
  return req.actor;
}

export async function listEscalationRules(_req: Request, res: Response): Promise<void> {
  sendSuccess(res, await escalationService.listRules());
}

export async function createEscalationRule(req: Request, res: Response): Promise<void> {
  sendSuccess(
    res,
    await escalationService.createRule(req.body as CreateEscalationRuleBody, actorOf(req)),
    { status: 201 },
  );
}

export async function updateEscalationRule(req: Request, res: Response): Promise<void> {
  sendSuccess(
    res,
    await escalationService.updateRule(
      req.params.id as string,
      req.body as UpdateEscalationRuleBody,
      actorOf(req),
    ),
  );
}

export async function deleteEscalationRule(req: Request, res: Response): Promise<void> {
  await escalationService.deleteRule(req.params.id as string, actorOf(req));
  sendNoContent(res);
}

/** The ladder as it has actually been climbed for one ticket. */
export async function listTicketEscalations(req: Request, res: Response): Promise<void> {
  sendSuccess(res, await escalationService.listForTicket(req.params.ticketId as string));
}

/**
 * Runs the escalation pass now. The companion to `POST /sla/scan`, and the only
 * way to exercise the ladder when `QUEUE_DRIVER=inline`.
 */
export async function runEscalations(_req: Request, res: Response): Promise<void> {
  sendSuccess(res, await escalationService.run());
}

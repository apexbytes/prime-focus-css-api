import type { Request, Response } from 'express';
import { AppError } from '../../common/errors/index.js';
import type { Actor } from '../../common/types/actor.js';
import { sendNoContent, sendSuccess } from '../../common/utils/response.js';
import * as routingService from './routing.service.js';
import type {
  CreateRoutingRuleBody,
  ReplaceSkillsBody,
  UpdateRoutingRuleBody,
} from './routing.schema.js';

function actorOf(req: Request): Actor {
  if (!req.actor) throw AppError.unauthenticated();
  return req.actor;
}

export async function listRoutingRules(_req: Request, res: Response): Promise<void> {
  sendSuccess(res, await routingService.listRules());
}

export async function createRoutingRule(req: Request, res: Response): Promise<void> {
  sendSuccess(
    res,
    await routingService.createRule(req.body as CreateRoutingRuleBody, actorOf(req)),
    { status: 201 },
  );
}

export async function updateRoutingRule(req: Request, res: Response): Promise<void> {
  sendSuccess(
    res,
    await routingService.updateRule(
      req.params.id as string,
      req.body as UpdateRoutingRuleBody,
      actorOf(req),
    ),
  );
}

export async function deleteRoutingRule(req: Request, res: Response): Promise<void> {
  await routingService.deleteRule(req.params.id as string, actorOf(req));
  sendNoContent(res);
}

/**
 * What routing *would* do with this ticket, without doing it. The console shows
 * this next to the assignment so a supervisor can see which rule is responsible
 * before they change one.
 */
export async function previewRouting(req: Request, res: Response): Promise<void> {
  const decision = await routingService.decideFor(req.params.ticketId as string);
  if (!decision) throw AppError.notFound('Ticket not found');

  sendSuccess(res, {
    ruleId: decision.rule?.id ?? null,
    ruleName: decision.rule?.name ?? null,
    teamId: decision.teamId,
    requiredSkill: decision.requiredSkill,
  });
}

// -- agent skills, mounted under /users/:id ----------------------------------

export async function listAgentSkills(req: Request, res: Response): Promise<void> {
  sendSuccess(res, await routingService.listSkills(req.params.id as string));
}

export async function replaceAgentSkills(req: Request, res: Response): Promise<void> {
  const body = req.body as ReplaceSkillsBody;
  sendSuccess(
    res,
    await routingService.replaceSkills(req.params.id as string, body.skills, actorOf(req)),
  );
}

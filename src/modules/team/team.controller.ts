import type { Request, Response } from 'express';
import { AppError } from '../../common/errors/index.js';
import type { Actor } from '../../common/types/actor.js';
import { sendSuccess } from '../../common/utils/response.js';
import * as teamService from './team.service.js';
import type { AddMemberBody, CreateTeamBody, UpdateTeamBody } from './team.schema.js';

function actorOf(req: Request): Actor {
  if (!req.actor) throw AppError.unauthenticated();
  return req.actor;
}

export async function listTeams(_req: Request, res: Response): Promise<void> {
  sendSuccess(res, await teamService.list());
}

export async function getTeam(req: Request, res: Response): Promise<void> {
  sendSuccess(res, await teamService.get(req.params.id as string));
}

export async function createTeam(req: Request, res: Response): Promise<void> {
  const team = await teamService.create(req.body as CreateTeamBody, actorOf(req));
  sendSuccess(res, team, { status: 201 });
}

export async function updateTeam(req: Request, res: Response): Promise<void> {
  sendSuccess(
    res,
    await teamService.update(req.params.id as string, req.body as UpdateTeamBody, actorOf(req)),
  );
}

export async function addTeamMember(req: Request, res: Response): Promise<void> {
  const body = req.body as AddMemberBody;
  sendSuccess(
    res,
    await teamService.addMember(req.params.id as string, body.userId, body.isLead, actorOf(req)),
  );
}

export async function removeTeamMember(req: Request, res: Response): Promise<void> {
  sendSuccess(
    res,
    await teamService.removeMember(
      req.params.id as string,
      req.params.userId as string,
      actorOf(req),
    ),
  );
}

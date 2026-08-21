import type { Request, Response } from 'express';
import { AppError } from '../../common/errors/index.js';
import type { Actor } from '../../common/types/actor.js';
import { sendSuccess } from '../../common/utils/response.js';
import * as retentionService from './retention.service.js';
import type { SweepBody } from './retention.schema.js';

function actorOf(req: Request): Actor {
  if (!req.actor) throw AppError.unauthenticated();
  return req.actor;
}

/** The policy, the cutoffs it implies, and what is currently past them. */
export async function getPolicy(_req: Request, res: Response): Promise<void> {
  sendSuccess(res, await retentionService.describePolicy());
}

export async function runSweep(req: Request, res: Response): Promise<void> {
  const body = req.body as SweepBody;

  sendSuccess(res, await retentionService.sweep({ dryRun: body.dryRun, actor: actorOf(req) }));
}

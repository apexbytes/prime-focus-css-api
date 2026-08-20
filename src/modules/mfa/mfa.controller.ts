import type { Request, Response } from 'express';
import { AppError } from '../../common/errors/index.js';
import type { UserActor } from '../../common/types/actor.js';
import { sendNoContent, sendSuccess } from '../../common/utils/response.js';
import * as mfaService from './mfa.service.js';

function userActor(req: Request): UserActor {
  if (req.actor?.kind !== 'user') throw AppError.unauthenticated();
  return req.actor;
}

export async function listDevices(req: Request, res: Response): Promise<void> {
  sendSuccess(res, await mfaService.listDevices(userActor(req).id));
}

export async function revokeDevice(req: Request, res: Response): Promise<void> {
  const actor = userActor(req);
  await mfaService.revokeDevice(actor.id, req.params.id as string, actor);
  sendNoContent(res);
}

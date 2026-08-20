import type { Request, Response } from 'express';
import { AppError } from '../../common/errors/index.js';
import type { Actor } from '../../common/types/actor.js';
import type { PermissionCode } from '../../common/types/permissions.js';
import { sendNoContent, sendSuccess } from '../../common/utils/response.js';
import * as apiKeyService from './api-key.service.js';
import type { CreateApiKeyBody } from './api-key.schema.js';

function actorOf(req: Request): Actor {
  if (!req.actor) throw AppError.unauthenticated();
  return req.actor;
}

export async function listApiKeys(_req: Request, res: Response): Promise<void> {
  sendSuccess(res, await apiKeyService.list());
}

export async function createApiKey(req: Request, res: Response): Promise<void> {
  const body = req.body as CreateApiKeyBody;
  const created = await apiKeyService.issue(
    {
      name: body.name,
      scopes: body.scopes as PermissionCode[],
      expiresAt: body.expiresAt,
    },
    actorOf(req),
  );

  sendSuccess(res, created, {
    status: 201,
    meta: { notice: 'Store this key now — it cannot be retrieved again.' },
  });
}

export async function revokeApiKey(req: Request, res: Response): Promise<void> {
  await apiKeyService.revoke(req.params.id as string, actorOf(req));
  sendNoContent(res);
}

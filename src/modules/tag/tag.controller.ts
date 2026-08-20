import type { Request, Response } from 'express';
import { AppError } from '../../common/errors/index.js';
import type { Actor } from '../../common/types/actor.js';
import { sendNoContent, sendSuccess } from '../../common/utils/response.js';
import * as tagService from './tag.service.js';
import type { CreateTagBody } from './tag.schema.js';

function actorOf(req: Request): Actor {
  if (!req.actor) throw AppError.unauthenticated();
  return req.actor;
}

export async function listTags(_req: Request, res: Response): Promise<void> {
  sendSuccess(res, await tagService.list());
}

export async function createTag(req: Request, res: Response): Promise<void> {
  const tag = await tagService.create(req.body as CreateTagBody, actorOf(req));
  sendSuccess(res, tag, { status: 201 });
}

export async function deleteTag(req: Request, res: Response): Promise<void> {
  await tagService.remove(req.params.id as string, actorOf(req));
  sendNoContent(res);
}

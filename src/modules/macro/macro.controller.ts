import type { Request, Response } from 'express';
import { AppError } from '../../common/errors/index.js';
import type { Actor } from '../../common/types/actor.js';
import { sendNoContent, sendSuccess } from '../../common/utils/response.js';
import * as macroService from './macro.service.js';
import type { CreateMacroBody, ListMacrosQuery, UpdateMacroBody } from './macro.schema.js';

function actorOf(req: Request): Actor {
  if (!req.actor) throw AppError.unauthenticated();
  return req.actor;
}

export async function listMacros(req: Request, res: Response): Promise<void> {
  const query = req.query as unknown as ListMacrosQuery;
  sendSuccess(res, await macroService.listForProduct(query.productId, actorOf(req)));
}

export async function createMacro(req: Request, res: Response): Promise<void> {
  const body = req.body as CreateMacroBody;
  const macro = await macroService.create({ ...body, actions: body.actions }, actorOf(req));
  sendSuccess(res, macro, { status: 201 });
}

export async function updateMacro(req: Request, res: Response): Promise<void> {
  const body = req.body as UpdateMacroBody;
  sendSuccess(
    res,
    await macroService.update(
      req.params.id as string,
      { ...body, actions: body.actions },
      actorOf(req),
    ),
  );
}

export async function deleteMacro(req: Request, res: Response): Promise<void> {
  await macroService.remove(req.params.id as string, actorOf(req));
  sendNoContent(res);
}

export async function applyMacro(req: Request, res: Response): Promise<void> {
  sendSuccess(
    res,
    await macroService.apply(req.params.id as string, req.params.ticketId as string, actorOf(req)),
  );
}

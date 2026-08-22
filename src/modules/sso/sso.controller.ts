import type { Request, Response } from 'express';
import { AppError } from '../../common/errors/index.js';
import type { Actor, UserActor } from '../../common/types/actor.js';
import { sendNoContent, sendSuccess } from '../../common/utils/response.js';
import * as ssoService from './sso.service.js';
import type {
  CompleteLoginBody,
  CreateProviderBody,
  StartLoginBody,
  UpdateProviderBody,
} from './sso.schema.js';

function actorOf(req: Request): Actor {
  if (!req.actor) throw AppError.unauthenticated();
  return req.actor;
}

function userActor(req: Request): UserActor {
  if (req.actor?.kind !== 'user') throw AppError.unauthenticated();
  return req.actor;
}

// -- the sign-in flow ---------------------------------------------------------

/** Unauthenticated: the sign-in screen has to know which buttons to draw. */
export async function listSignInProviders(_req: Request, res: Response): Promise<void> {
  sendSuccess(res, await ssoService.listProvidersForSignIn());
}

export async function startLogin(req: Request, res: Response): Promise<void> {
  const body = req.body as StartLoginBody;
  sendSuccess(res, await ssoService.startLogin(body));
}

/**
 * 200 either way, like the password login: `authenticated` with tokens, or
 * `otp_required` for a provider whose own second factor is not relied on. The
 * client that handles the password flow already handles both.
 */
export async function completeLogin(req: Request, res: Response): Promise<void> {
  const body = req.body as CompleteLoginBody;
  const result = await ssoService.completeLogin(body);

  sendSuccess(res, { ...result.login, returnPath: result.returnPath, provider: result.provider });
}

// -- a user's own links -------------------------------------------------------

export async function listIdentities(req: Request, res: Response): Promise<void> {
  sendSuccess(res, await ssoService.listIdentities(userActor(req)));
}

export async function unlinkIdentity(req: Request, res: Response): Promise<void> {
  await ssoService.unlinkIdentity(userActor(req), req.params.id as string);
  sendNoContent(res);
}

// -- provider administration --------------------------------------------------

export async function listProviders(_req: Request, res: Response): Promise<void> {
  sendSuccess(res, await ssoService.listProviders());
}

export async function getProvider(req: Request, res: Response): Promise<void> {
  sendSuccess(res, await ssoService.getProvider(req.params.id as string));
}

export async function createProvider(req: Request, res: Response): Promise<void> {
  const body = req.body as CreateProviderBody;
  sendSuccess(res, await ssoService.createProvider(body, actorOf(req)), { status: 201 });
}

export async function updateProvider(req: Request, res: Response): Promise<void> {
  const body = req.body as UpdateProviderBody;
  sendSuccess(res, await ssoService.updateProvider(req.params.id as string, body, actorOf(req)));
}

export async function deleteProvider(req: Request, res: Response): Promise<void> {
  await ssoService.removeProvider(req.params.id as string, actorOf(req));
  sendNoContent(res);
}

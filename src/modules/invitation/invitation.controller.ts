import type { Request, Response } from 'express';
import { AppError } from '../../common/errors/index.js';
import type { Actor } from '../../common/types/actor.js';
import { sendNoContent, sendSuccess } from '../../common/utils/response.js';
import * as invitationService from './invitation.service.js';
import type {
  AcceptInvitationBody,
  CreateInvitationBody,
  InvitationTokenBody,
} from './invitation.schema.js';

function actorOf(req: Request): Actor {
  if (!req.actor) throw AppError.unauthenticated();
  return req.actor;
}

export async function listInvitations(_req: Request, res: Response): Promise<void> {
  sendSuccess(res, await invitationService.list());
}

export async function createInvitation(req: Request, res: Response): Promise<void> {
  const invitation = await invitationService.invite(req.body as CreateInvitationBody, actorOf(req));
  sendSuccess(res, invitation, { status: 201 });
}

export async function resendInvitation(req: Request, res: Response): Promise<void> {
  sendSuccess(res, await invitationService.resend(req.params.id as string, actorOf(req)));
}

export async function revokeInvitation(req: Request, res: Response): Promise<void> {
  await invitationService.revoke(req.params.id as string, actorOf(req));
  sendNoContent(res);
}

/** Public: renders the accept screen without consuming the invitation. */
export async function previewInvitation(req: Request, res: Response): Promise<void> {
  const { token } = req.body as InvitationTokenBody;
  sendSuccess(res, await invitationService.preview(token));
}

/** Public: sets the password, activates the account and signs the user in. */
export async function acceptInvitation(req: Request, res: Response): Promise<void> {
  const body = req.body as AcceptInvitationBody;
  const result = await invitationService.accept(body);
  sendSuccess(res, result, { status: 201 });
}

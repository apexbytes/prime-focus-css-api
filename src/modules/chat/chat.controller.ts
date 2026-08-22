import type { Request, Response } from 'express';
import { AppError } from '../../common/errors/index.js';
import { sendNoContent, sendSuccess } from '../../common/utils/response.js';
import * as chatService from './chat.service.js';
import type { ChatVisitor } from './chat.types.js';

/**
 * The REST half of the chat channel.
 *
 * Everything the websocket protocol does is also here, which is the same
 * promise the staff realtime layer makes: a widget behind a proxy that strips
 * upgrades polls instead of streaming, and is slower rather than broken. It is a
 * stronger promise here — the staff console is used by people the desk can help,
 * and a customer whose corporate network eats websockets is a customer nobody
 * hears from.
 */
export async function startSession(req: Request, res: Response): Promise<void> {
  const body = req.body as {
    productCode?: string;
    displayName?: string;
    contactEmail?: string;
    page?: string;
  };

  const session = await chatService.startSession({
    ...(body.productCode ? { productCode: body.productCode } : {}),
    ...(body.displayName ? { displayName: body.displayName } : {}),
    ...(body.contactEmail ? { contactEmail: body.contactEmail } : {}),
    ...(body.page ? { page: body.page } : {}),
    ...(req.ip ? { ip: req.ip } : {}),
    ...(req.get('user-agent') ? { userAgent: req.get('user-agent') } : {}),
  });

  sendSuccess(res, session, { status: 201 });
}

export async function sendMessage(req: Request, res: Response): Promise<void> {
  const visitor = await requireVisitor(req);
  const { body } = req.body as { body: string };

  sendSuccess(res, await chatService.postVisitorMessage(visitor, body), { status: 201 });
}

export async function transcript(req: Request, res: Response): Promise<void> {
  const visitor = await requireVisitor(req);
  sendSuccess(res, await chatService.transcript(visitor));
}

export async function endSession(req: Request, res: Response): Promise<void> {
  const visitor = await requireVisitor(req);
  await chatService.endSession(visitor);
  sendNoContent(res);
}

/**
 * Resolves the visitor from the session token.
 *
 * A bearer header, not a cookie and not a query parameter: the token is a
 * credential, and this system's rule about credentials never travelling in a URL
 * has no exception for members of the public. Deliberately *not* the
 * `authenticate` middleware — that produces an `Actor`, and a visitor must never
 * be one, because every authorisation check in the codebase takes an actor and
 * would then have to know about a kind that has no permissions at all.
 */
async function requireVisitor(req: Request): Promise<ChatVisitor> {
  const header = req.get('authorization');
  const token = header?.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : undefined;

  if (!token) throw AppError.unauthenticated();
  return chatService.authenticateVisitor(token);
}

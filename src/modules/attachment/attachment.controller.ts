import type { Request, Response } from 'express';
import { AppError } from '../../common/errors/index.js';
import type { Actor } from '../../common/types/actor.js';
import { sendNoContent, sendSuccess } from '../../common/utils/response.js';
import * as attachmentService from './attachment.service.js';
import type { ConfirmUploadBody, UploadUrlBody } from './attachment.schema.js';

function actorOf(req: Request): Actor {
  if (!req.actor) throw AppError.unauthenticated();
  return req.actor;
}

export async function listAttachments(req: Request, res: Response): Promise<void> {
  sendSuccess(
    res,
    await attachmentService.listForTicket(req.params.ticketId as string, actorOf(req)),
  );
}

export async function createUploadUrl(req: Request, res: Response): Promise<void> {
  const body = req.body as UploadUrlBody;
  const ticket = await attachmentService.createUploadTicket(
    { ticketId: req.params.ticketId as string, ...body },
    actorOf(req),
  );

  sendSuccess(res, ticket, { status: 201 });
}

export async function putContent(req: Request, res: Response): Promise<void> {
  if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
    throw AppError.badRequest('Expected the file bytes as the request body');
  }

  sendSuccess(
    res,
    await attachmentService.storeContent(req.params.id as string, req.body, actorOf(req)),
  );
}

export async function confirmUpload(req: Request, res: Response): Promise<void> {
  const { messageId } = req.body as ConfirmUploadBody;
  sendSuccess(
    res,
    await attachmentService.confirmUpload(req.params.id as string, messageId, actorOf(req)),
  );
}

export async function downloadAttachment(req: Request, res: Response): Promise<void> {
  const result = await attachmentService.download(req.params.id as string, actorOf(req));

  if (result.kind === 'redirect') {
    // 302 to a short-lived signed URL: the bytes never pass through this process.
    res.redirect(302, result.url);
    return;
  }

  res.setHeader('content-type', result.row.contentType);
  res.setHeader(
    'content-disposition',
    `attachment; filename="${result.row.filename.replace(/"/g, '')}"`,
  );
  res.setHeader('content-length', String(result.body.byteLength));
  // Attachments can carry customer documents; never let a proxy keep a copy.
  res.setHeader('cache-control', 'private, no-store');
  res.end(result.body);
}

export async function deleteAttachment(req: Request, res: Response): Promise<void> {
  await attachmentService.remove(req.params.id as string, actorOf(req));
  sendNoContent(res);
}

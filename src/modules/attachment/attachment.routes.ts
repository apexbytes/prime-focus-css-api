import express, { Router } from 'express';
import { env } from '../../config/index.js';
import { validate } from '../../common/middleware/index.js';
import { authenticate, requirePermission } from '../auth/auth.middleware.js';
import {
  confirmUpload,
  createUploadUrl,
  deleteAttachment,
  downloadAttachment,
  listAttachments,
  putContent,
  rescanAttachment,
} from './attachment.controller.js';
import {
  attachmentIdParams,
  confirmUploadBody,
  ticketIdParams,
  uploadUrlBody,
} from './attachment.schema.js';

/**
 * Mounted at /tickets/:ticketId/attachments.
 *
 * `mergeParams` is essential: without it the parent's `:ticketId` never reaches
 * these handlers.
 */
export const attachmentRouter: Router = Router({ mergeParams: true });

attachmentRouter.use(authenticate);

attachmentRouter.get(
  '/',
  requirePermission('ticket:read'),
  validate({ params: ticketIdParams }),
  listAttachments,
);
attachmentRouter.post(
  '/upload-url',
  requirePermission('ticket:reply'),
  validate({ params: ticketIdParams, body: uploadUrlBody }),
  createUploadUrl,
);

/** Mounted at /attachments — operations on one file, wherever it hangs. */
export const attachmentItemRouter: Router = Router();

attachmentItemRouter.use(authenticate);

attachmentItemRouter.put(
  '/:id/content',
  requirePermission('ticket:reply'),
  // Raw bytes, not JSON. Only used by the local-disk backend; with object
  // storage the client PUTs straight to the presigned URL.
  express.raw({ type: '*/*', limit: env.ATTACHMENT_MAX_BYTES }),
  validate({ params: attachmentIdParams }),
  putContent,
);
attachmentItemRouter.post(
  '/:id/confirm',
  requirePermission('ticket:reply'),
  validate({ params: attachmentIdParams, body: confirmUploadBody }),
  confirmUpload,
);
attachmentItemRouter.get(
  '/:id/download',
  requirePermission('ticket:read'),
  validate({ params: attachmentIdParams }),
  downloadAttachment,
);
// `ticket:manage`, not `ticket:reply`: re-running a scan is what unsticks an
// attachment the scanner never got to, which is an operational call.
attachmentItemRouter.post(
  '/:id/rescan',
  requirePermission('ticket:manage'),
  validate({ params: attachmentIdParams }),
  rescanAttachment,
);
attachmentItemRouter.delete(
  '/:id',
  requirePermission('ticket:delete'),
  validate({ params: attachmentIdParams }),
  deleteAttachment,
);

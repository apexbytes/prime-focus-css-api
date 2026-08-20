import { API_PREFIX, env } from '../../config/index.js';
import { AppError } from '../../common/errors/index.js';
import { isUserActor, type Actor } from '../../common/types/actor.js';
import { withTransaction } from '../../db/transaction.js';
import { createModuleLogger } from '../../lib/logger/index.js';
import {
  buildStorageKey,
  deleteObject,
  getObject,
  objectSize,
  presignDownload,
  presignUpload,
  putObject,
  supportsPresigning,
} from '../../lib/storage/index.js';
import * as auditService from '../audit/audit.service.js';
import * as ticketService from '../ticket/ticket.service.js';
import type { AttachmentRow } from './attachment.model.js';
import * as repository from './attachment.repository.js';

const log = createModuleLogger('attachment');

/**
 * Executables and scripts are refused outright. Phase 4 adds real scanning; until
 * then the denylist is the only thing standing between a support inbox and an
 * agent double-clicking a `.exe` a "customer" sent.
 */
const BLOCKED_EXTENSIONS = new Set([
  'exe',
  'com',
  'bat',
  'cmd',
  'msi',
  'scr',
  'pif',
  'cpl',
  'jar',
  'js',
  'jse',
  'vbs',
  'vbe',
  'wsf',
  'wsh',
  'ps1',
  'psm1',
  'sh',
  'app',
  'dmg',
  'deb',
  'rpm',
  'lnk',
  'reg',
  'dll',
]);

function assertAllowed(filename: string, sizeBytes: number): void {
  const extension = filename.split('.').pop()?.toLowerCase() ?? '';
  if (BLOCKED_EXTENSIONS.has(extension)) {
    throw AppError.badRequest(`Files of type .${extension} are not accepted`);
  }

  if (sizeBytes > env.ATTACHMENT_MAX_BYTES) {
    throw AppError.badRequest(
      `Attachments must be ${Math.floor(env.ATTACHMENT_MAX_BYTES / 1024 / 1024)}MB or smaller`,
    );
  }
}

export interface UploadTicket {
  attachmentId: string;
  uploadUrl: string;
  method: 'PUT';
  /** True when the URL points at object storage rather than back at this API. */
  direct: boolean;
  expiresAt: Date | null;
  headers: Record<string, string>;
}

/**
 * Reserves an attachment row and hands back somewhere to PUT the bytes.
 *
 * The client flow is identical whichever backend is configured: with object
 * storage it gets a presigned URL and the bytes never touch this process; on
 * local disk it gets an API URL instead. That keeps development free of a cloud
 * account without giving the client two code paths.
 */
export async function createUploadTicket(
  input: { ticketId: string; filename: string; contentType: string; sizeBytes: number },
  actor: Actor,
): Promise<UploadTicket> {
  const ticket = await ticketService.requireAccessible(input.ticketId, actor);
  assertAllowed(input.filename, input.sizeBytes);

  const storageKey = buildStorageKey(ticket.id, input.filename);

  const row = await withTransaction(async ({ tx }) => {
    const created = await repository.insert(
      {
        ticketId: ticket.id,
        filename: input.filename,
        contentType: input.contentType,
        sizeBytes: input.sizeBytes,
        storageKey,
        status: 'pending',
        uploadedByUserId: isUserActor(actor) ? actor.id : null,
      },
      tx,
    );

    await auditService.record(
      {
        action: 'attachment.reserved',
        entityType: 'ticket',
        entityId: ticket.id,
        after: { attachmentId: created.id, filename: created.filename },
      },
      actor,
      tx,
    );
    return created;
  });

  const presigned = await presignUpload(storageKey, input.contentType);

  return presigned
    ? {
        attachmentId: row.id,
        uploadUrl: presigned.url,
        method: 'PUT',
        direct: true,
        expiresAt: presigned.expiresAt,
        headers: { 'content-type': input.contentType },
      }
    : {
        attachmentId: row.id,
        uploadUrl: `${env.API_BASE_URL}${API_PREFIX}/attachments/${row.id}/content`,
        method: 'PUT',
        direct: false,
        expiresAt: null,
        headers: { 'content-type': input.contentType },
      };
}

/** Local-disk backend only: receives the bytes through the API. */
export async function storeContent(id: string, body: Buffer, actor: Actor): Promise<AttachmentRow> {
  if (supportsPresigning) {
    throw AppError.badRequest('Upload directly to the URL issued by the upload-url endpoint');
  }

  const row = await requireAccessible(id, actor);
  if (row.status !== 'pending') throw AppError.conflict('This attachment was already uploaded');

  assertAllowed(row.filename, body.byteLength);

  const checksum = await putObject(row.storageKey, body, row.contentType);
  const updated = await repository.update(id, {
    status: 'skipped',
    sizeBytes: body.byteLength,
    checksum,
    uploadedAt: new Date(),
  });

  log.info('attachment stored', { attachmentId: id, sizeBytes: body.byteLength });
  if (!updated) throw AppError.notFound('Attachment not found');
  return updated;
}

/**
 * Confirms a direct-to-storage upload by checking the object is really there.
 * Trusting the client would let it register attachments that do not exist.
 */
export async function confirmUpload(
  id: string,
  messageId: string | undefined,
  actor: Actor,
): Promise<AttachmentRow> {
  const row = await requireAccessible(id, actor);

  const size = await objectSize(row.storageKey);
  if (size === null) {
    throw AppError.badRequest('No uploaded file found for this attachment');
  }
  if (size > env.ATTACHMENT_MAX_BYTES) {
    await deleteObject(row.storageKey);
    await repository.update(id, { status: 'failed' });
    throw AppError.badRequest('The uploaded file exceeds the maximum size');
  }

  const updated = await repository.update(id, {
    // `skipped` rather than `clean`: nothing has scanned it yet, and saying
    // otherwise would be a lie the console would display.
    status: 'skipped',
    sizeBytes: size,
    uploadedAt: new Date(),
    ...(messageId ? { messageId } : {}),
  });

  if (!updated) throw AppError.notFound('Attachment not found');
  return updated;
}

export async function listForTicket(ticketId: string, actor: Actor): Promise<AttachmentRow[]> {
  await ticketService.requireAccessible(ticketId, actor);
  return repository.listForTicket(ticketId);
}

/** Either a presigned URL to redirect to, or the bytes to stream. */
export async function download(
  id: string,
  actor: Actor,
): Promise<
  { kind: 'redirect'; url: string } | { kind: 'stream'; row: AttachmentRow; body: Buffer }
> {
  const row = await requireAccessible(id, actor);

  if (row.status === 'pending') throw AppError.notFound('This attachment has not been uploaded');
  if (row.status === 'infected') {
    throw AppError.badRequest('This attachment was quarantined by the virus scanner');
  }

  const presigned = await presignDownload(row.storageKey, row.filename);
  if (presigned) return { kind: 'redirect', url: presigned.url };

  const object = await getObject(row.storageKey, row.contentType);
  return { kind: 'stream', row, body: object.body };
}

export async function remove(id: string, actor: Actor): Promise<void> {
  const row = await requireAccessible(id, actor);

  await withTransaction(async ({ tx, afterCommit }) => {
    await auditService.record(
      {
        action: 'attachment.deleted',
        entityType: 'ticket',
        entityId: row.ticketId,
        before: { attachmentId: row.id, filename: row.filename },
      },
      actor,
      tx,
    );
    await repository.remove(id, tx);

    // The object goes only after the row is committed: an orphaned object is
    // recoverable waste, an orphaned row is a broken download link.
    afterCommit(async () => {
      await deleteObject(row.storageKey).catch((error: unknown) => {
        log.error('failed to delete stored object', { storageKey: row.storageKey, err: error });
      });
    });
  });
}

/** Access to an attachment is access to its ticket. */
async function requireAccessible(id: string, actor: Actor): Promise<AttachmentRow> {
  const row = await repository.findById(id);
  if (!row) throw AppError.notFound('Attachment not found');

  await ticketService.requireAccessible(row.ticketId, actor);
  return row;
}

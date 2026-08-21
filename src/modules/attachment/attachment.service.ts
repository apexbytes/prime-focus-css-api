import { antivirusDriver, API_PREFIX, env } from '../../config/index.js';
import { AppError } from '../../common/errors/index.js';
import { isUserActor, type Actor } from '../../common/types/actor.js';
import { withTransaction } from '../../db/transaction.js';
import { scanBuffer } from '../../lib/antivirus/index.js';
import { createModuleLogger } from '../../lib/logger/index.js';
import { enqueue, JOB } from '../../lib/queue/index.js';
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
import * as notificationService from '../notification/notification.service.js';
import * as ticketService from '../ticket/ticket.service.js';
import type { AttachmentRow } from './attachment.model.js';
import * as repository from './attachment.repository.js';

const log = createModuleLogger('attachment');

/**
 * Executables and scripts are refused outright, whatever the scanner says.
 *
 * Kept now that scanning exists, because the two answer different questions: a
 * scanner asks "is this known malware", the denylist asks "is there any reason a
 * customer would send this to a support desk". A novel `.exe` passes the first
 * and fails the second.
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
    // `uploaded` means the bytes are here and nothing has looked at them yet.
    // The scan job is what moves it to `clean`, `infected` or `skipped`.
    status: 'uploaded',
    sizeBytes: body.byteLength,
    checksum,
    uploadedAt: new Date(),
  });

  log.info('attachment stored', { attachmentId: id, sizeBytes: body.byteLength });
  if (!updated) throw AppError.notFound('Attachment not found');

  await enqueue(JOB.attachmentScan, { attachmentId: id });
  // Re-read: under the inline driver the scan has already run and settled the
  // status, and answering `uploaded` would describe a row that no longer exists.
  return (await repository.findById(id)) ?? updated;
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
    // `uploaded`, not `clean`: nothing has scanned it yet, and saying otherwise
    // would be a lie the console would display. The scan job settles it.
    status: 'uploaded',
    sizeBytes: size,
    uploadedAt: new Date(),
    ...(messageId ? { messageId } : {}),
  });

  if (!updated) throw AppError.notFound('Attachment not found');

  await enqueue(JOB.attachmentScan, { attachmentId: id });
  // As above: the response must not claim a status the row has moved past.
  return (await repository.findById(id)) ?? updated;
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

  // Still `uploaded` means the scan has not answered — either it is queued, or
  // the scanner is down and pg-boss has exhausted its retries. Refusing is the
  // right way round for a fintech support desk: an agent who cannot open a
  // statement for a minute is an inconvenience, an agent who opens malware is
  // an incident. `POST /attachments/:id/rescan` is the way out.
  if (row.status === 'uploaded') {
    throw AppError.conflict('This attachment has not finished being scanned yet');
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

// -- scanning ----------------------------------------------------------------

export interface ScanOutcome {
  attachmentId: string;
  status: 'clean' | 'infected' | 'skipped';
  signature?: string;
  reason?: string;
}

/**
 * Scans one uploaded attachment and settles its status.
 *
 * Driven by the `attachment.scan` job. Deliberately **throws** when the scanner
 * itself fails, rather than recording a verdict it did not reach: a throw is
 * what makes pg-boss retry with backoff, and the alternative — writing
 * `skipped` on a connection error — would quietly mark a real outage as
 * "we chose not to scan this".
 *
 * Idempotent on anything already settled, because a retried job will see the
 * verdict the previous attempt wrote.
 */
export async function scan(attachmentId: string): Promise<ScanOutcome> {
  const row = await repository.findById(attachmentId);
  if (!row) {
    // Deleted between the enqueue and the run. Nothing to scan, nothing wrong.
    return { attachmentId, status: 'skipped', reason: 'attachment no longer exists' };
  }

  if (row.status !== 'uploaded') {
    return { attachmentId, status: 'skipped', reason: `already ${row.status}` };
  }

  if (antivirusDriver === 'none') {
    await repository.update(attachmentId, { status: 'skipped' });
    return { attachmentId, status: 'skipped', reason: 'no scanner is configured' };
  }

  const object = await getObject(row.storageKey, row.contentType);
  const result = await scanBuffer(object.body);

  if (result.verdict === 'failed') {
    // Surfaces as a job failure so it is retried and then visible, rather than
    // as a file nobody ever looked at.
    throw new Error(`virus scan failed: ${result.reason ?? 'unknown'}`);
  }

  if (result.verdict === 'infected') {
    await quarantine(row, result.signature ?? 'unknown');
    return {
      attachmentId,
      status: 'infected',
      ...(result.signature ? { signature: result.signature } : {}),
    };
  }

  await repository.update(attachmentId, {
    status: result.verdict === 'clean' ? 'clean' : 'skipped',
  });

  return {
    attachmentId,
    status: result.verdict,
    ...(result.reason ? { reason: result.reason } : {}),
  };
}

/**
 * Marks an infected file and destroys the bytes.
 *
 * The row stays: an agent looking at the ticket has to be able to see that
 * something was sent and quarantined, and — more importantly — that the
 * customer's machine is probably compromised, which is a conversation somebody
 * needs to have with them. Only the object is deleted.
 */
async function quarantine(row: AttachmentRow, signature: string): Promise<void> {
  await withTransaction(async ({ tx, afterCommit }) => {
    await repository.update(row.id, { status: 'infected' }, tx);

    await auditService.record(
      {
        action: 'attachment.quarantined',
        entityType: 'ticket',
        entityId: row.ticketId,
        after: { attachmentId: row.id, filename: row.filename, signature },
      },
      { kind: 'system', name: 'attachment.scan' },
      tx,
    );

    afterCommit(async () => {
      await deleteObject(row.storageKey).catch((error: unknown) => {
        // The row already says `infected`, so the file is unreachable through
        // the API whether or not the object survived.
        log.error('failed to delete quarantined object', {
          storageKey: row.storageKey,
          err: error,
        });
      });

      if (row.uploadedByUserId) {
        await notificationService.notifyAttachmentQuarantined(row.uploadedByUserId, {
          ticketId: row.ticketId,
          filename: row.filename,
          signature,
        });
      }
    });
  });

  log.warn('attachment quarantined', {
    attachmentId: row.id,
    ticketId: row.ticketId,
    signature,
  });
}

/**
 * Queues another scan by hand.
 *
 * Exists for the case the blocking rule above creates: the scanner was down when
 * a file arrived, its retries are spent, and the attachment is stuck at
 * `uploaded`. Without this the only remedy would be re-uploading a document the
 * customer already sent.
 */
export async function requeueScan(id: string, actor: Actor): Promise<AttachmentRow> {
  const row = await requireAccessible(id, actor);

  if (row.status === 'pending') {
    throw AppError.conflict('This attachment has not been uploaded yet');
  }
  if (row.status === 'infected') {
    throw AppError.conflict('This attachment is quarantined and its content has been destroyed');
  }

  // Back to `uploaded` so the job has something to settle, whatever it said
  // last time — a scanner with a fresh signature database may well disagree.
  const reset = await repository.update(id, { status: 'uploaded' });
  if (!reset) throw AppError.notFound('Attachment not found');

  await auditService.recordSafely(
    {
      action: 'attachment.rescan_requested',
      entityType: 'ticket',
      entityId: row.ticketId,
      before: { status: row.status },
      after: { attachmentId: id, status: 'uploaded' },
    },
    actor,
  );

  await enqueue(JOB.attachmentScan, { attachmentId: id });
  return (await repository.findById(id)) ?? reset;
}

/** Access to an attachment is access to its ticket. */
async function requireAccessible(id: string, actor: Actor): Promise<AttachmentRow> {
  const row = await repository.findById(id);
  if (!row) throw AppError.notFound('Attachment not found');

  await ticketService.requireAccessible(row.ticketId, actor);
  return row;
}

// -- retention ---------------------------------------------------------------

/**
 * Deletes every attachment on these tickets, bytes first.
 *
 * Objects before rows, which is the opposite order to `remove()` above. There
 * the priority is never leaving a broken download link; here it is never leaving
 * a customer's document in a bucket after the row that pointed at it is gone —
 * an orphaned object is exactly the thing a retention sweep exists to prevent.
 *
 * An object that will not delete is logged and its row is still removed: the
 * alternative is a sweep that stalls on one bad key and never reaches the rest.
 */
export async function purgeForTickets(ticketIds: readonly string[]): Promise<number> {
  const rows = await repository.listForTickets(ticketIds);

  for (const row of rows) {
    await deleteObject(row.storageKey).catch((error: unknown) => {
      log.error('retention could not delete stored object', {
        storageKey: row.storageKey,
        err: error,
      });
    });
  }

  return repository.removeForTickets(ticketIds);
}

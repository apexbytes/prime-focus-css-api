import { createModuleLogger } from '../../lib/logger/index.js';
import { JOB, registerHandler } from '../../lib/queue/index.js';
import * as attachmentService from './attachment.service.js';

const log = createModuleLogger('attachment:jobs');

interface ScanPayload {
  attachmentId: string;
}

/**
 * Scans an uploaded attachment.
 *
 * Enqueued the moment the bytes land, not on a schedule: an attachment sits at
 * `uploaded` — and so undownloadable — until this answers, so latency here is
 * felt by an agent waiting to open a customer's document.
 *
 * The handler lets a scanner failure propagate. That is what earns the retry
 * with backoff, and it is the difference between "the scanner said this is fine"
 * and "the scanner never answered".
 */
export function registerAttachmentJobs(): void {
  registerHandler<ScanPayload>(JOB.attachmentScan, async (payload) => {
    const outcome = await attachmentService.scan(payload.attachmentId);

    if (outcome.status === 'infected') {
      log.warn('attachment scan found malware', {
        attachmentId: outcome.attachmentId,
        signature: outcome.signature,
      });
    }
  });
}

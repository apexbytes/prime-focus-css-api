import { AppError } from '../../common/errors/index.js';
import { env } from '../../config/index.js';
import type { Executor } from '../../db/transaction.js';
import { createModuleLogger } from '../../lib/logger/index.js';
import { notificationDigestEmail, sendEmail, webUrl } from '../../lib/resend/index.js';
import type { NotificationPreferencesRow, NotificationRow } from './notification.model.js';
import * as repository from './notification.repository.js';

const log = createModuleLogger('notification');

/** Applied until the user saves a preference of their own. */
const DEFAULT_PREFERENCES = {
  emailOnAssignment: true,
  emailOnCustomerReply: true,
  emailOnMention: true,
  emailDigest: true,
};

export function list(
  userId: string,
  filter: { unreadOnly: boolean; limit: number; cursor?: string },
): Promise<NotificationRow[]> {
  return repository.list(userId, filter);
}

export function unreadCount(userId: string): Promise<number> {
  return repository.unreadCount(userId);
}

export async function markRead(userId: string, id: string): Promise<NotificationRow> {
  const row = await repository.markRead(userId, id);
  if (!row) throw AppError.notFound('Notification not found or already read');
  return row;
}

export function markAllRead(userId: string): Promise<number> {
  return repository.markAllRead(userId);
}

export async function getPreferences(userId: string) {
  const stored = await repository.preferences(userId);
  return stored ?? { userId, ...DEFAULT_PREFERENCES };
}

export function updatePreferences(
  userId: string,
  patch: Partial<NotificationPreferencesRow>,
): Promise<NotificationPreferencesRow> {
  return repository.upsertPreferences(userId, patch);
}

/**
 * In-app only, still. What Phase 5 added is the *digest* — one email a morning
 * summarising what is waiting — rather than an email per notification.
 *
 * That was the cheaper half of the trade and most of the value: an agent who
 * lives in the console does not want six emails a day, and an agent who does not
 * open it needs one. Per-event email fan-out remains a queue job away, which is
 * what the `emailOn*` columns are still for.
 */
async function create(
  input: {
    userId: string;
    type: string;
    title: string;
    body?: string | undefined;
    entityType?: string | undefined;
    entityId?: string | undefined;
  },
  exec?: Executor,
): Promise<void> {
  try {
    await repository.insert(
      {
        userId: input.userId,
        type: input.type,
        title: input.title,
        body: input.body ?? null,
        entityType: input.entityType ?? null,
        entityId: input.entityId ?? null,
      },
      exec,
    );
  } catch (error) {
    // A failed notification must never fail the action that triggered it.
    log.error('failed to create notification', { type: input.type, err: error });
  }
}

export function notifyAssignment(
  userId: string,
  ticket: { id: string; reference: string; subject: string },
  exec?: Executor,
): Promise<void> {
  return create(
    {
      userId,
      type: 'ticket.assigned',
      title: `${ticket.reference} assigned to you`,
      body: ticket.subject,
      entityType: 'ticket',
      entityId: ticket.id,
    },
    exec,
  );
}

export function notifyCustomerReply(
  userId: string,
  ticket: { id: string; reference: string; subject: string },
  exec?: Executor,
): Promise<void> {
  return create(
    {
      userId,
      type: 'ticket.customer_replied',
      title: `${ticket.reference} — customer replied`,
      body: ticket.subject,
      entityType: 'ticket',
      entityId: ticket.id,
    },
    exec,
  );
}

/**
 * Tells the owner their clock ran out. Deliberately blunt in the title: this
 * lands in a list of notifications and has to be legible at a glance.
 */
export function notifySlaBreach(
  userId: string,
  ticket: { id: string; reference: string; subject: string; kind: string },
  exec?: Executor,
): Promise<void> {
  const clock = ticket.kind === 'first_response' ? 'first response' : 'resolution';

  return create(
    {
      userId,
      type: 'sla.breached',
      title: `${ticket.reference} — ${clock} SLA breached`,
      body: ticket.subject,
      entityType: 'ticket',
      entityId: ticket.id,
    },
    exec,
  );
}

/** Sent to whoever a rung of the escalation ladder names. */
export function notifyEscalation(
  userId: string,
  ticket: { id: string; reference: string; subject: string },
  reason: string,
  exec?: Executor,
): Promise<void> {
  return create(
    {
      userId,
      type: 'ticket.escalated',
      title: `${ticket.reference} escalated`,
      body: reason,
      entityType: 'ticket',
      entityId: ticket.id,
    },
    exec,
  );
}

/**
 * Tells whoever uploaded a file that it was malware and is gone.
 *
 * The uploader rather than the assignee: usually an agent who forwarded
 * something a customer sent them, and the thing they need to know is that the
 * customer's machine is probably compromised.
 */
export function notifyAttachmentQuarantined(
  userId: string,
  input: { ticketId: string; filename: string; signature: string },
  exec?: Executor,
): Promise<void> {
  return create(
    {
      userId,
      type: 'attachment.quarantined',
      title: `${input.filename} was quarantined`,
      body: `The virus scanner reported ${input.signature}. The file has been deleted.`,
      entityType: 'ticket',
      entityId: input.ticketId,
    },
    exec,
  );
}

export function notifyMention(
  userId: string,
  ticket: { id: string; reference: string },
  mentionedBy: string,
  exec?: Executor,
): Promise<void> {
  return create(
    {
      userId,
      type: 'ticket.mentioned',
      title: `${mentionedBy} mentioned you on ${ticket.reference}`,
      entityType: 'ticket',
      entityId: ticket.id,
    },
    exec,
  );
}

// -- the daily digest --------------------------------------------------------

export interface DigestResult {
  candidates: number;
  sent: number;
  failed: number;
}

/** Breaching tickets listed per agent before the list stops being actionable. */
const DIGEST_TICKET_LIMIT = 5;

/**
 * Sends each agent one email about what is waiting for them.
 *
 * Runs before the desk opens, so it is read on arrival rather than competing
 * with the queue it is describing. Agents with nothing waiting are not emailed
 * at all — a daily "you have nothing" is how a digest gets filtered away, taking
 * the useful ones with it.
 *
 * One failure does not stop the rest: a bad address on one account must not cost
 * everyone else their morning summary.
 */
export async function sendDailyDigest(): Promise<DigestResult> {
  if (!env.NOTIFICATION_DIGEST_ENABLED) return { candidates: 0, sent: 0, failed: 0 };

  const candidates = await repository.digestCandidates();
  if (candidates.length === 0) return { candidates: 0, sent: 0, failed: 0 };

  const breaching = await repository.breachingForUsers(candidates.map((row) => row.userId));
  const byUser = new Map<string, { reference: string; subject: string }[]>();
  for (const ticket of breaching) {
    const list = byUser.get(ticket.userId) ?? [];
    if (list.length < DIGEST_TICKET_LIMIT) {
      list.push({ reference: ticket.reference, subject: ticket.subject });
    }
    byUser.set(ticket.userId, list);
  }

  let sent = 0;
  let failed = 0;

  for (const candidate of candidates) {
    try {
      const rendered = notificationDigestEmail({
        fullName: candidate.fullName,
        unreadNotifications: candidate.unreadNotifications,
        assignedOpen: candidate.assignedOpen,
        breaching: byUser.get(candidate.userId) ?? [],
        consoleUrl: webUrl('/tickets', { assigned: 'me' }),
      });

      const result = await sendEmail({
        ...rendered,
        to: candidate.email,
        kind: 'notification_digest',
      });

      if (result.delivered) sent += 1;
      else failed += 1;
    } catch (error) {
      failed += 1;
      log.error('digest could not be sent', { userId: candidate.userId, err: error });
    }
  }

  log.info('notification digest sent', { candidates: candidates.length, sent, failed });
  return { candidates: candidates.length, sent, failed };
}

import { AppError } from '../../common/errors/index.js';
import type { Executor } from '../../db/transaction.js';
import { createModuleLogger } from '../../lib/logger/index.js';
import type { NotificationPreferencesRow, NotificationRow } from './notification.model.js';
import * as repository from './notification.repository.js';

const log = createModuleLogger('notification');

/** Applied until the user saves a preference of their own. */
const DEFAULT_PREFERENCES = {
  emailOnAssignment: true,
  emailOnCustomerReply: true,
  emailOnMention: true,
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
 * In-app notifications only for now. Phase 4 adds the email fan-out behind the
 * queue, which is why the preference columns already exist — a notification that
 * has to be emailed synchronously would slow down the request that caused it.
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

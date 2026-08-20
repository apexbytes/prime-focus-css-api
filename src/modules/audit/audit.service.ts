import { getContext } from '../../common/context/request-context.js';
import { describeActor, type Actor } from '../../common/types/actor.js';
import type { Executor } from '../../db/transaction.js';
import { createModuleLogger } from '../../lib/logger/index.js';
import type { AuditLogRow } from './audit.model.js';
import * as repository from './audit.repository.js';
import type { AuditEntry, AuditLogFilter } from './audit.types.js';

const log = createModuleLogger('audit');

/**
 * Writes one audit row. Pass the surrounding transaction so the trail commits
 * with the change it describes — an audit row that survives a rolled-back change
 * (or vice versa) is worse than none.
 *
 * Actor, IP and request id come from the ambient request context, so callers do
 * not thread the request through every service signature.
 */
export async function record(
  entry: AuditEntry,
  actor: Actor | undefined,
  exec?: Executor,
): Promise<void> {
  const context = getContext();

  await repository.insert(
    {
      actorType: entry.actorType ?? actor?.kind ?? 'system',
      actorId: entry.actorId ?? (actor && actor.kind !== 'system' ? actor.id : null),
      actorLabel: entry.actorLabel ?? (actor ? describeActor(actor) : null),
      action: entry.action,
      entityType: entry.entityType,
      entityId: entry.entityId ?? null,
      before: entry.before ?? null,
      after: entry.after ?? null,
      ip: context?.ip ?? null,
      userAgent: context?.userAgent ?? null,
      requestId: context?.requestId ?? null,
    },
    exec,
  );
}

/**
 * Records an entry without letting a logging failure break the operation it is
 * describing. Only for effects outside the main transaction (e.g. a failed login
 * attempt, where there is nothing to roll back).
 */
export async function recordSafely(entry: AuditEntry, actor?: Actor): Promise<void> {
  try {
    await record(entry, actor);
  } catch (error) {
    log.error('failed to write audit entry', { action: entry.action, err: error });
  }
}

export function list(filter: AuditLogFilter): Promise<AuditLogRow[]> {
  return repository.list(filter);
}

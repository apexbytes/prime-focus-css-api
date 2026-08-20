import { AppError } from '../../common/errors/index.js';
import { isUserActor, type Actor } from '../../common/types/actor.js';
import type { Executor } from '../../db/transaction.js';
import { withTransaction } from '../../db/transaction.js';
import * as auditService from '../audit/audit.service.js';
import type { TagRow } from './tag.model.js';
import * as repository from './tag.repository.js';

/** Tag names are compared case-insensitively so `Fraud` and `fraud` are one tag. */
function normalise(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, '-');
}

export function list(): Promise<TagRow[]> {
  return repository.list();
}

export function forTicket(ticketId: string, exec?: Executor): Promise<TagRow[]> {
  return repository.forTicket(ticketId, exec);
}

export function forTickets(ticketIds: string[], exec?: Executor): Promise<Map<string, string[]>> {
  return repository.forTickets(ticketIds, exec);
}

export async function create(
  input: { name: string; colour?: string | undefined },
  actor: Actor,
): Promise<TagRow> {
  const name = normalise(input.name);
  const existing = await repository.findByName(name);
  if (existing) throw AppError.conflict('A tag with this name already exists');

  return withTransaction(async ({ tx }) => {
    const tag = await repository.insert(
      {
        name,
        colour: input.colour ?? null,
        createdByUserId: isUserActor(actor) ? actor.id : null,
      },
      tx,
    );

    await auditService.record(
      { action: 'tag.created', entityType: 'tag', entityId: tag.id, after: tag },
      actor,
      tx,
    );
    return tag;
  });
}

/**
 * Finds a tag by name or creates it. Agents tag as they work, so requiring a
 * separate create step first would just mean fewer tags being used.
 */
export async function findOrCreate(name: string, actor: Actor, exec: Executor): Promise<TagRow> {
  const normalised = normalise(name);
  const existing = await repository.findByName(normalised, exec);
  if (existing) return existing;

  return repository.insert(
    { name: normalised, createdByUserId: isUserActor(actor) ? actor.id : null },
    exec,
  );
}

export async function remove(id: string, actor: Actor): Promise<void> {
  const tag = await repository.findById(id);
  if (!tag) throw AppError.notFound('Tag not found');

  await withTransaction(async ({ tx }) => {
    await auditService.record(
      { action: 'tag.deleted', entityType: 'tag', entityId: id, before: tag },
      actor,
      tx,
    );
    // ticket_tags cascades: removing a tag unlabels its tickets rather than
    // leaving dangling rows.
    await repository.remove(id, tx);
  });
}

export function attach(ticketId: string, tagId: string, exec?: Executor): Promise<void> {
  return repository.attach(ticketId, tagId, exec);
}

export function detach(ticketId: string, tagId: string, exec?: Executor): Promise<boolean> {
  return repository.detach(ticketId, tagId, exec);
}

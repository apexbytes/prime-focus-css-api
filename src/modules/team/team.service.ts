import { AppError } from '../../common/errors/index.js';
import type { Actor } from '../../common/types/actor.js';
import { withTransaction } from '../../db/transaction.js';
import * as auditService from '../audit/audit.service.js';
import * as userService from '../user/user.service.js';
import * as repository from './team.repository.js';
import type { TeamRow, TeamWithMembers } from './team.types.js';

export function list(): Promise<TeamRow[]> {
  return repository.list();
}

export async function get(id: string): Promise<TeamWithMembers> {
  const team = await repository.findById(id);
  if (!team) throw AppError.notFound('Team not found');

  return { ...team, members: await repository.members(id) };
}

export async function create(
  input: { name: string; description?: string | undefined },
  actor: Actor,
): Promise<TeamWithMembers> {
  const team = await withTransaction(async ({ tx }) => {
    const row = await repository.insert(
      { name: input.name, description: input.description ?? null },
      tx,
    );

    await auditService.record(
      { action: 'team.created', entityType: 'team', entityId: row.id, after: row },
      actor,
      tx,
    );
    return row;
  });

  return { ...team, members: [] };
}

export async function update(
  id: string,
  patch: {
    name?: string | undefined;
    description?: string | undefined;
    isActive?: boolean | undefined;
  },
  actor: Actor,
): Promise<TeamWithMembers> {
  const before = await repository.findById(id);
  if (!before) throw AppError.notFound('Team not found');

  await withTransaction(async ({ tx }) => {
    const row = await repository.update(
      id,
      {
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.description !== undefined ? { description: patch.description } : {}),
        ...(patch.isActive !== undefined ? { isActive: patch.isActive } : {}),
      },
      tx,
    );
    if (!row) throw AppError.notFound('Team not found');

    await auditService.record(
      { action: 'team.updated', entityType: 'team', entityId: id, before, after: row },
      actor,
      tx,
    );
  });

  return get(id);
}

export async function addMember(
  teamId: string,
  userId: string,
  isLead: boolean,
  actor: Actor,
): Promise<TeamWithMembers> {
  const team = await repository.findById(teamId);
  if (!team) throw AppError.notFound('Team not found');

  // Fails loudly rather than inserting a row pointing at nobody.
  const user = await userService.requireById(userId);

  await withTransaction(async ({ tx }) => {
    await repository.addMember(teamId, userId, isLead, tx);
    await auditService.record(
      {
        action: 'team.member_added',
        entityType: 'team',
        entityId: teamId,
        after: { userId, email: user.email, isLead },
      },
      actor,
      tx,
    );
  });

  return get(teamId);
}

export async function removeMember(
  teamId: string,
  userId: string,
  actor: Actor,
): Promise<TeamWithMembers> {
  const team = await repository.findById(teamId);
  if (!team) throw AppError.notFound('Team not found');

  await withTransaction(async ({ tx }) => {
    const removed = await repository.removeMember(teamId, userId, tx);
    if (!removed) throw AppError.notFound('That user is not a member of this team');

    await auditService.record(
      {
        action: 'team.member_removed',
        entityType: 'team',
        entityId: teamId,
        before: { userId },
      },
      actor,
      tx,
    );
  });

  return get(teamId);
}

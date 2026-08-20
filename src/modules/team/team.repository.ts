import { and, asc, eq } from 'drizzle-orm';
import { db } from '../../db/client.js';
import type { Executor } from '../../db/transaction.js';
import { users } from '../user/user.model.js';
import { teamMembers, teams, type TeamRow } from './team.model.js';
import type { TeamMemberSummary } from './team.types.js';

export function list(exec: Executor = db): Promise<TeamRow[]> {
  return exec.select().from(teams).orderBy(asc(teams.name));
}

export async function findById(id: string, exec: Executor = db): Promise<TeamRow | undefined> {
  const [row] = await exec.select().from(teams).where(eq(teams.id, id)).limit(1);
  return row;
}

export async function insert(
  values: typeof teams.$inferInsert,
  exec: Executor = db,
): Promise<TeamRow> {
  const [row] = await exec.insert(teams).values(values).returning();
  if (!row) throw new Error('team insert returned no row');
  return row;
}

export async function update(
  id: string,
  patch: Partial<TeamRow>,
  exec: Executor = db,
): Promise<TeamRow | undefined> {
  const [row] = await exec.update(teams).set(patch).where(eq(teams.id, id)).returning();
  return row;
}

export function members(teamId: string, exec: Executor = db): Promise<TeamMemberSummary[]> {
  return exec
    .select({
      userId: users.id,
      fullName: users.fullName,
      email: users.email,
      isLead: teamMembers.isLead,
    })
    .from(teamMembers)
    .innerJoin(users, eq(users.id, teamMembers.userId))
    .where(eq(teamMembers.teamId, teamId))
    .orderBy(asc(users.fullName));
}

export async function addMember(
  teamId: string,
  userId: string,
  isLead: boolean,
  exec: Executor = db,
): Promise<void> {
  await exec
    .insert(teamMembers)
    .values({ teamId, userId, isLead })
    // Re-adding an existing member updates their lead flag rather than failing.
    .onConflictDoUpdate({ target: [teamMembers.teamId, teamMembers.userId], set: { isLead } });
}

export async function removeMember(
  teamId: string,
  userId: string,
  exec: Executor = db,
): Promise<boolean> {
  const rows = await exec
    .delete(teamMembers)
    .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, userId)))
    .returning({ userId: teamMembers.userId });

  return rows.length > 0;
}

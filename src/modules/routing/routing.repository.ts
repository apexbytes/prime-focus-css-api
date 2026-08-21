import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import type { Executor } from '../../db/transaction.js';
import { userProducts } from '../product/product.model.js';
import { users } from '../user/user.model.js';
import {
  agentSkills,
  routingRules,
  type AgentSkillRow,
  type RoutingRuleRow,
} from './routing.model.js';
import type { RoutingCandidate } from './routing.scoring.js';

// -- rules -------------------------------------------------------------------

/**
 * Every rule, in evaluation order. `sortOrder` then `createdAt`, so the order is
 * explicit and stable rather than whatever the planner returns.
 */
export function listRules(exec: Executor = db): Promise<RoutingRuleRow[]> {
  return exec
    .select()
    .from(routingRules)
    .orderBy(asc(routingRules.sortOrder), asc(routingRules.createdAt));
}

export function listActiveRules(exec: Executor = db): Promise<RoutingRuleRow[]> {
  return exec
    .select()
    .from(routingRules)
    .where(eq(routingRules.isActive, true))
    .orderBy(asc(routingRules.sortOrder), asc(routingRules.createdAt));
}

export async function findRuleById(
  id: string,
  exec: Executor = db,
): Promise<RoutingRuleRow | undefined> {
  const [row] = await exec.select().from(routingRules).where(eq(routingRules.id, id)).limit(1);
  return row;
}

export async function insertRule(
  values: typeof routingRules.$inferInsert,
  exec: Executor = db,
): Promise<RoutingRuleRow> {
  const [row] = await exec.insert(routingRules).values(values).returning();
  if (!row) throw new Error('routing rule insert returned no row');
  return row;
}

export async function updateRule(
  id: string,
  patch: Partial<RoutingRuleRow>,
  exec: Executor = db,
): Promise<RoutingRuleRow | undefined> {
  const [row] = await exec
    .update(routingRules)
    .set(patch)
    .where(eq(routingRules.id, id))
    .returning();
  return row;
}

export async function deleteRule(id: string, exec: Executor = db): Promise<boolean> {
  const removed = await exec
    .delete(routingRules)
    .where(eq(routingRules.id, id))
    .returning({ id: routingRules.id });

  return removed.length > 0;
}

// -- candidates --------------------------------------------------------------

/**
 * The agents who could take a ticket on this product, with everything the
 * scorer needs to rank them.
 *
 * Membership comes from `user_products` only. Administrators hold
 * `ticket:read_all_products` and can *read* every queue, but auto-assigning to
 * them because of that permission would drop customer tickets on people who do
 * not work a queue — an explicit grant is the signal that someone does.
 *
 * One statement rather than a query per agent: the scan and the autoassign job
 * both run this on the hot path.
 */
export function candidatesFor(
  productId: string,
  requiredSkill: string | null,
  defaultMaxOpenTickets: number,
  exec: Executor = db,
): Promise<RoutingCandidate[]> {
  return (
    exec
      .select({
        userId: users.id,
        availability: users.availability,
        maxOpenTickets: sql<number>`coalesce(${users.maxOpenTickets}, ${defaultMaxOpenTickets})::int`,
        // Correlated rather than a group-by: the ticket table is the big one, and
        // this keeps it to an index probe per agent.
        openTickets: sql<number>`(
        select count(*)::int
        from tickets
        where tickets.assigned_to_user_id = ${users.id}
          and tickets.status in ('new', 'open', 'pending', 'on_hold')
          and tickets.deleted_at is null
      )`,
        skillProficiency: agentSkills.proficiency,
        lastAssignedAt: sql<Date | null>`(
        select max(ticket_assignments.created_at)
        from ticket_assignments
        where ticket_assignments.to_user_id = ${users.id}
      )`,
        teamIds: sql<string[]>`coalesce((
        select array_agg(team_members.team_id)
        from team_members
        where team_members.user_id = ${users.id}
      ), '{}')`,
      })
      .from(users)
      .innerJoin(
        userProducts,
        and(eq(userProducts.userId, users.id), eq(userProducts.productId, productId)),
      )
      // Joined on the one skill the rule asked for, so `skillProficiency` is
      // non-null exactly when the agent holds it. With no skill required the join
      // matches nothing and the column stays null, which the scorer treats as
      // "irrelevant" rather than "missing".
      .leftJoin(
        agentSkills,
        requiredSkill
          ? and(eq(agentSkills.userId, users.id), eq(agentSkills.skill, requiredSkill))
          : sql`false`,
      )
      .where(and(eq(users.status, 'active'), isNull(users.deletedAt)))
  );
}

// -- skills ------------------------------------------------------------------

export function listSkills(userId: string, exec: Executor = db): Promise<AgentSkillRow[]> {
  return exec
    .select()
    .from(agentSkills)
    .where(eq(agentSkills.userId, userId))
    .orderBy(asc(agentSkills.skill));
}

/** Replaces an agent's whole skill set in one go. */
export async function replaceSkills(
  userId: string,
  skills: { skill: string; proficiency: number }[],
  exec: Executor = db,
): Promise<AgentSkillRow[]> {
  await exec.delete(agentSkills).where(eq(agentSkills.userId, userId));
  if (skills.length === 0) return [];

  return exec
    .insert(agentSkills)
    .values(skills.map((entry) => ({ userId, ...entry })))
    .returning();
}

import { and, asc, desc, eq } from 'drizzle-orm';
import { db } from '../../db/client.js';
import type { Executor } from '../../db/transaction.js';
import {
  escalationRules,
  escalations,
  type EscalationRow,
  type EscalationRuleRow,
} from './escalation.model.js';

// -- rules -------------------------------------------------------------------

export function listRules(exec: Executor = db): Promise<EscalationRuleRow[]> {
  return exec
    .select()
    .from(escalationRules)
    .orderBy(asc(escalationRules.sortOrder), asc(escalationRules.createdAt));
}

export function listActiveRules(exec: Executor = db): Promise<EscalationRuleRow[]> {
  return exec
    .select()
    .from(escalationRules)
    .where(eq(escalationRules.isActive, true))
    .orderBy(asc(escalationRules.sortOrder), asc(escalationRules.createdAt));
}

export async function findRuleById(
  id: string,
  exec: Executor = db,
): Promise<EscalationRuleRow | undefined> {
  const [row] = await exec
    .select()
    .from(escalationRules)
    .where(eq(escalationRules.id, id))
    .limit(1);
  return row;
}

export async function insertRule(
  values: typeof escalationRules.$inferInsert,
  exec: Executor = db,
): Promise<EscalationRuleRow> {
  const [row] = await exec.insert(escalationRules).values(values).returning();
  if (!row) throw new Error('escalation rule insert returned no row');
  return row;
}

export async function updateRule(
  id: string,
  patch: Partial<EscalationRuleRow>,
  exec: Executor = db,
): Promise<EscalationRuleRow | undefined> {
  const [row] = await exec
    .update(escalationRules)
    .set(patch)
    .where(eq(escalationRules.id, id))
    .returning();
  return row;
}

export async function deleteRule(id: string, exec: Executor = db): Promise<boolean> {
  const removed = await exec
    .delete(escalationRules)
    .where(eq(escalationRules.id, id))
    .returning({ id: escalationRules.id });

  return removed.length > 0;
}

// -- escalations -------------------------------------------------------------

/**
 * Claims the right to escalate, and reports whether it was won.
 *
 * The insert *is* the lock. A scan running every minute keeps seeing the same
 * overdue ticket, and several instances may scan at once; the unique constraint
 * on (ticket, rule, target) means exactly one of them gets a row back and the
 * rest are no-ops. Checking first and inserting after would race.
 */
export async function claim(
  values: typeof escalations.$inferInsert,
  exec: Executor = db,
): Promise<EscalationRow | null> {
  const [row] = await exec
    .insert(escalations)
    .values(values)
    .onConflictDoNothing({
      target: [escalations.ticketId, escalations.ruleId, escalations.targetId],
    })
    .returning();

  return row ?? null;
}

export function listForTicket(ticketId: string, exec: Executor = db): Promise<EscalationRow[]> {
  return exec
    .select()
    .from(escalations)
    .where(eq(escalations.ticketId, ticketId))
    .orderBy(desc(escalations.triggeredAt));
}

/** Which rules have already fired for a target, so the pass can skip them. */
export async function firedRuleIds(
  ticketId: string,
  targetId: string,
  exec: Executor = db,
): Promise<Set<string>> {
  const rows = await exec
    .select({ ruleId: escalations.ruleId })
    .from(escalations)
    .where(and(eq(escalations.ticketId, ticketId), eq(escalations.targetId, targetId)));

  return new Set(rows.map((row) => row.ruleId).filter((id): id is string => id !== null));
}

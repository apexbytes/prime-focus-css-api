import { and, asc, eq, isNull, lte } from 'drizzle-orm';
import { db } from '../../db/client.js';
import type { Executor } from '../../db/transaction.js';
import { tickets } from '../ticket/ticket.model.js';
import {
  businessHours,
  holidays,
  slaBreaches,
  slaPolicies,
  ticketSlaTargets,
  type BusinessHoursRow,
  type HolidayRow,
  type SlaBreachRow,
  type SlaPolicyRow,
  type SlaTargetKind,
  type TicketSlaTargetRow,
} from './sla.model.js';
import type { DueTarget } from './sla.types.js';

// -- calendars ---------------------------------------------------------------

export function listCalendars(exec: Executor = db): Promise<BusinessHoursRow[]> {
  return exec.select().from(businessHours).orderBy(asc(businessHours.name));
}

export async function findCalendarById(
  id: string,
  exec: Executor = db,
): Promise<BusinessHoursRow | undefined> {
  const [row] = await exec.select().from(businessHours).where(eq(businessHours.id, id)).limit(1);
  return row;
}

export async function findDefaultCalendar(
  exec: Executor = db,
): Promise<BusinessHoursRow | undefined> {
  const [row] = await exec
    .select()
    .from(businessHours)
    .where(eq(businessHours.isDefault, true))
    .limit(1);
  return row;
}

export async function updateCalendar(
  id: string,
  patch: Partial<BusinessHoursRow>,
  exec: Executor = db,
): Promise<BusinessHoursRow | undefined> {
  const [row] = await exec
    .update(businessHours)
    .set(patch)
    .where(eq(businessHours.id, id))
    .returning();
  return row;
}

export function listHolidays(businessHoursId: string, exec: Executor = db): Promise<HolidayRow[]> {
  return exec
    .select()
    .from(holidays)
    .where(eq(holidays.businessHoursId, businessHoursId))
    .orderBy(asc(holidays.observedOn));
}

export async function insertHoliday(
  values: typeof holidays.$inferInsert,
  exec: Executor = db,
): Promise<HolidayRow> {
  const [row] = await exec.insert(holidays).values(values).returning();
  if (!row) throw new Error('holiday insert returned no row');
  return row;
}

export async function deleteHoliday(
  businessHoursId: string,
  holidayId: string,
  exec: Executor = db,
): Promise<boolean> {
  const removed = await exec
    .delete(holidays)
    .where(and(eq(holidays.id, holidayId), eq(holidays.businessHoursId, businessHoursId)))
    .returning({ id: holidays.id });

  return removed.length > 0;
}

// -- policies ----------------------------------------------------------------

export function listPolicies(productId: string | undefined, exec: Executor = db) {
  return exec
    .select()
    .from(slaPolicies)
    .where(productId ? eq(slaPolicies.productId, productId) : undefined)
    .orderBy(asc(slaPolicies.productId), asc(slaPolicies.priority));
}

export async function findPolicyById(
  id: string,
  exec: Executor = db,
): Promise<SlaPolicyRow | undefined> {
  const [row] = await exec.select().from(slaPolicies).where(eq(slaPolicies.id, id)).limit(1);
  return row;
}

/** The policy that governs a ticket: its product at its priority, if active. */
export async function findPolicyFor(
  productId: string,
  priority: SlaPolicyRow['priority'],
  exec: Executor = db,
): Promise<SlaPolicyRow | undefined> {
  const [row] = await exec
    .select()
    .from(slaPolicies)
    .where(
      and(
        eq(slaPolicies.productId, productId),
        eq(slaPolicies.priority, priority),
        eq(slaPolicies.isActive, true),
      ),
    )
    .limit(1);

  return row;
}

export async function insertPolicy(
  values: typeof slaPolicies.$inferInsert,
  exec: Executor = db,
): Promise<SlaPolicyRow> {
  const [row] = await exec.insert(slaPolicies).values(values).returning();
  if (!row) throw new Error('sla policy insert returned no row');
  return row;
}

export async function updatePolicy(
  id: string,
  patch: Partial<SlaPolicyRow>,
  exec: Executor = db,
): Promise<SlaPolicyRow | undefined> {
  const [row] = await exec.update(slaPolicies).set(patch).where(eq(slaPolicies.id, id)).returning();
  return row;
}

// -- targets -----------------------------------------------------------------

export async function insertTarget(
  values: typeof ticketSlaTargets.$inferInsert,
  exec: Executor = db,
): Promise<TicketSlaTargetRow> {
  const [row] = await exec
    .insert(ticketSlaTargets)
    .values(values)
    // A ticket has at most one target of each kind. Re-creating one (a reopen)
    // replaces the deadline rather than colliding with the old one.
    .onConflictDoUpdate({
      target: [ticketSlaTargets.ticketId, ticketSlaTargets.kind],
      set: {
        policyId: values.policyId ?? null,
        targetMinutes: values.targetMinutes,
        businessHoursId: values.businessHoursId ?? null,
        startedAt: values.startedAt,
        dueAt: values.dueAt,
        pausedAt: null,
        pausedMinutes: 0,
        satisfiedAt: null,
        breachedAt: null,
      },
    })
    .returning();

  if (!row) throw new Error('sla target upsert returned no row');
  return row;
}

export function targetsForTicket(
  ticketId: string,
  exec: Executor = db,
): Promise<TicketSlaTargetRow[]> {
  return exec
    .select()
    .from(ticketSlaTargets)
    .where(eq(ticketSlaTargets.ticketId, ticketId))
    .orderBy(asc(ticketSlaTargets.kind));
}

export async function findTarget(
  ticketId: string,
  kind: SlaTargetKind,
  exec: Executor = db,
): Promise<TicketSlaTargetRow | undefined> {
  const [row] = await exec
    .select()
    .from(ticketSlaTargets)
    .where(and(eq(ticketSlaTargets.ticketId, ticketId), eq(ticketSlaTargets.kind, kind)))
    .limit(1);

  return row;
}

export async function updateTarget(
  id: string,
  patch: Partial<TicketSlaTargetRow>,
  exec: Executor = db,
): Promise<TicketSlaTargetRow | undefined> {
  const [row] = await exec
    .update(ticketSlaTargets)
    .set(patch)
    .where(eq(ticketSlaTargets.id, id))
    .returning();

  return row;
}

/** Live targets for a ticket, i.e. the ones a status change has to act on. */
export function liveTargetsForTicket(
  ticketId: string,
  exec: Executor = db,
): Promise<TicketSlaTargetRow[]> {
  return exec
    .select()
    .from(ticketSlaTargets)
    .where(
      and(
        eq(ticketSlaTargets.ticketId, ticketId),
        isNull(ticketSlaTargets.satisfiedAt),
        isNull(ticketSlaTargets.breachedAt),
      ),
    );
}

/**
 * The scan's one query: targets whose deadline has passed and which are still
 * running. The three null checks match `ticket_sla_targets_due_idx` exactly — if
 * they drift, this stops using the partial index and starts scanning the table.
 */
export function dueTargets(now: Date, limit: number, exec: Executor = db): Promise<DueTarget[]> {
  return exec
    .select({
      target: ticketSlaTargets,
      ticketId: tickets.id,
      productId: tickets.productId,
      priority: tickets.priority,
      assignedToUserId: tickets.assignedToUserId,
      reference: tickets.reference,
      subject: tickets.subject,
    })
    .from(ticketSlaTargets)
    .innerJoin(tickets, eq(tickets.id, ticketSlaTargets.ticketId))
    .where(
      and(
        lte(ticketSlaTargets.dueAt, now),
        isNull(ticketSlaTargets.satisfiedAt),
        isNull(ticketSlaTargets.breachedAt),
        isNull(ticketSlaTargets.pausedAt),
      ),
    )
    .orderBy(asc(ticketSlaTargets.dueAt))
    .limit(limit);
}

/**
 * Targets the escalation pass still has an interest in: unsatisfied and not
 * paused.
 *
 * Deliberately includes already-breached targets. A rule with a threshold of 100
 * fires *on* the breach, and `sla.scan` sets `breachedAt` before escalation runs
 * — filter those out and the last rung of every ladder would be unreachable.
 */
export function escalatableTargets(limit: number, exec: Executor = db): Promise<DueTarget[]> {
  return exec
    .select({
      target: ticketSlaTargets,
      ticketId: tickets.id,
      productId: tickets.productId,
      priority: tickets.priority,
      assignedToUserId: tickets.assignedToUserId,
      reference: tickets.reference,
      subject: tickets.subject,
    })
    .from(ticketSlaTargets)
    .innerJoin(tickets, eq(tickets.id, ticketSlaTargets.ticketId))
    .where(and(isNull(ticketSlaTargets.satisfiedAt), isNull(ticketSlaTargets.pausedAt)))
    .orderBy(asc(ticketSlaTargets.dueAt))
    .limit(limit);
}

// -- breaches ----------------------------------------------------------------

export async function insertBreach(
  values: typeof slaBreaches.$inferInsert,
  exec: Executor = db,
): Promise<SlaBreachRow> {
  const [row] = await exec.insert(slaBreaches).values(values).returning();
  if (!row) throw new Error('sla breach insert returned no row');
  return row;
}

export function breachesForTicket(ticketId: string, exec: Executor = db): Promise<SlaBreachRow[]> {
  return exec
    .select()
    .from(slaBreaches)
    .where(eq(slaBreaches.ticketId, ticketId))
    .orderBy(asc(slaBreaches.breachedAt));
}

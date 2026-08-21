import { AppError } from '../../common/errors/index.js';
import type { Actor } from '../../common/types/actor.js';
import { env } from '../../config/index.js';
import { withTransaction, type Executor } from '../../db/transaction.js';
import { createModuleLogger } from '../../lib/logger/index.js';
import { enqueue, JOB } from '../../lib/queue/index.js';
import * as auditService from '../audit/audit.service.js';
import * as notificationService from '../notification/notification.service.js';
import * as productService from '../product/product.service.js';
// From the shared status file, not the ticket barrel: the barrel pulls in
// ticket.service, which calls back into this module, and a cycle at module
// scope is worth avoiding when a plain constant is all that is needed.
import { CLOCK_PAUSED_STATUSES } from '../ticket/ticket.status.js';
import type { TicketPriority, TicketStatus } from '../ticket/ticket.types.js';
import {
  addBusinessMinutes,
  businessMinutesBetween,
  consumedFraction,
  type BusinessCalendar,
} from './sla.clock.js';
import type {
  BusinessHoursRow,
  BusinessHoursWindow,
  SlaPolicyRow,
  SlaTargetKind,
  TicketSlaTargetRow,
} from './sla.model.js';
import * as repository from './sla.repository.js';
import type { BusinessHoursWithHolidays, DueTarget, SlaTargetView } from './sla.types.js';

const log = createModuleLogger('sla');

/**
 * Calendars change perhaps twice a year, and the breach scan reads one per
 * target every minute. Cached with the same short TTL as the permission cache,
 * and invalidated explicitly on write.
 */
const CACHE_TTL_MS = 60_000;
const calendarCache = new Map<string, { calendar: BusinessCalendar; expiresAt: number }>();

export function invalidateCalendarCache(id?: string): void {
  if (id) {
    calendarCache.delete(id);
    return;
  }
  calendarCache.clear();
}

/**
 * Loads a calendar and flattens its holidays into the shape the clock wants.
 *
 * A target whose calendar has been deleted falls back to the default one rather
 * than losing its deadline — an SLA with no clock would silently never breach.
 */
export async function calendarFor(businessHoursId: string | null): Promise<BusinessCalendar> {
  const cacheKey = businessHoursId ?? '__default__';
  const cached = calendarCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.calendar;

  const row = businessHoursId
    ? ((await repository.findCalendarById(businessHoursId)) ??
      (await repository.findDefaultCalendar()))
    : await repository.findDefaultCalendar();

  if (!row) {
    throw AppError.internal(
      'No business-hours calendar is configured; run the service-levels seed',
    );
  }

  const holidayRows = await repository.listHolidays(row.id);
  const calendar: BusinessCalendar = {
    timezone: row.timezone,
    weekly: row.weekly,
    // `observedOn` is a Postgres `date`, which the driver hands back as a string
    // already in the YYYY-MM-DD form the clock compares against.
    holidays: new Set(holidayRows.map((holiday) => String(holiday.observedOn))),
  };

  calendarCache.set(cacheKey, { calendar, expiresAt: Date.now() + CACHE_TTL_MS });
  return calendar;
}

// -- calendars (admin) -------------------------------------------------------

export function listCalendars(): Promise<BusinessHoursRow[]> {
  return repository.listCalendars();
}

export async function getCalendar(id: string): Promise<BusinessHoursWithHolidays> {
  const row = await repository.findCalendarById(id);
  if (!row) throw AppError.notFound('Business hours not found');

  return { ...row, holidays: await repository.listHolidays(id) };
}

/**
 * Replaces a calendar's working week. A PUT rather than a PATCH because a week
 * only makes sense as a whole: merging a partial set of windows into an existing
 * week would leave hours nobody asked for.
 */
export async function replaceCalendar(
  id: string,
  input: {
    name?: string | undefined;
    timezone?: string | undefined;
    weekly: BusinessHoursWindow[];
  },
  actor: Actor,
): Promise<BusinessHoursWithHolidays> {
  const before = await repository.findCalendarById(id);
  if (!before) throw AppError.notFound('Business hours not found');

  const timezone = input.timezone ?? before.timezone;
  // Proves the zone exists and the week is usable before it is stored: an
  // unusable calendar would break every deadline computed from it afterwards.
  addBusinessMinutes(new Date(), 1, {
    timezone,
    weekly: input.weekly,
    holidays: new Set(),
  });

  const updated = await withTransaction(async ({ tx }) => {
    const row = await repository.updateCalendar(
      id,
      {
        ...(input.name !== undefined ? { name: input.name } : {}),
        timezone,
        weekly: input.weekly,
      },
      tx,
    );
    if (!row) throw AppError.notFound('Business hours not found');

    await auditService.record(
      {
        action: 'business_hours.updated',
        entityType: 'business_hours',
        entityId: id,
        before: { timezone: before.timezone, weekly: before.weekly },
        after: { timezone: row.timezone, weekly: row.weekly },
      },
      actor,
      tx,
    );

    return row;
  });

  invalidateCalendarCache();
  log.info('business hours updated', { businessHoursId: id, timezone: updated.timezone });

  return { ...updated, holidays: await repository.listHolidays(id) };
}

export async function addHoliday(
  businessHoursId: string,
  input: { observedOn: string; name: string },
  actor: Actor,
): Promise<BusinessHoursWithHolidays> {
  const calendar = await repository.findCalendarById(businessHoursId);
  if (!calendar) throw AppError.notFound('Business hours not found');

  const existing = await repository.listHolidays(businessHoursId);
  if (existing.some((holiday) => String(holiday.observedOn) === input.observedOn)) {
    throw AppError.conflict('That date is already a holiday on this calendar');
  }

  await withTransaction(async ({ tx }) => {
    const holiday = await repository.insertHoliday(
      { businessHoursId, observedOn: input.observedOn, name: input.name },
      tx,
    );

    await auditService.record(
      {
        action: 'holiday.created',
        entityType: 'business_hours',
        entityId: businessHoursId,
        after: { observedOn: holiday.observedOn, name: holiday.name },
      },
      actor,
      tx,
    );
  });

  invalidateCalendarCache();
  return getCalendar(businessHoursId);
}

export async function removeHoliday(
  businessHoursId: string,
  holidayId: string,
  actor: Actor,
): Promise<BusinessHoursWithHolidays> {
  await withTransaction(async ({ tx }) => {
    const removed = await repository.deleteHoliday(businessHoursId, holidayId, tx);
    if (!removed) throw AppError.notFound('Holiday not found on this calendar');

    await auditService.record(
      {
        action: 'holiday.deleted',
        entityType: 'business_hours',
        entityId: businessHoursId,
        before: { holidayId },
      },
      actor,
      tx,
    );
  });

  invalidateCalendarCache();
  return getCalendar(businessHoursId);
}

// -- policies (admin) --------------------------------------------------------

export async function listPolicies(
  productId: string | undefined,
  actor: Actor,
): Promise<SlaPolicyRow[]> {
  if (productId) await productService.assertAccess(actor, productId);
  return repository.listPolicies(productId);
}

export async function createPolicy(
  input: {
    productId: string;
    priority: TicketPriority;
    firstResponseMinutes: number;
    resolutionMinutes: number;
    businessHoursId?: string | undefined;
  },
  actor: Actor,
): Promise<SlaPolicyRow> {
  await productService.requireById(input.productId);

  const businessHoursId = input.businessHoursId ?? (await requireDefaultCalendarId());
  if (input.businessHoursId && !(await repository.findCalendarById(input.businessHoursId))) {
    throw AppError.validation('Unknown business hours', {
      details: [{ field: 'businessHoursId', issue: 'no calendar exists with this id' }],
    });
  }

  const existing = await repository.findPolicyFor(input.productId, input.priority);
  if (existing) {
    throw AppError.conflict(
      'A policy already exists for this product and priority; update it instead',
    );
  }

  return withTransaction(async ({ tx }) => {
    const policy = await repository.insertPolicy(
      {
        productId: input.productId,
        priority: input.priority,
        firstResponseMinutes: input.firstResponseMinutes,
        resolutionMinutes: input.resolutionMinutes,
        businessHoursId,
      },
      tx,
    );

    await auditService.record(
      {
        action: 'sla_policy.created',
        entityType: 'sla_policy',
        entityId: policy.id,
        after: policy,
      },
      actor,
      tx,
    );

    return policy;
  });
}

export async function updatePolicy(
  id: string,
  patch: {
    firstResponseMinutes?: number | undefined;
    resolutionMinutes?: number | undefined;
    businessHoursId?: string | undefined;
    isActive?: boolean | undefined;
  },
  actor: Actor,
): Promise<SlaPolicyRow> {
  const before = await repository.findPolicyById(id);
  if (!before) throw AppError.notFound('SLA policy not found');

  const firstResponse = patch.firstResponseMinutes ?? before.firstResponseMinutes;
  const resolution = patch.resolutionMinutes ?? before.resolutionMinutes;
  if (resolution < firstResponse) {
    throw AppError.validation('Resolution must allow at least as long as the first response', {
      details: [{ field: 'resolutionMinutes', issue: `must be at least ${firstResponse}` }],
    });
  }

  return withTransaction(async ({ tx }) => {
    const row = await repository.updatePolicy(
      id,
      {
        ...(patch.firstResponseMinutes !== undefined
          ? { firstResponseMinutes: patch.firstResponseMinutes }
          : {}),
        ...(patch.resolutionMinutes !== undefined
          ? { resolutionMinutes: patch.resolutionMinutes }
          : {}),
        ...(patch.businessHoursId !== undefined ? { businessHoursId: patch.businessHoursId } : {}),
        ...(patch.isActive !== undefined ? { isActive: patch.isActive } : {}),
      },
      tx,
    );
    if (!row) throw AppError.notFound('SLA policy not found');

    await auditService.record(
      {
        action: 'sla_policy.updated',
        entityType: 'sla_policy',
        entityId: id,
        before,
        after: row,
      },
      actor,
      tx,
    );

    // Editing a policy deliberately does not move deadlines already computed
    // from it: `targetMinutes` is copied onto the target for exactly that reason.
    return row;
  });
}

async function requireDefaultCalendarId(): Promise<string> {
  const row = await repository.findDefaultCalendar();
  if (!row) {
    throw AppError.internal('No default business-hours calendar; run the service-levels seed');
  }
  return row.id;
}

// -- ticket lifecycle --------------------------------------------------------

interface TicketClockContext {
  id: string;
  productId: string;
  priority: TicketPriority;
  createdAt?: Date;
}

/**
 * Attaches the first-response and resolution deadlines to a new ticket.
 *
 * Called inside the ticket's own transaction, not from a job: a ticket whose
 * targets went missing because a queue was down would look permanently on time,
 * and nothing would ever escalate it. Two extra queries is a cheap price for
 * that not being possible.
 *
 * A product with no policy for the ticket's priority simply gets no targets —
 * that is a configuration choice, not an error.
 */
export async function applyTargetsForNewTicket(
  ticket: TicketClockContext,
  exec: Executor,
): Promise<TicketSlaTargetRow[]> {
  const policy = await repository.findPolicyFor(ticket.productId, ticket.priority, exec);
  if (!policy) {
    log.debug('no sla policy for ticket', {
      ticketId: ticket.id,
      productId: ticket.productId,
      priority: ticket.priority,
    });
    return [];
  }

  const calendar = await calendarFor(policy.businessHoursId);
  const startedAt = ticket.createdAt ?? new Date();

  const created: TicketSlaTargetRow[] = [];
  for (const [kind, minutes] of [
    ['first_response', policy.firstResponseMinutes],
    ['resolution', policy.resolutionMinutes],
  ] as const) {
    created.push(
      await repository.insertTarget(
        {
          ticketId: ticket.id,
          policyId: policy.id,
          kind,
          targetMinutes: minutes,
          businessHoursId: policy.businessHoursId,
          startedAt,
          dueAt: addBusinessMinutes(startedAt, minutes, calendar),
        },
        exec,
      ),
    );
  }

  return created;
}

/** Stops the first-response clock. Idempotent: only the first reply counts. */
export async function markFirstResponse(ticketId: string, at: Date, exec: Executor): Promise<void> {
  const target = await repository.findTarget(ticketId, 'first_response', exec);
  if (!target || target.satisfiedAt) return;

  await repository.updateTarget(target.id, { satisfiedAt: at, pausedAt: null }, exec);
}

/**
 * Applies a status change to the clocks.
 *
 * Four things can happen: the resolution obligation is met, the clock stops
 * because we are waiting on somebody else, the clock restarts, or a reopened
 * ticket needs a fresh resolution deadline.
 */
export async function onStatusChanged(
  ticket: TicketClockContext,
  from: TicketStatus,
  to: TicketStatus,
  exec: Executor,
): Promise<void> {
  if (from === to) return;

  const wasPaused = CLOCK_PAUSED_STATUSES.includes(from);
  const isPaused = CLOCK_PAUSED_STATUSES.includes(to);
  const now = new Date();

  if (to === 'resolved' || to === 'closed') {
    const target = await repository.findTarget(ticket.id, 'resolution', exec);
    if (target && !target.satisfiedAt && !target.breachedAt) {
      await repository.updateTarget(target.id, { satisfiedAt: now, pausedAt: null }, exec);
    }
    return;
  }

  // Reopened: the resolution obligation is live again, measured from now. The
  // first response already happened, so that target is left alone. `to` is
  // already known not to be resolved or closed — the branch above returned.
  if (from === 'resolved' || from === 'closed') {
    await reopenResolutionTarget(ticket, now, exec);
    return;
  }

  if (isPaused && !wasPaused) {
    for (const target of await repository.liveTargetsForTicket(ticket.id, exec)) {
      if (!target.pausedAt) await repository.updateTarget(target.id, { pausedAt: now }, exec);
    }
    return;
  }

  if (wasPaused && !isPaused) {
    await resumeTargets(ticket.id, now, exec);
  }
}

/**
 * Restarts stopped clocks, pushing each deadline out by the working time the
 * pause actually cost. A pause over a weekend costs nothing, which is the whole
 * point of measuring it in business minutes rather than wall-clock.
 */
async function resumeTargets(ticketId: string, now: Date, exec: Executor): Promise<void> {
  for (const target of await repository.liveTargetsForTicket(ticketId, exec)) {
    if (!target.pausedAt) continue;

    const calendar = await calendarFor(target.businessHoursId);
    const paused = businessMinutesBetween(target.pausedAt, now, calendar);

    await repository.updateTarget(
      target.id,
      {
        pausedAt: null,
        pausedMinutes: target.pausedMinutes + paused,
        dueAt: addBusinessMinutes(target.dueAt, paused, calendar),
      },
      exec,
    );
  }
}

async function reopenResolutionTarget(
  ticket: TicketClockContext,
  now: Date,
  exec: Executor,
): Promise<void> {
  const policy = await repository.findPolicyFor(ticket.productId, ticket.priority, exec);
  if (!policy) return;

  const calendar = await calendarFor(policy.businessHoursId);

  await repository.insertTarget(
    {
      ticketId: ticket.id,
      policyId: policy.id,
      kind: 'resolution',
      targetMinutes: policy.resolutionMinutes,
      businessHoursId: policy.businessHoursId,
      startedAt: now,
      dueAt: addBusinessMinutes(now, policy.resolutionMinutes, calendar),
    },
    exec,
  );
}

// -- reads -------------------------------------------------------------------

/** The SLA panel for one ticket: where each clock stands right now. */
export async function targetsForTicket(ticketId: string): Promise<SlaTargetView[]> {
  const targets = await repository.targetsForTicket(ticketId);
  const now = new Date();

  return Promise.all(
    targets.map(async (target) => {
      const calendar = await calendarFor(target.businessHoursId);

      return {
        id: target.id,
        kind: target.kind,
        targetMinutes: target.targetMinutes,
        dueAt: target.dueAt,
        consumed: consumedFraction(target, now, calendar),
        minutesRemaining: target.pausedAt
          ? null
          : businessMinutesBetween(now, target.dueAt, calendar),
        paused: target.pausedAt !== null,
        satisfiedAt: target.satisfiedAt,
        breachedAt: target.breachedAt,
      };
    }),
  );
}

export function breachesForTicket(ticketId: string) {
  return repository.breachesForTicket(ticketId);
}

/** How far through its allowance a target is; escalation compares against this. */
export async function consumedFor(target: TicketSlaTargetRow, now = new Date()): Promise<number> {
  return consumedFraction(target, now, await calendarFor(target.businessHoursId));
}

/** Targets escalation should look at: unsatisfied, unpaused, breached or not. */
export function escalatableTargets(limit: number): Promise<DueTarget[]> {
  return repository.escalatableTargets(limit);
}

// -- the scan ----------------------------------------------------------------

export interface ScanResult {
  examined: number;
  breached: number;
}

/**
 * Marks everything whose deadline has passed as breached, once.
 *
 * Each target is handled in its own transaction so one bad row cannot roll back
 * a whole batch, and `breachedAt` is the idempotency guard: a scan that runs
 * every minute keeps seeing the same overdue ticket until it is marked, and must
 * not record the breach twice.
 */
export async function scanForBreaches(limit = env.SLA_SCAN_BATCH_SIZE): Promise<ScanResult> {
  const now = new Date();
  const due = await repository.dueTargets(now, limit);

  let breached = 0;
  for (const entry of due) {
    try {
      await recordBreach(entry, now);
      breached += 1;
    } catch (error) {
      log.error('failed to record sla breach', {
        ticketId: entry.ticketId,
        targetId: entry.target.id,
        err: error,
      });
    }
  }

  if (due.length > 0) {
    log.info('sla scan complete', { examined: due.length, breached });
  }

  return { examined: due.length, breached };
}

/**
 * The whole minute-by-minute cycle: record what has breached, then let the
 * escalation ladder act on everything that is late or getting there.
 *
 * Both the `sla.scan` job and `POST /sla/scan` call this, so the manual endpoint
 * exercises exactly what the cron does. Splitting them was a bug: the endpoint
 * recorded breaches and never escalated them, which is precisely the difference
 * an operator running it by hand would not expect.
 */
export async function scanAndEscalate(limit = env.SLA_SCAN_BATCH_SIZE): Promise<ScanResult> {
  const result = await scanForBreaches(limit);

  // Unconditional: rules fire at a percentage of the SLA as well as on a
  // breach, so there is work to do even when this pass broke nothing.
  await enqueue(JOB.slaEscalate, {}, { singletonKey: JOB.slaEscalate });

  return result;
}

async function recordBreach(entry: DueTarget, now: Date): Promise<void> {
  const calendar = await calendarFor(entry.target.businessHoursId);
  const minutesOverdue = businessMinutesBetween(entry.target.dueAt, now, calendar);

  await withTransaction(async ({ tx, afterCommit }) => {
    // Re-read inside the transaction: another instance's scan may have marked
    // this target between the query above and here.
    const current = await repository.findTarget(entry.ticketId, entry.target.kind, tx);
    if (!current || current.breachedAt || current.satisfiedAt) return;

    await repository.updateTarget(current.id, { breachedAt: now }, tx);

    await repository.insertBreach(
      {
        ticketId: entry.ticketId,
        targetId: current.id,
        kind: current.kind,
        dueAt: current.dueAt,
        breachedAt: now,
        minutesOverdue,
      },
      tx,
    );

    await auditService.record(
      {
        action: 'sla.breached',
        entityType: 'ticket',
        entityId: entry.ticketId,
        after: { kind: current.kind, dueAt: current.dueAt, minutesOverdue },
      },
      { kind: 'system', name: 'sla.scan' },
      tx,
    );

    afterCommit(async () => {
      if (!entry.assignedToUserId) return;

      await notificationService.notifySlaBreach(entry.assignedToUserId, {
        id: entry.ticketId,
        reference: entry.reference,
        subject: entry.subject,
        kind: current.kind,
      });
    });
  });

  log.warn('sla breached', {
    ticketId: entry.ticketId,
    reference: entry.reference,
    kind: entry.target.kind,
    minutesOverdue,
  });
}

export type { SlaTargetKind };

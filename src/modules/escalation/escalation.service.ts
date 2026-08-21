import { AppError } from '../../common/errors/index.js';
import type { Actor, SystemActor } from '../../common/types/actor.js';
import { env } from '../../config/index.js';
import { withTransaction } from '../../db/transaction.js';
import { createModuleLogger } from '../../lib/logger/index.js';
import * as auditService from '../audit/audit.service.js';
import * as notificationService from '../notification/notification.service.js';
import * as productService from '../product/product.service.js';
import * as slaService from '../sla/sla.service.js';
import type { DueTarget, SlaTargetKind } from '../sla/sla.types.js';
import * as teamService from '../team/team.service.js';
import * as ticketService from '../ticket/ticket.service.js';
import type { TicketPriority } from '../ticket/ticket.types.js';
import type { EscalationRow, EscalationRuleRow } from './escalation.model.js';
import * as repository from './escalation.repository.js';

const log = createModuleLogger('escalation');

const ESCALATION_ACTOR: SystemActor = { kind: 'system', name: 'sla.escalate' };

/** Ordered, so "one step up" is well defined. */
const PRIORITY_LADDER: readonly TicketPriority[] = ['low', 'normal', 'high', 'urgent'];

// -- rules (admin) -----------------------------------------------------------

export function listRules(): Promise<EscalationRuleRow[]> {
  return repository.listRules();
}

export async function createRule(
  input: {
    name: string;
    productId?: string | undefined;
    priority?: TicketPriority | undefined;
    targetKind?: SlaTargetKind | undefined;
    thresholdPercent: number;
    action: EscalationRuleRow['action'];
    notifyUserId?: string | undefined;
    notifyTeamId?: string | undefined;
    reassignToUserId?: string | undefined;
    reassignToTeamId?: string | undefined;
    raisePriority?: boolean | undefined;
    sortOrder?: number | undefined;
  },
  actor: Actor,
): Promise<EscalationRuleRow> {
  if (input.productId) await productService.requireById(input.productId);
  assertActionIsAchievable(input);

  return withTransaction(async ({ tx }) => {
    const rule = await repository.insertRule(
      {
        name: input.name,
        productId: input.productId ?? null,
        priority: input.priority ?? null,
        targetKind: input.targetKind ?? null,
        thresholdPercent: input.thresholdPercent,
        action: input.action,
        notifyUserId: input.notifyUserId ?? null,
        notifyTeamId: input.notifyTeamId ?? null,
        reassignToUserId: input.reassignToUserId ?? null,
        reassignToTeamId: input.reassignToTeamId ?? null,
        ...(input.raisePriority !== undefined ? { raisePriority: input.raisePriority } : {}),
        ...(input.sortOrder !== undefined ? { sortOrder: input.sortOrder } : {}),
      },
      tx,
    );

    await auditService.record(
      {
        action: 'escalation_rule.created',
        entityType: 'escalation_rule',
        entityId: rule.id,
        after: rule,
      },
      actor,
      tx,
    );

    return rule;
  });
}

/**
 * A rule whose action cannot be carried out is a rule that will silently do
 * nothing every minute forever, so it is refused at write time instead.
 */
function assertActionIsAchievable(input: {
  action: EscalationRuleRow['action'];
  // Nullable as well as optional: an update merges the stored row, where an
  // unset destination is null, over the patch.
  notifyUserId?: string | null | undefined;
  notifyTeamId?: string | null | undefined;
  reassignToUserId?: string | null | undefined;
  reassignToTeamId?: string | null | undefined;
  raisePriority?: boolean | undefined;
}): void {
  const notifies = input.action === 'notify' || input.action === 'notify_and_reassign';
  const reassigns = input.action === 'reassign' || input.action === 'notify_and_reassign';

  if (notifies && !input.notifyUserId && !input.notifyTeamId) {
    throw AppError.validation('A notifying rule needs somebody to notify', {
      details: [{ field: 'notifyUserId', issue: 'provide notifyUserId or notifyTeamId' }],
    });
  }

  if (reassigns && !input.reassignToUserId && !input.reassignToTeamId) {
    throw AppError.validation('A reassigning rule needs a destination', {
      details: [
        { field: 'reassignToUserId', issue: 'provide reassignToUserId or reassignToTeamId' },
      ],
    });
  }
}

export async function updateRule(
  id: string,
  patch: Partial<EscalationRuleRow>,
  actor: Actor,
): Promise<EscalationRuleRow> {
  const before = await repository.findRuleById(id);
  if (!before) throw AppError.notFound('Escalation rule not found');

  assertActionIsAchievable({ ...before, ...patch });

  return withTransaction(async ({ tx }) => {
    const row = await repository.updateRule(id, patch, tx);
    if (!row) throw AppError.notFound('Escalation rule not found');

    await auditService.record(
      {
        action: 'escalation_rule.updated',
        entityType: 'escalation_rule',
        entityId: id,
        before,
        after: row,
      },
      actor,
      tx,
    );

    return row;
  });
}

export async function deleteRule(id: string, actor: Actor): Promise<void> {
  const rule = await repository.findRuleById(id);
  if (!rule) throw AppError.notFound('Escalation rule not found');

  await withTransaction(async ({ tx }) => {
    await auditService.record(
      {
        action: 'escalation_rule.deleted',
        entityType: 'escalation_rule',
        entityId: id,
        before: rule,
      },
      actor,
      tx,
    );
    await repository.deleteRule(id, tx);
  });
}

export function listForTicket(ticketId: string): Promise<EscalationRow[]> {
  return repository.listForTicket(ticketId);
}

// -- the ladder --------------------------------------------------------------

/** Whether a rule speaks to this target at this point on the clock. */
function ruleApplies(rule: EscalationRuleRow, entry: DueTarget, consumedPercent: number): boolean {
  if (!rule.isActive) return false;
  if (rule.productId !== null && rule.productId !== entry.productId) return false;
  if (rule.priority !== null && rule.priority !== entry.priority) return false;
  if (rule.targetKind !== null && rule.targetKind !== entry.target.kind) return false;

  return consumedPercent >= rule.thresholdPercent;
}

export interface EscalationRunResult {
  examined: number;
  triggered: number;
}

/**
 * One pass of the ladder over every clock that is still running.
 *
 * Driven by the `sla.escalate` job, which `sla.scan` hands off to each minute.
 * Every rung a ticket has passed fires, not just the highest: a ladder that
 * warns at 50% and reassigns at 90% must do both, and the record of the warning
 * is what a supervisor looks at afterwards.
 */
export async function run(limit = env.SLA_SCAN_BATCH_SIZE): Promise<EscalationRunResult> {
  const rules = await repository.listActiveRules();
  if (rules.length === 0) return { examined: 0, triggered: 0 };

  const targets = await slaService.escalatableTargets(limit);
  const now = new Date();

  let triggered = 0;
  for (const entry of targets) {
    try {
      triggered += await escalateTarget(entry, rules, now);
    } catch (error) {
      // One unroutable ticket must not stop the rest of the queue escalating.
      log.error('escalation failed for ticket', {
        ticketId: entry.ticketId,
        targetId: entry.target.id,
        err: error,
      });
    }
  }

  if (triggered > 0) log.info('escalation pass complete', { examined: targets.length, triggered });

  return { examined: targets.length, triggered };
}

async function escalateTarget(
  entry: DueTarget,
  rules: readonly EscalationRuleRow[],
  now: Date,
): Promise<number> {
  const measured = Math.round((await slaService.consumedFor(entry.target, now)) * 100);
  // A target the scan has already marked breached is past its deadline by
  // definition, so it can never present as under 100% here — otherwise the last
  // rung of every ladder would be unreachable.
  const consumedPercent = entry.target.breachedAt ? Math.max(100, measured) : measured;

  const applicable = rules.filter((rule) => ruleApplies(rule, entry, consumedPercent));
  if (applicable.length === 0) return 0;

  const alreadyFired = await repository.firedRuleIds(entry.ticketId, entry.target.id);

  let fired = 0;
  for (const rule of applicable) {
    if (alreadyFired.has(rule.id)) continue;
    if (await applyRule(rule, entry, consumedPercent)) fired += 1;
  }

  return fired;
}

/**
 * Records the escalation, then carries out its action.
 *
 * The record comes first and in its own transaction: if the reassignment below
 * fails, the ladder must not re-fire this rung on the next pass and try forever.
 * The escalation genuinely happened — what failed is one of its consequences,
 * which is logged and visible.
 */
async function applyRule(
  rule: EscalationRuleRow,
  entry: DueTarget,
  consumedPercent: number,
): Promise<boolean> {
  const clock = entry.target.kind === 'first_response' ? 'first response' : 'resolution';
  const reason = entry.target.breachedAt
    ? `${clock} SLA breached (${consumedPercent}% of ${entry.target.targetMinutes} minutes used)`
    : `${consumedPercent}% of the ${clock} SLA used`;

  const claimed = await withTransaction(async ({ tx }) => {
    const row = await repository.claim(
      {
        ticketId: entry.ticketId,
        ruleId: rule.id,
        targetId: entry.target.id,
        thresholdPercent: rule.thresholdPercent,
        action: rule.action,
        fromUserId: entry.assignedToUserId,
        toUserId: rule.reassignToUserId,
        reason,
        triggeredAt: new Date(),
      },
      tx,
    );

    // Another instance got there first; it owns the side effects.
    if (!row) return null;

    await auditService.record(
      {
        action: 'ticket.escalated',
        entityType: 'ticket',
        entityId: entry.ticketId,
        after: {
          ruleId: rule.id,
          ruleName: rule.name,
          thresholdPercent: rule.thresholdPercent,
          action: rule.action,
          consumedPercent,
        },
      },
      ESCALATION_ACTOR,
      tx,
    );

    return row;
  });

  if (!claimed) return false;

  await carryOut(rule, entry, reason);

  log.warn('ticket escalated', {
    ticketId: entry.ticketId,
    reference: entry.reference,
    ruleName: rule.name,
    thresholdPercent: rule.thresholdPercent,
    consumedPercent,
    action: rule.action,
  });

  return true;
}

/** Notifications, reassignment and the priority bump, each failing on its own. */
async function carryOut(rule: EscalationRuleRow, entry: DueTarget, reason: string): Promise<void> {
  const ticket = { id: entry.ticketId, reference: entry.reference, subject: entry.subject };

  if (rule.action === 'notify' || rule.action === 'notify_and_reassign') {
    for (const userId of await notifyTargets(rule)) {
      await notificationService.notifyEscalation(userId, ticket, reason);
    }
  }

  if (rule.action === 'reassign' || rule.action === 'notify_and_reassign') {
    await reassign(rule, entry, reason);
  }

  if (rule.raisePriority) await raisePriority(entry);
}

/** Who a rule notifies: a named person, a whole team, or both. */
async function notifyTargets(rule: EscalationRuleRow): Promise<string[]> {
  const recipients = new Set<string>();
  if (rule.notifyUserId) recipients.add(rule.notifyUserId);

  if (rule.notifyTeamId) {
    try {
      const team = await teamService.get(rule.notifyTeamId);
      for (const member of team.members) recipients.add(member.userId);
    } catch (error) {
      log.error('escalation could not resolve notify team', {
        teamId: rule.notifyTeamId,
        err: error,
      });
    }
  }

  return [...recipients];
}

async function reassign(rule: EscalationRuleRow, entry: DueTarget, reason: string): Promise<void> {
  try {
    // Moving the team alone is a real outcome: the ticket lands on the
    // specialists' board for whoever is free, rather than on one named person
    // who may also be busy.
    if (rule.reassignToTeamId) {
      await ticketService.updateFields(
        entry.ticketId,
        { teamId: rule.reassignToTeamId },
        ESCALATION_ACTOR,
      );
    }

    if (rule.reassignToUserId && rule.reassignToUserId !== entry.assignedToUserId) {
      await ticketService.assign(
        entry.ticketId,
        rule.reassignToUserId,
        `escalated: ${reason}`,
        ESCALATION_ACTOR,
      );
    }
  } catch (error) {
    log.error('escalation reassignment failed', {
      ticketId: entry.ticketId,
      ruleId: rule.id,
      err: error,
    });
  }
}

async function raisePriority(entry: DueTarget): Promise<void> {
  const current = PRIORITY_LADDER.indexOf(entry.priority);
  const next = PRIORITY_LADDER[Math.min(current + 1, PRIORITY_LADDER.length - 1)];
  if (!next || next === entry.priority) return;

  try {
    // Note this does not move the deadline: `targetMinutes` was copied onto the
    // target when it was created, so a live clock is never rewritten under an
    // agent. The new priority governs the next ticket, and reporting.
    await ticketService.updateFields(entry.ticketId, { priority: next }, ESCALATION_ACTOR);
  } catch (error) {
    log.error('escalation could not raise priority', { ticketId: entry.ticketId, err: error });
  }
}

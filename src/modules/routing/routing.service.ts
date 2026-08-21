import { AppError } from '../../common/errors/index.js';
import type { Actor, SystemActor } from '../../common/types/actor.js';
import { env } from '../../config/index.js';
import { withTransaction } from '../../db/transaction.js';
import { createModuleLogger } from '../../lib/logger/index.js';
import * as auditService from '../audit/audit.service.js';
import * as customerService from '../customer/customer.service.js';
import * as productService from '../product/product.service.js';
import * as ticketService from '../ticket/ticket.service.js';
import * as userService from '../user/user.service.js';
import type { AgentSkillRow, RoutingRuleRow } from './routing.model.js';
import * as repository from './routing.repository.js';
import {
  chooseAgentWithFallback,
  decide,
  type RoutingCriteria,
  type RoutingDecision,
} from './routing.scoring.js';

const log = createModuleLogger('routing');

/** Jobs act as the system, never as the agent whose action triggered them. */
const TRIAGE_ACTOR: SystemActor = { kind: 'system', name: 'ticket.triage' };
const ASSIGN_ACTOR: SystemActor = { kind: 'system', name: 'ticket.autoassign' };

// -- rules (admin) -----------------------------------------------------------

export function listRules(): Promise<RoutingRuleRow[]> {
  return repository.listRules();
}

export async function createRule(
  input: {
    name: string;
    productId?: string | undefined;
    categoryId?: string | undefined;
    priority?: RoutingRuleRow['priority'] | undefined;
    channel?: RoutingRuleRow['channel'] | undefined;
    customerTier?: RoutingRuleRow['customerTier'] | undefined;
    language?: string | undefined;
    requiredSkill?: string | undefined;
    assignToTeamId?: string | undefined;
    sortOrder?: number | undefined;
  },
  actor: Actor,
): Promise<RoutingRuleRow> {
  if (input.productId) await productService.requireById(input.productId);

  return withTransaction(async ({ tx }) => {
    const rule = await repository.insertRule(
      {
        name: input.name,
        productId: input.productId ?? null,
        categoryId: input.categoryId ?? null,
        priority: input.priority ?? null,
        channel: input.channel ?? null,
        customerTier: input.customerTier ?? null,
        language: input.language ?? null,
        requiredSkill: input.requiredSkill ?? null,
        assignToTeamId: input.assignToTeamId ?? null,
        ...(input.sortOrder !== undefined ? { sortOrder: input.sortOrder } : {}),
      },
      tx,
    );

    await auditService.record(
      {
        action: 'routing_rule.created',
        entityType: 'routing_rule',
        entityId: rule.id,
        after: rule,
      },
      actor,
      tx,
    );

    return rule;
  });
}

export async function updateRule(
  id: string,
  patch: Partial<
    Pick<
      RoutingRuleRow,
      | 'name'
      | 'productId'
      | 'categoryId'
      | 'priority'
      | 'channel'
      | 'customerTier'
      | 'language'
      | 'requiredSkill'
      | 'assignToTeamId'
      | 'sortOrder'
      | 'isActive'
    >
  >,
  actor: Actor,
): Promise<RoutingRuleRow> {
  const before = await repository.findRuleById(id);
  if (!before) throw AppError.notFound('Routing rule not found');

  return withTransaction(async ({ tx }) => {
    const row = await repository.updateRule(id, patch, tx);
    if (!row) throw AppError.notFound('Routing rule not found');

    await auditService.record(
      {
        action: 'routing_rule.updated',
        entityType: 'routing_rule',
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
  if (!rule) throw AppError.notFound('Routing rule not found');

  await withTransaction(async ({ tx }) => {
    await auditService.record(
      {
        action: 'routing_rule.deleted',
        entityType: 'routing_rule',
        entityId: id,
        before: rule,
      },
      actor,
      tx,
    );
    await repository.deleteRule(id, tx);
  });
}

// -- skills ------------------------------------------------------------------

export async function listSkills(userId: string): Promise<AgentSkillRow[]> {
  await userService.requireById(userId);
  return repository.listSkills(userId);
}

export async function replaceSkills(
  userId: string,
  skills: { skill: string; proficiency: number }[],
  actor: Actor,
): Promise<AgentSkillRow[]> {
  await userService.requireById(userId);

  return withTransaction(async ({ tx }) => {
    const rows = await repository.replaceSkills(userId, skills, tx);

    await auditService.record(
      {
        action: 'agent_skills.replaced',
        entityType: 'user',
        entityId: userId,
        after: { skills: rows.map((row) => `${row.skill}:${row.proficiency}`) },
      },
      actor,
      tx,
    );

    return rows;
  });
}

// -- the engine --------------------------------------------------------------

/**
 * Reads everything a routing decision depends on off the ticket and its
 * customer. Read fresh rather than passed through the queue payload: a job may
 * run seconds or minutes after it was enqueued, and the ticket may have been
 * recategorised in between.
 */
async function criteriaFor(ticketId: string): Promise<{
  criteria: RoutingCriteria;
  defaultTeamId: string | null;
  assignedToUserId: string | null;
} | null> {
  const ticket = await ticketService.findRawById(ticketId);
  if (!ticket) {
    log.warn('routing skipped: ticket no longer exists', { ticketId });
    return null;
  }

  const [product, customer] = await Promise.all([
    productService.requireById(ticket.productId),
    customerService.requireById(ticket.customerId),
  ]);

  return {
    criteria: {
      productId: ticket.productId,
      categoryId: ticket.categoryId,
      priority: ticket.priority,
      channel: ticket.channel,
      customerTier: customer.tier,
      language: customer.language,
    },
    defaultTeamId: product.defaultTeamId,
    assignedToUserId: ticket.assignedToUserId,
  };
}

/** The decision for a ticket, without acting on it. Used by the console too. */
export async function decideFor(ticketId: string): Promise<RoutingDecision | null> {
  const context = await criteriaFor(ticketId);
  if (!context) return null;

  return decide(await repository.listActiveRules(), context.criteria, context.defaultTeamId);
}

/**
 * Puts a new ticket in front of the right team.
 *
 * Triage only sets the team; choosing a person is `autoassign`'s job. Splitting
 * them means a queue with nobody available still ends up on the correct team's
 * board, which is what an agent picking work up looks at.
 */
export async function triage(ticketId: string): Promise<void> {
  const context = await criteriaFor(ticketId);
  if (!context) return;

  const decision = decide(
    await repository.listActiveRules(),
    context.criteria,
    context.defaultTeamId,
  );

  if (decision.teamId) {
    await ticketService.updateFields(ticketId, { teamId: decision.teamId }, TRIAGE_ACTOR);
  }

  log.info('ticket triaged', {
    ticketId,
    ruleId: decision.rule?.id ?? null,
    teamId: decision.teamId,
    requiredSkill: decision.requiredSkill,
  });
}

export interface AutoassignResult {
  assignedToUserId: string | null;
  relaxed: 'none' | 'team' | 'team_and_skill';
}

/**
 * Chooses an agent and gives them the ticket.
 *
 * Does nothing to a ticket somebody already owns: an agent may have claimed it
 * between the ticket being created and this job running, and taking it back off
 * them would be worse than not routing at all.
 */
export async function autoassign(ticketId: string): Promise<AutoassignResult> {
  const idle: AutoassignResult = { assignedToUserId: null, relaxed: 'none' };

  if (!env.AUTO_ASSIGN_ENABLED) return idle;

  const context = await criteriaFor(ticketId);
  if (!context) return idle;

  if (context.assignedToUserId) {
    log.debug('autoassign skipped: already assigned', { ticketId });
    return idle;
  }

  const decision = decide(
    await repository.listActiveRules(),
    context.criteria,
    context.defaultTeamId,
  );

  const candidates = await repository.candidatesFor(
    context.criteria.productId,
    decision.requiredSkill,
    env.DEFAULT_AGENT_MAX_OPEN_TICKETS,
  );

  const { agent, relaxed } = chooseAgentWithFallback(candidates, {
    teamId: decision.teamId,
    requiredSkill: decision.requiredSkill,
    allowAway: env.ROUTING_ASSIGN_TO_AWAY_AGENTS,
  });

  if (!agent) {
    // Not an error. The ticket stays in the unassigned queue, which is visible
    // to everyone who works the product.
    log.info('no agent available, ticket left unassigned', {
      ticketId,
      candidates: candidates.length,
      teamId: decision.teamId,
      requiredSkill: decision.requiredSkill,
    });
    return idle;
  }

  await ticketService.assign(ticketId, agent.userId, reasonFor(decision, relaxed), ASSIGN_ACTOR);

  log.info('ticket auto-assigned', {
    ticketId,
    userId: agent.userId,
    ruleId: decision.rule?.id ?? null,
    openTickets: agent.openTickets,
    relaxed,
  });

  return { assignedToUserId: agent.userId, relaxed };
}

/** Written onto the assignment record, so the history explains itself. */
function reasonFor(decision: RoutingDecision, relaxed: AutoassignResult['relaxed']): string {
  const basis = decision.rule ? `rule “${decision.rule.name}”` : 'default routing';

  switch (relaxed) {
    case 'team':
      return `auto-assigned by ${basis}; no one available on the matched team`;
    case 'team_and_skill':
      return `auto-assigned by ${basis}; no one available with the required skill`;
    case 'none':
      return `auto-assigned by ${basis}`;
  }
}

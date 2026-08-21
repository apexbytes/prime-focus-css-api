import type { CustomerTier } from '../customer/customer.types.js';
import type { TicketChannel, TicketPriority } from '../ticket/ticket.types.js';
import type { AgentAvailability } from '../user/user.types.js';
import type { RoutingRuleRow } from './routing.model.js';

/**
 * Rule matching and agent selection, with no I/O so both are unit-testable.
 *
 * Deliberately deterministic — see §11 of the API doc. Sentiment scoring and
 * auto-categorisation would arrive as extra criteria feeding the same
 * `RoutingDecision`, which is why the seam is here rather than inside the
 * service.
 */

/** What we know about a ticket at the moment it needs an owner. */
export interface RoutingCriteria {
  productId: string;
  categoryId: string | null;
  priority: TicketPriority;
  channel: TicketChannel;
  customerTier: CustomerTier;
  /** ISO code from the customer record. */
  language: string;
}

/** An agent who could take the ticket, with the facts selection depends on. */
export interface RoutingCandidate {
  userId: string;
  availability: AgentAvailability;
  /** Tickets they currently hold in an open state. */
  openTickets: number;
  /** Their own limit, already defaulted by the caller. */
  maxOpenTickets: number;
  /** 1–5, or null when they do not hold the skill the rule asked for. */
  skillProficiency: number | null;
  /** When they were last given a ticket; null means never. */
  lastAssignedAt: Date | null;
  teamIds: readonly string[];
}

export interface AgentSelectionOptions {
  /** Restricts to members of this team, when a rule named one. */
  teamId?: string | null;
  /** Restricts to agents holding this skill. */
  requiredSkill?: string | null;
  /** Whether an `away` agent may be given work. */
  allowAway: boolean;
}

/** Why a ticket ended up where it did, recorded on the assignment. */
export interface RoutingDecision {
  rule: RoutingRuleRow | null;
  teamId: string | null;
  requiredSkill: string | null;
}

/**
 * Whether every criterion a rule *states* is satisfied. A null column is a
 * wildcard, so the broadest possible rule — all nulls — matches everything, and
 * is how a catch-all default is expressed.
 */
export function ruleMatches(rule: RoutingRuleRow, criteria: RoutingCriteria): boolean {
  if (!rule.isActive) return false;
  if (rule.productId !== null && rule.productId !== criteria.productId) return false;
  if (rule.categoryId !== null && rule.categoryId !== criteria.categoryId) return false;
  if (rule.priority !== null && rule.priority !== criteria.priority) return false;
  if (rule.channel !== null && rule.channel !== criteria.channel) return false;
  if (rule.customerTier !== null && rule.customerTier !== criteria.customerTier) return false;
  if (rule.language !== null && rule.language.toLowerCase() !== criteria.language.toLowerCase()) {
    return false;
  }

  return true;
}

/**
 * The first matching rule wins.
 *
 * Order is the caller's responsibility — the repository returns rules by
 * `sortOrder` then `createdAt` — because "most specific wins" is a trap: it
 * requires ranking criteria against each other, and two equally specific rules
 * would then be resolved by something invisible. An explicit order is auditable.
 */
export function decide(
  rules: readonly RoutingRuleRow[],
  criteria: RoutingCriteria,
  fallbackTeamId: string | null,
): RoutingDecision {
  for (const rule of rules) {
    if (!ruleMatches(rule, criteria)) continue;

    return {
      rule,
      // A matching rule that names no team still narrows by skill; the product's
      // default team remains the destination.
      teamId: rule.assignToTeamId ?? fallbackTeamId,
      requiredSkill: rule.requiredSkill,
    };
  }

  return { rule: null, teamId: fallbackTeamId, requiredSkill: null };
}

/** Whether this agent is eligible at all, before any preference is applied. */
export function isEligible(candidate: RoutingCandidate, options: AgentSelectionOptions): boolean {
  const availableNow =
    candidate.availability === 'online' || (options.allowAway && candidate.availability === 'away');
  if (!availableNow) return false;

  // At capacity: skipped rather than stacked on. A queue an agent can never
  // clear is worse for the customer than a ticket waiting to be picked up.
  if (candidate.openTickets >= candidate.maxOpenTickets) return false;

  if (options.requiredSkill && candidate.skillProficiency === null) return false;

  if (options.teamId && !candidate.teamIds.includes(options.teamId)) return false;

  return true;
}

/**
 * Orders eligible agents best-first.
 *
 * Load is compared as a *ratio* of each agent's own limit, so a part-time agent
 * with a limit of 5 is not handed work until they are as busy as a full-timer
 * with a limit of 20. Skill breaks ties, then least-recently-assigned, which is
 * what makes the fallback a genuine round robin rather than always the same
 * alphabetically-first name.
 */
export function compareCandidates(left: RoutingCandidate, right: RoutingCandidate): number {
  const leftLoad = left.openTickets / Math.max(1, left.maxOpenTickets);
  const rightLoad = right.openTickets / Math.max(1, right.maxOpenTickets);
  if (leftLoad !== rightLoad) return leftLoad - rightLoad;

  const leftSkill = left.skillProficiency ?? 0;
  const rightSkill = right.skillProficiency ?? 0;
  if (leftSkill !== rightSkill) return rightSkill - leftSkill;

  const leftSeen = left.lastAssignedAt?.getTime() ?? 0;
  const rightSeen = right.lastAssignedAt?.getTime() ?? 0;
  if (leftSeen !== rightSeen) return leftSeen - rightSeen;

  // Total order, so the same inputs always produce the same choice.
  return left.userId.localeCompare(right.userId);
}

/**
 * Picks the agent, or nobody.
 *
 * Returning null is a real outcome, not a failure: the ticket stays in the
 * unassigned queue where any agent can claim it. That is strictly better than
 * assigning to someone who is offline or already over capacity, because an
 * unassigned ticket is visible to the whole team.
 */
export function chooseAgent(
  candidates: readonly RoutingCandidate[],
  options: AgentSelectionOptions,
): RoutingCandidate | null {
  const eligible = candidates.filter((candidate) => isEligible(candidate, options));
  if (eligible.length === 0) return null;

  return [...eligible].sort(compareCandidates)[0] ?? null;
}

/**
 * Selection with progressive relaxation, in the order a human would try.
 *
 * Each step drops the least important constraint: first the team, then the
 * skill. Nothing relaxes availability or capacity — those are the two
 * constraints that make an assignment wrong rather than merely imperfect.
 */
export function chooseAgentWithFallback(
  candidates: readonly RoutingCandidate[],
  options: AgentSelectionOptions,
): { agent: RoutingCandidate | null; relaxed: 'none' | 'team' | 'team_and_skill' } {
  const exact = chooseAgent(candidates, options);
  if (exact) return { agent: exact, relaxed: 'none' };

  if (options.teamId) {
    const withoutTeam = chooseAgent(candidates, { ...options, teamId: null });
    if (withoutTeam) return { agent: withoutTeam, relaxed: 'team' };
  }

  if (options.requiredSkill) {
    const withoutSkill = chooseAgent(candidates, {
      ...options,
      teamId: null,
      requiredSkill: null,
    });
    if (withoutSkill) return { agent: withoutSkill, relaxed: 'team_and_skill' };
  }

  return { agent: null, relaxed: 'none' };
}

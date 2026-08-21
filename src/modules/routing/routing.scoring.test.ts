import { describe, expect, it } from 'vitest';
import type { RoutingRuleRow } from './routing.model.js';
import {
  chooseAgent,
  chooseAgentWithFallback,
  decide,
  isEligible,
  ruleMatches,
  type RoutingCandidate,
  type RoutingCriteria,
} from './routing.scoring.js';

const criteria: RoutingCriteria = {
  productId: 'product-wallet',
  categoryId: 'category-transfer',
  priority: 'high',
  channel: 'email',
  customerTier: 'vip',
  language: 'en',
};

/** A rule with everything wildcarded; each test narrows what it cares about. */
const rule = (overrides: Partial<RoutingRuleRow> = {}): RoutingRuleRow => ({
  id: 'rule-1',
  name: 'test rule',
  productId: null,
  categoryId: null,
  priority: null,
  channel: null,
  customerTier: null,
  language: null,
  requiredSkill: null,
  assignToTeamId: null,
  sortOrder: 0,
  isActive: true,
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-01T00:00:00Z'),
  ...overrides,
});

const agent = (overrides: Partial<RoutingCandidate> = {}): RoutingCandidate => ({
  userId: 'agent-a',
  availability: 'online',
  openTickets: 0,
  maxOpenTickets: 20,
  skillProficiency: null,
  lastAssignedAt: null,
  teamIds: [],
  ...overrides,
});

describe('ruleMatches', () => {
  it('matches an all-wildcard rule against anything', () => {
    expect(ruleMatches(rule(), criteria)).toBe(true);
  });

  it('matches when every stated criterion agrees', () => {
    expect(ruleMatches(rule({ productId: 'product-wallet', priority: 'high' }), criteria)).toBe(
      true,
    );
  });

  it('rejects when any stated criterion disagrees', () => {
    expect(ruleMatches(rule({ productId: 'product-lending' }), criteria)).toBe(false);
    expect(ruleMatches(rule({ priority: 'low' }), criteria)).toBe(false);
    expect(ruleMatches(rule({ channel: 'agent' }), criteria)).toBe(false);
    expect(ruleMatches(rule({ customerTier: 'standard' }), criteria)).toBe(false);
    expect(ruleMatches(rule({ categoryId: 'category-other' }), criteria)).toBe(false);
  });

  it('compares language case-insensitively', () => {
    expect(ruleMatches(rule({ language: 'EN' }), criteria)).toBe(true);
    expect(ruleMatches(rule({ language: 'sn' }), criteria)).toBe(false);
  });

  it('never matches an inactive rule', () => {
    expect(ruleMatches(rule({ isActive: false }), criteria)).toBe(false);
  });

  it('treats a null category on the ticket as unmatchable by a category rule', () => {
    const uncategorised = { ...criteria, categoryId: null };
    expect(ruleMatches(rule({ categoryId: 'category-transfer' }), uncategorised)).toBe(false);
    expect(ruleMatches(rule(), uncategorised)).toBe(true);
  });
});

describe('decide', () => {
  it('takes the first rule in the order given, not the most specific', () => {
    const broad = rule({ id: 'broad', assignToTeamId: 'team-general', sortOrder: 10 });
    const narrow = rule({
      id: 'narrow',
      productId: 'product-wallet',
      assignToTeamId: 'team-wallet',
      sortOrder: 20,
    });

    expect(decide([broad, narrow], criteria, null).rule?.id).toBe('broad');
    expect(decide([narrow, broad], criteria, null).rule?.id).toBe('narrow');
  });

  it('skips rules that do not match', () => {
    const other = rule({ id: 'other', productId: 'product-lending' });
    const mine = rule({ id: 'mine', productId: 'product-wallet', assignToTeamId: 'team-wallet' });

    const decision = decide([other, mine], criteria, null);
    expect(decision.rule?.id).toBe('mine');
    expect(decision.teamId).toBe('team-wallet');
  });

  it('falls back to the product default team when nothing matches', () => {
    const decision = decide([rule({ productId: 'product-lending' })], criteria, 'team-default');
    expect(decision.rule).toBeNull();
    expect(decision.teamId).toBe('team-default');
    expect(decision.requiredSkill).toBeNull();
  });

  it('keeps the default team when a matching rule names only a skill', () => {
    const decision = decide([rule({ requiredSkill: 'chargebacks' })], criteria, 'team-default');
    expect(decision.teamId).toBe('team-default');
    expect(decision.requiredSkill).toBe('chargebacks');
  });
});

describe('isEligible', () => {
  const options = { allowAway: false };

  it('accepts an online agent with capacity', () => {
    expect(isEligible(agent(), options)).toBe(true);
  });

  it('rejects an offline agent', () => {
    expect(isEligible(agent({ availability: 'offline' }), options)).toBe(false);
  });

  it('rejects an away agent unless away agents are allowed', () => {
    expect(isEligible(agent({ availability: 'away' }), options)).toBe(false);
    expect(isEligible(agent({ availability: 'away' }), { allowAway: true })).toBe(true);
  });

  it('rejects an agent at capacity', () => {
    expect(isEligible(agent({ openTickets: 20, maxOpenTickets: 20 }), options)).toBe(false);
    expect(isEligible(agent({ openTickets: 19, maxOpenTickets: 20 }), options)).toBe(true);
  });

  it('rejects an agent lacking a required skill', () => {
    expect(isEligible(agent(), { ...options, requiredSkill: 'chargebacks' })).toBe(false);
    expect(
      isEligible(agent({ skillProficiency: 3 }), { ...options, requiredSkill: 'chargebacks' }),
    ).toBe(true);
  });

  it('rejects an agent outside a named team', () => {
    expect(isEligible(agent({ teamIds: ['team-b'] }), { ...options, teamId: 'team-a' })).toBe(
      false,
    );
    expect(
      isEligible(agent({ teamIds: ['team-a', 'team-b'] }), { ...options, teamId: 'team-a' }),
    ).toBe(true);
  });
});

describe('chooseAgent', () => {
  const options = { allowAway: false };

  it('prefers the least loaded agent', () => {
    const busy = agent({ userId: 'busy', openTickets: 8 });
    const free = agent({ userId: 'free', openTickets: 1 });

    expect(chooseAgent([busy, free], options)?.userId).toBe('free');
  });

  it('compares load as a share of each agent’s own limit', () => {
    // 4/5 is busier than 6/20, even though the raw count is lower.
    const partTime = agent({ userId: 'part-time', openTickets: 4, maxOpenTickets: 5 });
    const fullTime = agent({ userId: 'full-time', openTickets: 6, maxOpenTickets: 20 });

    expect(chooseAgent([partTime, fullTime], options)?.userId).toBe('full-time');
  });

  it('breaks a load tie on skill', () => {
    const novice = agent({ userId: 'novice', skillProficiency: 2 });
    const expert = agent({ userId: 'expert', skillProficiency: 5 });

    expect(chooseAgent([novice, expert], options)?.userId).toBe('expert');
  });

  it('round-robins on least-recently-assigned when load and skill tie', () => {
    const recent = agent({ userId: 'recent', lastAssignedAt: new Date('2026-03-02T10:00:00Z') });
    const stale = agent({ userId: 'stale', lastAssignedAt: new Date('2026-03-02T08:00:00Z') });

    expect(chooseAgent([recent, stale], options)?.userId).toBe('stale');
  });

  it('treats never-assigned as the least recently assigned', () => {
    const seen = agent({ userId: 'seen', lastAssignedAt: new Date('2026-03-02T08:00:00Z') });
    const fresh = agent({ userId: 'fresh', lastAssignedAt: null });

    expect(chooseAgent([seen, fresh], options)?.userId).toBe('fresh');
  });

  it('is deterministic when everything ties', () => {
    const first = agent({ userId: 'aaa' });
    const second = agent({ userId: 'bbb' });

    expect(chooseAgent([second, first], options)?.userId).toBe('aaa');
    expect(chooseAgent([first, second], options)?.userId).toBe('aaa');
  });

  it('returns null rather than assigning to an ineligible agent', () => {
    expect(chooseAgent([agent({ availability: 'offline' })], options)).toBeNull();
    expect(chooseAgent([], options)).toBeNull();
  });

  it('does not mutate the array it was given', () => {
    const candidates = [agent({ userId: 'bbb' }), agent({ userId: 'aaa' })];
    chooseAgent(candidates, options);
    expect(candidates.map((entry) => entry.userId)).toEqual(['bbb', 'aaa']);
  });
});

describe('chooseAgentWithFallback', () => {
  const options = { allowAway: false };

  it('reports no relaxation when the exact constraints are met', () => {
    const candidate = agent({ teamIds: ['team-a'], skillProficiency: 3 });

    expect(
      chooseAgentWithFallback([candidate], {
        ...options,
        teamId: 'team-a',
        requiredSkill: 'chargebacks',
      }),
    ).toEqual({ agent: candidate, relaxed: 'none' });
  });

  it('drops the team before the skill', () => {
    // Holds the skill but is on another team.
    const outsider = agent({ userId: 'outsider', teamIds: ['team-b'], skillProficiency: 4 });

    const result = chooseAgentWithFallback([outsider], {
      ...options,
      teamId: 'team-a',
      requiredSkill: 'chargebacks',
    });

    expect(result.agent?.userId).toBe('outsider');
    expect(result.relaxed).toBe('team');
  });

  it('drops the skill only when dropping the team was not enough', () => {
    const unskilled = agent({ userId: 'unskilled', teamIds: ['team-b'], skillProficiency: null });

    const result = chooseAgentWithFallback([unskilled], {
      ...options,
      teamId: 'team-a',
      requiredSkill: 'chargebacks',
    });

    expect(result.agent?.userId).toBe('unskilled');
    expect(result.relaxed).toBe('team_and_skill');
  });

  it('never relaxes availability or capacity', () => {
    const offline = agent({ userId: 'offline', availability: 'offline', skillProficiency: 5 });
    const full = agent({ userId: 'full', openTickets: 20, maxOpenTickets: 20 });

    expect(
      chooseAgentWithFallback([offline, full], {
        ...options,
        teamId: 'team-a',
        requiredSkill: 'chargebacks',
      }),
    ).toEqual({ agent: null, relaxed: 'none' });
  });
});

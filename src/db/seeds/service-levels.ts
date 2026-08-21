import { eq, isNull, sql } from 'drizzle-orm';
import { env } from '../../config/index.js';
import { createModuleLogger } from '../../lib/logger/index.js';
import { escalationRules } from '../../modules/escalation/escalation.model.js';
import { products } from '../../modules/product/product.model.js';
import { routingRules } from '../../modules/routing/routing.model.js';
import { businessHours, holidays, slaPolicies } from '../../modules/sla/sla.model.js';
import { teamMembers, teams } from '../../modules/team/team.model.js';
// From the model, not the module's types file: the boundary rules let `db`
// reach a module's table definitions (schema.ts barrels them) and nothing else.
import type { TicketPriority } from '../../modules/ticket/ticket.model.js';
import { users } from '../../modules/user/user.model.js';
import { db } from '../client.js';

const log = createModuleLogger('db:seed');

const DEFAULT_CALENDAR_NAME = 'Zimbabwe office hours';
const DEFAULT_TEAM_NAME = 'Support Desk';

/**
 * Monday to Friday, 08:00–17:00, Harare. `day` is 0 = Sunday.
 *
 * A single unbroken window rather than a lunch break: the desk is staffed
 * through lunch, and a calendar that closes at 13:00 would quietly extend every
 * deadline by an hour.
 */
const WORKING_WEEK = [1, 2, 3, 4, 5].map((day) => ({
  day,
  opensAt: '08:00',
  closesAt: '17:00',
}));

/**
 * Default targets, in minutes of *working* time.
 *
 * Resolution figures are deliberately round numbers of working days at nine
 * hours a day: 540 is one day, 1620 is three. An administrator will replace
 * these with whatever the business has actually committed to.
 */
const DEFAULT_POLICIES: {
  priority: TicketPriority;
  firstResponseMinutes: number;
  resolutionMinutes: number;
}[] = [
  { priority: 'urgent', firstResponseMinutes: 15, resolutionMinutes: 240 },
  { priority: 'high', firstResponseMinutes: 30, resolutionMinutes: 540 },
  { priority: 'normal', firstResponseMinutes: 120, resolutionMinutes: 1620 },
  { priority: 'low', firstResponseMinutes: 480, resolutionMinutes: 2700 },
];

/** Easter Sunday, by the anonymous Gregorian algorithm. */
function easterSunday(year: number): Date {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;

  return new Date(Date.UTC(year, month - 1, day));
}

function isoDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function addDays(value: Date, days: number): Date {
  return new Date(value.getTime() + days * 86_400_000);
}

/** The nth given weekday of a month; used for the August holidays. */
function nthWeekdayOfMonth(year: number, month: number, weekday: number, nth: number): Date {
  let seen = 0;

  for (let day = 1; day <= 31; day += 1) {
    const candidate = new Date(Date.UTC(year, month - 1, day));
    if (candidate.getUTCMonth() !== month - 1) break;

    if (candidate.getUTCDay() === weekday) {
      seen += 1;
      if (seen === nth) return candidate;
    }
  }

  throw new Error(`no ${nth}th weekday ${weekday} in ${year}-${month}`);
}

/**
 * Zimbabwe's public holidays for one year.
 *
 * The movable ones are computed rather than listed, so the seed stays correct in
 * later years instead of silently running out of holidays. Where a holiday falls
 * on a Sunday the following Monday is also a holiday in practice; that is left
 * to whoever runs the desk, via `POST /business-hours/:id/holidays`.
 */
function zimbabweHolidays(year: number): { observedOn: string; name: string }[] {
  const easter = easterSunday(year);
  const heroes = nthWeekdayOfMonth(year, 8, 1, 2);

  return [
    { observedOn: `${year}-01-01`, name: "New Year's Day" },
    { observedOn: `${year}-02-18`, name: 'Robert Gabriel Mugabe National Youth Day' },
    { observedOn: isoDate(addDays(easter, -2)), name: 'Good Friday' },
    { observedOn: isoDate(addDays(easter, -1)), name: 'Easter Saturday' },
    { observedOn: isoDate(addDays(easter, 1)), name: 'Easter Monday' },
    { observedOn: `${year}-04-18`, name: 'Independence Day' },
    { observedOn: `${year}-05-01`, name: "Workers' Day" },
    { observedOn: `${year}-05-25`, name: 'Africa Day' },
    { observedOn: isoDate(heroes), name: "Heroes' Day" },
    { observedOn: isoDate(addDays(heroes, 1)), name: 'Defence Forces Day' },
    { observedOn: `${year}-12-22`, name: 'Unity Day' },
    { observedOn: `${year}-12-25`, name: 'Christmas Day' },
    { observedOn: `${year}-12-26`, name: 'Boxing Day' },
  ];
}

/**
 * Service-level configuration: the working calendar, its holidays, a default
 * SLA policy per product and priority, and a routing and escalation default
 * that make a fresh deployment behave sensibly rather than inertly.
 *
 * Idempotent, like the other seeds: safe to run on every deploy. Nothing here
 * overwrites a value an administrator has since changed — each step either
 * inserts or leaves well alone.
 */
export async function seedServiceLevels(): Promise<void> {
  const calendarId = await seedCalendar();
  await seedHolidays(calendarId);
  const teamId = await seedDefaultTeam();
  await seedPolicies(calendarId);
  await seedRoutingDefault(teamId);
  await seedEscalationLadder(teamId);
}

async function seedCalendar(): Promise<string> {
  const [calendar] = await db
    .insert(businessHours)
    .values({
      name: DEFAULT_CALENDAR_NAME,
      timezone: env.DEFAULT_TIMEZONE,
      weekly: WORKING_WEEK,
      isDefault: true,
    })
    .onConflictDoUpdate({
      target: businessHours.name,
      // The week is editable through the API, so the seed must not stamp on it.
      set: { updatedAt: sql`now()` },
    })
    .returning();

  if (!calendar) throw new Error('failed to upsert the default business-hours calendar');

  log.info('business hours seeded', {
    name: calendar.name,
    timezone: calendar.timezone,
    openMinutesPerWeek: WORKING_WEEK.length * 9 * 60,
  });

  return calendar.id;
}

async function seedHolidays(calendarId: string): Promise<void> {
  const thisYear = new Date().getUTCFullYear();
  let inserted = 0;

  // This year and next, so a deployment in December does not spend January with
  // no holidays on the calendar.
  for (const year of [thisYear, thisYear + 1]) {
    for (const holiday of zimbabweHolidays(year)) {
      const result = await db
        .insert(holidays)
        .values({ businessHoursId: calendarId, ...holiday })
        .onConflictDoNothing()
        .returning({ id: holidays.id });

      inserted += result.length;
    }
  }

  log.info('holidays seeded', { years: [thisYear, thisYear + 1], inserted });
}

/**
 * One team, so the routing and escalation defaults below have somewhere to point.
 * The seeded administrator is its lead — on a fresh deployment they are the only
 * person who exists.
 */
async function seedDefaultTeam(): Promise<string> {
  const [team] = await db
    .insert(teams)
    .values({
      name: DEFAULT_TEAM_NAME,
      description: 'First line of response for every product',
    })
    .onConflictDoUpdate({ target: teams.name, set: { updatedAt: sql`now()` } })
    .returning();

  if (!team) throw new Error('failed to upsert the default team');

  const [administrator] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, env.SEED_ADMIN_EMAIL.toLowerCase()))
    .limit(1);

  if (administrator) {
    await db
      .insert(teamMembers)
      .values({ teamId: team.id, userId: administrator.id, isLead: true })
      .onConflictDoNothing();
  }

  // Only where a product has no team yet: reassigning a product's default team
  // is an operational decision, not the seed's.
  await db.update(products).set({ defaultTeamId: team.id }).where(isNull(products.defaultTeamId));

  log.info('default team seeded', { name: team.name });
  return team.id;
}

async function seedPolicies(calendarId: string): Promise<void> {
  const catalogue = await db.select({ id: products.id, code: products.code }).from(products);
  let inserted = 0;

  for (const product of catalogue) {
    for (const policy of DEFAULT_POLICIES) {
      const result = await db
        .insert(slaPolicies)
        .values({
          productId: product.id,
          priority: policy.priority,
          firstResponseMinutes: policy.firstResponseMinutes,
          resolutionMinutes: policy.resolutionMinutes,
          businessHoursId: calendarId,
        })
        .onConflictDoNothing()
        .returning({ id: slaPolicies.id });

      inserted += result.length;
    }
  }

  log.info('sla policies seeded', { products: catalogue.length, inserted });
}

/**
 * A single catch-all rule: everything goes to the desk. It matches every ticket
 * because every criterion is null, and sits at a high `sortOrder` so any rule
 * added later is evaluated first.
 */
async function seedRoutingDefault(teamId: string): Promise<void> {
  const existing = await db.select({ id: routingRules.id }).from(routingRules).limit(1);
  if (existing.length > 0) return;

  await db.insert(routingRules).values({
    name: 'Default — everything to the Support Desk',
    assignToTeamId: teamId,
    sortOrder: 1000,
  });

  log.info('default routing rule seeded');
}

/**
 * A two-rung ladder: warn the desk before the deadline, act on it afterwards.
 *
 * Seeded only when no rules exist at all, so an operation that has designed its
 * own ladder never has this one reappear underneath it.
 */
async function seedEscalationLadder(teamId: string): Promise<void> {
  const existing = await db.select({ id: escalationRules.id }).from(escalationRules).limit(1);
  if (existing.length > 0) return;

  await db.insert(escalationRules).values([
    {
      name: 'Warn the desk at 80% of the first-response SLA',
      targetKind: 'first_response',
      thresholdPercent: 80,
      action: 'notify',
      notifyTeamId: teamId,
      sortOrder: 10,
    },
    {
      name: 'On any breach, tell the desk and raise the priority',
      thresholdPercent: 100,
      action: 'notify',
      notifyTeamId: teamId,
      raisePriority: true,
      sortOrder: 20,
    },
  ]);

  log.info('default escalation ladder seeded');
}

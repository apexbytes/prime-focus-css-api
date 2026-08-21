import { AppError } from '../../common/errors/index.js';
import type { BusinessHoursWindow } from './sla.model.js';

/**
 * Business-hours arithmetic: the whole of it, with no I/O and no dependencies.
 *
 * Every function here is pure so the awkward cases — a ticket raised at 16:55 on
 * the Friday before a public holiday — are unit-testable without a database.
 *
 * Two rules hold throughout:
 *
 *   - Instants crossing this boundary are UTC. Windows are wall-clock time in
 *     the calendar's own zone, so the conversion happens here and nowhere else.
 *   - Zone conversion goes through `Intl`, not a fixed offset. Africa/Harare has
 *     no daylight saving today, but hardcoding UTC+2 would make the first
 *     calendar in another zone silently wrong rather than obviously wrong.
 */

/** A working calendar, flattened from `business_hours` plus its holidays. */
export interface BusinessCalendar {
  /** IANA zone name, e.g. `Africa/Harare`. */
  timezone: string;
  weekly: readonly BusinessHoursWindow[];
  /**
   * Non-working local dates as `YYYY-MM-DD`. A set, because the day walk below
   * asks about membership once per day and nothing else.
   */
  holidays: ReadonlySet<string>;
}

/** A local calendar date, with no time and no zone attached. */
interface LocalDate {
  year: number;
  month: number;
  day: number;
}

interface Window {
  /** Minutes from local midnight. */
  startMinute: number;
  endMinute: number;
}

const MINUTE_MS = 60_000;
const DAY_MINUTES = 1440;

/**
 * How far the walk will look for enough open time before giving up. Two years
 * is far past any real SLA and still terminates promptly on a calendar whose
 * windows are all unusable.
 */
const MAX_LOOKAHEAD_DAYS = 730;

/** Ceiling on the elapsed-time walk, so a stale ticket cannot spin. */
const MAX_ELAPSED_DAYS = 1_000;

// -- zone conversion ---------------------------------------------------------

/** `Intl.DateTimeFormat` construction is expensive; one per zone is plenty. */
const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  const cached = formatters.get(timeZone);
  if (cached) return cached;

  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  } catch {
    throw AppError.validation('Unknown time zone', {
      details: [{ field: 'timezone', issue: `${timeZone} is not an IANA time zone` }],
    });
  }

  formatters.set(timeZone, formatter);
  return formatter;
}

interface ZonedParts extends LocalDate {
  hour: number;
  minute: number;
  second: number;
}

/** The wall-clock reading of an instant in a given zone. */
function zonedParts(instant: Date, timeZone: string): ZonedParts {
  const parts = formatterFor(timeZone).formatToParts(instant);
  const read = (type: Intl.DateTimeFormatPartTypes): number => {
    const part = parts.find((candidate) => candidate.type === type);
    return part ? Number(part.value) : 0;
  };

  return {
    year: read('year'),
    month: read('month'),
    day: read('day'),
    // Some ICU builds render midnight as hour 24 under hour12:false.
    hour: read('hour') % 24,
    minute: read('minute'),
    second: read('second'),
  };
}

/** The zone's offset from UTC at a given instant, in milliseconds. */
function offsetMsAt(instant: Date, timeZone: string): number {
  const parts = zonedParts(instant, timeZone);
  const asIfUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );

  // The formatter has no sub-second resolution, so compare against whole seconds.
  return asIfUtc - Math.floor(instant.getTime() / 1000) * 1000;
}

/**
 * The UTC instant of a local date plus an offset in minutes from its midnight.
 *
 * Resolved twice on purpose: the offset that applies is the one at the *result*,
 * not at the naive guess, and those differ across a daylight-saving boundary.
 */
function utcFromLocal(date: LocalDate, minuteOfDay: number, timeZone: string): Date {
  const naive = Date.UTC(date.year, date.month - 1, date.day) + minuteOfDay * MINUTE_MS;

  const firstGuess = offsetMsAt(new Date(naive), timeZone);
  let utc = naive - firstGuess;

  const settled = offsetMsAt(new Date(utc), timeZone);
  if (settled !== firstGuess) utc = naive - settled;

  return new Date(utc);
}

function localDateOf(instant: Date, timeZone: string): LocalDate {
  const { year, month, day } = zonedParts(instant, timeZone);
  return { year, month, day };
}

function nextLocalDate(date: LocalDate): LocalDate {
  // Via Date.UTC so month lengths and leap years are the calendar's problem.
  const next = new Date(Date.UTC(date.year, date.month - 1, date.day + 1));
  return {
    year: next.getUTCFullYear(),
    month: next.getUTCMonth() + 1,
    day: next.getUTCDate(),
  };
}

function dayOfWeek(date: LocalDate): number {
  return new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay();
}

/** `YYYY-MM-DD`, the form holidays are stored and compared in. */
export function localDateKey(date: LocalDate): string {
  const month = String(date.month).padStart(2, '0');
  const day = String(date.day).padStart(2, '0');
  return `${date.year}-${month}-${day}`;
}

// -- window parsing ----------------------------------------------------------

/**
 * `HH:MM` to minutes past midnight. `24:00` is accepted as the end of a day, so
 * a round-the-clock calendar can be written without a sentinel.
 */
export function parseTimeOfDay(value: string): number | null {
  const match = /^(\d{1,2}):([0-5]\d)$/.exec(value.trim());
  if (!match) return null;

  const hour = Number(match[1]);
  const minute = Number(match[2]);
  const total = hour * 60 + minute;

  if (total > DAY_MINUTES) return null;
  return total;
}

/**
 * The usable windows for one weekday, sorted and with nonsense dropped: a window
 * that ends before it starts would otherwise consume negative time.
 */
function windowsForDay(weekly: readonly BusinessHoursWindow[], day: number): Window[] {
  const windows: Window[] = [];

  for (const entry of weekly) {
    if (entry.day !== day) continue;

    const startMinute = parseTimeOfDay(entry.opensAt);
    const endMinute = parseTimeOfDay(entry.closesAt);
    if (startMinute === null || endMinute === null) continue;
    if (endMinute <= startMinute) continue;

    windows.push({ startMinute, endMinute });
  }

  return windows.sort((left, right) => left.startMinute - right.startMinute);
}

/** Total open minutes in a week. Zero means no deadline can ever be met. */
export function weeklyOpenMinutes(weekly: readonly BusinessHoursWindow[]): number {
  let total = 0;
  for (let day = 0; day < 7; day += 1) {
    for (const window of windowsForDay(weekly, day)) {
      total += window.endMinute - window.startMinute;
    }
  }
  return total;
}

function isWorkingDay(date: LocalDate, calendar: BusinessCalendar): boolean {
  return !calendar.holidays.has(localDateKey(date));
}

// -- the arithmetic ----------------------------------------------------------

/**
 * The instant `minutes` of working time after `from`.
 *
 * Time outside a window does not count, so a one-hour target set at 16:40 on a
 * Friday falls on Monday morning rather than Friday evening. Time already inside
 * a window counts from `from` itself, not from the window's start.
 */
export function addBusinessMinutes(from: Date, minutes: number, calendar: BusinessCalendar): Date {
  if (minutes <= 0) return new Date(from.getTime());

  assertUsable(calendar);

  let remainingMs = minutes * MINUTE_MS;
  let cursor = from.getTime();
  let date = localDateOf(from, calendar.timezone);

  for (let walked = 0; walked <= MAX_LOOKAHEAD_DAYS; walked += 1) {
    if (isWorkingDay(date, calendar)) {
      for (const window of windowsForDay(calendar.weekly, dayOfWeek(date))) {
        const opens = utcFromLocal(date, window.startMinute, calendar.timezone).getTime();
        const closes = utcFromLocal(date, window.endMinute, calendar.timezone).getTime();

        // Already past this window, or not yet in it: either way, start where the
        // window does unless the cursor is further along.
        const segmentStart = Math.max(opens, cursor);
        if (segmentStart >= closes) continue;

        const availableMs = closes - segmentStart;
        if (availableMs >= remainingMs) return new Date(segmentStart + remainingMs);

        remainingMs -= availableMs;
        cursor = closes;
      }
    }

    date = nextLocalDate(date);
    // Resume at the top of the next local day rather than at `closes`, so a
    // window on the following day is not skipped by a stale cursor.
    cursor = Math.max(cursor, utcFromLocal(date, 0, calendar.timezone).getTime());
  }

  // Reachable only if the calendar is open for a vanishing amount of time
  // relative to the target, which is a configuration error, not a runtime one.
  throw AppError.validation('This calendar has too little open time to meet that target', {
    details: [
      { field: 'targetMinutes', issue: `${minutes} minutes exceeds ${MAX_LOOKAHEAD_DAYS} days` },
    ],
  });
}

/**
 * Working minutes between two instants, counting only time inside a window.
 *
 * Used for "how much of the SLA has been consumed", and for converting a pause
 * that spanned a weekend into the working time it actually cost.
 */
export function businessMinutesBetween(from: Date, to: Date, calendar: BusinessCalendar): number {
  const start = from.getTime();
  const end = to.getTime();
  if (end <= start) return 0;

  let totalMs = 0;
  let date = localDateOf(from, calendar.timezone);

  for (let walked = 0; walked <= MAX_ELAPSED_DAYS; walked += 1) {
    const dayStart = utcFromLocal(date, 0, calendar.timezone).getTime();
    if (dayStart > end) break;

    if (isWorkingDay(date, calendar)) {
      for (const window of windowsForDay(calendar.weekly, dayOfWeek(date))) {
        const opens = utcFromLocal(date, window.startMinute, calendar.timezone).getTime();
        const closes = utcFromLocal(date, window.endMinute, calendar.timezone).getTime();

        const overlap = Math.min(closes, end) - Math.max(opens, start);
        if (overlap > 0) totalMs += overlap;
      }
    }

    date = nextLocalDate(date);
  }

  return Math.round(totalMs / MINUTE_MS);
}

/**
 * How much of a target has been used, as a fraction: `1` is exactly on the
 * deadline and above `1` is overdue.
 *
 * Measured *backwards from `dueAt`*, not forwards from the start. `dueAt` is the
 * one authoritative statement of the deadline — it is what the breach scan
 * compares against, and it is what pausing moves — so deriving consumption from
 * anything else would let the two disagree. They did in an earlier version of
 * this function: a target could be past `dueAt`, and so breached, while an
 * elapsed-time calculation still put it under 100% and no escalation rung fired.
 *
 * Pausing needs no special arithmetic here beyond freezing the clock, because
 * `dueAt` has already absorbed the pause by the time the clock restarts.
 */
export function consumedFraction(
  input: {
    targetMinutes: number;
    dueAt: Date;
    /** Set while the clock is stopped; consumption freezes at that moment. */
    pausedAt: Date | null;
  },
  now: Date,
  calendar: BusinessCalendar,
): number {
  if (input.targetMinutes <= 0) return 1;

  const at = input.pausedAt ?? now;

  if (at.getTime() >= input.dueAt.getTime()) {
    const overdue = businessMinutesBetween(input.dueAt, at, calendar);
    return 1 + overdue / input.targetMinutes;
  }

  const remaining = businessMinutesBetween(at, input.dueAt, calendar);
  return (input.targetMinutes - remaining) / input.targetMinutes;
}

function assertUsable(calendar: BusinessCalendar): void {
  if (weeklyOpenMinutes(calendar.weekly) === 0) {
    throw AppError.validation('This calendar has no open hours', {
      details: [{ field: 'weekly', issue: 'at least one window is required' }],
    });
  }
}

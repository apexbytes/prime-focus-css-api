/**
 * Reporting windows.
 *
 * Pure, so the date arithmetic that decides which rows a dashboard sees can be
 * tested without a database. The whole file exists because the reporting views
 * are bucketed by *local* calendar day and the API takes instants: getting the
 * conversion wrong shifts every number in every report by up to two hours'
 * worth of tickets, silently.
 */

/** Default window when the caller names none. A month is what a dashboard shows. */
export const DEFAULT_WINDOW_DAYS = 30;

/**
 * Longest window accepted. A year and a day, so "the last 12 months" and "this
 * calendar year plus today" both fit, and an unbounded scan of every day the
 * system has ever run does not.
 */
export const MAX_WINDOW_DAYS = 366;

const DAY_MS = 86_400_000;

export interface ReportRange {
  /** Inclusive, `YYYY-MM-DD` in the reporting timezone. */
  fromDay: string;
  /** Inclusive. */
  toDay: string;
  /** Days spanned, inclusive of both ends. */
  days: number;
}

/**
 * The local calendar date an instant falls on.
 *
 * `en-CA` because its short date format is ISO `YYYY-MM-DD`, which is what the
 * `day` column of every reporting view holds — building the string from parts by
 * hand is how off-by-one-month bugs get in.
 */
export function toLocalDay(instant: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(instant);
}

/**
 * Resolves the window a report covers.
 *
 * Both ends are inclusive: a caller asking for `from=2026-08-01&to=2026-08-01`
 * means that day, not an empty range. An unbounded request becomes the last
 * `DEFAULT_WINDOW_DAYS`, and a window longer than `MAX_WINDOW_DAYS` is clamped
 * forward from `to` rather than refused — a dashboard asking for too much should
 * get the recent end of it, not an error.
 */
export function resolveRange(
  input: { from?: Date | undefined; to?: Date | undefined },
  timeZone: string,
  now: Date = new Date(),
): ReportRange {
  const end = input.to ?? now;
  const start = input.from ?? new Date(end.getTime() - (DEFAULT_WINDOW_DAYS - 1) * DAY_MS);

  // A reversed range is a client bug, and answering it with nothing hides the
  // bug. Swapping is the reading the caller obviously meant.
  const [lower, upper] = start.getTime() <= end.getTime() ? [start, end] : [end, start];

  let fromDay = toLocalDay(lower, timeZone);
  const toDay = toLocalDay(upper, timeZone);

  let days = daysBetween(fromDay, toDay);
  if (days > MAX_WINDOW_DAYS) {
    fromDay = shiftDay(toDay, -(MAX_WINDOW_DAYS - 1));
    days = MAX_WINDOW_DAYS;
  }

  return { fromDay, toDay, days };
}

/** Inclusive day count between two `YYYY-MM-DD` strings. */
export function daysBetween(fromDay: string, toDay: string): number {
  return (
    Math.round((Date.parse(`${toDay}T00:00:00Z`) - Date.parse(`${fromDay}T00:00:00Z`)) / DAY_MS) + 1
  );
}

/** `YYYY-MM-DD` shifted by whole days, staying in the same calendar. */
export function shiftDay(day: string, delta: number): string {
  const shifted = new Date(Date.parse(`${day}T00:00:00Z`) + delta * DAY_MS);
  return shifted.toISOString().slice(0, 10);
}

/**
 * A ratio, or null when the denominator is zero.
 *
 * Null rather than 0: "no tickets had an SLA" and "every ticket breached" are
 * different facts, and a dashboard that renders 0% for the first one is lying.
 */
export function ratio(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : numerator / denominator;
}

/** Rounds a ratio to a whole percentage, preserving the null. */
export function percent(value: number | null): number | null {
  return value === null ? null : Math.round(value * 100);
}

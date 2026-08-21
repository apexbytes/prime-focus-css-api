import { describe, expect, it } from 'vitest';
import {
  DEFAULT_WINDOW_DAYS,
  MAX_WINDOW_DAYS,
  daysBetween,
  percent,
  ratio,
  resolveRange,
  shiftDay,
  toLocalDay,
} from './report.range.js';

const HARARE = 'Africa/Harare';

describe('toLocalDay', () => {
  it('buckets by the local calendar day, not the UTC one', () => {
    // 22:30 UTC is already the next day in Harare (UTC+2). A report that
    // bucketed by UTC would put this ticket on the wrong day.
    expect(toLocalDay(new Date('2026-08-20T22:30:00Z'), HARARE)).toBe('2026-08-21');
    expect(toLocalDay(new Date('2026-08-20T22:30:00Z'), 'UTC')).toBe('2026-08-20');
  });

  it('formats single-digit months and days with a leading zero', () => {
    expect(toLocalDay(new Date('2026-01-05T09:00:00Z'), HARARE)).toBe('2026-01-05');
  });
});

describe('resolveRange', () => {
  const now = new Date('2026-08-21T09:00:00Z');

  it('defaults to a month ending today, both ends inclusive', () => {
    const range = resolveRange({}, HARARE, now);

    expect(range.toDay).toBe('2026-08-21');
    expect(range.days).toBe(DEFAULT_WINDOW_DAYS);
    expect(range.fromDay).toBe('2026-07-23');
  });

  it('treats a single day as that day rather than an empty range', () => {
    const day = new Date('2026-08-10T12:00:00Z');
    const range = resolveRange({ from: day, to: day }, HARARE, now);

    expect(range).toEqual({ fromDay: '2026-08-10', toDay: '2026-08-10', days: 1 });
  });

  it('swaps a reversed range instead of answering with nothing', () => {
    const range = resolveRange(
      { from: new Date('2026-08-20T00:00:00Z'), to: new Date('2026-08-01T00:00:00Z') },
      HARARE,
      now,
    );

    expect(range.fromDay).toBe('2026-08-01');
    expect(range.toDay).toBe('2026-08-20');
  });

  it('clamps an over-long window to the recent end of it', () => {
    const range = resolveRange(
      { from: new Date('2020-01-01T00:00:00Z'), to: new Date('2026-08-21T00:00:00Z') },
      HARARE,
      now,
    );

    expect(range.days).toBe(MAX_WINDOW_DAYS);
    expect(range.toDay).toBe('2026-08-21');
    // The window ends where it was asked to; it is the start that moved.
    expect(range.fromDay).toBe('2025-08-21');
  });
});

describe('daysBetween and shiftDay', () => {
  it('counts both ends', () => {
    expect(daysBetween('2026-08-01', '2026-08-01')).toBe(1);
    expect(daysBetween('2026-08-01', '2026-08-31')).toBe(31);
  });

  it('crosses month and year boundaries', () => {
    expect(shiftDay('2026-03-01', -1)).toBe('2026-02-28');
    expect(shiftDay('2026-01-01', -1)).toBe('2025-12-31');
    expect(shiftDay('2028-03-01', -1)).toBe('2028-02-29');
  });
});

describe('ratio and percent', () => {
  it('distinguishes "nothing measured" from "nothing succeeded"', () => {
    expect(ratio(0, 0)).toBeNull();
    expect(ratio(0, 10)).toBe(0);
    expect(percent(null)).toBeNull();
    expect(percent(0)).toBe(0);
  });

  it('rounds to whole percentages', () => {
    expect(percent(ratio(2, 3))).toBe(67);
  });
});

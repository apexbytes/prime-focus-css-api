import { describe, expect, it } from 'vitest';
import {
  addBusinessMinutes,
  businessMinutesBetween,
  consumedFraction,
  localDateKey,
  parseTimeOfDay,
  weeklyOpenMinutes,
  type BusinessCalendar,
} from './sla.clock.js';

/**
 * Dates are written with an explicit offset so the fixture says what local time
 * it means, and asserted in UTC so a wrong offset cannot pass by accident.
 *
 * Africa/Harare is UTC+2 all year: 08:00 local is 06:00Z.
 */
const at = (value: string): Date => new Date(value);

/** Mon–Fri, 08:00–17:00, Harare. The calendar the seed installs. */
const officeHours = (holidays: string[] = []): BusinessCalendar => ({
  timezone: 'Africa/Harare',
  weekly: [1, 2, 3, 4, 5].map((day) => ({ day, opensAt: '08:00', closesAt: '17:00' })),
  holidays: new Set(holidays),
});

const roundTheClock: BusinessCalendar = {
  timezone: 'Africa/Harare',
  weekly: [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, opensAt: '00:00', closesAt: '24:00' })),
  holidays: new Set(),
};

/** Mon–Fri with an hour closed for lunch. */
const splitDay: BusinessCalendar = {
  timezone: 'Africa/Harare',
  weekly: [1, 2, 3, 4, 5].flatMap((day) => [
    { day, opensAt: '08:00', closesAt: '12:00' },
    { day, opensAt: '13:00', closesAt: '17:00' },
  ]),
  holidays: new Set(),
};

describe('parseTimeOfDay', () => {
  it('reads HH:MM as minutes past midnight', () => {
    expect(parseTimeOfDay('08:00')).toBe(480);
    expect(parseTimeOfDay('00:00')).toBe(0);
    expect(parseTimeOfDay('17:30')).toBe(1050);
  });

  it('accepts 24:00 as the end of a day, so a 24-hour calendar is expressible', () => {
    expect(parseTimeOfDay('24:00')).toBe(1440);
  });

  it('rejects anything that is not a real time of day', () => {
    expect(parseTimeOfDay('25:00')).toBeNull();
    expect(parseTimeOfDay('08:60')).toBeNull();
    expect(parseTimeOfDay('8')).toBeNull();
    expect(parseTimeOfDay('lunchtime')).toBeNull();
  });
});

describe('weeklyOpenMinutes', () => {
  it('totals a five-day nine-hour week', () => {
    expect(weeklyOpenMinutes(officeHours().weekly)).toBe(5 * 9 * 60);
  });

  it('discounts the lunch break', () => {
    expect(weeklyOpenMinutes(splitDay.weekly)).toBe(5 * 8 * 60);
  });

  it('ignores a window that ends before it starts', () => {
    expect(weeklyOpenMinutes([{ day: 1, opensAt: '17:00', closesAt: '08:00' }])).toBe(0);
  });
});

describe('addBusinessMinutes', () => {
  it('stays inside the working day when there is room', () => {
    // Monday 09:00 + 1h = 10:00, same day.
    const due = addBusinessMinutes(at('2026-03-02T09:00:00+02:00'), 60, officeHours());
    expect(due.toISOString()).toBe('2026-03-02T08:00:00.000Z');
  });

  it('starts the clock at opening time for a ticket raised overnight', () => {
    // 06:00 is before the doors open: the 30 minutes run from 08:00.
    const due = addBusinessMinutes(at('2026-03-02T06:00:00+02:00'), 30, officeHours());
    expect(due.toISOString()).toBe('2026-03-02T06:30:00.000Z');
  });

  it('rolls a ticket raised after hours to the next morning', () => {
    const due = addBusinessMinutes(at('2026-03-02T18:00:00+02:00'), 30, officeHours());
    expect(due.toISOString()).toBe('2026-03-03T06:30:00.000Z');
  });

  it('spills the remainder into the next working day', () => {
    // Friday 16:40 has 20 minutes left; the other 40 land on Monday from 08:00.
    const due = addBusinessMinutes(at('2026-03-06T16:40:00+02:00'), 60, officeHours());
    expect(due.toISOString()).toBe('2026-03-09T06:40:00.000Z');
  });

  it('skips the weekend entirely', () => {
    const due = addBusinessMinutes(at('2026-03-07T10:00:00+02:00'), 30, officeHours());
    expect(due.toISOString()).toBe('2026-03-09T06:30:00.000Z');
  });

  it('skips a public holiday', () => {
    // Monday the 9th is a holiday, so Friday's remainder lands on Tuesday.
    const due = addBusinessMinutes(
      at('2026-03-06T16:40:00+02:00'),
      60,
      officeHours(['2026-03-09']),
    );
    expect(due.toISOString()).toBe('2026-03-10T06:40:00.000Z');
  });

  it('jumps the lunch break', () => {
    // 11:30 + 1h: 30 minutes before noon, the rest from 13:00.
    const due = addBusinessMinutes(at('2026-03-02T11:30:00+02:00'), 60, splitDay);
    expect(due.toISOString()).toBe('2026-03-02T11:30:00.000Z');
  });

  it('counts wall-clock time on a round-the-clock calendar', () => {
    const due = addBusinessMinutes(at('2026-03-07T23:30:00+02:00'), 60, roundTheClock);
    expect(due.toISOString()).toBe('2026-03-07T22:30:00.000Z');
  });

  it('carries a multi-day target across several weeks', () => {
    // 45 working hours at 9h/day = five working days.
    const due = addBusinessMinutes(at('2026-03-02T08:00:00+02:00'), 45 * 60, officeHours());
    expect(due.toISOString()).toBe('2026-03-06T15:00:00.000Z');
  });

  it('resolves the offset at the deadline, not at the start', () => {
    // Britain moves to BST on Sunday 2026-03-29. Friday 16:30 GMT has 30 minutes
    // left, so the rest runs from 09:00 *BST* on Monday — 08:00Z, not 09:00Z.
    const london: BusinessCalendar = {
      timezone: 'Europe/London',
      weekly: [1, 2, 3, 4, 5].map((day) => ({ day, opensAt: '09:00', closesAt: '17:00' })),
      holidays: new Set(),
    };

    const due = addBusinessMinutes(at('2026-03-27T16:30:00Z'), 60, london);
    expect(due.toISOString()).toBe('2026-03-30T08:30:00.000Z');
  });

  it('returns the start instant for a non-positive target', () => {
    const start = at('2026-03-02T09:00:00+02:00');
    expect(addBusinessMinutes(start, 0, officeHours()).toISOString()).toBe(start.toISOString());
  });

  it('refuses a calendar with no open hours rather than looping', () => {
    const closed: BusinessCalendar = {
      timezone: 'Africa/Harare',
      weekly: [],
      holidays: new Set(),
    };

    expect(() => addBusinessMinutes(at('2026-03-02T09:00:00Z'), 60, closed)).toThrow(
      /no open hours/i,
    );
  });

  it('rejects a time zone that does not exist', () => {
    const nowhere: BusinessCalendar = {
      timezone: 'Mars/Olympus_Mons',
      weekly: [{ day: 1, opensAt: '08:00', closesAt: '17:00' }],
      holidays: new Set(),
    };

    expect(() => addBusinessMinutes(at('2026-03-02T09:00:00Z'), 60, nowhere)).toThrow(
      /unknown time zone/i,
    );
  });
});

describe('businessMinutesBetween', () => {
  it('counts a span inside one working day', () => {
    expect(
      businessMinutesBetween(
        at('2026-03-02T09:00:00+02:00'),
        at('2026-03-02T11:00:00+02:00'),
        officeHours(),
      ),
    ).toBe(120);
  });

  it('excludes the weekend from a Friday-to-Monday span', () => {
    // 16:00–17:00 Friday plus 08:00–09:00 Monday.
    expect(
      businessMinutesBetween(
        at('2026-03-06T16:00:00+02:00'),
        at('2026-03-09T09:00:00+02:00'),
        officeHours(),
      ),
    ).toBe(120);
  });

  it('excludes a holiday that falls inside the span', () => {
    expect(
      businessMinutesBetween(
        at('2026-03-06T16:00:00+02:00'),
        at('2026-03-09T09:00:00+02:00'),
        officeHours(['2026-03-09']),
      ),
    ).toBe(60);
  });

  it('counts only the open part of an overnight span', () => {
    // 22:00 Monday to 10:00 Tuesday: nothing overnight, two hours in the morning.
    expect(
      businessMinutesBetween(
        at('2026-03-02T22:00:00+02:00'),
        at('2026-03-03T10:00:00+02:00'),
        officeHours(),
      ),
    ).toBe(120);
  });

  it('is zero when the range is empty or inverted', () => {
    const instant = at('2026-03-02T09:00:00+02:00');
    expect(businessMinutesBetween(instant, instant, officeHours())).toBe(0);
    expect(businessMinutesBetween(instant, at('2026-03-02T08:00:00+02:00'), officeHours())).toBe(0);
  });

  it('round-trips against addBusinessMinutes', () => {
    const start = at('2026-03-05T15:20:00+02:00');
    const due = addBusinessMinutes(start, 250, officeHours());
    expect(businessMinutesBetween(start, due, officeHours())).toBe(250);
  });
});

describe('consumedFraction', () => {
  const calendar = officeHours();
  const startedAt = at('2026-03-02T08:00:00+02:00');
  /** 08:00 + 60 working minutes = 09:00 the same morning. */
  const dueAt = addBusinessMinutes(startedAt, 60, calendar);

  it('reports the share of the allowance used', () => {
    expect(
      consumedFraction(
        { targetMinutes: 60, dueAt, pausedAt: null },
        at('2026-03-02T08:30:00+02:00'),
        calendar,
      ),
    ).toBeCloseTo(0.5);
  });

  it('reaches 1 exactly on the deadline and passes it when overdue', () => {
    expect(
      consumedFraction({ targetMinutes: 60, dueAt, pausedAt: null }, dueAt, calendar),
    ).toBeCloseTo(1);

    expect(
      consumedFraction(
        { targetMinutes: 60, dueAt, pausedAt: null },
        at('2026-03-02T09:30:00+02:00'),
        calendar,
      ),
    ).toBeCloseTo(1.5);
  });

  it('is at least 1 for anything past the deadline, so a breach always escalates', () => {
    // Overdue across a weekend: no working time passes, but it is still late.
    const fridayDue = at('2026-03-06T16:50:00+02:00');
    expect(
      consumedFraction(
        { targetMinutes: 60, dueAt: fridayDue, pausedAt: null },
        at('2026-03-08T12:00:00+02:00'),
        calendar,
      ),
    ).toBeGreaterThanOrEqual(1);
  });

  it('freezes while the clock is stopped', () => {
    const pausedAt = at('2026-03-02T08:30:00+02:00');

    // An hour of wall-clock later, the fraction has not moved.
    expect(
      consumedFraction(
        { targetMinutes: 60, dueAt, pausedAt },
        at('2026-03-02T09:30:00+02:00'),
        calendar,
      ),
    ).toBeCloseTo(0.5);
  });

  it('ignores time outside working hours', () => {
    // Raised Friday 16:30 with an hour to answer: due Monday 08:30.
    const fridayStart = at('2026-03-06T16:30:00+02:00');
    const mondayDue = addBusinessMinutes(fridayStart, 60, calendar);
    expect(mondayDue.toISOString()).toBe('2026-03-09T06:30:00.000Z');

    // Monday 08:00 — half the allowance is still unused.
    expect(
      consumedFraction(
        { targetMinutes: 60, dueAt: mondayDue, pausedAt: null },
        at('2026-03-09T08:00:00+02:00'),
        calendar,
      ),
    ).toBeCloseTo(0.5);
  });

  it('reports nothing consumed before the clock has started running', () => {
    expect(
      consumedFraction(
        { targetMinutes: 60, dueAt, pausedAt: null },
        at('2026-03-02T08:00:00+02:00'),
        calendar,
      ),
    ).toBeCloseTo(0);
  });

  it('treats a zero-minute target as immediately spent', () => {
    expect(consumedFraction({ targetMinutes: 0, dueAt, pausedAt: null }, startedAt, calendar)).toBe(
      1,
    );
  });
});

describe('localDateKey', () => {
  it('zero-pads to the form holidays are stored in', () => {
    expect(localDateKey({ year: 2026, month: 4, day: 7 })).toBe('2026-04-07');
  });
});

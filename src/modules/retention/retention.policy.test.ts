import { describe, expect, it } from 'vitest';
import { cutoffsFor, isCoherent, yearsBefore } from './retention.policy.js';

describe('yearsBefore', () => {
  it('moves whole calendar years, not 365-day windows', () => {
    expect(yearsBefore(new Date('2026-08-21T10:00:00Z'), 5).toISOString()).toBe(
      '2021-08-21T10:00:00.000Z',
    );
  });

  it('handles a leap day landing on a non-leap year', () => {
    // 2024-02-29 minus one year has no 29th of February to land on; the
    // platform normalises it forward rather than throwing.
    const shifted = yearsBefore(new Date('2024-02-29T00:00:00Z'), 1);
    expect(shifted.toISOString().slice(0, 10)).toBe('2023-03-01');
  });
});

describe('cutoffsFor', () => {
  it('derives both cutoffs from one clock reading', () => {
    const now = new Date('2026-08-21T00:00:00Z');
    const cutoffs = cutoffsFor({ auditLogYears: 7, ticketYears: 5 }, now);

    expect(cutoffs.auditLogsBefore.getUTCFullYear()).toBe(2019);
    expect(cutoffs.ticketContentBefore.getUTCFullYear()).toBe(2021);
    // The audit cutoff is the older of the two: audit rows survive longest.
    expect(cutoffs.auditLogsBefore.getTime()).toBeLessThan(cutoffs.ticketContentBefore.getTime());
  });
});

describe('isCoherent', () => {
  it('requires the audit trail to outlive the content it describes', () => {
    expect(isCoherent({ auditLogYears: 7, ticketYears: 5 })).toBe(true);
    expect(isCoherent({ auditLogYears: 5, ticketYears: 5 })).toBe(true);
    // Inverted, the sweep would delete the record of an anonymisation before
    // performing it — which is exactly what an auditor asks to see.
    expect(isCoherent({ auditLogYears: 3, ticketYears: 5 })).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';
import {
  SUGGEST_TERM_LIMIT,
  extractTerms,
  toSearchQuery,
  toSuggestQuery,
} from './knowledge-base.search.js';

describe('toSearchQuery', () => {
  it('passes the user through, so quoted phrases and exclusions still work', () => {
    expect(toSearchQuery('"failed transfer" -airtime')).toBe('"failed transfer" -airtime');
  });

  it('trims and bounds a pasted wall of text', () => {
    const query = toSearchQuery(`  ${'a'.repeat(1000)}  `);
    expect(query).toHaveLength(512);
  });

  it('returns null for a query with nothing searchable in it', () => {
    // The caller must treat this as an empty result, never as no filter.
    expect(toSearchQuery('')).toBeNull();
    expect(toSearchQuery('   ')).toBeNull();
    expect(toSearchQuery('*** --- ...')).toBeNull();
  });
});

describe('toSuggestQuery', () => {
  it('ORs the distinctive terms, because ANDing a ticket body matches nothing', () => {
    const query = toSuggestQuery({
      subject: 'Transfer failed',
      body: 'I sent money to my brother and the transfer failed.',
    });

    expect(query).toContain(' or ');
    expect(query).toContain('transfer');
    expect(query).not.toContain(' and ');
  });

  it('drops the words every ticket contains', () => {
    const query = toSuggestQuery({ subject: 'Please help urgent issue', body: 'Thanks' });
    // Nothing distinctive survives, so there is nothing honest to suggest.
    expect(query).toBeNull();
  });

  it('does not let a ticket reference dominate the query', () => {
    const query = toSuggestQuery({
      subject: 'PF-2026-000123 disbursement delayed',
      body: 'Reference PF-2026-000123.',
    });

    expect(query).toBe('disbursement or delayed');
  });

  it('ignores amounts, addresses and links', () => {
    const query = toSuggestQuery({
      body: 'I paid 1 234 567.89 from rudo@example.co.zw see https://example.com/receipt airtime',
    });

    // The words survive; the identifiers do not.
    expect(query).toBe('airtime or paid');
    expect(query).not.toMatch(/example|receipt|234|567/);
  });

  it('returns null rather than an empty query', () => {
    expect(toSuggestQuery({})).toBeNull();
    expect(toSuggestQuery({ subject: '   ', body: '' })).toBeNull();
  });
});

describe('extractTerms', () => {
  it('prefers longer, more specific words when the budget runs out', () => {
    const terms = extractTerms(
      'settlement reconciliation merchant terminal chargeback disbursement statement ' +
        'repayment onboarding withdrawal collateral guarantor overdraft mandate',
    );

    expect(terms).toHaveLength(SUGGEST_TERM_LIMIT);
    expect(terms[0]).toBe('reconciliation');
    // The shortest word is the one that got cut.
    expect(terms).not.toContain('mandate');
  });

  it('de-duplicates and lower-cases', () => {
    expect(extractTerms('Airtime airtime AIRTIME')).toEqual(['airtime']);
  });

  it('drops words too short to be a signal', () => {
    expect(extractTerms('my pin is up')).toEqual(['pin']);
  });
});

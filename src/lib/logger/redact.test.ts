import { describe, expect, it } from 'vitest';
import { __testing } from './redact.js';

const { redactValue } = __testing;

describe('log redaction', () => {
  it('redacts credentials and customer PII', () => {
    const result = redactValue({
      password: 'hunter2',
      accessToken: 'abc',
      email: 'client@example.co.zw',
      phone: '+263771234567',
      nationalId: '63-1234567-A-42',
      ticketId: 'PF-2026-000123',
    }) as Record<string, unknown>;

    expect(result.password).toBe('[redacted]');
    expect(result.accessToken).toBe('[redacted]');
    expect(result.email).toBe('[redacted]');
    expect(result.phone).toBe('[redacted]');
    expect(result.nationalId).toBe('[redacted]');
    // Identifiers are the whole point of logging — they must survive.
    expect(result.ticketId).toBe('PF-2026-000123');
  });

  it('matches keys regardless of casing or separators', () => {
    const result = redactValue({
      Account_Number: '1',
      'phone-number': '2',
      NATIONALID: '3',
    }) as Record<string, unknown>;

    expect(Object.values(result)).toEqual(['[redacted]', '[redacted]', '[redacted]']);
  });

  it('redacts nested and array-held values', () => {
    const result = redactValue({
      customer: { profile: { email: 'a@b.com' }, id: 'cus_1' },
      contacts: [{ phone: '+263' }],
    }) as any;

    expect(result.customer.profile.email).toBe('[redacted]');
    expect(result.customer.id).toBe('cus_1');
    expect(result.contacts[0].phone).toBe('[redacted]');
  });

  it('survives circular references', () => {
    const node: Record<string, unknown> = { id: 'a' };
    node.self = node;

    expect(() => redactValue(node)).not.toThrow();
    expect((redactValue(node) as any).self).toBe('[circular]');
  });

  it('serialises errors instead of walking them', () => {
    const result = redactValue({ err: new Error('boom') }) as any;

    expect(result.err.message).toBe('boom');
    expect(result.err.stack).toBeTypeOf('string');
  });
});

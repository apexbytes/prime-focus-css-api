import { describe, expect, it } from 'vitest';
import { sign, SIGNATURE_VERSION, verify } from './webhook.signature.js';

const SECRET = 'a-signing-secret-that-only-two-systems-know';
const BODY = JSON.stringify({ type: 'ticket.created', ticket: { reference: 'PF-2026-000001' } });

describe('webhook signature', () => {
  it('produces a versioned hex digest a receiver can verify', () => {
    const signature = sign({ body: BODY, timestamp: 1_770_000_000, secret: SECRET });

    expect(signature.startsWith(`${SIGNATURE_VERSION}=`)).toBe(true);
    expect(
      verify({ body: BODY, timestamp: 1_770_000_000, secret: SECRET, presented: signature }),
    ).toBe(true);
  });

  it('refuses a body that changed after signing', () => {
    const signature = sign({ body: BODY, timestamp: 1_770_000_000, secret: SECRET });

    expect(
      verify({
        body: BODY.replace('000001', '000002'),
        timestamp: 1_770_000_000,
        secret: SECRET,
        presented: signature,
      }),
    ).toBe(false);
  });

  /**
   * The property the timestamp exists for. Without it in the signed string, a
   * captured request stays valid forever and a receiver has no way to tell a
   * replay from the original.
   */
  it('refuses the same body replayed under a different timestamp', () => {
    const signature = sign({ body: BODY, timestamp: 1_770_000_000, secret: SECRET });

    expect(
      verify({ body: BODY, timestamp: 1_770_000_060, secret: SECRET, presented: signature }),
    ).toBe(false);
  });

  it('refuses another subscription’s secret', () => {
    const signature = sign({ body: BODY, timestamp: 1_770_000_000, secret: SECRET });

    expect(
      verify({
        body: BODY,
        timestamp: 1_770_000_000,
        secret: `${SECRET}-but-different`,
        presented: signature,
      }),
    ).toBe(false);
  });

  /**
   * The separator between the timestamp and the body is what stops two
   * different (timestamp, body) pairs signing the same bytes — the mistake a
   * scheme that simply concatenates its fields makes.
   */
  it('distinguishes payloads that would concatenate identically', () => {
    const first = sign({ body: '23-45', timestamp: 1, secret: SECRET });
    const second = sign({ body: '3-45', timestamp: 12, secret: SECRET });

    expect(first).not.toBe(second);
  });
});

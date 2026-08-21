import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * The signature scheme receivers verify.
 *
 * Deliberately the same shape as the one Resend/Svix use on the way in, because
 * the team already has to understand that one, and a second scheme with the
 * same purpose is a second thing to get wrong.
 *
 * Three properties, and the reason for each:
 *
 * - **The timestamp is inside the signed string.** Signing the body alone makes
 *   every request replayable forever by anyone who captured one. A receiver is
 *   expected to reject anything older than `TOLERANCE_SECONDS`.
 * - **The version prefix is in the header value**, so a future scheme can be
 *   introduced by sending both and retiring the old one, rather than by
 *   breaking every receiver on a deploy.
 * - **Comparison is constant-time**, on the receiver's side as much as ours; the
 *   verify helper here exists so our own tests check the real thing.
 */
export const SIGNATURE_VERSION = 'v1';

/** What a receiver should refuse as a replay. Documented, not enforced here. */
export const TOLERANCE_SECONDS = 300;

export const SIGNATURE_HEADER = 'x-pf-signature';
export const TIMESTAMP_HEADER = 'x-pf-timestamp';
export const EVENT_HEADER = 'x-pf-event';
export const EVENT_ID_HEADER = 'x-pf-event-id';
export const DELIVERY_HEADER = 'x-pf-delivery';

/**
 * `v1=<hex>` over `<timestamp>.<body>`.
 *
 * The separator matters: without it, a timestamp of `1` and a body of `23…` signs
 * the same bytes as a timestamp of `12` and a body of `3…`, which is the classic
 * length-extension-adjacent mistake in a scheme that concatenates fields.
 */
export function sign(input: { body: string; timestamp: number; secret: string }): string {
  const digest = createHmac('sha256', input.secret)
    .update(`${input.timestamp}.${input.body}`)
    .digest('hex');

  return `${SIGNATURE_VERSION}=${digest}`;
}

/** The receiver's half, used by this system's own tests. */
export function verify(input: {
  body: string;
  timestamp: number;
  secret: string;
  presented: string;
}): boolean {
  const expected = Buffer.from(sign(input), 'utf8');
  const actual = Buffer.from(input.presented, 'utf8');

  if (expected.length !== actual.length) return false;
  return timingSafeEqual(expected, actual);
}

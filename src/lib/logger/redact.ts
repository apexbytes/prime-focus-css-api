import { format } from 'winston';

/**
 * Keys whose values must never reach a log sink. Zimbabwe's Cyber and Data
 * Protection Act (2021) plus ordinary fintech hygiene mean customer PII and
 * credentials stay out of logs: log identifiers and reference codes instead.
 *
 * This is the safety net, not the strategy — call sites should not pass these
 * in the first place.
 */
const REDACTED_KEYS = new Set([
  'password',
  'passwordhash',
  'currentpassword',
  'newpassword',
  'token',
  'accesstoken',
  'refreshtoken',
  'authorization',
  'cookie',
  'secret',
  'apikey',
  'mfasecret',
  'totp',
  'recoverycode',
  'otp',
  'email',
  'phone',
  'phonenumber',
  'msisdn',
  'nationalid',
  'idnumber',
  'accountnumber',
  'cardnumber',
  'pan',
  'cvv',
  'pin',
  'fullname',
  'firstname',
  'lastname',
  'address',
]);

const REDACTION = '[redacted]';
const MAX_DEPTH = 6;

function redactValue(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (depth > MAX_DEPTH || value === null || typeof value !== 'object') return value;
  if (value instanceof Date) return value;
  if (seen.has(value)) return '[circular]';
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, depth + 1, seen));
  }

  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack };
  }

  const output: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    output[key] = REDACTED_KEYS.has(key.toLowerCase().replace(/[_-]/g, ''))
      ? REDACTION
      : redactValue(nested, depth + 1, seen);
  }
  return output;
}

/** Reserved by Winston/logform; redacting these would break the output format. */
const PRESERVED_KEYS = new Set(['level', 'message', 'timestamp', 'stack', 'label', 'ms', 'splat']);

/**
 * Winston format that deep-redacts sensitive keys from log metadata.
 *
 * Mutates `info` in place: Winston keeps the level and raw message on Symbol
 * keys, and returning a fresh object literal drops them, which breaks colorize()
 * and every transport that reads them.
 */
export const redactFormat = format((info) => {
  const seen = new WeakSet<object>();

  for (const key of Object.keys(info)) {
    if (PRESERVED_KEYS.has(key)) continue;

    const record = info as unknown as Record<string, unknown>;
    record[key] = REDACTED_KEYS.has(key.toLowerCase().replace(/[_-]/g, ''))
      ? REDACTION
      : redactValue(record[key], 0, seen);
  }

  return info;
});

export const __testing = { redactValue: (v: unknown) => redactValue(v, 0, new WeakSet()) };

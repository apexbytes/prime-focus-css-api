import { createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { hash, verify } from '@node-rs/argon2';
import { env } from '../../config/index.js';

/**
 * Password hashing. Argon2id with the library defaults (19 MiB, t=2), which is
 * the OWASP-recommended floor and costs ~50ms per verify — deliberately slow,
 * because the whole point is to make offline cracking expensive.
 */
export function hashPassword(plaintext: string): Promise<string> {
  // The library default is Argon2id; the `Algorithm` enum cannot be imported
  // under verbatimModuleSyntax, so crypto.test.ts asserts the digest prefix.
  return hash(plaintext);
}

export async function verifyPassword(digest: string, plaintext: string): Promise<boolean> {
  try {
    return await verify(digest, plaintext);
  } catch {
    // A malformed digest is a data problem, not a valid login.
    return false;
  }
}

/**
 * Burns roughly the same CPU as a real verify, for use when no password hash
 * exists (unknown email, invited-but-not-activated account). Without it, the
 * response time itself tells an attacker whether an address is registered.
 */
const DUMMY_DIGEST =
  '$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHRzb21lc2FsdA$1dNFcDVMg+YSRvGvJPWLpqkFYPBUJ5m0FEQeVKN9jXk';

export async function burnPasswordVerify(): Promise<void> {
  await verifyPassword(DUMMY_DIGEST, 'timing-equalisation');
}

/**
 * Opaque bearer secret (refresh tokens, invitation links, device tokens, API
 * keys). 32 bytes of entropy, URL-safe so it survives being put in a link.
 */
export function generateSecret(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/**
 * Lookup hash for high-entropy secrets. SHA-256 rather than Argon2 on purpose:
 * these values already have 256 bits of entropy, so there is nothing to brute
 * force, and they are hashed on every request that presents one.
 */
export function hashSecret(secret: string): string {
  return createHmac('sha256', env.JWT_SECRET).update(`secret:${secret}`).digest('hex');
}

/**
 * A 6-digit code has almost no entropy, so a plain digest would be trivially
 * reversible from a database leak. Keying the hash with the server secret means
 * the stored value is useless without it.
 */
export function hashOtp(code: string, challengeId: string): string {
  return createHmac('sha256', env.JWT_SECRET).update(`otp:${challengeId}:${code}`).digest('hex');
}

/** Numeric code, uniformly distributed, from the CSPRNG. */
export function generateOtp(length: number = env.OTP_LENGTH): string {
  let code = '';
  for (let index = 0; index < length; index += 1) {
    code += String(randomInt(0, 10));
  }
  return code;
}

/** Comparison that does not leak how many leading characters matched. */
export function secureEquals(left: string, right: string): boolean {
  const a = Buffer.from(left, 'utf8');
  const b = Buffer.from(right, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * API keys are presented as `pfc_<prefix>_<secret>`: the prefix is a non-secret
 * handle that can be logged and shown in the admin list, and it makes the
 * lookup a single indexed read instead of a scan over every key's hash.
 */
export interface GeneratedApiKey {
  plaintext: string;
  prefix: string;
  hash: string;
}

export function generateApiKey(): GeneratedApiKey {
  const prefix = randomBytes(6).toString('hex');
  const secret = generateSecret(32);
  return {
    plaintext: `pfc_${prefix}_${secret}`,
    prefix,
    hash: hashSecret(secret),
  };
}

/**
 * Splitting on '_' would be wrong: the secret is base64url, whose alphabet
 * includes '_', so roughly half of all keys contain one. The prefix is
 * fixed-length hex, which makes the boundary unambiguous.
 */
const API_KEY_PATTERN = /^pfc_([0-9a-f]{12})_([A-Za-z0-9_-]{20,})$/;

export function parseApiKey(presented: string): { prefix: string; secret: string } | null {
  const match = API_KEY_PATTERN.exec(presented);
  if (!match?.[1] || !match[2]) return null;
  return { prefix: match[1], secret: match[2] };
}

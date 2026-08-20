import { describe, expect, it } from 'vitest';
import {
  burnPasswordVerify,
  generateApiKey,
  generateOtp,
  generateSecret,
  hashOtp,
  hashPassword,
  hashSecret,
  parseApiKey,
  secureEquals,
  verifyPassword,
} from './crypto.js';

describe('password hashing', () => {
  it('uses argon2id', async () => {
    // The Algorithm enum cannot be imported under verbatimModuleSyntax, so the
    // library default is asserted here rather than assumed.
    const digest = await hashPassword('a-perfectly-fine-password');
    expect(digest.startsWith('$argon2id$')).toBe(true);
  });

  it('verifies a correct password and rejects a wrong one', async () => {
    const digest = await hashPassword('correct horse battery staple');

    expect(await verifyPassword(digest, 'correct horse battery staple')).toBe(true);
    expect(await verifyPassword(digest, 'Correct horse battery staple')).toBe(false);
    expect(await verifyPassword(digest, '')).toBe(false);
  });

  it('salts, so the same password hashes differently every time', async () => {
    const [first, second] = await Promise.all([
      hashPassword('same-input'),
      hashPassword('same-input'),
    ]);
    expect(first).not.toBe(second);
  });

  it('treats a malformed digest as a failed login rather than throwing', async () => {
    await expect(verifyPassword('not-a-hash', 'anything')).resolves.toBe(false);
  });

  it('burns comparable time when there is no hash to check', async () => {
    // Guards the enumeration defence: this must do real work, not return early.
    const startedAt = performance.now();
    await burnPasswordVerify();
    expect(performance.now() - startedAt).toBeGreaterThan(1);
  });
});

describe('secret handling', () => {
  it('generates URL-safe secrets with no padding', () => {
    const secret = generateSecret(32);
    expect(secret).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(secret.length).toBeGreaterThanOrEqual(43);
  });

  it('hashes deterministically, so a lookup by hash works', () => {
    const secret = generateSecret();
    expect(hashSecret(secret)).toBe(hashSecret(secret));
    expect(hashSecret(secret)).not.toBe(hashSecret(generateSecret()));
  });

  it('never stores the secret itself in the hash', () => {
    const secret = generateSecret();
    expect(hashSecret(secret)).not.toContain(secret);
  });
});

describe('OTP codes', () => {
  it('generates codes of the configured length, digits only', () => {
    for (let index = 0; index < 50; index += 1) {
      expect(generateOtp(6)).toMatch(/^\d{6}$/);
    }
  });

  it('binds the hash to the challenge, so a code cannot be replayed elsewhere', () => {
    const code = '123456';
    expect(hashOtp(code, 'challenge-a')).not.toBe(hashOtp(code, 'challenge-b'));
    expect(hashOtp(code, 'challenge-a')).toBe(hashOtp(code, 'challenge-a'));
  });

  it('produces a spread of values rather than a constant', () => {
    const seen = new Set(Array.from({ length: 200 }, () => generateOtp(6)));
    expect(seen.size).toBeGreaterThan(150);
  });
});

describe('api keys', () => {
  it('round-trips the prefix and secret', () => {
    // Many iterations on purpose: the secret is base64url, so about half of all
    // keys contain an '_' and a naive split-based parser passes ~50% of the time.
    for (let index = 0; index < 200; index += 1) {
      const generated = generateApiKey();
      const parsed = parseApiKey(generated.plaintext);

      expect(parsed, `failed to parse ${generated.plaintext}`).not.toBeNull();
      expect(parsed?.prefix).toBe(generated.prefix);
      expect(hashSecret(parsed?.secret ?? '')).toBe(generated.hash);
    }
  });

  it('parses a key whose secret contains underscores and hyphens', () => {
    const parsed = parseApiKey('pfc_0123456789ab_abc_def-ghi_jkl-mno_pqrstuvwxyz');
    expect(parsed?.prefix).toBe('0123456789ab');
    expect(parsed?.secret).toBe('abc_def-ghi_jkl-mno_pqrstuvwxyz');
  });

  it('stores only the hash of the secret half', () => {
    const generated = generateApiKey();
    const parsed = parseApiKey(generated.plaintext);

    expect(parsed?.secret).toBeTypeOf('string');
    expect(generated.hash).not.toContain(parsed?.secret ?? '');
    expect(generated.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('rejects malformed keys', () => {
    expect(parseApiKey('nope')).toBeNull();
    expect(parseApiKey('pfc_only-two-parts')).toBeNull();
    expect(parseApiKey('xxx_prefix_secret')).toBeNull();
    expect(parseApiKey('pfc__secret')).toBeNull();
    // Prefix must be 12 hex characters.
    expect(parseApiKey('pfc_nothex000000_' + 'a'.repeat(43))).toBeNull();
    expect(parseApiKey('pfc_0123456789ab_short')).toBeNull();
  });
});

describe('secureEquals', () => {
  it('compares equal and unequal values correctly', () => {
    expect(secureEquals('abc', 'abc')).toBe(true);
    expect(secureEquals('abc', 'abd')).toBe(false);
  });

  it('handles differing lengths without throwing', () => {
    expect(secureEquals('short', 'much longer value')).toBe(false);
  });
});

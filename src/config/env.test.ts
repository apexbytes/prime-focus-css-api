import { describe, expect, it } from 'vitest';
import { parseEnv } from './env.js';

const minimal = { DATABASE_URL: 'postgres://user:pass@localhost:5432/db' };

describe('parseEnv', () => {
  it('applies defaults when only the required values are present', () => {
    const env = parseEnv(minimal);

    expect(env.NODE_ENV).toBe('development');
    expect(env.PORT).toBe(3000);
    expect(env.DEFAULT_TIMEZONE).toBe('Africa/Harare');
    expect(env.DB_POOL_MAX).toBe(10);
  });

  it('fails fast when DATABASE_URL is missing', () => {
    expect(() => parseEnv({})).toThrow(/DATABASE_URL/);
  });

  it('reports every problem at once rather than one per boot', () => {
    try {
      parseEnv({ PORT: 'not-a-port', LOG_LEVEL: 'chatty' });
      expect.unreachable('expected parseEnv to throw');
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain('PORT');
      expect(message).toContain('LOG_LEVEL');
      expect(message).toContain('DATABASE_URL');
    }
  });

  it('coerces numeric strings and rejects out-of-range ports', () => {
    expect(parseEnv({ ...minimal, PORT: '8080' }).PORT).toBe(8080);
    expect(() => parseEnv({ ...minimal, PORT: '70000' })).toThrow();
  });

  it('accepts the several shapes a boolean env var arrives in', () => {
    expect(parseEnv({ ...minimal, DB_SSL: 'true' }).DB_SSL).toBe(true);
    expect(parseEnv({ ...minimal, DB_SSL: '1' }).DB_SSL).toBe(true);
    expect(parseEnv({ ...minimal, DB_SSL: 'false' }).DB_SSL).toBe(false);
    expect(parseEnv({ ...minimal, DB_SSL: '0' }).DB_SSL).toBe(false);
    expect(parseEnv(minimal).DB_SSL).toBe(false);
  });

  it('rejects a boolean-ish value it cannot interpret', () => {
    expect(() => parseEnv({ ...minimal, LOG_TO_FILE: 'yes' })).toThrow(/LOG_TO_FILE/);
  });
});

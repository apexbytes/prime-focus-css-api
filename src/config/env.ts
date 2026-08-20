import { config as loadDotenv } from 'dotenv';
import { z } from 'zod';

loadDotenv({ quiet: true });

/**
 * The single place `process.env` is read. Every other module imports `env`.
 * Parsing happens once at import time and throws on anything missing or
 * malformed, so a misconfigured deploy fails at boot rather than on the first
 * request that happens to need the value.
 */
const booleanish = z
  .union([z.boolean(), z.enum(['true', 'false', '1', '0'])])
  .transform((value) => value === true || value === 'true' || value === '1');

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  API_BASE_URL: z.string().min(1).default('http://localhost:3000'),
  DEFAULT_TIMEZONE: z.string().min(1).default('Africa/Harare'),

  LOG_LEVEL: z.enum(['error', 'warn', 'info', 'http', 'debug', 'silly']).default('info'),
  LOG_DIR: z.string().min(1).default('logs'),
  LOG_TO_FILE: booleanish.default(false),

  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  DB_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
  DB_SSL: booleanish.default(false),
  DB_STATEMENT_TIMEOUT_MS: z.coerce.number().int().min(0).default(15_000),

  CORS_ORIGINS: z.string().default('*'),
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(10).default(1),
  BODY_LIMIT: z.string().default('1mb'),

  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().min(1000).default(60_000),
  RATE_LIMIT_MAX: z.coerce.number().int().min(1).default(300),

  SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().min(0).default(15_000),
  READINESS_CHECK_TIMEOUT_MS: z.coerce.number().int().min(100).default(3_000),

  GIT_COMMIT_SHA: z.string().default('unknown'),
  APP_VERSION: z.string().default(process.env.npm_package_version ?? '0.0.0'),
});

export type Env = z.infer<typeof envSchema>;

/** Exported for tests: parse an arbitrary record instead of `process.env`. */
export function parseEnv(source: Record<string, unknown>): Env {
  const result = envSchema.safeParse(source);

  if (!result.success) {
    const problems = result.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${problems}`);
  }

  return result.data;
}

export const env: Env = parseEnv(process.env);

export const isProduction = env.NODE_ENV === 'production';
export const isTest = env.NODE_ENV === 'test';
export const isDevelopment = env.NODE_ENV === 'development';

/** `*` means allow any origin; otherwise a comma-separated allowlist. */
export const corsOrigins: string[] | '*' =
  env.CORS_ORIGINS.trim() === '*'
    ? '*'
    : env.CORS_ORIGINS.split(',')
        .map((origin) => origin.trim())
        .filter(Boolean);

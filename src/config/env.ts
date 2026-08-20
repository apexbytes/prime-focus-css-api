import { config as loadDotenv } from 'dotenv';
import { z } from 'zod';

loadDotenv({ quiet: true });

/**
 * Placeholder so development and tests boot with no secrets configured. It is
 * rejected outright in production by the check below.
 */
const DEV_JWT_SECRET = 'dev-only-insecure-jwt-secret-change-me';

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
  /** Tighter budget for credential endpoints, where guessing has a payoff. */
  AUTH_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().min(1000).default(900_000),
  AUTH_RATE_LIMIT_MAX: z.coerce.number().int().min(1).default(10),

  SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().min(0).default(15_000),
  READINESS_CHECK_TIMEOUT_MS: z.coerce.number().int().min(100).default(3_000),

  GIT_COMMIT_SHA: z.string().default('unknown'),
  APP_VERSION: z.string().default(process.env.npm_package_version ?? '0.0.0'),

  // ---- auth ----------------------------------------------------------------
  /** Signing key for access tokens. The dev default is rejected in production. */
  JWT_SECRET: z.string().min(32).default(DEV_JWT_SECRET),
  JWT_ISSUER: z.string().min(1).default('prime-focus-css'),
  JWT_AUDIENCE: z.string().min(1).default('prime-focus-css-api'),
  /** Key id in the token header, so the secret can be rotated without downtime. */
  JWT_KID: z.string().min(1).default('k1'),
  ACCESS_TOKEN_TTL_MINUTES: z.coerce.number().int().min(1).max(1440).default(15),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().min(1).max(365).default(30),

  PASSWORD_MIN_LENGTH: z.coerce.number().int().min(8).max(128).default(12),
  MAX_FAILED_LOGINS: z.coerce.number().int().min(3).max(20).default(5),
  ACCOUNT_LOCK_MINUTES: z.coerce.number().int().min(1).max(1440).default(15),

  // ---- email OTP (second factor) -------------------------------------------
  OTP_LENGTH: z.coerce.number().int().min(4).max(10).default(6),
  OTP_TTL_MINUTES: z.coerce.number().int().min(1).max(60).default(10),
  OTP_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(5),
  OTP_RESEND_COOLDOWN_SECONDS: z.coerce.number().int().min(0).max(600).default(60),
  TRUSTED_DEVICE_TTL_DAYS: z.coerce.number().int().min(1).max(365).default(30),

  // ---- invitations + password reset ----------------------------------------
  INVITATION_TTL_HOURS: z.coerce.number().int().min(1).max(720).default(72),
  PASSWORD_RESET_TTL_MINUTES: z.coerce.number().int().min(5).max(1440).default(30),
  /** Base URL of the agent console, used to build invite and reset links. */
  APP_WEB_URL: z.string().min(1).default('http://localhost:5173'),

  // ---- email ---------------------------------------------------------------
  RESEND_API_KEY: z.string().min(1).optional(),
  RESEND_FROM: z.string().min(1).default('Prime Focus Support <support@primefocus.co.zw>'),
  RESEND_REPLY_TO: z.string().min(1).optional(),
  /**
   * `log` prints the message instead of sending it, which is how development and
   * tests run without credentials. Defaults to `resend` when a key is present.
   */
  EMAIL_TRANSPORT: z.enum(['resend', 'log']).optional(),

  // ---- seed ----------------------------------------------------------------
  SEED_ADMIN_EMAIL: z.string().min(3).default('admin@primefocus.co.zw'),
  SEED_ADMIN_NAME: z.string().min(1).default('Prime Focus Administrator'),
  /** Required only when running `npm run db:seed`. */
  SEED_ADMIN_PASSWORD: z.string().min(1).optional(),
});

export type Env = z.infer<typeof envSchema>;

/** Exported for tests: parse an arbitrary record instead of `process.env`. */
/**
 * Guards that only apply in production. Kept separate from the field schema so
 * development stays zero-config while a real deploy cannot start half-secured.
 */
const productionSchema = envSchema.superRefine((value, ctx) => {
  if (value.NODE_ENV !== 'production') return;

  if (value.JWT_SECRET === DEV_JWT_SECRET) {
    ctx.addIssue({
      code: 'custom',
      path: ['JWT_SECRET'],
      message: 'must be set to a real secret in production (the dev default is not allowed)',
    });
  }

  // Without a key the transport silently falls back to logging, which would
  // mean invitations and login codes never actually reach anyone.
  if (!value.RESEND_API_KEY && value.EMAIL_TRANSPORT !== 'log') {
    ctx.addIssue({
      code: 'custom',
      path: ['RESEND_API_KEY'],
      message:
        'is required in production (or set EMAIL_TRANSPORT=log to send nothing deliberately)',
    });
  }

  if (value.CORS_ORIGINS.trim() === '*') {
    ctx.addIssue({
      code: 'custom',
      path: ['CORS_ORIGINS'],
      message: 'must be an explicit allowlist in production, not "*"',
    });
  }
});

export function parseEnv(source: Record<string, unknown>): Env {
  const result = productionSchema.safeParse(source);

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

/** `resend` when a key is configured, otherwise `log`. */
export const emailTransport: 'resend' | 'log' =
  env.EMAIL_TRANSPORT ?? (env.RESEND_API_KEY ? 'resend' : 'log');

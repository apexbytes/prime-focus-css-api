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
  /**
   * A product system's own budget, keyed on its API key rather than its IP.
   * Higher than the per-IP limit on purpose: an integration is expected to be
   * chatty, and it must not spend the budget shared by every browser behind the
   * same corporate NAT.
   */
  API_KEY_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().min(1000).default(60_000),
  API_KEY_RATE_LIMIT_MAX: z.coerce.number().int().min(1).default(1_000),

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

  // ---- tickets -------------------------------------------------------------
  /** Leading segment of a ticket reference, e.g. `PF` in PF-2026-000123. */
  TICKET_REFERENCE_PREFIX: z.string().min(1).max(8).default('PF'),
  /**
   * Emails the customer a reference when their query is logged. On by default:
   * without it, a customer who emails support gets silence until an agent
   * happens to reply.
   */
  SEND_TICKET_ACKNOWLEDGEMENT: booleanish.default(true),

  // ---- inbound email -------------------------------------------------------
  /** Svix signing secret from the Resend webhook page. Required to accept inbound mail. */
  RESEND_WEBHOOK_SECRET: z.string().min(1).optional(),
  /** Domain the support addresses live on, e.g. support.primefocus.co.zw. */
  SUPPORT_INBOX_DOMAIN: z.string().min(1).default('support.primefocus.co.zw'),
  /**
   * Product an inbound email falls back to when its recipient address matches no
   * product. Without it, unroutable mail is parked as `failed` rather than
   * silently filed under the wrong product.
   */
  DEFAULT_PRODUCT_CODE: z.string().min(1).optional(),

  // ---- attachment storage --------------------------------------------------
  /** Derived from credentials when unset: `s3` if a bucket is configured, else `local`. */
  STORAGE_BACKEND: z.enum(['local', 's3']).optional(),
  STORAGE_LOCAL_DIR: z.string().min(1).default('storage'),
  STORAGE_ENDPOINT: z.string().min(1).optional(),
  STORAGE_REGION: z.string().min(1).default('auto'),
  STORAGE_BUCKET: z.string().min(1).optional(),
  STORAGE_ACCESS_KEY_ID: z.string().min(1).optional(),
  STORAGE_SECRET_ACCESS_KEY: z.string().min(1).optional(),
  /** Required by most S3-compatible providers that are not AWS. */
  STORAGE_FORCE_PATH_STYLE: booleanish.default(true),
  ATTACHMENT_MAX_BYTES: z.coerce
    .number()
    .int()
    .min(1024)
    .default(25 * 1024 * 1024),
  UPLOAD_URL_TTL_SECONDS: z.coerce.number().int().min(60).max(3600).default(900),

  // ---- async jobs ----------------------------------------------------------
  /**
   * `inline` runs a job the moment it is enqueued, in the same process, and
   * never fires a cron schedule. It exists so tests and a database-less
   * checkout behave the same way the queue does, and defaults to `inline` only
   * under NODE_ENV=test — see `queueDriver`.
   */
  QUEUE_DRIVER: z.enum(['pgboss', 'inline']).optional(),
  /** pg-boss owns this schema outright; it migrates it itself. */
  QUEUE_SCHEMA: z.string().min(1).default('pgboss'),
  /** Workers per job queue in this process. */
  QUEUE_CONCURRENCY: z.coerce.number().int().min(1).max(50).default(2),
  /** How long a job may run before pg-boss retries it. */
  QUEUE_JOB_EXPIRY_SECONDS: z.coerce.number().int().min(30).default(300),
  QUEUE_RETRY_LIMIT: z.coerce.number().int().min(0).max(20).default(3),

  // ---- service levels ------------------------------------------------------
  /** Cron for the breach scan. Every minute: an SLA is quoted in minutes. */
  SLA_SCAN_CRON: z.string().min(1).default('* * * * *'),
  /**
   * Tickets examined per scan. A backlog is worked through over successive
   * runs rather than in one unbounded statement.
   */
  SLA_SCAN_BATCH_SIZE: z.coerce.number().int().min(1).max(5000).default(500),

  // ---- routing -------------------------------------------------------------
  /**
   * Off leaves every new ticket in the unassigned queue for agents to pick from,
   * which is how a team that dislikes push assignment runs.
   */
  AUTO_ASSIGN_ENABLED: booleanish.default(true),
  /**
   * Fallback when nobody matching a rule is `online`. Off means the ticket waits
   * in the queue rather than landing on an agent who is not at their desk.
   */
  ROUTING_ASSIGN_TO_AWAY_AGENTS: booleanish.default(false),
  /** Open tickets an agent may hold before routing skips them. */
  DEFAULT_AGENT_MAX_OPEN_TICKETS: z.coerce.number().int().min(1).max(500).default(20),

  // ---- knowledge base ------------------------------------------------------
  /** Articles offered by `GET /kb/suggest` during the ticket-creation flow. */
  KB_SUGGEST_LIMIT: z.coerce.number().int().min(1).max(20).default(5),

  // ---- customer satisfaction (CSAT) ----------------------------------------
  /** Off sends nothing; the surveys already dispatched stay answerable. */
  CSAT_ENABLED: booleanish.default(true),
  /**
   * Delay between resolving a ticket and asking about it. Long enough that a
   * customer who is about to reply "that did not work" reopens the ticket
   * instead of rating a resolution that did not hold.
   */
  CSAT_DELAY_MINUTES: z.coerce.number().int().min(0).max(10_080).default(60),
  /** How long the rating link stays usable. */
  CSAT_TOKEN_TTL_DAYS: z.coerce.number().int().min(1).max(90).default(14),
  /**
   * Minimum gap between surveys to the same customer. A customer who raises
   * five tickets in a week must not be asked five times.
   */
  CSAT_CUSTOMER_COOLDOWN_DAYS: z.coerce.number().int().min(0).max(365).default(7),

  // ---- reporting -----------------------------------------------------------
  /**
   * How often the materialised views are rebuilt. Every 15 minutes: dashboards
   * are read constantly and a report is allowed to be a quarter of an hour
   * behind, which is what keeps reporting off the transactional query path.
   */
  REPORT_REFRESH_CRON: z.string().min(1).default('*/15 * * * *'),

  // ---- attachment scanning -------------------------------------------------
  /**
   * `none` records uploads as `skipped` — honest about the fact that nothing
   * looked at them. Derived as `clamav` once a host is configured.
   */
  ANTIVIRUS_DRIVER: z.enum(['clamav', 'none']).optional(),
  /** clamd host. TCP rather than a unix socket so the scanner can be its own container. */
  ANTIVIRUS_HOST: z.string().min(1).optional(),
  ANTIVIRUS_PORT: z.coerce.number().int().min(1).max(65535).default(3310),
  ANTIVIRUS_TIMEOUT_MS: z.coerce.number().int().min(1000).max(600_000).default(30_000),
  /** Must not exceed clamd's own StreamMaxLength, or it closes the connection. */
  ANTIVIRUS_MAX_BYTES: z.coerce
    .number()
    .int()
    .min(1024)
    .default(25 * 1024 * 1024),

  // ---- notification digest -------------------------------------------------
  /** 07:00 in DEFAULT_TIMEZONE: before the desk opens, so it is read on arrival. */
  NOTIFICATION_DIGEST_CRON: z.string().min(1).default('0 7 * * *'),
  NOTIFICATION_DIGEST_ENABLED: booleanish.default(true),

  // ---- data retention ------------------------------------------------------
  /**
   * Zimbabwe's Cyber and Data Protection Act (2021) shapes these: the audit
   * trail is kept for seven years, ticket content for five, after which the
   * customer's personal data is anonymised in place rather than deleted, so
   * aggregate reporting survives.
   */
  RETENTION_SWEEP_CRON: z.string().min(1).default('0 3 * * 0'),
  RETENTION_SWEEP_ENABLED: booleanish.default(true),
  RETENTION_AUDIT_LOG_YEARS: z.coerce.number().int().min(1).max(50).default(7),
  RETENTION_TICKET_YEARS: z.coerce.number().int().min(1).max(50).default(5),
  /** Rows touched per sweep, so a first run on an old database is not one huge statement. */
  RETENTION_SWEEP_BATCH_SIZE: z.coerce.number().int().min(1).max(50_000).default(500),

  // ---- cache & shared state ------------------------------------------------
  /**
   * Without it the cache, the rate-limit counters and the socket fan-out are
   * per-process, which is correct for one instance and quietly wrong for two.
   * Derived: `redis` once a URL is set, otherwise `memory`.
   */
  REDIS_URL: z.string().min(1).optional(),
  CACHE_DRIVER: z.enum(['redis', 'memory']).optional(),
  /** Namespace on a shared Redis, so two environments cannot read each other. */
  REDIS_KEY_PREFIX: z.string().min(1).default('pfcss:'),
  REDIS_CONNECT_TIMEOUT_MS: z.coerce.number().int().min(100).max(60_000).default(5_000),
  /**
   * How long a cached knowledge base suggestion stays usable. Short: an article
   * unpublished for being wrong must stop being offered within the minute.
   */
  KB_SUGGEST_CACHE_TTL_SECONDS: z.coerce.number().int().min(0).max(3600).default(60),

  // ---- realtime ------------------------------------------------------------
  /** Off serves the REST API alone; the console falls back to polling. */
  REALTIME_ENABLED: booleanish.default(true),
  /** Socket.IO mount path. Distinct from any REST route, and proxied as-is. */
  REALTIME_PATH: z.string().min(1).default('/realtime'),
  /**
   * How long a ticket lock survives without a heartbeat. Deliberately short: a
   * lock is advisory, and the failure mode to avoid is a closed laptop making a
   * customer's ticket look owned for the rest of the afternoon.
   */
  TICKET_LOCK_TTL_SECONDS: z.coerce.number().int().min(15).max(3600).default(120),
  /** How often the client should refresh a lock it still holds. */
  TICKET_LOCK_HEARTBEAT_SECONDS: z.coerce.number().int().min(5).max(600).default(30),
  /**
   * How often an open socket re-checks that its account is still active. The
   * REST path re-reads the user row on every request, so a suspension takes
   * effect immediately there; a socket authenticated once at handshake would
   * otherwise stay live all afternoon.
   */
  REALTIME_REAUTH_SECONDS: z.coerce.number().int().min(30).max(3600).default(300),

  // ---- outbound webhooks ---------------------------------------------------
  /** A receiver that has not answered by now is treated as a failed attempt. */
  WEBHOOK_TIMEOUT_MS: z.coerce.number().int().min(1000).max(60_000).default(10_000),
  /** Attempts per delivery, including the first. */
  WEBHOOK_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(20).default(5),
  /**
   * Consecutive failed deliveries before a subscription is disabled. A host
   * that was decommissioned without anyone deleting its subscription would
   * otherwise be retried for every event forever.
   */
  WEBHOOK_DISABLE_AFTER_FAILURES: z.coerce.number().int().min(1).max(1000).default(20),
  /**
   * Delivery log rows are operational debris, not business records: they are
   * swept on the same schedule as everything else with a retention period.
   */
  WEBHOOK_DELIVERY_RETENTION_DAYS: z.coerce.number().int().min(1).max(365).default(30),

  // ---- omnichannel: WhatsApp ------------------------------------------------
  /**
   * Meta app secret. It keys the `X-Hub-Signature-256` on every inbound
   * webhook, and without it the ingress refuses everything: an unauthenticated
   * inbound endpoint is a way to post messages to the desk as any phone number,
   * which is impersonating a customer.
   */
  WHATSAPP_APP_SECRET: z.string().min(1).optional(),
  /**
   * The number messages are sent from, as Meta's own id for it rather than the
   * number itself. A business can move its number between Cloud API numbers and
   * the id is what the send endpoint is addressed by.
   */
  WHATSAPP_PHONE_NUMBER_ID: z.string().min(1).optional(),
  /** System-user token for the Cloud API. Long-lived, and a secret. */
  WHATSAPP_ACCESS_TOKEN: z.string().min(1).optional(),
  /**
   * The string Meta echoes back when it verifies the webhook URL. Meta sends it
   * in a query parameter on a `GET`, which is why it is a value of its own and
   * not the app secret: it travels in a URL, and nothing that signs anything is
   * allowed to do that.
   */
  WHATSAPP_VERIFY_TOKEN: z.string().min(1).optional(),
  WHATSAPP_API_BASE_URL: z.string().min(1).default('https://graph.facebook.com'),
  WHATSAPP_HTTP_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(30_000).default(10_000),
  /** `cloud` once credentials exist, otherwise `log`, which sends nothing. */
  WHATSAPP_TRANSPORT: z.enum(['cloud', 'log']).optional(),
  /**
   * Which product a WhatsApp conversation belongs to, by code.
   *
   * One number serves the whole business, so unlike email — where the address
   * written to identifies the product — there is nothing in an inbound WhatsApp
   * message that says which product it is about. Routing rules and the agent
   * sort it out afterwards; this is where it lands first. Falls back to
   * `DEFAULT_PRODUCT_CODE`.
   */
  WHATSAPP_PRODUCT_CODE: z.string().min(1).optional(),
  /**
   * Meta's customer-service window, in hours. 24 is the platform's rule, not a
   * preference — free-form replies outside it are refused by the provider — and
   * it is configurable only so a change on Meta's side does not need a deploy.
   */
  WHATSAPP_SERVICE_WINDOW_HOURS: z.coerce.number().int().min(1).max(168).default(24),
  /**
   * The approved template used to re-open a conversation whose window has
   * closed, and the language it is approved in. Unset means an agent replying
   * outside the window is told the reply could not be delivered rather than a
   * template being invented on their behalf.
   */
  WHATSAPP_REOPEN_TEMPLATE: z.string().min(1).optional(),
  WHATSAPP_REOPEN_TEMPLATE_LANGUAGE: z.string().min(2).default('en'),

  /**
   * How long a channel thread may sit idle before its ticket pointer is
   * dropped, so the next message opens new work instead of reopening something
   * the desk finished. Seven days by default: long enough that a customer who
   * replies after a weekend joins the same ticket, short enough that "I have
   * another problem" next month is not filed as the old one.
   */
  CONVERSATION_IDLE_HOURS: z.coerce.number().int().min(1).max(8760).default(168),
  CONVERSATION_SWEEP_CRON: z.string().min(1).default('20 * * * *'),

  // ---- omnichannel: live chat ----------------------------------------------
  /** Off refuses new chat sessions; existing tickets are unaffected. */
  CHAT_ENABLED: booleanish.default(true),
  /** Socket.IO namespace the visitor widget connects to. */
  CHAT_NAMESPACE: z.string().min(1).default('/chat'),
  /**
   * How long a visitor's session token is good for. Long enough to survive a
   * page reload mid-conversation, short enough that a token left in a shared
   * browser is not a way back into somebody else's thread tomorrow.
   */
  CHAT_SESSION_TTL_MINUTES: z.coerce.number().int().min(5).max(1440).default(120),
  /** Which product a chat lands in when the widget does not name one. */
  CHAT_PRODUCT_CODE: z.string().min(1).optional(),
  /**
   * Messages one visitor may send per minute. A chat widget is unauthenticated
   * by construction, so this is the only thing between a bored visitor and a
   * thousand ticket messages.
   */
  CHAT_MESSAGE_RATE_PER_MINUTE: z.coerce.number().int().min(1).max(600).default(30),

  // ---- federated sign-in (SSO) ---------------------------------------------
  /**
   * Where the identity provider sends the browser back. It is the **console's**
   * callback route, not an API route: the console reads `code` and `state` out
   * of its own URL and posts them to `/auth/sso/callback`, which keeps the
   * session tokens out of a URL the way every other credential in this system
   * is kept out of one. Derived from `APP_WEB_URL` unless set.
   */
  SSO_REDIRECT_URL: z.string().min(1).optional(),
  /**
   * How long a started sign-in stays completable. Ten minutes: long enough for
   * a password manager and a second factor at the provider, short enough that a
   * `state` captured from a browser's history is useless.
   */
  SSO_LOGIN_REQUEST_TTL_MINUTES: z.coerce.number().int().min(1).max(60).default(10),
  /**
   * How long a provider's OpenID discovery document is reused. An hour: these
   * change when a provider rotates an endpoint, which is rare, and the signing
   * keys behind it are fetched and cached separately by their own `kid`.
   */
  SSO_DISCOVERY_CACHE_SECONDS: z.coerce.number().int().min(0).max(86_400).default(3_600),
  /** Budget for one call to a provider's discovery, JWKS or token endpoint. */
  SSO_HTTP_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(30_000).default(8_000),
  /**
   * Allows an `http` or loopback issuer, which is what the test suite's own
   * provider is. Refused in production: an issuer reachable over plain HTTP is
   * an identity provider anyone on the path can impersonate.
   */
  SSO_ALLOW_INSECURE_ISSUER: booleanish.default(false),

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

  if (!value.RESEND_WEBHOOK_SECRET) {
    ctx.addIssue({
      code: 'custom',
      path: ['RESEND_WEBHOOK_SECRET'],
      message: 'is required in production to verify inbound email webhooks',
    });
  }

  // An unscanned attachment store is a malware distribution channel with a
  // support desk attached. Opting out is allowed, but it has to be deliberate.
  if (!value.ANTIVIRUS_HOST && value.ANTIVIRUS_DRIVER !== 'none') {
    ctx.addIssue({
      code: 'custom',
      path: ['ANTIVIRUS_HOST'],
      message:
        'is required in production (or set ANTIVIRUS_DRIVER=none to accept unscanned attachments deliberately)',
    });
  }

  if ((value.STORAGE_BACKEND ?? 'local') === 'local') {
    ctx.addIssue({
      code: 'custom',
      path: ['STORAGE_BUCKET'],
      message:
        'object storage must be configured in production; local disk does not survive a redeploy',
    });
  }

  // Rate-limit counters, cached permissions and socket rooms all live in
  // process memory without it. One instance behaves; two disagree about who is
  // over their limit and never see each other's broadcasts, which is a bug that
  // only appears under the load that made you scale out.
  if (!value.REDIS_URL && value.CACHE_DRIVER !== 'memory') {
    ctx.addIssue({
      code: 'custom',
      path: ['REDIS_URL'],
      message:
        'is required in production (or set CACHE_DRIVER=memory to run a single instance deliberately)',
    });
  }

  // An issuer reachable over plain HTTP, or on a host only this process can
  // reach, is an identity provider that can be impersonated by anyone on the
  // path — and it authenticates staff into a support desk.
  if (value.SSO_ALLOW_INSECURE_ISSUER) {
    ctx.addIssue({
      code: 'custom',
      path: ['SSO_ALLOW_INSECURE_ISSUER'],
      message: 'cannot be enabled in production; an identity provider must be reachable over https',
    });
  }

  // A WhatsApp ingress with no app secret accepts anything that reaches the
  // URL. There is no `log` escape hatch for this one: the alternative to
  // verifying is trusting the internet about who a customer is.
  if (value.WHATSAPP_TRANSPORT !== 'log' && value.WHATSAPP_ACCESS_TOKEN) {
    if (!value.WHATSAPP_APP_SECRET) {
      ctx.addIssue({
        code: 'custom',
        path: ['WHATSAPP_APP_SECRET'],
        message: 'is required in production to verify inbound WhatsApp webhooks',
      });
    }
    if (!value.WHATSAPP_PHONE_NUMBER_ID) {
      ctx.addIssue({
        code: 'custom',
        path: ['WHATSAPP_PHONE_NUMBER_ID'],
        message: 'is required to send WhatsApp replies',
      });
    }
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

/**
 * `inline` under test so a suite that never starts a queue still exercises the
 * job handlers; `pgboss` everywhere else, including development, where the
 * Docker database is already running and the cron surface is the point.
 *
 * Setting `QUEUE_DRIVER=inline` in production is allowed but means no schedule
 * ever fires — the queue module warns about it at boot.
 */
export const queueDriver: 'pgboss' | 'inline' =
  env.QUEUE_DRIVER ?? (env.NODE_ENV === 'test' ? 'inline' : 'pgboss');

/**
 * `clamav` once a scanner host is configured, otherwise `none`, which records
 * every upload as `skipped` rather than claiming it is clean.
 */
export const antivirusDriver: 'clamav' | 'none' =
  env.ANTIVIRUS_DRIVER ?? (env.ANTIVIRUS_HOST ? 'clamav' : 'none');

/**
 * `redis` once a URL is configured, otherwise `memory`, which keeps development
 * and the test suite free of a second service to run. The memory driver is
 * honest rather than equivalent: its cache, rate-limit counters and socket
 * rooms are per-process, so it reports `not_configured` on `/readyz` and is
 * refused in production unless chosen explicitly.
 */
export const cacheDriver: 'redis' | 'memory' =
  env.CACHE_DRIVER ?? (env.REDIS_URL ? 'redis' : 'memory');

/**
 * `s3` once a bucket and credentials exist, otherwise the local-disk backend so
 * development and tests need no cloud account. Same upload flow either way.
 */
export const storageBackend: 'local' | 's3' =
  env.STORAGE_BACKEND ??
  (env.STORAGE_BUCKET && env.STORAGE_ACCESS_KEY_ID && env.STORAGE_SECRET_ACCESS_KEY
    ? 's3'
    : 'local');

/**
 * `cloud` once an access token and a phone number id exist, otherwise `log`,
 * which records what it would have sent instead of sending it — the same
 * bargain `EMAIL_TRANSPORT` makes, and what lets the whole omnichannel path be
 * exercised without a Meta business account.
 */
export const whatsappTransport: 'cloud' | 'log' =
  env.WHATSAPP_TRANSPORT ??
  (env.WHATSAPP_ACCESS_TOKEN && env.WHATSAPP_PHONE_NUMBER_ID ? 'cloud' : 'log');

/**
 * The console route the provider redirects back to, derived from `APP_WEB_URL`
 * unless overridden. It is registered with the provider and sent again on the
 * token exchange, where the provider checks the two match — so this value and
 * the one in the provider's console have to agree exactly, trailing slash
 * included, which is why it is normalised here rather than at each call site.
 */
export const ssoRedirectUrl: string =
  env.SSO_REDIRECT_URL ?? `${env.APP_WEB_URL.replace(/\/+$/, '')}/auth/sso/callback`;

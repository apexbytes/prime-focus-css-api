# Prime Focus CSS — API Structure

Central customer support API for all Prime Focus products. This document is the
implementation outline: stack, folder layout, module inventory, data model,
endpoints, and build order. It is deliberately narrower than
`customer-support-system.md` — see §11 for what was cut and why.

---

## 1. Stack decisions

| Concern            | Choice                                                                        | Why                                                                                                                                         |
| ------------------ | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Runtime            | Node.js 24 LTS + TypeScript 6.x (ESM, `NodeNext`)                             | Current LTS; ESM avoids the CJS/ESM interop tax later. TypeScript is held at 6.x because `typescript-eslint` has no stable TS 7 support yet |
| HTTP               | Express 5                                                                     | Native async error propagation, largest middleware ecosystem, easiest hiring pool                                                           |
| DB                 | PostgreSQL 16                                                                 | Relational core (tickets/SLA/audit), plus `tsvector` FTS and `jsonb` for channel payloads                                                   |
| DB access          | Drizzle ORM + `pg`                                                            | Schema lives in `*.model.ts` per entity — matches the modular convention; SQL-first, typed, real migrations                                 |
| Migrations         | `drizzle-kit` (SQL files, checked in)                                         | Reviewable, replayable, no runtime schema sync                                                                                              |
| Validation         | Zod                                                                           | One schema drives runtime validation + inferred TS types                                                                                    |
| Auth               | JWT access (15 min) + rotating refresh tokens in Postgres; Argon2id passwords | Stateless reads, revocable sessions                                                                                                         |
| MFA                | TOTP via `otplib` + hashed recovery codes                                     | Mandatory for staff, no SMS cost/SIM-swap risk                                                                                              |
| Email              | Resend (outbound + inbound webhook)                                           | Requirement; inbound webhook is the email→ticket channel                                                                                    |
| Logging            | Winston + `AsyncLocalStorage` correlation IDs                                 | Requirement; JSON to stdout, daily-rotate file in prod                                                                                      |
| Async work         | `pg-boss` (Postgres-backed queue + cron)                                      | Retries, scheduling, dead-letter — no extra broker to run (see §11)                                                                         |
| Realtime           | `socket.io` (Phase 3)                                                         | Ticket locks, typing indicators, live queue counts                                                                                          |
| File storage       | S3-compatible object store, presigned uploads                                 | Attachments never transit the API process                                                                                                   |
| Cache / rate limit | Redis (Phase 2)                                                               | Token buckets, KB search cache, socket adapter                                                                                              |
| Tests              | Vitest + Supertest + Testcontainers Postgres                                  | Real DB in integration tests, no mock drift                                                                                                 |

---

## 2. Repository layout

```
prime-focus-css/
├── docs/
│   ├── api-structure.md
│   └── adr/                          # one file per architectural decision
├── drizzle/                          # generated SQL migrations + snapshots
├── src/
│   ├── index.ts                      # process entry: load config, start server + workers
│   ├── app.ts                        # express app assembly (no listen) — importable by tests
│   ├── server.ts                     # http server, graceful shutdown, signal handlers
│   │
│   ├── config/
│   │   ├── env.ts                    # zod-validated process.env, fail-fast at boot
│   │   ├── constants.ts
│   │   └── index.ts
│   │
│   ├── db/
│   │   ├── client.ts                 # pg Pool + drizzle instance + readiness probe
│   │   ├── schema.ts                 # barrel re-exporting every *.model.ts
│   │   ├── transaction.ts            # withTransaction() + afterCommit hooks
│   │   ├── migrate.ts                # extensions, then the drizzle migrator
│   │   ├── models/                   # infra tables with no owning module
│   │   └── seeds/                    # roles, permissions, products, business hours
│   │
│   ├── common/
│   │   ├── errors/                   # AppError + typed subclasses, error codes enum
│   │   ├── middleware/
│   │   │   ├── authenticate.ts       # JWT / API-key → req.actor
│   │   │   ├── authorize.ts          # requirePermission('ticket:assign')
│   │   │   ├── validate.ts           # zod body/query/params
│   │   │   ├── correlationId.ts
│   │   │   ├── requestLogger.ts
│   │   │   ├── rateLimit.ts
│   │   │   ├── idempotency.ts        # Idempotency-Key for writes
│   │   │   └── errorHandler.ts       # last middleware, maps AppError → envelope
│   │   ├── utils/                    # response envelope, lifecycle flag, pagination, dates
│   │   ├── context/                  # AsyncLocalStorage request context
│   │   ├── types/                    # Actor, Paginated<T>, ApiResponse<T>, express augmentation
│   │   └── events/                   # typed in-process event bus → queue producers
│   │
│   ├── lib/                          # thin third-party adapters, swappable
│   │   ├── logger/                   # winston setup + child loggers
│   │   ├── resend/                   # client wrapper, retry, template renderer
│   │   ├── queue/                    # pg-boss bootstrap, job registry, schedules
│   │   └── storage/                  # object storage presign/get/delete
│   │
│   ├── modules/                      # one folder per entity — see §3
│   │   ├── auth/
│   │   ├── mfa/
│   │   ├── user/
│   │   ├── role/
│   │   ├── team/
│   │   ├── product/
│   │   ├── customer/
│   │   ├── ticket/
│   │   ├── message/
│   │   ├── attachment/
│   │   ├── category/
│   │   ├── tag/
│   │   ├── routing/
│   │   ├── sla/
│   │   ├── escalation/
│   │   ├── macro/
│   │   ├── knowledge-base/
│   │   ├── survey/
│   │   ├── notification/
│   │   ├── email/
│   │   ├── audit/
│   │   ├── report/
│   │   ├── api-key/
│   │   ├── webhook/
│   │   └── health/
│   │
│   ├── routes/
│   │   └── v1.ts                     # mounts every module router under /api/v1
│   └── workers/
│       └── index.ts                  # registers job handlers exported by modules
├── tests/
│   ├── helpers/                      # test db, auth fixtures, factories
│   └── e2e/
├── .github/workflows/ci.yml          # format, lint, typecheck, tests, build
├── .env.example
├── docker-compose.yml                # local PostgreSQL (host port 5434)
├── drizzle.config.ts
├── eslint.config.js                  # incl. enforced architectural boundaries
├── vitest.config.ts
├── tsconfig.json                     # typecheck (src + tests)
├── tsconfig.build.json               # emit (src only, tests excluded)
├── README.md
└── package.json
```

### Per-module file convention

Every entity folder uses the same shape. Files are added only when needed —
no empty placeholders.

```
ticket/
├── ticket.routes.ts        # express Router, middleware wiring only
├── ticket.controller.ts    # HTTP in / HTTP out. No business logic, no SQL
├── ticket.service.ts       # business rules, transactions, orchestration
├── ticket.repository.ts    # all SQL for this entity (drizzle queries)
├── ticket.model.ts         # drizzle table + relations + inferred row types
├── ticket.schema.ts        # zod request/response schemas
├── ticket.types.ts         # domain types, enums, DTOs
├── ticket.events.ts        # event names + payload types this module emits
├── ticket.jobs.ts          # queue handlers owned by this module (optional)
├── ticket.policy.ts        # can-this-actor-do-this checks (optional)
├── ticket.mapper.ts        # row → API DTO (optional)
├── ticket.service.test.ts
├── ticket.routes.test.ts
└── index.ts                # barrel: router, service, jobs, events
```

One exception to "every table lives in its module": tables that belong to no
business entity — the idempotency replay log, and later the queue's own tables —
live in `src/db/models/`. `src/db/schema.ts` barrels both sources, and it is the
only file `drizzle-kit` reads.

**Dependency rule (enforced by lint, `eslint-plugin-boundaries`):**
`routes → controller → service → repository → db`. Controllers never touch
repositories. Repositories never call services. Cross-module calls go
service → service via the other module's `index.ts` barrel — never into
another module's repository.

---

## 3. Module inventory

Grouped by domain; each is a folder in `src/modules/`.

### 3.1 Identity & access

- **auth** — register (staff invite accept), login, refresh, logout, logout-all, password reset, email verification, session listing.
- **mfa** — TOTP enrol/verify/disable, recovery codes, step-up challenge during login.
- **user** — staff CRUD, status (active/suspended), profile, availability (online/away/offline), skills, capacity limits.
- **role** — roles, permissions catalogue, role↔permission matrix. Permissions are string codes (`ticket:read`, `ticket:assign`, `report:view`, `user:manage`).
- **team** — teams, membership, per-product team defaults, business hours binding.
- **api-key** — machine credentials issued to Prime Focus product systems so they can create tickets on a customer's behalf. Hashed at rest, scoped, revocable.

### 3.2 Customer & product context

- **product** — the Prime Focus product catalogue (code, name, active). Every ticket, SLA policy, category, and KB article is product-scoped. This is the tenancy axis of the whole system.
- **customer** — end users: contact details, language, tier, per-product account links (`customer_product_accounts`), merge of duplicate identities, 360° timeline endpoint.

### 3.3 Ticketing core

- **ticket** — lifecycle (`new → open → pending → on_hold → resolved → closed`, plus `reopened`), priority, reference generation (`PF-2026-000123`), bulk operations, filtered/saved views.
- **message** — thread entries. `visibility: public | internal`, author is customer/agent/system, carries the channel-specific external ID for email threading.
- **attachment** — presigned upload, virus-scan job, download authorisation.
- **category** / **tag** — hierarchical categories per product; free tags for reporting.
- **routing** — assignment engine: rules (product, category, language, tier) → team → agent, using availability + open-ticket capacity. Round-robin fallback, manual reassignment with reason, assignment history.
- **macro** — canned responses and one-click macros (apply body + set status/priority/tags/assignee in one action).

### 3.4 Service levels

- **sla** — policies per product × priority (first-response minutes, resolution minutes), business-hours calendars incl. Zimbabwe public holidays, per-ticket targets, pause on `pending customer`, breach records.
- **escalation** — escalation ladder, triggers at % of SLA consumed, notify + reassign, escalation audit.

### 3.5 Self-service & feedback

- **knowledge-base** — articles with draft/review/published states, product + category scoping, Postgres full-text search (`tsvector`, weighted title/body), view + helpfulness counters, "suggested articles" endpoint the ticket-creation flow calls for deflection.
- **survey** — CSAT: token-based one-click rating emailed after resolution, score + comment, aggregation per agent/team/product.

### 3.6 Platform services

- **email** — Resend outbound send with templates; inbound webhook (signature-verified) that parses replies, matches the ticket by reference/`Message-ID`, and appends a message or opens a new ticket; delivery/bounce/complaint event log.
- **notification** — in-app notification records + fan-out to email; per-user preferences; digest job.
- **webhook** — outbound subscriptions so other Prime Focus systems can react to ticket events; HMAC-signed, retried with backoff, delivery log.
- **audit** — append-only trail of every state change (actor, action, entity, before/after, IP, UA). Written inside the same transaction as the change. Read-only API for admins.
- **report** — FRT, resolution time, SLA compliance, volume by product/channel/category, agent throughput, CSAT. Served from materialised views refreshed on a schedule, not from live ticket scans.
- **health** — `/healthz` (liveness), `/readyz` (DB + queue + Resend reachability), `/metrics`.

---

## 4. Data model (core tables)

Conventions: `uuid` v7 primary keys, `created_at`/`updated_at` timestamptz,
soft delete only where legally useful (`deleted_at` on customer/user), all
timestamps stored UTC and rendered in `Africa/Harare`.

**Identity**
`users`, `roles`, `permissions`, `role_permissions`, `teams`, `team_members`,
`agent_skills`, `sessions` (refresh-token families), `password_reset_tokens`,
`email_verification_tokens`, `mfa_secrets`, `mfa_recovery_codes`,
`login_attempts`, `api_keys`.

**Context**
`products`, `customers`, `customer_product_accounts`, `customer_merges`.

**Ticketing**
`tickets`, `ticket_messages`, `attachments`, `categories`, `tags`,
`ticket_tags`, `ticket_assignments` (history), `ticket_watchers`,
`ticket_locks`, `macros`.

**Service levels**
`sla_policies`, `business_hours`, `holidays`, `ticket_sla_targets`,
`sla_breaches`, `escalation_rules`, `escalations`.

**Self-service**
`kb_articles`, `kb_article_revisions`, `kb_article_feedback`, `kb_views`,
`csat_responses`.

**Platform**
`notifications`, `notification_preferences`, `outbound_emails`,
`email_events`, `webhook_subscriptions`, `webhook_deliveries`, `audit_logs`,
`idempotency_keys`. (`pg-boss` owns its own `pgboss` schema.)

**Indexes that matter from day one**

- `tickets (status, assigned_to)`, `tickets (product_id, status, created_at desc)`
- `tickets (reference)` unique
- `ticket_messages (ticket_id, created_at)`
- `ticket_sla_targets (due_at) where breached_at is null` — the escalation cron's only scan
- `kb_articles` GIN on `search_vector`
- `audit_logs (entity_type, entity_id, created_at desc)`

**Key state machine** — enforced in `ticket.service.ts`, not the DB:
transitions are whitelisted, each one writes an `audit_log` row and emits a
`ticket.*` event in the same transaction.

---

## 5. API surface

Base path `/api/v1`. Staff endpoints require a session JWT; the customer
portal uses the same JWT with a `customer` actor type; product systems use
API keys.

```
POST   /auth/login                      → tokens | { mfaRequired, challengeId }
POST   /auth/mfa/verify
POST   /auth/refresh
POST   /auth/logout
POST   /auth/password/forgot | /reset
GET    /auth/me
GET    /auth/sessions                   DELETE /auth/sessions/:id

POST   /mfa/enrol | /mfa/activate | /mfa/recovery-codes   DELETE /mfa

GET    /users  POST /users  GET|PATCH /users/:id
PATCH  /users/:id/status | /users/:id/availability | /users/:id/skills
GET    /roles  POST /roles  PATCH /roles/:id  GET /permissions
GET    /teams  POST /teams  POST /teams/:id/members

GET    /products  POST /products  PATCH /products/:id

GET    /customers?search=  POST /customers  GET|PATCH /customers/:id
GET    /customers/:id/tickets | /timeline
POST   /customers/:id/merge

GET    /tickets?status=&product=&assignee=&priority=&sla=&q=&cursor=
POST   /tickets                         (Idempotency-Key required)
GET    /tickets/:id
PATCH  /tickets/:id                     (status, priority, category, product)
POST   /tickets/:id/assign | /escalate | /merge | /reopen
POST   /tickets/bulk                    (bulk status/assign/tag)
GET    /tickets/:id/messages   POST /tickets/:id/messages   (public|internal)
POST   /tickets/:id/attachments/presign
POST   /tickets/:id/tags       DELETE /tickets/:id/tags/:tagId
POST   /tickets/:id/lock       DELETE /tickets/:id/lock
GET    /tickets/:id/audit

GET    /macros  POST /macros  POST /tickets/:id/macros/:macroId/apply

GET    /sla-policies  POST /sla-policies  PATCH /sla-policies/:id
GET    /business-hours  PUT /business-hours/:id
GET    /escalation-rules  POST /escalation-rules

GET    /kb/articles?product=&q=   POST /kb/articles
GET|PATCH /kb/articles/:id        POST /kb/articles/:id/publish
GET    /kb/search?q=&product=     POST /kb/articles/:id/feedback
GET    /kb/suggest?subject=&body= (deflection, called before ticket create)

GET    /surveys/:token            POST /surveys/:token   (public, unauthenticated)
GET    /reports/overview | /sla | /agents | /csat | /volume
GET    /notifications  PATCH /notifications/:id/read  PUT /notification-preferences

POST   /webhooks/resend/inbound   (Resend signature verified, no auth)
POST   /webhooks/resend/events
GET    /webhook-subscriptions  POST /webhook-subscriptions
GET    /audit-logs?entity=&actor=&from=&to=
GET    /api-keys  POST /api-keys  DELETE /api-keys/:id
GET    /healthz | /readyz          (mounted at the root, NOT under /api/v1 —
                                    orchestrators expect unversioned probes)
```

### Response contract

```jsonc
// success
{ "success": true, "data": { }, "meta": { "requestId": "…", "pagination": { } } }
// error
{ "success": false, "error": { "code": "TICKET_INVALID_TRANSITION",
  "message": "Cannot resolve a ticket that is on hold",
  "details": [{ "field": "status", "issue": "…" }] },
  "meta": { "requestId": "…" } }
```

Cursor pagination on every list (`?cursor=&limit=`, max 100). Errors carry a
stable machine `code` from a single enum, never a raw driver message.

---

## 6. Cross-cutting rules

- **Product scoping is not optional.** Every list query filters by the
  products the actor's role grants. A tier-1 agent on Product A cannot read
  Product B's tickets. Enforced in the repository layer signature (every
  ticket query takes a `productScope`), not left to callers.
- **Correlation IDs.** `x-request-id` (or generated) is put in
  `AsyncLocalStorage` at the edge; every Winston line, DB slow-query log, and
  queued job inherits it, so an email bounce three hops later traces back to
  the request that sent it.
- **Logging discipline.** No PII in logs — no full names, phone numbers,
  national IDs, or account numbers. Log IDs and reference codes; add a
  redaction serialiser in the Winston format chain as the safety net.
- **Idempotency.** Every unsafe POST that creates a ticket, message, or email
  accepts `Idempotency-Key`; the key + response are stored for 24h.
- **Transactions.** `withTransaction()` wraps service methods that touch more
  than one table. Domain events are collected in the transaction and only
  published to the queue after commit.
- **Rate limits.** Per-IP on `/auth/*`, per-actor on writes, per-API-key
  quotas for product systems.
- **Secrets.** MFA secrets and API keys encrypted/hashed at rest; JWT signing
  key from env, rotatable via `kid`.
- **Compliance.** Zimbabwe's Cyber and Data Protection Act (2021) shapes
  retention: audit logs 7 years, ticket bodies 5 years, then anonymise
  customer PII in place; attachment deletion is hard, its audit row is not.
- **Graceful shutdown.** SIGTERM → stop accepting, drain in-flight requests,
  let pg-boss finish current jobs, close pool.

---

## 7. Async jobs (`pg-boss`)

| Job                     | Trigger                      | Owner module |
| ----------------------- | ---------------------------- | ------------ |
| `email.send`            | queued on notification/reply | email        |
| `email.inbound.process` | Resend inbound webhook       | email        |
| `ticket.triage`         | ticket created               | routing      |
| `ticket.autoassign`     | after triage                 | routing      |
| `sla.scan`              | cron, every minute           | sla          |
| `sla.escalate`          | from scan                    | escalation   |
| `survey.dispatch`       | ticket resolved + delay      | survey       |
| `attachment.scan`       | upload confirmed             | attachment   |
| `webhook.deliver`       | domain event                 | webhook      |
| `report.refresh`        | cron, every 15 min           | report       |
| `notification.digest`   | cron, daily 07:00 CAT        | notification |
| `retention.sweep`       | cron, weekly                 | audit        |

Webhook ingress does the minimum synchronously (verify signature, persist raw
payload, 200) and queues the parse. A Resend outage must never turn into a
5xx on the customer's reply.

---

## 8. Build order

**Phase 1 — foundation (walking skeleton)** — _complete_
Zod-validated `config/env`, pg pool + Drizzle client, first migration
(`pgcrypto`/`citext`/`pg_trgm` + `idempotency_keys`), Winston with
AsyncLocalStorage correlation IDs and PII redaction, the error taxonomy and
terminal error handler, request logging, rate limiting, `validate` middleware,
`withTransaction` + `afterCommit`, the health module (`/healthz`, `/readyz`),
`app.ts`/`server.ts` with graceful shutdown, Docker Compose, and CI running
format + lint + typecheck + tests + build.

Two additions beyond the original Phase 1 list, both deliberate:

- **`Idempotency-Key` middleware.** The first migration needs a table, and the
  only Phase-1-appropriate table is the idempotency log — shipping it without its
  consumer would have left dead schema. It is applied per-route, so nothing uses
  it until the Phase 3 write endpoints exist.
- **Local PostgreSQL on host port 5434**, because 5432 and 5433 are commonly
  already taken. The container port is unchanged; CI uses 5432.

**Phase 2 — identity**
auth, mfa, user, role, team, api-key, audit. Ends with: an admin can invite an
agent, the agent logs in with TOTP, and every action is audited.

**Phase 3 — ticketing core**
product, customer, ticket, message, attachment, category, tag, macro,
notification, email (outbound + inbound). Ends with: a customer emails
support and an agent replies from the API, threaded correctly.

**Phase 4 — routing & SLA**
routing, sla, business hours, escalation, the pg-boss cron surface. Ends with:
tickets auto-assign and breaches escalate without human input.

**Phase 5 — deflection & insight**
knowledge-base + search, survey/CSAT, report views.

**Phase 6 — realtime & scale**
socket.io (locks, typing, live counts), Redis cache + rate limits, outbound
webhook subscriptions.

**Phase 7 — federation**
OAuth2/OIDC SSO (Google/Microsoft) and, if an enterprise partner requires it,
SAML — as an additional strategy behind the existing `auth` module, not a
rewrite of it.

---

## 9. Environment

```
NODE_ENV, PORT, API_BASE_URL, LOG_LEVEL
DATABASE_URL, DB_POOL_MAX, DB_SSL
JWT_SECRET, JWT_ACCESS_TTL, JWT_REFRESH_TTL, JWT_KID
ARGON2_MEMORY_COST
MFA_ISSUER, ENCRYPTION_KEY
RESEND_API_KEY, RESEND_FROM, RESEND_INBOUND_SECRET, SUPPORT_INBOX_DOMAIN
STORAGE_ENDPOINT, STORAGE_BUCKET, STORAGE_KEY, STORAGE_SECRET
REDIS_URL                      # phase 6
RATE_LIMIT_WINDOW, RATE_LIMIT_MAX
DEFAULT_TIMEZONE=Africa/Harare
```

`config/env.ts` parses these with Zod and throws at boot on anything missing
or malformed — never `process.env.X` anywhere else in the codebase.

---

## 10. Testing

- **Unit** — services with a stubbed repository; state machine, SLA clock
  arithmetic across business hours/holidays, and routing scoring get the
  heaviest coverage.
- **Integration** — routes through a real Postgres (Testcontainers), migrated
  and seeded per suite. Resend and object storage are faked at the `lib/`
  adapter boundary.
- **Contract** — Resend inbound webhook fixtures (plain reply, HTML reply,
  forwarded chain, autoresponder, attachment) as golden files.
- **Authorisation matrix** — a table-driven test asserting each role × endpoint
  outcome. This is the one suite that must never be skipped: RBAC regressions
  in a fintech leak customer financial data.

---

## 11. Scope deviations from the draft

Called out so the trade-offs are explicit, not silently dropped:

1. **Kafka/RabbitMQ → `pg-boss`.** The draft's spike-absorption goal is real,
   but a broker is a second stateful system to operate. Postgres-backed
   queueing handles Prime Focus's volume, gives transactional
   enqueue-with-commit for free, and swapping it later only touches
   `lib/queue/`.
2. **AI/NLP triage → deterministic rules first.** Phase 4 routing uses
   metadata rules. Sentiment and auto-categorisation land behind the same
   `routing.service` interface once there is labelled ticket data to justify
   a model — the interface is designed for it now, the model isn't built now.
3. **VoIP and social channels deferred.** The channel abstraction (`channel`
   enum + `source_metadata jsonb` + one adapter per channel in `lib/`) is in
   from day one; only email, web form, and product-system API are implemented.
   Adding WhatsApp is a new adapter, not a schema change.
4. **Data lake → materialised views.** Real-time dashboards come from Postgres
   materialised views refreshed on a schedule. A warehouse export is a Phase 6+
   concern once reporting queries actually contend with transactional load.
5. **SSO moved last.** Local auth + mandatory TOTP secures staff now; SSO is
   an added strategy in Phase 7, not a prerequisite.
6. **Full microservices → modular monolith.** Every module already owns its
   routes/service/repository/schema with enforced boundaries, so any of them
   can be extracted later. Starting distributed would buy distributed-tracing
   pain before there is load to justify it.

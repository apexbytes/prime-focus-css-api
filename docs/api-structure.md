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
| MFA                | Emailed one-time code + 30-day trusted devices                                | No enrolment step, no shared secret at rest, and no authenticator app for agents to lose. Trusted devices keep the friction off every login |
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
repositories. Repositories never call services. Cross-module calls go service → service
by importing the other module's `*.service.ts` directly; the `index.ts` barrel is for
router and app wiring. Reaching another module's **repository** is what the rule forbids.

Two exceptions the lint config allows explicitly, because forbidding them would be worse:
a repository may join another module's _table_ (one database, one schema — the alternative
is N+1 queries across service calls), and a `*.types.ts` may import another module's DTOs,
which is compile-time only.

`auth.service` and `user.service` import each other: login has to read users, and
suspending a user has to revoke sessions. Both export hoisted function declarations and
touch each other only inside function bodies, so the ES module cycle resolves safely.

---

## 3. Module inventory

Grouped by domain; each is a folder in `src/modules/`.

### 3.1 Identity & access

- **auth** — login (password, then an emailed code), OTP verify/resend, refresh with
  rotation and reuse detection, logout, logout-everywhere, password reset and change,
  session listing and revocation. **There is no register or sign-up endpoint**: accounts
  exist only by invitation.
- **mfa** — issues and verifies the emailed login code, and manages trusted devices
  (`/auth/devices`). Not TOTP: there is no enrolment and no shared secret stored, so a
  lost phone costs nothing. A device that has passed one code may skip the challenge for
  `TRUSTED_DEVICE_TTL_DAYS`; the password is still required every time.
- **invitation** — the only way a staff account comes into existence. An account holder
  with `user:invite` supplies email, name and **the role the invitee will hold**; the
  account is created in `invited` state with no password, and a one-time link is emailed.
  Accepting sets the password, activates the account and signs the user in.
- **user** — staff CRUD, status (active/suspended), profile, availability (online/away/offline), skills, capacity limits.
- **role** — roles, permissions catalogue, role↔permission matrix. Permissions are string codes (`ticket:read`, `ticket:assign`, `report:view`, `user:manage`).
- **team** — teams, membership, per-product team defaults, business hours binding.
- **api-key** — machine credentials issued to Prime Focus product systems so they can create tickets on a customer's behalf. Hashed at rest, scoped, revocable.

### 3.2 Customer & product context

- **product** — the Prime Focus product catalogue, and the tenancy axis of the whole system. Access is **per agent**: `user_products` records who may work which product, and every ticket read takes a scope argument derived from it. An agent with no grant sees nothing; only holders of `ticket:read_all_products` (administrators) bypass it. A ticket outside the caller's scope answers **404, not 403** — whether it exists is itself information. Products also carry a `supportEmail`, which is how inbound mail is routed.
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

**Identity** — built in Phase 2
`users`, `roles`, `permissions`, `role_permissions`, `invitations`, `teams`,
`team_members`, `sessions` (refresh-token families), `password_reset_tokens`,
`login_attempts`, `otp_challenges`, `trusted_devices`, `api_keys`, `audit_logs`.

No `mfa_secrets` or `mfa_recovery_codes`: an emailed code needs neither. No
`email_verification_tokens` either — accepting an invitation _is_ the proof of address
control, so a separate verification step would verify the same fact twice.
`agent_skills` arrived with Phase 4 routing, alongside `availability` and
`max_open_tickets` on `users`.

**Context**
`products`, `customers`, `customer_product_accounts`, `customer_merges`.

**Ticketing** — built in Phase 3
`products`, `user_products`, `customers`, `customer_product_accounts`, `categories`,
`tickets`, `ticket_messages`, `ticket_assignments` (history), `ticket_watchers`, `tags`,
`ticket_tags`, `attachments`, `macros`, `inbound_emails`, `outbound_emails`,
`email_events`, `notifications`, `notification_preferences`, plus the
`ticket_reference_seq` sequence.

`ticket_locks` waits for Phase 6, alongside the WebSocket layer that would use it.
Ticket references come from a **sequence**, not a count: two concurrent creates would
otherwise race to the same number.

**Service levels & routing** — built in Phase 4
`business_hours`, `holidays`, `sla_policies`, `ticket_sla_targets`,
`sla_breaches`, `escalation_rules`, `escalations`, `routing_rules`,
`agent_skills`, plus `availability` and `max_open_tickets` on `users`.

`business_hours` holds one week as `jsonb` rather than a child table of windows —
the clock loads a whole calendar to compute against and never queries a single
window. `holidays` is calendar-scoped and keyed on a `date`, because a public
holiday is a local calendar day and which UTC instants that covers depends on the
calendar's zone.

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
- `ticket_sla_targets (due_at) where satisfied_at is null and breached_at is null and paused_at is null`
  — the breach scan's only query. `sla.repository.dueTargets` filters on exactly
  these three columns; if they drift the scan silently stops using the index
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
POST   /auth/login                  { email, password, deviceToken? }
                                    → { status: 'authenticated', tokens, user }
                                    | { status: 'otp_required', challengeId, expiresAt }
POST   /auth/otp/verify             { challengeId, code, trustDevice? } → tokens [+ deviceToken]
POST   /auth/otp/resend             { challengeId }
POST   /auth/refresh                { refreshToken } → rotated pair
POST   /auth/logout | /auth/logout-all
GET    /auth/me                     → profile + effective permissions
GET    /auth/sessions               DELETE /auth/sessions/:id
GET    /auth/devices                DELETE /auth/devices/:id   (trusted devices)
POST   /auth/password/forgot        { email }            (always 202)
POST   /auth/password/reset         { token, password }   (revokes all sessions + devices)
POST   /auth/password/change        { currentPassword, newPassword }

POST   /invitations                 { email, fullName, roleId }   (perm user:invite)
GET    /invitations                 POST /invitations/:id/resend
DELETE /invitations/:id             (revoke)
POST   /invitations/verify          { token }             (public: render accept screen)
POST   /invitations/accept          { token, password, fullName? } → active + signed in

GET    /users  GET /users/:id       PATCH /users/me
PATCH  /users/:id                   (self, or perm user:manage)
PATCH  /users/:id/role | /users/:id/status
GET    /roles  POST /roles  GET|PATCH /roles/:id  DELETE /roles/:id
PUT    /roles/:id/permissions       (perm role:manage — super_admin only by default)
GET    /permissions
GET    /teams  POST /teams  GET|PATCH /teams/:id
POST   /teams/:id/members           DELETE /teams/:id/members/:userId
GET    /api-keys  POST /api-keys    DELETE /api-keys/:id
GET    /audit-logs?entity=&actor=&action=&from=&to=

Notably absent, by design: no POST /users, no /auth/register, no /auth/signup.

GET    /products  POST /products  PATCH /products/:id

GET    /customers?search=  POST /customers  GET|PATCH /customers/:id
GET    /customers/:id/tickets | /timeline
POST   /customers/:id/merge

GET    /products?mine=true          POST /products   GET|PATCH /products/:id
POST   /products/:id/agents         DELETE /products/:id/agents/:userId
GET    /customers?search=&tier=     POST /customers  GET|PATCH /customers/:id
POST   /customers/:id/accounts      DELETE /customers/:id/accounts/:accountId
POST   /customers/:id/merge         { duplicateId }
GET    /categories?productId=       POST /categories  PATCH|DELETE /categories/:id
GET    /tags                        POST /tags        DELETE /tags/:id

GET    /tickets?status=&priority=&productId=&assignedToUserId=&unassigned=&search=&cursor=
POST   /tickets                     (Idempotency-Key honoured)
GET    /tickets/:id
PATCH  /tickets/:id                 (subject, status, priority, category, team)
POST   /tickets/:id/assign          { assignedToUserId | null, reason? }
POST   /tickets/:id/reopen
POST   /tickets/:id/tags            DELETE /tickets/:id/tags/:tagId
POST   /tickets/:id/watch           DELETE /tickets/:id/watch
GET    /tickets/:id/assignments     (reassignment history)
GET    /tickets/:id/messages        POST /tickets/:id/messages  { body, visibility }
GET    /tickets/:id/attachments     POST /tickets/:id/attachments/upload-url
PUT    /attachments/:id/content     (local backend only)
POST   /attachments/:id/confirm     GET /attachments/:id/download
DELETE /attachments/:id
GET    /notifications               POST /notifications/read-all
PATCH  /notifications/:id/read      GET|PUT /notifications/preferences

GET    /macros  POST /macros  PATCH|DELETE /macros/:id
POST   /macros/:id/apply/:ticketId   (changes fields, returns text — sends nothing)

GET    /sla-policies  POST /sla-policies  PATCH /sla-policies/:id
GET    /business-hours  GET|PUT /business-hours/:id
POST   /business-hours/:id/holidays   DELETE /business-hours/:id/holidays/:holidayId
GET    /escalation-rules  POST /escalation-rules  PATCH|DELETE /escalation-rules/:id
GET    /routing-rules  POST /routing-rules  PATCH|DELETE /routing-rules/:id

GET    /tickets/:id/sla          (both clocks, consumed fraction, breaches)
GET    /tickets/:id/escalations  (the ladder as actually climbed)
GET    /tickets/:id/routing      (which rule would place this ticket, changing nothing)

PATCH  /users/me/availability    (an agent marks themselves online/away/offline)
PATCH  /users/:id/availability   PATCH /users/:id/capacity
GET|PUT /users/:id/skills

POST   /sla/scan                 (run the breach scan and the ladder now)
POST   /escalation-rules/run     (run only the ladder now)

GET    /kb/articles?product=&q=   POST /kb/articles
GET|PATCH /kb/articles/:id        POST /kb/articles/:id/publish
GET    /kb/search?q=&product=     POST /kb/articles/:id/feedback
GET    /kb/suggest?subject=&body= (deflection, called before ticket create)

GET    /surveys/:token            POST /surveys/:token   (public, unauthenticated)
GET    /reports/overview | /sla | /agents | /csat | /volume
GET    /notifications  PATCH /notifications/:id/read  PUT /notification-preferences

POST   /webhooks/resend/inbound   (Svix-signed, unauthenticated, mounted ahead of
                                   the rate limiter so a spike of customer email
                                   is never throttled)
POST   /webhooks/resend/events
GET    /email/inbound/unprocessed POST /email/inbound/:id/reprocess
GET    /webhook-subscriptions  POST /webhook-subscriptions
GET    /audit-logs?entity=&actor=&from=&to=
GET    /api-keys  POST /api-keys  DELETE /api-keys/:id
GET    /healthz | /readyz          (mounted at the root, NOT under /api/v1 —
                                    orchestrators expect unversioned probes)
```

**Tokens never travel in a URL.** Invitation and password-reset tokens are accepted in
the request body only (`POST /invitations/verify`, not `GET /invitations/:token`), because
URLs land in browser history, `Referer` headers and proxy logs.

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

- **Product scoping is not optional.** Every ticket read takes an explicit scope
  argument, so an omitted scope is a type error rather than a silent leak. `null` means
  unrestricted (administrators); an empty array matches nothing.
- **Message visibility is the highest-stakes flag in the system.** A `public` message is
  emailed to the customer, an `internal` note never leaves. `visibility` is a required
  field with no default — defaulting it wrong would send a private note to a customer —
  and tests assert that an internal note produces no outbound mail at all.
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
- **Secrets.** Passwords are Argon2id. Everything else presented as a bearer value —
  refresh tokens, device tokens, invitation and reset tokens, API keys — is stored only
  as an HMAC-SHA256 digest keyed by `JWT_SECRET`, so a database leak yields nothing
  replayable. Login codes are hashed the same way and additionally bound to their
  challenge id. The signing key is rotatable via `kid`.
- **Account enumeration.** A wrong password and an unknown address return an identical
  401, and both pay the same Argon2 cost (`burnPasswordVerify`). Lockout, suspension and
  not-yet-activated states are disclosed only to a caller who already supplied the correct
  password — except invited accounts, which have no password to check and must be told to
  use their invitation. `POST /auth/password/forgot` always answers 202.
- **Revocation latency.** The authenticate middleware reads the user row on every request,
  so suspension and role changes take effect immediately rather than after the access
  token's 15 minutes. Role → permission lookups are cached in-process for 60 seconds and
  invalidated on write.
- **Compliance.** Zimbabwe's Cyber and Data Protection Act (2021) shapes
  retention: audit logs 7 years, ticket bodies 5 years, then anonymise
  customer PII in place; attachment deletion is hard, its audit row is not.
- **Graceful shutdown.** SIGTERM → stop accepting, drain in-flight requests,
  let pg-boss finish current jobs, close pool.

---

## 7. Async jobs (`pg-boss`)

| Job                     | Trigger                      | Owner module | Built   |
| ----------------------- | ---------------------------- | ------------ | ------- |
| `ticket.triage`         | ticket created               | routing      | Phase 4 |
| `ticket.autoassign`     | after triage                 | routing      | Phase 4 |
| `sla.scan`              | cron, every minute           | sla          | Phase 4 |
| `sla.escalate`          | from scan                    | escalation   | Phase 4 |
| `email.send`            | queued on notification/reply | email        | inline  |
| `email.inbound.process` | Resend inbound webhook       | email        | inline  |
| `survey.dispatch`       | ticket resolved + delay      | survey       | phase 5 |
| `attachment.scan`       | upload confirmed             | attachment   | phase 5 |
| `report.refresh`        | cron, every 15 min           | report       | phase 5 |
| `webhook.deliver`       | domain event                 | webhook      | phase 6 |
| `notification.digest`   | cron, daily 07:00 CAT        | notification | phase 5 |
| `retention.sweep`       | cron, weekly                 | audit        | phase 5 |

`email.send` and `email.inbound.process` are marked _inline_: they exist and work,
but they still run in the request that causes them rather than as queued jobs.
Phase 4 deliberately did not move them — the Phase 3 email path is verified
behaviour and rewriting it buys retry-across-restart at the cost of re-proving
threading and acknowledgement. Moving them is a contained change now that
`lib/queue` exists.

Handlers are registered by `src/workers/index.ts`, which `createApp()` calls.
Registration is pure bookkeeping — a name-to-handler map — so it is safe during
app assembly; `startQueue()` is called from `server.ts`, which is why a Supertest
suite never opens a queue. The consequence is deliberate: under the `inline`
driver the handlers are present, so a test that enqueues runs the real job.

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

**Phase 2 — identity** — _complete_
auth, mfa (emailed OTP + trusted devices), invitation, user, role, team, api-key, audit,
plus the Resend adapter pulled forward from Phase 3 because invitations and login codes
both need email. 15 tables, 4 seeded roles, 21 permissions, and the single seeded
administrator that bootstraps everything else.

Verified end to end: the seeded administrator signs in with a password and an emailed
code, invites an agent with a chosen role, the agent accepts the link and sets a password,
and every step lands in the audit trail with the acting user attached.

Deviations from the original plan, all deliberate:

- **Emailed OTP instead of TOTP**, and trusted devices to keep it off every login.
- **No sign-up.** One seeded account; everyone else is invited. The invitation carries the
  role, so a new account never exists without one.
- **Resend moved from Phase 3 to Phase 2** — unavoidable once the first step of account
  creation is an email. Without an API key the transport logs the message instead of
  sending it, which is how development and tests run; production refuses to boot without a
  key unless `EMAIL_TRANSPORT=log` is set on purpose.
- **`lib/jwt`** wraps `jose`, keeping token mechanics out of the auth service.

**Phase 3 — ticketing core** — _complete_
product, customer, category, tag, ticket, message, attachment, macro, notification and
email (outbound replies + the inbound pipeline). 18 more tables, 46 more endpoints.

Verified end to end: a customer emails `wallet@support…`, a ticket opens against the right
product with the customer created from the address, an agent replies, and the customer's
response threads back onto the same ticket rather than opening a second one.

Decisions worth knowing:

- **Per-agent product access**, as chosen: `user_products` plus a scope argument threaded
  through every ticket read. An empty grant list means _nothing_, not everything — there is
  a test for exactly that, because getting it backwards would expose every product.
- **Inbound email is a two-step contract.** Resend's `email.received` webhook carries
  **metadata only** — no body, no headers — so the pipeline persists the envelope, answers
  202 immediately, and then fetches the body from `GET /emails/receiving/{id}`. The
  `inbound_emails` row is the durable queue: if processing dies the email is still there,
  and `POST /email/inbound/:id/reprocess` retries it. Phase 4 turns that into a job.
- **Threading** works on `In-Reply-To`/`References` first (exact, matched against the
  Message-ID we sent), then falls back to the reference in the subject line — which is why
  the reference is in the subject at all.
- **Unroutable mail is parked, never guessed.** An inbound email whose recipient matches no
  product's `supportEmail`, with no `DEFAULT_PRODUCT_CODE` fallback, stays `failed`. Filing
  it under an arbitrary product would hide a customer's problem from the only agents who
  could act on it.
- **Auto-replies and bounces are dropped** before they can open tickets or start a loop of
  robots answering each other.
- **Attachments have one client flow across two backends.** With object storage configured
  the client gets a presigned PUT and the bytes never touch the API; without it, the same
  flow points at `PUT /attachments/:id/content` and files land on local disk. Uploads are
  recorded as `skipped`, not `clean` — nothing has scanned them yet, and saying otherwise
  would be a lie the console displays.
- **Macros never send.** Applying one changes the ticket's fields and returns rendered
  reply text for the agent to review, so a mis-click is recoverable.
- **Customers are acknowledged on arrival.** A ticket raised by email, web form or a
  product system emails the customer their reference immediately, quoting their own words
  back so they can tell which query it is. Agent-raised tickets are excluded: the customer
  has just been given the reference on the phone. The acknowledgement's `Message-ID` is
  recorded against the ticket as an internal system entry, so a reply to _that_ email
  threads by header even if the customer's client rewrites the subject — which also means
  threading works on their first reply, not only after an agent has answered. Sending is
  after commit and swallows its own errors: a mail outage must not cost a saved ticket.
  Switchable with `SEND_TICKET_ACKNOWLEDGEMENT`.

**Phase 4 — routing & SLA** — _complete_
routing, sla, escalation, `lib/queue` (pg-boss) and `workers/`. 10 more tables, 2
columns on `users`, 21 more endpoints, and the first scheduled work in the system.

Verified end to end: a ticket arrives, is given a first-response and a resolution
deadline from its product's policy, lands on an available agent without anyone
touching it, has its clock stopped while the customer is thinking and restarted
where it left off, and — when the deadline passes — is marked breached exactly
once and escalated up the ladder. The pg-boss path was exercised for real, not
only under the inline driver: the cron fired every minute, `sla.scan` handed off
to `sla.escalate`, and SIGTERM drained both before closing the pool.

Decisions worth knowing:

- **SLA targets are written in the ticket's own transaction**, not by the triage
  job. Everything else about routing is asynchronous, but a ticket whose targets
  went missing because the queue was down would look permanently on time and
  never escalate. Two extra queries buys the guarantee that a saved ticket always
  has a deadline.
- **`due_at` is the single source of truth for a deadline.** Consumption is
  measured _backwards_ from it rather than forwards from the start, and pausing
  moves `due_at` rather than accumulating an offset to apply later. An earlier
  version measured elapsed time from `started_at` and the two disagreed: a target
  could be past `due_at`, and so breached, while the elapsed-time figure still
  read under 100% — which made the last rung of every ladder unreachable. The
  clock's `consumedFraction` and the breach scan now answer to the same column.
- **The clock does its own timezone arithmetic through `Intl`**, with no date
  library. Africa/Harare has no daylight saving, so a fixed UTC+2 offset would
  have worked and would have been quietly wrong the first time a calendar was
  created in another zone. `sla.clock.ts` is pure and has the heaviest unit
  coverage in the codebase; the DST case is a real test, not a hypothetical.
- **Business hours are one `jsonb` week, not a child table.** The clock loads a
  whole calendar to do arithmetic on it and never queries individual windows, and
  `PUT /business-hours/:id` replaces the week as one value. A child table would
  have added a join to every target for nothing.
- **Routing is first-match-wins in an explicit `sort_order`**, not
  most-specific-wins. Ranking criteria against each other requires deciding
  whether product beats priority, and two equally specific rules would then be
  resolved by something invisible. An explicit order is auditable and an operator
  can reorder it.
- **Load is compared as a share of each agent's own capacity**, so a part-timer
  with a limit of 5 is not handed work until they are as busy as a full-timer with
  a limit of 20. Skill breaks the tie, then least-recently-assigned — which is
  what makes the round-robin fallback genuine rather than always the same
  alphabetically-first name.
- **Nobody available is a normal outcome.** The ticket stays unassigned, where
  every agent on the product can see it. Selection relaxes the team and then the
  skill to find someone, but never availability or capacity: an offline or
  over-capacity agent is a worse home for a customer's problem than an open queue.
- **Auto-assignment only considers explicit `user_products` grants.**
  Administrators hold `ticket:read_all_products` and can read every queue, but
  assigning to them on the strength of that permission would drop customer tickets
  on people who do not work one.
- **Escalation fires every rung a ticket has passed**, not just the highest, so a
  ladder that warns at 80% and reassigns at 100% does both and the warning is on
  the record. The unique constraint on `(ticket, rule, target)` is the idempotency
  guard, and the insert _is_ the lock — checking first and inserting after would
  race between instances. The escalation is recorded before its side effects run,
  so a failed reassignment does not make the ladder retry the same rung forever.
- **Raising a priority does not move a live deadline.** `target_minutes` is copied
  onto the target at creation, so neither an escalation nor an edited policy
  rewrites an agent's afternoon.
- **`sla.scan` and `POST /sla/scan` are the same code path** (`scanAndEscalate`).
  They were briefly not, and the endpoint recorded breaches without escalating
  them — exactly the difference an operator running it by hand would not expect.
- **The queue has an `inline` driver**, following `EMAIL_TRANSPORT=log` and the
  local storage backend. It runs a job the instant it is enqueued and fires no
  schedule, which is what lets the test suite exercise the real job handlers with
  no queue running. It reports `not_configured` on `/readyz` rather than `ok`,
  because nothing is going to run a schedule under it.
- **A default configuration is seeded**, so a fresh deployment escalates rather
  than sitting inert: the Zimbabwe working week, the public holidays for this year
  and next (Easter and the August holidays computed, not listed, so the seed does
  not silently run out), a policy per product and priority, a `Support Desk` team,
  a catch-all routing rule, and a two-rung ladder.

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
QUEUE_DRIVER, QUEUE_SCHEMA, QUEUE_CONCURRENCY, QUEUE_JOB_EXPIRY_SECONDS, QUEUE_RETRY_LIMIT
SLA_SCAN_CRON, SLA_SCAN_BATCH_SIZE
AUTO_ASSIGN_ENABLED, ROUTING_ASSIGN_TO_AWAY_AGENTS, DEFAULT_AGENT_MAX_OPEN_TICKETS
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
   metadata rules, as built: `routing_rules` matched in an explicit order, then
   selection on availability, capacity, skill and recency. Sentiment and
   auto-categorisation would arrive as further criteria feeding the same
   `RoutingDecision` that `routing.scoring.ts` already produces — the seam is
   there, the model is not.
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

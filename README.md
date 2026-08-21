# Prime Focus CSS

Central customer support API for Prime Focus products. Node.js + TypeScript +
PostgreSQL.

The API design — modules, data model, endpoints, and build order — lives in
[`docs/api-structure.md`](docs/api-structure.md). Read that first.

## Requirements

- Node.js 24 LTS or newer
- Docker (for the local PostgreSQL instance)

## Getting started

```bash
npm install
cp .env.example .env      # defaults match the Docker Compose database
npm run db:up             # start PostgreSQL on localhost:5434
npm run db:migrate        # create extensions and apply migrations
npm run db:seed           # roles, permissions, and the one default administrator
npm run dev               # http://localhost:3000
```

`db:seed` prints the generated administrator password once. That account is the only
way into a fresh deployment — there is no sign-up endpoint. Everyone else is invited.

Verify:

```bash
curl localhost:3000/healthz   # process is alive
curl localhost:3000/readyz    # dependencies are reachable
curl localhost:3000/api/v1    # API index
```

## Scripts

| Script                      | Purpose                                            |
| --------------------------- | -------------------------------------------------- |
| `npm run dev`               | Watch-mode server via `tsx`                        |
| `npm run build` / `start`   | Compile to `dist/`, then run it                    |
| `npm run check`             | Everything CI runs: format, lint, typecheck, tests |
| `npm run lint` / `lint:fix` | ESLint, including architectural boundary rules     |
| `npm run typecheck`         | `tsc --noEmit` over `src` and `tests`              |
| `npm test` / `test:watch`   | Vitest                                             |
| `npm run db:up` / `db:down` | Start/stop the local PostgreSQL container          |
| `npm run db:generate`       | Generate a migration from schema changes           |
| `npm run db:migrate`        | Apply pending migrations                           |
| `npm run db:reset`          | Destroy the local database and rebuild it          |
| `npm run db:studio`         | Drizzle Studio                                     |

## Testing

Unit specs sit beside the code they cover (`*.test.ts`). Integration specs that
need real PostgreSQL are gated:

```bash
npm run db:up && npm run db:migrate
RUN_DB_TESTS=1 npm test
```

Without `RUN_DB_TESTS=1` they skip, so `npm test` works with no database.

## Signing in

Authentication is password + a one-time code emailed to the user. There is no
authenticator app and nothing to enrol.

```bash
# 1. password → a code is emailed, and a challenge id comes back
curl -sX POST localhost:3000/api/v1/auth/login -H 'content-type: application/json' \
  -d '{"email":"admin@primefocus.co.zw","password":"..."}'

# 2. the code, optionally trusting this device for 30 days
curl -sX POST localhost:3000/api/v1/auth/otp/verify -H 'content-type: application/json' \
  -d '{"challengeId":"...","code":"123456","trustDevice":true}'
```

In development no email is sent: `EMAIL_TRANSPORT` falls back to `log`, so the code and
any invitation link are printed to the server output. Pass the `deviceToken` from step 2
on a later login to skip the code.

To add a colleague, `POST /api/v1/invitations` with their email, name and the `roleId`
they should hold. They receive a link, choose a password at
`POST /api/v1/invitations/accept`, and are signed in immediately.

Seeded roles: `super_admin`, `admin`, `tier2_specialist`, `tier1_agent`. Only
`super_admin` can change what a role may do.

## Ticketing

Every ticket belongs to exactly one product, and **agents only see the products they are
granted**. Grant access with `POST /products/:id/agents`; an agent with no grants sees an
empty queue. Administrators hold `ticket:read_all_products` and see everything.

```bash
# raise a ticket (the body becomes the opening message in the thread)
curl -sX POST localhost:3000/api/v1/tickets -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' -d '{
    "productId": "...", "subject": "Transfer never arrived",
    "body": "I sent $50 two hours ago.", "customerEmail": "customer@example.co.zw"
  }'

# reply to the customer, or leave a note only staff can see
curl -sX POST localhost:3000/api/v1/tickets/$ID/messages -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' -d '{"body":"Reversed.","visibility":"public"}'
```

`visibility` has no default on purpose: `public` emails the customer, `internal` never
leaves the system, and guessing wrong would send a private note to a customer.

Tickets arriving by email, web form or API trigger an **acknowledgement email** carrying
the reference, so the customer knows their query is tracked before an agent gets to it.
Agent-raised tickets skip it — the customer was just told the reference on the call. Turn
it off with `SEND_TICKET_ACKNOWLEDGEMENT=false`.

### Inbound email

Resend's `email.received` webhook carries **metadata only**, so the pipeline persists the
envelope, answers 202, then fetches the body from Resend's received-email API. Point a
Resend inbound webhook at `POST /api/v1/webhooks/resend/inbound` and set
`RESEND_WEBHOOK_SECRET`; without the secret the endpoint refuses everything rather than
trusting unverified mail.

Routing is by recipient address — each product has a `supportEmail`. An email matching no
product is parked as `failed` rather than filed under a guess; fix the routing and retry it
with `POST /api/v1/email/inbound/:id/reprocess`. Retrieving bodies needs a real
`RESEND_API_KEY`, so inbound mail cannot be exercised end to end locally without one.

### Attachments

One client flow, two backends. `POST /tickets/:id/attachments/upload-url` returns somewhere
to `PUT` the bytes: a presigned URL when object storage is configured (`STORAGE_BUCKET` and
credentials), otherwise an API URL that writes to `./storage`. Local files are gitignored —
they are real customer documents.

## Service levels, routing and escalation

Every ticket gets two deadlines when it is raised — a first response and a
resolution — from the SLA policy for its **product × priority**. The clock counts
**working time only**, against a business-hours calendar with Zimbabwe's public
holidays on it, so an hour's target on a ticket that arrives at 16:40 on Friday
falls on Monday morning rather than Friday evening.

```bash
# where a ticket's clocks stand
curl -s localhost:3000/api/v1/tickets/$ID/sla -H "authorization: Bearer $TOKEN"

# the working week and the holidays on it
curl -s localhost:3000/api/v1/business-hours -H "authorization: Bearer $TOKEN"
```

The clock **stops** while a ticket is `pending` or `on_hold` — waiting on the
customer is not time we owe them — and the deadline is pushed out by the working
time the pause actually cost when it restarts. A pause over a weekend costs
nothing. Replying satisfies the first-response clock; resolving satisfies the
other; reopening starts a fresh resolution clock.

Editing a policy never moves a deadline that already exists: `target_minutes` is
copied onto the ticket's target when it is created, so an agent's afternoon
cannot be rewritten under them by a configuration change.

**Assignment is automatic.** `routing_rules` are matched in `sortOrder`, first
match wins, and every criterion is optional — a rule with no criteria at all is
the catch-all at the bottom of the list. The matched rule names a team and,
optionally, a required skill; the engine then picks the least loaded eligible
agent, comparing load as a share of _each agent's own_ capacity so a part-timer
is not handed work until they are as busy as a full-timer. Ties break on skill,
then on least-recently-assigned, which is what makes the fallback a real round
robin.

Nobody eligible is a normal outcome, not a failure: the ticket stays in the
unassigned queue, visible to everyone who works the product. Availability and
capacity are never relaxed to find someone — an offline or over-capacity agent is
a worse home for a customer's problem than an open queue.

```bash
# an agent marks themselves at their desk; routing only picks `online` agents
curl -sX PATCH localhost:3000/api/v1/users/me/availability \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"availability":"online"}'

# why this ticket landed where it did, without changing anything
curl -s localhost:3000/api/v1/tickets/$ID/routing -H "authorization: Bearer $TOKEN"
```

Turn push assignment off entirely with `AUTO_ASSIGN_ENABLED=false`.

**Breaches escalate on their own.** A cron scan runs every minute, marks
everything past its deadline as breached exactly once, and hands off to the
escalation ladder. Rungs fire at a percentage of the SLA — 80 warns before the
deadline, 100 fires on the breach, and above 100 is legitimate for a ticket
somebody is clearly stuck on. Every rung a ticket has passed fires, not just the
highest, and each fires at most once per ticket per clock; the unique constraint
on `escalations` is what guarantees that against a scan running every minute on
several instances at once.

```bash
# run the scan and the ladder now, instead of waiting for the cron
curl -sX POST localhost:3000/api/v1/sla/scan -H "authorization: Bearer $TOKEN"

# what has already been escalated on a ticket, and why
curl -s localhost:3000/api/v1/tickets/$ID/escalations -H "authorization: Bearer $TOKEN"
```

`db:seed` installs a working default: Mon–Fri 08:00–17:00 Harare, the public
holidays for this year and next, a policy for every product and priority, one
catch-all routing rule pointing at a `Support Desk` team, and a two-rung ladder
that warns the desk at 80% of the first-response target and raises the priority
on any breach. All of it is ordinary data — replace it through the API.

### Async jobs

Jobs run on **pg-boss**, in the same process that serves HTTP, against its own
`pgboss` schema. `/readyz` reports the queue alongside Postgres.

| Job                 | Trigger            | Does                                      |
| ------------------- | ------------------ | ----------------------------------------- |
| `ticket.triage`     | ticket created     | matches routing rules, sets the team      |
| `ticket.autoassign` | after triage       | picks an agent, or leaves it queued       |
| `sla.scan`          | cron, every minute | records breaches, hands off to the ladder |
| `sla.escalate`      | from the scan      | fires escalation rungs                    |

`QUEUE_DRIVER=inline` runs a job the moment it is enqueued and **fires no
schedule**. Tests use it, so the job path is the path under test; setting it
anywhere real means no breach is ever detected, which is why `/readyz` reports the
queue as `not_configured` rather than `ok` under it.

SLA targets are the one exception to the queue: they are written in the same
transaction as the ticket. A ticket whose targets went missing because a queue was
down would look permanently on time and never escalate.

## Conventions

Each entity is a folder under `src/modules/` with its own
`*.routes.ts`, `*.controller.ts`, `*.service.ts`, `*.repository.ts`,
`*.model.ts`, `*.schema.ts` and `index.ts`.

The layering — `routes → controller → service → repository → model` — is
enforced by `eslint-plugin-boundaries`, not by convention. A controller that
imports a repository, or a repository that calls a service, fails `npm run lint`.
Cross-module traffic goes service → service through the other module's
`index.ts`.

Two more rules worth knowing before writing code:

- `process.env` is read only in `src/config/env.ts`. Everything else imports `env`.
- Nothing presented as a bearer credential is stored in the clear. Passwords are Argon2id;
  refresh tokens, device tokens, invitation and reset tokens, API keys and login codes are
  stored as keyed HMAC digests.
- Customer PII and credentials never go into logs. `src/lib/logger/redact.ts` is
  the safety net, not the strategy — log IDs and reference codes.

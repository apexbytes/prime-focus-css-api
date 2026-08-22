# Prime Focus CSS

Central customer support API for Prime Focus products. Node.js + TypeScript +
PostgreSQL.

The API design — modules, data model, endpoints, and build order — lives in
[`docs/api-structure.md`](docs/api-structure.md). Read that first.

## Requirements

- Node.js 24 LTS or newer
- Docker (for the local PostgreSQL and Redis instances)

## Getting started

```bash
npm install
cp .env.example .env      # defaults match the Docker Compose database
npm run db:up             # start PostgreSQL on 5434 and Redis on 6381
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

| Script                      | Purpose                                              |
| --------------------------- | ---------------------------------------------------- |
| `npm run dev`               | Watch-mode server via `tsx`                          |
| `npm run build` / `start`   | Compile to `dist/`, then run it                      |
| `npm run check`             | Everything CI runs: format, lint, typecheck, tests   |
| `npm run lint` / `lint:fix` | ESLint, including architectural boundary rules       |
| `npm run typecheck`         | `tsc --noEmit` over `src` and `tests`                |
| `npm test` / `test:watch`   | Vitest                                               |
| `npm run db:up` / `db:down` | Start/stop the local PostgreSQL and Redis containers |
| `npm run db:generate`       | Generate a migration from schema changes             |
| `npm run db:migrate`        | Apply pending migrations                             |
| `npm run db:reset`          | Destroy the local database and rebuild it            |
| `npm run db:studio`         | Drizzle Studio                                       |

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

### Through an identity provider

Staff can also sign in through Google, Microsoft Entra or any OpenID Connect
provider. Providers are configured, not compiled in:

```bash
# perm sso:manage. The client secret goes in and is never returned again.
curl -X POST localhost:3000/api/v1/identity-providers \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"code":"google","displayName":"Google","kind":"google",
       "issuer":"https://accounts.google.com",
       "clientId":"…","clientSecret":"…",
       "allowedEmailDomains":["primefocus.co.zw"]}'
```

`allowedEmailDomains` is required and may not be empty: `accounts.google.com` is
the issuer for every consumer Google account on earth, so "no domains" must not
mean "any domain". For a Microsoft provider, add `"requireVerifiedEmail": false` —
Entra does not emit the `email_verified` claim at all, and that has to be an
administrator's decision rather than a default.

The flow is three calls, and the provider redirects to the **console** rather than
to the API, so no session token ever travels in a URL:

```bash
# 1. the sign-in screen asks what buttons to draw (public)
curl localhost:3000/api/v1/auth/sso/providers

# 2. start one. The browser goes to authorizationUrl; state, nonce and the PKCE
#    challenge are already in it.
curl -sX POST localhost:3000/api/v1/auth/sso/start -H 'content-type: application/json' \
  -d '{"providerCode":"google","returnPath":"/tickets"}'

# 3. the provider sends the browser to APP_WEB_URL/auth/sso/callback?code=…&state=…
#    and the console posts both here, getting the ordinary token pair back
curl -sX POST localhost:3000/api/v1/auth/sso/callback -H 'content-type: application/json' \
  -d '{"state":"…","code":"…"}'
```

Register `SSO_REDIRECT_URL` (by default `APP_WEB_URL/auth/sso/callback`) with the
provider, exactly as written.

**No account is created by signing in.** A provider says who somebody is, not
that they work here, so invitation is still the only way an account comes into
existence — but an invited colleague who signs in through a provider is activated
on the spot with no password to choose, and their invitation link stops working.
Such an account has no password, so `POST /auth/login` answers
`SSO_LOGIN_REQUIRED` and points them at the button; a password reset still works,
because a provider outage must not lock the desk out.

```bash
# my own links, and unlinking one — refused if it is the only way in
curl localhost:3000/api/v1/auth/sso/identities -H "authorization: Bearer $TOKEN"
curl -X DELETE localhost:3000/api/v1/auth/sso/identities/$ID -H "authorization: Bearer $TOKEN"
```

Links are keyed on the provider's `sub`, never on the email address: a reassigned
mailbox must not inherit the previous holder's tickets. A _new_ subject arriving
with an already-linked address is a 409, not a silent relink. And a provider
cannot be deleted while anybody signs in through it — `PATCH { "isActive": false }`
is the reversible way to stop offering it.

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

## Deflection and insight

### Knowledge base

Articles are **drafted, reviewed, then published** — publishing is its own
endpoint, not `PATCH { status: "published" }`, because it is a different decision
from an edit. Editing a published article leaves it published; a correction should
not take the answer offline. Every edit snapshots what the article said before it.

```bash
# write one (it starts as a draft, whatever you ask for)
curl -sX POST localhost:3000/api/v1/kb/articles -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' -d '{
    "title": "Why a transfer can fail", "productId": "...", "visibility": "public",
    "body": "Check the recipient number, the daily limit, then whether the wallet is dormant.",
    "keywords": ["transfer", "limit"]
  }'

curl -sX POST localhost:3000/api/v1/kb/articles/$ID/publish -H "authorization: Bearer $TOKEN"
```

`visibility` is required and has no default, for the same reason message
`visibility` does. `internal` articles are agent runbooks — escalation contacts,
fraud procedure — and `GET /kb/suggest` exists to put text in front of customers.
The column defaults to `internal` at the database level so anything that ever
forgets the field fails closed.

**Search and suggest are not the same query.** Postgres ANDs the terms of a
search box, which is right for `?q=daily limit` and useless for a ticket body — a
customer's paragraph ANDed together matches nothing ever written. So `suggest`
reduces the text to its distinctive words, ORs them, and lets ranking decide.

```bash
# what an agent looks for, with runbooks included on request
curl -s 'localhost:3000/api/v1/kb/search?q=dormant+wallet&includeInternal=true' \
  -H "authorization: Bearer $TOKEN"

# what the ticket form asks before the customer presses send:
# published + public only, always, whoever is asking
curl -s -G localhost:3000/api/v1/kb/suggest -H "authorization: Bearer $TOKEN" \
  --data-urlencode 'subject=My transfer never arrived' \
  --data-urlencode 'body=I sent $50 and it never came through'
```

"hello please help" returns nothing on purpose: an arbitrary article is worse
than none. Ranking is weighted — a title match beats a keyword match beats a
mention in the body — and results carry a `ts_headline` excerpt with the matched
terms marked.

Articles can be fetched by slug as well as id, because a knowledge base link
pasted into a ticket is a slug. Readers vote once with
`POST /kb/articles/:id/feedback`; changing your mind moves the counters rather
than adding a second opinion.

### Customer satisfaction

A resolved ticket earns one emailed survey — five links, one per score, and the
link lands on the console, which POSTs the rating. A GET that recorded a score
would be cast by the first mail scanner to follow it.

```bash
# public, unauthenticated: the token from the email is the credential
curl -s localhost:3000/api/v1/surveys/$TOKEN
curl -sX POST localhost:3000/api/v1/surveys/$TOKEN \
  -H 'content-type: application/json' -d '{"score":5,"comment":"Sorted in ten minutes."}'
```

The survey is sent an hour after resolution (`CSAT_DELAY_MINUTES`), and the
ticket's state is re-read when the job runs — the delay is exactly the window in
which a customer replies "that did not work" and reopens it. It is skipped, not
failed, when there is nothing to rate: a ticket nobody replied to, one already
surveyed, or a customer asked anything in the last `CSAT_CUSTOMER_COOLDOWN_DAYS`.
Being asked five times about five tickets is how a response rate reaches zero.

It answers once, expires after `CSAT_TOKEN_TTL_DAYS`, and the token is stored as
an HMAC digest like every other bearer value here.

### Reports

Dashboards read **six materialised views**, rebuilt every fifteen minutes, never
the live ticket tables. Every response says how stale it is.

```bash
curl -s localhost:3000/api/v1/reports/overview -H "authorization: Bearer $TOKEN"
curl -s 'localhost:3000/api/v1/reports/sla?from=2026-08-01' -H "authorization: Bearer $TOKEN"
curl -s localhost:3000/api/v1/reports/agents -H "authorization: Bearer $TOKEN"
curl -s localhost:3000/api/v1/reports/csat -H "authorization: Bearer $TOKEN"
curl -s localhost:3000/api/v1/reports/volume -H "authorization: Bearer $TOKEN"

# rebuild now instead of waiting for the schedule (perm report:refresh)
curl -sX POST localhost:3000/api/v1/reports/refresh -H "authorization: Bearer $TOKEN"
```

`meta.refreshedAt` is the **oldest** refresh across the views a report reads, and
`meta.stale` is true if any of them failed — taking the newest would hide a view
that has been broken for a week behind one that succeeded a minute ago.

Reports are product-scoped like everything else: `report:view` is held by tier-2
specialists, who only see the products they work. Durations in the views are wall
clock, because a materialised view cannot call the SLA clock; anything answering
to a service level comes from `/reports/sla`, which reads the targets the clock
itself wrote. Compliance is `met ÷ (met + breached)` — a ticket still inside its
deadline is neither, and counting it either way would make this morning's figure
depend on the time of day.

The views bucket by **local** calendar day, with `Africa/Harare` baked into the
migration. Changing `DEFAULT_TIMEZONE` means a migration to match.

### Attachment scanning

Uploaded bytes land as `uploaded` and the `attachment.scan` job settles them.
**A download is refused while a scan has not answered** — an agent who cannot
open a statement for a minute is an inconvenience, an agent who opens malware is
an incident.

```bash
# a scanner outage leaves a file stuck; this unsticks it (perm ticket:manage)
curl -sX POST localhost:3000/api/v1/attachments/$ID/rescan -H "authorization: Bearer $TOKEN"
```

With no scanner configured, uploads are recorded as `skipped` — honest about the
fact that nothing looked at them — and `/readyz` reports the scanner as
`not_configured` rather than `ok`. Point `ANTIVIRUS_HOST` at a clamd instance to
turn it on; production refuses to boot without either that or an explicit
`ANTIVIRUS_DRIVER=none`. The `.exe` denylist stays either way: a scanner asks
whether a file is known malware, the denylist asks whether a customer has any
reason to send it.

### Data retention

Zimbabwe's Cyber and Data Protection Act (2021) shapes what is kept: the audit
trail for seven years, ticket content for five, after which customer personal
data is anonymised **in place** rather than deleted, so five-year-old volume
figures do not change retroactively. Attachments are the exception and are
deleted outright — a stored document is the personal data, so there is nothing
left to anonymise once the file is gone.

```bash
# what the policy is, and what is currently past it (perm audit:read)
curl -s localhost:3000/api/v1/retention/policy -H "authorization: Bearer $TOKEN"

# a dry run, which is what an empty body gets you
curl -sX POST localhost:3000/api/v1/retention/sweep -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' -d '{}'

# actually do it (perm retention:run — super_admin only by default)
curl -sX POST localhost:3000/api/v1/retention/sweep -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' -d '{"dryRun":false}'
```

`dryRun` defaults to **true**, unlike every other flag in this API: an operator
POSTing an empty body to see what an endpoint does should get a report, not a
deletion. The weekly cron runs for real. `RETENTION_AUDIT_LOG_YEARS` below
`RETENTION_TICKET_YEARS` is refused rather than clamped — it would delete the
record of an anonymisation before performing it.

## Realtime and outbound webhooks

### Ticket locks and live counts

Everything the websocket offers is also an HTTP endpoint, so a console behind a
proxy that strips upgrades is slower rather than broken.

```bash
# take the lock on a ticket, or refresh one you already hold
curl -X POST localhost:3000/api/v1/tickets/$TICKET/lock -H "authorization: Bearer $TOKEN"
# → { acquired: true, holder: { userId, fullName, acquiredAt, expiresAt }, heartbeatSeconds }

# somebody else has it: still a 200, because a lock is advisory
# → { acquired: false, holder: { fullName: "Chipo Agent", … } }

# release your own — never anybody else's, and there is no force-release
curl -X DELETE localhost:3000/api/v1/tickets/$TICKET/lock -H "authorization: Bearer $TOKEN"

# the queue header, counted live rather than from the 15-minute reporting views
curl "localhost:3000/api/v1/realtime/queue-counts?productId=$PRODUCT" -H "authorization: Bearer $TOKEN"
```

A lock expires after `TICKET_LOCK_TTL_SECONDS` and is released the moment the
holder's socket drops. It blocks no write anywhere in the system: what it buys
is the console being able to say "Chipo is replying to this" before a second
agent types the same answer.

### The websocket

Socket.IO at `REALTIME_PATH` (default `/realtime`). The access token goes in the
handshake `auth` object, never the query string. **Staff sessions only** — an
API key is refused, because a product system has no console.

```js
const socket = io('http://localhost:3000', {
  path: '/realtime',
  auth: { token: accessToken },
});

socket.emit('ticket:subscribe', { ticketId }, (res) => console.log(res.data)); // lock state
socket.emit('product:subscribe', { productId });
socket.emit('ticket:lock', { ticketId }, (res) => console.log(res.data.acquired));
socket.emit('ticket:typing', { ticketId, isTyping: true });

socket.on('ticket', (event) => {}); // a domain event about a ticket you watch
socket.on('ticket:lock', (state) => {}); // somebody took or released the lock
socket.on('ticket:typing', (who) => {});
socket.on('queue:counts', (counts) => {}); // live totals for a product
socket.on('notification', (item) => {}); // addressed to you, no subscription needed
```

Every client event answers through a callback — `{ ok: true, data }` or
`{ ok: false, error }`. Subscriptions are access-checked by the module that owns
the resource, so a room is never a way around product scoping. An open socket
re-checks every `REALTIME_REAUTH_SECONDS` that its account is still active and
disconnects if it is not.

### Outbound webhooks

```bash
# subscribe another Prime Focus system to ticket events (perm webhook:manage)
curl -X POST localhost:3000/api/v1/webhook-subscriptions \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"name":"Wallet ledger","url":"https://ledger.internal/hooks/support",
       "eventTypes":["ticket.created","ticket.resolved"],"productId":"…"}'
# → the signing secret, once. It is never returned again.

curl localhost:3000/api/v1/webhook-subscriptions/event-types -H "authorization: Bearer $TOKEN"
curl localhost:3000/api/v1/webhook-subscriptions/$ID/deliveries -H "authorization: Bearer $TOKEN"
curl -X POST localhost:3000/api/v1/webhook-deliveries/$ID/redeliver -H "authorization: Bearer $TOKEN"
```

Each delivery arrives as:

```
POST /your/endpoint
x-pf-event: ticket.created
x-pf-event-id: 018f…            ← deduplicate on this
x-pf-delivery: 018f…
x-pf-timestamp: 1770000000
x-pf-signature: v1=<hex>
```

Verify it by computing `HMAC-SHA256(secret, "<timestamp>.<raw body>")` and
comparing in constant time, then **reject a timestamp older than five minutes** —
the timestamp is inside the signed string precisely so a captured request is not
replayable forever.

A payload never contains a message body. `ticket.message_created` carries the
message id, its visibility and who wrote it; an internal note is agent-only, and
a webhook is an egress its author never saw. A receiver that needs the text asks
the API for it with credentials of its own.

Failed deliveries retry with backoff up to `WEBHOOK_MAX_ATTEMPTS` and are
readable in the delivery log with the response status and body. A subscription
that fails `WEBHOOK_DISABLE_AFTER_FAILURES` times in a row switches itself off;
`PATCH { "isActive": true }` puts it back with a clean counter.

There is deliberately no "send a test event" button: it would have to fabricate a
ticket, and a delivery log full of tickets that never existed teaches a receiver
to accept them.

## Omnichannel: WhatsApp and live chat

Two channels a customer can reach the desk on and be answered on, added in
Phase 8. Both feed the same pipeline as inbound email and land as ordinary
tickets — routing, SLA clocks, escalation and reporting all apply without
knowing which channel a ticket came from.

The one thing to understand before reading further: **an agent replies the same
way whatever the channel**. There is no per-channel endpoint. `POST
/tickets/:id/messages` with `visibility: "public"` sends an email on an email
ticket, a WhatsApp message on a WhatsApp ticket and a socket frame on a chat
ticket, and `visibility: "internal"` still sends nothing anywhere.

### WhatsApp

```bash
# Meta verifies the webhook URL once, with a GET. The reply is the bare
# challenge string, because Meta compares bytes.
curl "localhost:3000/api/v1/webhooks/whatsapp?hub.mode=subscribe\
&hub.verify_token=$WHATSAPP_VERIFY_TOKEN&hub.challenge=1158201444"
# → 1158201444

# messages arrive here, signed. Unauthenticated and ahead of the rate limiter:
# the signature is the credential, and WhatsApp arrives in bursts.
POST /api/v1/webhooks/whatsapp
x-hub-signature-256: sha256=<HMAC-SHA256(app secret, raw body)>
```

A message from a number nobody has seen creates a customer with **no email
address**, records the number as that customer's WhatsApp identity, opens a
thread and raises a ticket. The next message from the same number joins the same
ticket. Set `WHATSAPP_PRODUCT_CODE` — one number serves the whole business, so
unlike inbound email there is nothing in the message that says which product it
is about, and with nothing configured the message waits in the backlog rather
than being filed somewhere nobody looks.

Without `WHATSAPP_ACCESS_TOKEN` and `WHATSAPP_PHONE_NUMBER_ID` the transport is
`log`: replies are recorded and nothing is sent, which is how development runs.

**Meta's 24-hour rule is real and you will meet it.** Outside 24 hours of the
customer's last message, Meta refuses a free-form reply — only an approved
template gets through. So the window is stored on the thread, checked before the
send, and a refusal is written into the ticket as a system note, because in the
console a refused reply otherwise looks exactly like a delivered one:

```
ℹ  This reply could not be delivered over whatsapp: the 24-hour WhatsApp reply
   window has closed and no re-open template is configured
```

Set `WHATSAPP_REOPEN_TEMPLATE` to an approved template name and late replies go
out through it instead.

Two gaps, stated rather than hidden. Inbound **media is not downloaded** — a
photo is recorded in the inbound log as `no readable body` and opens no ticket;
fetching it means Meta's media endpoint, the object store, the virus scanner and
a retention rule. And a customer with no address **gets no CSAT survey**: the
survey is an email with a tokenised link, and `survey.dispatch` answers
`skipped: customer has no email address` rather than sending into nothing.

### Live chat

```bash
# public: is chat on, and where does the widget connect?
curl localhost:3000/api/v1/chat/config

# public: open a session. This is the only endpoint that hands an
# unauthenticated caller a token.
curl -X POST localhost:3000/api/v1/chat/sessions \
  -H 'content-type: application/json' \
  -d '{"displayName":"Rudo","page":"/transfers"}'
# → { sessionToken, conversationExternalId, expiresAt, namespace, path }

# every call after that carries the session token
curl -X POST localhost:3000/api/v1/chat/messages \
  -H "authorization: Bearer $SESSION" -H 'content-type: application/json' \
  -d '{"body":"My card was declined at the till."}'

# the public thread, for a widget that has just reloaded
curl localhost:3000/api/v1/chat/transcript -H "authorization: Bearer $SESSION"

# the visitor closes the conversation
curl -X DELETE localhost:3000/api/v1/chat/session -H "authorization: Bearer $SESSION"
```

The visitor's socket lives on its **own namespace** (`CHAT_NAMESPACE`, default
`/chat`) on the same `REALTIME_PATH` as the staff console:

```js
const socket = io('http://localhost:3000/chat', {
  path: '/realtime',
  auth: { sessionToken },
});

socket.emit('chat:send', { body: 'Anyone there?' }, (res) => res.data.ticketId);
socket.emit('chat:typing', { isTyping: true });
socket.emit('chat:transcript', {}, (res) => res.data);
socket.emit('chat:end');

socket.on('chat:message', (frame) => {}); // { author: 'agent' | 'customer', body }
socket.on('chat:typing', (who) => {});
socket.on('chat:ended', (why) => {});
```

A separate namespace rather than rooms on the staff connection, because the
isolation is then structural instead of a check to remember: there is no client
event that takes a room name, no ticket id anywhere in the protocol, and no
locks, queue counts or notifications to reach. A staff token is refused here and
a visitor token is refused on the staff namespace. Everything the socket does is
also one of the REST calls above, so a widget behind a proxy that strips upgrades
is slower rather than broken.

An address typed into the widget is **contact detail, not identity**. It is
recorded on the session for the agent to see and links to no existing customer
record: anyone can type anybody's address, and matching on it would hand a
stranger somebody else's thread history. An agent who establishes who they are
talking to sets the address or merges the records — and a merge moves the
channel identities with it.

### The desk's view

```bash
# live threads, product-scoped like every other ticket read (perm channel:read)
curl "localhost:3000/api/v1/conversations?channel=whatsapp&status=open" \
  -H "authorization: Bearer $TOKEN"

# messages recorded but not yet filed onto a ticket (perm channel:manage)
curl localhost:3000/api/v1/conversations/inbound/unprocessed -H "authorization: Bearer $TOKEN"
curl -X POST localhost:3000/api/v1/conversations/inbound/$ID/reprocess \
  -H "authorization: Bearer $TOKEN"
```

A thread nobody has written on for `CONVERSATION_IDLE_HOURS` has its ticket
pointer dropped, so a customer replying after a weekend joins the ticket they
were discussing while "I have another problem" next month opens new work. The
thread row itself survives — it holds the identity a returning customer is
recognised by.

Opening the chat panel creates a customer and a thread before anything is typed,
because the session has to authorise something. The same hourly sweep deletes
chat threads that never became a ticket, past twice `CHAT_SESSION_TTL_MINUTES`,
along with the customer each one invented — so a visitor who closes the tab
without a word leaves nothing behind. WhatsApp threads are never reaped: their
identity is how a returning customer is recognised.

### Redis

Redis holds the state that has to be _shared between instances_ — rate-limit
counters, the knowledge base's suggestion cache, cache-invalidation signals and
the Socket.IO room registry. Nothing depends on it to be correct: with
`CACHE_DRIVER=memory` every path still works, for one instance. Production
refuses to boot without `REDIS_URL` unless that driver is chosen deliberately,
because two instances with local counters give a caller twice the budget they
were sold and never see each other's broadcasts.

`/readyz` reports it. A configured-but-unreachable Redis fails readiness and
fails no request: the limiters pass and the caches miss.

### Async jobs

Jobs run on **pg-boss**, in the same process that serves HTTP, against its own
`pgboss` schema. `/readyz` reports the queue alongside Postgres.

| Job                       | Trigger                  | Does                                                 |
| ------------------------- | ------------------------ | ---------------------------------------------------- |
| `ticket.triage`           | ticket created           | matches routing rules, sets the team                 |
| `ticket.autoassign`       | after triage             | picks an agent, or leaves it queued                  |
| `sla.scan`                | cron, every minute       | records breaches, hands off to the ladder            |
| `sla.escalate`            | from the scan            | fires escalation rungs                               |
| `survey.dispatch`         | ticket resolved, delayed | emails the CSAT survey, or skips it                  |
| `attachment.scan`         | bytes uploaded           | settles an attachment to clean/infected/skipped      |
| `report.refresh`          | cron, every 15 min       | rebuilds the six reporting views                     |
| `notification.digest`     | cron, 07:00 CAT          | one email an agent about what is waiting             |
| `retention.sweep`         | cron, Sundays 03:00      | enforces the retention policy, one batch             |
| `webhook.deliver`         | a domain event           | signs and POSTs one delivery, retrying with backoff  |
| `channel.inbound.process` | WhatsApp webhook         | files an inbound message onto a ticket, or opens one |
| `conversation.sweep`      | cron, hourly             | detaches idle threads, reaps abandoned chat widgets  |

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
  refresh tokens, device tokens, invitation and reset tokens, API keys, login codes, SSO
  `state` values and live-chat session tokens are stored as keyed HMAC digests. The two exceptions are the values this
  API presents to somebody else rather than verifies — a webhook subscription's signing
  secret and an identity provider's client secret — and both are write-only through the
  API.
- Customer PII and credentials never go into logs. `src/lib/logger/redact.ts` is
  the safety net, not the strategy — log IDs and reference codes.

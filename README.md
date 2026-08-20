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
npm run dev               # http://localhost:3000
```

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
- Customer PII and credentials never go into logs. `src/lib/logger/redact.ts` is
  the safety net, not the strategy — log IDs and reference codes.

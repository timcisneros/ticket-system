# Ticket System

A server-rendered system for bounded agent work. A ticket assigns responsibility, a run owns one
execution attempt, and every admitted operation passes through authority, evidence, evaluation, and
consequence boundaries.

[Portfolio case study](https://timcis.com/projects/ticket-system)

![Triage showing allowed and prohibited operator actions](docs/images/triage.png)

## System guarantees

The reference implementation demonstrates five reliability properties:

- Persistent state keeps tickets and runs beyond a single model response.
- Scoped authority checks operations against explicit permissions.
- Inspectable evidence records external effects through append-only PostgreSQL events and receipts.
- Independent verification keeps run completion separate from acceptance of the ticket objective.
- Recoverable failure exposes triage, replay, and allowed operator actions without hiding failed work.

## Current architecture

PostgreSQL is the only structured runtime store. It owns tickets, runs, leases, event history,
replay, operation receipts, sessions, catalogs, inbox state, runtime policy, and coordination. The
server has no JSON persistence mode, dual-write path, or legacy runtime-data importer.

The filesystem remains an external target boundary:

- `WORKSPACE_ROOT` is the workspace an authorized run may inspect or mutate.
- `ARTIFACT_ROOT` holds replaceable browser artifacts.
- `data/` and `ARCHIVE/legacy-json-runtime/` are fixtures or historical material, not live server
  authority.

The product is still in development. Completing the persistence cutover does not claim production
security hardening, tenant isolation, managed backups, retention, or hosted-service readiness.

## Runtime flow

`ticket -> run -> PostgreSQL claim/lease -> agent or workflow -> authority check -> target effect ->
transactional evidence/replay/receipt -> evaluation -> consequence -> operator UI/API`

Run admission is coordinated in PostgreSQL across server processes. It uses a short transaction
advisory lock, bounded candidate queries, row leases, and `FOR UPDATE SKIP LOCKED`; it does not
globally serialize execution. Overlapping workspace paths are fenced separately. Process-local
mutation admission protects bounded resources and recovers automatically after pressure falls; it
does not substitute for deployment-wide run admission and does not turn temporary pressure into a
restart-required outage.

## Requirements

- Node.js 24 or newer
- PostgreSQL 17 (the CI baseline)
- pnpm 11 is the lockfile/package-manager baseline; npm remains supported for invoking scripts

## First run

```sh
pnpm install --frozen-lockfile

cp .env.example .env.local
# Edit .env.local with the connection and secrets for your development database.

npm run db:migrate
npm run dev
```

`dev` and `db:migrate` load the ignored `.env.local` file. Explicit environment variables take precedence.

Optional settings:

- `POSTGRES_SCHEMA` (default `ticket_system`)
- `WORKSPACE_ROOT` (development default `.local-workspace`)
- `ARTIFACT_ROOT` (development default `.local-artifacts`)
- provider settings such as `OPENAI_API_KEY`, `OPENAI_MODEL`, `OLLAMA_MODEL`, and
  `OLLAMA_BASE_URL`

Development startup can create the first `admin` user with the local default password `admin123`
when `ADMIN_BOOTSTRAP_PASSWORD` is absent. Production initialization refuses that default.

## Operator flow

```sh
node scripts/oquery.js login --url http://127.0.0.1:3099
node scripts/oquery.js create-ticket --url http://127.0.0.1:3099 --agent Mike --wait --json '<objective>'
npm run codex:trace -- --run <runId>
```

The primary evidence surfaces are `/api/runs/:id/state`, `/api/runs/:id/events`,
`/api/runs/:id/decision-graph`, `/api/event-journal`, and `/api/runtime/status`.

## Verification

The release checkpoint requires a disposable PostgreSQL database and creates isolated schemas:

```sh
npm run build
TEST_DATABASE_URL='postgresql://...' npm run checkpoint:release
```

Targeted database checks are available as `test:persistence:postgres`,
`test:cutover:postgres`, and `test:page-render:postgres`. See [docs/SETUP_AND_FIRST_RUN.md](docs/SETUP_AND_FIRST_RUN.md),
[docs/SYSTEM_STATUS.md](docs/SYSTEM_STATUS.md), and
[docs/POSTGRES_CUTOVER.md](docs/POSTGRES_CUTOVER.md).

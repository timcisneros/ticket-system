# Setup and First Run

## Prerequisites

- Node.js 24+
- PostgreSQL 17 (CI baseline)
- pnpm 11 for lockfile-faithful installation

## Install and configure

```sh
pnpm install --frozen-lockfile

cp .env.example .env.local
# Edit .env.local with the connection and secrets for your development database.
```

`dev` and `db:migrate` load `.env.local`; explicit environment variables take precedence.
`DATABASE_URL` and `SESSION_SECRET` remain mandatory. `ADMIN_BOOTSTRAP_PASSWORD` is mandatory when a
production-mode startup must create the first admin. Optional environment variables are:

- `POSTGRES_SCHEMA` (default `ticket_system`)
- `WORKSPACE_ROOT` (development default `.local-workspace`)
- `ARTIFACT_ROOT` (development default `.local-artifacts`)
- `PORT` (default `3099`)
- `SESSION_PURGE_INTERVAL_MS` (default `60000`)
- `SESSION_PURGE_BATCH_SIZE` (default and current repository maximum `1000`)
- `OPENAI_API_KEY`, `OPENAI_MODEL`, `OLLAMA_MODEL`, `OLLAMA_BASE_URL`

The migration CLI and server use the same `POSTGRES_SCHEMA` setting.

## Migrate and start

```sh
npm run db:migrate
npm run dev
```

Migrations are explicit. The server verifies the schema at startup; it does not silently migrate a
production database. Open `http://127.0.0.1:3099`, sign in, and change a development bootstrap
password before sharing the environment.

## Verify the runtime

```sh
npm run build
TEST_DATABASE_URL='postgresql://...' npm run checkpoint:release
```

The checkpoint creates and drops isolated schemas inside the test database. Never point
`TEST_DATABASE_URL` at a database where arbitrary schemas with test-generated names must be
retained.

Useful focused checks:

```sh
TEST_DATABASE_URL='postgresql://...' npm run test:persistence:postgres
TEST_DATABASE_URL='postgresql://...' npm run test:cutover:postgres
npm run test:admission
npm run test:scheduler
```

## Data and evidence

PostgreSQL owns all structured runtime data, including event history, replay, logs, receipts,
sessions, configuration catalogs, and inbox/application state. Use the authenticated HTTP/API and
`oquery` surfaces to inspect it. Do not edit database rows or root JSON fixtures to operate the
server.

The workspace and browser artifacts intentionally remain filesystem targets. They are not alternate
state authorities and may require separate blob/shared-filesystem architecture in a hosted
deployment.

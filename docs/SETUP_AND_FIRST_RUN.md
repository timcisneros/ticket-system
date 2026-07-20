# Setup and First Run

## Prerequisites

- Node.js 24+
- PostgreSQL 17 (CI baseline)
- pnpm 11 for lockfile-faithful installation

## Install and configure

```sh
pnpm install --frozen-lockfile
# Optional local database:
docker compose -f compose.dev.yml up -d
pnpm dev:setup
```

`dev:setup` creates `.env.local` with mode `0600` only when absent, applies explicit migrations,
and creates the first admin only when absent. It never replaces existing configuration or
credentials. The initial password uses a hidden interactive prompt and is not persisted in the env
file. In non-interactive automation, provide `DATABASE_URL`, `SESSION_SECRET`, and
`ADMIN_BOOTSTRAP_PASSWORD` through the process environment.

All development commands load `.env.local`; explicit environment variables take precedence.
`DATABASE_URL` and `SESSION_SECRET` are mandatory. `ADMIN_BOOTSTRAP_PASSWORD` is creation-only,
must contain at least 12 characters, and is ignored after the admin exists. Optional environment
variables are:

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
pnpm dev:doctor
pnpm dev
```

The `dev` command runs the same read-only preflight before startup. It does not silently migrate,
create users, or rotate credentials. Run `pnpm dev:setup` again when explicit migrations are
needed; repeated setup preserves an existing admin.

To change an existing credential, use `pnpm admin:password` (or
`pnpm admin:password -- --username <name>`). Passwords are accepted only through the hidden prompt,
never through argv. The command uses the transactional user repository, preserves memberships, and
writes the normal administrative audit event.

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

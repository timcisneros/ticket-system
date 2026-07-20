# Setup and First Run

## Prerequisites

- Node.js 24+
- PostgreSQL 17 (CI baseline), or Docker Compose/Podman Compose for the bundled database
- pnpm 11 for lockfile-faithful installation
- An OpenAI API key, or a running Ollama installation with a pulled model

## Install and configure

```sh
# If pnpm is not already installed with Node 24:
corepack enable
corepack install

pnpm install --frozen-lockfile
# Skip this when DATABASE_URL points to an existing PostgreSQL 17 database:
pnpm dev:db
pnpm dev:setup
```

`dev:setup` creates `.env.local` with mode `0600` only when absent, applies explicit migrations,
and creates the initial admin when absent and a provider-configured agent when no runnable
agent exists. Existing
configuration, users, agents, memberships, and credentials are preserved on repeated runs.

Interactive setup prompts for the database URL, a hidden admin password, an OpenAI or Ollama
provider, an agent name, and model details. An interactively entered OpenAI key is hidden and stored
only in local PostgreSQL through the existing agent repository. For non-interactive automation,
provide `DATABASE_URL`, `SESSION_SECRET`, and `ADMIN_BOOTSTRAP_PASSWORD`, plus either
`OPENAI_API_KEY` and `OPENAI_MODEL` or `OLLAMA_MODEL`. Supply the same provider environment
when starting the server if it is not persisted in `.env.local`.

For OpenAI, choose `openai` during interactive setup and accept `gpt-4.1-mini` or enter another
model enabled for the account; the API-key prompt is hidden. For Ollama, provision the provider
before setup:

```sh
# Keep the service running in its own terminal or through the OS service manager.
ollama serve
ollama pull <model>
ollama list
```

Enter the exact installed model tag and base URL during setup. The repository does not create
external provider accounts or download model weights implicitly.

All development commands load `.env.local`; explicit environment variables take precedence.
`ADMIN_BOOTSTRAP_PASSWORD` is creation-only, must contain at least 12 characters, and is ignored
after the admin exists. Optional environment variables are:

- `POSTGRES_SCHEMA` (default `ticket_system`)
- `WORKSPACE_ROOT` (development default `.local-workspace`)
- `ARTIFACT_ROOT` (development default `.local-artifacts`)
- `PORT` (default `3099`)
- `SESSION_PURGE_INTERVAL_MS` (default `60000`)
- `SESSION_PURGE_BATCH_SIZE` (default and current repository maximum `1000`)
- `DEV_AGENT_PROVIDER`, `DEV_AGENT_NAME`
- `OPENAI_API_KEY`, `OPENAI_MODEL`, `OLLAMA_MODEL`, `OLLAMA_BASE_URL`

The migration CLI and server use the same `POSTGRES_SCHEMA` setting.

## Start and verify the first ticket

```sh
pnpm dev:doctor
pnpm dev
```

The `dev` command runs the same read-only preflight before startup. It does not silently migrate,
create accounts, or rotate credentials. Run `pnpm dev:setup` again when explicit migrations or a
missing initial account are needed.

With the server running, use a second terminal:

```sh
pnpm dev:smoke
```

The smoke command securely prompts for the admin password, creates one bounded
`Ensure folder onboarding-smoke exists` ticket through the authenticated HTTP surface, waits for
its run, and verifies the workspace folder. It is an observational provider check: model/provider
failures remain failures and include the exact `codex:trace` follow-up command.

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

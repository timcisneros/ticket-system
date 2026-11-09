# Setup and First Run

## Prerequisites

- Node.js 24+
- PostgreSQL 17 (CI baseline), and Docker Compose for the bundled database (a system
  installation under /usr/bin, /bin, or /usr/local/bin; Podman is not supported by this
  automatic disposable-development path)
- pnpm 11 for lockfile-faithful installation
- An OpenAI API key, or a running Ollama installation with a pulled model

## Install and configure

```sh
# If pnpm is not already installed with Node 24:
corepack enable
corepack install

pnpm install --frozen-lockfile
# Start the bundled PostgreSQL and prepare the disposable development database:
pnpm dev:db
pnpm dev:setup
```

After this, `pnpm dev` is normally all that is needed.

**Development target:** the daily dev commands (`pnpm dev`, `dev:db`, `dev:setup`,
`dev:doctor`, `dev:reset`) operate on ONE fixed, repository-owned disposable development
database — host `127.0.0.1`, database `ticket_system_dev`, schema `ticket_system`,
bundled development credentials (owner: `scripts/dev-environment.js`;
`TICKET_SYSTEM_POSTGRES_PORT` selects the bundled Compose SERVICE host port. When the
configured operational database is also the bundled service's `ticket_system` database,
the Compose host port MUST equal the exact operational URL port (an incompatible
TICKET_SYSTEM_POSTGRES_PORT refuses before any contact; the automatic lifecycle resolves
only a trusted system Docker Compose CLI with a root-owned system Compose plugin).
`DATABASE_URL` remains the operational/persistent target
(T10 migration-authority protected): it is never migrated by dev commands, and a configured
operational target whose identity equals the development identity refuses all development
contact before any mutation. The configuration channels are independent on EXACT terms: an
explicitly supplied `DATABASE_URL` — external or bundled-named — owns the operational
identity exactly (byte-exact URL, port, database, schema) with no URL-shape exception, while
the coexisting bundled development port keeps selecting only the fixed development target.
The development
database persists across `pnpm dev` restarts,
auto-migrates to the current source head under the explicit code-declared disposable
development authority on every `pnpm dev`, and is reset only explicitly:

```sh
pnpm dev:reset   # destroys and recreates ONLY ticket_system_dev, then re-migrates it
```

`dev:setup` creates `.env.local` with mode `0600` only when absent, prepares and migrates the
fixed disposable development database, and creates the initial admin when absent and a
provider-configured agent when no runnable agent exists. Existing configuration, users,
agents, memberships, and credentials are preserved on repeated runs. It never attempts to
migrate the operational `DATABASE_URL` target.

Setup prompts for the operational database URL (persistent state), a hidden admin password,
an OpenAI or Ollama provider, an agent name, and model details. An interactively entered OpenAI
key is hidden and stored only in local PostgreSQL through the existing agent repository. For
non-interactive automation, provide `DATABASE_URL`, `SESSION_SECRET`, and
`ADMIN_BOOTSTRAP_PASSWORD`, plus either `OPENAI_API_KEY` and `OPENAI_MODEL` or `OLLAMA_MODEL`.
Supply the same provider environment when starting the server if it is not persisted in
`.env.local`. If a database volume is reset (`pnpm dev:reset`), rerun `pnpm dev:setup` to
recreate the initial admin and agent inside the development database.

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
after the admin exists. `SESSION_SECRET` follows the one canonical supported rule consumed by the
server boot, `dev:doctor`, and the canonical configuration registry
(`runtime/environment-config-registry.js`): at least 32 characters and never the placeholder. The
server refuses to start on any required startup configuration the registry calls invalid
(fail-closed startup). Optional environment variables are:

- `TICKET_SYSTEM_POSTGRES_PORT` (default `5432`; selects the host port of the repository's
  bundled PostgreSQL Compose SERVICE, inside which the fixed disposable development target
  `ticket_system_dev` lives. It NEVER rewrites an explicit `DATABASE_URL`. When the
  configured operational database is ALSO the bundled service's `ticket_system` database,
  the Compose host port must equal the exact operational URL port — an incompatible value
  refuses before any contact; when the operational target is external, it may
  independently choose the local development-service port)
- `POSTGRES_SCHEMA` (default `ticket_system`; operational-channel configuration — the
  disposable development database always uses the code-owned schema `ticket_system`)
- `WORKSPACE_ROOT` (development default `workspace-root` — one canonical default shared with the
  server boot surface; the canonical registry is
  `runtime/environment-config-registry.js`)
- `ARTIFACT_ROOT` (development default `.local-artifacts`)
- `PORT` (default `3099`)
- `SESSION_PURGE_INTERVAL_MS` (default `60000`)
- `SESSION_PURGE_BATCH_SIZE` (default and current repository maximum `1000`)
- `DEV_AGENT_PROVIDER`, `DEV_AGENT_NAME`
- `OPENAI_API_KEY`, `OPENAI_MODEL`, `OLLAMA_MODEL`, `OLLAMA_BASE_URL`

The migration CLI (`npm run db:migrate`) and the server use the same `POSTGRES_SCHEMA`
setting for the OPERATIONAL channel. The disposable development database is unaffected by it.

### Development migration-ledger state

`dev:doctor` diagnoses the fixed disposable development database honestly
(`docs/DEPLOYMENT_CONTRACT.md` §9, **E-dev**):

- **current** — the development ledger is current and migration identities are valid;
- **behind** — informational: `pnpm dev` auto-migrates the disposable development database to
  the source head (no migration-execution authorization is involved for this code-declared
  disposable target; no authorization claim is made);
- **missing** — informational: `pnpm dev` / `pnpm dev:setup` provisions it;
- **incompatible / drifted (unknown future migrations, identity or checksum drift, partial
  ledger)** — FAIL; remediation is exactly `pnpm dev:reset` (destroys and recreates ONLY the
  disposable development identity);
- **collision** — the configured operational target identity equals the development identity:
  FAIL before any development database contact.

The doctor also renders ONE informational operational-target row (derived without contact)
showing the configured `DATABASE_URL` identity, so it is always explicit that
`DATABASE_URL` remains T10-protected and untouched by dev commands. Operational
ledger-state guidance (behind + authorized / behind + NOT authorized) continues to be decided
by the canonical migration-execution authority when the OPERATIONAL migration command runs
(`npm run db:migrate`).

## Start and verify the first ticket

```sh
pnpm dev:doctor
pnpm dev
```

`pnpm dev` starts and verifies the bundled PostgreSQL service, ensures the fixed disposable
development database, auto-migrates it to the current source head under the code-declared
disposable development authority, runs the same read-only preflight against it, and then
points the server process at the development identity. It does not create accounts, rotate
credentials, or migrate the operational target. Run `pnpm dev:setup` when the initial admin or
agent is needed.

With the server running, use a second terminal:

```sh
pnpm dev:smoke
```

The smoke command securely prompts for the admin password, creates one bounded
`Ensure folder onboarding-smoke exists` ticket through the authenticated HTTP surface, waits for
its run, and verifies the workspace folder. It is an observational provider check: model/provider
failures remain failures and include the exact `developer-agent:trace` follow-up command.

To change an existing credential, use `pnpm admin:password` (or
`pnpm admin:password -- --username <name>`). The default targets the fixed repository-owned
disposable development database (`ticket_system_dev`, `ticket_system` schema on the bundled
compose port) and never reads `DATABASE_URL`, `POSTGRES_SCHEMA`, or PG* libpq variables as
its target authority; pass `--operational` to target the exact operational
`DATABASE_URL` / `POSTGRES_SCHEMA` channel instead. Before any contact the command prints a
credential-free target identity (`host`, `port`, `database`, `schema`) so the operator can
see which channel it acts on. The selector is an operator-routing guard, not an access-control
boundary: a process able to run arbitrary code under your account is outside its scope.
Passwords are accepted only through the hidden prompt,
never through argv. The command uses the transactional user repository, preserves memberships, and
writes the normal administrative audit event. In operational mode the same runtime-integrity
gates as the server apply unchanged (an operational ledger behind the source head refuses,
exactly as T10 requires).

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

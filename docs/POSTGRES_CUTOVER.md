# PostgreSQL Cutover

This is the living contract for replacing process-local JSON persistence and coordination with
shared transactional storage. It describes current code and the remaining cutover boundary; it is
not a claim that the server already runs on PostgreSQL.

## Current status

The first two PostgreSQL foundation phases are implemented:

- `persistence/postgres/migrations/001_runtime_core.sql` defines the ticket, run, append-only event,
  and per-run event-chain-tip schema.
- `persistence/postgres/store.js` provides database-owned identity and time, transactional event
  append, row-locked hash-chain sequencing, `FOR UPDATE SKIP LOCKED` run claims, heartbeat/release
  leases, and transaction-scoped hierarchical workspace locks.
- Lease state and its evidence are committed together. Concurrent run-event writers serialize only
  on that run's chain tip. Unrelated workspace paths do not share an exclusive global lock.
- Connection, statement, and workspace-lock waits are bounded. Pool size, claim candidate lists,
  and indexed read pages are bounded and configurable per store instance.
- A deterministic contract test is in the normal checkpoint. CI also starts PostgreSQL and runs the
  real migration/concurrency integration test.
- `002_runtime_evidence.sql` adds database-enforced entity revisions, authoritative run lifecycle
  timestamps, immutable final evaluation/consequence records, optimistically revised replay
  snapshots that become immutable when finalized, and append-only operation receipts keyed for
  idempotent persistence.
- Ticket and run transition APIs require an expected revision and allowed source status. Their state
  change and lifecycle event commit or roll back together. Starting a run requires its live lease;
  every worker transition from `running` requires the matching live lease, and an expired run may
  only return to `pending` for recovery. A terminal transition clears the lease. Terminal runs
  cannot be reopened; retry creates a new run so final evaluation and consequence evidence remains
  immutable.
- Evaluation, consequence, and operation-receipt inserts are atomic with their run event. Identical
  retries return the existing immutable record without another event; a different value under the
  same authority key is an explicit conflict.
- Complex run events retain the current hash contract after a PostgreSQL round trip. Event payloads
  use order-preserving `JSON`, while queryable state/evidence documents use `JSONB`. The forward
  migration refuses non-empty disposable foundation event data rather than silently invalidating
  its stored hashes.

The Fastify server still uses JSON files as its runtime authority. Setting
`PERSISTENCE_BACKEND=postgres` currently fails startup so an operator cannot accidentally run a
partial JSON/PostgreSQL authority. `DATABASE_URL` is used only by the migration and integration
tools until the cutover is complete.

## Product decisions

- PostgreSQL is the shared persistence and coordination target. SQLite is not an intermediate
  runtime backend; adding it would create another migration and concurrency contract without
  advancing the hosted architecture.
- Do not dual-write the same authoritative state to JSON and PostgreSQL. A write is either committed
  in the active authority or refused.
- Do not add an importer or compatibility branch for disposable development records. Reset or seed
  development data at cutover. Future retained customer data requires an explicit, tested migration
  plan based on that production schema; this decision does not prohibit production migrations.
- JSON remains a development implementation stage, not a product capacity promise. The PostgreSQL
  store is not restricted to one server process.
- Preserve the existing ticket/run/authority/evidence product model. Changing the storage engine
  does not grant new action authority, weaken verification, or turn the ticket system into a broad
  orchestration layer.
- An idempotent database receipt prevents duplicate evidence records; it does not make a filesystem
  or remote-provider side effect atomic with PostgreSQL. The runtime adapter still needs a stable
  operation key plus target-side idempotency or explicit reconciliation before retrying uncertain
  effects.

## Cutover invariants

The server backend must not be enabled until all of these hold:

1. Every mutation in a cutover domain and its required evidence share a transaction boundary.
2. IDs and authoritative timestamps come from PostgreSQL, not `max + 1` scans or application clocks.
3. Concurrent claims cannot select the same run; expired leases can be recovered without a
   process-local singleton.
4. Run event sequence and hash-chain updates are atomic. Events remain append-only and retain the
   current evidence envelope.
5. Overlapping workspace mutations coordinate across processes, while unrelated paths remain
   concurrent. A lock timeout refuses work before side effects instead of hanging indefinitely.
6. Reads use bounded indexed queries; no PostgreSQL mode falls back to scanning JSON files.
7. Startup, scheduler, recovery, replay, operator, and test paths use the same selected authority.
8. A failed database commit cannot leave a successful unrecorded mutation. External target effects
   need an idempotency/reconciliation contract where a database transaction cannot cover the target.
9. The real PostgreSQL integration suite passes in CI. The current JSON checkpoint continues to pass
   until the backend switch, then is replaced with equivalent PostgreSQL-backed runtime coverage.

## Remaining implementation order

1. Refactor the server's synchronous JSON call sites to asynchronous repository calls. Migrate a
   complete authority slice at a time; do not publish a mixed backend as horizontally scalable.
2. Integrate stable operation keys and target-side idempotency/reconciliation with the PostgreSQL
   receipt authority before external side effects can be retried across process failure.
3. Move workflows, templates, schedules, Work Contexts, routing, connectors, permissions, and other
   mutable control records to shared storage with their current validation and provenance rules.
4. Replace in-memory sessions and process-local scheduler ownership where multi-process deployment
   requires shared coordination. Keep provider and run admission bounded per deployment policy.
5. Add indexed event retention/archive operations and tenant/isolation boundaries. PostgreSQL alone
   does not supply those product policies.
6. Run behavioral parity, restart/recovery, multi-process claim, overlapping-path, rollback, and
   pressure tests against the assembled backend.
7. Reset disposable development data, enable `PERSISTENCE_BACKEND=postgres`, and remove the JSON
   runtime path rather than carrying it as a permanent compatibility backend.

## Commands

Apply migrations to a development database without printing its connection string:

```sh
DATABASE_URL=postgresql://... DATABASE_SCHEMA=ticket_system pnpm run db:migrate
```

Run the provider-free contract test:

```sh
pnpm run test:persistence:contract
```

Run the real database integration test. It creates and drops a unique schema in the supplied test
database:

```sh
TEST_DATABASE_URL=postgresql://... pnpm run test:persistence:postgres
```

The local integration command requires a reachable PostgreSQL server. The normal CI workflow
provisions PostgreSQL 17 and runs it on every push and pull request.

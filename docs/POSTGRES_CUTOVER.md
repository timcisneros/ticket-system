# PostgreSQL Cutover

This is the living contract for replacing process-local JSON persistence and coordination with
shared transactional storage. It describes current code and the remaining cutover boundary; it is
not a claim that the server already runs on PostgreSQL.

## Current status

The PostgreSQL foundation and the first five server authority seams are implemented:

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
- `003_ticket_run_lifecycle.sql` adds database-enforced workflow-child idempotency and an indexed
  ticket-batch lookup used by lifecycle settlement.
- Ticket and run transition APIs require an expected revision and allowed source status. Their state
  change and lifecycle event commit or roll back together. Starting a run requires its live lease;
  every normal worker transition from `running` requires the matching live lease. An expired run
  may return to `pending` for recovery or be terminalized as failed/interrupted by recovery; it
  cannot complete without a live owner. A terminal transition clears the lease. Terminal runs
  cannot be reopened; retry creates a new run so final evaluation and consequence evidence remains
  immutable.
- Evaluation, consequence, and operation-receipt inserts are atomic with their run event. Identical
  retries return the existing immutable record without another event; a different value under the
  same authority key is an explicit conflict.
- Complex run events retain the current hash contract after a PostgreSQL round trip. Event payloads
  use order-preserving `JSON`, while queryable state/evidence documents use `JSONB`. The forward
  migration refuses non-empty disposable foundation event data rather than silently invalidating
  its stored hashes.
- Scheduler-owned run lease authority now has one asynchronous repository contract with JSON and
  PostgreSQL implementations. It covers bounded cursor-paged pending discovery, claim,
  ownership verification, heartbeat, workflow-step progress, release, expired-run discovery, and
  recovery. The scheduler rotates through continuation pages, so the configured page size bounds a
  query rather than capping deployment queue depth or permanently starving work behind a blocked
  prefix.
- Expired or wrong-owner leases cannot renew, persist another workflow step, release authority, or
  pass the action ownership check. The runtime preserves an already-returned provider response,
  then renews its lease before parsing; it also revalidates the live lease before each action
  without adding a journal sync per action. A failed check stops execution for recovery instead of
  terminalizing the run through the stale worker. This point-in-time check does not make the target
  side effect atomic with the lease; stable operation keys and target idempotency or reconciliation
  remain required for failure-spanning retries.
- Run terminalization now has one repository boundary for terminal status and lease clear, final
  replay, violation evidence, evaluation, consequence, and ordered terminal events. PostgreSQL
  commits or rolls back that bundle in one transaction, including immutable evidence inserts and
  per-run event-chain updates. The active JSON adapter uses the same runtime call but cannot make
  its snapshot file, run projection, and journal one filesystem transaction; it preserves
  prerequisite evidence, prevents concurrent different-ticket projections from overwriting one
  another, and relies on current-format startup reconciliation after a crash.
- Ticket/run lifecycle now has one repository contract for database-owned ticket and run identity,
  ticket creation/status evidence, batch pending-run creation with open-to-in-progress transition,
  ticket settlement from terminal run evidence, manual reopen, and automatic retry creation.
  PostgreSQL locks only the affected ticket during run admission and commits each state/event bundle
  together. Its retry transaction locks and verifies the terminal predecessor, records reopen, and
  creates exactly one pending successor before commit. The predecessor's terminalization is an
  earlier committed transaction; its process-local execution key remains a scheduling barrier until
  that worker exits. Workflow child ticket idempotency survives multi-process creation races.
- The active JSON lifecycle adapter uses the same server calls but remains honestly
  non-transactional across its projection files and journal. Group run records are persisted as one
  ticket batch, while their later scheduling and execution remain concurrent. Same-ticket lifecycle
  coordination does not serialize unrelated tickets.
- Non-terminal workspace mutations now prepare an append-only target intent before the local
  filesystem effect. A stable key derives from the run, deterministic action slot, operation, and
  canonical input. Completion owns the operation receipt, mutation replay item, and
  `workspace.operation` event through one repository call. Startup and expired-lease recovery
  confirm already-applied effects from target state; a state matching neither the prepared
  pre-state nor intended effect is not retried and emits reconciliation-required evidence.
- PostgreSQL migration `004_non_terminal_evidence.sql` stores immutable prepared intents. Its
  completion transaction inserts the idempotent receipt, advances mutable replay, and appends the
  completion event together. A session-scoped hierarchical target lock spans the committed intent,
  external effect, and completion transaction; it is released automatically if the worker
  connection dies. This does not make the filesystem effect part of a database transaction; the
  prepared-intent reconciliation protocol is the cross-system boundary.
- The remaining bounded execution stream now uses stable, run-attempt-scoped evidence keys through
  the same non-terminal repository. Provider requests are committed before transport admission;
  returned and structured-error responses are committed before parsing or action execution. Parsed
  plans, workflow invocation/step/action-plan evidence, target snapshots, non-mutating workspace
  reads, browser receipts, workflow-draft evidence, handoff evidence, and capability selection/output
  pair replay items with compact events through one repository call. Browser receipts also use the
  append-only idempotent operation-receipt store. Observational keys include the persisted execution
  attempt so a legitimate same-run recovery does not conflict with earlier observations; mutation
  keys remain attempt-independent so target reconciliation still prevents duplicate effects.

The Fastify server currently instantiates the JSON implementations of those repositories, and all
remaining runtime domains still use JSON files as their authority. JSON state mutation and event
append do not gain a database transaction merely by passing through the asynchronous contract.
Setting
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

1. Move replay initialization, remaining scalar/diagnostic replay projections, and bounded replay
   reads to the selected shared authority. These paths still call JSON helpers directly even though
   the bounded execution records listed above use the repository seam.
2. Continue replacing the server's remaining synchronous JSON call sites with asynchronous
   repositories, one complete authority slice at a time. The scheduler lease, run terminalization,
   ticket/run lifecycle, target-mutation evidence, and bounded non-terminal execution-evidence
   slices are complete. Do not publish the mixed implementation as horizontally scalable.
3. Make every startup, recovery, and operator read consume the same selected authority used by
   schedulers and workers; use bounded indexed queries and remove JSON fallback/scans from the
   PostgreSQL path.
4. Move workflows, templates, schedules, Work Contexts, routing, connectors, permissions, and other
   mutable control records to shared storage with their current validation and provenance rules.
5. Replace in-memory sessions and process-local scheduler ownership where multi-process deployment
   requires shared coordination. Keep provider and run admission bounded per deployment policy.
6. Add indexed event retention/archive operations and tenant/isolation boundaries. PostgreSQL alone
   does not supply those product policies.
7. Run behavioral parity, restart/recovery, multi-process claim, overlapping-path, rollback, and
   pressure tests against the assembled backend.
8. Reset disposable development data, enable `PERSISTENCE_BACKEND=postgres`, and remove the JSON
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

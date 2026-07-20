# PostgreSQL Runtime Contract

## Status: cutover complete

PostgreSQL is the only structured runtime persistence and coordination backend. The server does not
select a JSON adapter, dual-write to files, or import disposable legacy development records.
Archived JSON implementation material is retained under `ARCHIVE/legacy-json-runtime/` as history,
not current evidence or a supported runtime mode.

## Authority boundary

Migrations `001` through `028` and `persistence/postgres/store.js` own:

- ticket/run identity, lifecycle, leases, recovery, phase projection, evaluation, and consequence;
- append-only events with database-owned identity/time and per-run sequence/hash-chain tips;
- replay, prepared intents, operation receipts, workspace ownership, and recovery evidence;
- users, groups, permissions, agents, workflows, templates, schedules, Work Contexts, routing,
  connectors, watchers, runtime limits, and diagnostic logs;
- browser targets, work types, local connector objects, allocation plans, inbox threads/messages,
  and HTTP sessions.

Referential constraints, revision guards, append-only triggers, and transaction boundaries live in
the database rather than being inferred from process-local file ordering.

## Concurrency model

Run claim performs a short transaction-scoped admission lock, reads deployment policy, counts live
leases, and claims an eligible row with `FOR UPDATE SKIP LOCKED`. The lock protects the decision; it
does not remain held while a run executes. Different processes and tickets may execute concurrently.
Provider limits are deployment policy, and hierarchical target locks fence only conflicting paths.

The server also has bounded process-local mutation admission. Reaching that capacity refuses or
pauses new mutation admission before side effects, keeps diagnostics available, and recovers when
work drains. A PostgreSQL write/integrity/ownership failure is instead fatal for mutation execution
in the current process.

## Transaction and durability boundary

Lifecycle changes and their required database evidence commit or roll back together. PostgreSQL
durability is governed by the deployed PostgreSQL/storage configuration; the application does not
describe process ordering as power-loss durability.

Filesystem, browser, model-provider, and future connector effects are external to a database
transaction. The runtime records prepared intent before an admitted effect and commits completion
evidence afterward. Reconciliation and stable idempotency keys handle interruption at this boundary.

## Bounded access

Collection reads use exact IDs, keyset cursors, bounded candidate sets, or bounded aggregates. The
HTTP export endpoint requires a domain and returns one bounded page. Page size bounds individual
queries; it is not a deployment queue-size promise. PostgreSQL stores the growing event history;
retention and partitioning remain deployment work rather than an in-process JSON rotation scheme.

## Operational contract

Required startup values:

```sh
DATABASE_URL='postgresql://...'
SESSION_SECRET='stable high-entropy value'
POSTGRES_SCHEMA='ticket_system'   # optional
```

Apply migrations explicitly:

```sh
DATABASE_URL='postgresql://...' POSTGRES_SCHEMA='ticket_system' npm run db:migrate
```

Verify against a disposable database:

```sh
TEST_DATABASE_URL='postgresql://...' npm run checkpoint:release
```

## What completion does not mean

This cutover completes the repository's structured persistence/coordination replacement. It does
not by itself deliver tenant isolation, managed database operations, automated backup/PITR,
retention/partition management, a distributed artifact store, or production security certification.
Those can now be built on one shared transactional authority without carrying a legacy runtime.

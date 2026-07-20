# System Status

This is the living description of current behavior. Dated audits and release notes are historical
evidence, not current verification authority.

## Current baseline

The structured runtime cutover to PostgreSQL is complete:

- Server startup requires `DATABASE_URL` and a stable `SESSION_SECRET`.
- The active backend resolver accepts only `postgres`.
- Tickets, runs, leases, lifecycle transitions, hash-chained events, replay, receipts, logs,
  evaluations, consequences, sessions, catalogs, inbox state, and runtime policy are PostgreSQL
  authorities.
- No live JSON fallback, dual write, or legacy development-data importer exists.
- Operator exports and work-type reads are bounded, cursor-paged database queries.
- Session cleanup is bounded and periodic; sessions survive process restarts and can be shared by
  server instances.

## Coordination and scale direction

- Run admission is deployment-wide. PostgreSQL serializes only the short policy decision and uses
  row leases plus `FOR UPDATE SKIP LOCKED` for claims.
- `maxActiveRuns` and local-model concurrency apply across server processes using the same database.
- Different tickets can run concurrently. Same or overlapping filesystem paths can still be fenced
  to prevent conflicting effects.
- Process-local mutation admission bounds outstanding in-process work. Capacity pressure is
  recoverable and reopens automatically; it is not a permanent service-failure state.
- Fatal persistence/integrity failures fail closed so mutation work never proceeds without its
  required evidence.

## Deliberate external boundaries

`WORKSPACE_ROOT` and browser artifacts remain filesystem/external-effect boundaries. PostgreSQL
transactions protect prepared intent and completion evidence but cannot atomically commit a
filesystem, browser, model-provider, or future connector side effect. Stable operation keys,
target-side idempotency, and reconciliation are required across that boundary.

## Not yet claimed

The repository does not yet claim production-grade multi-tenancy, row-level tenant isolation,
managed secrets, backup/restore automation, point-in-time recovery, event retention/partitioning,
read replicas, zero-downtime migration orchestration, or a shared artifact/blob service. Those are
deployment/productization phases, not reasons to retain the old JSON runtime.

## Verification authority

`TEST_DATABASE_URL=... npm run checkpoint:release` is the deterministic release gate. It includes
syntax, admission/scheduler contracts, core behavioral checks, the full PostgreSQL persistence
integration suite, the application-state/session/deployment-admission cutover test, and authenticated PostgreSQL-native page rendering. A document
does not substitute for a fresh checkpoint result.

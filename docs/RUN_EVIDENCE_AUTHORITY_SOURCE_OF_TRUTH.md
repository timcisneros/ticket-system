# Run Evidence and Authority Source of Truth

This is the living source-of-truth map for current run evidence. It describes which persisted
surface supports each kind of claim; it does not make the event table a complete database or an
executable replay format.

**The authoritative store is PostgreSQL.** Every table below is a PostgreSQL relation in the
configured schema, reached through `PostgresRuntimeStore`. The `data/*.json` paths this document
previously named are the retired JSON adapter and are not consulted by the running server.

## Persisted authorities

| Claim | Primary persisted authority | Supporting evidence |
| --- | --- | --- |
| Ticket identity, assignment, policy, status, and ticket triage | `tickets` | Ticket lifecycle events and logs |
| Run identity, attempt state, immutable runtime/verification snapshots, status, evaluation, consequence, and run triage | `runs` | Run lifecycle events and replay snapshot |
| Ordered lifecycle, authority decisions, operation evidence, and reconciliation chronology | `events` | Replay events and logs |
| Committed workspace mutations and receipts | `operation_history` | `workspace.operation` events and replay operations |
| Provider requests/responses, parsed plans, read evidence, and per-run execution context | `run_replays` | Events and logs |
| Human-readable operator narrative | `logs` | Stronger structured sources above when available |

Local-workspace read receipts are embedded in workspace-operation event and replay evidence; there
is no separate local-read ledger. Browser operations retain their operation-history/action receipt
as well as paired replay/event evidence. Triage is authoritative on the current ticket or run
record. Logs may supply historical context for operator annotations, but they do not override
structured state, receipts, or event evidence.

Bounded execution records use stable evidence keys to correlate their replay item with a compact
event through the non-terminal evidence repository. This includes provider requests/responses,
parsed plans, target snapshots, workflow and capability progress, local reads, browser/action
receipts, workflow-draft evidence, and handoff evidence. Provider request persistence is awaited
before transport admission; returned or structured-error responses are persisted before parsing or
action execution. Observational keys include the run execution-attempt ordinal so recovery can make
new observations, while mutation operation keys remain stable across attempts for reconciliation.
PostgreSQL is the active backend and implements these calls transactionally: a run's replay,
operation history, and event append commit or roll back together. The retired JSON adapter could not
make those one filesystem transaction, which is the limitation this paragraph used to describe.

Replay initialization, scalar/diagnostic projection updates, and single/batch reads use the replay
repository rather than server-level file access. Batch reads accept exact run IDs and enforce a
per-query row limit; larger caller-owned sets are processed in bounded batches without scanning the
replay directory or PostgreSQL replay table. Terminal fields and existing replay items are sealed.
If an operation was admitted before terminalization, it may append exactly one new evidence item
afterward; this preserves a late provider response without changing terminal status, evaluation,
consequence, or action authority.

## Event journal contract

`appendEvent` sanitizes the envelope, assigns the current schema version, id, and high-resolution
timestamp, and writes one row. Run-scoped events receive a zero-based sequence, previous hash, and
content hash, taken from a `run_event_chain_tips` row locked `FOR UPDATE`; concurrent producers
therefore cannot claim the same position.

Bounded, weighted producer admission still governs evidence-dependent work. New HTTP work that
requires evidence can receive recoverable backpressure before side effects, and already accepted
runtime work waits on the shared capacity-change signal before its next evidence-dependent side
effect or standalone append.

Two failure classes are deliberately distinct, and conflating them is a defect in either direction:

- **Request-scoped rejection.** A record exceeding `maxJsonRecordBytes` (2 MiB) is refused by
  `assertJsonRecord` with a `RangeError` carrying `code: 'POSTGRES_RECORD_TOO_LARGE'`,
  `recordBytes`, and `maxRecordBytes`. The enclosing transaction rolls back, so nothing is written
  and no chain position is consumed. `appendEvent` maps this — with `TypeError` and `RangeError`
  generally — to HTTP 413 and rethrows. It does **not** latch, because a caller must not be able to
  degrade the deployment with one oversized request.
- **Internal evidence-persistence failure.** Any other append failure latches
  `evidencePersistenceFailure`, clears readiness, and stops the runtime and template schedulers.
  Subsequent evidence-dependent work is refused with `EVENT_PERSISTENCE_UNAVAILABLE` (503) and
  `/health` reports `degraded`. This is fail-closed by design: a runtime that cannot record what it
  is doing must stop doing it.

Note the limit ordering: Fastify's default body limit (1 MiB) is **below** `maxJsonRecordBytes`
(2 MiB), so an oversized request body is refused as `FST_ERR_CTP_BODY_TOO_LARGE` before the store
rule can apply. The store limit governs records the server accumulates — evaluation, consequence,
and replay documents — not request bodies.

Callers resume after the transaction commits. That commit is the process's durable acknowledgement
boundary; it does not claim protection beyond the guarantees the PostgreSQL deployment provides.

**Known gap — see A20 (`docs/ARCHITECTURAL_DECISIONS_PENDING.md`).** The JSON journal represented an
individual oversized event with compact durable `event.record_rejected` evidence. PostgreSQL leaves
**no durable trace** of a rejected record, and the `oversizedRejections` journal metric no longer
exists. The promise is recorded as an open defect rather than deleted.

## Authority and projection rules

- Authority is decided by runtime checks before a mutation. `authority.allowed` and
  `authority.denied` events plus replay authority checks support that decision; successful mutation
  must not be used to infer an omitted allow decision.
- Operation history is authoritative for committed mutation receipts. Events and replay also record
  refused or failed attempts that never produced a commit record.
- Run evaluation and consequence prefer persisted fields on the `runs` row; a computed fallback must
  be labelled as derived.
- The ticket timeline and operational transparency surfaces are read-only projections. They
  deduplicate and link source evidence without becoming a new ledger or mutation authority.
- Event reconstruction is diagnostic and reduced. Full provider bodies, mutable live state,
  external side effects, and arbitrary safe replay cannot be reconstructed from the event table
  alone.

## Storage boundary

The event table is append-only in normal operation and has no automatic rotation, compaction, or
retention policy. Append admission bounds process-local outstanding work, not total table growth.
PostgreSQL is the shared transactional storage that multiple processes or horizontal deployment
require; what remains process-local is admission accounting, not durability. Coordinated
admission, and an explicit retention/archive design.

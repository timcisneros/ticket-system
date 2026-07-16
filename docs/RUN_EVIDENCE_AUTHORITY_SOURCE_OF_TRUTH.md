# Run Evidence and Authority Source of Truth

This is the living source-of-truth map for current run evidence. It describes which persisted
surface supports each kind of claim; it does not make `events.jsonl` a complete database or an
executable replay format.

## Persisted authorities

| Claim | Primary persisted authority | Supporting evidence |
| --- | --- | --- |
| Ticket identity, assignment, policy, status, and ticket triage | `data/tickets.json` | Ticket lifecycle events and logs |
| Run identity, attempt state, immutable runtime/verification snapshots, status, evaluation, consequence, and run triage | `data/runs.json` | Run lifecycle events and replay snapshot |
| Ordered lifecycle, authority decisions, operation evidence, and reconciliation chronology | `data/events.jsonl` | Replay events and logs |
| Committed workspace mutations and receipts | `data/operation-history.json` | `workspace.operation` events and replay operations |
| Provider requests/responses, parsed plans, read evidence, and per-run execution context | `data/replay-snapshots/run-<id>.json` | Events and logs |
| Human-readable operator narrative | `data/logs.json` | Stronger structured sources above when available |

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
The active JSON adapter cannot make its replay file, operation history, and journal one filesystem
transaction; PostgreSQL implements the same calls transactionally, but is not yet the active server
backend.

## Event journal contract

`appendEvent` sanitizes the envelope, assigns the current schema version, id, and high-resolution
timestamp, and serializes one JSON line. Run-scoped events receive a zero-based sequence, previous
hash, and content hash. A chain position is reserved only after producer admission is available;
concurrent producers therefore cannot claim the same position while a pressure wait is pending.

The process-local journal uses bounded, weighted producer admission and bounded asynchronous group
commit. New HTTP work that requires journal evidence can receive recoverable backpressure before
side effects. Already accepted runtime work waits on the shared capacity-change signal before its
next journal-dependent side effect or standalone evidence append. An individual oversized event is
represented by compact `event.record_rejected` evidence and fails that operation. Write or sync
failure latches a fatal-for-the-current-process persistence state and stops further journal-dependent
mutation execution.

Callers resume after the batch write and `FileHandle.sync()` complete. This is the process's durable
acknowledgement boundary; it does not claim protection beyond the filesystem and hardware guarantees
available to the deployment.

## Authority and projection rules

- Authority is decided by runtime checks before a mutation. `authority.allowed` and
  `authority.denied` events plus replay authority checks support that decision; successful mutation
  must not be used to infer an omitted allow decision.
- Operation history is authoritative for committed mutation receipts. Events and replay also record
  refused or failed attempts that never produced a commit record.
- Run evaluation and consequence prefer persisted fields on `runs.json`; a computed fallback must be
  labelled as derived.
- The ticket timeline and operational transparency surfaces are read-only projections. They
  deduplicate and link source evidence without becoming a new ledger or mutation authority.
- Event reconstruction is diagnostic and reduced. Full provider bodies, mutable live state,
  external side effects, and arbitrary safe replay cannot be reconstructed from the journal alone.

## Storage boundary

The event file is append-only in normal operation and has no automatic rotation, compaction, or
retention policy. Append admission bounds process-local outstanding work, not total file growth.
Multiple processes or horizontal deployment require shared transactional storage, coordinated
admission, and an explicit retention/archive design.

# T2 Implementation Tranche 3 Preflight

## Scope

This is a source/database-contract preflight only. It does not create
migration 041, change runtime behavior, inspect the operational database, or
begin the five-state cutover.

The accepted Tranche 3 boundary is the five-state persistence cutover:

`open`, `in_progress`, `blocked`, `completed`, `canceled`.

`failed` and `closed` remain historical vocabulary until the atomic cutover.
`waiting` remains deferred.

## Opening Gate

- Branch: `master`
- HEAD: `2ee789ec5f57455901900bd17c8fc54c11815c73`
- `origin/master`: `154294e7accff57c044032b0bade6952501d181d`
- Working tree: clean at opening
- Migrations 039 and 040: present
- Tranche 1 lifecycle projector: present
- Tranche 2 cancellation authority contract: present

## Current Owners

### Persistence and Canonical Mutation

- `persistence/postgres/migrations/001_runtime_core.sql:3` owns the current
  six-state Ticket CHECK.
- `persistence/postgres/migrations/009_operational_status.sql:1-71` owns the
  six-state Ticket counter identity, seed, and maintenance trigger.
- `persistence/postgres/migrations/039_ticket_attempt_authority.sql` owns
  immutable attempt membership, attempt dispositions, and exact terminal
  evidence.
- `persistence/postgres/migrations/040_ticket_cancellation_authority.sql`
  owns the durable cancellation authority, not Ticket status.
- `persistence/postgres/store.js:170` owns the six-state runtime set.
- `persistence/postgres/store.js:2190-2320` creates Tickets and serializes
  status in creation events.
- `persistence/postgres/store.js:6165-6459` admits Attempts/Runs and projects
  `open` to `in_progress`.
- `persistence/postgres/store.js:8868-8954` is generic Ticket status mutation.
- `persistence/postgres/store.js:9235-9580` settles Attempts and projects the
  legacy Ticket status.
- `persistence/postgres/store.js:9862-9946` reopens Tickets and admits retries.
- `server.js:14843-17228` contains canonical blocker/refusal writers.
- `server.js:15885-15924` reconstructs stuck `in_progress` Tickets at startup.

### Derived and Product Projections

- `runtime/ticket-lifecycle-contract.js` owns the frozen five-state projector.
- `persistence/postgres/store.js:789-822,6508-7049` reconstructs, filters,
  lists, and counts Tickets by persisted status.
- `persistence/process-template-projection.js:18-115` counts and summarizes
  generated Tickets, including failed/blocked branches.
- `server.js:326,4389-4744,8571-8769,9098-9537` exposes status in API and
  server-rendered projections.
- `scripts/oquery.js:233-330,1385-1420` filters and displays status in CLI.
- `views/tickets.ejs` and `views/ticket-detail.ejs` expose status filters,
  badges, retry/rerun controls, and generic status PATCH behavior.

### Compatibility, Tests, and Historical Evidence

- `ARCHIVE/legacy-json-runtime/**` is historical compatibility only.
- `data/tickets.json`, `data/events.jsonl`, and `data/logs.json` are local
  fixtures, not live PostgreSQL authority.
- `events` is append-only and carries status-change observations.
- `diagnostic_logs` is append-only and carries `ticket:status_change` records.
- Existing source fixtures cover old failed/blocked/interrupted behavior but do
  not establish production historical row counts.

`closed` on `message_threads` and statuses on catalogs/process tables are
unrelated authorities and are outside the Ticket cutover.

## Legacy Close Trace

The live generic close path is:

1. `PATCH /api/tickets/:id/status` receives `status='closed'` and derives
   `changedBy` from the authenticated user and `changedAt` from the request
   process.
2. The route calls `transitionTicketState` with `fromStatuses: [previousStatus]`
   and patch/event payload `{ changedBy, changedAt }`.
3. `transitionTicketState` locks the Ticket and delegates to `transitionTicket`.
4. `transitionTicket` updates `tickets.status`, merges `changedBy` and
   `changedAt` into Ticket JSON, increments revision, and appends a durable
   `ticket.updated` event in the same transaction.
5. The event payload contains `previousStatus`, `status='closed'`, revision,
   `updatedAt`, `changedBy`, and `changedAt`. The event field is named
   `previousStatus`, not `fromStatus`.
6. After the transition returns, the route appends a separate
   `ticket:status_change` diagnostic log containing `fromStatus`, `toStatus`,
   `changedBy`, `changedAt`, and the Ticket id.
7. The route separately snapshots pending/running Runs and calls
   `interruptAgentRun(run, '<changedBy> closed ticket #<ticketId>')` for each.
8. Each interruption performs process cancellation, replay preparation, Run
   terminalization to `interrupted`, terminal Run evidence, a `run:interrupted`
   diagnostic log, and `updateTicketAfterRunInterrupted`.

The exact answers are:

- `fromStatus` is durably recorded in the separate diagnostic log, not in the
  same authoritative transition event; the event records `previousStatus`.
- `changedBy` is recorded in the Ticket body patch, transition event payload,
  and diagnostic log.
- `changedAt` is recorded in the body patch, transition event payload, and
  diagnostic log; `updatedAt` is the database transition timestamp.
- Active Runs present in the route's pending/running snapshot are interrupted
  sequentially by the close path.
- Interruption records can be associated by Ticket id, operator string, exact
  interruption reason, and event/log ordering, but no close event id is carried
  into the interruption evidence.
- The status update and event are transactional. The diagnostic log and Run
  interruptions are subsequent operations and are not in that transaction.
- The close-to-interruption sequence is therefore reconstructably ordered, not
  atomically committed. Missing interruption evidence is detectable and must
  refuse historical cancellation classification.
- The same generic status transition primitive can be invoked outside this HTTP
  route, and the legacy close path has no dedicated cancellation reason or
  causal event id. The same `ticket.updated` shape can therefore arise from a
  non-product generic caller; the classifier requires the matching
  `ticket:status_change` log and, for `in_progress`, the complete interruption
  consequence. Status text alone is not authority.

## Authority-First CLOSED Classifier

The legacy status is only a materialized projection. It is a consistency check,
not the semantic authority. For each selected close operation, establish
`closeAt` from the authoritative close event and reconstruct the Ticket
authority immediately before that event.

The reconstruction excludes the close event, its diagnostic log, all Run
interruption consequences caused by it, and every record created after
`closeAt`. It includes only:

- cancellation authority committed before `closeAt`;
- attempts with `admitted_at` before `closeAt`;
- attempt dispositions whose `settled_at` is before `closeAt`;
- exact Run membership and terminal/evidence timestamps before `closeAt`;
 - immutable completion decisions, leaf membership, and v2 plan metadata
   durable before `closeAt`; the mutable aggregate projection is not
   independent authority;
- blocker/triage creation and resolution evidence ordered before `closeAt`;
- retry and budget authority durable before `closeAt`.

The frozen lifecycle projector is then applied to those as-of-close facts. A
legacy `previousStatus` that disagrees with a valid pre-close projection is a
materialization inconsistency, not a reason to trust the string. If the
authority itself is malformed, contradictory, or cannot be ordered, the row
refuses as an integrity contradiction.

The concrete completed/manual-rerun counterexample is source-valid:

`completed attempt -> legacy reopenTicket persists open -> operator close`

At the close instant the Ticket still derives `completed`, because the new
attempt has not yet been admitted. That row is therefore PROVEN NOT CANCELED,
despite `previousStatus='open'`.

## Final CLOSED Matrix

| Reconstructed canonical pre-close lifecycle and close evidence | Classification | Deciding fact |
|---|---|---|
| Pre-close `completed` | PROVEN NOT CANCELED | Completion was already authoritative before closure; no unfinished work was being abandoned. |
| Pre-close `open`, matching product close event/log, nonempty operator, no contradiction | PROVEN CANCELED | Current legacy close semantics deliberately stop available unfinished work; the product evidence proves the operator close operation. |
| Pre-close `in_progress`, matching close event/log, operator, and every active Run has the exact closure reason plus terminal interruption evidence | PROVEN CANCELED | The complete closure-caused interruption consequence is reconstructably tied by Ticket, operator, reason, and ordering. |
| Pre-close `in_progress` with missing, partial, failed, or unmatchable interruption | AMBIGUOUS | The close status committed, but intentional stopping of all active work is not proved. |
| Pre-close `blocked` with close evidence | AMBIGUOUS | Blocker resolution/supersession and abandonment are not distinguishable from current close evidence. |
| Pre-close `open` or `in_progress` with insufficient product-close proof | AMBIGUOUS | The canonical lifecycle is known, but intentional abandonment is not established. |
| Pre-close `canceled` / existing valid migration-040 authority | PROVEN CANCELED | The Ticket-owned cancellation fact already wins lifecycle precedence. |
| Missing authoritative status-change event/log | AMBIGUOUS | The status column cannot establish close intent or prior authority. |
| Multiple/conflicting close operations | AMBIGUOUS | No unique close operation or as-of-close authority can be selected. |
| Missing operator identity | AMBIGUOUS | Intentional operator authority is not attributable. |
| Missing close timestamp | AMBIGUOUS | As-of-time reconstruction is impossible. |
| Malformed or contradictory cancellation authority | AMBIGUOUS | It is an integrity contradiction and must abort migration. |

FAILED is not a row in this semantic matrix. It is first demoted through the
pre-close authority reconstruction: no blocker/no newer attempt becomes OPEN,
an unresolved blocker becomes BLOCKED, a newer unsettled attempt becomes
IN_PROGRESS, and authoritative completion becomes COMPLETED. The resulting
canonical lifecycle then follows exactly the ordinary matrix row. Two Tickets
with identical reconstructed authority and identical close evidence therefore
classify identically regardless of whether one legacy projection said `failed`
and the other said `open`.

## Historical Cancellation Authority Reconstruction

For PROVEN CANCELED rows:

- `ticketId` comes from the durable Ticket primary key.
- `requestedBy` comes from durable `changedBy` operator identity.
- `committedAt` comes from the authoritative close event/log timestamp, never
  migration execution time.
- `authoritySource` is a deterministic migration-owned value such as
  `historical_operator_closure`; it does not pretend the old path emitted the
  migration-040 contract.
- `reason` is a deterministic factual statement such as
  `historical operator closure of unfinished Ticket work`; it is not an
  invented user-supplied reason.
- The complete object must pass migration-040 and the runtime normalizer.

If any actor, timestamp, pre-close authority, or interruption fact is missing,
the row is AMBIGUOUS and receives no fabricated authority.

## As-of-Time Ordering Contract

- Attempt admission uses `ticket_attempts.admitted_at` and must precede
  `closeAt`.
- Attempt settlement uses `ticket_attempts.settled_at` and must precede
  `closeAt`.
- Run terminal/evidence facts use their durable event, completion, replay,
  consequence, and log timestamps; post-close facts are excluded.
- `aggregateDecision.decidedAt` exists inside the JSON projection, but it is
  not an immutable version history. `allocation_plans.updated_at` orders only
  the current row update, not the aggregate value that was previously stored.
- `ticket.allocation_leaf_items_reconciled` is append-only and carries event
  time, aggregate status/hash, and changed-item observations, but it does not
  preserve a complete prior aggregate object or every prior `decidedAt` value.
- The preflight therefore does not use a mutable aggregate row as independent
  pre-close authority. It derives the fresh v2 candidate from immutable leaf
  membership and append-only per-Run terminal/completion evidence whose event,
  consequence, replay, and receipt timestamps precede `closeAt`.
- If immutable plan metadata or per-Run evidence needed for that derivation is
  missing, malformed, or cannot be ordered as-of close, the v2 case is
  AMBIGUOUS. A later aggregate row cannot repair it.
- Triage/blocker creation and resolution use their stored timestamps and event
  order; a resolution after `closeAt` cannot remove a pre-close blocker.
- Close event position/timestamp establishes `closeAt`; the diagnostic log and
  interruption records are consequences and cannot participate in pre-close
  lifecycle derivation.

Where the schema lacks a trustworthy timestamp or ordering relation for a
required authority, classification is AMBIGUOUS.

## Refusal Mechanism

The eventual migration must abort the entire transaction on the first
ambiguous, contradictory, malformed, or unclassifiable row. The repository
migration runner already executes each migration inside `BEGIN`/`COMMIT` and
rolls back on error. No permanent migration-error lifecycle state is added.

## Generic Status and Retry Cutover

The final cutover must remove or restrict generic `PATCH /api/tickets/:id/status`.
Canonical ownership becomes:

- `in_progress`: attempt admission;
- `completed`: completion authority and settlement;
- `canceled`: Ticket cancellation authority;
- `blocked`: canonical blocker writers;
- `open`: canonical reprojection or atomic admission/retry operation.

Manual rerun currently persists `open` through `forceTicketOpenForRerun` and
then admits Runs. This requires a narrowly scoped atomic rerun/admission writer
before cutover. The existing `createRetryRun` composition is the accepted base
for automatic retry and already performs reopen plus admission transactionally.
Interrupted recovery remains distinct from new-attempt retry.

## Blocker Dependency

Current unresolved Ticket triage, structured refusal evidence, and exhausted
attempt authority are sufficient blocker sources when reconstructable. A
status-only blocked row or a refusal with no current unresolved authority is
ambiguous and aborts migration. Blocker supersession is not implemented here;
rows requiring it cannot be guessed through the cutover.

## Release Compatibility Barrier

The migration and application must use a maintenance boundary:

1. Stop or disable every old application process, scheduler, worker, reader,
   and writer that can access Ticket lifecycle state.
2. Run the zero-ambiguity read-only preflight.
3. Apply the atomic database cutover.
4. Deploy and start the five-state-compatible application.
5. Run post-cutover integrity verification.
6. Reopen traffic and workers.

No old six-state reader/writer may run against the five-state database, and no
five-state-only reader/writer may run against the old six-state database. No
dual-schema compatibility layer is introduced merely to avoid this boundary.

## Schema Boundary

Before:

```sql
status TEXT NOT NULL CHECK (
  status IN ('open', 'in_progress', 'completed', 'failed', 'blocked', 'closed')
)
```

After:

```sql
status TEXT NOT NULL CHECK (
  status IN ('open', 'in_progress', 'blocked', 'completed', 'canceled')
)
```

The status-counter identity, seed, maintenance trigger, runtime constants,
filters, serializers, and all generic writers must change in the same release
boundary. No seven-state database vocabulary is permitted.

## Deterministic Migration Test Matrix

- Completed attempt plus legacy intermediate `open`, then close: MUST remain
  PROVEN NOT CANCELED.
- Failed attempt with no blocker, then close: demotes to OPEN and receives the
  exact ordinary OPEN result.
- Failed attempt with unresolved blocker, then close: demotes to BLOCKED and
  receives the exact ordinary BLOCKED result.
- Failed attempt with newer unsettled attempt, then close: demotes to
  IN_PROGRESS and receives the exact ordinary IN_PROGRESS result.
- Normal open with no prior completion and product close: PROVEN CANCELED only
  with matching product evidence.
- In-progress Ticket with complete matched interruption consequence: PROVEN
  CANCELED.
- In-progress Ticket with partial/missing interruption consequence:
  AMBIGUOUS.
- Blocked Ticket plus close: AMBIGUOUS.
- Completed Ticket plus close: PROVEN NOT CANCELED.
- Later evidence created after `closeAt`: excluded from pre-close derivation.
- Identical reconstructed pre-close authority plus identical close evidence:
  identical classification regardless of legacy `previousStatus`.
- Valid and inconsistent rows for every other old status.
- Exact current-attempt membership and completion evidence.
- v2 aggregate proof and malformed/misbound v2 refusal.
- Failed demotion with unsettled attempt, blocker, completion, and open cases.
- Blocked rows with unresolved, resolved, absent, and status-only blockers.
- Closed rows covering every table classification above.
- Missing, duplicate, conflicting, and mismatched close evidence.
- Missing operator, timestamp, and interruption consequence.
- Valid and malformed historical cancellation authority reconstruction.
- Atomic rollback on one ambiguous row.
- Successful cutover leaves only the five allowed statuses and matching counts.
- Post-cutover generic status mutation refusal and atomic rerun behavior.

## Next Read-Only Operational Preflight

The next authorized operation is a zero-mutation enumerator, not a count-only
query. For every Ticket it must output Ticket id, current status, authority
references, current Attempt id/ordinal/disposition/member count, all exact Run
members and terminal evidence, v2 plan/aggregate references, triage/blocker
references, cancellation authority, close event ids/timestamps/payload fields,
matching status-change logs, interruption evidence, proposed lifecycle, and a
classification/refusal reason.

It must use a read-only database role or an explicit transaction with no write
statements, emit a deterministic report artifact, and require zero ambiguous
or contradictory rows before migration. It must not be executed against the
operational database without separate authorization.

## Remaining Prerequisite

The five-state implementation remains gated on the read-only operational row
classification described above, especially legacy `closed` and status-only
`blocked` rows. No operational data was inspected in this preflight.

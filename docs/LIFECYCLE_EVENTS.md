# Lifecycle Events Contract

## Canonical Events (5)

| Event | Phase | Meaning |
|-------|-------|---------|
| `run.execution_completed` | Execution done | Model/tool loop ended and intended terminal status is known; reconciliation is still pending |
| `run.snapshot_finalized` | Snapshot written | Replay snapshot persisted to disk |
| `run.evaluation_completed` | Evaluation done | `runEvaluation` recorded |
| `run.consequence_recorded` | Consequence done | `runConsequence` recorded |
| `run.terminalized` | Reconciliation done | Final lifecycle evidence that terminal reconciliation completed |

## Emission Order

Normal completion / failure follow this pipeline:

```
run.execution_completed
    → run.snapshot_finalized
    → run.postconditions_checked  (when applicable)
    → run.violations_checked
    → run.evaluation_completed
    → run.consequence_recorded
    → run.terminalized
    → finalizeTicketForRun
```

Interruption follows the same reconciliation pipeline without postcondition checking:

```
run.execution_completed
    → run.snapshot_finalized
    → run.violations_checked
    → run.evaluation_completed
    → run.consequence_recorded
    → run.terminalized
    → updateTicketAfterRunInterrupted
```

Reconciliation (`reconcileTerminalRun`) emits only missing steps with the same terminalization:

```
(guard: skip if run.terminalized already exists)
[snapshot if missing] → [evaluation if missing] → [consequence if missing]
    → run.terminalized
```

## Finality Rules

1. `run.status` is the materialized run state used by the runtime, UI, APIs, scheduler, and recovery logic.
2. Current terminal `run.status` values are `completed`, `failed`, and `interrupted`.
3. `run.execution_completed` means execution is complete and the intended terminal status is known.
4. `run.execution_completed` is explicitly **not fully reconciled** — snapshot, evaluation, consequence, and terminalization may still be pending.
5. `run.terminalized` is lifecycle reconciliation evidence, not a `run.status` value.
6. A terminal `run.status` plus `run.terminalized` means the run is fully reconciled and immutable.

## Disposition Rules

| Events Present | `isTerminal` | `hasExecutionCompleted` | Disposition |
|---|---|---|---|
| `run.terminalized` | true | true | Immutable — skip, do not reconcile, do not resume |
| `run.execution_completed` + `run.snapshot_finalized` + `run.evaluation_completed` + `run.consequence_recorded` but NO `run.terminalized` | false | true | **Reconcilable** — run terminalization is missing |
| `run.execution_completed` + `run.snapshot_finalized` but NO evaluation/consequence/terminalized | false | true | **Reconcilable** — evaluation and consequence are missing |
| `run.execution_completed` but NO snapshot | false | true | **Reconcilable** — snapshot and everything after missing |
| No `run.execution_completed` and no `run.terminalized` | false | false | **Resumable** (if hash chain and authority intact) |

## Current-Schema Boundary

Only the lifecycle events documented above are accepted. Development data and fixtures must be
reset or regenerated when the schema changes; readers do not carry compatibility branches for old
run events. `run.execution_completed` and `run.snapshot_finalized` are never terminal by themselves.

`run.progress_blocked` (Tranche 5) is a **governance** event, not a lifecycle event, and is
deliberately absent from the five above. It records that a governed structured leaf Run was stopped
by a verified-progress, churn, duration, or sibling-read decision, and it binds the deciding
authority: reason, block hash, churn-decision hash, verified-progress projection hash, progress
policy hash, and the exact cutoff including its database-captured evaluation instant.

It does not participate in the disposition rules above. It is written in the same transaction as
the block it records, exactly once per block transition — re-evaluating an already-blocked Run reads
the stored block and appends nothing. A blocked Run is not resumable by recovery, which is why the
churn decision uses `blocked` rather than `interrupted`.

## State Machine

```
Materialized run.status:

pending → running → completed
                 ↘ failed
                 ↘ interrupted

Lifecycle reconciliation evidence:

run.execution_completed → run.snapshot_finalized → run.evaluation_completed
    → run.consequence_recorded → run.terminalized

run.created          → pending
run.lease_acquired   → pending
run.started          → running
run.execution_completed → terminal status known, still needs reconciliation
run.terminalized     → reconciliation complete (not a run.status value)
```

Transitions out of terminal statuses are invalid. Events permitted after terminal status:
`run.evaluation_completed`, `run.consequence_recorded`, `run.violations_checked`, `run.snapshot_finalized`, `run.execution_completed`, `run.terminalized`.

## Invariants (Enforced by Test)

1. `run.execution_completed` alone → `isTerminal=false`, `hasExecutionCompleted=true`
2. `run.snapshot_finalized` without `run.terminalized` → `isTerminal=false`
3. `run.evaluation_completed` without `run.terminalized` → `isTerminal=false`
4. `run.consequence_recorded` without `run.terminalized` → `isTerminal=false`
5. `run.terminalized` → `isTerminal=true`, `safeToResume=false`

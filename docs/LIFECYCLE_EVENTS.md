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

## Legacy Compatibility

- `run.completed`, `run.failed`, `run.interrupted` are legacy terminal event names.
- Terminal statuses `completed`, `failed`, and `interrupted` are current runtime truth, not legacy states.
- Readers treat legacy event names as equivalent to `run.terminalized` for backward compatibility (`isTerminal = true`).
- They are also treated as equivalent to `run.execution_completed` (`hasExecutionCompleted = true`).
- No new code may emit `run.completed`/`run.failed`/`run.interrupted`. They are read-only legacy formats.
- No new code may classify `run.execution_completed` or `run.snapshot_finalized` as terminal.

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
6. Legacy `run.completed` → `isTerminal=true` (backward compat)

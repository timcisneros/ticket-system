# Lifecycle Events Contract

## Canonical Events (5)

| Event | Phase | Meaning |
|-------|-------|---------|
| `run.execution_completed` | Execution done | Model/tool loop ended (all agent steps consumed, or error/interrupt occurred) |
| `run.snapshot_finalized` | Snapshot written | Replay snapshot persisted to disk |
| `run.evaluation_completed` | Evaluation done | `runEvaluation` recorded |
| `run.consequence_recorded` | Consequence done | `runConsequence` recorded |
| `run.terminalized` | Terminal | **Sole authoritative final lifecycle event** |

## Emission Order

Normal completion / failure / interruption all follow the same pipeline:

```
run.execution_completed
    → postconditions check  (completed/failed only, not interrupted)
    → run.snapshot_finalized
    → violations check
    → run.evaluation_completed
    → run.consequence_recorded
    → run.terminalized
    → finalizeTicketForRun
```

Reconciliation (`reconcileTerminalRun`) emits only missing steps with the same terminalization:

```
(guard: skip if run.terminalized already exists)
[snapshot if missing] → [evaluation if missing] → [consequence if missing]
    → run.terminalized
```

## Finality Rules

1. **Only `run.terminalized` is authoritative.** No other event makes a run terminal.
2. `run.execution_completed` is explicitly **not final** — it means the execution loop finished but reconciliation (evaluation, consequence, terminalization) is still pending.
3. `run.snapshot_finalized` is explicitly **not final** — snapshot is written but evaluation and consequence may not have run yet.
4. `run.evaluation_completed` and `run.consequence_recorded` are explicitly **not final** — they precede terminalization.
5. A run with `run.terminalized` is fully done. The scheduler, recovery, and execution engine must treat it as immutable.

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
- Readers treat them as equivalent to `run.terminalized` for backward compatibility (`isTerminal = true`).
- They are also treated as equivalent to `run.execution_completed` (`hasExecutionCompleted = true`).
- No new code may emit `run.completed`/`run.failed`/`run.interrupted`. They are read-only legacy formats.
- No new code may classify `run.execution_completed` or `run.snapshot_finalized` as terminal.

## State Machine

```
States: pending → running → terminalized
                           ↘ completed / failed / interrupted (legacy terminal)

run.created          → pending
run.lease_acquired   → pending
run.started          → running
run.execution_completed → running (no state change — still needs reconciliation)
run.completed        → completed (legacy terminal)
run.failed           → failed (legacy terminal)
run.interrupted      → interrupted (legacy terminal)
run.terminalized     → terminalized (authoritative terminal)
```

Transitions out of terminal states are invalid. Events permitted after terminal state:
`run.evaluation_completed`, `run.consequence_recorded`, `run.violations_checked`, `run.snapshot_finalized`, `run.execution_completed`, `run.terminalized`.

## Invariants (Enforced by Test)

1. `run.execution_completed` alone → `isTerminal=false`, `hasExecutionCompleted=true`
2. `run.snapshot_finalized` without `run.terminalized` → `isTerminal=false`
3. `run.evaluation_completed` without `run.terminalized` → `isTerminal=false`
4. `run.consequence_recorded` without `run.terminalized` → `isTerminal=false`
5. `run.terminalized` → `isTerminal=true`, `safeToResume=false`
6. Legacy `run.completed` → `isTerminal=true` (backward compat)

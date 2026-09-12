# Execution Semantics

## Overview

The ticket system supports four distinct execution boundaries. Each boundary controls what the model sees, what gets mutated, and whether a prior failure context is injected.

## Boundaries

### 1. Resume
**Definition**: Deterministic continuation of an interrupted run using the same run record, replay snapshot, and action ledger.

**Rules**:
- Resume is only allowed when `safeToResumeExecution` is true: the run is not terminal (`!isTerminal`), execution has not completed (`!hasExecutionCompleted`), the hash chain is intact, and there are no duplicate mutations.
- On resume, previously committed mutations (same operation + same args fingerprint in the run ledger) are skipped as idempotent no-ops.
- Resume does not ADD a new `priorAttemptContext`. Recovery may re-deliver the same Run's durable first model step with the identical original first-step `priorAttemptContext`; later resumed turns receive no prior-attempt projection.
- Workspace state reflects whatever was committed before interruption; no rollback occurs.

**Why it matters**: Resume prevents duplicate work if a process restarts mid-run. The model continues from the last successful step as if nothing happened.

### 2. Retry
**Definition**: A fresh run on the same ticket, created by `/api/tickets/:id/rerun` with default mode `retry`.

**Rules**:
- A new run record is created with `rerunMode: 'retry'`.
- The model receives an empty `previousActionResults` array.
- **No** `priorAttemptContext` is injected into the prompt.
- The model may see the current workspace state (which may include artifacts from prior runs), but it is not told why prior runs failed.
- Workspace mutations proceed normally with full authority checks.

**Why it matters**: Retry is a clean-slate rerun. It trusts the model to inspect the workspace and figure out what needs doing without being primed with failure analysis.

### 3. Reassess
**Definition**: A fresh run on the same ticket, created by `/api/tickets/:id/rerun` with explicit mode `reassess`.

**Rules**:
- A new run record is created with `rerunMode: 'reassess'`.
- The model receives an empty `previousActionResults` array.
- **Only in reassess mode**, `priorAttemptContext` is injected on step 0. It includes:
  - `priorRunId` / `priorRunStatus`: the most recent prior terminal run on this ticket (including one materialized `completed` whose objective decision was incomplete or blocked) and how it ended
  - `priorReasonCode` / `priorError` / `priorDecisionAt`: the persisted completion-decision reason code, the boundary-sanitized prior error, and the decision timestamp, each omitted when unavailable
  - `committedPaths`: `{ entries, total, truncated }` — committed mutation paths (`{category, path}` or `{category:'renamed', path, nextPath}`) from the prior run's canonical hydrated consequence, deduplicated source-side and bounded by the prior run's own durable `runtimeLimitsSnapshot.maxWorkspaceOperationsPerRun`; omitted when the canonical consequence or the durable bound is unavailable
  - `priorCriteria`: `{ label, entries }` — the prior run's persisted `completionDecision.evaluatedPostconditions` (`{type, path?, passed, reasonCode}`), explicitly labeled **PRIOR-ATTEMPT TERMINAL/LAST-OBSERVED CRITERION STATE**
  - `historicalBoundary`: the fixed statement that these facts describe the prior attempt only, are not current workspace truth, cannot satisfy criteria or authorize actions, and that current deterministic observation and canonical evaluation in the new run control actual completion
- Workspace mutations proceed normally with full authority checks.

**Why it matters**: Reassess gives the model explicit bounded historical evidence of the prior attempt so it can avoid repeating the same mistake. This is the only mode where prior-attempt context crosses the run boundary, and it is model context only — never completion or action authority.

### 4. Commit
**Definition**: The idempotent mutation boundary inside a single run.

**Rules**:
- Every mutating workspace operation (`writeFile`, `createFolder`, `renamePath`, `deletePath`) is fingerprinted, and the fingerprint is recorded with its committed operation receipt.
- If the exact same fingerprint already exists in the Run's authoritative committed-mutation evidence for the current run — the PostgreSQL `operation_receipts` store — the operation is skipped as an idempotent no-op and the prior result is returned.
- If a **different** operation already committed on the **same path** in the current run, the new operation is rejected with `MUTATION_CONFLICT`.
- The fingerprint for `renamePath` includes both `path` and `nextPath`, so renaming A→B and then A→C are treated as different operations (and the second would conflict on path A).
- The fingerprint for `deletePath` is just the path, so deleting the same file twice is idempotent.

**Why it matters**: Commit prevents duplicate mutations during resume and prevents logically conflicting mutations within a single run (e.g., write then delete the same file).

## Mode Matrix

| Mode | New run? | Failure context? | Use case |
|------|----------|-------------------|----------|
| Resume | No | No | Process restart mid-run |
| Retry | Yes | No | Clean-slate rerun |
| Reassess | Yes | Yes | Diagnose and avoid prior failure |
| Commit | N/A | N/A | Idempotent mutation inside a run |

## API

### Rerun endpoint
```
POST /api/tickets/:id/rerun
Body: { "mode": "reassess" }  // or omit for default "retry"
```

The `mode` is stored on the ticket (`ticket.rerunMode`) and copied to the new run (`run.rerunMode`). In the current five-state Ticket vocabulary (`open`, `in_progress`, `blocked`, `completed`, `canceled`), `rerunMode` is cleared when the ticket transitions to `completed` or is reopened back to `open`.

## Invariants

1. `priorAttemptContext` is injected **only** when `rerunMode === 'reassess'` and `actionResults.length === 0`. It is model context only: never completion authority, action authority, or a criterion satisfier, and excluded from authority/decision hashes.
2. `rerunMode` is cleared when the ticket transitions to `completed` or back to `open`.
3. Idempotent skip applies only to exact fingerprint matches (same operation + same args).
4. Any different operation targeting the same path in the same run is rejected with `MUTATION_CONFLICT`.
5. Mutation fingerprinting covers all four mutating operations.

# Execution Semantics

## Overview

The ticket system supports four distinct execution boundaries. Each boundary controls what the model sees, what gets mutated, and whether a prior failure context is injected.

## Boundaries

### 1. Resume
**Definition**: Deterministic continuation of an interrupted run using the same run record, replay snapshot, and action ledger.

**Rules**:
- Resume is only allowed when `safeToResumeExecution` is true: the run is not terminal (`!isTerminal`), execution has not completed (`!hasExecutionCompleted`), the hash chain is intact, and there are no duplicate mutations.
- On resume, previously committed mutations (same operation + same args fingerprint in the run ledger) are skipped as idempotent no-ops.
- The model receives the full prior action results history (`previousActionResults`) but **does not** receive `priorFailureContext`.
- Workspace state reflects whatever was committed before interruption; no rollback occurs.

**Why it matters**: Resume prevents duplicate work if a process restarts mid-run. The model continues from the last successful step as if nothing happened.

### 2. Retry
**Definition**: A fresh run on the same ticket, created by `/api/tickets/:id/rerun` with default mode `retry`.

**Rules**:
- A new run record is created with `rerunMode: 'retry'`.
- The model receives an empty `previousActionResults` array.
- **No** `priorFailureContext` is injected into the prompt.
- The model may see the current workspace state (which may include artifacts from prior runs), but it is not told why prior runs failed.
- Workspace mutations proceed normally with full authority checks.

**Why it matters**: Retry is a clean-slate rerun. It trusts the model to inspect the workspace and figure out what needs doing without being primed with failure analysis.

### 3. Reassess
**Definition**: A fresh run on the same ticket, created by `/api/tickets/:id/rerun` with explicit mode `reassess`.

**Rules**:
- A new run record is created with `rerunMode: 'reassess'`.
- The model receives an empty `previousActionResults` array.
- **Only in reassess mode**, `priorFailureContext` is injected on step 0. It includes:
  - `priorRunId`: the most recent terminal run on this ticket
  - `status`: why it failed (`failed` or `interrupted`)
  - `reason`: human-readable failure reason
  - `lastAction`: the last workspace operation attempted
  - `mutations`: list of prior mutations with paths and content hashes
  - `inspectedFiles`: unique files read in the prior run
- Workspace mutations proceed normally with full authority checks.

**Why it matters**: Reassess gives the model explicit evidence of a prior failure so it can avoid repeating the same mistake. This is the only mode where failure context crosses the run boundary.

### 4. Commit
**Definition**: The idempotent mutation boundary inside a single run.

**Rules**:
- Every mutating workspace operation (`writeFile`, `createFolder`, `renamePath`, `deletePath`) is fingerprinted by `computeMutationFingerprint`.
- If the exact same fingerprint already exists in `operation-history.json` for the current run, the operation is skipped as an idempotent no-op and the prior result is returned.
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

The `mode` is stored on the ticket (`ticket.rerunMode`) and copied to the new run (`run.rerunMode`). When the ticket reaches a terminal status (`completed`, `failed`, `interrupted`), `rerunMode` is cleared.

## Invariants

1. `priorFailureContext` is injected **only** when `rerunMode === 'reassess'` and `actionResults.length === 0`.
2. `rerunMode` is cleared on ticket terminalization.
3. `findCommittedMutation` skips only exact fingerprint matches (same operation + same args).
4. `findConflictingMutation` rejects any different operation targeting the same path in the same run.
5. `computeMutationFingerprint` covers all four mutating operations.

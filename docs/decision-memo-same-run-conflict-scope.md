# Decision Memo: Same-Run Conflict Scope

## Decision Under Consideration

Should `findConflictingMutation` scope be narrowed from same-run to same-batch?

## Options

### Option A: Retain same-run scope
Keep `findConflictingMutation` rejecting any different mutating operation on the same path across all steps in a single run.

### Option B: Reduce to same-batch scope
Narrow `findConflictingMutation` to reject only conflicting mutating operations within the same model response (same step). Allow cross-step mutations on the same path.

## Known Evidence

### Same-run scope
- **Demonstrated cost:** 1 — two independent experiments show a legitimate create-then-delete workflow blocked, run failed, artifact stranded.
- **Demonstrated benefit:** 0 — zero naturally occurring operational protections found in `events.jsonl`, `operation-history.json`, `runs.json`, or replay snapshots.
- **Pre-existing protection overlap:** `findCommittedMutation` already handles exact duplicate mutations during resume.

### Same-batch scope
- **Demonstrated cost:** Unknown. No naturally occurring data exists because the current runtime has never operated under it.
- **Demonstrated benefit:** Unknown. No naturally occurring data exists because the current runtime has never operated under it.

### Origin uncertainty
- Pre-commit Run 1 contained cross-step `writeFile → deletePath`.
- No commit message, design note, failure report, or review discussion links Run 1 to the feature.
- Causal origin unknown.

## Unknowns

- Whether same-batch scope would allow a real model to accidentally delete its own prior work across steps in actual operation.
- How many legitimate multi-step workflows are silently blocked by same-run scope.
- Whether changing scope would affect existing benchmark results or regression test baselines.
- Whether any workload profile or prompt guidance implicitly assumes cross-step mutation blocking.

## Consequences of Each Option

### Option A (retain same-run)
- **Known consequence:** Legitimate create-then-delete workflows continue to be blocked and fail.
- **Known consequence:** 4 existing tests continue to pass without modification.
- **Known consequence:** Documents (`EXECUTION_SEMANTICS.md`, `BOUNDED_OPERATION_BATCHES.md`) remain accurate.
- **Unknown consequence:** Theoretical protective value against cross-step self-destruction remains unverified.

### Option B (reduce to same-batch)
- **Known consequence:** Legitimate create-then-delete workflows would be allowed.
- **Known consequence:** 4 existing tests would fail and require updating.
- **Known consequence:** Documents (`EXECUTION_SEMANTICS.md`, `BOUNDED_OPERATION_BATCHES.md`) would require updating.
- **Unknown consequence:** Risk of cross-step self-destructive mutations in real operation.

## Decision Deferred

`decision_deferred = true`

The evidence packet is asymmetric: same-run has a demonstrated cost but no demonstrated benefit; same-batch is entirely unknown. A decision owner cannot make an informed choice between the options using only the current evidence.

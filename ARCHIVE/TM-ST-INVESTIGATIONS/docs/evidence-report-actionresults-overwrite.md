# Evidence Report: actionResults Overwrite Sites

## Decision Under Consideration

Should the four remaining `actionResults = [{warning}]` overwrite sites in `server.js` be changed to `push`?

Sites:
- `model:action_limit` (line 9380)
- `model:mutating_action_limit` (line 9443)
- `execution.phase_violation` (line 9473)
- `model:stalled` (line 9518)

## Evidence Found

### Operational Occurrences

| Event Type | Events in `data/events.jsonl` | Runs Failed |
|------------|------------------------------|-------------|
| `model:action_limit` | **0** | **0** |
| `model:mutating_action_limit` | **0** | **0** |
| `execution.phase_violation` | **0** | **0** |
| `model:stalled` | **0** | **0** |

**None of the four paths have ever been hit in actual operational data.**

### Code Structure Analysis

These four overwrite sites share a critical structural property:

```javascript
// Line 9363: actionResults is reset at the start of each step loop iteration
actionResults = [];
const actions = modelPlan.actions;

// Lines 9372-9478: Pre-execution validation checks occur HERE
// - action limit check
// - mutating action limit check
// - phase compliance check

// If any check fails, actionResults is still [] because no operations have executed yet.
actionResults = [{warning: '...'}];

// Lines ~9573+: The execution loop begins AFTER these checks.
// Only here do operations execute and push results into actionResults.
```

**At the point of replacement, `actionResults` is empty.** No operations have been executed. No inspection evidence exists. No workspace state has been observed. `push` vs `=` is mechanically equivalent at these four sites.

### Existing Test Coverage

| Test | Path Tested | Tests Repeated Behavior? | Tests Self-Correction? |
|------|-------------|-------------------------|----------------------|
| `bounded-transition-test.js` | `model:mutating_action_limit` | Yes (fake model repeats oversized batch) | **No** — fake model hard-codes repetition |
| `operational-abuse-test.js` | `model:action_limit`, `model:stalled` | Partial | **No** |
| `agent-regression-test.js` | `model:stalled` | Partial | **No** |

All tests use **mocked models** that hard-code the violating behavior.

## What Is NOT Lost at These Sites

The following claims are **unsupported** and should not be made:

- The model loses prior inspection evidence at these four sites.
- The model receives only a warning because evidence was destroyed.
- Changing `=` to `push` would preserve operation results.
- Changing `=` to `push` would enable self-correction.

At these four sites, `actionResults` is empty. There is no accumulated evidence to preserve. The model receives a warning, but there is no destroyed evidence to recover.

## What Was Different About the no_progress Case

The `model:no_progress` overwrite (now fixed) was structurally different:

- **Location:** AFTER the execution loop, not before.
- **Evidence state:** `actionResults` contained actual `listDirectory` results (directory entries, file metadata).
- **Overwritten:** `actionResults = [{warning}]` destroyed all discovered directory contents.
- **Consequence:** Model lost discovered state and repeated `listDirectory` because it could not see prior results.

That operational failure justified the fix. The current four sites do not share this structure.

## Demonstrated Costs

### Specific to the four overwrite sites
**0** — No operational run has ever been observed hitting these paths.

### Regarding evidence destruction as a general pattern
**>0** — A prior audit (Run 77 postmortem) established that overwriting accumulated `actionResults` can destroy evidence needed for state transitions. That finding applied to the `model:no_progress` path, which occurred after operations had executed and accumulated results. The current four sites are pre-execution rejections where no evidence exists to destroy.

## Demonstrated Benefits

### Specific to the four overwrite sites
**0** — No operational benefit has been demonstrated.

## Audit Boundary

### Findings about the four specific overwrite sites
The evidence packet for these four paths is empty:

| Path | Operational Occurrences | Demonstrated Cost | Demonstrated Benefit |
|------|------------------------|-------------------|----------------------|
| `model:action_limit` | 0 | 0 | 0 |
| `model:mutating_action_limit` | 0 | 0 | 0 |
| `execution.phase_violation` | 0 | 0 | 0 |
| `model:stalled` | 0 | 0 | 0 |

All existing test coverage is synthetic (mocked models with hard-coded behavior).

**Decision on these four sites: `decision_deferred = true`** — No operational data exists to evaluate whether changing them would produce real improvements. Because `actionResults` is empty at the point of replacement, `push` vs `=` would have no demonstrated effect.

### Claims this audit does NOT support
- "Evidence destruction is harmless in general." (The `no_progress` case proved otherwise.)
- "The four overwrite sites destroy evidence the model needs." (No evidence exists to destroy at these pre-execution sites.)
- "Changing `=` to `push` at these sites would enable self-correction." (No evidence exists to preserve; this would be a new feature, not evidence preservation.)

### Claims this audit DOES support
- "No operational evidence exists for or against changing the four remaining overwrite sites."
- "The `no_progress` overwrite was a real evidence-destruction bug with a different structure (post-execution, not pre-execution)."
- "The four sites are pre-execution rejections where `actionResults` is empty; `push` vs `=` is mechanically equivalent."

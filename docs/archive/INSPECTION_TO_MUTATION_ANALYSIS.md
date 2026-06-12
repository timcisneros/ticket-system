# Inspection to Mutation Analysis

## Question

Why does the model continue choosing a valid inspection action instead of transitioning to mutation after inspection has already succeeded?

---

## 1. Current Phase Transition Rules

### Phase states

```javascript
const EXECUTION_PHASES = ['planning', 'inspection', 'mutation', 'verification', 'terminalization'];
const PHASE_OPERATIONS = {
  planning: [],
  inspection: ['listDirectory', 'readFile'],
  mutation: ['writeFile', 'createFolder', 'renamePath', 'deletePath', 'createWorkflowDraft', 'createWorkflowDraftIntent', 'createHandoffTask'],
  verification: ['listDirectory', 'readFile'],
  terminalization: []
};
```

### Transition matrix

```javascript
const ALLOWED_PHASE_TRANSITIONS = {
  planning: ['planning', 'inspection', 'mutation', 'verification'],
  inspection: ['inspection', 'mutation', 'verification'],
  mutation: ['mutation', 'verification'],
  verification: ['verification', 'terminalization'],
  terminalization: ['terminalization']
};
```

### How phase advances

Phase is advanced by `checkPhaseCompliance` → `advanceRunPhase` based on the **inferred phase from the model's actions**:

```javascript
function inferPhaseFromActions(actions) {
  const phases = new Set();
  for (const op of ops) {
    for (const [phase, allowed] of Object.entries(PHASE_OPERATIONS)) {
      if (allowed.includes(op)) phases.add(phase);
    }
  }
  if (phases.size === 1) return [...phases][0];
  // inspection and verification share ops; default to inspection
  if (onlyReadPhases) return 'inspection';
  return 'mixed';
}
```

`checkPhaseCompliance` only rejects:
1. **Mixed-phase responses** (actions from different phases in one response)
2. **Terminalization violations** (ops after terminalization)

It **does NOT reject** an inspection-only response when the current phase is `inspection`. This is by design; the comment in `server.js:361-365` states:

> "Phase state tracks forward progression for observability, but does not constrain which single-phase response the model may emit."

Therefore, the model can emit `listDirectory` in `inspection` phase indefinitely. The phase does not block it.

---

## 2. Current No-Progress Rules

### Bounded operation batch enforcement

In the execution loop (`server.js:9043-9084`):

```javascript
if (!modelPlan.complete && !hasMutatingAction && actions.length > 0) {
  const isInspectionOnly = actions.every(a => {
    const op = a && a.operation;
    return op === 'listDirectory' || op === 'readFile';
  });

  if (isInspectionOnly) {
    noProgressResponses += 1;
    // ... record event ...
    if (noProgressResponses >= 2) {
      throw createRunLimitError(run, 'step', 'Model repeated inspection-only non-progress twice...');
    }
    actionResults = [{
      warning: 'model:no_progress',
      message: 'You emitted inspection-only actions without progress. Bounded inspection must be followed by exactly one bounded operation batch...'
    }];
    continue;
  }
}
```

### Critical behavior

- **First inspection step (step 0):** `noProgressResponses` increments from 0 to 1. The model receives the warning message in `actionResults`, but the run does NOT terminate. The model gets another turn.
- **Second inspection step (step 1):** `noProgressResponses` increments from 1 to 2. The run terminates with `run:step_limit`.

The first step is **not** free of penalty. The model already receives an explicit warning. It simply ignores it.

---

## 3. Replay Evidence from Runs 77 / 79 / 81

### Run #81 (after prompt wording change)

**Step 0:**
- Model emits: `[{operation: 'listDirectory', args: {path: ''}}]`
- Runtime executes `listDirectory`. Result: directory entries returned.
- Runtime detects `isInspectionOnly = true`, `noProgressResponses = 1`.
- `actionResults` set to warning: `"You emitted inspection-only actions without progress..."`

**Step 1:**
- `previousActionResults` passed to model contains ONLY the no-progress warning. It does **not** contain the actual `listDirectory` result.
- Model emits: `[{operation: 'listDirectory', args: {path: ''}}]`
- Runtime detects `isInspectionOnly = true`, `noProgressResponses = 2`.
- Run terminates.

### Key observation: actionResults replacement

On the first inspection step, the successful `listDirectory` result is **replaced** by the no-progress warning. The model never sees the transition guidance `buildTransitionGuidance` because that function requires `actionResults` items with `.action` and `.result` fields — but those were overwritten.

Evidence from `buildTransitionGuidance` (`server.js:8288-8313`):

```javascript
const ops = actionResults.filter(item => item && item.action && item.action.operation);
if (ops.length === 0) return [];
```

When `actionResults = [{warning: 'model:no_progress', ...}]`, `ops` is empty, so `buildTransitionGuidance` returns `[]`. The prompt does NOT include:

> "Previous inspection is complete. You already have the directory entries in previousActionResults. Do not call listDirectory or readFile again for discovery."

Instead, the prompt includes:

> "You emitted inspection-only actions without progress..."

The model receives a **scolding**, not a **transition cue**.

---

## 4. Is "Inspection Complete" a First-Class State?

### Is inspection currently modeled as a phase?

**Yes.** `run.currentPhase` can be `'inspection'`. It is tracked in `runs.json`, events, and replay snapshots.

### Is inspection completion currently modeled?

**No.** There is no boolean, state machine node, or event type for "inspection is complete." The substrate knows:
1. The current phase is `inspection`
2. The model emitted inspection actions
3. Those actions succeeded
4. No progress was made

But it does not record a state transition from "inspection in progress" to "inspection complete." The phase stays `inspection` until the model emits mutation actions.

### What signal tells the model that inspection is complete?

**None, in practice.**

The signal that *should* tell the model is `buildTransitionGuidance`, but it is suppressed because `actionResults` is overwritten with the no-progress warning on the very first inspection step.

The generic workload profile guidance is present in the system prompt ("Phase 1 — DISCOVER: listDirectory the relevant directory ONCE"), but this is advisory and the model ignores it.

The no-progress warning tells the model it did something wrong, but it does not tell it "inspection is complete; here is your data; proceed to mutation."

### Is that signal prompt-only, runtime-only, or both?

The transition guidance is **prompt-only** and **never actually fires** in the observed failure mode because the action results are clobbered. The no-progress enforcement is **runtime-only**. There is no combined signal.

| Signal | Type | Fires in observed failure? | Content |
|--------|------|---------------------------|---------|
| Phase-gated prose | Prompt | Yes | "allowed operations are: listDirectory, readFile" |
| Workload profile guidance | Prompt | Yes | "DISCOVER... listDirectory ONCE" |
| Transition guidance | Prompt | **No** | Suppressed by no-progress warning |
| No-progress warning | Prompt + Runtime | Yes | "You emitted inspection-only actions without progress" |
| Phase advance (inspection → mutation) | Runtime | **No** | Only advances when model emits mutation ops |

---

## 5. Architectural Options Without Violating Invariants

### Option 1: Do nothing (current)
- Keep no-progress enforcement as the sole boundary
- Accept that weak models may fail
- **Invariant impact:** None
- **Analysis:** Already documented. The model ignores the warning.

### Option 2: Preserve actionResults for transition guidance
- Stop overwriting `actionResults` with the no-progress warning
- Instead, append the warning alongside the actual results
- This allows `buildTransitionGuidance` to fire on step 1
- **Invariant impact:** None — this is a data-flow fix, not a semantic change
- **Risk:** The model would receive both the directory entries AND the no-progress scolding. Unclear if this improves behavior.

### Option 3: Transition guidance on no-progress
- Modify `buildTransitionGuidance` to also fire when `previousActionResults` contains a no-progress event with successful prior inspection
- Or modify the no-progress warning message to explicitly include the transition text
- **Invariant impact:** None — prompt-layer change only
- **Risk:** The prompt becomes longer and more contradictory ("You did wrong" + "Now do this").

### Option 4: Make `inspection complete` a first-class state
- After the first successful inspection-only response, advance `run.currentPhase` to a new state (e.g., `inspection_complete`) or directly to `mutation`
- This would require a new phase or a change to phase transition rules
- **Invariant impact:** Violates Invariant #5 (Generic Phase Semantics) if a new phase like `inspection_complete` is added; violates Invariant #2 (Preserve Abstractions) if the generic phase system is made context-aware
- **Verdict:** Not viable under current invariants

### Option 5: Reduce no-progress grace from 1 to 0
- Terminate the run immediately on the first inspection-only response after the initial planning phase
- **Invariant impact:** Violates Invariant #3 (Bounded Execution) by tightening the operational envelope; also contradicts the concept of "bounded inspection must be followed by exactly one bounded operation batch" — the batch needs at least one step to exist
- **Verdict:** Not viable

### Option 6: Make transition guidance unconditional
- Always inject "Previous inspection is complete..." into the prompt when `currentPhase === 'inspection'` and `previousActionResults` is non-empty
- **Invariant impact:** None — purely prompt-layer
- **Risk:** False positive: the model may not have completed inspection yet (e.g., it read one file but needs another)

### Option 7: Distinguish first inspection from repeated inspection
- Do not flag `noProgressResponses` on the very first inspection step
- Only flag it on the second and subsequent inspection steps
- This gives the model a "free" first inspection and preserves the actual actionResults for transition guidance on step 1
- **Invariant impact:** Weakens Invariant #4 (Preserve Enforcement) slightly by making the first inspection step penalty-free
- **Verdict:** Borderline; would need invariant committee approval

---

## Summary

| Question | Answer |
|----------|--------|
| Is inspection currently modeled as a phase? | **Yes.** `run.currentPhase` can be `'inspection'`. |
| Is inspection completion currently modeled? | **No.** There is no state or event for "inspection complete." The phase stays `inspection` until the model emits mutation actions. |
| What signal tells the model inspection is complete? | **None, in practice.** The `buildTransitionGuidance` signal is suppressed because `actionResults` is overwritten with the no-progress warning on the first inspection step. |
| Is that signal prompt-only, runtime-only, or both? | **Neither fires.** The transition guidance (prompt) is suppressed. The no-progress warning (runtime + prompt) replaces it. Phase advance (runtime) never happens because the model does not emit mutation ops. |
| Why does the model repeat inspection? | Because: (1) `listDirectory` is valid in `inspection` phase; (2) phase does not block it; (3) the transition cue is suppressed; (4) the model receives only a no-progress warning, which it ignores; (5) the prompt still shows `listDirectory` as an allowed operation. |

---

## Root Cause

The substrate does not distinguish between:
- "The model is doing its first inspection" (expected, should be followed by transition guidance)
- "The model is repeating inspection" (violation, should be followed by no-progress enforcement)

Both paths hit the same code: `noProgressResponses += 1`, `actionResults = [warning]`. The first inspection step is treated as a no-progress event, which clobbers the action results and prevents the transition guidance from ever reaching the model.

The model therefore receives:
1. Step 0: succeeds at inspection, but gets scolded
2. Step 1: sees the scolding and the phase-gated prompt, but no "inspection is complete, here is your data, proceed" signal
3. Step 1: defaults to the only safe-looking action it knows: `listDirectory` again
4. Step 1: gets terminated

---

*All claims derived from direct code inspection of `server.js` lines 293–317, 319–366, 8288–8313, 8741–8784, 9043–9084, and replay snapshots from Runs 77, 79, and 81.*

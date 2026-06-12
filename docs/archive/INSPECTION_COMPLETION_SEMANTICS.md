# Inspection Completion Semantics

## Question

What is the smallest possible representation of successful inspection completion that does not violate `docs/ARCHITECTURE_INVARIANTS.md`?

And: is "inspection completed successfully" a state, an event, an evidence artifact, or something else?

---

## Background

From `docs/INSPECTION_TO_MUTATION_ANALYSIS.md`, the current failure mode is:

1. Model emits `listDirectory` on step 0 (first inspection).
2. Runtime detects `isInspectionOnly = true`, increments `noProgressResponses` to 1.
3. Runtime **overwrites** `actionResults` with the no-progress warning, destroying the actual `listDirectory` result.
4. On step 1, `buildTransitionGuidance` sees no items with `.action` and `.result`, so it returns `[]`.
5. The model receives a scolding but no "inspection is complete, here is your data" signal.
6. Model emits `listDirectory` again. Run terminates.

The root cause is not that the substrate lacks a concept of inspection completion. The root cause is that the substrate **destroys the evidence** of successful inspection by replacing it with a no-progress warning.

---

## Option A: Keep Current Model

**Description:** Continue overwriting `actionResults` with the no-progress warning on the first inspection step. Transition guidance is suppressed. Model receives only the penalty message.

### Invariant Impact

| Invariant | Impact |
|-----------|--------|
| #1 Generic Substrate | Preserved |
| #2 Preserve Abstractions | Preserved |
| #3 Bounded Execution | Preserved |
| #4 Preserve Enforcement | Preserved — but enforcement is the only signal |
| #5 Generic Phase Semantics | Preserved |
| #6 Embedded Planning | Preserved |
| #7 Runtime Authority | Preserved |
| #8 Workload Profiles | Preserved |

### Runtime Authority Impact

Runtime authority is intact. The runtime observes, judges, and enforces. No new concepts are introduced.

### Adaptation Impact

**High.** The model must learn to treat a no-progress warning as a signal to transition to mutation. This is counter-intuitive: the model is told "you did something wrong" rather than "you completed a phase, proceed." Weak models (gpt-4.1-mini) do not make this inference.

### Replay Impact

Replay snapshots show the no-progress warning in `previousActionResults` but omit the actual operation results. A replay consumer cannot reconstruct what the model discovered.

### Complexity

Zero. No code change.

---

## Option B: Preserve Action Results + Warning

**Description:** Instead of replacing `actionResults` with the warning, append the warning to the existing action results array.

```javascript
// Current (destructive):
actionResults = [{ warning: 'model:no_progress', message: '...' }];

// Option B (preservative):
actionResults = [
  ...actionResults,  // keep the actual listDirectory/readFile results
  { warning: 'model:no_progress', message: '...' }
];
```

This allows `buildTransitionGuidance` to see items with `.action` and `.result`, so it fires and injects:

> "Previous inspection is complete. You already have the directory entries in previousActionResults. Do not call listDirectory or readFile again for discovery."

### Invariant Impact

| Invariant | Impact |
|-----------|--------|
| #1 Generic Substrate | Preserved |
| #2 Preserve Abstractions | Preserved — no new abstraction introduced |
| #3 Bounded Execution | Preserved |
| #4 Preserve Enforcement | Preserved — the warning is still present; enforcement is unchanged |
| #5 Generic Phase Semantics | Preserved |
| #6 Embedded Planning | Preserved |
| #7 Runtime Authority | Preserved |
| #8 Workload Profiles | Preserved |

### Runtime Authority Impact

No change. The runtime still governs execution semantics. It simply preserves more evidence.

### Adaptation Impact

**Medium.** The model now receives:
1. The actual inspection results (directory entries)
2. The transition guidance ("inspection is complete...")
3. The no-progress warning ("you emitted inspection-only actions without progress...")

This is richer context. The model has both the data it needs AND the enforcement signal. Whether weak models can reconcile these two signals is an empirical question, but at least the necessary information is present.

### Replay Impact

**Positive.** Replay snapshots retain the actual operation results alongside the warning. Downstream consumers (trace tools, auditors, replay reconstructions) can see both what the model did and what the runtime said about it.

### Complexity

**Very low.** A one-line change in the no-progress handling block (server.js ~9078) from assignment to append.

---

## Option C: Introduce Inspection-Complete Evidence

**Description:** After the first successful inspection-only response, the runtime appends an explicit evidence artifact recording that inspection is complete.

```javascript
actionResults = [
  ...actionResults,
  {
    type: 'inspection_complete',
    step,
    operations: ['listDirectory'],
    message: 'Bounded inspection phase complete. Proceed to mutation.'
  }
];
```

This is distinct from the no-progress warning. It is a positive assertion of completion.

### Invariant Impact

| Invariant | Impact |
|-----------|--------|
| #1 Generic Substrate | Preserved |
| #2 Preserve Abstractions | **Risk** — introduces a new evidence type that is specific to the phase concept |
| #3 Bounded Execution | Preserved |
| #4 Preserve Enforcement | Preserved — enforcement unchanged; this is additive |
| #5 Generic Phase Semantics | Preserved |
| #6 Embedded Planning | Preserved |
| #7 Runtime Authority | Preserved |
| #8 Workload Profiles | Preserved |

### Runtime Authority Impact

The runtime now makes an explicit judgment: "inspection is complete." This is a new runtime assertion. It does not change what executes, but it adds a new semantic concept to the substrate.

### Adaptation Impact

**Medium.** The model sees an explicit "inspection_complete" record. This is a stronger signal than transition guidance prose. However, it introduces a new concept the model must learn. It also coexists with the no-progress warning, creating potential confusion ("You did wrong" + "You completed inspection" in the same step).

### Replay Impact

**Positive but heavier.** Replay snapshots gain a new evidence type. Downstream tools must understand `inspection_complete` semantics to interpret the run correctly.

### Complexity

**Low.** Requires adding a new evidence item generation block. But it introduces a new concept into the substrate vocabulary.

---

## Option D: Introduce Inspection-Complete State

**Description:** Add a persistent state variable to the run object that records whether inspection is complete.

```javascript
// After first successful inspection-only response:
run.inspectionComplete = true;
```

This state could be:
- Exposed in `runtimeEnvelope` to the model
- Used by runtime logic to change enforcement (e.g., reject inspection ops after `inspectionComplete`)
- Recorded in replay snapshots

### Invariant Impact

| Invariant | Impact |
|-----------|--------|
| #1 Generic Substrate | Preserved |
| #2 Preserve Abstractions | **Collapses** — adds a state variable that is specific to one phase progression pattern |
| #3 Bounded Execution | Preserved |
| #4 Preserve Enforcement | **Risk** — if used to change enforcement, it makes enforcement state-dependent in a new way |
| #5 Generic Phase Semantics | **Borderline** — `inspectionComplete` is not a new phase name, but it is a new state dimension tied to a specific phase |
| #6 Embedded Planning | Preserved |
| #7 Runtime Authority | Preserved |
| #8 Workload Profiles | Preserved |

### Runtime Authority Impact

**Risk of overreach.** If the runtime uses `inspectionComplete` to reject `listDirectory` in later steps, it is making a judgment about the model's intent ("you already inspected, so you may not inspect again") that goes beyond the current generic no-progress rule. This is closer to hardcoding a phase script than governing generic operations.

If the state is purely observational (not used for enforcement), it is harmless but redundant.

### Adaptation Impact

**High if exposed; medium if hidden.** If exposed in `runtimeEnvelope`, the model must reason about a new boolean state. If hidden, the model gains nothing.

### Replay Impact

**Positive but heavy.** Adds a new state field to runs and replay snapshots. Tooling must be updated to display and interpret it.

### Complexity

**Medium.** Requires schema change to `run` object, persistence update, replay snapshot update, and potentially prompt exposure logic.

---

## Comparative Summary

| Criterion | A Keep Current | B Preserve Results | C Introduce Evidence | D Introduce State |
|-----------|---------------|---------------------|---------------------|------------------|
| Invariant #2 (Abstractions) | Preserved | Preserved | Minor risk | Collapses |
| Invariant #4 (Enforcement) | Preserved | Preserved | Preserved | Risk if used for enforcement |
| Invariant #5 (Generic Phases) | Preserved | Preserved | Preserved | Borderline |
| Runtime authority | Preserved | Preserved | Preserved | Risk of overreach |
| Adaptation impact | High | Medium | Medium | High |
| Replay impact | Destructive | Richer | New evidence type | New state field |
| Implementation complexity | Zero | Very low | Low | Medium |
| New substrate concepts | None | None | `inspection_complete` evidence | `inspectionComplete` state |

---

## Meta-Question: What is "inspection completed successfully"?

### It is not a state

A state describes the current condition of a system (e.g., `currentPhase = 'inspection'`). "Inspection completed" describes a past transition that has already occurred. Making it a persistent boolean (Option D) gives it state-like properties, but it is semantically a historical fact, not a current condition.

### It is not an event

An event is a discrete occurrence at a point in time (e.g., `execution.phase_transition`). While one could define an `inspection.completed` event, "completion" is not a discrete instant — it is a **judgment** the runtime makes about a set of already-executed operations. The event would be a derived record, not a primary occurrence.

### It is an evidence artifact

The substrate already contains all the evidence needed to determine whether inspection completed successfully:
- The operation history (`workspaceOperations` in replay)
- The action results (`previousActionResults` in the prompt)
- The phase state (`currentPhase`)

"Inspection completed successfully" is a **derived property** of this evidence. It means: "The model emitted inspection-only operations, they all succeeded, and the runtime has determined that bounded inspection is satisfied."

### More precisely: it is a prompt-layer signal derived from preserved evidence

The runtime doesn't need a new representation. It needs to **stop destroying the existing representation**. The successful `listDirectory` result IS the evidence. The transition guidance IS the signal. Both already exist. The substrate just needs to preserve them.

Therefore, the smallest possible representation is **the preservation of what is already there** (Option B).

---

## Recommendation

**Adopt Option B: Preserve action results + warning.**

This is the smallest possible representation because it introduces **zero new substrate concepts**. It changes one assignment to an append, allowing the existing `buildTransitionGuidance` to fire using existing evidence.

Options C and D both introduce new concepts (`inspection_complete` evidence type, `inspectionComplete` state variable) that duplicate information already present in the operation history. The additional explicitness does not add runtime value proportionate to the complexity.

Option A is the baseline but fails weak models because it suppresses the transition signal.

### Why B does not violate invariants

- **Invariant #2 (Preserve Abstractions):** No new abstraction. Just stops destroying existing evidence.
- **Invariant #4 (Preserve Enforcement):** The no-progress warning is still present. Enforcement is unchanged.
- **Invariant #7 (Runtime Authority):** The runtime still governs. It simply communicates more completely.
- **Invariant #5 (Generic Phase Semantics):** No new phases or phase-like states.

---

*All claims derived from evaluation of `docs/ARCHITECTURE_INVARIANTS.md` against the four options, and from the evidence in `docs/INSPECTION_TO_MUTATION_ANALYSIS.md`.*

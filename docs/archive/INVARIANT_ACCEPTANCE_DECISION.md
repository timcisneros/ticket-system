# Invariant Acceptance Decision

## Burden of Proof

**Promote Now** requires all three:
1. Direct regression — evidence that violating the principle causes a measurable failure
2. Direct fix — a change that directly enacts the principle
3. Direct improvement — the fix measurably improves outcomes

**Hold As Principle** requires:
1. Strong architectural reasoning — the principle is structurally sound
2. Insufficient empirical validation — the three Promote Now criteria are not all met

**Reject** requires:
1. The principle is unsound, or
2. It is already fully covered by existing invariants

---

## Candidate 1: Evidence Preservation

### Proposed wording

> **Evidence Preservation** — Do not destroy runtime-generated evidence when injecting enforcement feedback. Operation results, state observations, and action outcomes must remain accessible to downstream consumers.

### Direct regression

**Yes.**

Runs #77, #79, and #81 exhibit identical failure chains:
- Step 0: Model emits `listDirectory` (valid inspection action)
- Runtime executes `listDirectory`, generates directory entries as evidence
- Runtime detects `isInspectionOnly = true`, increments `noProgressResponses` to 1
- Runtime **overwrites** `actionResults` with the no-progress warning
- Step 1: `buildTransitionGuidance` sees no items with `.action` and `.result`, returns `[]`
- Model receives no "inspection is complete" signal, only a scolding
- Model repeats `listDirectory`
- Run terminates

The regression is mechanical: the `actionResults = [{warning}]` assignment on line 9078 destroyed the evidence that `buildTransitionGuidance` needed to fire.

### Direct fix

**Yes.**

Option B changed one assignment to an append on line 9078:

```javascript
// Before (regression):
actionResults = [{
  warning: 'model:no_progress',
  message: '...'
}];

// After (fix):
actionResults.push({
  warning: 'model:no_progress',
  message: '...'
});
```

This is a direct enactment of the principle. No new concepts, no new runtime semantics, no new abstraction.

### Direct improvement

**Yes.**

Run #82 (after fix) vs. Runs 77/79/81 (before fix):

| Outcome | Before | After |
|---------|--------|-------|
| terminalStatus | `failed` | `completed` |
| Step 1 action | `listDirectory` (repeat) | `createFolder`, `createFolder` (mutation) |
| Transition guidance | Absent (suppressed) | Present ("Previous inspection is complete...") |
| Inspection evidence | Destroyed | Preserved |

The improvement is binary: identical model, identical ticket, identical enforcement, identical limits. The only variable is evidence preservation. The outcome flips from fail to complete.

### Verdict

**Promote Now.**

All three criteria are met with direct causal evidence.

---

## Candidate 2: Authority Layer Separation

### Proposed wording

> **Authority Layer Separation** — Primitive capability and operational authority are distinct layers. The runtime must not conflate them in data models, prompts, or enforcement logic.

### Direct regression

**Partial.**

The prompt contradiction (line 8368 before fix) told the model:

> "Use only the operations listed in runtimeEnvelope.allowedOperations."

while the prose immediately below said:

> "Your current execution phase is runtimeEnvelope.currentPhase. In this phase, the allowed operations are: listDirectory, readFile."

This was a bug. It gave the model two contradictory signals. However, it was not the **primary** cause of the Ticket #59 failure.

Evidence: Run #81 was executed **after** the prompt wording fix ("Use only the operations appropriate to your current execution phase...") but **before** Option B (evidence preservation). Run #81 still failed with the identical pattern: step 0 `listDirectory`, step 1 `listDirectory`, then `run:step_limit`.

Therefore, the prompt contradiction contributed to model confusion but was not sufficient to cause the failure on its own. The direct regression is weaker than for Evidence Preservation.

### Direct fix

**Yes, but orthogonal to the observed improvement.**

The prompt wording fix (changing line 8368) directly enacted the principle. The envelope field (`allowedOperations`) is no longer named as the operational authority in the prompt. The operational authority is now explicitly the phase-gated catalog.

However, this fix did not change the outcome. Run #81 (after prompt fix, before Option B) still failed.

### Direct improvement

**No.**

There is no run showing that the prompt wording fix alone improved outcomes. The improvement came from Option B (Evidence Preservation), not from the prompt fix.

| Run | Prompt wording | Evidence preservation | Outcome |
|-----|---------------|----------------------|---------|
| 77 | Old (contradiction) | Destroyed | Failed |
| 79 | Old (contradiction) | Destroyed | Failed |
| 81 | New (aligned) | Destroyed | **Failed** |
| 82 | New (aligned) | Preserved | **Completed** |

The variable that explains the outcome is Evidence Preservation, not Authority Layer Separation. The prompt wording change is a good practice, but it did not cross the causal threshold.

### Strong architectural reasoning

**Yes.**

- `docs/ALLOWED_OPERATIONS_AUTHORITY.md` demonstrated that conflating primitive and operational authority collapses abstraction layers.
- `docs/PHASE_GATED_ENVELOPE_ANALYSIS.md` showed the envelope is designed to carry primitive capability, not operational restrictions.
- The replay snapshot structure confirms the separation: `primitiveContract.allowedOperations` (full catalog) vs. prompt prose (phase subset).
- The principle protects against a specific class of bug: naming a primitive-capability field as if it were the operational authority.

### Verdict

**Hold As Principle.**

Strong architectural reasoning, but **insufficient empirical validation** for the Promote Now threshold. The prompt wording fix did not produce measurable improvement on its own. The principle is sound and should be documented, but it has not been causally validated through a regression-fix-improvement chain.

---

## Comparative Threshold Analysis

| Criterion | Evidence Preservation | Authority Layer Separation |
|-----------|----------------------|---------------------------|
| **Direct regression** | Yes (Runs 77/79/81) | Partial (contributed, not primary cause) |
| **Direct fix** | Yes (Option B, line 9078) | Yes (prompt wording, line 8368) |
| **Direct improvement** | **Yes** (Run #82 completed) | **No** (Run #81 still failed after fix) |
| **Burden met?** | **All three** | **Two of three; improvement missing** |
| **Verdict** | **Promote Now** | **Hold As Principle** |

### Key distinction

Evidence Preservation has a **mechanical causal chain**:
1. Evidence destroyed → transition guidance suppressed → model lacks data → model repeats inspection → failure
2. Evidence preserved → transition guidance fires → model has data → model transitions to mutation → success

Authority Layer Separation has a **logical causal chain**:
1. Prompt contradiction → model confused about authority → model may choose wrong actions
2. Prompt aligned → model knows correct authority → model still needs evidence to act on it

The second chain is real, but it was **not the binding constraint** in the observed failure. The model's failure was not caused by not knowing the correct authority; it was caused by not having the evidence to act on that authority.

---

## Final Decision Matrix

| Candidate | Classification | Rationale |
|-----------|---------------|-----------|
| **Evidence Preservation** | **Promote Now** | Direct regression, direct fix, direct improvement. Causal chain is mechanical and validated. |
| **Authority Layer Separation** | **Hold As Principle** | Strong architectural reasoning, sound abstraction boundary, but the prompt fix alone did not produce measurable improvement. Not yet causally validated at the Promote Now threshold. |

---

## Documentation Recommendation

**For ARCHITECTURE_INVARIANTS.md:**

Add **Evidence Preservation** as a new invariant.

Add **Authority Layer Separation** as a note or subsection under **Invariant #2 (Preserve Abstractions)**, not as a standalone invariant. It is an explicit extension of the abstraction-preservation principle, not an independent structural invariant.

**For docs/ directory:**

Keep `docs/SUBSTRATE_DESIGN_PRINCIPLES.md` as the comprehensive analysis. Add a note in that document reflecting this decision: Authority Layer Separation is held as a principle pending further empirical validation.

---

*All claims derived from direct replay comparison (Runs 77, 79, 81, 82) and causal reasoning about which variable explains the outcome change.*

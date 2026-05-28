# Substrate Design Principles

## Candidate Principles Discovered

Through the phase-authority investigation (Runs 77–82, Tickets 59, Option B implementation, and evidence preservation analysis), the following candidate principles emerged. Each is evaluated against the evidence, counterexamples, and existing invariants.

---

## Principle 1: Append Evidence, Do Not Replace Evidence

### Statement
When the runtime generates evidence (operation results, action outcomes, state observations), that evidence must be appended to the feedback loop rather than overwritten by enforcement warnings or penalty messages.

### Evidence Supporting
- **Run #77, #79, #81:** `actionResults` was overwritten with `model:no_progress` warning on the first inspection step. The actual `listDirectory` result (directory entries) was destroyed. The model received a scolding but no transition cue.
- **Run #82 (Option B):** Changed `actionResults = [{warning}]` to `actionResults.push({warning})`. The `listDirectory` result was preserved. `buildTransitionGuidance` saw `.action` and `.result` fields and fired. The model received: "Previous inspection is complete. You already have the directory entries..." The model transitioned to `createFolder` + `createFolder` on step 1. The run completed.
- **Other surfaces:** Replay snapshots (`appendRunReplaySnapshotItem`), event streams (`appendEvent`), operation history (`histories.push`), and logs (`appendRunLog`) are all append-only. None exhibit evidence destruction.

### Counterexamples
- The decision matrix analysis revealed that action limit, mutating action limit, and phase violation checks occur **before** execution, where `actionResults` is already empty. In those cases, there is no evidence to preserve mechanically. However, the **event stream** still captures the proposed actions in all three cases. The evidence is not lost from the substrate; it is only lost from the prompt feedback loop.

### Confidence Level
**Very high.** Direct causal evidence. Option B was a single-line change with a binary outcome: fail (evidence destroyed) vs. complete (evidence preserved).

### Verdict
**Should become an invariant.** This is a structural property of the substrate's feedback loop. It is not a design preference; it is a correctness requirement for any runtime that uses per-step feedback to guide model adaptation.

---

## Principle 2: Runtime Authority Over Model Authority

### Statement
The runtime governs execution semantics. The model proposes bounded operations; the runtime executes, verifies, and enforces limits. The runtime does not delegate structural verification back to the model. The model does not override runtime authority.

### Evidence Supporting
- **ARCHITECTURE_INVARIANTS.md #7** explicitly states this.
- **PHASE_AUTHORITY_OPTIONS.md:** Option B (response validation) was recommended because it "best aligns with Runtime Authority." The runtime validates each proposed operation against the current phase before execution.
- **PROMPT_AUTHORITY_ALIGNMENT.md:** The prompt contradiction was identified as a bug precisely because it told the model to trust `runtimeEnvelope.allowedOperations` (a data field) as the operational authority rather than the runtime's phase-gated enforcement.

### Counterexamples
- The current prompt (before the wording fix) explicitly instructed the model: "Use only the operations listed in runtimeEnvelope.allowedOperations." This delegated authority naming to the envelope JSON blob. When the blob contained the full catalog, the model effectively had permission to use any primitive operation regardless of phase.
- The model did not respect this authority either (it repeated `listDirectory` despite the phase-gated prose), showing that even when authority is delegated to the prompt, the model may not comply.

### Confidence Level
**High.** Already an explicit invariant. The investigation reinforced it by showing what happens when prompt wording contradicts it.

### Verdict
**Already an invariant** (#7 in ARCHITECTURE_INVARIANTS.md). No change needed.

---

## Principle 3: Generic Substrate Semantics

### Statement
Ticket-specific behavior must not become runtime semantics. The runtime executes generic operations. A particular ticket's expected sequence belongs in the model prompt or workload profile, not in hardcoded runtime branching.

### Evidence Supporting
- **ARCHITECTURE_INVARIANTS.md #1** explicitly states this.
- The entire investigation resisted implementing automatic `inspection → mutation` advancement, `requestMoreInspection`, or ticket-specific phase scripts. These were all identified as violations.
- **INSPECTION_COMPLETION_SEMANTICS.md:** Option D (introduce `inspectionComplete` state) was rejected because it would bake a specific phase progression pattern into the run schema.

### Counterexamples
- **WORKLOAD_PROFILES.md** defines profile-specific guidance (e.g., "listDirectory ONCE" for refactor). This looks like ticket-specific behavior, but it is explicitly categorized as "prompt guidance" not "runtime semantics." The runtime does not enforce profile-specific rules; it only injects them into the prompt.
- **Counterexample resolved:** The profile system does not violate the invariant because the runtime still executes generic operations. The profile is an example, not a substrate rule (Invariant #8).

### Confidence Level
**High.** Core invariant, repeatedly tested during the investigation.

### Verdict
**Already an invariant** (#1 in ARCHITECTURE_INVARIANTS.md). No change needed.

---

## Principle 4: Preserve Abstractions

### Statement
Fix failing behavior without collapsing reusable abstractions. If a model fails a task, strengthen guidance or adjust the prompt. Do not replace a generic phase system with a task-specific script or special-case handler in the execution loop.

### Evidence Supporting
- **ARCHITECTURE_INVARIANTS.md #2** explicitly states this.
- **PHASE_GATED_ENVELOPE_ANALYSIS.md:** Option A (primitive authority contract) preserves the abstraction layers: primitive contract → operational context (phase) → prompt text. Option B (phase-gated envelope) would collapse the primitive contract and operational restriction into one field.
- **PHASE_AUTHORITY_OPTIONS.md:** Option C (tool catalog gating) was rated as collapsing abstractions because the same field (`allowedOperations`) would mean "primitive capability" on step 0 and "operational restriction" on step 2.
- **INSPECTION_COMPLETION_SEMANTICS.md:** Option D (new state variable) was rejected because it adds a state dimension tied to a specific phase progression pattern.

### Counterexamples
- The pre-Option B no-progress handling was a minor abstraction leak: it replaced a structured evidence array with a single warning object. This collapsed the evidence abstraction into the enforcement abstraction.

### Confidence Level
**High.** Core invariant, central to the architecture.

### Verdict
**Already an invariant** (#2 in ARCHITECTURE_INVARIANTS.md). No change needed.

---

## Principle 5: Bounded Execution

### Statement
Do not raise limits to compensate for poor workload design. `maxExecutionSteps`, `maxListDirectoryPerRun`, `maxMutatingActionsPerResponse`, and other limits define the operational envelope. If a task exceeds the envelope, redesign the task or the model plan. Do not widen the envelope to make a benchmark pass.

### Evidence Supporting
- **ARCHITECTURE_INVARIANTS.md #3** explicitly states this.
- The investigation repeatedly rejected proposals to raise step limits or disable no-progress enforcement.
- **INSPECTION_COMPLETION_SEMANTICS.md:** Option 5 (reduce no-progress grace from 1 to 0) was rejected because it would tighten the operational envelope in a way that contradicts the bounded inspection → mutation pattern.

### Counterexamples
- None found. The investigation upheld this invariant consistently.

### Confidence Level
**High.** Core invariant, never challenged.

### Verdict
**Already an invariant** (#3 in ARCHITECTURE_INVARIANTS.md). No change needed.

---

## Principle 6: Phase-Gated Adaptation

### Statement
The model adapts its behavior based on the current execution phase. Phase-appropriate operation catalogs, transition guidance, and workload profile guidance are injected into the prompt to guide the model toward correct phase transitions.

### Evidence Supporting
- **Run #82:** The model successfully transitioned from `listDirectory` (inspection) to `createFolder` + `createFolder` (mutation) after receiving phase-gated guidance and preserved transition guidance.
- **PHASE_GATED_ACTION_CATALOG.md:** Documents the phase catalog design and its injection into the prompt.
- **WORKLOAD_PROFILES.md:** Profiles inject phase-specific guidance (e.g., "Phase 1 — DISCOVER: listDirectory ONCE").

### Counterexamples
- **Runs 77, 79, 81:** The model ignored phase-gated guidance and repeated `listDirectory` in the inspection phase. This shows phase-gated adaptation is not sufficient on its own when contradictory signals exist or when evidence is destroyed.
- **Run #78:** Also failed with the same pattern, showing the failure is systematic for this model/ticket combination under the old prompt wording.
- **PROMPT_AUTHORITY_ALIGNMENT_RESULTS.md:** The prompt wording change alone (removing the contradiction) did not fix the behavior; only evidence preservation (Option B) did.

### Confidence Level
**Medium.** Phase-gated adaptation works when the signal is clear and evidence is preserved, but it is not a strong enough mechanism to guarantee model compliance. It is a prompt-layer technique, not a structural substrate property.

### Verdict
**Design heuristic, not invariant.** The phase system is a useful abstraction, but the model's compliance with it is observational, not guaranteed. Making it an invariant would overstate its reliability.

---

## Principle 7: Primitive Authority ≠ Phase Authority

### Statement
`runtimeEnvelope.allowedOperations` expresses the agent's primitive capability contract (the full toolbox). Phase-gated operation subsets express operational authority (what is appropriate for the current phase). These are distinct layers and must not be conflated in the prompt or the data model.

### Evidence Supporting
- **ALLOWED_OPERATIONS_AUTHORITY.md:** Comprehensive analysis showing `runtimeEnvelope.allowedOperations` is the primitive contract, while `phaseGatedOps` is the operational restriction. The prompt contradiction occurred because the system prompt told the model to trust the primitive contract as the operational authority.
- **PHASE_GATED_ENVELOPE_ANALYSIS.md:** `buildRuntimeEnvelope` constructs the primitive catalog. `buildAgentPrompt` applies phase gating on top of it. The separation of concerns is intentional and documented.
- **Replay evidence:** `primitiveContract.allowedOperations` in replay snapshots always shows the full catalog, while the prompt prose shows the phase subset. This confirms the layer separation in the data model.

### Counterexamples
- The prompt wording before the fix ("Use only the operations listed in runtimeEnvelope.allowedOperations") directly conflated the two authorities. This was identified as a bug.
- If the envelope were phase-gated (Option B in the envelope analysis), the two authorities would collapse into one field, violating this principle.

### Confidence Level
**High.** This is an architectural definition that was tested through multiple analysis documents. The fix (changing the prompt wording) validated the principle empirically by removing the contradiction.

### Verdict
**Validated architectural principle; not yet invariant-level.**

The principle is structurally sound and was validated by removing the prompt contradiction. However, the prompt wording fix alone did not produce measurable outcome improvement (Run #81 still failed after the fix). The binding constraint in the observed failure was Evidence Preservation, not Authority Layer Separation.

**Status:** Hold as principle. Awaiting causal validation through a direct regression-fix-improvement chain before promotion to invariant.

---

## Summary Table

| Principle | Evidence | Counterexamples | Confidence | Verdict |
|-----------|----------|-----------------|------------|---------|
| 1. Evidence Preservation | Run #82 completed after Option B | None | Very High | **Promoted to invariant #9** |
| 2. Runtime authority | Invariant #7; Option B recommended | Pre-fix prompt wording | High | **Already invariant** |
| 3. Generic substrate | Invariant #1; rejected auto-advance | Workload profiles (resolved) | High | **Already invariant** |
| 4. Preserve abstractions | Invariant #2; rejected envelope collapse | Pre-Option B replacement | High | **Already invariant** |
| 5. Bounded execution | Invariant #3; upheld throughout | None | High | **Already invariant** |
| 6. Phase-gated adaptation | Run #82 success | Runs 77/79/81 ignored it | Medium | **Design heuristic** |
| 7. Primitive ≠ phase authority | Prompt fix validated it | Pre-fix prompt conflation | High | **Validated principle; held pending causal validation** |

---

## Promotion Status

| Principle | ARCHITECTURE_INVARIANTS.md Status | Date |
|-----------|-----------------------------------|------|
| Evidence Preservation | **Added as Invariant #9** | 2026-05-28 |
| Authority Layer Separation | **Held as principle** — `docs/SUBSTRATE_DESIGN_PRINCIPLES.md` | 2026-05-28 |

---

*All claims derived from the evidence collected across 13 documents produced during the phase-authority investigation, spanning 6 runs (77–82), direct code inspection of `server.js`, and static analysis of test files.*

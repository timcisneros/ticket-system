# Allowed Operations Authority

## Question

What is the correct architectural role of `runtimeEnvelope.allowedOperations`?

- **A.** Primitive authority contract — remains full catalog; phase gating stays prompt-only
- **B.** Phase authority contract — becomes phase-gated; prompt and envelope align
- **C.** Something else

---

## Evidence Sources

- `docs/ARCHITECTURE_INVARIANTS.md` — substrate invariants
- `docs/archive/PHASE_GATED_ENVELOPE_ANALYSIS.md` — code paths, downstream consumers, risks
- Direct inspection of `server.js` `buildRuntimeEnvelope`, `buildAgentPrompt`, replay snapshot shapes, and test assertions

---

## 1. Which interpretation best matches the invariants?

### Invariant #1: Generic Substrate Semantics

> "Ticket-specific behavior must not become runtime semantics."

- **A (Primitive):** The envelope carries the generic agent capability set (`AGENT_DIRECT_OPERATIONS` filtered only by agent config). It knows nothing about ticket class or expected sequences. **Matches.**
- **B (Phase-gated):** The envelope would embed phase state, which is generic (not ticket-specific), but it still makes the envelope structure dependent on execution progress rather than static capability. **Neutral match.**
- **C (Profile-aware primitive):** Would make the envelope dependent on heuristic workload-profile detection. This turns profile examples into substrate rules. **Violates.**

**Verdict:** A is the only interpretation that keeps the envelope free of ticket-derived or operational-context-derived state.

### Invariant #2: Preserve Abstractions

> "Fix failing behavior without collapsing reusable abstractions."

- **A:** `runtimeEnvelope` remains a reusable capability manifest. The phase system operates as a separate prompt-layer filter. The abstraction layers are: primitive contract → operational context (phase) → prompt text. **Preserves abstraction.**
- **B:** Collapses the primitive contract and the operational restriction into one field. The same field now means "what this agent can do" on step 0 and "what this agent may do right now" on step 2. Downstream consumers (replay tools, API clients, test fixtures) must now know phase semantics to interpret the field correctly. **Collapses abstraction.**
- **C (Add new field):** Would preserve the existing field's role while adding context. But the question asks about the role of the *existing* field, not a new one.

**Verdict:** A preserves the abstraction; B collapses it.

### Invariant #7: Runtime Authority

> "Runtime governs execution semantics. The model proposes bounded operations; the runtime executes, verifies, and enforces limits."

- **A:** The envelope tells the model its primitive toolbox. The runtime still independently validates every proposed operation against both the primitive contract AND the current phase rules. Runtime authority is complete and final. **Matches.**
- **B:** The runtime pre-filters the model's view of the toolbox. Runtime still validates, but it has delegated the "what may I propose?" question to the envelope. The model's proposal space is now constrained by the envelope rather than purely by runtime enforcement. This is not a violation per se, but it changes where the authority boundary is drawn. **Weakens the authority invariant conceptually.**

**Verdict:** A keeps runtime authority centralized; B distributes it into the envelope.

### Invariant #8: Workload Profiles Are Examples, Not Substrate Rules

> "Profiles may specialize guidance... Runtime semantics remain generic."

- **A:** The envelope ignores profiles. Profile guidance is injected only into the prompt. **Matches.**
- **B:** Would also ignore profiles (unless combined with profile gating). **Matches,** but less cleanly because phase gating itself is an operational context.
- **C (Profile-aware):** Would violate directly.

**Verdict:** A and B both avoid profile contamination, but A is more consistent because the envelope is completely free of operational context.

**Overall invariant match: A > B > C(profile).**

---

## 2. Which interpretation best matches replay semantics?

Replay snapshots store `runtimeEnvelope` as part of the frozen execution context. The envelope also appears in `run.replaySnapshot` and in the `run-detail` EJS template.

### Stability

- **A:** `allowedOperations` is identical across every step of a run. A replay consumer can read it once and know "this agent had these primitives available for the entire run." **Stable and interpretable.**
- **B:** `allowedOperations` varies step-by-step. A replay consumer looking at the final step would see only mutation-phase operations and might incorrectly conclude the agent never had `listDirectory` capability. **Unstable and misleading.**

### Separation of concerns

- **A:** The replay already stores `primitiveContract.allowedOperations` (stable full catalog) separately from `runtimeEnvelope.allowedOperations`. With A, both fields carry the same stable catalog, which is redundant but unambiguous.
- **B:** Would create a divergence: `primitiveContract` says the agent CAN listDirectory, but `runtimeEnvelope` says it MAY NOT. This is a new kind of ambiguity in the replay format.

### UI rendering

`views/run-detail.ejs` renders authority from `ac.authority.allowedOperations`, which is sourced from `primitiveContract`, not `runtimeEnvelope`. This means:
- **A:** UI and replay agree. **Consistent.**
- **B:** UI would still show the full catalog (from primitiveContract), but the replay envelope would show subsets. **Inconsistent unless UI is also changed.**

**Replay semantics match: A > B.**

---

## 3. Which interpretation best matches future semantic work primitives?

"Semantic work primitives" refers to the base operations (`listDirectory`, `readFile`, `writeFile`, `createFolder`, `renamePath`, `deletePath`, plus workflow/handoff extensions) as the foundational capability vocabulary of the substrate.

Future operational context layers may include:

1. **Capability elevation:** An operator temporarily grants `deletePath` to an agent that normally lacks it. The primitive contract should remain stable; the elevation is a transient overlay.
2. **Allocation scoping:** An allocated subtask might restrict operations to a subset of the workspace. The primitive contract stays full; the scope is a separate restriction.
3. **Multi-agent delegation:** A planner agent has `createHandoffTask`; an executor agent lacks it. Each agent's primitive contract is static; operational context varies by task.
4. **Audit and compliance:** A downstream auditor needs to know "what was this agent fundamentally capable of?" independently of "what phase was it in at step 3?"

- **A:** Provides a clean primitive layer that future operational context can intersect with. `primitiveContract` or `allowedOperations` answers "what can it do?"; `currentPhase` or future fields answer "when may it do it?"
- **B:** Collapses these layers. Any future operational context would need to either override the envelope (creating precedence rules) or be ignored by the envelope (making the envelope unreliable).
- **C (new field):** Could also work, but the question is about the role of `allowedOperations` specifically. Its role should remain primitive.

**Future semantic work match: A > B.**

---

## 4. The prompt contradiction

The current prompt contains this line:

> "Use only the operations listed in runtimeEnvelope.allowedOperations."

This directly contradicts the phase-gated prose that follows. In Runs #77 and #79, the model repeated `listDirectory` in the inspection phase. The model may be following the JSON blob authority rather than the prose restriction.

**This is a prompt bug, not an envelope bug.**

The fix does not require redefining `runtimeEnvelope.allowedOperations`. It requires changing the prompt text from:

> "Use only the operations listed in runtimeEnvelope.allowedOperations."

to something like:

> "Use only the operations appropriate to your current execution phase, as listed in the phase guidance above."

This fixes the contradiction while preserving the envelope's primitive role.

---

## 5. Option C: Is there a viable alternative?

One "something else" interpretation is:

> `runtimeEnvelope.allowedOperations` should become the **workload-profile** operation subset (e.g., refactor excludes `writeFile`), while phase gating stays prompt-only.

This interpretation was evaluated in `PHASE_GATED_ENVELOPE_ANALYSIS.md` and rejected because:
1. `WORKLOAD_PROFILES.allowedOperations` is defined in code but **never consumed** in `server.js`.
2. Profile detection is heuristic (keyword matching), so baking it into the primitive contract violates Invariant #1 and Invariant #8.
3. It would still leave the prompt contradiction unaddressed.

Another "something else" interpretation is:

> Keep `allowedOperations` as primitive (A), but add `runtimeEnvelope.phaseAllowedOperations` for prompt alignment.

This is architecturally sound, but it is an **extension** of Option A, not a replacement. The role of the existing field remains primitive.

**No viable Option C redefines the field's role better than Option A.**

---

## Recommendation

**Adopt Option A: Primitive authority contract.**

`runtimeEnvelope.allowedOperations` should remain the full agent-config-filtered catalog. Its architectural role is to declare the primitive operations available to this agent for this run, independent of phase, workload profile, or step.

Phase gating, workload-profile restrictions, and any future operational context should remain layers **on top of** the primitive contract, not replacements for it. The prompt contradiction should be fixed in the prompt text, not by redefining the envelope.

| Criterion | Winner | Rationale |
|-----------|--------|-----------|
| Invariants | **A** | Preserves abstractions; keeps runtime authority centralized; avoids profile contamination |
| Replay semantics | **A** | Stable across steps; avoids ambiguity with `primitiveContract` |
| Future semantic work | **A** | Provides clean primitive layer for elevation, scoping, delegation, and audit |
| Prompt alignment | Fix prompt text, not envelope | The contradiction is a prose bug, not a data-structure bug |

---

*All claims above are derived from direct code inspection, static analysis of test files, and evaluation against the architecture invariants. No model synthesis was used for factual assertions.*

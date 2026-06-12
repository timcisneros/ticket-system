# Phase Authority Options

## Context

The substrate exposes a four-phase operational model (`planning → inspection → mutation → verification → terminalization`) and a phase-gated operation catalog. The current implementation puts phase restrictions in the **prompt only** (advisory). The runtime enforces no-progress limits after the fact. The model (gpt-4.1-mini) ignores the advisory guidance and repeats inspection without mutation.

This document evaluates three architectural approaches to phase authority.

---

## Option A: Advisory Phase Gating (Current)

**How it works:** The prompt includes prose like "Your current execution phase is inspection. In this phase, the allowed operations are: listDirectory, readFile." The runtime does not validate operations against the current phase before execution. Enforcement is post-hoc via no-progress detection.

### Invariant Impact

| Invariant | Impact | Rationale |
|-----------|--------|-----------|
| #1 Generic Substrate | Preserved | Phase is generic, not ticket-specific |
| #2 Preserve Abstractions | Preserved | Phase filter is a prompt-layer abstraction |
| #3 Bounded Execution | Preserved | Limits unchanged |
| #4 Preserve Enforcement | Weak | Enforcement is indirect (no-progress), not phase-specific |
| #5 Generic Phase Semantics | Preserved | Phases remain generic |
| #6 Embedded Planning | Preserved | Model sees full catalog, can plan freely |
| #7 Runtime Authority | Preserved but deferred | Runtime validates via no-progress, not phase gate |
| #8 Workload Profiles | Preserved | Profile guidance stays in prompt |

### Weak Model Performance

**Poor.** Weak models ignore prose guidance. They emit `listDirectory` in the inspection phase (valid) repeatedly (no-progress violation). They never reach mutation. They fail on step limits. The advisory signal is noise they filter out.

Evidence: Runs #77, #79, #81 — gpt-4.1-mini repeated `listDirectory` twice in inspection phase despite the phase-gated prompt and transition guidance.

### Strong Model Performance

**Good.** Strong models read the guidance, plan a single inspection step, transition to mutation, and succeed. The advisory layer is sufficient for compliant models.

### Adaptation Impact

**Low.** Models must learn to follow prose guidance. No new runtime concepts. No new failure modes. Adaptation is purely behavioral (model-side).

### Operational Substrate Alignment

**High.** The substrate remains generic. Runtime validation is primitive-only (`AGENT_DIRECT_OPERATIONS`). Phase is operational context, not substrate rule.

### Semantic Work Primitive Alignment

**High.** The model always sees its full primitive toolbox in `runtimeEnvelope.allowedOperations`. Primitives are never hidden.

---

## Option B: Response Validation

**How it works:** Before executing any model-proposed action, the runtime validates each operation against `PHASE_OPERATIONS[currentPhase]`. Phase-inappropriate operations are rejected with a deterministic error (e.g., `"renamePath is not allowed in the inspection phase. Allowed: listDirectory, readFile"`). The model receives this rejection in `previousActionResults` and can adapt in the next step.

### Invariant Impact

| Invariant | Impact | Rationale |
|-----------|--------|-----------|
| #1 Generic Substrate | Preserved | Phase validation uses generic `PHASE_OPERATIONS` map |
| #2 Preserve Abstractions | Preserved | Adds a validation layer, doesn't collapse layers |
| #3 Bounded Execution | Preserved | Limits unchanged |
| #4 Preserve Enforcement | **Strengthened** | Adds explicit phase enforcement alongside no-progress |
| #5 Generic Phase Semantics | Preserved | Phases remain generic |
| #6 Embedded Planning | Preserved | Model still sees full catalog; planning is unrestricted |
| #7 Runtime Authority | **Strengthened** | Runtime is the definitive gatekeeper of what executes |
| #8 Workload Profiles | Preserved | Phase validation is orthogonal to profiles |

### Weak Model Performance

**Improved for wrong-phase ops; unchanged for no-progress.**

If a weak model emits `renamePath` during `inspection`, it is rejected immediately. The model gets explicit feedback: "You proposed X, but only Y and Z are allowed right now." This is a teachable moment.

If a weak model repeats `listDirectory` during `inspection`, response validation does **not** help — `listDirectory` IS valid in `inspection`. The existing no-progress detection still catches this.

Net effect: weak models are protected from the most obvious phase violations, but still need to learn the no-progress boundary themselves.

### Strong Model Performance

**Neutral to good.** Strong models already emit phase-appropriate ops, so they never hit the rejection. The validation acts as a deterministic safety net. No regression.

### Adaptation Impact

**Medium.** Models must learn a new failure mode: phase-rejected actions. The feedback loop becomes:

1. Model proposes action
2. Runtime rejects with phase-specific message
3. Model sees rejection in `previousActionResults`
4. Model must adapt

This is more concrete than advisory prose, but it requires the model to understand and act on runtime rejection messages.

### Operational Substrate Alignment

**Very high.** The substrate pattern "model proposes, runtime validates, runtime executes" is exactly Invariant #7. Response validation is an extension of the existing `AGENT_DIRECT_OPERATIONS` validation in `parseAgentDirectAction`. The runtime governs execution semantics; the model does not override it.

### Semantic Work Primitive Alignment

**High.** The model retains full visibility of all primitives. It can reason about any operation even if the current phase prevents its execution. The primitive layer and the operational layer remain separate.

---

## Option C: Tool Catalog Gating

**How it works:** `runtimeEnvelope.allowedOperations` (or a new field like `runtimeEnvelope.phaseAllowedOperations`) contains only the phase-appropriate subset. The model literally cannot see `renamePath` during `inspection`. The prompt prose and JSON schema both reflect the gated subset.

### Invariant Impact

| Invariant | Impact | Rationale |
|-----------|--------|-----------|
| #1 Generic Substrate | Preserved | Phase is still generic |
| #2 Preserve Abstractions | **Collapses** | Primitive contract and operational context merge into one field |
| #3 Bounded Execution | Preserved | Limits unchanged |
| #4 Preserve Enforcement | Preserved | Enforcement still exists, but enforcement is now pre-emptive |
| #5 Generic Phase Semantics | Preserved | Phases remain generic |
| #6 Embedded Planning | **Risk** | Model cannot reason about future-phase ops because they are hidden |
| #7 Runtime Authority | **Weakened** | Runtime delegates "what may I propose?" to the catalog |
| #8 Workload Profiles | Preserved | Profiles orthogonal, but adding profile gating later would compound complexity |

### Weak Model Performance

**Mixed.** Weak models cannot emit phase-inappropriate ops because they don't see them. This eliminates wrong-phase rejections.

However, weak models may be confused by the dynamic catalog. They might observe "I used to be able to listDirectory, now I can only renamePath" and generate incorrect reasoning. They may also fail to plan ahead (e.g., "After I mutate, I will verify by listing...") because `listDirectory` is invisible during `mutation`.

Evidence risk: The `PHASE_GATED_ENVELOPE_ANALYSIS.md` identified this as a primary risk for weak models.

### Strong Model Performance

**Neutral.** Strong models adapt to the restricted catalog. They only emit what they see. No runtime rejections. The catalog gating acts as a hard prompt-level filter.

### Adaptation Impact

**High.** Models must adapt to a step-varying capability catalog. The same field means different things at different steps. This is a significant shift from the current stable primitive contract.

Historical replay snapshots would also vary step-by-step, creating tooling and versioning complexity.

### Operational Substrate Alignment

**Medium.** The substrate is no longer purely runtime-validated. The authority boundary moves into the prompt construction layer (`buildRuntimeEnvelope` or `buildAgentPrompt`). Runtime still validates, but the first line of defense is the catalog presentation.

This is less aligned with Invariant #7 than Option B.

### Semantic Work Primitive Alignment

**Low.** The primitive layer is obscured. The model does not see its full toolbox. It sees only the phase-filtered view. This makes it harder for the model to reason about cross-phase workflows or to understand its fundamental capabilities.

---

## Comparative Summary

| Criterion | A Advisory | B Response Validation | C Tool Catalog Gating |
|-----------|------------|----------------------|----------------------|
| **Invariant #2 (Abstractions)** | Preserved | Preserved | **Collapses** |
| **Invariant #7 (Runtime Authority)** | Preserved, deferred | **Strengthened** | Weakened |
| **Weak model: wrong-phase ops** | Fails late (no-progress) | **Rejected immediately** | Cannot emit |
| **Weak model: no-progress** | Still caught | Still caught | Still caught |
| **Strong model performance** | Good | Neutral/good | Neutral |
| **Adaptation impact** | Low | Medium | **High** |
| **Operational substrate alignment** | High | **Very high** | Medium |
| **Semantic primitive alignment** | High | **High** | Low |
| **Implementation complexity** | None | Low (add phase check to validation) | Medium (envelope or prompt changes) |

---

## Recommendation

**Adopt Option B: Response Validation.**

### Rationale

1. **Best aligns with Runtime Authority (Invariant #7).** The runtime, not the prompt, governs what executes. The model proposes; the runtime validates against both primitive contract AND operational phase. This is the definitive interpretation of "Runtime governs execution semantics."

2. **Preserves abstractions (Invariant #2).** The primitive contract (`allowedOperations`), operational context (`currentPhase`), and prompt guidance remain separate layers. None are collapsed into each other.

3. **Provides deterministic enforcement without hiding primitives.** Weak models get explicit rejection feedback instead of being silently constrained. Strong models are unaffected.

4. **Lowest adaptation cost with highest enforcement gain.** Option C requires models to adapt to dynamic catalogs and creates snapshot/tooling complexity. Option B adds a single validation check that mirrors the existing `AGENT_DIRECT_OPERATIONS` validation pattern.

5. **Does not conflate prompt and authority.** The prompt can remain advisory/guidance-oriented. The runtime is the enforcer. This separation of concerns is architecturally clean.

### Caveat

Response validation does **not** solve the specific Ticket #59 failure (repeated `listDirectory` in `inspection` phase). `listDirectory` is valid in `inspection`; the failure is no-progress, not wrong-phase. That failure requires no-progress enforcement, not phase validation.

However, as a general architectural approach to phase authority, **B is the correct substrate design**.

---

*All claims derived from evaluation against `docs/ARCHITECTURE_INVARIANTS.md` and the evidence collected in `docs/RUN_77_POSTMORTEM.md`, `docs/PHASE_GATED_ENVELOPE_ANALYSIS.md`, `docs/ALLOWED_OPERATIONS_AUTHORITY.md`, and `docs/PROMPT_AUTHORITY_ALIGNMENT_RESULTS.md`.*

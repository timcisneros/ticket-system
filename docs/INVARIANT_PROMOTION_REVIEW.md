# Invariant Promotion Review

## Scope

Evaluate whether two candidate principles should be promoted to invariants in `docs/ARCHITECTURE_INVARIANTS.md`:

1. **Evidence Preservation**
2. **Authority Layer Separation**

Evidence sources: `docs/SUBSTRATE_DESIGN_PRINCIPLES.md`, `docs/ARCHITECTURE_INVARIANTS.md`, `docs/OPTION_B_RESULTS.md`, and all documents from the phase-authority investigation.

---

## Candidate 1: Evidence Preservation

### Proposed invariants

**A.** "Append evidence, do not replace evidence."

**B.** "Preserve useful evidence until downstream consumers have had an opportunity to use it."

**C.** "Do not destroy runtime-generated evidence when injecting enforcement feedback. Operation results, state observations, and action outcomes must remain accessible to downstream consumers."

### Is this truly invariant-level?

**Yes.** An invariant protects substrate semantics from local overfitting regressions. The no-progress overwrite (destroying `listDirectory` results with a warning) was exactly such a regression: it was introduced to "simplify" the prompt feedback, but it destroyed the signal the model needed to adapt. Without an explicit invariant, a future developer could similarly "clean up" the feedback loop by replacing a multi-item array with a single summary message.

The causal evidence is direct: Run #82 completed after the one-line fix. Runs 77/79/81 failed identically before the fix.

### Validity across future environments

| Environment | Valid? | Rationale |
|-------------|--------|-----------|
| Larger scale | Yes | Whether single-process or distributed, evidence produced by the runtime must reach downstream consumers |
| Multi-agent | Yes | If Agent A produces evidence consumed by Agent B or the planner, the evidence must survive enforcement by the runtime between agents |
| Workflow-driven | Yes | Workflow step outputs are evidence for downstream steps; destroying them with enforcement messages would break the workflow |
| Semantic-primitive-driven | Yes | Semantic primitives produce structured outputs (embeddings, parsed trees, etc.) that downstream reasoning depends on |
| Business-oriented | Yes | Audit, compliance, and observability all require that evidence survive enforcement actions |

### Could future architectures reasonably violate it?

Only in a **fundamentally different architecture**:
- A stateless architecture where each model call is independent and receives only current workspace state (no `previousActionResults`). In that architecture there is no "per-step feedback loop" to preserve evidence within.
- A capability-based security model where the model has no memory of prior steps.

These are not evolutions of the current substrate; they are replacements. Within the current paradigm (runtime generates per-step feedback for the model), the principle is structural.

### What is it fundamentally?

**Architectural boundary.** It defines how the enforcement layer interacts with the evidence/feedback layer. It is not an implementation technique (it generalizes beyond arrays), not an optimization, and not a runtime semantic (it doesn't change what executes).

### Wording evaluation

| Wording | Precision | Generality | Clarity | Verdict |
|---------|-----------|------------|---------|---------|
| A. "Append evidence, do not replace evidence" | High | Low | High | Too mechanical; assumes array-based feedback |
| B. "Preserve useful evidence until downstream consumers have had an opportunity to use it" | Medium | Medium | Medium | Vague on "useful" and "opportunity" |
| C. "Do not destroy runtime-generated evidence when injecting enforcement feedback" | High | High | High | Best balance |

**Recommended wording:**

> **Evidence Preservation** — Do not destroy runtime-generated evidence when injecting enforcement feedback. Operation results, state observations, and action outcomes must remain accessible to downstream consumers.

This wording:
- Does not specify the mechanism (append vs. stream vs. map)
- Names the conflict (evidence vs. enforcement feedback)
- Names what must survive (results, observations, outcomes)
- Names why (downstream consumers need it)

### Verdict for Candidate 1

**Promote.** Causal evidence is direct. The principle is architectural, not implementation-specific. It remains valid across all plausible evolutions of the current substrate. The wording above balances precision and generality.

---

## Candidate 2: Authority Layer Separation

### Proposed invariant

"Primitive capability and operational authority are distinct layers. The runtime must not conflate them in data models, prompts, or enforcement logic."

### Is this truly invariant-level?

**Yes, with nuance.** The prompt contradiction ("Use only the operations listed in runtimeEnvelope.allowedOperations" while simultaneously restricting to phase-gated ops) was a well-meaning regression. A prompt engineer saw a field named `allowedOperations` and assumed it was the operational authority. The invariant would prevent this class of bug by making the layer separation explicit.

However, this principle is also a **specific application** of Invariant #2 (Preserve Abstractions): it names a particular abstraction boundary (primitive capability vs. operational authority) that must not be collapsed. It could be argued that Invariant #2 is sufficient and a separate invariant is redundant.

**Counter-argument to redundancy:** Invariant #2 is general. The authority conflation bug was subtle enough to escape general review. A dedicated invariant makes the boundary explicit and testable. This is the same reason Invariant #8 (Workload Profiles Are Examples) exists as a separate statement even though it is also an application of Invariant #1 (Generic Substrate).

### Validity across future environments

| Environment | Valid? | Rationale |
|-------------|--------|-----------|
| Larger scale | Yes | Capability declarations and permission grants remain separate concepts at any scale |
| Multi-agent | Yes | Agent A's primitive capabilities are distinct from what Agent A is allowed to do in a specific allocation |
| Workflow-driven | Yes | Workflow steps have primitive capabilities; workflow routing logic applies operational restrictions |
| Semantic-primitive-driven | Yes | Semantic primitives (e.g., "search", "compute") are distinct from permission scopes (e.g., "read-only", "write-allowed") |
| Business-oriented | Yes | RBAC (role-based access control) separates "what you can do" (primitive capability) from "what you may do" (operational authority) |

### Could future architectures reasonably violate it?

**Yes, in a capability-based security model.** In capability-based systems, the capability token itself encodes both primitive capability and operational authority. There is no separate "operational authority" layer. The token IS the conflation.

However, the current substrate is **authority-based**, not capability-based. The runtime validates model proposals against rules. Within this paradigm, the separation is fundamental. If the substrate ever moved to capability-based security, all invariants would need re-examination.

### What is it fundamentally?

**Architectural boundary.** It defines the separation between two conceptual layers: the agent's toolbox (what it is fundamentally capable of) and the runtime's current restrictions (what it is allowed to do right now). It is not runtime semantics (doesn't change what executes), not implementation technique, and not optimization.

### Is this just a restatement of Invariant #2?

Partially. But consider:
- Invariant #2 says "do not collapse abstractions"
- Candidate 2 says "these two specific abstractions must remain separate"

The distinction matters for review and testing. A reviewer reading Invariant #2 might not think to check whether `allowedOperations` is being used as both primitive and operational authority. A dedicated invariant makes the review check explicit.

### Verdict for Candidate 2

**Promote, but with reduced priority.** It is a valuable explicit boundary, but it is derivative of Invariant #2. Its value is in making a specific abstraction boundary testable during review. It should be added, but framed as an explicit extension of Preserve Abstractions rather than an independent structural invariant.

---

## Comparison Table

| Criterion | Evidence Preservation | Authority Layer Separation |
|-----------|----------------------|---------------------------|
| Causal evidence | Direct (Run #82) | Indirect (prompt bug) |
| Confidence | Very high | High |
| Independence from existing invariants | Independent (not covered by #1–#8) | Derivative of #2, but adds specificity |
| Generality across architectures | High (any feedback-loop substrate) | Medium (authority-based systems only) |
| Risk of re-violation | High (easy to "simplify" feedback) | Medium (easy to name field ambiguously) |
| Testability during review | High | Medium |
| Recommended action | **Promote** | **Promote** |

---

## Recommendations

### Evidence Preservation

**Promote** with wording:

> **Evidence Preservation** — Do not destroy runtime-generated evidence when injecting enforcement feedback. Operation results, state observations, and action outcomes must remain accessible to downstream consumers.

### Authority Layer Separation

**Promote** with wording:

> **Authority Layer Separation** — Primitive capability and operational authority are distinct layers. The runtime must not conflate them in data models, prompts, or enforcement logic. The model's operational restrictions are applied by the runtime on top of the primitive contract, not by modifying the primitive contract itself.

### Placement in ARCHITECTURE_INVARIANTS.md

Insert after Invariant #8 (the last existing invariant), maintaining the declarative style of the document.

### Do not promote

Neither candidate should be held back. Both have been validated through the investigation:
- Evidence Preservation by causal experiment (Option B)
- Authority Layer Separation by architectural analysis and prompt fix

---

*All claims derived from evaluation of the 13 documents produced during the phase-authority investigation, direct code inspection of `server.js`, and reasoning about substrate evolution across multiple architectural paradigms.*

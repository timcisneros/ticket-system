# Remaining Product Uncertainties

## Accepted Constraints

- Ticket abstraction survived analysis.
- Workflow abstraction survived analysis.
- An implicit Business Work Definition layer exists, fragmented across Workload Profiles, Workflow Definitions, Action Contracts, and Execution Phases.
- Workload Profiles are the current center of gravity for agent-mode behavior.
- Hybrid work (structured phases with adaptive reasoning) emerged as a dominant pattern in the research model but represents only 19% of the historical ticket corpus.
- The historical ticket corpus is a validation and test corpus, not a representative usage corpus.

These constraints bound what is known. The following identifies what remains unknown.

---

## 1. Supported by Evidence

These assumptions have direct empirical support from the codebase, historical tickets, or behavioral traces.

### Finding 1: The system already behaves differently based on work type
**Evidence:** Workload Profiles (`server.js` lines 92-162) are detected from the objective string via regex, merge type-specific runtime limits (`getProfileRuntimeLimits`), and inject type-specific behavioral guidance into agent prompts (`buildProfileGuidance`). The behavioral trace confirms profile influence at multiple decision points.

### Finding 2: The ticket abstraction conflates distinct concepts into a single field
**Evidence:** The ticket `objective` field absorbs intent, inputs, constraints, success criteria, and stakeholder context into one prose string. The ticket gap analysis confirmed all 20 research primitives force structured metadata into this single field.

### Finding 3: The current workflow engine is a static action graph
**Evidence:** `data/workflows.json` shows `actions` arrays with `next`, `trueNext`, `falseNext` fields. No loop construct, no bounded agent execution phase, no handoff suspension. Classification confirmed it naturally fits ~20-27% of work.

### Finding 4: Workload Profiles only cover 47% of agent-mode work
**Evidence:** Actual ticket usage analysis of all 82 tickets showed 32 of 60 agent-mode tickets (53%) do not match any of the five profile regex patterns.

### Finding 5: Historical usage is procedural, not cognitive
**Evidence:** 46% of tickets are explicit step-by-step procedural instructions (file creation, moves, handoffs). Only 19% involve inspection, diagnosis, or synthesis. The corpus is test/validation work, not operational work.

---

## 2. Weakly Supported

These assumptions have some structural or logical support but lack direct evidence from real user behavior.

### Assumption 1: Agent mode will remain the dominant execution path
**Why weak:** Currently 73% of tickets use agent mode. However, the corpus is dominated by procedural test work and batch legal-intake workflows. Real operational users might prefer workflows for repeatable tasks (the legal-intake batch pattern suggests this). The 73% figure may not generalize.

### Assumption 2: The 10 Cognitive Primitives form a sufficient grammar
**Why weak:** All 20 research primitives decomposed into the 10 cognitive primitives without requiring an eleventh. This demonstrates internal consistency. However, the 20 research primitives themselves were authored during the investigation, not discovered from real usage. Whether this grammar covers work that real users actually perform is untested.

### Assumption 3: Hybrid work is the dominant pattern for operational AI
**Why weak:** The research classification yielded 55% hybrid. The actual corpus shows 19% hybrid, but the corpus is acknowledged as non-representative. No evidence confirms that real users will create hybrid work at the 55% level.

### Assumption 4: Workload Profiles should be expanded beyond five types
**Why weak:** 53% of agent work does not match any profile. However, that unmatched work is mostly procedural test tickets (file creation, handoffs, vague objectives). Expanding profiles might not be valuable if real users create different work types. The five existing profiles (report, diagnosis, refactor, recommendation, bulk-inventory) may be sufficient for the work that actually matters.

### Assumption 5: The workflow abstraction is viable if the implementation is enhanced
**Why weak:** When the workflow concept was imagined with loops, agent phases, and handoffs, 10 of 11 hybrid primitives became expressible. This is a logical inference, not an empirical test. Whether a richer workflow engine would actually be used for hybrid work, or whether users would continue to use agent mode with inline instructions, is unknown.

### Assumption 6: The implicit BWD layer should be made explicit and unified
**Why weak:** The investigation identified fragmentation (Profiles for agent, Workflows for workflow mode, Phases universal). There is no evidence that unifying these improves any outcome. The current fragmentation may be functional for the actual usage pattern.

---

## 3. Unvalidated

These assumptions have no direct or indirect evidence. They are hypotheses generated by the investigation that require validation before they can inform product decisions.

### Assumption 1: Users will author and reuse configurable work definitions
**Evidence gap:** The system already supports user-authored workflow definitions (`data/workflows.json`), but most tickets are one-off agent objectives. No user study, prototype test, or usage metric supports the claim that users prefer authoring reusable definitions over writing ad-hoc objectives.

### Assumption 2: Users prefer declarative outcome requests over imperative step-by-step instructions
**Evidence gap:** The actual ticket corpus shows the opposite. Most agent-mode tickets contain explicit step-by-step instructions ("Create folder X, then move file Y to Z, then verify"). The Business Work Primitive model assumes users declare outcomes ("Remediate service degradation") and let the system determine steps. No evidence supports this preference.

### Assumption 3: Semantic success criteria reduce false completions
**Evidence gap:** The current system uses substrate postconditions (`fileExists`, `fileContains`) for workflows and agent self-reporting (`complete:true`) for agent mode. Whether business-level acceptance criteria ("report contains cited evidence") would produce fewer false completions has never been measured.

### Assumption 4: Exposing Cognitive Traces improves trust or debuggability
**Evidence gap:** The concept of labeling runtime traces with Cognitive Primitive vocabulary (Observe, Diagnose, Plan, etc.) was defined but never tested. No user study, proxy metric, or behavioral measurement was gathered.

### Assumption 5: Business Work Primitives are the right level of abstraction for user-facing work
**Evidence gap:** The 20 candidate primitives (Investigate Anomaly, Assess Operational Risk, etc.) were authored during the investigation. The actual ticket corpus shows users create work at the substrate level ("create file X", "move file Y"). There is no evidence that users think in terms of "Investigate Anomaly" or would find such a catalog useful.

### Assumption 6: Stakeholder routing, multi-party coordination, and arbitration are needed
**Evidence gap:** These capabilities appear in the research primitives (Coordinate Cross-Functional Action, Resolve Escalation, Negotiate Service Terms, Finalize Go/No-Go Decision) but zero tickets in the 82-ticket corpus required them. No real-world usage validates their priority.

### Assumption 7: Evidence requirements and provenance are valued by users
**Evidence gap:** The research model requires cited evidence, provenance maps, and source reliability for many primitives. Whether users care about this level of traceability, or whether it improves trust, has not been measured.

### Assumption 8: The workflow engine should be enhanced with loops, agent phases, and handoff suspension
**Evidence gap:** The research model says these capabilities would unlock 55% hybrid work. However, actual usage shows only 19% hybrid, and the corpus is test work. There is no evidence that adding these capabilities would increase hybrid usage or improve outcomes. They might be unused infrastructure.

### Assumption 9: A unified Business Work Definition layer improves any measurable outcome
**Evidence gap:** The investigation identified that the layer is fragmented and latent. Whether making it explicit, unified, and user-visible improves completion accuracy, time-to-result, reuse rate, or failure reduction has never been tested.

### Assumption 10: The 55/25/20 distribution (hybrid/agent-first/workflow-first) generalizes to real usage
**Evidence gap:** This distribution came from classifying 20 authored primitives. Actual usage is 19/54/27 (hybrid/agent-first/workflow-first), but the corpus is non-representative. No cross-domain study or real-user observation validates either distribution.

---

## Summary of Largest Uncertainties

| Rank | Uncertainty | Why It Matters |
|---|---|---|
| 1 | **Will users author reusable work definitions?** | The entire BWD model depends on users creating and reusing work-type definitions. If they prefer one-off objectives, the layer adds no value. |
| 2 | **Do users prefer declarative outcomes or imperative steps?** | The BWD model assumes declarative work requests. The actual corpus shows imperative step-by-step instructions. This mismatch threatens the model's core interaction pattern. |
| 3 | **Is hybrid work actually dominant in real usage?** | The research model optimized for 55% hybrid. If real usage remains procedural (like the corpus), the model over-engineers for a minority pattern. |
| 4 | **Does exposing the BWD layer improve any outcome?** | Unifying the fragmented layer is a structural change. Without evidence it improves trust, accuracy, speed, or reuse, the change is unjustified. |
| 5 | **Are sophisticated primitives (arbitration, negotiation, coordination) ever needed?** | These are complex capabilities in the model. Zero historical usage. They may be premature for the product's actual trajectory. |

---

## Constraint on Future Work

The investigation produced a coherent conceptual model, but it cannot be treated as validated product direction. The model explains sophisticated work well and misses common work entirely. Until real user behavior is observed, all assumptions about the future product remain hypotheses.

# Product Synthesis: Work Primitive Investigation

## What Was Investigated

A conceptual investigation into whether Business Work Primitives constitute a distinct semantic layer above the current ticket/workflow/action stack. The investigation examined:

- 20 candidate Business Work Primitives
- 10 Cognitive Primitives (Observe, Diagnose, Scope, Plan, Execute, Verify, Repair, Synthesize, Arbitrate, Commit)
- The existing workflow engine implementation
- The existing ticket abstraction
- The runtime execution path

The investigation did not include user studies, benchmarks, or prototype tests. All conclusions are derived from conceptual classification, code inspection, and behavioral tracing.

---

## 1. Assumptions Confirmed

### Assumption: Business Work Primitives are a distinct semantic layer
**Status: Confirmed.** The 20 candidate primitives share a common structure (name, business objective, inputs, outputs, success criteria, cognitive composition) that is different from both workflow step graphs and substrate action catalogs. They describe *what* work delivers, not *how* it executes.

### Assumption: Cognitive Primitives form a stable decomposition grammar
**Status: Confirmed.** Ten primitives (Observe, Diagnose, Scope, Plan, Execute, Verify, Repair, Synthesize, Arbitrate, Commit) covered all 20 business operations without requiring an eleventh. The grammar appears closed and cross-domain.

### Assumption: The current workflow implementation is too rigid for most operational work
**Status: Confirmed.** The workflow engine is a static action graph with deterministic branching (`next`, `trueNext`, `falseNext`). It lacks loops, bounded agent execution phases, and handoff suspension. Classification showed it naturally fits ~20% of work and struggles with ~80%.

### Assumption: The ticket objective conflates multiple distinct concepts
**Status: Confirmed.** The `objective` field absorbs intent, inputs, constraints, success criteria, and stakeholder context into a single free-text string. This makes the work unverifiable, non-reusable, and structurally opaque to the system.

### Assumption: The system already behaves differently based on work type
**Status: Confirmed.** Workload Profiles (`server.js` lines 92-162) define five reusable work types with distinct constraints, expected phase patterns, and behavioral guidance. The runtime detects the profile from the objective string, merges profile-specific limits, and injects type-specific instructions into agent prompts. The system already has an implicit BWD layer.

---

## 2. Assumptions Disproven

### Assumption: The Business Work Definition layer is entirely missing
**Status: Disproven.** The investigation initially concluded the BWD layer was missing, but further inspection revealed it is **latent and fragmented** across:
- Workload Profiles (agent-mode work types)
- Workflow Definitions (workflow-mode work types)
- Action Contracts (substrate vocabulary)
- Execution Phases (universal structure)

The layer exists. It is hardcoded, invisible, execution-mode-dependent, and incomplete — but it is not absent.

### Assumption: Workflows are fundamentally the wrong abstraction
**Status: Disproven.** When the workflow concept was decoupled from the current implementation — imagined as an orchestration layer with loops, agent phases, and handoffs — 10 of 11 hybrid primitives became expressible. The friction is implementation, not abstraction. The workflow concept is viable for ~75% of work.

### Assumption: The system has no reusable work definitions
**Status: Disproven.** Workflow Definitions (`data/workflows.json`) are user-authored reusable definitions with input schemas and postconditions. Workload Profiles (`server.js` lines 92-162) are hardcoded reusable definitions with constraints and behavioral guidance. Both are catalogs of reusable work types.

---

## 3. Abstractions That Survived

### Ticket Instance
**Why it survived:** The ticket abstraction is sufficient for requesting work. Any primitive can be expressed as a ticket with an `objective`, `assignment`, and `status`. The investigation confirmed it is a durable request mechanism, even if it is an insufficient definition mechanism.

### Workflow Definition
**Why it survived:** The workflow abstraction is the correct model for procedural, deterministic work (~20% of the catalog). The investigation confirmed it is viable and should be evolved, not deprecated.

### Execution Runtime
**Why it survived:** The runtime's phase model (planning → inspection → mutation → verification → terminalization), authority system, and limit enforcement are substrate-independent and correctly positioned. The investigation confirmed they are universal infrastructure, not work-type-specific logic.

### Action Contracts
**Why it survived:** The contract catalog (`inputSchema`, `outputSchema`, `authorityConstraints`, `provenanceSurface`) provides a stable substrate vocabulary. It is the building-block layer that underpins both workflows and agent execution.

---

## 4. Abstractions That Emerged

### Business Work Primitive
**What it is:** A reusable, business-meaningful unit of work (e.g., "Investigate Anomaly," "Draft Operational Policy") with defined inputs, outputs, success criteria, and a typical cognitive composition.

**Evidence:** The 20 candidate primitives all share this structure. Workload Profiles are the system's current partial expression of this abstraction.

### Cognitive Primitive
**What it is:** A universal reasoning grammar (Observe, Diagnose, Scope, Plan, Execute, Verify, Repair, Synthesize, Arbitrate, Commit) that decomposes any business work into its cognitive operations.

**Evidence:** All 20 business primitives were expressible as compositions of these 10 cognitive primitives. No additional primitive was needed.

### Hybrid Work
**What it is:** Work that requires structured orchestration (phase boundaries, step sequences) with adaptive reasoning inside each phase. Hybrid work is the dominant pattern (55% of the catalog).

**Evidence:** Classification showed 11 of 20 primitives are hybrid. The current system addresses hybrid work through agent-mode execution with phase-aware prompts, but without explicit orchestration support.

### Latent Business Work Definition Layer
**What it is:** An implicit layer distributed across Workload Profiles, Workflow Definitions, Action Contracts, and Execution Phases that already classifies work, applies type-specific constraints, and shapes behavior.

**Evidence:** Workload Profiles detect work type from the objective string, merge type-specific limits, and inject type-specific guidance. Workflow Definitions provide procedural work types with input schemas and postconditions. Together they form a fragmented but real BWD layer.

---

## 5. Abstractions That Remain Unproven

### User-authored Reusable Work Definitions
**What is unproven:** Whether users would create, reuse, and benefit from configurable work definitions (playbooks) rather than writing one-off objectives.

**Why:** No user study, prototype test, or usage data supports this. The current system already has user-authored workflow definitions, but their usage rate is low compared to agent-mode tickets.

### Cognitive Traces
**What is unproven:** Whether exposing the decomposition of a run into Cognitive Primitives (Observe, Diagnose, Plan, etc.) improves user trust, debuggability, or runtime comprehension.

**Why:** No behavioral study or proxy metric was gathered. The concept is logical but untested.

### Semantic Success Criteria
**What is unproven:** Whether business-level acceptance criteria ("report contains cited evidence") produce fewer false completions than substrate postconditions ("file exists and contains string").

**Why:** No measurement or experiment was conducted. The current system uses substrate postconditions for workflows and agent self-reporting (`complete:true`) for agent mode.

### Distribution Generalization
**What is unproven:** Whether the 55% hybrid / 25% agent-first / 20% workflow-first distribution holds for operational domains outside the ones investigated.

**Why:** The classification was performed on 20 primitives drawn from a single domain focus. No systematic cross-domain analysis was performed.

### Measurable Benefit of a Unified BWD Layer
**What is unproven:** Whether making the latent BWD layer explicit, unified, and user-visible improves any measurable outcome (completion accuracy, time-to-result, reuse rate, failure reduction).

**Why:** The investigation identified that the layer is latent and fragmented, but did not test whether surfacing it would change outcomes.

---

## Durable Product Truths

1. **The product already has an implicit Business Work Definition layer.** It is fragmented across Workload Profiles and Workflow Definitions. It is not missing.

2. **Workload Profiles are the current center of gravity for work-type behavior.** They classify agent-mode work, apply type-specific constraints, and inject type-specific guidance. They are hardcoded, invisible, and bypassed by workflow mode.

3. **The ticket abstraction is sufficient for execution but insufficient for definition.** The `objective` field conflates intent, inputs, constraints, and success criteria into a single prose blob.

4. **The workflow implementation is too rigid, but the workflow abstraction is not wrong.** A richer orchestration layer (loops, agent phases, handoffs) would express ~75% of work.

5. **Hybrid work is the dominant pattern.** 55% of operational work requires phase structure with adaptive reasoning inside each phase. This is the most important category to support.

6. **Cognitive Primitives form a stable grammar.** Ten primitives decompose all investigated business work without gaps.

7. **User configurability of work definitions is unproven.** The system already has reusable definitions (workflows, profiles) but no evidence shows users prefer authoring them over one-off objectives.

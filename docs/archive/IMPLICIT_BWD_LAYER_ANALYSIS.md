# Implicit Business Work Definition Layer Analysis

## Method

This analysis inspects the current codebase for concepts that define reusable work rather than individual executions. Each candidate is evaluated against the five metadata categories identified in the gap analysis: Inputs, Constraints, Success Criteria, Evidence Requirements, and Stakeholders.

---

## Candidate 1: Workflow Definitions

**Location:** `data/workflows.json`, `server.js` workflow CRUD routes

**What it is:** JSON documents that declare an ordered `actions` array with deterministic branching (`next`, `trueNext`, `falseNext`), an `inputSchema`, and `postconditions`.

**Responsibilities:**
- Defines step sequences for procedural work
- Validates input types against `inputSchema`
- Checks substrate-level completion via `postconditions` (`fileExists`, `fileContains`)
- Serves as the `capabilityId` for `executionMode: "workflow"` tickets

**BWD responsibilities satisfied:**

| Category | Satisfied? | How | Limitation |
|---|---|---|---|
| **Inputs** | Partial | `inputSchema` defines expected types (e.g., `intakeText: "string"`) | Schema is type-only; no semantic binding (e.g., "intake text" is not linked to the Legal Intake primitive) |
| **Constraints** | None | No constraint field exists | Authority checks are in the runtime, not the workflow definition |
| **Success Criteria** | Partial | `postconditions` check file existence and content | Substrate-level only; cannot express semantic criteria like "report contains cited evidence" |
| **Evidence Requirements** | None | No provenance or citation requirements | No field for evidence tracing |
| **Stakeholders** | None | No routing or notification field | Assignee is on the ticket, not the workflow |

**Evidence from codebase:**
- `data/workflows.json` defines `inputSchema` and `postconditions`.
- `server.js` (line 1307-1327) normalizes workflows with `inputSchema`, `actions`, and `postconditions`.
- Only 20% of candidate Business Work Primitives are workflow-first.

---

## Candidate 2: Workload Profiles

**Location:** `server.js` lines 92-162

**What it is:** A hardcoded catalog of five operational envelopes (`report`, `diagnosis`, `refactor`, `recommendation`, `bulk-inventory`) derived from observed workload behavior during validation.

**Responsibilities:**
- Defines execution limits per work type (`executionStepLimit`, `modelRequestLimit`, `maxWorkspaceOperations`)
- Restricts allowed operations per type (`allowedOperations`)
- Declares expected phase patterns (`expectedPhasePattern`)
- Provides retry guidance tailored to the work type
- Flags whether a final artifact is required (`finalArtifactRequired`)

**BWD responsibilities satisfied:**

| Category | Satisfied? | How | Limitation |
|---|---|---|---|
| **Inputs** | Partial | `maxListDirectory`, `maxReadFile` limit input gathering | No named input schema; only operational limits on input operations |
| **Constraints** | Yes | `executionStepLimit`, `modelRequestLimit`, `allowedOperations`, `expectedPhasePattern` | Hardcoded; not user-configurable |
| **Success Criteria** | Partial | `finalArtifactRequired` (boolean) | No semantic criteria; only a binary artifact flag |
| **Evidence Requirements** | Partial | `retryGuidance` includes evidence-gathering instructions | Prose guidance, not structured requirements |
| **Stakeholders** | None | No stakeholder routing | Single assignee only |

**Evidence from codebase:**
- `server.js` lines 96-162 define `WORKLOAD_PROFILES`.
- `server.js` lines 7355-7384 show `detectWorkloadProfile()` using regex patterns on the `objective` string to infer the profile.
- `server.js` lines 7386-7398 merge profile limits into runtime limits.
- `server.js` lines 7402-7459 generate profile-specific guidance injected into agent prompts.

**Significance:** Workload Profiles are the strongest candidate for an implicit BWD layer. They define reusable work types with constraints and partial success criteria. However, they are hardcoded in code (not data), cover only five types, and are detected by regex rather than declared explicitly.

---

## Candidate 3: Action Contracts

**Location:** `server.js` lines 651-900 (`ACTIONS_CATALOG`)

**What it is:** A catalog of available actions (`writeFile`, `readFile`, `agentStructuredOutput`, `condition`, `stop`, etc.) with `inputSchema`, `outputSchema`, `errorSchema`, `authorityConstraints`, and `provenanceSurface`.

**Responsibilities:**
- Defines the contract for each individual action
- Specifies what the runtime logs for forensics (`provenanceSurface`)
- Declares authority constraints per action

**BWD responsibilities satisfied:**

| Category | Satisfied? | How | Limitation |
|---|---|---|---|
| **Inputs** | Partial | `inputSchema` per action | Action-level, not work-level |
| **Constraints** | Partial | `authorityConstraints` per action | Action-level authority, not work-type policy |
| **Success Criteria** | None | No success criteria field | Actions produce outputs; correctness is checked elsewhere |
| **Evidence Requirements** | Partial | `provenanceSurface` traces where evidence is logged | Action-level provenance, not work-level evidence requirements |
| **Stakeholders** | None | No stakeholder field | N/A |

**Evidence from codebase:**
- `server.js` lines 651-900 define `ACTIONS_CATALOG` with `inputSchema`, `outputSchema`, `authorityConstraints`, `provenanceSurface`.
- `server.js` lines 606-642 define `AGENT_PRIMITIVE_METADATA` with `responseShape`, `errorShape`, `authorityConstraints`, `provenanceSurface`.

**Significance:** Action Contracts provide the building blocks but do not compose into work-level definitions. They are substrate-level contracts, not Business Work Primitive definitions.

---

## Candidate 4: Ticket Shaping Service

**Location:** `server.js` `/api/tickets/shape-objective`, `views/index.ejs`

**What it is:** A model-based service that takes a raw objective and returns a structured suggestion (`suggestedObjective`, `expectedOutputs`, `decomposition`, `warnings`, `tooBroadForOneRun`).

**Responsibilities:**
- Suggests how to bound a vague objective
- Proposes expected outputs
- Decomposes broad objectives into smaller tickets
- Flags objectives likely too broad for one run

**BWD responsibilities satisfied:**

| Category | Satisfied? | How | Limitation |
|---|---|---|---|
| **Inputs** | None | No input schema | Only operates on the objective string |
| **Constraints** | Partial | `tooBroadForOneRun` flag | Binary heuristic, not configurable policy |
| **Success Criteria** | Partial | `expectedOutputs` list | Suggested per instance, not reusable definition |
| **Evidence Requirements** | Partial | `warnings` list | Per-instance suggestions |
| **Stakeholders** | Partial | `groupModeFit` | Per-instance analysis |

**Evidence from codebase:**
- `server.js` has `/api/tickets/shape-objective` endpoint.
- `views/index.ejs` lines 17-21 show the UI for requesting shaping.
- `views/index.ejs` lines 235-274 call the shaping API and render suggestions.

**Significance:** Ticket Shaping is ad-hoc and per-instance. It does not create reusable definitions. It is a prompt-engineering helper, not a BWD layer.

---

## Candidate 5: Execution Phases

**Location:** `server.js` lines 75-90

**What it is:** A universal phase model (`planning`, `inspection`, `mutation`, `verification`, `terminalization`) with allowed operations per phase and transition rules.

**Responsibilities:**
- Enforces universal execution structure across all work
- Restricts operations based on current phase
- Tracks phase transitions in run events

**BWD responsibilities satisfied:**

| Category | Satisfied? | How | Limitation |
|---|---|---|---|
| **Inputs** | None | No input concept | N/A |
| **Constraints** | Partial | `ALLOWED_PHASE_TRANSITIONS`, `PHASE_OPERATIONS` | Universal rules, not work-type-specific |
| **Success Criteria** | None | No completion criteria | N/A |
| **Evidence Requirements** | None | No evidence concept | N/A |
| **Stakeholders** | None | No stakeholder concept | N/A |

**Evidence from codebase:**
- `server.js` lines 75-90 define `EXECUTION_PHASES` and `PHASE_OPERATIONS`.
- `server.js` lines 319-381 enforce phase compliance via `checkPhaseCompliance()`.

**Significance:** Execution Phases are universal runtime structure, not work-type definitions. They apply equally to all tickets regardless of primitive type.

---

## Aggregate Evaluation

### Existing Concepts That Partially Act as BWDs

| Concept | Inputs | Constraints | Success Criteria | Evidence | Stakeholders |
|---|---|---|---|---|---|
| **Workflow Definitions** | Type schema only | None | Substrate postconditions | None | None |
| **Workload Profiles** | Operation limits only | Full (hardcoded) | Binary artifact flag | Guidance prose | None |
| **Action Contracts** | Action schema only | Action authority | None | Action provenance | None |
| **Ticket Shaping** | None | Heuristic only | Suggested outputs | Warnings | Heuristic only |
| **Execution Phases** | None | Universal phase rules | None | None | None |

### Missing Responsibilities

No single existing concept covers all five metadata categories. Specifically:

1. **Semantic input binding:** No concept links named business inputs (alert signal, policy corpus, stakeholder requirements) to a reusable work type. `inputSchema` in workflows is type-only; workload profiles have no input schema at all.

2. **Semantic success criteria:** No concept can express "report contains cited evidence" or "decision criteria are explicitly addressed." `postconditions` are substrate checks; `finalArtifactRequired` is a boolean flag.

3. **Evidence requirements:** No concept requires provenance maps, source citations, or audit trails as part of the work definition. `provenanceSurface` in action contracts traces what the runtime logs, but does not require the agent to produce evidence.

4. **Stakeholder routing:** No concept defines who should be notified, consulted, or asked for acknowledgment. `assignmentTargetId` captures only the primary executor.

### Overlapping Responsibilities

- **Constraints** are split across Workload Profiles (per-type limits), Execution Phases (universal phase rules), and Action Contracts (per-action authority). There is no unified constraint model.
- **Inputs** are split across Workflow `inputSchema` (type schema for 20% of work), Workload Profile operation limits (soft constraints on input gathering for agent work), and Ticket `objective` (prose for 80% of work).
- **Success criteria** are split across Workflow `postconditions` (substrate checks for workflow mode) and agent self-reporting (`complete:true` in objective for agent mode).

---

## Conclusion

**Does the system already contain an implicit Business Work Definition layer?**

No. The system contains **fragments** of what a BWD layer would provide, but they are:

1. **Fragmented across multiple concepts:** No single concept covers all five metadata categories. Workload Profiles cover constraints; Workflows cover inputs and substrate success criteria; Action Contracts cover action-level contracts; Execution Phases cover universal runtime structure.

2. **Hardcoded and non-reusable:** Workload Profiles are embedded in `server.js` code, not user-configurable data. They cover only five types and are detected by regex on the objective string.

3. **Execution-mode-dependent:** Workflow Definitions serve only the 20% of work that uses workflow mode. Workload Profiles serve only agent-mode work. There is no unified concept that spans both execution paths.

4. **Missing semantic layer:** None of the existing concepts can express semantic success criteria, evidence requirements, or stakeholder routing. They operate at the substrate layer (files, operations) or the runtime layer (limits, phases), not at the business work layer.

**The investigation uncovered a genuinely missing abstraction.** The current system has pieces that approximate parts of a BWD — most notably Workload Profiles, which are the closest candidate — but they do not cohere into a unified, user-visible, reusable definition of Business Work. The gap is structural, not merely a matter of surfacing an existing implicit layer.

# Center of Gravity: The Latent Business Work Definition Layer

## Evaluation Criteria

Each existing concept is evaluated against:

1. **BWD Responsibilities Satisfied** — Which of the five metadata categories (Inputs, Constraints, Success Criteria, Evidence Requirements, Stakeholders) does it cover?
2. **Missing Responsibilities** — What is absent?
3. **Centrality to System Behavior** — How often is it consulted? Does it shape runtime behavior?
4. **Role** — Is it a primary work-definition mechanism or a supporting mechanism?

---

## Candidate 1: Workload Profiles

**Location:** `server.js` lines 92-162, 7355-7459

### Responsibilities Satisfied

| Category | Coverage | Evidence |
|---|---|---|
| **Inputs** | Partial | `maxListDirectory`, `maxReadFile` constrain input-gathering operations per type. No named schema, but operation envelopes define what data access patterns are expected. |
| **Constraints** | **Full** | `executionStepLimit`, `modelRequestLimit`, `maxWorkspaceOperations`, `allowedOperations`, `expectedPhasePattern` — all are per-profile operational envelopes. |
| **Success Criteria** | Partial | `finalArtifactRequired` (boolean) signals whether the work type expects a deliverable. |
| **Evidence Requirements** | Partial | `retryGuidance` includes evidence-gathering instructions (e.g., "Cite specific file paths," "Link each recommendation to specific evidence"). |
| **Stakeholders** | None | Single assignee only; no multi-party routing. |

### Missing Responsibilities

- Named input schema (e.g., "alert signal" or "intake text")
- Semantic success criteria (e.g., "report contains cited evidence")
- Structured evidence requirements (e.g., provenance map, source reliability)
- Stakeholder routing
- User configurability (hardcoded in `server.js`)

### Centrality to System Behavior

**Very high.** Every agent-mode ticket passes through `detectWorkloadProfile()` (line 7403). The detected profile directly shapes:
- Runtime limits via `getProfileRuntimeLimits()` (line 7386)
- Agent prompt content via `buildProfileGuidance()` (lines 7409-7459)
- Available operation catalog via phase-aware restriction
- Expected phase progression enforced by `checkPhaseCompliance()`

Historical ticket data shows the majority of execution is agent-mode. Workload Profiles are therefore consulted more frequently than any other work-definition mechanism.

### Role: Primary Work-Definition Mechanism

Workload Profiles are the system's current answer to "What kind of work is this?" for the dominant execution path. They classify, constrain, and guide agent behavior based on work type.

---

## Candidate 2: Workflow Definitions

**Location:** `data/workflows.json`, `server.js` workflow CRUD routes

### Responsibilities Satisfied

| Category | Coverage | Evidence |
|---|---|---|
| **Inputs** | Partial | `inputSchema` defines expected types (e.g., `intakeText: "string"`). No semantic binding. |
| **Constraints** | None | No per-workflow constraint field. Runtime limits are global defaults. |
| **Success Criteria** | Partial | `postconditions` (`fileExists`, `fileContains`) check substrate completion. No semantic criteria. |
| **Evidence Requirements** | None | No provenance or citation requirements. |
| **Stakeholders** | None | Assignee is on the ticket, not the workflow. |

### Missing Responsibilities

- Semantic success criteria
- Evidence requirements
- Operational constraints (timeouts, budgets)
- Stakeholder routing
- Adaptive / hybrid work patterns (loops, agent phases)

### Centrality to System Behavior

**Moderate.** Workflow definitions are authoritative when `executionMode: "workflow"` is selected. They determine step sequencing, branching, and substrate-level completion checks. However, historical data (`data/tickets.json`) shows the majority of tickets use `executionMode: "agent"`, bypassing workflows entirely.

### Role: Primary Work-Definition Mechanism (for Workflow-Mode Work Only)

Workflow Definitions are the system's current answer to "What kind of work is this?" for procedural, deterministic work. They are more structurally complete than Workload Profiles (full step graph, input schema, postconditions) but cover a smaller fraction of execution.

---

## Candidate 3: Action Contracts

**Location:** `server.js` lines 606-650, 651-900

### Responsibilities Satisfied

| Category | Coverage | Evidence |
|---|---|---|
| **Inputs** | Partial | `inputSchema` per action (e.g., `writeFile` requires `path` and `content`). |
| **Constraints** | Partial | `authorityConstraints` per action (e.g., workspace scope, protected paths). |
| **Success Criteria** | None | Actions produce outputs; correctness is checked at the orchestration layer. |
| **Evidence Requirements** | Partial | `provenanceSurface` traces where evidence is logged per action. |
| **Stakeholders** | None | No routing or notification field. |

### Missing Responsibilities

- Work type definition (actions are building blocks, not compositions)
- Work-level success criteria
- Work-level evidence requirements
- Work-level stakeholder routing

### Centrality to System Behavior

**Very high.** Every workspace operation, every workflow step, and every agent action is validated against the contract catalog. But this is substrate validation, not work-type classification.

### Role: Supporting Mechanism

Action Contracts provide the vocabulary that Workload Profiles and Workflow Definitions use. They are essential infrastructure but do not define what work to perform.

---

## Candidate 4: Execution Phases

**Location:** `server.js` lines 75-90, 319-381

### Responsibilities Satisfied

| Category | Coverage | Evidence |
|---|---|---|
| **Inputs** | None | No input concept at this layer. |
| **Constraints** | Partial | `ALLOWED_PHASE_TRANSITIONS` and `PHASE_OPERATIONS` restrict what can happen in each phase. |
| **Success Criteria** | None | No completion criteria. |
| **Evidence Requirements** | None | No evidence concept. |
| **Stakeholders** | None | No routing or notification. |

### Missing Responsibilities

- Named work types
- Input schema
- Success criteria
- Evidence requirements
- Stakeholders

### Centrality to System Behavior

**Very high.** All work traverses phases. Phase compliance is checked on every agent response. But the phase model is universal — it does not vary by work type.

### Role: Supporting Mechanism

Execution Phases provide the universal structure that Workload Profiles reference via `expectedPhasePattern`. They are the stage, not the play.

---

## Ranking

| Rank | Concept | Primary or Supporting | Coverage of BWD Responsibilities | Execution Mode Coverage | User-Authored |
|---|---|---|---|---|---|
| **1** | **Workload Profiles** | **Primary** | Constraints (full), Success Criteria (partial), Evidence (partial), Inputs (partial) | **Agent-mode (dominant)** | **No (hardcoded)** |
| **2** | **Workflow Definitions** | Primary | Inputs (partial), Success Criteria (partial) | Workflow-mode (minority) | **Yes** |
| **3** | **Action Contracts** | Supporting | Inputs (action-level), Constraints (action-level), Evidence (action-level) | All modes | No |
| **4** | **Execution Phases** | Supporting | Constraints (universal phase rules) | All modes | No |

---

## Evidence Summary

### Why Workload Profiles Rank First

1. **Frequency of consultation.** `detectWorkloadProfile()` is called for every agent-mode ticket. Agent mode is the dominant execution path in historical data.

2. **Direct behavioral influence.** Profiles directly mutate runtime limits (`getProfileRuntimeLimits`), agent prompt content (`buildProfileGuidance`), and operation catalogs (phase-aware restriction). No other work-definition mechanism has as broad a runtime footprint.

3. **BWD-like structure.** Profiles contain: name, description, constraints, expected outcomes (`finalArtifactRequired`), expected phase pattern, and type-specific behavioral guidance. This is the most complete BWD-like structure in the system.

4. **Explicit design intent.** The code comment at line 93 states: "Explicit operational envelopes for common ticket classes." This is an explicit BWD design intent.

### Why Workflow Definitions Rank Second

1. **More structurally complete.** Workflows have full step graphs, input schemas, and postconditions — richer structure than profiles.

2. **User-authored.** Unlike hardcoded profiles, workflows are created and stored in `data/workflows.json`.

3. **Limited reach.** Only ~20% of work uses workflow mode. Most work bypasses this mechanism entirely.

### Why Action Contracts and Execution Phases Rank Lower

- Both are universal infrastructure, not work-type definitions.
- Neither names work types, declares success criteria, or binds inputs at the business level.
- They are referenced by the primary mechanisms (Profiles use phase patterns; Workflows use action contracts) but do not themselves classify work.

---

## Determination

**The center of gravity of the latent Business Work Definition layer is Workload Profiles.**

Workload Profiles are the system's current expression of "What kind of work is this, and how should it behave?" They are consulted on every agent-mode ticket, directly shape runtime limits and agent guidance, and contain the most complete BWD-like metadata of any existing concept.

The layer is latent because:
- It is hardcoded, not user-configurable
- It covers only five work types
- It is execution-mode-specific (agent only)
- It lacks semantic success criteria and stakeholder routing

But it is not missing. It is the existing primary work-definition mechanism for the dominant execution path.

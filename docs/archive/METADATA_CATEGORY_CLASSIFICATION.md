# Metadata Category Classification Analysis

## Current System Layers

The existing system provides three primary layers where metadata can reside:

- **Ticket metadata:** Instance-specific fields (`objective`, `assignmentTargetType`, `assignmentTargetId`, `workflowId`, `workflowInput`, `status`, timestamps). Defines a single request for work.
- **Workflow metadata:** Orchestration-definition fields (`actions`, `inputSchema`, `postconditions`, `next` / `trueNext` / `falseNext`). Defines a deterministic execution graph and its completion checks.
- **Execution metadata:** Runtime-enforced fields (`DEFAULT_AGENT_RUNTIME_LIMITS`, `AGENT_ALLOWED_OPERATIONS`, `PHASE_OPERATIONS`, authority constraints, replay snapshots, event chains). Defines what the runtime permits, tracks, and enforces during a run.

---

## Category 1: Inputs

**Classification: A. Ticket metadata**

**Reasoning:**

Inputs are the specific data, evidence, and artifact references required to perform a particular instance of work. Examples from the gap analysis include: alert signal identifiers, source streams, existing policy corpus references, intake text, and conflicting source values.

In the current system, bound input values live in `workflowInput` (for workflow mode) or are embedded in the `objective` string (for agent mode). Both are ticket fields. The workflow definition carries an `inputSchema` that describes types, but the schema is a type contract, not the data itself. The actual data is instance-specific and bound at request time.

Inputs are not execution metadata because they are not about runtime limits or enforcement. They are not workflow metadata because they are not part of the orchestration graph structure. They are request-specific context that changes from ticket to ticket.

**Conclusion:** Inputs naturally belong with the ticket instance.

---

## Category 2: Constraints

**Classification: C. Execution metadata**

**Reasoning:**

Constraints define the operational envelope within which execution must occur. Examples include: time bounds (completion windows, stability observation periods), safety boundaries (protected paths, forbidden operations), resource limits (mutation budgets, model request caps), and rollback policies.

In the current system, these map directly to execution-layer mechanisms:
- Time bounds → `maxRuntimeDurationMs`, `maxExecutionSteps`
- Safety boundaries → `AGENT_ALLOWED_OPERATIONS`, `AGENT_MUTATING_OPERATIONS`, protected-paths list, authority checks
- Resource limits → `maxWorkspaceOperationsPerRun`, `maxMutatingActionsPerResponse`
- Rollback triggers → phase transition rules (`ALLOWED_PHASE_TRANSITIONS`), operation-history recovery

The execution runtime is the component that reads, enforces, and logs compliance with these boundaries. Constraints are not ticket metadata because they are not instance-specific routing or intent; they are operational rules. They are not workflow metadata because they are not step sequencing or postconditions; they are cross-cutting runtime policies.

**Conclusion:** Constraints naturally belong in the execution layer.

---

## Category 3: Success Criteria

**Classification: B. Workflow metadata**

**Reasoning:**

Success criteria are the pass/fail conditions that determine whether a completed run satisfies the request. Examples include: "report contains cited evidence," "performance returned to baseline," "all P0 bugs closed," "criteria are explicitly addressed."

In the current system, the only structured location for completion checks is the workflow `postconditions` array (`fileExists`, `fileContains`). Postconditions are checked after workflow execution to determine whether the orchestration achieved its intended effect. Success criteria serve the same semantic role: they are the contract that the orchestration must satisfy.

They are not ticket metadata because they define reusable completion logic, not instance routing. They are not execution metadata because they are not about runtime limits or authority; they are about outcome correctness. The execution runtime enforces *how* work runs; success criteria define *when* the result is acceptable.

**Conclusion:** Success criteria naturally belong with the orchestration definition, alongside postconditions.

---

## Category 4: Evidence Requirements

**Classification: B. Workflow metadata**

**Reasoning:**

Evidence requirements specify what proof the output must carry: source citations, provenance maps, audit trails, before/after comparisons, and confidence distributions. Examples include: "root cause is cited," "evidence is directly cited from inputs," "provenance map links every segment to its origin."

These are quality requirements on the work product. They are checked as part of verifying completion. In the current system, the closest analog is the workflow `postconditions` layer, which validates output properties (file content checks). Evidence requirements are a more sophisticated version of the same concept: they are acceptance conditions on the output artifact.

They are not ticket metadata because they are not routing or request context. They are not execution metadata because they are not about runtime enforcement or limits; they are about output correctness. They belong with the orchestration contract that defines what a valid result looks like.

**Conclusion:** Evidence requirements naturally belong with the orchestration definition, as an extension of completion verification.

---

## Category 5: Stakeholders

**Classification: A. Ticket metadata**

**Reasoning:**

Stakeholders define who is involved in, affected by, or must be notified about a specific instance of work. Examples include: the assigned agent, parties to coordinate with, escalation contacts, reviewers, and dissent record recipients.

In the current system, the primary stakeholder is captured by `assignmentTargetType` / `assignmentTargetId` — a ticket field. The gap analysis identified that multi-party work (Coordinate Cross-Functional Action, Resolve Escalation, Negotiate Service Terms) requires routing to additional parties beyond the single assignee, but these additional stakeholders are instance-specific: they depend on who is involved in this particular conflict, negotiation, or coordination task.

Stakeholders are not workflow metadata because they are not part of the orchestration graph. They are not execution metadata because they are not runtime limits or enforcement rules. They are routing and notification context that is specific to the work request.

**Conclusion:** Stakeholders naturally belong with the ticket instance.

---

## Summary Table

| Category | Natural Home | Reasoning |
|---|---|---|
| **Inputs** | **A. Ticket metadata** | Instance-specific data bound at request time; currently lives in `workflowInput` or `objective`. |
| **Constraints** | **C. Execution metadata** | Operational envelope enforced by runtime; maps to limits, authority, phase rules. |
| **Success Criteria** | **B. Workflow metadata** | Completion contract checked after orchestration; analog to postconditions. |
| **Evidence Requirements** | **B. Workflow metadata** | Output quality contract; checked as part of completion verification. |
| **Stakeholders** | **A. Ticket metadata** | Instance-specific routing and notification context. |

---

## Observed Gap

Four of the five categories have a natural home in the current system. **Success Criteria** and **Evidence Requirements** both map to workflow metadata, which means:

- For **workflow execution mode**, they have a plausible home in `postconditions` (though current postconditions are substrate-level, not semantic).
- For **agent execution mode**, they have no structured home at all; they must be embedded in the `objective` string and are invisible to the system.

This asymmetry — where completion verification exists for workflows but not for agent direct-action — is a structural gap in the current architecture, not a missing metadata field.

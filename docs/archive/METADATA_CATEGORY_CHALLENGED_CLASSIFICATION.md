# Challenged Metadata Classification

## Full-Context Re-evaluation

This re-evaluation uses the complete investigation — Business Work Primitives, Cognitive Primitives, hybrid work classification, workflow compatibility, and ticket gap analysis — to determine where each metadata category most naturally belongs.

The four candidate layers:

1. **Ticket Instance** — A single work request (`objective`, `assignment`, `workflowInput`, `status`).
2. **Business Work Definition** — The reusable definition of a work type (`name`, `objectiveTemplate`, `inputSchema`, `successCriteria`, `constraintPolicies`).
3. **Workflow / Orchestration** — The deterministic execution graph (`actions`, `next`, `postconditions`).
4. **Execution Runtime** — The system that enforces limits, tracks phases, and manages authority (`maxExecutionSteps`, `allowedOperations`, `phaseTransitions`).

---

## 1. Inputs

**Previous classification:** Ticket metadata (values only).

**Challenged classification:** Split — **Business Work Definition** for the schema, **Ticket Instance** for the bound values. The category as a concept is anchored at the **Business Work Definition**.

**Reasoning:**

The investigation defined each Business Work Primitive with explicit Inputs (e.g., Investigate Anomaly: "Alert signal, current operational context, historical pattern library, investigation mandate"). These are not instance-specific inventions; they are characteristic of the primitive type. The product shape placed "input fields" in the Playbook (Business Work Definition) and "bound inputs" in the Work Order (Ticket Instance).

The Cognitive Primitive layer reinforces this: Observe takes "Observation target specification, prior context window, sensory or data channel reference." The input schema is part of the primitive's contract.

However, the actual data values (alert ID "ALERT-2847", specific intake text) are bound per instance and belong to the Ticket Instance.

**Why not Workflow / Orchestration?** The workflow `inputSchema` describes types for the 20% of work that uses workflow mode. Eighty percent of work (hybrid + agent-first) does not use workflows. If input schema lived only in workflows, the majority of work would have no structured input home.

**Why not Execution Runtime?** The runtime consumes inputs but does not define what inputs a primitive requires.

**Most natural layer:** The schema belongs to **Business Work Definition**; the values belong to **Ticket Instance**. The category is fundamentally anchored at the Business Work Definition because the schema characterizes the primitive.

---

## 2. Constraints

**Previous classification:** Execution metadata.

**Challenged classification:** **Business Work Definition** for default policies; **Ticket Instance** for instance overrides; enforcement belongs to **Execution Runtime**. The category as a concept is anchored at the **Business Work Definition**.

**Reasoning:**

The investigation found that constraints are predictable structure that should be encoded statically (Predicting Parameters thesis). The product shape explicitly placed "Constraint policies (time bounds, authority limits, arbitration rules)" in Playbooks (Business Work Definition). Work Orders inherit these defaults and can override them per instance.

From the Business Work Primitive definitions:
- Remediate Service Degradation has "remediation constraints, rollback policy, safety boundaries"
- Scope Initiative has "strategic constraints, capacity estimates, risk appetite, dependency map"
- These constraints characterize the primitive type, not the individual ticket.

The Execution Runtime enforces whatever constraints are active (maxExecutionSteps, maxRuntimeDurationMs, allowedOperations), but it does not originate them. Enforcement is downstream of definition.

**Why not purely Execution Runtime?** The current system places all constraints in the runtime, but the investigation identified this as a gap: constraints are currently invisible to users and cannot be customized per primitive type. The Adaptation thesis argues that predictable structure should be user-configurable, not hard-coded.

**Most natural layer:** Default constraint policies belong to **Business Work Definition**; instance overrides belong to **Ticket Instance**; enforcement belongs to **Execution Runtime**. The category is anchored at the Business Work Definition because constraints characterize the operational envelope of the work type.

---

## 3. Success Criteria

**Previous classification:** Workflow metadata.

**Challenged classification:** **Business Work Definition**.

**Reasoning:**

The previous classification mapped success criteria to workflow `postconditions`. This was a mistake.

The investigation found that **all 20 Business Work Primitives have success criteria**, but only **20% of primitives are workflow-first**. The remaining 80% (55% hybrid + 25% agent-first) do not use workflow execution mode. If success criteria lived in Workflow / Orchestration, the majority of work would have no structured completion contract.

The product shape explicitly placed success criteria in the Playbook (Business Work Definition), not in the workflow. Work Orders can optionally override them per instance.

From the primitive definitions:
- Investigate Anomaly: "Root cause is identified and cited; impact is quantified; recommendation is actionable"
- Finalize Go/No-Go Decision: "Criteria are explicitly addressed; decision is unambiguous; dissent is preserved"
- These criteria define what the primitive promises to deliver. They are part of the primitive's identity.

The Cognitive Primitive layer confirms this: Verify produces "Pass/fail verdict, evidence excerpt, deviation magnitude" — but what constitutes "pass" is defined by the work's success criteria, not by the orchestration.

**Why not Workflow / Orchestration?** Postconditions check substrate state (file exists, contains string). Success criteria are semantic ("report contains cited evidence"). They operate at different layers.

**Why not Execution Runtime?** The runtime checks authority and limits, not business correctness.

**Most natural layer:** **Business Work Definition**.

---

## 4. Evidence Requirements

**Previous classification:** Workflow metadata.

**Challenged classification:** **Business Work Definition**.

**Reasoning:**

Same structural argument as Success Criteria. Evidence requirements ("cited evidence," "provenance map," "attestation trail") are quality contracts on the output. They characterize the primitive type, not the orchestration path.

From the primitive definitions:
- Synthesize Intelligence: "All sources are represented; contradictions are resolved or explicitly noted; confidence is calibrated"
- Audit Control Effectiveness: "Every control is tested; gaps are evidenced; recommendations are proportionate; attestation is independently verifiable"

These requirements exist for all 20 primitives, but only 20% use workflows. Placing them in Workflow / Orchestration would strand 80% of work without structured evidence contracts.

The Cognitive Primitive layer treats evidence as part of the reasoning grammar: Verify requires "evidence snippet directly quoted from the target;" Commit requires "complete audit trail reference." These are universal requirements, not workflow-specific.

**Most natural layer:** **Business Work Definition**.

---

## 5. Stakeholders

**Previous classification:** Ticket metadata.

**Challenged classification:** **Ticket Instance**.

**Reasoning:**

This classification survives the challenge.

Stakeholders are instance-specific routing context. Who is involved in a particular escalation, negotiation, or coordination task varies from ticket to ticket. The primitive definition may say "notify stakeholders," but the actual people are bound per request.

From the product shape: "Stakeholder Routing" was explicitly placed on the Work Order (Ticket Instance).

From the gap analysis: Stakeholders had no natural home in the current system because `assignmentTargetType` / `assignmentTargetId` only captures the primary assignee. Multi-party work (Coordinate, Resolve, Negotiate) requires additional routing that is specific to the request.

**Why not Business Work Definition?** A primitive definition can say "this primitive involves stakeholders," but it cannot name the specific people for a particular instance.

**Why not Workflow / Orchestration?** Orchestration routes between steps, not between people.

**Why not Execution Runtime?** The runtime enforces authority, but authority is about permissions, not stakeholder identity.

**Most natural layer:** **Ticket Instance**.

---

## Summary

| Category | Previous Classification | Challenged Classification | Reasoning |
|---|---|---|---|
| **Inputs** | Ticket metadata | **Business Work Definition** (schema) + **Ticket Instance** (values) | Input schema defines what a primitive consumes; characteristic of the work type. Values are bound per instance. |
| **Constraints** | Execution metadata | **Business Work Definition** (default policies) + **Ticket Instance** (overrides) + **Execution Runtime** (enforcement) | Constraint policies characterize the primitive's operational envelope; predictable structure belongs in the definition. |
| **Success Criteria** | Workflow metadata | **Business Work Definition** | Completion contract defines the primitive; 80% of work does not use workflows, so workflow postconditions cannot be the natural home. |
| **Evidence Requirements** | Workflow metadata | **Business Work Definition** | Output quality contract defines the primitive; universal across all execution modes. |
| **Stakeholders** | Ticket metadata | **Ticket Instance** | Routing and notification context is specific to the work request. |

---

## Key Correction

The most significant correction is **Success Criteria** and **Evidence Requirements**.

The previous classification mapped both to Workflow / Orchestration because the current system only provides postconditions at the workflow layer. The full investigation revealed that this is a structural artifact of the current implementation, not the natural architecture. These categories belong to the **Business Work Definition** because they define what a primitive promises to deliver, independent of whether that delivery is achieved through workflow orchestration, agent reasoning, or hybrid execution.

Placing them in Workflow / Orchestration would mean 80% of operational work has no structured completion contract.

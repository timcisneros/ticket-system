# Work Primitive to Current Ticket Gap Analysis

## Current Ticket Schema

The existing ticket abstraction (`data/tickets.json`, `server.js`) provides the following fields for expressing work:

- `objective` (free-text string)
- `assignmentTargetType` / `assignmentTargetId` (who performs the work)
- `assignmentMode` (how scope is determined: individual, allocated, dynamic)
- `ownedOutputPaths` (workspace paths owned by this ticket)
- `status` (open, in_progress, completed, failed, closed)
- `executionMode` (agent or workflow)
- `workflowId` / `workflowInput` (if workflow execution)
- `capabilityType` / `capabilityId` / `capabilityInput`
- Audit fields (`createdBy`, `changedBy`, timestamps)

The ticket's primary expressive field is `objective`: a single free-text string that must carry the entire intent, inputs, constraints, success criteria, and context of the work.

---

## Individual Primitive Mapping

### 1. Investigate Anomaly

**Current ticket expression:**
```
objective: "Investigate anomaly ALERT-2847 in production auth service. 
Check logs, traces, and recent deployments. Determine root cause 
and impact. Return a report with timeline and evidence."
executionMode: "agent"
```

**Fits naturally:** Assignment to agent; open-ended objective text.

**Awkward:** The alert signal, affected scope, confidence threshold, and evidence requirements are all crammed into `objective`. The ticket has no way to separate "what happened" (input) from "what to deliver" (output expectation).

**Missing:** Structured input binding for alert ID / signal data; explicit success criteria ("report contains timeline, impact, and cited evidence"); time-bounded investigation window.

---

### 2. Remediate Service Degradation

**Current ticket expression:**
```
objective: "Remediate service degradation in checkout API. 
Restore p95 latency to <200ms. Do not restart payment processor. 
Verify stability for 10 minutes before marking complete."
executionMode: "agent"
```

**Fits naturally:** Assignment to agent; degradation description in objective.

**Awkward:** Performance baseline, remediation constraints, safety boundaries, and verification window are all inline prose. The ticket cannot express "rollback if this fails" or "stability verification is part of completion criteria."

**Missing:** Baseline metrics reference; rollback policy; safety constraints; post-remediation verification criteria; stability window duration.

---

### 3. Draft Operational Policy

**Current ticket expression:**
```
objective: "Draft a data retention policy covering EU customer data. 
Must comply with GDPR Article 5, align with existing privacy policy, 
include exception handling for legal holds, and be reviewable by legal."
executionMode: "agent"
```

**Fits naturally:** Assignment to agent; topic in objective.

**Awkward:** Stakeholder requirements, regulatory constraints, exception scenarios, and existing corpus references are all interleaved in a prose blob. The ticket cannot express "compare against existing policy X" as a separate input.

**Missing:** Regulatory framework reference; existing policy corpus reference; stakeholder list; output format requirement; acceptance criteria (internal consistency, coverage check).

---

### 4. Resolve Escalation

**Current ticket expression:**
```
objective: "Resolve escalation: Team A and Team B both claim ownership 
of the billing migration. Priority framework says infrastructure > product. 
Resource inventory shows both teams at capacity. Decide ownership and 
unblock the migration. Inform both teams."
executionMode: "agent"
```

**Fits naturally:** Assignment to agent; conflict description in objective.

**Awkward:** Stakeholder positions, priority framework, resource constraints, and communication requirements are forced into a single narrative. The ticket has no field for competing alternatives or decision criteria.

**Missing:** Competing alternatives with cited evidence; decision criteria weights; stakeholder routing; dissent preservation requirement; precedent reference.

---

### 5. Synthesize Intelligence

**Current ticket expression:**
```
objective: "Synthesize intelligence from sources: incident report IR-12, 
threat feed TF-99, and internal assessment Q2-sec. Produce unified 
intelligence product with confidence assessment and knowledge gaps."
executionMode: "agent"
```

**Fits naturally:** Assignment to agent; synthesis topic in objective.

**Awkward:** Source references, reliability ratings, and timeliness constraints are embedded in prose. The ticket cannot bind multiple named inputs.

**Missing:** Named source inputs with reliability scores; synthesis mandate; timeliness constraint; confidence threshold; output format and provenance requirements.

---

### 6. Scope Initiative

**Current ticket expression:**
```
objective: "Scope initiative: build automated compliance reporting. 
Must fit within 6 weeks, use existing data warehouse, not require 
new infrastructure. Acceptance criteria: generates SOC2 report 
automatically, covers all 5 trust principles. Exclusions: no UI, 
no real-time alerting."
```

**Fits naturally:** Assignment to agent; initiative topic in objective.

**Awkward:** In-scope list, out-of-scope list, acceptance criteria, and constraints are all inline. The ticket conflates "what to scope" with "what the scope should exclude."

**Missing:** Separate in-scope and out-of-scope fields; acceptance criteria checklist; effort estimate field; risk register; explicit success condition ("scope is testable").

---

### 7. Audit Control Effectiveness

**Current ticket expression:**
```
objective: "Audit control effectiveness for access controls AC-1 through AC-12. 
Use SOC2 framework. Evidence window: Q2 2026. Tolerance: no more than 
2 minor gaps. Produce attestation and remediation recommendations."
```

**Fits naturally:** Assignment to agent; audit topic in objective. Could use `executionMode: "workflow"` with a postcondition checklist.

**Awkward:** Control definitions, compliance framework, evidence window, and tolerance are all prose. Postconditions can check file existence but cannot express "no more than 2 minor gaps."

**Missing:** Control inventory reference; compliance framework reference; evidence window; sampling strategy; gap severity taxonomy; attestation requirements.

---

### 8. Deploy Configuration Change

**Current ticket expression:**
```
objective: "Deploy configuration change: enable new rate limiter in 
prod-us-east. Pre-conditions: feature flag 'ratelimiter-v2' is off. 
Post-conditions: flag is on, p99 latency < 100ms, no 5xx spike. 
Rollback if post-conditions fail."
executionMode: "workflow"
workflowId: "deploy-config-change"
workflowInput: { config: "ratelimiter-v2", target: "prod-us-east" }
```

**Fits naturally:** Workflow mode maps well; `workflowInput` carries structured config.

**Awkward:** Pre-conditions, post-conditions, and rollback policy are all in the `objective` string. The workflow has postconditions, but they are substrate checks (file exists, contains string), not system-state checks like "p99 latency < 100ms."

**Missing:** Pre-condition specification; rollback plan reference; impact analysis; approval record reference; safety boundary specification.

---

### 9. Reconcile Discrepancies

**Current ticket expression:**
```
objective: "Reconcile discrepancies between billing system total ($45,200) 
and payment processor total ($44,800). Reconciliation rule: payment 
processor wins. Tie-breaker: use processor timestamp. Document deviations 
and adjust source reliability scores."
```

**Fits naturally:** Assignment to agent; discrepancy description in objective.

**Awkward:** Conflicting sources, reconciliation rules, and tie-breaker hierarchy are forced into narrative form. The ticket cannot express "Source A says X, Source B says Y" as structured inputs.

**Missing:** Named conflicting sources with values; reconciliation rule specification; tie-breaker hierarchy; source reliability history.

---

### 10. Finalize Go/No-Go Decision

**Current ticket expression:**
```
objective: "Finalize go/no-go decision for v2.3 launch. Gate criteria: 
all P0 bugs closed, performance regression < 5%, security review passed. 
Consider stakeholder input from eng, product, and security. Document 
dissent and reversal conditions."
```

**Fits naturally:** Assignment to agent; decision topic in objective.

**Awkward:** Gate criteria, stakeholder weights, dissent requirement, and reversal conditions are all prose. The ticket has no field for criteria weights or decision record.

**Missing:** Criteria checklist with weights; stakeholder input attachments; dissent preservation requirement; reversal conditions; consequence predictions.

---

### 11. Assess Operational Risk

**Current ticket expression:**
```
objective: "Assess operational risk for upcoming cloud migration. 
Threat landscape: vendor lock-in, data loss, downtime. Asset inventory 
in wiki. Control posture: backup daily, DR tested monthly. Tolerance: 
RTO < 4 hours, RPO < 1 hour. Produce risk register with mitigations."
```

**Fits naturally:** Assignment to agent; risk topic in objective.

**Awkward:** Threat landscape, asset inventory, control posture, and tolerance thresholds are all inline. The ticket cannot reference an external asset inventory or control registry.

**Missing:** Threat landscape reference; asset inventory reference; control posture reference; risk taxonomy; tolerance thresholds; output format (risk register schema).

---

### 12. Produce Status Report

**Current ticket expression:**
```
objective: "Produce status report for Q2 engineering. Reporting period: 
April 1 - June 30. Audience: executive team. Data sources: Jira, GitHub, 
CI/CD dashboard. Template: executive summary, milestones, blockers, 
next quarter forecast. Flag exceptions > 1 week delay."
```

**Fits naturally:** Assignment to agent; reporting topic in objective.

**Awkward:** Reporting period, audience, data sources, template constraints, and exception thresholds are all prose. The ticket cannot bind multiple data sources.

**Missing:** Reporting period; audience requirements; named data source references; template constraints; exception threshold; output format specification.

---

### 13. Validate System Integrity

**Current ticket expression:**
```
objective: "Validate system integrity for inventory service. Invariants: 
stock count >= 0, SKU uniqueness, price > 0. Dependency map in service 
wiki. Variance allowance: transient negative stock allowed during checkout 
for 30 seconds. Severity ranking required."
```

**Fits naturally:** Assignment to agent; validation topic in objective. Could use workflow mode with postconditions.

**Awkward:** Invariant definitions, dependency map, and variance allowances are prose. Postconditions can check files but not service invariants like "stock count >= 0."

**Missing:** Invariant registry reference; dependency map reference; variance allowances; severity schema; historical anomaly pattern reference.

---

### 14. Coordinate Cross-Functional Action

**Current ticket expression:**
```
objective: "Coordinate cross-functional action: launch security audit 
across eng, infra, and compliance. Party capability: eng handles code 
review, infra handles access logs, compliance handles policy review. 
Deadline: July 15. Escalation path: PM if blocked > 3 days."
```

**Fits naturally:** Assignment to agent; coordination topic in objective.

**Awkward:** Party capabilities, communication protocol, deadline, and escalation path are all prose. The ticket assigns to a single agent but describes multi-party work. `createHandoffTask` exists in the runtime but is not reflected in the ticket schema.

**Missing:** Party inventory with capabilities; communication protocol; checkpoint schedule; deadline; escalation path; integration criteria.

---

### 15. Curate Reference Knowledge

**Current ticket expression:**
```
objective: "Curate reference knowledge for on-call runbooks. Artifacts: 
wiki pages tagged 'runbook'. Currency rule: updated within 6 months. 
Quality bar: contains symptoms, diagnosis steps, and remediation. 
Deprecation policy: archive if unused > 12 months."
```

**Fits naturally:** Assignment to agent; curation topic in objective.

**Awkward:** Artifact set, currency rules, quality bar, and deprecation policy are prose. The ticket cannot express "inspect these 15 artifacts and apply this quality rubric to each."

**Missing:** Artifact inventory reference; currency rules; quality bar specification; deprecation policy; usage telemetry reference.

---

### 16. Negotiate Service Terms

**Current ticket expression:**
```
objective: "Negotiate service terms with vendor Alpha for CDN services. 
Requirements: 99.99% uptime SLA, <50ms global latency, $5k/month cap. 
Fallback: current vendor renews at +10%. Negotiation bounds: max $6k, 
min 99.9% SLA. Document agreed terms and exception clauses."
```

**Fits naturally:** Assignment to agent; negotiation topic in objective.

**Awkward:** Requirements, fallback terms, negotiation bounds, and exception clauses are all interleaved. The ticket has no field for counterparty input or multi-turn conversation state.

**Missing:** Counterparty reference; requirements specification; fallback terms; negotiation bounds; precedent agreements; performance thresholds.

---

### 17. Review Output Quality

**Current ticket expression:**
```
objective: "Review output quality for Q2 compliance report. Acceptance 
criteria: covers all 5 trust principles, cites evidence, no unresolved 
findings. Review rubric: executive summary, control descriptions, 
evidence mapping, gap analysis. Defects must be reproducible."
```

**Fits naturally:** Assignment to agent; review topic in objective.

**Awkward:** Acceptance criteria, review rubric, and defect requirements are prose. The ticket cannot reference the work product being reviewed as a distinct input.

**Missing:** Work product reference; acceptance criteria checklist; review rubric; prior defect pattern reference; safety classification; rework instruction format.

---

### 18. Transition Operational State

**Current ticket expression:**
```
objective: "Transition operational state from legacy-auth to new-auth. 
Source: legacy-auth service. Target: new-auth service. Transition protocol: 
blue-green with 1-hour canary. Data migration: user sessions table. 
Continuity: no session loss. Fallback: revert DNS if error rate > 0.1%."
```

**Fits naturally:** Assignment to agent; transition topic in objective. Could use workflow mode.

**Awkward:** Source state, target state, protocol, migration requirements, continuity constraints, and fallback are all prose. The ticket cannot express "if error rate > 0.1%, execute fallback" as a structured condition.

**Missing:** Source state reference; target state reference; transition protocol reference; data migration requirements; continuity constraints; fallback activation criteria.

---

### 19. Preserve Institutional Record

**Current ticket expression:**
```
objective: "Preserve institutional record for Q2 board decision on 
cloud migration. Recordable artifacts: decision memo, risk assessment, 
dissent notes. Retention: 7 years. Access: board and legal only. 
Audit requirement: tamper-evident storage."
```

**Fits naturally:** Assignment to agent; archival topic in objective. Could use workflow mode.

**Awkward:** Artifacts, retention policy, access classification, and audit requirements are prose. The ticket cannot bind multiple artifacts or express access rules.

**Missing:** Artifact inventory reference; retention policy reference; access classification; audit requirements; archival destination; integrity standard.

---

### 20. Clarify Ambiguous Mandate

**Current ticket expression:**
```
objective: "Clarify ambiguous mandate: leadership said 'improve 
customer experience.' Scope: does this include billing, support, or 
product? Constraints: no new headcount, 3-month timeline. Precedent: 
Q1 'improve reliability' included only infrastructure. If unclarifiable, 
reject with rationale."
```

**Fits naturally:** Assignment to agent; the objective IS the ambiguous mandate.

**Awkward:** The ticket is asking for clarification of itself. Raw mandate, constraints, precedent, and rejection criteria are all in the same field. The ticket has no separation between "the unclear request" and "the clarified output."

**Missing:** Raw mandate field (separate from objective); clarification protocol; stakeholder contact map; constraint hierarchy; precedent catalog reference; rejection criteria.

---

## Summary Table

| # | Business Work Primitive | Fits Current Ticket | Missing Metadata | Awkward Representation |
|---|---|---|---|---|
| 1 | Investigate Anomaly | Objective + assignment | Alert signal, evidence threshold, time bounds, success criteria | Alert context forced into prose |
| 2 | Remediate Service Degradation | Objective + assignment | Baseline metrics, rollback policy, safety constraints, verification window | Performance targets and constraints inline |
| 3 | Draft Operational Policy | Objective + assignment | Regulatory refs, existing corpus, stakeholders, output format, acceptance criteria | Multi-source requirements as narrative |
| 4 | Resolve Escalation | Objective + assignment | Competing alternatives, criteria weights, stakeholder routing, dissent preservation | Conflict context as single text blob |
| 5 | Synthesize Intelligence | Objective + assignment | Named sources, reliability scores, confidence threshold, provenance requirements | Source references embedded in prose |
| 6 | Scope Initiative | Objective + assignment | In-scope list, out-of-scope list, acceptance criteria, effort estimate, risk register | Scope definition conflated with exclusions |
| 7 | Audit Control Effectiveness | Objective + assignment (or workflow) | Control inventory, compliance framework, evidence window, severity taxonomy | Audit methodology as narrative |
| 8 | Deploy Configuration Change | Workflow mode + workflowInput | Pre-conditions, rollback plan, impact analysis, approval record, safety boundaries | Pre/post/rollback as prose in objective |
| 9 | Reconcile Discrepancies | Objective + assignment | Conflicting sources with values, reconciliation rules, tie-breaker hierarchy | Source values and rules inline |
| 10 | Finalize Go/No-Go Decision | Objective + assignment | Criteria checklist with weights, stakeholder input, dissent record, reversal conditions | Decision criteria as prose narrative |
| 11 | Assess Operational Risk | Objective + assignment | Threat landscape, asset inventory, control posture, risk taxonomy, tolerance thresholds | Risk context as monolithic text |
| 12 | Produce Status Report | Objective + assignment | Reporting period, audience, data sources, template constraints, exception threshold | Report parameters all inline |
| 13 | Validate System Integrity | Objective + assignment (or workflow) | Invariant registry, dependency map, variance allowances, severity schema | System properties as prose |
| 14 | Coordinate Cross-Functional Action | Objective + assignment | Party capabilities, communication protocol, checkpoint schedule, deadline, escalation path | Multi-party work assigned to single agent |
| 15 | Curate Reference Knowledge | Objective + assignment | Artifact inventory, currency rules, quality bar, deprecation policy, usage telemetry | Quality criteria as narrative |
| 16 | Negotiate Service Terms | Objective + assignment | Counterparty reference, requirements, fallback terms, negotiation bounds, precedent agreements | Multi-turn context in single text |
| 17 | Review Output Quality | Objective + assignment | Work product reference, acceptance criteria, review rubric, prior defect patterns | Rubric and criteria inline |
| 18 | Transition Operational State | Objective + assignment (or workflow) | Source/target state, transition protocol, migration requirements, continuity constraints, fallback criteria | Complex state machine as prose |
| 19 | Preserve Institutional Record | Objective + assignment (or workflow) | Artifact inventory, retention policy, access classification, audit requirements, archival destination | Multi-artifact archival as narrative |
| 20 | Clarify Ambiguous Mandate | Objective + assignment | Raw mandate field, clarification protocol, stakeholder map, constraint hierarchy, precedent catalog, rejection criteria | Ticket asks to clarify itself |

---

## Aggregate Gap Analysis

### What Fits Naturally

- **Single-agent assignment.** The current ticket's `assignmentTargetType` / `assignmentTargetId` cleanly maps to assigning a Business Work Primitive to an agent.
- **Free-text intent.** The `objective` field can absorb any business intent, no matter how complex, as a prose string.
- **Workflow binding.** For the 20% of primitives that are procedural, `executionMode: "workflow"` with `workflowId` / `workflowInput` provides a clean execution path.
- **Status lifecycle.** `status` (open → in_progress → completed / failed / closed) covers the terminal states of any work primitive.
- **Audit trail.** `createdBy`, `changedBy`, timestamps provide basic provenance.

### What Is Awkward

- **The objective as a universal catch-all.** Every primitive forces structured information (inputs, criteria, constraints, context) into a single free-text field. This makes objectives verbose, error-prone, and unparseable.
- **No separation of inputs from intent.** The ticket conflates "what the work is about" with "what evidence to use." For Investigate, the alert signal is an input, not part of the intent.
- **No success criteria field.** All 20 primitives have acceptance criteria, but they must be embedded in the `objective` string. The system cannot verify completion against them because they are not machine-readable.
- **No constraint expression.** Safety boundaries, time windows, rollback policies, and resource limits are inline prose. The runtime cannot enforce them structurally.
- **Multi-party work assigned to one agent.** Coordinate, Resolve Escalation, and Negotiate describe work involving multiple parties, but the ticket assigns to a single agent. The agent must internalize all coordination.
- **No output specification.** The ticket describes what to do but not what to produce (report schema, decision record format, attestation structure). Output expectations are prose.

### What Has No Natural Home

| Missing Concept | Primitives Affected | Why It Matters |
|---|---|---|
| **Structured input binding** | 1, 2, 3, 5, 7, 8, 9, 11, 12, 13, 14, 15, 17, 18, 19, 20 | The ticket cannot declare "use these 3 sources" or "apply this rubric" as first-class references. |
| **Success / acceptance criteria** | All 20 | No field exists for pass/fail conditions at the business level. Only substrate postconditions exist for workflow mode. |
| **Constraint specification** | 2, 3, 6, 8, 10, 11, 14, 16, 18 | Time bounds, safety boundaries, resource limits, and negotiation bounds have no structured expression. |
| **Rollback / reversal conditions** | 2, 8, 10, 18 | No field for "undo if X" or "reversible until Y." |
| **Stakeholder / party references** | 3, 4, 6, 10, 14, 16, 20 | Multi-party context is prose, not structured routing. |
| **Work product reference** | 8, 17, 18, 19 | The ticket cannot reference the artifact being acted upon (e.g., "review THIS report" or "deploy THIS config"). |
| **Evidence / provenance requirements** | 1, 3, 5, 7, 10, 12 | No field for "cite evidence" or "trace sources." |
| **Rejection / exit criteria** | 6, 20 | No field for "fail if unclarifiable" or "reject if criteria unmet." |

---

## Overall Assessment

### Is the current ticket abstraction sufficient?

**For execution: Yes.** The current ticket can request any of the 20 Business Work Primitives. The `objective` field is infinitely flexible, `assignmentTargetType` / `assignmentTargetId` handles assignment, and `executionMode` / `workflowId` handles procedural work. No primitive is unexpressible.

**For definition: No.** The current ticket abstraction conflates five distinct concepts into one field:

1. **Intent** (what to do)
2. **Inputs** (what evidence to use)
3. **Constraints** (what boundaries to respect)
4. **Success criteria** (what completion looks like)
5. **Context** (who else is involved, what precedents apply)

Because these are all prose inside `objective`, the system cannot:
- Verify completion against business acceptance criteria (only substrate postconditions exist)
- Select execution strategy based on work type (the system infers from free text)
- Reuse work definitions (every ticket reinvents the prose)
- Route to appropriate capabilities (stakeholder routing, escalation paths are invisible)
- Enforce constraints structurally (time bounds, safety limits are advisory prose)

**The gap is not in execution capability. The gap is in expressiveness.** The ticket is a sufficient work request but an insufficient work definition.

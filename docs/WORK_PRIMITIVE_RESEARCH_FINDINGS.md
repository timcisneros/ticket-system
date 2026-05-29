# Work Primitive Research Findings

## What Was Investigated

The investigation explored whether Business Work Primitives constitute a new semantic layer above workflows, or whether they indicate that workflows are the wrong abstraction for operational AI work. The investigation examined:

- A proposed catalog of 20 candidate Business Work Primitives.
- A proposed catalog of 10 Cognitive Primitives (Observe, Diagnose, Scope, Plan, Execute, Verify, Repair, Synthesize, Arbitrate, Commit).
- The existing ticket system's workflow engine implementation (`data/workflows.json`, runtime code in `server.js`).
- Historical execution patterns in the existing ticket and run data.

The investigation did not include user studies, benchmarks, prototype tests, or comparative experiments. All conclusions are derived from conceptual classification and code inspection.

---

## Findings

These statements are directly supported by the investigation.

1. **A catalog of 20 candidate Business Work Primitives was identified**, ranging from "Investigate Anomaly" to "Clarify Ambiguous Mandate."

2. **A catalog of 10 Cognitive Primitives was proposed** (Observe, Diagnose, Scope, Plan, Execute, Verify, Repair, Synthesize, Arbitrate, Commit).

3. **All 20 Business Work Primitives were expressible as compositions of the 10 Cognitive Primitives.** No additional cognitive primitive was required to cover the 20 business cases.

4. **Classification against the current workflow implementation yielded:**
   - 4 workflow-first primitives (20%): Deploy Configuration Change, Validate System Integrity, Transition Operational State, Preserve Institutional Record.
   - 11 agent-first primitives (55%): Investigate Anomaly, Draft Operational Policy, Resolve Escalation, Synthesize Intelligence, Scope Initiative, Reconcile Discrepancies, Finalize Go/No-Go Decision, Assess Operational Risk, Negotiate Service Terms, Review Output Quality, Clarify Ambiguous Mandate.
   - 5 hybrid primitives (25%): Remediate Service Degradation, Audit Control Effectiveness, Produce Status Report, Coordinate Cross-Functional Action, Curate Reference Knowledge.

5. **Classification against a conceptual workflow engine** (capable of loops, bounded agent execution steps, and handoff suspension) yielded:
   - 4 workflow-first (20%).
   - 5 agent-first (25%).
   - 11 hybrid (55%).

6. **The current workflow engine stores definitions** in `data/workflows.json` as ordered `actions` arrays with deterministic branching via `next`, `trueNext`, and `falseNext` fields.

7. **The current workflow engine's available actions** are `writeFile`, `agentStructuredOutput`, `condition`, and `stop`.

8. **The current workflow engine does not support** iteration, dynamic step generation, suspension for external events, or bounded agent execution phases.

9. **Historical ticket data** (`data/workflows.json`) shows the majority of executed tickets use `executionMode: "agent"` with `capabilityId: "agent-selected-actions"`, not `executionMode: "workflow"`.

10. **The existing runtime enforces execution phases** (planning, inspection, mutation, verification, terminalization) and tracks phase transitions in run events and replay snapshots.

---

## Interpretations

These are conclusions drawn from the findings. They are logical inferences, not proven facts.

1. **The 10 Cognitive Primitives appear to form a stable decomposition grammar for the 20 Business Work Primitives investigated.** Whether this stability holds for operational domains outside the ones examined (e.g., infrastructure operations, healthcare, logistics) is unknown.

2. **The shift from 55% agent-first to 25% agent-first when reclassifying against a richer workflow concept suggests that many primitives are not inherently anti-workflow.** The friction observed may be a property of the current static-graph implementation rather than the workflow abstraction itself.

3. **The 5 irreducibly agent-first primitives share common properties:** they are either pre-work that produces inputs to later orchestration (Scope Initiative, Clarify Ambiguous Mandate) or require open-ended judgment under uncertainty with no useful procedural structure (Resolve Escalation, Finalize Go/No-Go Decision, Negotiate Service Terms).

4. **The dominance of `executionMode: "agent"` in historical ticket data indicates that the existing user base already operates primarily through agent direct-action** rather than through the workflow execution path.

5. **The current workflow engine can express approximately 20% of the candidate primitive catalog without structural strain.** The remaining 80% either require capabilities the engine lacks (55% hybrid) or resist orchestration entirely (25% agent-first).

---

## What Was Not Established

These ideas were investigated but lack supporting evidence.

1. **Whether exposing Cognitive Primitive traces to users improves trust, debuggability, or runtime comprehension.** No user study or proxy metric was gathered.

2. **Whether users would prefer authoring reusable Work Primitive definitions over writing one-off ticket objectives.** No user interviews, prototype tests, or usage data supports this.

3. **Whether semantic success criteria (business-level acceptance conditions) reduce false-positive completions compared to substrate postconditions.** No measurement or experiment was conducted.

4. **Whether the 55/25/20 distribution generalizes** to operational domains outside the ones investigated.

5. **Whether hybrid orchestration (structured phases with agent reasoning inside each phase) reduces agent timeout or failure rates** relative to current free-text objectives.

6. **Whether a semantic layer between the ticket and the runtime improves any measurable outcome** such as reuse rate, completion accuracy, or time-to-result.

---

## Possible Directions

During the investigation, several structural possibilities were identified as potential responses to the observed friction between Business Work Primitives and the current execution surface. These are recorded as unvalidated hypotheses that emerged from the investigation. None are advocated, and none have been tested.

- **Hypothesis: Reusable intent definitions.** If users could define reusable configurations for Business Work Primitives (name, objective template, input schema, success criteria), reuse might increase and objective ambiguity might decrease. Whether this is true is unknown.

- **Hypothesis: Richer orchestration primitives.** If the workflow engine supported bounded agent execution steps, iteration, and handoff suspension, the proportion of work expressible as hybrid might increase from 25% to 55% of the candidate catalog. Whether building these capabilities is justified by usage volume is unknown.

- **Hypothesis: Semantic success criteria.** If success criteria were defined at the business level (e.g., "report contains cited evidence") rather than the substrate level (e.g., "file exists"), completion accuracy might improve. Whether this produces any practical benefit is unknown.

- **Hypothesis: Cognitive trace labeling.** If runtime traces and replay snapshots were labeled with the Cognitive Primitive vocabulary (Observe, Diagnose, Plan, etc.) rather than substrate action names (listDirectory, readFile, writeFile), debuggability might improve. Whether this is useful to users is unknown.

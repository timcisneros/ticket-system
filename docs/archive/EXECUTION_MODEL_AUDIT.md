# Execution Model Audit

## Purpose And Verdict

This audit records the execution model currently implemented and validated by committed milestone work. It is factual and evidence-bound. It is not a proposal document.

Verdict: the execution graph substrate has enough evidence for stabilization and consolidation. The system should not add auto-run, lifecycle rollups, parent waiting semantics, graph schedulers, subworkflow primitives, policy registries, or workspace policy artifacts before consolidating the invariants already proven.

## Implemented Execution Primitives

### Ticket

Purpose: the user-visible unit of requested work. A ticket assigns work to an agent or workflow capability and may be linked to parent/child workflow tickets.

Invariants:

- A ticket has a status and assignment target.
- Workflow tickets carry `executionMode: workflow`, `workflowId`, and `workflowInput`.
- Child tickets created by `executeTicketPlan` are blocked by default and are not auto-run.
- Child tickets preserve parent linkage: `parentTicketId`, `parentRunId`, `parentWorkflowId`, `spawnedByStepId`, `spawnPlanId`, and `spawnIdempotencyKey`.

Replay evidence:

- Ticket creation is recorded in events.
- Child ticket creation is linked from parent run replay through `workflowTicketPlans`.
- Ticket records retain parent/child metadata outside the replay snapshot.

Idempotency behavior:

- After WF-6A, child ticket idempotency is scoped to parent ticket, child workflow id, and stable child identity such as `vendorId`.
- Parent reruns reject duplicate child ticket proposals instead of creating duplicate child tickets.
- Same-run duplicate proposals are rejected through the same idempotency check.

Authority boundary:

- Tickets do not directly mutate the workspace.
- Ticket authority is expressed through assignment, execution mode, workflow input, and runtime-created runs.
- Child ticket creation is constrained by `executeTicketPlan` validation, not arbitrary agent ticket creation.

### Run

Purpose: one execution attempt for a ticket.

Invariants:

- A run is created from an open ticket.
- A run owns execution status, lease state, workflow id/input when applicable, replay snapshot path, logs, events, evaluation, and consequence evidence.
- Terminalized runs should have durable replay finalization and terminalization evidence.
- Startup recovery reconciles completed-but-unfinalized runs.

Replay evidence:

- Run replay snapshots record workflow invocation, workflow actions, action plans, ticket plans, provider requests/responses, workspace operations, and terminalization evidence.
- Append-only events carry run event chains and terminal lifecycle events.

Idempotency behavior:

- Workspace mutation replay/recovery uses mutation fingerprints and operation history to avoid duplicate committed mutations in recovery cases already tested.
- Run identity is no longer the default child ticket idempotency scope after WF-6A.

Authority boundary:

- Runs acquire leases before execution.
- Runtime authority checks gate workspace operations.
- Writer lock enforces one active scheduler/runtime writer per data directory.

### Workflow

Purpose: the bounded work primitive. A workflow defines ordered steps, input schema, policy metadata, task prompt template, verifier contract metadata, postconditions, and execution actions.

Invariants:

- Workflow actions execute through the runtime action catalog.
- Workflow steps are explicit except bounded model-proposed plans handled by `executeActionPlan` and `executeTicketPlan`.
- Workflow policy and verifier contract are metadata, not workspace artifacts.
- Workflow invocation records workflow, policy, and verifier versions plus policy text hash.

Replay evidence:

- `workflowInvocation` records workflow id/version, policy id/version/hash, and verifier contract id/version.
- `workflowActions` records individual workflow step execution.
- Workflow action plans and ticket plans have dedicated replay arrays.

Idempotency behavior:

- Workflow reruns create new runs.
- Child ticket duplicate prevention now persists across parent ticket reruns.
- Workflow output artifact idempotency depends on deterministic paths and existing workspace operation behavior.

Authority boundary:

- Workflows can only use workflow-usable catalog actions.
- Workflow input schema validates declared workflow inputs.
- Workspace mutations still go through existing runtime path checks and protected-path rules.

### executeActionPlan

Purpose: bounded dynamic workspace action execution for model-proposed mutation plans.

Invariants:

- Supported operations are `createFolder` and `renamePath` only.
- `writeFile`, `deletePath`, and arbitrary actions are not part of the validated v1 action plan surface.
- Plans are finite arrays bounded by `maxActions` and `maxMutations`.
- Actions are validated against allowed operations, catalog presence, workflow usability, schemas, mutation budget, and authority checks before execution.

Replay evidence:

- `workflowActionPlans` records proposed, accepted, rejected, and executed actions.
- Executed actions also record workspace operation evidence, operation history, and events.

Idempotency behavior:

- Accepted actions execute once in order for the current workflow step.
- Recovery behavior relies on existing workspace operation history and replay semantics.
- Rejected actions are recorded and not executed.

Authority boundary:

- The primitive is workflow-scoped.
- It uses existing workspace operation authority checks.
- It is not a general escape hatch and cannot write final report artifacts.

### executeTicketPlan

Purpose: bounded child workflow ticket creation from model-proposed ticket plans.

Invariants:

- Creates child workflow tickets only.
- Does not execute child tickets.
- Does not create direct-agent arbitrary tickets.
- Requires allowed workflow ids, existing enabled child workflows, input schema validity, bounded objective, and non-recursive child workflow shape.
- Duplicate child tickets are rejected using parent-ticket-scoped idempotency.

Replay evidence:

- `workflowTicketPlans` records proposed, accepted, rejected, and created tickets.
- Created child ticket ids and validation reasons are recorded in replay.
- Ticket records preserve parent/child metadata.

Idempotency behavior:

- Parent reruns proposing the same child workflow/vendor identities do not create duplicate child tickets.
- Duplicate proposals in the same run are rejected.
- Existing child tickets created before WF-6A were not migrated; no migration was required for observed acceptance tests.

Authority boundary:

- The primitive can only create workflow tickets for allowed workflow ids.
- Child tickets are blocked by default; execution requires explicit manual/test-harness opening today.
- It does not bypass assignment, ticket status, run creation, workflow input validation, or runtime authority.

### Workspace Operations

Purpose: bounded file inspection and mutation inside the configured workspace.

Invariants:

- Workspace operations include `createFolder`, `writeFile`, `renamePath`, `deletePath`, `listDirectory`, and `readFile`.
- Protected paths and owned path checks are enforced by runtime authority.
- Mutating operations record operation history and replay evidence.
- `renamePath` output is aligned with workflow action contract and preserves `status`, `path`, and `historyId` evidence.

Replay evidence:

- Workspace operations are recorded in replay snapshots, operation history, events, logs, evaluation, and consequence surfaces.
- `workspace.operation` events and operation-history records provide audit evidence for mutations.

Idempotency behavior:

- Recovery semantics use mutation fingerprints and operation history for already-validated resume cases.
- Concurrent operations over distinct child artifacts completed without duplicate artifacts in WF-6.
- Overlapping mutation contention is only validated for observed Shared Drive overlap behavior, not as a general coordination model.

Authority boundary:

- Workspace operations are the runtime authority boundary for file reads/writes/moves/deletes.
- Direct agent actions, workflow actions, and `executeActionPlan` all converge on existing workspace operation checks.

### Verifier

Purpose: deterministic external judgment for fixture/workflow success.

Invariants:

- Verifier oracle and manifest remain outside the agent decision context.
- Verifier contract metadata is attached to workflow definitions.
- Verifier checks expected artifacts, decision accuracy, final workspace state, replay evidence, and graph evidence depending on fixture mode.

Replay evidence:

- Replay records verifier contract id and version through `workflowInvocation`.
- Verifier scripts inspect replay snapshots, ticket records, run records, operation history, and workspace artifacts.

Idempotency behavior:

- Verifier does not mutate the graph.
- It can detect duplicate child tickets, duplicate child runs, duplicate artifacts, and missing replay evidence in validated modes.

Authority boundary:

- Verifier is outside runtime authority and outside the workspace decision context.
- It should not be treated as an agent-visible policy source.

## Validated Experiments And Commits

- `e81f1f8` Add workflow policy metadata for Legal Intake: validated workflow-scoped policy, task prompt template, verifier contract metadata, and replay policy/verifier hash evidence.
- `db53a5c` Fit legal intake fixture to read budget: validated an 8-file Legal Intake fixture under current runtime limits.
- `d0bdc86` Add vendor compliance workflow fixture: generalized workflow/policy/verifier architecture to a second review domain.
- `2a3e61d` Document workflow policy verifier architecture: recorded the architecture boundary across Legal Intake and Vendor Compliance.
- `ce4a8c0` Align workspace action outputs with contracts: aligned workspace action output contract evidence for workflow action execution.
- `0f65c46` Add shared drive cleanup workflow fixture: validated mutation workflow behavior with exact final-state verification.
- `9bf9917` Add bounded workflow action plan execution: added `executeActionPlan` and validated bounded dynamic workspace actions.
- `651f6f0` Document dynamic action plan milestone: recorded dynamic Shared Drive Cleanup proof: proposed/accepted/executed action plan evidence and no hardcoded per-file rename steps.
- `509a490` Add vendor remediation workflow chain: validated two separate workflow tickets over the same workspace as manual workflow handoff.
- `cdf119f` Add vendor failure handoff workflow: validated failure handoff through workflow input and verifier evidence.
- `d14aef6` Add bounded workflow ticket plan execution: added `executeTicketPlan`, child ticket metadata, and ticket-plan replay evidence.
- `1cab650` Document child ticket execution milestone: validated manual/test-harness child ticket execution as normal workflow runs with artifacts and graph verifier evidence.
- `ed79b97` Fix child ticket idempotency across parent reruns: fixed parent rerun duplicate child ticket creation and added targeted regression coverage.
- `07fa326` Document execution model: consolidated validated execution model evidence and remaining unknowns.

Validated behaviors:

- Legal Intake workflow policy/verifier metadata.
- Vendor Compliance workflow policy/verifier metadata.
- Shared Drive Cleanup mutation workflow.
- Dynamic Shared Drive Cleanup through `executeActionPlan`.
- Vendor Remediation workflow handoff through separate tickets over the same workspace.
- Vendor failure handoff with deterministic blocker artifacts.
- Child workflow ticket creation through `executeTicketPlan`.
- Manual child ticket execution as normal workflow runs.
- Parent rerun child ticket idempotency after WF-6A.
- Partial child graph completion.
- Concurrent child execution over distinct artifacts.
- Parent crash after child creation using existing interruption/finalization recovery path.

## Known Limitations

- Child tickets do not auto-run.
- No parent waiting semantics are implemented.
- No lifecycle rollup aggregates child status into parent status.
- No automatic chain engine exists.
- No graph scheduler exists.
- No subworkflow primitive exists.
- Large work graphs are untested.
- Concurrent parent/child lifecycle beyond tested cases is untested.
- Long-running chain recovery is untested.
- Child failure aggregation is untested.
- Agent/group assignment for graph work remains future work.
- `executeActionPlan` supports only `createFolder` and `renamePath`.
- Dynamic plan rejected-action recovery is only lightly validated.
- Partial dynamic action plan execution policy is not broadly validated.
- Delete-path dynamic plans are unvalidated.
- Overlapping dynamic plans and overlapping child mutation targets are not validated as a general coordination model.

## Duplicate Concepts / Possible Collapses

- `executionMode`, `workflowId`, and `workflowInput` overlap with `capabilityType`, `capabilityId`, and `capabilityInput` for workflow tickets and runs.
- Ticket status and run status are separate lifecycle concepts, but no parent/child lifecycle rollup exists. The separation is real today, but the boundary should be documented as an invariant.
- Replay snapshots, append-only events, logs, operation history, run evaluation, and run consequence all carry overlapping evidence. The overlap is useful for audit/recovery, but the authoritative source for each evidence type should be clarified.
- Workflow policy metadata and verifier contract metadata are runtime workflow fields, while fixture manifests and verifier oracles live outside the agent workspace. The boundary is validated but easy to confuse in docs and tests.
- `executeActionPlan` and explicit workflow steps both execute workspace actions. The difference is dynamic bounded plan execution versus static step execution.
- `executeTicketPlan` and ordinary ticket creation both persist tickets. The difference is bounded workflow-scoped child ticket creation versus user/operator ticket creation.

## Implemented But Not Fully Justified By Evidence

- Broad direct-agent behavior relative to the workflow graph model has not been revalidated across the same graph scenarios.
- Full action catalog workflow usability is broader than the validated graph experiments.
- Workflow metadata fields beyond policy, task prompt template, verifier contract, and input schema have less business-domain evidence.
- Evaluation and consequence surfaces exist for runs, but complex multi-run graph aggregation has not been validated.
- Recovery behavior is validated for selected run interruption cases and parent crash after child creation, not for long-running multi-level graphs.
- Group assignment and owned-scope allocation exist, but graph experiments used direct agent workflow tickets.
- Metrics and quality scoring exist, but they are not the primary trust surface for the workflow graph evidence.

## Final Recommendation

Stabilize and consolidate execution-model invariants before adding new capabilities.

The current model has enough evidence to support Ticket -> Run -> Workflow -> Plan -> Runtime Validation -> Runtime Execution -> Replay Evidence -> Verifier Judgment, including bounded child ticket creation and manual child execution. The next work should be documentation, invariant tests, and evidence-bound cleanup of duplicate concepts. Do not add auto-run, chain engines, lifecycle rollups, parent waiting semantics, graph schedulers, subworkflow primitives, policy registries, or workspace policy artifacts until the existing model is stabilized.

# Execution Model

## Status

This document records the execution model validated by committed milestone work. It describes the model that has evidence today, not a proposed future architecture.

## Validated Primitives

- Ticket: the unit of requested work. A ticket can invoke a workflow and can be linked to parent/child workflow tickets.
- Run: one execution attempt for a ticket. A run owns execution evidence, replay snapshots, workflow invocation metadata, and terminal status.
- Workflow: the work primitive. A workflow carries ordered steps, policy metadata, task guidance, verifier contract metadata, and input constraints.
- Workspace: the bounded file area containing source materials and produced artifacts. It does not contain policy documents, verifier oracles, or runtime system artifacts beyond fixture manifests used for evaluation.
- Policy metadata: workflow-scoped policy text with id, version, and replayed hash evidence.
- Verifier contract metadata: workflow-scoped verifier identity, version, fixture name, and expected artifact contract.
- Replay/Event evidence: durable evidence for workflow invocation, policy/verifier versions, action execution, workspace operations, terminalization, and recovery.
- executeActionPlan: a bounded workflow action for model-proposed workspace mutations. The validated implementation supports `createFolder` and `renamePath`, validates schemas and budgets, uses existing authority checks, and records accepted/rejected/executed plan evidence.
- executeTicketPlan: a bounded workflow action for creating child workflow tickets. It validates child workflow ids, input schemas, objective bounds, idempotency, and records accepted/rejected/created ticket evidence. It does not run child tickets.

## Rejected Or Not Yet Needed Primitives

- Policy registry: not needed for the validated domains. Policy is workflow metadata.
- Subworkflow primitive: not needed yet. Workflow handoff and remediation can be modeled with separate workflow tickets.
- Automatic chain engine: not needed yet. Manual workflow-to-workflow handoff over the same workspace is sufficient for current evidence.
- Workspace policy artifacts: rejected for current architecture. Policy belongs in workflow metadata, not in the agent workspace.
- Arbitrary agent-assigned ticket spawning: rejected. Ticket creation is only validated through bounded `executeTicketPlan` with allowed workflow ids and child input validation.

## Execution Lifecycle

```txt
Ticket
-> Run
-> Workflow
-> Policy/Verifier context
-> Plan proposal
-> Runtime validation
-> Runtime execution
-> Replay evidence
-> Verifier judgment
```

The workflow supplies policy and verifier context. The model may propose actions or child tickets only through bounded workflow steps. The runtime validates proposals before execution or creation, records the accepted and rejected plan evidence, executes authorized operations, and leaves replay/event evidence for verifier judgment.

## Work Graph Model

```txt
Ticket can create child workflow tickets through executeTicketPlan.
Workflow can mutate workspace through executeActionPlan.
Workflow handoff can be modeled as separate tickets over the same workspace.
```

Current evidence supports an explicit work graph, not an automatic orchestration engine. Parent tickets can create child workflow tickets, and those child tickets can be manually opened and executed as normal workflow runs. Child tickets are still blocked by default and do not auto-run in v1. Multi-stage workflows can be represented as separate tickets that share a workspace and consume prior produced artifacts or supplied failure evidence.

## Evidence Lifecycle

Trust requires durable evidence for:

- workflow id and workflow version
- policy id, policy version, and policy text hash
- verifier contract id and verifier contract version
- accepted, rejected, and executed action plans
- accepted, rejected, and created ticket plans
- workspace operations and operation history, including paths and history ids
- parent/child ticket metadata, including parent ticket id, parent run id, parent workflow id, spawning step id, spawn plan id, and idempotency key
- terminal run status, replay finalization, terminalization, evaluation, and consequence evidence

Verifier judgment is outside the agent workspace. The workspace contains work materials and produced artifacts; the manifest and oracle remain outside the decision context.

## Validated Domains

- Legal Intake: policy and verifier metadata attached to workflow; source materials in workspace; verifier oracle outside workspace.
- Vendor Compliance: same workflow/policy/verifier pattern generalized to a second review domain.
- Shared Drive Cleanup: workflow performed real workspace mutation and artifact production with exact final-state verification.
- Dynamic Shared Drive Cleanup: runtime-discovered mutation set executed through `executeActionPlan` without hardcoded per-file rename steps.
- Vendor Remediation workflow chain: Stage 2 consumed Stage 1 artifacts over the same workspace without a chain primitive.
- Vendor failure handoff: Stage 2 consumed Stage 1 failure evidence and produced deterministic blocker/remediation artifacts.
- Workflow ticket-plan creation: parent workflow created bounded child workflow tickets through `executeTicketPlan` without auto-running them.
- Child ticket execution graph: child workflow tickets created by `executeTicketPlan` were manually opened, executed as normal workflow runs, and produced deterministic remediation artifacts.
- Parent rerun idempotency: after WF-6A, rerunning the parent ticket does not create duplicate child tickets; duplicate proposals are rejected/skipped with replay evidence.
- Partial child graph completion: a graph with 5 child tickets and only 3 completed child runs remained coherent, with lineage intact and remaining children still blocked/open/pending as expected.
- Concurrent child execution: 5 child tickets over distinct remediation artifacts executed concurrently and completed without duplicate artifacts.
- Parent crash after child creation: child tickets persisted across restart with no duplicates using the existing interruption/finalization recovery path.

## Remaining Unknowns

- automatic chaining
- large work graphs
- concurrent parent/child lifecycle beyond tested cases
- long-running chain recovery
- agent/group assignment later
- child failure aggregation
- parent waiting/status rollup
- rejected-action recovery behavior beyond the validated small cases
- partial dynamic plan execution policy
- dynamic plans using operations beyond `createFolder` and `renamePath`

## Recommendation

Pause feature expansion. Consolidate the execution model before WF-5 follow-on work.

The execution graph substrate has enough evidence for consolidation. The validated model now covers ticket/run/workflow execution, workflow-scoped policy and verifier metadata, dynamic workspace action plans, explicit workflow handoff, failure handoff, bounded child ticket creation, manual child ticket execution, parent rerun idempotency, partial child graph completion, concurrent child execution, and restart after child creation.

Do not add auto-run or lifecycle rollups until the execution model is documented and invariant tests are consolidated around the primitives already proven.

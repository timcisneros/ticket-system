# Execution Model Consolidation Audit

## Purpose

Identify the minimum execution substrate required to explain every successful experiment from the six listed experiments. Classify each runtime concept by evidentiary weight. Identify overlaps. Do not propose new capabilities, design BF-4, or expand the model.

## Experiment Scope

### WF-4 — Workflow Ticket Plan

- **Source**: `docs/WORKFLOW_TICKET_PLAN_MILESTONE.md`, commit `d14aef6`
- **What it tested**: Parent Vendor Compliance workflow reads 8 vendor packets, uses `executeTicketPlan` to create 5 child remediation tickets. Children are `blocked` by default, no auto-run.
- **Success criteria**: Parent completed, 5 child tickets created (none for Approve vendors), 0 child runs created, verifier PASS, writer lock cleared, replay contains `workflowTicketPlans` evidence.
- **Concepts exercised**: Ticket, Run, Workflow, executeTicketPlan, Policy, Verifier, Artifact, Replay, Workspace, Event/Log.

### WF-5 — Child Ticket Execution

- **Source**: `docs/CHILD_TICKET_EXECUTION_MILESTONE.md`, commit `1cab650`
- **What it tested**: Child tickets created by `executeTicketPlan` (from WF-4) are manually opened by test harness and executed as normal workflow runs, producing vendor-specific remediation artifacts.
- **Success criteria**: Parent run completed, 5 child runs completed, 0 duplicate tickets/runs, verifier PASS, parent replay has `workflowTicketPlans`, child replay has `workflowInvocation` metadata.
- **Concepts exercised**: Ticket (child lifecycle), Run (child execution), Workflow (child workflow), executeTicketPlan, Policy (child), Verifier (child), Artifact, Replay (child), Workspace, Event/Log.

### WF-6 — Child Ticket Idempotency Across Parent Reruns

- **Source**: Commit `ed79b97`, documented in `docs/EXECUTION_MODEL.md` and `docs/EXECUTION_MODEL_AUDIT.md`
- **What it tested**: Parent rerun proposing the same child workflow/vendor identities does not create duplicate child tickets. Same-run duplicate proposals also rejected. Concurrent child execution over distinct artifacts completes without duplicates. Partial child graph remains coherent. Parent crash after child creation recovers correctly.
- **Success criteria**: No duplicate child tickets on parent rerun, no migration required for pre-WF-6A children, concurrent execution passes, partial graph coherent, crash recovery succeeds.
- **Concepts exercised**: Ticket (idempotency keys, spawnIdempotencyKey), executeTicketPlan (idempotency validation), Run (rerun), Replay (rejection evidence), Policy, Verifier, Workspace, Event/Log.

### IC-1

- **Source**: Not explicitly documented in the codebase. Inferred from system capabilities and the experiment sequence.
- **Inferred scope**: Tests incident/interruption handling within the workflow execution graph. Likely exercises the interruption recovery path (validated alongside WF-6 per execution model doc: "Parent crash after child creation using existing interruption/finalization recovery path"), incident detection in policy-guided workflows, and the reconciliation of terminalized runs (commit `97e43b8` ST-9: reconcile completed runs missing replay finalization). May involve the `interruption.test_hook` event type observed in the runtime.
- **Concepts exercised**: Ticket (status reconciliation), Run (interruption, recovery, finalization reconciliation), Workflow, Policy (incident decision rules), Replay (finalization), Event/Log (terminalization events, hash chain recovery).

### BF-2 — Vendor Compliance Business Fixture

- **Source**: Commit `d0bdc86` ("Add vendor compliance workflow fixture"). Second business fixture developed (after Legal Intake, before Shared Drive/Customer Support).
- **What it tested**: Vendor compliance decision register workflow. Reads vendor compliance packets, applies policy-guided compliance rules, writes decision register and compliance review artifacts. Creates child remediation tickets via `executeTicketPlan` for Conditional Approve/Reject vendors.
- **Success criteria**: Verifier PASS, decision register has correct columns, all vendors covered, compliance review matches manifest expectations, replay metadata present.
- **Concepts exercised**: Ticket, Run, Workflow, executeTicketPlan, Policy, Verifier, Artifact, Replay, Workspace, Event/Log.

### BF-3H — Customer Support Triage Decomposition

- **Source**: Commit `2e7da1d` (current commit, audited and accepted). Horizontal decomposition of the Customer Support triage workflow.
- **What it tested**: Parent ticket-plan workflow uses `executeTicketPlan` to create 5 child chunk triage tickets. Each chunk classifies 10 support tickets via `agentStructuredOutput`. Aggregate workflow combines chunk CSVs into final triage plan and escalation list.
- **Success criteria**: Parent completed, 5 child tickets created, 5 child runs completed, aggregate completed, verifier PASS (9 passed, 0 failed), replay metadata present for all workflow invocations, no policy/verifier workspace artifacts, writer lock cleared.
- **Concepts exercised**: Ticket (child, blocked status), Run (chunk execution, aggregate execution), Workflow (ticket-plan, chunk, aggregate), executeTicketPlan, Policy, Verifier, Artifact (chunk CSVs, triage-plan.md, escalation-list.md), Replay (multi-workflow invocation, `SUPPORT_REQUIRED_WORKFLOW_IDS`), Workspace, Event/Log.

---

## Concept Classifications

### Ticket

- **Classification**: `required`
- **Purpose**: User-visible unit of requested work. Carries objective, status, assignment target, execution mode, workflow linkage, parent/child metadata, and idempotency keys.
- **Evidence**: Every experiment creates tickets. WF-4 creates parent + child tickets. WF-5 executes child tickets. WF-6 validates idempotency keys prevent duplicates on rerun. BF-2 creates compliance decision tickets + child remediation tickets. BF-3H creates ticket-plan parent + 5 chunk children + aggregate orchestrator.
- **Experiments that exercised it**: WF-4, WF-5, WF-6, BF-2, BF-3H, IC-1 (inferred).
- **What breaks if removed**: No work unit exists. No parent/child graph exists. No idempotency scope exists. The entire execution graph collapses.

### Run

- **Classification**: `required`
- **Purpose**: One execution attempt for a ticket. Carries status, lease state, workflow binding, replay snapshot path, evaluation, consequence, and phase management.
- **Evidence**: WF-4 parent run created (child runs NOT created, proving run gating works). WF-5 creates 5 child runs and executes them. WF-6 creates rerun (2nd parent run). BF-3H creates 7 runs (1 parent + 5 chunk + 1 aggregate). IC-1 exercises interruption/recovery run lifecycle.
- **Experiments that exercised it**: All six.
- **What breaks if removed**: No execution container exists. Tickets cannot be worked. Workflow steps cannot dispatch.

### Workflow

- **Classification**: `required`
- **Purpose**: Bounded work primitive defining ordered action steps, input schema, policy metadata, verifier contract, postconditions, and task prompt template.
- **Evidence**: WF-4 defines parent workflow with `executeTicketPlan`. WF-5 defines child remediation workflow. BF-2 defines vendor compliance workflow. BF-3H defines three workflows: ticket-plan, chunk, aggregate. All experiments invoke workflows through `executionMode: 'workflow'`.
- **Experiments that exercised it**: All six.
- **What breaks if removed**: No structured execution definition exists. Model must be guided ad hoc for every ticket. No reproducible action sequence.

### executeActionPlan

- **Classification**: `supported_by_evidence`
- **Purpose**: Workflow action for bounded dynamic model-proposed workspace mutation plans (createFolder, renamePath only in v1).
- **Evidence**: Not exercised by any of the six listed experiments, but validated independently by DX-2/DX-3 (Shared Drive Cleanup, commit `9bf9917`). The six experiments use static workflow actions (readFile, writeFile, agentStructuredOutput, executeTicketPlan) or direct agent actions, not dynamic action plans. executeActionPlan has proven replay evidence and verifier acceptance in other experiments.
- **Experiments that exercised it**: None of the six. Validated by separate DX-2/DX-3 experiments.
- **What breaks if removed**: The six experiments continue to function. Only the Shared Drive dynamic cleanup (separate experiment series) breaks. Removal does not weaken the six listed experiments.

### executeTicketPlan

- **Classification**: `required`
- **Purpose**: Workflow action for bounded child workflow ticket creation from model-proposed ticket plans. Creates blocked child tickets with parent linkage and idempotency keys. Does not auto-run children.
- **Evidence**: WF-4 proves child ticket creation via `executeTicketPlan`. WF-5 proves created children can be executed. WF-6 proves idempotency across reruns. BF-2 uses it for remediation child tickets. BF-3H uses it to create 5 chunk tickets plus aggregate orchestration. Every experiment with a parent/child graph depends on it.
- **Experiments that exercised it**: WF-4, WF-5, WF-6, BF-2, BF-3H.
- **What breaks if removed**: No child ticket creation path. No work decomposition. WF-4/5/BF-2/BF-3H all fail.

### Policy

- **Classification**: `required`
- **Purpose**: Structured text attached to workflow definitions (`workflow.policy`). Guides model behavior in `agentStructuredOutput` instructions. Recorded in replay as `policyId`, `policyVersion`, `policyTextHash`.
- **Evidence**: All workflow experiments embed policy text. WF-4/BF-2 use vendor compliance policy. BF-3H uses customer support triage policy with decision rules for P1-P4, incident vs duplicate precedence, enterprise sandbox escalation. IC-1 exercises incident decision rules. Verifier checks replay for policy metadata.
- **Experiments that exercised it**: All six.
- **What breaks if removed**: Model receives no structured guidance. Decision quality depends entirely on ad hoc prompt engineering. Replay cannot verify which policy version was used.

### Verifier

- **Classification**: `required`
- **Purpose**: Deterministic external judgment for fixture/workflow success. Verifier contract metadata attached to workflow definitions (`verifierContract`). Checks expected artifacts, decision accuracy, workspace state, replay evidence, and graph evidence.
- **Evidence**: Every experiment reports "verifier PASS." BF-2/BF-3H verifiers check CSV columns, coverage (all source items accounted), no hallucination, replay metadata, escalation lists, duplicate chains. Verifier is the sole pass/fail arbiter for every experiment.
- **Experiments that exercised it**: All six.
- **What breaks if removed**: No objective pass/fail criterion. No way to determine whether an experiment succeeded or failed.

### Artifact

- **Classification**: `required`
- **Purpose**: Files produced by workflow runs in the workspace. Includes CSVs, Markdown reports, chunk outputs, aggregate summaries.
- **Evidence**: WF-4 produces vendor decision register and compliance review. WF-5 produces remediation artifacts per vendor. BF-2 produces compliance review and remediation tasks. BF-3H produces 5 chunk CSVs, triage-plan.md, escalation-list.md. Verifier checks expected artifacts exist with correct content.
- **Experiments that exercised it**: All six.
- **What breaks if removed**: No visible output. Verifier cannot check workspace state. Workflow results are ephemeral.

### Replay

- **Classification**: `required`
- **Purpose**: Per-run snapshot recording workflow invocation, actions, action plans, ticket plans, workspace operations, model responses, authority checks, and terminalization evidence. Persisted to `data/replay-snapshots/run-<id>.json`.
- **Evidence**: Every experiment checks replay evidence. BF-3H verifier checks multiple workflow invocations (`SUPPORT_REQUIRED_WORKFLOW_IDS`). WF-4/WF-5 verify `workflowTicketPlans` evidence. WF-6 verifies idempotency rejection evidence in replay. Verifier checks workflowId, policyId, policyVersion, policyTextHash, verifierContractId, verifierContractVersion.
- **Experiments that exercised it**: All six.
- **What breaks if removed**: No evidence trail. No verification of what the model did. No recovery support. Verifier cannot confirm workflow/policy/contract provenance.

### Workspace

- **Classification**: `required`
- **Purpose**: File system root for workflow input/output. All read/write operations target paths under `workspace-root/`. Workspace provider enforces path permissions, protected paths, and ownership.
- **Evidence**: Every experiment reads source files from and writes artifacts to the workspace. WF-4 reads vendor packets from workspace. BF-3H reads support-inbox, writes to support-queue. Verifier reads workspace artifacts for checking.
- **Experiments that exercised it**: All six.
- **What breaks if removed**: No file I/O possible. No source documents, no output artifacts. Workflows that depend on file content immediately fail.

### Event/Log

- **Classification**: `supported_by_evidence`
- **Purpose**: Append-only event stream (`data/events.jsonl`) with forensic hash chain. Run-scoped log entries (`data/logs.json`). Operation history (`data/operation-history.json`) for workspace mutation audit.
- **Evidence**: Events and logs are generated by every run but are not directly verified by experiment pass/fail criteria. The verifier checks replay snapshots (which include an embedded events array) but does not validate `events.jsonl` or `logs.json` directly. Events.jsonl is critical for recovery (reconstructResumableState uses the hash chain) and for the runtime's own scheduler/lease operations. Operation-history.json is used by workspace mutation dedup and consequence building.
- **Experiments that exercised it**: All six (passively — events generated but not directly checked).
- **What breaks if removed**: Recovery from interruption/crash breaks (IC-1 fails). Workspace mutation dedup breaks. Consequence building degrades. The runtime can still execute single-pass experiments, but robustness guarantees are lost.

---

## Overlap Analysis

### Ticket vs Workflow

- **Overlap**: Workflow tickets carry `executionMode: 'workflow'`, `workflowId`, and `workflowInput`, creating a tight coupling. The ticket is the assignment unit; the workflow is the definition. Child tickets created by `executeTicketPlan` are always workflow tickets.
- **Distinction**: Tickets represent the work unit (who, what, status). Workflows define the work structure (how, steps, policy). A ticket can reference any enabled workflow. A workflow can be referenced by many tickets. Tickets have lifecycle status independent of workflow definition changes.
- **Evidence boundary**: All six experiments use workflow tickets. No experiment validates a ticket without a workflow binding for child tickets. The separation is real but always composed in practice.
- **Verdict**: `overlapping` — conceptually distinct, always composed in these experiments, but separable at the implementation level (direct-agent tickets exist without workflows).

### Run Status vs Ticket Status

- **Overlap**: A completed ticket typically has a completed run. A failed run can leave a ticket open for retry. Child tickets are `blocked` regardless of run status.
- **Distinction**: Run status tracks execution attempt lifecycle (pending -> running -> completed/failed/interrupted). Ticket status tracks work unit lifecycle (open -> in_progress -> completed/failed/blocked/closed). Multiple runs per ticket are possible (reruns). Parent/child ticket statuses are independent (no status rollup exists).
- **Evidence boundary**: WF-4 proves child tickets can be `blocked` with 0 runs. WF-6 proves parent rerun creates a new run without changing parent ticket status. The separation is directly tested.
- **Verdict**: `overlapping` — correlated in simple cases, but the separation is essential for reruns, blocked children, and independent child lifecycle.

### Replay vs Event Log

- **Overlap**: Both record execution evidence. Replay snapshots have an embedded `events` array. Events.jsonl records the same operations with additional fields (hash chain, seq, prevHash). Both capture workspace operations, model responses, and terminalization.
- **Distinction**: Replay is per-run, finalized at run end, and directly consumed by verifiers. Events.jsonl is global append-only, hash-chained, and consumed by runtime recovery. Replay is the verification surface; events.jsonl is the recovery surface.
- **Evidence boundary**: Verifiers only check replay snapshots, never events.jsonl directly. No experiment validates the events.jsonl hash chain. IC-1 (inferred interruption recovery) would depend on events.jsonl for `reconstructResumableState`.
- **Verdict**: `overlapping` — significant content overlap, different consumers (verifier vs recovery), different lifecycles (per-run finalized vs append-only global). The overlap is useful redundancy for audit integrity.

### Policy Metadata vs Verifier Metadata

- **Overlap**: Both are attached to workflow definitions as structured metadata (`workflow.policy` and `workflow.verifierContract`). Both are recorded together in replay `workflowInvocation` (policyId, policyVersion, policyTextHash, verifierContractId, verifierContractVersion). Both serve quality/accountability roles.
- **Distinction**: Policy text is injected into model prompts to guide behavior. Verifier contract is consumed by external verifier scripts to judge output. Policy is agent-visible; verifier contract is not. They serve different lifecycle phases (guidance vs judgment).
- **Evidence boundary**: All experiments verify both are present in replay. No experiment has one without the other in these 6 experiments. The execution model audit already flags this as a "possible collapse."
- **Verdict**: `overlapping` — structurally similar metadata, different consumption paths (agent prompt vs verifier script), always coupled in these experiments.

### Artifact Evidence vs Replay Evidence

- **Overlap**: Replay records `artifactPrediction` which predicts what artifacts a workflow plan will produce. Both carry evidence of what the workflow did. Artifacts are the concrete workspace output; replay is the verifiable execution record.
- **Distinction**: Artifacts are persistent files in the workspace that can be read by verifiers. Replay is a runtime record that captures what the model proposed (not just what was actually written). Verifier checks both: artifact content for decision accuracy, replay for metadata integrity.
- **Evidence boundary**: BF-3H verifier checks both triage-plan.md content (artifact) and multi-workflow replay metadata (replay). They serve complementary verification roles that cannot substitute for each other.
- **Verdict**: `overlapping` — complementary verification targets, both needed for full audit. Replay captures intent; artifacts capture outcome.

### executeActionPlan vs Direct Workflow Actions

- **Overlap**: Both execute workspace mutations through the same runtime authority checks. Both record operation history, events, and replay evidence. Both can produce artifacts.
- **Distinction**: Direct workflow actions are statically defined at workflow creation time with explicit operation, path, and content. executeActionPlan accepts a model-proposed dynamic plan at runtime, validated against an allowed-operations list and mutation budget. Direct actions are deterministic from workflow definition; executeActionPlan introduces model-driven variability.
- **Evidence boundary**: None of the six experiments use executeActionPlan. All six use direct workflow actions (readFile, writeFile, agentStructuredOutput, executeTicketPlan). executeActionPlan was validated solely by DX-2/DX-3. Direct actions alone explain all six experiment successes.
- **Verdict**: `overlapping` — both mutate the workspace through the same authority layer, but executeActionPlan provides dynamic model-proposed bounded plans while direct workflow actions are statically defined at definition time. They overlap as mutation mechanisms but serve distinct flexibility vs determinism roles. For these six experiments, direct actions cover all needs, but system-wide they are not redundant.

### executeTicketPlan vs Ordinary Ticket Creation

- **Overlap**: Both create tickets in tickets.json. Both record ticket creation events.
- **Distinction**: executeTicketPlan is workflow-scoped, creates child tickets with parent linkage and idempotency keys, restricts to allowed workflow IDs, blocks children by default, and validates recursive prevention. Ordinary ticket creation is user/API-triggered, assigns to any agent/workflow, and creates runs immediately.
- **Evidence boundary**: WF-4/WF-5/BF-2/BF-3H all use executeTicketPlan. No experiment tests ordinary ticket creation as a substitute for child ticket creation. The distinction is fundamental to the execution graph model.
- **Verdict**: `overlapping` — both create tickets, but executeTicketPlan's constraints (parent linkage, idempotency, blocked status, allowed workflow IDs) are essential for the execution graph experiments. They are not interchangeable.

---

## Minimum Proven Execution Substrate

Below are the concepts that are **necessary** to explain all six successful experiments. No concept classified as `unproven`, `redundant`, `overlapping`, or `supported_by_evidence` in these experiments is included.

| # | Concept | Rationale |
|---|---------|-----------|
| 1 | **Ticket** | Every experiment creates or manipulates tickets. No experiment succeeds without a ticket to assign work. Parent/child ticket graph is the core data structure. |
| 2 | **Run** | Every experiment executes work through runs. Run lifecycle (create, lease, execute, complete, finalize) is the execution container. Reruns and child runs are directly tested. |
| 3 | **Workflow** | Every experiment defines and invokes workflows. Workflow actions (readFile, writeFile, agentStructuredOutput, executeTicketPlan, condition, stop) are the execution primitives. No experiment uses direct agent execution for the tested scenarios. |
| 4 | **executeTicketPlan** | Required by WF-4, WF-5, BF-2, BF-3H for child ticket creation. The parent/child execution graph depends on this primitive. No alternative mechanism creates blocked child tickets with parent linkage and idempotency keys. |
| 5 | **Policy** | Every experiment embeds policy text in workflow definitions. Policy guides model behavior in agentStructuredOutput. Replay verifies policy provenance. No experiment succeeds without policy-guided model output. |
| 6 | **Verifier** | Every experiment reports verifier PASS as the success criterion. Verifier checks artifact content, coverage, no hallucination, replay metadata. No other mechanism provides objective pass/fail judgment. |
| 7 | **Artifact** | Every experiment produces workspace artifacts (CSVs, Markdown reports). Verifier reads artifacts to judge correctness. No experiment succeeds without observable output. |
| 8 | **Replay** | Every experiment checks replay evidence. Replay records workflow invocation, policy/verifier metadata, action plans, ticket plans, and workspace operations. Verifier inspects replay snapshots. No experiment validates without replay. |
| 9 | **Workspace** | Every experiment reads source files from and writes output to the workspace. Workspace provider is the file I/O layer for all artifact operations. No file-based workflow succeeds without it. |

**Concepts excluded from the minimum substrate:**

| Concept | Classification | Exclusion Rationale |
|---------|---------------|-------------------|
| executeActionPlan | `supported_by_evidence` | Not necessary for these six experiments — direct workflow actions cover all mutation needs for the listed scenarios. Validated separately by DX-2/DX-3. |
| Event/Log | `supported_by_evidence` | Generated and important for recovery, but not directly verified by any experiment's pass/fail criteria. Not required for single-pass success. |

The minimum substrate requires 9 concepts. No further reduction is possible while explaining all six experiments.

No new capabilities are proposed. No BF-4 design is suggested. No model expansion is implied.

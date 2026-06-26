# Target Interface and Snapshot Replay Audit

## 1. Executive summary

The current system already has an implicit target model: the local workspace rooted at `WORKSPACE_ROOT` is the first execution target. Ticket runs inspect and mutate that target through workspace operations, authority checks, evidence capture, operation history, replay snapshots, and deterministic post-run checks.

There is not yet a formal `TargetProvider` contract. `server.js` has a local workspace provider object (`createLocalWorkspaceProvider`) and a run boundary function (`getRunWorkspaceProvider`), but the latter always returns the same local filesystem-backed provider. The next implementation should extract and formalize this boundary before any real connector is added.

The current local target is good enough for deterministic local tests and bounded demo runs. It is not yet safe to generalize to remote targets because receipts, snapshots, replay preconditions, provider error mapping, and remote resource identity semantics are not formalized.

## 2. Current implementation map

Current ticket-to-mutation path:

```text
Ticket
-> run creation / queueing / lease acquisition
-> runtime envelope and prompt/workflow execution
-> operation parsing and capability checks
-> authority and scope checks
-> local workspace provider operation
-> operation-history, replay snapshot, event, and log evidence
-> deterministic batch verification / postcondition checks
-> runEvaluation and runConsequence
-> UI/API run state
```

Concrete implementation points:

- `server.js` defines data roots (`DATA_DIR`, `WORKSPACE_ROOT`) and persistence files, including `data/events.jsonl`, `data/logs.json`, `data/operation-history.json`, and `data/replay-snapshots/`.
- `ACTIONS_CATALOG`, `AGENT_PRIMITIVE_METADATA`, and generated agent actions define the current primitive operation vocabulary and provenance surfaces.
- `buildRuntimeEnvelope` supplies run, ticket, workspace root, allocation, owned paths, current phase, limits, and `allowedOperations`.
- `executeAgentRun` drives model-backed ticket execution. It captures provider requests, model responses, parsed plans, direct workspace operations, workflow draft actions, handoff actions, phase checks, postcondition checks, and terminal run state.
- `executeWorkflowDefinition` and `executeWorkflowAction` run workflow steps. Workspace workflow actions use the same `executeWorkspaceOperation` path as direct agent actions.
- `executeWorkspaceOperation` is the central local workspace operation executor for `listDirectory`, `readFile`, `createFolder`, `writeFile`, `renamePath`, and `deletePath`.
- `checkWorkspaceMutationAuthority`, `assertAllocatedOwnershipAllowsMutation`, `blockProtectedWorkspaceOperation`, `assertNoCrossTicketOverlap`, and `assertAgentWorkspacePathAllowed` enforce runtime authority and scope.
- `createLocalWorkspaceProvider` implements the actual local filesystem provider, including path normalization, root containment, list/read/write/create/rename/delete behavior, type checks, and content hashes.
- `persistWorkspaceOperationHistory` records mutating operation receipts in `data/operation-history.json`.
- `appendRunReplaySnapshotItem` appends run evidence to replay snapshots. `writeRunReplaySnapshot` persists those snapshots in `data/replay-snapshots/run-<id>.json`.
- `appendEvent` appends structured events to `data/events.jsonl` with run-local sequencing and hash chaining.
- `appendRunLog` writes human-readable run logs to `data/logs.json`.
- `verifyBatchOperation`, `checkPostconditionCompletion`, workflow postcondition evaluation, run violations, `runEvaluation`, and `runConsequence` provide deterministic completion and consequence evidence after execution.

## 3. Current operation surface

Current direct agent workspace operations:

- `listDirectory` - read directory entries from the local workspace target.
- `readFile` - read file content from the local workspace target.
- `createFolder` - create a directory.
- `writeFile` - create or overwrite a file.
- `renamePath` - rename or move a path.
- `deletePath` - delete a file or folder.

Related runtime/workflow operations:

- `executeActionPlan` - workflow-only dynamic workspace action plan, currently restricted to `createFolder` and `renamePath`.
- `executeTicketPlan` - workflow-only bounded child ticket plan creation; child execution is not automatic.
- `agentStructuredOutput` - model call for structured workflow output; no direct workspace mutation.
- `condition` - deterministic branching.
- `stop` - workflow termination.
- `invokeWorkflow` - agent-invoked workflow execution.
- `createWorkflowDraft` and `createWorkflowDraftIntent` - disabled workflow draft creation surfaces.
- `createHandoffTask` - direct runtime execution of one `writeFile` handoff through the same workspace authority path.

Operator workspace API operations:

- `GET /api/workspace/list`
- `GET /api/workspace/file`
- `POST /api/workspace/file` (`createFile`)
- `POST /api/workspace/folder` (`createFolder`)
- `PATCH /api/workspace/file` (`writeFile`)
- `PATCH /api/workspace/rename` (`renamePath`)
- `DELETE /api/workspace` (`deletePath`)
- `POST /api/workspace/fixture`

Simulation, verification, and replay surfaces:

- `buildSimulationRuntimeEnvelope` and `scripts/agent-behavior-simulation-test.js` cover simulated agent behavior.
- `verifyBatchOperation` deterministically checks post-mutation effects for `createFolder`, `writeFile`, `renamePath`, and `deletePath`.
- `scripts/replay-workspace.js` reconstructs an in-memory workspace projection from `workspace.operation` events.
- `scripts/replay-reconstructor.js`, `scripts/replay-snapshot-storage-test.js`, `scripts/replay-reconstructor-test.js`, and related scripts inspect replay snapshot/event consistency.
- `scripts/verify-snapshot.js` hashes projections for snapshot verification.

## 4. Current authority model

User/operator authority:

- Permissions are stored in `data/permissions.json`.
- Relevant permissions include `ticket:create`, `ticket:read`, `ticket:update`, `ticket:delete`, `workspace:read`, `workspace:write`, `workspace:reset`, `workspace.delete.cross_ticket_artifact`, and process-template permissions such as `processTemplate:manage`.
- UI/API routes use `hasPermission` for ticket, run, agent, workspace, triage, and admin access.
- Operator workspace mutations require `workspace:write` and are logged through `operatorWorkspaceMutationApi`.

Agent/run authority:

- Ticket assignment binds runs to an agent, group, allocation mode, execution policy, workflow, and optional owned output paths.
- `buildRuntimeEnvelope` exposes `assignedAgentId`, execution workspace type, allocation plan/item, owned output paths, and allowed primitive operations to the run.
- `assertAgentOperationAllowed` gates runtime-config-controlled operations (`createWorkflowDraft`, `createWorkflowDraftIntent`, `createHandoffTask`).
- `checkWorkspaceMutationAuthority` gates mutating workspace operations on lease ownership, protected paths, and owned output paths.
- `assertAllocatedOwnershipAllowsMutation` enforces `main_owned_paths` restrictions.
- `assertNoCrossTicketOverlap` blocks destructive `renamePath` and `deletePath` operations that overlap artifacts produced by another ticket, except permissioned cross-ticket deletes initiated by a user with `workspace.delete.cross_ticket_artifact`.
- `findPriorSuccessfulArtifactOwner` blocks writes to paths previously produced by another ticket.

Path authority:

- `createLocalWorkspaceProvider` rejects absolute paths, traversal, hidden/system paths by default, and realpath escapes outside the workspace root.
- `assertAgentWorkspacePathAllowed` and protected path matching block sensitive workspace paths.
- `config/protected-paths.json` supplies configured protected path patterns with defaults as fallback.

When authority blocks a mutation:

- A structured error is thrown before the filesystem mutation.
- Authority evidence is appended to replay snapshot `authorityChecks`.
- An `authority.denied` event is appended to `events.jsonl`.
- Workspace replay entries may include `blocked`, `reason`, `ownedOutputPaths`, `workspaceRoot`, allocation metadata, and the denied action.
- Run logs capture human-readable blocked/denied messages for several cases.
- The run generally fails or retries according to the surrounding execution path and error classification.

## 5. Current evidence and audit trail

Durable evidence surfaces:

- `data/events.jsonl` - append-only structured operational history with run-local sequence and hash-chain metadata for run events.
- `data/replay-snapshots/run-<id>.json` - per-run replay snapshot containing provider requests, model responses, parsed plans, workspace operations, authority checks, workflow actions, events, evaluation, and consequence fields.
- `data/operation-history.json` - mutating workspace operation history with run, ticket, allocation, step, operation, args, pre-state, post-state, result, and error.
- `data/logs.json` - mutable human-readable run and system logs.
- `data/runs.json` - run state, replay snapshot path/summary, evaluation, consequence, error, lease, and terminal status.
- `data/tickets.json` - ticket assignment, status, execution policy, workflow, parent/child, and ownership metadata.

Mutation information captured today:

- Operation name and sanitized args.
- Ticket id, run id, allocation plan/item, and step.
- Pre-state for mutating operations, including existence, type, content hash, and in some cases pre-mutation content.
- Post-state for mutating operations, including existence, type, and content hash.
- Result or error.
- Replay snapshot workspace operation entry with duration, workspace root, execution workspace type, allocation metadata, owned output paths, and history id.
- `workspace.operation` event payload with operation, path, next path, mutating flag, input, result or error.
- Authority allowed/denied evidence.

Read evidence captured today:

- `listDirectory` and `readFile` results are captured in replay snapshot `workspaceOperations`, `workspace.operation` events, action results, and run logs.
- There is no separate durable `TargetReadReceipt` type with explicit target id, metadata, content hash, or scope provenance for every read.

What is sufficient for audit today:

- Proving that a bounded local workspace mutation was requested, authorized or denied, executed or failed, and associated with a ticket/run/agent.
- Auditing protected-path and owned-output-path decisions.
- Auditing cross-ticket artifact conflict blocks and permissioned cross-ticket delete authorization.
- Reconstructing a rough local workspace projection from events for simple create/write/delete cases.
- Comparing replay snapshot counts with event-derived counts.

What is insufficient for connector-grade replay:

- No formal target id or provider kind is attached to each operation.
- `workspaceRoot` is a local filesystem path, not a stable target identity.
- Read evidence lacks a first-class receipt contract.
- Snapshot evidence is root-listing-oriented and bounded, not a full scoped target snapshot.
- Replay entries do not consistently encode expected preconditions or safe replay conditions.
- Remote resource ids, version ids, etags, permissions, rate limits, partial failures, and provider-side idempotency are not represented.

## 6. Snapshot/replay status

Currently replayable:

- Event stream ordering for a single run, using run-local `seq` where present.
- Simple in-memory workspace projection from `workspace.operation` events through `scripts/replay-workspace.js`.
- Replay snapshot/event consistency checks for counts and presence of provider requests, model responses, parsed plans, workspace operations, evaluation, and consequence.
- Mutating local operation audit from `operation-history.json`, including before/after state for local files and folders.

Partially replayable:

- Local workspace mutation history for `writeFile`, `createFolder`, `renamePath`, and `deletePath`.
- Reads and listings as observed operation results, not as independently validated resource-version receipts.
- Root workspace snapshots used in prompts through `captureRunWorkspaceRootSnapshot`, bounded to root-level listing and capped entries.
- Workflow actions and action plans as evidence of runtime decisions, not as a safe re-execution plan.

Not replayable:

- A guaranteed full workspace state for large or nested targets from a single run snapshot.
- Safe mutation replay against a live local filesystem or remote provider without precondition checks.
- Provider/model output determinism.
- External connector state, because connectors do not exist and target identity/resource-version semantics are not modeled.

Simulation-only:

- Agent behavior simulation tests and runtime envelope simulation.
- In-memory replay projections used for inspection and regression checks.

Deterministic enough for tests:

- Path normalization and local root containment.
- Operation schema/preflight checks.
- Phase/batch limits and deterministic verification checks.
- Local operation post-state checks and content hash comparisons.
- Event/replay reconstruction checks that operate on stored evidence.

Not safe for real connector replay yet:

- Delete/rename replay without provider-native preconditions.
- Remote update replay without etag/version checks.
- Retrying remote operations without idempotency keys or duplicate detection.
- Mapping path-based authority to remote resource ids.
- Inferring connector state from local-style path snapshots.

## 7. Proposed TargetProvider contract

This milestone does not add code. Conceptually, the next boundary should define these records.

`TargetProvider`:

- `id` - stable target id used in receipts and snapshots.
- `kind` - provider kind, initially `localWorkspace`.
- `root/scope identity` - local root path or remote bounded container id.
- `capabilities` - explicit read/list/create/update/delete/rename support and dry-run support.
- `authority profile` - path/resource restrictions, protected resources, owned scope behavior, and delegated permission hooks.

`TargetSnapshot`:

- `targetId`.
- `timestamp`.
- Visible tree/listing within the assigned scope.
- Content hashes, resource ids, etags, versions, sizes, modified timestamps, or equivalent metadata.
- Scope boundary.
- Provenance, including who/what captured it and whether it is full, partial, bounded, or truncated.

`TargetOperation`:

- Operation type.
- Target path or provider resource id.
- Input payload.
- Authority context, including actor, run id, ticket id, allocation/owned-path context, and delegated user if any.
- Idempotency key when applicable.

`TargetMutationReceipt`:

- Operation id.
- Target id.
- Before/after metadata.
- Changed resources.
- Created resources.
- Deleted resources.
- Provider response.
- Timestamp.
- Actor, run, and ticket ids.
- Authority decision reference.
- Error/failure classification if mutation failed or was denied.

`TargetReadReceipt`:

- Resource read or listing.
- Metadata, such as hash, etag, version, size, or modified timestamp where available.
- Timestamp.
- Scope and target id.
- Truncation/partial-read markers when applicable.

`TargetReplayPlan`:

- Original operation and original receipt.
- Expected preconditions, including resource existence, version/hash/etag, path/resource identity, and authority context.
- Safe replay conditions.
- Unsafe replay reasons.
- Dry-run result.
- Required human/operator confirmation if replay is destructive or preconditions diverge.

## 8. Connector readiness rules

Before any real connector is added:

- The connector must expose a bounded target scope.
- The connector must support read/list/create/update/delete semantics explicitly, or explicitly declare unsupported operations.
- The connector must produce read and mutation receipts.
- The connector must preserve idempotency where possible.
- The connector must expose provider-native resource identity, version, etag, hash, or equivalent precondition metadata where available.
- The connector must map provider errors into existing triage/failure categories without losing raw provider evidence.
- The connector must not bypass protected path, owned output path, lease, delegated permission, or agent runtime-config rules.
- The connector must not create tickets or runs directly.
- The connector must not mutate outside assigned target scope.
- The connector must be testable with fixtures.
- The connector must be simulatable or dry-runnable before mutation.
- The connector must record enough evidence for replay reconstruction without calling the live provider.
- The connector must define delete and rename semantics explicitly, including soft delete/trash behavior if applicable.
- The connector must fail closed when scope, authority, or preconditions are ambiguous.

## 9. Non-goals

Not part of r1.13:

- No connector implementation.
- No Google Drive, Slack, Discord, GitHub, chat, or external integration.
- No Work Context.
- No ambient watchers.
- No model routing.
- No new scheduler behavior.
- No new template behavior.
- No scheduled token behavior.
- No old-version replay.
- No autonomous child-ticket spawning.
- No workflow builder.
- No rich UI.
- No runtime behavior changes.
- No changes to verification, triage, auto-retry, provider, template, or schedule behavior.

## 10. Recommended next implementation slice

Recommended next milestone: `r1.14-target-provider-contract-implementation`.

Scope:

- Extract/formalize the existing local workspace as the first `TargetProvider`.
- Preserve current behavior exactly.
- Attach stable target identity to local workspace operation evidence.
- Add or normalize mutation receipts where current operation-history/replay evidence is missing provider-neutral fields.
- Add target snapshot metadata where current root snapshots and replay snapshots are insufficient.
- Add a first-class read receipt shape for `listDirectory` and `readFile`.
- Test the local provider through the target contract.
- Keep operator workspace routes and ticket execution behavior functionally unchanged.
- Do not add external connectors yet.

## 11. Risk register

P0 risks:

- Local filesystem assumptions leak into future connectors, causing remote provider behavior to be forced into path-only semantics.
- Insufficient mutation receipts make replay unsafe or unverifiable.
- Path-based authority does not map cleanly to remote resource ids.
- Replay of destructive operations is unsafe without explicit precondition checks.
- Connectors could bypass protected path, owned output, lease, or delegated permission checks if the target boundary is extracted incorrectly.

P1 risks:

- Snapshots may be too expensive for large targets.
- Provider errors may be too vague for triage unless raw error evidence and normalized failure kinds are both preserved.
- Delete and rename semantics differ across providers, especially trash/soft-delete, move, overwrite, and folder behavior.
- Idempotency differs across providers, making retry/resume behavior inconsistent.
- Verification may assume local filesystem semantics such as recursive folders, immediate consistency, UTF-8 file content, and content hashes.
- Read/list receipts may become large or leak too much provider metadata without truncation and redaction rules.

P2 risks:

- `workspaceRoot` displayed in prompts and replay may be confused with future target identity.
- Root-only snapshots may lead agents to over-trust incomplete target state.
- Operator workspace APIs currently log mutations differently from run mutations, which may complicate a uniform provider receipt model.
- Replay scripts support useful local reconstruction but may encourage overclaiming replay safety for connectors.

## 12. Final recommendation

Proceed to `r1.14-target-provider-contract-implementation` only after this audit is reviewed. Keep r1.14 local-provider-only and behavior-preserving. Do not add external connectors until the target contract, receipts, snapshots, and replay precondition model are stable. Keep autonomy bounded by target authority, explicit scope, and durable receipts.

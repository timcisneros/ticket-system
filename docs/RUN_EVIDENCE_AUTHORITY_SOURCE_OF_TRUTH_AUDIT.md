# Run Evidence and Authority Source-of-Truth Audit

## 1. Executive summary

The current system has several durable history-like surfaces, but they do not have the same role. The source-of-truth model should be frozen as follows:

- `data/tickets.json` is the primary live record for ticket identity, assignment, policy, status, provenance, and ticket-level triage.
- `data/runs.json` is the primary live record for run identity, attempt state, status, error, policy and verification snapshots, replay reference, evaluation, consequence, and run-level triage.
- `data/events.jsonl` is the append-only event ledger for lifecycle chronology, authority decisions, workspace operations, verification events, and reconciliation evidence. It supports audit, recovery analysis, and reduced projection reconstruction; it is not the live state read path.
- `data/replay-snapshots/run-<id>.json` is a per-run evidence bundle referenced by `run.replaySnapshotPath`. It is not the sole source of ticket or run state and is not proof that arbitrary operations are safe to replay.
- `data/operation-history.json` is the durable mutation commit and receipt ledger for target mutations. It is logically append-only during normal execution even though the JSON persistence helper rewrites the containing array.
- Target read receipts currently live inside workspace-operation event and replay evidence. There is no standalone read-receipt ledger.
- `data/logs.json` is the human-readable operator/run narrative. It can support an audit, and it is currently the only historical companion for some operator annotations such as triage resolution, but it is not the strongest canonical source when structured state, events, receipts, or replay evidence exist.
- Verification and triage have authoritative materialized outcomes plus supporting events/evidence, but no single ticket-timeline projection joins them today.

r1.18 should build a read-only ticket timeline projection from these existing sources. It must define precedence and provenance, deduplicate overlapping evidence, and avoid creating another persisted history system.

## 2. Vocabulary freeze

**Ticket**: The persisted unit of requested work. A ticket owns the objective, assignment, execution configuration, current status, source/template provenance, optional ownership scope, and ticket-level triage. Its live record is in `tickets.json`.

**Run**: One execution attempt for a ticket. A run owns attempt status, lease and phase state, immutable-at-run-start policy/verification context, execution evidence references, terminal error, evaluation, consequence, and run-level triage. Its live record is in `runs.json`.

**Event**: A sanitized structured occurrence appended through `appendEvent` to `events.jsonl`. Run-scoped events carry a per-run sequence and previous-hash link. Events record chronology and evidence; they do not replace the materialized ticket/run records.

**Log**: A human-readable narrative record written through `appendRunLog` or `appendSystemLog` to `logs.json`. Logs are mutable JSON projections optimized for operators, not a hash-chained canonical ledger.

**Evidence**: A persisted structured observation sufficient to support a claim about execution, authority, mutation, verification, or lifecycle. Events, receipts, replay items, evaluation, and consequence can all be evidence; their authority depends on the claim being made.

**Replay Snapshot**: The versioned per-run evidence bundle persisted at `replay-snapshots/run-<id>.json`. It captures run context and append-style arrays of requests, responses, plans, authority checks, workspace operations, events, and related execution records, then receives terminal summary fields.

**Operation History**: The mutation ledger in `operation-history.json`. Each record identifies ticket/run/step, operation and args, before/after state, result/error, authority decision, target identity, and normalized mutation receipt.

**Target Read Receipt**: Provider-neutral evidence for `listDirectory` or `readFile`, including target identity, resource path, timestamp, available metadata/hash, and actor/run/ticket context. It is embedded in workspace-operation evidence, not persisted in a separate ledger.

**Target Mutation Receipt**: Provider-neutral evidence attached to an operation-history record and copied into workspace-operation evidence. It records operation id, target identity, before/after metadata, changed/created/deleted resources, provider response or error, authority decision, timestamp, and actor/run/ticket ids.

**Authority Decision**: A runtime allow/deny decision made before mutation for lease ownership, protected paths, owned output scope, or other bounded authority. `recordAuthorityEvidence` writes the same decision to replay `authorityChecks` and an `authority.allowed` or `authority.denied` event.

**Verification Result**: A deterministic result from batch checks, workflow postconditions, direct objective checks, and the terminal verification gate. Structured events record checks and pass/fail chronology; `runEvaluation` summarizes effectiveness and violations.

**Triage State**: A materialized ticket- or run-level record describing required human action, reason, evidence references, allowed/prohibited actions, and optional resolution annotation. Unresolved triage is `required: true`; resolution annotates the record and does not change execution status or trigger work.

**Run Evaluation**: A persisted run-level summary built from existing run, event, replay, verification, and operation evidence. It records effectiveness, efficiency, violations, and effective runtime configuration. It is both stored on the run and emitted in `run.evaluation_completed`.

**Run Consequence**: A persisted run-level summary of committed and attempted mutations, created/updated/deleted/renamed resources, notifications, external effects, and verification status. It derives committed mutation consequences from operation history and attempted failures from replay/events.

**Ticket Timeline**: A read-only ordered projection of ticket provenance, attempts, lifecycle, authority, target evidence, verification, and triage. It is not a new ledger and must retain source labels and links to the underlying records.

## 3. Current source-of-truth matrix

| Concern | Authoritative source | Supporting evidence | Diagnostic/UI projection | Current gaps | r1.18 display recommendation |
| --- | --- | --- | --- | --- | --- |
| Ticket identity/status/assignment | `tickets.json` | `ticket.created`, `ticket.updated`, `ticket.blocked`; system logs | Ticket list/detail | Events cannot restore all policy/triage fields | Render current ticket header from ticket record; show sourced historical changes separately |
| Run identity/status/attempt/error | `runs.json` | `run.created`, `run.started`, `run.execution_completed`, `run.terminalized` | Run detail, attempt summary | A status event alone does not include all run fields | Render attempts from runs; use events for ordered lifecycle and reconciliation state |
| Provider requests/responses | Per-run replay snapshot | Model request/heartbeat events and logs | Run diagnostics | Event reconstruction has counts, not full request/response bodies | Show counts and timestamps by default; link to replay evidence, with redaction notice |
| Parsed model plans | Per-run replay snapshot `parsedModelPlans` | Phase/rejection events | Run diagnostics | Not independently stored elsewhere | Show concise plan/action summary with replay source label |
| Workspace read evidence | Replay/event `workspace.operation.readReceipt` | Run logs and action results | Run detail evidence | No standalone read ledger; large content may be truncated or omitted | Show operation, path, target id/kind, hash/metadata, and partial/truncated markers; avoid full content by default |
| Workspace mutation receipt | `operation-history.json` record and `mutationReceipt` | `workspace.operation`, replay workspace operation, run consequence | Run detail, recovery preview | Denials before a committed history record may exist only in event/replay evidence | Render committed mutations from operation history; render denied/failed attempts from events/replay |
| Authority allowed/denied decision | `authority.allowed`/`authority.denied` event chronology | Replay `authorityChecks`; receipt `authorityDecision` | Run authority evidence | Some later conflict guards are operation failures rather than `authority.denied` | Show rule, decision, actor, operation, path, reason, and source; do not infer allow from mutation success |
| Protected-path denial | `authority.denied` with `rule: protected_path` | Replay authority check and failed workspace operation | Blocked workspace log, triage | Duplicate surfaces require deduplication | Render one denial entry linked to event and replay evidence |
| Owned-output-path denial | `authority.denied` with `rule: owned_output_path` | Replay authority check, owned paths on run/evidence | Ownership-blocked log | Legacy paths may have log/error without normalized decision | Render assigned owned scope beside denied target path |
| Cross-ticket artifact conflict | Operation failure evidence plus prior successful operation-history owner | `workspace.operation`, run failure/triage, permissioned-delete event | Conflict error and audit block | Not every conflict is modeled as `authority.denied` | Render prior owner ticket/run/history id and whether delegated delete permission was used |
| Verification/postcondition result | Structured verification/postcondition events for verdict chronology; run status for current outcome | Replay events/failure, verification contract snapshot | Run evaluation and detail | Multiple check types need one ordered summary | Show required/not-required, checks, final pass/fail, and contract source without recomputing semantics |
| `runEvaluation` | `runs.json.runEvaluation` | `run.evaluation_completed`; replay terminal bundle | Serialized runtime state | Can be derived when absent, so persisted versus computed must be labeled | Prefer persisted evaluation; label derived fallback and link supporting events |
| `runConsequence` | `runs.json.runConsequence` | `run.consequence_recorded`, operation history, replay/events | Serialized runtime state | Attempted and committed mutations can be confused | Split committed consequences from attempted/blocked operations |
| Triage inbox state | Ticket/run `triage` records in `tickets.json`/`runs.json` | `ticket.blocked`, `run.triage_created`, failure/verification events | `/triage` | Inbox is a projection, not a ledger | Derive unresolved items directly from current ticket/run triage |
| Triage resolution state | Resolved triage annotation in ticket/run record | `ticket:triage_resolve` or `run:triage_resolve` system log | Ticket/run detail | No structured triage-resolution event today | Show current resolution from state and optional operator-log timestamp; label the historical gap |
| Scheduled trigger provenance | Ticket `source`; process-template trigger ledger | `process_template:triggered` log | Ticket/template detail | Trigger history is separate from run events | Show trigger type/token/scheduled time from ticket source and ledger reference |
| Process-template version provenance | Ticket `source.templateVersion` and immutable trigger snapshot | Process-template trigger ledger and append-only version store | Ticket/template detail | Legacy tickets may have no version | Show producing version when present; explicitly label legacy unversioned tickets |
| Target provider identity | Run/replay target metadata and operation receipts | Workspace-operation events/logs | Run diagnostics | Local-only identity; no connector resource ids | Show `targetId`, `targetKind`, and bounded scope once per run plus per-operation resource path |
| Replay reconstruction | `events.jsonl` for event chronology plus replay snapshot and operation history for richer evidence | Reconstructor/verifier outputs | Diagnostics tooling | Cannot reconstruct full live state, omitted content, or safe external replay | Present reconstruction completeness and missing-source warnings; never label it executable replay |

## 4. Current event ledger role

`appendEvent` sanitizes an event, assigns an id and high-resolution timestamp, and appends one JSON line to `events.jsonl`. Run-scoped events receive a zero-based `seq` and `prevHash`; the next link is derived from a SHA-256 hash of canonical type/ticket/run/step/payload content. Concurrent producers reserve chain positions before yielding. A persistent asynchronous journal serializes bounded batches, and each caller resumes only after the batch sync succeeds; committed chain state advances at that same acknowledgement boundary.

The ledger is append-only during normal operation. Debug reset is an explicit destructive development operation and is not production recovery. The event file is read by runtime recovery/reconciliation helpers and by replay, projection, telemetry, and integrity scripts.

Timeline-significant event groups include:

- ticket lifecycle: `ticket.created`, `ticket.updated`, `ticket.blocked`;
- run lifecycle: `run.created`, `run.lease_acquired`, `run.started`, `run.execution_completed`, `run.snapshot_finalized`, `run.evaluation_completed`, `run.consequence_recorded`, `run.terminalized`;
- authority: `authority.allowed`, `authority.denied`, and permissioned cross-ticket-delete audit events;
- target operations: `workspace.operation`;
- verification: `batch.verification_failed`, `run.postcondition_failed`, `run.postconditions_checked`, `run.verification_passed`, `run.verification_failed`, `run.violations_checked`;
- triage creation: `run.triage_created` and ticket blocking events;
- workflow/model evidence: workflow step and model request/response lifecycle events where present.

Some events, notably scheduler ticks and heartbeats, are telemetry-heavy and should be omitted or collapsed in a user-facing timeline. The ledger does not replace `tickets.json`, `runs.json`, operation history, replay request/response bodies, or current triage annotations. Projection rebuild from events is diagnostic and reduced; it is not a lossless restore path.

## 5. Current replay snapshot role

`createReplaySnapshotBase` captures run/ticket identity, agent assignment, primitive contract, workspace and target identity, execution and verification snapshots, allocation/owned scope, runtime limits, and empty evidence arrays. `appendRunReplaySnapshotItem` appends sanitized items to named arrays and persists the snapshot file. Finalization adds terminal status, failure, mutation summary, events, evaluation, consequence, and timestamps.

`run.replaySnapshotPath` is a relative pointer such as `replay-snapshots/run-42.json`. `runs.json` keeps that pointer and a compact `replaySummary`; the full inline snapshot is removed from the run record. Readers may hydrate the file for UI or analysis.

Replay snapshots contain or reference:

- provider requests and model responses;
- parsed model plans and capability/workflow decisions;
- workspace operations with target metadata, receipts, results, errors, duration, and history ids;
- authority checks;
- workflow actions, action plans, handoffs, and draft evidence;
- selected runtime events;
- verification contract, terminal failure, evaluation, consequence, and target snapshot metadata.

This is an evidence bundle, not all-purpose state. It is safe to reconstruct the recorded sequence, inspect what the model/runtime observed, correlate operations with receipts, and detect missing/inconsistent evidence. It is not safe to claim that the snapshot contains the complete current workspace, that model output is deterministic, that a remote provider has not changed, or that replaying a mutation is safe. Bounded/truncated snapshots and absent provider-native preconditions prevent that stronger claim.

## 6. Current operation-history and target receipt role

r1.14 formalized the local workspace target and attached provider-neutral target evidence without changing operation behavior. `persistWorkspaceOperationHistory` creates one record for each attempted mutation that reaches the mutation execution boundary. The record preserves legacy fields and adds target id/kind/scope/resource identity, authority decision, normalized error fields, and `mutationReceipt`.

The operation-history record is the strongest source for committed mutation facts because runtime idempotency, conflict checks, run consequence, and recovery tooling consume it. Before/after metadata establishes existence/type/hash transitions; the receipt identifies changed, created, and deleted resources. The provider response records the local operation result. Failed provider operations can also have history records with error classification.

Denied mutations that fail before history persistence still appear in `authority.denied`, failed workspace-operation evidence, and replay mutation receipts with no operation id. r1.18 must not pretend those are committed history records.

Read receipts are created cheaply for successful `listDirectory` and `readFile` operations and attached to replay/event workspace evidence. They include target identity, operation/resource identity, timestamp, local metadata/hash where available, and actor/run/ticket context. They do not create operation-history entries and do not retain more content than the existing operation evidence.

Timeline mutation entries should originate from operation history when a history id exists. Timeline read entries should originate from structured workspace-operation evidence and be summarized to avoid exposing large content. Event/replay duplicates should be correlated by run, step, operation, resource, timestamp/history id, and receipt operation id rather than displayed twice.

## 7. Current authority model role

Authority is enforced at several layers:

- route permissions gate ticket, run, workspace, triage, template, and administrative operations;
- run lease ownership prevents mutation by a process that does not hold the run;
- protected-path matching rejects configured sensitive paths;
- `main_owned_paths` runs may mutate only assigned output paths;
- path normalization, root containment, traversal/hidden-path checks, and realpath checks constrain the local target;
- prior operation history protects artifacts owned by another ticket;
- rename/delete overlap checks prevent destructive cross-ticket mutation;
- delegated `workspace.delete.cross_ticket_artifact` permission allows a specifically audited operator delete path;
- process-template and schedule controls have their own operator permission checks and immutable provenance.

`authority.denied` means a normalized pre-mutation authority rule rejected the operation. It should not be generalized to mean every failed action: schema failures, provider errors, mutation conflicts, and cross-ticket ownership conflicts can be recorded as failed workspace operations with different evidence. Conversely, an `authority.allowed` event proves that the checked authority gate passed at that point; it does not prove the provider mutation later succeeded.

The r1.16 blocked-correctly contracts expect `authorityDeniedEventPresent`, target identity, mutation-receipt evidence for the denied attempt, replay reference, and `noWorkspaceMutation`. A future scenario harness should verify all of those independently. A denial alone is insufficient if operation history or target state shows a committed mutation.

## 8. Current verification and triage role

Deterministic batch verification checks immediate structural effects after bounded mutations. Workflow postconditions evaluate declared file/output conditions and emit individual failures plus `run.postconditions_checked`. Terminalization emits `run.verification_passed` or `run.verification_failed` when verification applies. The run's verification contract snapshot freezes the applicable workflow/verifier context so later workflow changes do not silently reinterpret the attempt.

`runEvaluation` summarizes effectiveness, efficiency, violations, and runtime configuration. `runConsequence` summarizes committed effects from operation history and attempted/blocked effects from replay/events. Both are persisted on the run and paired with lifecycle events before `run.terminalized`.

Run status and lifecycle finality are distinct. `run.execution_completed` means execution ended but reconciliation may remain. A terminal `run.status` plus `run.terminalized` is the strongest current indication that reconciliation completed. Verification-required work is not objective-success evidence unless the verification verdict passed.

Ticket-level triage is persisted on the ticket; run-level triage is persisted on the run. `/triage` is a read-only projection of unresolved records. Resolution changes only the triage annotation (`required: false`, resolver, time, note), preserves the original reason/evidence/action guidance, and does not rerun, complete, fail, retry, or change status.

Rerun hardening requires unresolved ticket triage to be resolved before a new run and preserves existing failed-run and verification gates after triage resolution. Bounded auto-retry is decided inside `failAgentRun` before run triage is persisted. It applies only to allowlisted non-mutating runtime failures with finite policy and no blocking ticket triage; verification failure, authority denial, mutation evidence, and exhausted attempts fall through to normal triage behavior. r1.18 should display these facts but must not alter them.

Final versus pending human action:

- fully reconciled run: terminal run status plus `run.terminalized`;
- verified success: completed run with required verification passed, or completed run where verification was not required;
- pending human action: unresolved ticket/run triage;
- resolved annotation: triage acknowledged, but the underlying run/ticket status and verification outcome remain unchanged;
- auto-retried failure: failed attempt remains evidence, while a new pending attempt is a separate run.

## 9. Logs versus evidence

`logs.json` is useful because it provides concise operator-readable messages, workspace action summaries, and records of controls such as status changes, permissioned deletes, template triggers, and triage resolution. It is a practical UI source for narrative context.

Logs are not hash-chained, are persisted by rewriting a JSON array, may sanitize/truncate messages, and often duplicate stronger structured records. They must not become the canonical mutation, authority, verification, or lifecycle store when operation history, events, replay evidence, or materialized state exists.

One current limitation is important: triage resolution updates authoritative ticket/run state and writes a system log, but does not append a structured triage-resolution event. r1.18 may display the state plus that log, clearly labeled, but should not silently elevate all logs into canonical evidence or add a new ledger as part of timeline work.

## 10. Future r1.18 ticket timeline recommendation

Recommended milestone: `r1.18-ticket-timeline-and-authority-visibility`.

Scope:

- Build an on-demand ticket timeline projection from current ticket/run records, events, operation history, replay summaries/receipts, triage records, and provenance ledgers.
- Add no new runtime semantics, agent behavior, connector, Work Context, watcher, model routing, or autonomous action.
- Display ticket creation/current state and process-template version or scheduled-trigger provenance when present.
- Display each run attempt, rerun mode, lifecycle and reconciliation finality.
- Display authority decisions, including protected/owned scope and cross-ticket conflict context.
- Display target identity plus summarized read and mutation evidence.
- Display verification requirements, checks, verdict, evaluation, and consequence.
- Display unresolved/resolved triage without implying that resolution changed execution outcome.
- Distinguish committed mutations from attempted/denied operations.
- Distinguish authoritative state/evidence from diagnostic logs through source labels.
- Deduplicate overlapping event/replay/receipt records with stable source references.
- Keep the projection read-only and derive it per request or through a disposable cache, never as a second persisted source of truth.

## 11. Risks and gaps

### P0

- A persisted timeline could become a second source of truth and diverge from tickets, runs, events, and receipts.
- Combining duplicate surfaces without precedence rules could display denied attempts as committed mutations or allowed authority as successful execution.
- Replay snapshots could be mislabeled as proof of safe executable replay despite bounded snapshots and missing live preconditions.
- A timeline could expose full read content or pre-mutation content that current evidence retains for audit but should not be broadly rendered.

### P1

- Multiple history-like surfaces can confuse operators when event, replay, receipt, evaluation, consequence, and log entries describe the same action.
- Logs may be mistaken for authoritative evidence, especially where triage resolution currently has no structured event.
- Operation history covers mutations more strongly than reads; read receipts have no standalone ledger.
- Verification, terminalization, and triage do not yet have one clean timeline projection.
- Cross-ticket conflicts and some path guards do not always share the same `authority.denied` shape.
- Future connectors need provider-native versions, etags, ids, and replay preconditions stronger than current local receipts.

### P2

- Stale tests or tools may still expect inline `run.replaySnapshot` instead of `replaySnapshotPath`.
- Legacy tickets/runs can lack version, receipt, sequence, or normalized target fields.
- Telemetry-heavy scheduler/heartbeat events can overwhelm a user timeline if not collapsed.
- Derived evaluation/consequence fallbacks can be confused with persisted terminal records unless labeled.

## 12. Final recommendation

Do not add new history primitives and do not rewrite existing ledgers. Freeze the core model as:

```text
Ticket -> Run -> Event/Evidence -> Authority -> Verification -> Triage
```

Keep target read and mutation receipts as evidence of bounded operations, not triggers for autonomous behavior. Keep materialized ticket/run records authoritative for live state, the event ledger authoritative for append-only chronology, operation history authoritative for mutation commits, and replay snapshots as per-run evidence bundles.

r1.18 should be a projection and visibility implementation only. It should expose the existing sources with explicit provenance and precedence, not create a new source of truth.

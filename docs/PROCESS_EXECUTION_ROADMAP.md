# Authoritative process-execution roadmap

This document is the authoritative process-execution roadmap.
Implementation labels such as 2A0–2B are internal stages and do not replace
or redefine the eight original tranches.

## Official status

```text
Tranche 1: COMPLETE
Tranche 2: COMPLETE
Tranche 3: COMPLETE
Tranche 4: COMPLETE
Tranche 5: COMPLETE
Tranche 6: COMPLETE
Tranche 7: NOT STARTED
Tranche 8: NOT STARTED
```

Future tranches may have reusable prerequisites already implemented. A tranche remains
`NOT STARTED` until work begins against its frozen capability claim. Completed authority,
materialization, launcher, containment, lifecycle, artifact, evidence, cancellation, and
recovery systems are foundations to reuse, not parallel systems to rebuild.

## Tranche 1 — Declarative process profiles and authority

### Capability claim

A ticket run can hold immutable authority for a small, trusted, declarative process
profile without being able to execute a process.

### Required capabilities

- Trusted target and process-profile catalog.
- Explicit agent grants to target/profile combinations.
- Admission-time resolution of process authority.
- Immutable process-policy snapshot stored with the run.
- Phase restrictions for each profile.
- Closed profile authority covering:

  - trusted runtime identity;
  - executable identity;
  - fixed arguments;
  - fixed working directory;
  - fixed environment;
  - filesystem policy;
  - resource limits;
  - execution policy.

- Model-visible projection contains only target IDs, profile IDs, and required request
  fields.
- Executable paths, arguments, environment, limits, rootfs identity, and host paths
  remain private.
- Historical snapshot replay remains deterministic.
- No executor or process launch exists.

### Acceptance criteria

- Unauthorized target/profile requests fail closed.
- Later catalog changes do not modify existing run authority.
- Replay reconstructs the same authority.
- No process can start.

### Scope boundary

This tranche defines declarative authority only. It contains no executor or process
launch.

## Tranche 2 — Minimal safe process execution

### Capability claim

An exactly authorized process profile can execute through one bounded, fail-closed
runtime path, with no arbitrary command authority and no unsandboxed fallback.

### Required capabilities

- Immutable launch plan derived only from trusted profile authority.
- Immutable read-only materialization of the run workspace.
- Verified, versioned runtime rootfs.
- Verified executable identity.
- One authenticated native launcher.
- Kernel-enforced filesystem, process, network, syscall, and resource containment active
  before untrusted execution.
- Durable execution intent before launcher submission.
- Idempotent operation identity preventing duplicate launch.
- Authorized runtime dispatch for version-3 authority only.
- Bounded stdout and stderr handling.
- Durable terminal operation result.
- Cancellation and restart reconciliation sufficient to avoid duplicate execution.
- Default-off feature gate.
- No unsandboxed fallback.
- Existing non-process behavior remains unchanged.

### Acceptance criteria

- Exact authorized profile executes successfully.
- Unauthorized or malformed requests cannot execute.
- Same operation cannot execute twice across runtime or launcher restart.
- Process and descendants cannot escape containment.
- Output and terminal facts are bounded and truthful.
- Runtime or launcher interruption does not silently relaunch.
- Full release checkpoint passes.

### Scope boundary

The implementation stages 2A0 through 2B belong entirely to this tranche. This tranche
does not grant arbitrary command authority or permit an unsandboxed fallback.

## Tranche 3 — Evidence, artifacts, and crash recovery

### Capability claim

Every process execution has durable, truthful, reconstructable evidence and artifacts,
and all relevant crash windows converge without losing or duplicating execution history.

### Required capabilities

- Durable execution-operation identity.
- Durable start/acceptance evidence.
- Durable terminal evidence.
- Immutable stdout and stderr artifacts.
- Artifact metadata binds:

  - operation identity;
  - byte count;
  - cryptographic hash;
  - stream identity.

- Raw output is not stored inline in run evidence.
- Required evidence is append-only and idempotent.
- Generic operation receipts include process execution.
- Replay and run reconstruction include process operations.
- Runtime restart recovery for:

  - intent persisted before launch;
  - launcher acceptance before runtime persistence;
  - process active during runtime loss;
  - terminal result before artifact publication;
  - partial artifact transfer;
  - artifacts published before database binding;
  - terminal database state before evidence publication;
  - evidence publication before response delivery.

- Launcher restart recovery does not permit duplicate execution.
- Cancellation recovery is durable and idempotent.
- Lease-expiry recovery uses the same process cancellation authority.
- Artifact or evidence failure cannot be reported as successful completion.
- No fabricated exit code, signal, resource cause, output, or completion fact.
- Existing replay, evidence, recovery, and projection behavior remains intact.

### Acceptance criteria

- Every defined crash window converges to:

  - one execution;
  - one terminal operation;
  - one artifact per output stream;
  - one evidence set;
  - one operation receipt.

- Restart never causes duplicate execution.
- Artifact substitution, truncation, extension, or stream swapping is rejected.
- Missing evidence or artifacts leave the operation recoverable rather than falsely
  complete.
- Process receipts participate in ordinary replay and consequence reconstruction.
- Full PostgreSQL and release validation passes.

### Scope boundary

This tranche is about durable truth and recovery, not adding another launcher, executor,
artifact system, or recovery subsystem.

## Tranche 4 — Kernel-enforced containment

### Capability claim

Process isolation is enforced by the operating system rather than by application-level
path checks, and the complete process tree remains owned and terminable.

### Required capabilities

- Dedicated launcher principal.
- Dedicated materializer principal.
- Runtime principal cannot traverse launcher/materializer private state.
- Launcher-only immutable workspace descriptor handoff.
- No mutable host workspace path in launch authority.
- Verified read-only rootfs.
- Read-only workspace mount.
- Fresh mount namespace.
- Fresh PID namespace.
- Fresh network namespace.
- Fresh IPC and UTS namespaces.
- User namespace or equivalent privilege isolation.
- Private `/proc`.
- Minimal `/dev`.
- Bounded private `/tmp`.
- No host home, runtime state, database socket, session bus, SSH agent, artifact root, or
  protected project state mounted.
- `no_new_privs`.
- Capabilities dropped.
- Pinned seccomp policy.
- External network communication denied.
- Cgroup v2 operation ownership.
- Enforced process-count and memory limits.
- CPU quota treated as throttling, not fabricated terminal exhaustion.
- Output and wall-time enforcement.
- Process-tree cancellation through the operation cgroup.
- Double-fork, new-session, ignored-signal, and daemonization resistance.
- Launcher crash kills or truthfully terminalizes descendants.
- Stale cgroup cleanup.
- Cross-UID active proof.
- Fixed Node runtime compatibility proof.

### Acceptance criteria

- Containment is active before the first untrusted instruction.
- Host filesystem and protected state cannot be reached.
- External IPv4, IPv6, DNS, TCP, UDP, Unix-host-socket, Netlink, and inherited-socket
  paths are unavailable as defined by the contract.
- Blocked syscalls are actually denied.
- Processes and threads cannot exceed policy.
- Memory enforcement is attributable through cgroup evidence.
- Cancellation and launcher death leave no descendant alive.
- All operation cgroups reach `populated 0`.
- Fixed trusted Node profile executes successfully inside containment.
- Mandatory real Linux, cgroup, namespace, seccomp, and multi-UID suite passes.

### Scope boundary

This tranche does not require multiple sandbox backends, arbitrary writable mounts,
generalized container orchestration, or another launcher.

## Tranche 5 — Runtime budgets and scheduling

### Capability claim

The runtime admits and schedules work only when bounded capacity exists, enforces
ticket/run budgets consistently across all operation types, and fails deterministically
under exhaustion.

### Required capabilities

- One canonical budget model covering applicable:

  - model requests;
  - execution steps;
  - workspace operations;
  - process operations;
  - browser operations;
  - elapsed runtime;
  - output/artifact limits;
  - concurrency.

- Ticket execution-policy limits are enforced rather than merely recorded.
- Existing runtime defaults remain the fallback when policy values are null.
- Admission estimates required work where deterministic information exists.
- Work that cannot fit hard limits is rejected before execution where possible.
- Actual usage is charged once to the correct run/ticket authority.
- Retries and recovery do not double-charge completed work.
- Scheduling honors:

  - global capacity;
  - per-target capacity;
  - per-run serialization requirements;
  - process-launcher capacity;
  - database coordination;
  - configured concurrency.

- Backpressure is explicit.
- Capacity exhaustion does not create busy loops or repeated model calls.
- No starvation caused by permanently reacquiring one runnable item.
- Lease and heartbeat behavior remain compatible with long-running bounded operations.
- Budget and scheduling outcomes are observable and reconstructable.
- No second scheduler or parallel budget authority is introduced.

### Acceptance criteria

- Runs cannot exceed snapshotted hard budgets.
- Concurrent runtime instances cannot oversubscribe the same guarded capacity.
- Admission rejects deterministically impossible work.
- Recovery resumes with correct remaining budget.
- Exhaustion produces stable typed outcomes.
- Existing workload classes remain functional.
- Full concurrency, PostgreSQL, recovery, and release validation passes.

### Scope boundary

This tranche extends the canonical scheduler and budget authority. It does not add a
second scheduler or parallel budget authority.

### Implemented contract

Every new run stores a closed version-1 `runtimeBudgetSnapshot` before execution. It
resolves `maxAttempts`, execution steps, model requests, workspace operations, process
operations, browser operations, elapsed runtime, aggregate output-artifact bytes, and
`allowParallelRuns` from the admitted execution policy and the referenced runtime-limit
revision. A `null` ticket limit means the concrete value from that revision; historical
runs without this snapshot keep their prior compatibility behavior and are not silently
reinterpreted. One atomic owned-scope allocation wave is one ticket attempt even though
it contains one run per allocated agent; ordinary single-run admission is one attempt.

PostgreSQL table `run_budget_charges` is the single reservation and charging authority.
Its canonical identities are the durable provider-request identity, runtime-step
identity, workspace operation-receipt identity, process operation identity, browser
operation-receipt identity, and immutable stream-artifact identity. Reservations precede
covered effects, transition forward to committed or released, and are reconciled from
durable provider, receipt, process-operation, and artifact facts after recovery. Process
output remains subject to its launcher ceiling in addition to the aggregate run artifact
budget.

Feasibility admission rejects only deterministic lower bounds already present in trusted
facts, such as a declared operation batch or workflow step count that cannot fit the
snapshot. Vague objectives are not assigned inferred costs, and no model call estimates
feasibility.

The existing scheduler remains authoritative. PostgreSQL coordinates global active-run,
configured local-model, target, and process-launcher capacity. Same-run lease fencing and
workspace mutation serialization remain unchanged; `allowParallelRuns: false` prevents
simultaneous active runs for one ticket. Capacity waits retain their first eligibility
time and use stable run-ID ordering, while unrelated capacity keys remain eligible.
Waiting is persisted and emitted once as backpressure rather than causing model
re-entry. Capacity ownership renews with the run lease, expires fail-closed, and is
reclaimed deterministically; process lease loss continues through the existing durable
cancellation and reconciliation path.

Append-only budget, capacity, and feasibility events reconstruct the admitted snapshot,
committed and reserved usage, remaining limits, the current wait, and final exhaustion.
The stable outcome distinctions are `RUN_FEASIBILITY_REJECTED`,
`RUN_BUDGET_EXHAUSTED`, `RUN_RUNTIME_DURATION_EXCEEDED`, temporary capacity waiting,
and the typed capacity integrity failures. None represents objective completion.

Future work must reuse this snapshot, charge ledger, PostgreSQL capacity leases, canonical
scheduler, run leases, operation receipts, artifacts, evidence, and existing process
recovery. It must not introduce a second budget authority, scheduler, launcher-capacity
registry, or recovery path.

## Tranche 6 — Verification and completion semantics

### Capability claim

The runtime distinguishes successful operations from completed objectives and
terminalizes only from deterministic, evidence-backed postconditions.

### Required capabilities

- Operation success does not automatically equal ticket completion.
- Declared postconditions are evaluated against durable operation receipts and observable
  state.
- Process results participate in the same completion system as workspace and browser
  operations.
- Required verification cannot be bypassed by model claims.
- Completion evidence is truthful and reconstructable.
- Failed verification remains distinguishable from failed execution.
- Incomplete objectives cannot be marked completed merely because limits were exhausted.
- Postcondition evaluation survives restart and replay.
- Contradictory or missing evidence fails closed.
- Existing workflow semantics remain compatible.
- No generalized theorem prover or unrestricted workflow engine is added.

### Acceptance criteria

- Objective-complete, operation-successful-but-incomplete, verification-failed, and
  infrastructure-failed cases remain distinct.
- Replay produces the same completion result.
- Model completion claims cannot override deterministic postconditions.
- Required evidence is observed before terminal completion.
- Full postcondition, replay, recovery, and release validation passes.

### Scope boundary

This tranche does not add a generalized theorem prover or unrestricted workflow engine.

### Implemented contract

Completion follows one authority hierarchy:

```text
durable observable facts
→ durable operation receipts
→ deterministic consequence reconstruction
→ declared postcondition evaluation
→ immutable verification policy
→ completion decision
→ model claims
```

A lower source cannot contradict or override a higher source. In particular, a model
completion statement is retained only as a non-authoritative claim. Operation success,
artifact existence, absence of a known violation, cancellation, and budget exhaustion
cannot establish objective completion by themselves.

Each newly admitted run freezes a closed version-1 `completionAuthoritySnapshot`. It
binds the objective hash and recognized deterministic kind, the existing completion
policy, normalized direct postconditions, the immutable `requireVerification` policy,
and its own canonical hash. The only supported verification policy remains
`when_declared`: declared postconditions are required and all are evaluated; without a
declaration verification is explicitly `not_required`, but that state does not turn an
unrecognized objective or a model claim into completion. Invalid or future policy values
fail closed. Historical runs without this authority retain explicitly labelled
compatibility behavior.

The existing immutable `run_consequences` record owns one canonical version-1
`completionDecision`; no parallel completion store exists. Its three independent closed
dimensions are:

```text
executionDisposition:
  succeeded | failed | cancelled | budget_exhausted | infrastructure_failed

verificationDisposition:
  not_required | passed | failed | unavailable

completionDisposition:
  completed | incomplete | blocked
```

The decision binds the run and ticket, admitted objective/workflow/policy/budget hashes,
operation-receipt authority, consequence authority, required-evidence authority,
evaluated postconditions, violations, missing or contradictory evidence, the bounded
model claim as non-authority, a stable reason code, evaluation time, and a canonical
decision hash. It is append-only with the consequence: exact reconstruction is
idempotent, mutation and deletion remain prohibited by the existing consequence
constraints, and conflicting replay fails closed.

The existing deterministic completion language is preserved. Direct folder, file, and
absence requirements use their admitted normalized contracts, governed workspace state,
durable workspace receipts, and finalized replay checks. Existing workflow
postconditions retain their exact file/output evidence inputs. The only process
predicates added are closed exact-metadata checks for an identified durable process
operation, its terminal outcome, or a named stdout/stderr artifact with exact immutable
metadata. They consume the existing `processOperations` consequence and process terminal
and artifact evidence; raw process output is never interpreted. Browser verdicts use the
existing durable receipt/evidence classifier. A successful process exit, workspace
mutation, navigation, or browser observation remains an operation fact rather than a
completion shortcut.

Missing or contradictory receipt, terminal, artifact, browser-verdict, workspace, or
consequence authority produces `verification: unavailable` and
`completion: blocked`; deterministically false postconditions produce
`verification: failed` and `completion: incomplete`. The runtime does not select the
more favorable source, call a model to arbitrate, or fabricate an unknown fact.

Terminalization reuses the canonical PostgreSQL bundle and required-evidence drain:
owned operations and receipts settle, required evidence is observed, the consequence
and decision are reconstructed, `run.completion_decided` is appended idempotently, the
run terminalizes, and ticket projection follows the persisted decision. Crash recovery
at each boundary retrieves or recreates the exact same decision and evidence without
rerunning a side effect. Current runs can project a completed ticket only from
`completionDisposition: completed`; incomplete and blocked outcomes cannot inherit a
model-facing completed run status.

Stable integrity and outcome codes include `COMPLETION_DECISION_INVALID`,
`COMPLETION_DECISION_CONFLICT`, `COMPLETION_EVIDENCE_MISSING`,
`COMPLETION_EVIDENCE_CONTRADICTORY`, `COMPLETION_CONSEQUENCE_INVALID`,
`POSTCONDITION_EVALUATION_FAILED`, `POSTCONDITION_EVIDENCE_UNAVAILABLE`,
`POSTCONDITION_UNSUPPORTED`, `OBJECTIVE_INCOMPLETE`, `VERIFICATION_REQUIRED`,
`VERIFICATION_FAILED`, and `VERIFICATION_UNAVAILABLE`.

Future work must reuse the admitted authority snapshot, `run_consequences`, generic
operation receipts, replay, required evidence, PostgreSQL terminalization, and the
existing workspace/browser/process consequence paths. It must not introduce a second
completion, consequence, receipt, evidence, or recovery subsystem.

## Tranche 7 — Supervised process lifecycle

### Capability claim

Operators can safely understand and supervise active process work without gaining
arbitrary execution authority or weakening runtime ownership.

### Required capabilities

- Process lifecycle is visible through existing run and operation surfaces.
- Active, cancelling, finalizing, terminal, interrupted, and failed states are represented
  truthfully.
- Operator cancellation uses the same durable launcher cancellation path.
- Restart and reconciliation status is visible.
- Output artifacts and hashes are discoverable through existing artifact/evidence
  surfaces.
- Operator actions are authorized and audited.
- No direct PID, cgroup, shell, signal, command, path, or containment-option authority is
  exposed.
- No separate process-control UI backend or shadow lifecycle is created.
- Operational diagnostics distinguish policy denial, capacity exhaustion, containment
  failure, execution failure, artifact failure, evidence failure, and recovery failure.

### Acceptance criteria

- Operator views match durable PostgreSQL and launcher state.
- Cancellation cannot terminalize the run while the process tree remains active.
- Repeated operator actions are idempotent.
- Unauthorized users cannot inspect or control process operations.
- Existing run-detail and evidence interfaces remain coherent.
- Full authorization, page-render, recovery, and release validation passes.

### Scope boundary

This tranche uses existing run, operation, artifact, and evidence surfaces. It adds no
direct process authority and no shadow lifecycle.

## Tranche 8 — Release hardening and GA

### Capability claim

Process execution can be deployed, operated, upgraded, retained, and rolled back safely
under production conditions.

### Required capabilities

- Production installation and upgrade procedure.
- Dedicated users, groups, directories, ownership, and permissions.
- Validated systemd service and tmpfiles configuration.
- Required kernel, cgroup, namespace, Bubblewrap, seccomp, rootfs, and subordinate-UID
  prerequisites.
- Startup health and fail-closed behavior.
- Production feature enablement procedure.
- Migration rollout and rollback policy.
- Rootfs and executable update/retention policy.
- Seccomp policy update/versioning procedure.
- Launcher registry retention and tombstone compaction that cannot permit
  operation-identity reuse.
- Artifact retention and cleanup.
- Capacity monitoring and alerting.
- Audit and incident diagnostics.
- Upgrade compatibility for in-flight and terminal operations.
- Backup and disaster-recovery expectations.
- Release gates cannot silently skip privileged containment or PostgreSQL tests when
  execution is enabled.
- Documented rollback disables new launches without abandoning owned active processes.
- Final end-to-end production-like validation.

### Acceptance criteria

- Fresh production-like deployment passes active containment and execution.
- Upgrade preserves or truthfully reconciles existing operation state.
- Rollback fails closed and does not leak descendants.
- Retention cannot enable duplicate execution or destroy required evidence prematurely.
- Operational failure modes are documented and tested.
- GA checklist and complete release checkpoint pass.

### Scope boundary

This tranche hardens deployment and operations for general availability. It reuses the
existing process authority, launcher, containment, lifecycle, evidence, artifact, and
recovery systems.

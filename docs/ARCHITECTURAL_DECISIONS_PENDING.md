# Architectural Decisions Pending

This is the **canonical register of open integrity defects, deferred work, and pending
architectural decisions**. It is the single authoritative record: nothing required to
understand, operate, audit, recover, or continue this project may exist only in agent
memory, chat transcripts, scratchpads, or private notes. A defect or decision discovered
during work must be recorded here before that work ends, or the work must state explicitly
that it was not recorded because repository scope was not authorized.

Secondary documents link here rather than restating an entry. Where an entry names a
governing design memo, that memo holds the rationale and this register holds the status.

---

### A27. The ticket-simulation provider call is unbounded

| Field | Value |
|-------|-------|
| **Status** | **Open.** Found during the Tranche 2B provider-seam audit; not fixed there because it is outside that tranche's scope |
| **Severity** | **Medium** — an operator-triggered endpoint can hold a request open indefinitely against a hung provider |
| **Discovered by** | Auditing every `callModelProvider` call site for Tranche 2B reuse |

`POST /api/tickets/:id/simulate` (`server.js`, the `includeModelPlan` branch) calls:

```js
modelResponse = await callModelProvider(agent, input, { simulation: true, timeout: 30000 });
```

`callModelProvider` reads only `options.signal` and `options.onRequest`. Both
`simulation` and `timeout` are silently ignored, so this call has **no timeout and no
abort path at all**. For `ollama` it goes through `providerHttpJsonRequest`, which is
documented as having no implicit timeout by design because the run's `AbortController`
is meant to be the sole budget — and here there is no controller. For `openai` it
inherits only undici's default header timeout.

Every other provider call site passes a real `AbortSignal`
(`callModelProviderWithRunTimeout` for runs; a dedicated `AbortController` for the
Tranche 2B planner request). This endpoint is the only one that does not.

**Why it was not fixed in Tranche 2B.** The tranche's authorized surface is structured
allocation planning. Changing simulation-endpoint timeout behavior is an unrelated
runtime policy change with its own operator-visible effect, and folding it into a
planner-admission commit would hide it. Tranche 2B instead constructs its own
`AbortController` and does not reuse the simulation call's option shape.

**Decision needed.** Either give the simulation endpoint an explicit
`AbortController` with a documented bound, or delete the two dead options so the
absence of a timeout is visible in the source rather than implied by them.

---

## Process-execution GA release blockers (2026-07-29)

| Field | Value |
|-------|-------|
| **Status** | **Resolved 2026-07-29 — patched production graph and clean authorized external audits; final GA validation remains in progress** |
| **Scope** | Tranche 8 GA release evidence |
| **Original code** | `PROCESS_RELEASE_VULNERABILITIES_FOUND` |

The prior backup/restore and bounded-soak scripts were not valid GA evidence: the
former rebuilt the same fixture in a new empty schema and the latter printed
hard-coded zero-leak/no-duplicate claims. Both have been replaced. The bounded
soak passes with measured PostgreSQL, launcher, artifact, receipt, completion,
capacity, cancellation, restart, and compaction observations. The backup test
passes through an actual `pg_dump` custom archive plus `pg_restore` into a
separate schema, paired with a separately restored artifact tree and no
reseeding.

The authorized external audit ran on 2026-07-29. `pnpm` 11.8.0 reported three
high-severity advisories in the shipped production Fastify dependency graph:

- `GHSA-v2hh-gcrm-f6hx`: `fast-uri` 3.1.2, fixed in 3.1.4 or later;
- `GHSA-4c8g-83qw-93j6`: `fast-uri` 3.1.2, fixed in 3.1.3 or later
  (3.1.4 therefore satisfies both `fast-uri` advisories);
- `GHSA-c96f-x56v-gq3h`: `find-my-way` 9.6.0, fixed in 9.6.1 or later.

`fast-uri` and `find-my-way` are transitive production dependencies beneath the
direct shipped dependency `fastify` 5.8.5, not development-only packages. The
locked RustSec audit tool `cargo-audit` 0.22.2 found zero advisories across 22
locked dependencies in each of the launcher and materializer components, using
RustSec database commit `7c7ccac53056b87f69ac677f15ea2d9a98a6f8e2`.

The authorized remediation updated the direct Fastify v5 dependency from
5.8.5 to 5.10.0 and refreshed only its required production subtree.
`find-my-way` moved from 9.6.0 to 9.7.0. The former `fast-uri` 3.1.2 paths
now resolve to 3.1.4 through AJV and to 4.1.1 through
`fast-json-stringify`. No override, advisory allowlist, automatic fix,
Cargo-lock change, registry change, Git dependency, or local-filesystem
dependency was introduced.

The authorized external gate was rerun on 2026-07-29 with `pnpm` 11.8.0 and
`cargo-audit` 0.22.2:

```sh
PROCESS_RELEASE_NETWORK_AUDIT=1 npm run release:security
```

The production Node report contained zero critical, high, moderate, low, or
informational vulnerabilities across 83 dependencies. Each native lockfile
contained 22 dependencies and reported zero RustSec vulnerabilities using
database commit `7c7ccac53056b87f69ac677f15ea2d9a98a6f8e2`.

The dependency blocker is resolved, but this record does not by itself close
Tranche 8. The final candidate checkpoint and the complete GA command must
still pass from the exact clean committed source. The GA command remains
fail-closed and cannot print `PROCESS EXECUTION GA RELEASE PASSED` if a
mandatory gate is skipped, unavailable, or inconclusive.

---

## Execution-Governance Audit (2026-07-25)

A read-only execution-governance integrity audit was performed against run #8 (ticket #3,
objective `create folders A-Z in the workspace`, agent Mike / `gemma3:latest`), which failed
as `MODEL_RESPONSE_CONTRACT_VIOLATION` with zero mutations. The audit examined every
mechanism that can admit or reject a run, restrict model visibility, limit budgets, truncate
or reject model output, detect stalls, terminate a run, change behavior after recovery, or
alter completion eligibility.

Commit `a1143e6` ("Make execution semantics reconstructable") fixed the **evidence
truthfulness and reconstructability** findings only. Everything below was audited,
confirmed against source, and deliberately left unfixed. Severity is stated in terms of what
the defect can cause, not how hard it is to fix.

### Status summary

| # | Defect | Severity | Status | Class |
|---|--------|----------|--------|-------|
| A1 | Workspace-snapshot failure truthfulness (E4) | **High** | **Implemented** `ee44369` + `3f6d4ac` — entry retained for the record | Correctness |
| A2 | Live-state vs immutable-snapshot mutation counting (E5) | Medium | Open | Correctness |
| A3 | Wall-clock and progress-counter recovery resets | **High** | Closed for governed structured leaf execution; open elsewhere | Bounds integrity |
| A4 | Enforcement gates bypass the immutable policy snapshot | Medium | Open | Architecture |
| A5 | Workload-profile re-resolution | Low | Open | Architecture |
| A6 | Gate ordering vs prefix truncation | Medium | **Governance decision required** | Policy |
| A7 | Objective-grammar anchoring | Medium | **Governance decision required** | Policy |
| A8 | Dead `allow*` policy fields | Low | Open | Dead contract |
| A9 | Latency-aware feasibility | Medium | Open | Feasibility |
| A10 | Orphaned PostgreSQL-era test harnesses | **High** | **Resolved for the inventoried 14** — see entry; wider orphan population newly recorded | Verification gap |
| A11 | `truncated:true` disclosed to the model but never explained | Low | Open — split from A1 | Prompt policy |
| A12 | Bounded workspace-snapshot recovery policy | Medium | **Open — decision required** — residual of A1 | Policy |
| A13 | Tests asserting removed commit-idempotency helpers | Medium | **Resolved 2026-07-26** — five retired, two contracts re-expressed behaviorally; one residual `verifyBatchOperation` gap | Verification gap |
| A14 | Redundant-mutation postcondition shortcut does not fire | **High** | **Implemented** — see entry | Correctness |
| A15 | Postcondition telemetry names a source the event never reaches | Low | **Open — decision required** | Documentation / telemetry |
| A16 | Run consequence records no committed mutations | **High** | **Implemented** — see entry | Correctness |
| A17 | Delegated handoff logging crashes the server process | **Critical** | **Open — implementation required** | Correctness / availability |
| A20 | Repository-wide PostgreSQL-cutover test-orphan population | **High** | **Open** — inventory complete, anti-rot implemented; 81 orphans remain | Verification gap |
| A21 | Ticket reassignment silently discarded; audit trail asserts otherwise | **High** | **Implemented 2026-07-26** — see entry | Correctness / truthfulness |
| A22 | Resume after a committed workspace operation fails on an idempotency conflict | **High** | **Implemented 2026-07-26** — see entry | Correctness / recovery |
| A23 | Deterministic crash-seam coverage was incomplete | Medium | **Closed 2026-07-26** — all nine seams driven | Verification gap |
| A24 | Absolute host filesystem paths disclosed to the model provider | **High** | **Implemented 2026-07-27** — see entry | Privacy / disclosure |
| A25 | Bounded automatic retry never executed — `ReferenceError` swallowed | **High** | **Implemented 2026-07-27** — see entry | Correctness / dead feature |
| A26 | `countRunMutatingOperations` always returns 0; the mutated-run retry guard is inert | **High** | **Implemented 2026-07-27** — see entry | Correctness / safety |

### Sequencing

1. **A10 first.** Until the orphaned harnesses are repaired or replaced, there is no working
   feasibility or postcondition coverage in the release checkpoint, so A1/A2/A9 cannot be
   validated through their natural suites.
2. **A1 (implemented), then A2.** A1 changed when a run stops; A2 changes what the feasibility
   gate counts. A1 shipped with purpose-built coverage because A10 leaves no working
   feasibility/postcondition suite to host it.
3. **A3 and A12 together.** A3 tightens an effective limit and will fail runs that previously
   passed, so it needs its own observation window; A12's retry bound depends on whether A3's
   per-attempt wall-clock reset is fixed. Deciding either alone changes the other's behavior.
4. **A6 and A7** are governance decisions, not defects to fix unilaterally. Do not implement
   either without a recorded decision.
5. **A4, A5, A8, A9** may follow in any order.

---

### A1. Workspace-snapshot failure truthfulness (E4)

| Field | Value |
|-------|-------|
| **Status** | **Implemented 2026-07-25** in `ee44369` (representation, classification) and `3f6d4ac` (recovery lifecycle correction); entry retained as the decision record |
| **Severity** | High — converts an infrastructure failure into confident model action |
| **Evidence** | `server.js` `captureRunWorkspaceRootSnapshot`; capture sites at run start and per step |
| **Decision** | Fail closed at both capture sites; representation must never encode failure as an empty listing |

**Description:**

When the root workspace listing throws, the catch path returns a snapshot with
`entries: []`, `truncated: false`, `entryCount: 0`, plus an `error` key. A listing *failure*
is therefore indistinguishable from a legitimately *empty* workspace in every field the
model is instructed to read. The system prompt never mentions `error` or `truncated`, so a
model receiving this reasonably concludes the workspace is empty and may create the full
target state from scratch, or treat pre-existing artifacts as absent.

The failure is also recorded as evidence: the run-start snapshot is persisted to
`replaySnapshot.targetSnapshots` and emits `target.snapshot.captured`. Encoding failure as an
empty listing therefore makes the *diagnostic record* assert a clean empty workspace for a run
that never managed to read it — independent of any model.

**Why fail closed rather than flag and continue.** A thrown listing can never mean "the
workspace does not exist yet": `resolveInside` calls `ensureRoot()` (`mkdirSync` recursive)
before every operation, so a missing root is created and yields an empty listing. Every
reachable cause of a throw is abnormal — mkdir failure (EACCES/EROFS/ENOSPC, or the root path
occupied by a file), a containment rejection from `assertRealPathInside`, or `readdirSync`
failing with EACCES/EIO. `docs/SYSTEM_STATUS.md` already states the house rule: *"Fatal
persistence/integrity failures fail closed so mutation work never proceeds without its
required evidence."* The run-start snapshot is required evidence — it anchors relative
objectives.

**Why the per-step site also stops.** `initialWorkspaceSnapshot` plus `mutationsByThisRun` is
durable reconstruction evidence, but it is **not** authoritative current workspace state. It
cannot exclude external changes, partial or unexpected filesystem effects, changed
permissions, containment changes, or divergence between recorded results and present reality.
Continuing on reconstruction alone would let the model act on a workspace nobody can currently
observe.

### Decided shape

**Representation — every capture site, success and failure:**

- `available: false` on failure, `available: true` on success
- `entries: null`, `entryCount: null`, `truncated: null` on failure — never `[]`, `0`, `false`
- sanitized structured error classification
- failure is never encoded as a successful empty listing

**Run-start capture failure:**

- emit durable replay and journal evidence
- terminate before the first model request
- permit no mutations
- classify as an environment/integrity failure — not a model or provider failure

**Per-step capture failure:**

- preserve all mutations and evidence already committed by the run
- stop before another model request or mutation
- place the run into a recoverable state; stopping is **not** rollback, and completed
  mutations are **not** automatically redone
- resume only after recovery successfully captures a fresh current-workspace snapshot

*Mechanism (corrected in `3f6d4ac`):* stop without terminalizing and **retain** the lease.
`failAgentRun` is not called, so no terminal event, triage, or status transition is written.
The lease is deliberately not released: releasing it nulls `lease_owner`, which
`listRecoverableRuns` matches immediately — making the run reclaimable while the invocation is
still unwinding, and collapsing the stop into a single instant retry. Heartbeats stop with the
invocation, so the lease simply expires, and only then does the architecture's existing
lease-expiry recovery claim the run and re-enter `runAgentTicket`. Retry cadence is therefore
bounded to one attempt per lease duration. No new recovery machinery.

*Verified while deciding this:* run statuses are `pending`, `running`, `completed`, `failed`,
`interrupted`, with the last three in `TERMINAL_RUN_STATUSES`; `interruptAgentRun`
terminalizes; and both recovery modes in `listRecoverableRuns` gate on
`status = 'running' AND (lease_owner IS NULL OR lease_expires_at <= clock_timestamp())`. No
stable recoverable-stopped state exists to adopt, so lease retention plus a state-aware guard
is the smallest truthful mechanism.

**Recovery:**

- record the previous capture failure
- attempt a new capture on re-entry
- a failed recovery capture **remains recoverably stopped** — it does not terminalize; only a
  first failure on a run with no unresolved prior failure terminalizes
- resume only once some later capture succeeds, which records recovery exactly once

*Availability is a transition, not an existence check* (`runtime/workspace-snapshot-availability.js`):
the latest ordered transition between `workspace:snapshot_unavailable` and
`workspace:snapshot_recovered` decides both whether a failure terminalizes or stops
recoverably, and whether a successful capture records recovery. Existence-based logic
re-emitted recovery on every later entry and could not distinguish a first failure from a
failure during recovery.

**Residual, unresolved:** A1 decided *that* a failed capture stops recoverably; it did not
decide how long that may continue. The resulting indefinite lease-cadence retry is **not an
approved behavior** — it is the current behavior pending a policy decision, tracked separately
as **A12**. Do not read A1's implemented status as approval of unbounded retry.

**Classification — distinct codes, shared fail-closed plumbing:**

| Code | Cause | Significance |
|------|-------|--------------|
| `WORKSPACE_CONTAINMENT_VIOLATION` | `assertRealPathInside` rejection (symlink escape) | Security-relevant; must stay distinguishable in triage |
| `WORKSPACE_SNAPSHOT_UNAVAILABLE` | I/O or availability failure (EACCES, EIO, ENOSPC, ENOTDIR, mkdir failure) | Environment fault; ordinarily retryable |

**Explicitly out of scope for A1:** no model-prompt changes. Under this decision the model
never receives `available: false` — the run stops first. Guidance for `truncated: true`
affects healthy runs and is split out as **A11**.

### A1 blockers — all resolved in `3f6d4ac`

Raised 2026-07-25 against `ee44369`; all five resolved in `3f6d4ac`. Representation
(`available:false`, null counts) and classification (two distinct codes) were accepted as
landed. The recovery implementation was not, and the suite did not catch it. Retained because
B5 is a standing lesson about how these tests can pass while proving the wrong thing.

**B1 — "recoverable stop" was one automatic retry, then terminalization.** The per-step stop
released the lease, which made the run immediately reclaimable; the recovery sweep re-entered
at once and, if the fresh capture also failed, the run-start guard *terminalized* it. The
decided behavior requires the run to remain recoverably stopped and to resume only after a
later successful capture. An immediately-expired running lease is not a stable recoverable
state.

**B2 — no stable recoverable-stopped state exists in the architecture.** Verified: run
statuses are `pending`, `running`, `completed`, `failed`, `interrupted`, with the last three
in `TERMINAL_RUN_STATUSES`. `interruptAgentRun` terminalizes, so it does not provide these
semantics. `listRecoverableRuns` gates **both** recovery modes on the identical condition —
`status = 'running' AND (lease_owner IS NULL OR lease_expires_at <= clock_timestamp())` — so a
released lease is claimed immediately and there is no "stopped, awaiting recovery, not yet
retryable" state to adopt.

**B3 — claim race.** Releasing the lease inside the `catch` made the run reclaimable while the
original `runAgentTicket` invocation was still unwinding its `finally`.

**B4 — recovery evidence was existence-based, not transition-based.** The acknowledgement
fired whenever *any* historical `workspace:snapshot_unavailable` event existed, so a later
clean re-entry would emit a duplicate recovery event for an already-resolved failure.

**B5 — the suite proved the wrong thing.** The assertion labelled *"failed recovery capture
cannot resume — the only post-guard path throws"* tested `recoverableStop: false` in the
run-start guard. That is the terminalizing behavior, i.e. the defect. The assertion was
written to match the implementation rather than the requirement, and passing it was reported
as covering scenario 7 ("failed recovery capture remaining stopped"). Source-level assertions
cannot establish lifecycle behavior; that scenario needs real store/server coverage.

**Implementation (`ee44369`, recovery lifecycle superseded by `3f6d4ac`):**
`classifyWorkspaceSnapshotFailure`,
`isWorkspaceSnapshotUnavailable`, `createWorkspaceSnapshotFailureError`, and
`recordWorkspaceSnapshotFailure` in `server.js`; guards at both capture sites; recoverable-stop
branch in the `runAgentTicket` catch; recovery acknowledgement
(`workspace:snapshot_recovered` / `workspace.snapshot_recovered`) emitted after a successful
re-capture. Coverage is split by what each suite can honestly establish:
`scripts/workspace-snapshot-availability-test.js` (93 checks) covers representation,
classification, and transition logic; `scripts/workspace-snapshot-recovery-test.js`
(34 checks) proves the recovery lifecycle against a real server, a real store, and a real
EACCES fault induced with `chmod 000` — all twelve lifecycle scenarios. Both are registered in
the release checkpoint. Purpose-built rather than routed through the orphaned suites — see A10.

`isWorkspaceSnapshotUnavailable` treats only an explicit `available: false` as failure, so
snapshots persisted before this change are read as available rather than retroactively
appearing unreadable.

---

### A2. Live-state vs immutable-snapshot mutation counting (E5)

| Field | Value |
|-------|-------|
| **Status** | Open |
| **Severity** | Medium — understates required mutations on reruns |
| **Evidence** | `server.js` `countRequiredContractMutations` |
| **Decision required** | Whether feasibility counts against run-start state or live state |

**Description:**

`countRequiredContractMutations(contract, initialWorkspaceSnapshot)` accepts the run-start
snapshot as a parameter and **never reads it**. The body queries live filesystem state
through the module-global `workspaceProvider.getPathInfo`, contradicting two of its own
comments that claim it uses the initial snapshot. On a rerun, artifacts created by a prior
attempt are counted as pre-existing, so the required-mutation count — and therefore the
feasibility projection recorded in `run.feasibility_decision` — understates the real work.

It also reads the module-global provider rather than the run's own provider, which is
questionable for owned-scope runs.

**Constraint:** changing this changes run admission. Separate tranche, with tests.

---

### A3. Wall-clock and progress-counter recovery resets

| Field | Value |
|-------|-------|
| **Status** | Open |
| **Severity** | High — no mechanism bounds total run cost across recoveries |
| **Evidence** | `server.js` `runAgentTicket` loop-entry initialization and resume block |
| **Decision required** | Whether these limits are per-run or per-attempt, and which counters must be durable |

**Description:**

At execution-loop entry the runtime rehydrates some state from durable evidence and resets
the rest. Restored: workspace-operation count, model-request count (recomputed from durable
evidence), listed directory paths, current phase, and the action-contract violation streak.
**Not restored:** the run-start timestamp used for the wall-clock check, the `listDirectory`
and `readFile` counters, the stalled-response counter, and the inspection-no-progress counter.

Consequences:

- `maxRuntimeDurationMs` is enforced per loop entry, not per run. A run that recovers N times
  receives N × the configured wall-clock budget. There is no persisted run-start timestamp.
- `maxListDirectoryPerRun` and `maxReadFilePerRun` are named `PerRun` but are enforced per
  loop entry.
- The stall and inspection-no-progress termination counters reset on recovery, while the
  action-contract streak was deliberately made restart-durable (see
  `runtime/action-contract-streak.js`, which documents why). A model can evade the two
  reset counters indefinitely across recovery cycles by exactly the mechanism the streak
  design was built to prevent. `server.js` carries an acknowledging comment
  ("We don't track stalled across restarts").

**Constraint:** fixing the wall clock tightens an effective limit and will fail runs that
previously passed. Stage behind observation.

#### Verdict after Tranche 5 (2026-08-02): CLOSED FOR GOVERNED STRUCTURED LEAF EXECUTION

A3 is now closed for governed structured leaf execution, and remains open outside it. The
boundary is stated precisely because the two halves were closed in different sessions and
it would be easy to over-read the result.

**Closed — governed structured leaf Runs.** For this execution family, every quantity A3
names survives recovery, because every one of them is reconstructed from durable rows
rather than carried in memory:

- cumulative requests survive recovery;
- cumulative operations survive recovery;
- cumulative economic consumption survives recovery;
- no-progress history survives recovery;
- cumulative execution duration survives recovery;
- persisted stops survive recovery.

The duration half — the part left open by the previous verdict — is enforced by
`maximumCumulativeExecutionDurationMs`, a closed progress-policy field captured immutably
on the Run at leaf admission and covered by the policy hash. Elapsed time is derived in
exactly one place, `elapsedExecutionDurationMs`, as the interval between the immutable
execution epoch (the earliest append-only `run.lease_acquired` event) and an evaluation
instant read from the DATABASE clock in the same statement and snapshot that captures the
receipt, reservation and budget cutoffs. Reaching the limit blocks at the pre-reservation
gate, before any provider call, economic reservation or model-request budget charge, and
the stop is persisted as a cutoff-bound block with its own closed reason,
`cumulative_execution_duration_exhausted`.

Two properties are worth stating explicitly because they are what make this a bound rather
than a suggestion. Verified progress resets the consecutive no-progress streak but does
NOT reset cumulative duration — tolerance can be earned back, consumption cannot. And
scheduler queue time is not execution time: a Run that has never been leased has no epoch
and therefore zero duration, so a long wait in the queue cannot exhaust a bound the Run
never began spending.

**Open — every other execution family.** Tranche 5 deliberately did not touch direct, v1,
workflow, browser, process, simulation, or compiler execution. Those families still use
attempt-local counters and per-loop-entry duration behavior: `server.js` `runAgentTicket`
still carries `const stalledResponses = 0; // We don't track stalled across restarts`, and
`maxRuntimeDurationMs`, `maxListDirectoryPerRun` and `maxReadFilePerRun` remain enforced
per loop entry there. A run on those paths that recovers N times still receives N budgets.

**Remaining decision.** Whether to migrate the other execution families onto governed
evaluation or to bound them separately. The staging constraint above still applies to
them: tightening their wall clock will fail runs that previously passed.

#### Verified progress is not credited on the production path (2026-08-02)

| Field | Value |
|-------|-------|
| **Status** | Open — BLOCKS Tranche 5 merge |
| **Severity** | High — verified-progress accounting is a core Tranche 5 behaviour and is absent in production |
| **Evidence** | `persistence/postgres/store.js` `prepareAndReserveNextGovernedRunRequest` passes `satisfiedFactIdentitiesByReceiptId: null`; no production caller supplies it |
| **Decision required** | Where the receipt-to-declared-fact derivation lives, and whether the stop reason should distinguish "no progress" from "progress not measured" |

`evaluateGovernedRunProgress` accepts a mapping from durable receipt identities to the
declared-work facts they newly satisfy. The classification, the four levels and the
tolerance arithmetic all consume it correctly. Nothing in production builds it.

Consequences on the governed structured leaf path:

- `verifiedProgressCount` is always 0;
- the consecutive no-progress streak grows on every governed window;
- a Run stops at `maximumConsecutiveNoProgressWindows` with reason
  `verified_progress_exhausted` regardless of whether it advanced declared work;
- the Ticket projection always reports `totalVerifiedProgressFacts: 0`.

This is not an economic safety defect: the error is conservative, stopping earlier than
the captured policy intends and never permitting extra spend. It is a truthfulness
defect in the explanation given to an operator, which is why it is recorded here rather
than treated as acceptable rounding.

**Reclassified 2026-08-02 after merge-readiness audit.** This was first recorded as a
non-blocking documented boundary. That was wrong: false blocking is incorrect execution
authority, and a persisted stop reason that can be untrue is not made acceptable by
erring toward less spend. It blocks merge.

**Why it cannot be wired inside Tranche 5.** The audit traced every candidate authority.
An evaluator exists (`directPostconditionResult`), an identity rule exists (typed
`criterionHash`), and an objective compiler exists (`buildObjectiveContract`). The
DURABLE SUBSTRATE does not. `run:postcondition_completed` claims are written by
`recordRunEvent` into `replay_snapshots` — one mutable row per run (`run_id PRIMARY KEY`,
`revision` counter), items stamped `capturedAt: new Date()` (process clock), no per-item
monotonic id. The append-only path `buildRunPostconditionEvidence` returns `null` unless
`executionMode === 'workflow'`; governed leaf Runs are `agent`. No migration defines a
postcondition table or column.

That substrate admits no cutoff (`id <= N` is not expressible), would make the process
clock the ordering authority, and is rewritten in place. Feeding it into governed
progress evaluation would break the stable-cutoff proof, the database-time proof, and the
A3 closure that rests on both. Deriving satisfaction from `operation_receipts` instead
would require a second independent postcondition evaluator, which is precisely the second
authority this tranche exists to avoid.

**Prerequisite to close.** A durable, append-only, database-ordered postcondition-result
record — a typed-evidence seam writing deterministic postcondition results to an ordered
table with a monotonic id and a database timestamp, as `operation_receipts` and `events`
already do. Owner: the typed-evidence work, not churn control.

**Do not**, while this is open: weaken the contract to call candidate progress verified;
describe `verified_progress_exhausted` as proof that no declared work advanced; or merge
Tranche 5 as feature-complete. A3's persistence closure is scoped separately and is
unaffected — see the A3 verdict above.

#### Tranche 5 coordination scope deliberately NOT implemented (2026-08-02)

Recorded here so no later reader infers these were overlooked rather than declined.
None is a defect, and none is planned as part of Tranche 5:

- **dependency DAGs** — structured siblings have no ordering and no graph;
- **sibling waiting or ordering** — an unverified sibling read is refused and the
  reading Run stops; waiting would be a dependency by another name;
- **shared-decision registry** — no generic decision-claim store exists;
- **advisory review Workflow steps**;
- **automatic retry**, **automatic replanning**, **automatic rerouting** — the churn
  decision vocabulary is exactly `continue | blocked`;
- **automatic unblocking** — a persisted block is the decision of record and is never
  reopened by the runtime;
- **generic coordination messaging** between Runs;
- **Tranche 6 behavior** — controlled evaluation and the product decision.

A separately authorized retry Run is unaffected by any of the above: it receives its own
execution epoch, its own captured policy and its own duration authority. What does not
happen is the runtime creating one on its own.

**Interacts with A12.** Because each recovery re-entry restarts the wall clock, no runtime
limit currently bounds A12's indefinite snapshot-recovery cycling. Fixing A3 alone would
silently impose a bound there; the two must be decided consistently.

---

### A4. Enforcement gates bypass the immutable policy snapshot

| Field | Value |
|-------|-------|
| **Status** | Open — partially addressed by `a1143e6` |
| **Severity** | Medium — split-brain policy resolution |
| **Evidence** | `runtime/execution-semantics.js`; per-response ceilings in `server.js` |
| **Decision required** | Whether a single resolved policy envelope should be the only input to enforcement |

**Description:**

A real immutable envelope exists and is written before dispatch (`run.runtimeLimitsSnapshot`,
`run.executionPolicySnapshot`, `run.routingSnapshot`, `replaySnapshot.runtimeEnvelope`).
Roughly half the enforcement gates read it; the rest independently re-read process constants,
environment flags, and live regex evaluation of ticket text at the moment they fire.

`a1143e6` made the semantic controls **recordable and reconstructable** — every run now
persists `runtimeLimitsSnapshot.semantics` — but deliberately did **not** change which values
the gates consume. The record is descriptive only; no gate branches on it.

The candidate direction is a single `resolvedExecutionPolicy` produced before dispatch, with
enforcement consuming only that. Two constraints if it is pursued: the process constants must
become *unreachable* from gate code (otherwise this adds a third source of truth rather than
removing the second), and regex-derived values must be resolved once at dispatch. Adding
per-key provenance (`value` + `source: default|env|ui|profile|ticket`) is cheap and directly
answers "why was this limit this value".

---

### A5. Workload-profile re-resolution

| Field | Value |
|-------|-------|
| **Status** | Open |
| **Severity** | Low — requires an objective edit mid-flight to manifest |
| **Evidence** | `server.js` `detectWorkloadProfile` call sites: run creation and runtime-envelope construction |
| **Decision required** | Whether the profile is resolved once at dispatch |

**Description:**

`detectWorkloadProfile` runs twice against different inputs at different times: once at run
creation, where its result is snapshotted into the runtime-limits snapshot, and again on
every runtime-envelope build against the **live** `ticket.objective`. Ticket objectives are
mutable. Editing an objective between run creation and execution makes the model's envelope
disagree with the limits actually enforced, and nothing detects the divergence.

Note also that the profile is *inferred from objective text by regex*, not selected by an
operator, and that profile matching can only tighten step/request/operation limits
(`Math.min`) while it sets the `listDirectory`/`readFile` limits outright.

---

### A6. Gate ordering vs prefix truncation

| Field | Value |
|-------|-------|
| **Status** | **Governance decision required** — do not implement unilaterally |
| **Severity** | Medium |
| **Evidence** | Run #8; total-action and mutating-action gates in `server.js` |
| **Governing memo** | `decision-record-truthfulness-over-boundedness.md` (status: *Governance decision pending*) |
| **Decision required** | Whether an over-limit response is salvaged or rejected whole |

**Description:**

Two per-response gates run in order. The total-action gate (>`MAX_AGENT_ACTIONS_PER_RESPONSE`)
rejects the whole response and returns. The mutating-action gate
(>`MAX_MUTATING_ACTIONS_PER_RESPONSE`) has a prefix-truncation path behind
`ENABLE_PREFIX_TRUNCATION` that executes the first N mutations and continues.

Because the total gate returns first, a response exceeding the total ceiling can never reach
truncation **regardless of the flag**. Prefix truncation is therefore live only in the narrow
band of ≤8 total but >2 mutating actions — never for the failure shape it was built for.
Run #8 (26 actions, twice) is exactly that shape and terminated with zero mutations.

**Do not "fix" this as a bug.** Making the total gate salvage rather than reject is the
truthfulness-vs-boundedness tradeoff whose decision record is still pending. Note also that
for run #8 the current behavior produced the *better* outcome: truncation would have made
partial mutations and then died on the wall clock, replacing a clean, correctly classified
contract failure with a partial-mutation timeout.

**Prerequisite:** `ENABLE_PREFIX_TRUNCATION` is now recorded per run (`a1143e6`), so any
change here is observable in evidence. It was not before.

---

### A7. Objective-grammar anchoring

| Field | Value |
|-------|-------|
| **Status** | **Governance decision required** — do not implement unilaterally |
| **Severity** | Medium |
| **Evidence** | `objective-contract.js` create-range recognizer |
| **Governing memo** | `decision-memo-objective-interpretation-direction.md` — read before touching objective parsing |
| **Decision required** | Whether recognizers tolerate trailing locative phrases |

**Description:**

The create-range recognizer is anchored with `$`, so a trailing prepositional phrase defeats
recognition. Verified empirically:

```
"create folders A-Z in the workspace" -> recognized: false, intent: model_driven, 0 mutations
"Create folders A-Z"                  -> recognized: true,  26 mutations
"create folders A through Z"          -> recognized: true,  26 mutations
```

For run #8 this silently disabled the feasibility gate entirely: with no enumerable contract,
`countRequiredContractMutations` returned null and the gate skipped. As of `a1143e6` that skip
is no longer silent — it emits `run:feasibility_decision` with
`outcome: skipped_unrecognized_objective` — but the recognition behavior itself is unchanged.

The governing memo freezes the deterministic grammar at its current scope, with existing
recognizers to be *audited* rather than grandfathered. This entry is that audit finding.

---

### A8. Remaining dead `allow*` policy fields

| Field | Value |
|-------|-------|
| **Status** | Open |
| **Severity** | Low — the UI is already honest about it |
| **Evidence** | `server.js` `copyExecutionPolicy`; `views/run-detail.ejs`, `views/ticket-detail.ejs`; Tranche 5 `runtimeBudgetSnapshot` |
| **Decision required** | Implement enforcement or formally retire the fields |

**Description:**

`executionPolicy.allowWorkspaceWrites` and `allowChildTickets` remain normalized,
snapshotted intent fields without their own implementation. The UI labels them as recorded
intent, and labels child-ticket creation explicitly as not implemented.

Tranche 5 resolved the other items that used to be grouped here. `allowParallelRuns` is
captured in `runtimeBudgetSnapshot` and enforced by scheduler admission. Nullable numeric
budget overrides — including attempts, execution steps, runtime, model, workspace,
process, browser, and aggregate output-artifact limits — resolve to concrete immutable
values at admission and are enforced. `maxAttempts` bounds manual and enabled automatic
retry admission; a null override inherits the runtime default rather than disabling retry
or granting unlimited attempts. Historical runs without a runtime-budget snapshot retain
an explicitly historical advisory display.

---

### A9. Latency-aware feasibility

| Field | Value |
|-------|-------|
| **Status** | Open |
| **Severity** | Medium |
| **Evidence** | `server.js` `assertRuntimeBudgetFeasible`; run #8 timings |
| **Decision required** | Which budget dimensions feasibility must consider before dispatch |

**Description:**

The feasibility gate checks exactly one relation: projected steps against
`maxExecutionSteps`. It does not consider the model-request budget (each step costs roughly
one request), the wall clock, observed provider latency, the workspace-operation budget, or
whether the workspace snapshot was truncated beyond the model's visibility.

Run #8 illustrates the gap: 24 required mutations at a cap of 2 project to 12 steps against a
limit of 32 — comfortably "feasible" — while the observed 113–169 s per model call put the
real cost at roughly 1400–2000 s against a 400 s ceiling. Provider and model are already known
at dispatch (`run.routingSnapshot`), so latency is available and unused.

As of `a1143e6` the gate's decision and its resolved inputs are durable on every path
(`run:feasibility_decision` / `run.feasibility_decision`), so any added dimension is
measurable against existing evidence. **What the gate enforces was deliberately not widened.**

---

### A10. Orphaned PostgreSQL-era test harnesses

| Field | Value |
|-------|-------|
| **Status** | **Resolved for the inventoried 14.** All fourteen are migrated, individually green, registered in the release checkpoint, and pinned as mandatory. A wider orphan population found during the tranche is recorded below and is **not** resolved |
| **Severity** | High — the release checkpoint had no working feasibility or postcondition coverage |
| **Evidence** | Baselined at commit `3a73a13` in a detached worktree; failure strings identical to current HEAD |
| **Decision required** | Repair, port, or retire each harness — **decided per suite below** |

**Description:**

These suites fail at HEAD. They are legacy JSON-era harnesses orphaned by the PostgreSQL
cutover: each spawns a server without setting `DATABASE_URL` and dies with
`Error: DATABASE_URL is required for the PostgreSQL runtime`.

- `scripts/runtime-feasibility-test.js`
- `scripts/ticket-feasibility-gate-test.js`
- `scripts/postcondition-completion-test.js`
- `scripts/direct-folder-postcondition-completeness-test.js`
- `scripts/resume-obvious-postcondition-test.js`
- `scripts/recovery-regression-test.js`
- `scripts/startup-data-integrity-test.js`
- `scripts/run-diagnostics-bundle-test.js`
- `scripts/run-detail-evidence-clarity-test.js`
- `scripts/bounded-transition-test.js`
- `scripts/replay-snapshot-storage-test.js`
- `scripts/runtime-limits-config-test.js`
- `scripts/runtime-limits-ui-test.js`
- `scripts/renamepath-runtime-regression-test.js` *(added 2026-07-25: same JSON-era cause —
  9 `DATA_DIR` references and the identical `DATABASE_URL is required` failure. Missed by the
  original inventory.)*

`scripts/execution-semantics-test.js` fails for a *different* reason — it asserts helpers that
no longer exist — and is **not** part of this storage migration. It is tracked separately as
**A13**, together with four sibling scripts that fail the same way. It is unrelated to
`scripts/execution-semantics-snapshot-test.js`, which is current and passing.

None are registered in `CHECKPOINT_TEST_SCRIPTS` or `POSTGRES_INTEGRATION_SCRIPTS`, so
`npm run checkpoint:release` stays green while they rot.

This gap is why `a1143e6` wrote feasibility coverage as executed code inside
`scripts/evidence-truthfulness-contract-test.js` (all six outcome paths against stubs) and
`scripts/execution-semantics-persistence-test.js` (the `passed` path through real dispatch),
rather than extending `runtime-feasibility-test.js`.

**Method note for whoever picks this up:** before treating any suite failure as a regression,
baseline it at the relevant commit in a detached worktree and compare failure strings. Most
failures in this list are pre-existing.

### Audit findings (2026-07-25) — repair is a migration, not a configuration fix

Re-audited against clean `master` (`c062af6`); all fourteen still fail. The missing
`DATABASE_URL` is the *first* error each hits, but it is **not** the only defect:

1. **`DATA_DIR` is read nowhere.** `grep -c 'process.env.DATA_DIR' server.js` returns **0**.
   Every one of these harnesses seeds `data/*.json` into a temporary `DATA_DIR` and then
   asserts by re-reading those files. The PostgreSQL server ignores that directory entirely,
   so simply supplying `DATABASE_URL` would let the server boot and then fail every assertion,
   because the seeded fixtures would not exist and the asserted state would never be written
   there. Repair therefore requires migrating **seeding and assertions** onto the store, not
   just adding an environment variable.

2. **All thirteen server-based harnesses are JSON-era.** None references
   `PostgresRuntimeStore`; all spawn a server and use `DATA_DIR` plus JSON reads
   (~4,750 lines total). Each also carries its own copy of the same ~90 lines of scaffolding
   (HTTP client, readiness poll, login, spawn, cleanup), which is why the cutover orphaned
   them all simultaneously.

3. **The startup data-integrity contract no longer exists.** `validateUniqueIntegerIds`
   (`server.js`) is **defined but never called** — its only occurrence is its own definition.
   The JSON-era startup refusal it powered (duplicate ids, malformed flat-file records) was
   removed by the cutover, and PostgreSQL enforces that class of integrity structurally through
   primary keys and constraints. `scripts/startup-data-integrity-test.js` therefore asserts a
   behavior the runtime no longer has. The dead helper is a small residual defect in its own
   right and should be removed or re-wired by whoever decides that contract's future.

### Final disposition (complete)

**Restoration count: 14 of 14.** A suite counts as restored only when its migrated test
executes and passes its intended behavioral assertions. Neither a scenario inventory nor an
audit plan counts as restoration.

All fourteen are registered in `POSTGRES_INTEGRATION_SCRIPTS` and pinned as mandatory by
`scripts/release-checkpoint-coverage-test.js`, so dropping one now fails the checkpoint. That
pin is the actual fix for the original defect: the suites did not rot because they were hard
to maintain, they rotted because nothing failed when they were absent.

**570 assertions across the fourteen suites.**

| Harness | Disposition | Status |
|---------|-------------|--------|
| `ticket-feasibility-gate-test.js` | Repair and retain | ✅ Migrated — 22 assertions |
| `resume-obvious-postcondition-test.js` | Repair and retain | ✅ Migrated — 15 assertions |
| `direct-folder-postcondition-completeness-test.js` | Repair and retain | ✅ Migrated — 14 assertions |
| `runtime-feasibility-test.js` | Repair and retain | ✅ Migrated — 76 assertions |
| `recovery-regression-test.js` | Repair and retain | ✅ Migrated — 47 assertions |
| `postcondition-completion-test.js` | Repair and retain | ✅ Migrated — 140 assertions, 20/20 scenarios |
| `startup-data-integrity-test.js` | **Replace** — the JSON `DATA_DIR` refusal mechanism no longer exists | ✅ Migrated — 14 assertions; **was vacuous, repaired** (below) |
| `run-diagnostics-bundle-test.js` | Repair and retain | ✅ Migrated — 35 assertions |
| `run-detail-evidence-clarity-test.js` | Repair and retain | ✅ Migrated — 15 assertions |
| `bounded-transition-test.js` | **Repair, two scenarios re-expressed** — the phase gate and the action-contract streak superseded them | ✅ Migrated — 31 assertions |
| `replay-snapshot-storage-test.js` | **Repair with the extraction-helper third retired** — separation is now structural | ✅ Migrated — 17 assertions |
| `runtime-limits-config-test.js` | Repair and retain | ✅ Migrated — 88 assertions |
| `runtime-limits-ui-test.js` | Repair and retain | ✅ Migrated — 34 assertions |
| `renamepath-runtime-regression-test.js` | Repair and retain | ✅ Migrated — 22 assertions |
| `execution-semantics-test.js` | **Not in A10** — see A13 | Tracked separately |

### `startup-data-integrity-test.js` passed while asserting nothing (found and fixed 2026-07-25)

Recorded prominently because it is the most transferable lesson in this tranche, and
because the suite had already been counted as restored.

The migrated suite spawned the server with only `DATABASE_URL`, `POSTGRES_SCHEMA`,
`WORKSPACE_ROOT`, `NODE_ENV` and `PORT`. It supplied no `SESSION_SECRET`, so **both**
scenarios died at `resolveSessionSecret` before reaching any storage code. Every
assertion — non-zero exit, no default admin in the output, no leaked bootstrap
password — held trivially, because a process that dies on line 122 satisfies all
three. It also passed `DATABASE_SCHEMA`, which nothing reads (`server.js` reads
`POSTGRES_SCHEMA`), so its "structurally unusable schema" scenario never pointed the
server at the schema it had corrupted.

Three changes, and the assertion count went 8 → 14:

1. `POSTGRES_SCHEMA`, plus `SESSION_SECRET` and a per-run random
   `ADMIN_BOOTSTRAP_PASSWORD`, so the server reaches storage and the leak assertion is
   about *this run's* secret rather than the historical `admin123` literal.
2. **A positive control (scenario 0).** The same binary and the same environment
   against an intact migrated schema must reach `/health` ready and must print
   `Default admin user created`. This is what makes the refusals attributable: only
   the injected fault differs between scenario 0 and scenarios 1–2, and the control
   proves the bootstrap line appears when bootstrap actually runs — so its absence in
   the refusal scenarios is evidence rather than an accident.
3. Each refusal must name its cause (`expectedCause` regex), so a refusal for an
   unrelated reason no longer counts.

**The general rule this establishes: a refusal test is worthless without a positive
control.** "Exit code was non-zero" is satisfied by every crash, including the ones
that never reach the behavior under test.

### Dead JSON-era behavior that was retired rather than ported

Repair was not mechanical everywhere. Where the runtime had moved, the retired
assertion is recorded here so a future reader can tell a deliberate retirement from an
accidental omission.

**`bounded-transition-test.js` — two scenarios re-expressed.**

- The suite expected a *mixed* inspection+mutation batch to execute and record four
  workspace operations. That batch shape is now rejected by the **execution phase
  gate** (`execution.phase_violation`, "actions belong to different execution phases"),
  which did not exist when the suite was written; nothing is executed. The scenario now
  proves the two gates are DISTINCT — the mutating cap accepts the batch
  (`model:action_contract_passed`) and the phase gate then rejects it — and a new
  at-cap same-phase scenario covers the boundary the old assertion was reaching for.
  (The ordering of those two gates is A6's open governance question; this suite only
  records the current behavior, it does not endorse it.)
- The suite pinned the failure to the string *"Model repeatedly proposed too many
  mutating actions; no workspace mutations were executed."* and to a
  `run:mutating_action_limit` event. Neither exists: the mutating-action gate was
  folded into the unified action-contract streak (`runtime/action-contract-streak.js`),
  which terminates through `MODEL_RESPONSE_CONTRACT_VIOLATION` and records
  `model:no_progress`. The live structured classification is asserted instead. Streak
  *semantics* stay with `model-contract-violation-test.js`; this suite owns only that
  the mutating cap was the gate that fired.

**`replay-snapshot-storage-test.js` — the extraction helper retired.** A third of the
suite drove `scripts/extract-replay-snapshots.js`, a one-shot JSON-era migration that
lifted an inline `run.replaySnapshot` out of `runs.json` into
`data/replay-snapshots/run-N.json` and left a `replaySnapshotPath` pointer. It reads
`DATA_DIR`; separation is now structural (a `replay_snapshots` table keyed by run id)
rather than the product of a migration step. The suite now asserts the PROPERTY that
migration existed to establish: the run row holds no snapshot payload, the snapshot
round-trips through its own record, and both consumers — run detail and the `oquery`
CLI — hydrate it from there.

**`runtime-limits-config-test.js` / `runtime-limits-ui-test.js` — renamed surfaces.**
`concurrencyLimits.process` and `concurrencyLimits.activeProcessRuns` no longer exist;
the status payload now distinguishes the deployment-scoped cap (`maxActiveRuns`) from
this process's occupancy (`localProcess.admittedRuns`), and both are asserted. The
admin form label "Max active runs in this **process**" is now "in this **deployment**".

**Residual JSON-era artifacts, not fixed here.** `scripts/extract-replay-snapshots.js`
is dead (reads `DATA_DIR`, produces a layout that no longer exists), as is
`validateUniqueIntegerIds` in `server.js` (defined, never called — already noted in the
audit findings above). Both are small disposition decisions in their own right and are
deliberately left alone by a test-only tranche.

### Two migration hazards worth knowing

- **Crashed-run leases.** `TEST_INTERRUPTION_POINT` SIGKILLs the process, so the run keeps a
  lease nobody can renew and recovery cannot claim it until that lease expires. A resume test
  must shorten `RUN_LEASE_DURATION_MS` in its own environment or it will appear to hang for the
  default 180s. This is a test-environment knob only.
- **`jsonb` does not preserve key insertion order.** Assertions ported from the JSON era that
  compared payloads with `JSON.stringify` fail for that reason alone. Compare structurally;
  element order is usually part of the contract, key order never is.

### Mutation testing: proving the restored suites are not vacuous

`scripts/suite-mutation-test.js` breaks one runtime contract at a time and requires
the corresponding suite to FAIL. It exists because `startup-data-integrity-test.js`
demonstrated that green and vacuous are not mutually exclusive, and "the migrated suite
passes" is therefore not evidence that it still catches anything.

Run it explicitly — it is **deliberately not in the release checkpoint** because it
edits tracked source in place:

```
TEST_DATABASE_URL='postgresql://...' node scripts/suite-mutation-test.js
```

It refuses to start if any file it would mutate has uncommitted changes, restores every
file in a `finally` and on SIGINT/SIGTERM, and verifies the restore by SHA-256.

| Mutation | Contract removed | Suite | Result |
|----------|------------------|-------|--------|
| `startup-fails-open` | a startup guard failure exits non-zero | `startup-data-integrity-test.js` | killed |
| `mutating-action-cap` | a response may propose at most 2 mutating actions | `bounded-transition-test.js` | killed |
| `renamepath-conflict-carveout` | renamePath may consume a path this run created | `renamepath-runtime-regression-test.js` | killed |
| `diagnostic-count-wording` | count wording is status-aware | `run-diagnostics-bundle-test.js` | killed |

**Two lessons from building it, both recorded in the script itself.**

- *A surviving mutation means one of two different things.* The first aim at the
  startup suite removed `access_users` from the required-relation list and SURVIVED —
  not because the suite was vacuous, but because dropping that table also breaks
  bootstrap, which fails closed independently. Defense in depth means removing one
  layer does not remove the contract. The mutation was re-aimed at the exit code.
- *A kill can be false.* The first renamePath mutation deleted only the carve-out
  clause and left `$5`/`$6` bound, so the query failed to parse. The suite failed —
  proving nothing. A mutation must yield a runtime that is **wrong**, not one that is
  **broken**.

### `postcondition-completion-test.js` scenario inventory

Recorded before migration, per the A10 discipline. Retained as the contract record; the
suite is now migrated and passing at 140 assertions across all 20 scenarios.

 20 scenarios across 1,266 lines, driven by a
shared `runScenario(preloadPath, agent, objective, envOverrides, expectations)` helper and a
single `global.fetch` preload that branches on the objective string. Each scenario restarts the
server with its own budget overrides, so per-scenario limits are part of the contract.

Only the first eight concern postcondition completion directly. Scenarios 9–19 use the same
harness to cover **workflow draft intents and handoff tasks** — they assert
`expectNoPostcondition` plus scenario-specific verification, and are distinct regressions that
must not be collapsed together.

| # | Objective shape | Budget (steps/reqs) | Expected outcome | Negative condition guarded |
|---|-----------------|---------------------|------------------|----------------------------|
| 1 | `postcondition-create-folder-file` | 4/4 | completed, postcondition fired, ≤N steps | completion must not need extra model turns |
| 2 | `postcondition-repeated-write` | 4/4 | completed, postcondition fired, ≤N steps | repeated identical write must not loop |
| 3 | `postcondition-repeated-write` (tight) | 3/3 | completed, postcondition fired, ≤N steps | must complete before exhausting a tighter budget |
| 4 | `postcondition-failed-op` | 4/4 | **no** postcondition | a failed operation must never satisfy a postcondition |
| 5 | `postcondition-mixed-read` | 4/4 | no postcondition, ≥N steps | inspection mixed with mutation must not shortcut |
| 6 | `workspace-objective-satisfied` (write note) | 3/3 | no postcondition | workspace-satisfied path must not fire the postcondition path |
| 7 | `workspace-root-objective-satisfied` | 3/3 | terminal status only | root-scoped objective resolves without shortcut |
| 8 | `postcondition-non-obvious` | 4/4 | completed, postcondition fired, ≤N steps | non-obvious objectives still complete deterministically |
| 9 | `workflow-draft-valid` | 3/3 | no postcondition, `expectedRevision` | a valid draft persists at the expected revision |
| 10 | `workflow-draft-intent` | 3/3 | no postcondition | draft intent recorded, not executed |
| 11 | `workflow-draft-intent-action-postconditions` | 3/3 | no postcondition | action-level postconditions captured on the intent |
| 12 | `workflow-draft-intent-both-postconditions` | 3/3 | no postcondition | both draft- and action-level postconditions captured |
| 13 | `workflow-draft-intent-action-note` | 3/3 | no postcondition | action notes preserved |
| 14 | `workflow-draft-intent-numeric-id` | 3/3 | no postcondition | numeric ids normalized rather than rejected |
| 15 | `workflow-branching-unsupported` | 3/3 | no postcondition | branching objectives are not misfiled as draft-intent failures |
| 16 | `handoff-valid` | 3/3 | no postcondition | a valid handoff task is created |
| 17 | `handoff-invalid-path` | 3/3 | no postcondition | an out-of-scope handoff path is rejected |
| 18 | `handoff-unknown-executor` | 3/3 | no postcondition | an unknown executor is rejected |
| 19 | `workflow-draft-invalid` | 3/3 | no postcondition | an invalid draft is rejected, not silently stored |
| 20 | `compiled-partial-completion` | 3/4 | completed, postcondition fired, ≥N steps | a compiled contract must not complete on partial state |

**Mapping to current runtime.** All 20 objective shapes still route through live code paths:
`checkPostconditionCompletion`, `checkObjectiveContractPostcondition`, the workflow
draft-intent surface, and `createHandoffTask`. Nothing in the inventory asserts a removed
helper, so this suite is a **repair**, not a replacement or retirement.

**Established port mappings** (verified against the current store while inventorying, so the
next porter does not re-derive them):

| JSON-era access | PostgreSQL replacement |
|-----------------|------------------------|
| `run.replaySnapshot` | `(await store.readRunReplay(runId)).snapshot` |
| `readJson('runs.json')` lookup | `store.listRuns({ limit })` then `store.getRun(id)` |
| `readJson('tickets.json')` | `store.listTickets({ limit })` / `store.getTicket(id)` |
| `readJson('workflows.json')` | workflow-catalog store methods (`persistence/postgres/workflow-catalog-methods.js`) |
| `readJson('operation-history.json')` | `store.listRunOperations(runId, { limit })` |
| `readJson('logs.json')` | `store.listLogs({ types, runId, ticketId, limit })` |
| `events.jsonl` filtered by run | `store.listRunEvents(runId, { afterSeq: -1, limit })` |
| `waitForEvent(predicate)` | poll `store.listRunEvents` for the predicate |
| seeded `agents.json` entry | `store.createConfiguredAgent({ value, groupIds, changedBy })` |
| seeded group / membership | `store.createGroup({ value, changedBy })` + agent `groupIds` |

`runScenario(preloadPath, agent, objective, envOverrides, expectations)` ports cleanly: its
`startServer(preloadPath, envOverrides)` becomes the harness `startServer({ NODE_OPTIONS,
...envOverrides })`, and its `expectations.verify({ run, ticket, snapshot, cookie })` callback
keeps the same shape with `snapshot` sourced from `readRunReplay`. The helper's structure is
worth preserving rather than flattening — it is what keeps the twenty scenarios independent.

**Port note.** The per-scenario server restart is intrinsic to the contract (each scenario
asserts behavior under its own budget), so the migrated suite must keep restarting the server
per scenario through the shared harness rather than sharing one server.

### Repair mechanism

`scripts/postgres-test-harness.js` — one shared bootstrap the orphaned suites migrate onto,
rather than thirteen independent patches. It provides an explicit test database URL with loud
failure when absent, one isolated `tstharness_*` schema per test process, deterministic
migration, deterministic cleanup on success *and* failure, age-based reaping of schemas left by
interrupted runs, and a real server spawn with readiness polling and login. It has no JSON or
in-memory fallback: these suites must exercise the PostgreSQL runtime because that is what
production uses. It deliberately does not abstract what any suite asserts.

### A10's inventory of fourteen badly understates the orphan population (found 2026-07-25)

**This is the one part of A10 that is NOT resolved, and it is larger than what was
fixed.** While migrating the last six suites, two more JSON-era orphans surfaced that
drive the *same* cross-ticket-delete contract as `run-diagnostics-bundle-test.js`:

- `scripts/concurrency-conflict-test.js` (12 `DATA_DIR` references)
- `scripts/run-detail-permissioned-delete-audit-test.js` (9 `DATA_DIR` references)

Neither references `PostgresRuntimeStore` or the shared harness, and neither is
registered in the checkpoint. Sweeping for the general shape — a script under
`scripts/` matching `*-test.js` that references `DATA_DIR` and references neither
`postgres-test-harness` nor `PostgresRuntimeStore` — returns **96 files**:

```
for f in scripts/*-test.js; do
  if grep -q "DATA_DIR" "$f" && ! grep -q "postgres-test-harness\|PostgresRuntimeStore" "$f";
  then echo "$f"; fi
done | wc -l
```

**What this count does and does not establish.** It is a *candidate* list, not 96
confirmed failures. It certainly includes false positives — suites that only mention
`DATA_DIR` in a comment, and deliberately-skipped live-provider suites such as
`live-openai-test.js` and `allocated-live-openai-test.js`. The two named above were
individually confirmed to be genuine JSON-era orphans. The rest have **not** been
executed or triaged.

**Why it matters anyway.** A10's framing — "fourteen suites" — implied the orphaned
population was bounded and now cleared. It is not. The fourteen were the ones somebody
happened to notice; the cutover orphaned suites in bulk and nothing detected it,
because the checkpoint never ran any of them. Closing A10's inventory without recording
this would leave the next reader believing the verification gap is closed when the
majority of it has not even been measured.

**Not done here, deliberately.** Triaging ~96 candidate scripts is a tranche of its own
and is not test-migration work that can ride along with fourteen suites. It needs its
own inventory pass: execute each, classify (genuine orphan / false positive /
intentionally-excluded live-provider suite), then repair, replace, or retire with the
reason recorded — the same discipline this entry established.

**Recommended next step:** open a successor entry scoped to that sweep, with
`concurrency-conflict-test.js` and `run-detail-permissioned-delete-audit-test.js` as
its confirmed seed set, since both guard the cross-ticket-delete authority contract
that only `run-diagnostics-bundle-test.js` currently covers.

**Done — see A20.** The sweep was executed rather than inferred. The real orphan count
is **83**, not ~96: all 96 candidates do reference `DATA_DIR` in executable code (there
were no comment-only false positives, contrary to the caution recorded above), but 13
are legitimately excluded rather than orphaned. Both seed suites are repaired and
registered. A20 also found seven orphans that **exit zero while asserting nothing**, a
class no grep sweep could have surfaced.

---

### A17. Delegated handoff logging crashes the server process

| Field | Value |
|-------|-------|
| **Status** | **Open — implementation required** |
| **Severity** | **Critical** — one diagnostic-log identity mismatch terminates the entire Node process |
| **Scope** | Production runtime defect. Surfaced by A10; **not** an A10 test-migration issue |
| **Evidence** | Read-only probe against `master` `f0a18be`; stack, events, and receipts below |
| **Decision required** | Separate the run's owner identity from the acting executor, and contain run-log failures |

**Proven behavior.**

A valid handoff task — planner delegates one `writeFile` to an existing executor agent — kills
the server. Observed stack:

```
Error: run 1 was not found with the supplied ticket and agent authority
    at PostgresRuntimeStore.appendRunLog (persistence/postgres/store.js:2125)
  code: 'POSTGRES_RECORD_NOT_FOUND'
```

**Mechanism.** `appendRunLog` resolves the run row with an identity predicate that includes the
acting agent:

```sql
FROM runs WHERE id = $1 AND ticket_id = $2 AND agent_id = $3
```

`agentId` is read from the passed run object (`persistence/postgres/store.js`, `appendRunLog`;
entered from `server.js` `appendRunLog(run, type, message, workspaceAction, extraFields)`).
During handoff execution the runtime acts as the **executor**, while the run is owned by the
**planner**. The predicate therefore matches no row, `rowCount === 0`, and the method throws.
The rejection is unhandled and the process exits.

**Identities in the observed run:** run owner / planner `agentId = 1`; delegated executor
(`Mike`) `agentId = 2`.

**The delegated work itself is correct.** Authority was evaluated and granted under the executor
identity, and the mutation committed durably:

```
authorityChecks: [{ actor: "agent:2", status: "allowed", path: "handoff-note.md" }]
receipts:        ["writeFile:succeeded"]
handoffTasks:    [{ status: "validated", plannerAgentId: 1, executorAgentId: 2 }]
```

**Last durable events** (journal, in order):

```
… handoff.task_validated, authority.allowed, workspace.operation_prepared, workspace.operation
```

**First expected evidence that never occurs:** the handoff task's transition to `executed`, and
any terminal evidence. `lastHeartbeatAt` freezes at the moment of the workspace operation.

**Process and run aftermath.** The server process exits (`/health` → `ECONNREFUSED`, non-null
`exitCode`). The run is left **falsely `running`** with a live lease and **no terminal error**,
so nothing distinguishes it from healthy in-flight work until the lease expires. Every other
concurrent run in that process is abandoned the same way.

**Impact.** The capability documented in `server.js` — *"Planner may create one validated
writeFile handoff to one existing executor agent; runtime executes directly through workspace
authority"* — is unreachable in practice: any valid handoff reproduces this. A single
diagnostic-log identity mismatch is amplified into a process-wide outage.

**Natural blocked regression.** `postcondition-completion-test.js` scenario 16 (`handoff-valid`)
times out waiting for a terminal run, because the server that would terminalize it is gone. The
scenario is **unchanged and remains blocked**; it is the contract this entry protects.

**Ruled out.** Not mutation-admission starvation — nothing was waiting; `waitForAdmissionChange`
is not implicated. Not an A10 fixture defect — the executor agent resolved, authority was
granted, and the mutation succeeded. Not a runtime-duration defect — the process died rather
than overrunning a budget.

**Two defects, to be proven separately.** (1) Delegated execution substitutes the executor for
the run's owner in the log identity predicate. (2) A failed run-log append becomes an unhandled
rejection that terminates the process rather than failing that run closed.


**Outside-`runAgentTicket` caller classification (complete).** The rule: a required
log inside an execution path with a guaranteed later drain may use tracked
`appendRunLog`; outside such a path it must use `appendRequiredRunLog` or an
explicit settle boundary before the guarded transition returns success; only the
five listed terminal echoes may be best effort after authoritative terminal state.
A marker with no consumer is invalid.

| Caller | Log type | Class | Boundary | Guarded transition | Failure outcome | Cleanup |
|---|---|---|---|---|---|---|
| `runAgentTicket` | `run:started` | Required | `appendRequiredRunLog` — rejection propagates | run start | run fails closed | `commitRunTerminalization` |
| `runAgentTicket` (27 exec-phase sites) | model/workspace/postcondition events | Required | Loop gate drains before next model request or mutation | step + action execution | run fails closed, `EVIDENCE_PERSISTENCE_FAILED` | `commitRunTerminalization` |
| `completeAgentRunUnlocked` | `run:completed`, `run:verification_failed` | **Best effort** | none needed — post-terminal echo | none | logged to stderr, run unaffected | n/a (never marked) |
| `failAgentRunUnlocked` | `run:failed`, `run:failed_auto_retried` | **Best effort** | none needed — post-terminal echo | none | stderr, run unaffected | n/a |
| `interruptAgentRunUnlocked` | `run:interrupted` | **Best effort** | none needed — post-terminal echo | none | stderr, run unaffected | n/a |
| `reconcileTerminalRunUnlocked` | `run:reconciled` | Required | `settleTerminalRunEvidence` → `recordRequiredReplayEvent` | terminal reconciliation | durable `run.reconciliation_evidence_failed` | `releaseRunEvidenceTracking` |
| `interruptStaleRunsOnStartup` | `run:terminalized` | Required | `settleTerminalRunEvidence` | startup terminal repair | durable replay evidence | `releaseRunEvidenceTracking` |
| `interruptStaleRunsOnStartup` / `expireStaleRunLeases` | `run:resumed` | Required | Case 1 — resumed run re-enters `runAgentTicket`, whose first gate drains | resumption | run fails closed at the gate | `commitRunTerminalization` |
| `reconcileUnfinalizedTicketsOnStartup` | `run:ticket_finalized` | Required | `settleTerminalRunEvidence` | ticket finalization | durable replay evidence | `releaseRunEvidenceTracking` |

**Best-effort set is exactly five types** and is asserted for exact membership in
`scripts/run-evidence-drain-test.js`; adding a sixth fails the suite. Each is emitted
only after `commitRunTerminalization` has made the runs row, replay snapshot,
terminal bundle, evaluation, and consequence durable, so losing one cannot change
reconstruction, terminal classification, authority attribution, recovery safety,
operator truth, or compliance evidence.

**Verification coverage map (audited 2026-07-25 against the committed suites).**

| Guarantee | Covered? | Test / assertion |
|---|---|---|
| Containment does not recurse into the failing log path | **Yes** | `delegated-run-logging-containment-test.js:309` "containment did not recurse into the failing log path"; `reconciliation-evidence-failure-test.js:286` "no recursive diagnostic-log attempt occurred: exactly one per fixture" |
| Terminalization clears pending-write and failure-marker state | **Yes** | `run-evidence-drain-test.js:183` "terminalization clears the failure marker"; `:185` "terminalization clears pending-write state"; `:274`/`:276` no marker or pending-write entries leak after release |
| A later run id inherits no stale state | **Yes** | `run-evidence-drain-test.js` "a later run with a different id does not inherit stale failure state" |
| Post-mutation and final-step failure positions | **Yes** | `delegated-run-logging-containment-test.js`, mutation-proven via completion-drain removal |
| **Resumed-run initial evidence drain** | **No** | *(open follow-up A17-V1)* |
| **Required-log failure strictly before action execution** | **No** | *(open follow-up A17-V2)* |
| **Cleanup asserted end-to-end across recovery/startup-reconciled paths** | **Partial** | proven at unit level in `run-evidence-drain-test.js`; not asserted through a live recovery run *(A17-V3)* |

**Open verification follow-ups (A17-V1..V3).** These are *missing proofs*, not known
defects. The production paths they would exercise are implemented and reasoned:
`run:resumed` is classified under caller-rule case 1 because the resumed run re-enters
`runAgentTicket`, whose first gate drains before any model request or mutation; the
before-mutation position is guarded by the same gate that the post-mutation case
proves. No incorrect production behavior is known or implied. They are recorded here
so no future reader mistakes reasoned coverage for tested coverage.

**Tests.** `scripts/delegated-run-logging-containment-test.js` (37),
`scripts/run-evidence-drain-test.js` (40),
`scripts/reconciliation-evidence-failure-test.js` (18).

**Mutation proofs.** Ownership overwrite → focused identity test and natural
scenario 16; containment removal → process death; single-snapshot drain → nested
write test; completion drain removal → false `completed`; `logType`→`type` →
required-log propagation; settle boundary removal at both startup sites → missing
durable evidence.

---

### A23. Deterministic crash-seam coverage was incomplete

| Field | Value |
|-------|-------|
| **Status** | **Closed 2026-07-26.** All nine seams are driven by registered suites |
| **Severity** | Medium — recovery was largely asserted by construction rather than demonstrated |
| **Scope** | Verification gap in its own right. Opened separately from A20, which is scoped to test ORPHANS; these three seams were driven by no suite at all, orphaned or otherwise |
| **Evidence** | Seam map rebuilt from the repository after A22 and after the reconciliation repair |

**Description:**

The runtime exposes nine deterministic crash seams (`maybeTestInterrupt`). They exist
because the recovery contract is hard to prove any other way. A20 found only two were
ever driven; A22 took that to five and the reconciliation repair to six. The last three
were driven by nothing, and — unlike everything in A20 — no orphaned suite guarded them
either, so repairing an orphan could never have closed the gap.

| Seam | Driver |
|------|--------|
| `after_action_contract_violation` | `model-contract-violation-recovery-test.js` |
| `after_first_authority.allowed` | `resumable-execution-test.js` |
| `after_first_workspace.operation` | `resume-obvious-postcondition-test.js`, `resumable-execution-test.js` |
| `after_run.started` | `resumable-execution-test.js` |
| `before_run.snapshot_finalized` | `resumable-execution-test.js` |
| `after_first_workspace_target_effect` | `target-operation-reconciliation-test.js` |
| `after_run.created` | **`terminalization-boundary-recovery-test.js`** |
| `before_run.consequence_recorded` | **`terminalization-boundary-recovery-test.js`** |
| `after_run.snapshot_finalized` | **`terminalization-boundary-recovery-test.js`** |

### The seam names no longer describe the states they were coined for

Writing the suite surfaced a correction worth recording.
`before_run.snapshot_finalized` and `before_run.consequence_recorded` fire **back to
back at the same point**, and `server.js` says why:

> The old interruption points now sit before the repository boundary. They can abort
> before the bundle, but cannot create a partially committed PostgreSQL terminal state
> between its constituent records.

Terminalization is a single transaction. A crash at `before_run.consequence_recorded`
therefore leaves the run **non-terminal** — not "terminal with a missing consequence",
which is the state the seam name implies and which the current runtime **cannot
produce**. The suite asserts what is reachable and additionally proves the unreachable
state stays unreachable, rather than encoding a shape that no longer exists.

That leaves three materially different recovery contracts, which is why one suite with
three scenarios was the right shape:

| Seam | Durable state at death | What recovery must do |
|------|------------------------|-----------------------|
| `after_run.created` | run row only | claim and execute it; no duplicate run |
| `before_run.consequence_recorded` | run still running, bundle aborted | terminalize once, recording the consequence |
| `after_run.snapshot_finalized` | bundle committed, terminal | add nothing, contradict nothing |

**`terminalization-boundary-recovery-test.js` — 56 assertions, 3 seams, registered.**
Every scenario proves the hook fired, the process died, and the run was in the expected
incomplete durable state at death, so none can pass by never crashing. A shared
convergence check then requires: one run (no duplicate), original ownership and
assignment intact, no stale lease, exactly one finalized snapshot agreeing with the
run's terminal status, a recorded consequence, at most one `run.terminalized` and one
`run.consequence_recorded` event, and at most one successful mutation receipt. The
consequence is cross-checked against the receipts rather than merely asserted present —
that is the A16 property, and a consequence claiming no mutations while receipts say
otherwise is the failure that matters.

**Mutation-verified, and one needed re-aiming.**

| Mutation | Contract removed | Result |
|----------|------------------|--------|
| `crashed-runs-never-reclaimed` | a run abandoned by a dead process is reclaimed once its lease expires | killed |
| `terminalization-not-atomic` | a run reaching terminalization records its consequence | killed |

The first was initially aimed at `interruptStaleRunsOnStartup` and **survived**: a run
abandoned by a dead process is reclaimed when its **lease expires**, which the scheduler
does on its own interval, not by startup recovery. Re-aimed at the recoverable-run scan,
it kills. Fifth instance in this effort of a surviving mutation meaning defense in depth
rather than a coverage hole — the rule now has enough evidence to state plainly: **when
a mutation survives, identify which layer actually executes before concluding anything
about the suite.**

---

### A22. Resume after a committed workspace operation fails on an idempotency conflict

| Field | Value |
|-------|-------|
| **Status** | **Implemented 2026-07-26.** Canonical prepared-intent projection; `resumable-execution-test.js` reinstated as required (35 assertions, 4 crash seams); mutation-verified |
| **Severity** | **High** — a crash after a committed mutation makes the run unrecoverable |
| **Scope** | Production runtime/persistence. Found by A20 while migrating `resumable-execution-test.js` |
| **Evidence** | `scripts/resumable-execution-test.js` scenario 2, against `940c32a` |
| **Decision required** | Confirmed: neither. The two write paths source `preState` from different places. See the diagnosis |

**Description:**

Kill the runtime at `after_first_workspace.operation` — after a `writeFile` has
committed but before the run finishes — then restart. Recovery claims the run and the
resume **fails**:

```
Operation receipt idempotency key conflicts for run 2:
run:2:slot:ed5dcf36…:input:e7484052…
```

The mutation is **not** duplicated, so the safety property holds. But the run does not
complete either: it terminalizes as `failed`. A crash at this seam therefore makes the
run unrecoverable rather than resumable, which is the opposite of what the seam exists
to support.

**Where it comes from.** `persistence/postgres/store.js` raises
`IdempotencyConflictError` when a resumed run re-emits evidence under a key that already
exists and the stored event differs from the re-derived one:

```js
if (storedEvent.type !== eventType || storedEvent.stepId !== eventStepId ||
    canonicalJson(storedEvent.payload) !== canonicalJson(eventPayload)) {
  throw new IdempotencyConflictError(id, key);
}
```

The guard itself is right — silently overwriting divergent evidence would be worse. The
open question is **why the re-derived payload differs at all**. Two possibilities, and
they have opposite fixes:

1. **Legitimate nondeterminism.** If the payload carries a duration, timestamp or other
   per-attempt field, the comparison is too strict and should exclude it. The guard
   should compare the evidence's *meaning*, not fields that cannot survive a replay.
2. **A genuine mismatch.** If the resumed run reconstructs materially different
   evidence, the conflict is correctly reporting a real reconstruction defect and the
   bug is upstream of the guard.

### Diagnosis (2026-07-26) — field-level

The conflict is raised at the **operation receipt** insert (`persistence/postgres/store.js`,
the `matches` comparison in the receipt writer), not at the replay-item or event
comparison. Every scalar column matches; only the `receipt` JSON document differs.

Instrumenting the comparison and diffing the two documents gives exactly three
differences, and one of them is an artefact of the diagnostic:

| Field | Stored (first pass) | Rebuilt (resume) | Real? |
|-------|--------------------|------------------|-------|
| `before` | *absent* | `{"existed": false}` | **yes** |
| `createdResources` | `[]` | `["resume-afterop-….txt"]` | **yes** |
| `targetScope` | `{root, type}` | `{type, root}` | **no** — key order only; `canonicalJson` sorts keys recursively, so this cannot contribute |

**Both real differences reduce to one cause.** `buildTargetMutationReceipt` derives
`before` directly from `preState`, and `buildMutationResourceChanges` derives
`createdResources` from `preState.existed === false && postState.existed`. A single
missing `preState` produces both.

**The two write paths source `preState` from different places:**

```js
// first pass — server.js, the writeFile execute path
const prepared = await beginWorkspaceMutation(...);
const preState = prepared.preState;          // ← empty on this run
… completeWorkspaceMutationEvidence({ …, preState, postState, … })

// resume — server.js, beginWorkspaceMutation's reconciliation branch
await completeWorkspaceMutationEvidence({
  …, preState: state.receipt.preState,        // ← populated, from the durable receipt
})
```

The durable target-operation receipt records a populated `preState`; the value
`beginWorkspaceMutation` hands back to the caller for the first pass does not. The two
therefore build **different receipt documents for the same logical operation**, and the
disagreement is invisible until a resume compares them.

**Classification, against the four cases this entry had to distinguish:**

- ~~transient/attempt-local metadata treated as semantic identity~~ — no; `before` and
  `createdResources` are semantic, and no timestamp or duration is involved
- **canonical payload construction differs across restart** — **yes, this one**
- ~~resume reconstructs a materially different operation~~ — no; same path, same content,
  same fingerprint, and every scalar column matches
- ~~the guard is right and an upstream recovery defect produces the mismatch~~ — the guard
  is right, but the defect is not in recovery: it is that the *first* pass writes an
  under-populated receipt

**The guard is correct and must not be weakened.** Excluding `before` or
`createdResources` from the comparison would let genuinely divergent evidence overwrite
committed evidence — precisely what the idempotency key exists to prevent. The fix
belongs at the earliest layer: **`beginWorkspaceMutation` must return the same
`preState` it persisted to the target-operation receipt**, so both passes build an
identical document and the resume compares equal.

### Implementation (2026-07-26)

**One line of cause, one place to fix it.** `targetOperationIntentFromRow` returned only
the row shape, leaving the persisted intent document nested at `.intent`. Four runtime
readers treat that record AS the document:

```js
classifyPreparedWorkspaceMutation(provider, intent)   // intent.args, intent.preState
beginWorkspaceMutation → return { preState: prepared.intent.preState }
reconcileWorkspaceOperation                            // intent.target, intent.args
```

Every one of those reads landed **one level too shallow** and silently produced
`undefined`. `intent.operation` appeared to work only because `operation` is also a
column — which is exactly why this survived so long.

So the first execution built its receipt with `preState === undefined`, giving no
`before` and an empty `createdResources`. Recovery rebuilt the same receipt through
`targetOperationReceiptProjection`, which *does* dig into the document
(`intent.preState`), and got both. Two projections of one operation disagreed, and the
disagreement was invisible until a resume compared them.

**The fix spreads the persisted document onto the record**, so the durable and
in-memory projections are the same values by construction rather than by two
independently-written readers agreeing. `intent` is kept nested so the prepare-conflict
comparison (`canonicalJson(current.intent.intent)`) and
`targetOperationReceiptProjection` continue to read the raw document unchanged.

**Nothing was weakened.** `before` and `createdResources` remain in the receipt
comparison; the idempotency guard is untouched; resume accepts no conflicting evidence;
no pre-state is recomputed after the mutation. The fix makes logically identical work
*compare equal*, which is what the guard always intended.

**Proof — `scripts/resumable-execution-test.js`, 35 assertions across 4 crash seams**,
all now passing. Every scenario proves its seam actually fired, the process actually
died, and the run was genuinely unfinished before resume — so a scenario cannot pass by
never crashing. The committed-operation case additionally proves:

- the first mutation committed and the file holds its intended contents
- exactly one successful mutation receipt exists
- the resume produced **no** idempotency conflict, in neither the run error nor the log
- the stored receipt document records `before` and names the created resource, so first
  pass and resume project identically
- the run **completes** rather than merely avoiding duplication — the distinction that
  matters, because the defect produced no duplicate either; it failed the run instead

**Mutation-verified.** `prepared-prestate-not-propagated` removes the document spread
and restores A22 exactly. Worth noting what it does *not* do: it produces no duplicate
mutation, so a suite that only checked "the mutation did not run twice" would have
stayed green through the entire defect.

**Why this went unnoticed.** `after_first_workspace.operation` is one of only two crash
seams any registered suite drives, and the suite that drives it
(`resume-obvious-postcondition-test.js`) asserts a postcondition outcome rather than
resume-to-completion. The seven other seams are driven by nothing. See A20's note on
crash-seam coverage.

**Coverage.** `scripts/resumable-execution-test.js` is migrated, PostgreSQL-native, and
reproduces this deterministically as scenario 2. It is classified `excluded` /
`blocked-by-defect` — correct suite, broken production — exactly as
`assignment-audit-test.js` was before A21. Scenario 1 (crash *before* the operation,
resume executes it exactly once) is **verified green**, so the migration and the resume
path itself are sound; scenarios 3 and 4 are unverified because the suite aborts at 2.

---

### A21. Ticket reassignment is silently discarded, and the audit trail says otherwise

| Field | Value |
|-------|-------|
| **Status** | **Implemented 2026-07-26.** `reassignTicket` store writer; `assignment-audit-test.js` reinstated as required (31 assertions); mutation-verified |
| **Severity** | **High** — an audit record asserted a change that did not happen |
| **Scope** | Production runtime/persistence defect. Found by A20 tranche 2; **not** a test-migration issue |
| **Evidence** | Reproduced against `d29b3c5` by `scripts/assignment-audit-test.js`; root cause below |
| **Decision required** | Whether `transitionTicket` should patch the assignment columns, or whether reassignment needs its own store method |

**Description:**

`PATCH /api/tickets/:id/assignment` answers **HTTP 200**, advances the ticket revision,
sets `changedBy`/`changedAt`, appends a `ticket:assignment_change` audit log naming the
old and new agent, and emits `ticket.updated` — **while leaving the ticket assigned to
the original agent.**

```
agents a=1 b=2   ticket target=1
PATCH /api/tickets/1/assignment  { agentId: 2 }   → HTTP 200
after target=1   changedBy=admin
```

**Root cause.** `assignment_target_type` and `assignment_target_id` are real columns on
`tickets` (`persistence/postgres/migrations/001_runtime_core.sql`). `ticketFromRow`
reads them **from the columns**, overriding whatever the JSON `body` holds:

```js
assignmentTargetId: nullablePositiveSafeInteger(row.assignment_target_id, 'ticket.assignmentTargetId'),
```

`transitionTicket` — the only update path the endpoint uses — writes just two things:

```sql
SET status = $4,
    body = ticket.body || $5::jsonb,
```

So the endpoint's patch lands in `body`, where the column immediately shadows it.
Grepping `assignment_target_id` in `persistence/postgres/store.js` confirms it is
written **only at INSERT** (`createTicket`, `createTicketWithEvent`). **No update path
anywhere writes those columns.** A ticket's assignment is effectively immutable after
creation, and every surface that claims to change it is lying.

**Why this is High rather than Medium.** The failure is not "reassignment doesn't
work" — a visibly broken button is recoverable. It is that the system **records a
false audit fact**: the log says the ticket moved from agent 1 to agent 2, the
`ticket.updated` event payload says the same, and the ticket did not move. Anyone
reconstructing who was responsible for work at a given time gets a wrong answer from
the durable record. `docs/SYSTEM_STATUS.md`'s truthfulness rule applies directly here.

There is a second-order effect: the endpoint then calls `createRunsForTicket(ticket)`,
so the run it dispatches goes to the **old** agent while the audit trail attributes the
work to the new one.

**Coverage.** `scripts/assignment-audit-test.js` is repaired, PostgreSQL-native, and
correctly **fails** on this. It is classified `excluded` / `blocked-by-defect` in
`scripts/test-manifest.js` — not weakened to pass, and not deleted. It reverts to
`required` the moment this entry is implemented, and it already asserts the exact
property that must hold:

```js
assert(auditLog.nextAssignment.assignmentTargetId === reassigned.assignmentTargetId,
  'the audit log agrees with the ticket it describes');
```

### Implementation (2026-07-26)

**A dedicated store writer, not a widened primitive.** `transitionTicket` has eleven
callers and none of them changes an assignment. Teaching it to write the assignment
columns would have made *every* status transition capable of moving a ticket between
principals — a much larger blast radius than the defect. `PostgresRuntimeStore.reassignTicket`
was added instead, and `transitionTicket` is untouched, so the other callers are correct
by construction rather than by review.

`reassignTicket` writes the two authoritative COLUMNS and the body's `assignmentMode` in
a single UPDATE, under the same optimistic revision guard and status guard the other
transitions use, and it appends **both** the `ticket.updated` event and the
`ticket:assignment_change` audit log **inside the same transaction**. The endpoint
previously appended the audit log after the commit, so a failure between the two left a
reassignment with no audit record; now the evidence and the change commit together or
not at all.

The prior assignment is read `FOR UPDATE` inside that transaction rather than taken from
the caller's snapshot, so a concurrent writer cannot make the recorded "previous" value
a lie. The event and log payloads are both built from the row that was actually written.

**Proof — `scripts/assignment-audit-test.js`, 31 assertions**, one per guarantee:

| Guarantee | How it is proved |
|-----------|------------------|
| the ticket acquires the requested assignment | `store.getTicket` reports the new agent |
| assignment fields stay internally consistent | target type, target id and mode asserted together |
| the returned ticket reflects persistence | the HTTP body's ticket is compared to the stored row |
| the audit log matches ticket state | `nextAssignment` compared to the ticket, not to the request |
| the event agrees with the persisted ticket | payload assignment, `previousAssignment`, and the revision it produced |
| the run is dispatched on the NEW assignment | every dispatched run targets the new agent and none the old |
| a no-op is inert | revision, timestamps, log, event and run count all unchanged |
| stale writes cannot overwrite | a stale-revision `reassignTicket` is rejected, the ticket does not move back, and no audit evidence is left |

Two of those needed care to state truthfully: dispatching a run emits its own
`ticket.updated` immediately after the reassignment, so the assignment event is selected
by its `previousAssignment` marker rather than by being last, and the revision asserted
is the one the reassignment produced rather than the ticket's current one.

**Mutation-verified.** `assignment-column-divergence` in `scripts/suite-mutation-test.js`
restores the exact defect — the assignment lands in the JSON body where the column read
shadows it — and the suite fails. The endpoint still answers 200 and still writes its
evidence under that mutation, which is precisely why a suite that checked only the HTTP
status or only the log's existence would have stayed green.

---

### A20. Repository-wide PostgreSQL-cutover test-orphan population

| Field | Value |
|-------|-------|
| **Status** | **Open — inventory complete and authoritative; repair backlog of 83 remains.** Anti-rot mechanism implemented; two confirmed orphans repaired |
| **Severity** | **High** — 83 suites guard live contracts and none of them can run |
| **Scope** | Successor to A10, which inventoried 14 of them |
| **Evidence** | Every unregistered suite executed at `e1d05a7`; results in the classification below |
| **Decision required** | Repair, replace, or retire each of the 83, in priority order |

**Description:**

A10 restored fourteen orphaned harnesses and recorded a suspicion that the population was
larger. It is. Executing every unregistered suite establishes the real numbers:

| Classification | Count |
|----------------|-------|
| **required** — must run in the release checkpoint | 75 |
| **orphaned** — genuine cutover orphan, cannot run | 75 (one split; its injection half still open) |
| **excluded** — deliberately outside the checkpoint | 20 |
| **total `scripts/*-test.js`** | **162** |

The A10 entry guessed ~96 candidates and cautioned that the list "includes false positives,
comments, and intentionally excluded live-provider tests." **That caution was wrong in one
direction and right in another.** All 96 reference `DATA_DIR` in executable code, not
comments — there were no comment-only false positives. But 13 of them are legitimately
excluded (live-provider, manual-demo) rather than orphaned, so the true orphan count is 83.

### The inventory is execution-backed, not grep-backed

Every one of the 111 unregistered suites was executed. Grep established candidates; execution
established categories, and it moved suites between them:

- **70** die on `DATABASE_URL is required for the PostgreSQL runtime` — the loud A10 shape.
- **11** present as `Timed out waiting for server ready`. Same root cause: they spawn a server
  with no database URL, and their own readiness poll masks the child's death.
- **7** were the reason this had to be executed rather than inferred. See below.
- **14** PASS. Six are genuinely runnable and were simply never registered.
- **4** fail on missing helper symbols — the A13 population.
- **12** fail for assorted separate reasons (live-provider guards, manual-demo prerequisites,
  two more source-coupled suites).

### Seven suites exit ZERO while asserting nothing

The most serious finding, and the one a grep sweep could never have produced: these suites
report success while executing no assertions at all.

```
assignment-audit-test.js              15s, exit 0, ZERO bytes of output
conditional-workflow-prompt-test.js   15s, exit 0, ZERO bytes of output
status-transition-evidence-test.js    15s, exit 0, ZERO bytes of output
workflow-composition-test.js          15s, exit 0, ZERO bytes of output
operational-abuse-test.js             exit 0, "Total: 0 | Passed: 0 | Failed: 0"
resumable-execution-test.js           exit 0, "Total: 0 | Passed: 0 | Failed: 0"
scheduler-integrity-abuse-test.js     exit 0, "Total: 0 | Passed: 0 | Failed: 0"
```

**Mechanism, confirmed in the source.** Each has a cleanup block of the form:

```js
} finally {
  child.kill();
  await new Promise(resolve => child.once('exit', resolve));   // no guard
}
```

When the server dies at startup — which is the orphan condition — the child has **already**
exited, so `child.once('exit')` never fires again and the promise never settles. The `finally`
hangs, `main().catch(...)` never runs, the event loop drains, and node exits **0** with the
error never printed. `waitForReady()` did throw; nobody ever saw it.

Contrast the correct form, present in the suites that fail loudly:

```js
if (child.exitCode !== null || child.killed) return resolve();
```

**Why this is worse than a loud orphan.** A loud orphan is a known gap. A silent one is
indistinguishable from working coverage — and if anyone had "helpfully" registered these to
raise the checkpoint count, they would have been permanently green while asserting nothing.
They are classified `cutover-orphan-silent` and must have this defect fixed as part of any
repair, not merely be pointed at PostgreSQL.

### Anti-rot: `scripts/test-manifest.js`

The gap A10 left is that its guard is a hand-maintained list of fourteen filenames. It cannot
notice a *new* suite nobody registers — which is exactly how the cutover orphaned suites in
bulk without anything going red.

The manifest is now the authority. Every `scripts/*-test.js` file carries a status
(`required` / `orphaned` / `excluded`) and, when not required, a reason from a documented
vocabulary. `scripts/release-checkpoint-coverage-test.js` enforces six rules:

1. every test file appears in the manifest — **an unclassified new test fails the checkpoint**;
2. no manifest entry points at a file that no longer exists;
3. every `required` suite is registered in the checkpoint;
4. every registered suite is classified `required` — nothing orphaned or excluded runs;
5. every non-required entry carries a reason from the documented vocabulary;
6. the three statuses partition the manifest exactly.

**Why a manifest rather than another filename heuristic.** Rule 3 is the anti-rot rule, but it
only works if exclusions are legitimate and explicit. "Every `*-test.js` must be registered"
would be false — live-provider suites need an API key or a running Ollama, the mutation tool
edits tracked source, and the manual-demo runners expect a developer server. A heuristic would
have to encode those exceptions by filename and would drift. The manifest states them.

`node scripts/test-manifest.js` prints the inventory, so the repository answers *what tests
exist, which are required, which are excluded, why, and where each runs* without depending on
anyone's memory.

### Exclusions, and one that is not merely a preference

| Reason | Count | Basis |
|--------|-------|-------|
| `live-provider` | 4 | Needs a real OpenAI key or a running Ollama |
| `manual-demo` | 8 | Operator demo/stress runners, not regression suites |
| `mutation-tool` | 1 | `suite-mutation-test.js` edits tracked source by design |
| `source-coupled-other` | 2 | `operator-workflow-test.js`, `report-generation-test.js` — same extraction coupling, outside A13's scope; needs its own disposition |

**`manual-demo` is a safety classification, not a taste one — demonstrated accidentally.** The
inventory sweep executed them, and several write into the repository working tree: they set
`DATA_DIR = path.join(ROOT, 'data')` and `WORKSPACE_ROOT = path.join(ROOT, 'workspace-root')`.
The sweep left six tracked `data/*.json` files modified (`data/tickets.json` lost 869 lines)
and created a stray `workspace-root/`. All were restored, but the lesson stands: these must
never run unattended, and the manifest is where that is now written down.

### Repaired in this tranche

| Suite | Contract | Result |
|-------|----------|--------|
| `concurrency-conflict-test.js` | Concurrent overlapping/non-overlapping workspace mutation; cross-ticket delete authority | 16 scenarios, 0 not-proven |
| `run-detail-permissioned-delete-audit-test.js` | Run detail displays permissioned cross-ticket delete provenance — **and only when the permission was used** | 16 assertions |

**A strengthening that was a precondition for registering the first one.**
`concurrency-conflict-test.js` treated `NOT_PROVEN` as a neutral discovery outcome, and every
scenario had a `NOT_PROVEN` escape ("owner run did not complete"). A run of it in which nothing
worked would have exited **0**. That is the same green-but-vacuous shape as the seven silent
suites, just with a tidier report. `NOT_PROVEN` is now a hard failure: against a real store
driven by a deterministic model-free stub, a scenario that cannot reach its own preconditions
means the harness is broken, not that reality is ambiguous.

Its JSON-corruption assertions (`jsonParsesOrNull`) were retired: they guarded against a torn
concurrent write to a flat file, which PostgreSQL cannot produce. The surviving property —
concurrent writers lose and duplicate no records — is asserted directly through record counts
and per-run receipt isolation.

`OBSERVED_SAFE`/`OBSERVED_UNSAFE` is kept for the two parent/child probes, because the
vocabulary still records *how* the guard fired rather than only that it did.

### Also registered: six suites that were passing and unwatched

`telemetry-test.js`, `workload-profile-test.js`, `archive-local-events-test.js`,
`mutating-limit-context-regression-test.js` (deterministic) and `operator-visibility-test.js`,
`oquery-parity-test.js` (already PostgreSQL-native). Nothing was wrong with any of them.
Nothing ran them either — the same gap, in its quietest form.

### Mutation coverage

`scripts/suite-mutation-test.js` (renamed from `a10-suite-mutation-test.js`, which now covers
A10 and A20) gained two mutations for the repaired suites, both killed:

| Mutation | Contract removed | Suite |
|----------|------------------|-------|
| `cross-ticket-delete-gate` | a cross-ticket delete requires the permission | `concurrency-conflict-test.js` |
| `permissioned-delete-block-unconditional` | the audit block renders only when the permission was used | `run-detail-permissioned-delete-audit-test.js` |

The second is worth noting: only the suite's **negative** half catches it. A block that always
renders would attest to an authorization that never happened, and a suite asserting only the
happy path would have stayed green.

### Tranche 2 (2026-07-26) — the silent orphans

Started with the seven `cutover-orphan-silent` suites, per this entry's own sequencing.

**The shared fix.** `scripts/child-process-settlement.js` replaces the unguarded
`child.once('exit')` pattern once rather than seven times:

- `settleChild(child, { timeoutMs })` — resolves whether the child exited before or
  after the call, and **rejects rather than hangs** if it does neither
- `stopChild(child, { graceMs, killMs })` — SIGTERM → SIGKILL, always settles
- `assertScenariosExecuted({ assertions, scenarios, minAssertions })` — the vacuity
  floor, because "zero assertions ran" is never a valid successful outcome

`scripts/child-process-settlement-test.js` (23 assertions, registered) demonstrates all
six required cases: child still running, child already exited, normal exit codes,
forced termination, a child that never exits reaching the caller as a rejection, and no
successful zero-assertion exit. The already-exited case asserts the helper returns in
under a second — the old pattern waited forever there.

**Dispositions this tranche:**

| Suite | Disposition | Result |
|-------|-------------|--------|
| `status-transition-evidence-test.js` | Repair and retain → **required** | ✅ 22 assertions |
| `assignment-audit-test.js` | Repair and retain → **excluded / blocked-by-defect** | ✅ repaired; **fails on a real production defect — see A21** |
| `conditional-workflow-prompt-test.js` | Still `cutover-orphan-silent` | Not reached |
| `workflow-composition-test.js` | Still `cutover-orphan-silent` | Not reached |
| `operational-abuse-test.js` | Still `cutover-orphan-silent` | Not reached |
| `resumable-execution-test.js` | **Migrated** → `excluded / blocked-by-defect` | Scenario 1 verified green; scenario 2 reproduces **A22** |
| `scheduler-integrity-abuse-test.js` | Still `cutover-orphan-silent` | Not reached |

**The tranche found a High-severity production defect, which is the point.**
`assignment-audit-test.js`, once it could actually fail, immediately exposed **A21**:
`PATCH /api/tickets/:id/assignment` returns 200 and writes an audit record claiming the
ticket moved between agents, while the assignment columns are never updated by any
update path. That defect had been sitting behind a suite that exited 0 in silence.

It is classified `blocked-by-defect` rather than weakened to pass. A new exclusion
reason was added for exactly this case: **the suite is correct and production is
broken.** Excluding it keeps the checkpoint honest; adjusting the assertion until it
went green would have re-hidden the defect the suite exists to catch.

**Note for whoever takes the remaining five.** Two things learned here that will save
time:

- The scheduler must be parked (`RUNTIME_SCHEDULER_INTERVAL_MS: '3600000'`) for any
  suite that measures ticket state, or it dispatches a run and mutates the fields under
  test mid-assertion.
- Reopening a ticket synchronously calls `createRunsForTicket`, so a ticket asserted as
  `open` may legitimately already be `in_progress`. Assert what the transition
  guarantees (it left `blocked`), not an exact resting status.

**`resumable-execution-test.js` — hypothesis tested and REJECTED. Disposition: repair
and retain.**

A preliminary read suggested its five scenarios might already be covered by
`recovery-state-reconstruction-test.js`, `lease-renewal-resume-safety-test.js` and
`postgres-startup-recovery-test.js`. That hypothesis was recorded rather than acted on,
and checking it showed it is **materially wrong**.

The runtime exposes **nine** deterministic crash seams:

```
after_action_contract_violation      after_run.created
after_first_authority.allowed        after_run.snapshot_finalized
after_first_workspace.operation      after_run.started
after_first_workspace_target_effect  before_run.consequence_recorded
before_run.snapshot_finalized
```

Across the **entire registered checkpoint**, only **two** are ever driven:
`after_first_workspace.operation` (`resume-obvious-postcondition-test.js`) and
`after_action_contract_violation` (`model-contract-violation-recovery-test.js`).

`resumable-execution-test.js` drives **four**:

| Interruption point | Covered by a registered suite? |
|--------------------|-------------------------------|
| `after_first_authority.allowed` | **No** |
| `after_run.started` | **No** |
| `before_run.snapshot_finalized` | **No** |
| `after_first_workspace.operation` | Yes |

`recovery-state-reconstruction-test.js` does not close this: it is a **pure classifier
test** over synthetic snapshots and never crashes a real server, so it cannot show that
the runtime reaches the same conclusion the classifier does. Three of the four crash
points here have **no live crash-recovery coverage anywhere in the repository**.

Retiring this suite would therefore have deleted unique coverage of exactly the
contract A20 ranks highest — recovery and terminal-state integrity. It is
**repair and retain**, and it should lead the next tranche.

**Wider finding worth its own attention:** 7 of 9 crash seams are exercised by nothing
in the checkpoint. The seams exist because the recovery contract is hard to prove any
other way; leaving most of them unused means recovery is largely asserted by
construction rather than demonstrated. That is a coverage gap independent of the orphan
backlog and is worth a decision of its own.

### The last four silent orphans — coverage analysis (2026-07-26)

Partial. Each finding below is stated with the evidence that supports it, and what is
**not** yet verified is marked as such rather than rounded up to a disposition.

**`conditional-workflow-prompt-test.js` — REPAIR, not retire. Earlier recommendation
withdrawn (inventory 2026-07-26).**

The previous entry recommended retiring it on the strength of the dead
`replaySnapshotPath` coupling. Reading the rest of the suite shows that was the wrong
call, and the correction is worth stating plainly: **a dead mechanism in one helper is
not evidence that the properties are dead.**

The `replaySnapshotPath` coupling is confined to a **single three-line helper**
(`readSnapshot`), which falls back to it only when an inline snapshot is absent. That
helper is dead storage-layout coupling and must not be ported. It is not the suite.

What the suite actually guards is **prompt composition**, asserted against the prompt
the model received — the recording-provider shape, already built. It carries **34
negative assertions** of the form *"ordinary prompt should not include …"*, which is
exactly the leak protection that matters here:

| Property | Assertion style |
|----------|-----------------|
| workflow guidance appears only for workflow runs | positive on workflow prompt |
| branching guidance, example and intent warning excluded from ordinary runs | **negative** |
| workflow-draft-intent prose, example, id guidance, nested-field and postcondition guidance excluded from ordinary runs | **negative** |
| handoff prose and args reminder excluded from ordinary runs | **negative** |
| `allowedOperations` still lists `createHandoffTask` / `createWorkflowDraftIntent` on ordinary runs | positive control — capability is present even when its guidance is not |
| branching directs away from `createWorkflowDraftIntent` | positive |
| allocated runs carry populated `allocationPlanId`, `allocationItemId`, `allocationItem`, `allocationSubtask`, `ownedOutputPaths` | positive |

`postcondition-completion-test.js` covers draft-intent and handoff **behavior** —
whether an intent is recorded, whether a handoff is created. It asserts nothing about
what the model was **told**, so it is not a successor for any of the above. **No
registered suite asserts prompt content at all.**

**Recommended shape.** Port it as `workflow-prompt-composition-test.js` against the
harness, keeping the negative assertions verbatim, sourcing prompts from a recording
provider (the pattern in `rerun-mode-evidence-test.js`), and dropping `readSnapshot`
entirely — nothing in the prompt contract needs a replay snapshot. Required additions:
a non-workflow run must receive no workflow-only instruction, an unrelated workflow must
not leak context, and zero captured prompts must fail rather than pass vacuously.

**`operational-abuse-test.js` — SPLIT AND CLOSED (2026-07-26).** Every one of its 15
scenarios now has a named end-state, so none is left ambiguous:

| Scenario | End state |
|----------|-----------|
| `testTooManyActions`, `testTooManyMutatingActions` | covered — `bounded-transition-test.js` |
| `testStalledResponses`, `testMultiStepStallThenRecover` | covered — `model-contract-violation-test.js` |
| `testLeaseExpiryRecovery` | covered — `lease-renewal-resume-safety-test.js` |
| `testRunInterruption` | covered — `resumable-execution-test.js` (A22) |
| `testConcurrentAgentRuns` | covered — `concurrency-conflict-test.js` |
| `testReplayEventConsistency` | covered — `required-replay-evidence-test.js`, `replay-snapshot-storage-test.js` |
| `testInvalidRuntimeConfig` | covered — `runtime-limits-config-test.js` |
| `testMalformedHandoff`, `testInvalidDraftIntent`, `testHandoffExecutorMismatch` | covered — `postcondition-completion-test.js` scenarios 9–19 |
| `testProtectedPathWrite`, `testAgentDirectOperationAccess` | **migrated** → `workspace-authority-gate-test.js` |
| `testDisabledOperationGate` | **left open — A8.** See below |

The suite is `excluded / superseded`: retained on disk so the mapping can be re-checked,
not run, and no coverage lost.

**`testDisabledOperationGate` is left open deliberately, and it is not a test defect.**
The scenario seeds an agent with `runtimeConfig: { allowWorkflowDraftIntent: false }`,
observes whether the restriction is enforced, and then returns `passed: true`
**regardless** — logging a "FINDING" that the flag "is declared but not enforced". So
the historical suite already knew the gate does not exist and chose to report rather
than fail. That is **A8 (dead `allow*` policy fields)**, an open governance item: whether
those flags become enforced or are removed is a product decision, not something a test
tranche may settle by picking one. Migrating the scenario now would mean either encoding
the broken behavior as correct or shipping a red suite for a decision nobody has made.

### `workspace-authority-gate-test.js` — the migrated residue

17 assertions, 3 scenarios, registered. What it proves that nothing did before:

- a `writeFile` to `.env` (in `config/protected-paths.json`) fails the run, records an
  `authority.denied` event carrying the structured `rule: 'protected_path'` and the
  refused path, creates no file, and leaves **no receipt claiming a successful write**
- a path escaping the workspace root is refused on the same terms
- **positive control:** the same agent, same run shape, an ordinary path — succeeds,
  writes exactly one receipt, and records no denial

The control is load-bearing. Without it, both refusal scenarios would also pass against
a runtime that refused every mutation or never dispatched a run at all.

**Why this was genuinely uncovered.** `protected_path` appeared in the registered
checkpoint only inside `workspace-snapshot-availability-test.js`, and only as a pure
classifier check — `classifyWorkspaceSnapshotFailure({ kind: 'protected_path' })`.
Nothing drove a real run at a protected path. A classifier agreeing with itself is not
evidence that the gate fires, which the `protected-path-gate-disabled` mutation
confirms.

**Aiming that mutation taught something worth keeping.** The first attempt neutered
`blockProtectedWorkspaceOperation` alone and **survived** — a second, independent
authority check (`createWorkspaceViolationItem`) also matches protected paths, so
removing one layer left the contract intact. Re-aimed at the shared matcher
`getProtectedWorkspacePathMatch`, which both gates consult, it kills the suite. And the
kill exposed a **third** layer: with protected-path matching gone, `.env` is still
refused — by the hidden/system-path rule ("Hidden and system paths are not allowed").

So protected paths are defended three deep. That is good news for the runtime and a
warning for testing it: a suite asserting only "the run failed" would have stayed green
through the removal of two independent gates. The assertion that actually caught it is
the one requiring the failure to **name the protected-path rule**, which is why the
suite checks the structured `rule` and the refused path rather than just the outcome.
This is the third time in A20 that a surviving mutation meant defense in depth rather
than a coverage hole.

**Superseded scenario mapping (retained for re-checking):** of its 15 scenarios,
at least five have registered successors:

| Scenario | Covered by |
|----------|-----------|
| `testTooManyActions`, `testTooManyMutatingActions` | `bounded-transition-test.js` |
| `testStalledResponses`, `testMultiStepStallThenRecover` | `model-contract-violation-test.js` |
| `testLeaseExpiryRecovery` | `lease-renewal-resume-safety-test.js` |
| `testRunInterruption` | `resumable-execution-test.js` (registered under A22) |

The residue is authority and gate coverage — `testProtectedPathWrite`,
`testDisabledOperationGate`, `testAgentDirectOperationAccess`, `testMalformedHandoff`,
`testHandoffExecutorMismatch`, `testInvalidDraftIntent` — and that is where the value
is. Port the residue; retire the rest with the mapping above recorded.

**`scheduler-integrity-abuse-test.js` — CLOSED (2026-07-26).** Checked scenario by
scenario rather than assumed. Every one of its 13 has a named end state, and unlike
`operational-abuse-test.js` the residue produced no migration: it is covered, obsolete,
or vacuous by construction.

| Scenario | End state |
|----------|-----------|
| `testRunResumptionAfterCrash` | covered — `resumable-execution-test.js` (A22) |
| `testLeaseExpiryDuringRun`, `testStaleLeaseCleanup`, `testDoubleLeaseAcquisition`, `testConcurrentRunClaims` | covered — `lease-renewal-resume-safety-test.js`, `scheduler-observability-test.js` |
| `testDuplicateReplayAppend`, `testReplayOrdering` | covered — `required-replay-evidence-test.js`, `replay-snapshot-storage-test.js` |
| `testConcurrentWorkspaceMutation` | covered — `concurrency-conflict-test.js` |
| `testEvaluationConsequenceOrdering` | covered — `run-consequence-mutation-test.js` (A16) |
| `testExecutorRunOrphaning` | covered — `concurrency-conflict-test.js` asserts `stuckRunning === 0` after concurrent stop+rerun, the same no-orphan property under strictly harder conditions |
| `testInterruptedExecutorHandoff` | covered — `resumable-execution-test.js` (terminal convergence incl. `interrupted`) and `delegated-run-logging-containment-test.js` |
| `testPartialWriteInterruption` | **retired — mechanism and property both obsolete.** It asserts `dataValid`, meaning a flat JSON file was not left torn by an interrupted write. PostgreSQL cannot produce that state; the same reasoning retired `jsonParsesOrNull` from `concurrency-conflict-test.js` |
| `testStalledProviderRecovery` | **retired — vacuous by construction.** It returns `passed: true` unconditionally. Stall recovery is covered by `model-contract-violation-recovery-test.js` |

**Ten of its 13 scenarios return `passed: true` literally**, so the suite could not have
failed on those regardless of runtime behavior. That is worth recording as a caution
about the whole `*-abuse-test.js` family: they were written as *exploratory probes* that
report findings, not as regressions that gate. Reading their names as coverage would
overstate what they ever guaranteed.

**Superseded mapping detail (retained for re-checking):** At least seven of its 13
scenarios map onto registered suites: crash resumption to `resumable-execution-test.js`;
lease expiry, stale-lease cleanup, double acquisition and concurrent claims to
`lease-renewal-resume-safety-test.js` and `scheduler-observability-test.js`; duplicate
replay append and replay ordering to `required-replay-evidence-test.js` and
`replay-snapshot-storage-test.js`; concurrent workspace mutation to
`concurrency-conflict-test.js`; evaluation/consequence ordering to
`run-consequence-mutation-test.js` (A16). The residue is executor orphaning and partial
write interruption. *Unverified:* whether the registered successors assert the same
properties or merely touch the same mechanism. Check scenario by scenario before
retiring anything — A20 already rejected one overlap hypothesis that looked stronger
than these.

**`workflow-composition-test.js` — REPAIR, and it is the most valuable orphan left
(inventory 2026-07-26).**

Structure first, because it changes how the file must be handled: there are **no
discrete scenarios**. `main()` is one 1,275-line sequence carrying **~340 inline
assertions** and ending in a single JSON emission. It cannot be split by lifting
scenario functions the way `operational-abuse-test.js` was; the contracts have to be
read out of the assertions.

Contract groups, from the assertion inventory:

| Group | Registered successor? |
|-------|----------------------|
| `executeActionPlan` — proposed / accepted / executed / rejected action evidence, `workflowActionPlans` | **NONE** |
| `executeTicketPlan` — child ticket creation, `workflowTicketPlans`, parent ticket/run/step/plan linkage, parent-scoped spawn idempotency, "v1 must not auto-run children" | **NONE** |
| Workflow branch execution (true and false paths, invalid `trueNext` rejection) | **NONE** |
| Workflow mutation budgets — `maxMutations`, exact-cap stop, over-cap deterministic rejection | Partial — `bounded-transition-test.js` covers per-response caps, not per-workflow budgets |
| Execution-policy normalization for legacy tickets (assisted mode, null maxAttempts, `when_declared`, shared scope, policy-change must not mutate replay evidence) | **NONE** |
| Failing postcondition → `run.verification_failed`, `run.triage_created`, failed effectiveness, "completed status alone must not report 100% objective success" | Mostly — `postcondition-completion-test.js` |
| Run lifecycle event completeness (~20 event types) | Partial — `operator-visibility-test.js`, `event-integrity-negative-test.js` |

**The headline: `executeActionPlan`, `executeTicketPlan`, `workflowActionPlans` and
`workflowTicketPlans` appear in NO registered suite.** Workflow composition — the
runtime path that spawns child tickets and executes planned actions — is guarded by
this orphan and by nothing else. `spawnIdempotencyKey` has store-level coverage in
`postgres-persistence-integration-test.js`, but the runtime path that produces it does
not.

That makes this the **highest-value repair remaining in A20**, ahead of the 76 loud
orphans: it is the only coverage of a whole subsystem, and it has been dead since the
cutover.

**Recommended shape.** Do not port the monolith. Extract focused PostgreSQL-native
suites along the group boundaries above, starting with the two that have no successor
at all:

1. `workflow-action-plan-test.js` — proposed/accepted/executed/rejected evidence, and
   that rejection is deterministic and does not fail the workflow
2. `workflow-ticket-plan-test.js` — child ticket creation and full parent linkage,
   parent-scoped spawn idempotency (duplicate plan steps create one child), and that v1
   does not auto-run children

Both need negative controls: an invalid plan must record the proposal AND the rejection
while executing nothing, and an over-cap plan must reject **all** proposed actions
rather than a prefix.

**A caution that has now been earned twice.** Both suites repaired in the previous
tranche found production defects the moment they could fail (A21, A22), and A20's own
overlap hypothesis about `resumable-execution-test.js` was wrong. Apparent redundancy in
this list should be treated as a hypothesis to test, not a reason to delete.

### Silent orphans: closed (2026-07-26)

**`cutover-orphan-silent` is now zero.** All seven are dispositioned: two repaired in
tranche 2, two split against named successors, one repaired under A22, and the final two
replaced here.

**Workflow composition — the subsystem that had no coverage at all — is now guarded.**
The 1,275-line monolith is retired and replaced by two focused suites along the
primitive boundary, because `workflowActionPlans` and `workflowTicketPlans` are separate
evidence collections and the original conflated them behind one harness.

`workflow-action-plan-test.js` (31 assertions, 3 scenarios): a valid plan executes for
real and in order — proved from the workspace, not just the evidence — with the
proposed/accepted/rejected/executed quartet consistent and one durable operation receipt
per executed action; an action outside `allowedOperations` is rejected with a reason,
executes nothing, and **does not fail the workflow**; an over-cap plan rejects **every**
proposed action rather than a prefix, leaving no partial effect.

That last one matters most: partial acceptance would let a run claim a bounded plan
while having performed an unbounded fraction of it.

`workflow-ticket-plan-test.js` (31 assertions, 2 scenarios): planned children are
created with the requested workflow, objective and per-child workflow input, fully
attributable to parent ticket, run, workflow, step and plan instance, each carrying a
distinct parent-scoped spawn idempotency key; **v1 does not auto-run them** — they are
created blocked with zero runs; and a workflow outside `allowedWorkflowIds` is rejected
without creating anything or failing the parent.

`workflow-prompt-composition-test.js` (15 assertions) replaces the conditional-prompt
suite. It reads `systemInstructionSnapshot` from the durable replay snapshot — the
instruction the runtime actually sent, recorded by the runtime itself — so the dead
`replaySnapshotPath` helper is simply not ported. It proves branching, canonical,
draft-intent and handoff guidance stay out of an ordinary run, that a workflow-shaped
objective does receive them (the positive control), and that `allowedOperations` remains
truthful on the ordinary run even where the guidance is withheld. Guidance and
capability are asserted separately because they must be allowed to disagree.

**Three mutations added, all killed** — and two needed re-aiming, in ways worth keeping:

| Mutation | Note |
|----------|------|
| `action-plan-allowlist-ignored` | killed first try |
| `child-tickets-auto-run` | first attempt edited only the explanatory COMMENT above the code and survived. A mutation must change behavior, not prose. Re-aimed at the child's `status: 'blocked'` |
| `workflow-guidance-leaks-into-ordinary-prompt` | first attempt gated on `AGENT_CANONICAL_WORKFLOW_DRAFTS_ENABLED`, which is **off by default**, so removing it changed nothing — and that also revealed the suite's canonical-marker assertions were vacuous until the flag was enabled. Re-aimed at the applicability predicate itself |

The second of those is the more useful lesson: a surviving mutation exposed that two of
the suite's own negative assertions could never have failed, because the guidance they
excluded was never emitted under the test's environment. Enabling
`AGENT_ALLOW_CANONICAL_WORKFLOW_DRAFT` made them real.

### Crash-seam coverage, remapped after A22 (2026-07-26)

Rebuilt from the repository, not carried forward from the pre-A22 count:

| Seam | Registered driver |
|------|-------------------|
| `after_action_contract_violation` | `model-contract-violation-recovery-test.js` |
| `after_first_authority.allowed` | `resumable-execution-test.js` |
| `after_first_workspace.operation` | `resume-obvious-postcondition-test.js`, `resumable-execution-test.js` |
| `after_run.started` | `resumable-execution-test.js` |
| `before_run.snapshot_finalized` | `resumable-execution-test.js` |
| `after_first_workspace_target_effect` | **`target-operation-reconciliation-test.js` (repaired here)** |
| `after_run.created` | none |
| `after_run.snapshot_finalized` | none |
| `before_run.consequence_recorded` | none |

A22 took this from 2 of 9 to 5; repairing the reconciliation suite makes it **6 of 9**.
The three still uncovered are all terminalization-boundary seams and are the natural
next recovery cluster.

**`target-operation-reconciliation-test.js` — repaired and registered (20 assertions).**
It was the only suite in the repository driving `after_first_workspace_target_effect`,
the window where the external effect has landed and its evidence has not. It proves both
outcomes: an APPLIED effect is reconciled into exactly one recovery-marked receipt
retaining its stable operation key, with one completion event and replay linkage and no
re-application; and an UNCERTAIN effect — where a third party changed the target while
the runtime was down — is REFUSED, manufacturing no successful receipt, leaving the
divergent state untouched, and emitting
`workspace.operation_reconciliation_required` for a human to decide.

The refusal half is the safety-critical one: reconciling under divergence would fabricate
evidence for an effect nobody can prove this run produced.

**The mutation needed two re-aims, and the reason is reusable.**
`reconciliation.status === 'uncertain'` appears at three sites on three different paths.
Cutting the in-run `beginWorkspaceMutation` branch **survived** — a crashed run is
reconciled by STARTUP recovery (`reconcilePreparedTargetOperation`), not by the in-run
begin path. Aimed there, it kills. When a mutation survives, check which layer actually
executes before concluding the suite is weak; this is the fourth time in A20 that a
surviving mutation meant defense in depth rather than a coverage hole.

### Authority cluster 1 — permission escalation (2026-07-26)

**`rbac-and-inline-data-security-test.js` — SPLIT.** It bundles two unrelated
contracts, and only one of them is an authority boundary:

| Half | Contract | Disposition |
|------|----------|-------------|
| privilege escalation | a partial admin cannot reach permissions it was not granted | **migrated** → `permission-escalation-boundary-test.js` |
| inline data security | hostile agent names are script-escaped, provider secrets are not rendered, client rows avoid HTML sinks | **still open** — an injection contract, not an authority one; needs its own home |

The historical file stays `orphaned` because half its contract has not moved yet.
Retiring it now would silently drop the injection half — thematic proximity to "security"
is not a successor relationship.

**`permission-escalation-boundary-test.js` — 17 assertions, 7 scenarios, registered.**

The escalation shape that matters is not "can a nobody do nothing" but "can a partial
admin promote itself", so the seeded principal holds a realistic bundle —
`user:create`, `user:read`, `user:update`, `group:create`, `group:update` — and is
refused when it tries to create an account already inside a privileged group, mint a
group carrying `user:delete`, reach workflow management on the strength of `user:read`,
or read the event stream without `ticket:read`.

**Both sides, and effect not just status.** Every refusal is paired with the nearest
action the same principal legitimately may take — an unassigned account, an empty group
— and with an administrator succeeding on the surface the limited principal was refused.
Refusals additionally assert the row was **not written**: a 403 that still created the
user would be worse than a 500, and status alone cannot distinguish them. A seventh
scenario pins the outer boundary, so the 403s above are known to be about permissions
rather than authentication.

One assertion was weakened deliberately and the reason recorded in the suite:
`/admin/users` and `/admin/groups` are POST-only, so an anonymous GET is a 404 rather
than a redirect. The property under test is that nothing is *served*, so those assert
"not 200", with `/admin/workflows` — which does have a GET — carrying the stricter
redirect/401/403 assertion.

**Mutation-verified.** `permission-grant-escalation-open` removes the
`permission:assign` check from group creation, letting a principal with `group:create`
mint a group carrying any permission and add itself. Killed. Note that every positive
control stays green under it — only the refusal half catches self-promotion.

### Authority cluster 2 — timeline authority evidence (2026-07-26)

**`ticket-timeline-authority-visibility-test.js` → `timeline-authority-evidence-test.js`**
(30 assertions, 5 scenarios, registered). The historical file stays `orphaned`: it also
carries read-receipt, provenance-versioning and triage-projection assertions that have
not moved yet.

The contract is that the timeline is a **truthful, deterministic, read-only** projection
of what authority decided. Proved: a protected-path refusal appears exactly once as an
`authority.denied` entry carrying the structured `rule` and the refused target, leaves
no filesystem effect and no successful receipt; an allowed mutation on the same agent
appears once as `target.mutation_committed` with an `authority.allowed` counterpart and
is never rendered as a denial; neither ticket's timeline carries an entry belonging to
the other's run or ticket; projecting twice is byte-identical; and projecting mutates no
run or ticket revision.

**Two of this suite's own assertions were vacuous until the mutation test caught them.**
Both are recorded because the pattern will recur:

1. *Folding.* The suite asserted that a blocked `workspace.operation` folds into the
   authority entry. Cutting the folding logic — both the key dedupe and the id set —
   **survived**, because a protected-path block throws *before* any
   `workspace.operation` event is written. There was never a duplicate to fold, so the
   assertion could not fail. It is retained as a real invariant with that limitation
   stated inline. **Fold coverage still needs a denial shape that does emit a blocked
   workspace event** — cross-ticket ownership is the candidate, and
   `concurrency-conflict-test.js` already drives it behaviorally.

2. *Rule attribution.* The suite matched `/protected/i` against the entry's details and
   summary. Stripping the structured `rule` field **survived**, because the summary
   prose still contains the word "protected". Re-expressed as
   `details.rule === 'protected_path'`, which is what the objective's "name the actual
   rule" requires — a substring of English is not attribution.

**Mutation status, stated precisely.** `authority-denial-loses-its-rule` is **killed**,
but by the determinism assertion rather than the attribution one: nulling the rule also
changes the projection between two reads. The suite therefore detects the regression,
which is the required proof, but the kill is not attributable to the assertion aimed at
it. Left as-is rather than tuned to produce a prettier attribution.

**`allocated-regression-test.js` — inventoried, split identified, not yet migrated.**
Its 1,372 lines carry **five separable contracts**, so it must be split rather than
ported:

| Contract | Nature |
|----------|--------|
| **scope admission** — overlapping, non-directory, absent or ambiguous owned scopes refused at creation and not persisted | authority |
| **owned-path enforcement** — an allocated run may mutate only inside its own scope | authority |
| **allocation attribution** — plan id, item id, subtask, agent, status, shared batch marker, one run per group agent | authority/provenance |
| **replay fidelity and secret redaction** — snapshot carries correct run/ticket/agent/allocation identity and exposes no API key or `Authorization` value | evidence + security |
| **retry / rerun / idempotency / stop / budget** lifecycle | lifecycle |

**Authority core migrated — `allocation-scope-authority-test.js`, 31 assertions,
7 scenarios, registered.**

**The recorded hypothesis about the blocker was WRONG, and the correction matters more
than the fix.** A20 guessed the embedded `#ACTIONS=` directive made the objective
infeasible. It does not. The real gate is `assertAllocatedObjectiveSupported`: an
allocated objective must contain an ADDITIVE noun (`file`, `folder`, `report`,
`document`, …) and must contain NO destructive verb (`delete`, `remove`, `rename`,
`move`, `edit`, `update existing`, …). The failing probe objective was "Write status
notes" — and *notes* is simply not in the additive vocabulary. The directive was never
the problem; three different objective shapes all failed identically, which is what
exposed the guess.

The fix is therefore not a workaround: the objectives are natural language that
genuinely describes additive independent outputs, and the provider stub keys off a
distinct MARKER WORD carried inside that objective rather than an encoded plan. The
feasibility gate runs for real — nothing bypassed, disabled or mocked.

**What it proves:** overlapping scopes, a non-directory scope and absent
`ownedOutputPaths` are each refused with HTTP 400 leaving no persisted ticket; a
well-formed allocated ticket is ADMITTED, is not blocked by feasibility, and produces
one run per allocated agent sharing one allocation plan with distinct items, each naming
its own owned path; the in-scope write completes and leaves exactly one successful
receipt; and an out-of-scope write — on a ticket that was *admitted*, so the refusal is
enforcement rather than admission — fails the run, leaves no file and no successful
receipt, and names both the ownership rule and the refused target.

**Mutation `owned-path-scope-broadened`** widens the containment check so every path
counts as owned. Admission still works and the in-scope control stays green; only the
out-of-scope scenario catches an allocated agent writing into a peer's territory.
Killed.

**Contracts 2 and 3 migrated — `allocation-attribution-redaction-test.js`, 50
assertions, 5 scenarios, registered.**

*Attribution* is asserted as a **bijection**, not merely as presence: two runs, two
distinct allocation items, one shared plan, each owning exactly the scope its agent was
allocated. The failure that matters is not missing attribution but WRONG attribution —
item B's receipt filed under item A is worse than no receipt, because it is confidently
false. Cross-contamination is checked directly: every receipt is filed under the run
that produced it, each item's receipts stay inside its own scope, and item A's event
stream never mentions item B's scope.

*Redaction* uses distinctive high-entropy fake keys, so absence means something, and
every absence assertion is paired with proof the snapshot is genuinely POPULATED —
allocation identity, owned scope, provider, model, actions, terminal status. Without
that pairing, deleting the replay snapshot entirely would make the suite greener.

**An honest limitation, found by the mutation test and recorded rather than papered
over.** Two mutations were aimed at redaction and both showed the same thing: the
agent's `apiKey` **never reaches the replay path at all**. Disabling
`sanitizeSnapshotValue`'s key redaction changed nothing, because the snapshot records
`assignedAgentId`, `provider` and `model` — not the agent record. Credentials are kept
out **by construction**, not by an active redaction step on this path. The assertions
are therefore a *regression guard on a leak that does not currently exist*. That is
worth having and worth not overstating, so no mutation was manufactured to make the
guard look load-bearing. The allocation cluster's mutation proof rests on
`owned-path-scope-broadened`, which is genuinely load-bearing.

**Contract 5 migrated — `allocation-lifecycle-isolation-test.js`, 31 assertions,
4 scenarios, registered.** All five contracts now have destinations.

Sibling items are made ASYMMETRIC on purpose — the ScopeA agent reaches into ScopeB and
is refused while the ScopeB agent does legitimate work — because coupling between
allocation items is invisible while everything succeeds and only appears when something
goes wrong. A sibling marked failed because its neighbour failed is a false accusation
against work that actually succeeded.

Proved: the out-of-scope item fails while its sibling COMPLETES with its file on disk,
its single receipt, a replay recording its own success, no failure reason, and no trace
of the neighbour's refused work; owned scope and plan/item identity survive the failure;
a rerun produces exactly one fresh run per agent under ONE new plan distinct from the
original, each keeping its agent's owned scope and allocation identity, with no run left
active and no runaway duplication of committed mutations.

**Two honest limitations, recorded rather than smoothed over.**

1. *Stop is tested against an already-terminal run.* By the time the rerun settles both
   runs are terminal, so the stop is REFUSED rather than executed. That refusal is
   itself a real contract — a finished run cannot be stopped — and the assertions prove
   a *rejected* lifecycle call touches neither the sibling nor its own target. They do
   **not** prove isolation of an in-flight stop. Forcing that needs a long-running run
   the deterministic stub cannot currently produce.

2. *No mutation is registered for this suite.* The intended mutation — stripping owned
   paths from the rerun draft — could not be aimed: `ownedOutputPaths:
   getRunOwnedOutputPaths(run),` occurs **nine** times in `server.js`, so the anchor is
   not unique, and no mutation was manufactured against a different contract to fill the
   slot. The allocation cluster's mutation proof rests on `owned-path-scope-broadened`.
   Aiming a lifecycle-specific mutation with a unique anchor is outstanding work.

### `allocated-regression-test.js` — RETIRED

All five recorded contracts have named destinations:

| Contract | Destination |
|----------|-------------|
| scope admission | `allocation-scope-authority-test.js` |
| owned-path enforcement | `allocation-scope-authority-test.js` |
| allocation attribution | `allocation-attribution-redaction-test.js` |
| replay fidelity and secret redaction | `allocation-attribution-redaction-test.js` |
| retry / rerun / stop lifecycle isolation | `allocation-lifecycle-isolation-test.js` |

Assertions not carried across were JSON-era mechanics — `operation-history.json` and
`runs.json` reads, `replaySnapshotPath` file hydration, `events.jsonl` string matching —
whose surviving properties are asserted through the store in the three replacements. The
historical file is deleted; 112 assertions became 112 across three focused suites with
positive controls the original lacked.

### `rbac-and-inline-data-security-test.js` — RETIRED (2026-07-26)

Both halves now have destinations, so the file is deleted:

| Half | Destination |
|------|-------------|
| privilege escalation | `permission-escalation-boundary-test.js` |
| inline data security | `inline-data-injection-test.js` |

**`inline-data-injection-test.js` — 23 assertions, 3 surfaces, registered.** The
boundaries were taken from the historical assertions rather than guessed:
`/process-templates`, the ticket-creation page's allocated-agent selector, and — added
here — the `/api/configured-agents` JSON surface, because escaping the HTML page would
not help if the API handed the same record to a client with its credential attached.
A20's instruction not to treat absence from one path as application-wide coverage is
what made that third boundary necessary.

The hostile payload closes a script block and injects markup, and includes quotes,
backslashes and an HTML entity so escaping is exercised on each. The credential is
distinctive so absence means something.

**The positive control is load-bearing.** "The raw payload is absent" is satisfied by a
page that renders no agents at all — a broken query, an empty list, a 500. The suite
requires the payload to be present in **script-context escaped** form
(`\u003c/script\u003e`) and a benign agent to render normally, which together prove the
data reached the page and was made safe rather than dropped.

**One assertion was deliberately NOT made, and the reason is recorded inline.** An early
version asserted the absence of the payload's `onerror=` text. That is wrong: once
`</script>` is escaped, the remainder is an inert JS string literal, and demanding its
absence would assert that the data had been DROPPED rather than escaped. The
vulnerability signature is raw block termination followed by markup, plus the payload
never landing as a real element.

**Mutations, both killed at the exact boundary each guards:**

| Mutation | Contract removed | Caught by |
|----------|------------------|-----------|
| `inline-script-escaping-removed` | `<` is escaped in inline script serialization | the hostile name lands as a real `<img>` element |
| `agents-api-leaks-provider-key` | the agents API returns the public projection | the API serializes provider keys |

Both leave the page rendering and every unrelated assertion green, which is why the
injection-specific checks are the ones that catch them.

**Not done in this tranche:** the allocation split above and the inline-data-security half of
`rbac-and-inline-data-security-test.js`, which remains explicitly open as an injection
contract: script-context escaping, provider-secret leakage, unsafe DOM sinks, inline
serialized-data safety.

### `concurrency-conflict-test.js` is load-sensitive (observed 2026-07-26)

Recorded because a flaky suite inside the gate erodes trust in the gate.

A clean-worktree checkpoint failed on it with a cascade — `bothOk=null`,
`statuses=[null,null]`, then seven consecutive `NOT_PROVEN` "run did not reach
terminal". Re-run in isolation on the same commit and database it passes with **16
scenarios, 0 hard failures, 0 not-proven**, and a second full checkpoint passed 77/77.
So the failure was contention, not a regression: the suite creates many concurrent runs
and stalls when the machine is already busy.

This is not harmless. The suite's `NOT_PROVEN`-is-fatal rule — added deliberately when
it was migrated — means load now surfaces as a hard checkpoint failure rather than a
silent pass, which is the right trade, but it makes the gate non-deterministic under
load.

### Investigation (2026-07-26) — cause NOT found; teardown hardened anyway

Candidates were tested rather than assumed, and most are **ruled out**:

| Candidate | Result |
|-----------|--------|
| PostgreSQL connection exhaustion | **Ruled out** — peak 9 of 100 connections |
| CPU contention | **Ruled out** — the suite passes with six CPU-saturating processes running alongside it |
| Stray server processes surviving a suite | **Not observed** at rest |
| Contention with other integration suites | Untested — the checkpoint runs suites serially via `spawnSync`, so overlap would require a leaked process |
| Test-internal concurrency exceeding its contract | Plausible but unconfirmed; the suite creates ~21 tickets against a default `MAX_ACTIVE_RUNS` of 32 |

**The incident did not reproduce**: not in isolation, not under artificial CPU load, not
on a repeat checkpoint. It is therefore recorded as **unexplained**, not as fixed. No
speculative cure was applied to the suite: `NOT_PROVEN` remains fatal, no retry was
added, no timeout was multiplied, and the suite stays in the checkpoint.

**One genuine latent defect was found and fixed on its own merits.**
`scripts/postgres-test-harness.js` `stop()` sent SIGKILL and returned **immediately**
without waiting for the child to exit, so `withHarness` could drop the schema — and the
checkpoint start the next suite — while a killed server was still unwinding its
connections and transactions. Across a ~50-suite checkpoint that is an unbounded number
of overlapping shutdowns. It now uses `stopChild` from
`scripts/child-process-settlement.js`, which escalates and **awaits actual exit**.

That is the same "signalled is not exited" distinction the settlement helper was written
for in the silent-orphan tranche, and it should have been applied to the harness then.
**It is not claimed as the cause.**

### Recurrence, and step two of the escalation (2026-07-26)

It recurred on a later checkpoint, so the recorded next step was taken: **bound the
suite's own concurrency**.

The suite's largest burst is scenario 1, which creates ten tickets at once and never
waits for their runs. Those are noop plans, but leaving them in flight meant every later
scenario competed with them for run admission — the suite carried its own peak load
forward through all sixteen scenarios. It now DRAINS that burst before continuing.

This costs no coverage. The contract scenario 1 asserts is that concurrent CREATION
loses and duplicates nothing, which the assertions have already proved by the time the
drain runs. What is removed is only the residual in-flight work, not any concurrency the
suite intends to exercise.

Checkpoint passed 81/81 after the change. **This is step two of the escalation, not a
confirmed cure** — the incident was never reproduced on demand, so a passing run is
consistent with the fix and also with the flake simply not firing. If it recurs again,
the escalation is exhausted and the next step is the recorded one: treat a runtime that
cannot drain under reasonable bounded load as a **production progress/liveness defect**,
not a harness problem.

### Terminal-state cluster — RETIRED `state-agreement-completion-test.js` (2026-07-26)

**The file is deleted.** It combined two related but distinct terminal-state contracts,
and both now have registered PostgreSQL-native destinations:

| Half | Contract | Destination |
|------|----------|-------------|
| completion admission | what an operator may manually mark completed | `completion-admission-test.js` — 25 assertions, 7 scenarios, registered |
| startup state convergence | a ticket whose run already terminalized converges to the matching status on restart | `startup-state-convergence-test.js` — 35 assertions, 10 scenarios, registered |
| immutable verification snapshot | reconciliation verifies from the run's captured contract (`contractSource: 'run_snapshot'`), never the live catalog | inherited by the named orphan `verification-contract-reconciliation-test.js`, which already asserts exactly this at its restart-recovery step — see the note below |

**`completion-admission-test.js`.** "Completed" is the strongest claim the system makes
about work and an operator can assert it directly, so this gate is the only thing
between a wish and a durable record. Refusals are proved for: no run at all, a failed
latest run, an interrupted latest run, unresolved triage, and declared-but-unverified
verification. Each refusal must EXPLAIN itself — an unexplained 409 tells an operator
nothing about what to fix — and each is checked for EFFECT: the ticket must be
unchanged, not merely un-completed. **The positive control is the whole test**: a ticket
whose run genuinely completed IS accepted and DOES persist, and a seventh check
re-attempts one refusal afterwards to rule out order-dependent behaviour.

**The verification refusal is RESOLVED — the assertion was real, the fixture was wrong,
twice.** It was previously recorded here as unreproducible. Reading
`isRunVerificationRequired` settled it: verification is required only when *all* of
  * ~~the run's policy snapshot says `when_declared`~~ — **this was wrong, see the
    verification-contract cluster below**: `normalizeExecutionPolicy` pins
    `requireVerification`, so that check can never fail and the policy value is
    irrelevant. The first fixture was accepted for the same reason as the second;
  * the run is a **workflow** run with a `workflowId`; and
  * `normalizeVerificationContractSnapshot` returns non-null, which requires the
    snapshot to carry its **own** `workflowId` — the second fixture omitted it, so the
    contract normalized to null and verification silently was not required.

The earlier conclusion ("the gate keys off recorded evaluation state") was wrong, and
the honest lesson is narrower than it looked: two plausible fixture shapes both produced
a 200 for two *different* reasons, and neither was visible without reading the predicate.
Guessing a third time would have been worse than the recorded gap.

*(A second fixture lesson: the gate reads the RUN's policy snapshot, not the ticket's
live policy — correctly, since editing a policy after the fact must not retroactively
change what a finished run proved.)*

*(The `'always'` note previously recorded here was wrong and is superseded by the
verification-contract cluster below: `'always'` is not a weaker mode, it is not a mode
at all.)*

**`startup-state-convergence-test.js`.** `run.terminalized` and the ticket's
finalization are separate durable steps; a process that dies between them leaves a
finished run and a ticket still claiming `in_progress` — a lie about live work that no
scheduler revisits. Covered: completed → completed, failed → failed (**never**
completed), interrupted → open; incomplete terminal evidence is completed and recorded
before convergence; no new runs; exactly one `run.terminalized` per run; ticket, run,
replay and timeline agree; a second restart changes nothing.

**Two reconcilers, not one — found by a failing negative control.** The suite was
written assuming `reconcileUnfinalizedTicketsOnStartup` was the only healer, so a
completed run *without* `run.terminalized` was seeded as a negative control that must
not converge. It converged. `interruptStaleRunsOnStartup` runs first and handles runs
whose **evidence** is incomplete (`readRunsNeedingTerminalReconciliation` →
`reconcileTerminalRun`); the second handles runs whose evidence is complete but whose
**ticket** is stuck. The scenario was re-aimed to the contract that actually matters
there: convergence is allowed, but startup must durably record the terminalization it
acted on rather than finalize a ticket on evidence that still does not exist. This is
the sixth time in A20 that a surprising result was defense-in-depth rather than a
coverage hole; the rule holds — **identify which layer executes before judging a suite.**

**Both directions are controlled.** Scenarios 1–4 demand real transitions, so a startup
that changes nothing fails. Scenarios 5–6 seed `in_progress` tickets that must NOT move
— one with a still-pending sibling run, one with no runs at all — so a startup that
converges everything also fails.

**The in-flight control had to be built deliberately to be load-bearing.** Its first
form put the pending run *newest*, and the mutation below survived: with a pending
latest run the healer stops at its terminal-status branch and the in-flight guard is
never reached. Reordering so the *completed* run is latest puts the guard on the only
path. The pending sibling is also created holding an unexpired lease, so the scheduler's
first tick cannot claim it and the scenario observes the healer rather than racing it.

**Mutations — all killed.**

| Mutation | Removes | Result |
|----------|---------|--------|
| `startup-converges-failed-run-to-completed` | convergence finalizes to the run's ACTUAL terminal status | killed — a failed run's ticket no longer reaches `failed` |
| `startup-finalizes-ticket-with-live-run` | the pending/running guard | killed after the fixture was re-aimed |
| `completion-ignores-unresolved-triage` | the triage gate | killed |
| `completion-ignores-required-verification` | the declared-verification gate | killed |

**On the inherited assertion.** `verification-contract-reconciliation-test.js` asserts
`contractSource === 'run_snapshot'` at its restart-recovery step — the same contract the
retired suite checked for run 103, and more thoroughly. It is itself an A20 orphan, so
this is a **named successor that is not yet registered**, not proven coverage. Retiring
the historical file does not lose the contract, but it does not currently run either;
it is tracked in the orphan list below and must be repaired before A20 closes.

### Verification-contract cluster — RETIRED `verification-contract-reconciliation-test.js` (2026-07-26)

**Replaced by `verification-contract-authority-test.js` — 27 assertions, 6 scenarios,
registered.** The historical suite asserted the right contract against a runtime that no
longer exists: it copied `data/*.json` into a temp directory and read `runs.json` back.

**The contract.** When a run finishes, whose definition of "verified" applies — the
workflow as it exists now, or as it existed when the run started? It must be the latter.
A workflow is mutable operator configuration; a run is a durable claim about work that
already happened. If verification read live state, editing a workflow would retroactively
change what past runs proved, in **both** directions.

**The mechanism, carried over from the historical suite because it is the right one.**
Each scenario crashes at `before_run.snapshot_finalized` — after execution, before
terminalization — mutates the workflow while the process is down, then restarts. The
snapshot and the live catalog now disagree on purpose, so which one recovery used is
directly observable:

| Scenario | Live workflow becomes | Run must be | Reading live state would give |
|----------|----------------------|-------------|-------------------------------|
| relaxed | postconditions removed | **failed** (it violated the original) | passed — a laundered failure |
| stricter | a requirement the run never had | **completed** (it met the original) | failed — a retroactive conviction |

Neither a blanket pass nor a blanket fail satisfies both, which is what makes the pair a
control structure rather than two similar assertions.

#### `requireVerification` — SETTLED: not a defect, and not a switch

The open question from the previous tranche is closed by reading
`normalizeExecutionPolicy`, which **hardcodes** `requireVerification: 'when_declared'`
and never reads the caller's value.

* **Is `always` intended to require verification?** No. `'always'` is not a supported
  value and never was. Nothing in the repository outside test fixtures ever sets any
  other value; no UI field, API parameter, or document offers one. The value in my own
  earlier fixture was invented by the fixture.
* **Why does `when_declared` with a valid contract require verification while `always`
  does not?** It doesn't — that framing was wrong. Both normalize to the same constant.
  What actually governs is `isRunVerificationRequired`'s remaining conditions: a
  **workflow** run, with a `workflowId`, whose captured contract survives
  `normalizeVerificationContractSnapshot` (which requires the snapshot to carry its own
  `workflowId`) and declares at least one postcondition. Verification is required by
  **durable per-run evidence**, never by a policy string.
* **Classification: intended semantics, with a real but narrow naming/configuration
  trap.** The behavior is correct — letting a policy field force verification on or off
  would let mutable configuration override durable evidence, which is exactly what the
  reconciliation half of this suite exists to prevent. The trap is that the field *looks*
  configurable and is silently discarded.

**The correction that follows.** The previous tranche recorded that `'always'` returns
false from the policy check — wrong. The check `requireVerification !== 'when_declared'`
is **provably dead**, because its input is pinned. Both of my earlier fixtures failed for
the same single reason: no valid captured contract. That is now corrected above.

**Production change (isolated, behavior-preserving except at one boundary).**
`SUPPORTED_REQUIRE_VERIFICATION` names the constant, `normalizeExecutionPolicy`
documents that it pins rather than derives, and `assertSupportedRequireVerification`
**refuses** any other value at the two surfaces that store a raw, unnormalized policy —
process-template create and draft. Those are the only places an author can express a
verification preference, and until now they would be silently downgraded to something
weaker than they asked for and never told. Everywhere else is untouched, so reading
historical snapshots cannot break.

**What the suite now makes the repository answer.**

| Question | Answer, pinned by |
|----------|-------------------|
| when is verification required | scenarios 3-5: a captured contract with ≥1 postcondition, nothing else |
| which durable snapshot governs | `run.verificationContractSnapshot`, asserted captured **before** the crash |
| snapshot or mutable current state | scenarios 1-2, in both directions |
| absent / empty / identity-less snapshot | scenarios 4-5: all three mean *not required* |
| manual completion while unresolved | scenario 3: refused, with verification named |
| startup convergence while unresolved | scenarios 1-2: reconciled to the snapshot's verdict, not deferred |
| what records the outcome | `run.postconditions_checked` carrying `contractSource: 'run_snapshot'`, plus `run.verification_passed` / `run.verification_failed`, and the replay snapshot |

**Controls.** Scenario 3 is the positive control for the gate — without it, 4 and 5
would be satisfied by a runtime that never requires verification at all. Scenario 6
pairs its refusal with two acceptances (the supported value, and omission), so a guard
that broke the endpoint outright would fail.

**Mutations — both killed.**

| Mutation | Removes | Result |
|----------|---------|--------|
| `verification-honours-relaxed-live-contract` | verifying from the captured postconditions | killed — the relaxed scenario reconciles as passing |
| `template-policy-silently-downgraded` | the raw-policy boundary guard | killed — the unsupported value is accepted |

*(Note the first mutation is aimed at the semantics, not the field: it leaves
`contractSource: 'run_snapshot'` in place and still lies. A suite that only checked the
label would not have caught it.)*

### Event-journal record limits — RETIRED `event-journal-record-rejection-test.js` (2026-07-26)

**Replaced by `event-record-limit-containment-test.js` — 29 assertions, 5 scenarios,
registered.** The historical names are all gone (`EVENT_JOURNAL_MAX_RECORD_BYTES`,
`EVENT_RECORD_TOO_LARGE`, `event.record_rejected`, `oversizedRejections`) but the
contract survived under PostgreSQL names, so this is a replacement. A name search alone
would have retired a live contract.

**The load-bearing distinction.** Two failures look alike and demand opposite responses:

| | Cause | Correct response | Wrong response would mean |
|-|-------|------------------|---------------------------|
| Request-scoped rejection | caller sent an unstorable record | fail the request, keep running | any client can degrade the deployment |
| Internal evidence-persistence failure | system cannot record what it is doing | latch, stop schedulers, refuse work | the runtime mutates the world unable to record it |

Scenarios 4 and 5 are the **same server surface with opposite containment**, which is
what makes either meaningful: a runtime that never latches passes 4 and fails 5; one
that latches on anything passes 5 and fails 4. Scenario 5 injects the failure narrowly —
a trigger on one standalone evidence append, the path that runs through the server's own
`appendEvent` wrapper where the latch lives — so it proves containment rather than
merely breaking the database. Observed: `/health` → 503 `degraded`, later work refused
503, and the refused work verified absent rather than silently performed.

#### Configuration-seam decision — recorded, NOT hidden in the migration

`maxJsonRecordBytes` (2 MiB) is a `PostgresRuntimeStore` option `server.js` does not
expose. The previous tranche recommended adding an env option. **That recommendation is
withdrawn: no production configuration surface was added.** The real default is
exercisable directly through the store, so the convenience knob was never needed, and
adding a production surface only to make a test convenient is the wrong trade.

**But the investigation found something the knob would have hidden.** Fastify's default
body limit is **1 MiB — below** the store's 2 MiB. So:

* an oversized request body is refused as `FST_ERR_CTP_BODY_TOO_LARGE`, **not**
  `POSTGRES_RECORD_TOO_LARGE`; the two 413s come from different layers;
* `appendEvent`'s `POSTGRES_RECORD_TOO_LARGE` → 413 mapping is **unreachable from any
  request-body path**. It is live only for records the server accumulates server-side
  (evaluation, consequence, replay documents);
* the historical suite set the record limit to 1024 bytes so the store rule fired first.
  Today's ordering inverts that, which is why the contract could not be migrated as
  written.

The suite asserts the HTTP boundary for what it actually is rather than pretending it
reaches the store rule, and covers the store rule directly where it is truthfully
observable. **Consequence for coverage, stated plainly:** a mutation collapsing
`appendEvent`'s request-scoped branch into the latching branch SURVIVES this suite,
because no reachable HTTP path delivers an oversized record to that wrapper. It was
removed rather than left in the registry as a false claim. Closing it honestly requires
driving a server-accumulated >2 MiB evidence document — worth doing, not done here.

**Mutations — two killed, both on active layers.**

| Mutation | Removes | Result |
|----------|---------|--------|
| `oversized-record-partially-persisted` | the size check's rejection | killed — the oversized record is stored |
| `evidence-failure-treated-as-client-error` | the latch on a genuine failure | killed — the process reports itself merely `starting`, never `degraded` |

#### OPEN DEFECT — rejected records leave no durable evidence

`docs/RUN_EVIDENCE_AUTHORITY_SOURCE_OF_TRUTH.md` promised that an individual oversized
event is "represented by compact `event.record_rejected` evidence". **PostgreSQL
implements no such thing.** A rejected record rolls back completely and leaves no trace;
the `oversizedRejections` metric on `/api/runtime/status` no longer exists either.

Scenario 3 proves the rollback is clean — no partial write, no consumed chain position —
which is correct as far as it goes. What is missing is the *positive* half: an operator
cannot discover that a record was ever refused. Evidence of refusal is exactly the kind
of thing this repository treats as load-bearing everywhere else (`authority.denied`,
`action.rejected`, `run.verification_failed` all exist precisely so a refusal is
visible).

**Not silently rewritten as though it never existed**, per the governance rule: the
promise is recorded here and the document now points at this entry. Deciding whether to
reinstate the evidence or formally withdraw the promise is a separate decision — it is
an evidence-completeness question, not a test-migration question.

#### Documentation truthfulness — `RUN_EVIDENCE_AUTHORITY_SOURCE_OF_TRUTH.md` reconciled

The document described the JSON journal as current throughout, including the flatly
false "PostgreSQL ... is not yet the active server backend". Reconciled: the authority
table now names PostgreSQL relations instead of `data/*.json` paths; the durable
acknowledgement boundary is transaction commit rather than `FileHandle.sync()`; the two
failure classes above are stated explicitly with their codes and status codes; the limit
ordering is documented; and the storage-boundary section no longer describes a local
append-only file as the shared-storage limitation. The one promise PostgreSQL does not
implement is flagged in place and linked to the open defect above rather than deleted.

*(Worth noting how close this came to a wrong disposition: the cluster was queued as a
retirement on a name search, and the document that would have "confirmed" the mechanism
was gone was itself stale. Two independent stale sources agreeing is not corroboration.)*

### RESOLVED — runtime progress/liveness: admitted runs fail to reach terminal (2026-07-27)

**Status: OPEN and UNRESOLVED. No cause is claimed.** It has not reproduced since, but
nothing was changed that is known to address it, so this stays open.

**The incident.** During clean-worktree validation of `8638c51`,
`concurrency-conflict-test.js` failed with **10 hard failures and 7 not-proven across 16
scenarios** — escalation step 3, after the bounded-burst drain in `25fd221` (never
claimed as a cure, and definitively not one).

```
✗ double rerun: FAIL — newRuns=2 stillRunning=0 r1=200 r2=200
✗ stop vs rerun: NOT_PROVEN — base run did not reach terminal
✗ allocated/dynamic non-overlap: FAIL — bothOk=null filesOk=false noFalseConflict=true
✗ same-agent same-file conflict blocked: FAIL — statuses=[null,null] attributed=false cleanWrites=0
✗ same-agent failure isolation: NOT_PROVEN — owner setup run did not complete (null)
✗ permitted cross-ticket delete: NOT_PROVEN — owner run did not complete (null)
✗ non-cross-ticket delete allowed without permission: NOT_PROVEN — run did not reach terminal
```

The signature is **progress, not correctness**: runs do not reach a terminal status at
all (`statuses=[null,null]`, `did not complete (null)`). The suite is not observing wrong
conflict decisions; it is observing no decision, because the work never finishes.

**CORRECTION (2026-07-26, later the same day): the mechanism IS the evidence-persistence
latch.** The first occurrence was recorded here as "no deadlock, degraded-health or 503
signature explained it". That rule-out was **absence of evidence, not evidence of
absence** — the suite printed no health state at all, so a latch could never have shown
up in its output. The very first run with the new diagnostics armed caught it:

```
scheduler:  {"running":false,"intervalMs":200}
health:     {"status":"degraded","ready":false}
counts:     {"active":1,"pending":1,"running":0,"expiredLeases":0}
run 23: status=pending phase=planning revision=1 ticket=21 lease=none heartbeat=n/a
        ticketStatus=in_progress lastEvents=run.created
```

`evidencePersistenceFailure` is latched, **both schedulers are stopped**, and the run
therefore sits `pending` and unclaimed forever with no lease. Every downstream
`NOT_PROVEN — did not reach terminal` follows from that single fact. The scenarios were
never racing; they were waiting on a scheduler that had been shut down.

This retroactively explains the whole incident class, including the original occurrence:
the symptom "admitted runs never reach terminal" is what a latched deployment looks like
from the outside.

**What is still unknown: WHAT latches it.** The 40P01 deadlock fixed in `85f0802` was one
route into the latch, and it is closed — this recurrence proves it was not the only one.
The server's stderr is not captured in the checkpoint log, so the underlying error is not
yet in evidence. The diagnostics now additionally issue one evidence-dependent request
when health is degraded and record the resulting 503 body, which carries
`Event persistence is unavailable: <cause>` — the single missing fact.

**Latch provenance is now armed (`f60d00e`).** `recordEvidencePersistenceLatch` captures
the FIRST failure only — timestamp, channel, operation, event type, run and ticket id,
PostgreSQL code, routine, constraint, a bounded sanitized message, and a classification
of transient (serialization / deadlock / lock_not_available / statement timeout /
connection / too-many-connections) versus permanent (integrity / data exception /
syntax-access / application validation). Later failures are counted separately rather
than overwriting it. Exposed at `/api/runtime/status` as `eventPersistence` and printed
by the liveness diagnostics. Verified end to end against an injected failure. Codes and
ids only — no payload contents, no secrets.

#### ROOT CAUSE CAPTURED AND FIXED (2026-07-27)

The armed provenance caught it on a clean-worktree checkpoint:

```json
{"latched":true,"firstFailure":{
  "channel":"event_append","operation":"appendEvent",
  "eventType":"scheduler.run_skipped","runId":22,"ticketId":21,
  "code":"40P01","message":"deadlock detected","routine":"DeadLockReport",
  "kind":"deadlock_detected","retryable":true},"subsequentFailures":0}
```

**A routine deadlock was taking the whole deployment down.** `40P01` aborts one
transaction and PostgreSQL expects the loser to retry. Nothing retried it, so it reached
the server's `appendEvent`, which cannot classify it as request-scoped and therefore
latched `evidencePersistenceFailure`, stopped both schedulers, and left every pending run
unleased until restart. One transient conflict, one dead deployment.

Note this is a **different** deadlock from the chain-tip inversion fixed in `85f0802` —
that fix was correct and remains, but it was never the whole story. The general defect was
never the specific lock pair; it was that a retryable condition was treated as permanent.

**The fix: bounded retry where the transaction is provably replayable.**
`PostgresRuntimeStore.appendEvent` retries `40001`, `40P01` and `55P03` with exponential
backoff and jitter — **only when it owns the transaction**. A caller-supplied `client`
means the caller owns it and its earlier statements are not ours to replay, so that path
is never retried. Because these codes abort the entire transaction, nothing committed and
a replay appends the event exactly once.

Deliberately **not** retried: statement timeout (`57014`) and connection failures, which
signal genuine overload or loss rather than a resolvable conflict — retrying those
compounds the problem. On exhaustion the original error is rethrown, so a persistent
inability to record evidence still fails closed exactly as before.

**Validation.** `event-append-lock-order-test.js` scenario 5 forces a real deadlock with
`store.appendEvent` as a participant and requires it to succeed; scenario 1 independently
proves that interleaving genuinely deadlocks at the SQL level, so a pass is a retry and
not an absent conflict. Mutation `transient-conflict-not-retried` removes the retry and is
killed with the captured error verbatim — `(40P01: deadlock detected)`. Fail-closed
behaviour is unchanged: `evidence-failure-treated-as-client-error` still kills against
`event-record-limit-containment-test.js`.

**The fix broke a mutation, and that mattered.** Adding the retry made
`event-append-restores-lock-inversion` SURVIVE: the retry absorbed the very deadlock the
lock-order guard prevents, so removing the guard failed nothing — the append still
succeeded. Genuine defense-in-depth, but it left the ordering contract unobservable.

`PostgresRuntimeStore.transientConflictRetries` now counts absorbed retries, which
separates the two contracts:

| Layer | Contract | Assertion |
|-------|----------|-----------|
| lock ordering | conflicts must not ARISE | scenario 2 requires **zero** absorbed conflicts from the correctly ordered interleaving |
| transient retry | conflicts that arise must be ABSORBED | scenario 5 requires the count to **rise**, proving its success is recovery and not an absent conflict |

Both mutations kill again. The generalizable point: **when a recovery layer is added
above a prevention layer, the prevention layer stops being observable through outcomes
alone.** Something has to count the recoveries, or the older guard silently becomes
untested while still appearing green.

**The instrumentation is what solved this.** Three hypotheses preceded it and all three
were wrong — including one previously recorded here as ruled out. The incident only moved
once the repository could state which operation failed and how PostgreSQL classified it.

#### Hunt log (superseded by the capture above)

**Hunt status (2026-07-27): the cause had NOT yet been captured at this point.** The latch did not recur
across the checkpoints run after the instrumentation landed. Two other intermittent
failures surfaced during the hunt and were separated out rather than confused with it:

| Observed | Disposition |
|----------|-------------|
| `timeline-authority-evidence-test.js` — determinism assertion | **My fixture defect**, fixed in `f60d00e`. It demanded identical entry lists across repeated reads while terminal evidence was still landing, so legitimate projection GROWTH read as nondeterminism. Now asserts the real contract: already-reported entries are never rewritten or dropped. |
| `delegated-run-logging-containment-test.js` — "the run:completed echo insert was attempted and rejected" | **New, unexplained, load-dependent.** Passes 3/3 standalone. Recorded here so it is not mistaken for the latch; it has its own signature and no evidence links it. |
| `mutation-admission-contract-test.js` | Not a flake — it correctly caught the provenance refactor moving the inline `evidencePersistenceFailure = error` assignment it pins in source. Restructured so the assignment stays at the call site. |

**Known candidate, explicitly NOT acted on.** The pool sets `statement_timeout` to 30s and
there is no global `lock_timeout`. Since `85f0802` converted the chain-tip deadlock into a
lock WAIT, a sufficiently contended append could now exceed the statement timeout and
raise `57014` — a transient condition that `appendEvent` would latch on, because its
non-latching branch covers only `POSTGRES_RECORD_TOO_LARGE`/`TypeError`/`RangeError`.
That is a plausible route into the latch and the classification table above would mark it
`retryable: true`. **It remains a hypothesis.** The previous two hypotheses in this
incident were both wrong, so nothing is being changed until provenance names the code.

**Do not treat this as fixed, and do not widen `appendEvent`'s non-latching branch.** The
latch is behaving exactly as designed; something is legitimately failing to persist
evidence, and the correct fix is at whatever is failing, not at the containment that
reports it.

**Validation evidence since the port and deadlock fixes** (recorded as evidence, *not* as
a cure — see below):

| Round | Result | `concurrency-conflict` |
|-------|--------|------------------------|
| in-tree checkpoint (port fix) | 84/84 PASSED | 0 hard failures |
| in-tree checkpoint (deadlock fix) | 85/85 PASSED | 0 hard failures |
| clean worktree × 4 | 85/85 PASSED each | 0 hard failures each |

**Why the quiet period meant nothing.** Six consecutive green runs did not establish a
cause, and the failure recurred on the very next checkpoint after they were recorded —
vindicating the decision not to claim a cure. Treating a quiet period as a fix would have
been the `25fd221` mistake a second time.

**What changed instead: the next occurrence will be diagnosable.** The suite reported
that a run "did not reach terminal" while saying nothing about what the run was doing —
that gap is what made one occurrence undiagnosable. It now captures, on the **first** hard
failure only (later scenarios inherit the same broken state):

* scheduler ownership, running flag and cadence; deployment and local-process concurrency
  limits; admitted/starting run counts (including local-model slots);
* pending / running / expired-lease counts and the expired-lease run ids;
* `/health`, so a latched evidence failure is distinguished immediately;
* for every non-terminal run: status, phase, revision, ticket id, lease owner, lease
  expiry, last heartbeat, owning ticket status, and its last six event types — enough to
  tell queued from leased from executing from blocked-on-evidence from abandoned.

Verified by forcing a hard failure and confirming the block emits, then reverting. **This
is diagnostics only** — it never changes a verdict, never retries, and never extends a
timeout.

**Still forbidden:** retries, softening `NOT_PROVEN`, broad timeout increases, or moving
the suite out of the checkpoint. Four tranches have now been tempted by each.

### RESOLVED — a PostgreSQL deadlock degraded the whole process (2026-07-26)

Found during clean-worktree validation of `8638c51`, and it matters precisely because of
what that same tranche just documented.

**Observed.** `run-diagnostics-bundle-test.js` failed with `error: deadlock detected`,
thrown from `PostgresRuntimeStore._appendEvent` inside `withTransaction`, while the
suite's own server was running against the same schema. Not reproducible standalone (3
clean runs); it needs the checkpoint's concurrency, like the
`concurrency-conflict-test.js` flake. **Unlike that one, the mechanism is identified.**

**Mechanism.** `_appendEvent` takes `run_event_chain_tips` (`INSERT ... ON CONFLICT DO
NOTHING`, then `SELECT ... FOR UPDATE`) inside a transaction that has usually already
locked the `runs` row via `transitionRun`. Two concurrent evidence-writing transactions
acquiring the run row and the chain tip in opposite orders deadlock. PostgreSQL resolves
this the normal way: it aborts one side with SQLSTATE `40P01`.

**Why this is a defect and not just a flake.** A deadlock is a *routine, retryable*
condition in PostgreSQL — the aborted transaction is expected to be retried. This
runtime does not retry it, and worse, `40P01` is a generic `Error`: it is neither
`POSTGRES_RECORD_TOO_LARGE` nor a `TypeError`/`RangeError`, so in server-level
`appendEvent` it falls through to the **latching** branch. Per the containment contract
just pinned by `event-record-limit-containment-test.js`, that means it sets
`evidencePersistenceFailure`, clears readiness, stops both schedulers, and refuses all
further evidence-dependent work with 503.

So a transient, self-resolving database condition takes the deployment into
fail-closed degraded state requiring a restart. The fail-closed behaviour is correct for
a genuine inability to persist evidence; a deadlock is not that.

**Not fixed here.** The fix is a real production change with design choices —
bounded retry on `40P01` at the store transaction boundary, and/or a consistent lock
order between `runs` and `run_event_chain_tips` — and it needs its own validation under
load. Recording it beats a hasty fix at the end of a session.

**Do not classify deadlock as request-scoped to make this go away.** Widening
`appendEvent`'s non-latching branch to swallow generic errors would break the exact
distinction the tranche above exists to protect. The retry belongs at the transaction
boundary, below the latch.

**Tranche 8 clean-commit addendum (2026-07-29).** The independent GA checkpoint exposed
two more concrete lock-order cycles in the operator process-cancellation public seam:
`appendRunEvidence` took `replay_snapshots` before `_appendEvent` acquired its run-row
foreign-key lock, while terminalization takes `runs` before replay; separately,
`transitionTicketAfterRun` took the ticket before its run batch, while process evidence
takes a run before its event insert obtains the ticket foreign-key lock. Both surfaced
as `40P01`, and neither was accepted as a flaky pass. The canonical store now orders
these boundaries as `runs → replay_snapshots → event chain` and `run batch → ticket`.
`event-append-lock-order-test.js` scenarios 6 and 7 close the exact former cycles and
prove the bundled evidence and ticket projection each commit once without retry or
hash-chain damage. `process-supervision-postgres-test.js` then proves the real public
cancellation route converges. No failure was downgraded and no duplicate evidence path
was introduced.

### RESOLVED — surviving mutation `authority-denial-loses-its-rule` (2026-07-26)

Surfaced by the first full 32-mutation run of the session (earlier tranches ran targeted
subsets). **The suite was correct; the mutation was aimed at the wrong evidence channel.**

**The traced path.** `timeline-authority-evidence-test.js` asserts `details.rule` on the
timeline's `authority.denied` entry. That value comes from exactly one place:

```
buildAuthorityEvidence(run, operation, path, 'denied', 'protected_path', …)   server.js 12302
  → recordAuthorityEvidence → durable `authority.denied` event, payload = evidence
    → timeline folding: details.rule = payload.rule || null              server.js 8233
```

The mutation had been stripping `rule: 'protected_path'` from
`createWorkspaceViolationItem` (~6528). That function feeds `run.violation_detected`
(6580) — **a different evidence channel that the authority entry never consults.** So the
mutation changed a real, live layer and the projection was legitimately unaffected. Not
defense-in-depth over one field, and not a fallback inference: two separate channels, one
of which the assertion does not read.

**No inference was found.** The timeline does not reconstruct the rule from prose,
operation type, or path shape — `payload.rule || null` is the whole derivation, so the
evidence-authority contract is intact and nothing needed fixing in production.

**Disposition: re-aimed at the layer responsible for the projection.** The mutation now
nulls the rule at 12302. The denial still occurs and the entry still appears; only the
structured attribution is lost. It is killed **by the attribution assertion itself** —
`1: the entry names the protected-path rule structurally (got null)` — not by a
neighbouring field or a determinism check changing.

**Three properties, now independently falsifiable.** The suite previously carried the
distinction only as a comment, which no run could check:

| Property | Assertion |
|----------|-----------|
| exact structured attribution | `details.rule === 'protected_path'`, identity not substring, plus a type check |
| prose is not attribution | the entry independently carries human-readable text mentioning the refusal, and the rule is asserted to be a discrete token rather than that prose reused |
| deterministic projection | the rule and the full entry list are identical across repeated reads |

The prose assertion is the point: because the summary genuinely contains "protected", a
substring check over the entry would pass with the structured rule stripped. Asserting
both separately keeps that trap visible instead of relying on a comment.

**Mutation baseline is now 32/32 killed** — fully green for the first time this session.

*(Eighth instance of the standing lesson, with a twist worth keeping: the surprise was
not a second source for one field but a second CHANNEL for one concept. "Which layer
executes?" had to become "which layer does the assertion actually read?")*

### Harness defect — RESOLVED: pid-modulo test ports collide (2026-07-26)

Found while validating the event-record-limit tranche. The checkpoint failed once on
`lease-renewal-resume-safety-test.js` with `server did not start`, then passed on a
rerun and passes standalone. **Unlike the `concurrency-conflict-test.js` flake, this one
has an identified mechanism** and should not be filed alongside it.

Eight suites derive a fixed port from their own pid, and the ranges **overlap heavily**:

| Suite | Range |
|-------|-------|
| `page-render-regression-test.js` | 3400–4399 — spans every other range |
| `lease-renewal-resume-safety-test.js` | 3600–3799 |
| `postgres-startup-recovery-test.js` | 3620–3769 |
| `provider-response-recovery-postgres-test.js` | 3660–3779 |
| `model-contract-violation-test.js` | 3680–3799 |
| `model-contract-violation-recovery-test.js` | 3700–3799 |
| `execution-semantics-persistence-test.js` | 3810–3929 |
| `workspace-snapshot-recovery-test.js` | 3940–3989 |

`process.pid % N` is not collision-free, pids of sequentially spawned suites are
adjacent, and a previous suite's server child can still hold its port while the next
suite starts — the failure observed was `provider-response-recovery` immediately
followed by `lease-renewal`, whose ranges overlap. The symptom is misleading: the suite
reports "server did not start" when the server started fine and could not bind.

**FIXED** in `b85cd53`. `scripts/test-port.js` replaces the arithmetic with the
allocator the OS already provides: bind port 0, ask what you got. Two concurrent probes
cannot receive the same port. Callers needing several ports get them from one call so the
probes are open simultaneously and cannot alias — the old `PORT_1 + 1` scheme assumed the
neighbouring port was free. `release-checkpoint-coverage-test.js` now fails if any
checkpoint suite reintroduces pid-modulo or a hard-coded base/listen port, and exercises
the facility itself so the guard cannot point at something broken; verified it catches a
deliberate reintroduction. Validated by running all eight affected suites concurrently
three times (24/24), which is exactly the contention the old scheme lost.

**Do not "fix" this with retries or by widening timeouts** — the same standing rule as
the concurrency escalation. The cause is known; suppressing the symptom would discard a
real diagnosis.

### Admission cluster — RETIRED `event-journal-admission-recovery-test.js` (2026-07-27)

**Replaced by `mutation-admission-backpressure-test.js` — 27 assertions, 6 scenarios,
registered.** The historical suite drove a `.sync-control` file to stall
`FileHandle.sync()` on `events.jsonl`. That mechanism is gone; the contract survived
under PostgreSQL names — `EVENT_ADMISSION_BACKPRESSURED` became
`MUTATION_ADMISSION_BACKPRESSURED`, and the journal metrics became
`mutationAdmission.getMetrics()` (`backend: 'postgres'`).

**The load-bearing distinction, and it mirrors the record-limit cluster on the admission
side rather than the append side.** Two refusals share HTTP 503 and mean opposites:

| Refusal | Code | Retry-After | Meaning |
|---------|------|-------------|---------|
| backpressure | `MUTATION_ADMISSION_BACKPRESSURED` | `1` | healthy, momentarily full; capacity returns by itself |
| latched failure | `EVENT_PERSISTENCE_UNAVAILABLE` | none | cannot record evidence; retrying is futile |

Telling an operator to retry in one second when the deployment needs a restart is the
failure this prevents; the reverse — treating momentary fullness as fatal — would take
down a healthy system under load. The runtime checks the fatal condition **first**, and
scenario 6 pins that precedence explicitly.

**Covered:** refusal happens in the `onRequest` hook, so refused work leaves no state at
all (checked per objective, not in aggregate); admitted work is not lost to the pressure;
capacity recovers automatically with no restart; only routes declaring
`config.mutationAdmission` are gated, so session login and read-only diagnostics survive
pressure — an operator must not lose the ability to log in and inspect a system exactly
when it is loaded; and the latch records provenance naming the operation that caused it.

**Scenario 1 is the positive control.** Every other scenario asserts a refusal, and a
server refusing all mutations would satisfy them all.

**No configuration surface was added.** `MUTATION_ADMISSION_MAX_OUTSTANDING` is already
production-configurable, so capacity 1 makes backpressure reachable natively — the
opposite of the record-size limit, which is not env-configurable and is therefore covered
directly at the store.

*(Fixture lesson: scenario 6 first ran its latch server at capacity 1 too, and the health
probe caught `backpressured` before the latch landed — the exact confusion the scenario
exists to rule out. The latch server now runs at default capacity and the probe waits for
`degraded` specifically rather than "any non-200".)*

**Mutations — both killed.**

| Mutation | Removes | Result |
|----------|---------|--------|
| `backpressure-reported-as-fatal` | the recoverable code on a full queue | killed — transient fullness reported as a persistence failure |
| `backpressure-omits-retry-after` | the retry signal | killed — a recoverable refusal gives the caller nothing to act on |

### Transparency cluster — RETIRED `operational-transparency-test.js` (2026-07-27)

**Replaced by `operational-summary-readonly-test.js` — 38 assertions, 5 scenarios,
registered.** The historical suite seeded `data/*.json` and diffed those files to prove
nothing was written. `/ops` and `/api/ops/summary` are live and unchanged in intent.

**Two properties make the broadest read in the system safe**, and both are covered:

1. **Permission-gated on `ops:read`, on BOTH surfaces.** The negative control is a
   principal holding a *different* permission (`ticket:create`), which is what proves the
   gate keys off `ops:read` specifically rather than "is authenticated" or "has any
   permission". Anonymous access is checked too, and neither refusal leaks the state it
   withheld.
2. **Reading writes nothing.** This is the hard one and the reason the suite exists:
   read-only is not enforced by any type or route flag — it is a property of what
   `buildOperationalSummary` happens to call. A future contributor adding a repository
   call that records an access log, touches a projection, or lazily materializes a cache
   would break it **silently**, because the response would look identical.

The proof is a durable census (tickets, runs, events, logs with ids, statuses, revisions
and sequences) taken across four repeated reads of both surfaces, as a dashboard poll
would. Refused reads are censused separately — a rejected request that logged an access
record would still be a write on an observability path.

**Two controls make the stillness meaningful.** A census that never changes proves
nothing if the census is blind: scenario 4 performs a real mutation and requires both the
census and the summary's own counters to move. Scenario 3 additionally proves the census
is stable with **no reads at all** before attributing any later change to the reads.
Scenario 5 pins that the summary is a projection rather than a new ledger — reading it
emits no events and records no summary artefact.

*(Fixture lesson, and it is the same trap as the startup-convergence suite: the first run
failed the read-only assertion because the seeded PENDING run was executed by the
scheduler's first tick, so ticket and run reached terminal states mid-suite and the census
attributed that background progress to the reads. `RUNTIME_SCHEDULER_INTERVAL_MS` does not
suppress the first tick. The run now holds an unexpired lease so it cannot be claimed.
Reading a "read-only violated" failure at face value would have produced a fabricated
production defect.)*

**Mutation `ops-summary-permission-open`** removes the `ops:read` check. The endpoint
still answers with correct data, so only the principal-without-permission scenario
notices. Killed.

### Evidence-carry cluster — RETIRED `tm2-evidence-preservation-test.js` (2026-07-27)

**Replaced by `carried-evidence-preservation-test.js` — 43 assertions, 8 scenarios,
registered.** A replacement, not a retirement: `previousActionResults` and
`model:no_progress` are live production mechanisms and that orphan was the only file in
the repository referencing either.

**The contract: what a later model turn is told about earlier turns must be TRUE.** A run
is a conversation. If the account of what just happened is missing, stale, or belongs to
another run, the model re-does completed work and loops until a runtime limit kills it,
and replay gives no explanation.

**The provider is driven by prompt state, not a call counter, and that IS the positive
control.** Each response is chosen by inspecting the `previousActionResults` it just
received:

| Prior evidence seen | Response |
|---|---|
| none | listDirectory on a MISSING path **and** on the real one |
| a listing, no warning | listDirectory on the real path again (redundant) |
| a `model:no_progress` warning | writeFile, complete |

A counter-driven stub would advance regardless and pass against a runtime carrying
nothing. Here turn 3 is **unreachable** unless the warning was genuinely delivered, so a
runtime that drops carried evidence cannot finish the run at all — the suite fails hard
rather than passing vacuously. The mutation confirms it: with the carry removed, the run
dies at the no-progress threshold.

**Outcomes are pinned as the runtime actually represents them**, discovered rather than
assumed: an unsuccessful inspection is carried as `result.status: 'not_found'` with empty
entries — **not** an `error` field, which is what the JSON-era suite implied. Turn 1
inspects a missing and a real path in one response, so a single carried set contains an
unsuccessful and a successful outcome differing only in their recorded result. Turn 2
repeats a path, which is what lets the runtime name the repetition in
`repeatedListPaths`.

**Three runtime facts learned by failing, each now recorded in the suite:**

1. **Phase separation is enforced.** A response mixing inspection and mutation is refused
   as `execution.phase_violation` and executes **nothing**. The first fixture emitted
   `createFolder + listDirectory` and looped to its step limit having performed no
   operation — the carried evidence contained only the violation warning.
2. **`previousActionResults` means the PREVIOUS turn, not a transcript.** `actionResults`
   is reset per turn (`server.js` ~19293). Pinned explicitly so a future change to
   cumulative history is a deliberate decision rather than silent drift.
3. **`recordRunEvent` writes to the REPLAY SNAPSHOT and the run log, not the ticket
   journal.** The durable no-progress decision lives in `snapshot.events`.

**Cross-run isolation is scoped correctly.** A concurrent decoy run on another ticket
executes throughout. The leak assertion covers *carried evidence*, not the raw prompt:
both runs share one workspace, so the decoy's file legitimately appears in the subject's
workspace snapshot — that is the filesystem described truthfully. Leakage would be the
decoy's operation records appearing in the subject's `previousActionResults`. The first
version asserted on the raw body and failed for that reason; taking it at face value
would have produced a fabricated isolation defect.

**Mutation `carried-evidence-dropped-from-prompt`** removes the composition that carries
prior results into the next request. The first turn's operations still execute, replay
still records them, and later model calls still occur — only the model's knowledge is
gone. Killed, with the run failing to converge exactly as the contract predicts.

### Correction — timeline determinism assertion was over-strict, twice (2026-07-27)

An assertion I added in `fb93128` failed under checkpoint load a second time, in a second
way. Recorded because the pattern is the point.

* **First over-reach:** it required identical entry LISTS across repeated reads. The
  projection legitimately GROWS as terminal evidence lands, so it failed on growth.
  Narrowed to "already-reported entries are never rewritten".
* **Second over-reach:** that narrowed form still failed, because `addEntry` deliberately
  ENRICHES an existing entry when a higher-priority source arrives for the same dedupe
  key, merging details and keeping the stronger source. Designed behaviour — and the same
  mechanism the receipt tranche relies on.

Now scoped to the authority entry this suite owns: its identity, decision, and structured
`rule` must not drift. Growth and enrichment elsewhere are permitted because they are what
the projection is designed to do. The attribution mutation still kills.

**The lesson:** "deterministic projection" is not "byte-identical output". A projection
that merges evidence from several durable sources is deterministic *given the same
inputs*, and its inputs keep arriving. Two failures were needed to state that precisely,
and both were my assertion being wrong rather than the runtime.

### OPEN — model-contract mutating cap resolves to 8 instead of 2 (2026-07-27)

**The armed diagnostics named it on the first recurrence.** `model-contract-violation-test.js`
failed a third time during clean-worktree validation of `49092e3`, and this time the
suite reported its own inputs:

```
captured OVERSIZED requests: 2
run status: failed error: ... rejected by the per-response action limits (8 total / 8 mutating) ...
violation events: 2 streak: 2
[request 1] feedbackMatches=["... at most 8 total action(s) and at most 8 mutating action(s) ..."]
health: 200 {"status":"ok","ready":true}
```

**It is NOT a missing request** — the hypothesis the previous entry called most likely.
Two requests were captured and the second DOES carry corrective feedback. The feedback is
simply wrong: it states **8 mutating** where the suite expects **2**, and the run's own
failure message agrees (`8 total / 8 mutating`). Health is clean, so no latch or
backpressure is involved.

**What is established:**

* `MAX_AGENT_ACTIONS_PER_RESPONSE` is hard-coded 8; `MAX_MUTATING_ACTIONS_PER_RESPONSE`
  is `env AGENT_MAX_MUTATING_ACTIONS_PER_RESPONSE || 2`.
* That variable is set **nowhere** — not in `.env`, not in the shell, not in the suite's
  child env. So the process constant is 2.
* Yet the enforced and reported mutating cap was 8, equal to the total. The mutating
  ceiling collapsed onto the total.
* `resolveRunActionCaps` prefers what the RUN RECORDED (`run_semantics_snapshot`) over the
  live constants — deliberately, so changing the environment cannot retroactively rewrite
  a historical run's authority. So the run's recorded execution-semantics snapshot
  carried mutating = 8.

**CORRECTION (2026-07-27, later): the durable snapshot is NOT implicated.** Tracing the
message to its source settles it — `createModelResponseContractViolationError`
(`server.js` ~10600) renders the PROCESS CONSTANTS directly:

```js
`(${MAX_AGENT_ACTIONS_PER_RESPONSE} total / ${MAX_MUTATING_ACTIONS_PER_RESPONSE} mutating)`
```

It never consults the run, `runtimeLimitsSnapshot.semantics`, hydration, or
`resolveRunActionCaps`. So "8 mutating" in that message means
`MAX_MUTATING_ACTIONS_PER_RESPONSE` was literally **8 in the server process**, and the
corrective-feedback text agreeing with it is a consequence, not corroboration of a
snapshot fault. My earlier entry inferred a `run_semantics_snapshot` divergence from the
two agreeing; that inference was wrong, and any fix aimed at the snapshot or at
`resolveRunActionCaps` would have been aimed at a layer this evidence does not implicate.

**What that leaves.** The constant is `env AGENT_MAX_MUTATING_ACTIONS_PER_RESPONSE || 2`,
so the server process saw that variable set to `8`. Repository search finds it set in
exactly two places, neither of which can reach this suite:

| Site | Why it cannot be the source |
|------|-----------------------------|
| `agent-regression-test.js:1374` sets `'8'` | orphaned — not in the checkpoint |
| `execution-semantics-persistence-test.js:133` sets a per-case value | runs AFTER this suite in `POSTGRES_INTEGRATION_SCRIPTS` |

Both set it only in a spawned child's `env`, which cannot affect a sibling suite's
process. No `.env` entry, no shell export.

**Not reproduced on demand.** Three rounds of the suite under deliberate concurrent load
from its checkpoint neighbours all passed. All three real failures occurred in a
clean-worktree checkpoint; in-tree checkpoints have not shown it.

**Boundary capture extended** so the next occurrence is decisive rather than inferential.
On failure the suite now additionally reports the env this test process saw, the env it
passed to the server, and the admitted run's RECORDED semantics — which separates the
four candidates (ambient env, env propagation, recorded snapshot, rendering) in one line
each.

**No production change was made, and no regression suite was written.** The requested
regression would pin snapshot-integrity properties that this evidence shows are not
where the defect lives; writing it would create the appearance of a fix without one.
Confirming the real mechanism needs one more captured occurrence — which the extended
capture now makes self-describing.

**Nothing was changed.** Per the standing rule the failure was diagnosed, not weakened —
no retry, no relaxed assertion, no widened timeout. The suite passes standalone and on
checkpoint reruns, so it is not blocking, and its diagnostics now make each occurrence
self-describing.

*(This is the second time armed first-failure capture converted an "intermittent,
unexplainable" suite into a specific claim about production state — and the second time
the leading hypothesis beforehand was wrong.)*

### OPEN — load-dependent suite failures under checkpoint (2026-07-27)

### OPEN — load-dependent suite failures under checkpoint (2026-07-27)

Two suites have now each failed **once** under checkpoint load and passed repeatedly
standalone. Recorded together because they share a shape, and kept separate from the
resolved liveness defect because **neither shows a latch signature** — no `degraded`
health, no `Evidence persistence latched` line, no `EVENT_PERSISTENCE_UNAVAILABLE`.

| Suite | Symptom | Standalone |
|-------|---------|-----------|
| `delegated-run-logging-containment-test.js` | "the run:completed echo insert was attempted and rejected" | 3/3 pass |
| `model-contract-violation-test.js` | "corrective feedback must state both the total (8) and mutating (2) limits" | 3/3 pass; **RECURRED 2026-07-27** |

**What they have in common:** both drive real agent runs against a model stub and assert
on the CONTENT of runtime-generated feedback at a particular turn. That is the class most
sensitive to timing — a turn arriving in a different order, or a run settling later than
the assertion expects, changes the observed text without any contract being violated.

**Do not preemptively weaken either.** No retries, no softened assertions, no widened
timeouts — the same standing rule as the liveness escalation, which was vindicated when
the "quiet period" there turned out not to be a fix. If either recurs, apply the
first-failure discipline that solved the liveness incident: capture the state at the
moment of failure rather than reasoning from the summary line. Neither currently reports
what the run was doing when the assertion failed, which is precisely the gap that made
the liveness incident undiagnosable for three tranches.

**`model-contract-violation-test.js` has now RECURRED** — same suite, same assertion
(line ~214), on the clean-worktree validation of `a853eaf`, with no latch signature
again. Per the standing rule it was diagnosed rather than weakened, and the first thing
diagnosis needed was inputs the suite did not record.

**What the assertion actually reads:** `provider.requestBodies(OVERSIZED)[1]` — the
SECOND provider request for that scenario, defaulting to `''` when absent. So the summary
line cannot distinguish two very different causes:

* the corrective feedback genuinely changed or lost a limit; or
* the second request was never captured, in which case the empty default fails both
  regexes and the message blames the feedback.

The immediately preceding assertions pass (`oversizedViolations.length === 2`, streak 2),
which means two model responses WERE processed — so the second cause is the more likely
one and the message is actively misleading.

**First-failure capture added (diagnostics only — no retry, no timeout change, no
weakened condition).** On failure the suite now records: how many requests were captured,
the run's status and error, the violation count and reconstructed streak, per-request
byte length and every `at most …` fragment found, and a `/health` snapshot so a latched
or backpressured deployment is ruled in or out. The assertion message now also states the
captured count.

This is the same discipline that resolved the evidence-latch defect after three wrong
hypotheses: make the repository able to state which input failed before theorising about
why.

### Timeline cluster COMPLETE — RETIRED `ticket-timeline-authority-visibility-test.js` (2026-07-27)

Its authority half moved to `timeline-authority-evidence-test.js` in an earlier tranche;
the remaining half is now `timeline-receipt-projection-test.js` — **32 assertions, 6
scenarios, registered**. Every live assertion has a destination, so the historical file
is deleted.

**The central contract is DEDUPLICATION**, and it exists because the same operation is
durably recorded in TWO places: the append-only `workspace.operation` event and the run's
replay snapshot `workspaceOperations`. Both survive a crash and both are authoritative
for different questions. If the fold breaks, the timeline double-reports every operation
— an operator auditing what an agent touched sees twice the activity that occurred, with
no indication which half is real.

| Scenario | Contract |
|----------|----------|
| 1 | one operation in both sources renders exactly once, keeping its receipt identity |
| 2 | **positive control** — four genuinely distinct reads render as four entries, including one that exists ONLY in replay |
| 3 | source labels are DERIVED: a receipted read is `embedded_receipt`, an unreceipted one is not, and receipt metadata (hash, size) survives |
| 4 | a committed mutation projects one `operation_history` entry carrying the durable `historyId` linking back to the ledger |
| 5 | triage projects at ticket and run level, and resolution states `statusUnchangedByResolution` — a reviewed failure is still a failure |
| 6 | provenance names template version, id and exact trigger; fabricated provenance is refused by referential integrity |

**`legacyUnversioned` is retired as obsolete, with evidence.** The historical suite
asserted that an unversioned template source "renders safely". That state is no longer
reachable: the runtime throws a data-integrity error for a `process_template` source
missing `templateVersion`, and the store enforces a foreign key from the ticket to the
trigger that produced it. Scenario 6 pins the replacement behaviour — fabricated
provenance is refused at the data layer, not judged at render time — so the retirement
rests on what the runtime does rather than on the assertion's absence.

**The mutation took three aims, and the first two survived for the same reason.** This is
the ninth instance of the standing lesson and the most instructive so far:

1. Removing the replay pass's `workspaceEventKeys` guard — **survived**. `addEntry` still
   folded the duplicate, because both entries derive the same `dedupeKey`.
2. Making the replay entry's `dedupeKey` unique — **survived**. The `workspaceEventKeys`
   guard skipped the item before `addEntry` ever saw it.
3. Changing how the replay side COMPUTES `evidenceKey` — **killed**. Both guards key off
   that one value, so altering it defeats both at once.

Neither guard is redundant and neither is sufficient alone to expose the regression
through outcomes: they are two layers over a single shared key. **The mutation had to
target the key, not either consumer of it.** Tuning the assertions after the first
survival would have produced a suite that fails for the wrong reason.

*(Fixture facts learned by failing, each now recorded in the suite: operation receipts are
written with `recordOperationReceipt` and outcomes are `succeeded`/`failed`/`refused`, not
`committed`; workspace receipts require a `mutationFingerprint`; the returned shape is
`{record, event, inserted}`; and the projection's durable link is `details.historyId`,
derived from the record, rather than `receipt.operationId`, which is only whatever the
caller placed in the receipt document.)*

### Preflight cluster — RETIRED `invalid-action-preflight-recovery-test.js` (2026-07-27)

**Replaced by `action-batch-preflight-test.js` — 23 assertions, 6 scenarios, registered.**

**The contract is ATOMICITY OF ADMISSION:** the entire action batch is validated before
any action executes, so one invalid argument rejects the whole batch. If validation ran
per action during execution, `[createFolder ok, createFolder ""]` would create the first
folder and only then reject the second — leaving a workspace half-modified by a batch the
runtime calls *rejected*, with no receipt explaining the leftover. "Rejected" would mean
"partially applied", which is worse for an operator than either executing or refusing
cleanly.

| Scenario | Contract |
|----------|----------|
| 0 | the VALID action preceding the invalid one leaves no filesystem effect, no receipt, no replay execution |
| 1 | hard floor: all three state-driven turns were reached and the run recovered to completion |
| 2 | `workspace.invalid_action_args` names the operation, the action INDEX (1, not the valid 0), the reason, and `rejectedBatch`/`executed:false` — in both replay and the append-only journal |
| 3 | the next turn is told the batch was rejected, that nothing ran, and which action to fix |
| 4 | mixed-phase batches are refused via `execution.phase_violation` with no mutation and no receipt |
| 5 | **positive control** — the corrected single-phase batch executes and is the run's ONLY receipt |

**The provider is state-driven.** Each branch is reachable only if the runtime delivered
the matching corrective evidence, so a runtime that rejects silently cannot finish the
run and the suite fails hard rather than passing vacuously.

**Mutation `preflight-executes-valid-prefix`** narrows preflight to the first action only,
so a batch whose invalid action comes later passes admission and executes its prefix.
Killed.

*(Assertion-ordering lesson: the hard floor originally ran first, so the mutation failed
with "the run didn't reach three turns" — true, but naming the symptom rather than the
defect. The leftover prefix is observable however the run ended, so it is checked FIRST
and the failure now names the actual contract. Worth noting the mutation also collapses
the conversation, because corrective evidence is what drives the provider's next branch —
that coupling is inherent to a state-driven stub and is a strength, but it means the
ordering of assertions determines which truth gets reported.)*

### Browser-evidence cluster — RETIRED `browser-evidence-audit-test.js` (2026-07-27)

The analysis below was recorded before the tranche was built and is retained because it
is the runtime semantics record. The disposition is at the end of this section: the
replacement is `browser-evidence-verdict-test.js`, registered, and **the test-only
terminalization seam this analysis concluded was necessary turned out not to be.**

Disposition: **REPLACE**. `classifyBrowserEvidence` (`server.js` ~6206) is live and has no
registered coverage. Full semantics recorded here so the next tranche starts from the
runtime rather than from the historical suite.

**Gate:** `isBrowserRun(run)` requires `run.targetRef.kind === 'browser'` AND
`run.browserTargetSnapshot`. Anything else → `not_applicable`.

**Inputs:** `snapshot.browserOperations` and `snapshot.parsedModelPlans` only.

**Decision order (first match wins):**

| # | Condition | Status |
|---|-----------|--------|
| 1 | `browserOperations` empty | `objective_unverified` |
| 2 | any `navigate` whose `receipt.metadata.finalUrl` contains `/sorry/`, `/captcha`, `/login`, `/signin`, `/403`, `/blocked` | `target_blocked_or_redirected` |
| 3 | `readPageText` with `status==='ok'` and `receipt.metadata.bytes > 0`, **or** `observe` with `receipt.metadata.elementCount >= 3`, **or** `screenshot` with `status==='ok'` | `evidence_available` |
| 4 | otherwise | `browser_evidence_insufficient` (detail differs when a plan had `complete: true`) |

**The load-bearing property** is that step 3 requires REAL captured content. `complete:
true` alone lands in step 4, and a bare `navigate` record does not satisfy step 3 — the
model claiming success cannot manufacture evidence. Note `objective_unverified` is
reached only via step 1 (no operations at all), so a suite must not expect it from a
run that navigated but captured nothing; that case is `browser_evidence_insufficient`.

**Durable path:** the verdict flows into `buildRunEvaluation` (~6169) → the run's
`runEvaluation`, and `buildFinalizedRunReplayState` (~11661) → the finalized replay. Both
are observable from the store after terminalization, so the suite can assert the DURABLE
classification rather than calling the classifier directly.

**Privacy contract respected by construction:** `evidence_available` is reachable through
`readPageText` bytes or `observe` elementCount ≥ 3 — no screenshot fixture is needed or
permitted. A negative assertion that no screenshot material appears keeps read-only text/DOM
evidence distinct from forbidden image evidence.

**Fixture route — the startup-convergence idea was TRIED AND DOES NOT WORK.** Seeding a
browser-target run, terminalizing it with `store.transitionRun`, attaching a crafted
replay snapshot and letting startup convergence finalize it leaves `run.runEvaluation`
**unset**: convergence calls `finalizeTicketForRun`, which settles the TICKET, and never
runs the run's terminal evaluation builders. A suite written that way times out waiting
for an evaluation that is never built.

The verdict is written by `buildRunEvaluation` (~6169) and `buildFinalizedRunReplayState`
(~11661), both invoked on the runtime's own terminalization path. So the next attempt must
either (a) drive a real run to terminalization through the runtime with a stubbed provider
— the pattern `carried-evidence-preservation-test.js` uses — while giving the ticket a
browser `targetRef`, or (b) find an operator-reachable route that re-derives the
evaluation. Option (a) is the known-good shape; the open question is whether a browser
run can be driven without a live browser process, since `isBrowserRun` needs
`targetRef.kind === 'browser'` AND `browserTargetSnapshot` on the RUN, which the runtime
populates from the ticket's target.

**FIXTURE SEAM PROBE — RESULT (2026-07-27).** The two boundaries are now traced:

* **`browserTargetSnapshot`** is set on the run at creation from the ticket's browser
  target (`server.js` ~14084, `normalizeBrowserTargetSnapshot`). A run only satisfies
  `isBrowserRun` if it carries BOTH that snapshot and `targetRef.kind === 'browser'`.
* **`browserOperations`** are not written by the suite anywhere in production — they are
  appended during execution through the non-terminal evidence repository:
  `completeActionReceipt({ …, replayKey: 'browserOperations', replayItem: evidence })`
  (`server.js` ~17051). That is a real repository path a fixture could use.

**But the public path cannot construct this fixture without a live browser.** Once
`isBrowserRun(run)` is true, execution routes to the browser path, and
`getOrCreateBrowserSession` (~17066) requires `run.browserTargetSnapshot.status === 'active'`
and then calls `createBrowserSession(...)` — an actual browser process. A stub *provider*
does not help: the provider is the model, not the browser. So:

> A run cannot both satisfy `isBrowserRun` and reach the runtime's terminalization
> builders unless a real browser session is created.

That is the finding, recorded rather than worked around. The three routes the objective
allowed resolve as: (a) preferred — real agent run with stub provider — **not possible**,
because the browser branch demands a session; (b) local browser-target harness against a
deterministic page — possible in principle, but requires a browser process in the test
environment, which has not been established here; (c) a narrow test-only seam invoking
normal terminalization with persisted browser evidence — the remaining option, and it
should be justified by (a) being impossible rather than by convenience.

**ENVIRONMENT VERIFICATION — RESULT (2026-07-27). Route (c) is justified.**

| Check | Result |
|-------|--------|
| chromium on PATH | present at `/usr/bin/chromium-browser` |
| `BROWSER_ENGINE_EXECUTABLE` set | **no** |
| runtime auto-discovery of a system chromium | **none** — `configuredExecutable()` reads only that env var |
| `getEngineStatus()` as the runtime sees it | `{configured:false, executableExists:false, available:false, version:null}` |
| browser suites registered in the release checkpoint | **none** |

So although a chromium binary exists on this machine, the runtime reports the engine
**unavailable**, and no checkpoint suite launches it. Route (b) would require setting
`BROWSER_ENGINE_EXECUTABLE` in the checkpoint environment — a deployment/config change
that a test must not silently depend on, and one no existing registered suite establishes
as reliable. **That is the reason the public path cannot be used in the checkpoint
environment**, recorded here as the objective requires.

**Therefore route (c):** a narrow test-only seam that triggers normal terminal evaluation
for a persisted browser run. Its constraints, restated so the next tranche cannot drift:
persist browser operations through `completeActionReceipt` with `replayKey:
'browserOperations'` — the production write path — and let `buildRunEvaluation` /
`buildFinalizedRunReplayState` produce the verdict. Only the ACT of initiating
terminalization may be test-specific. Never call `classifyBrowserEvidence` directly as the
primary proof, never write the verdict, never build operations in memory only.

*(If `BROWSER_ENGINE_EXECUTABLE` is later configured for the checkpoint and a registered
browser suite demonstrates reliable launch, route (b) becomes preferable and this seam
should be revisited.)*

**Scenario matrix (already designed, reusable):** no ops → `objective_unverified`;
blocked navigate carrying text+DOM evidence → `target_blocked_or_redirected`, which is the
precedence proof; `readPageText` bytes → `evidence_available`; `observe` elementCount 3 →
`evidence_available`; navigate + `observe` 2 + `complete: true` → `browser_evidence_insufficient`,
which is the "a claim is not evidence" proof; non-browser run → `not_applicable`. Assert
BOTH `runEvaluation.browserEvidence.status` and the finalized replay's
`browserEvidenceStatus`.

**Mutation target:** the step-3 predicate (`hasContentEvidence`), e.g. treating a bare
navigate as content. That leaves the run and replay structurally valid and changes only
the verdict, which is what the objective requires.

**Not built here:** the session's context budget ran out at this point. Recording the
runtime semantics is the expensive part of this cluster and it is done; the fixture is a
short hop from the startup-convergence pattern.

### BUILT — `browser-evidence-verdict-test.js` (13 scenarios, 181 assertions), 2026-07-27

Registered. `browser-evidence-audit-test.js` is retired from disk; the manifest orphan
count falls to 64.

**CORRECTION — the terminal-evaluation seam is NOT needed, and was not shipped.**

Everything above about the environment stands: chromium exists on this machine, the
runtime reports the engine unavailable, and no checkpoint suite launches one. What was
wrong is the inference drawn from it — that reaching `buildRunEvaluation` therefore
required a test-only route into terminalization. It does not. The reasoning missed a
state the runtime passes through on every run:

> A run held at its **first model call** is `running`, its replay snapshot is already
> initialized (`createRunReplaySnapshot` runs before the provider call), and it has
> captured nothing yet. That is precisely the state browser evidence needs to be
> attached to — and the run then terminalizes **through its own normal path**.

So the fixture holds each run there with a provider stub that blocks until the suite
releases it by name, persists that run's operations through `completeActionReceipt`
with `replayKey: 'browserOperations'` — the same repository call
`recordBrowserOperationEvidence` makes — and releases the gate. The runtime completes
the run and writes both verdicts itself. **No production source changed.**

The seam *was* built first (a doubly-gated `POST /__test__/runs/:id/terminal-evaluation`
calling `commitRunTerminalization`), proved to work, and was then removed once the
gated-provider fixture showed it redundant. Recorded because the general lesson is worth
more than this cluster: *a seam justified by "the public path cannot reach X" should be
re-tested against the states the runtime already passes through on the way to X.* The
blocked branch was `getOrCreateBrowserSession`, which is reached only when the model
proposes a browser action — and a run that never gets a model response never proposes
one.

**Every live assertion of the retired suite is mapped:**

| Retired assertion | Successor |
|-------------------|-----------|
| non-browser run → `not_applicable`, and its replay gains no `browserOperations` | scenario 2 |
| `/sorry/` navigation → `target_blocked_or_redirected`, detail names the URL | scenario 4 |
| `readPageText` content → `evidence_available`, in run AND replay | scenario 6 |
| low `observe` → insufficient | scenario 8, tightened to the exact status |
| no browser operations → `objective_unverified` | scenario 3 |
| terminal status independent of the evidence verdict | scenario 1 (every run completes; four of the six verdicts are not `evidence_available`) |
| exactly five allowed browser operations, none mutating | scenario 11 |

Three of those were **weakened** in the original and are not ported that way. Its
low-observe and completion-versus-evidence checks accepted
`browser_evidence_insufficient` **or** `objective_unverified`, which is precisely the
distinction this classifier turns on; the replacement asserts one status. And the
original **skipped with exit 0** when no browser engine was found — which, in this
environment, is what it would always have done.

**What the replacement adds that the original had no way to assert:**

- **Precedence.** A run whose navigation was blocked *and* which carried page text and a
  7-element DOM inventory — evidence sufficient on its own — still reports
  `target_blocked_or_redirected`. A classifier checking content first would call that run
  verified while it never reached the target.
- **The two sufficiency branches, separated.** The page-text run carries no `observe`;
  the DOM run carries no `readPageText`. Either branch alone decides its run, which is
  what makes the two mutations below independently meaningful.
- **A claim is not evidence, stated as a runtime property.** The stub answers *every* run
  identically — "objective addressed; finishing", `complete: true` — so the only thing
  differing between scenarios is what was captured. Four of the six browser runs durably
  record that completion claim and do **not** report `evidence_available`.
- **Attribution.** A second browser target runs concurrently with sufficient evidence; the
  run with none stays `objective_unverified`. Each run carries exactly its own operations
  and receipts. And offering one run's evidence under another ticket's ownership is
  **refused by the production write path** — asserted before terminalization, so the
  refusal comes from the store's ownership check rather than from the finalized-snapshot
  guard that would refuse everything afterwards.
- **Hydration.** Both verdicts and both explanations are re-read after a full runtime
  restart, and the restarted runtime still serves the evaluation over the operator API.
- **The privacy contract.** No screenshot operation, no screenshot artifact material, and
  no verdict justified by one — `evidence_available` is reached twice, by text and by DOM,
  and never by an image.

**Two mutations, both killed, each on its own branch:**

| Mutation | Contract removed | Failed on |
|----------|------------------|-----------|
| `browser-page-text-not-evidence` | captured page text is sufficient on its own | scenario 6 — the page-text run reports insufficient |
| `browser-dom-observation-not-evidence` | a ≥3-element DOM observation is sufficient on its own | scenario 7 — the DOM run reports insufficient |

Both leave the run, the receipts, the terminalization and the finalized replay intact and
change only the durable verdict, which is the point: the suite fails because the record is
wrong, not because the fixture broke. Keeping the two sufficient runs disjoint is what
makes that true — a single run carrying both text and a DOM inventory would survive either
mutation on the strength of the other branch, which is the same defence-in-depth trap A20
has now hit four times.

### Workspace-error cluster — RETIRED five `er*` orphans (2026-07-27)

**Replaced by `workspace-error-containment-test.js` — 160 assertions, 10 scenarios,
registered.** Orphan backlog 64 → 59.

Retired together: `er1-readfile-recoverable-test.js`,
`er2-createfolder-existing-file-recoverable-test.js`,
`er2a-readfile-notafile-recoverable-test.js`,
`er2b-writefile-notafile-recoverable-test.js`,
`er2c-listdirectory-not-enoent-recoverable-test.js`.

**They were five suites for one property, and that is why all five rotted together.**
Each spawned its own server, seeded its own `DATA_DIR`, and asserted one shape of the
same contract. Nothing tied them to each other, so nothing noticed when the cutover
killed the whole family at once.

**THE CONTRACT — the runtime must tell two kinds of failure apart:**

| Class | `failureKind` | Required behavior |
|-------|---------------|-------------------|
| Environmental | `workspace_error` | run CONTINUES; failure recorded with `blocked: false`; reported back to the model |
| Policy | `protected_path` | run FAILS; recorded with `blocked: true`; **no further turn** |

The discriminator is one line in the action loop:
`if (error.failureKind !== 'workspace_error') throw error;` (`server.js` ~20015).

**It had no registered coverage of any kind.** Before this suite, no registered file in
the repository referenced `workspace_error`, `WORKSPACE_FS_ENOENT` or
`WORKSPACE_PATH_TYPE_CONFLICT` — only the five orphans did.

**Both directions are defects, and the second is the worse one.** Treating environmental
failure as terminal kills runs on a missing file the model could have worked around —
the regression the er* family was written for. Treating a policy refusal as recoverable
hands a refused request back to the model as ordinary feedback and lets it keep trying,
turning a containment boundary into a retry loop. `workspace-authority-gate-test.js`
proves protected paths are *refused*; nothing proved the refusal was **terminal**.

**Live shapes, verified against the runtime before anything was written:**

| Shape | Classification site | Contained? |
|-------|--------------------|-----------|
| `readFile` on a missing path | `createStructuredWorkspaceFsError` → `WORKSPACE_FS_ENOENT` | yes |
| `readFile` on a directory | `WORKSPACE_PATH_TYPE_CONFLICT` | yes |
| `writeFile` onto a directory | `WORKSPACE_PATH_TYPE_CONFLICT` | yes |
| `createFolder` where a file exists | `WORKSPACE_PATH_TYPE_CONFLICT` | yes |
| `listDirectory` on a file (ENOTDIR) | wrapped in the `listDirectory` catch | yes |
| `readFile` escaping the root | `WORKSPACE_PATH_TRAVERSAL` / `protected_path` | **no** |
| `writeFile` to a hidden path | `WORKSPACE_HIDDEN_PATH` / `protected_path` | **no** |

*(`listDirectory` on a missing path is not an error at all — it returns
`status: 'not_found'`, already covered by `carried-evidence-preservation-test.js`.)*

**Historical assertion mapping — every live property has a destination:**

| Retired assertion | Successor |
|-------------------|-----------|
| run completed / `terminalStatus` completed after a recoverable error | scenario 1, for all five shapes |
| exactly one failed operation of that shape, carrying an error | scenario 3 |
| `blocked === false` on a recoverable failure | scenario 3 |
| no `run:step_limit` event | scenario 1 |
| the follow-up action executed and its file exists | scenario 2 |
| traversal: run failed, `terminalStatus` failed, `blocked === true` | scenario 6 |

One historical assertion is **not** ported as written: er2/er2a/er2b/er2c each required the
recovery action to be a `listDirectory`. Which operation the model chooses next is
fixture detail, not contract; the live property is that a further action executed at all,
which scenario 2 asserts through its durable receipt and its filesystem effect.

**What the replacement adds that the originals could not:**

- **The failure is REPORTED, not merely survived.** Scenario 4 asserts the structured
  `previousActionResults` the runtime actually sent: the failed operation, the path it
  attempted, and a non-empty reason — and no `result` alongside it. The stub is
  state-driven, so a runtime that contains the error but says nothing cannot finish the
  run at all.
- **The refusal is terminal, proved by absence of both consequences.** Scenario 7
  requires the policy runs to have received exactly one model turn and to have left no
  follow-up file. A suite asserting only "the run failed" would survive the boundary
  being downgraded to feedback if the retry happened to fail too.
- **Containment reaches the filesystem.** Scenario 8 re-checks the workspace: the
  directory a `writeFile` targeted is still a directory with its contents intact, the
  file a `createFolder` targeted still holds its original bytes, the missing path was
  not created, the hidden path was never written, and nothing landed outside the root.
  "The run survived" is not the same as "nothing half-happened".
- **A positive control.** One case reads a file that exists. Without it every assertion
  above is satisfied by a runtime that fails every operation, because *contained* would
  be indistinguishable from *broken*.
- **No vacuous exit.** No skip path, no `NOT_PROVEN`, every wait throws on timeout, and
  `assertScenariosExecuted` enforces a floor. The historical suites had none of this.

**Three mutations, all killed, aimed at two different layers:**

| Mutation | Layer | Failed on |
|----------|-------|-----------|
| `recoverable-workspace-error-terminates-run` | the discriminator branch | scenario 1 — a missing file kills the run |
| `policy-refusal-treated-as-recoverable` | the same branch, inverted | scenario 6 — a path escape completes |
| `missing-file-classified-as-policy-refusal` | the CLASSIFIER below it | scenario 1 — the branch is still correct, it is told the wrong thing |

The third exists because the first two only prove the branch reads `failureKind`. It
leaves the branch untouched and mislabels ENOENT upstream, so the run dies *and* the
durable record calls a missing file "blocked" — which an operator would read as an
authorization decision that never happened.

**Assertion ordering was corrected, and the lesson is the same one the preflight tranche
recorded.** The first version asserted the exact model-turn count in the hard floor, so
two of the three mutations failed with *"expected 2 turns, got 1"* — true, and a
description of the symptom rather than of the defect. The run's terminal status is
observable however the conversation went, so it is checked first; the exact turn counts
moved to the scenarios where they are the property under test.

**Observation, recorded not fixed: the ENOENT message handed to the model contains the
absolute host path.** `previousActionResults` carries the raw `fs` message, e.g.
`ENOENT: no such file or directory, lstat '/tmp/tstharness-ws-69nVwM/absent.txt'`. The
model is given the workspace root's real filesystem location, and that text goes to the
external provider. Other surfaces redact deliberately — browser runs redact URLs and
model prose — so this is an inconsistency rather than an established position. It is out
of this cluster's scope and needs its own disposition: either the error is sanitized to
the workspace-relative path before it reaches the prompt, or the disclosure is stated as
intended. Not changed here, because the current text is what the retired suites and the
replacement both assert against, and changing it silently would move a contract while
claiming to cover it.

### Rerun-admission cluster — RETIRED three orphans (2026-07-27)

**Replaced by `rerun-admission-gate-test.js` — 65 assertions, 9 scenarios, registered.**
Orphan backlog 59 → 56.

Retired: `ticket-triage-rerun-hardening-test.js`, `manual-rerun-attempt-ceiling-test.js`,
`max-attempts-control-test.js`.

**THE CONTRACT — what may start new work after a ticket has stopped.** Two things may
refuse, and they are the only bounds on repeating failing work:

| Bound | Enforced in | Lifted by |
|-------|-------------|-----------|
| unresolved ticket triage | `hasUnresolvedTicketTriage`, consulted by rerun, retry and `createRunsForTicket` | resolving the triage |
| `executionPolicy.maxAttempts` | `validateManualRerun` — the ONLY site, counting runs that exist | raising or clearing the ceiling |

**Neither had registered coverage.** The refusal strings `Manual rerun rejected` and
`unresolved ticket-level triage`, and the ceiling-edit route, appeared only in the three
orphans.

**Every refusal is asserted twice — the status AND the run count read from the store.**
A gate that returns 409 and creates a run anyway is indistinguishable from a working gate
by its response alone, and that is the failure mode an operator would never see.

**THE MOST USEFUL FINDING: the triage gate is two layers deep, and only the outer layer
explains itself.**

The `triage-gate-never-fires` mutation makes `hasUnresolvedTicketTriage` return `false`
— disabling all three call sites at once. It is killed, but **not where it was aimed**.
The rerun is still refused, because the store's own `reopenTicket` raises
`TICKET_TRIAGE_REQUIRED` underneath the route, *with the identical message text*. So the
rerun scenario passes through the mutation, and what actually fails is the retry
scenario, where the surviving refusal degrades to a bare `409 Conflict`.

> The gate holds without the predicate. What does not hold is the refusal remaining
> **legible** — and an unexplained 409 is one an operator cannot act on.

A suite asserting only "the rerun was refused" would have stayed green through the
removal of the entire route-level gate. Every refusal in the replacement therefore
asserts the reason text, not just the status. This is the fourth time in A20 that a
mutation landing somewhere unexpected meant defence in depth rather than a coverage hole,
and the first time the surviving layer was materially *worse* than the one removed.

**Historical assertion mapping:**

| Retired assertion | Successor |
|-------------------|-----------|
| blocked ticket with unresolved triage: rerun 409 | scenario 6, on runtime-produced triage |
| retry on a run whose parent ticket has unresolved triage: 409 | scenario 8 |
| PATCH status → open on a triaged ticket creates no run | scenario 6 |
| resolved triage: rerun allowed again | scenario 7 |
| non-triaged ticket: rerun still works | scenario 1 (positive control) |
| below-ceiling rerun allowed, creating exactly one run | scenario 1 |
| rerun at `maxAttempts` rejected 409, creating no run | scenario 2 |
| unauthorized ceiling edit 403, policy unchanged | scenario 4 |
| ceiling edit preserves other policy fields, creates no run | scenario 4 |
| the rerun guard reads the updated ceiling | scenario 3 |

**Improved rather than ported literally.** The retired ceiling suite compared the policy
against a hard-coded field list, which silently stops covering any field the policy
gains. The replacement snapshots the policy **as the runtime normalized and stored it**
before the edit and diffs every key, plus asserts the key count is unchanged so the edit
cannot introduce a field either. (The first draft of this suite hard-coded field names
too, and failed against `verificationTiming` — a field that does not exist. That is the
same fragility, caught immediately.)

**Where the triage comes from.** Scenario 5 is fully public: an ambiguous objective makes
`createRunsForTicket` block the ticket through `blockTicketForObjectiveAmbiguity`, with
required triage and zero runs, no test involvement. Scenario 8 needs a state the public
API cannot reach in one step — a FAILED run whose parent ticket *also* carries unresolved
ticket-level triage — and seeds it through `transitionTicketState`, the same repository
call `blockTicketForNoModelRoute` makes, with the same patch and event type. The
triage-producing paths themselves are covered by `ticket-feasibility-gate-test.js` and
`runtime-feasibility-test.js`.

**Three mutations, three layers, all killed:**

| Mutation | Layer | Failed on |
|----------|-------|-----------|
| `triage-gate-never-fires` | the shared predicate, not one route | scenario 8 — the refusal loses its reason |
| `attempt-ceiling-off-by-one` | `validateManualRerun` | scenario 2 — one extra attempt is granted |
| `ceiling-edit-drops-other-policy-fields` | the ceiling-edit route | scenario 4 — every other policy field resets |

The second is an off-by-one rather than a deletion on purpose: the ceiling still exists,
still reports and still refuses eventually. A suite asserting "some rerun is eventually
refused" survives it; one asserting the exact boundary does not.

**`auto-retry-test.js` is deliberately NOT in this cluster, and here is where the next
tranche should start.** Bounded automatic retry is the *automatic* counterpart of the
same admission question and is live (`assessAutoRetryAfterFailureIfPolicyAllows`,
`runAutoRetryAfterFailureIfPolicyAllows`), gated on `autoRetry === true`, a finite
effective attempt limit (an explicit `maxAttempts` override or the inherited runtime
default), no ticket triage, an individual-agent ticket, `mutationCount === 0`, and a
prospective triage reason code of exactly `runtime_failed`.

That last condition is the blocker, and it is a real one rather than an omission.
`runtime_failed` is the **fallback** reason code (`buildRunTriage`: assigned only when no
structured `failureKind` matched), so inducing it deterministically means finding a
failure path that carries no failure kind at all. Every convenient failure does carry
one: traversal → `protected_path` → `authority_blocked`; provider faults →
`provider_error` → `provider_failed`; malformed model output →
`MODEL_RESPONSE_CONTRACT_VIOLATION` → `model_contract_failed`. Identifying a deterministic
`runtime_failed` producer is the first task of that tranche, not an afterthought inside
this one — driving the retry with the wrong reason code would exercise the *ineligible*
branch while appearing to cover the eligible one.

### The remaining 56 — sequencing

Not repaired here, and deliberately not batch-migrated. A10 established that mechanical
migration is wrong: `bounded-transition-test.js` needed two scenarios re-expressed because the
phase gate superseded them, and `replay-snapshot-storage-test.js` needed a third of itself
retired. Each of the 83 needs the same per-suite judgement about whether its contract is still
live.

Recommended order:

1. **The remaining 5 `cutover-orphan-silent` suites**, regardless of what they guard. Their
   failure mode is invisible, so they are the ones most likely to be mistaken for coverage.
   Use `scripts/child-process-settlement.js`; the unguarded pattern is now fixed in one place.
2. **Suites guarding authority, mutation and evidence contracts** — the ones whose regression
   would be a correctness or security defect rather than a display defect.
3. **Everything else**, retiring rather than porting wherever the mechanism is dead, with the
   reason recorded here.

The manifest makes progress measurable: `node scripts/test-manifest.js` reports the orphan
count directly, and it can only fall by a suite being repaired and registered, or retired with
a reason.

---

### A25. Bounded automatic retry never executed

| Field | Value |
|-------|-------|
| **Status** | **Implemented 2026-07-27.** One-line correction; `auto-retry-bounds-test.js` registered (29 assertions, 7 scenarios) |
| **Severity** | **High** — an operator-enabled policy did nothing, and the record looked identical to the policy being off |
| **Discovered by** | Building the A20 replacement for `auto-retry-test.js` |
| **Evidence** | Read-only probe: eligible ticket, `{autoRetry: true, maxAttempts: 2}`, `runtime_failed`, no mutations → **1 run**, triaged |

**Proven behavior (before).** A ticket meeting every documented eligibility condition
produced exactly one run and fell into triage, indistinguishable from a ticket with
auto-retry switched off.

**Mechanism.** `runAutoRetryAfterFailureIfPolicyAllows(failedRun, assessment)` called:

```js
const created = await getTicketRunLifecycleRepository().createRetryRun({ … },
  options.persistence || options);
```

The function has **no `options` parameter**, and no `options` binding exists in its scope
(the only declarations in the file are locals inside unrelated route handlers). Every
eligible retry therefore threw `ReferenceError: options is not defined`, which the
surrounding `catch` swallowed into `{ retried: false, reason: 'retry_creation_failed' }`.
The caller then built triage after the fact, producing exactly the shape an ineligible
run produces.

`createRetryRun` accepts **one** argument; the second was never meaningful. Removing it is
the whole fix.

**Why nothing noticed.** The failure was caught, the run still terminalized correctly, the
triage was still written, and the only observable difference was a run that did not exist.
`auto-retry-test.js` — the one suite that counted runs per ticket — has been orphaned
since the PostgreSQL cutover. This is the **fifth** time in A20 that a suite exposed a
live production defect the moment it could run again.

**Behavior change.** Deployments with `executionPolicy.autoRetry: true` and remaining
effective attempt capacity will retry eligible runtime failures once per available
attempt. The bound may be an explicit ticket override or the runtime default resolved
into each newly admitted run.

---

### A26. `countRunMutatingOperations` always returns 0

| Field | Value |
|-------|-------|
| **Status** | **Implemented 2026-07-27.** One authority for both consumers; `run-mutation-evidence-test.js` registered (55 assertions, 9 scenarios) |
| **Severity** | **High** — a run that mutated the workspace was automatically retried, and finalized replays recorded `no_mutations` for runs that mutated |
| **Discovered by** | A25's probe: a ticket whose run wrote a file and then failed on a step limit was retried |
| **Evidence** | Source, plus an observed retry of a run whose write landed on disk |

**Mechanism.**

```js
function countRunMutatingOperations(runId, history = null) {
  history = Array.isArray(history) ? history : [];   // null → []
  return history.filter(record => record.runId === runId && isActualWorkspaceMutation(record)).length;
}
```

Called with one argument it can only return **0**. It never loads history. Both live call
sites call it that way:

| Call site | Consequence of a constant 0 |
|-----------|------------------------------|
| `failAgentRun` | the `mutationCount === 0` half of auto-retry eligibility is inert, so **a run that already mutated the workspace is retried** |
| `buildFinalizedRunReplayState` | `mutationCount: 0` and `mutationOutcome: 'no_mutations'` are written into the finalized replay of runs that DID mutate |

**Observed.** A ticket whose run wrote `mutated-*.txt` and then failed on the execution
step limit produced a second, automatic run. The file was on disk; the guard that exists
to prevent exactly that retry did not fire.

**Why this is the dangerous half of A25.** Retrying an unmutated failure repeats nothing.
Retrying a run that already applied part of its intended change re-enters a workspace the
previous attempt left half-modified — which is the scenario `isAutoRetryableReason` was
written to exclude.

**It was worse than first recorded.** The inventory found **four** zero-argument call
sites, not two, and one more passing `suppliedOperations || undefined` (which defaults to
the same empty array). One of them is `completeAgentRun`, so **every COMPLETED run's
finalized replay also claimed `no_mutations`**, regardless of what it wrote — not only
failures.

**The authoritative source.** `readAllRunOperations` — the committed operation receipts,
the same records operation reconciliation, run consequence and the operator surfaces
already read. A probe confirmed the disagreement directly: a run that wrote `alpha.txt`
and created `beta-dir` had `runConsequence.mutations` listing both (A16's path, correct)
while the finalized replay said `mutationCount: 0, mutationOutcome: 'no_mutations'`. Two
durable authorities, one question, opposite answers.

Not inferred from the requested operation name, a planned action, a refused or failed
operation, a replay entry without a receipt, or the workspace itself — the last cannot
separate this run's changes from what was already there.

**The correction.**

- `resolveRunMutationEvidence(runId)` is **explicitly asynchronous** and returns
  `{ count, available }`. The optional-history parameter that silently defaulted to `[]`
  is gone from every production path.
- Both consumers — the retry assessment and `buildFinalizedRunReplayState` — derive from
  it, so they cannot disagree.
- **Fails closed.** When receipts cannot be read, `count` is `null` and `available` is
  `false`; the replay records `mutationOutcome: 'unknown'` (a truthful third state, not a
  degraded `no_mutations`) and `assessAutoRetryAfterFailureIfPolicyAllows` refuses with
  `mutation_evidence_unavailable`. "We could not tell" must never read as "it changed
  nothing", because both consumers treat 0 as permission.
- **One committed operation counts once**, de-duplicated by operation key, so a
  reconciled effect surfacing under the same key cannot inflate the total.

**Classification, as observed rather than assumed:**

| Class | Durable shape | Counted? |
|-------|---------------|----------|
| committed mutation | receipt, `outcome: succeeded` | yes, once |
| successful read | **no receipt** — reads are replay evidence, not a commit path | no |
| policy-refused mutation | **no receipt** — refused before the operation is prepared | no |
| mutation failing before its effect | receipt with a non-`succeeded` outcome AND an error | no |
| reconciled committed effect | same operation key | once |
| divergent duplicate | **refused by the store** with `IdempotencyConflictError` | cannot exist |

Two of those were corrections found while writing the suite: a policy refusal and a read
leave no receipt at all, so assertions written against "a receipt with a failed outcome"
were wrong about the mechanism even though right about the outcome.

**Mutations — and a defence-in-depth lesson that cost two re-aims.**

| Mutation | Result |
|----------|--------|
| `committed-mutations-ignored` (evidence boundary returns 0) | killed — scenario 1, the replay records 0 of 2 |
| `uncommitted-mutations-counted` (whole non-committed carve-out) | killed — scenario 4, the count inflates to 2 |
| `divergent-receipt-accepted-for-committed-key` (store idempotency guard) | killed — scenario 7 |

`uncommitted-mutations-counted` **survived twice** before landing. Removing the store's
`outcome` verdict alone survived; removing the recorded `error` alone survived too. A
receipt for a mutation that failed before its effect carries **both**, and either one
excludes it. That is defence in depth in the runtime and a warning for testing it: a
mutation removing one exclusion proves nothing about whether the exclusion is covered.
The fifth such finding in A20.

The de-duplication in the counting helper is likewise **defence in depth, not the
control**: the operation-receipt table cannot hold two rows for one key, so the layer that
actually prevents double counting is the store's idempotency guard — which is where the
third mutation is aimed and what scenario 7 asserts.

**Known gap, stated rather than assumed.** The `available: false` branch is fail-closed by
construction but is **not covered behaviorally**. Reaching it requires the receipt read to
fail, which no checkpoint-reachable condition produces; proving it would mean adding a
fault-injection seam to production source. That was judged not worth new production
surface (the A24 precedent), so it is recorded as an uncovered branch rather than counted
as tested.

**Consequence for A20 — `auto-retry-test.js` is still NOT retired, on ONE assertion.**

| Historical assertion | Destination |
|----------------------|-------------|
| default off; no finite ceiling; bounded single retry; provenance; policy snapshot; exhausted run triaged | `auto-retry-bounds-test.js` 2–4 |
| authority/protected never retries | `auto-retry-bounds-test.js` 5 |
| provider failure never retries | `auto-retry-bounds-test.js` 5b |
| ticket-level triage blocks auto-retry | `auto-retry-bounds-test.js` 5c |
| exactly one `ticket:auto_retry` audit entry | `auto-retry-bounds-test.js` 5d |
| startup must not retry old failures | `auto-retry-bounds-test.js` 6 |
| runtime failure WITH a mutation never retries | `run-mutation-evidence-test.js` 2 |
| **verification failure never retries** | **NONE** |

**Why the last one is still open, stated rather than papered over.** The property holds
*structurally* — a postcondition failure terminalizes through `completeAgentRun`, which
never reaches the retry hook in `failAgentRun` — but a fixture that actually produces a
`verification_failed` run was not found: an objective naming a folder, left undone,
**completed** rather than failing verification. Asserting the property against a fixture
that does not reproduce it would be worse than leaving it recorded, so it is recorded.

Closing it needs a deterministic postcondition failure. `postcondition-completion-test.js`
induces blocked-operation and completion-deferral shapes but not this one, so the first
task is establishing which objective or workflow shape reliably fails verification —
the same "find the truthful fixture first" discipline A25 needed for `runtime_failed`.

Retire `auto-retry-test.js` when that lands, not before.

---

### A24. Absolute host filesystem paths disclosed to the model provider

| Field | Value |
|-------|-------|
| **Status** | **Implemented 2026-07-27.** Redaction at the provider-input boundary; `provider-input-privacy-test.js` registered (40 assertions, 8 scenarios) |
| **Severity** | **High** — every model request disclosed the host filesystem layout to an external provider |
| **Discovered by** | `workspace-error-containment-test.js` — the ENOENT message it asserts against carries the absolute path |
| **Evidence** | Read-only probe capturing complete provider request bodies, before and after |

**Description.**

The defect was reported as *recoverable filesystem errors carry the raw Node message,
including the absolute host path*. That is true, and it is the narrow case. Capturing
whole provider request bodies showed the disclosure was never confined to error text:

| Provider-bound field | When | Contains |
|----------------------|------|----------|
| `runtimeEnvelope.workspaceRoot` | every request | absolute host root |
| `runtimeEnvelope.mainWorkspaceRoot` | every request | absolute host root |
| `initialWorkspaceSnapshot.targetScope.root` | every request | absolute host root |
| `currentWorkspaceSnapshot.targetScope.root` | every request | absolute host root |
| `previousActionResults[].error` | after a filesystem failure | absolute host path of the attempted file |

**4 of 4 captured requests carried the absolute root, before any error occurred.**
Sanitizing the error message alone would have fixed one field of five and left the
disclosure fully intact — and the reported defect would have looked closed.

An off-machine model therefore received the deployment's filesystem layout: a developer
home directory, a temporary directory, or a production workspace path, on every turn of
every run.

**Decision — redact at the SEND boundary, not per field and not in the prompt builder.**

`callModelProviderWithRunEvidence` receives the assembled input for every provider call
— agent and browser alike — and is the last point before the wire.
`redactProviderInput` replaces every known host workspace root
(`run.workspaceRoot`, `run.mainWorkspaceRoot`, `workspaceProvider.root`) with the stable
token `<workspace-root>`.

Per-field redaction was rejected for a reason the evidence makes concrete: three of the
five disclosing fields are not error channels at all, and any prompt field added later
would reintroduce the disclosure by simply forgetting to opt in. A boundary cannot forget.

**Why the send path rather than the prompt builder — an implementation attempt that was
withdrawn.** The first version wrapped `buildAgentPrompt`, splitting the renderer into
`buildAgentPromptMessages`. That broke `organization-guidance-test.js`, which extracts
the `buildAgentPrompt` body from `server.js` as TEXT and greps it; two further registered
suites (`phase-gated-catalog-behavioral-test.js`,
`workspace-snapshot-availability-test.js`) couple to the same function by name or offset.
Rather than edit three source-coupled suites to accommodate a rename, the redaction moved
to the send path — which is a strictly better boundary anyway:

- it covers **every** provider call, including any future builder, not just this one;
- it is the same value the provider-request replay evidence is recorded from, so the
  durable record of what was sent matches what was actually sent, instead of attesting a
  payload that was never written to the wire.

The source-extraction coupling itself is pre-existing (the A13 family) and is left as it
is; it was the signal that pointed at the better boundary, not a problem this entry
opened.

**The placeholder is a token, not a deletion.** The prompt contract refers to
`runtimeEnvelope.workspaceRoot` by name when instructing the model never to use it in a
path; deleting the field would leave that instruction pointing at nothing.

**Meaning was strengthened, not traded away.** Carried failures now include `errorCode`
and `failureKind` alongside the message, which they did not before. After redaction the
prose is no longer the only thing distinguishing *the file is missing*
(`WORKSPACE_FS_ENOENT`) from *the path is the wrong type*
(`WORKSPACE_PATH_TYPE_CONFLICT`), and it must not become so. This mirrors the shape the
workspace-snapshot failure path already used — `error: failure.code` plus `errorKind` —
which was the in-repository precedent for what correct looks like here.

**Operator diagnostics are deliberately untouched.** Replay snapshots, run logs and
events keep the raw message and the real absolute root. That evidence is local, behind
the operator's session, and it is what someone diagnosing a path fault needs. Scenario 7
of the suite asserts the durable record still contains the real root and is NOT redacted
— a fix that quietly blinded the operator too would be a different defect, not a smaller
one.

**Scope: which channels were genuinely shared.**

| Channel | Finding | Action |
|---------|---------|--------|
| `previousActionResults[].error` | raw `fs` message, absolute path — the reported defect | covered by the boundary; `errorCode`/`failureKind` added |
| `runtimeEnvelope.workspaceRoot` / `mainWorkspaceRoot` | absolute, every request, by design | covered by the boundary |
| `initialWorkspaceSnapshot` / `currentWorkspaceSnapshot` `.targetScope.root` | absolute, every request | covered by the boundary |
| `priorFailureContext.reason` (`run.error` verbatim) | **same raw-message pattern**, provider-bound | covered by the boundary. No current failure path was shown to put an absolute path there — `workspace_error` never terminates a run, and the terminal `protected_path` messages carry no path — so it was NOT separately rewritten |
| workspace-snapshot failure `error` | already `failure.code` + `errorKind`, no message | unchanged; it is the precedent |
| browser runs | URLs already redacted through `redactBrowserUrl`; no filesystem paths | unchanged |

`priorFailureContext` is the case the instruction to avoid speculative broadening
applies to: the pattern is genuinely shared, but the disclosure is not demonstrable
today. The boundary covers it either way, which is the argument for putting the fix
there rather than in five places.

**Mutation.** `prompt-carries-raw-host-paths` makes the redaction return its input
unchanged. The runs still start, still fail recoverably, still carry evidence forward and
still complete; the suite fails on the disclosure assertion with everything else about
the run intact — which is what makes it a privacy regression rather than a broken run.

### A19. No canonical runtime replay-snapshot validator exists

| Field | Value |
|-------|-------|
| **Status** | **Open — decision required** |
| **Severity** | Medium — replay validity is asserted piecemeal, never centrally |
| **Found** | 2026-07-25, while proving A18 |

Replay snapshot creation and mutation are guarded by **distributed** shape checks:
`createReplaySnapshotBase` defines the creation contract, individual append helpers
guard their own keys, and test scripts carry their own expectations (for example
`assertReplayOrdering` in `scripts/scheduler-integrity-abuse-test.js`). No single
runtime validator establishes that a replay snapshot is complete, well-formed, and
reconstructable.

Consequence: code that creates or repairs a replay snapshot cannot ask the system
whether the result is valid. A18's strict evidence path therefore validates the
snapshots it initializes against `createReplaySnapshotBase` and normal
`readRunReplay` reader behavior in `scripts/required-replay-evidence-test.js`. That
is contract-and-reader validation, **not** formal runtime validation, and A18 does
not claim otherwise.

Whether to introduce a runtime replay validator — and whether it should run on
creation, on repair, or on read — is a governance decision outside A18's scope and
is deliberately left open here rather than resolved implicitly.

---

### A18. Required replay evidence is silently discarded when no snapshot exists

| Field | Value |
|-------|-------|
| **Status** | **Resolved — strict required-evidence replay path implemented and mutation-proven** |
| **Severity** | **High** — an evidence-of-last-resort channel reports success after writing nothing |
| **Found** | 2026-07-25, while proving A17 proof 8a (startup settle boundary) |
| **Blocks** | A17 proof 8a; A17 proofs 5 and 8b depend on the same fallback |

**Defect.** `settleTerminalRunEvidence` (`server.js`) uses `recordReplayEvent` as the
last authoritative channel after a *required* diagnostic log has already failed.
`recordReplayEvent` calls `appendRunReplaySnapshotItem`, which opens with:

```js
return updateRunReplaySnapshot(runId, snapshot => {
  if (!snapshot) return snapshot;   // silent success: nothing is written
  ...
```

When the run has no replay snapshot the append writes nothing, raises nothing, and
returns normally. The caller cannot distinguish "durably recorded" from "silently
discarded", so reconciliation and startup settlement may be treated as
evidence-complete when the required failure evidence was in fact lost. The
`try/catch` around the fallback is ineffective because no error is ever thrown.

**Proven symptom.** `scripts/reconciliation-evidence-failure-test.js` fails
deterministically at:

```
ok  the fixture run row reads running
ok  terminal evidence exists while the row still reads running
ok  the intended run:terminalized insert was attempted and rejected (1 fires)
FAIL timed out waiting for run.reconciliation_evidence_failed
```

The trigger firing proves the settle boundary is genuinely reached and the
rejection genuinely contained; only the durable evidence is missing.

**Fixture shape (startup Path B).** Terminal evidence committed while the run row
still reads `running` with an expired lease — created through store primitives
(`createRun` → `claimPendingRun` → `transitionRun` to `running` → append
`run.terminalized` → expire lease). This drives `interruptStaleRunsOnStartup` and
its `run:terminalized` log, not `run:reconciled`. A rejecting trigger on
`diagnostic_logs` proves firing via a sequence, whose increments survive the
rollback `RAISE EXCEPTION` causes.

**Unknown.** Whether ordinary crashed runs reaching startup repair usually *do*
possess a replay snapshot is **not established**. This fixture builds a run that
lacks one, so production frequency is unknown and must not be assumed low. The
behavior is defective regardless of frequency: this call site requires evidence,
not optional enrichment, and a silent success is wrong at any rate of occurrence.

**Resolution.** `appendRequiredRunReplaySnapshotItem` owns the whole required-evidence
sequence — identity/shape validation, canonical initialization via `initializeRunReplay`
(`ON CONFLICT DO NOTHING`, so idempotent and non-destructive), existing-identity
inspection, idempotency/conflict decision, append, and exact readback of identity +
type + payload. `recordRequiredReplayEvent` is a thin wrapper. The tolerant
`appendRunReplaySnapshotItem` is unchanged and remains documented as optional
enrichment.

Required evidence carries a **caller-supplied stable identity**, never derived from
type, message, timestamp, or serialized payload. Payload comparison is semantic
(`canonicalOperationJson`) because PostgreSQL `jsonb` does not preserve key order.
Failures are classified as `initialization_failure`, `append_failure`,
`readback_failure`, `event_missing_after_append`, `event_identity_conflict`, or
`malformed_replay`, each carrying `EVIDENCE_PERSISTENCE_FAILED`,
`failureKind: evidence_persistence`, `evidenceChannel: replay`, run id, event type,
evidence identity, store code where available, and internal `cause` linkage — never
replay contents.

`buildReconciliationEvidenceId(runId, revision, logType)` scopes one occurrence to
one reconciliation attempt against one run state. It is a named function rather than
an inline template precisely so the scoping is testable: an inline string passed
every test while silently collapsing occurrences.

**Proof.** `scripts/required-replay-evidence-test.js` — 56 assertions, PostgreSQL-native,
with the strict helper extracted from `server.js` source and driven against the real
replay store. Seven mutations each fail a named assertion:

| Mutation | Failing assertion |
|---|---|
| Silent return on missing event | `an append that writes nothing is detected, not trusted` |
| Canonical initialization removed | `initialization_failure` |
| Readback weakened to type-only | `event_identity_conflict` |
| Identity conflict check removed | `same identity with conflicting type fails` |
| Idempotency removed | `retrying the same occurrence appends no duplicate event` |
| Identity requirement removed | `required evidence without a stable identity is refused` |
| Identity reverted to `runId + logType` | `the occurrence identity embeds the persisted run revision` |

Revision scoping is proven against **real persisted revisions**: a retry reuses the
identity and appends nothing; a genuine `claimPendingRun` + `transitionRun` advances
the revision (1 → 3) and yields a distinct identity; both occurrences persist
separately. Snapshot validation is against `createReplaySnapshotBase` and normal
reader behavior — see [A19] for the absent canonical runtime validator.

**Caller classification (complete).** The tolerant helper has exactly two wrappers.
Absence of a replay snapshot is only *possible* at one of their call sites, which is
why this defect is narrow rather than pervasive.

| Wrapper / site | Event type(s) | Lifecycle phase | Snapshot guaranteed present? | Classification | API |
|---|---|---|---|---|---|
| `recordRunEvent` — 27 sites (`server.js` 10382, 10787, 17178, 18327, 18779, 18946, 19056, 19138, 19156, 19229, 19274, 19307, 19335, 19353, 19390, 19399, 19437, 19468, 19505, 19860, 19869, 19899, 19933, 19942, 19948, 19963) | feasibility, model-contract, workspace-contract, postcondition, phase-violation, snapshot-recovery | Active execution inside `runAgentTicket` | **Yes** — `createRunReplaySnapshot` runs `initializeRunReplay` at run start, before any step | Required evidence, but absence is unreachable | Tolerant (correct) |
| `recordReplayEvent` — `server.js` ~11681 | `run:interrupted` | Interrupted-run terminalization | **Yes** — `ensureInterruptedRunReplaySnapshot` calls `initializeRunReplay` immediately above it in the same function | Required evidence, absence unreachable **by construction** | Tolerant (correct — explicit decision, not left vague) |
| `recordReplayEvent` — `server.js` ~5118 (A17 settle boundary) | `run.reconciliation_evidence_failed` | Startup repair / terminal reconciliation | **No** — the run may never have had a snapshot | **Required evidence of last resort** | **Strict** (`recordRequiredReplayEvent`) |

Every execution-phase caller is preceded by initialization on its own path, so the
tolerant no-op is unreachable for them and switching them to the strict API would
add cost without changing behavior. The startup/reconciliation fallback is the sole
site where a snapshot may legitimately be absent, and it is the only site switched.
Direct `updateRunReplaySnapshot` callers (`server.js` 9957 artifact prediction,
19048 browser report text) are **optional enrichment**: both guard on `!snapshot`
deliberately, and both are meaningless without a snapshot. They stay tolerant.

**Required direction.** Do not globally make `appendRunReplaySnapshotItem` strict —
its missing-snapshot tolerance may be intentional for optional enrichment and for
historical runs. Instead inventory every caller of `appendRunReplaySnapshotItem`,
`recordReplayEvent`, and related helpers, classify each as required evidence,
optional enrichment, or historical-compatibility, and introduce an explicitly named
strict API (`appendRequiredRunReplaySnapshotItem` / `recordRequiredReplayEvent`)
whose contract is: append durably, or throw a structured evidence-persistence
error — never return success having written nothing. A17's reconciliation and
startup fallback must use the strict path. Where no snapshot can be validly
initialized, persist through another authoritative durable channel (such as the run
event journal) or return an explicit evidence-incomplete result. Do not fabricate a
partial replay snapshot to make the append succeed, and do not downgrade required
evidence to stderr.

---

### A16. Run consequence records no committed mutations

| Field | Value |
|-------|-------|
| **Status** | **Implemented 2026-07-26.** Prospective correction + historical compatibility |
| **Severity** | **High** — a run's durable record of what it changed is empty even when it changed something |
| **Scope** | Separate production-runtime defect. **Not** an A10 test-migration issue |
| **Evidence** | Independent read-only probe against `master` `074526e` |
| **Decision required** | Diagnose the consequence path, then decide the smallest coherent correction |

**Proven behavior.**

A completed run holding a **succeeded** `writeFile` operation receipt persists an empty
consequence:

```
RUN status=completed
OPS=["writeFile:cons-note.md:succeeded"]
CONSEQUENCE.created=[]
CONSEQUENCE.mutations=[]
```

`runConsequence.created` is `[]` and `runConsequence.mutations` is `[]` despite the receipt
existing with `outcome: succeeded`.

**Operational impact.** The run surface and the diagnostic bundle render `runConsequence` as
what the run created, deleted, renamed, updated, and mutated. With these collections empty, both
surfaces **falsely report that the run changed nothing** — while the workspace and the operation
receipts show that it did. An operator triaging from either surface is told the opposite of what
happened.

**Natural test impact.** `postcondition-completion-test.js` scenario 6
(`workspace-objective-satisfied`) remains blocked. Its assertion —
`runConsequence.created` contains the written note — is **retained unchanged**; it is the
contract this entry exists to protect and must not be weakened to make the suite pass.

### Root cause — proven read-only, 2026-07-25

**Data is lost at write/finalization time. Not at persistence, and not at projection.**

`buildRunConsequence` (`server.js`) populates `mutations` and the category collections from
**one** source, with no fallback:

```js
(Array.isArray(suppliedOperations) ? suppliedOperations : []).forEach(record => {
  const mutation = buildMutationConsequenceFromHistory(record);
  if (!mutation) return;
  consequence.mutations.push(mutation.item);
  consequence[mutation.category].push(mutation.item);
});
```

If `operations` is not supplied, those collections are unconditionally empty. There are three
call sites and they disagree:

| Site | Path | Passes `operations`? | Result |
|------|------|----------------------|--------|
| `buildRunConsequence(projectedRun, …)` inside `commitRunTerminalization` | **normal terminalization** | **NO** — passes `snapshot`, `evaluation`, `events` only | **empty `created`/`mutations` persisted** |
| `buildRunConsequence({…}, { …, operations })` in the terminal-repair path | reconcile/repair | **YES** | populated |
| `run.runConsequence \|\| buildRunConsequence(run, { events, operations, evaluation })` | read-time reconstruction | YES | **never reached** |

The normal terminalization path — the one every ordinary run takes — omits the argument. The
terminal-repair path in the same file passes it, which is what proves the omission is a defect
rather than a narrower intended meaning.

The read-time fallback would have masked this, but cannot: it is guarded by
`run.runConsequence || …`, and an **empty-but-present** consequence is truthy, so the persisted
empty value wins and the reconstruction never runs.

**Answers to the diagnosis questions:**

- *Calculated during execution?* No — built once at terminalization.
- *Reconstructed on read?* Only when absent; an empty persisted consequence blocks it.
- *Projected differently between access paths?* No. The projection and the row are faithful to
  what was built; nothing is dropped on write to PostgreSQL or on read.
- *Did PostgreSQL persistence drop fields the JSON runtime wrote?* No. The row stores exactly the
  object `buildRunConsequence` returned.
- *Is the succeeded receipt visible to the builder?* Yes — receipts are committed before
  terminalization. The builder is simply never handed them.
- *Does something overwrite a populated consequence with an empty default?* No. It is never
  populated on this path.
- *Are `created`/`mutations` narrower concepts than the scenario assumes?* No —
  `buildMutationConsequenceFromHistory` exists specifically to classify a receipt into
  `created` / `updated` / `deleted` / `renamed` / `mutations`, and the repair path uses it that way.

**Affected operations and runs.** All mutating operations (`writeFile`, `createFolder`,
`renamePath`, `deletePath`) on **every run that terminalizes normally** — i.e. the common case.
Runs that go through terminal repair are unaffected.

**Is scenario 6's expectation still an intended contract? Yes.** Evidence, not inference:

- The terminal-repair call site passes `operations`, so the same codebase intends consequences to
  enumerate committed mutations.
- `buildMutationConsequenceFromHistory` exists only to build these entries.
- `views/run-detail.ejs` renders the consequence categories directly to the operator.
- `summarizeDeliverableConsequence` composes the run's terminal report from
  `consequence.created` and its siblings when the model left no message — so an empty consequence
  makes the run report "no recorded consequence".

**Relationship to A14: none established.** A14 was a read-path projection defect in
`getOperation`. This is a missing argument at a write-path call site. Different mechanism,
different layer. No shared cause is claimed.

### Correction (implemented)

**Prospective — receipts read inside the terminalization transaction.** The store now loads the
run's canonical projected receipts on the terminalization transaction's **own client**
(`_listRunOperationsOn(client, id, …)`) and passes them to the consequence callback, so the
consequence describes exactly the evidence committed under that boundary. `listRunOperations`
and the in-transaction reader share one body, so pooled and transactional reads cannot project
differently. No array loaded outside the transaction is used.

**Omission made impossible.** `buildRunConsequence` now requires an explicit `operations` array
and throws when it is missing; the silent `Array.isArray(...) ? ... : []` default is gone. All
three call sites — normal terminalization, terminal repair, read-time reconstruction — pass
deliberately. `[]` remains valid and meaningful for a genuinely non-mutating run.
`buildMutationConsequenceFromHistory` semantics are unchanged.

**Historical — one canonical presentation hydration.** Three sites attach `runConsequence` to a
run: `readRuntimeRunAuthority` (run detail and diagnostics), `buildTicketTimeline`
(ticket-level), and `buildRunDecisionGraphForRequest` (decision map). All three now hydrate
through `hydrateRunConsequenceForPresentation`, so no two surfaces can derive different
consequences.

Reconstruction applies only when the persisted consequence is materially empty **and** succeeded
mutating receipts exist. It preserves every non-mutation field, never replaces a non-empty
mutation consequence, never counts failed/refused/prepared operations, leaves a genuinely
non-mutating run empty and unmarked, and **never writes back** — reading does not mutate stored
evidence. Provenance is explicit: `mutationConsequenceSource: reconstructed_from_operation_receipts`,
surfaced in run detail ("Reconstructed, not originally persisted") and in the diagnostic bundle
("NOT the terminal record written at the time").

**Query discipline.** The hydration helper returns immediately when the mutation consequence is
materially non-empty, so normally populated runs perform **no** operation-history query. Receipts
are read only for the empty case. `buildTicketTimeline` and the decision-graph builder therefore
issue at most one extra query per historical run; batching was not available at these call sites,
so the bounded per-run read was kept. **Recorded concern:** a ticket with many historical
mutating runs will issue one receipt query per such run (N+1). This is bounded, affects only
pre-fix runs, and is a performance note rather than a correctness issue — worth revisiting if
durable backfill is chosen.

**No silent catch.** An earlier draft wrapped the receipt read in a swallowing `try/catch`; that
would have degraded every surface back to a false "changed nothing", the exact failure this entry
removes. It was deliberately removed so a reconstruction failure surfaces.

**Coverage.** `scripts/run-consequence-mutation-test.js` — **33 assertions**, registered in the
release checkpoint. Proves all four mutation categories at normal terminalization; refused
operations excluded; `already_exists_noop` follows existing builder semantics; non-mutating runs
empty and unmarked; consequence matches succeeded receipts one-for-one; missing `operations`
fails loudly; terminalization reads on its transaction client; historical reconstruction with and
without succeeded receipts; non-empty consequences preserved; non-mutation fields survived;
provenance reaching run detail **and** the diagnostic bundle; and run detail and bundle agreeing
on the reconstructed mutation.

**Natural validation.** The A10-migrated `postcondition-completion-test.js` scenario 6 passes
unchanged, reporting the `writeFile` in `runConsequence.created`. That suite reaches **106
assertions across scenarios 1–15** before an unrelated A10 port defect at scenario 16
(`handoff-valid` timeout), which is out of A16 scope.

**Mutation proofs.** Removing the transaction-local operations load fails the focused test
(*"createFolder is recorded in consequence.created"*) and fails scenario 6 (*"Run consequence
should record created note"*). Disabling historical reconstruction fails the provenance assertion
(*"run detail marks reconstructed data as not the originally persisted record"*). Both restored.

**Durable backfill remains open.** Historical runs are corrected **on read only**; their stored
consequences are still empty. Whether to backfill `run_consequences` durably is deliberately not
decided here — the table is append-only, so any backfill needs its own sanctioned mechanism.

**Reproduction.** Minimal single-turn agent writing one file, dispatched through the normal
ticket path, observed through the store only. Reproduced independently of the A10-migrated
harness, so it is not a porting artifact.

**Not repaired in A10.** Any correction is a runtime-semantic change, which the A10
test-infrastructure tranche forbids.

---

### A15. Postcondition telemetry names a source the event never reaches

| Field | Value |
|-------|-------|
| **Status** | **Open — decision required.** Discovered during A14; deliberately excluded from A14's implemented status |
| **Severity** | Low — a telemetry metric cannot be derived from its documented source |
| **Evidence** | `docs/OPERATIONAL_TELEMETRY.md`; `recordRunEvent` in `server.js`; commit `b7d1763` |
| **Decision required** | Correct the documented telemetry source, or add journal routing for the event |

**Description:**

`docs/OPERATIONAL_TELEMETRY.md` lists:

```
| Postcondition checks | events.jsonl | Count of `run.postcondition_completed` |
```

Production does not write that event to the journal. `run:postcondition_completed` is emitted
through `recordRunEvent`, which writes the **replay snapshot** and the **run log** only:

```js
async function recordRunEvent(run, type, message, details = {}) {
  appendRunLog(run, type, message);
  await appendRunReplaySnapshotItem(run.id, 'events', { type, message, ...details });
}
```

There is no `appendEvent` for this event type anywhere in `server.js`. The documented metric
therefore cannot be computed from its documented source. Note the naming also differs — the
document uses the journal-style `run.postcondition_completed`, while the emitted type is the
replay-style `run:postcondition_completed`.

**Surfaced by A14, not caused by it.** A14's focused regression test initially asserted journal
durability for this event; that assertion was wrong about production, not about the fix, and was
corrected to assert replay and run-log durability — where the event actually lands. A14 changed
no event routing, so this discrepancy predates it and survives it.

**Decision required — two coherent options, not to be chosen here:**

1. **Correct the documentation.** If replay + run log is the intended durability surface, update
   `docs/OPERATIONAL_TELEMETRY.md` to name that source and the correct event type. Cheapest, and
   changes no behavior.
2. **Add journal routing.** If postcondition completion genuinely belongs in the operational
   ledger alongside `run.violations_checked` and `run.violation_detected` — the two neighbouring
   rows in the same table, which *are* journalled — add an `appendEvent` call. This is a
   runtime-semantic change and would need its own tranche and evidence review.

The neighbouring rows being genuinely journalled is why this is a real ambiguity rather than an
obvious documentation typo: the table's other entries are accurate, so the intent behind this
row is not self-evident from the document alone.

**Not to be resolved inside A10.** A10 is test-infrastructure repair.

---

### A14. Redundant-mutation postcondition shortcut does not fire

| Field | Value |
|-------|-------|
| **Status** | **Implemented 2026-07-25.** Surfaced by A10, fixed as its own isolated production tranche |
| **Severity** | High — a documented completion path appears inert |
| **Evidence** | Live probe against `master` `c062af6` + uncommitted A10 tree; operation receipts and replay events below |
| **Decision required** | Is the redundancy shortcut still intended? If so, why does it not fire; if not, the postcondition suite's scenarios 1-3 and 8 must be retired |

**Description:**

`checkPostconditionCompletion` (`server.js`) completes a run when every proposed mutation in a
response turns out to be redundant against current state — `already_exists_noop` for
`createFolder`, and for `writeFile` a `preState` that already exists with content identical to
what the action would write. Four scenarios in `postcondition-completion-test.js` depend on it
(inventory rows 1, 2, 3, 8).

**It does not fire, even though the persisted evidence satisfies every condition it checks.**

A minimal probe ran a two-turn agent that proposed the identical `createFolder pc-folder` +
`writeFile pc-folder/file.txt` batch twice. The second turn's receipts are exactly what the
check requires:

```
{"op":"createFolder","id":3,"preState":{"type":"directory","existed":true},"status":"already_exists_noop"}
{"op":"writeFile","id":4,"preState":{"type":"file","content":"hello","existed":true,"contentHash":"2cf24d…"}}
```

`already_exists_noop` is present; `preState.existed` is `true`; `preState.content` is `"hello"`,
identical to the action's content. Yet the run's replay events are only:

```
run:feasibility_decision, model:action_contract_passed, model:action_contract_passed
```

No `run:postcondition_completed`. The run instead completed through the model's own
`complete:true`.

**Ruled out as port artifacts.** The provider stub, workspace, and objective were reproduced in
an independent probe that does not use the migrated suite. `readFile` returns a string, so the
`preState.content !== action.args.content` comparison is comparing like with like. The
mutating-action cap is not implicated (two mutating actions, cap 2).

**Root cause — proven read-only, 2026-07-25.**

`checkPostconditionCompletion` resolves history with
`postgresRuntimeStore.getOperation(id)` and then requires `historyRecord.preState`:

```js
// server.js, checkPostconditionCompletion
const histories = await Promise.all(historyIds.map(id => postgresRuntimeStore.getOperation(id)));
...
const historyRecord = histories.find(h => h.id === ar.result.historyId);
if (!historyRecord || !historyRecord.preState) return null;   // ← BAILS HERE
if (!historyRecord.preState.existed) return null;
if (historyRecord.preState.content !== action.args.content) return null;
```

`getOperation` (`persistence/postgres/application-state-methods.js`, `async getOperation`)
returns the **raw receipt document** spread over envelope columns:

```js
return { ...(row.receipt || {}), id: ..., runId: ..., ticketId: ..., step: ..., operation: ... };
```

It does **not** apply the receipt projection that `listRunOperations` uses, and that projection
is where pre-state is resolved:

```js
// persistence/postgres/store.js — projection only
preState: document.preState || document.before || intent.preState || null,
```

Pre-state lives on the **intent**, not the receipt document. Probe output, same four receipts,
compared through both paths:

```
id=1 createFolder projection.preState={"existed":false}                    getOperation.preState=undefined  rawStateKeys=["after"]
id=2 writeFile    projection.preState={"existed":false}                    getOperation.preState=undefined  rawStateKeys=["after"]
id=3 createFolder projection.preState={"type":"directory","existed":true}  getOperation.preState=undefined  rawStateKeys=["after"]
id=4 writeFile    projection.preState={"type":"file","content":"hello",…}   getOperation.preState=undefined  rawStateKeys=["after"]
```

The receipt document carries only `after`. `historyRecord.preState` is therefore `undefined`
for **every** receipt, and the guard returns `null` before any content comparison runs.

**Failing comparison:** the `!historyRecord.preState` guard in `checkPostconditionCompletion`
(`server.js`), caused by `getOperation` (`persistence/postgres/application-state-methods.js`)
bypassing the projection at `persistence/postgres/store.js`. `historyId` is correct, present,
and resolves to the right receipt — the identifier is not the problem.

**Scope.** Only operations whose check needs the history lookup are affected — i.e. `writeFile`.
`createFolder` and `deletePath` redundancy is decided from `ar.result.status`
(`already_exists_noop` / `already_missing_noop`) and still fires correctly. That is why
`direct-folder-postcondition-completeness-test.js` passes while postcondition scenarios 1, 2, 3
and 8 do not.

**The shortcut is still an intended live contract.** Evidence, not inference:

- It is wired as the live fallback: `const postcondition = compiledPostcondition || … await checkPostconditionCompletion(…)`
  (`server.js`). The compiled-contract path is a *preference*, not a replacement — with the
  objective compiler off by default, the redundancy shortcut is the only postcondition path.
- Its event is consumed across the runtime: operational-outcome classification
  (`completed_with_verified_postcondition`), failure summary, run summary, log labelling, and
  the run-detail surface.
- It is a **documented telemetry metric** — `docs/OPERATIONAL_TELEMETRY.md`: *"Postcondition
  checks | events.jsonl | Count of `run.postcondition_completed`"*.
- It is referenced by the operator CLI (`scripts/oquery.js`) and seven test scripts.
- **No supersession is recorded anywhere.** A repository-wide search for supersession language
  near "postcondition" returns nothing. The newer contract-based mechanism was added alongside
  it, not in place of it.

Per the A14 discipline, supersession was NOT inferred from the mere existence of the
contract-based path.

### Correction (implemented)

**Shared projection at the repository boundary.** `projectOperationReceipt(envelope, intent)`
in `persistence/postgres/store.js` is now the single canonical way to turn a receipt envelope
into a projected operation record, selecting `targetOperationReceiptProjection` when a prepared
intent exists and `actionOperationReceiptProjection` otherwise. Both `listRunOperations` and
`getOperation` consume it, so the two access paths cannot drift again.

`getOperation` now joins `target_operation_intents` on `(run_id, operation_key)` and projects,
instead of spreading the raw receipt document. The projection's state resolution was widened to
the canonical form for both directions:

```js
preState:  document.preState || document.before || intent.preState || null,
postState: document.postState || document.after || null,
```

`document.preState` is accepted first so alternate/older receipt shapes normalize identically;
current receipts carry pre-state only on the intent.

**Caller audit.** `getOperation` had exactly two callers — `checkPostconditionCompletion` and
the rename verification path in `server.js`. Both want projected records; neither needs the raw
document. An explicitly named `getOperationRawReceipt` is retained as an escape hatch with no
current callers, so any future need for the stored document is explicit at the call site rather
than served accidentally by the normal accessor.

**Affected behavior.** Redundant-`writeFile` batches once again complete through the verified
postcondition path and emit `run:postcondition_completed`. `createFolder` and `deletePath`
redundancy is unchanged — those never used the history lookup.

**Focused regression coverage.** `scripts/operation-receipt-projection-test.js` (22 assertions,
registered in the release checkpoint) proves: pre-state persists on the intent and
`getOperation` resolves it; both access paths agree on `preState`, `postState`, receipt id,
operation identity, prepared-intent linkage, outcome, and recovery fields; a redundant write
emits the event; completion comes from the postcondition path and not from `complete:true`
(no model response in the fixture ever sets it); the event is durable in replay and run-log
evidence; the operational outcome is `completed_with_verified_postcondition`; a non-redundant
write never triggers the shortcut; repeated `createFolder` still reports
`already_exists_noop`; and a receipt storing state as `before`/`after` still normalizes.

**Natural validation.** The A10-migrated `postcondition-completion-test.js` now clears the
previously blocked scenarios with **unchanged expectations** — `postcondition-create-folder-file`,
`postcondition-repeated-write`, and `postcondition-repeated-write timeout-avoided` all record
`run:postcondition_completed` within their step budgets. That suite remains uncommitted A10 work
and still stops later on an unrelated A10 port gap (an unwired `waitForStoredRun` helper in a
workflow-draft scenario); that gap is A10's to close, not A14's.

**Mutation proof.** Restoring the raw `getOperation` behavior fails the focused test at
*"getOperation resolves preState for a prepared operation"* and fails the migrated postcondition
suite at *"run:postcondition_completed was recorded"*. Both detect the regression; the
correction was then restored.

**Adjacent discrepancy, not fixed here.** `docs/OPERATIONAL_TELEMETRY.md` lists *"Postcondition
checks | events.jsonl | Count of `run.postcondition_completed`"*, but this event is written by
`recordRunEvent` to the replay snapshot and run log only — there is no `appendEvent` for it
anywhere in `server.js`, so it has never reached the journal. Recorded here as documentation
drift for a separate decision; A14 changed no event routing.

**Why this was not repaired in A10.** Making it fire is a runtime-semantic change, which A10
explicitly forbids. A10's job was to restore the harness that reveals this — which it did. The
migrated `postcondition-completion-test.js` is fully ported (all 20 scenarios) and is blocked at
scenario 1 by this defect, not by a porting error.

**Decision required.** Either the shortcut is intended and is broken (fix it, then the suite
passes as ported), or the shortcut was deliberately superseded by contract-based completion and
inventory rows 1, 2, 3, and 8 must be retired with that reason recorded.

---

### A13. Tests asserting removed commit-idempotency helpers

| Field | Value |
|-------|-------|
| **Status** | **Resolved 2026-07-26.** All five retired; the two live contracts they guarded are re-expressed behaviorally, registered, and mutation-verified. One residual gap recorded below |
| **Severity** | Medium — five suites were dead; two of the contracts they guarded were NOT covered elsewhere |
| **Evidence** | Failures reproduced against `master` `c062af6`; symbol counts in `server.js` |
| **Decision required** | Retire each suite, or re-point it at the surviving PostgreSQL-enforced contract |

**Description:**

Five scripts fail because they extract and assert helper functions that production no longer
contains. This is **not** the A10 cause: they do not fail on `DATABASE_URL`, and repairing them
is not part of the PostgreSQL-storage migration. Investigation confirmed the causes do not
overlap, so per instruction they are tracked separately rather than folded into A10.

**Exact failures:**

| Script | Failure |
|--------|---------|
| `scripts/execution-semantics-test.js` | `computeMutationFingerprint should exist`; `findConflictingMutation should exist`; `findCommittedMutation should be called in executeWorkspaceOperation`; `rerun endpoint should pass mode to rerunTicketFromBeginning` (1 passed / 5 failed) |
| `scripts/renamepath-conflict-regression-test.js` | `ASSERTION FAILED` on the same extracted helpers |
| `scripts/observed-poststate-regression-test.js` | `buildTargetOperationKey is not defined` |
| `scripts/renamepath-preservation-regression-test.js` | `buildTargetOperationKey is not defined` |
| `scripts/verify-batch-operation-regression-test.js` | `buildTargetOperationKey is not defined` |

**Removed helpers.** `computeMutationFingerprint`, `findConflictingMutation`, and
`findCommittedMutation` each occur **0 times** in `server.js`. The suites extract them from
source text and execute them, so their absence fails the extraction rather than any behavior.
`buildTargetOperationKey` does exist in `server.js` but is not exported into the scope those
scripts build, which is the same class of defect: they depend on internal structure, not
behavior.

**The contract survives — in a different mechanism.** Commit idempotency and conflict rejection
moved from in-process JavaScript helpers to PostgreSQL enforcement: stable operation keys
(`buildTargetOperationKey` + `operationKey`), prepared intent, and the `operation_receipts`
table with its `operation_receipts_idempotency_unique` and `operation_receipts_append_only`
constraints.

**It is already covered.** `scripts/operation-batch-test.js` — in the release checkpoint and
**passing** — asserts exactly these contracts today:

- *"duplicate-commits-skipped: stable keys, prepared intent, receipt reuse, and reconciliation
  prevent repeated effects"*
- *"conflicting-operations-rejected: all four primitives use PostgreSQL receipt authority and
  target locks"*

So the runtime guarantee is not unprotected; only these five source-coupled suites are dead.

**Decision required:** for each of the five, either retire it with the overlap against
`operation-batch-test.js` recorded assertion-by-assertion, or re-point it at the surviving
receipt-based contract. Retirement must not be assumed — `execution-semantics-test.js` also
covers resume deduplication, retry hidden-context, and reassess evidence injection, and the
*reassess* assertion still passes today, so at least part of that file guards live behavior
that must be preserved somewhere before anything is deleted.

**Not to be repaired inside A10.** Investigation established the causes are disjoint.

### Finalized disposition (2026-07-25) — and a correction to this entry's premise

Re-verified by executing all five at HEAD and by counting every symbol in `server.js`.
All five still fail exactly as tabulated above.

**Symbol census — this is what splits the five into two groups:**

| Symbol | Occurrences in `server.js` | Consequence |
|--------|---------------------------|-------------|
| `computeMutationFingerprint` | 0 | genuinely removed |
| `findConflictingMutation` | 0 | genuinely removed |
| `findCommittedMutation` | 0 | genuinely removed |
| `buildTargetOperationKey` | 5 | **live** |
| `captureWorkspacePostState` | 12 | **live** |
| `verifyBatchOperation` | 2 | **live** |
| `rerunTicketFromBeginning` | 3 | **live** |

**The premise above is true for two of the five and false for three.** This entry
states that "the contract they guarded is covered elsewhere" and that "only these five
source-coupled suites are dead". That holds for the two commit-idempotency suites,
whose helpers are gone. It does **not** hold for the three `buildTargetOperationKey`
suites: the behavior they guard is still in the runtime, and retiring them would delete
coverage rather than delete dead weight.

| Suite | Contract it guards | Still live? | Covered elsewhere? | Disposition |
|-------|--------------------|-------------|--------------------|-------------|
| `execution-semantics-test.js` | commit idempotency, conflict rejection via removed helpers | **No** (0 occurrences) | Yes — `operation-batch-test.js` (receipt authority, target locks) | **Retire**, *after* relocating its one live assertion (below) |
| `renamepath-conflict-regression-test.js` | the renamePath conflict carve-out, by source extraction | **No** (extracts `findConflictingMutation`) | **Yes, and better** — `renamepath-runtime-regression-test.js` (A10) now drives all five carve-out cases end-to-end through the real runtime and the real receipt table, and its coverage is mutation-verified | **Retire** |
| `observed-poststate-regression-test.js` | `operation-history.postState` comes from filesystem observation, not from requested args | **Yes** (`captureWorkspacePostState`, 12) | **Partially** — `recovery-regression-test.js` asserts `preState.existed`/`postState.existed` on one operation; the divergence case (filesystem differs from args) is uncovered | **Re-point, do not retire** |
| `renamepath-preservation-regression-test.js` | `batch.verification_failed` emits exact checks when a renamePath destination's type or contentHash diverges | **Yes** (`verifyBatchOperation`, 2) | **No** — `operation-batch-test.js` only asserts the source text *contains* `'batch.verification_failed'`, which is a substring check, not a behavioral one | **Re-point, do not retire** |
| `verify-batch-operation-regression-test.js` | the remaining `batch.verification_failed` checks | **Yes** | **No** — same gap | **Re-point, do not retire** |

**The one live assertion inside `execution-semantics-test.js`.** Of its six, exactly one
passes today: *`reassess-explicit-evidence`: reassess mode injects structured failure
context*. It must land somewhere before that file is deleted. It is unrelated to commit
idempotency and does not belong with the receipt suites.

**Why this was not executed in the A10 tranche.** Retiring test suites, and rewriting
three that guard live-but-uncovered behavior, is a verification-scope decision this
entry itself marks *decision required* — and the third column above shows two contracts
with **no behavioral coverage at all** today. Acting on that unilaterally inside a
test-migration commit would be the wrong place to make it. What has changed is that the
decision is now evidence-backed rather than assumed: the coverage map is complete, the
false premise is corrected, and the sequencing constraint (relocate `reassess` first) is
explicit.

**Recommended sequence when A13 is picked up:**

1. Relocate `reassess-explicit-evidence` into a PostgreSQL-native suite.
2. Retire `execution-semantics-test.js` and `renamepath-conflict-regression-test.js`.
3. Re-point the three `verifyBatchOperation` / `captureWorkspacePostState` suites onto
   the real runtime via `scripts/postgres-test-harness.js`, following the A10 pattern —
   and register them, since the substring check in `operation-batch-test.js` is the only
   thing standing behind `batch.verification_failed` today.
4. Mutation-test the result. `scripts/suite-mutation-test.js` is the template.

### Executed 2026-07-26

All five suites are **retired**. Their coverage was not deleted: the two contracts that
were genuinely live, and genuinely uncovered, are now asserted behaviorally against the
real PostgreSQL runtime.

| Retired suite | Replacement | Why retirement does not reduce protection |
|---------------|-------------|-------------------------------------------|
| `execution-semantics-test.js` | `rerun-mode-evidence-test.js` (new) for its one live assertion; `operation-batch-test.js` for commit idempotency | Its commit-idempotency helpers are gone from `server.js` (0 occurrences), and receipt authority plus target locks are asserted by `operation-batch-test.js` |
| `renamepath-conflict-regression-test.js` | `renamepath-runtime-regression-test.js` (A10) | The replacement drives all five carve-out cases end-to-end through the real runtime and the real receipt table, and is mutation-verified — strictly stronger than extracting `findConflictingMutation` from source text |
| `observed-poststate-regression-test.js` | `operation-poststate-observation-test.js` (new) | Same property, asserted against receipts the running system wrote |
| `renamepath-preservation-regression-test.js` | `operation-poststate-observation-test.js` (new) | Preservation is asserted from the stored receipt's source pre-state vs destination post-state |
| `verify-batch-operation-regression-test.js` | `operation-poststate-observation-test.js` (new), partially — see the residual gap | The reachable half is covered; the unreachable half is recorded rather than pretended |

**What the two new suites assert, and why the negative halves carry the weight.**

`rerun-mode-evidence-test.js` (22 assertions) — a recording provider stub captures every
prompt, so *reassess injects structured prior-failure context* and *retry injects none*
are both asserted against what the model actually received. The retry half is the
load-bearing one: silently injecting a previous failure into every rerun would make
"retry" a different operation than it claims to be and would leak one run's evidence
into a run that never asked for it. **The retired suite could not express this at all** —
a substring match on `server.js` cannot tell whether a function is *called*.

`operation-poststate-observation-test.js` (27 assertions) — an operation receipt must
describe what the filesystem did, not what the model asked for. The discriminating case
is a **refused** mutation: on success the request and reality agree, so success alone
cannot distinguish an observing implementation from an echoing one. A refused
cross-ticket write is used, and no receipt may carry the content hash of bytes that
never reached disk.

**Residual gap, recorded rather than papered over.** `verifyBatchOperation` runs
immediately after each action inside the per-action loop (`server.js`), so its
DIVERGENCE branches — `content_mismatch`, `file_missing`, `destination_content_mismatch`,
`path_still_exists`, `source_still_exists`, `destination_missing`, `folder_missing` —
cannot be reached through the runtime's public surface: nothing can change the
filesystem between an action and its own verification. The new suite covers the
reachable half (verification runs and stays silent exactly when reality matches). Making
the divergence branches reachable requires a test seam in production code, which is a
production change and was out of scope for a test-only tranche. **This is a real gap in
`verifyBatchOperation` coverage and should be decided separately** — either add a
seam in the style of the existing `TEST_INTERRUPT_*` hooks, or accept that those
branches are verified only by inspection.

**Mutation-verified.** Two mutations added to `scripts/suite-mutation-test.js`, both
killed:

| Mutation | Contract removed | Caught by |
|----------|------------------|-----------|
| `reassess-context-always-injected` | prior-failure context is injected for reassess only | the retry half of `rerun-mode-evidence-test.js` |
| `poststate-echoes-request` | post-state is captured by observing the filesystem | `operation-poststate-observation-test.js` |

---

### A12. Bounded workspace-snapshot recovery policy

| Field | Value |
|-------|-------|
| **Status** | **Open — decision required.** Residual of A1; not solved and not approved |
| **Severity** | Medium |
| **Evidence** | A1 implementation (`3f6d4ac`): recoverable-stop branch in `runAgentTicket`, state-aware run-start guard, `runtime/workspace-snapshot-availability.js` |
| **Decision required** | Backoff, attempt cap, operator-attention state, terminal semantics, and manual recovery |

**Description:**

A1 decided that a workspace-snapshot capture failure stops the run recoverably rather than
terminalizing. It did **not** decide how long a run may remain in that state. The behavior
that shipped is therefore a default, not an approved policy.

**Current behavior:**

- One capture attempt per lease-expiry recovery cycle, repeated **indefinitely** for as long
  as the capture keeps failing.
- Cadence is bounded only by the run lease duration (`RUN_LEASE_DURATION_MS`, default 180000).
- While unavailable the run issues **no model request** and performs **no mutation**; committed
  mutations and their evidence are preserved untouched.
- Each cycle appends a `workspace:snapshot_unavailable` transition to the replay snapshot and a
  `workspace.snapshot_unavailable` event to the journal.

**Why this needs a decision:**

- **Unbounded scheduler activity.** A run whose workspace never becomes readable is re-claimed
  and re-entered forever. The work per cycle is small, but the cycles do not stop on their own.
- **Unbounded evidence growth.** Every cycle adds durable replay and journal events, so a
  permanently broken workspace grows a run's evidence without limit.
- **No operator signal.** The run stays `running` and is not surfaced as needing attention.
  Nothing distinguishes "recovering normally" from "stuck since yesterday".
- **Interaction with A3.** The per-attempt wall-clock reset means `maxRuntimeDurationMs` does
  not bound this either: each recovery re-entry starts a fresh clock, so no existing runtime
  limit terminates the cycle. A3 and A12 must be decided consistently — fixing A3 alone would
  silently impose a bound here, and deciding A12 alone leaves that bound dependent on A3.

**Decisions required:**

1. **Backoff** — should retry cadence remain flat at one attempt per lease duration, or grow?
2. **Attempt cap** — is there a maximum number of failed recovery captures, and is it counted
   durably (the counters in A3 reset per attempt, so a naive counter would not survive)?
3. **Operator-attention state** — should a run stuck unavailable become visibly blocked or
   triage-required rather than silently `running`?
4. **Terminal semantics** — if a cap exists, what terminal classification applies, and how does
   it stay distinguishable from the run-start environment/integrity failure?
5. **Manual recovery** — should an operator be able to force a capture retry, or to terminalize
   a stuck run explicitly, rather than waiting for an automatic cycle?

**Explicitly not solved in the A1 tranche.** A1 is marked implemented because the fail-closed
behavior, classification, evidence, and recovery lifecycle are complete and proven. This entry
carries the remaining policy question so that "implemented" is not mistaken for "unbounded
retry was approved".

---

### A11. `truncated:true` is disclosed to the model but never explained

| Field | Value |
|-------|-------|
| **Status** | Open — split out of A1 on 2026-07-25 |
| **Severity** | Low |
| **Evidence** | `RUN_WORKSPACE_SNAPSHOT_MAX_ENTRIES` in `server.js`; the agent system prompt |
| **Decision required** | Whether the system prompt should instruct the model on incomplete snapshots, and what it should then do |

**Description:**

The run-start and per-step workspace snapshots cap entries at
`RUN_WORKSPACE_SNAPSHOT_MAX_ENTRIES` (200) and set `truncated: true` beyond that. The flag
reaches the model in-band — a real strength — but no system-prompt line ever mentions it, so
the model has no instruction for what an incomplete view means or what to do about it. This
compounds with the workload-profile inspection limits (`maxListDirectory` of 2–3), which can
leave a capable model structurally unable to see a workspace root larger than 200 entries.

Split from A1 because it differs on both axes that matter: it concerns *successful* captures,
and any fix changes prompt text sent on **every healthy run**, not only on faults. It
therefore needs its own behavioral decision and its own tests rather than riding along with a
fail-closed change.

---

## Process Profile Phase Snapshot Representation

| Field | Value |
|-------|-------|
| **Status** | Resolved — explicit snapshotted runtime phases implemented by process-execution Tranche 1 on 2026-07-27 |
| **Boundary** | No longer blocks profile admission/advertising; later effect classification must not replace phase authority |
| **Evidence** | `docs/PROCESS_EXECUTION_CONTRACT.md`; `runtime/process-execution-contract.js`; `server.js` `PHASE_OPERATIONS` |
| **Decision** | Store a nonempty canonical `allowedPhases` array on each resolved version-2 profile; accepted values are `inspection`, `mutation`, and `verification` |

**Resolved rule:** a process profile declares its permitted runtime phase; the run
snapshot captures that declaration; the envelope advertises `runProcess` in a phase only
when a snapshotted profile permits that phase; and authorization rechecks the selected
profile against the current phase.

Version-2 snapshots store explicit, deduplicated, canonically ordered `allowedPhases`.
Envelope filtering and dispatch authorization use only that captured array. `runProcess`
remains absent from all global phase catalogs. Effect classification may later inform
sandbox or workspace permissions, but it cannot determine phase authority. Live target
configuration does not participate after admission. Version-1 historical reference
snapshots remain readable but receive no executable authority.

---

## Process Executable Authority and Launch-Plan Boundary

| Field | Value |
|-------|-------|
| **Status** | Resolved through Tranche 2B on 2026-07-28; original Tranche 2 is complete |
| **Boundary** | Authorized version-3 dispatch only through fresh runtime capability, durable PostgreSQL lifecycle, and the proven native launcher |
| **Evidence** | `docs/PROCESS_EXECUTION_CONTRACT.md`; `docs/PROCESS_INPUT_MATERIALIZER.md`; `docs/PROCESS_LAUNCHER_FOUNDATION.md`; `runtime/process-execution-contract.js`; `runtime/process-launch-plan.js`; `runtime/process-launcher-foundation-contract.js` |
| **Decision** | Only a complete version-3 authority snapshot can produce a private immutable launch plan; versions 1 and 2 are permanently executor-free |

**Why version 2 is not executable:** it records a host absolute executable path but no
executable content hash, immutable runtime-root identity, read-only materialized-input
identity, memory/CPU/FD/file/temp ceilings, or explicit immutable filesystem policy.
Interpreting it through later live deployment configuration would rewrite historical
authority. It remains readable and unchanged but can never produce a launch plan.

**Version-3 authority:** catalog version 2 resolves exact rootfs ID/manifest authority,
ELF path/content identity, arguments, working directory, replacement environment,
read-only materialized-input policy, all required resource ceilings, phases, and fixed
execution policy into the admitted run. Canonical JSON and the shared locale-independent
comparator govern snapshot and launch-plan hashes.

**Rootfs trust:** rootfs trees are root-owned, versioned, non-writable by the runtime and
launcher UID, manifest-verified before containment health, and retained while
referenced. Live host system directories and operator home directories cannot substitute.
An operator deployment mapping from rootfs ID to installed path is outside model input and
outside live dispatch authority.

**Execution input (implemented in Tranche 2A1):** no mutable host workspace path appears
in authority or launch plans. The Rust materializer holds the existing PostgreSQL
workspace-root advisory-lock boundary, copies only regular files with descriptor-relative
`openat2` traversal, rejects links and special files, applies a separate versioned
read-exclusion policy, enforces file/byte bounds, creates a service-owned sealed tree,
hashes the canonical output manifest, and rescans identity/type/size/content before
publication. Its canonical fsynced private registry binds the opaque descriptor to the
run, ticket, operation, policy hash, exact canonical filesystem-policy hash, allocation,
generation, manifest, and counts. Startup pins allocation, sealed-state, and socket
directories by descriptor without following symbolic or magic links. Allocation physical
identity affects the materializer generation; configured paths cannot redirect a live
generation. Sealed and socket roots are pre-provisioned through the checked-in
systemd/tmpfiles boundary. The fixed pre-authentication refusal uses `requestId: null`
and preserves `PROCESS_MATERIALIZER_CLIENT_UNAUTHORIZED`; one bounded frame is drained
without parsing after the refusal is sent so transport reset cannot replace the typed
result. The peer UID is never exposed.
`docs/PROCESS_INPUT_MATERIALIZER.md` is the governing design.

**Read-only first launch:** `inputMode` is `materialized_read_only`; writable roots are
empty and cannot be enabled. Writable process effects require a later independent
authority and bounded-copy-out decision.

**Network meaning:** `networkAccess: none` prohibits communication outside the operation
sandbox. Tranche 2A3 enforces a fresh network namespace, no host interfaces/socket
mounts/inherited sockets, and a pinned seccomp policy denying external socket creation.
Unnamed operation-local IPC such as Unix `socketpair` remains permitted.

**Launch-plan boundary:** the plan is private runtime-to-launcher material, derived only
from an immutable v3 run snapshot plus a trusted materialized-input descriptor. It is
closed, bounded, versioned, canonically hashed, deeply frozen, and absent from the model
envelope. Version 3 remains non-dispatchable until a future healthy sandbox capability
generation is an additional gate.

**Integrity correction:** absence from the model envelope is not itself
non-dispatchability. Version-3 resolution now fails closed as
`PROCESS_SANDBOX_UNAVAILABLE` with denied authority unless a closed, healthy, time-bounded
sandbox capability descriptor is supplied. The current runtime supplies none. Historical
version 2 retains only its executor-unavailable compatibility refusal.

The private builder now accepts a closed `{runId, ticketId, currentPhase,
processPolicySnapshot}` context, derives operation identity from `(runId, operationId)`,
and binds the workspace descriptor to the run, policy hash, and capability-approved
materializer generation. The launch hash also binds the launcher protocol, launcher,
sandbox backend, seccomp policy, rootfs-registry, and materializer generations. Tranche
2A1 now provides the trusted opaque-workspace registry and exact `getSnapshot`
revalidation; launch-plan construction remains disconnected from dispatch.

Launcher capacity is a pre-start `failed_to_start` cause and cannot be represented as
`resource_limit_exceeded`, which is reserved for enforcement against an established
process operation.

**Launcher protocol:** launcher-owned restricted Unix socket, `SO_PEERCRED`
validation against the exact service UID, closed bounded messages with a fixed maximum
size of 2,097,152 bytes, no client host mount paths, raw sandbox options, raw cgroup names,
or unsandboxed fallback. The mandatory barrier is create cgroup → set every limit → create blocked child
→ move and verify membership → release → execute.

**Cross-UID release gate:** sealed ownership is not proven by same-UID chmod. The
dedicated Linux test uses distinct launcher, materializer, runtime, trusted-rootfs, and
unauthorized identities and is mandatory whenever process execution is enabled. On
2026-07-28 the current host executed it successfully inside a systemd-delegated
subordinate-UID namespace; the active gate also proves durable interrupted-operation
replay after launcher restart.

**Tranche 2A2 resolution:** the materializer now holds a kernel lifetime lease before
any staging, registry, or socket mutation. A separate Rust launcher-foundation service
pins trusted rootfs/manifest/backend/seccomp/cgroup identities, validates a canonical
complete rootfs manifest, freshly verifies rootfs-internal ELF identities, and exposes
only authenticated `health`, `getRootfs`, and `verifyExecutable` operations. Its
rootfs-registry generation binds complete trusted configuration, launcher/backend/policy
bytes and physical identities, every rootfs manifest and physical identity, protocol,
and manifest schema. The runtime can form only a private, expiring
`prerequisites_verified` descriptor with `readyForExecution: false`; this descriptor is
deliberately incompatible with the healthy sandbox capability contract.
`docs/PROCESS_LAUNCHER_FOUNDATION.md` is the governing design.

**Tranche 2A3 resolution:** systemd `Delegate=cpu memory pids` supplies the actual
service cgroup; the launcher derives it from `/proc/self/cgroup`, proves controller
write/readback and blocked-child membership, and binds its physical identity into an
expiring active generation. The materializer passes the exact sealed tree and manifest
with launcher-only `SCM_RIGHTS`. A fixed Bubblewrap plan uses pinned rootfs/workspace
descriptors, fresh mount/PID/network/IPC/UTS/user/cgroup namespaces, a private bounded
tmpfs, a private `/proc` and `/dev`, cleared environment/capabilities, `/dev/null` stdin,
and the pinned installed seccomp policy. Operation cgroups enforce tasks, memory/swap,
and CPU rate; rlimits enforce descriptors/file size/core; streaming raw-byte monitors
enforce combined output and monotonic wall time. Cancellation, timeout, output, and
observed cgroup violations kill the whole tree and wait for `populated 0`.

The active fixture proves network/filesystem/process/seccomp/environment isolation,
process/thread/memory/output/time/resource limits, double-fork/session resistance,
launcher-crash descendant death, stale-cgroup restart cleanup, and the fixed
`/usr/bin/node --check /workspace/server.js` compatibility profile. CPU quota is
truthfully a throttle and no longer a terminal resource cause.
`docs/PROCESS_LAUNCHER_FOUNDATION.md` is the governing design.

The private generation is deliberately not assigned to a mutable
`CURRENT_PROCESS_SANDBOX_CAPABILITY`. Tranche 2B resolves fresh native health into a
closed `process-runtime-v1-<sha256>` generation only while the feature flag, migration
029 lifecycle schema, artifact store, materializer, containment, rootfs/ELF authority,
protocol versions, and mandatory release gates all match.

**Tranche 2B resolution:** `process_operations` binds one immutable launch plan to the
canonical run-scoped operation identity before any launcher call. PostgreSQL advisory
locks and revision-guarded state transitions enforce
`intent → active → finalizing → terminal`. The Rust launcher persists acceptance before
child release, preserves terminal tombstones across restart, and exposes bounded
terminal-only output chunks with cleanup acknowledgement. The runtime independently
verifies and atomically publishes raw stdout/stderr artifacts, records append-only
authority/terminal/artifact evidence and a generic operation receipt, and acknowledges
launcher output only after durable finalization. Interruption, lease expiry, startup,
Node crash, and launcher restart reconcile without duplicate execution or invented
terminal facts.

This completes the durable lifecycle and recovery capabilities originally expected from
Tranche 3 and the enforceable sandbox capabilities originally expected from Tranche 4.
They must not be reintroduced as parallel subsystems.

**Tranche 3 integrity completion:** the authoritative roadmap is now persisted in
`docs/PROCESS_EXECUTION_ROADMAP.md`. Scheduler lease-expiry recovery invokes the existing
durable process cancellation authority immediately after fencing the stale owner and
before ordinary reconciliation can resume the run. Accepted/active operations therefore
reach the launcher's one terminal result and finish artifacts, evidence, receipt, and
output acknowledgement before stale-run recovery completes; finalizing and terminal
operations only finish their existing idempotent obligations. A natural-completion race
preserves both the durable cancellation request and the launcher result. The real
PostgreSQL scheduler seam is covered by
`scripts/process-lease-expiry-cancellation-postgres-test.js`.

Generic `runProcess` receipts now also participate in ordinary run consequence
reconstruction through a closed `processOperations` projection. That projection records
only durable operation/target/profile/outcome/result-hash and bounded artifact metadata;
it cannot claim a workspace mutation, expose raw/private authority, or alter completion
semantics. Restart replay and unchanged workspace/browser behavior are covered by
`scripts/process-consequence-reconstruction-test.js`.

**Tranche 6 completion decision:** every newly admitted run now captures immutable
completion authority from the recognized objective contract, declared postconditions,
and admitted `when_declared` verification policy. The existing immutable
`run_consequences` record stores one canonical hashed completion decision with separate
execution, verification, and objective-completion dispositions. Required bounded
`run.completion_decided` evidence is appended in the existing PostgreSQL terminalization
transaction before the terminal lifecycle event and is repaired idempotently after
restart.

The evaluator consumes only durable facts, receipts, consequence projections, declared
postconditions, and admitted policy. Exact process-operation, process-terminal-outcome,
and process-artifact predicates reuse `processOperations` and existing process evidence;
workspace and browser verification retain their canonical paths. Missing or
contradictory authority fails closed, raw process output is not interpreted, and model
completion prose is retained only as a non-authoritative claim. Ticket projection for a
current run follows the persisted completion disposition rather than its overloaded run
status. Historical runs without admitted completion authority retain explicit
compatibility behavior.

Tranches 3, 4, 5, 6, and 7 are complete; Tranche 8 is next and remains not started.
Tranche 7 adds only the derived, bounded `processSupervision` projection on existing
run-detail/state/CLI surfaces and authorized delegation from the existing run stop route
to the canonical cancellation controller. Existing authority, materialization,
launcher, containment, lifecycle, budgets, scheduling, artifact, evidence,
cancellation, completion, consequence, receipt, supervision, and recovery systems are
mandatory reuse points, not subsystems to rebuild.

---

## Workspace Operation Error Handling

| Field | Value |
|-------|-------|
| **Status** | Unresolved inconsistency |
| **Documentation** | Recoverable |
| **Implementation** | Terminal |
| **Evidence** | See `docs/archive/DOCUMENTATION_IMPLEMENTATION_DIVERGENCE.md` |
| **Decision required** | Which behavior is authoritative? |

**Description:**

The documentation (`docs/OPERATIONS.md`, `docs/STATE_SURFACES.md`) claims that workspace operation failures are recoverable feedback returned to the model. The implementation (`server.js`) treats all filesystem errors (except `listDirectory` ENOENT) as terminal failures that immediately end the run. Both behaviors have co-existed since the initial commit on 2026-05-19. No reconciliation has occurred.

---

## Event Log Stream Semantics

| Field | Value |
|-------|-------|
| **Status** | Open questions; classification contract documented |
| **Classification authority** | `docs/EVIDENCE_VS_TELEMETRY.md` (intent: evidence only; practice: evidence + telemetry) |
| **Evidence** | `docs/archive/EVENT_LOG_INTENT_REVIEW.md`, `docs/archive/SCHEDULER_TICK_REVIEW.md` |
| **Decision required** | Whether and how to reconcile `events.jsonl` practice with the evidence-only intent (stream separation, filtering, retention) |

**Description:**

Open questions merged from `UNRESOLVED_EVENT_LOG_QUESTIONS.md` (recorded 2026-05-28; original preserved at `docs/archive/UNRESOLVED_EVENT_LOG_QUESTIONS.md`).

### 1. Should operational history contain telemetry?

`AGENTS.md` defines `events.jsonl` as "append-only operational history."

- Does "operational history" mean a record of operations the system performed, or does it include observations of system state?
- Is a `scheduler.tick` event (pendingRuns count every 500ms) an operation or an observation?
- Is `run.heartbeat` (lease metadata on every model request) an operation or an observation?
- If operational history includes observations, what observations are in scope and which are out of scope?
- If operational history excludes observations, what stream should observations use?

### 2. Should evidence and telemetry share a stream?

The same `events.jsonl` file is:
- A "source of truth" for projection rebuilders and replay reconstructors
- A "ledger" from which telemetry metrics are derived

- Is sharing a single append-only stream between state reconstruction and observational metrics intentional or incidental?
- If shared intentionally, is there a documented rationale?
- If shared incidentally, was a separation ever considered and rejected?
- What is the cost to projection rebuilders of scanning telemetry events that carry no reconstructive value?
- What is the cost to telemetry consumers if telemetry events are separated from the reconstructive stream?

### 3. What properties distinguish reconstructive events from observational events?

Currently, the distinction is implicit:
- `run.started`, `workspace.operation`, `execution.phase_transition` — consumed by replay/reconstruction
- `scheduler.tick` — not consumed by replay/reconstruction
- `run.heartbeat` — partially consumed (phase map, provider request proxy)

- Is the distinction defined by whether the event has a `runId`? (`scheduler.tick` has no `runId`; most reconstructive events do.)
- Is the distinction defined by whether the event is hashed/sequenced in the run event chain? (`scheduler.tick` is not sequenced; most run events are. `run.heartbeat` is sequenced.)
- Is the distinction defined by whether the event changes mutable state? (`scheduler.tick` does not mutate `runs.json`; most reconstructive events do.)
- Is the distinction defined by consumer usage? (If a new consumer starts using `scheduler.tick` for reconstruction, does it change categories?)
- Is there a formal taxonomy of event types that the substrate intends to maintain?

### 4. Should retention differ by category?

`events.jsonl` is append-only. No documented expiration or compaction exists.

- Should reconstructive events be retained indefinitely?
- Should observational events (e.g., `scheduler.tick` with `pendingRuns: 0`) be retained indefinitely?
- If observational events are not retained indefinitely, what is the minimum retention needed for telemetry accuracy?
- If observational events are compacted or expired, does the "append-only" contract apply uniformly or per-category?
- Does the telemetry system's determinism guarantee (same ledger → identical report) require all historical ticks, or only ticks during active runs?
- If retention differs by category, how does the system express that policy? (File-level? Event-type-level? Consumer-level?)

### 5. Should replay consumers ignore categories explicitly or implicitly?

Current behavior:
- `scripts/projection-rebuilder.js` ignores `scheduler.tick` (no `runId`, so it is not grouped by run)
- `scripts/replay-reconstructor.js` ignores `scheduler.tick` (not referenced in reconstruction logic)
- `scripts/event-chain-verify.js` counts `scheduler.tick` as `nonRunEvents` but does not flag it as an error

- Should replay/reconstruction tools explicitly filter out known observational event types?
- Should replay/reconstruction tools implicitly ignore events they do not recognize?
- If explicit filtering is preferred, where is the filter list maintained?
- If implicit ignoring is preferred, what prevents an observational event from being accidentally reconstructed into a run state?
- Should the event chain verifier treat non-run events as valid (current behavior) or as a warning?
- Should tests that assert event log contents (e.g., "events.jsonl should include scheduler.tick") be considered part of the contract, or are they implementation-detail assertions that could be removed without semantic impact?

### 6. Additional open questions

- Should `appendEvent` enforce any boundary on what event types may be emitted, or should it remain an unrestricted append surface?
- Should telemetry events carry the same forensic metadata (seq, prevHash) as run events, or is the absence of seq/prevHash on `scheduler.tick` a signal that it is not part of the reconstructive chain?
- Is the `OPERATIONAL_TELEMETRY.md` principle "Evidence-only" ("Every metric is computed from persisted ledger files") intended to mean "metrics are derived only from evidence," or "metrics are derived from whatever is in the ledger, including telemetry"?
- If the event log grows by ~120 lines/minute on an idle system, at what point does file size become an operational concern for append performance, read performance, or storage cost?

---

## complete:true Under Per-Response Action Caps

| Field | Value |
|-------|-------|
| **Status** | Substantially resolved in runtime (audited 2026-07-17); entry retained for the record |
| **Surfaced** | 2026-06-18, during live validation of the relative-objective anchoring fix (`83aead9`) |
| **Evidence** | Live gpt-4.1-mini run: first response proposed E/F/G with `complete:true`; the per-response mutation cap (`MAX_MUTATING_ACTIONS_PER_RESPONSE`, default 2) executed only E/F; later steps created G; net outcome correct |
| **Decision required** | Whether a capped, partially executed response may honor `complete:true` |

**Description:**

`complete:true` in a capped response does not mean the requested target state was
fully applied — it means "complete as proposed," while the runtime may have dropped
proposed actions beyond the cap. In the observed run the runtime continued and the
outcome was correct (this is NOT the moving-goalpost bug, which is fixed and
validated), but in other scenarios a capped + `complete:true` response could
terminate a run before the full target state is applied — a potential correctness
gap, not just display clarity.

Open questions for the diagnosis:

- Should the runtime ignore/override `complete:true` when any proposed actions were dropped by per-response caps?
- Should run detail surface "response proposed more actions than were executed"?
- Should the continuation prompt explicitly state that only the first N actions were executed and the rest were not applied?
- Should replay show capped/skipped proposed actions separately from executed actions?
- Is this a correctness gap anywhere in current behavior, or only a clarity gap? (Start in `runAgentTicket`: confirm how `complete:true` is honored when actions were truncated.)

**Resolution status (audited 2026-07-17):** the runtime now answers the first and third
questions directly — when per-response caps drop proposed actions, the continuation message
states how many executed, how many were dropped, and that "`complete:true` was not honored …
continue from the executed state and re-emit the remaining action(s)" (see the
`truncatedMessage` construction in `server.js`). The second and fourth are answered by the
run page's Parsed Model Plans section (per-plan complete flag and proposed actions,
comparable against Workspace Actions). No further diagnosis is pending; reopen only if the
cap-feedback path regresses.

---

## Structured Allocation Leaf-Run Retry Boundary

| Field | Value |
|-------|-------|
| **Status** | Deliberately deferred by Tranche 3 (2026-07-31); fail-closed, not a defect |
| **Surfaced** | 2026-07-31, implementing structured-allocation leaf-run admission |
| **Evidence** | `runtime/structured-allocation-leaf-run-contract.js`, `persistence/postgres/store.js` (`admitStructuredAllocationLeafRuns`, `reconcileStructuredAllocationLeafItems`), `scripts/structured-allocation-leaf-run-postgres-test.js` |
| **Decision required** | Whether, and how, a failed structured leaf Run may be retried while preserving the same immutable allocation-item authority |

**Description:**

Tranche 3 admits exactly ONE initial Run per immutable Allocation Plan v2 item. It
does not retry a failed leaf.

The existing retry seam cannot be reused as-is. `createRetryRun()` persists a run
draft built by `prepareAgentRunDraft()`, which does not carry a leaf binding — the
binding is derived by the store during leaf admission and hashes the
runtime-assigned Run ID, so a retry would need its own freshly derived binding for
the same allocation item. Separately, `assessAutoRetryAfterFailureIfPolicyAllows()`
already refuses every owned-scope ticket (`unsupported_ticket_shape`), so automatic
retry cannot reach a structured leaf today by either route.

The tranche therefore fails closed: a failed leaf item resolves to a `failed` item
and prevents aggregate completion, and there is no automatic second attempt. The
aggregate decision already represents a per-item `runLineage`, and
`reconcileStructuredAllocationLeafItems()` already decides an item from the most
recent Run bound to it, so a future retry that preserves the same allocation-item
authority is expressible without a schema change or a new primitive.

Open questions for the diagnosis:

- Should a structured leaf retry exist at all, or should a failed item require operator reopen?
- If it exists, must the retry Run carry a NEW binding over the same allocation item, and must the binding record its predecessor explicitly rather than only through `runLineage`?
- Should the per-item attempt ceiling come from the existing runtime budget (which currently counts one attempt per allocation plan, not per item), or from a new per-item bound?
- Does a retried leaf invalidate the item's prior completion-decision identity, or is the lineage's latest valid decision sufficient?
- Should partial retry of a multi-item plan be permitted while sibling items are still running?

## Governed Response-Hash Tamper Has No Scenario (recorded 2026-08-02)

**Status:** open — test-coverage gap, not a known defect.

Governed recovery rehydrates request 1's transcript from canonical response
replay and verifies it against the response hash the reservation recorded at
dispatch. Removing that verification fails no test, because nothing constructs a
mismatch.

An attempt this session altered the stored transcript while leaving its hash —
the shape a partial write or edited replay row would leave. Two useful things
came out of it and are worth keeping:

* the replay table refuses an update that does not advance its revision, which
  is a real durability guard;
* with the transcript tampered, the Run executed NOTHING — the injected action
  never ran and no request 2 was issued.

What could not be shown in the time available is that the refusal surfaces as
the canonical integrity error on a durable, observable Run state: the Run stayed
in `running` across the observation window rather than terminalizing with
`GOVERNED_RESPONSE_REHYDRATION_CONFLICT`. Whether the guard fires and the Run
merely retries, or the mismatch is absorbed somewhere earlier, is UNRESOLVED.
The scenario was removed rather than committed in a failing state.

**What would close it.** Determine where a rehydration conflict lands in the
attempt lifecycle, then assert the durable integrity signal alongside the
already-observed absence of effects, and mutation-test removal of the hash
check against it.


## Governed Request Delivery Uncertainty (recorded 2026-08-02, resolved as fail-closed)

**Status:** closed as a design position, not as a defect. Exactly-once external
transport is NOT claimed.

A governed request commits its reservation, ordinal, budget charge and
provider-request replay, and `markEconomicRequestStarted` runs before any byte
leaves. There is no marker that could fix this: a database transaction is not
atomic with a network send. A marker written before the send cannot prove bytes
left; one written after cannot be guaranteed to exist when they did. Adding one
would buy the appearance of certainty and none of the substance, so none was
added.

The runtime therefore treats a reservation in `request_started` with no durable
response as UNDECIDABLE and fails closed under
`GOVERNED_REQUEST_DELIVERY_UNCERTAIN` / `governed_request_delivery_uncertain`.
It does not retransmit: a second send could pay for and apply a second answer to
a request the provider already served.

Two crash points prove the position, and prove production cannot tell them
apart — which is the point:

* `governed-pre-transport-restart-postgres-test.js` — zero bytes sent;
* `governed-post-transport-restart-postgres-test.js` — the provider demonstrably
  received the request, then the process died before the response was durable.

Both yield the same durable outcome: one ordinal, one charge, one reservation,
one request replay, no response, no progress window, no churn increment, no
progress block, no second transport, and an idempotent reason across repeated
restarts.

**Consequence, stated plainly.** A request the Ticket paid for can end
unanswered, and no automatic recovery will complete it. That is a deliberate
trade: an unanswered paid request is recoverable by an operator, while a
duplicated external send is not.

**Not claimed.** No progress window exists until a durable response and its
required evidence exist. Automatic retransmission of an ambiguous started
request is unsupported.

## suite-mutation-test Stale Anchor: closed 2026-08-04

**Status:** closed. Supersedes the entry recorded when the failure was only
observed, not diagnosed.

The `owned-path-scope-broadened` mutation aimed at `server.js`, where the owned
-path containment rule used to live. `350809f` moved it to
`runtime/authority-paths.js` so the enforced rule and every operator-visible
listing (admin dashboard, oquery CLI) could not drift, and reformatted it across
two lines. **The invariant still exists — only the textual anchor was stale.**

What remains in `server.js` is `matchedOwnedRootForEntry`, which documents
itself as display-only and as merely reusing this containment shape. Aiming
there would mutate a label rather than an authority, and the out-of-scope write
would still be refused, so the mutation would have survived while looking
repaired.

Re-aimed at `runtime/authority-paths.js`; killed by
`allocation-scope-authority-test.js` in 5.5s. Unmodified control passes, source
is restored and SHA-256-verified, and an equivalent refactor of the same
function produces no false hit.

## Structured-Leaf Terminal-State Representability (recorded 2026-08-04)

Classification of the nine terminal states, from source and from the refusals
the database actually raises. Recorded because several are NOT missing tests —
they are states the system refuses to represent, and the refusal is the proof.

| # | State | Classification |
|---|---|---|
| 1 | valid completed leaf + canonical decision | production path |
| 2 | completed, decision missing | controlled fixture (status written, evidence withheld) |
| 3 | decision bound to wrong Run/Ticket | controlled fixture (internally valid, wrongly bound) |
| 4 | completion-authority mismatch | controlled fixture; **not observable in Ticket projection** |
| 5 | decision conflicts with Run status | controlled fixture |
| 6 | replay-integrity failure | production path (existing corruption scenario) |
| 7 | verified_progress_exhausted | production path |
| 8 | undeclared_sibling_dependency | production path |
| 9 | uncontained replay corruption | controlled fixture |

Findings that changed how these must be proved:

* **A stored decision cannot be corrupted in place.**
  `normalizeCompletionDecision` recomputes `decisionHash` over every other
  field, so editing `runId` in the database yields
  `COMPLETION_DECISION_INVALID` — a different failure than the binding rule
  under test. Cases 3-5 need a decision that is internally consistent and
  wrongly bound, built through the canonical builder.
* **One malformed decision per Run, by construction.** `run_consequences` is
  keyed by `run_id`, requires `ticket_id` to match the Run's through a
  composite foreign key, and is append-only (the evidence-mutation trigger
  refuses UPDATE and DELETE). Cases cannot be staged by overwriting; each needs
  its own admitted Run.
* **Terminal Runs cannot be reopened**, so one Run cannot serve two malformed
  cases in sequence.
* **Case 4 was unobservable in Ticket projection — and that was a defect, not
  a property.** CORRECTED 2026-08-04. The projection passed
  `runCompletionAuthorityHash: null`, which the shared rule reads as "no
  opinion", so it never reported `completion_authority_mismatch`. That rule
  exists for a caller genuinely holding no comparable hash; this caller held
  one. `projectedStatus` guards on `item.completionAuthoritySnapshot` in order
  to reach the evaluator at all, and allocation reconciliation compares against
  exactly `run.completionAuthoritySnapshot.objectiveContractHash`. So a
  structured leaf could present a decision built against a DIFFERENT objective
  contract, be called a mismatch by reconciliation, and be projected
  `completed` by the Ticket in the same breath.

  **Verdict: STRUCTURED TICKET PROJECTION CAN VALIDATE COMPLETION AUTHORITY.**
  The projection now supplies the hash it already holds — the existing durable
  field, not a reconstruction. A generic Run is unaffected: the guard returns
  its status before the evaluator is reached, so no Run without structured
  authority can fail for lacking it. Both domains are asserted.

`COMPLETION_EVIDENCE_MISSING` is ONE code carrying DIFFERENT closed reasons
(`completion_decision_missing`, `completion_decision_stale`,
`completion_authority_mismatch`, `completion_decision_conflicts_run`). A
projection collapsing them would still refuse, and would still pass a test
asserting only the code, so the reason is asserted every time.

**Still open from this matrix:** fresh-process (stop-server/restart) projection
for cases 1, 6, 7 and 9; cross-surface parity across Ticket page, Run Detail,
Ticket/runtime APIs, allocation reconciliation, parent aggregate and CLI; and
the restart/scheduler before-and-after count matrix.

## Sibling Refusal's failureKind: closed 2026-08-04

**Status:** closed. Supersedes the entry recorded when the value was only known
to be inert.

**Verdict: FAILURE_KIND IS ADVISORY BUT OBSERVABLE METADATA** — and the
specific value `no_progress` was inert on the sibling-dependency path.

Consumer inventory. `buildRunTriage` maps `failureKind` to a reason code for a
CLOSED set only: `protected_path`, `provider_error`, and the runtime-budget
kinds (`runtime_budget_insufficient`, `runtime_budget_exhausted`,
`runtime_duration_exhausted`, `deterministic_infeasibility`). A few call sites
test `protected_path` or `workspace_error` directly. Nothing anywhere reads
`no_progress` as a failure kind — the three writes have no matching read, and
`model:no_progress` is an unrelated EVENT type. So it controlled no durable
classification, no retry eligibility, no aggregation and no completion
semantics; anything unmapped falls through to `runtime_failed`.

But the field is not inert as a FIELD: `buildRunFailure` returns a record only
when `error.failureKind` is set, or for three specific codes. With it removed,
the sibling refusal falls through every branch and returns **null**, losing the
durable `GOVERNED_SIBLING_READ_BLOCKED` code and the sibling detail. Deleting
it would therefore have destroyed observable evidence to remove a misleading
label.

Minimal correction: keep the field, replace the borrowed value with
`sibling_dependency_blocked`, which describes this refusal instead of implying
churn/progress semantics the system does not honour. Triage, retry, aggregation
and completion are unchanged — unmapped kinds already produced `runtime_failed`.
No new triage category was invented.

The coordination refusal continues to be distinguished where it always was: the
canonical progress block's reason, sibling allocation item, sibling Run,
requested path, `siblingDependencyBlocked` flag and hash. Automatic retry
remains prohibited through the triage owner, not through this field.

## Duplicate-Dispatch Outcome Anomaly: closed 2026-08-04

**Status:** closed. Supersedes the "unreproduced" entry recorded earlier the
same day, which was honest about not knowing the cause and is replaced now that
the cause is proved rather than guessed.

The observation — one transport, one reservation, one ordinal, and NO caller
reporting `received` — is reproduced deterministically by a barrier that holds
the dispatch owner at a chosen boundary instead of racing the scheduler. Two
distinct defects were behind it:

1. **A rejected owner vanished from the accounting.** The duplicate-concurrency
   test filtered to FULFILLED outcomes, so an owner whose post-transport
   persistence threw contributed nothing and left a bare count with no
   explanation. Every caller is now accounted for, rejections included with
   their error code. The runtime behaviour here was and remains correct: a
   response that could not be made durable is one no caller may claim.

2. **A caller that lost the start race reported `already_dispatched_unresolved`
   — the same status `closeUnconfirmed` returns for an ABANDONED request it
   settled at the reserved maximum.** Worse, the losing path never consulted the
   claim-aware classifier that every other observer goes through, so the two
   ways of discovering "somebody else started this" could disagree. Both now
   resolve through one authority, `resolveStartedRequest`.

The correction that mattered most is narrow: a caller that just lost the atomic
start transition has FIRST-HAND evidence of a live concurrent owner, which is
strictly stronger than a lease read. Unifying the two paths naively made such a
caller settle books the winner still owned whenever the lease could not see the
winner — an unleased Run, another process's lease, or one expired mid-flight.
`concurrentStartObserved` keeps that distinction explicit.

The dispatch owner never enters this authority at all. It holds its result
linearly from the start transition through transport and durable persistence to
its own returned outcome, so it can never be told its own live request belongs
to somebody else.

## Governed Claim Ownership: closed 2026-08-03

**Status:** closed. Recorded because the path to it corrected two of my own
earlier claims.

Request starts are bound to the append-only `position` of the
`run.lease_acquired` event the INITIATING attempt resolved at entry, validated
transactionally against the governing claim. A superseded claim is refused
(`ECONOMIC_REQUEST_STALE_CLAIM_ATTEMPT` /
`governed_leaf_stale_claim_attempt`) rather than silently rebound to whatever
claim is newest at write time.

Two corrections along the way:

* comparing `started_at` against the claim timestamp was described as claim
  identity in an earlier handoff. It is not — `clock_timestamp()` has finite
  resolution and clock order is not append order;
* deriving the claim inside the store was described as making the binding "a
  fact rather than an inference". It removed caller trust but introduced a
  different error: a caller that began under claim A, paused, and resumed after
  reclaim would have its request recorded against claim B.

The equal-timestamp collision that the database refuses to stage — three
integrity mechanisms reject it — is now proved as data by
`scripts/governed-request-claim-classification-test.js`, against a pure
classifier that takes no timestamps at all and says so by source assertion.

## Parent–Fixture Hash Handshake: NOT REQUIRED (recorded and closed 2026-08-03)

**Status:** closed as a design position.

The governed request body exposes no Run, source or ordinal identity
(`runtime/provider-request-body.js:33`), and the transport adds no identifying
header (`runtime/governed-openai-transport.js:62`), so keying staged responses
by canonical identity would need a synchronous parent–fixture control protocol.
That protocol is not built, and is not needed, because every property it would
have bought is established another way:

* production request identity is bound to `exact_request_hash` and its economic
  reservation — the fixture's staging has no bearing on it;
* cross-Run ownership is isolated: a planner or sibling request cannot consume a
  leaf response, and crash boundaries belong to staged request matches rather
  than a global arrival count;
* requests within one Run are SEQUENTIAL, proved from durable row ordering —
  request 2's reservation is created only after request 1 has a durable
  response and turn 0's receipts and postcondition evidence have committed, so
  two turns cannot race for a staged answer;
* persisted response identity is verified against canonical execution turn;
* swapping the request-1 and request-2 responses fails deterministically in one
  run;
* lifecycle stability is 30/30.

**Stated precisely.** Staged order is NOT production authority. It is
deterministic scenario sequencing whose result is independently verified against
canonical turn identity, in a system where the requests it sequences cannot
overlap.

## Malformed Success Is Hard to Persist (recorded 2026-08-03)

**Status:** informational — defense in depth worth knowing about.

Constructing a Run that claims `completed` without valid completion evidence is
resisted by the database itself, not only by projection. In sequence, direct
writes hit: pending runs cannot complete without entering running;
`runs_lifecycle_timestamps`; `runs_terminal_phase_shape`;
`runs_current_phase_check`; and finally "terminal runs cannot be reopened".

`malformed-completion-projection-postgres-test` therefore proves ONE case —
`completed` with no decision is refused with `COMPLETION_EVIDENCE_MISSING`, the
Ticket status is unchanged, and no synthetic decision is created. The intended
failed/interrupted contrast could not be built on the same Run because terminal
Runs cannot be reopened; that half is covered where it occurs naturally, in
`governed-replay-corruption-postgres-test`.

Constraints were NOT disabled to build a richer scenario. Doing so would have
proved something about a database this system does not run on.

---

*Corrupted Replay Snapshot Recovery Loop recorded, diagnosed and closed 2026-08-03 by scripts/governed-replay-corruption-postgres-test.js. Ticket Projection Over Failed Leaf recorded and closed 2026-08-03. Run Detail Page Over Corrupt Transcript recorded and closed 2026-08-03. Replay-Availability Field Unasserted recorded and closed 2026-08-03. Duplicate Terminal-Leaf Derivations recorded and closed 2026-08-03 (one shared authority, both consumers). Governed Lifecycle Transport-Count Flake recorded and closed 2026-08-03 (fixture arrival counter conflated with canonical ordinal). Intermittent Guard Mutation Limit recorded and closed 2026-08-03 (deterministic correlation contract). Fixture Crash Boundary Arrival Counter recorded and closed 2026-08-03. Parent-Fixture Hash Handshake recorded and closed as NOT REQUIRED 2026-08-03. Concurrent-Duplicate Misclassification regression recorded and closed 2026-08-03 by claim-epoch classification. Malformed Success Persistence Resistance recorded 2026-08-03. Replayed Recovery Window Churn recorded and resolved 2026-08-02. Governed Request Delivery Uncertainty recorded and resolved 2026-08-02. Governed Response-Hash Tamper recorded 2026-08-02. Workspace Operation Error Handling recorded 2026-05-28. Event Log Stream Semantics merged 2026-06-12 from `UNRESOLVED_EVENT_LOG_QUESTIONS.md` (2026-05-28). complete:true Under Per-Response Action Caps recorded 2026-06-18, ported to this document 2026-07-16. Structured Allocation Leaf-Run Retry Boundary recorded 2026-07-31. Governed No-Progress Refusal Coverage recorded and closed 2026-08-02. Recovered Governed Run Resume recorded and closed 2026-08-02 by scripts/governed-authorized-restart-postgres-test.js by scripts/governed-no-progress-withholding-postgres-test.js.*

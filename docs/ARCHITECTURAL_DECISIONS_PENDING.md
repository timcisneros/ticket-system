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
| A3 | Wall-clock and progress-counter recovery resets | **High** | Open | Bounds integrity |
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

### A8. Dead `allow*` policy fields

| Field | Value |
|-------|-------|
| **Status** | Open |
| **Severity** | Low — the UI is already honest about it |
| **Evidence** | `server.js` `copyExecutionPolicy`; `views/run-detail.ejs`, `views/ticket-detail.ejs` |
| **Decision required** | Implement enforcement or formally retire the fields |

**Description:**

`executionPolicy.allowWorkspaceWrites`, `allowParallelRuns`, and `allowChildTickets` are
normalized at policy-copy time and **never read again anywhere in the repository**. They are
snapshotted into `executionPolicySnapshot` and displayed, but nothing enforces them.

The UI does not lie about this — run detail renders them as "recorded intent, not enforced"
and ticket detail as "recorded intent" — which is why this is Low rather than High. The
defect is that a persisted, operator-settable policy field has no effect.

Related and **already honest**: `executionPolicy.maxRuntimeMs`, `maxModelRequests`, and
`maxWorkspaceOperations` are advisory telemetry only, computed into an explicitly
advisory-labelled budget block that "never blocks, stops, fails, or reruns anything".
`maxAttempts` *is* enforced, but only at the manual rerun-from-start gate, and that narrow
scope is documented at the call site. Do not mistake these for enforced per-ticket limits.

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
| **required** — must run in the release checkpoint | 71 |
| **orphaned** — genuine cutover orphan, cannot run | 76 |
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

### The remaining 76 — sequencing

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

*Workspace Operation Error Handling recorded 2026-05-28. Event Log Stream Semantics merged 2026-06-12 from `UNRESOLVED_EVENT_LOG_QUESTIONS.md` (2026-05-28). complete:true Under Per-Response Action Caps recorded 2026-06-18, ported to this document 2026-07-16.*

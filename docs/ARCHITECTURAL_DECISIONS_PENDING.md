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
| A10 | Orphaned PostgreSQL-era test harnesses | **High** | Open | Verification gap |
| A11 | `truncated:true` disclosed to the model but never explained | Low | Open — split from A1 | Prompt policy |
| A12 | Bounded workspace-snapshot recovery policy | Medium | **Open — decision required** — residual of A1 | Policy |
| A14 | Redundant-mutation postcondition shortcut does not fire | **High** | **Implemented** — see entry | Correctness |
| A15 | Postcondition telemetry names a source the event never reaches | Low | **Open — decision required** | Documentation / telemetry |
| A16 | Run consequence records no committed mutations | **High** | **Implemented** — see entry | Correctness |

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
| **Status** | Open — confirmed pre-existing, not a regression |
| **Severity** | High — the release checkpoint has no working feasibility or postcondition coverage |
| **Evidence** | Baselined at commit `3a73a13` in a detached worktree; failure strings identical to current HEAD |
| **Decision required** | Repair, port, or retire each harness |

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

A fourteenth, `scripts/execution-semantics-test.js`, fails for a different reason: it asserts
helpers such as `computeMutationFingerprint` that no longer exist (1 passed / 5 failed at
HEAD). It is unrelated to `scripts/execution-semantics-snapshot-test.js`, which is current.

None are registered in `CHECKPOINT_TEST_SCRIPTS` or `POSTGRES_INTEGRATION_SCRIPTS`, so
`npm run checkpoint:release` stays green while they rot.

This gap is why `a1143e6` wrote feasibility coverage as executed code inside
`scripts/evidence-truthfulness-contract-test.js` (all six outcome paths against stubs) and
`scripts/execution-semantics-persistence-test.js` (the `passed` path through real dispatch),
rather than extending `runtime-feasibility-test.js`.

**Method note for whoever picks this up:** before treating any suite failure as a regression,
baseline it at the relevant commit in a detached worktree and compare failure strings. Most
failures in this list are pre-existing.

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

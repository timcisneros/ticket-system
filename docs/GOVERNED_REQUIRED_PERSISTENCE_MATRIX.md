# Governed Required-Persistence Failure Matrix

Tranche 5. The question no other governed suite asks: **what happens when a
required durable write does not commit?**

Every other governed suite proves behaviour when persistence works — including
the restart suites, which crash a process *between* writes that each succeeded.
This matrix fails the write itself.

**Governing principle.** A state transition may rely only on authority that was
durably persisted. Required-persistence failure must never produce false
success, false verified progress, false blocking, false request delivery,
duplicate economic authority, automatic retransmission, or scheduler-visible
work lacking its required authority.

Canonical suite: `scripts/governed-required-persistence-postgres-test.js`
(315 assertions). Injection seam: `scripts/fixtures/persistence-fault-repository.js`.

---

## 0. How a write is classified

Not by its name. By tracing its consumers and its recovery role.

| Classification | Meaning |
|---|---|
| `REQUIRED — SAME TRANSACTION` | Commits atomically with the transition that depends on it. No partial state exists to observe. |
| `REQUIRED — ORDERED BEFORE DEPENDENT ACTION` | Its own transaction, but strictly before the action it authorizes. Failure prevents the action. |
| `REQUIRED — POST-EXTERNAL-SIDE-EFFECT, UNCERTAINTY ON FAILURE` | The external effect may already exist. Failure yields truthful uncertainty, never a guess. |
| `RECONSTRUCTIBLE FROM STRONGER DURABLE AUTHORITY` | Recovery may reproduce it from a durable fact that outranks it. |
| `BEST EFFORT — NON-AUTHORITATIVE` | Nothing that decides reads it. |

---

## 1. The injection seam

`runGovernedLeafRequest` already takes its repository as a parameter — that is
how `server.js` supplies the real one — so a decorated store arrives through the
seam production itself uses. **No production source is conditional on testing.**

Three modes, because "the write failed" is three situations:

| Mode | Models |
|---|---|
| `before` | The statement never ran. The rolled-back transaction. |
| `after` | The statement **committed**, and the caller then failed. The only mode that produces a durable fact whose caller never learned of it. |
| `replace` | The method reports success while persisting nothing. |

Faults are armed for a bounded number of firings and record each one, so a row
asserts the injection happened rather than assuming it. `faultRepository` binds
pass-through methods to the real store so a fault cannot leak into unrelated
paths; `faultStoreMethod` shadows the method as an own property of the instance,
which is what reaches writes a store method performs on *itself* (the ones that
share a transaction).

What this seam deliberately does **not** do: shut PostgreSQL down (that fails
every write at once and proves only that a Run stops, not why), disable
constraints, use `session_replication_role`, or bypass append-only and hash
validation.

---

## 2. Transaction and atomicity map

**The single most important structural fact in this matrix.** Rows are
impossible to observe partially when PostgreSQL commits their constituent writes
together.

| Transaction | Writes committed together | Source |
|---|---|---|
| **Claim** | `runs.lease_owner` + `run.lease_acquired` event + capacity-wait release + `capacity.acquired` events | `claimPendingRun`, one `withTransaction` |
| **Start** | `runs.status='running'` + `runtimeBudgetStartedAt` + lease timing + `run.started` event | `startClaimedRun` |
| **Reservation** | ordinal derivation + reservation row + account reserved balance + `ticket.economic_request_reserved` event | `prepareAndReserveNextGovernedRunRequest` → `reserveEconomicRequest` |
| **Request start** | `state='request_started'` + `started_claim_event_position` binding + event | `markEconomicRequestStarted` |
| **Response marker** | `state='response_persisted'` + identity + hash + event | `markEconomicResponsePersisted` |
| **Settlement** | `state='settled'` + receipt + account balances + event | `settleEconomicRequest` |
| **Release** | `state='released'` + account balance restore + event | `releaseUndispatchedEconomicReservation` |
| **Receipt** | `operation_receipts` row + `operation.receipt_recorded` event | `recordOperationReceipt` |
| **Evidence set** | the **whole fact set** for one batch | `appendGovernedPostconditionEvidenceSet` |
| **Block** | `runs.body.governedProgressBlock` + revision + `run.progress_blocked` event | `blockGovernedRunForProgressDecision` |
| **Terminalization** | terminal status + phase + **lease clearing** + finalized replay snapshot + evaluation + consequence + `run.completion_decided` event + terminal event | `terminalizeRun`, one `withTransaction` |
| **Containment** | terminal status + integrity code/reason/timestamp + integrity event | `terminalizeRunForReplayIntegrityFailure` |

### Combinations that are STRUCTURALLY IMPOSSIBLE

Listed as impossible, **not** as passing. Asserting them would be asserting
PostgreSQL.

| Named combination | Why it cannot occur |
|---|---|
| Lease held without its `run.lease_acquired` event | One transaction. This is what makes `startedClaimEventPosition` a resolvable identity at all. |
| Reservation row without its ordinal or account debit | One transaction. |
| Request started without its claim binding | Same UPDATE statement. |
| Response marker without its event | One transaction. |
| Block row without its block event, or vice versa | One transaction — proved observationally by row 7.2 ("exactly one block event"). |
| Partial fact set within one evidence batch | One transaction — proved observationally by row 6.1 ("the set is all-or-nothing"). |
| Consequence without its completion-decision event | `_recordCompletionDecisionEvidence` runs on the terminalization client. |
| Terminal status without its consequence, evaluation, replay snapshot or terminal event | One transaction — proved observationally by row 8.1 (revision did not move). |
| **Terminal status while the lease is still held** | `transitionRun` clears `lease_owner`, `lease_expires_at` and `last_heartbeat_at` in the **same UPDATE statement** that sets the terminal status (`CASE WHEN $4 = ANY(ARRAY['completed','failed','interrupted']) THEN NULL`). |
| **Lease released while the Run is not yet terminal** | Same statement. `releaseRunLease` is the scheduler's cleanup for Runs that never terminalized; it is not part of the terminal bundle. |

### Deliberately SEPARATE transactions

| Boundary | Why, from source |
|---|---|
| Progress evaluation → block persistence | The refusal throws, which would roll back the evaluation transaction and discard the very block that must survive it. So the evaluation transaction commits first, the block is persisted in its own transaction, and only then is `GOVERNED_RUN_PROGRESS_BLOCKED` raised. Row 7.1 is about exactly this window. |
| Request-start commit → provider transport | Nothing durable can span a network call. This is the irreducible uncertainty window. |
| Terminalization → `transitionTicketAfterRun` | Ticket aggregation reads committed Run truth; row 8.1 proves it *refuses* a Run that never reached a terminal status. |

---

## 3. The inventory

Every durable write in the real lifecycle, with its classification.

| # | Lifecycle stage | Required write | Owner | Classification | Transport before it? | Reconstructible? | Failure behaviour today | Canonical suite |
|---|---|---|---|---|---|---|---|---|
| 1 | claim | `run.lease_acquired` event | `claimPendingRun` | REQUIRED — SAME TRANSACTION | no | no | atomic with the lease; no claim ⇒ no ownership | production-path, this matrix §2 |
| 2 | admission | runtime-budget charge | `runtimeBudgetController.reserve` via `persistRequestEvidence` | REQUIRED — ORDERED BEFORE DEPENDENT ACTION | **no** | no | propagates; no transport | **4.3** |
| 3 | admission | economic reservation | `prepareAndReserveNextGovernedRunRequest` | REQUIRED — ORDERED BEFORE DEPENDENT ACTION | no | no | closed `reservation_refused`; no ordinal consumed | **4.1** |
| 4 | request start | `state='request_started'` | `markEconomicRequestStarted` | REQUIRED — ORDERED BEFORE DEPENDENT ACTION | no | no | propagates; reservation stays `reserved`; retryable | **4.2**, **4.4** |
| 5 | request start | `started_claim_event_position` | same statement | REQUIRED — SAME TRANSACTION | no | no | superseded claim refuses; malformed is coded | **4.2** |
| 6 | pre-transport | provider-request replay item | `recordNonTerminalRunEvidence` via `persistRequestEvidence` | REQUIRED — ORDERED BEFORE DEPENDENT ACTION | **no** | no | propagates; **no byte leaves** | **4.3** |
| 7 | transport | *(no durable write)* | — | — | — | — | the irreducible uncertainty window | 4.3, 5.1 |
| 8 | response | model-response replay evidence | `persistResponseEvidence` | REQUIRED — POST-EXTERNAL-SIDE-EFFECT | **yes** | no | propagates; marker not written past it | **5.2** |
| 9 | response | `state='response_persisted'` | `markEconomicResponsePersisted` | REQUIRED — POST-EXTERNAL-SIDE-EFFECT | **yes** | no | delivery uncertainty; **never retransmits** | **5.1** |
| 10 | settlement | `state='settled'` + receipt | `settleEconomicRequest` | RECONSTRUCTIBLE FROM STRONGER DURABLE AUTHORITY (the response) | yes | **yes** | propagates; recovery settles from the reservation and response | **5.3** |
| 11 | operations | operation receipt | `recordOperationReceipt` | REQUIRED — POST-EXTERNAL-SIDE-EFFECT | n/a | no | append-only, idempotency-keyed; survives downstream failure | **6.1** |
| 12 | evidence | baseline evidence | `appendGovernedPostconditionEvidence` | REQUIRED — ORDERED BEFORE DEPENDENT ACTION | no | no | absent baseline is an integrity refusal, not an unsatisfied fact | lifecycle suite |
| 13 | evidence | post-batch fact evidence | `appendGovernedPostconditionEvidenceSet` | REQUIRED — SAME TRANSACTION (whole set) | yes | no | propagates; transition reader then **refuses closed** | **6.1** |
| 14 | evidence | evidence-batch boundary | same set (`batchStepId`, `throughOperationReceiptId`) | REQUIRED — SAME TRANSACTION | yes | no | all-or-nothing with the set | **6.1** |
| 15 | evaluation | verified-progress projection | derived, not stored | RECONSTRUCTIBLE (deterministic over durable rows) | — | **yes** | recomputed identically per cutoff | lifecycle suite |
| 16 | block | governed progress block + event | `blockGovernedRunForProgressDecision` | REQUIRED — ORDERED BEFORE DEPENDENT ACTION | no | **no** (never from status or churn) | refusal is **not** raised; closed generic refusal; re-decided next attempt | **7.1**, **7.2** |
| 17 | block | sibling-dependency block | same method, `siblingDependency` arg | REQUIRED — ORDERED BEFORE DEPENDENT ACTION | no | no | identical, and the two reasons stay distinct | `governed-sibling-dependency-postgres-test` |
| 18 | terminal | Run consequence | `recordRunConsequence` | REQUIRED — SAME TRANSACTION | n/a | no | **whole terminalization rolls back** | **8.1** |
| 19 | terminal | completion decision | inside the consequence document | REQUIRED — SAME TRANSACTION | n/a | no | no decision ⇒ no terminal state at all | **8.1** |
| 20 | terminal | `run.completion_decided` event | `_recordCompletionDecisionEvidence` | REQUIRED — SAME TRANSACTION | n/a | no | conflict detection refuses divergence | **8.1** |
| 21 | terminal | terminal status + phase + **lease clearing** | `transitionRun` (one statement) | REQUIRED — SAME TRANSACTION | n/a | no | atomic; no split truth possible | **8.2** |
| 22 | terminal | terminal event | `terminalizeRun` | REQUIRED — SAME TRANSACTION | n/a | no | atomic | **8.1** |
| 23 | integrity | containment status + code + event | `terminalizeRunForReplayIntegrityFailure` | REQUIRED — SAME TRANSACTION | n/a | no | containment **not claimed**; corruption left intact | **9.1** |
| 24 | observability | `run:completed`, `run:verification_failed`, `run:failed`, `run:failed_auto_retried`, `run:interrupted` | `appendRunLog` | BEST EFFORT — NON-AUTHORITATIVE | n/a | n/a | tolerated post-terminal only | **Phase 10** |
| 25 | operator plane (T8-I5) | `workspace.operator_mutation` occurrence event (non-run-scoped) | `operatorWorkspaceMutationApi` and the fixture-reset route, via the server `appendEvent` | REQUIRED — POST-EXTERNAL-SIDE-EFFECT, UNCERTAINTY ON FAILURE | **yes** (the filesystem mutation precedes the record) | no | latches fail-closed (readiness cleared, schedulers stopped); truthful occurred-but-unrecorded response; further operator mutations refused while latched; diagnostic log retained best-effort | `operator-occurrence-evidence-test.js` |

Row 25 is the operator-plane occurrence write (T8-I5). It is not a Run lifecycle write — operator
acts remain outside T6 governed membership — but it is a required durable write against the same
governing principle, so it is inventoried here rather than left unowned. The filesystem effect
precedes the record and cannot be reconstructed from anything else: a recording failure after the
effect yields truthful uncertainty (neither false success nor false failure, no unsupported
repetition), and the mutation authority, `withTargetOperationLock` serialization, and same-Run
target visibility are unchanged.

---

## 4. Results by phase

### Phase 4 — required pre-transport writes

Every row asserts the full contract: zero dependent transports, no
model-response replay, no settlement, no ordinal beyond the admitted one, no
progress evidence, no block, no completion decision, no terminal success.

| Row | Injected failure | Observed durable state | Later authorized attempt | Verdict |
|---|---|---|---|---|
| **4.1** | `prepareAndReserveNextGovernedRunRequest` (before) | **no reservation row at all** | proceeds, and reaches **ordinal 1** — the failure consumed nothing | PASS |
| **4.2** | `markEconomicRequestStarted` (before) | reservation stays `reserved`, never `request_started` | starts the **same** reservation; still one ordinal | PASS |
| **4.3** | `persistRequestEvidence` (budget charge + provider-request replay) | reservation `request_started`, **zero transports** | does **not** retransmit; reports delivery uncertainty | PASS |
| **4.4** | `markEconomicRequestStarted` (**after** — committed, caller failed) | the durable start is **not erased** by the caller failing | does not dispatch; never reports a response it lacks | PASS |

**When claim acquisition itself fails**, no caller behaves as though it owns the
Run: `markEconomicRequestStarted` matches the caller's stated claim against the
append-only event log and refuses a superseded or unresolvable one
(`ECONOMIC_REQUEST_STALE_CLAIM_ATTEMPT`, `ECONOMIC_REQUEST_CLAIM_POSITION_INVALID`),
and both map to closed `reservation_refused` outcomes before any byte leaves.

**4.3 records the cost of failing closed, explicitly.** Nothing was sent, but
the reservation is `request_started` and *the provider-request replay item was
the marker that would have distinguished "failed before dispatch" from "failed
during dispatch"* — and it is the write that failed. So the later attempt must
refuse to retransmit rather than guess, even though a reader of the test knows
the bytes never left. This is correct, and it is not free.

### Phase 5 — transport and response uncertainty

| Row | Injected failure | Transport count | Retransmission | Durable outcome | Verdict |
|---|---|---|---|---|---|
| **5.1** | `markEconomicResponsePersisted` (before) | **exactly 1** | **none** | request stays started; transport fact not erased; no progress window, no churn increment, no completion | PASS |
| **5.2** | `persistResponseEvidence` (before) | exactly 1 | none | the economic marker was **not** written past the missing evidence | PASS |
| **5.3** | `settleEconomicRequest` (before) | exactly 1 | none | response **is** durable; recovery reuses it exactly once and settles then | PASS |
| **5.4** | `settleEconomicRequest` (before), churn ceiling 1 | exactly 1 | none | response **reused**, settlement reconstructed, **no block** until the answer is actually processed — then legitimate churn blocks | PASS |

**The settlement rule, read from source rather than guessed.**
`settleFromDurableFacts` is called on every path that observes a reservation in
`response_persisted`, and settles idempotently from the reservation's own
captured facts. Settlement is therefore **RECONSTRUCTIBLE FROM STRONGER DURABLE
AUTHORITY** — the response — and is *not* required before the response may be
used. What it may never do is vanish behind a successful result, and 5.3 asserts
that the caller receives the failure rather than a `received` outcome.

Durable-response rehydration across a real process boundary is owned by
`governed-post-transport-restart-postgres-test`; it is not duplicated here.

### Phase 6 — operations, receipts and evidence

| Row | Injected failure | Result | Verdict |
|---|---|---|---|
| **6.1** | `appendGovernedPostconditionEvidenceSet` (before), **after a real committed receipt** | see below | PASS |

- The committed receipt **survives** — the operation demonstrably occurred.
- No post-batch evaluation exists; the set is **all-or-nothing**.
- `readGovernedFactTransitions` **refuses closed** with
  `GOVERNED_FACT_TRANSITION_REFUSED` / `fact_evidence_incomplete` rather than
  returning an empty mapping.
- The pre-reservation gate therefore refuses too, issues no provider request,
  and creates **no churn block**.

This is the sharpest distinction in the matrix, and production makes it
correctly: **"operation succeeded but its evidence is missing" is refused as
incomplete evidence, not collapsed into "it did not advance."** Missing evidence
is recorded as absence, never as a failed evaluation nobody performed.

### Phase 7 — block and withholding persistence

| Row | Injected failure | Result | Verdict |
|---|---|---|---|
| **7.1** | `blockGovernedRunForProgressDecision` (before), at a genuine block point | closed refusal that is **not** `GOVERNED_RUN_PROGRESS_BLOCKED`; no block row, no block event, no fabricated hash, no completion, no extra provider request, no second reservation. The next attempt **re-decides from durable facts** and persists the block for the same reason. | PASS |
| **7.2** | same method (**after** — committed, caller failed) | the block **survives its caller**; exactly one block event; a later observation re-reports the **same** block hash and appends no duplicate; no provider request occurs after a persisted block. | PASS |

An unpersisted block **suppresses nothing** — it does not act as though it
existed — and a persisted block is never reconstructed from generic failed
status or churn history. Block row and block event are one transaction, so
"accepted partial state" between them does not exist.

### Phase 8 — completion and terminalization

| Row | Injected failure | Result | Verdict |
|---|---|---|---|
| **8.1** | `recordRunConsequence` (before), inside a real `terminalizeRun` | the **entire transaction rolls back**: status still `running`, **revision unchanged**, no completion timestamp, no consequence row, no `run.consequence_recorded`, no `run.completion_decided`, no `run.terminalized`, lease not released. The aggregate **refuses** to reconcile (`STATE_TRANSITION_CONFLICT`) and the Ticket does not complete. A later attempt terminalizes with **exactly one** of each record. No transport or spending. | PASS |
| **8.2** | `releaseRunLease` (before), after a coherent terminal state | lease was already cleared by the terminal statement; the failure is observed by its caller and changes nothing. The scheduler does **not** reclaim a terminal Run (`claimPendingRun` selects `pending`), and `recoverExpiredRun` does not reopen it (`status='running'` only). | PASS |

Separating rollback from post-commit repair: **every row in Phase 8 is
transactional rollback.** There is no post-commit repair window inside
terminalization, because there is nothing after the commit except the Ticket
transition, which reads committed truth and refuses anything else.

### Phase 9 — replay-integrity containment

| Row | Injected failure | Result | Verdict |
|---|---|---|---|
| **9.1** | `terminalizeRunForReplayIntegrityFailure` (before) | containment is **not claimed**: Run not terminal, no integrity code/reason/timestamp, no integrity event, no normal completion decision required or created, no fabricated block authority. Uncontained corruption is **not** projected as ordinary failure. A later attempt contains it once with the exact code; a repeat observation writes nothing — no duplicate event, **no revision churn**. | PASS |

The corrupted snapshot is left exactly as it is: it is the evidence of what
happened.

### Phase 10 — required versus best-effort observability

Five run-log types are classified best effort. The classification is defensible
only while nothing that decides reads them, so the suite asserts the structural
fact that makes it true: **none of the five identifiers appears in any runtime
contract or in the store** — the layers that own projection, recovery,
accounting, completion and blocking.

One permitted appearance, allowed **by name** rather than by loosening the rule:
`runtime/execution-semantics.js` lists `run:failed` in
`NON_REJECTION_EVENT_TYPES`, a named record of what is deliberately *not*
counted. `countResponseRejections` consults `RESPONSE_REJECTION_EVENT_TYPES`
only, and the exclusion map's sole consumer is a test asserting the two stay
disjoint. Excluding a type from a count is the strongest available evidence that
it is not authority. The suite additionally asserts `run:failed` is absent from
the counted set.

**The classification is retained, not broadened.** No type was added to
`BEST_EFFORT_RUN_LOG_TYPES` to make anything pass.

For required writes, the converse holds: all nine failure-injected writes
propagate to their caller, asserted individually in Phases 4–9.

---

## 5. Reconstructible-write map

| Write | Reconstructible from | Proof |
|---|---|---|
| Settlement receipt | the reservation's captured facts + the durable response | 5.3 |
| Verified-progress projection | durable receipts, reservations and evidence under an explicit cutoff | lifecycle suite; deterministic per cutoff |
| Governed response transcript | the Run's own canonical response evidence, matched **by response hash** | `governed-post-transport-restart-postgres-test` |
| **Governed progress block** | **nothing** — never from status, churn history, or a re-derivation after the cutoff | 7.1, 7.2 |
| **Completion decision** | **nothing** — a missing decision stays non-success | 8.1 |
| **Containment authority** | **nothing** — containment is claimed only when its write committed | 9.1 |

Startup repair (`repairRunTerminalization`) consumes durable authority only: it
reads the committed consequence row and the committed lifecycle event and
**refuses** when they diverge, rather than inventing either. That is no longer a
source-reading claim — it is failure-injected in §6a, Phases 11 and 12.

---

## 6. The response-consumption boundary (corrected)

Row 5.4 previously pinned a defect. It is **fixed**; this section records the
correction, because it is the one production behaviour change this matrix
produced.

### What was wrong

`evaluateGovernedRunProgress` scored a window as no-progress whenever
`hasDurableResponse` was true and no fact was verified. When settlement — or any
required write between the response marker and the worker — failed, the answer
was durable but execution never saw it, and the window was charged against the
model's churn tolerance anyway. At a tolerance of one, the paid-for answer became
permanently unreachable behind a block that short-circuits every later attempt:
**false blocking attributable to a persistence failure.**

### Phase 1 verdict

**PROGRESS EVALUATION LACKS A RESPONSE-CONSUMED WINDOW BOUNDARY.**

Ordering was *not* the defect and was not changed. `runGovernedLeafRequest`
already reuses a `response_persisted` reservation and settles idempotently; the
gate simply miscounted the window before that reuse could be reached. Correcting
eligibility makes the existing `reused_durable_response` path reachable, with the
lifecycle order untouched:

```
existing request/reservation inspection
  -> pre-reservation gate (a persisted block still short-circuits FIRST)
  -> durable response reuse + settlement reconstruction
  -> worker processing and evidence persistence
  -> progress evaluation
  -> possible next request admission
```

A persisted block is still consulted before anything else, so response recovery
cannot bypass one, and a delivery-uncertain request is still never retransmitted.

### The canonical consumption authority

The committed **`model_request` runtime-budget charge**, matched by
`source_identity` — which is byte-identical to the economic reservation's
`logical_source_identity`.

| Property | Why it is the right boundary |
|---|---|
| Written in exactly one place | `dispatchGovernedLeafModelRequest` commits it immediately before handing the response envelope to the worker loop |
| Reserved pre-transport, committed post-response | so `reserved` vs `committed` *is* the "answered but not delivered" distinction |
| Already inside `budgetCutoff` | no new cutoff dimension — the cutoff shape, and therefore every stored block hash, is unchanged |
| Already read by `readGovernedRunProgressState` | previously only aggregated; now also grouped by source identity |
| Exists for a turn that proposed nothing | so ordinary churn stays countable |

**No new column, table or event was added.**

### The churn-eligible window

One shared definition, `isChurnEligibleWindow` in
`runtime/governed-progress-evaluation.js`, used by the single evaluator:

| Durable state | Classification |
|---|---|
| no durable response | **not** a churn window |
| durable response, delivery not committed | **not** a churn window |
| durable response, delivery committed, zero newly satisfied facts | **one** no-progress window |
| durable response, delivery committed, verified progress | progress window — resets the streak per existing policy |
| receipts exist but evidence incomplete | refused upstream as incomplete evidence; never reaches the evaluator |

Deliberately **not** required: receipts, evidence, or a non-empty plan. A turn
whose answer reached execution and proposed nothing *is* a no-progress window —
that is the ordinary case churn control exists for.

### Fail-safe, not fail-open

`runtimeBudgetController` is a no-op for a Run carrying no runtime budget
snapshot, so such a Run has **no** `model_request` charge rows for any window.
Reading that absence as "nothing was ever delivered" would silently disable churn
control for those Runs — strictly worse than the defect being fixed. So delivery
is a **tri-state**: `true`, `false`, or `null` when the Run keeps no
model-request ledger. Only an explicit `false` withholds eligibility; `null`
falls back to the previous durable-response rule.

### Row 5.4, before and after

| | Before | After |
|---|---|---|
| re-entry after settlement failure | `reservation_refused` / `GOVERNED_RUN_PROGRESS_BLOCKED` | `reused_durable_response` |
| block | `verified_progress_exhausted` persisted immediately | none until the answer is processed |
| churn streak for the undelivered window | 1 | **0** |
| paid-for answer | permanently unreachable | reused, settlement reconstructed idempotently |
| transports | 1 | 1 |
| ordinals / reservations | 1 | 1 |

### Legitimate churn is unchanged

Row 5.4 then completes the processing with a real no-progress result — delivery
committed, a real receipt, complete evidence, zero newly satisfied facts — and
the next gate **does** block with `verified_progress_exhausted` at a ceiling of
one. Blocking still happens; it happens after the model's response was actually
processed.

Independently confirmed through a **real server** by
`governed-no-progress-withholding-postgres-test`, which drives a genuine
no-progress turn end to end and still withholds the next request. Restart and
same-process behaviour is confirmed by `governed-blocked-restart-postgres-test`,
`governed-pre-transport-restart-postgres-test` and
`governed-post-transport-restart-postgres-test`.

---

## 6a. Startup-repair persistence (Phases 11-12)

Both previously-retained rows are now **failure-injected**, not source-only.

`repairRunTerminalization` runs in ONE transaction, so every refusal below is a
complete rollback rather than a partial repair.

### Repair authority (Phase 11)

| Row | Injected state | Result |
|---|---|---|
| **11.1** | no `run.execution_completed` / `run.execution_failed` evidence | refuses `TERMINAL_REPAIR_INTEGRITY_FAILURE`, "execution-completion evidence is missing" |
| **11.2** | two `run.evaluation_completed` events | refuses, "duplicated or contradictory" |
| **11.3** | consequence carrying **no** completion decision | repair completes the tail, invents **no** decision; Run stays non-success; Ticket does not complete |
| **11.4** | pre-existing `run.completion_decided` conflicting with the consequence | refuses; whole repair rolls back |
| **11.5** | consequence already durable, terminal tail missing | **reuses** it — still exactly one consequence, one terminal event; nothing reconstructed over durable authority |

Every refusal additionally proves: revision unmoved, no consequence invented, no
completion decision invented, no completion derived from status, no Ticket or
aggregate completion, no reservation, no transport, no operation.

### Consequence reconstruction under repair (Phase 12)

Each canonical write repair performs while reconstructing a missing consequence
was failed once, at its real method name:

| Faulted method | Result |
|---|---|
| `writeReplaySnapshot` | propagates; full rollback; later repair succeeds exactly once |
| `recordRunEvaluation` | propagates; full rollback; later repair succeeds exactly once |
| `recordRunConsequence` | propagates; full rollback; later repair succeeds exactly once |
| `_recordCompletionDecisionEvidence` | propagates; full rollback; later repair succeeds exactly once |
| `_listRunOperationsOn` (read) | propagates — a repair **read** failure is not swallowed |

"Exactly once" is asserted as one consequence, one terminal event and at most
one completion-decision event after the later repair, with no transport,
reservation or operation created at any point.

### Structurally unreachable repair states

| State | Why it cannot be manufactured legally |
|---|---|
| consequence row without its `run.consequence_recorded` event, or vice versa | `recordRunConsequence` writes both in one transaction. Repair still *checks* for the disagreement (`consequence storage and lifecycle evidence disagree`) — that guard can never fire in a schema-legal state, and is retained as defence in depth. |
| terminal status with a partially written terminalization tail from `terminalizeRun` | `terminalizeRun` is one transaction. The only production path that produces a terminal row without its tail is `transitionRun`, which is exactly the shape Phase 11 seeds. |
| completion decision without its event | `_recordCompletionDecisionEvidence` runs on the repair client, inside the same transaction. |

No constraint was disabled to manufacture any state.

---

## 7. Focused mutation matrix

Every mutation fails at the row that owns it. All source files restored and
verified by SHA-256.

| # | Mutation | Canonical owner mutated | Owning row | Verdict |
|---|---|---|---|---|
| M1 | transport occurs without provider-request replay (failure swallowed) | `governed-leaf-orchestration.js` | 4.3 | CAUGHT |
| M2 | request-start persistence failure still transports | `governed-leaf-orchestration.js` | 4.2 | CAUGHT |
| M3 | a started request is re-dispatched (retransmission) | `governed-leaf-orchestration.js` | 4.3, 4.4, 5.1 | CAUGHT |
| M4 | settlement failure is ignored | `governed-leaf-orchestration.js` | 5.3 | CAUGHT |
| M5 | incomplete evidence silently reports no progress | `governed-fact-transitions.js` | 6.1 | CAUGHT |
| M6 | unpersisted block still reported as governed blocking, with a fabricated hash | `store.js` gate | 7.1 | CAUGHT |
| M7 | block idempotency dropped — duplicate block authority and event | `blockGovernedRunForProgressDecision` | **7.3** | CAUGHT |
| M8 | consequence failure swallowed inside terminalization | `terminalizeRun` | 8.1 | CAUGHT |
| M9 | terminal transition leaves the lease held | `transitionRun` | 8.2 | CAUGHT |
| M10 | containment claimed without its integrity code | `terminalizeRunForReplayIntegrityFailure` | **9.2** | CAUGHT |
| M11 | a released reservation is dispatched anyway | `governed-leaf-orchestration.js` | **4.5** | CAUGHT |
| M12 | a best-effort run log becomes projection authority | `verified-progress-projection.js` | Phase 10 | CAUGHT |

### Second focused set — the correction and the repair rows (12/12 CAUGHT)

| # | Mutation | Canonical owner mutated | Owning row | Verdict |
|---|---|---|---|---|
| N1 | unconsumed durable response counts as churn | `isChurnEligibleWindow` | 5.4 | CAUGHT |
| N2 | a merely RESERVED charge is read as delivery | `readGovernedRunProgressState` | 5.4 | CAUGHT |
| N3 | response recovery transports again | `governed-leaf-orchestration.js` | 5.3, 5.4 | CAUGHT |
| N4 | delivery is assumed rather than observed | `readGovernedRunProgressState` | 5.4 | CAUGHT |
| N5 | a fully evaluated no-progress window stops counting | `isChurnEligibleWindow` | 5.4 tail, 7.x | CAUGHT |
| N6 | incomplete evidence becomes zero progress | `governed-fact-transitions.js` | 6.1 | CAUGHT |
| N7 | startup repair accepts divergent authority | `repairRunTerminalization` | 11.2 | CAUGHT |
| N8 | startup repair proceeds without execution evidence | `repairRunTerminalization` | 11.1 | CAUGHT |
| N9 | repair reconstructs over durable consequence authority | `repairRunTerminalization` | **11.5** | CAUGHT |
| N10 | repair accepts a conflicting completion decision | `_recordCompletionDecisionEvidence` | 11.4 | CAUGHT |
| N11 | repair swallows its consequence-write failure | `repairRunTerminalization` | 12 | CAUGHT |
| N12 | repair swallows its operation-read failure | `repairRunTerminalization` | 12 | CAUGHT |

**N9 survived its first pass**, for the same class of reason as the three below:
row 11.5 stored a consequence *identical* to the one repair would rebuild, so
reuse and reconstruction were indistinguishable. The row now stores a
distinguishing marker in `created` and asserts it survives verbatim — proof that
repair read durable authority rather than rebuilding over it. The row was fixed;
the mutation was not re-aimed.

### First focused set: three mutations survived the first pass, and why

Recorded because the reason is the useful part: each survived a **real coverage
gap**, not a mis-aimed mutation, and each gap was closed by adding the row that
owns it rather than by re-aiming the mutation.

| Mutation | Why it survived | Row added |
|---|---|---|
| M7 | Row 7.2 reaches the block **through the gate**, and the gate short-circuits on `run.governedProgressBlock` *before* calling the block writer. The writer's own idempotency branch was therefore never re-entered. | **7.3** calls the canonical writer twice directly — what a caller that failed after the commit actually does when it retries. |
| M10 | Row 9.1 starts from a **running** Run, so `alreadyTerminal` is false whichever half of the predicate is evaluated. | **9.2** starts from a Run terminal for an *ordinary* reason, where the two halves disagree. |
| M11 | No row produced a **released** reservation at all — that needs the credential-unavailable path. | **4.5** releases a reservation undispatched and proves it is never dispatched and its ordinal never reused. |

M5 additionally did not apply on the first pass (the harness's marker-based
anchor failed to match) and was re-aimed to an exact source anchor. It was
scored `NOT APPLIED`, never as coverage.

---

## 8. Rows this matrix does NOT own

Stated so the matrix is not read as broader than it is.

| Row from the brief | Status | Owner |
|---|---|---|
| Sibling-dependency block persistence | proved, elsewhere | `governed-sibling-dependency-postgres-test` |
| Durable-response rehydration across a real restart | proved, elsewhere | `governed-post-transport-restart-postgres-test` |
| Baseline evidence persistence | proved, elsewhere | `governed-verified-progress-lifecycle-postgres-test` |
| Evidence-integrity assertion | proved, elsewhere | `governed-evidence-integrity-postgres-test` |
| Contained-vs-uncontained classification across a restart | proved, elsewhere | `governed-replay-corruption-postgres-test` |
| Startup repair invents missing authority | **now proved here** | §6a Phase 11 (rows 11.1-11.5) |
| Consequence-reconstruction inputs failing under repair | **now proved here** | §6a Phase 12 (five faulted methods) |

No row in this matrix is DEFECT, UNTESTED, SOURCE-ONLY or PENDING. Every row is
either failure-injected against production, or proved structurally unreachable
from the transaction map in §2 and §6a.

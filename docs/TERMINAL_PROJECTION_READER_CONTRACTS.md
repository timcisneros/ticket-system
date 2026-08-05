# Terminal Projection Reader Contracts

Source-backed audit of every reader that projects a structured-leaf terminal
state, captured so the remaining parity work can be written without further
payload discovery.

Captured at `df18fd8993bf3d6f83424f74920aa32d0458fe0a` from live payloads of the
existing cold-process scenarios. Field paths below are the actual keys observed,
not inferred from handler source. No production behaviour was changed to produce
this document.

**Why this exists.** Four consecutive sessions failed to close the terminal
matrix for the same reason: each one discovered that a reader owns a different
field set than assumed, and the correction consumed the budget the matrix rows
needed. Twice a conclusion recorded as fact was simply wrong — see *Corrections*
below. The discovery cost is paid once here.

---

## 1. Reader ownership

| # | Reader | Owner | Reads | Payload kind | Refuses closed? |
|---|---|---|---|---|---|
| 1 | Ticket page `GET /tickets/:id` | `renderCachedView('ticket-detail.ejs')`, server.js ~26261 | whole Ticket | presentation over canonical seams | yes (500 on integrity) |
| 2 | Ticket runtime API `GET /api/tickets/:id/runtime` | `serializeTicketRuntimeState`, server.js 26607 | every Run on the Ticket | canonical + summary | yes |
| 3 | Ticket timeline API `GET /api/tickets/:id/timeline` | server.js 26630 | ticket/run/event/history records | raw history | yes |
| 4 | Run page `GET /runs/:id` | `run-detail.ejs` | one Run | presentation | yes (500 on uncontained) |
| 5 | Run-state API `GET /api/runs/:id/state` | `serializeRunRuntimeState`, server.js 28900 via `readRuntimeRunAuthority` | one Run | canonical, narrower than Ticket runtime | yes |
| 6 | Run-events API `GET /api/runs/:id/events` | server.js 28872 | one Run | raw durable history | yes |
| 7 | Reconciliation | `deriveLeafItemDisposition` (runtime/structured-allocation-leaf-run-contract.js), sole caller `persistence/postgres/store.js:3106` | one Run's facts | canonical disposition | n/a (throws) |
| 8 | Parent aggregate | `aggregateDecision.items` on the allocation plan | all items | canonical | n/a |
| 9 | CLI | `scripts/oquery.js` | remote domains `tickets, runs, logs, history, plans` | presentation over fetched domains | n/a |

### The "one canonical seam" claim is only partly true

`server.js:26258` states the verified-progress summary is read "through the
single canonical seam so the page, the API and the CLI cannot disagree."

**Accurate for:** the Ticket page and Ticket runtime API — both call
`readTicketVerifiedProgressProjection`.

**Not accurate for the CLI.** `scripts/oquery.js` fetches the domains
`tickets, runs, logs, history, plans` (line 281) and never calls
`readTicketVerifiedProgressProjection`. It cannot disagree with that seam
because it never reads it. The comment should be read as covering page+API only.

---

## 2. Actual payload shapes

Observed keys. Long strings redacted; no credentials, cookies, prompts or
corrupt replay content are reproduced here.

### 2.1 Ticket runtime API — `GET /api/tickets/:id/runtime`

Top level:

```
ticket, structuredAllocation, structuredAllocationPlanning, governedEconomics,
verifiedProgress, structuredAllocationLeafExecution, currentRun, latestRun,
currentMessage, currentStep, leaseState, runStateInconsistency, outcome,
outcomeLabel
```

**Per-item disposition** — `structuredAllocationLeafExecution.items[]`, scope
with `findRuntimeRun(payload, runId)`:

```
allocationItemId, assignedAgentId, ownedOutputPaths, objective,
itemDeclaredWorkHash, parentDeclaredWorkHash, leafBindingHash,
runId, runLineage, itemStatus, dispositionReason, completionDecisionHash
```

Observed values (contained-corruption Ticket): corrupt leaf
`itemStatus: failed`, `dispositionReason: completion_decision_missing`;
siblings `failed` / `completion_unsuccessful` — each its own reason.

**Ticket-level block summary** — `verifiedProgress`, a SUMMARY of run-ID lists
grouped by reason, **no per-Run block object and no blockHash**:

```
governedRunIds, runsPermittedToContinue, runsQueuedBeforeFirstExecution,
runsNotYetEvaluated, blockedForVerifiedProgressExhaustion,
blockedForRepeatedNoOp, blockedForRepeatedFailedOperation,
blockedForMutationReversal, blockedForCumulativeExecutionDuration,
blockedForUndeclaredSiblingDependency, blockedForProgressAccountingConflict,
unresolvedActiveWindows, totalVerifiedProgressFacts, cumulativeResources
```

### 2.2 Run-state API — `GET /api/runs/:id/state`

Top level:

```
id, ticketId, agentId, agentName, status, executionMode, capabilityType,
capabilityId, workflowId, executionPolicySnapshot, verificationContractSnapshot,
completionAuthoritySnapshot, declaredWorkSnapshot, declaredWorkAvailability,
declaredCompletionBinding, triage, lease, leaseExpiresAt, currentStepId,
currentWorkflowAction, lastHeartbeatAt, eventSummary, latestEventSummary,
replaySummary, verifiedProgress, authorityEvidence, runEvaluation, attemptUsage,
completionDecisionIntegrity
```

**`verifiedProgress` is per-Run here** (unlike the Ticket API):

```
runId, ticketId, allocationPlanId, allocationItemId, policy, evaluated,
executionEpochAt, cutoff, window, resources, signals, decision, block
```

**`verifiedProgress.block`** — the full governed block, observed on the
`verified_progress_exhausted` row:

```
blockHash, reason, decision, blockedAt, churnDecisionHash,
verifiedProgressProjectionHash, progressPolicyHash, executionEpochAt,
cutoff{receiptCutoff, reservationCutoff, budgetCutoff,
postconditionEvidenceCutoff, evaluatedAt, cutoffIdentity},
siblingDependency
```

Observed: `reason: "verified_progress_exhausted"`, `decision: "blocked"`,
64-hex `blockHash`.

**`replaySummary`** — `null` when the replay cannot be read (contained
integrity failure). Otherwise:

```
model, terminalStatus, failureReason, failure{code, kind, detail},
mutationCount, mutationOutcome, finalizedAt, continuationOf, steps,
workspaceOperations, providerRequests, modelResponses, hasBlockedOrRejected,
hasCompletedNoop, hasPostconditionCompleted, browserEvidenceStatus,
browserEvidenceDetail
```

**`completionDecisionIntegrity`** — observed on the contained-corruption leaf as
`{ status: "missing", code: "COMPLETION_EVIDENCE_MISSING" }`. This is a
descriptive status, not a refusal: the projection still renders.

**`replayAvailability` is ABSENT from this route.** Replay availability is a
Run-page concern (§2.4).

**`triage`** — `{ required, reasonCode, summary, requiredDecision, evidenceRefs,
allowedActions, prohibitedActions, createdAt, resolvedAt, resolvedBy,
resolution }`. Owner of the automatic-retry prohibition.

### 2.3 Run-events API — `GET /api/runs/:id/events`

```
{ events: [...], summary: { currentStep, latestStatus, latestError,
  latestWorkspaceMutation } }
```

Raw durable history. Relevant types include `run.progress_blocked`,
`run.completion_decided`, `run.triage_created`, `run.terminalized`.

### 2.4 Run page — `GET /runs/:id`

Stable `<dt>` labels observed:

```
Run Outcome, Started, Completed, Duration, Mutations, Phase, Lease,
Last Heartbeat, Event Status, Latest Workflow Step, Latest Workspace Mutation,
Latest Event Error, Current Message, Reason, Required decision, Summary,
Created, Allowed next actions, Prohibited actions, Run Ended As, Root Cause,
Final Blocking Reason, Last Model Message, Last Proposed Actions, Churn decision
```

`replay_unavailable_integrity_failure` and `POSTGRES_REPLAY_INTEGRITY_FAILURE`
render on this page for the contained row (already asserted).

### 2.5 Uncontained corruption refusal envelope

```
HTTP 500
{"statusCode":500,"code":"POSTGRES_REPLAY_INTEGRITY_FAILURE",
 "error":"Internal Server Error",
 "message":"Replay snapshot integrity check failed for run <id>"}
```

Names the code it refuses about; carries no replay content and no containment
vocabulary.

---

## 3. Five-row reader applicability matrix

Legend — **CAN**: can express the canonical authority · **NARROW**:
status-only · **RAW**: raw history only · **REFUSE**: refuses closed ·
**N/A**: reader does not expose this authority.

| Row | Ticket page | Ticket runtime API | Ticket timeline | Run page | Run-state API | Run-events API | Reconciliation | Aggregate | CLI |
|---|---|---|---|---|---|---|---|---|---|
| 1 valid completion | CAN | CAN (`items[].completionDecisionHash`, `itemStatus`) | RAW | CAN | CAN (`completionAuthoritySnapshot`, `completionDecisionIntegrity`) | RAW | CAN | CAN | **CAN** (prints objective/execution/verification disposition) |
| 2 contained replay-integrity | CAN | NARROW (`itemStatus: failed`) | RAW | **CAN** (only reader exposing `replay_unavailable_integrity_failure`) | NARROW (`replaySummary: null`, no `replayAvailability`) | RAW | NARROW | NARROW | **N/A** — no integrity read |
| 3 verified_progress_exhausted | CAN | NARROW + reason membership (`blockedForVerifiedProgressExhaustion`) | RAW | CAN (`Churn decision`) | **CAN** (`verifiedProgress.block.blockHash`) | RAW (`run.progress_blocked`) | CAN (`completion_blocked`) | CAN | **N/A** — no block read |
| 4 undeclared_sibling_dependency | CAN | NARROW + reason membership (`blockedForUndeclaredSiblingDependency`) | RAW | CAN | **CAN** (`verifiedProgress.block.siblingDependency`) | RAW | CAN (`completion_blocked`) | CAN | **N/A** — no sibling/path read |
| 5 uncontained corruption | REFUSE | REFUSE | REFUSE | REFUSE | REFUSE | REFUSE | n/a — never reached | n/a | **N/A** |

**No cell may be filled from another reader's evidence.** In particular the
Ticket runtime API owns no `blockHash` (rows 3–4) and the Run-state API owns no
`replayAvailability` (row 2).

---

## 4. CLI applicability

`scripts/oquery.js` fetches the remote domains `tickets, runs, logs, history,
plans` (line 281) and prints `runConsequence.completionDecision` fields
(line 1973-1976): `executionDisposition`, `verificationDisposition`,
`completionDisposition`, plus `completionDecisionHash` at lines 717 and 1866.

| Row | Classification | Basis |
|---|---|---|
| 1 valid completion | **APPLICABLE — ASSERT** run/ticket identity, `executionDisposition`, `verificationDisposition`, `completionDisposition`, `completionDecisionHash` | reads `runConsequence.completionDecision` |
| 2 contained replay-integrity | **NOT APPLICABLE** | no replay, integrity or `replayAvailability` read anywhere in the file |
| 3 verified_progress_exhausted | **NOT APPLICABLE** for block authority | never calls `readTicketVerifiedProgressProjection`; no `governedProgressBlock` or `blockHash` read. Its completion decision disposition *is* printable, so a narrow disposition-only assertion is possible if wanted |
| 4 undeclared_sibling_dependency | **NOT APPLICABLE** for sibling/path authority | no `siblingDependency`, `requestedPath` or `siblingDependencyBlocked` read |
| 5 uncontained corruption | **NOT APPLICABLE** | no projection seam reached |

No CLI features are to be added in this tranche to fill cells.

---

## 4a. CLI applicability — corrected 2026-08-05

§4 classified rows 3 and 4 NOT APPLICABLE. **That was wrong**, and the error is
instructive: the grep behind it looked for `governedProgressBlock`, which is not
the payload's field name. The CLI reaches the block through
`verifiedProgress.block`.

`cmdReplay` (oquery.js:679-691) prints:

```
progress block <reason> <blockHash>
  blocked at <blockedAt> cutoff <cutoff.cutoffIdentity>
  decision <churnDecisionHash> policy <progressPolicyHash>
  sibling read <requestedPath> owned by item #<siblingAllocationItemId>
```

Corrected classification:

| Row | CLI | Basis |
|---|---|---|
| 1 valid completion | **APPLICABLE — ASSERTED** | `oquery run-state <runId>`; lifecycle suite |
| 2 contained integrity | NOT APPLICABLE | no `integrityFailureCode`, `replayAvailability` or `POSTGRES_REPLAY_INTEGRITY_FAILURE` anywhere in the file |
| 3 verified_progress_exhausted | **APPLICABLE — NOT ASSERTED** | `oquery replay` prints block reason and `blockHash` |
| 4 undeclared_sibling_dependency | **APPLICABLE — NOT ASSERTED** | same command prints `requestedPath` and sibling item |
| 5 uncontained corruption | NOT APPLICABLE | no projection or refusal seam |

Both directions are pinned by a source contract in the lifecycle suite: the four
absent symbols must stay absent, the three present ones must stay present, and
the matrix row is parsed and checked against both. Re-marking rows 3 or 4
NOT APPLICABLE now fails.

Rows 3 and 4 CLI assertions are **not written** — that is new reader work, and
the session that found this misclassification was scoped to row 1.

## 4b. `oquery replay` crashes before printing governed block detail

**Defect, found 2026-08-05 while closing the rows 3 and 4 CLI cells. Not fixed —
the session was scoped to asserting readers, not changing CLI behaviour.**

Command: `node scripts/oquery.js replay <runId>` (OPERC_URL + cached session).

§4a established that `cmdReplay` prints `progress.block.reason`, `blockHash`,
`blockedAt`, `cutoff.cutoffIdentity`, `churnDecisionHash`,
`progressPolicyHash` and the sibling `requestedPath` /
`siblingAllocationItemId` at oquery.js:679-691. **Those lines are real and
unreachable for a governed structured leaf.** The command throws first:

```
/home/timcis/Documents/ticket-system/scripts/oquery.js:601
            for (const request of governed.requests) {
TypeError: governed.requests is not iterable
```

exiting 1. On the affected Run the surrounding governed fields print
`undefined` (`authorized route`, `economic authority`, `pricing entry`,
`worker account #undefined`), so `governed` exists without the shape the loop
at line 601 assumes.

**What the command does emit before dying**, and what the blocked-restart suite
therefore asserts:

```
Replay: Run #<id> failed
ticket #<ticketId> agent <name> model <model>
run <id> is blocked by a persisted progress decision: verified_progress_exhausted
```

That is real operator-visible output proving the CLI reaches the block
authority. The block DETAIL fields cannot be asserted until the crash is fixed.

**Corrected classification:** rows 3 and 4 are **PARTIAL — BLOCKED BY DEFECT**,
not APPLICABLE — ASSERTED and not NOT APPLICABLE. The suite pins the crash
itself, so a fix will fail that assertion and prompt the fuller cell.

**Smallest correction (not applied):** guard the iteration —
`for (const request of governed.requests || [])` — or populate `requests` for
governed leaf Runs that have none. That is a CLI change and needs its own
session.

## 5. Page semantic-section contract

Assert by `<dt>` label and its sibling `<dd>`, never by whole-page substring —
the same vocabulary legitimately appears in diagnostic sections.

| Concern | Section |
|---|---|
| current terminal disposition | `Run Outcome`, `Run Ended As` |
| failure authority | `Root Cause`, `Final Blocking Reason` |
| triage / retry policy | `Reason`, `Required decision`, `Allowed next actions`, `Prohibited actions` |
| progress/churn history | `Churn decision` |
| replay integrity | body carries `replay_unavailable_integrity_failure` + `POSTGRES_REPLAY_INTEGRITY_FAILURE` |
| raw history | event list |

### The completed-Run churn case

A **completed** Run's page renders `verified_progress_exhausted` under
`Churn decision`. It is historical, not the terminal authority: the final
progress window produced no new verified progress and the Run then completed
because its declared work was satisfied.

Prove it as:

1. the `Run Outcome` / `Run Ended As` section reads completed;
2. `Run-state.verifiedProgress.block` is `null` — no block owns the terminal
   state (this is the decisive check, and it is a field, not a substring);
3. `completionDecisionIntegrity.status` is not `missing`;
4. `verified_progress_exhausted` appears only within the `Churn decision`
   section.

Do not assert absence of the string anywhere on the page.

---

## 6. Existing fixture map

| Row | Suite | Scenario | Cold restart | Quiescence | Neighbours active at assert? |
|---|---|---|---|---|---|
| 1 valid completion | `governed-verified-progress-lifecycle-postgres-test` | 2-request lifecycle to `completed` | yes — `cold` server | `waitForSchedulerQuiescence` before baseline | no |
| 2 contained integrity | `governed-replay-corruption-postgres-test` | corruption → terminalize | yes — `third` server | implicit; suite asserts counts | siblings terminal |
| 3 verified_progress | `governed-blocked-restart-postgres-test` | crash → block | yes — `second` server | `waitForSchedulerQuiescence` | **yes** — restart is recovery |
| 4 sibling dependency | `governed-sibling-dependency-postgres-test` | real runtime sibling read | yes — `fresh` server | closing read after sibling quiesces | **yes** by design |
| 5 uncontained | `governed-replay-corruption-postgres-test` | sibling replay corrupted, never terminalized | yes — `fourth` server | quiescence before refusal reads | siblings terminal |

IDs: Ticket from `seeded.ticketId` / `run.ticketId`; Run from `seeded.runIds[n]`;
allocation item from `run.leafRunBinding.allocationItemId` or plan items.

Helpers to reuse: `findRuntimeRun`, `durableTerminalCounts`, `durableRunCounts`,
`countDelta`, `waitForSchedulerQuiescence`
(`scripts/fixtures/terminal-projection-restart.js`).

---

## 7. Mutation-owner map

Assign each mutation only to a suite that executes its owner.

| Assertion | Canonical owner | Suite that must own the mutation |
|---|---|---|
| valid completion mapping | `deriveLeafItemDisposition` | `structured-allocation-leaf-run-contract-test` |
| completion-authority matching | `evaluateRunCompletionEvidence` | `structured-allocation-leaf-run-contract-test`, `malformed-completion-binding-postgres-test` |
| blocked → `completion_blocked` | `deriveLeafItemDisposition` | `structured-allocation-leaf-run-contract-test` ✔ done |
| progress `blockHash` preservation | `projectBlock` | `verified-progress-projection-postgres-test` ✔ done |
| tampered block refuses on read | `normalizeGovernedProgressBlock` | `verified-progress-terminal-mapping-test` ✔ done |
| progress vs sibling block shape | `buildGovernedProgressBlock` | `verified-progress-terminal-mapping-test` ✔ done |
| contained vs uncontained | `hasPersistedReplayIntegrityDisposition` / `readRunReplayForProjection` (server.js 6494-6512) | `governed-replay-corruption-postgres-test` ✔ done |
| corrupt payload exclusion | `replaySnapshotFromRow` (store.js 795) | `governed-replay-corruption-postgres-test` ✔ done |
| sibling/path identity | `blockGovernedRunForSiblingRead` → block contract | `governed-sibling-dependency-postgres-test` ✔ done |
| aggregate failed/blocked child | aggregate projection | `governed-replay-corruption-postgres-test` (partial), needs rows 3–4 |
| completion-evidence isolation | Ticket projection | `governed-replay-corruption-postgres-test` ✔ done |
| scheduler ineligibility | scheduler claim query | restart suites ✔ done |
| read-only projection | n/a — count assertions | restart suites ✔ done |
| Ticket runtime scoping | `findRuntimeRun` | `governed-blocked-restart-postgres-test` ✔ done |
| Run-state block authority | `serializeRunRuntimeState` | **unowned** — see checklist |
| CLI applicability | `scripts/oquery.js` | **unowned** |

---

## 8. Remaining implementation checklist

**Reader cells remaining: 24.** Rows × readers where an assertion is still
missing, excluding cells classified NOT APPLICABLE (12) and cells already
asserted (9).

**Mutation cases remaining: 9.**

By file, in the recommended order:

1. **`structured-allocation-leaf-run-contract-test`** — no work; owner
   assertions complete.
2. **`governed-verified-progress-lifecycle-postgres-test`** (row 1): Ticket
   runtime `items[]` via `findRuntimeRun` (`itemStatus`, `completionDecisionHash`,
   `allocationItemId`); Run-state `completionAuthoritySnapshot.objectiveContractHash`
   vs decision hash, `completionDecisionIntegrity.status !== 'missing'`,
   `verifiedProgress.block === null`; events API `run.completion_decided`;
   page `Run Outcome` section. **≈10 assertions. Mutations: 2.**
3. **`governed-replay-corruption-postgres-test`** (rows 2, 5): Ticket runtime
   `items[]` for the corrupt leaf; Run-state `replaySummary === null` +
   `completionDecisionIntegrity`; both APIs refuse for the uncontained Run;
   aggregate parity. **≈9 assertions. Mutations: 3.**
4. **`governed-blocked-restart-postgres-test`** (row 3): Run-state
   `verifiedProgress.block.blockHash` equals the durable hash,
   `block.siblingDependency === null`; events API `run.progress_blocked`;
   page `Churn decision` section. **≈5 assertions. Mutations: 2.**
5. **`governed-sibling-dependency-postgres-test`** (row 4): Run-state
   `verifiedProgress.block.siblingDependency.{siblingRunId,
   siblingAllocationItemId, requestedPath}` and `blockHash`; Ticket runtime
   reason membership. **≈6 assertions. Mutations: 2.**
6. **CLI** — row 1 only, asserting the four disposition fields listed in §4.
   **≈4 assertions.**
7. **Final Ticket-scoped quiescent no-drift read** already exists for rows 3–4;
   add for rows 1, 2, 5 using `durableTerminalCounts` + `countDelta`.
8. **One final `suite-mutation-test` run** — must remain 54/54.

No production source change is expected for any item above.

---

## 9. Corrections to previously recorded conclusions

1. **"The Run-state API does not own block authority."** Wrong. It exposes the
   complete per-Run block at `verifiedProgress.block`, including `blockHash`,
   `reason`, `churnDecisionHash` and `siblingDependency`. The earlier check
   searched for a top-level `governedProgressBlock` key, which does not exist,
   and concluded the authority was absent. Row 3 and row 4 are **CAN**, not
   narrow, for this reader.
2. **"page, API and CLI cannot disagree" (server.js:26258)** is accurate for the
   page and API only. `oquery.js` never reads that seam.
3. **`replayAvailability` is not on the Run-state API.** It is a Run-page
   concern. Any plan asserting it on that route is asserting an absent field.

## 10. Product defects found and corrected

Both defects recorded during blueprint implementation were corrected in a
session scoped to exactly those two changes.

### 10.1 Governed block authority was invisible to reconciliation — FIXED

`deriveLeafItemDisposition` received no governed block. A blocked leaf's
completion decision says `incomplete` / `RUN_EXECUTION_FAILED`, exactly what an
ordinary failure says, so at item level — and on every reader derived from it —
`verified_progress_exhausted` and `undeclared_sibling_dependency` were
indistinguishable from a plain failure.

**Correction:** `persistence/postgres/store.js` reconciliation now passes
`current.run.governedProgressBlock`, and the owner consumes it. Only a persisted
block counts; nothing is inferred from status, churn or an incomplete
disposition.

**An earlier claim in this document was wrong.** It said a `blocked` completion
disposition was synthetic-only. Production emits it from
`buildCompletionDecision` for `VERIFICATION_UNAVAILABLE` and
`infrastructure_failed`. Reusing `completion_blocked` for governed blocking
would therefore have collapsed "the verifier could not run" into "the
coordination controls stopped this Run". Two new closed reasons carry the
distinction:

| Reason | Meaning |
|---|---|
| `completion_blocked` | completion-decision sense: verification unavailable / infrastructure failed |
| `governed_progress_blocked` | durable governed block, non-sibling reason |
| `governed_sibling_dependency_blocked` | durable `undeclared_sibling_dependency` block |
| `completion_unsuccessful` | ordinary unsuccessful execution, no block |

### 10.2 Completed Run classified from historical churn — FIXED

A completed Run holding no persisted block was listed under
`blockedForVerifiedProgressExhaustion`, contradicting Run-state and the durable
row.

**Correction:** `runtime/verified-progress-projection.js` restricts the churn
fallback to NONTERMINAL Runs. A terminal Run contributes a blocked reason only
from its own persisted block. `runStatus` is carried on the run projection for
that decision. Live churn reporting for executing Runs is retained; historical
churn remains visible on the Run page under "Churn decision".

**Churn-fallback domain verdict:** CHURN FALLBACK IS VALID ONLY FOR NONTERMINAL
RUNS (`pending`, `running`). Terminal states (`completed`, `failed`,
`interrupted`) must use the persisted block or nothing.

### 10.3 Still open (unchanged)

* `/api/runs/:id/state` reports
  `completionDecisionIntegrity.code = COMPLETION_EVIDENCE_MISSING` for a leaf
  that failed on replay integrity — truthful, but the same code the Ticket
  projection uses to REFUSE. It is `null` for a healthy completed leaf.
* The Run-state API exposes no `replayAvailability`; an API-only consumer
  distinguishes "no replay yet" from "replay withheld" only via
  `replaySummary === null`.

---

## 11. Five-row proof matrix — COMPLETE

Every cell names the suite that owns it. No cell is filled from a different
reader.

Suites: **L** lifecycle · **B** blocked-restart · **S** sibling-dependency ·
**C** replay-corruption · **X** leaf-run contract

| | 1 valid completion | 2 contained integrity | 3 verified_progress_exhausted | 4 sibling dependency | 5 uncontained |
|---|---|---|---|---|---|
| origin | production | controlled fixture | production | production | controlled fixture |
| cold process | ✔ L `cold` | ✔ C `third` | ✔ B `second` | ✔ S `fresh` | ✔ C `fourth` |
| Ticket page | ✔ L | ✔ C | ✔ B | ✔ S | ✔ refuses, C |
| Ticket runtime API | ✔ L `findRuntimeRun` | ✔ C `findRuntimeRun` | ✔ B | ✔ S | ✔ refuses, C |
| Ticket timeline | RAW HISTORY ONLY ✔ L | RAW HISTORY ONLY ✔ C | RAW HISTORY ONLY ✔ B | RAW HISTORY ONLY ✔ S | RAW HISTORY ONLY ✔ C |
| Run page | ✔ L §sections | ✔ C | ✔ B §sections | ✔ S §sections | ✔ 500, C |
| Run-state API | ✔ L | ✔ C | ✔ B `verifiedProgress.block` | ✔ S `block.siblingDependency` | ✔ refuses, C |
| Run-events API | ✔ L | ✔ C | ✔ B | ✔ S | ✔ C |
| reconciliation | `completion_verified` L | `completion_unsuccessful` C | `governed_progress_blocked` B | `governed_sibling_dependency_blocked` S | refuses first |
| parent aggregate | ✔ L | ✔ C | ✔ B | ✔ S | refuses first |
| CLI | APPLICABLE — ASSERTED, L | NOT APPLICABLE §4 | PARTIAL — BLOCKED BY DEFECT §4b, B | PARTIAL — BLOCKED BY DEFECT §4b | NOT APPLICABLE §4 |
| completion authority | decision + matching hash L | none; not required C | none B | none S | none |
| integrity-failure authority | absent L | `POSTGRES_REPLAY_INTEGRITY_FAILURE` C | absent B | absent S | refusal envelope C |
| progress block + blockHash | absent L | absent C | ✔ exact hash B | absent S | n/a |
| sibling block + blockHash | absent L | absent C | absent B | ✔ exact hash S | n/a |
| replay availability | n/a | `replay_unavailable_integrity_failure`, Run page only C | n/a | n/a | none invented C |
| scheduler eligibility | ineligible L | ineligible C | ineligible B | ineligible S | unchanged C |
| complete no-side-effect | ✔ Ticket-scoped L | ✔ **full matrix** C | ✔ Ticket-scoped B | ✔ Ticket-scoped S | ✔ **full matrix** C |

### Rows 2 and 5 full no-side-effect capture

Both captured with the Ticket quiescent, every applicable read issued between
two `fullTerminalCounts` snapshots. Identical before and after:

```
runs:3  activeLeases:0  leaseEvents:4  reservations:3  requestOrdinals:1
settlements:3  responseReplays:1  receipts:1  consequences:2
replaySnapshots:3  events:124  retryEvents:3  integrityEvents:1
terminalizedEvents:2  evidenceBatches:8  runRevisions:"1:12,2:5,3:5"
```

For row 5 the refusing reads additionally leave `runRevisions` byte-identical —
nothing was terminalized, repaired or reclaimed — and create no containment
record.

### Cells deliberately not asserted
### Cells deliberately not asserted

* **CLI row 1** — classified APPLICABLE in §4 but **not executed**. Rows 2-5
  are NOT APPLICABLE with the source reason recorded there. This is the one
  remaining cell in the matrix.

## 11a. Completion evidence is owed only by a completion claim (corrected 2026-08-05)

An earlier revision of this matrix reported the contained-integrity row's
reconciliation reason as `completion_decision_missing`, while the same row's
page assertion said no missing-evidence refusal was attributed to that leaf.
Both could not describe one disposition.

**Verdict: CONTAINED-INTEGRITY LEAF WAS MISCLASSIFIED** — a production defect,
not a mislabel. Captured from the live scenario after quiescence:

| Input | Value |
|---|---|
| Run status | `failed` |
| completion decision | absent |
| completion authority hash | present |
| integrity authority | `POSTGRES_REPLAY_INTEGRITY_FAILURE` |
| governed block | none |

| Output | Value |
|---|---|
| `deriveLeafItemDisposition` | `failed` / **`completion_decision_missing`** |
| `structuredAllocationLeafExecution` item | same |
| aggregate item | same |
| Ticket aggregate | `failed` |

The STATUS was correct; the REASON was not. `evidence.result` is
`not_applicable` — the Run never claimed completion, so no evidence was owed —
yet the reason claimed evidence was required and absent. A source comment
acknowledged the string was retained "so existing consumers keep the string they
had".

**Correction:** that branch now returns `completion_unsuccessful`. The absence
of a decision remains visible through a null `completionDecisionHash`.

**These are different facts and must not be conflated:**

| Fact | Meaning |
|---|---|
| `completionDecisionIntegrity.status = missing` | diagnostic: no decision is available to this reader |
| item reason `completion_decision_missing` | terminal claim: successful completion evidence was REQUIRED and absent |

Only a Run that reached `completed` can make the second claim. The four-case
regression matrix in `structured-allocation-leaf-run-contract-test` pins it:
completed+missing → `completion_decision_missing`; failed+no decision →
`completion_unsuccessful`; interrupted+no decision → not missing-evidence;
completed+valid → `completion_verified`.

**Unowned mutation.** `projectedStatus`'s `not_applicable` branch — a terminal
non-success Run projecting its own status through `transitionTicketAfterRun` —
has no suite that drives it. The malformed-completion suites only drive a
`completed` Run, and the restart suites never invoke the transition. Recorded,
not claimed.

## 11b. Suites required when completion-authority projection changes

Derive this set from source rather than maintaining another list — but derive it
from the SEAM, not from the symbol names.

**A symbol grep is not sufficient**, and this is the trap that hid the
regression:

```
grep -rln "runCompletionAuthorityHash\|evaluateRunCompletionEvidence" scripts/
  -> malformed-completion-binding-postgres-test.js
     structured-allocation-leaf-run-contract-test.js
```

That misses `structured-allocation-leaf-run-postgres-test`, the suite that
actually broke, because it never names those symbols — it exercises the
authority comparison through the store.

**Use the seam instead:**

```
grep -rln "transitionTicketAfterRun\|reconcileStructuredAllocationLeafItems" scripts/
```

which yields, and all of which must run for any change to Ticket projection or
reconciliation authority comparison:

* `structured-allocation-leaf-run-postgres-test` — holds the deliberate
  foreign-authority negative cases; **omitted from session gate lists for
  several sessions while failing**
* `malformed-completion-projection-postgres-test`
* `malformed-completion-binding-postgres-test`
* `completion-decision-postgres-test`
* `verified-progress-terminal-mapping-test`
* `governed-leaf-production-path-postgres-test`
* `postgres-persistence-integration-test`
* `event-append-lock-order-test`

A per-session gate list assembled from the suites a session happens to touch
misses this set. The release checkpoint does not — it already requires every one
of them.

## 12. Mutation ownership

Caught at the owner that executes the code, restore verified by SHA-256.

| Mutation | Owner | Suite |
|---|---|---|
| reconciliation ignores a real progress block | store reconciliation | B |
| reconciliation ignores a real sibling block | store reconciliation | S |
| every incomplete decision treated as blocked | `governedBlockItemReason` | C |
| progress block gains sibling authority | `governedBlockItemReason` | B |
| sibling block collapses to progress block | `governedBlockItemReason` | S |
| replay-integrity failure becomes a governed block | `deriveLeafItemDisposition` | C |
| completed Run grouped from churn fallback | `projectTicketVerifiedProgress` | L |
| persisted progress block leaves the summary | `projectTicketVerifiedProgress` | B |
| persisted sibling block leaves the summary | `projectTicketVerifiedProgress` | S |
| contained corruption becomes uncontained | `hasPersistedReplayIntegrityDisposition` | C |
| uncontained corruption becomes contained | `readRunReplayForProjection` | C |
| corrupt replay payload exposed | `replaySnapshotFromRow` | C |
| runtime helper inspects a sibling | `findRuntimeRun` | C |
| projection drops block hash | `projectBlock` | B |
| projection drops sibling authority | `projectBlock` | S |
| item loses `completion_verified` | `deriveLeafItemDisposition` | L |
| item loses completion-decision hash | `deriveLeafItemDisposition` | L |
| tampered block accepted on read | `normalizeGovernedProgressBlock` | mapping test |

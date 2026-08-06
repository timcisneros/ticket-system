# Structured Leaf Progress-Policy Authority — Decision Required

**Status: OPTION B ACCEPTED. Version-1 values APPROVED 2026-08-06 — see §6b.
Implementation authorized.**

Recorded 2026-08-06 from `structured-allocation-controlled-evaluation`.

---

## 1. The proven defect

Structured Allocation Plan v2 admission succeeds and persists three valid items.
Leaf preflight and Run-draft preparation succeed. The store then refuses:

```
code     GOVERNED_LEAF_CAPTURE_REQUIRED
at       PostgresRuntimeStore._captureGovernedLeafAuthority
```

`governedLeafCapture` requires `{ policySource, progressControlPolicy }`.
`server.js` supplies neither, **no production caller builds a
`progressControlPolicy` at all**, zero leaf Runs persist, the transaction rolls
back cleanly, and the public failure is falsely classified as a concurrency
conflict.

The policy source half is solvable by reading the same governed container the
planner already reads, with `role = structured_leaf_executor`. **The progress
policy half is the open question this memo decides.**

---

## 2. Rejected interpretation

The previous session concluded the only owners were a fourth policy-source
subdocument, a new operator configuration table, or removal of the capture
requirement. **That framing was too narrow.** It missed the option the Tranche 5
direction actually points at: a repository-owned, versioned policy captured with
the Run through the execution-policy authority that already exists.

---

## 3. Phase 1 — execution-policy authority inventory

| Authority | Owner | Mutable or captured | Persistence | Hash / version | Scope | Held by server.js before leaf admission? |
|---|---|---|---|---|---|---|
| `executionPolicy` (`DEFAULT_EXECUTION_POLICY`) | ticket | **mutable** admin/ticket field | `tickets.body` | `executionPolicyHash` when snapshotted | Ticket | yes |
| `runtimeLimitsSnapshot` | run draft | **captured** | `runs.body` | `runtimeLimitsRevision` | Run | yes — built in `prepareAgentRunDraft` |
| `runtimeBudgetSnapshot` | `buildRuntimeBudgetSnapshot` | **captured, immutable** | `runs.body` | `snapshotHash`, `executionPolicyHash`, `runtimeLimitsRevision` | Run | **yes — already on every leaf draft** |
| `completionAuthoritySnapshot` | Tranche 3 | captured, immutable | `runs.body` | `snapshotHash` | Run | yes |
| `declaredWorkSnapshot` | Tranche 1/2 | captured, immutable | `runs.body` | `contractHash` | Run/item | yes |
| `governedExecution` (routing + economics + pricing) | Tranche 4 | captured, immutable | `runs.body` | `governedExecutionHash` | Run | **no — this is what leaf admission builds** |
| environment constants (`RUNTIME_*`) | deployment | **mutable, ambient** | none | none | process | not authority |

**`runtimeBudgetSnapshot` is the decisive find.** It is already immutable,
already hashed, already Run-scoped, already bound to the execution policy that
produced it, and already present on every leaf draft at the exact moment leaf
admission needs a progress policy.

Its fields: `maxAttempts`, `maxModelRequests`, `maxWorkspaceOperations`,
`maxExecutionSteps`, `maxProcessOperations`, `maxBrowserOperations`,
`maxOutputArtifactBytes`, `maxRuntimeDurationMs`, `allowParallelRuns`,
`runtimeLimitsRevision`, `executionPolicyHash`, `snapshotHash`.

---

## 4. Phase 2 — progress-policy field inventory

`buildProgressControlPolicy` (`runtime/churn-decision-contract.js`), version 1.

| Field | Kind | Existing authority? | Product decision or mechanical? |
|---|---|---|---|
| `maximumConsecutiveNoProgressWindows` | runtime execution control — how many answered windows may credit no declared fact before stopping | **none** | **product decision** |
| `maximumRepeatedMutations` | safety bound on repeated identical mutations | **none** | **product decision** |
| `maximumFailedOperationStreak` | safety bound on consecutive failed operations | **none** | **product decision** |
| `maximumMutationReversals` | safety bound on write/undo oscillation | **none** | **product decision** |
| `maximumInspectionOnlyStreak` | safety bound on read-only churn | **none** | **product decision** |
| `maximumCumulativeExecutionDurationMs` | duration boundary | **`runtimeBudgetSnapshot.maxRuntimeDurationMs`** — required positive integer, never null | **mechanical derivation** |
| `resourceDimensions` | which durable dimensions the projection reports | closed vocabulary: `provider_requests`, `durable_operations`, `settled_micro_usd`, `budget_charged_units` | **repository-owned**, not deployment-specific |

Every field changes **termination** behaviour and therefore spending. None is a
model claim. None is objective semantics. All must be captured per Run, because
a Run's stop reason must remain explainable from the authority it ran under.

**One field maps cleanly. Five are genuine product decisions with no existing
home. One is a repository-owned constant.**

---

## 5. Phase 3 — the five options

### Option A — derive entirely from the existing immutable snapshot — **INSUFFICIENT**

Truthfully supplies exactly one field:
`maximumCumulativeExecutionDurationMs ← runtimeBudgetSnapshot.maxRuntimeDurationMs`.

The five churn tolerances have no counterpart in `executionPolicy`,
`runtimeLimitsSnapshot` or `runtimeBudgetSnapshot`. Deriving them from
`maxModelRequests` or `maxExecutionSteps` would be **fabrication**: "how many
requests may this Run make" and "how many wasted windows may it burn before we
stop it" are different questions, and conflating them would make a Run's stop
reason unexplainable from its own authority.

**Verdict: cannot stand alone. Adopted only for the duration field.**

### Option B — repository-owned versioned policy captured into the existing execution-policy authority — **RECOMMENDED**

The repository declares one explicit, versioned progress-control policy, hashes
it, and captures it immutably per Run alongside the budget snapshot that already
travels with the Run.

This is **not** a hidden default. A default is an unstated value silently
substituted; this is a stated, hashed, versioned product decision that travels
with every Run and is visible in its durable authority. Evolving it means
publishing version 2 — historical Runs keep version 1 and remain explainable.

* no operator configuration surface;
* no migration (`runs.body` is JSONB and already carries every other snapshot);
* duration comes from Option A rather than being restated;
* separation of concerns is preserved — routing, economics, execution control
  and completion stay distinct.

**Verdict: smallest truthful correction.**

### Option C — operator-configurable durable progress policy — **NOT NOW**

Justified only if churn tolerance genuinely varies by deployment or operator.
No evidence supports that today, and it costs a migration, a revision and
lifecycle model, an admission path, invalidation rules and an operator surface.
Option B does not preclude it: a later version can read an operator row when one
exists, because the policy is already captured per Run.

**Verdict: configurability without demonstrated need.**

### Option D — fourth governed-policy-source subdocument — **REJECTED**

`runtime/governed-policy-source.js` admits exactly three subdocuments and states
that "a fourth is a configuration error, not an extension point." That boundary
is substantive, not stylistic: routing and economics answer *who may be called
and what may be spent*; progress control answers *when execution stops making
progress*. The first two are provider-facing procurement authority, the third is
runtime execution control. Reversing the boundary for convenience would put
termination policy in a container operators edit for pricing.

**Verdict: wrong home. Do not reverse for convenience.**

### Option E — relax the capture requirement — **REJECTED**

Removing it restores ungoverned structured leaf admission, which the Tranche 4
cutover deliberately removed, and forfeits Tranche 5 guarantees that depend on a
captured policy: a persisted block bound to `progressPolicyHash`; churn
decisions replayable from durable rows; `verified_progress_exhausted` meaning
what it says; and the A3 duration bound, which `buildProgressControlPolicy`
explicitly refuses to default *because* an unbounded governed Run is the defect
A3 records.

**Verdict: disfavoured, and the capture is not redundant.**

---

## 6. Recommendation

**Option B, with Option A supplying the duration field.**

> Progress control is a **versioned runtime execution policy captured with the
> Run** — not a model claim, and not part of provider-routing or economic
> policy.

The repository supports this conclusion: `runtimeBudgetSnapshot` already
demonstrates the pattern (repository-built, hashed, immutable, Run-scoped,
derived from the execution policy), and `maxRuntimeDurationMs` already supplies
one of the seven fields.

---

## 6a. Phase 1 scope verdict — ALL LEAVES SHARE ONE POLICY-RELEVANT EXECUTION SNAPSHOT

Proved from source rather than sampled. Inside `prepareAgentRunDraft`,
`buildRuntimeBudgetSnapshot` takes exactly two inputs:

```js
buildRuntimeBudgetSnapshot({
  runtimeLimits: { ...runtimeLimitsSnapshot, revision: …runtimeLimitsRevision },
  executionPolicy: executionPolicySnapshot
})
```

* `runtimeLimitsSnapshot` ← `resolveAgentRuntimeLimits(ticket.objective, { workflow })`
  — the **agent is not a parameter**;
* `executionPolicySnapshot` ← `copyExecutionPolicy(ticket.executionPolicy, 'owned_paths')`
  — Ticket policy plus a scope constant across the items of one structured plan.

Neither the assigned agent nor the allocation item participates, so every leaf
draft of one plan necessarily yields an identical `runtimeBudgetSnapshot`,
including `snapshotHash`, `executionPolicyHash`, `runtimeLimitsRevision` and
`maxRuntimeDurationMs`.

**One canonical `governedLeafCapture` per plan admission is therefore correct**,
and the store may copy that immutable capture to every leaf Run.

**Equality must still be verified at runtime, not assumed.**
`resolveAgentRuntimeLimits` re-reads the current runtime-limits configuration on
each draft, so a configuration change mid-admission could in principle produce
drafts that disagree. The implementation must compare the policy-relevant fields
across all drafts and refuse before admission when they differ — never take the
first draft's snapshot on faith.

---

## 6b. BLOCKING — the version-1 tolerance values are not decided

**Implementation stopped here, deliberately.** The implementing brief states:
*"Do not invent different version-1 values during implementation. If the memo
does not state an exact value needed by the builder, stop and report the missing
decision rather than choosing one implicitly."*

This memo fixes two of the three groups and **not** the third:

| Group | Decided? |
|---|---|
| `maximumCumulativeExecutionDurationMs` | **yes** — derived from `runtimeBudgetSnapshot.maxRuntimeDurationMs` |
| `resourceDimensions` | **yes** — `['provider_requests', 'settled_micro_usd']` |
| the five churn tolerances | **NO — numeric values were never stated** |

The builder cannot be written without them, and choosing them silently is
exactly the fabrication this decision exists to prevent. Each one changes when a
Run stops and therefore what it spends.

### Recommended version 1, for approval

`boundedTolerance` requires a positive integer ≤ 1000; there is no default.
The values below are the ones the test fixture has used throughout Tranches 4-5,
so adopting them keeps every existing governed suite's behaviour unchanged and
makes the production policy identical to the one already exercised:

| Field | Recommended | Rationale |
|---|---|---|
| `maximumConsecutiveNoProgressWindows` | 3 | three answered windows crediting no declared fact before stopping |
| `maximumRepeatedMutations` | 3 | tolerates a retry and a correction, stops the third repeat |
| `maximumFailedOperationStreak` | 4 | one more than the mutation tolerance: failures are often transient |
| `maximumMutationReversals` | 3 | write/undo oscillation past three is not progress |
| `maximumInspectionOnlyStreak` | 4 | reading is legitimate work; four consecutive read-only windows is not |

**Explicitly NOT adopted from the fixture:**
`maximumCumulativeExecutionDurationMs: 3_600_000`. The fixture calls it
"generous by design" so unrelated suites are not incidentally blocked — a
test-harness convenience, not product authority. Production derives duration
from `runtimeBudgetSnapshot.maxRuntimeDurationMs`.

### APPROVED VERSION 1 — 2026-08-06

The numeric decision is **RESOLVED**. Version 1 of the structured leaf
progress-control policy is exactly:

```
version:                              1
maximumConsecutiveNoProgressWindows:  3
maximumRepeatedMutations:             3
maximumFailedOperationStreak:         4
maximumMutationReversals:             3
maximumInspectionOnlyStreak:          4
resourceDimensions:                   ['provider_requests', 'settled_micro_usd']
maximumCumulativeExecutionDurationMs: runtimeBudgetSnapshot.maxRuntimeDurationMs
```

These constitute **explicit version-1 runtime execution policy**. They are not
environment defaults, model output, operator configuration, routing policy or
economic policy.

`maximumCumulativeExecutionDurationMs` is derived **only** from
`runtimeBudgetSnapshot.maxRuntimeDurationMs`. The fixture's 3 600 000 ms value is
a harness convenience and is explicitly **not** adopted.

Historical Runs are unchanged. A later adjustment requires an explicit version
bump and must not rewrite existing captured Runs.

---

## 7. Phase 6 — exact implementation brief

**Not implemented in this session.**

| Item | Specification |
|---|---|
| Canonical owner | `runtime/churn-decision-contract.js` — already owns the constructor, normalizer and hash |
| Builder | new pure `buildDefaultProgressControlPolicy({ runtimeBudgetSnapshot })` in that module; production and fixtures both call it |
| Version | reuse `PROGRESS_POLICY_VERSION` (currently 1); a tolerance change requires an explicit bump |
| Version-1 values | five tolerances declared explicitly in the contract with a comment stating each is a product decision; `maximumCumulativeExecutionDurationMs` from `runtimeBudgetSnapshot.maxRuntimeDurationMs`; `resourceDimensions` = `['provider_requests', 'settled_micro_usd']` |
| Snapshot and hash | existing `policyHash` over all fields — unchanged |
| Capture point | `server.js admitStructuredAllocationLeafRuns`, immediately before the store call, built once per plan |
| Persistence | inside `governedExecution.progressControlPolicy` on each leaf Run — already where the store writes it |
| Binding | plan-scoped construction, Run-scoped capture; identical for every sibling of one plan |
| Server wiring | read the governed container with `role = structured_leaf_executor` via `readGovernedPolicySource`, build the progress policy, pass `governedLeafCapture: { policySource, progressControlPolicy }` |
| Store validation | **unchanged**, still fail-closed |
| Recovery | none — the policy is captured, so restart replays the same authority |
| Historical Runs | untouched; they carry no leaf authority because none was ever admitted |
| Allocated vs dynamic | identical; ownership differs, progress authority does not |
| Migration | **none required** — `runs.body` is JSONB and already carries the field |
| Missing authority | refuse closed with the existing `GOVERNED_LEAF_CAPTURE_REQUIRED` / `GOVERNED_LEAF_POLICY_INCOMPLETE`; never fabricate a capture |
| Test owners | `structured-allocation-leaf-run-postgres-test` (admission), `governed-verified-progress-lifecycle-postgres-test` (execution), `structured-allocation-evaluation-runner-postgres-test` (B/C end to end) |
| Mutation owners | server omits the capture; builder reads a mutable current policy instead of the captured snapshot; duration derived from anything other than `maxRuntimeDurationMs`; tolerance changed without a version bump |

### Separate correction — truthful failure classification

Conceptually independent, and must not be bundled merely because both touch the
same catch block.

| Condition | Reason code |
|---|---|
| expected revision changed, plan state changed, equivalent Runs already admitted, matching binding exists, recognized serialization conflict | `leaf_admission_conflict` — **only these** |
| `GOVERNED_LEAF_CAPTURE_REQUIRED`, `GOVERNED_LEAF_POLICY_INCOMPLETE`, `GOVERNED_LEAF_ROLE_MISMATCH`, invalid binding, unavailable target | its own existing stable code, preserved exactly |
| unexpected `Error` | `leaf_admission_internal_failure` |
| PostgreSQL error | `leaf_admission_internal_failure` with sanitized class and SQLSTATE |

Durable diagnostic fields: failure stage, stable application code, SQLSTATE when
present, sanitized failure class, timestamp, retryability when derivable.
**Never** persisted or exposed: raw provider request/response, credentials,
prompts, filesystem contents, arbitrary database detail, stack traces, unbounded
`error.message`.

---

## 8. Consequences and reversal

Adopting Option B unblocks structured leaf admission, governed leaf execution,
and therefore Tranche 6's structured arms. It does **not** create an operator
surface, and it does not decide whether tolerances should eventually be
configurable.

**Reverse to Option C if** deployments demonstrably need different churn
tolerances, or an operator must relax one for a specific Ticket. Because the
policy is already captured per Run and versioned, that change reads an operator
row at capture time and leaves historical Runs intact.

**Relationship to the tranches.** Tranche 4 made ungoverned structured leaf
admission impossible; Tranche 5 built the verified-progress controls that consume
this policy and proved a persisted block binds `progressPolicyHash`; Tranche 6
cannot measure the structured path until leaf Runs execute. This memo decides
the one authority all three depend on.

---

## 9. Status

**DECISION REQUIRED.** Not implemented, not closed. No production behaviour
changed in this session, and the Tranche 6 blocker remains open.

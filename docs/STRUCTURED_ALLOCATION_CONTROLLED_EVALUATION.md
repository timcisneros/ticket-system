# Structured Allocation — Controlled Evaluation Protocol

Tranche 6, session 1. **Protocol design and repository-seam audit only.** No
production behaviour changed. The evaluation has NOT been run.

---

## 1. The decision question

> Does the structured-allocation path built in Tranches 1–5 improve real agent
> work enough to justify its complexity, latency and cost compared with a simpler
> execution path?

Authorized outcome: evidence supporting **RETAIN**, **REVISE** or **STOP** for the
structured-allocation path.

### The exact source-backed Tranche 6 contract

`docs/STRUCTURED_ALLOCATION_AND_MODEL_ECONOMICS_ROADMAP.md` §"Tranche 6 —
Controlled Evaluation and Product Decision" is four sentences:

> Run controlled scenarios comparing allocation quality, completion truthfulness,
> latency, cost, and churn. Use the evidence to decide whether to retain, revise,
> or stop the structured allocation path. This tranche is not implemented by
> Tranche 1.

That is the whole authoritative contract. It fixes:

* **five dimensions** — allocation quality, completion truthfulness, latency,
  cost, churn;
* **three outcomes** — retain, revise, stop;
* **a method** — controlled scenarios.

No sixth dimension is added here. Metrics that were easy to collect but that the
contract does not name (agent turn counts, file sizes, prose quality) are
deliberately excluded.

**Not to be confused with** `docs/PROCESS_EXECUTION_ROADMAP.md` §"Tranche 6 —
Verification and completion semantics", which is a different roadmap's tranche
and is already COMPLETE. This document concerns only the structured-allocation
roadmap.

### Phase 1 verdict

**TRANCHE 6 REQUIRES A CONTROLLED-EVALUATION PROTOCOL.**

Searched: the roadmap, `docs/DECISION_LOG.md`, `docs/ARCHITECTURAL_DECISIONS_PENDING.md`,
`docs/PRODUCT_SYNTHESIS.md`, `docs/REMAINING_PRODUCT_UNCERTAINTIES.md`,
`docs/BUSINESS_SCENARIO_VERIFICATION_CONTRACTS.md`, and every
`scripts/*-experiment.js` / `*-benchmark.js` / `fixture-evaluation.js`.

| Element | Already defined? |
|---|---|
| Baseline scenarios | **No** — `fixtures/workspace-catalog/scenario-contracts.json` defines 16 *capability/safety* contracts (artifact-success and blocked-correctly). They are not comparative and have no arms. |
| Comparison arms | **No** |
| Success thresholds | **No** |
| Acceptable regressions | **No** |
| Statistical / repetition requirements | **No** |
| Retain/revise/stop rules | **No** |

The existing `*-experiment.js` and `*-benchmark.js` scripts are ad-hoc research
harnesses: most require `ALLOW_LIVE_OPENAI_TESTS=true` and a real
`OPENAI_API_KEY`, several are JSON-era (they seed `allocation-plans.json` and
similar `DATA_FILES`), and none are `*-test.js`, so **none is covered by
`scripts/test-manifest.js`** — the manifest governs `scripts/*-test.js` only.
They are not authority for this evaluation and must not be mistaken for it.

---

## 2. Comparison arms

The repository selects one of **three distinct existing production paths** at
ticket creation. All three already exist; none is a strawman, and none is built
for this evaluation.

### Arm A — DIRECT / INDIVIDUAL (the simple baseline)

`assignmentTargetType: 'agent'` → `assignmentMode` is forced to `'individual'`
(`server.js`, ticket normalization). One Ticket, one agent, **one Run**. No
planner, no allocation plan, no leaf binding. `ticketWorkspaceScope` resolves to
`'shared'`. `selectRunProviderPath` finds no `leafRunBinding`, so the Run takes
the **ungoverned** provider path.

This is the strongest existing simpler path that can execute the same declared
work: it carries the same completion authority (Tranche 3 captures
`completionAuthoritySnapshot` on every Run) and the same postcondition evaluator.

### Arm A2 — LEGACY v1 GROUP OWNERSHIP (reported, not invented)

**Phase 2 requires reporting another legitimate existing baseline before adding
an arm. There is one, and it matters.**

`assignmentTargetType: 'group'` with mode `allocated` or `dynamic` and **no
`declaredWork`** does *not* reach the Tranche 1–5 machinery. It goes to
`buildAllocatedOwnershipPlan`: one plan item per group agent, owned paths
supplied by the operator (`allocated`) or derived by `deriveDynamicOwnedPaths`
(`dynamic`), and a **generic subtask string** — `"Produce your allocated output
for ticket N inside your owned path only."` There is **no planner model call**,
no declared-work contract, and no governed economics.

This arm isolates the two things Tranche 6 must not conflate:

* *multi-agent parallel ownership* (present in A2 and in B/C), from
* *planner + declared work + governed execution* (present only in B/C).

Without A2, any advantage of B/C over A could be attributed to parallelism alone
and the complexity question would go unanswered. **A2 is therefore required, not
optional.**

### Arm B — STRUCTURED ALLOCATION, ALLOCATED MODE

`assignmentTargetType: 'group'`, `assignmentMode: 'allocated'`, **`declaredWork`
supplied at creation**, group has a `plannerAgentId`. This builds
`structuredAllocationAuthorityDraft`; `hasStructuredPlanningAuthority` then routes
the ticket to `runStructuredAllocationPlanning` → planner request → plan
admission → `admitStructuredAllocationLeafRuns` → governed leaf Runs with
economic authority and verified-progress control. Owned paths are
operator-supplied.

### Arm C — STRUCTURED ALLOCATION, DYNAMIC MODE

Identical to B except `assignmentMode: 'dynamic'`, so `ownedOutputPaths` are
derived by `deriveDynamicOwnedPaths(agents)` at creation and carried into the
authority draft.

### What the arms mean for the decision

```
PRIMARY   A (direct)            vs   B/C (structured allocation)
ISOLATOR  A2 (v1 ownership)     vs   B/C (planner + declared work + governance)
SECONDARY B (allocated)         vs   C (dynamic)
```

Allocated-vs-dynamic is a **secondary** comparison inside the structured system,
exactly as the tranche brief requires. In the v1 path it is only "who supplies
the paths"; in the v2 path it additionally changes what the planner is given.

---

## 3. Controlled variables

Held constant across arms wherever the architecture permits:

| Factor | How it is held |
|---|---|
| Ticket objective | identical string; the objective compiler is deterministic |
| Declared work | identical `declaredWork` document for A2/B/C; A carries the same objective |
| Postconditions | identical typed criteria; `criterionHash` is the identity |
| Provider and model | one configured agent model (exact dated snapshot, no mutable alias) |
| Execution role | `agent` executionMode throughout; no workflow arm |
| Output/context limits | same `maxOutputTokensPerRequest`, same prompt construction |
| Runtime budgets | identical `runtimeLimitsSnapshot` (steps, model requests, operations, duration, attempts) |
| Economic ceilings | identical economic policy and pricing catalog where the arm has one |
| Workspace initial state | same fixture workspace, reset per repetition |
| Available tools | same operation catalog |
| Retry policy | `autoRetry` off, `maxAttempts` equal |
| Concurrency | `allowParallelRuns` set identically |
| Model determinism | hermetic staged transport (see §8) or fixed seed corpus |
| Verification authority | unchanged — one completion decision contract for all arms |

### Factors that CANNOT be held constant (recorded, not hidden)

These are architectural consequences of the arms themselves. Differences
attributable to them must not be reported as allocation-architecture effects.

1. **Workspace scope.** A is `shared`; A2/B/C are `owned_paths`. Different write
   authority is intrinsic to ownership allocation.
2. **Run cardinality.** A produces 1 Run; A2/B/C produce N leaf Runs (+ a planner
   attempt in B/C). **All metrics must therefore be Ticket-scoped, never
   Run-scoped.**
3. **Governed vs ungoverned execution.** Only B/C take the governed provider path.
   Economic reservations, settlements, progress blocks and required-persistence
   guarantees exist *only* on B/C. A and A2 have no `economic_request_reservations`
   rows at all.
4. **Planner request.** Only B/C spend a planner model request. That spend is a
   real cost of the structured path and is counted, not excluded.
5. **Agent count.** A is single-agent by construction. A2/B/C scale with group
   membership; group size must be fixed per scenario and reported.
6. **Churn control.** Verified-progress withholding exists only on B/C. A and A2
   cannot be "blocked" for churn, so churn is measured on B/C and reported as
   *not applicable* for A/A2 rather than as zero.

---

## 4. Scenario families

Bounded set, using existing repository capabilities only. No recursive
delegation, no new workflow language, no new product features.

| # | Family | Why it discriminates |
|---|---|---|
| 1 | Small indivisible work (one artifact) | allocation overhead should dominate; tests the "complexity not justified" hypothesis |
| 2 | Cleanly separable multi-part work (N disjoint outputs) | the structured path's best case |
| 3 | Legitimate sibling dependency (one part reads another's output) | exercises `undeclared_sibling_dependency` block authority |
| 4 | Apparently separable, actually coupled | tests whether the planner fragments work that should not be split |
| 5 | Ownership known precisely in advance | should favour B (allocated) over C (dynamic) |
| 6 | Ownership genuinely unknown in advance | should favour C (dynamic) over B |
| 7 | No-progress / churn case | honest work that advances no declared fact; only B/C can withhold |
| 8 | Partial failure and recovery | mid-run interruption; measures recovery latency and truthfulness |
| 9 | Completion-evidence ambiguity | model claims completion without supporting evidence |
| 10 | Cost-sensitive small work | planner overhead as a fraction of total spend |

Each family runs on all applicable arms. Family 7 reports churn only for B/C.

---

## 5. Metric definitions and their durable authority

Every metric is derived from durable repository authority. No metric is computed
from model prose.

### 5.1 Allocation quality — B/C only (A has no plan; A2 has a degenerate one)

| Component | Authority |
|---|---|
| Admitted items with valid declared work | `allocation_plans` / plan items; `itemDeclaredWorkHash` |
| Ownership correctness | `ownedOutputPaths` vs the paths actually written, from `operation_receipts.workspace_path` |
| Overlap or conflict | `assertNoOverlappingOwnedPaths` refusals; `WORKSPACE_WRITE_CONFLICT` receipts |
| Unnecessary fragmentation | item count vs the scenario's declared minimum separable parts |
| Undeclared sibling dependencies | persisted blocks with reason `undeclared_sibling_dependency` |
| Aggregate completion success | `transitionTicketAfterRun` result and the aggregate plan decision |
| Planner refusal / correction rate | planning-attempt states and `STRUCTURED_PLANNING_EVENT_TYPES` |

**Explicitly not scored:** producing more items. Fragmentation is a cost, not an
achievement.

### 5.2 Completion truthfulness — all arms

Authority: `run_consequences.completionDecision` (normalized), the
`run.completion_decided` event, and `deriveLeafItemDisposition` reasons.

| Outcome | Determination |
|---|---|
| True positive completion | decision `completion_verified` AND the scenario's independent postcondition check passes |
| **False positive completion** | decision claims success AND the independent check fails |
| False negative / blocked | independent check passes but the Run/Ticket did not complete |
| Missing / stale / conflicting authority | `completion_decision_missing`, `completion_decision_stale`, `completion_authority_mismatch`, `completion_decision_conflicts_run` |
| Unsupported model claim | model `complete:true` with no supporting evidence |
| Integrity refusal | `POSTGRES_REPLAY_INTEGRITY_FAILURE` |
| Cross-projection agreement | Run, allocation item and Ticket projections must agree |

**Weighting: a false positive completion counts 10× an ordinary incompletion**,
and is additionally a hard disqualifier (§6). Erring toward incompletion is
recoverable; asserting false success is not.

### 5.3 Latency — all arms, Ticket-scoped

| Sub-metric | Authority |
|---|---|
| Planning latency | planning-attempt start → plan admission (B/C only; 0 for A/A2) |
| Time to first useful execution | ticket creation → first `operation_receipt` for the Ticket |
| End-to-end completion latency | ticket creation → terminal Ticket transition |
| Recovery latency | interruption → next committed receipt after restart |
| Time lost to coordination/withholding | interval between a persisted block and the next authorized request |

All instants come from database timestamps (`events.ts`,
`operation_receipts.recorded_at`), never a process clock.

### 5.4 Cost

| Sub-metric | Authority | Arms |
|---|---|---|
| Planner requests and cost | `economic_request_reservations` role `structured_planner` | B/C |
| Leaf requests and cost | `economic_request_reservations` role `structured_leaf_executor` | B/C |
| Retries | attempt counts | all |
| Unused reservations | reservations in state `released` | B/C |
| Settled spend (micro-USD) | `economic_request_reservations.settled_micro_usd` | **B/C only** |
| Model request counts | `run_budget_charges` dimension `model_request`, state `committed` | **all** |
| Provider token usage | `usage` on `model:response` run-log evidence | all |

**Total cost per truthfully completed objective** = total settled spend ÷ count of
true-positive completions. See §8 for the arm-A/A2 pricing gap.

### 5.5 Churn — B/C only

Counted **only on canonical evaluated windows**, using the Tranche 5 definitions:

| Sub-metric | Authority |
|---|---|
| No-progress windows | `consecutiveNoProgressWindows` from `evaluateGovernedRunProgress` |
| Withheld requests | gate refusals with `GOVERNED_RUN_PROGRESS_BLOCKED` |
| Persisted progress blocks | `governedProgressBlock`, reason `verified_progress_exhausted` |
| Sibling-dependency blocks | reason `undeclared_sibling_dependency` |
| Wasted operations | committed receipts in windows crediting no fact |
| Responses not converted to progress | delivered answers with zero newly satisfied facts |

**Excluded by construction, per the Tranche 5 contract:**

* a request with no durable response is not a churn window;
* a durable response never **delivered to execution** is not a churn window
  (`isChurnEligibleWindow` requires the committed `model_request` charge);
* incomplete evidence refuses (`fact_evidence_incomplete`) and is not counted as
  zero progress.

Persistence interruptions and unanswered requests are therefore **never** counted
as model churn.

---

## 6. Decision thresholds — fixed before any comparison is run

These are committed **now**, before results exist.

### Hard disqualifiers → STOP (any one is sufficient)

1. Structured arms show a **higher false-positive completion rate** than arm A on
   any scenario family.
2. Any **authority violation**: block or completion authority fabricated, a Run
   projected completed without its canonical decision, or cross-projection
   disagreement.
3. **Uncontrolled cost**: settled spend exceeding the captured economic ceiling,
   or unbounded growth across repetitions.
4. **Non-deterministic recovery**: identical durable state producing different
   terminal dispositions across repetitions.
5. **Systematic churn misclassification**: a persistence or recovery interruption
   attributed to model churn.

### RETAIN

All of:

* zero hard disqualifiers;
* false-positive completion rate **≤ arm A** on every family;
* true-positive completion rate **≥ arm A + 10 percentage points** on families
  2, 3, 5 and 6 (the separable/coordinated cases), and **≥ A2 + 5 points** on the
  same families — the A2 comparison is what shows the planner earns its cost
  beyond bare parallelism;
* end-to-end latency **≤ 1.5×** arm A on families 2/3/5/6;
* total cost per truthfully completed objective **≤ 1.5×** arm A on those
  families;
* no family where structured is worse on truthfulness.

### REVISE

Zero hard disqualifiers, and structured wins materially on **some** families
while losing on others — for example winning families 2/3/6 but losing families
1/10 on latency or cost. The output is then a conditional activation policy (§7),
not a global retain.

### STOP

Any hard disqualifier, **or** no family where structured improves truthful
completion by ≥ 5 points over both A and A2 while remaining within the latency
and cost bounds.

### Repetition requirements

* **5 repetitions per (scenario family × arm)** under hermetic staged responses,
  which must be **identical** across repetitions — any variation is a defect, not
  noise.
* **3 repetitions** for any live-provider confirmation run, reported separately
  and never pooled with hermetic results.
* A family is **inconclusive**, not favourable, when repetitions disagree on the
  completion verdict.
* No metric is reported as a single-run number.

---

## 7. Activation-policy question

The evaluation must be able to conclude a **conditional** policy rather than one
universal mode. Candidate policies, to be selected by evidence:

* always structured;
* manually selected;
* automatically selected only for qualifying work (e.g. ≥ N separable declared
  outputs);
* structured restricted to dynamic mode;
* structured restricted to operator-allocated mode;
* structured retained as an advanced path only;
* structured removed.

A plausible evidence-supported outcome, stated here only as an example of the
shape a REVISE answer may take: *direct execution for small indivisible work;
allocated structured execution when ownership is already known; dynamic
structured execution only for sufficiently separable multi-part objectives.*
Nothing in this document presumes that result.

---

## 8. Instrumentation audit

### Already durable and sufficient

Allocation plans and items; Runs and leaf bindings; completion decisions and
their events; block authorities (progress and sibling); governed postcondition
evidence and fact transitions; operation receipts; economic reservations and
settlements; replay and recovery evidence; database timestamps on every event;
terminal Run/item/Ticket outcomes.

### Phase 8 verdict

**MINIMAL EVALUATION INSTRUMENTATION REQUIRED** — two observational gaps, both
read-only.

**Gap 1 — priced cost is not comparable across arms.** `settled_micro_usd` exists
only for governed runs, so arms A and A2 have **no durable money figure at all**.
Token usage for A/A2 is available from `usage` on `model:response` run-log
evidence, but it is not priced.

*Smallest addition:* a read-only evaluation reader that prices A/A2 token usage
using the **same** `runtime/model-pricing-catalog.js` entry the governed arms
captured, and reports it as *derived*, clearly distinguished from settled
authority. No execution semantics change; no new column; no write.

**Gap 2 — no Ticket-scoped comparison reader exists.** Every metric above is
individually durable, but nothing assembles them per Ticket across arms.

*Smallest addition:* a read-only aggregation script producing one row per
(scenario, arm, repetition). Reads only; writes nothing.

**Explicitly rejected:** changing execution semantics, adding fields to
production records, or emitting new events to make measurement easier. Anything
that alters what is executed invalidates the comparison it is meant to measure.

---

## 9. Confounders

1. **Governed vs ungoverned execution** is entangled with structured vs direct.
   The structured arms benefit from Tranche 4/5 economic and progress controls
   that arm A does not have. A gain in truthfulness may come from *governance*
   rather than from *allocation*. Arm A2 partially isolates this (it is
   multi-agent but ungoverned); a complete isolation would require a governed
   single-Run arm, which **does not exist today** — recorded as a prerequisite,
   not silently ignored.
2. **Planner model quality** is a property of the planner agent, not of the
   architecture. Fix the planner model across all repetitions and report it.
3. **Group size** changes parallelism independently of allocation strategy.
4. **Objective recognizability.** The deterministic objective compiler recognizes
   only some objectives; an unrecognized objective yields
   `explicit_evidence_required` and changes completion behaviour on every arm.
   Scenarios must state which compile and which do not.
5. **Fixture workspace realism.** Results are bounded by the fixture catalog and
   do not generalize to customer targets.
6. **Hermetic staging removes model variance by design**, which makes truthfulness
   and cost comparable but makes *allocation quality under real model variance*
   unmeasurable. Live confirmation runs are reported separately for this reason.

---

## 10. Execution order

1. Build the two read-only readers from §8. No production change.
2. Register them under `scripts/test-manifest.js` with a truthful classification.
3. Encode scenario families 1–10 as hermetic fixtures.
4. Dry-run one family across all four arms to validate the harness, discarding
   the results.
5. Run 5 hermetic repetitions per (family × arm).
6. Aggregate; apply §6 thresholds **as written**.
7. Optional live confirmation, reported separately.
8. Record the verdict in the decision format below.

---

## 11. Decision format

```text
STRUCTURED ALLOCATION CONTROLLED EVALUATION — VERDICT

Decision:            RETAIN | REVISE | STOP
Arms compared:       A, A2, B, C
Families run:        <list>       Repetitions: <n> per (family × arm)
Hard disqualifiers:  <none | list>

Per family:  allocation quality | truthfulness | latency | cost | churn
Activation policy recommended: <policy>
Evidence gaps / inconclusive families: <list>
```

---

## 12. Unresolved prerequisites

The evaluation **must not run** until each is closed.

| # | Prerequisite | Why it blocks |
|---|---|---|
| 1 | Priced-cost reader for arms A/A2 (§8 gap 1) | cost comparison is otherwise impossible, not merely imprecise |
| 2 | Ticket-scoped aggregation reader (§8 gap 2) | no per-arm comparison exists today |
| 3 | Hermetic fixtures for families 1–10 | families 3, 4, 7, 8 and 9 have no existing fixture |
| 4 | Fixed planner agent + dated model snapshot | otherwise planner quality confounds every result |
| 5 | Independent postcondition oracle | truthfulness needs a check *independent* of the completion decision under test; using that decision to score itself is circular |
| 6 | Decision on the governed-single-Run arm | recorded in §9(1). Either accept governance as part of "the structured path" and say so, or build the arm. **Not to be resolved by silence.** |

Prerequisite 5 is the most important and the least obvious: scoring completion
truthfulness with the same authority being evaluated would guarantee agreement
and prove nothing.

---

## 13. Status

**Tranche 6: IN PROGRESS — protocol design.** Not complete. No comparison has
been run and no verdict exists. No production behaviour changed in this session.

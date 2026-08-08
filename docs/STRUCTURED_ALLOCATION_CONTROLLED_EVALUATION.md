# Structured Allocation — Controlled Evaluation Protocol

Tranche 6. **Protocol design, then prerequisite resolution and the read-only
evaluation harness.** No production behaviour changed in either session. The
scored evaluation has NOT been run and no RETAIN / REVISE / STOP verdict exists.

Harness modules, all read-only:

| Module | Role |
|---|---|
| `scripts/fixtures/evaluation-oracle.js` | independent postcondition oracle |
| `scripts/fixtures/evaluation-arms.js` | the five configurations and their path proofs |
| `scripts/fixtures/evaluation-normalized-cost.js` | one cost method for every arm |
| `scripts/fixtures/evaluation-trial-record.js` | comparison envelope and Ticket-scoped record |
| `scripts/structured-allocation-evaluation-report.js` | SELECT-only durable collection |
| `scripts/structured-allocation-evaluation-test.js` | 72 deterministic proofs |
| `config/structured-allocation-evaluation-v1.json` | frozen experiment configuration |

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

## 12. Prerequisite resolutions (session 2)

Each of the six recorded blockers, with its verdict. A prerequisite is CLOSED
only when something in the repository proves it, not when it is argued.

### 1. Priced-cost reader for arms A/A2 — **CLOSED**

*Why it blocked:* `settled_micro_usd` exists only on governed runs, so the
direct and legacy arms had no monetary figure at all and cost could not be
compared.

*Seam:* `runtime/model-pricing-catalog.js` (`computeActualCost`),
`run_budget_charges` (dimension `model_request`, state `committed`) — the one
request-count authority present on **every** arm, governed or not.

*Kind:* read-only instrumentation.

*Resolution:* `scripts/fixtures/evaluation-normalized-cost.js` prices every arm
with **one** method — see §5a. Nothing re-implements pricing arithmetic.

*Proof:* `structured-allocation-evaluation-test`, section 4; mutations E7, E8,
E10.

### 2. Ticket-scoped aggregation reader — **CLOSED**

*Why it blocked:* every metric was individually durable but nothing assembled
them per Ticket across arms, and per-Run averaging would divide the structured
arms by their own parallelism.

*Seam:* `scripts/structured-allocation-evaluation-report.js` (SELECT-only) and
`scripts/fixtures/evaluation-trial-record.js`.

*Kind:* read-only instrumentation.

*Resolution:* a reader that issues only SELECT statements, plus a Ticket-scoped
record whose aggregation names its denominator `trials`.

*Proof:* sections 6 and 7 of the suite; mutations E9, E13.

### 3. Hermetic fixtures for families 1–10 — **PARTIALLY CLOSED — EVALUATION MAY NOT RUN**

*Why it blocks:* families 3, 4, 7, 8 and 9 could not be executed.

*Kind:* deterministic fixture support.

*Closed in session 3:*

* the **hermetic provider fixture** (`scripts/fixtures/evaluation-fixture-provider.js`)
  — no network or API key, one response table keyed by protocol / scenario /
  logical task / seed / role / ordinal and **never by the arm**, stable response
  identities, deterministic token usage, planner and worker roles, the three
  controlled failure boundaries, a per-trial namespace that refuses reuse, a
  transcript and an external access log exposed as plain files outside product
  authority, and **refusal — never generic success — for an unexpected request**;
* **family 4's missing observation** (`scripts/fixtures/evaluation-coupling-oracle.js`)
  — see §4a. Family 4 is no longer observation-blocked;
* the **quiescence contract** and the **immutable trial artifact**
  (`scripts/fixtures/evaluation-quiescence.js`).

*Still open:* the five scenario fixture definitions for families 3, 7, 8 and 9
are not authored as data, and **the trial runner and its five arm adapters are
not built**. No smoke run was performed.

*This remains the reason the evaluation may not run.*

### 4. Fixed planner agent + dated model snapshot — **CLOSED**

*Why it blocked:* planner quality would otherwise confound every structured
result.

*Kind:* frozen configuration.

*Resolution:* `config/structured-allocation-evaluation-v1.json` → `fixedModel`
pins provider, exact dated model snapshot and adapter, used for the planner and
every worker so the model identity cannot differ between arms. `model` is a
controlled envelope field, so a mismatch refuses the comparison.

*Proof:* suite section 5; mutation E15.

### 5. Independent postcondition oracle — **CLOSED**

*Why it blocked:* scoring truthfulness with the completion authority under
evaluation is circular and would guarantee agreement.

*Seam:* `scripts/fixtures/evaluation-oracle.js`.

*Kind:* read-only instrumentation.

*Resolution:* an oracle that reads **raw filesystem state only**. It imports
nothing from `runtime/`, accepts no store, repository, Run or Ticket, and has no
arm parameter — so it cannot consult product authority and cannot behave
differently per arm. Refusal is a first-class verdict.

*Proof:* suite sections 1 and 2 assert the structural independence at source
level and demonstrate all five required detections — false positive, false
negative, agreed success, agreed failure, and refusal on unobservable state.
Mutations E4, E5, E6.

### 6. Decision on the governed-single-Run arm — **CLOSED as a product decision**

*Why it blocked:* governed execution is entangled with the structured path, so
a difference might come from governance rather than allocation.

*Kind:* product decision, explicitly not resolved by silence.

*Resolution — the primary unit is the shipped bundle.* Governance, verified
progress, bounded economics, structured completion and coordination are part of
the structured product path as it actually ships. The evaluation therefore
compares the direct and legacy alternatives against the **complete** structured
path, and **no governed single-Run arm is built for the evaluation.** No
equivalent existing production path was found, and inventing one would evaluate
a product that does not exist.

*The causal limitation, stated plainly:* the primary evaluation can determine
whether the integrated structured path earns its total complexity, but **cannot
attribute every observed difference to planning alone.** Arms A2a and A2b
control for much of the multi-agent and ownership benefit, which is what makes
the remaining ambiguity narrow rather than fatal.

*A later ablation is proposed only if* the main result is RETAIN or REVISE **and**
identifying which structured component carries the value would change the
product decision.

---

## 4a. Family 4 — genuine coupling versus lucky final state (CLOSED)

Raw final state alone cannot decide family 4: a consumer that never read the
producer's artifact can still leave files that look exactly like a correct run.
Scoring that as success would manufacture the very false positive the evaluation
exists to detect.

Three independent raw facts resolve it, none of them product authority:

1. the producer artifact is **derived from the trial seed**, so its content is
   unpredictable before the trial and cannot be hard-coded into a staged
   response;
2. the **fixture-owned access log** — written by the fixture, not the Ticket
   runtime — records that the consumer read that exact artifact **by hash**;
3. the consumer's final output **binds the producer artifact hash**, so it
   cannot be produced without having seen it.

| Situation | Verdict |
|---|---|
| correct dependency use | **PASS** |
| final files look correct, no consumer read | **FAIL** (diagnostic names the missing read) |
| consumer read a different version | **FAIL** |
| output does not bind the producer hash | **FAIL** |
| **self-consistent forgery** — hard-coded producer content, matching access-log hash, matching binding | **FAIL**, on the seed derivation alone |
| access log unavailable | **REFUSED** |

The forgery case is load-bearing: without it, a mutation removing the
seed-derivation check survived, because every other case was caught by a later
check instead.

The coupling oracle imports nothing from `runtime/`, takes no store, and has no
arm parameter, exactly like the base oracle.

---

## 7a. Quiescence

Nine named conditions, each reported individually so a non-quiescent Ticket says
*which* fact is outstanding: pending or running Runs, active leases, in-flight
governed requests, unresolved delivery uncertainty, unsettled reconstructible
reservations, recoverable terminalization, scheduler-visible retries, pending
aggregate reconciliation, and active fixture requests.

**Quiescence is not "all Runs are terminal."** A Ticket can have every Run
terminal while a lease is still held, a governed request is started with no
durable response, or a terminalization the startup repair would still finish is
outstanding. Sampling the oracle then measures a half-finished system.

The reader **observes** quiescence and never creates it: SELECT-only, and proved
at source level to call no transition, claim, settlement or repair.

---

## 8a. Trial artifact

Write-once JSON per trial carrying schema and protocol versions, the exact
repository commit, scenario / arm / repetition / seed, mode, envelope hash, path
proof, the Ticket-scoped report, oracle and coupling results, normalized cost,
durable governed cost where it exists, latency, churn, quiescence, fixture
transcript hash, external state hash, exclusions, warnings and a final artifact
hash. Every artifact carries the label **UNSCORED HARNESS SMOKE — NOT PRODUCT
EVIDENCE**.

Overwriting an existing artifact is refused — a result that can be rewritten is
not evidence. Fixture and live results are separated **twice over**: distinct
directory namespaces *and* a mandatory validated `mode` field, so neither
containment can be defeated alone, and an artifact that does not state its mode
is refused rather than defaulted.

---

## 3a. Phase 1 verdict — the real-server harness (session 4)

**EXISTING HARNESS REQUIRES A TEST-ONLY ADAPTER.**

`scripts/postgres-test-harness.js` supplies everything structural the runner
needs: `withHarness` gives a real store, schema, workspace root and
`startServer({ env, serverOptions })`, which spawns the actual server with a
preload via `NODE_OPTIONS`. Ticket creation goes through the real form POST to
`/tickets` carrying `objective`, `assignmentTargetType`, `assignmentTargetId`,
`assignmentMode`, `declaredWork` and `ownedOutputPaths` — the single seam that
reaches all five paths without bypassing a branch condition.

**What was missing is the hermetic provider boundary for the ungoverned arms,
and finding it exposed a safety gap in the existing preload.**

The two provider paths use different transports:

| Path | Arms | Transport |
|---|---|---|
| governed | B, C | `https.request` via `createOpenAiGovernedTransport`, which has a documented `httpsRequest` injection seam |
| ungoverned | A, A2a, A2b | **`global.fetch`** — `server.js` `callOpenAI` issues `fetch('https://api.openai.com/v1/responses', …)` |

`hermetic-governed-transport-preload.js` documented a second guarantee: a KILL
SWITCH making "Node's real `https.request` and `http.request` throw for any
non-localhost host". **That guarantee did not cover `fetch`.** `fetch` is
undici, which has its own HTTP stack and never calls `https.request`. Verified
directly: with both `http.request` and `https.request` replaced by throwing
stubs, `fetch('https://api.openai.com/v1/responses')` **completed and neither
stub was called**.

So a real-server suite exercising an *ungoverned* Run was protected from the
network only if it happened to stub `global.fetch` itself. Several do, and they
are unaffected — their own override is installed after the preload and still
wins. But the stated guarantee was narrower than its comment claimed, and the
Tranche 6 arms A/A2a/A2b would have run straight through it.

The preload now guards `globalThis.fetch` on the same non-localhost rule, so the
guarantee holds for every transport this runtime can actually use. All twelve
suites that load the preload pass unchanged.

This is a **test-infrastructure correction, not a production change** —
production is supposed to call the provider. It is recorded here because it
determines the runner's design: one fixture provider can serve all five arms
only once the ungoverned transport is interceptable at the same boundary.

---

## 3b. The executable runner (session 5)

`scripts/structured-allocation-evaluation-runner.js`, driven by
`scripts/structured-allocation-evaluation-runner-postgres-test.js` (registered
required).

```
node scripts/structured-allocation-evaluation-runner.js \
  --mode fixture --scenario family-1-simple --arm <A|A2a|A2b|B|C> \
  --repetition <n> --seed <value> --output <path>
```

The runner executes inside the canonical PostgreSQL real-server harness, which
supplies the store, workspace and server lifecycle. It uses the real
`POST /tickets` form, the existing scheduler and workers, and the existing
terminalization and reconciliation. It inserts no plan, planning attempt, Run,
leaf binding, receipt, evidence, block, consequence, completion decision or
terminal status.

**Live mode is refused outright**, so a typo cannot make a live call.

### Family-1 five-arm milestone — EXECUTED

All five arms ran through their real production paths and resolved to exactly
**three distinct paths**. 85 smoke assertions.

| Arm | Observed path | Plan admitted | Oracle | Quiescent | Zero drift |
|---|---|---|---|---|---|
| A | `direct` | n/a | pass | yes | yes |
| A2a | `legacy_v1` | yes | pass | yes | yes |
| A2b | `legacy_v1` | yes | pass | yes | yes |
| B | `structured_v2` | no — planning blocked | pass | yes | yes |
| C | `structured_v2` | no — planning blocked | pass | yes | yes |

**This is not a comparison.** No arm is ranked, no threshold is computed, and
the table is a routing and harness-integrity record.

**B and C reached structured planning and were blocked before admitting a
plan** (two planning attempts each, `ticket.structured_planning_failed`). That
is a truthful product result and valid trial data, not a harness failure — but
it means the structured arms have not yet been observed executing leaf Runs, and
the planning-refusal cause is the first thing the next session must resolve.

### What the path proof rests on

Durable state only: `runs.body` leaf bindings and governed envelopes,
`allocation_plans`, `ticket.structured_planning*` events and
`structured_planner` reservations. The arm label is never evidence. A trial
whose durable facts belong to another path is refused as **invalid**, not
relabelled.

A structured planning attempt is itself proof the structured path ran — a
blocked trial admits no plan and creates no Run, and counting only plans and
Runs would have reported it as `direct`.

### Scenario preconditions discovered by execution

Family 1 now starts with **three** top-level folders and pre-created owned
paths, because production refuses an allocated ticket whose owned paths are
absent and refuses dynamic allocation with fewer usable top-level directories
than the group has agents. The initial state is identical for every arm, so it
remains a controlled variable.

### Isolation and zero drift

Each trial resets the workspace to the scenario's declared initial state, takes
a fresh fixture namespace that refuses reuse, and creates a fresh group, agents
and Ticket. After quiescence the read-only report is invoked **twice** and the
durable fingerprint — runs, run revisions, events, receipts, reservations,
consequences and diagnostic logs — is captured before, between and after. Any
difference fails the trial. All five arms showed zero drift.

Artifacts:
`/tmp/ticket-system-structured-evaluation-smoke/<commit>/fixture/family1-<arm>.json`,
each labelled `UNSCORED HARNESS SMOKE — NOT PRODUCT EVIDENCE`, write-once, and
asserted to contain no rank, winner, score or aggregate.

---

## 3c. B and C now admit Allocation Plan v2 (session 6)

The previous result was `structured planning attempted, no plan admitted,
ticket.structured_planning_failed`. Four distinct causes were found, each from
durable authority rather than inference, and each corrected at the harness — no
production file changed.

| # | Durable evidence | Cause | Correction |
|---|---|---|---|
| 1 | `failureStage: invocation_readiness`, `failureReason: planner_route_unavailable`, `requestHash: null` | No active model routing policy carried `governedExecution`, so `loadGovernedPlannerPolicyContainer` refused. Production was correctly declining to spend without captured routing and pricing authority. | The runner seeds one governed routing policy with role routes and economic policy for the planner and leaf executor. |
| 2 | `failureDetail: economicPolicy is missing field(s): capturedAt` | The seeded economic policy omitted `capturedAt`. | Added — a policy that cannot say when it was captured cannot bind a request. |
| 3 | `failureStage: proposal_validation`, `plannerProposal is missing field(s): version, sharedConstraints, items` | The staged planner body was not a v2 proposal. | The proposal is now materialized per trial from the real contract: `version`, `sharedConstraints`, and items carrying exactly `assignedAgentId`, `objective`, `expectedOutputs`, `successCriteria` and an EMPTY `evidenceRequirements`. Owned paths are absent because production assigns them — which is why one proposal serves both the allocated and dynamic arms. |
| 4 | `failureStage: lowering`, `proposal_candidate_mismatch: plannerProposal omitted captured candidate 3` | The planner agent is a group member and therefore a captured candidate, and lowering refuses a proposal that omits one. | One proposal item per captured candidate. |

A fifth defect was in the harness itself: seeding a routing policy per trial made
the **second** structured trial fail, because `loadGovernedPlannerPolicyContainer`
refuses when two active governed policies exist. The runner now reuses an
existing one. C admitted a plan in isolation before this fix, which is what
identified it as cross-trial interference rather than an arm difference.

`planVersion` was also being derived from leaf Runs, which reported a genuinely
admitted v2 plan as v1 whenever leaf admission had not yet run. It is now derived
from how the plan was **admitted**.

### The four path facts are now separate

`planningAttempted`, `planAdmitted`, `leafRunsAdmitted` and
`governedLeafExecutionObserved` are reported individually, so a planning attempt
can never stand in for executed governed work. `assertObservedPathMatches` takes
an explicit `expectLeafExecution` flag rather than inferring the requirement.

### Current five-arm matrix — 91 assertions

| Arm | Path | Planning attempted | Plan admitted | Leaf Runs admitted |
|---|---|---|---|---|
| A | `direct` | n/a | n/a | n/a |
| A2a | `legacy_v1` (operator ownership) | no | yes (v1) | n/a |
| A2b | `legacy_v1` (system-derived ownership) | no | yes (v1) | n/a |
| B | `structured_v2` (allocated) | **yes** | **yes, v2** | **not yet** |
| C | `structured_v2` (dynamic) | **yes** | **yes, v2** | **not yet** |

**The session goal is not fully met.** B and C admit v2 plans but structured
leaf-Run admission has not been observed, so governed execution, governed
economics, verified-progress controls and aggregate structured completion remain
unexercised. That is recorded as the remaining gap rather than implied to have
happened.

Artifacts:
`/tmp/ticket-system-structured-evaluation-smoke/<commit>/fixture/family1-<arm>.json`,
each labelled `UNSCORED HARNESS SMOKE — NOT PRODUCT EVIDENCE`.

---

## 3d. Plan-to-leaf lifecycle: the zero-leaf cause (session 7)

### Phase 1 verdict: LEAF MATERIALIZATION ATTEMPT REFUSED

Not "no attempt", not "rolled back", and not a reader misclassification. The
durable evidence for both B and C:

```
plan:      version 2, status pending, 3 allocation items
items:     agent 1 -> reports/alpha/ · agent 2 -> reports-b/beta/ · agent 3 -> reports/agent-2/
events:    … ticket.structured_planning_validated
           ticket.allocation_plan_admitted
           ticket.blocked
block:     reasonCode  leaf_admission_conflict
           stage       leaf_admission
           reason      "Leaf-run admission lost a concurrent race for this allocation plan"
           workerRunsCreated 0
log:       "admitted Allocation Plan v2 #1 (pending; zero worker runs; leaf admission runs next)"
```

So leaf admission **is** reached synchronously after plan admission, is
attempted, and refuses. The admitted plan and its three items are well formed:
distinct agents, distinct non-overlapping owned paths, version 2.

### The reported reason is almost certainly not the real one

`server.js:17078` is a **catch-all**:

```js
} catch (error) {
  if (error instanceof StructuredAllocationLeafRunError && error.reason) {
    return refuse(error.reason, error.message);
  }
  return refuse('leaf_admission_conflict', error.message);
}
```

Any exception that is not a `StructuredAllocationLeafRunError` is reported as
`leaf_admission_conflict` — a concurrency verdict — regardless of its actual
cause. And `refuse(reason, message)` renders the vocabulary message rather than
`error.message`, so the underlying error text reaches neither the block payload,
nor the diagnostic log, nor the server's stdout.

Two facts argue the label is wrong here:

* raising `RUNTIME_SCHEDULER_INTERVAL_MS` from 200 ms to 2000 ms changed
  nothing, so a scheduler continuation racing the synchronous admission is not
  the cause;
* a genuine race would require a competing admitter, and the winner would have
  created leaf Runs. Zero Runs exist.

**This is a diagnosability finding worth recording on its own:** a leaf-admission
failure of any kind is currently indistinguishable from a concurrency conflict,
and its cause is unrecoverable from durable state. Establishing the real error
is the first task of the next session, and it needs either a bounded production
diagnostics change (surfacing `error.message`/`error.code` on the refusal) or an
in-process reproduction of `admitStructuredAllocationLeafRuns` against the
admitted plan.

**No production file was changed in this session**, so the catch-all is left as
found rather than altered inside the evaluation branch.

### Quiescence audit

The current contract treats plan-admitted / leaf-unmaterialized as quiescent,
which is wrong for a plan whose leaf admission may still continue. The
correction is **not made yet**, because the distinction it must draw depends on
the answer above: a terminally refused admission may legitimately be quiescent,
while a recoverable one may not, and the present block is of unknown kind.

### Unchanged five-arm matrix

A `direct` · A2a `legacy_v1` allocated · A2b `legacy_v1` dynamic · B and C
`structured_v2` with an admitted v2 plan and **no leaf Runs**. The four path
facts remain reported separately, so nothing here reads as executed governed
work.

---

## 5a. The normalized cost method

One method, every arm:

```
canonical committed model-request charges
  x one frozen pricing snapshot
  -> normalized derived cost
```

* the same `computeActualCost` from the production pricing catalog — no second
  pricing authority;
* the same model identity, token accounting and rounding;
* unmetered requests fall back to `authorized_maximum_assumed` **using the same
  function**, never to zero, identically on every arm;
* planner requests are counted, never excluded;
* cost per truthful completion is `null` — not zero, not infinity — when there
  were no truthful completions.

For B and C the **durable** governed settlement is reported *beside* the
normalized figure with their difference as an accounting-integrity cross-check.
It is never the cross-arm comparison value, and no settled monetary authority is
invented for A/A2a/A2b. Every normalized value is labelled `derived`.

---

## 6a. Ticket-scoped trial record

`scripts/fixtures/evaluation-trial-record.js` builds one record per Ticket per
trial carrying: trial/scenario/arm/repetition/seed identity, envelope hash and
initial-state hash, Ticket / plan / item / Run identities and **runCount**,
provider and model, observed production path, allocation topology and ownership,
planner and worker request counts, receipts, the independent oracle result
beside the product completion claim, the truthfulness class, latency components,
normalized cost, durable governed cost where it exists, canonical churn, retries
and recovery, terminal authority, inclusion and confounders. Every group states
its source: `durable`, `derived` or `independent`.

Churn is `null` — never `0` — for arms with no churn control, so "cannot be
blocked" is never read as "did not churn".

---

## 8a. Comparability enforcement

`buildComparisonEnvelope` requires all 17 controlled fields; an unstated control
is refused rather than defaulted. `assertComparable` refuses a comparison whose
envelopes differ and names the offending fields. `assertSingleExecutionMode`
refuses to pool deterministic-fixture and live-model records. Unavoidable
architectural differences are recorded on every envelope.

A failed product trial **stays in the data set**; only a predeclared
infrastructure failure may exclude a trial.

---

## 9a. Scenario readiness

| Family | Readiness |
|---|---|
| 1 small indivisible | READY |
| 2 cleanly separable | READY |
| 3 sibling dependency | READY WITH FIXTURE-ONLY ORACLE |
| 4 apparently separable, actually coupled | **READY** — observation closed, see §4a |
| 5 ownership known in advance | READY |
| 6 ownership unknown in advance | READY |
| 7 no-progress / churn | READY WITH FIXTURE-ONLY ORACLE |
| 8 partial failure and recovery | READY WITH FIXTURE-ONLY ORACLE |
| 9 completion-evidence ambiguity | READY |
| 10 cost-sensitive small work | READY |

Family 4 is blocked, not weakened: raw final state cannot distinguish *correct
handling of coupling* from *a lucky execution order that happened to work*. An
oracle that guessed would manufacture exactly the truthfulness error this
evaluation exists to measure.

Smoke subset, when fixtures exist: families 1 and 2 — the smallest pair covering
both the overhead case and the structured best case.

---

## 10a. Repetition and ordering

Pinned in `config/structured-allocation-evaluation-v1.json`: 5 deterministic
repetitions and 3 live repetitions per cell; a deterministic balanced Latin
square rotating arm order across repetitions with the permutation derived from
the scenario seed; a 900 s timeout recorded as a product failure unless the
harness itself crashed; four predeclared infrastructure exclusions; and
write-once trial records — a re-run produces a new `trialId` rather than
overwriting one.

---

## 3e. Governed leaf Runs now EXECUTE — B and C complete (session 9)

### What changed in production

Two corrections landed in session 8 (`f2741929`, `dca37af7`): the canonical
version-1 progress-control policy is now built and supplied as
`governedLeafCapture` during real leaf admission, and leaf-admission failures are
classified truthfully instead of every unexpected error being reported as a
concurrency race.

The second correction immediately exposed a third defect. With honest
classification, B and C stopped claiming a race and reported
`leaf_governed_authority_unavailable` — because **one governed policy container
could fund only one role**, and only one active container was permitted. Resolved
this session by `docs/GOVERNED_ROLE_ECONOMIC_POLICY_SET_DECISION.md`: the
container's economic authority became a closed, role-keyed set
(`economicPolicies`, version 2) so one immutable container funds both
`structured_planner` and `structured_leaf_executor`. No fourth subdocument, no
second container, no cross-role fallback, no migration.

### The fixture blind spot that hid both defects

`seedGovernedStructuredTicket` passed a worker-role policy source **straight to
the store**, bypassing `loadGovernedPlannerPolicyContainer` entirely. A fixture
that skips the production seam cannot fail when that seam is broken — which is
why both the missing-capture defect and the one-role defect survived a full
release checkpoint. The evaluation runner now seeds a real container and reads it
**through the production loader**; `scripts/fixtures/governed-role-policy-container.js`
builds only the RAW container body and deliberately cannot produce a normalized
source.

### Family-1 results — UNSCORED HARNESS SMOKE, NOT PRODUCT EVIDENCE

| Arm | Path stage reached | Runs | Governed leaf | Claimed | Planner req | Worker req |
|---|---|---|---|---|---|---|
| A | `direct_executed` | 1 | 0 | 0 | 0 | 0 |
| A2a | `legacy_v1_allocated_executed` | 2 | 0 | 0 | 0 | 0 |
| A2b | `legacy_v1_dynamic_executed` | 2 | 0 | 0 | 0 | 0 |
| B | `structured_v2_allocated_executed` | 3 | 3 | 3 | 1 | 3 |
| C | `structured_v2_dynamic_executed` | 3 | 3 | 3 | 1 | 3 |

Each structured arm reserved against **exactly two role accounts** — one
`structured_planner`, one `structured_leaf_executor` — with no reservation
crossing roles, and reconciled to a terminal aggregate.

**An observation recorded, not interpreted.** Every arm terminalized with ticket
status `failed` while the independent oracle — reading raw filesystem state
only — returned `pass`. That divergence is a real fact about the product and is
recorded here deliberately. It is **not** scored, ranked, compared or explained
in this session: doing so would be a product verdict, which is out of scope.
Nothing in this table is evidence for or against any arm.

### Path-stage classification

Runner and report now share ONE classifier (`classifyPathStage` in
`scripts/fixtures/evaluation-arms.js`). `structured_v2_*_executed` requires an
actually claimed, worker-role governed leaf Run — never a merely admitted one and
never a planning attempt. Five independently tracked facts: `planningAttempted`,
`planAdmitted`, `leafRunsAdmitted`, `governedLeafExecutionObserved`,
`aggregateReconciliationObserved`.

Quiescence gained a tenth condition: `admitted_plan_without_leaf_runs`. A
structured plan admitted with no governed leaf Run yet is **mid-flight, not
finished** — without it, a structured trial that never executed governed work
could be observed as quiescent and read as complete. It is scoped to the
structured path so legacy v1 plans, which never owe a leaf Run, are unaffected.

## 3f. Cross-role parent policy revision binding (session 10)

### The gap

B and C executed, and each role's authority was individually valid. But the
durable envelopes proved only *this exact worker policy funded this Run* — not
*the planner policy and the worker policy came from the same immutable revision*.
Replacing the active container mid-plan with one whose worker entry is
byte-identical and whose planner entry differs left every captured hash matching.

**Phase 1 audit verdict: PARENT POLICY REVISION IS NOT DURABLY BOUND.** Nothing —
planning attempts, planner reservations, admitted plans, leaf Run authority,
worker reservations, projections — carried the container row ID, its revision, a
container body hash, the economic set version or the set hash.

### The binding

Both governed authority envelopes now carry `parentPolicyReference`
(container row ID, revision, governed-content hash, economic set version and
hash), versioned in parallel at version 2 with version 1 kept readable under its
original rules. Leaf admission requires the worker's reference to equal the
planner's field for field, before any leaf Run commits.

### Artifact fields — authority validity, NOT a sixth metric

Each trial artifact now records `plannerParentPolicyReference`,
`workerParentPolicyReference`, `economicPolicySetVersion`,
`economicPolicySetHash`, `plannerEconomicPolicyHash`, `workerEconomicPolicyHash`
and `sameParentPolicyRevision`. These say whether a trial's governed authority is
coherent. They are never compared between arms and are not scored.

Read entirely from **captured** state — the durable planning attempt and the
durable Run envelopes. Deriving them from the currently active container would
prove nothing, because the question is what was true when they were captured.

B and C: `sameParentPolicyRevision = true`, with planner and worker economic
policy hashes distinct.

### Accepted over-strictness

The row revision increments on any edit, including legacy fields governed
execution ignores. A legacy edit between planning and leaf admission therefore
refuses leaf admission. Deliberate: the alternative is deciding which edits "do
not count". Recorded in the decision record rather than left as a surprise.

## 3g. Scenario families 3, 4, 7, 8 and 9 (session 11)

### What was built

- **Variant model.** Families 7 and 8 now declare executable variants (7A–7D,
  8A–8D) resolved into complete scenarios by `resolveScenarioVariant`. The
  runner takes `--variant`, and refuses an unknown variant, a variant belonging
  to another scenario, or an arm the variant does not allow.
- **Execution matrix** (`scripts/fixtures/evaluation-execution-matrix.js`) —
  twelve candidate cells with required arms, excluded arms and an exact reason
  for each exclusion. An **undeclared** exclusion refuses, so a failing cell
  cannot be retired as "infrastructure" after the fact.
- **Coupling oracle wired** into the runner for families 3 and 4, with a
  fixture-owned read observer.
- **Scenario PostgreSQL suite** executing every required cell through the real
  server.

### Three harness defects found and corrected

1. **Pre-created ownership made oracles trivially true.** Production requires
   every owned output path to exist before a Run starts, so the harness
   pre-creates `reports/alpha/`. Families 8 and 9 expected `folder_exists
   reports/alpha` — satisfied before any work happened, which would have
   reported a pre-transport failure as a success. Observations now target paths
   only the worker's own action creates.
2. **Static planner proposals could not name real agents.** Families 3, 4, 7, 8
   and 9 staged frozen proposals, and lowering refuses a proposal that omits any
   captured candidate — so every structured arm refused the plan before any leaf
   Run existed. All now use the agent-bound `plannerResponseTemplate`.
3. **Dynamic arms had too few workspace roots.** Dynamic allocation derives one
   owned root per agent and refuses when there are fewer directories than
   agents, so a single `reports` folder made every dynamic arm fail at ticket
   creation. All scenarios now provide three roots, matching family 1.

### The blocking finding: families 3, 4, 7 and 8 are OBSERVATION-BLOCKED

Those four families depend on **fixture-owned external observation** — the
consumer access log for the coupling families, the served-call transcript for
the churn and recovery families. **That channel does not reach a spawned
server.** The governed path is served by `hermetic-governed-transport-preload`,
which has its own staged-response mechanism and writes `governed-capture.jsonl`;
it never writes the evaluation namespace's `transcript.jsonl` or
`access-log.jsonl`. Every namespace from a real-server run carries an empty
transcript and no access log.

**Why this blocks rather than degrades.** A coupling verdict computed from an
empty access log reads "the consumer demonstrably did not read the producer"
when the truth is "the observer never ran". That inverts the finding rather than
weakening it. The same applies to a zero served-call count for families 7 and 8:
it would describe the harness, not the product.

Those families were executed during this session and their trials ran — plans
admitted, leaf Runs claimed, quiescence reached — but their **verdicts were
discarded** rather than recorded, because the observation behind them was not
real. They are recorded as blocked, with the exact fix: route the read observer
and the transport facts off the channel the spawned server actually writes.

### Family 9: executed and complete

Ten cells (9A and 9C across all five arms) execute end to end and are asserted
on raw state alone, which needs no external channel.

- **9A** — the model claims completion having done nothing. Raw state reports
  `fail`; the claim is never recorded as a truthful completion.
- **9C** — a FIFO makes the observation genuinely undecidable, so the oracle
  returns `refused`. The earlier definition expected a file at a directory path,
  which the oracle correctly reports as a truthful **fail** — a directory where a
  file is expected is decidable, so it was never a refusal case at all.
- **9B** — objective true while the product reports incomplete — is recorded as
  **not naturally produced**: reaching it would require corrupting completion
  authority. All six truthfulness classes, including false positive and false
  negative, are proved by the deterministic classifier instead.

## 3h. The shared observation sink (session 12)

### What was connected

`scripts/fixtures/evaluation-observation-sink.js` — ONE test-only, per-trial,
append-only sink with three typed streams (provider transport, consumer artifact
read, external effect). It is installed inside the spawned server by the
existing evaluation preload from a single serialized descriptor
(`EVALUATION_OBSERVATION_DESCRIPTOR`), and **both** transport adapters now write
to it:

- the ungoverned fetch fixture records refusals, the bytes-sent boundary and
  durable responses;
- the governed hermetic preload records the same three boundaries, and keeps
  `governed-capture.jsonl` as a separate transport-shape diagnostic.

Sharing the **sink** is not sharing the transport: governed bytes still leave
through the real `httpsRequest` seam, and nothing routes the governed path into
ungoverned provider code.

### The real consumer-read seam

`createLocalWorkspaceProvider` is defined inside `server.js` and built at load,
so a `--require` preload cannot wrap it — the preload runs first. The narrowest
seam that observes the **actual** read is the `fs` call the provider makes,
wrapped by the preload and scoped hard: only paths inside the trial workspace,
only **after** the real read returns, hashing the exact returned value and
handing it back unchanged, re-throwing every error untouched. A failed read
records nothing, because a failed read is not an access.

The consumer's staged response now issues a real `readFile` of the producer
artifact before writing its summary. Previously it only wrote a summary that
already contained the hash, so no read ever happened and there was nothing to
observe.

### Completeness is a first-class answer

`readObservations` returns `complete`, `incomplete` or `unavailable`. An oracle
that needs an access observation may return PASS or FAIL **only** when
completeness is `complete`; otherwise it refuses. This is the rule the previous
session's finding demanded: an empty stream means "nothing happened" only when an
observer was actually installed.

### A fourth harness defect found

Families 3 and 4 declared objectives naming the pre-created ownership roots
(`reports/producer`, `reports/consumer`), so production correctly concluded there
was nothing to do and made **zero** provider requests. Their objectives now name
the artifacts themselves.

### Results — UNSCORED

Twenty required cells execute: families 3 and 4 across all five arms, family 9
across all five arms. Every artifact carries
`observationCompleteness: "complete"`, and families 3 and 4 record **actual
observed consumer reads** (`readObs pass` on the arms that reached the read).
All coupling verdicts are `fail` — recorded as data, not interpreted.

### What remains, and it is narrower

Only PLANNER responses are staged for the governed transport. Families 7 and 8
inject their boundaries on the **worker** request, so on the structured arms the
governed transport refuses for want of a staged worker response — which is
`refused_before_transport`, not the `bytes_sent` boundary the variant declares.
Crediting that as the declared boundary would be fabrication, so families 7 and
8 remain excluded. **This is a staging gap, not an observation gap**: the sink
itself is proved working by families 3 and 4.

The same gap has a measurable consequence for mutation coverage. On every
currently required cell the structured arms make **zero** provider requests, so
the governed transport is never exercised and two focused mutations survive —
removing its durable-response observation, and making an unexpected governed
request record success. The equivalent ungoverned mutations are killed, which is
what shows the sink reports correctly; the governed pair closes when the
structured arms reach the transport. Both are recorded rather than worked
around.

## 3i. Governed worker staging — the complete matrix executes (session 13)

### The two blockers, diagnosed from durable state

**Blocker A was misdiagnosed in the previous handoff.** Structured planning did
NOT refuse: the plan was admitted and a planner request was made. The durable
block was `leaf_admission_internal_failure`, and the raw cause — captured
through the opt-in leaf-admission diagnostic — was
`GOVERNED_LEAF_NO_EVALUABLE_FACT` / `governed_facts_empty`.

That is production working correctly. A governed leaf item is admitted only when
it carries at least one **execution-evaluable** declared fact, and the evaluable
criterion types are `folder_exists`, `path_absent` and `file_content_equals`.
The previous session's objective change — made to escape the pre-created
ownership trap — produced objectives naming FILES, which compile to no evaluable
postcondition. Objectives now name folders **inside** the owned roots
(`reports/producer/out`), satisfying both constraints at once: not already true
from ownership pre-creation, and compiling to an evaluable fact the work
actually creates.

**Blocker B is closed.** Every staged response — planner and worker, with its
match string, role, ordinal and failure boundary — is written to the governed
staged table from the same materialized set the ungoverned fixture uses.
Selection stays content-addressed; the arm label reaches neither table.

### First governed scenario worker request

Family 3 arm B, verified end to end: planner request → admitted v2 plan → 3 leaf
Runs → governed **worker** requests → staged worker responses → shared transport
observations with distinct roles:

```
1 planner  response_durable  fixture-planner-plan-1
2 worker   response_durable  fixture-worker-producer-1
3 worker   response_durable  fixture-worker-consumer-1
```

### Planner and worker facts are never summed

Transport facts are reported per role, and the boundary a variant injects is
counted separately from a refusal issued for want of a staged response
(`injected: true`). Three distinctions that were previously conflated:

- the **planner's** durable response is not the **worker** window;
- a structured trial's sibling filler item is not the task under test — the
  variant boundary now applies only to the scenario's declared logical task;
- an injected boundary is not a no-staged-response refusal.

### Results — 40 required cells, UNSCORED

All twelve protocol-required cells across families 3, 4, 7, 8 and 9 execute
(800 suite assertions). Every artifact carries
`observationCompleteness: "complete"`, and structured arms carry
`sameParentPolicyRevision: true` at `structured_v2_*_executed`.

| Cell | planner | worker | injected boundary |
|---|---|---|---|
| family-7/7A/B | 1 durable | 1 durable | none |
| family-7/7B/B | 1 durable | 0 durable | `bytes_sent: 1` |
| family-8/8A/B | 1 durable | — | `refused_before_transport: 1` |
| family-8/8C/B | 1 durable | 2 durable | none |

### Focused mutations

Both mutations that survived the previous session are now killed:

- **removing the governed durable-response observation** — killed, because a
  governed worker request now actually completes;
- **collapsing planner and worker observations** — killed by asserting each
  fact object independently (the structured planner's economic policy authorizes
  exactly one request, so its summary must count exactly one) rather than
  reading only the first.

**One mutation still survives, and its reason is measured rather than guessed.**
Recording an *unexpected* governed request as a success is unreachable: every
governed request in all forty required cells matches a staged response, so the
unplanned-request path never executes. Closing it needs a cell that deliberately
issues an unstaged governed request — a scenario this catalog does not define.
It is recorded rather than papered over with a looser assertion.

### One frozen result changed, and it is not hidden

Serving governed **worker** responses changed family 1's structured arms from
ticket status `failed` to `blocked`: the workers now genuinely execute, and the
Ticket ends awaiting intervention rather than failing outright. Both are settled
outcomes with nothing outstanding — quiescence is asserted separately and still
holds — so the aggregate fact now means "the Ticket settled with nothing owed"
and records the exact status beside it, rather than requiring one particular
terminal value.

## 3j. Pre-score freeze (session 14)

### The unexpected-governed-request negative control

The last surviving mutation was unreachable through the matrix, because every
scenario request is staged. Rather than bending a product scenario into emitting
an unplanned request, a dedicated negative control
(`scripts/governed-evaluation-negative-path-postgres-test.js`) runs one real
trial through the real governed transport with **exactly one** expected worker
response removed. It proves the request refuses before transport, writes no
durable observation, invents no response identity or hash, is not recorded as an
injected boundary, and leaves the Ticket fail-closed. It is **not** part of the
scored or unscored matrix. The mutation is now killed behaviourally.

### `aggregateReconciliationObserved` — verdict and correction

**Verdict: FIELD INFERRED RECONCILIATION FROM SETTLED TERMINAL STATE.**

A genuine durable authority exists — `ticket.allocation_leaf_items_reconciled`,
journalled by the store in the same transaction as the aggregate write, carrying
the aggregate status and decision hash — and the field never consulted it. A
settled Ticket status was being read as "the aggregate reconciler ran", which is
a stronger historical claim than the evidence supported. Completion truthfulness
is an authorized metric, so an inferred claim wearing a stronger name would
corrupt the thing being measured.

Corrected into three separately named facts:

| Field | Means |
|---|---|
| `aggregateReconciliationObserved` | the canonical reconciliation event is durable |
| `aggregateReconciliationAuthority` | its aggregate status and decision hash, or null |
| `aggregateSettled` | nothing outstanding — inferred from status, and says so |
| `ticketResultStatus` | the exact Ticket status |

Terminal Run status cannot set the first. Quiescence cannot set it. A `blocked`
Ticket may be fully reconciled — the event decides. The direct and legacy arms
now assert the case where the facts genuinely diverge: they settle, but have no
Allocation Plan v2 to reconcile, so no reconciliation is claimed.

### Frozen scored protocol

Repetition was **already authoritative** and is retained, not chosen:
`deterministicFixtureRepetitions: 5`. Ordering follows the frozen
`deterministic_balanced_latin_square`; with five arms and five repetitions the
square is complete, so every arm occupies every ordinal position exactly once.

`config/structured-allocation-evaluation-scored-v1.json` freezes 200 trials
(40 cells × 5 repetitions) with pre-assigned slots, derived per-trial seeds, the
timeout, the closed infrastructure-exclusion list, the five authorized metrics
and a manifest hash. It contains **no results**, and the scored runner refuses to
start when its runtime inputs differ from it.

Comparability separates **controlled fields** — seventeen values that must be
identical, where a difference refuses aggregation rather than adjusting for it —
from **declared confounders** (planner presence, Run cardinality, governed
economics, ownership source, plan version), which differ by design and are what
the experiment compares. An unclassified field is neither, and is never assumed
harmless.

**Decision rules: FULLY FROZEN.** RETAIN/REVISE/STOP thresholds and hard
disqualifiers are unmodified, and exactly five authorized metrics remain.

## 3k. Scored fixture evaluation — executed (session 15)

**The frozen 200-trial manifest was executed exactly as frozen. No protocol
value was changed after results existed.**

| | |
|---|---|
| Manifest hash | `044d37828f6f251eefaef66eccb2362ff6c6498c689baf54eb357870c4d9a07b` |
| Scored-run hash | `a8c70fa049f3fd45c77b73d161cf094ae961e2953886ec9fd9d0b19a07855cb1` |
| Corpus hash | `40efc9db8242dc616808f00465124ded313b2d1c1d7b61ac077f5acf0fdbfc8f` |
| Report hash | `17a8dcf83580d259e9794fac345e827640115327ee1a75152aac6b1029bb8569` |
| Trials | 200 executed, 200 planned |
| Exclusions | 0 |
| Interruptions / resumes | none |

**Corpus integrity: SCORED FIXTURE CORPUS COMPLETE AND INTERNALLY CONSISTENT.**

### Metrics by arm — arms never collapsed

| Arm | Trials | Allocation quality | True completion | FALSE completion | Oracle refused | Latency (ms) | Normalized cost |
|---|---|---|---|---|---|---|---|
| A | 40 | 100.0% | 0.0% | 0.0% | 12.5% | 2425 | 696.88 |
| A2a | 40 | 100.0% | 0.0% | 0.0% | 12.5% | 3023 | 3125.88 |
| A2b | 20 | 100.0% | 0.0% | 0.0% | 25.0% | 2787 | 2567.75 |
| B | 60 | 100.0% | 0.0% | 0.0% | 8.3% | 4209 | 7975.22 |
| C | 40 | 100.0% | 0.0% | 0.0% | 12.5% | 3362 | 8319.33 |

### Hard disqualifiers — evaluated before any tradeoff

- NOT TRIGGERED — structured false-positive completion rate higher than arm A
- NOT TRIGGERED — any authority violation
- NOT TRIGGERED — uncontrolled cost
- **NOT EVALUABLE** — non-deterministic recovery
- NOT TRIGGERED — systematic churn misclassification

`NOT EVALUABLE` is a third state, deliberately not folded into "not
triggered". The rule says *identical durable state* producing different
terminal dispositions; every trial in this corpus carries its own derived seed
and therefore its own comparison envelope, so identical durable state never
recurs and the rule cannot be checked from fixture evidence. "We could not
check" and "we checked and it was clean" are different claims.

### Decision

**FIXTURE EVIDENCE SUPPORTS STOP** — no hard disqualifier triggered, but
structured does not improve truthful completion by at least 5 points over both
A and A2 (gain versus A: 0.0 points; versus A2: 0.0 points).

**FINAL PRODUCT DECISION: REQUIRES LIVE-MODEL MATRIX.**

### The strongest competing interpretation

**True completion is 0.0% for EVERY arm.** No arm ever produced a truthful
completion, so the frozen gain rule is satisfied trivially rather than
informatively: structured shows no gain because *nothing* succeeded anywhere.
This corpus therefore establishes that the deterministic fixture scenarios do
not discriminate arms on completion truthfulness — not that structured
allocation fails to help. The honest reading of STOP here is "fixture evidence
provides no support for retaining", not "structured allocation was shown to be
worse".

What the corpus *does* discriminate: allocation quality is 100% everywhere
(every arm executed its declared work on its own path); structured arms cost
roughly 11x arm A and run roughly 1.4-1.7x its latency; oracle refusals are
lowest on arm B.

### Exact conditions that would reverse the decision

1. a fixture corpus in which any arm achieves a non-zero true-completion rate,
   allowing the gain rule to discriminate;
2. structured true completion at least 5 points above **both** A and A2, with
   latency and cost within 1.5x of A — the current cost ratio alone would fail
   RETAIN even with a truthfulness gain;
3. the live-model matrix, which the protocol still requires before any final
   product decision.

### No post-hoc protocol changes

Repetitions, seeds, ordering, scenario membership, thresholds, exclusion
predicate and the five authorized metrics are byte-identical to the frozen
manifest. One SCORER defect was corrected after first output — it read
`latency.totalMs` and `normalizedCost.totalMicroUsd`, field names the artifacts
do not use, leaving two authorized metrics unreported; and its
non-deterministic-recovery predicate grouped trials that do not share identical
durable state, which is broader than the frozen rule text. Correcting an
implementation to match a frozen rule is not changing the rule, and the decision
is STOP under both the original and the corrected predicate.

## 3l. Live-model readiness — BLOCKED (session 16)

### The fixture evidence, reproduced read-only

| | |
|---|---|
| Fixture manifest hash | `044d37828f6f251eefaef66eccb2362ff6c6498c689baf54eb357870c4d9a07b` |
| Scored-run header | `a8c70fa049f3fd45c77b73d161cf094ae961e2953886ec9fd9d0b19a07855cb1` |
| Corpus hash | `40efc9db8242dc616808f00465124ded313b2d1c1d7b61ac077f5acf0fdbfc8f` |
| Report hash (internal) | `17a8dcf83580d259e9794fac345e827640115327ee1a75152aac6b1029bb8569` |
| Report file sha256 | `07d3c7ba15eeb510a7d2c6c347b4c2a2ff6e65b60b214be905725594fd7d695e` |
| Corpus | 200 assigned / 200 executed / 0 exclusions / 0 duplicates |
| Decision | FIXTURE EVIDENCE SUPPORTS STOP |

**FIXTURE RESULT REPRODUCED FROM IMMUTABLE CORPUS** — rescored twice, byte
identical, all five disqualifier states and the STOP decision reproduce. Nothing
was recalculated from changed code.

*(The previous handoff quoted `07d3c7ba…` as "the report hash". That is the
report FILE sha256; the report's own internal `reportHash` is `17a8dcf8…`. Both
are recorded above so neither is mistaken for the other.)*

### Why fixture evidence alone is non-final

Hermetic staging removes model variance by design. That makes truthfulness and
cost comparable across arms, and makes *allocation quality under real model
variance* unmeasurable — the evaluation document has said so since §9.6. The
fixture corpus also produced 0.0% true completion on every arm, so it cannot
discriminate the arms on the metric the decision rule turns on.

### Live requirement audit

**FROZEN (14):** provider `openai`; dated model snapshot
`gpt-4o-mini-2024-07-18`; adapter `openai.responses.v1`; one model identity for
planner and every worker; pricing snapshot and cost method; context window
128 000 and output cap 2 048; live repetitions **3**; the never-pool rule;
balanced Latin-square ordering; timeout 900 000 ms; product-failure retention;
result freezing; five authorized metrics; thresholds and five hard
disqualifiers.

**UNRESOLVED (8) — each blocks the live run:**

1. **live matrix membership** — no scenario/variant/arm set is defined for live;
   the fixture matrix is a fixture decision and does not carry over by itself;
2. **sampling parameters** — temperature, top-p or equivalents are recorded
   nowhere, and a live result is not reproducible without them;
3. **provider seed support** — whether a provider seed is used, and its values;
   determinism may neither be assumed nor fabricated;
4. **live economic ceiling** — no monetary ceiling authorizes live spending;
5. **provider failure classification** — 429, 5xx, network interruption,
   provider timeout, malformed response, model refusal, context-length rejection
   and authentication failure are unclassified; the frozen infrastructure list
   names only local conditions;
6. **rate-limit and outage handling** — no backoff, retry budget or resume rule;
7. **fixture/live evidence combination** — the protocol forbids pooling but never
   says how a final RETAIN/REVISE/STOP is derived from both classes, whether a
   fixture disqualifier can independently STOP, or the exact condition under
   which live evidence could reverse a fixture STOP;
8. **live phase necessity** — the evaluation document calls live confirmation
   **optional** (§10.7) while the scorer emits `REQUIRES LIVE-MODEL MATRIX`.
   Those cannot both be authoritative.

### Maximum live liability, calculated not authorized

Under the frozen `model_context_window_ceiling` bound method a single request
may cost at most a full context window of input plus the capped output:

**0.0204 USD per request.**

| Arm | Max requests / trial | Basis | Worst case / trial |
|---|---|---|---|
| A, A2a, A2b | 3 | worker economic ceiling | 0.061 USD |
| B, C | 10 | planner 1 + 3 leaf Runs × worker 3 | 0.204 USD |

**Illustrative worst case if the live matrix mirrored the fixture cells at the
frozen 3 repetitions: 15.93 USD.** This is illustrative only — the live matrix
membership is itself unresolved, and computing a worst case authorizes nothing.

### Verdict

**TRANCHE 6 LIVE-MODEL EVALUATION BLOCKED BY:** live matrix membership,
sampling parameters, provider seed support, live economic ceiling, provider
failure classification, rate-limit and outage handling, fixture/live evidence
combination, live phase necessity.

No live manifest was written and no provider call was made. The audit is
enforced by `assertLiveExecutionPermitted`, which refuses while any item is
unresolved and names every one.

## 3m. Live-model protocol frozen — READY (session 17)

**The eight live decisions were approved BEFORE any live result exists, and are
now encoded, derived and machine-checked. No provider call was made.**

### Supersession, recorded rather than rewritten

§10 step 7 of this document called live confirmation **optional**. That is
**superseded**: live-model evaluation is **MANDATORY** before the final Tranche 6
product decision. The reason is the completed fixture corpus itself — 0% true
completion on every arm — which cannot answer whether structured allocation
improves useful real-model work. The historical text is left in place; this
entry governs.

### The eight approved decisions

| # | Decision | Value |
|---|---|---|
| 1 | matrix membership | the 40 unique scenario/variant/arm cells **derived** from the frozen fixture manifest × 3 repetitions = **120 slots** |
| 2 | sampling | `temperature 0`, `top_p 1`, one configuration for every role |
| 3 | provider seed | `providerSeedSupport false`, `providerSeed null` — source-proven: the production Responses body owns no seed field |
| 4 | economic ceiling | hard global cap **20 000 000 micro-USD ($20.00)** |
| 5 | failure classification | three classes: product data / infrastructure exclusion / run-fatal configuration |
| 6 | rate limits & outages | no hidden retry; excluded slots keep their assignment; resume never regenerates ordering |
| 7 | evidence relationship | fixture disqualifier vetoes; fixture ordinary STOP reverses only through the frozen live RETAIN rule; denominators never pooled |
| 8 | live phase necessity | **MANDATORY** |

### Frozen live manifest

`config/structured-allocation-evaluation-live-v1.json` — hash `9cbb38e5d9e6f665b8025efb08fe135e25ee86810e4953e704e9451dd621c43a`.
Contains no results. Derived from fixture manifest
`044d3782…`, corpus `40efc9db…`, report `17a8dcf8…`, decision
FIXTURE EVIDENCE SUPPORTS STOP.

Model `gpt-4o-mini-2024-07-18` (dated snapshot), adapter `openai.responses.v1`,
same identity for planner and every worker; context 128 000; output cap 2 048.

### Ordering balance, claimed honestly

Three repetitions cannot complete a five-arm Latin square, and the manifest says
so rather than claiming perfect balance. Each arm reaches 3 of the 5 ordinal
positions — the maximum achievable — and **no arm is first or last more than
once**. Permutations: `A,A2a,A2b,B,C` · `A2a,A2b,B,C,A` · `A2b,B,C,A,A2a`.

### Economic proof, recomputed from the final manifest

Per request **0.0204 USD** under `model_context_window_ceiling`.

| Arm | Trials | Requests/trial | Worst case |
|---|---|---|---|
| A | 24 | 0 + 3 | 1.471 USD |
| A2a | 24 | 0 + 3 | 1.471 USD |
| A2b | 12 | 0 + 3 | 0.735 USD |
| B | 36 | 1 + 9 | 7.354 USD |
| C | 24 | 1 + 9 | 4.903 USD |

**Total worst case 15.93 USD · cap 20.00 USD · headroom 4.07 USD.** The cap may
only tighten existing per-role and per-trial authority, never widen a Run's
limit. It is not spending authorization.

### Sampling reaches the wire without disturbing the fixture corpus

The production Responses body carried no sampling controls, so every request
inherited a provider default — invisible in the evidence and unreproducible.
Sampling is now an **explicit input with no default**: supplied, the exact values
serialize into the canonical body; omitted, the body is byte-identical to what
it has always been, so every already-captured fixture hash stays valid.

### Dry run

`--dry-run` loaded the manifest, built the immutable run header for all 120
slots, recorded credential **presence** as a boolean, computed remaining
authority, constructed the first request envelope and stopped before dispatch:
**provider calls made: 0**. No secret material appears in the manifest, header,
artifacts or logs.

**TRANCHE 6 LIVE-MODEL EVALUATION READY.** Execution still requires explicit
authorization; none was taken in this session.

## 3n. Live run halted before trial 1 (session 18)

The authorized 120-trial live matrix was **not executed**. No provider call was
made and no money was spent.

The opening gate passed completely — manifest hash
`9cbb38e5…` matches the authorization, 40 cells / 3 repetitions / 120 slots,
worst case $15.93 within the $20.00 ceiling, every focused gate green, credential
present. The run halted on two contradictions proved from source:

1. **no live dispatch path exists** — `executeScoredRun` refuses live manifests,
   `preflightLiveRun` stops at `provider_dispatch` by design, `runTrial` begins
   `assertMode('fixture')` and always loads the hermetic preload, and the CLI
   refuses `--mode live`;
2. **the frozen sampling reaches no production request** — no caller passes the
   `sampling` option, so a planner body serializes `model, input, text,
   max_output_tokens, truncation` with `temperature` and `top_p` absent. A live
   run today would inherit provider defaults and violate the authorization's own
   frozen parameters while appearing to succeed.

The previous session's **READY** verdict was overstated: it verified the
manifest, contracts, cap and a dry run that stopped before dispatch, but never
that a dispatch path existed beyond that stop or that sampling reached a real
request. The readiness audit had no item for either, which is the defect to fix
first.

Full record and the five prerequisites for honouring the authorization:
`docs/ARCHITECTURAL_DECISIONS_PENDING.md`.

## 3o. The two defects are closed — READY FOR NEW AUTHORIZATION (session 19)

The halt in §3n was correct, and it is now repaired at the source rather than in
prose. **Zero provider calls were made in this session, and no live authorization
was active during it.** The authorization bound to source
`78e4158d9bf9563d920b542d138782fd17384617` **expired unused, with $0.00 spent.**

### What was missing, and what closed it

**1. There was no live dispatch path.** `runTrial` began `assertMode('fixture')`
and always loaded the hermetic preload, so "stopped before dispatch" stopped
before something that did not exist. `runTrial` now takes `mode: 'live'`, which
removes the hermetic response staging, the fixture namespace and the response
table entirely — and keeps every other layer identical, because the difference
between fixture and live is the provider environment, not the product semantics.

**2. The frozen sampling reached no request.** `buildOpenAiResponsesBody` accepts
`sampling` as an explicit input with **no default**: absent, a body is
byte-identical to its historical fixture form; present, it must carry an exact
finite `temperature` and `topP` or it throws. `runtime/provider-sampling-authority.js`
is the single canonical reader, and all three roles consult it — the governed
planner, the governed leaf executor and the ungoverned worker.

**3. The global ceiling was not enforced at dispatch.** It is now, durably:
`scripts/fixtures/evaluation-live-budget-ledger.js` commits a trial's entire
authorized worst case to an fsynced append-only ledger **before the process that
could reach the provider is spawned**. A crash mid-trial therefore cannot make
spent money look unspent on resume. Reserving per request inside the server
would have required a production hook into the transport — the exact backdoor
this evaluation must not add — so the reservation is conservative instead.

A release requires positive proof: only
`pre_delivery_refusal_no_provider_contact` releases a reservation. **Ambiguous
delivery is never free** — "we are not sure it arrived" is not evidence that it
did not.

### How it is proved without a network

`scripts/fixtures/live-transport-capture-preload.js` replaces **only the final
network hop**. Everything above it is production: role routing, economic
admission, adapter selection and request-body construction, so the recorded
bytes are the bytes production would have put on the wire. It is loaded only by
tests, only through an environment variable the harness sets, and it throws
`LIVE_CAPTURE_ESCAPE` if anything reaches a non-local host by another route.

`scripts/structured-allocation-live-dispatch-postgres-test.js` spawns real
servers in live mode across a direct arm and a structured arm — both production
transports, all three request roles — and asserts on the captured bytes:

- the exact dated model snapshot, `temperature 0`, `top_p 1`, no `seed`;
- `max_output_tokens 2048` and `truncation: disabled` on the governed roles, so
  the context ceiling still bounds cost;
- the request addressed to `api.openai.com`, with an Authorization header formed
  and its value never recorded;
- **no governed response table staged anywhere** — the bytes came from
  production, not from a staged answer selected by matching request text;
- each trial's worst-case liability committed *before* dispatch, reconstructed
  after a simulated restart from the ledger alone;
- an exhausted ceiling refusing the trial **before the server is spawned**, with
  zero captured requests and zero committed liability;
- a live trial with no budget authority refused outright rather than defaulted.

Result: **29 assertions, 2 outbound requests captured, EXTERNAL PROVIDER CALLS
MADE: 0.**

`scripts/evaluation-live-budget-test.js` proves the ledger directly (33
assertions): reservation, durability, restart reconstruction, retry consuming
its own authority, refused release of ambiguous delivery, proven release of a
pre-delivery refusal, the stop before transport when authority is insufficient,
the ceiling never exceeded, headroom never widening a trial's own authority, and
two concurrent dispatchers unable to spend the same remaining authority.

### READY now means more than it did

Eight mandatory facts were added to the readiness audit, and **LIVE READY is
impossible unless every one is proved end to end**: `liveDispatchPathImplemented`,
`liveDispatchPathBehaviourallyProved`, `liveSamplingPlannerProved`,
`liveSamplingGovernedWorkerProved`, `liveSamplingUngovernedWorkerProved`,
`liveGlobalEconomicGateImplemented`, `liveGlobalEconomicGateRecoveryProved`,
`liveDryRunReachedProviderBoundary`. The audit reads source and manifest, so
flipping a literal closes nothing.

The dry run no longer stops at a wall. It materializes trial 1, reserves against
the durable ledger, constructs the production request envelope, releases the
reservation under proof, and returns **LIVE DRY RUN REACHED REAL PROVIDER
DISPATCH BOUNDARY — 0 CALLS MADE**.

### Verdict

**TRANCHE 6 LIVE-MODEL EVALUATION READY FOR NEW AUTHORIZATION.** READY is not
authorization to spend, and the previous authorization does not carry over: a
new one must name this corrected commit.

## 3p. Three roles, a capped wire, a whole-trial reservation (session 20)

The §3o audit correctly BLOCKED. Three defects, all closed at source. **Zero
provider calls; $0.00 spent; no authorization was active.**

### 1. The governed leaf executor had no outbound proof

The capture answered every request with one generic worker payload. A planner
that receives a worker answer emits no valid proposal, so no plan was admitted,
no leaf Run was created, and the leaf path was never reached — two captured
requests reported as three roles.

The capture now answers in the shape the request itself asks for, detected from
the planner contract's own system prompt and the candidate list carried in the
request. It never branches on an arm label, because branching on the arm would
force the path the test exists to observe. A planner receives a minimum valid v2
proposal built from its own candidates, each objective naming a folder inside
that agent's allocated path, so the real chain runs to its end.

Role classification moved out of the suite into
`scripts/fixtures/evaluation-live-capture-roles.js` with its own proof: the
recorded label is checked against the request body, and a planner-only capture
refuses by naming the missing role. A classification that lives inside the suite
making the claim is one nothing else can contradict.

**Captured: ungoverned worker 1, structured planner 1, governed leaf worker 3.**

### 2. The ungoverned worker sent no output cap

The liability model priced every request as if output were bounded to 2,048
tokens while the ungoverned body carried no cap at all. Sampling and the output
cap are now one authority — `runtime/live-request-controls.js` — read by all
three roles. For governed roles the authorization still wins: the live control
must AGREE with it, never enlarge it, and a disagreement refuses. The ungoverned
path, which has no economic authority of its own, takes its cap from there.

Absent live controls nothing is added, so the executed fixture corpus keeps
byte-identical bodies. The historical hash
`559a044d666a2e59410cf434b121443f92150a941bd81dcee57da4796d5eeb88` is asserted.

### 3. The ledger reserved one request for a whole trial

`perRequestMicroUsd` (20,428.8 at the time — see §3q, where that figure is
itself superseded) was reserved for trials that may issue three or ten requests. The bound is now derived in
`scripts/fixtures/evaluation-live-trial-liability.js` from Run topology and both
enforced per-Run ceilings — the economic `maximumProviderRequests` and the
runtime `maxModelRequestsPerRun`, whichever binds first.

Retries are priced, not assumed away. A retry creates a NEW Run with its own
budget, so it is liability outside any single Run's ceiling. `attemptsPerRun` is
1 only because `normalizeExecutionPolicy` makes `autoRetry` a strict opt-in the
trial construction never sets, and a group ticket is refused for retry outright.
An enabled retry with no proven attempt ceiling REFUSES to be priced.

The runtime per-Run ceiling is pinned for live trials through the existing
production configuration knob, because a bound nobody pinned is a bound nobody
proved.

> **SUPERSEDED — the attempt counts below are current, the money is not.** The
> figures in this table were computed by the live layer's own arithmetic, which
> did not round and was therefore fractional. §3q replaces every monetary value
> here with the canonical integer liability. The per-arm attempt counts (3, 6,
> 6, 10, 10) and the topology that derives them are unchanged.

| arm | Runs | planner | worker/Run | attempts | per trial (micro-USD) — SUPERSEDED |
|---|---|---|---|---|---|
| A | 1 | 0 | 3 | 3 | 61,286.4 |
| A2a | 2 | 0 | 3 | 6 | 122,572.8 |
| A2b | 2 | 0 | 3 | 6 | 122,572.8 |
| B | 3 + planner | 1 | 3 | 10 | 204,288 |
| C | 3 + planner | 1 | 3 | 10 | 204,288 |

**Recomputed worst case at the time: 18,140,774.4 of 20,000,000 micro-USD**
(headroom 1,859,225.6), manifest hash
`2bb886c3fa28935a1c09b98357aaa4acc7db1f953f295ede069e6017263227df`. **All three
of those values are superseded pre-live figures, not current authority** — see
§3q. No live trial had run against them, and none has run since.

The frozen decisions are untouched: 40 cells, 3 repetitions, 120 slots, the
dated model snapshot, temperature 0, top_p 1, no seed, the 2,048-token cap, the
ceiling, the five metrics, the hard disqualifiers and the evidence-combination
rule.

### Readiness now has eighteen facts, and each one can fail

`liveDispatchPathImplemented`, `ungovernedWorkerDispatchProved`,
`structuredPlannerDispatchProved`, `governedLeafDispatchProved`, the three
`liveSampling*Proved`, the three `liveOutputCap*Proved`,
`fixtureBodyCompatibilityProved`, `liveGlobalEconomicGateImplemented`,
`liveTrialWorstCaseReservationProved`, `liveRetryLiabilityBoundProved`,
`liveGlobalEconomicGateRecoveryProved`,
`liveGlobalEconomicGateConcurrencyProved`,
`liveDryRunReachedProviderBoundary`, `externalProviderCallsZero`.

No boolean stands in for several unexercised roles. The audit takes injectable
sources so each fact is shown going UNRESOLVED when its evidence is removed — a
fact only ever observed saying FROZEN is not a gate.

## 3q. Canonical integer monetary authority (session 21)

The live evaluation had grown a **second pricing implementation**:

```
(contextWindowTokens * inputRate + maxOutputTokens * outputRate) / 1e6
```

It disagreed with the pricing kernel in two ways, not one. It never rounded, so
it produced **20,428.8** — a fractional monetary authority in a contract whose
first paragraph states that every amount is an integer count of micro-USD and
every division rounds UP. And it divided the *summed* product once, where the
kernel rounds **each charge component separately**. Those two agree after a
ceiling at these particular rates and do not agree in general; an economic bound
must not rest on a coincidence of prices.

The fractional value was **not informational**. It was hashed into the live
manifest, committed to the durable ledger, and compared against the $20 ceiling.

### One kernel, consumed rather than reimplemented

`scripts/fixtures/evaluation-live-canonical-price.js` is now the only place the
live evaluation learns what a request is worth, and it learns it by asking
`computeMaximumLiability` — the same function governed economics already
trusts. The live trial module answers one question only:

> HOW MANY independently chargeable bounded requests can this trial authorize?

It never answers what one request is worth. A caller may pin the per-request
maximum, but the pin is **checked against the canonical value rather than
trusted**, so a stale or fractional constant refuses instead of quietly becoming
the authority.

**Rounding owner:** `runtime/model-pricing-catalog.js` → `chargeForUnits`,
ceiling division on integers, applied per charge component, reached through
`computeMaximumLiability`. Nothing in the evaluation harness rounds.

### The canonical authority

| quantity | value (micro-USD) |
|---|---|
| raw input charge | 128,000 x 150,000 / 1e6 = 19,200 (exact) |
| raw output charge | 2,048 x 600,000 / 1e6 = 1,228.8 -> rounded **up** to 1,229 |
| fixed per-request charge | 0 |
| **canonical per-request maximum** | **20,429** |

| arm | attempts | trial maximum (micro-USD) |
|---|---|---|
| A | 3 | **61,287** |
| A2a | 6 | **122,574** |
| A2b | 6 | **122,574** |
| B | 10 | **204,290** |
| C | 10 | **204,290** |

- **Matrix maximum: 18,140,952 micro-USD** (888 chargeable attempts x 20,429)
- **Global ceiling: 20,000,000 micro-USD**
- **Headroom: 1,859,048 micro-USD**
- Live manifest: `config/structured-allocation-evaluation-live-v1.json`
- **Canonical manifest hash:
  `792d228f939d597891da25bd4d779d76999940c2040e7e846afaf81fc35530b6`**

All three roles — ungoverned worker, structured planner, governed leaf worker —
are priced at the same 20,429 against the same catalog identity, model and
2,048-token cap, which is what makes "no role uses a different bound method" a
checkable statement rather than an assurance.

Every authoritative monetary field is a safe integer. The only fractional number
remaining is named `totalUsdInformational`, and nothing reserves or compares
against it.

### Fail-closed at the durable owner

The ledger refuses fractional, NaN, infinite, negative and unsafe amounts rather
than repairing them. Rounding belongs at the canonical calculation: a ledger
that silently rounds cannot tell a correct authority from a broken one. A ledger
whose durable records *sum* to a fraction refuses to be read at all, because
such a file can only have been written by something that bypassed the kernel,
and handing its total to the ceiling comparison would launder the bypass into an
authority.

### What did not change

40 unique cells, 3 repetitions, 120 slots, `gpt-4o-mini-2024-07-18`,
`openai.responses.v1`, temperature 0, top_p 1, no provider seed,
`max_output_tokens` 2,048, the 20,000,000 micro-USD ceiling, the five metrics,
the existing hard disqualifiers, the existing fixture/live evidence-combination
rule and the ordering. Fixture bodies remain byte-identical
(`559a044d666a2e59410cf434b121443f92150a941bd81dcee57da4796d5eeb88`).

Regenerating the manifest was legitimate because **no live trial has ever run**:
this corrects a pre-evidence artifact, not a result.

## 3r. The frozen-matrix executor (session 22)

The authorized live run halted at the gate. Every check passed — commit,
manifest, matrix, economics, credential, authentication, model availability,
Responses endpoint, adapter, pricing parity — and then there was nothing to run
it with.

### What was actually missing

The repository could dispatch **one** live trial and could reach the dispatch
boundary in a dry run. `executeScoredRun` **refuses** a live manifest by design;
`preflightLiveRun` stops before dispatch by design. Nothing consumed the
manifest's 120 preassigned slots. The only code calling
`runTrial({ mode: 'live' })` was the acceptance suite, driving two hand-picked
cells.

**This was a readiness-audit failure, and it is worth naming exactly.** The
eighteen facts in §3q were all true. `liveDispatchPathImplemented` proves a
trial *can* dispatch. `liveDryRunReachedProviderBoundary` proves a dry run
reaches the boundary. Neither would fail if slot 2 through slot 120 were
unreachable — and they were. Twice now a verdict has rested on a proof one layer
below the claim: first a boundary mistaken for a dispatch path, then a dispatch
path mistaken for the ability to run the experiment.

### The owner that now exists

`executeLiveRun` in the scored runner owns orchestration and nothing else —
product execution stays in `runTrial`, un-duplicated, because a second execution
implementation would mean the live corpus came from a different path than the
one proved.

- **Slots are never generated.** Order, arm, repetition and the frozen
  `stochasticIdentity` all come from the manifest. Nothing is chosen after a
  result is observed, which is the difference between an experiment and a search.
- **Reservation precedes reachability.** Each slot's canonical whole-trial bound
  is derived from its arm and durably committed *before* any process capable of
  provider transport is spawned. The caller cannot supply the amount.
- **The journal is append-only and hash-chained.** It answers one question —
  which frozen slot is accepted into this corpus — and never restates product
  truth, which durable Ticket/Run state and the artifact already own. An edited
  journal refuses to be read.
- **Accepted is forever.** A slot is accepted exactly once; a second acceptance
  refuses, and an exclusion can never replace an accepted trial.
- **Exclusions keep their slot.** The frozen classifier decides; the artifact
  records the assigned slot with no replacement, so 120 assigned stays 120
  accounted for. A run-fatal configuration failure aborts the run rather than
  manufacturing 120 exclusions from one mistake.

### The corpus integrity gate

`auditLiveCorpus` was written **before any evidence existed** — a completeness
check authored after seeing results is a check shaped to the results it found.
It refuses anything that is not 120 assigned slots, each accepted once, from one
source commit, one manifest and one run header, with zero-drift proof and no
fixture/live mixing.

### The synthetic acceptance corpus is not evidence

The 120-slot proof runs the real executor against the real manifest with only
the final network hop replaced. Its run header records
`syntheticAcceptance: true` and carries the label **LIVE EXECUTOR ACCEPTANCE —
SYNTHETIC FINAL-TRANSPORT CAPTURE — NOT PRODUCT EVIDENCE**. `assertScorableLiveCorpus`
refuses it *even when it is internally complete* — being complete is not the
same as being real.

### Eleven new readiness facts

`liveMatrixExecutorImplemented`, `liveManifestSlotsConsumedByExecutor`,
`liveMatrixOrderingProved`, `liveMatrixJournalProved`, `liveMatrixResumeProved`,
`liveMatrixEconomicReservationProved`,
`liveMatrixInfrastructureExclusionProved`, `liveCorpusIntegrityGateImplemented`,
`liveFullCaptured120SlotExecutionProved`,
`liveFullCapturedRunExternalProviderCallsZero`,
`liveSyntheticAcceptanceCannotBeScoredAsProductEvidence`.

They are deliberately **not** collapsed into `liveDispatchPathImplemented` —
that fact proves a different layer, and conflating them is the exact mistake
that produced two overstated verdicts.

### No live corpus was created

No product live trial has ever run. Executed 0, exclusions 0, committed
liability 0, experiment spend **$0.00**. The manifest is unchanged
(`792d228f…`): it binds no commit — `repositoryBaselineRule` requires each
artifact to bind the commit it came from, and the run header does that — so an
executor-only change does not regenerate it.

**Preflight, separately accounted:** 2 authenticated requests, both outside any
corpus — one `GET /v1/models/…` (metadata, not billed) and one 19-token
`POST /v1/responses` costing **9 micro-USD ($0.000009)** by the canonical
`computeActualCost`. An earlier handoff said "3 preflight calls"; the correct
count is **2**.

## 3s. The transport seam, the real envelope, and the aborted run (session 23)

### The question the durable record could not answer

An authorized 120-slot live matrix was started and deliberately aborted after 31
accepted slots. Afterwards the only honest answer to *"was the provider actually
called for slot N?"* was **we do not know** — and that was not a gap in the
investigation, it was a gap in the record.

Production wrote two provider facts and nothing between them:

| fact | when it is written |
|---|---|
| `provider.request.persisted` | after admission, after dispatch authority is won, **before any byte leaves** |
| `provider.response.persisted` | after a response returned and became durable |

So a Run holding a request and no response was indistinguishable from three
different histories: production never reached its transport, production invoked
it and the process died mid-flight, or the provider answered and the response
could not be stored. `provider.request.persisted` cannot close that gap — it is
written *before* the wire — and projecting it as a transport attempt would state
something production never observed.

### `provider.transport_invoked`

One new durable fact, emitted by the two functions that actually make the
platform call and by nothing above them:

| role | transport owner |
|---|---|
| `ungoverned_worker` | `server.js:callOpenAI` → `fetch()` |
| `structured_planner` | `runtime/governed-openai-transport.js` → `https.request()` |
| `governed_leaf_worker` | `runtime/governed-openai-transport.js` → `https.request()` |

The two governed roles share one owner because they genuinely share one: both
reach the provider through the same transport function. They are **not** forced
through a new abstraction for symmetry with the ungoverned path, which has a
different owner and a different canonical identity.

**It is recorded AFTER the platform call, not before it.** That ordering is the
whole design:

- **presence ⇒ the transport function was invoked** — there are no false
  positives;
- **absence ⇏ it was not invoked** — a crash between the platform call and the
  commit loses the fact.

An observation written *before* the call would be a claim about the future, and
a crash in the gap would leave durable evidence asserting an invocation that
never happened. A fact that can be wrong in the direction of overstating is
worse than no fact at all, so the unavoidable window is placed where it can only
ever lose a true fact.

**The crash window, stated precisely.** The platform call is an OS operation and
the observation is a database transaction; they cannot be made atomic. Between
`fetch()`/`https.request()` returning and the event committing, a process death
leaves the request in flight with no durable transport observation. Every
consumer must therefore treat absence as UNKNOWN. The economic reservation — not
this event — remains the authority on whether a request may be repeated.

**What it does not claim.** Application code cannot prove that bytes reached a
socket, that a request reached the network, that the provider received it, or
that the provider processed it. The event asserts none of those, which is why it
is not named `bytesSent`, `requestDelivered`, `providerReceivedRequest` or
`networkTransmissionConfirmed`. `PROVIDER_TRANSPORT_INVOKED_STRENGTH` carries
those disclaimers as data, and the projection copies them beside the value so a
reader cannot lose the limitation on the way.

**It is append-only evidence.** It changes no retry decision, no timeout, no
request body, no credential and no economic authority, and it never turns a
transport failure into a success. It introduces no table: it is one event, in
the existing event log, Run-scoped for the two Run-executed roles and
Ticket-scoped for the planner, which dispatches against a planning attempt and
has no Run. Its payload carries bounded non-secret identity only — role,
transport owner, endpoint, method, byte count, evidence key, reservation id and
model-request ordinal — and the builder **refuses** an input carrying
`Authorization`, an API key, a credential hash/prefix/length, headers or the
request body rather than dropping it silently.

An evidence-write failure is reported as a failure, never swallowed, and is
classified `possiblyDispatched` — which is the truth, because by then the bytes
had already been handed to the platform.

### The observation was a control point, and is not any more

The seam shipped with a defect that contradicted its own purpose. It was invoked
with the request already in flight, and on a failed evidence write it **threw**:

```
external transport invoked
  → observation database write fails
    → provider result never consumed
      → Run failed, reservation settled at the authorized maximum
```

That is a control point wearing an observer's name. Traced from source, an
observation write failure altered all five things it must not:

| | before |
|---|---|
| provider response awaited/consumed | never — the throw skipped `await pending` / `return await settled` |
| error returned to the Run | the evidence error, or `transport_refused` |
| retry/recovery classification | `possiblyDispatched` → settle rather than release |
| economic settlement | `authorized_maximum_assumed` instead of usage-derived |
| terminal Run outcome | a successful model interaction became a failed Run |

**The correction is structural, not a caught exception at each call site.**
`observeProviderTransportInvocation` now cannot throw — not for a missing
observer, not for a malformed payload, not for a failed write. It returns a
closed result (`recorded` / `no_observer` / `payload_refused` / `not_persisted`)
which every transport owner discards. There is no value it can return that a
caller branches on.

**Why that is still honest.** The frozen rule already says absence means
UNKNOWN, because a crash between the platform call and the commit loses the
fact. A failed write lands in exactly the same epistemic place: transport may
have been invoked, the record cannot prove it, the projection says UNKNOWN.
Nothing is claimed that is not known, and — this is the point — no product
outcome is invented to preserve the appearance of completeness.

The failure is still noticed, through `appendSystemLog` under
`provider:transport_observation_unrecorded`. That channel is the ordinary
operational log, not run evidence and not the observation itself, so noticing a
failed evidence write cannot recurse into writing more evidence. It is invoked
at most once, never awaited on the provider path, and its own failure is
swallowed.

**Proved by equivalence, not by inspection.** The same request runs twice — once
with a working writer, once with one that throws — and the results must be
identical. At the unit level for the governed owner (byte-identical transport
result and dispatch outcome, one platform invocation either way), and at the
real pipeline for both transports: the ungoverned trial still consumes and
persists the same response body, parses identically, commits the same single
receipt and completes; the governed arm still admits its plan, creates the same
three leaf Runs, makes the same four outbound requests and leaves identical
reservation states. Only the observation itself is missing, and the artifact
projects transport UNKNOWN — never NOT_INVOKED, a state the projection cannot
produce at all.

The readiness fact now requires **both** halves and blocks if either is removed.

### Durable observation inventory — final form

| # | fact | state | canonical authority |
|---|---|---|---|
| 1 | dispatch authorized | KNOWN | `provider.request.persisted`, `ticket.economic_request_started` |
| 2 | provider request persisted | KNOWN | `provider.request.persisted` + `providerRequests` replay |
| 3 | **external transport invocation** | **KNOWN (new)** | `provider.transport_invoked` |
| 4 | provider request id | KNOWN when a response arrived | `provider.response.persisted` `requestId` |
| 5–6 | provider response received / persisted | KNOWN | `provider.response.persisted` |
| 7 | extraction succeeded | **KNOWN — already canonical** | `provider.response.persisted` `outcome`; failure code `OPENAI_NO_OUTPUT` |
| 8–9 | parser accepted / refused + code | KNOWN | `model.plan.parsed`; `run.execution_completed` `failure.code = MODEL_MALFORMED_JSON` |
| 10 | per-response action-limit refusal | **KNOWN — stable code identified** | `action.suppressed` / `action.truncated`, `payload.reason = mutating_action_limit`, with `limit` and `mutatingCount` |
| 11–12 | workspace action accepted / refused + code | KNOWN | `workspace.operation`; `operation_receipts.receipt.error.code`; `authority.denied` `payload.rule` |
| 13 | operation receipt persisted | KNOWN | `operation_receipts` |
| 14 | response delivered into execution | KNOWN | `run.execution_completed` |
| 15 | terminal Run result | KNOWN | `run.terminalized` |

**Item 7 needed no new event.** Production already refuses an empty extraction
with its own stable code (`OPENAI_NO_OUTPUT`, phase `model_output`) *before* a
successful response can be persisted. A persisted successful response therefore
**is** proof that extraction succeeded, and a persisted failure under that code
**is** proof that it failed. Nothing is inferred from a later terminal state, and
parser acceptance is deliberately not used as a proxy: a response can extract
cleanly and still fail to parse, and those are different findings.

**Item 10 needed no new event either.** The canonical durable owner is the
worker execution loop's `action.suppressed` event (or `action.truncated` when
prefix truncation is enabled), whose `payload.reason` is the stable code. The
four-`createFolder` case lands there with `mutatingCount: 4` against `limit: 2`.

### The live artifact projection

`projectLiveDurableObservation` derives one `durableObservation` block per trial
from durable events and records only. It is a **projection, not a second
authority**: every field names the durable owner it read, the object is frozen,
and it decides nothing.

`UNKNOWN` is a value. The four prohibitions are asserted individually and travel
with the data as `nonImplications`:

- `workerRequestCount = 0` — a *governed reservation* count — does not imply
  transport was not invoked; the ungoverned arms hold zero reservations and still
  call providers;
- no `provider.response.persisted` does not imply transport was not invoked;
- `operationReceiptCount = 0` does not imply no provider was called;
- a failed Run does not imply the model response was malformed.

### The ungoverned pipeline against the envelope the provider actually returns

Every acceptance proof before this session answered the ungoverned worker with a
top-level `output_text` on a hand-written `Response` clone. The real Responses
API returns neither — it returns `output[].content[]` with type `output_text`, on
a platform `Response` whose headers production iterates with `headers.entries()`
— so a fixture defect was once reported as a production runtime defect.

Both are now proved from production's own durable record, on the **real
uncaptured live branch** with only the final hop replaced:

| proof | result |
|---|---|
| A — one action | real envelope consumed, parser accepted, 1 mutation within the cap of 2, workspace operation reached, **one durable `createFolder` receipt**, child absent before and present after, Run truthfully `completed` |
| A — four actions | parser **accepted** the response (structurally valid), per-response mutating authority **refused** it under `reason = mutating_action_limit`, `limit 2` vs `mutatingCount 4`, **zero** operations, no transport/extraction/parser/harness failure code — product/model data |
| A2a | its own per-agent Runs, real envelope, 2 receipts, both `completed` |
| A2b | its own per-agent Runs, real envelope, 2 receipts, both `completed` |
| B / C | three-role dispatch re-proved on the corrected `Response`/`Headers` and the real envelope: ungoverned worker 1, structured planner 1, governed leaf 3 |

A2a and A2b are executed independently. Neither is inferred from A, because they
are a different production path (legacy v1 group allocation) and arm A cannot
stand in for either.

**No product or runtime relaxation was made.** The four-mutation refusal is
correct behaviour of the per-response action authority; the one-action success
was always available and had been masked by the fixture.

### The aborted run is mechanically unscorable

A run abandoned partway through is not a small corpus. Which slots it holds was
decided by *when* the abort happened, so scoring them would report the first N
trials as though they were the experiment — and this run's provider responses
were not retained, so nothing in it can be re-examined either.

The run

```
b2b59ad2b9d9fafc8ac860838b0530cb8f90bc02907b36a3a230b560bece2eef
```

is listed **by identity**, not only by label, in `evaluation-aborted-runs`. A
header hash *is* the run, so a rewritten header cannot launder it back in. The
refusal is enforced at all three doors into a decision — the live corpus gate,
the scorer (by header **and** by imported artifact), and the final
evidence-combination contract — because a rule enforced at one of three doors is
a rule that can be walked around. It is **refused**, not downgraded to NOT YET
DECIDABLE: there is no amount of an aborted run that becomes evidence.

Its artifacts are not modified. Preserving an aborted run's evidence and
refusing to score it are the same discipline, not opposite ones.

### Accounting and abort record

| item | value |
|---|---|
| PRE-FLIGHT ACTUAL | **9 micro-USD** |
| DIAGNOSTICS ACTUAL | **890 micro-USD** |
| TOTAL PRE-FLIGHT + DIAGNOSTICS | **899 micro-USD** |
| ABORTED MATRIX ACTUAL PROVIDER COST | **UNKNOWN** |
| KNOWN GOVERNED DURABLE SETTLEMENT LOWER BOUND | **20,046 micro-USD** |
| ABORTED MATRIX NORMALIZED COST | **213,752 micro-USD** — *not actual spend* |
| ABORTED MATRIX COMMITTED MAXIMUM LIABILITY | **4,412,664 micro-USD** — *not actual spend* |

The normalized cost and the committed maximum liability are **not** measurements
of money spent. The normalized figure is a pricing model applied to a request
list; the committed figure is the ceiling that was reserved before dispatch.
Neither becomes an actual-spend number by being written down next to one.

Historical facts about the aborted run, stated exactly:

- 120 slots assigned;
- 31 accepted before the deliberate abort;
- 67 known governed provider requests;
- historical **ungoverned** transport attempts **NOT ESTABLISHED**;
- historical ungoverned provider responses **NOT RETAINED**;
- the exact cause of the abort **NOT ESTABLISHED**;
- **no product conclusion is drawn** from any of it.

`provider.transport_invoked` is **not** retroactively populated for that run.
The seam did not exist when it executed, and writing the fact now would be
manufacturing evidence rather than recording it. Its transport history stays
UNKNOWN, permanently and by design.

### Verification actually run, and what was not

Stated exactly, because a verdict is only as good as the runs behind it.

**Ran and passed.** The full 120-slot frozen matrix against the exact committed
source — 120 assigned, 120 accounted for, restart at the predeclared ordinal 60,
60 slots reused and never re-executed, 0 duplicates, 0 replacements, committed
liability 18,140,952 micro-USD reconstructed equal to the canonical matrix
maximum, corpus integrity COMPLETE AND INTERNALLY CONSISTENT, the scorer
refusing it as synthetic, and **0 external provider calls**. All 120 written
artifacts carry the durable-observation projection; all 120 record that
production crossed into external transport; 60 hold ZERO economic reservations
while transport was invoked, which is what makes the prohibited inference
demonstrably unavailable rather than merely forbidden in prose.

Also: 20 focused mutations, each dying at its own owner; the repository mutation
suite at its own authoritative count, **54/54 killed, 0 survived**; and every
readiness audit green with the six new facts individually falsifiable.

**Did NOT pass: a complete release checkpoint.** Two runs, both recorded:

1. The first run refused the scorer for importing a second module. That was a
   real contract violation and it was right to fail — see the allow-list change
   above. It is why "passed on the first properly configured run" is **false**
   for this session.
2. The second run, against the exact final source, reached the native suites and
   failed there because **this machine has no Rust toolchain**. `cargo` and
   `rustc` are absent, so `process-launcher-foundation-native-test`,
   `process-materializer-native-test` and `third-party-notices-test` (which
   shells out to `cargo metadata`) cannot execute here at all. That gap predates
   this work — the same suites were already registered at `c1eaee1e` — and none
   of the three files is touched by it.

Every other checkpoint-registered suite was then executed individually against
the final source: **213 ran, 212 passed, 1 failed, 2 skipped**, where the single
failure and both skips are exactly the three Rust-dependent entries.

**So the checkpoint criterion is NOT met**, and no amount of the surrounding
evidence substitutes for it. A complete checkpoint must be run on a machine with
the Rust toolchain installed before this work can be called release-verified.

### Readiness now has six more facts

`realProviderEnvelopeShapeProved`, `ungovernedOneActionResponsePipelineProved`,
`ungovernedActionLimitProductRefusalProved`,
`providerTransportInvocationObservationProved`,
`liveFailureObservationProjectionProved` and
`abortedCorpusMechanicallyUnscorableProved`. Each reads its own evidence and
each independently turns the verdict BLOCKED when its own proof is removed —
proved negatively in `evaluation-live-readiness-test`, including that removing
one blocks **only** that fact. Neither `liveFullCaptured120SlotExecutionProved`
nor the three-role dispatch facts can substitute for any of them.

## 13. Status

**Tranche 6: IN PROGRESS — harness built and executing; evaluation NOT run.**

All five arms now execute end to end through real servers on family-1, including
governed structured leaf execution for B and C. **No scored or live evaluation
has been run.** No comparison, no aggregate, no ranking, no verdict, and no
RETAIN / REVISE / STOP.

**Prerequisite 3 (hermetic scenario fixtures) is CLOSED.** All
forty protocol-required family-3/4/7/8/9 cells execute through real governed
worker requests with complete observation, immutable unscored artifacts and
zero-drift reporting. Families 1 and 9 remain executed. No cell is excluded for
want of observation or staging.

The scored matrix remains **NOT RUN**, so Tranche 6 stays IN PROGRESS.

Production behaviour DID change in sessions 8 and 9 — the progress-policy
capture, the failure classification, and the role-keyed economic policy set.
Each is covered by its own decision record and its own suites.

### Exact remaining execution blockers

1. **scenario fixture definitions** for families 3, 4, 7, 8 and 9 are not
   authored as data (the *mechanism* to run them exists; the staged responses and
   expectations do not);
2. repetition, ordering and comparability across families are specified but
   unexercised beyond family-1;
3. consequently **only an unscored family-1 smoke has been performed**, and
   nothing more is claimed.

Family 4 is no longer among these: its missing observation is closed (§4a).

The five arm configurations are fully specified and their routing is proved in
both directions against the real dispatch conditions, and the production seam
they must drive is identified — the form POST to `/tickets` accepting
`objective`, `assignmentTargetType`, `assignmentTargetId`, `assignmentMode`,
`declaredWork` and `ownedOutputPaths`, which is the single route through which
all five paths are reachable without bypassing any branch condition.

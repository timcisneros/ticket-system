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

## 13. Status

**Tranche 6: IN PROGRESS — harness built, evaluation NOT run.**

Five of six prerequisites are CLOSED with repository proof. **Prerequisite 3
(hermetic scenario fixtures) is OPEN, and the evaluation may not run until it
closes.** The trial runner and the scenario fixtures it would drive are not
built; consequently **no smoke run was performed**, no comparison has been run,
no verdict exists, and no RETAIN / REVISE / STOP has been issued.

No production behaviour changed in either Tranche 6 session.

### Exact remaining execution blockers

1. **scenario fixture definitions** for families 3, 7, 8 and 9 are not authored
   as data (the *mechanism* to run them exists; the staged responses and
   expectations do not);
2. **the trial runner and its five arm adapters** are not built, so no arm has
   been driven end to end through a real server;
3. consequently **no unscored smoke run was performed**, and none is claimed.

Family 4 is no longer among these: its missing observation is closed (§4a).

The five arm configurations are fully specified and their routing is proved in
both directions against the real dispatch conditions, and the production seam
they must drive is identified — the form POST to `/tickets` accepting
`objective`, `assignmentTargetType`, `assignmentTargetId`, `assignmentMode`,
`declaredWork` and `ownedOutputPaths`, which is the single route through which
all five paths are reachable without bypassing any branch condition.

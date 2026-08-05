# Decision Log

## Tranche 5 closed — the verified-progress substrate was built (2026-08-05)

**Supersedes "Verified progress has no durable evidence substrate (2026-08-02)"**
below. That entry is retained unaltered as the dated record of why the work
stopped; this entry records what changed.

The 2026-08-02 decision named a prerequisite and declined to fake it: a durable,
append-only, database-ordered postcondition-result record. It was subsequently
built — `governed_postcondition_evidence` (migration 035), with 036's
evidence-batch boundary and 037's baseline. It carries a monotonic id and a
database timestamp and is bounded by the `postconditionEvidenceCutoff` dimension
of the same one-statement cutoff that already bounded receipts, reservations and
budget charges.

**Every objection in the superseded entry was honoured, not worked around.**
`replay_snapshots` was not promoted to authority; it remains presentation and
replay state. No second postcondition evaluator was written — the canonical
evaluator's verdict is what the evidence records, and
`prepareAndReserveNextGovernedRunRequest` derives the satisfied-fact mapping from
that evidence rather than accepting one from a caller. The stable-cutoff proof,
the database-time proof and the A3 closure that rests on both are intact.

**Three further truthfulness rules closed in the same tranche**, each of which
made a persisted reason mean what it says:

* **Missing evidence is not evidence of no progress.** A batch that committed
  receipts but recorded no verdicts is refused as `fact_evidence_incomplete`
  rather than counted as zero progress.
* **A durable response is not proof it reached execution.** Only an answer
  delivered to execution is churn-eligible, where delivery is observable, so a
  persistence or recovery interruption is no longer attributed to model churn.
* **Historical churn does not make a completed Run blocked**, and block authority
  comes only from a persisted canonical block — never from status, churn history
  or a re-derivation after the cutoff.

**A3 is unchanged by this entry.** It remains CLOSED FOR GOVERNED STRUCTURED LEAF
RESOURCE ACCOUNTING only. The repository-wide remainder is still open.

Tranche 5 is COMPLETE. Tranche 6 — Controlled Evaluation and Product Decision —
is NOT STARTED.


## Verified progress has no durable evidence substrate (2026-08-02)

**SUPERSEDED 2026-08-05** — see "Tranche 5 closed — the verified-progress
substrate was built" above. The prerequisite named here was built; this entry
is retained unaltered as the dated record of why the work stopped.

The Tranche 5 merge-readiness audit found that production never credits verified
progress, and that the gap cannot be closed inside Tranche 5.

**The classification was wrong the first time.** It was recorded as a
non-blocking documented boundary on the reasoning that the error direction is
conservative — the runtime stops spending earlier than the policy intends and
can never overspend. That reasoning does not survive contact with what the
system tells an operator. A Run that genuinely advanced declared work is stopped
and labelled `verified_progress_exhausted`, and that persisted reason is false.
Erring toward less spend does not make incorrect execution authority correct.

**Three of the four pieces exist.** A canonical deterministic evaluator
(`directPostconditionResult`), a canonical identity rule (the typed criterion's
`criterionHash`), and a canonical objective compiler (`buildObjectiveContract`)
that yields `folder_exists` and `path_absent` postconditions for recognized
objectives. The missing piece is the durable substrate.

**The substrate is the whole problem.** `run:postcondition_completed` claims go
to `replay_snapshots` — one mutable row per run, keyed `run_id PRIMARY KEY`,
carrying a JSONB document and a `revision` counter. Items are stamped with
`new Date()`, the process clock, and have no per-item monotonic identity. The
append-only events path is workflow-only and returns null for the `agent` Runs
that governed structured leaf execution uses. No migration defines a
postcondition table or column.

Tranche 5's evaluation discipline cannot be satisfied by that: no cutoff is
expressible without a monotonic id; ordering authority would revert to the
process clock, which the execution-epoch work deliberately removed; and a row
rewritten in place cannot support "later facts do not rewrite an existing
evaluation". Wiring it would break the stable-cutoff proof, the database-time
proof, and the A3 closure that depends on both.

**The alternative was worse.** Deriving satisfaction from `operation_receipts`
would mean writing a second postcondition evaluator alongside the completion
one. Two authorities answering "did this postcondition pass" is exactly the
failure mode this tranche exists to prevent, and the first time they disagreed
the disagreement would be silent.

**So the work stopped rather than proceeding.** Verified-progress credit is
recorded as unresolved, the Tranche 5 completion claim is withdrawn, and the
prerequisite is named: a durable, append-only, database-ordered
postcondition-result record owned by the typed-evidence work. Churn termination,
coordination, duration bounding and stop persistence remain implemented and
proved; they do not depend on the missing piece. A3's persistence closure is
scoped separately and is unaffected.


## Tranche 5 — Coordination and Verified-Progress Controls (2026-08-02)

**Activity is not progress, and four levels are not one number.** A run that is
busy is not a run that is advancing, and conflating the two is what let churn
look like work. The projection keeps `activity`, `candidate_progress`,
`verified_progress` and `completion` apart at every level, and only the third
extends tolerance. A successful operation that advances no declared work fact is
candidate progress at best. Model prose claiming progress is not represented at
all — there is no field it could occupy.

**Verified progress is not completion.** Completion authority stays with the
Tranche 3 completion decision and aggregate plan decision. Tranche 5 reports a
pointer to that authority rather than a verdict of its own, because a surface
that could read verified progress as completion would eventually ship unverified
work as done.

**Two answers only: `continue` and `blocked`.** There is deliberately no
`retry`, `reroute`, `replan` or `remediate`. A runtime that automatically
repairs churn is a runtime that spends more money on a situation it has just
proven it does not understand. `blocked` was chosen over `interrupted` because
ordinary recovery resumes interrupted Runs automatically, which would re-enter
the loop that produced the stop.

**Every input is a durable row.** No process-local counter takes part, because a
counter that resets on recovery is a counter a model can evade by crashing —
exactly the defect pending decision A3 records. Windows are half-open intervals
over durable reservations and receipts, bounded by a cutoff captured in ONE
statement, because `withTransaction` runs at READ COMMITTED and receipts are
written on an independent connection.

**Duration begins at first actual execution.** Neither obvious candidate was
correct. `runs.started_at` is reset to NULL by `recoverExpiredRun`, so it
measures the latest attempt and would grant a recovering Run N budgets.
`governedExecution.capturedAt` is admission time, and since Runs are created
`pending`, it would charge scheduler queue time as execution. The earliest
append-only `run.lease_acquired` event is first execution start: absent while
queued, set exactly once, and unrewritable by recovery or retry preparation.

**Verified progress does not reset cumulative duration.** Tolerance for churn is
something progress can legitimately earn back. Total execution time is
consumption, and nothing buys it back. A duration stop carries its own closed
reason, `cumulative_execution_duration_exhausted`, evaluated ahead of every
churn signal — reporting it as `repeated_no_op` would name a pattern instead of
the bound that actually stopped the Run, inviting someone to fix the loop and
retry into the same wall.

**The evaluation instant comes from the database clock.** The process clock is
unshared, unverifiable and resettable, so a duration bound derived from it could
be moved by restarting on a differently-skewed host. `clock_timestamp()` rather
than `now()`, since `now()` is transaction start time and would understate
elapsed time for two evaluations in one transaction.

**Incomplete sibling reads block rather than wait.** Structured siblings are
authority-wise independent — no dependency graph, no ordering, no waiting. But
independence cuts both ways: a leaf Run reading another item's owned output is
consuming work whose truthfulness nobody has established. The read is refused
and the Run stops. Waiting would be a dependency by another name. A completed
sibling becomes readable only through canonical Tranche 3 authority: a
reconciled disposition of `completed` carrying a valid completion decision hash.
Terminal Run status is not completion.

**A blocked Run is the decision of record.** Re-evaluating one would capture a
later evaluation instant, produce a different projection hash, and conflict with
the block already stored — so a blocked Run is read, never re-derived. Tamper
detection is unaffected: the block contract recomputes and verifies its own hash
on every read.

**A3 is closed for governed structured leaf execution only.** Requests,
operations, economic consumption, no-progress history, cumulative execution
duration and persisted stop authority all survive recovery on that path. The
repository-wide remainder stays open for the execution families deliberately
left unmodified, which still use attempt-local counters and per-loop-entry
duration.


## Planner Response Bound and Admission Binding (2026-07-31)

Merge-readiness audit of Tranche 2B corrected three findings before merge.

**The response bound was post-buffer only.** Both adapters buffered the entire body
before any check — Ollama accumulated unbounded chunks then `Buffer.concat`, OpenAI
did `await response.text()` — and the check counted UTF-16 code units on the
extracted model text, not bytes on the wire. A post-buffer length check is not an
operational bound. Both adapters now accept an optional `maxResponseBytes`: reading
stops at the first chunk crossing the limit, the request is destroyed, and a
canonical `PROVIDER_RESPONSE_TOO_LARGE` refusal carrying no body is raised. Absent
the option, every pre-existing caller behaves exactly as before, so this is a new
optional boundary rather than a provider-architecture rewrite.

**Truncated response evidence was a recovery gap.** Accepting 262,144 characters
while storing 65,536 produced a durable `response_received` whose text was an
excerpt. Response persistence and proposal persistence are separate transactions and
the proposal is persisted only as a hash, so a crash between them left a record that
could not be continued without re-asking the provider — which no rule authorizes.
`MAX_PLANNER_RESPONSE_BYTES = 65,536` now governs both acceptance and storage,
enforced in bytes at transport receipt. A `response_received`, `proposal_validated`
or `plan_admitted` attempt must carry the complete text with `responseTruncated:
false`, byte count matching the stored text, and a hash over exactly those bytes;
all three are re-checked on every read. Truncation is no longer representable. The
window is removed rather than narrowed.

**Admission binding was implicit.** `planHash` sat inside `provenanceHash`'s
preimage, so a transplant was already detectable, but there was no third
independently validated value. Provenance now carries `admissionHash =
hash({planHash, provenanceHash})`, checkable on its own without rebuilding the
provenance record, re-derived from the persisted row inside the admission
transaction, and required — so partial provenance or a partial binding cannot be
represented. Historical Tranche 1 v2 plans omit provenance and binding entirely and
gain neither; neither value enters or changes any `planHash`.

A live provider-path suite was added. It reaches a local HTTP stub through the
existing configured-agent `baseUrl` seam, so the server issues a genuine request
through `callOllama` and `providerHttpJsonRequest` with nothing stubbed inside
production. The planner timeout gained an environment override that may only shorten
the contract bound, never extend it.

The A27 simulation-endpoint timeout finding was deliberately not fixed here: the
simulation call passes no `maxResponseBytes`, its behavior is unchanged, and it
remains an open documentation-only entry.

## Planner Lowering and Plan Admission (2026-07-31)

Tranche 2B admits Allocation Plan v2 from planner output. The integration boundary is
`createRunsForTicketAdmitted()`, before every branch that creates runs, because all six
run-creation entrypoints funnel through that one function. A Ticket holding structured
planning authority — an eligible admission WITH a captured planning-authority snapshot —
either plans through Tranche 2B or is blocked with a canonical reason, and never falls back
to v1 allocation. Admission-INELIGIBLE structured tickets deliberately keep the v1 path,
because Tranche 2A guarantees the live v1 path remains operational and a ticket that never
earned a planning principal has no structured planning authority to protect.

The entry rule is stored eligibility AND a present planning-authority snapshot AND a true
current-applicability projection. Immediately before the provider call, invocation readiness
is re-derived from live catalog facts and fails closed on a missing planner, lost designation,
lost membership, provider drift, model drift, unavailable credentials, missing or unauthorized
candidates, and assignment/mode/owned-path drift. Model drift compares the configured agent's
own recorded model, not a resolved provider config, because provider config falls back to
`OPENAI_MODEL`/`OLLAMA_MODEL` and that fallback would otherwise mask a substituted model.
Live catalog state can make captured authority unusable; it never rewrites it, and no
replacement planner, provider, model, candidate, or owned path is ever selected.

No migration. The planning attempt is a closed, versioned, hash-bound field of the Ticket JSONB
body plus one append-only Ticket event per stage, because Ticket already provides row locking,
revision-checked patching, and transactional event append. It is not a new top-level product
entity. Its lifecycle is closed, terminal failures always name the exact stage, and it has
exactly two writers; generic ticket patches reaching the field are refused like the authority
guard beside it.

Exactly one provider request per attempt through the existing run-free `callModelProvider`
seam — run-bound evidence wrappers require a `runId` and are correctly unusable here. Fixed
120s timeout, 262,144-character response ceiling, 65,536 characters of stored evidence hashed
over the complete response, and no tools, workspace, browser, process, workflow, handoff,
recursion, provider fallback, model fallback, repair request, or automatic retry. The size
bound is enforced on receipt rather than on the socket: the shared adapters buffer a complete
response, and a streaming cap would change behavior for every production run. Request evidence
is durable before the wire, so a stopped process resolves to interrupted/outcome-unknown and
the call is never repeated automatically.

The model proposes decomposition content only; the runtime owns every identity, owned path,
provenance label, criterion hash, evidence identity, and authority hash. Evidence requirements
must be proposed empty and are bound one-to-one from typed criteria, because the declared-work
contract already makes that binding total and deterministic. Exactly one JSON document is
accepted and no repair request is ever issued. A runtime-owned authority field appearing
anywhere in the proposal is refused distinctly rather than dropped, so an attempt to author
authority leaves evidence. Cardinality mirrors current v1 production: every captured candidate
exactly once. The legacy placeholder is refused by narrow whitespace-collapsed identity with
the ticket number as the only variable — no claim of general semantic understanding is made,
and the check must not be widened into one.

Planning provenance is stored beside the v2 authority, not inside `planHash`. `AUTHORITY_FIELDS`
is a closed REQUIRED list, so hash-including provenance would make every Tranche 1 v2 plan fail
validation on read and would change the meaning of every stored `planHash`. Provenance instead
occupies an ALLOWED-but-not-REQUIRED slot in the stored body, carries its own canonical hash,
embeds the `planHash` it describes so it cannot be transplanted, is validated on every read, and
is carried forward unchanged by item-status writes.

Admission is one transaction ending at the append of its event. It creates no worker Runs and
refuses outright if any Run already exists for the ticket, so the stopping boundary is enforced
rather than asserted. Success means exactly one pending v2 plan, a `plan_admitted` attempt, zero
worker Runs, and nothing scheduler-visible — the scheduler selects only pending Runs, so an
admitted plan is structurally invisible to it. Failure means a blocked Ticket with no plan and no
Runs, carrying the exact stage and canonical reason, with no v1 fallback and no hidden retry.
Execution of an admitted plan is Tranche 3 leaf-run admission, which runs as a separate
transaction immediately after admission commits; plan admission itself still creates zero worker
Runs, and the API, page, and CLI report that split explicitly.

## Structured Allocation Leaf-Run Admission and Aggregate Completion (2026-07-31)

An admitted, pending Allocation Plan v2 becomes execution through exactly one atomic leaf
admission: one initial Run per immutable allocation item, or none. Each Run carries an immutable
leaf binding — Ticket, plan id and hash, allocation item, assigned agent, item declared-work
hash, exact admitted owned paths, parent declared-work hash, planning-attempt id, admission hash,
runtime-assigned Run id, and its own canonical binding hash. The runtime derives the binding; no
model creates or modifies it, and it cannot be transplanted or rebuilt from current group, agent,
or route configuration. Run identities are reserved from the runs sequence inside the admission
transaction so the binding is complete at INSERT rather than patched in afterwards.

A leaf Run declares the ITEM, not the parent Ticket: objective, expected outputs and success
criteria come from the immutable item, the plan's shared constraints are carried unchanged, the
Run's own completion authority contributes its deterministic typed criteria through the canonical
declared-work builder, and the generic v1 `allocationSubtask` never appears. The assigned agent is
the worker principal, dispatched through the existing worker route; an unavailable or
unauthorized agent refuses the whole admission rather than selecting a replacement.

A v2 item that declares a `typed-postcondition` criterion has no admitted completion authority:
`assertDeclaredWorkCompletionAuthorityBinding` admits only `workflow-defined` and
`deterministic-objective-contract` typed criteria and additionally requires declared and admitted
criteria to be the same set in both directions, which no per-item subset of parent authority can
satisfy. Leaf admission therefore refuses the entire admission with
`leaf_item_typed_criteria_unsupported`, before any Run identity is reserved. The provenance is not
promoted, the criterion is not dropped or converted to text, no model is asked to validate it, and
text-only siblings are not admitted partially. The admitted plan is preserved.

For planner-admitted v2 plans the durable item status is derived inside the PostgreSQL
transaction from the immutable item-to-Run binding, the persisted Run lifecycle, the durable
completion decision, and declared-work/completion-authority hash agreement. A caller may request
reconciliation but may not supply or force the resulting status;
`updateAllocationItemStatus()` refuses such a write with `ALLOCATION_ITEM_STATUS_NOT_CALLER_OWNED`.
A terminal `completed` Run whose completion decision is absent, stale, conflicting, or
unsuccessful never makes the item completed — it resolves to `interrupted` or `failed` with a
closed reason. Historical v1 behavior, and v2 plans with no planner provenance, are unchanged.

One deterministic aggregate decision is built from the item bindings and completion decisions and
stored beside the plan authority, outside `planHash`, on the same terms as planning provenance.
The plan completes only when every item holds a valid completed decision with its supporting
decision hash. "All Runs terminal", agent prose, `complete: true`, file existence, and the absence
of running Runs are all explicitly insufficient. Any failed item prevents completion; interrupted
or evidence-incomplete items stay unresolved. Repeated reconciliation over unchanged facts writes
nothing and bumps no revision.

The parent Ticket outcome is NOT restated here. `transitionTicketAfterRun()` already projects
every Run in the batch through its durable completion decision and owns the
completed/failed/blocked/interrupted mapping including the owned-scope "every sibling completed"
rule; the leaf contract deliberately exports no second parent-completion authority.

### Correction (2026-07-31, merge-readiness audit)

Owning the mapping is not the same as consuming the proof, and the first implementation only did
the former. `transitionTicketAfterRun()` never read the plan, the leaf bindings or the aggregate
decision: it derived the parent status from `run_consequences` alone, using a rule strictly weaker
than the leaf derivation, which additionally proves item-to-Run binding, declared-work agreement,
completion-authority agreement and run-lifecycle agreement. The two could therefore disagree, with
the weaker one owning the Ticket. A completion decision that reports `completed` for the right Run
and Ticket but was evaluated against different completion authority completed the parent while the
aggregate refused — reproduced, and now covered by a regression test that fails when the gate is
removed.

Two call sites also transitioned the parent BEFORE deriving item state: operator terminal repair,
and startup reconciliation of an unfinalized ticket, which reconciled no items at all. A crash in
that window left a completed parent with no aggregate decision.

The fix keeps exactly one parent-status mapping and makes it consume the proof. For a
planner-admitted v2 plan, `transitionTicketAfterRun()` now runs the same store-owned leaf
derivation inside its own transaction, persists item statuses and the aggregate decision, and
requires the persisted aggregate to authorize the outcome the canonical mapping proposed.

Gating only `completed` was not enough, and left the failure paths as parallel authorities. An
aggregate reporting `interrupted` — because a decision was absent, stale, conflicting, or evaluated
against other completion authority — could sit beside a batch projection that independently reached
`blocked` or `failed`, and the parent terminalized on the weaker evidence. EVERY terminal parent
outcome is therefore gated:

| aggregateStatus                    | permitted parent outcome                          |
|------------------------------------|---------------------------------------------------|
| `completed`                        | `completed`                                       |
| `failed`                           | whichever of `blocked` or `failed` the canonical mapping chose |
| `pending` / `running` / `interrupted` | none — no terminal transition                  |
| absent or not yet persisted        | none — no terminal transition                     |
| malformed or hash-conflicting      | none — the transaction aborts on read             |

The aggregate decides only WHETHER a terminal outcome is provable. It never chooses between
`blocked` and `failed`: that distinction stays entirely with the existing canonical Run/consequence
logic and is used verbatim. `open` is deliberately outside the gate — returning an interrupted
owned-scope ticket to `open` is recovery, not terminalization, and must remain reachable without a
completion proof. Because the derivation and
the transition now share one transaction, no caller can order them wrongly, no crash can leave a
completed parent without its aggregate, and the parent event names the plan and the exact
`aggregateDecisionHash` that authorized it. Lock order is `allocation_plans → runs → tickets`
everywhere a leaf plan is involved.

Reconciliation also appends `ticket.allocation_leaf_items_reconciled` in the same transaction as
the write it describes, carrying the aggregate hash and every changed item disposition, so the
write is journalled and an event can never claim a reconciliation that rolled back.

Run identity is no longer caller data. The first implementation admitted `record.id` on the public
`createRun()`, and `createRunsAndStartTicket()` forwarded drafts verbatim, so any caller could
select an identity — a comment saying the caller had reserved it is not enforcement. `createRun()`
now REFUSES a record carrying `id` (`RUN_IDENTITY_NOT_CALLER_OWNED`), and reserved identities
arrive only through the options argument and only from a caller already composing inside the
reserving transaction.

Leaf admission additionally re-derives structured applicability and assignment from the LOCKED
ticket, matching what plan admission already did, so a reassignment committed between preflight and
commit cannot admit worker Runs against authority the ticket no longer holds.

Finally, `leafExecutionAvailable` was a single boolean answering four different questions and
hardcoded `true` on a ticket-scoped projection, so it claimed availability for tickets whose
admission would refuse. It is replaced by `leafExecutionCapabilityAvailable` (product capability,
planning-scoped) plus closed per-ticket fields on the leaf projection: `plannerAdmittedPlan`,
`admissionState` (`none`/`not_admitted`/`admitted`/`settled`), `admissionBlockedReason` from the
closed refusal vocabulary, and `schedulerVisibleRunIds`. There is deliberately no positive
`ready: true`: agent, group and worker-route readiness are live catalog facts proven only inside
the admission transaction, so a null blocker means "no known blocker", never a promise.

Retry boundary, fail-closed: Tranche 3 admits exactly one initial Run per item and never replans,
never creates a v1 plan, and never duplicates an initial binding. Automatic retry already refuses
owned-scope tickets, so no leaf retry lineage arises; the aggregate decision represents lineage so
a future retry that preserves the same allocation-item authority remains expressible without a
schema change. A partially persisted leaf set is reported as an integrity defect, never completed
from mutable configuration.

No migration. Leaf bindings live in the existing run JSONB body and the aggregate decision in the
existing allocation-plan body. Workflow-mode leaf admission is refused with
`leaf_execution_mode_unsupported` rather than synthesizing workflow typed criteria per item.

## Parent Work Authority and Planning Principal (2026-07-30)

Split the former planner-lowering tranche into prerequisite Tranche 2A and planner-admission
Tranche 2B. Owned output paths are capability boundaries and cannot be treated as expected
outputs. Objective grammar, acceptance prose, agent ordering, group membership, workspace
contents, or planner output likewise cannot synthesize missing parent work authority. New tickets
may therefore admit an explicit closed ticket-authored declared-work input through the canonical
`runtime/declared-work-contract.js` vocabulary, ordering, evidence consistency, hash, and deep
immutability. Historical tickets without that admission-time snapshot remain historical-unavailable;
reread, rerun, reopen, reassignment, or live configuration changes never synthesize or rewrite it.

The Ticket `objective` remains the single canonical objective: parent declared work must match its
canonical whitespace-normalized text exactly, ticket admission stores that canonical text, and a
Ticket carrying structured authority cannot later change it. Pure construction, transactional
admission, and restart reconstruction all fail closed on a competing or tampered objective; source
provenance is not treated as semantic-equivalence proof.

A ticket-capable agent group may designate exactly one nullable `plannerAgentId`. The selected
configured agent must be a current member; deletion or membership removal fails closed until the
group selects another member or clears the designation. There is no first-member, lowest-ID,
provider/model, random, or other fallback. Migration 032 adds the nullable configured-agent foreign
key and a deferred group-membership integrity constraint; provider and model remain configured-agent
facts rather than group or role-routing authority.

When explicit parent work is supplied, ticket admission deterministically evaluates structured
allocation eligibility. Sufficient authority is snapshotted inside the existing ticket/event
transaction: ticket identity, group identity/name/revision, planner identity/name/revision and exact
provider/model, candidate member identities/revisions and canonical owned paths, allocation mode,
parent declared-work hash, capture time, and canonical snapshot/aggregate hashes. The snapshot
contains no credentials and grants no provider request, routing role, budget, workspace/browser/
process operation, Allocation Plan v2, leaf run, scheduling, or completion authority. Tranche 2A
continues the live historical v1 allocation path unchanged. Tranche 2B may consume only this stored
parent and planning-principal authority to request, validate, and atomically admit a v2 plan.

Admission eligibility is immutable historical evidence, not a perpetual planning grant. A separate
pure current-applicability projection compares the current Ticket assignment target type, captured
group identity, allocation mode, and canonical owned-path mapping against the immutable planning
snapshot. Reassignment or scope/mode drift preserves the snapshot and its hash but returns
`assignment_changed_since_capture`. Tranche 2B may enter planner lowering only when both admitted
eligibility and current applicability are true.

## Structured Allocation Plan Authority (2026-07-30)

Retain Ticket and Workflow as the product primitives and extend the existing Allocation Plan as
the sole owner of allocated work decomposition. Historical unversioned plans remain v1. Allocation
Plan v2 binds its existing plan/ticket/mode identities, the exact immutable parent
`declaredWorkSnapshot`, provenance-bearing shared constraints, explicit typed declared work and
owned paths for each existing Allocation Item identity, and a canonical authority hash. Mutable
plan/item status and storage timestamps remain outside that hash. The existing PostgreSQL
`allocation_plans.body` JSONB path stores both versions without a migration or bulk rewrite.

Tranche 1 defines and projects authority only. It does not call a planner, dispatch v2 items, alter
worker prompts, route models, schedule runs, charge budgets, evaluate completion, or broaden
workspace/browser/process authority. Roadmap and later decision boundaries:
`STRUCTURED_ALLOCATION_AND_MODEL_ECONOMICS_ROADMAP.md`.

The merge-readiness audit consolidated lexical workspace path normalization,
owned-path containment, and sibling overlap in `runtime/authority-paths.js`.
Historical v1 keeps its permissive path spelling and hidden-directory admission;
v2 keeps stricter canonical admission, with every difference recorded and
tested. Protected/sensitive paths remain execution policy rather than plan
authority. Declared-work normalization, evidence identity/consistency, hashing,
ordering, and deep freezing remain canonical declared-work responsibilities.
Only an absent plan version selects historical v1; malformed or partial versioned
documents fail closed.

## Mixed-Family Work Model (2026-07-29)

Keep Ticket and Workflow as the product primitives. Workspace, browser, and process remain
separate operation families; evidence aggregation does not authorize a generic cross-family
router. The current scenario evidence does not justify a distinct reusable Work Primitive or
playbook entity. Reuse pressure should first be evaluated through the existing versioned Workflow
authority. Full scenario matrix, unsupported-composition findings, option comparison, and future
decision triggers: `decision-memo-mixed-family-work-model.md`.

## Objective Interpretation Direction (2026-07-17)

The deterministic objective grammar is frozen at its current scope (existing recognizers to be
audited, not grandfathered); the model contract compiler continues under the rule **inference
may self-bind and escalate; only explicit claims, observed facts, and deterministic guards may
produce hard outcomes**. Model-sourced contracts are permanently advisory — corroboration or
human confirmation produces a new separately sourced record (`deterministic_corroboration` /
`human_confirmed`) rather than upgrading provenance in place. Completion always requires
verifier-evaluated postcondition evidence. Full rationale, source-authority table, and
benchmark gating: `decision-memo-objective-interpretation-direction.md`.

## Branching Workflow Generation

Branching and conditional workflow generation is a separate capability from flat workflow draft intent. Do not treat branching objectives as `createWorkflowDraftIntent` failures unless that capability envelope changes.

## Tranche 4 — Role-Aware Routing and Bounded Economics

**Two canonical roles, closed.** `structured_planner` and
`structured_leaf_executor`. Adding a third is a schema change, not configuration.

**Routing authorization is not target capture.** A policy authorizes a route
*reference*; capture resolves it to an immutable *artifact*. Both are recorded
separately because a reference can move and an artifact cannot.

**Routing is separate from economics.** An early draft had routing resolve model
capability. That made an unpriced route look unroutable rather than
unaffordable, so capability resolution was removed from routing entirely.

**Liability is bounded by the full context window.** Pricing the entire window
as maximum input needs no framing estimate, because all accepted input is
subject to the finite window. Integer micro-USD throughout; every division
rounds up.

**Zero prices are explicit.** A route is eligible at zero cost because its
catalog says zero, never because "local" is assumed free.

**Exactness is bytes, not hashes.** A hash proves equality only against bytes
someone still holds. Reservations retain the serialized request itself, so the
winning start returns the authorized bytes rather than trusting a caller to
re-supply them.

**Settlement reads only captured facts.** The reservation retains the complete
economic authority and the exact pricing entry. Re-pricing or deleting a catalog
can neither alter nor block settlement of a request already reserved against it.
Unproven usage settles at the reserved maximum, never zero.

**One logical identity for two ledgers.** The runtime budget's
`model-request:<slot>` is reused as the economic reservation's logical source.
Account locking proves economic serialization but not logical uniqueness;
without the shared identity, duplicate orchestration of one request became
requests 1 and 2.

**Active is not abandoned.** A started request is never re-dispatched, but it
may only be *settled* when the Run lease proves the executor is gone. Elapsed
time is never the proof. Liveness is the lease alone — requiring
`status = 'running'` would report a just-claimed executor as dead.

**Partial governed state fails closed.** It is never read as historical. A Run
admitted with authority running ungoverned is the outcome the cutover exists to
prevent, so damaged authority throws rather than selecting a path.

**Fallback is authorizable but unavailable.** Policy can express a fallback
route; the runtime refuses to select one because it has no canonical
preflight-evidence authority proving the primary route is unavailable. It
refuses rather than inventing availability evidence.

**Tranche 4 is a development cutover, not a compatibility layer.** Pre-cutover
structured execution data is disposable and removed through the canonical
development reset. Preserving it would have created a permanent runtime branch
whose only purpose was to run structured work with no economic authority
bounding it — which is precisely what the tranche exists to prevent. A leaf
binding and a governed envelope are inseparable; either without the other is an
integrity failure regardless of the record's age.

**Ollama cannot be governed.** A tag is a moving reference. Without digest
resolution and a context-window proof, liability is unboundable, so Ollama
structured planning was withdrawn rather than governed on assumptions. Ollama
remains fully supported on historical ungoverned paths.


**Two adjacent argument shapes cannot be told apart by discipline.** The private
server spawn helper took `env` as one key; the wrapper suites were handed took
`env` positionally. Writing the first shape into the second was accepted in
full, so a hermetic preload silently never loaded and every assertion resting on
it passed vacuously. The fix was not more care at call sites but one closed
contract, `startServer({ env, serverOptions })`, that refuses everything else
before a child process starts — and a preload that prints proof-of-life the
suite asserts on, because a guard that can fail silently protects nothing.

**A gate that never refuses looks exactly like a correct gate.** Removing the
governed request gate's `permitsGovernedRequest` check failed no test, because
every governed scenario made progress in every window. Proving that verified
progress AUTHORIZES the next request is not the same claim as proving its
absence WITHHOLDS one, and only a scenario that does real work advancing nothing
can test the second. Refusal paths need scenarios that reach them, not unit
coverage of the predicate.

**Running the full checkpoint is itself evidence.** Three required suites had
been failing for several commits of this tranche — a sandbox missing a new
dependency, stale persistence-integrity counts, and an un-bumped release schema
version that made the process-execution preflight refuse a correctly migrated
database. None was caught by focused runs, and one of them had been reported as
an unexplained pre-existing flake. A required suite that fails unnoticed is
indistinguishable from one that would have caught a real regression.

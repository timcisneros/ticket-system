# Structured Allocation and Model Economics Roadmap

## Source of truth

This document is the authoritative roadmap for correcting allocation churn above
the completed Work Definition and Typed Evidence architecture. It is a new
roadmap, not a continuation of an unfinished prior roadmap.

Ticket and Workflow remain the product primitives. The existing Allocation Plan
is the canonical owner of allocated work decomposition, and Allocation Item is
the item-level authority within that plan. This roadmap does not authorize a
Delegation Contract, Work Primitive entity, universal Target abstraction,
generic operation language, cross-family router, recursive delegation, or
second allocation persistence subsystem.

## Tranche 1 — Structured Allocation Plan Authority

### Capability claim

The existing allocation representation can persist and reconstruct a closed,
versioned v2 authority that binds one immutable parent declared-work snapshot,
shared constraints, and explicit typed work for every allocation item.

### Contract boundary

- Historical unversioned plans remain v1 and retain their stored meaning.
- V2 reuses declared-work objective, expected-output, success-criterion,
  evidence-requirement, and provenance vocabulary.
- V2 authority is canonical, SHA-256 bound, deeply immutable, and separate from
  mutable plan/item status and storage timestamps.
- Owned paths use the existing workspace-relative safety and sibling-overlap
  rules. Path-typed outputs must remain inside item ownership.
- Structured item capabilities may narrow parent authority but may not introduce
  an output kind, typed criterion, evidence type, operation family, or stronger
  provenance absent from the parent declaration.
- Shared constraints carry declared-work provenance and have no capability,
  routing, budget, provider, workspace, browser, process, dispatch, or
  completion grant fields.
- PostgreSQL persists v2 through the existing `allocation_plans.body` JSONB
  document. No schema migration or bulk v1 rewrite is involved.

This tranche adds no planner call, worker prompt change, v2 dispatch, scheduling
change, routing change, budget action, completion change, or execution grant.
The live allocation creator remains v1.

### Merge-readiness authority audit

Dependency-neutral lexical normalization, owned-path containment, and sibling
overlap now live in `runtime/authority-paths.js`. Historical v1 allocation,
runtime mutation checks, the workspace provider, and v2 validation consume
those shared rules.

Historical v1 spelling remains deliberately unchanged: it canonicalizes leading
slashes, backslashes, dot segments, and trailing slashes, and its directory
existence check permits hidden paths. The workspace provider still rejects
absolute paths, escaping traversal, and hidden execution paths by default. V2
is stricter at new-authority admission: it rejects leading slashes,
backslashes, any raw parent traversal, hidden/system segments, NUL, and the
workspace root, while canonicalizing safe dot/duplicate-slash spelling. Both
versions use the same trailing-slash ownership form, containment predicate, and
sibling-overlap predicate for canonical paths. These differences are explicit
and regression-tested so historical v1 meaning does not change.

Protected and sensitive path policy remains mutable execution authority and is
not part of v2 plan hashing. Provenance comparisons prove only closed source
precedence within admitted output, criterion, and evidence families; they do
not claim that natural-language text is semantically narrower. A present plan
`version` is authoritative: only numeric v2 is accepted, while only absence of
the field identifies historical v1.

## Tranche 2A — Parent Work Authority and Planning Principal

Define explicit immutable parent declared work before allocation planning and an
explicitly designated, immutable planning principal. This prerequisite split is
required because current direct and group tickets have no explicit expected-output
authority and current groups have no planner principal. Owned output paths are
capability boundaries rather than work declarations; objective or acceptance text,
group membership, agent ordering, workspace contents, and mutable provider/model
configuration cannot truthfully supply either missing authority by inference.

Tranche 2A adds ticket-authored parent declared-work snapshots, a group-designated
planner principal, an admission-time planning-authority snapshot, persistence and
read-only projections, and deterministic eligibility evaluation. Explicit parent input
uses the existing declared-work output, criterion, and evidence vocabulary with
server-assigned ticket-authored provenance; client provenance is not accepted. Owned
paths, objectives, acceptance prose, group members, agent names, workspace contents,
and planner output never stand in for an expected-output declaration.

The Ticket objective is superior and singular authority. The parent declared-work objective is
canonicalized from, and must exactly equal, that Ticket objective; it is not a second ticket-authored
objective or an undocumented semantic narrowing. Once structured authority is admitted, the Ticket
objective cannot be changed without creating new ticket authority. Admission and reconstruction
reject mismatch or stored tampering.

The group designation is nullable historical authority backed by a configured-agent
foreign key and current-membership integrity. It has no implicit fallback and is not a
role-aware routing system: the selected configured agent remains the owner of its
provider/model facts. Ticket admission stores those exact facts, group and agent
revisions, candidate identities and owned paths, the parent declared-work hash, capture
time, and canonical hashes. Eligibility and every refusal reason are admission-time
facts, never recomputed from mutable catalogs. No credentials enter the snapshot.

`structuredAllocationEligibility` records immutable admission-time facts. It is projected as
admission eligibility and is distinct from current applicability. Current applicability is derived
without mutating the snapshot and refuses with `assignment_changed_since_capture` when the Ticket's
current target type, group identity, allocation mode, or canonical owned paths differ from the
captured planning authority. A later planner/group/catalog change does not rewrite either snapshot.

Tranche 2A performs no provider request, proposal parsing, Allocation Plan v2 admission,
leaf-run admission, scheduler change, aggregate completion, role-aware routing,
economics, or recursive allocation. The existing live v1 allocation/run path remains
operational and unchanged when a ticket is created. Historical tickets without the new
field remain historical-unavailable and cannot gain authority from later planner,
membership, route, workflow, ticket-text, or workspace changes.

## Tranche 2B — Planner Lowering and Plan Admission

Perform one bounded planner request using the admitted parent work and planning
principal created by Tranche 2A. Parse the closed proposal, deterministically
validate it against Allocation Plan v2, materialize runtime identities, and admit
Allocation Plan v2 atomically with its durable planning provenance and failure
evidence. Tranche 2B stops before leaf-run admission and does not dispatch workers.
Its entry rule requires both immutable admission eligibility and a true current-applicability
projection; stored admission eligibility alone can never authorize planning after reassignment or
scope/mode drift.

### Admitted behavior

The integration boundary is `createRunsForTicketAdmitted()` in `server.js`, before
any branch that creates runs. Every path that can create runs — ticket creation,
rerun, reopen, status change to open, reassignment, and watcher proposal — funnels
through that function, so one gate contains all of them. A ticket holding
structured planning authority either plans through Tranche 2B or is blocked with a
canonical reason; it never falls back to v1 allocation.

Containment applies to tickets whose admission was eligible AND that captured a
planning-authority snapshot. Admission-ineligible structured tickets keep the v1
path unchanged, because Tranche 2A guarantees the live v1 allocation/run path
remains operational and a ticket that never earned a planning principal has no
structured planning authority to protect.

Immediately before the provider call, invocation readiness is re-evaluated against
live catalog facts and fails closed on a missing planner, lost planner
designation, lost membership, provider drift, model drift, unavailable
credentials, a missing or unauthorized candidate, and assignment, mode or
owned-path drift. Model drift is compared against the configured agent's own
recorded model rather than a resolved provider config, because
`getAgentOpenAIConfig`/`getAgentOllamaConfig` fall back to `OPENAI_MODEL`/
`OLLAMA_MODEL`. Live catalog state can make captured authority unusable; it never
rewrites it, and no replacement planner, provider, model, candidate or owned path
is ever selected.

The planning attempt is a closed, versioned, hash-bound record in the Ticket JSONB
body under `structuredAllocationPlanningAttempt`, with one append-only Ticket event
per stage. It is not a new top-level product entity: Ticket already provides row
locking, revision-checked patching and transactional event append. Its lifecycle is
`created → request_started → response_received → proposal_validated → plan_admitted`,
with terminal `failed` and `interrupted` states that always name the exact failed
stage. It has exactly two writers, both enforcing the closed lifecycle and an
optimistic attempt-state guard; a generic ticket patch reaching the field is refused.

Exactly one provider request per attempt, through the existing run-free
`callModelProvider` adapter seam: a fixed 120,000 ms timeout via a dedicated
`AbortController`, a single `MAX_PLANNER_RESPONSE_BYTES = 65,536` limit governing
both acceptance and storage, and no tools, workspace, browser, process, workflow,
handoff, recursion, provider fallback, model fallback, repair request or automatic
retry. The environment may shorten the timeout but never extend it.

The response bound is enforced **at transport receipt, in bytes**. Both adapters
accept an optional `maxResponseBytes`; when it is supplied, reading stops at the
first chunk crossing the limit, the request is destroyed, and a canonical
`PROVIDER_RESPONSE_TOO_LARGE` refusal is raised carrying no body. When the option is
absent — every pre-existing caller — behavior is exactly as before. An oversized
response is therefore never fully buffered, never parsed, and never persisted.

Automated end-to-end coverage of the transport bound uses the `ollama` adapter,
because `callOllama` reaches a configured-agent `baseUrl` and a local stub can stand
in for a real server. The `openai` adapter's equivalent bounded read cannot be
covered the same way: `callOpenAI` hardcodes `https://api.openai.com/v1/responses`,
so no local stub can intercept it without introducing a production URL seam that
this tranche is not authorized to add. Both adapters share the same limit, the same
canonical `PROVIDER_RESPONSE_TOO_LARGE` refusal and the same absent-option default;
the OpenAI path was verified by direct exercise but is not gated by a registered
suite. Closing that gap needs a configurable OpenAI base URL, which is a separate
decision.

Request evidence is durable before the wire, so a process that stops after request
initiation resolves to `interrupted`/`outcome_unknown` and the provider call is
never repeated automatically.

The planner context carries only immutable admitted facts, is closed and
hash-bound, and is deterministically reconstructible. It contains no credentials,
secrets, live mutable catalog state as authority, host paths, raw database state,
unrelated runs, workspace contents or process-launch material.

The model proposes decomposition content only. The runtime supplies every identity,
owned path, provenance label, criterion hash, evidence identity, and authority
hash. Evidence requirements must be proposed empty and are bound one-to-one from
typed criteria by the runtime. Exactly one JSON document is accepted; fences,
commentary, surrounding prose, multiple values, malformed JSON and non-object
documents are refused, and no repair request is issued. Any runtime-owned authority
field appearing anywhere in the proposal is refused distinctly as
`proposal_model_owned_authority` rather than silently dropped. Cardinality mirrors
current v1 production: every captured candidate exactly once. The known legacy
placeholder `Produce your allocated output for ticket N inside your owned path
only.` is refused by whitespace-collapsed, case-insensitive identity with the
ticket number as the only variable; this makes no claim to recognize paraphrases
and must not be widened into one.

Admission is one transaction: re-lock the Ticket, validate immutable authority
hashes, re-evaluate current applicability, re-evaluate invocation readiness from
live rows, verify the attempt is uniquely active, verify request/response/proposal
hashes, verify no existing plan and no existing runs, reserve plan and item
identities, materialize and validate v2 authority and its `planHash`, persist the
plan with its provenance, mark the attempt `plan_admitted`, and append the
admission event. An already-admitted attempt is idempotent: it re-reports the
committed plan instead of admitting a second one.

Planning provenance binds the attempt identity, planner identity, provider, model,
planning-authority snapshot hash, parent declared-work hash, request hash, response
hash, proposal hash, admitted plan hash and admission timestamp. Admission is
validated through **three independent values**: `planHash` (the immutable plan
authority), `provenanceHash` (the planning facts that produced it), and
`admissionHash = hash({planHash, provenanceHash})` (the pairing itself).
`admissionHash` can be checked on its own without rebuilding the provenance record,
makes a half-written pair structurally impossible, and is re-derived from the
persisted row inside the admission transaction. Provenance requires all three fields,
so partial provenance or a partial binding cannot be represented. One attempt binds
to one plan and one plan to one attempt, enforced under the ticket lock. Provenance
is stored beside the v2 authority rather than inside `planHash`, in the stored body's
ALLOWED but not REQUIRED field set. `AUTHORITY_FIELDS` is a closed required list: adding
provenance there would make every Tranche 1 v2 plan fail validation on read and
would change the meaning of every stored `planHash`, which this roadmap forbids.
Provenance therefore carries its own canonical hash and embeds the `planHash` it
describes, so it verifies independently, cannot be transplanted onto another plan,
and is validated on every read. Item-status writes carry it forward unchanged.

On success exactly one v2 plan exists with status `pending`, the attempt is
`plan_admitted`, the Ticket remains open or blocked as before, zero worker Runs
exist, and nothing is scheduler-visible — the scheduler selects only pending Runs,
so an admitted plan is structurally invisible to it. On any refusal there is no v1
fallback, no generic allocation, no partial v2 plan, no worker Run, no scheduler
visibility, no completion and no hidden retry: a blocked Ticket with no plan and no
Runs is the canonical truthful state, carrying the exact stage, canonical reason and
available bounded evidence.

Recovery completeness is a structural invariant, not a hope. A `response_received`,
`proposal_validated` or `plan_admitted` attempt must carry the **complete** response
text, with `responseTruncated: false`, `responseBytes` equal to the UTF-8 byte length
of the stored text, and `responseHash` equal to the SHA-256 of exactly those bytes.
All three are re-checked on every read, so such a state always contains enough
hash-validated durable material to reparse and revalidate deterministically without a
second provider request. Truncation is not representable: `responseTruncated: true`
fails closed, and anything over the byte limit was refused at transport receipt before
`response_received` could be recorded.

An earlier split — accept up to 262,144 characters, store only 65,536 — did not have
this property. Response persistence and proposal persistence are separate
transactions, the proposal is persisted only as a hash, and a crash in that window
left a durable `response_received` holding a truncated excerpt that could not be
continued. Collapsing to one byte limit at transport receipt removes the window
entirely rather than narrowing it.

Recovery remains conservative about *action*. An attempt found in `request_started`
becomes `interrupted`/`outcome_unknown`. An attempt found in `response_received` or
`proposal_validated` is refused rather than auto-resumed, even though it is now
provably resumable, because no automatic repair or retry is authorized. Malformed or
hash-conflicting stored planning state fails closed on read, admitted attempts stay
idempotently admitted, and recovery creates no worker Runs.

Tranche 2B adds no migration. Historical Tickets without structured authority, v1
plans and runs, and existing Tranche 1 v2 plans are all unchanged, and no planner
provenance is synthesized historically.

### Tranche 2B / Tranche 3 boundary

Nothing in Tranche 2B calls `prepareAgentRunDraft()`, persists a worker Run, writes
a worker prompt, makes an execution unit scheduler-visible, dispatches a worker,
aggregates completion, routes by role, applies model economics, or delegates
recursively. Plan admission remains one transaction ending at its event, still
creating zero worker Runs. Tranche 3 begins at the point where an admitted v2
allocation item becomes leaf-run authority, in a separate transaction.

## Tranche 3 — Leaf-Run Admission and Aggregate Completion (implemented)

An admitted, pending v2 plan becomes execution through exactly one atomic leaf
admission: one initial Run per immutable allocation item, all scheduler-visible
together or none at all. Each Run carries an immutable leaf binding derived by the
runtime and hashed over Ticket, plan identity and hash, allocation item, assigned
agent, item declared-work hash, exact admitted owned paths, parent declared-work
hash, planning-attempt id, admission hash and the runtime-assigned Run id.

A leaf Run declares its allocation ITEM, not the parent Ticket, and never the
generic v1 `allocationSubtask`. The item's assigned agent is the worker principal,
dispatched through the existing worker route with no role-aware routing. An item
declaring a `typed-postcondition` criterion has no admitted completion authority
and refuses the whole admission with `leaf_item_typed_criteria_unsupported`,
before any Run identity is reserved and with the admitted plan preserved.

Item status for planner-admitted plans is derived transactionally from the
immutable binding, the persisted Run lifecycle, the durable completion decision
and declared-work/completion-authority hash agreement. Callers may request
reconciliation but never supply a status. A raw `completed` Run with absent,
stale, conflicting or unsuccessful evidence never completes its item. One
deterministic aggregate decision is stored beside the plan authority, outside
`planHash`; the plan completes only when every item holds a valid completed
decision. The parent Ticket outcome stays with `transitionTicketAfterRun()`, which
already owns that mapping — Tranche 3 adds no second parent-completion authority.

Tranche 3 adds no migration, no replanning, no v1 fallback, no recursion and no
delegation. Historical v1 behavior and non-planner v2 plans are unchanged.

## Tranche 4 — Role-Aware Routing and Bounded Economics

Evaluate role-aware model selection and explicit bounded economic authority for
planning and leaf execution. Preserve existing provider, model, routing, and
budget contracts until this tranche admits a change. This tranche is not
implemented by Tranche 1.

## Tranche 5 — Coordination and Verified-Progress Controls

Evaluate bounded coordination signals, verified-progress accounting, and churn
termination using durable evidence. Do not introduce recursive delegation or a
generic decision-claim registry. This tranche is not implemented by Tranche 1.

## Tranche 6 — Controlled Evaluation and Product Decision

Run controlled scenarios comparing allocation quality, completion truthfulness,
latency, cost, and churn. Use the evidence to decide whether to retain, revise,
or stop the structured allocation path. This tranche is not implemented by
Tranche 1.

## Roadmap status

```text
Tranche 1: COMPLETE
Tranche 2A: COMPLETE
Tranche 2B: COMPLETE
Tranche 3: NOT STARTED
Tranche 4: NOT STARTED
Tranche 5: NOT STARTED
Tranche 6: NOT STARTED
```

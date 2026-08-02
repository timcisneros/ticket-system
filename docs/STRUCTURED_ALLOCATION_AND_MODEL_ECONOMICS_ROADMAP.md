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

## Tranche 4 — Role-Aware Routing and Bounded Economics — COMPLETE

Role-aware model selection and explicit bounded economic authority for planning
and leaf execution.

### The authority chain

```text
work authority
→ canonical role
→ closed role-routing policy
→ immutable execution target
→ immutable economic authority
→ role-scoped Ticket account
→ exact prepared request
→ durable reservation
→ one-winner request start
→ exact-byte dispatch
→ response persistence
→ captured-basis settlement
```

Authority flows one way. Routing never consults capability or pricing;
economics never selects a route.

### Canonical roles

Exactly two, and they are closed:

* `structured_planner` — one provider request per planning attempt.
* `structured_leaf_executor` — many requests per Run, against one shared
  Ticket account.

Ordinary historical execution has no role and no account.

### Routing authorization is not target capture

A policy authorizes a route *reference*. Capture resolves that reference to an
immutable *artifact* and records the evidence. The two are separate fields on
every captured decision precisely because a reference can move and an artifact
cannot. A reference that cannot be resolved to an immutable artifact is refused;
it is never dispatched on the assumption that it will still mean the same thing
when the request lands.

### Routing is not economics

Routing answers *which exact route is authorized for this role*. Economics
answers *whether that captured route has capability, pricing and budget*. Two
independent documents, two independent hashes. An earlier draft had routing
consult model capability; that was removed, because it made an unpriced route
unroutable rather than unaffordable and hid the distinction.

### Exact OpenAI snapshot requirement

A governed route must name an exact dated snapshot (`gpt-4o-mini-2024-07-18`).
A mutable alias (`gpt-4o-mini`) is policy-representable but cannot be captured,
because the artifact it names today is not the artifact it will name tomorrow
and no evidence can bind it.

### Conservative liability: the full context ceiling

`model_context_window_ceiling` prices the **entire context window** as maximum
input. This needs no framing estimate: every accepted input is subject to the
finite window, so pricing the whole window can never understate the request.

Liability = fixed request charge + ceil(contextWindowTokens × input rate) +
ceil(maxOutputTokens × output rate), all in integer micro-USD, every division
rounding up.

A route is eligible only when the adapter transmits an enforceable output cap,
all chargeable output is covered by it, the input bound is proven, and fixed
charges and authorized fallback liability are included. Otherwise the runtime
refuses with `provider_path_not_hard_boundable` **before** provider contact.

### Explicit zero prices

`catalog_maximum_exactly_zero` admits a route whose catalog maximum is exactly
zero. It is eligible because its stated price is zero — never because a route
is assumed free for being local.

### Role-scoped Ticket accounts

`UNIQUE (ticket_id, role)`. Sibling leaf Runs contend against one shared worker
account; the planner account is separate and neither can spend the other's
authority. The database enforces `reserved + settled <= authorized`, so
oversubscription is impossible rather than merely unlikely.

### Durable logical-request identity

The runtime budget already names each model-request opportunity as
`model-request:<evidence slot>`, unique per Run and derived from the durable
execution step. Economic reservations reuse **that exact string** rather than
inventing a second counter that could drift:

```text
one canonical model-request source
→ one runtime-budget reservation
→ one economic reservation
→ one ordinal
```

Account locking proves economic serialization. It cannot prove logical
uniqueness, because it does not know two callers meant the same request. Without
the shared identity, duplicate orchestration of one request became requests 1
and 2 — two reservations, two charges, two provider calls.

### Request lifecycle

```text
reserved → request_started → response_persisted → settled
reserved → released
```

Release is legal **only** before start. Once started, the bytes may be on the
wire, so the request settles — conservatively if necessary — and is never
handed back.

### Exact bytes, not hashes

A request is serialized once; those bytes are hashed, reserved, persisted, and
later dispatched. A hash alone proves equality only against bytes someone still
holds and does not survive process failure. The winning start transition returns
the persisted bytes; a caller cannot supply its own.

### Captured pricing basis

Each reservation retains the complete normalized economic authority and the
exact pricing entry. Settlement reads only those. An administrator who re-prices
or deletes a catalog entry can neither change nor block the settlement of a
request already reserved against it.

Unknown, absent, partial or malformed usage settles at the **reserved maximum**,
never zero.

### Active versus abandoned

A `request_started` reservation is never re-dispatched. Whether it may be
*settled* depends on the Run lease:

```text
request_started + live lease → report in flight; no call, no settlement
request_started + no lease   → recovery may settle conservatively
```

Abandonment is proven by the lease against the database clock, never by elapsed
wall-clock time, and it reuses the same predicate the canonical recovery path
already uses. Liveness deliberately does not require `status = 'running'`:
`claimPendingRun` takes the lease before the Run advances, so requiring the
status would report a just-claimed executor as gone.

### No-repeat recovery

```text
reserved            → first start may occur using the persisted bytes
request_started     → never automatically dispatch again
response_persisted  → settle without dispatch
settled             → consume the durable response without dispatch
released            → terminal undispatched request
```

Recovery selects no new route, model, target, policy, catalog, prompt or
ordinal, and never replans.

### Development cutover

Tranche 4 is a development cutover. Pre-cutover structured execution data is
disposable and removed through the canonical development reset. Every supported
structured planner request and structured leaf Run requires complete governed
authority. Missing or partial governed state is an integrity failure, not a
historical compatibility mode.

There is no runtime category called "historical structured execution".

**Run pairing.** The binding and the authority are inseparable:

```text
no binding + no envelope       → supported non-structured execution family
binding    + complete envelope → supported structured leaf execution
binding    + absent/partial    → INTEGRITY FAILURE
no binding + envelope present  → INTEGRITY FAILURE
```

One canonical rule, `assertRunGovernedExecutionPairing`, is enforced at Run
creation and at PostgreSQL row reconstruction. Because every read — scheduler
pickup, recovery, retry preparation, projection, provider-path selection —
reconstructs through the same function, a malformed structured Run can neither
enter nor leave the runtime.

**Planning attempts.** `created` is a transient, non-request-capable stage that
may precede capture: the envelope binds a reservation identity that does not
exist until the reservation commits. From `request_started` onward the attempt
is request-capable and complete governed state is required. Nothing is
synthesized from current policy to repair an attempt that lacks it.

**Leaf admission** requires governed capture. There is no ungoverned structured
leaf admission and no v1 fallback: all siblings receive complete authority, or
zero Runs become scheduler-visible.

Age is consulted nowhere — not timestamps, not migration numbers, not IDs. A
record's vintage never excuses a malformed combination.

### Intentionally supported non-structured paths

Unchanged by this cutover, and not "legacy compatibility" — these are current
product capabilities: ordinary direct Runs, v1 allocated Runs, workflow Runs,
browser Runs, process Runs, simulation/A27, and objective-compiler calls. They
carry neither `leafRunBinding` nor `governedExecution` and keep their existing
provider path.

### Formal fallback boundary

```text
Fallback authorization is representable in policy.

Fallback selection and execution are unavailable because the
runtime has no canonical preflight-evidence authority proving
that the primary route is unavailable.

The runtime therefore refuses fallback rather than inventing
availability evidence.
```

`selectRoleRoute` refuses fallback with `fallback_preflight_evidence_unavailable`.
This is a recorded boundary, not a quiet deferral.

### Not implemented

Recorded explicitly so no reader infers otherwise:

* paid Ollama governance;
* Ollama digest resolution;
* mutable OpenAI aliases;
* live price lookup;
* price optimization;
* cached-token discount optimization;
* dynamic provider hopping;
* fallback selection/execution;
* recursive delegation;
* worker-created child work;
* scheduler changes;
* retry-policy changes.

### Provider support

| Provider | Governed planning | Governed leaf | Why |
|---|---|---|---|
| OpenAI (exact dated snapshot) | Yes | Yes | Immutable artifact, documented context window, enforceable output cap |
| OpenAI (mutable alias) | No | No | No immutable artifact can be captured |
| Ollama | No | No | A tag is a moving reference; no digest resolution and no context proof, so liability is unboundable |

Ollama remains fully supported on historical ungoverned paths.

### Operational projection

One canonical read-only seam, `runtime/governed-execution-projection.js`, feeds
Ticket Detail, Run Detail, both runtime APIs, replay snapshots and the CLI.
Balances come from the durable account row, never from summing reservations.
The durable lifecycle vocabulary is used verbatim; there is no overloaded
`governed: true`.

## Tranche 5 — Coordination and Verified-Progress Controls

**NOT COMPLETE — verified-progress credit is unresolved.** Bounded coordination
signals and churn termination are implemented and enforced from durable evidence.
Verified-progress ACCOUNTING is not: production cannot credit a newly satisfied
admitted declared-work fact, because the evidence prerequisite it depends on does
not exist durably. See "Verified progress requires an unimplemented evidence
prerequisite" below. No recursive delegation and no generic decision-claim
registry were introduced.

### The authority chain

```text
governed structured leaf Run
-> captured progress policy
-> durable logical request windows
-> stable database cutoffs
-> candidate and verified-progress classification
-> cumulative resource reconstruction
-> churn or sibling-read decision
-> persisted cutoff-bound block
-> no further governed spending
```

Every link is durable. Nothing in the chain is a process-local counter, so the
same rows produce the same decision in any process, before or after a restart.

### The distinction the tranche exists to make

```text
activity            something durable happened
candidate progress  something NEW happened
verified progress   a previously unsatisfied declared-work fact is satisfied
completion          owned by the Tranche 3 completion decision
```

* **Activity is not progress.** A window full of successful operations that
  advanced no declared fact has produced activity and nothing more.
* **A novel mutation is only candidate progress** unless it advances declared
  work. Writing a file nobody asked for is activity with a new fingerprint.
* **Verified progress does not mean completion.** It means one declared fact
  that was unsatisfied is now satisfied. Completion authority is unchanged and
  remains with the structured allocation completion decision and the aggregate
  plan decision.
* **Model prose is not represented at all.** There is no field it could occupy.

### Durability and duration

* **No-progress state survives restart.** Streaks are replayed from durable
  receipts and reservations under a cutoff captured in one statement, never
  carried in memory.
* **Duration begins at first actual execution** — the earliest append-only
  `run.lease_acquired` event. Not admission time, which would charge scheduler
  queue time; not `runs.started_at`, which recovery resets to NULL and which
  therefore measures only the latest attempt.
* **Verified progress does not reset cumulative duration.** Tolerance for churn
  is something progress can earn back; total execution time is consumption and
  nothing buys it back.
* **Evaluation instants come from the database clock**, captured in the same
  statement and snapshot as the receipt, reservation and budget cutoffs.

### Coordination

* **Writes remain disjoint.** Owned output paths are non-overlapping by
  admission, and Tranche 5 changed nothing about that.
* **No dependency DAG exists.** There is no ordering, no topological sort and no
  graph of any kind.
* **Incomplete sibling-output reads block rather than wait.** A leaf Run reading
  another item's owned output is refused and stopped. It does not wait for the
  sibling, because waiting would be a dependency by another name.
* **Completed sibling reads require canonical Tranche 3 completion authority** —
  a reconciled item disposition of `completed` carrying a valid completion
  decision hash. Terminal Run status is not completion and does not grant a read.
* **Blocked Runs are not automatically reopened.** `blocked` was chosen over
  `interrupted` precisely because ordinary recovery resumes interrupted Runs.
* **No retry, reroute, replan or automatic remediation occurs.** The churn
  decision vocabulary has exactly two values, `continue` and `blocked`.

### Pending decision A3

```text
A3 is closed for governed structured leaf execution.

Requests, operations, economic consumption, no-progress history,
cumulative execution duration, and persisted stop authority all
survive recovery.

The broader repository-wide A3 remainder remains open for
intentionally unmodified execution families that still use
attempt-local counters or duration behavior.
```

This is not a repository-wide closure. Direct, v1, workflow, browser, process,
simulation and compiler execution were deliberately untouched.

### Operational projection

One canonical read-only seam, `runtime/verified-progress-projection.js`, feeds
Ticket Detail, Run Detail, both runtime APIs, replay snapshots and the CLI. It
reports the decision the pre-reservation gate already made and re-derives
nothing. Where a Run is blocked, the stored cutoff is replayed rather than a
fresh one taken, so reading a blocked Run cannot change what it says.

Cumulative micro-USD in this projection is CONSUMPTION, drawn from the same
durable settlement facts Tranche 4 reads. Authoritative balances remain the
role-scoped economic accounts in `runtime/governed-execution-projection.js`;
Tranche 5 introduces no second ledger.

### Verified progress requires an unimplemented evidence prerequisite

**This is a blocking gap, not a documentation boundary.** It was previously
recorded as the latter; that classification was wrong. False blocking is
incorrect execution authority, and a persisted stop reason that can be untrue is
not made acceptable by the fact that it errs toward spending less.

The three pieces that DO exist:

* a canonical deterministic evaluator — `directPostconditionResult` in
  `runtime/completion-decision-contract.js`, which maps a postcondition
  declaration plus `run:postcondition_completed` claims to passed/failed;
* a canonical identity rule — a typed criterion's `criterionHash`, which is what
  `inventoryDeclaredFacts` uses as the declared-fact identity;
* a canonical objective compiler — `buildObjectiveContract`, which yields
  `folder_exists` and `path_absent` postconditions for recognized objectives.

The piece that does NOT exist is the durable substrate. `run:postcondition_completed`
claims are written by `recordRunEvent` into `replay_snapshots`: ONE MUTABLE ROW PER
RUN (`run_id PRIMARY KEY`, a `revision` counter), whose items are stamped
`capturedAt: new Date()` — the process clock — and carry no per-item monotonic
identity. The append-only events path, `buildRunPostconditionEvidence`, returns
`null` unless `executionMode === 'workflow'`, and governed structured leaf Runs
are `agent`. No migration defines a postcondition table or column.

That substrate cannot satisfy Tranche 5's evaluation discipline:

* **no cutoff is expressible** — there is no `id <= N` to bound, so a claim
  appended moments ago is indistinguishable from one that preceded the
  evaluation;
* **ordering authority would be the process clock** — precisely what the
  execution-epoch work removed as authority;
* **the row is rewritten in place**, so "later facts do not rewrite an existing
  evaluation" cannot hold the way it does for the hash-chained event log.

Wiring it anyway would inject process-clock-ordered, non-cutoff-bounded,
rewritable evidence into the one path this tranche made durable, cutoff-stable
and restart-deterministic — breaking the stable-cutoff proof, the
database-time proof, and the A3 closure that rests on both.

**The prerequisite.** A durable, append-only, database-ordered postcondition-result
record — a typed-evidence seam that writes deterministic postcondition results to
an ordered table with a monotonic id and a database timestamp, the way
`operation_receipts` and `events` already do. That belongs to the typed-evidence
work, not to churn control: building it inside Tranche 5 would create a second
postcondition authority, which is the thing this tranche exists to avoid.

**Until it exists**, on the governed structured leaf path:

* `verifiedProgressCount` is always 0;
* the consecutive no-progress streak grows on every governed window;
* a Run stops at `maximumConsecutiveNoProgressWindows` with reason
  `verified_progress_exhausted` **whether or not it advanced declared work**;
* that reason is therefore NOT evidence that no declared work advanced, and must
  not be read as such.

### Verified progress is not yet credited in production

The classification, the four levels and the tolerance arithmetic are complete and
enforced. What is NOT wired is the last input: `evaluateGovernedRunProgress` accepts
`satisfiedFactIdentitiesByReceiptId`, a mapping from durable receipt identities to the
declared-work facts they newly satisfy, and **no production caller supplies it today**.
`prepareAndReserveNextGovernedRunRequest` passes `null`, which becomes an empty map.

The consequence is exact and should not be understated:

* `verifiedProgressCount` is always 0 on the production path;
* the consecutive no-progress streak therefore grows on every governed window;
* a governed structured leaf Run is effectively bounded at
  `maximumConsecutiveNoProgressWindows` provider requests, and stops with reason
  `verified_progress_exhausted` **whether or not it actually advanced declared work**.

The direction of this error is conservative — it stops spending earlier than the policy
intends and can never overspend — which is why it is not a safety defect. It is a
TRUTHFULNESS limit: for a Run that genuinely advanced, `verified_progress_exhausted` is
the wrong explanation, and the Ticket summary will show `totalVerifiedProgressFacts: 0`.

Deriving that mapping from typed evidence is deliberately out of Tranche 5's frozen
scope: the evidence-to-declared-fact derivation belongs with the typed-evidence work, not
with churn control. Until it is wired, read verified-progress counts as "not measured",
not as "nothing happened".

### Not implemented

Recorded explicitly so no reader infers otherwise:

* derivation of `satisfiesDeclaredFactIdentities` from typed evidence — the seam accepts
  it, production does not yet supply it (see above);
* dependency DAGs;
* sibling waiting or ordering;
* shared-decision registry;
* advisory review Workflow steps;
* automatic retry;
* automatic replanning;
* automatic rerouting;
* automatic unblocking;
* generic coordination messaging;
* Tranche 6 behavior.

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
Tranche 3: COMPLETE
Tranche 4: COMPLETE
Tranche 5: SUBSTANTIALLY COMPLETE — authorizing and withholding
            directions both proven in production; crash/restart
            integrity scenarios outstanding
Tranche 6: NOT STARTED
```

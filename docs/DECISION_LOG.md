# Decision Log

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
Execution of an admitted plan is refused with `structured_leaf_run_admission_not_available` until
Tranche 3, and the API, page, and CLI state that boundary explicitly.

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

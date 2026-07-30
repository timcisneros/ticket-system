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

## Tranche 3 — Leaf-Run Admission and Aggregate Completion

Define how admitted v2 items become leaf-run authority and how ticket-level
completion consumes leaf outcomes without rewriting item authority or historical
v1 behavior. This tranche is not implemented by Tranche 1.

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
Tranche 2B: NOT STARTED
Tranche 3: NOT STARTED
Tranche 4: NOT STARTED
Tranche 5: NOT STARTED
Tranche 6: NOT STARTED
```

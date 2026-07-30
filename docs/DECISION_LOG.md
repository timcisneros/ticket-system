# Decision Log

## Parent Work Authority and Planning Principal (2026-07-30)

Split the former planner-lowering tranche into prerequisite Tranche 2A and planner-admission
Tranche 2B. Owned output paths are capability boundaries and cannot be treated as expected
outputs. Objective grammar, acceptance prose, agent ordering, group membership, workspace
contents, or planner output likewise cannot synthesize missing parent work authority. New tickets
may therefore admit an explicit closed ticket-authored declared-work input through the canonical
`runtime/declared-work-contract.js` vocabulary, ordering, evidence consistency, hash, and deep
immutability. Historical tickets without that admission-time snapshot remain historical-unavailable;
reread, rerun, reopen, reassignment, or live configuration changes never synthesize or rewrite it.

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

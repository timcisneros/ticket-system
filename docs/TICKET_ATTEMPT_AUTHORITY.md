# Ticket Attempt Authority

Status: accepted kernel contract, 2026-08-11.

Ticket and Workflow remain the product primitives. A Ticket attempt is internal
lifecycle and admission authority, not a product object, plan, executor strategy,
parent/child tree, or orchestration surface.

## Contract

One logical Ticket execution attempt has:

- one Ticket-scoped, kernel-minted immutable identity and ordinal;
- one exact, atomically admitted, immutable non-empty set of Run members;
- one terminal decision for each member under the existing Run evidence and
  completion authority;
- one write-once topology-neutral disposition: `completed`, `failed`, `blocked`,
  or `interrupted`.

A Run is one admitted execution member. A singleton attempt contains one Run;
an atomically admitted multi-Run wave is one attempt containing multiple Runs.
Retry, rerun, and reassess admit a new attempt. Lease reclaim, replay
continuation, terminal repair, and resume retain the same Run and attempt.

At most one unsettled attempt may exist for a Ticket. PostgreSQL enforces this
in addition to the Ticket-row admission lock. Therefore the highest committed
ordinal is the current attempt; a new ordinal cannot overlap its predecessor.

Strategies and callers may propose Run drafts but cannot supply an attempt ID,
ordinal, member count, existing membership, disposition, or Ticket projection.
The attempt contains no plan items, edges, planner identity, roles, sibling
dependencies, target kind, retry policy, or decomposition reason.

## Admission and projection

`createRunsAndStartTicket` is the product admission owner. Under the Ticket lock
it checks the effective attempt ceiling, creates one attempt, inserts every Run
member and admission event, and projects the Ticket `open -> in_progress` in one
transaction. A failed member/event insert commits neither the attempt nor any
Run. `maxAttempts` counts committed Ticket attempts, not Runs, plans, or
timestamps; the existing `attemptCount >= maxAttempts` refusal remains exact.

An attempt remains unsettled until its exact membership is terminal and the
evidence required by each Run's admitted authority is durable and reconciled.
The established multi-Run outcome order is preserved: completion blocking,
then failure, then interruption, then unanimous completion. Missing or
conflicting authority does not synthesize a disposition.

Canonical Ticket projection consumes only the current attempt. Ticket lifecycle
states are exactly the frozen five — `open`, `in_progress`, `blocked`,
`completed`, `canceled` (runtime/ticket-lifecycle-contract.js; the
`tickets_status_check` CHECK introduced by migration
`041_ticket_five_state_cutover.sql`). Attempt dispositions (`completed`,
`failed`, `blocked`, `interrupted`) are Run/attempt authority and are never
Ticket lifecycle states; the projector must not elevate a failed or interrupted
attempt disposition directly.

| Attempt authority | Ticket projected status |
| --- | --- |
| no attempt | `open` |
| unsettled | `in_progress` |
| settled `completed` (verified) | `completed` |
| settled `blocked` | `blocked` |
| settled `failed` | `open` — `failed` is attempt disposition only; with an established unresolved durable blocking authority the separate blocking authority projects `blocked` instead |
| settled `interrupted` | `open` — `interrupted` is attempt disposition only |

Triage/operator attention remains a separate projection. Run/evidence history
continues to expose detailed execution topology without making it Ticket
lifecycle authority.

## Historical compatibility

Migration `039_ticket_attempt_authority.sql` runs a source-owned, hash-aware
preflight and refuses rather than guessing. It maps:

- each non-plan historical Run to a singleton attempt;
- all same-Ticket Runs in one authoritative Allocation Plan v1 admission wave
  to one attempt;
- the exact immutable leaf-binding set of a valid historical Allocation Plan
  v2 to one attempt;
- an interrupted/recovered Run to its existing membership;
- later retry/rerun waves to later Ticket-scoped ordinals.

`ticketOpenedAt` verifies ordering/wave consistency only; it is never identity.
`planningAttemptId`, `allocationPlanId`, and `assignmentMode` are never future
Ticket-attempt authority. Historical v2 readers may validate old leaf/aggregate
proof, then return only generic membership/disposition to the canonical
projector. No Run body, evidence, receipt, consequence, completion decision,
plan, binding, replay snapshot, or Run revision is rewritten by backfill.

The preflight refuses missing/cross-Ticket plans, plan reuse across admission
waves, ambiguous multi-Run non-plan waves, incomplete/duplicate v2 bindings,
missing terminal evidence, count drift, and overlapping unsettled history.

## Explicitly deferred

This contract does not decide generic executor identity, human/external
executors, generic governed role or economic-subject vocabulary, model-selected
topology, or an execution-strategy/plugin interface. It creates no new Ticket
status and no Airport-status UI.

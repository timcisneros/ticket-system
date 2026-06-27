# Agent Handoff & Queue Protocol

r1.23 implements the smallest explicit handoff/queue protocol over the existing Ticket, Run,
lease, evidence, triage, timeline, and Work Context primitives. It is the implementation of
`docs/AGENT_HANDOFF_QUEUE_PROTOCOL_AUDIT.md`. It adds **no new execution path** — a handoff is a
ticket transition plus receipts, and execution stays Ticket → Run → Authority → Target → Evidence.

## The ticket is the handoff object

A ticket is a durable work object, not a prompt or a chat transcript. Work moves between humans and
agents by **creating/updating ordinary tickets** and attaching **receipts** — never through a
private channel and never as hidden work.

## Claim Receipt

A **claim** is the existing run lease (`leaseOwner` / `leaseExpiresAt`). The `run.lease_acquired`
event now carries a normalized **Claim Receipt** (`buildClaimReceipt`): `ticketId`, `runId`,
acting agent, assignee/owner, `claimedAt`, lease window, `workContextId` (if present), and
`claimSource: "run_lease"`. It is also derivable read-only at `GET /api/runs/:id/claim-receipt`.
Claiming writes only the lease + event — **no target or workspace mutation**. There is no second
claim system.

## Work Receipt

A **Work Receipt** (`buildWorkReceipt`, `GET /api/runs/:id/work-receipt`) summarizes what a run
did, derived live from existing evidence (run, events, operation-history, replay summary,
verification result, triage, run evaluation). It carries **refs, counts, ids, and paths only** —
**never full file contents or provider response bodies**: source refs read, target operations
performed, artifacts (paths), authority decisions, verification result, triage/blocked status,
what was/wasn't done, where work stopped, and the next recommended action. **Done without a
receipt is not complete enough.**

## Handoff Receipt

`POST /api/tickets/:id/handoff` (gated by `ticket:create`) proposes a handoff that **creates an
ordinary ticket through the normal authorized path** (`createTicketFromInput`). The new ticket's
`source` carries the **Handoff Receipt**: `fromTicketId`, `fromRunId`, `fromActor`, `toAssignee`,
`workContextId`, `objective`, `sourceRefs`, `evidenceRefs`, `constraints`, `authorityLimits`,
`stopCondition`, `receiptExpectation`, `createdAt`, `createdBy`, `status`. A `handoff.ticket_created`
event is appended. **A handoff proposal is not execution** — the created ticket flows through the
same run/triage/verification path as any ticket, and the **recipient claims it normally** (it gets
a normal pending run with no pre-granted lease). The handoff **never bypasses** ticket permissions,
Work Context scope, or Authority (all enforced by `createTicketFromInput`), and **never widens**
authority.

The pre-existing intra-run `createHandoffTask` agent action (a validated planner→executor file
write) is unchanged; the ticket-level handoff above is the agent-to-agent path.

## Needs-input / triage relationship

The protocol does **not** add a parallel needs-input system. Ambiguity is the existing stop point:
an ambiguous objective is **blocked with `objective_ambiguous` triage** (no run, no guessing). The
human answers on the **same ticket**, and work resumes only through **normal run/rerun semantics**.
A read-only `deriveNeedsInput` projection surfaces the exact blocking question from existing triage
evidence. **Triage resolution never rewrites history.**

## Timeline visibility

The r1.18 ticket timeline (projection-only) now shows the claim (`run.lease_acquired`), a
per-terminal-run **work receipt** entry, and a **handoff** provenance entry on handoff-created
tickets. The timeline remains **projection-only**: no new timeline ledger, no source-precedence
change, and it leaks no file content or provider body.

## Work Context relationship

Work Context **scopes** handoffs (filter queues/triage, supply creation-time defaults) but **does
not execute** and **creates no hidden work**. A handoff inherits the source ticket's Work Context
unless overridden, validated normally. Changing a context later does not reinterpret old handoffs
(tickets snapshot their context at creation).

## Deferred

Watchers, ambient behavior, connectors, chat/Slack/Discord, model/provider routing, and any private
agent-to-agent channel remain **out of scope** and deferred until this protocol is exercised end to
end.

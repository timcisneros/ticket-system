# Bounded Watcher

r1.26 implements the smallest bounded watcher as a **scoped, manual observer/proposer** over a Work
Context, per `docs/BOUNDED_WATCHER_DESIGN_AUDIT.md`. It adds **no execution path**: a watcher
observes a narrow source and may draft a ticket proposal; only an explicit, authorized approval
creates a normal ticket through the usual path.

## What a watcher is

- A record in `data/watchers.json` scoped to one **active** Work Context, with a narrow
  `sourceKind` and bounded `sourceRefs`, `status` (`active` | `paused` | `archived`), and an
  `actionPolicy.allowedActions` constrained to `summarize` / `raise_triage` / `propose_ticket` /
  `notify` (execution verbs are rejected).
- **Manual only in r1.26**: there is **no background daemon and no automatic polling loop**. A
  watcher only acts when an operator calls `POST /api/watchers/:id/observe`.

## sourceKind limitation

r1.26 supports exactly one source kind: **`workspace_file`** — a single bounded, workspace-relative
file read through the existing workspace provider boundary (path traversal is rejected). **No
external connectors** are added.

## Observation receipt

Each observe writes a receipt to `data/watcher-observations.json`:
`{ id, watcherId, workContextId, observedAt, sourceKind, sourceRefs, status, previousHash,
currentHash, summary: { bytes, lineCount }, actionTaken, ticketProposalId, error }`.

- The receipt records a **content hash and metadata only** — **never full file contents**.
- `status` is `changed` | `unchanged` | `failed` | `refused`. A **duplicate (unchanged)**
  observation is deterministic and creates no work. A **missing/unreadable source** records
  `failed` (no guessing). An archived/paused watcher or an inactive Work Context records `refused`.
- Observing creates **no ticket/run**, **mutates no target or workspace**, **wakes no agent**, and
  **runs no template**.

## Ticket proposal

A watcher may draft a proposal in `data/watcher-ticket-proposals.json`:
`{ id, watcherId, workContextId, observationId, status, objective, sourceRefs, evidenceRefs,
constraints, authorityLimits, stopCondition, receiptExpectation, createdTicketId, ... }`.

- A **proposal is not a ticket and not execution** — it creates no ticket and no run.
- Proposals are **blocked while the Work Context is not active**.

## Explicit approval creates a normal ticket

`POST /api/watcher-proposals/:id/approve` requires **`ticket:create`** and creates an **ordinary
ticket** through `createTicketFromInput`, carrying `source.type: "watcher_proposal"` with the
watcher/proposal/observation refs and the r1.23 handoff brief fields. The created ticket follows
the normal run/triage/verification path and the recipient **claims it normally** (a normal pending
run, no pre-granted lease). Authority and Work Context scope are enforced by the normal path and
never widened. A proposal can be approved once; **rejection rewrites no evidence**.

## API & UI

- API (gated by `watcher:manage`, except approval which needs `ticket:create`):
  `GET/POST /api/watchers`, `POST /api/watchers/:id`, `GET /api/watchers/:id`,
  `POST /api/watchers/:id/observe`, `POST /api/watchers/:id/proposals`,
  `POST /api/watcher-proposals/:id/approve`, `POST /api/watcher-proposals/:id/reject`.
- UI: `/watchers` (list) and `/watchers/:id` (detail with recent observations + proposals).
  No chat, connector, notification, automation-daemon, or model-routing UI.

## Timeline

The approved ticket's `source.type: "watcher_proposal"` is shown as a `ticket.watcher_proposal`
provenance entry in the existing projection-only timeline. **No watcher timeline ledger** is
created and source precedence is unchanged.

## Boundaries (unchanged by r1.26)

No target mutation, no agent wake-up, no template run, no connectors, no notifications, no model/
provider routing, no scheduler or scheduled-token changes, no process-template/version/durability
change, no handoff-protocol change, no Work Context execution. Old tickets/runs/evidence are not
rewritten and nothing is backfilled.

> **Framing:** the seed/demo watcher fixtures are **test/demo only** — in the real product a
> business connects its own drives/data; these are **not** final product seed data.

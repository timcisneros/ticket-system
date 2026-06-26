# Agent Handoff & Queue Protocol Audit

## 1. Executive summary

The system already has tickets, runs, authority, target evidence, verification, triage, a
projection-only timeline (r1.18), Work Context grouping (r1.20), and Work Context visibility
(r1.21). What it does **not** yet have is an explicit, receipt-backed protocol for how a piece of
work **moves between humans and agents**. Today that movement is implicit — it leans on whoever is
watching, on prose summaries, and on the human acting as the hallway between tools.

**Recommendation:** add a first-class **handoff/queue protocol before** building watchers, model
routing, or connectors. Concretely:

- Keep execution **ticket/run based**. A handoff is never a new execution primitive; it is a
  ticket transition plus a receipt.
- Make the states **claim, working, blocked, needs-input, done, failed, and receipt** explicit and
  visible on the ticket/run and timeline.
- **Do not use chat as the source of truth.** A ticket is a durable work object; a transcript is
  not.
- **No hidden work.** Every unit of work is a ticket with a run; nothing executes off-ledger.
- **Agents never spawn work outside normal ticket creation.** An agent "handing off" to another
  agent must create or update an ordinary ticket that the recipient claims normally — there is no
  private agent-to-agent channel and no bypass of authority, permissions, or Work Context scope.

A ticket is not a prompt. A ticket is a durable work object that can be claimed, worked, blocked,
handed off, verified, and reviewed by another human or agent **without relying on chat**.

## 2. Current substrate map

The protocol does not need new primitives — it formalizes movement across the ones we have.

| Primitive | Home | Role for handoff |
| --------- | ---- | ---------------- |
| **Ticket** | `data/tickets.json` | The durable work object that is assigned, claimed, blocked, handed off, and reviewed. |
| **Run** | `data/runs.json` | The only execution unit. Already carries `leaseOwner` / `leaseExpiresAt` — a real claim/lease today. |
| **Authority** | permissions/groups + per-run delegated authority (`run.delegatedUserId`) | Who may do what; a handoff must never widen it. |
| **Target Provider** | `docs/TARGET_PROVIDER_CONTRACT.md` | The only mutation path; receipts describe operations that flowed through it. |
| **Evidence / Event / Receipt** | `data/events.jsonl`, `data/operation-history.json`, `data/replay-snapshots/run-<id>.json` | The durable proof a handoff/claim/work happened. |
| **Verification** | verification contracts + postconditions | Proves "done" when declared. |
| **Triage** | ticket-level + run-level triage | The stop point for ambiguity, authority denial, verification failure, or required judgment. |
| **Timeline** | r1.18 projection | Read-only display of claim/handoff/receipt chronology; owns no state. |
| **Work Context** | `data/work-contexts.json` (r1.20/r1.21) | Groups related handoffs, scopes queues/triage, supplies creation-time defaults. Never executes. |
| **Process Template** | `data/process-templates.json` | Reusable ticket starter; a handoff may use one but does not change it. |
| **Schedule** | template `schedule` object | Creates tickets on an interval; unrelated to claim/handoff and unchanged here. |
| **`createHandoffTask`** | agent action (intra-run) | An existing, tightly-constrained "planner → one executor" handoff within a run; the protocol generalizes its discipline (validated, single, authority-bound) to the ticket layer. |

## 3. Problem being solved

- **Humans are currently the hallway.** Work moves between agents/tools because a person carries
  it — copy-pasting context, re-explaining, re-deciding. That does not scale and is not auditable.
- **Chat transcripts are bad state management.** A conversation is lossy, unordered for the
  reader, and not a durable record of what is owned, what was done, or where work stopped.
- **Vague summaries are not handoffs.** "I looked into it, seems mostly fine" is not a work object
  a second worker can pick up. A handoff needs objective, sources, constraints, authority limits, a
  stop condition, and a receipt expectation.
- **Agents need self-contained work objects.** An agent should be able to claim a ticket and have
  everything it needs *on the ticket* — not in a human's memory.
- **Teams need visible ownership, status, sources, stop points, and receipts** — who owns it, what
  state it is in, what it read, where it stopped, and proof of what happened.

## 4. Handoff vocabulary

- **Work Item** — a Ticket viewed as claimable work. Not a new object; a role for `tickets.json`.
- **Queue** — a filtered, ordered projection of Work Items (e.g. by assignee, status, or Work
  Context). A read-only view, **not** a scheduler.
- **Owner** — the principal accountable for the Work Item (often the creator or current assignee).
- **Assignee** — the principal/group the Work Item is currently directed to (existing
  `assignmentTargetType` / `assignmentTargetId`).
- **Claim** — an actor taking active ownership of execution for a Work Item, materialized as a run
  lease (`leaseOwner` / `leaseExpiresAt`).
- **Claim Receipt** — a durable record that a claim happened: who, when, which ticket/run, lease
  expiry.
- **Work Receipt** — a durable record of what a run did (§7).
- **Handoff** — directing a Work Item to a different assignee with a self-contained brief.
- **Handoff Receipt** — a durable record that a handoff happened: from, to, ticket, source/evidence
  refs carried, constraints, stop condition.
- **Source Reference** — a pointer to input material a worker read (ticket id, prior run id,
  artifact path, evidence ref). Not a prose summary.
- **Evidence Reference** — a pointer into `events.jsonl` / `operation-history.json` / a replay
  snapshot proving something occurred.
- **Needs Input** — a worker stopped because it needs a human decision/answer to proceed safely.
- **Blocked** — a worker cannot proceed (authority denied, dependency missing, ambiguity).
- **Done** — work finished and a Work Receipt is attached (and verified where required).
- **Verification Required** — the objective declares postconditions that must pass before "done."
- **Triage Required** — a human judgment stop point (ambiguity, authority denial, verification
  failure).
- **Next Work Proposal** — a recommendation for follow-on work; it only becomes work via normal
  ticket creation.

## 5. Proposed lifecycle

```
request
  → ticket created            (normal createTicketFromInput; optional Work Context)
  → assigned                  (assignee set; appears in that queue)
  → claimable                 (open and unclaimed)
  → claimed                   (run lease acquired; Claim Receipt written)
  → working                   (run executing under delegated authority)
  → blocked / needs input / done / failed
  → receipt attached          (Work Receipt; Handoff Receipt if handed off)
  → verified or triaged       (verification proves done; else Triage is the stop point)
  → next work proposed        (recommendation only)
     or created               (only through normal ticket creation)
```

No transition invents a new execution path: "working" is a run, "claimed" is a lease, "done"
requires a receipt, and "next work" is just another ticket.

## 6. Claim protocol

- **Who can claim:** an assignee (or a member of the assigned group) with the authority to run the
  ticket. Claiming never grants authority — it records who is executing.
- **What a claim writes:** a run lease (`leaseOwner`, `leaseExpiresAt`) plus a **Claim Receipt**
  event in the append-only ledger. It writes no target mutation and no workspace change.
- **Claim Receipt contains:** ticket id, run id, claiming actor/agent id, Work Context id (if any),
  claimedAt, lease expiry, and the source refs the claim is based on.
- **Lease/ownership relation:** the claim *is* the lease. Ownership of *execution* = current lease
  holder; ownership of *accountability* stays with the Owner/assignee.
- **Expiry / release:** a lease expires at `leaseExpiresAt` (existing semantics) or is released on
  terminalization; an expired claim returns the Work Item to claimable **without** inventing a new
  scheduler — the existing run lifecycle governs this.
- **Duplicate claims prevented:** a single active lease per run; a second claim attempt while a
  live lease exists is rejected (mirrors today's lease guard). This must not become a busy-loop.
- **Timeline:** the claim appears as a claim event with actor + timestamp; it is projection-only.

## 7. Work receipt protocol

A **Work Receipt** is the durable answer to "what happened on this run?" It is derived from
existing evidence (events, operation-history, replay snapshot, run evaluation) — not a free-text
note. It should reference:

- run id, actor/agent id, ticket id, Work Context id (if present);
- `startedAt` / `completedAt`;
- **source refs read** (tickets/runs/artifacts/evidence consulted);
- **target operations performed** (through the Target Provider; from `operation-history.json`);
- **artifacts produced** (paths/ids);
- **authority decisions** (allowed/denied, from the run's authority checks);
- **verification result** (passed/failed/none-required);
- **what was done** and **what was not done**;
- **where work stopped** (done / blocked / needs-input / failed);
- **next recommended action** (a proposal, not an auto-action).

Rule: **done without a receipt is not complete enough.** A run that claims completion but has no
receipt evidence is a triage candidate, not a "done" Work Item.

## 8. Blocked / needs-input protocol

- **No guessing under ambiguity.** When the objective is ambiguous or a precondition is missing, the
  agent must stop — this is exactly today's objective-clarification / authority gates feeding triage.
- **Ask the exact blocking question.** "Needs Input" records a specific, answerable question, not a
  vague status.
- **State stays on the ticket/run.** Blocked / needs-input is a property of the Work Item, recorded
  durably — never only in a chat message.
- **Human answer is recorded on the same ticket.** The answer attaches to the same Work Item so the
  next worker sees question + answer together.
- **Resume only through normal run/rerun semantics.** Answering does not magically continue work; it
  unblocks the ticket, and execution resumes via the existing run/rerun path (with attempt
  ceilings, verification, etc. unchanged).
- **Timeline shows question, answer, and resumed work** as ordered events.

Needs-input and triage overlap deliberately: needs-input is the worker raising a precise question;
triage is the operator-facing inbox where such stops are reviewed and resolved.

## 9. Agent-to-agent handoff protocol

- **An agent may propose a handoff**, but a proposal is not execution.
- **A handoff must create or update a normal ticket.** There is no off-ledger transfer. This
  generalizes the existing `createHandoffTask` discipline (validated, single, to one existing
  executor) to the ticket layer.
- **The handoff brief must be self-contained:** objective, source refs, constraints, **authority
  limits**, stop condition, and the receipt expectation.
- **The recipient claims normally** (§6). Receiving a handoff confers no special privilege.
- **No direct private agent-to-agent channel.** Everything flows through tickets that humans can
  see, filter, and audit.
- **No bypass:** a handoff cannot bypass ticket permissions, Work Context scope, or Authority. The
  recipient runs under its own delegated authority, never the sender's.

## 10. Work Context relationship

- Work Context **scopes** related handoffs/queues (filter tickets/triage/templates by
  `workContextId`, per r1.20/r1.21).
- Work Context **does not execute** and **creates no hidden work** — it is grouping/visibility only.
- Work Context can **filter queues and triage** and supply **creation-time defaults** (default
  target/template/verification, allow-lists that only narrow authority).
- Work Context can carry **visibility, participants, and target/template defaults**.
- **Changing a context later does not reinterpret old handoffs.** Tickets snapshot their context at
  creation; history is immutable (the r1.20 invariant).

## 11. Timeline relationship

- The timeline should **show handoff states** — claim, handoff, blocked/needs-input, receipt, done —
  as ordered events.
- The timeline **remains projection-only** (r1.18). It owns no state and changes no source
  precedence.
- Claim/handoff/receipt should surface as **events** in the existing ledgers, projected into the
  timeline — not as a new canonical store.
- **Diagnostic logs must not become canonical evidence.** Logs are observability; receipts and
  events are the record.
- **No new persisted timeline ledger** is created for handoff.

## 12. Triage and verification relationship

- **Triage is the correct stop point** for ambiguity, authority denial, verification failure, or any
  required human judgment. Handoff does not add a parallel decision surface — it feeds the same
  triage inbox.
- **Verification proves "done" when required.** If the objective declares postconditions, "done"
  means verified.
- **Done without a receipt is not complete enough** (§7) — such a run is a triage candidate.
- **Triage resolution does not rewrite history.** Resolving annotates; it never edits prior tickets,
  runs, receipts, or evidence (existing r1-era invariant).

## 13. Non-goals

Explicitly **not** in this protocol (now or in the r1.23 slice):

- no **watcher** / ambient behavior;
- no **hidden work**;
- no **chat system**; no **Slack/Discord** integration;
- no **connector**;
- no **model/provider routing**;
- no **new execution primitive** (execution stays ticket/run based);
- no **private agent-to-agent channel**;
- no replacing **tickets/runs**;
- no replacing **Authority**;
- no replacing **Verification / Triage / Timeline**.

## 14. Recommended r1.23 implementation slice

`r1.23-agent-handoff-queue-protocol-implementation` — the **smallest** slice:

- add a **Claim Receipt** (or formalize the existing lease as claim evidence — prefer reusing
  `leaseOwner`/`leaseExpiresAt` + an event over a new store);
- add a **Handoff Receipt** schema (from/to/ticket/source-refs/constraints/stop-condition);
- add **needs-input / handoff** status semantics **only if not already expressible** via existing
  blocked/triage states (prefer reusing triage over inventing statuses);
- **expose** handoff/claim/receipt in the timeline projection;
- add **deterministic tests**;
- **no** watcher, **no** connector, **no** model routing, **no** hidden work, **no** direct
  agent-to-agent channel.

## 15. Recommended r1.24 smoke tests

A deterministic end-to-end chain (no live provider):

1. human creates a ticket;
2. an agent **claims** the ticket (lease acquired);
3. the agent leaves a **Claim Receipt**;
4. the agent works and leaves a **Work Receipt**;
5. the agent **blocks on ambiguity** instead of guessing (needs-input → triage);
6. a human **answers on the same ticket**;
7. the agent **resumes through normal run/rerun** (attempt ceiling/verification intact);
8. the agent **proposes a handoff** to another agent;
9. the handoff **creates/updates a normal ticket** with source refs + constraints + authority
   limits + stop condition;
10. the recipient agent **claims normally**;
11. the **timeline shows the full chain** (claim → work → block → answer → resume → handoff → claim).

## 16. Risks

**P0**

- **Handoff creates hidden work** — a handoff that runs work without a visible ticket. Mitigation:
  handoff *must* create/update a normal ticket; no off-ledger execution.
- **Claim status becomes a second scheduler** — claims polled/auto-advanced into a background loop.
  Mitigation: claim is a lease + receipt only; the existing run lifecycle is the only driver.
- **Handoff bypasses authority** — recipient inherits the sender's authority. Mitigation: recipient
  runs under its own delegated authority; handoff never widens permissions or Work Context scope.
- **Vague summaries replace source/evidence refs** — prose instead of pointers. Mitigation: receipts
  carry concrete source/evidence refs, not free text.
- **Agent-to-agent delegation outside tickets** — a private channel. Mitigation: no direct channel;
  all transfer is via tickets.

**P1**

- **Too many statuses confuse operators.** Mitigation: reuse blocked/triage; add the minimum.
- **Needs-input overlaps with triage.** Mitigation: define needs-input as a triage feeder, not a
  parallel surface.
- **Work Context filters hide urgent work.** Mitigation: uncontexted/critical triage stays visible
  by default (r1.21 rule); filtering is opt-in.
- **Duplicate receipts create noisy timelines.** Mitigation: one receipt per run/handoff; dedupe in
  projection.
- **Claim locks become stale.** Mitigation: rely on existing lease expiry/terminalization; no new
  lock store.

**P2**

- **Naming confusion** between handoff, rerun, delegation, assignment. Mitigation: freeze the §4
  vocabulary.
- **Old tickets lack handoff fields.** Mitigation: fields are nullable/additive; no backfill; old
  tickets render safely.
- **Smoke tests become too toy-like.** Mitigation: assert real receipts/evidence/timeline, not just
  status strings.

## 17. Final recommendation

- **Proceed to r1.23 only after this protocol is frozen.** Vocabulary, lifecycle, and receipt
  shapes should be agreed before code.
- **Handoff must be explicit, receipt-backed, and visible** — never implicit, never chat-only.
- **Keep execution ticket/run based.** A handoff is a ticket transition plus a receipt, not a new
  primitive.
- **Keep Work Context as grouping only.** It scopes and defaults; it never executes or hides work.
- **Keep Triage as the judgment stop point** and **Timeline as projection only.**
- **Defer watchers, model routing, and connectors** until the handoff protocol demonstrably works
  end to end.

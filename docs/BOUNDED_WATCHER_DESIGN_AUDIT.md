# Bounded Watcher Design Audit

## 1. Executive summary

Now that the handoff queue loop is explicit and smoke-tested (r1.23/r1.24), a **bounded watcher**
becomes useful — and safe to design. A watcher is an **observer and proposer, never an executor**.

**Recommendation:** bounded watchers should exist, but only **after** (and on top of) the handoff
queue protocol. Concretely, a watcher:

- is **scoped to a single Work Context** and may only observe that context's allowed sources;
- **creates no hidden work** — every unit of work remains a visible ticket with a run;
- **never mutates targets**, never runs templates, never wakes agents directly;
- may only **summarize, raise triage, propose a ticket, or notify a human**;
- when it proposes work, that work is created **only through normal authorized ticket creation**
  (`ticket:create` + Work Context validation), following the r1.23 handoff protocol;
- is **auditable** — every observation produces a receipt (source, time, hash/etag if available,
  action taken).

A watcher is not a hidden agent, a hidden scheduler, a hidden connector, or a hidden execution
path. It makes the queue more useful without becoming autonomous. **No watcher code ships in
r1.25** — this is design only.

## 2. Current substrate map

A watcher must respect every existing primitive and own none of them.

| Primitive | Home / doc | Watcher constraint |
| --------- | ---------- | ------------------ |
| **Ticket** | `data/tickets.json` | A watcher may *propose* a ticket; it never executes one. |
| **Run** | `data/runs.json` | Execution stays here; a watcher creates no run and is not a run. |
| **Authority** | permissions/groups + delegated per-run authority | A watcher needs explicit observe permission; it can never use it to mutate. |
| **Target Provider** | `docs/TARGET_PROVIDER_CONTRACT.md` | A watcher reads through provider/connector abstractions; it never mutates and never owns credentials. |
| **Evidence / Event / Receipt** | `events.jsonl`, `operation-history.json`, replay snapshots | Observations become evidence/receipts; logs never become canonical. |
| **Verification** | verification contracts | Unchanged; a watcher never asserts "done". |
| **Triage** | ticket/run triage | The human judgment stop point a watcher raises into. |
| **Timeline** | r1.18 projection | Projection-only; a watcher creates no timeline ledger. |
| **Work Context** | `data/work-contexts.json` (r1.20/r1.21) | The watcher's scope boundary; grouping only, never execution. |
| **Handoff protocol** | r1.23 (`docs/AGENT_HANDOFF_QUEUE_PROTOCOL.md`) | The path a proposed ticket follows once created. |
| **Process Template** | `data/process-templates.json` | A watcher never triggers a template. |
| **Schedule** | template `schedule` object | A watcher's cadence is **separate**; no scheduled-token changes. |
| **Template activation durability** | r1.12.2 reconciler | Untouched; a watcher never affects version consistency. |

## 3. Problem watchers solve

- Humans should not have to **poll every Work Context manually** to notice that something changed.
- A bounded watcher can **notice changed inputs** (a source file/dataset/etag moved).
- It can **summarize deltas** instead of dumping raw change.
- It can **propose work** (a draft ticket) when a change implies a task.
- It can **raise triage** when a change needs human judgment.
- It can make the queue **more useful** without becoming an autonomous executor.

## 4. What a watcher is

- a **scoped observer** — bound to one Work Context;
- a **bounded source reader** — only the context's allowed sources;
- a **delta summarizer** — describes what changed, bounded;
- a **triage raiser** — escalates ambiguous/risky change to humans;
- a **ticket proposer** — drafts (does not execute) a ticket proposal;
- a **notification producer** — tells a human (delivery integration deferred);
- an **audit emitter** — every observation leaves a receipt.

## 5. What a watcher is not

- **not a run** and **not an agent**;
- **not a target mutator**;
- **not a scheduler replacement** and **not a process-template trigger**;
- **not a connector** and **not model routing**;
- **not a memory system**;
- **not a hidden execution loop** and **not an agent wake-up mechanism**;
- **not an auto-ticket spawner** — it may only *propose*; a ticket exists only when normal,
  authorized ticket creation runs.

## 6. Proposed watcher object shape

Conceptual only (not code). A declarative observer record:

```
Watcher {
  id
  name
  status                 // active | paused | archived
  workContextId          // the single Work Context this watcher is scoped to
  sourceRefs             // bounded, allow-listed sources it may observe
  sourceKind             // e.g. localWorkspace | targetProvider | connectorSnapshot (future)
  cadence                // explicit, bounded (no sub-minute; not the template scheduler)
  triggerPolicy          // when an observation runs (manual | bounded cadence)
  deltaPolicy            // how change is detected (hash/etag/size; bounded)
  actionPolicy           // constrained set below
  triagePolicy           // when to raise triage
  ticketProposalPolicy   // how a proposal is shaped (objective/refs/constraints/stop/receipt)
  notificationPolicy     // who is notified (delivery deferred)
  lastObservedAt
  lastObservationHash
  createdAt
  updatedAt
}
```

`actionPolicy` is constrained to exactly: **`summarize`**, **`raise_triage`**,
**`propose_ticket`**, **`notify`**. It must **never** include `mutate_target`, `run_template`,
`wake_agent`, or `direct_send`.

## 7. Source and connector relationship

**r1.25 adds no connectors** — this is design only.

- Future connectors provide **source snapshots/receipts**; a watcher reads through the
  target/provider/connector abstraction when available.
- A watcher must record a **`sourceRef`** and the observed **hash/etag** (if available) for every
  observation.
- A watcher must **not assume a source is unchanged without evidence** — no evidence means a
  recorded observation failure, not an assumption.
- A watcher **does not own connector credentials** and must **not bypass** target/provider
  permissions.

## 8. Work Context relationship

- **Every watcher belongs to exactly one Work Context** and inherits its visibility/scope.
- A watcher **cannot observe outside** the context's allowed sources.
- **Changing the Work Context later does not reinterpret old observations** (observations snapshot
  their context, mirroring the r1.20 ticket invariant).
- An **archived Work Context disables/pauses** the watcher's proposals by default.
- Work Context remains **grouping only**, never execution.

## 9. Authority relationship

- A watcher must hold an **explicit observe permission**; observing is not implied by any other
  grant.
- A watcher **cannot use observe permission to mutate** anything.
- A **proposed ticket must still pass `ticket:create` and Work Context validation** when it is
  actually created — the watcher cannot create work on its own authority.
- A watcher **cannot widen** target or capability authority.
- **Authority denials become evidence/triage**, never silent retries or guesses.

## 10. Triage relationship

- A watcher **may raise triage** when it notices ambiguous or risky change.
- **Triage is the human judgment stop point** — the watcher does not decide.
- The watcher must **ask an exact, answerable blocking question** (mirrors the r1.23 needs-input
  discipline).
- **Triage resolution triggers no hidden work**; any follow-up becomes a normal ticket or a normal
  run/rerun.

## 11. Ticket proposal relationship

- A watcher may **draft a ticket proposal**.
- **A proposal is not execution.**
- A proposal must include: **objective, `sourceRefs`, `evidenceRefs`, constraints, authority
  limits, stop condition, and receipt expectation** (the r1.23 handoff brief shape).
- A **human or an explicitly authorized system path** approves/creates the normal ticket.
- The **created ticket follows the r1.23 handoff protocol** (claim → work → receipt → verify/triage).

## 12. Timeline and evidence relationship

- Watcher observations should be **visible as evidence** (events/receipts), projected into the
  existing timeline.
- The **timeline remains projection-only**; a watcher creates **no new timeline ledger**.
- A watcher must **not make logs canonical** — logs stay observability.
- An **observation receipt** must identify: the source, the time, the hash/etag (if available), and
  the action taken (`summarize` / `raise_triage` / `propose_ticket` / `notify`).

## 13. Scheduling / cadence relationship

- A watcher's **cadence is not the existing process-template scheduler** and changes **no
  scheduled-token semantics**.
- Cadence must be **explicit and bounded** — **no sub-minute polling**, **no catch-up storm**.
- Cadence **never executes work**; it only produces **observation / proposal / triage /
  notification evidence**.

## 14. Failure / refusal behavior

- **Source unavailable** — record an observation failure; do not guess.
- **Permission denied** — record the denial; raise triage if a human should know.
- **Ambiguous delta** — raise triage.
- **Too many changes** — summarize a bounded subset and raise triage (no unbounded dump).
- **Duplicate observation** (same hash/etag) — no-op.
- **Archived Work Context** — no proposal unless explicitly allowed.
- **Unknown source** — refuse.

## 15. Non-goals

- **No watcher implementation in r1.25.**
- No connectors; no model/provider routing.
- No target mutation; no hidden execution; no private agent channel; no auto-run.
- No process-template trigger changes; no scheduler/token changes.
- No memory system; no chat UI; no notification integration yet.

## 16. Recommended r1.26 implementation slice

`r1.26-bounded-watcher-implementation` — the **smallest** slice:

- add a **watcher data store** (`data/watchers.json`);
- add **minimal admin list/detail** (gated by an explicit watcher/observe permission);
- add a **read-only/manual "observe now"** against a **local fixture or the existing target
  provider only** (no connectors);
- produce an **observation receipt**;
- optionally **raise triage or create a ticket proposal** — **not** ticket execution;
- **no automatic background daemon** unless explicitly bounded and tested;
- **no** connectors, **no** target mutation, **no** model routing, **no** hidden work.

## 17. Recommended tests for r1.26

- watcher CRUD creates **no ticket/run/workspace mutation**;
- observe reads **only the bounded source**;
- an **observation receipt is recorded**;
- a **duplicate observation no-ops**;
- a **source-unavailable** observation records a failure (no guess);
- a **permission-denied** observation does not retry secretly;
- an **ambiguous delta raises triage**;
- a **proposal is not execution** (no run created);
- an **approved proposal creates a normal ticket through `ticket:create` only**;
- an **archived Work Context blocks proposals**;
- **no scheduler-token changes**, **no target mutation**, **no hidden run**;
- the **timeline shows observation/proposal evidence without a new ledger**.

## 18. Risks

**P0**

- watcher becomes a **hidden scheduler/executor**;
- watcher **mutates targets**;
- watcher **creates tickets without authority**;
- watcher **wakes agents directly**;
- watcher **leaks across Work Contexts**;
- watcher treats **logs as canonical evidence**.

**P1**

- watcher creates **notification noise**;
- **duplicate observations spam triage**;
- the **proposal/triage boundary is unclear**;
- cadence creates **polling storms**;
- source snapshots **lack stable hashes/etags**.

**P2**

- **naming confusion** with schedule/process template;
- **too much UI before connectors exist**;
- **demo fixtures look like product seed data**.

## 19. Final recommendation

- **Proceed to watcher implementation only as a bounded observer/proposer.**
- **Keep the handoff queue protocol** as the work-movement path.
- **Keep Ticket/Run** as the execution path.
- **Keep Work Context** as the scope boundary.
- **Keep Triage** as the judgment stop point.
- **Keep Timeline** as projection only.
- **Defer connectors and model routing** until watcher behavior is bounded and tested.

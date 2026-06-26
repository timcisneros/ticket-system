# Work Context Primitive Design Audit

## 1. Executive summary

**Work Context should exist — but only as a product-layer grouping above the runtime.** It is
an organizing envelope that groups related tickets, process templates, targets, authority
defaults, triage visibility, schedules, participants, and scenario/demo work so an operator can
reason about "a body of work" instead of a flat list of tickets. It supplies **defaults and
filters**, nothing more.

Work Context **must not become a new execution path.** Every behavior that actually changes the
world stays exactly where it is today: execution happens through a **Run**, mutation happens
through a **Target Provider**, mutation requires **Authority**, results produce **Evidence**, and
correctness is judged by **Verification** and surfaced through **Triage**. Work Context adds no
new way to run work, no new way to mutate a target, and no new authority. It is a lens and a set
of defaults, not a runtime concept.

The recommended next step (r1.20) is the **smallest possible** implementation slice: a data
store, minimal admin/seed management, a **nullable** `workContextId` on future
tickets/templates/schedules, and context-filtered listing — with **no runtime execution change,
no authority widening, no watcher, no connector, no memory system, and no model routing.**

## 2. Current primitive map

The runtime today is built from a small set of frozen primitives, each with a single role and a
durable home (see `docs/RUN_EVIDENCE_AUTHORITY_SOURCE_OF_TRUTH_AUDIT.md`,
`docs/AUTHORITY_AND_DURABILITY.md`, `docs/TARGET_PROVIDER_CONTRACT.md`):

| Primitive | Home / source of truth | Role |
| --------- | ---------------------- | ---- |
| **Ticket** | `data/tickets.json` | Live record of work intent: objective, assignment, policy, status, provenance, ticket-level triage. |
| **Run** | `data/runs.json` | The only execution unit: attempt state, status, error, policy/verification snapshots, replay reference, evaluation, run-level triage. |
| **Authority** | permissions/groups + per-run authority decisions in the event ledger | What an actor/run is allowed to do (e.g. `ticket:create`, writable roots, allowed operations). |
| **Target Provider** | `docs/TARGET_PROVIDER_CONTRACT.md` (r1.14) | The single contract through which any external mutation flows. |
| **Evidence / Event / Receipt** | `data/events.jsonl`, `data/operation-history.json`, `data/replay-snapshots/run-<id>.json` | Append-only chronology, durable mutation/commit receipts, per-run evidence bundle. |
| **Verification** | verification contracts + postconditions on runs (r1.16) | Independent judgment of whether the objective was met. |
| **Triage** | ticket-level + run-level triage records | Human-control surface for blocked/failed work. |
| **Process Template** | `data/process-templates.json` | Reusable ticket starter (manual + scheduled). |
| **Template Version Store** | `data/process-template-versions.json` (r1.12) | Append-only immutable version history; draft/activation. |
| **Schedule** | template `schedule` object (interval/UTC) | Creates ordinary tickets on a bounded interval; token `schedule:<templateId>:<scheduledForIso>`, version-free, no catch-up. |
| **Timeline** | r1.18 projection | Read-only, deterministic, deduplicated projection over the above. Owns no state. |
| **Activation durability reconciliation** | r1.12.2 startup reconciler | Converges a template root pointer to the store's single active version after a crashed activation. |

Every one of these has exactly one job. Work Context must not absorb, replace, or duplicate any
of them.

## 3. Problem Work Context solves

Today the product surfaces are **flat and global**. Tickets, templates, schedules, and triage
are listed across the whole instance with no first-class notion of "which initiative does this
belong to." This creates real friction:

- An operator running several distinct initiatives (e.g. a legal-intake scenario, a compliance
  digest program, a demo) cannot see or filter "just this initiative's" tickets/triage/templates.
- Defaults that logically belong to an initiative — its default target, its authority profile,
  its allowed templates, its verification expectations — must be re-specified per ticket, by
  hand, every time.
- Business scenarios and demos are assembled by convention (naming, fixtures) rather than by a
  named grouping, so they are hard to scope, reset, or hand off.

Work Context solves **grouping, defaulting, and scoped visibility** — and only those. It gives an
initiative a name, a set of defaults, and a filter. It does not give it a new way to act.

## 4. What Work Context must not do

Work Context is explicitly **not** allowed to replace or reimplement any runtime primitive. It
must not become:

- a replacement for **Ticket** (work intent still lives on tickets),
- a replacement for **Run** (execution still happens only through runs),
- a replacement for **Authority** (it sets *defaults*, it never grants new power),
- a replacement for **Target Provider** (all mutation still flows through the provider contract),
- a replacement for **Evidence / Event / Receipt** (history still lives in the ledgers),
- a replacement for **Verification** (correctness is still judged independently),
- a replacement for **Triage** (human control still flows through triage),
- a replacement for **Process Template** or its **version store**,
- a replacement for **Schedule** (it filters schedules; it does not change scheduling semantics),
- a replacement for **Timeline** (timeline stays projection-only),
- a replacement for **template activation durability reconciliation**.

It must not create a second execution path, must not widen authority, must not create hidden
work, must not reinterpret old tickets/runs, and must not repair or override process-template
version consistency.

## 5. Proposed object shape

A purely declarative product-layer object. It holds **defaults, allow-lists, and filters** — no
execution state, no evidence, no authority grants.

```
WorkContext {
  id
  name
  purpose
  status                       // e.g. active | archived (visibility only, not a run state)
  defaultTargetId              // default Target Provider target for new work
  defaultAuthorityProfileId    // default authority profile (a ceiling/template, not a grant)
  allowedTargetIds             // allow-list a ticket may select from
  allowedCapabilities          // allow-list of capabilities a ticket may use
  allowedProcessTemplateIds    // templates considered "in" this context
  defaultVerificationProfile   // default verification expectations for new work
  memoryPolicy                 // scoping rules for any future context memory (default: isolated)
  visibilityPolicy             // who can see this context and its queues
  participants                 // users/groups associated with the context
  ticketQueueFilter            // derived filter over tickets.json (projection input)
  triageQueueFilter            // derived filter over triage (projection input)
  scheduleFilter               // derived filter over template schedules
  createdAt
  updatedAt
}
```

Notes:

- `default*` fields are **defaults**, applied at ticket/template creation time and then
  **snapshotted onto the ticket** — never read live during execution.
- `allowed*` fields are **ceilings/allow-lists** for the creation UI; they are not enforcement at
  the runtime layer (the runtime keeps enforcing real Authority independently).
- The `*Filter` fields are **projection inputs**, exactly like the r1.18 timeline: they read
  existing state and own none of it.

## 6. Invariants

These are the strict invariants any Work Context implementation must preserve:

1. **Work Context can set defaults.** New tickets/templates/schedules may inherit context defaults.
2. **Ticket can narrow defaults.** A ticket may choose a *more restrictive* target/authority/verification than its context's default.
3. **Ticket cannot silently exceed Work Context authority.** A ticket may never end up with more authority than the context default permits without an explicit, audited authority decision at the existing Authority layer.
4. **Every execution still occurs through a Run.**
5. **Every mutation still occurs through a Target Provider.**
6. **Every mutation still requires Authority.**
7. **Every result still produces Evidence.**
8. **Verification and Triage remain independent runtime concepts** — Work Context never judges correctness and never resolves triage on a run's behalf.
9. **Timeline remains projection-only** — Work Context adds a filter, not a new state owner.
10. **Work Context memory/context cannot leak into unrelated Work Contexts** (default `memoryPolicy` is isolated).
11. **Work Context cannot create hidden work** — no ticket or run exists that is not visible as an ordinary ticket/run.
12. **Work Context cannot reinterpret old tickets/runs** — existing provenance, `source.templateVersion`, and history are never rewritten or re-scoped retroactively.
13. **Work Context cannot repair or override process-template version consistency** — the r1.12.2 reconciler remains the sole authority over root/version-store convergence.

Because `workContextId` is **nullable**, every existing ticket/run/template/schedule remains
valid and unchanged with a null context — Work Context is strictly additive.

## 7. Relationship to current ticket system

Work Context sits **above** the ticket system as a grouping/defaulting layer:

- **Creation:** when a ticket (manual, or from a template/schedule) is created within a context,
  the context's `default*` values are used to *pre-fill* the ticket and are then **snapshotted
  onto the ticket** (like execution policy snapshots today). The ticket carries a nullable
  `workContextId` for grouping and a snapshot of any defaults it inherited.
- **Execution:** unchanged. `createTicketFromInput` / `createRunsForTicket` / `triggerProcessTemplate`
  read the ticket, not the context. The runtime never dereferences `workContextId` to decide
  what to do.
- **Listing/visibility:** ticket, triage, and template lists gain an optional context filter — a
  projection over existing data, identical in spirit to the r1.18 timeline.
- **Authority:** unchanged at the enforcement layer. Context authority defaults are a *creation-time
  ceiling/prefill*, never a live grant. Real authority decisions still happen per run and are
  still recorded in the event ledger.

## 8. Relationship to business scenarios

Business scenarios and fixtures (`docs/BUSINESS_FIXTURE_SPEC.md`,
`docs/WORKSPACE_FIXTURE_CATALOG.md`, `docs/BUSINESS_SCENARIO_VERIFICATION_CONTRACTS.md`) are today
assembled by naming convention and seed scripts. Work Context gives a scenario a **first-class
named home**: a scenario becomes a Work Context with its default target, allowed templates, and
verification profile, plus a clean filter for its tickets/triage. This makes scenarios easier to
seed, demo, reset, and hand off — **without** changing how any scenario's work actually executes
or verifies. Demo seeding (`scripts/seed-demo-data.js`) could later group the existing demo
tickets/templates under one or two Work Contexts, purely as organization.

## 9. Relationship to bounded future watcher/ambient behavior

Work Context is the **natural scope** for a future, strictly-bounded "watcher" (ambient
observation of a context's sources). This audit pre-commits the watcher's hard boundaries so the
grouping layer is never confused with an autonomous actor. A future watcher:

- **may** observe context sources,
- **may** summarize,
- **may** raise triage,
- **may** propose a ticket,
- **may** notify,
- **may not** mutate targets,
- **may not** run arbitrary templates,
- **may not** bypass authority,
- **may not** spawn child work without ticket creation,
- **may not** wake agents directly,
- **must** be auditable.

In short: a watcher may *observe, summarize, raise triage, propose, and notify* — every actual
change still goes through an ordinary **ticket → run → target provider → evidence** path under
real authority. The watcher is **out of scope** for r1.19 and r1.20; only its constraints are
recorded here.

## 10. Product UI implications

- A **context switcher** / context list as a top-level organizing surface.
- Context-scoped **ticket**, **triage**, and **template/schedule** lists (filtered projections).
- A context **settings** view for defaults and allow-lists (admin-gated).
- Ticket/template creation forms that **pre-fill** from the active context's defaults and show
  what was inherited vs. narrowed.
- No workflow builder, no rich editing surface, no new execution controls. The UI remains a
  visibility/navigation/human-control surface, consistent with the rest of the product.

## 11. Data migration strategy

- Add `data/work-contexts.json` as a new store. Absence/empty is valid (no contexts).
- Add a **nullable** `workContextId` to tickets/templates/schedules **for new records only**.
  Existing records keep `workContextId: null` (or absent) and behave exactly as today.
- **No backfill, no retroactive grouping, no rewrite** of existing tickets/runs/ledger/provenance.
- Normalization helpers treat a missing `workContextId` as null; all read paths must tolerate
  null. Deleting/archiving a context must never delete or rewrite its tickets/runs/evidence — it
  only changes grouping/visibility.

## 12. Test strategy for future implementation

When r1.20 implements this, tests should assert:

- a null `workContextId` preserves all existing behavior (no regression on any current test);
- context defaults are **snapshotted** onto created tickets and not read live during execution;
- a ticket can **narrow** but never silently **exceed** a context's authority default;
- context-filtered listing is a **pure projection** (no mutation, read-only) — mirroring the
  r1.18 timeline read-only assertions;
- creating/archiving/deleting a context creates no ticket/run/token/workspace mutation and never
  rewrites existing tickets/runs/ledger/provenance;
- scheduled tokens remain `schedule:<templateId>:<scheduledForIso>` (version-free) regardless of
  context;
- process-template version activation and the r1.12.2 durability reconciler are unaffected;
- memory/context isolation: nothing from one context is observable from another by default.

## 13. Risks

- **Scope creep into an execution path.** The biggest risk is Work Context quietly becoming a
  place where "work happens." Mitigation: the runtime never dereferences `workContextId`; defaults
  are snapshotted at creation; invariants 4–8 are enforced by test.
- **Authority confusion.** Treating context authority defaults as live grants would widen
  authority. Mitigation: defaults are creation-time prefill/ceiling only; real enforcement stays
  at the Authority layer (invariant 3).
- **Retroactive re-scoping.** Backfilling `workContextId` onto historical tickets would reinterpret
  old provenance. Mitigation: new-records-only, nullable, no backfill (invariant 12).
- **Memory leakage.** A future memory/context system could leak across contexts. Mitigation:
  `memoryPolicy` defaults to isolated; out of scope until explicitly designed (invariant 10).
- **Watcher overreach.** A future watcher could be mistaken for an autonomous actor. Mitigation:
  the §9 constraints are pre-committed; watcher is excluded from r1.19/r1.20.
- **Durability interference.** Context logic must never touch version-store/root reconciliation
  (invariant 13).

## 14. Recommended r1.20 implementation slice

`r1.20-work-context-primitive-implementation` — the **smallest** useful slice only:

- add a Work Context **data store** (`data/work-contexts.json`);
- add **minimal admin/seed management** (create/list/archive; admin-gated);
- add a **nullable `workContextId`** on future tickets/templates/schedules **if safe** (null-tolerant
  everywhere, no backfill);
- add **context-filtered** ticket/triage/template listing (pure projection);
- **no runtime execution behavior change**;
- **no authority widening**;
- **no watcher**;
- **no connector**;
- **no memory system**;
- **no model routing**.

Everything beyond this slice (watcher/ambient, memory, connectors, model routing, rich UI) is
explicitly deferred and gated behind its own future audit.

## 15. Final recommendation

**Adopt Work Context as a product-layer grouping primitive, not a runtime primitive.** It should
exist to group and default and filter — tickets, templates, targets, authority defaults, triage
visibility, schedules, participants, and scenario/demo work — and nothing more. It must preserve
every invariant in §6: execution through Runs, mutation through the Target Provider under
Authority, results as Evidence, independent Verification and Triage, projection-only Timeline,
isolated context memory, no hidden work, no retroactive reinterpretation, and no interference with
template version durability. Proceed with the minimal r1.20 slice in §14; keep watchers,
connectors, memory, and model routing out until each earns its own audit.

# Work Context Visibility Surface

r1.21 adds a **shared visibility surface** over the r1.20 Work Context primitive
(`docs/WORK_CONTEXT_PRIMITIVE.md`). It lets an operator open one Work Context and see the related
tickets, triage, process templates, schedules, and recent runs in one place.

## What it is

- A **read-only** detail page at `GET /work-contexts/:id` and a JSON summary at
  `GET /api/work-contexts/:id/summary` (both gated by `workContext:manage`).
- The list page `GET /work-contexts` now shows cheap per-context counts and links each context to
  its detail page.
- Everything shown is **derived live** from the existing stores — tickets, runs, process
  templates, and triage — filtered to one `workContextId`.

The summary returns: the Work Context record; bounded, deterministically-ordered lists of context
tickets, unresolved ticket/run triage, process templates (with schedule/due status), and recent
runs; plus counts (`ticketCount`, `openTicketCount`, `blockedTicketCount`,
`unresolvedTriageCount`, `processTemplateCount`, `scheduledTemplateCount`, `recentRunCount`).

## What it is NOT

- **Not a new source of truth.** It persists nothing. There is no context summary file and no
  context timeline ledger; every field is computed on read from the existing stores.
- **Not an execution path.** Viewing the list, detail, or summary creates no ticket, run,
  schedule, trigger token, or workspace change, and writes no log or event.
- **Not a watcher, memory system, connector, chat, or automation surface.** It has no controls
  that mutate anything; it only links to the existing ticket, triage, process-template, run, and
  ticket-timeline pages.

## Sources it reuses

| Shown | Source |
| ----- | ------ |
| Context tickets | `tickets.json` filtered by `workContextId` |
| Triage | ticket-level + run-level triage already on those tickets/runs |
| Process templates + schedule/due status | `process-templates.json` via the existing `deriveProcessTemplateState` |
| Recent runs | `runs.json` for context tickets |
| Timeline | links to existing per-ticket timeline (r1.18); no context timeline is created |

## Invariants preserved

- The runtime never dereferences `workContextId` during execution; this surface only reads.
- Filters are unchanged: `/tickets?workContextId=`, `/triage?workContextId=`,
  `/process-templates?workContextId=`. Uncontexted/critical triage stays visible by default and is
  only narrowed when the operator explicitly filters.
- Timeline source precedence (r1.18) is unchanged. Authority, Target Provider, Verification,
  Triage, scheduling, scheduled-token semantics, and the r1.12.2 activation-durability reconciler
  are all untouched. Old tickets/runs/evidence are never rewritten and nothing is backfilled.

# Work Context Primitive

Work Context (r1.20) is a **product-layer grouping above the runtime**. It groups related
tickets and process templates, supplies a few creation-time defaults/allow-lists, and scopes
listings. It is the smallest implementation of the design recorded in
`docs/WORK_CONTEXT_PRIMITIVE_DESIGN_AUDIT.md`.

> **Storage status:** The `data/work-contexts.json` storage detail below describes the
> **retired JSON adapter** and is kept as history. Current production persistence
> authority is PostgreSQL (work-context catalog migration `015`,
> `persistence/postgres/store.js`; canonical authority `docs/POSTGRES_CUTOVER.md`).
> The Work Context semantic contract below remains current.

## What Work Context is

- A named grouping with a `status` (`active` | `archived`), defaults, allow-lists, and filter
  fields. Stored in `data/work-contexts.json`.
- A creation-time convenience: when a ticket or template is assigned to a context, the context's
  identity is **snapshotted onto the record** (`workContextId` + a small `workContextSnapshot`
  with `id`/`name`/`purpose`/`status`).
- A read-only listing filter: tickets, triage, and process templates can be filtered by
  `?workContextId=<id>`.

## What Work Context is NOT

Work Context is **not**:

- an **execution path** — it never creates a run, never mutates a target, never creates hidden
  work. Creating/updating/archiving a context produces no ticket, run, schedule, trigger token,
  workspace change, or execution event;
- an **Authority** replacement — its allow-lists can only *narrow* what a new record may use; they
  never widen authority. Real authority enforcement stays at the runtime layer;
- a **Target Provider** replacement — all mutation still flows through the target provider;
- a **Timeline** replacement — the timeline stays projection-only; a context only contributes a
  display label;
- a **watcher**, **connector**, **memory system**, or **model/provider router** — none of these
  are added here.

## Nullable `workContextId` behavior

- `workContextId` is **nullable** on tickets and process templates. Old records have no context
  and behave exactly as before — they render safely with no Work Context label.
- There is **no backfill**: existing tickets/runs/templates are never retroactively grouped.
- For a **new** assignment, an unknown context id is rejected, and an **archived** context is
  rejected. A null/absent context is always valid.
- When a context's non-empty allow-lists are set, a new assignment that would exceed them
  (capability not in `allowedCapabilities`, target not in `allowedTargetIds`, template not in
  `allowedProcessTemplateIds`) is rejected.

## Defaults apply only at creation time

Context defaults/allow-lists are evaluated **once, at creation/assignment time**, and the result
is snapshotted onto the record. The runtime **never dereferences `workContextId` during
execution** — it reads the ticket's own fields. Consequently, **changing a context later never
reinterprets old tickets or runs**: an existing ticket keeps the snapshot it captured.

## Runtime is unchanged

Every piece of work still runs through the same substrate:

```
Ticket → Run → Authority → Target Provider → Evidence
```

Verification and Triage remain independent runtime concepts. Scheduling, scheduled-token
semantics (`schedule:<templateId>:<scheduledForIso>`, version-free), process-template version
activation, and the r1.12.2 activation-durability reconciler are all untouched by Work Context.

## Management surface

Gated by the `workContext:manage` permission:

- `GET /api/work-contexts` — list
- `POST /api/work-contexts` — create
- `POST /api/work-contexts/:id` — update / archive (set `status: "archived"`)
- `GET /work-contexts` — minimal list page (with per-context filtered-view links)
- `POST /api/process-templates/:id/work-context` — tag/clear a template's context

Archiving a context never deletes its tickets, runs, or evidence — it only changes grouping and
blocks **new** assignments to it.

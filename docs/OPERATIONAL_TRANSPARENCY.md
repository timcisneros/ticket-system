# Operational Transparency

The operational transparency surface is a **read-only** view of runtime health and boundaries. It
adds **no execution behavior** and **no new source of truth** — every value is derived live from
existing stores or in-process runtime state.

## What it is

- A read-only summary at `GET /api/ops/summary` (gated by `ops:read`) and a page at `/ops`.
- The summary is computed on each read from live runtime state plus `tickets.json`, `runs.json`, `work-contexts.json`,
  `watchers.json`, `watcher-observations.json`, `connectors.json`, `connector-receipts.json`,
  `model-routing-policies.json`, `process-templates.json`, and `logs.json`.
- It writes **nothing** — no ticket/run/log/event/receipt mutation, no workspace change, and **no
  ops summary file** is ever created.

## What the counts mean

- **tickets** — `total / open (open+in_progress) / blocked / completed / failed`.
- **runs** — `total / running (running+pending) / completed / failed / interrupted`.
- **triage** — unresolved ticket-level and run-level triage counts, plus a bounded recent list.
- **workContexts** — `active / archived / total`.
- **watchers** — `active / paused / archived`, plus recent `failed`/`refused` observations.
- **connectors** — `active / paused / archived / total`, plus recent refused receipts.
- **modelRoutingPolicies** — `active / archived / total`.
- **processTemplates** — `total / enabled / disabled / scheduled / pausedSchedule`.
- **schedules** — `enabled / disabled` (derived from template schedule state).
- **eventJournal** — effective process-local batch, record, and outstanding-admission capacity;
  current queued/active/outstanding work; utilization and high-water marks; durable commit
  totals/timing; and rejection counts. These metrics do not cap or report total `events.jsonl`
  growth and are not a new evidence ledger.
- **recent\*** lists — bounded (≤10), deterministically ordered (id desc).

## What the warning flags mean

`warnings` are booleans that flag a boundary worth a human look — they are **signals, not actions**:

- `unresolvedTriageExists`, `blockedTicketsExist`, `failedRunsExist` — work needs human attention.
- `connectorReadRefusalsExist`, `watcherFailedOrRefusedExist` — bounded adapters recorded refusals/
  failures (expected to surface, not silently swallow).
- `noActiveWorkContexts`, `noRoutingPolicies`, `noConnectors` — configuration gaps.
- `versionConsistencyUnresolved` — the r1.12.2 reconciler logged an unresolved root/version-store
  mismatch for manual review.
- `eventJournalPressureExists` — the journal failed, rejected an append under backpressure, or is
  currently at least 80% utilized. Backpressure remains fail-closed so evidence is never silently
  dropped; tune process-local admission from measurements and advance to shared durable storage
  before one process becomes the deployment bottleneck.

## No remediation

The `/ops` page is **visibility only**: it shows counts, warnings, bounded recent failure/refusal
lists, and links to the existing pages (tickets, triage, Work Contexts, watchers, connectors, model
routing, process templates, logs). It has **no remediation, rerun, retry, or mutation controls** and
no auto-refresh.

## How this supports release readiness

Before release-candidate work, an operator can answer "what exists, what is active, what is blocked,
what is unresolved, and does any source-of-truth boundary look unhealthy?" from one read-only place —
without touching runtime behavior. It is a **lens**, not a control surface.

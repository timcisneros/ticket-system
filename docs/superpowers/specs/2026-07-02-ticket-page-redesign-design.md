# Ticket Page Redesign — Design (Approach A)

**Date:** 2026-07-02
**Status:** Approved direction; pending spec review
**Scope:** Restructure the ticket detail view (`views/ticket-detail.ejs`) and supporting styles (`src/styles.css`). Information-architecture change only — no new lifecycle semantics, endpoints, or data model changes.
**Mockup:** `scratchpad/ticket-redesign-mockup.html` (published artifact) — the visual reference for this spec.

## Problem

`views/ticket-detail.ejs` renders ~19 `.detail-section` blocks in a single flat column, all at equal visual weight, in an order that does not match the operator's task. The audit found four structural problems:

1. **The same state is told 3+ times with no clear authority.** Ticket status appears in the header badge, in *Execution State* ("Latest run / Last outcome"), and again in *Runtime* ("Ticket Status"). "Current message" appears in both *Execution State* and *Runtime*. *Execution State* (server-rendered) and *Runtime* (live-polling) are near-duplicates separated by six unrelated sections; the live one is buried 10th.
2. **The live pulse sits below recorded-intent boilerplate.** *Execution Policy* repeats "recorded intent, not enforced" ~7 times and renders above the live *Runtime* block.
3. **Five overlapping evidence surfaces** are stacked as peers: *Execution Attempts*, *Runs*, *Artifacts*, *Timeline*, *Recent Activity*, *Operation History*. Attempts and Runs are near-duplicate per-run tables; triage also re-appears inside Timeline.
4. **No "does this need me?" zone.** Blocked reason, triage (up to 4 blocks), review status, and state warnings are scattered top-to-middle at the same weight as everything else.

Root cause: the page has no information architecture. Every fact is equal weight, so nothing is.

## Goal

Reorganize the page into four ordered zones, each answering one operator question, using progressive disclosure so a scanner and a deep operator are both served. Preserve the existing single scrolling column, component vocabulary (`.detail-section`, `.collapsible`, `.status-badge`, `.detail-grid`, `.tickets-table`), palette, and status semantics. No tab framework; no new server endpoints.

## Information Architecture — Four Zones

Render order top to bottom:

### Zone 1 — "At a glance" (What is this, and what's it doing right now?)
A single summary hero replacing the header + *Execution State* + *Runtime* trio.

- Identity: `Ticket #<id>`, status badge, objective.
- Primary actions inline: Retry/Rerun, Test gate, Test agent plan, Ticket Logs.
- **One canonical live-status block** (the merge): latest/active run link + status, assigned-to, last outcome, current step, elapsed, current message, plus the live-poll pulse and lease line.
- **Source of truth:** the existing live-runtime block (`#ticket-runtime-section` + `/api/tickets/:id/runtime` polling) is the canonical live surface. Fields unique to the old *Execution State* block that are *not* live (assignment target label, auto-run behavior, template/work-context provenance, group fan-out summary) move: assignment/provenance to Zone 3, the live subset to the hero. The standalone *Execution State* section is removed; no field is dropped, each lands in exactly one place.

### Zone 2 — "Needs your attention" (Does it need me, and what do I decide?)
Rendered **only when at least one attention item is active.** Consolidates, in severity order:

- Blocked reason / feasibility ("Why this ticket is blocked").
- Ticket-level triage (required + resolved variants).
- Latest-run triage (required + resolved variants).
- Review status (needs-review flag + reasons).
- Runtime state-inconsistency warning.

Each item is an `.attn` card with a left severity stripe (critical = red for required triage/blocked; warning = amber for review/warnings). Triage resolve forms keep their existing behavior and endpoints (`/api/tickets/:id/triage/resolve`, `/api/runs/:id/triage/resolve`). When nothing is pending, the entire zone (and its heading) is absent.

### Zone 3 — "How it's set up" (How is this ticket configured?)
Collapsed `<details>` disclosures, closed by default except "Assignment & work split":

- **Assignment & work split** — worker/group, assignment mode, work-split mode, work context, template provenance, auto-run, dynamic folder-scope map. Absorbs the config half of the old *Execution State* plus *Work Split Details* and *Ticket Details*.
- **Execution policy** — unchanged fields, but "recorded intent, not enforced" rendered as a muted qualifier (`.intent`) rather than repeated body text; the max-attempts control stays.
- **Ticket details** — created/updated/changed-by metadata.

Work Units (group allocation) render inside Zone 3 when a group allocation plan exists, under the assignment disclosure.

### Zone 4 — "What has happened" (What did the system actually do?)
One evidence group under a single zone header, as **stacked collapsibles** (framework-free — resolved open question 1):

- **Runs & attempts** — a single table. Merges *Runs* and *Execution Attempts*: base columns (Run #, Agent, Status, Outcome, Created) always shown; attempt-specific metrics (attempt #, duration, model reqs, workspace ops, mutating ops, verification, triage) shown as additional columns when attempt data exists, or a per-row expand. The separate *Execution Attempts* section is removed (resolved open question 2). Budget Advisory folds in as a caption/summary under this table.
- **Timeline** — the existing read-only projection, unchanged; remains the canonical chronology. Collapsed by default.
- **Artifacts** — unchanged table, collapsed by default.
- **Operation history** — unchanged, collapsed by default.
- *Recent Activity* is removed as a distinct section; its entries are already represented in Timeline (labeled `diagnostic_log`).

## Resolved Decisions

1. **Evidence presentation:** stacked collapsibles, not JS tabs. Keeps Ctrl-F/scan and deep-linking working, no framework. (The mockup shows a segmented control for illustration; the build uses collapsibles.)
2. **Attempts + Runs:** merged into one table with optional metric columns; separate Attempts table removed.
3. **Sticky summary rail** (Approach B borrow): **out of scope** for this change; recorded as a possible future desktop enhancement.

## Non-Goals

- No changes to run execution, lifecycle events, triage semantics, or authority model.
- No new API endpoints or server routes. The runtime-polling endpoint and all resolve/rerun/simulate/recovery endpoints are reused unchanged.
- No data-model or persistence changes.
- No removal of any datum — every field currently shown lands in exactly one zone.
- Mobile parity is preserved (single column already responsive); no separate mobile design.

## Implementation Surface

- **`views/ticket-detail.ejs`** — re-sectioned into the four zones. Existing per-item EJS logic (feasibility, triage variants, allocation items, runtime script, recovery/simulate/rerun scripts) is reused; primarily reordered and re-wrapped. The live-runtime `<script>` block and the `canUpdateTickets` action scripts are preserved verbatim.
- **`src/styles.css`** — add zone-header (`.zone`, `.zone-eyebrow`, `.zone-q`), hero (`.hero`, `.live`), attention (`.attn` + severity variants), disclosure-row, and merged-table styles, reusing existing tokens. No token/palette changes.
- **View model:** no new server-provided variables required. The merge consolidates fields already passed to the template (`ticket`, `executionState`, `ticketRuns`, `attemptSummary`, `budgetSummary`, `timeline`, `artifacts`, `operationHistory`, triage vars). If any field currently comes *only* from `executionState`, it continues to be read from `executionState`; only its on-page location changes.

## Verification

- Render the page in each meaningful state and confirm no field is lost vs. the current page and no duplicate remains:
  - open/unassigned ticket, running ticket (live poll active), completed ticket, failed ticket with required triage, group ticket with allocation plan, blocked (feasibility) ticket, resolved-triage ticket.
- Confirm Zone 2 is entirely absent when no attention item is active.
- Confirm live-poll behavior (SSE + interval + terminal reload) still works after the hero merge.
- Confirm resolve/rerun/simulate/recovery actions still function (endpoints unchanged).
- Confirm no horizontal body scroll at mobile width; wide tables scroll within their own container.

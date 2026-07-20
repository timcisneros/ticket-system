# Run Page Redesign — Design

**Date:** 2026-07-02
**Status:** Approved direction; pending spec review
**Scope:** Restructure the run detail view (`views/run-detail.ejs`, ~1397 lines, ~25 sections) into the four operator-question zones already established for the ticket detail page. Information-architecture change only — no new lifecycle semantics, endpoints, or data-model changes.
**Depends on:** `redesign-ticket-page` (this branch is based on it) for the shared CSS component layer (`.zone`, `.zone-head`, `.hero`, `.live`, `.attn`, `.disclosure`, spacing scale in `src/styles.css`). Rebase onto `master` after the ticket PR merges.

## Problem

`views/run-detail.ejs` renders ~25 `section`/`h2` blocks in a flat single column at equal visual weight: failure/triage/review, usage/limits/budget/policy, run summary, context, artifacts, authority, recent activity, replay snapshot (prompts, provider requests, model responses), workspace actions, events, operation history, diagnostics. Same failure mode as the pre-redesign ticket page — no information architecture, so the operator's core question ("did this run do what I wanted, and did it finish?") is buried under developer-level model/replay debug output.

## Goal

Reorganize into the four zones proven on the ticket page, reusing its component vocabulary and spacing scale, with a run-specific split in the evidence zone so operator-level and developer-level evidence are separated. No tab framework; single scrolling column; no new server endpoints.

## Information Architecture — Four Zones

### Zone 1 — "At a glance" (What is this run, and what's it doing?)
A summary hero: `Run #<id>` + status badge; a prominent link back to the parent ticket (and the agent); current phase/step; operational outcome; timing (started / elapsed / completed) and mutation count. If the run is active, live-updating — preserve the page's existing live/runtime script and every element id/attr it binds to, unchanged. Sourced from the current header + `Run Summary` section.

### Zone 2 — "Needs your attention" (Does it need me, and what do I decide?)
Rendered only when an attention item is active. Consolidates, as `.attn` severity cards: *Why this run stopped*, *Triage Required* / *Triage (resolved)*, *Review status*, *State Warning*, *Failure Summary* (with its "Raw failure details" kept as a nested collapsible). Triage resolve forms keep their existing endpoints/behavior.

### Zone 3 — "How it's set up" (How was this run configured?)
Collapsed `<details class="disclosure">`: *Execution Policy Snapshot*, *Runtime limits and usage*, *Usage / Attempt*, *Run Context*, *Authority & Scope*. First disclosure open by default.

### Zone 4 — "What has happened" — two tiers (What did it actually do?)
One zone, two tiers so the operator answer is not buried under model/replay debug:

- **Operator evidence (surfaced first):** *Workspace Actions* renders as an always-open card (the primary "what changed" surface, mirroring the ticket page's always-open Runs table); *Artifacts* (Artifact Prediction + Unexpected Actual Artifacts), *Operation History*, *Events*, and *Budget (advisory)* are collapsed `<details class="disclosure">`.
- **Developer evidence (collapsed group "Model interaction & raw evidence"):** the deep Replay Snapshot internals — *Prompt Instructions*, *Provider Requests*, *Model Responses*, *Technical Runtime Details*, *Allowed Workspace Actions*, *Operational Events*, *Permissioned Cross-Ticket Delete*, *Diagnostics*, *Replay Snapshot* path/metadata. Each remains a collapsible within this group; the group itself is collapsed by default.

*Recent Activity* is removed as a standalone section (as on the ticket page) — its entries are already represented in Events/Timeline-equivalent evidence.

## Non-Goals

- No changes to run execution, replay, triage, authority, or budget semantics.
- No new API endpoints or routes; reuse all existing resolve/recovery/live-runtime endpoints unchanged.
- No data-model or persistence changes.
- No datum removed — every field currently shown lands in exactly one zone (Recent Activity is the sole intentional removal, and only because it duplicates Events evidence; verified by field-parity audit).
- No changes to the ticket page or shared components beyond what the run page consumes.

## Implementation Surface

- **`views/run-detail.ejs`** — re-sectioned into the four zones; existing per-item EJS logic and all `<script>` blocks (live/runtime, triage-resolve, recovery, any collapsible JS) reused and relocated, not rewritten.
- **`src/styles.css`** — reuse the ticket page's component layer as-is. Add only a small rule for the Zone 4 "Model interaction & raw evidence" group wrapper if needed (e.g. a nested-disclosure group container). No token/palette changes.
- **View model:** no new server-provided variables. The redesign consolidates fields already passed to the template.
- **Tests:** extend `scripts/page-render-regression-test.js` with run-detail assertions (zone eyebrows present; attention zone conditional; two-tier evidence group present; no `Recent Activity`; deep replay content still reachable). Update, do not touch, the existing `runDetail` assertions that remain valid; the run-detail page must still expose "Run Outcome". The current harness asserts `runDetail.body.includes('Recent Activity')` — that assertion changes with this redesign.

## Verification

- Screenshot-verify (headless Chromium against a seeded copy of the data dir, as used for the ticket page) across meaningful run states: active/running run (live update), completed run, failed run with triage, blocked run, run with workspace mutations + artifacts, run with a full replay snapshot (prompts/provider/model), resolved-triage run.
- Confirm Zone 2 absent when no attention item is active.
- Confirm the live/runtime script still updates after the hero merge (all bound ids preserved).
- Confirm triage-resolve / recovery actions still function (endpoints unchanged).
- Field-parity audit vs. the pre-redesign template: 0 real datum losses.
- No horizontal body scroll at mobile width; wide tables scroll within their own container.

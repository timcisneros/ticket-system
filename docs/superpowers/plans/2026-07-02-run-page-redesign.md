# Run Page Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restructure `views/run-detail.ejs` from a flat ~25-section stack into the four operator-question zones already proven on the ticket page, with a two-tier evidence zone (operator-level surfaced, developer-level replay/model debug collapsed).

**Architecture:** Pure view + minimal stylesheet change. `run-detail.ejs` is re-sectioned; it reuses the ticket page's CSS component layer (`.zone`, `.zone-head`, `.hero`, `.live`, `.attn`, `.disclosure`, spacing scale) already in `src/styles.css` on this branch. Only one small CSS addition (the Zone 4 developer-evidence group wrapper) is needed. No server routes, endpoints, or data-model changes. Tests are HTTP render assertions added to `scripts/page-render-regression-test.js`.

**Tech Stack:** EJS 5 templates, Fastify (`server.js`), plain CSS (`src/styles.css`), the render harness in `scripts/page-render-regression-test.js`, headless-Chromium screenshot verification (Playwright installed in scratch, as used for the ticket page).

## Global Constraints

- Preserve verbatim every element id/attr consumed by the four `<script>` blocks in `run-detail.ejs`:
  - Live-poll (script ~line 1179): ids `run-live-status`, `run-live-outcome`, `run-live-completed`, `run-live-duration` (with `data-started-at`/`data-completed-at`), `run-live-message`, `run-live-event-status`, `run-live-event-error`.
  - Replay-jump/toggle (script ~1147): `id="replay-workspace-actions"`, and the item attrs `data-op-failure`, `data-op-mutation`, `data-event-failure`; the `data-replay-jump="workspace|failure|mutation"` buttons; the toggle-all button; `data-replay-section` attrs.
  - Diagnostics copy (script ~1124): `id="run-diagnostics-bundle"`.
  - Actions (script ~1293) + buttons: `data-stop-run-id`, `data-retry-run-id`, `data-preview-recovery-id`, `data-confirm-recovery-id`.
  - Triage-resolve (script ~138) + form `data-resolve-url="/api/runs/<id>/triage/resolve"`.
- Keep all four `<script>` blocks intact; relocate the markup they bind to without changing the scripts.
- Jump targets must stay reachable: `#replay-workspace-actions` (Workspace Actions) and the `data-op-*`/`data-event-failure` items live in the surfaced operator tier (open), not inside the collapsed developer group.
- No new server-provided template variables. Reuse only locals already passed at `server.js:19937` (`run`, `ticket`, `agent`, `snapshot`, `authorityContext`, `failureSummary`, `operationHistory`, `permissionedDeleteAuditEvents`, `completionSummary`, `eventSummary`, `recentLogs`, `artifactPredictionComparison`, `artifactAccuracy`, `operationalOutcome`, `reviewStatus`, `budgetStatus`, `runStatusLabel`, `runtimeLimitsDisplay`, `runDiagnosticBundle`, `diagnosticsGeneratedAt`, `canUpdateRuns`, and the existing per-section vars).
- No datum dropped; every field lands in exactly one zone. `Recent Activity` is the sole intentional removal (duplicates Events).
- The run-detail page must still expose the text `Run Outcome` (existing harness assertion) and the collapsibles `<summary>Ticket Objective</summary>` and `<summary>Prompt Instructions</summary>` (existing assertions), now inside the Zone 4 developer group.
- Single scrolling column; no tab framework. Reuse existing tokens/classes; do not introduce a new palette.
- Test command for every task: `node scripts/page-render-regression-test.js` — PASS exits 0 and prints `{"mainFormRender":true,...}`; FAIL prints an Error stack. Also run `node --check server.js` (exit 0) before committing.
- Commit after each task. Branch is `redesign-run-page` (based on `redesign-ticket-page`).

---

## File Structure

- **`views/run-detail.ejs`** (modify) — the whole redesign; existing per-item EJS and all four `<script>` blocks reused, content relocated into four zones.
- **`src/styles.css`** (modify, append) — one addition: the Zone 4 developer-evidence group wrapper (`.evidence-group`). Everything else reuses the ticket page's component layer already present on this branch.
- **`scripts/page-render-regression-test.js`** (modify) — add run-detail zone assertions; update the `runDetail` `Recent Activity` assertion; keep the `Run Outcome` / `Ticket Objective` / `Prompt Instructions` assertions valid.

Source-block map (current line ranges in `views/run-detail.ejs`) → destination zone:

| Current block (lines) | Destination |
|---|---|
| header `Run #id` + Stop/Retry actions (1–20) | Zone 1 hero |
| partial-execution-banner (22–39) | Zone 2 |
| Why this run stopped (43–87) | Zone 2 |
| Triage Required (91–123) / Triage resolved (125–135) | Zone 2 |
| triage-resolve `<script>` (138–…) | keep, after Zone 2 |
| Usage / Attempt (158–171) | Zone 3 |
| Runtime limits and usage (184–197) | Zone 3 |
| Budget (advisory) (210–218) | Zone 4 operator tier |
| Execution Policy Snapshot (222–238) | Zone 3 |
| Review status (242–256) | Zone 2 |
| State Warning (260–270) | Zone 2 |
| Failure Summary + Raw failure details (274–357) | Zone 2 |
| Run Summary (360–519): live fields → Zone 1 hero; Run Context collapsible (453) → Zone 3; Operational Events collapsible (513) → Zone 4 dev group | split |
| Artifact Prediction + Unexpected Actual Artifacts (521–618) | Zone 4 operator tier |
| Authority & Scope (620–753) | Zone 3 |
| Recent Activity (757–770) | REMOVED |
| Replay Snapshot group (774–873): Replay Snapshot, Ticket Objective, Technical Runtime Details, Allowed Workspace Actions, Prompt Instructions, Provider Requests, Model Responses + replay-jump toolbar | Zone 4 developer group |
| Permissioned Cross-Ticket Delete (877–899) | Zone 4 developer group |
| Workspace Actions (902–966, `#replay-workspace-actions`) | Zone 4 operator tier (always-open) |
| Events (968–1004) | Zone 4 operator tier |
| Operation History (1008–1111) | Zone 4 operator tier |
| Diagnostics (1115–1123, `#run-diagnostics`) | Zone 4 developer group |
| `<script>` blocks (1124, 1147, 1179, 1293) | keep unchanged; markup they bind to keeps its ids/attrs |

---

### Task 1: Zone scaffolding + developer-group CSS

Add the one new CSS rule and wrap the existing content in four labeled zone headers **without moving content between zones yet** — keeps the page green.

**Files:**
- Modify: `src/styles.css` (append `.evidence-group` rule)
- Modify: `views/run-detail.ejs` (four zone headers)
- Modify: `scripts/page-render-regression-test.js` (zone-eyebrow assertions on `runDetail`)

**Interfaces:**
- Produces (CSS class later tasks consume): `.evidence-group`, `.evidence-group > summary`.
- Reuses (already on this branch): `.zone`, `.zone-head`, `.zone-eyebrow`, `.zone-q`, `.hero`, `.live`, `.attn`, `.disclosure`, `.intent`.

- [ ] **Step 1: Write the failing assertions.** In `scripts/page-render-regression-test.js`, immediately after the existing `const runDetail = await assertPageRenders(...)` line (~398), add:

```javascript
    assert(runDetail.body.includes('>At a glance<'), 'run detail should render Zone 1 eyebrow');
    assert(runDetail.body.includes("How it's set up") || runDetail.body.includes('>How it&#39;s set up<'), 'run detail should render Zone 3 eyebrow');
    assert(runDetail.body.includes('>What has happened<'), 'run detail should render Zone 4 eyebrow');
```

- [ ] **Step 2: Run to verify it fails.**

Run: `node scripts/page-render-regression-test.js`
Expected: FAIL with "run detail should render Zone 1 eyebrow".

- [ ] **Step 3: Append the developer-group CSS to `src/styles.css`** (after the ticket page's `.disclosure` rules):

```css
/* Zone 4 developer-evidence group: a disclosure that itself contains nested
   replay collapsibles. Slightly recessed so it reads as secondary. */
.evidence-group { margin-top: 12px; background: #fafafa; border: 1px solid #e5e7eb; border-radius: 10px; overflow: hidden; }
.evidence-group > summary { list-style: none; cursor: pointer; display: flex; align-items: center; gap: 10px; padding: 14px 20px; font-size: 14px; font-weight: 600; color: #374151; }
.evidence-group > summary::-webkit-details-marker { display: none; }
.evidence-group > summary::before { content: "\203A"; font-size: 18px; color: #9ca3af; transition: transform .15s ease; }
.evidence-group[open] > summary::before { transform: rotate(90deg); }
.evidence-group > .evidence-group-body { padding: 6px 16px 16px; border-top: 1px solid #e5e7eb; }
.evidence-group .detail-section { margin: 12px 0 0; }
@media (prefers-reduced-motion: reduce) { .evidence-group > summary::before { transition: none; } }
```

- [ ] **Step 4: Wrap existing content in four zones in `views/run-detail.ejs`.** Do not move content between zones yet. Open Zone 1 `<section class="zone">` with its header before the `Run #id` header block and close it after the `Run Summary` section (after current line 519). Then insert three bare zone headers, each guarded/placed as noted:
  - A Zone 2 header, guarded so it only prints when an attention item exists. Add this compute before it (using vars already in scope — verify names against the existing sections and adjust if a section uses a different guard):

```ejs
<% const runHasAttention = (typeof completionSummary !== 'undefined' && completionSummary && completionSummary.stopped)
  || (typeof triage !== 'undefined' && triage && (triage.required || triage.resolvedAt))
  || (typeof reviewStatus !== 'undefined' && reviewStatus && reviewStatus.applicable && reviewStatus.needsReview)
  || (typeof runStateInconsistency !== 'undefined' && runStateInconsistency)
  || (typeof failureSummary !== 'undefined' && failureSummary); %>
<% if (runHasAttention) { %>
<div class="zone-head" data-attn-zone><span class="zone-eyebrow">Needs your attention</span><span class="zone-q">Does it need me, and what do I decide?</span></div>
<% } %>
```
  Place it before the partial-execution-banner / "Why this run stopped" block. (If any guard var name differs, use the actual condition each of those sections already uses; the point is the header renders iff at least one attention section will render.)
  - A Zone 3 header before `<h2>Usage / Attempt</h2>`:
```ejs
<div class="zone-head"><span class="zone-eyebrow">How it's set up</span><span class="zone-q">How was this run configured?</span></div>
```
  - A Zone 4 header before `<h2>Budget (advisory)</h2>`:
```ejs
<div class="zone-head"><span class="zone-eyebrow">What has happened</span><span class="zone-q">What did the run actually do?</span></div>
```
  - The Zone 1 header:
```ejs
<div class="zone-head"><span class="zone-eyebrow">At a glance</span><span class="zone-q">What is this run, and what's it doing right now?</span></div>
```

- [ ] **Step 5: Run to verify it passes.**

Run: `node scripts/page-render-regression-test.js`
Expected: PASS, exits 0.

- [ ] **Step 6: Syntax check.** Run: `node --check server.js` → exit 0.

- [ ] **Step 7: Commit.**

```bash
git add src/styles.css views/run-detail.ejs scripts/page-render-regression-test.js
git commit -m "Add zone scaffolding and evidence-group CSS for run page redesign"
```

---

### Task 2: Zone 1 — run summary hero

Replace the `Run #id` header + the live fields of `Run Summary` with one hero, preserving every `run-live-*` id. The Run Context collapsible and Operational Events collapsible inside the old Run Summary section move to Zone 3 / Zone 4 respectively (carry them into temporary `<div id="run-zone-carry-config">` / `<div id="run-zone-carry-events">` at the top of Zone 3 / the Zone 4 dev area, so no field is lost between tasks).

**Files:**
- Modify: `views/run-detail.ejs` (header 1–20, Run Summary 360–519)
- Modify: `scripts/page-render-regression-test.js` (hero assertions)

**Interfaces:**
- Consumes: `.hero`, `.live` (ticket page CSS).
- Produces: hero markup retaining `run-live-status`, `run-live-outcome`, `run-live-completed`, `run-live-duration`, `run-live-message`, `run-live-event-status`, `run-live-event-error` (each exactly once), and the Stop/Retry action buttons.

- [ ] **Step 1: Write failing assertions.** After the Task 1 assertions add:

```javascript
    assert(runDetail.body.includes('id="run-live-status"'), 'hero must keep the live status id');
    assert((runDetail.body.match(/id="run-live-status"/g) || []).length === 1, 'live status id must be unique');
    assert(!runDetail.body.includes('>Run Summary</h2>'), 'standalone Run Summary heading should be merged into the hero');
    assert(runDetail.body.includes('Run Outcome'), 'hero must still expose Run Outcome');
```

- [ ] **Step 2: Run to verify it fails.** Run: `node scripts/page-render-regression-test.js` → FAIL with "standalone Run Summary heading should be merged".

- [ ] **Step 3: Build the hero.** Compose one `<div class="hero">` inside the Zone 1 `<section class="zone">` (reuse the single Zone-1 section/header from Task 1 — do not add a second "At a glance" header). The hero contains:
  - `<h1>Run #<%= run.id %></h1>` with `<span id="run-live-status" class="status-badge status-<%= run.status %>">…</span>` (move the existing `run-live-status` span into the h1 line; keep its exact id/markup).
  - A prominent link back to the parent ticket and the agent: `<p class="text-muted"><a href="/tickets/<%= ticket.id %>">Ticket #<%= ticket.id %></a> · <%= agent ? agent.name : 'Agent #' + run.agentId %></p>` (use the existing ticket/agent vars as the current template references them).
  - The Stop/Retry buttons (move the existing `data-stop-run-id` / `data-retry-run-id` buttons here, unchanged) in a `.hero-actions` div.
  - A `<dl class="live">` holding the live fields, moving these existing `<dd>` elements verbatim (keep every id): Run Outcome (`run-live-outcome`), Completed (`run-live-completed`), Duration (`run-live-duration` with its `data-started-at`/`data-completed-at`), Current message (`run-live-message`), Event status (`run-live-event-status`), Event error (`run-live-event-error`), plus static fields the old Run Summary showed at the top (phase/step, started-at, mutation count) — move each field's `<dt>/<dd>` into the `.live` grid; do not drop any.
  Remove the standalone `<h2>Run Summary</h2>` section wrapper. Close Zone 1 `</section>` immediately after the hero, before the Zone 2 header.

- [ ] **Step 4: Carry the non-hero Run Summary content.** The Run Summary section also contains a `Run Context` collapsible (~453) and an `Operational Events` collapsible (~513). Move `Run Context` into a `<div id="run-zone-carry-config">` placed right after the Zone 3 header, and `Operational Events` into a `<div id="run-zone-carry-events">` placed right after the Zone 4 header — verbatim, for Tasks 4/5 to fold in. No field lost.

- [ ] **Step 5: Run to verify it passes.** Run: `node scripts/page-render-regression-test.js` → PASS.

- [ ] **Step 6: Manually verify live polling.** Screenshot a running run (Task 6 has the harness); confirm the `run-live-*` fields exist exactly once (`grep -c` each id in the file).

- [ ] **Step 7: Syntax check + commit.**

```bash
node --check server.js
git add views/run-detail.ejs scripts/page-render-regression-test.js
git commit -m "Merge run header and Run Summary into Zone 1 hero"
```

---

### Task 3: Zone 2 — attention consolidation

Convert the partial-execution-banner, Why-this-run-stopped, both triage variants, Review status, State Warning, and Failure Summary into `.attn` cards under the Zone 2 header, rendered only when `runHasAttention`.

**Files:**
- Modify: `views/run-detail.ejs` (blocks 22–39, 43–87, 91–135, 242–357)
- Modify: `scripts/page-render-regression-test.js` (attention assertions)

**Interfaces:** Consumes `.attn`, `.attn.critical`.

- [ ] **Step 1: Write failing assertions.** Add:

```javascript
    assert(runDetail.body.includes('class="attn'), 'run detail attention items should render as .attn cards');
    assert(!runDetail.body.includes('<section class="detail-section failure-summary">'), 'Failure Summary should be an attention card, not a standalone detail-section');
```

- [ ] **Step 2: Run to verify it fails.** Run: `node scripts/page-render-regression-test.js` → FAIL.

- [ ] **Step 3: Build Zone 2.** Wrap all six attention blocks in the existing `<% if (runHasAttention) { %> … <% } %>` guard from Task 1. Convert each block's outer `<section class="detail-section …">` to `<div class="attn critical">` for stop/blocked/required-triage/failure, and `<div class="attn">` for resolved triage / review / warning. Keep each block's inner `<dl>`, tables, the "Raw failure details" nested `<details>`, and the `.triage-resolve` form (its `data-resolve-url` unchanged) verbatim. Prefix each card with `<h3><span class="sev">…</span> …</h3>`. Keep the triage-resolve `<script>` right after Zone 2.

- [ ] **Step 4: Run to verify it passes.** Run: `node scripts/page-render-regression-test.js` → PASS.

- [ ] **Step 5: Syntax check + commit.**

```bash
node --check server.js
git add views/run-detail.ejs scripts/page-render-regression-test.js
git commit -m "Consolidate run attention items into Zone 2 cards"
```

---

### Task 4: Zone 3 — configuration disclosures

Convert Usage/Attempt, Runtime limits and usage, Execution Policy Snapshot, Run Context (carried), and Authority & Scope into collapsed `<details class="disclosure">`; first open.

**Files:**
- Modify: `views/run-detail.ejs` (158–197, 222–238, 620–753, `#run-zone-carry-config`)
- Modify: `scripts/page-render-regression-test.js` (disclosure assertion)

**Interfaces:** Consumes `.disclosure`, `.disclosure .detail-grid`.

- [ ] **Step 1: Write failing assertion.** Add:

```javascript
    assert(runDetail.body.includes('<summary>Execution Policy Snapshot') || runDetail.body.includes('Execution policy'), 'Zone 3 should present execution policy in a disclosure');
```

- [ ] **Step 2: Run to verify it fails.** Run: `node scripts/page-render-regression-test.js` → FAIL (the current markup uses `<h2>Execution Policy Snapshot</h2>`, not a `<summary>`; adjust the assertion to the summary label you choose and confirm RED first).

- [ ] **Step 3: Build Zone 3.** Under the Zone 3 header, create `<details class="disclosure" open>` for "Run context" (fold in the carried `#run-zone-carry-config` content, then delete that div), then `<details class="disclosure">` for "Usage / attempt", "Runtime limits & usage", "Execution policy snapshot", and "Authority & scope" — each wrapping the section's existing `.detail-grid`/tables verbatim. Convert `.detail-grid` inside to stay (the ticket page CSS styles `.disclosure .detail-grid`). Use `<summary>Label <span class="sub">…</span></summary><div class="body">…</div>`.

- [ ] **Step 4: Run to verify it passes.** Run: `node scripts/page-render-regression-test.js` → PASS.

- [ ] **Step 5: Syntax check + commit.**

```bash
node --check server.js
git add views/run-detail.ejs scripts/page-render-regression-test.js
git commit -m "Collapse run configuration into Zone 3 disclosures"
```

---

### Task 5: Zone 4 — two-tier evidence

Surface operator evidence (Workspace Actions always-open + Artifacts / Operation History / Events / Budget as disclosures), and put the replay/model debug into one collapsed `.evidence-group`. Remove Recent Activity.

**Files:**
- Modify: `views/run-detail.ejs` (210–218 Budget, 521–618 Artifacts, 757–770 Recent Activity, 774–899 replay group + cross-ticket delete, 902–966 Workspace Actions, 968–1004 Events, 1008–1111 Operation History, 1115–1123 Diagnostics, `#run-zone-carry-events`)
- Modify: `scripts/page-render-regression-test.js` (update `Recent Activity` assertion; add tier assertions)

**Interfaces:** Consumes `.evidence-group`, `.disclosure`, `.detail-section`.

- [ ] **Step 1: Update the changed assertion + add new ones.** Replace the existing line `assert(runDetail.body.includes('Recent Activity'), 'run detail should include inline recent activity');` with:

```javascript
    assert(!runDetail.body.includes('>Recent Activity<'), 'Recent Activity should be removed from run detail (duplicates Events)');
    assert(runDetail.body.includes('class="evidence-group"'), 'Zone 4 should have a collapsed developer-evidence group');
    assert(runDetail.body.includes('id="replay-workspace-actions"'), 'Workspace Actions (jump target) must remain present');
    assert(runDetail.body.includes('<summary>Prompt Instructions</summary>'), 'deep replay content stays reachable in the evidence group');
```
  Keep the existing `Run Outcome` and `<summary>Ticket Objective</summary>` assertions.

- [ ] **Step 2: Run to verify it fails.** Run: `node scripts/page-render-regression-test.js` → FAIL with "Recent Activity should be removed".

- [ ] **Step 3: Build Zone 4 operator tier.** Under the Zone 4 header: keep **Workspace Actions** (`#replay-workspace-actions`, 902–966) as an always-open `<section class="detail-section">` immediately below the header (it is the primary "what changed" surface and a jump target — must stay open/reachable). Then `<details class="disclosure">` for **Artifacts** (fold Artifact Prediction 521–618 + Unexpected Actual Artifacts), **Operation History** (1008–1111, keep recovery controls + their script), **Events** (968–1004, fold in the carried `#run-zone-carry-events` Operational Events, then delete that div), and **Budget** (210–218). Preserve `data-op-failure`/`data-op-mutation`/`data-event-failure` attrs on items.

- [ ] **Step 4: Build the developer group + remove Recent Activity.** Create one `<details class="evidence-group"><summary>Model interaction &amp; raw evidence</summary><div class="evidence-group-body"> … </div></details>` containing, verbatim, the replay group (Replay Snapshot, Ticket Objective, Technical Runtime Details, Allowed Workspace Actions, Prompt Instructions, Provider Requests, Model Responses, and the replay-jump toolbar), Permissioned Cross-Ticket Delete (877–899), and Diagnostics (1115–1123, keep `#run-diagnostics-bundle` + its copy script). Delete the Recent Activity section (757–770) entirely.

- [ ] **Step 5: Run to verify it passes.** Run: `node scripts/page-render-regression-test.js` → PASS.

- [ ] **Step 6: Verify replay-jump still works.** Confirm the `data-replay-jump` buttons and `#replay-workspace-actions` / `data-op-*` targets are intact (`grep`), and that the jump targets are in the open operator tier (not inside the collapsed group).

- [ ] **Step 7: Syntax check + commit.**

```bash
node --check server.js
git add views/run-detail.ejs scripts/page-render-regression-test.js
git commit -m "Split run evidence into operator tier and collapsed developer group"
```

---

### Task 6: Full-state verification pass

**Files:** Modify (only if a gap is found): `views/run-detail.ejs`, `scripts/page-render-regression-test.js`.

- [ ] **Step 1: Render harness.** Run: `node scripts/page-render-regression-test.js` → PASS, exit 0.

- [ ] **Step 2: Screenshot across states.** Reuse the ticket page's screenshot pipeline (Playwright + headless Chromium against a seeded temp copy of `data/`, per `scratchpad/shoot.js`). Seed and capture: a running run (confirm `run-live-*` fields update), a completed run, a failed run with triage (Zone 2 critical cards + resolve), a run with workspace mutations + artifacts (operator tier), a run with a full replay snapshot (developer group expands, Prompt Instructions/Model Responses present), a resolved-triage run. Confirm Zone 2 is absent when no attention item is active.

- [ ] **Step 3: Field-parity audit.** Compare visible labels between `git show <branch-base>:views/run-detail.ejs` and the current file (`grep -oE '<h2>[^<]*|<dt>[^<]*|<th>[^<]*|<summary>[^<]*'`); classify every disappeared label as intentional-merge or real-loss. Real losses = 0 (Recent Activity is the only intended removal).

- [ ] **Step 4: Confirm actions.** Exercise (or statically confirm the wiring for) Stop, Retry, triage Resolve, recovery Preview/Confirm, diagnostics Copy, and the replay-jump buttons.

- [ ] **Step 5: Final syntax check + commit.**

```bash
node --check server.js
git add -A
git commit --allow-empty -m "Verify run page redesign across all run states"
```

---

## Self-Review

**Spec coverage:**
- Zone 1 hero / merge Run Summary + header, ticket back-link, live fields → Task 2. ✓
- Zone 2 attention (banner, why-stopped, triage×2, review, state-warning, failure-summary), only-when-present → Tasks 1+3. ✓
- Zone 3 config disclosures (usage/attempt, runtime limits, policy, run context, authority) → Task 4. ✓
- Zone 4 two-tier (operator: Workspace Actions open + Artifacts/OpHistory/Events/Budget disclosures; developer group: replay internals + cross-ticket delete + diagnostics), Recent Activity removed → Task 5. ✓
- Reuse component layer + one `.evidence-group` CSS addition → Task 1. ✓
- Preserve live-poll/replay-jump/diagnostics/actions/triage scripts + ids/endpoints → Global Constraints + Tasks 2/5/6. ✓
- Verification across states, field-parity, screenshot → Task 6. ✓

**Placeholder scan:** Concrete code/markup in every code step. Relocations reference exact source line ranges (verbatim moves are not re-printed in full — the line ranges are given). Task 1 Step 4 and Task 3 note that guard-variable names must be verified against the actual sections and adjusted — this is a real verification instruction, not a vague placeholder, because the exact per-section guard vars live in unchanged EJS the implementer will read.

**Type/name consistency:** Live-poll ids (`run-live-status`/`-outcome`/`-completed`/`-duration`/`-message`/`-event-status`/`-event-error`) match the script and are asserted unique in Task 2. `#replay-workspace-actions`, `data-op-failure`/`data-op-mutation`/`data-event-failure`, `#run-diagnostics-bundle`, `data-stop-run-id`/`data-retry-run-id`/`data-preview-recovery-id`/`data-confirm-recovery-id` are named in Global Constraints and preserved in Tasks 2/5. CSS classes `.evidence-group`/`.evidence-group-body` defined in Task 1, consumed in Task 5. `runHasAttention` defined in Task 1, consumed in Task 3. Carry divs `#run-zone-carry-config`/`#run-zone-carry-events` created in Task 2, consumed/deleted in Tasks 4/5.

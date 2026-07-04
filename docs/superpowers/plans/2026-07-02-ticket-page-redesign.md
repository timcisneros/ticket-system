# Ticket Page Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restructure `views/ticket-detail.ejs` from a flat ~19-section stack into four ordered zones keyed to the operator's questions (at a glance / needs attention / how it's set up / what happened), with progressive disclosure.

**Architecture:** Pure view + stylesheet change. `views/ticket-detail.ejs` is re-sectioned; `src/styles.css` gains a zone/hero/attention/disclosure/merged-table component layer built from existing tokens. No server routes, endpoints, or data-model changes. Tests are HTTP render assertions added to the existing `scripts/page-render-regression-test.js` harness, which boots the real server against seeded JSON fixtures and asserts on returned HTML.

**Tech Stack:** EJS 5 templates, Fastify server (`server.js`), plain CSS (`src/styles.css`), Node built-in test harness pattern in `scripts/page-render-regression-test.js`.

## Global Constraints

- Preserve verbatim these element IDs/attrs consumed by the live-poll `<script>` (current lines 883–1043) on the merged live block: `id="ticket-runtime-section"`, `data-ticket-runtime-id`, `data-ticket-runtime-active`, and the `id`s `ticket-live-status`, `ticket-live-run`, `ticket-live-run-status`, `ticket-live-message`, `ticket-live-step`, `ticket-live-lease`, `ticket-live-elapsed` (with its `data-started-at`/`data-completed-at`), `ticket-live-outcome`. Breaking any ID silently disables live polling.
- Preserve all existing action-script endpoints and their `data-*` hooks: `data-rerun-ticket-id`, `data-simulate-plan-id`/`data-simulate-mode`, `data-preview-recovery-id`, `data-confirm-recovery-id`, `data-resolve-url`, the max-attempts control (`.max-attempts-control`), and `#simulation-result`.
- No new server-provided template variables. Reuse only the locals already passed at the render callsite (`server.js:18319`): `ticket`, `executionState`, `ticketRuns`, `agents`, `artifacts`, `recentLogs`, `operationHistory`, `runStateInconsistency`, `reviewStatus`, `attemptSummary`, `budgetSummary`, `timeline`, `latestTriage`, `latestRuntimeRunId`, `allocationPlan`, `canUpdateTickets`.
- No datum currently shown may be dropped; every field lands in exactly one zone.
- Single scrolling column only; no tab framework. Reuse existing tokens/classes (`.status-badge`, `.status-<x>`, `.detail-grid`, `.tickets-table`, `.collapsible`, `.owned-path`, `.text-muted`) — do not introduce a new palette.
- Test command for every task: `node scripts/page-render-regression-test.js` — PASS exits 0 and prints a `{"mainFormRender":true,...}` JSON line; FAIL prints an Error stack and exits 1.
- Commit after each task. Branch is `redesign-ticket-page` (already created; design doc already committed).

---

## File Structure

- **`views/ticket-detail.ejs`** (modify) — the whole redesign. Current 1172-line flat stack becomes four `<section class="zone">` blocks. Existing per-item EJS logic and all three `<script>` blocks are reused; content is relocated and re-wrapped, not rewritten.
- **`src/styles.css`** (modify, append) — add the zone/hero/attention/disclosure/merged-table component layer near the existing `.detail-section` rules (~line 250+).
- **`scripts/page-render-regression-test.js`** (modify) — add an attention-state fixture and new ticket-detail render assertions; update the assertions the redesign intentionally changes.

Source-block map (current line ranges in `views/ticket-detail.ejs`) → destination zone:

| Current block (lines) | Destination |
|---|---|
| page-header + actions (1–36) | Zone 1 hero |
| Why blocked / feasibility (38–102) | Zone 2 |
| Execution State (104–191) | live subset → Zone 1; assignment/provenance/group → Zone 3 |
| Ticket-level triage (193–229) | Zone 2 |
| Latest-run triage (231–267) | Zone 2 |
| triage-resolve `<script>` (269–286) | keep, place after Zone 2 |
| Execution Policy (288–344) | Zone 3 |
| Review status (346–361) | Zone 2 |
| Ticket Details collapsible (363–393) | Zone 3 |
| Runtime + pre-compute (395–479) | Zone 1 hero (canonical live block) |
| Work Split Details (481–504) | Zone 3 |
| Work Units (506–573) | Zone 3 |
| Execution Attempts (576–611) | merged into Zone 4 Runs table |
| Budget Advisory (613–633) | Zone 4 (caption under Runs) |
| Runs (635–682) | Zone 4 (merged) |
| Artifacts (684–721) | Zone 4 |
| Timeline (723–765) | Zone 4 |
| Recent Activity (767–786) | REMOVED (already represented in Timeline as `diagnostic_log`) |
| Operation History (788–881) | Zone 4 |
| live-poll `<script>` (883–1043) | keep unchanged; hero must retain its target IDs |
| action `<script>`s (1045–1171) | keep unchanged |

---

### Task 1: CSS component layer + zone scaffolding

Add all new styles and wrap the existing page body in four labeled zone `<section>`s **without moving content yet** — this locks the skeleton and keeps every existing assertion green.

**Files:**
- Modify: `src/styles.css` (append component layer)
- Modify: `views/ticket-detail.ejs` (wrap existing content in four zones)
- Modify: `scripts/page-render-regression-test.js:112` area (add zone-eyebrow assertions)

**Interfaces:**
- Produces (CSS classes later tasks consume): `.zone`, `.zone-head`, `.zone-eyebrow`, `.zone-q`, `.hero`, `.live`, `.attn`, `.attn.critical`, `.disclosure`, `.disclosure .body`, `.grid`, `.intent`, `.merged-runs`.

- [ ] **Step 1: Write the failing assertions.** In `scripts/page-render-regression-test.js`, immediately after the existing `const ticketDetail = await assertPageRenders(...)` line (~112), add:

```javascript
    assert(ticketDetail.body.includes('>At a glance<'), 'ticket detail should render Zone 1 eyebrow');
    assert(ticketDetail.body.includes('>Needs your attention<') || ticketDetail.body.includes('data-attn-zone'), 'ticket detail should support Zone 2 attention');
    assert(ticketDetail.body.includes('>How it&#39;s set up<') || ticketDetail.body.includes("How it's set up"), 'ticket detail should render Zone 3 eyebrow');
    assert(ticketDetail.body.includes('>What has happened<'), 'ticket detail should render Zone 4 eyebrow');
```

- [ ] **Step 2: Run to verify it fails.**

Run: `node scripts/page-render-regression-test.js`
Expected: FAIL with "ticket detail should render Zone 1 eyebrow".

- [ ] **Step 3: Append the component layer to `src/styles.css`.** Add after the existing `.detail-section` rules:

```css
/* ---- ticket page zones (redesign) ---- */
.zone { margin-top: 30px; }
.zone:first-of-type { margin-top: 4px; }
.zone-head {
  display: flex; align-items: baseline; gap: 12px;
  margin-bottom: 12px; padding-bottom: 8px; border-bottom: 1px solid #e5e7eb;
  flex-wrap: wrap;
}
.zone-eyebrow { font-size: 11px; font-weight: 700; letter-spacing: 0.12em; text-transform: uppercase; color: #374151; }
.zone-q { font-size: 13px; color: #6b7280; font-style: italic; }

.hero { background: #fff; border: 1px solid #e5e7eb; border-radius: 10px; padding: 22px 24px; }
.hero-top { display: flex; align-items: flex-start; gap: 14px; flex-wrap: wrap; }
.hero-actions { margin-left: auto; display: flex; gap: 8px; flex-wrap: wrap; }
.live {
  margin-top: 18px; border-top: 1px dashed #e5e7eb; padding-top: 16px;
  display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 16px 22px;
}
.live > div { display: flex; flex-direction: column; gap: 4px; }
.live dt { font-size: 11px; letter-spacing: 0.06em; text-transform: uppercase; color: #9ca3af; font-weight: 600; }
.live dd { margin: 0; font-size: 14px; color: #111827; font-variant-numeric: tabular-nums; }

.attn { border: 1px solid #fcd34d; border-left: 4px solid #f59e0b; background: #fffbeb; border-radius: 10px; padding: 16px 20px; }
.attn.critical { border-color: #fca5a5; border-left-color: #dc2626; background: #fef2f2; }
.attn + .attn { margin-top: 12px; }
.attn h3 { margin: 0 0 4px; font-size: 15px; font-weight: 650; }
.attn .sev { font-size: 11px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; color: #92400e; }
.attn.critical .sev { color: #dc2626; }

.disclosure { background: #fff; border: 1px solid #e5e7eb; border-radius: 10px; overflow: hidden; }
.disclosure + .disclosure { margin-top: 10px; }
.disclosure > summary { list-style: none; cursor: pointer; display: flex; align-items: center; gap: 12px; padding: 14px 18px; font-size: 14px; font-weight: 550; }
.disclosure > summary::-webkit-details-marker { display: none; }
.disclosure > summary::before { content: "\203A"; font-size: 18px; color: #9ca3af; transition: transform .15s ease; }
.disclosure[open] > summary::before { transform: rotate(90deg); }
.disclosure > summary .sub { margin-left: auto; font-weight: 400; color: #6b7280; font-size: 12.5px; }
.disclosure .body { padding: 4px 18px 18px 40px; border-top: 1px solid #e5e7eb; }
.disclosure .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(190px,1fr)); gap: 14px 26px; margin-top: 14px; }
.intent { color: #9ca3af; font-size: 12px; }
@media (prefers-reduced-motion: reduce) { .disclosure > summary::before { transition: none; } }
```

- [ ] **Step 4: Wrap existing content in four zones in `views/ticket-detail.ejs`.** Do not move content between zones yet. Insert the four zone headers so existing sections fall under the right eyebrow:
  - After line 1 opening, before the page-header, open Zone 1: `<section class="zone"><div class="zone-head"><span class="zone-eyebrow">At a glance</span><span class="zone-q">What is this, and what's it doing right now?</span></div>` and close `</section>` after the Runtime section (after current line 479).
  - Wrap the attention-type sections (feasibility 38–102, triage 193–267, review 346–361) is deferred to Task 3; for now place a single Zone 2 header with `data-attn-zone` immediately before the feasibility block and close after review status. Because content is not yet consolidated, guard the header so it only prints when any attention item exists:

```ejs
<% const hasAttention = Boolean(ticketBlockedReason || ticketFeasibility)
  || (ticket.triage && (ticket.triage.required || ticket.triage.resolvedAt))
  || (typeof latestTriage !== 'undefined' && latestTriage && (latestTriage.required || latestTriage.resolvedAt))
  || (typeof reviewStatus !== 'undefined' && reviewStatus && reviewStatus.applicable && reviewStatus.needsReview)
  || (typeof runStateInconsistency !== 'undefined' && runStateInconsistency); %>
<% if (hasAttention) { %>
<div class="zone-head" data-attn-zone><span class="zone-eyebrow">Needs your attention</span><span class="zone-q">Does it need me, and what do I decide?</span></div>
<% } %>
```
  - Insert a Zone 3 header before Execution Policy (288) and a Zone 4 header before Execution Attempts (576):

```ejs
<div class="zone-head"><span class="zone-eyebrow">How it's set up</span><span class="zone-q">How is this ticket configured?</span></div>
```
```ejs
<div class="zone-head"><span class="zone-eyebrow">What has happened</span><span class="zone-q">What did the system actually do?</span></div>
```

- [ ] **Step 5: Run to verify it passes.**

Run: `node scripts/page-render-regression-test.js`
Expected: PASS, exits 0, prints `{"mainFormRender":true,...}`.

- [ ] **Step 6: Verify the template still parses.**

Run: `node --check server.js`
Expected: no output, exit 0. (Confirms no stray EJS/JS syntax was introduced.)

- [ ] **Step 7: Commit.**

```bash
git add src/styles.css views/ticket-detail.ejs scripts/page-render-regression-test.js
git commit -m "Add zone scaffolding and CSS layer for ticket page redesign"
```

---

### Task 2: Zone 1 — summary hero (merge Execution State + Runtime)

Replace the page-header + `Execution State` + `Runtime` sections with one hero card containing identity, objective, primary actions, and a single canonical live block that retains all IDs the live-poll script needs. The config/provenance fields from `Execution State` move to Zone 3 in Task 4; for now relocate them into a temporary `<div id="zone1-config-carry">` at the top of Zone 3 so no field is lost between tasks.

**Files:**
- Modify: `views/ticket-detail.ejs` (lines 1–36 header, 104–191 Execution State, 395–479 Runtime)
- Modify: `scripts/page-render-regression-test.js` (hero assertions)

**Interfaces:**
- Consumes: `.hero`, `.live` (Task 1).
- Produces: hero markup with preserved IDs (`ticket-live-*`, `#ticket-runtime-section`) that the unchanged live-poll script binds to.

- [ ] **Step 1: Write failing assertions.** After the Task 1 zone-eyebrow assertions, add:

```javascript
    assert(ticketDetail.body.includes('id="ticket-runtime-section"'), 'hero must keep the live runtime container id');
    assert(ticketDetail.body.includes('id="ticket-live-status"'), 'hero must keep the live status id');
    assert(!ticketDetail.body.includes('>Execution State<'), 'standalone Execution State heading should be gone (merged into hero)');
    assert(!ticketDetail.body.includes('>Runtime</h2>'), 'standalone Runtime heading should be gone (merged into hero)');
    // ticket status badge appears once in the hero, not duplicated in a separate Runtime block
    assert((ticketDetail.body.match(/id="ticket-live-status"/g) || []).length === 1, 'live status id must be unique');
```

- [ ] **Step 2: Run to verify it fails.**

Run: `node scripts/page-render-regression-test.js`
Expected: FAIL with "standalone Execution State heading should be gone".

- [ ] **Step 3: Build the hero.** Replace the page-header block (lines 1–36) and delete the separate `Execution State` (104–191) and `Runtime` (395–479) `<section>`s, composing one hero. Keep the runtime pre-compute block (395–408) immediately above the hero. Hero markup:

```ejs
<section class="zone">
  <div class="zone-head"><span class="zone-eyebrow">At a glance</span><span class="zone-q">What is this, and what's it doing right now?</span></div>
  <div class="hero" id="ticket-runtime-section" data-ticket-runtime-id="<%= ticket.id %>" data-ticket-runtime-active="<%= activeRuntimeRun ? 'true' : 'false' %>">
    <div class="hero-top">
      <div>
        <h1 style="margin:0;font-size:26px;">Ticket #<%= ticket.id %>
          <span id="ticket-live-status" class="status-badge status-<%= ticket.status %>"><%= ticket.status %></span>
        </h1>
        <p class="text-muted" style="margin:8px 0 0;max-width:62ch;"><%= ticket.objective %></p>
      </div>
      <div class="hero-actions">
        <a class="btn-secondary" href="/tickets">Back to Tickets</a>
        <a class="btn-secondary" href="/logs?ticketId=<%= ticket.id %>">Ticket Logs</a>
        <% if (canUpdateTickets && !hasUnresolvedTriage && ticket.status !== 'open') { %>
          <button type="button" class="btn-secondary" data-rerun-ticket-id="<%= ticket.id %>"><%= ticket.status === 'failed' ? 'Retry' : 'Rerun' %></button>
        <% } %>
        <% if (canUpdateTickets) { %>
          <button type="button" class="btn-secondary" data-simulate-plan-id="<%= ticket.id %>" data-simulate-mode="gate">Test gate</button>
          <button type="button" class="btn-secondary" data-simulate-plan-id="<%= ticket.id %>" data-simulate-mode="model">Test agent plan (simulation)</button>
        <% } %>
      </div>
    </div>
    <dl class="live">
      <div><dt>Run</dt><dd id="ticket-live-run"><% if (visibleRuntimeRun) { %><a href="/runs/<%= visibleRuntimeRun.id %>">Run #<%= visibleRuntimeRun.id %></a><% } else { %>-<% } %></dd></div>
      <div><dt>Run Status</dt><dd><span id="ticket-live-run-status" class="status-badge <%= visibleRuntimeRun ? 'status-' + visibleRuntimeRun.status : '' %>"><%= visibleRuntimeRun ? visibleRuntimeRun.status : '-' %></span></dd></div>
      <div><dt>Assigned to</dt><dd><%= executionState ? executionState.assignmentTargetLabel : '-' %></dd></div>
      <div><dt>Latest Outcome</dt><dd id="ticket-live-outcome"><%= visibleRuntimeRun && visibleRuntimeRun.operationalOutcome ? visibleRuntimeRun.operationalOutcome : '-' %></dd></div>
      <div><dt>Current Step</dt><dd id="ticket-live-step"><%= visibleRuntimeRun && visibleRuntimeRun.currentStepId ? visibleRuntimeRun.currentStepId : '-' %></dd></div>
      <div><dt>Elapsed Time</dt><dd id="ticket-live-elapsed" data-started-at="<%= initialRuntimeStart %>" data-completed-at="<%= initialRuntimeComplete %>">-</dd></div>
      <div><dt>Lease State</dt><dd id="ticket-live-lease"><%= initialLeaseState %></dd></div>
      <div style="grid-column:1/-1;"><dt>Current Message</dt><dd id="ticket-live-message"><%= ticket.currentMessage || '-' %></dd></div>
    </dl>
    <% if (typeof runStateInconsistency !== 'undefined' && runStateInconsistency) { %>
      <div class="state-inconsistency-warning state-inconsistency-warning--inline" id="ticket-runtime-state-warning">
        <strong>State Warning</strong><p><%= runStateInconsistency.message %></p>
        <% if (runStateInconsistency.reasons && runStateInconsistency.reasons.length > 0) { %><ul><% runStateInconsistency.reasons.forEach(reason => { %><li><%= reason %></li><% }) %></ul><% } %>
      </div>
    <% } %>
    <% if (openStateNote) { %><p class="text-muted"><%= openStateNote %></p><% } %>
  </div>
</section>
```
  Keep the `hasUnresolvedTriage` const (currently lines 12–14) computed *before* the hero. Keep the simulation hint + `#simulation-result` div (lines 33–36) directly after the hero. Retain the `openStateNote` compute block (464–475) just before the hero.

- [ ] **Step 4: Carry Execution State config fields into Zone 3 temporarily.** At the very top of Zone 3 (before Execution Policy) add a `<div id="zone1-config-carry">` containing the non-live Execution State fields that Task 4 will fold into the assignment disclosure: `Created from template` (112–120), `Work Context` (121–129), `Assignment mode` (130–135), `Auto-run behavior` (136–139), the group fan-out `<p>` (170–174), and the dynamic-scope map (175–189). Copy those exact EJS blocks inside the carry div so no field is lost.

- [ ] **Step 5: Run to verify it passes.**

Run: `node scripts/page-render-regression-test.js`
Expected: PASS, exits 0.

- [ ] **Step 6: Manually verify live polling is intact.** Start the app (`npm run dev`), open a ticket with an active run, and confirm the status/run/elapsed fields update without a full reload (the unchanged live-poll script binds to the preserved IDs).

Run: `node --check server.js`
Expected: exit 0.

- [ ] **Step 7: Commit.**

```bash
git add views/ticket-detail.ejs scripts/page-render-regression-test.js
git commit -m "Merge Execution State and Runtime into Zone 1 summary hero"
```

---

### Task 3: Zone 2 — attention consolidation

Wrap feasibility, both triage variants, review status, and the state-warning into `.attn` severity cards under the Zone 2 header, rendered only when `hasAttention` (defined in Task 1). Move the state-warning display out of the hero into Zone 2 (remove the hero copy added in Task 2 Step 3). Add a fixture that produces the attention state so the conditional is tested both ways.

**Files:**
- Modify: `views/ticket-detail.ejs` (feasibility 38–102, triage 193–267, review 346–361; remove hero state-warning)
- Modify: `scripts/page-render-regression-test.js` (add `seedAttentionFixture`, assertions)

**Interfaces:**
- Consumes: `.attn`, `.attn.critical`, `hasAttention` flag.

- [ ] **Step 1: Seed an attention fixture.** In `scripts/page-render-regression-test.js`, after the existing `seedNavigationFixture()` definition, add a helper that appends a failed ticket with required triage, and call it in `main()` capturing the returned id:

```javascript
function seedAttentionFixture() {
  const agents = readJson('agents.json');
  const tickets = readJson('tickets.json');
  const now = new Date().toISOString();
  const agent = agents[0];
  const ticketId = Math.max(0, ...tickets.map(t => t.id || 0)) + 1;
  const ticket = {
    id: ticketId, objective: 'attention fixture', assignmentTargetType: 'agent',
    assignmentTargetId: agent.id, assignmentMode: 'individual', status: 'failed',
    createdBy: 'admin', createdAt: now, updatedAt: now,
    blockedReason: 'Missing authority grant for /reports/q3',
    triage: { required: true, reasonCode: 'authority.missing_grant', requiredDecision: 'grant_or_rescope',
      summary: 'Objective clarification required', allowedActions: ['grant'], prohibitedActions: [],
      evidenceRefs: ['/reports/q3'], resolvedAt: null }
  };
  writeJson('tickets.json', [...tickets, ticket]);
  return { ticketId };
}
```

- [ ] **Step 2: Write failing assertions.** In `main()`, after logging in, add:

```javascript
    const attention = seedAttentionFixture();
    const attnPage = await assertPageRenders(cookie, `/tickets/${attention.ticketId}`, 'attention ticket', 'Needs your attention');
    assert(attnPage.body.includes('class="attn critical"'), 'required triage should render a critical attention card');
    assert(attnPage.body.includes('Missing authority grant for /reports/q3'), 'blocked reason should appear in the attention zone');
    // clean completed ticket has no attention zone
    assert(!ticketDetail.body.includes('Needs your attention'), 'completed ticket without triage should omit the attention zone');
```

- [ ] **Step 3: Run to verify it fails.**

Run: `node scripts/page-render-regression-test.js`
Expected: FAIL with "attention ticket: expected text missing: Needs your attention".

- [ ] **Step 4: Build Zone 2.** Replace the feasibility (38–102), ticket triage (193–229), latest-run triage (231–267), and review-status (346–361) sections with a single Zone 2 wrapped in `<% if (hasAttention) { %>…<% } %>`. Convert each item's outer `<section class="detail-section">` to `<div class="attn critical">` for required triage and blocked/feasibility, and `<div class="attn">` for resolved triage and review flags. Keep each item's inner `<dl>`, evidence lists, and the two `.triage-resolve` forms verbatim (their `data-resolve-url` endpoints are unchanged). Prefix each card's heading with `<h3><span class="sev">…</span></h3>`. Remove the hero's state-warning block (added in Task 2 Step 3) and render it as an `<div class="attn critical">` at the top of Zone 2 instead. Keep the triage-resolve `<script>` (269–286) immediately after Zone 2.

- [ ] **Step 5: Run to verify it passes.**

Run: `node scripts/page-render-regression-test.js`
Expected: PASS, exits 0.

- [ ] **Step 6: Syntax check.**

Run: `node --check server.js`
Expected: exit 0.

- [ ] **Step 7: Commit.**

```bash
git add views/ticket-detail.ejs scripts/page-render-regression-test.js
git commit -m "Consolidate blocked/triage/review into Zone 2 attention cards"
```

---

### Task 4: Zone 3 — configuration disclosures

Convert Execution Policy, Ticket Details, Work Split Details, Work Units, and the Task-2 `#zone1-config-carry` fields into collapsed `<details class="disclosure">` blocks under the Zone 3 header. First disclosure ("Assignment & work split") is open by default; the rest closed.

**Files:**
- Modify: `views/ticket-detail.ejs` (Execution Policy 288–344, Ticket Details 363–393, Work Split 481–504, Work Units 506–573, carry div)
- Modify: `scripts/page-render-regression-test.js:113` (update Ticket Details assertion)

**Interfaces:**
- Consumes: `.disclosure`, `.disclosure .body`, `.disclosure .grid`, `.intent`.

- [ ] **Step 1: Update the changed assertion + add new ones.** Change the existing line (`assert(ticketDetail.body.includes('<summary>Ticket Details</summary>')…`) to match the new disclosure, and add:

```javascript
    assert(ticketDetail.body.includes('Assignment &amp; work split') || ticketDetail.body.includes('Assignment & work split'), 'Zone 3 should have an assignment disclosure');
    assert(ticketDetail.body.includes('class="disclosure"'), 'Zone 3 config should use disclosure rows');
    assert(ticketDetail.body.includes('Ticket details'), 'Zone 3 should keep ticket metadata');
```
  Delete the old `'<summary>Ticket Details</summary>'` assertion line.

- [ ] **Step 2: Run to verify it fails.**

Run: `node scripts/page-render-regression-test.js`
Expected: FAIL with "Zone 3 should have an assignment disclosure".

- [ ] **Step 3: Build the assignment disclosure.** Under the Zone 3 header, add:

```ejs
<details class="disclosure" open>
  <summary>Assignment &amp; work split <span class="sub"><%= ticket.assignmentTargetType === 'group' ? 'Group' : 'Agent' %> #<%= ticket.assignmentTargetId %> · <%= ticket.assignmentMode === 'allocated' ? 'Manual folder scopes' : ticket.assignmentMode === 'dynamic' ? 'Automatic folder scopes' : ticket.assignmentMode %></span></summary>
  <div class="body">
    <dl class="grid">
      <div><dt>Worker</dt><dd><%= ticket.assignmentTargetType === 'group' ? 'Group' : 'Agent' %> #<%= ticket.assignmentTargetId %></dd></div>
      <div><dt>Work Split</dt><dd><%= ticket.assignmentMode === 'allocated' ? 'Manual folder scopes' : ticket.assignmentMode === 'dynamic' ? 'Automatic folder scopes' : ticket.assignmentMode %></dd></div>
      <!-- carried Execution State fields: paste the template/work-context/assignment-mode/auto-run blocks from #zone1-config-carry here, unchanged -->
    </dl>
    <!-- paste the group fan-out <p> and dynamic-scope map from #zone1-config-carry here, unchanged -->
    <!-- paste Work Units (current 506–573 markup) here, unchanged, when allocationPlan exists -->
  </div>
</details>
```
  Move the exact EJS from `#zone1-config-carry` (Task 2 Step 4) into the `<dl class="grid">` / body as marked, then delete the `#zone1-config-carry` div. Move the Work Units block (506–573) inside this disclosure body, guarded by its existing `<% if (allocationPlan) { %>`. Move the Work Split Details metadata (481–504) into the summary/body as a nested detail or grid row.

- [ ] **Step 4: Convert Execution Policy and Ticket Details.** Wrap Execution Policy (288–344) as `<details class="disclosure"><summary>Execution policy <span class="sub">…</span></summary><div class="body">…</div></details>`, keeping the `.detail-grid` contents and the `.max-attempts-control` block verbatim, but replace each repeated "· recorded intent, not enforced" trailing text with `<span class="intent">recorded intent</span>`. Wrap Ticket Details (363–393) as `<details class="disclosure"><summary>Ticket details <span class="sub">…</span></summary>`, keeping its `.detail-grid`.

- [ ] **Step 5: Run to verify it passes.**

Run: `node scripts/page-render-regression-test.js`
Expected: PASS, exits 0.

- [ ] **Step 6: Syntax check.**

Run: `node --check server.js`
Expected: exit 0.

- [ ] **Step 7: Commit.**

```bash
git add views/ticket-detail.ejs scripts/page-render-regression-test.js
git commit -m "Collapse ticket configuration into Zone 3 disclosures"
```

---

### Task 5: Zone 4 — evidence merge

Merge `Execution Attempts` into a single `Runs & attempts` table; fold Budget Advisory into a caption; make Timeline, Artifacts, and Operation History collapsed peers; remove the `Recent Activity` section.

**Files:**
- Modify: `views/ticket-detail.ejs` (Execution Attempts 576–611, Budget 613–633, Runs 635–682, Artifacts 684–721, Timeline 723–765, Recent Activity 767–786, Operation History 788–881)
- Modify: `scripts/page-render-regression-test.js:112,114` (update `Run Outcome` and `Recent Activity` assertions)

**Interfaces:**
- Consumes: `.tickets-table` (existing), `.collapsible`/`.disclosure`.

- [ ] **Step 1: Update changed assertions + add new ones.** In the harness: change the `assertPageRenders(..., 'ticket detail', 'Run Outcome')` expected text to `'Runs & attempts'`; delete the `assert(ticketDetail.body.includes('Recent Activity')…` line; and add:

```javascript
    assert(!ticketDetail.body.includes('>Recent Activity<'), 'Recent Activity section should be removed (folded into Timeline)');
    assert(!ticketDetail.body.includes('>Execution Attempts'), 'Execution Attempts should be merged into the Runs table');
    assert(ticketDetail.body.includes('Runs &amp; attempts') || ticketDetail.body.includes('Runs & attempts'), 'Zone 4 should have a merged runs/attempts table');
```
  Note: the run-detail assertion asserting `'Recent Activity'` (for `/runs/:id`) stays — run-detail is out of scope.

- [ ] **Step 2: Run to verify it fails.**

Run: `node scripts/page-render-regression-test.js`
Expected: FAIL with "Recent Activity section should be removed".

- [ ] **Step 3: Build the merged Runs & attempts table.** Replace the `Runs` section (635–682) and delete the `Execution Attempts` section (576–611). Build one `<section class="detail-section"><h2>Runs &amp; attempts</h2>` whose `<table class="tickets-table">` uses the union of columns. Base columns always: Run #, Agent, Status, Run Outcome, Mutations, Created. When `attemptSummary && attemptSummary.attemptCount > 0`, add columns Attempt, Duration, Model reqs, Workspace ops, Mutating ops, Verification, Triage — join each run row to its attempt record by `runId`:

```ejs
<% const attemptByRun = {}; (typeof attemptSummary !== 'undefined' && attemptSummary ? attemptSummary.attempts : []).forEach(a => { attemptByRun[a.runId] = a; }); %>
<% const showAttemptCols = typeof attemptSummary !== 'undefined' && attemptSummary && attemptSummary.attemptCount > 0; %>
<% const hasScopedRuns = ticketRuns.some(run => run.allocationPlanId || run.allocationItemId); %>
<table class="tickets-table">
  <thead><tr>
    <% if (showAttemptCols) { %><th>Attempt</th><% } %>
    <th>Run #</th><th>Agent</th><th>Status</th><th>Run Outcome</th><th>Mutations</th>
    <% if (showAttemptCols) { %><th>Duration</th><th>Model reqs</th><th>Workspace ops</th><th>Mutating ops</th><th>Verification</th><th>Triage</th><% } %>
    <% if (hasScopedRuns) { %><th>Work Split</th><th>Work Unit</th><% } %>
    <th>Created</th>
  </tr></thead>
  <tbody>
    <% ticketRuns.forEach(run => { const a = attemptByRun[run.id]; %>
      <tr>
        <% if (showAttemptCols) { %><td><%= a && a.attemptNumber !== null && a.attemptNumber !== undefined ? a.attemptNumber : '-' %></td><% } %>
        <td><a href="/runs/<%= run.id %>">Run #<%= run.id %></a></td>
        <td><%= run.agentName %></td>
        <td><span class="status-badge status-<%= run.status %>"><%= run.status %></span></td>
        <td><code><%= run.operationalOutcome || '-' %></code></td>
        <td><%= run.partialMutationCount > 0 ? run.partialMutationCount : '-' %></td>
        <% if (showAttemptCols) { %>
          <td><%= a && a.durationMs !== null && a.durationMs !== undefined ? a.durationMs + 'ms' : 'unavailable' %></td>
          <td><%= a && a.modelRequestCount !== null && a.modelRequestCount !== undefined ? a.modelRequestCount : 'unavailable' %></td>
          <td><%= a && a.workspaceOperationCount !== null && a.workspaceOperationCount !== undefined ? a.workspaceOperationCount : 'unavailable' %></td>
          <td><%= a && a.mutatingWorkspaceOperationCount !== null && a.mutatingWorkspaceOperationCount !== undefined ? a.mutatingWorkspaceOperationCount : 'unavailable' %></td>
          <td><%= a && a.verificationRequired ? 'required · ' + a.verificationOutcome : 'not required' %></td>
          <td><%= a && a.triageRequired ? 'required' : 'none' %></td>
        <% } %>
        <% if (hasScopedRuns) { %><td><%= run.allocationPlanId || '-' %></td><td><%= run.allocationItemId || '-' %></td><% } %>
        <td><%= run.createdAt ? new Date(run.createdAt).toLocaleString() : '-' %></td>
      </tr>
    <% }) %>
  </tbody>
</table>
<% if (typeof budgetSummary !== 'undefined' && budgetSummary && budgetSummary.runCount > 0) { %>
  <p class="text-muted">Budget advisory (no execution blocked): overall <%= budgetSummary.overall %> · <%= budgetSummary.counts.exceeded %> exceeded, <%= budgetSummary.counts.within_threshold %> within, <%= budgetSummary.counts.unavailable %> unavailable, <%= budgetSummary.counts.not_configured %> not configured.</p>
<% } %>
<p class="text-muted">Each run is one attempt — measurement only, no retry triggered.</p>
```
  Keep the empty-state (`No runs yet.`) guard. Delete the standalone Budget Advisory section (613–633).

- [ ] **Step 4: Collapse the remaining evidence + remove Recent Activity.** Wrap Timeline (723–765), Artifacts (684–721), and Operation History (788–881) each in `<details class="disclosure"><summary>…<span class="sub">…</span></summary><div class="body">…</div></details>`, keeping their inner tables/lists verbatim. Delete the entire `Recent Activity` section (767–786). Ensure the Zone 4 header precedes the merged Runs table.

- [ ] **Step 5: Run to verify it passes.**

Run: `node scripts/page-render-regression-test.js`
Expected: PASS, exits 0.

- [ ] **Step 6: Syntax check.**

Run: `node --check server.js`
Expected: exit 0.

- [ ] **Step 7: Commit.**

```bash
git add views/ticket-detail.ejs scripts/page-render-regression-test.js
git commit -m "Merge Runs/Attempts and group evidence into Zone 4"
```

---

### Task 6: Full-state verification pass

Exercise the redesigned page across every meaningful ticket state, confirm no field regressed, and confirm the broader render/regression suites still pass.

**Files:**
- Modify (only if a gap is found): `views/ticket-detail.ejs`, `scripts/page-render-regression-test.js`

- [ ] **Step 1: Run the full render regression harness.**

Run: `node scripts/page-render-regression-test.js`
Expected: PASS, exits 0, prints `{"mainFormRender":true,...}`.

- [ ] **Step 2: Manually walk each state.** Start `npm run dev`, and for each of: open/unassigned ticket, running ticket (confirm live poll updates), completed ticket, failed ticket with required triage (Zone 2 critical card + resolve works), group ticket with allocation plan (Work Units in Zone 3, Work Split/Work Unit columns in Zone 4), blocked/feasibility ticket, resolved-triage ticket — confirm every datum from the pre-redesign page is present in exactly one zone and Zone 2 is absent when nothing needs attention.

- [ ] **Step 3: Confirm action controls.** On a failed ticket, exercise Retry, Test gate, Test agent plan (`#simulation-result` renders), a triage Resolve, and (if an operation is recoverable) Preview/Confirm Recovery. All must behave as before.

- [ ] **Step 4: Run the release-checkpoint render coverage guard** (confirms the harness is still wired into the suite):

Run: `node scripts/release-checkpoint-coverage-test.js`
Expected: exit 0 (or its existing baseline output with no new failures).

- [ ] **Step 5: Final syntax check + commit.**

```bash
node --check server.js
git add -A
git commit -m "Verify ticket page redesign across all ticket states"
```

---

## Self-Review

**Spec coverage:**
- Zone 1 hero / merge Execution State + Runtime → Task 2. ✓
- Zone 2 attention consolidation (blocked, both triage variants, review, state-warning), only-when-present → Task 3. ✓
- Zone 3 config disclosures + "recorded intent" as qualifier + Work Units → Task 4. ✓
- Zone 4 evidence merge (Runs+Attempts, Budget caption, collapsed Timeline/Artifacts/Operations, Recent Activity removed) → Task 5. ✓
- CSS component layer, palette/token reuse, single column → Task 1. ✓
- Verification across states, live-poll integrity, action endpoints → Tasks 2/3/6. ✓
- Non-goals (no server/data changes, no datum dropped) enforced by Global Constraints + Task 2 Step 4 carry + Task 6 Step 2 audit. ✓

**Placeholder scan:** All code steps show concrete markup/JS. The two "paste the exact EJS block from lines N–M" directives in Tasks 3–4 reference verbatim relocations of blocks reproduced in the current file (the plan intentionally does not re-print hundreds of unchanged lines; exact source ranges are given). No "TBD"/"add error handling"/"similar to Task N" placeholders.

**Type/name consistency:** Element IDs (`ticket-live-status`, `ticket-runtime-section`, `ticket-live-run/-run-status/-message/-step/-lease/-elapsed/-outcome`) match the live-poll script and are asserted unique in Task 2. CSS class names (`.zone`, `.hero`, `.live`, `.attn`, `.attn.critical`, `.disclosure`, `.grid`, `.intent`) are defined in Task 1 and consumed identically in Tasks 2–5. `attemptByRun`/`showAttemptCols`/`hasScopedRuns`/`hasAttention`/`visibleRuntimeRun`/`openStateNote` are each defined once before use.

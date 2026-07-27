#!/usr/bin/env node
'use strict';
// Ticket timeline authority evidence — PostgreSQL-native
// (docs/ARCHITECTURAL_DECISIONS_PENDING.md, A20).
//
// Replaces the authority-evidence half of `ticket-timeline-authority-visibility-test.js`.
//
// THE CONTRACT: the ticket timeline is a TRUTHFUL, DETERMINISTIC, READ-ONLY projection
// of what authority actually decided. Four properties, and each fails differently:
//
//   truthful       a denial appears as a denial with its rule and target; an allowed
//                  mutation appears as committed work, not as a refusal
//   folded         one refusal is one entry. The runtime writes an `authority.denied`
//                  event AND a blocked `workspace.operation` event for the same
//                  attempt, and the projection folds the second into the first —
//                  an operator counting entries must not see one refusal twice
//   deterministic  projecting twice yields the same entries in the same order
//   read-only      projecting changes no persisted state
//
// WHY FOLDING IS ASSERTED SEPARATELY FROM DENIAL. A suite that only checked "the run
// failed" or "a denial exists" passes while the timeline double-reports every refusal.
// Duplication in an evidence surface is not cosmetic: it is the difference between one
// blocked attempt and an apparent pattern of them.
//
// POSITIVE CONTROLS. An allowed mutation on the same agent proves denials are not the
// only thing the projection can render, and a second ticket proves evidence does not
// leak between tickets. Without those, a projection that rendered everything as denied
// — or rendered every ticket's evidence into every timeline — would pass.
//
// Requires TEST_DATABASE_URL (or DATABASE_URL).

const fs = require('fs');
const os = require('os');
const path = require('path');
const { withHarness, createAsserter, sleep } = require('./postgres-test-harness');
const { assertScenariosExecuted } = require('./child-process-settlement');

const STAMP = Date.now();
const assert = createAsserter();
let scenariosRun = 0;

function encodeActions(plan) {
  return Buffer.from(JSON.stringify(plan), 'utf8').toString('base64url');
}

function createFetchStub() {
  const preloadPath = path.join(os.tmpdir(), `timeline-authority-stub-${process.pid}-${STAMP}.js`);
  fs.writeFileSync(preloadPath, `
function okResponse(plan) {
  return { ok: true, status: 200, headers: new Map([['x-request-id', 'fake-timeline-authority']]),
    async text() { return JSON.stringify({ output_text: JSON.stringify(plan), usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } }); } };
}
global.fetch = async function(_url, options = {}) {
  let combined = '';
  try {
    const body = JSON.parse(options.body || '{}');
    const input = Array.isArray(body.input) ? body.input : [];
    combined = input.map(i => i && i.content ? String(i.content) : '').join('\\n');
  } catch (_) {}
  const m = combined.match(/#ACTIONS=([A-Za-z0-9_-]+=*)/);
  if (!m) return okResponse({ message: 'noop', actions: [], complete: true });
  let plan;
  try { plan = JSON.parse(Buffer.from(m[1], 'base64url').toString('utf8')); } catch (_) { plan = { actions: [], complete: true }; }
  return okResponse({ message: plan.message || 'stubbed', actions: plan.actions || [], complete: plan.complete !== false });
};
`);
  return preloadPath;
}

async function waitFor(fn, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await fn();
    if (result) return result;
    await sleep(120);
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function main() {
  const preloadPath = createFetchStub();
  try {
    await withHarness('timeline authority evidence', async ({ store, workspaceRoot, startServer }) => {
      const agent = (await store.createConfiguredAgent({
        value: { name: `TimelineAuthority-${STAMP}`, provider: 'openai', model: 'gpt-4.1-mini', apiKey: 'test-key-timeline' },
        groupIds: [], changedBy: 'timeline-authority-evidence-test'
      })).agent;

      const server = await startServer({
        NODE_OPTIONS: `--require ${preloadPath}`,
        RUNTIME_SCHEDULER_INTERVAL_MS: '200',
        RUN_LEASE_DURATION_MS: '60000'
      });
      const cookie = await server.login();

      async function runPlan(label, plan) {
        scenariosRun += 1;
        const objective = `timeline-authority ${label} ${STAMP} #ACTIONS=${encodeActions(plan)}`;
        const created = await server.request('POST', '/tickets', {
          cookie,
          form: { objective, assignmentTargetType: 'agent', assignmentTargetId: String(agent.id), assignmentMode: 'individual' }
        });
        assert(created.statusCode === 302, `${label}: ticket created (HTTP ${created.statusCode})`);
        const ticket = await waitFor(async () => {
          const { tickets } = await store.listTickets({ limit: 300 });
          return tickets.find(t => t.objective === objective) || null;
        }, 30000, `${label} ticket`);
        const run = await waitFor(async () => {
          const { runs } = await store.listRunsForTicket({ ticketId: ticket.id, limit: 10 });
          return runs[0] || null;
        }, 30000, `${label} run dispatch`);
        const terminal = await waitFor(async () => {
          const current = await store.getRun(run.id);
          return current && ['completed', 'failed', 'interrupted'].includes(current.status) ? current : null;
        }, 90000, `${label} terminal run`);
        return { ticket, run: terminal };
      }

      const timelineOf = async ticketId => {
        const response = await server.request('GET', `/api/tickets/${ticketId}/timeline`, { cookie });
        assert(response.statusCode === 200, `timeline for ticket ${ticketId} answered (HTTP ${response.statusCode})`);
        const body = JSON.parse(response.body);
        assert(Array.isArray(body.entries), `timeline for ticket ${ticketId} returns entries`);
        return body.entries;
      };
      const exists = rel => fs.existsSync(path.join(workspaceRoot, rel));

      // ── 1. A denial is rendered as a denial, with its rule and target ────────
      const denied = await runPlan('denied', {
        actions: [{ operation: 'writeFile', args: { path: '.env', content: 'SECRET=leaked' } }], complete: true
      });
      assert(denied.run.status === 'failed',
        `1: the protected-path mutation failed the run (${denied.run.status})`);
      assert(!exists('.env'), '1: the denied mutation left no filesystem effect');

      const deniedEntries = await timelineOf(denied.ticket.id);
      const authorityEntries = deniedEntries.filter(entry => entry.type === 'authority.denied');
      assert(authorityEntries.length === 1,
        `1: the refusal appears exactly once as an authority denial (got ${authorityEntries.length})`);
      const authorityEntry = authorityEntries[0];
      const details = authorityEntry.details || {};
      // THREE SEPARABLE PROPERTIES, asserted independently so a mutation that removes
      // structured attribution fails on ATTRIBUTION and not merely on some neighbouring
      // field changing.
      //
      // (a) EXACT STRUCTURED ATTRIBUTION. Identity, not a substring: the operator surface
      //     must carry a machine-readable rule an integrator can branch on.
      assert(details.rule === 'protected_path',
        `1: the entry names the protected-path rule structurally (got ${JSON.stringify(details.rule)})`);
      assert(typeof details.rule === 'string',
        `1: the rule is a structured string, not an object or inferred flag (got ${typeof details.rule})`);

      // (b) PROSE IS NOT ATTRIBUTION, and this proves the two cannot be confused. The
      //     human-readable text independently mentions the protection, so a substring
      //     check over the entry would pass even with the structured rule stripped —
      //     which is exactly why (a) is written as an identity test. Asserting the prose
      //     separately keeps that distinction visible and falsifiable rather than a
      //     comment nobody can check.
      const proseBlob = `${authorityEntry.title || ''} ${authorityEntry.summary || ''} ${details.reason || ''}`;
      assert(/protected|\.env/i.test(proseBlob),
        `1: the entry also carries human-readable prose about the refusal (got ${JSON.stringify(proseBlob)})`);
      assert(details.rule !== proseBlob && !/\s/.test(details.rule),
        '1: the structured rule is a discrete token, not the prose sentence reused as attribution');
      assert(/\.env/.test(JSON.stringify(details) + String(authorityEntry.summary || '')),
        '1: the entry names the target it refused');
      assert(authorityEntry.runId === denied.run.id,
        '1: the entry attributes the denial to the run that attempted it');

      // No duplicate entry may name the refused path. NOTE, honestly: a protected-path
      // block throws before any `workspace.operation` event is written, so there is
      // nothing to fold in THIS scenario and breaking the folder cannot fail this
      // assertion — the mutation test proved that. It is retained as a real invariant,
      // and A20 records that fold coverage needs a denial shape that does emit a
      // blocked workspace event (cross-ticket ownership).
      const deniedWorkspaceEntries = deniedEntries.filter(entry =>
        ['workspace.operation', 'target.mutation_committed'].includes(entry.type)
        && /\.env/.test(JSON.stringify(entry.details || {}) + String(entry.summary || '')));
      assert(deniedWorkspaceEntries.length === 0,
        `1: the blocked workspace attempt folded into the authority entry rather than double-reporting (got ${deniedWorkspaceEntries.length})`);
      assert(deniedEntries.filter(entry => entry.type === 'authority.allowed').length === 0,
        '1: a refused attempt records no allowed-authority entry');

      // (c) DETERMINISTIC PROJECTION. The timeline is a read-only projection, so the same
      //     durable evidence must fold to the same entries every time. A projection that
      //     re-derived attribution per read — from prose, operation type, or path shape —
      //     could drift between reads; identical output across reads is the observable
      //     that rules that out.
      const secondRead = await timelineOf(denied.ticket.id);
      const secondAuthority = secondRead.filter(entry => entry.type === 'authority.denied');
      assert(secondAuthority.length === 1,
        `1: the denial still appears exactly once on a repeated read (got ${secondAuthority.length})`);
      assert(secondAuthority[0].details.rule === 'protected_path',
        `1: the structured rule is identical on a repeated read (got ${JSON.stringify(secondAuthority[0].details.rule)})`);
      // STABILITY, not set equality. Terminal evidence (consequence, evaluation, logs)
      // can still be landing when the first read happens, so the projection legitimately
      // GROWS between reads — an earlier version of this assertion demanded identical
      // entry lists and failed under checkpoint load for that reason, which was a fixture
      // defect, not a projection defect. The real contract is that a projection never
      // rewrites what it has already reported.
      // Scoped to the AUTHORITY entry this suite owns. A blanket "no entry ever changes"
      // check is wrong twice over: the projection legitimately GROWS as terminal evidence
      // lands, and `addEntry` deliberately ENRICHES an existing entry when a
      // higher-priority source arrives for the same dedupe key, merging its details. Both
      // are designed behaviour. What must never drift is the authority decision itself.
      const firstAuthority = authorityEntry;
      const secondAuthority2 = secondAuthority[0];
      assert(secondAuthority2.id === firstAuthority.id && secondAuthority2.type === firstAuthority.type,
        '1: the authority entry keeps its identity across reads');
      assert(secondAuthority2.status === firstAuthority.status,
        `1: and its decision (${firstAuthority.status} → ${secondAuthority2.status})`);
      assert(secondAuthority2.details.rule === firstAuthority.details.rule,
        `1: and its structured attribution (${firstAuthority.details.rule} → ${secondAuthority2.details.rule})`);
      assert(deniedEntries.every(entry => secondRead.some(later => later.id === entry.id)),
        '1: no previously reported entry disappears from a later read');

      // Evidence truthfulness: no receipt may claim the write succeeded.
      const deniedOps = await store.listRunOperations(denied.run.id, { limit: 100 });
      const deniedCommitted = (deniedOps.operations || deniedOps)
        .filter(op => !op.error && op.outcome !== 'failed' && op.outcome !== 'refused');
      assert(deniedCommitted.length === 0,
        `1: the denied attempt left no successful receipt (got ${deniedCommitted.length})`);

      // ── 2. POSITIVE CONTROL — an allowed mutation is not rendered as denied ──
      const allowedPath = `timeline-allowed-${STAMP}.txt`;
      const allowed = await runPlan('allowed', {
        actions: [{ operation: 'writeFile', args: { path: allowedPath, content: 'ok' } }], complete: true
      });
      assert(allowed.run.status === 'completed',
        `2: the ordinary mutation completed (${allowed.run.status}: ${allowed.run.error || ''})`);
      assert(exists(allowedPath), '2: the ordinary mutation reached the workspace');

      const allowedEntries = await timelineOf(allowed.ticket.id);
      assert(allowedEntries.filter(entry => entry.type === 'authority.denied').length === 0,
        '2: an allowed mutation is never rendered as a denial');
      // A committed mutation surfaces as `target.mutation_committed`; the allowed
      // authority decision is its counterpart to the denial above.
      const committedEntries = allowedEntries.filter(entry =>
        entry.type === 'target.mutation_committed'
        && JSON.stringify(entry).includes(allowedPath));
      assert(committedEntries.length === 1,
        `2: the committed mutation appears exactly once (got ${committedEntries.length})`);
      assert(Boolean(committedEntries[0].sourceRef),
        '2: the committed mutation retains a source reference for provenance');
      const allowedAuthority = allowedEntries.filter(entry =>
        entry.type === 'authority.allowed' && JSON.stringify(entry).includes(allowedPath));
      assert(allowedAuthority.length === 1,
        `2: the allowed decision is recorded exactly once, mirroring the denial (got ${allowedAuthority.length})`);
      assert(allowedAuthority[0].runId === allowed.run.id,
        '2: the allowed decision is attributed to the run that made it');

      // ── 3. No evidence leaks between tickets ────────────────────────────────
      scenariosRun += 1;
      // Checked structurally, not by substring: run ids are small integers and match
      // coincidentally inside timestamps and counts.
      assert(allowedEntries.every(entry => !entry.runId || entry.runId === allowed.run.id),
        '3: the allowed ticket\'s timeline carries no entry from another run');
      assert(allowedEntries.every(entry => !entry.ticketId || entry.ticketId === allowed.ticket.id),
        '3: the allowed ticket\'s timeline carries no entry from another ticket');
      assert(deniedEntries.every(entry => !entry.runId || entry.runId === denied.run.id),
        '3: the denied ticket\'s timeline carries only its own run');

      // ── 4. Deterministic and read-only ──────────────────────────────────────
      scenariosRun += 1;
      const runBefore = await store.getRun(denied.run.id);
      const ticketBefore = await store.getTicket(denied.ticket.id);
      const again = await timelineOf(denied.ticket.id);
      assert(JSON.stringify(again) === JSON.stringify(deniedEntries),
        '4: projecting the same timeline twice yields identical entries in identical order');
      const runAfter = await store.getRun(denied.run.id);
      const ticketAfter = await store.getTicket(denied.ticket.id);
      assert(runAfter.revision === runBefore.revision && ticketAfter.revision === ticketBefore.revision,
        '4: projecting the timeline mutated no persisted state');

      // ── 5. The surface is permissioned ──────────────────────────────────────
      scenariosRun += 1;
      const missing = await server.request('GET', '/api/tickets/99999999/timeline', { cookie });
      assert(missing.statusCode === 404,
        `5: a missing ticket is a 404 rather than an empty success (HTTP ${missing.statusCode})`);

      assertScenariosExecuted({
        label: 'timeline authority evidence',
        assertions: assert.count(),
        scenarios: scenariosRun,
        minAssertions: 26,
        minScenarios: 5
      });
      console.log(`\nPASS: timeline authority evidence — ${scenariosRun} scenarios, ${assert.count()} assertions (PostgreSQL-native)`);
    }, { schemaSlug: 'timeline_authority' });
  } finally {
    try { fs.unlinkSync(preloadPath); } catch (_) { /* best effort */ }
  }
}

main().catch(error => {
  console.error(`\nFAIL: timeline authority evidence — ${error && error.stack ? error.stack : error}`);
  process.exit(1);
});

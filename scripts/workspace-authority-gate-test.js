#!/usr/bin/env node
'use strict';
// Workspace authority gates, end to end — PostgreSQL-native
// (docs/ARCHITECTURAL_DECISIONS_PENDING.md, A20).
//
// Extracted from `operational-abuse-test.js`, which A20 split rather than migrated
// whole. Most of that suite's fifteen scenarios have registered successors; its
// uncovered residue is authority and gate enforcement, which is what this focused
// suite owns.
//
// WHAT WAS ACTUALLY UNCOVERED. `protected_path` appears in the registered checkpoint
// only inside `workspace-snapshot-availability-test.js`, and there only as a PURE
// classifier check — `classifyWorkspaceSnapshotFailure({ kind: 'protected_path' })`.
// Nothing drove a real run at a protected path and observed the runtime refuse it.
// A classifier agreeing with itself is not evidence that the gate fires.
//
// THE CONTRACT:
//   1. a mutation targeting a protected path is REFUSED, the run fails, and the
//      refusal is recorded as authority evidence rather than a generic error
//   2. nothing reaches the workspace and no receipt claims otherwise
//   3. the same agent, same run shape, an ordinary path — SUCCEEDS
//
// (3) is load-bearing. Without it every assertion in (1) and (2) would also pass
// against a runtime that refused all mutations, or one that never dispatched a run at
// all. A denial suite with no positive control cannot tell "correctly refused" from
// "nothing worked".
//
// The parent suite exited 0 while asserting nothing — its runner reported
// `Total: 0 | Passed: 0 | Failed: 0` — so nothing here may pass by default: every
// scenario is counted and the suite refuses a zero-assertion exit.
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
  const preloadPath = path.join(os.tmpdir(), `authority-gate-stub-${process.pid}-${STAMP}.js`);
  fs.writeFileSync(preloadPath, `
function okResponse(plan) {
  return { ok: true, status: 200, headers: new Map([['x-request-id', 'fake-authority-gate']]),
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
    await withHarness('workspace authority gate', async ({ store, workspaceRoot, startServer }) => {
      const agent = (await store.createConfiguredAgent({
        value: { name: `AuthorityGate-${STAMP}`, provider: 'openai', model: 'gpt-4.1-mini', apiKey: 'test-key-authority-gate' },
        groupIds: [], changedBy: 'workspace-authority-gate-test'
      })).agent;

      const server = await startServer({ env: {
        NODE_OPTIONS: `--require ${preloadPath}`,
        RUNTIME_SCHEDULER_INTERVAL_MS: '200',
        RUN_LEASE_DURATION_MS: '60000'
      } });
      const cookie = await server.login();

      async function runPlan(label, plan) {
        scenariosRun += 1;
        const objective = `authority-gate ${label} ${STAMP} #ACTIONS=${encodeActions(plan)}`;
        const created = await server.request('POST', '/tickets', {
          cookie,
          form: { objective, assignmentTargetType: 'agent', assignmentTargetId: String(agent.id), assignmentMode: 'individual' }
        });
        assert(created.statusCode === 302, `${label}: ticket create was accepted (HTTP ${created.statusCode})`);
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
        const events = (await store.listRunEvents(terminal.id, { afterSeq: -1, limit: 500 })) || [];
        const ops = await store.listRunOperations(terminal.id, { limit: 200 });
        return { ticket, run: terminal, events, operations: ops.operations || ops };
      }

      const exists = rel => fs.existsSync(path.join(workspaceRoot, rel));

      // ── 1. A protected path is refused ──────────────────────────────────────
      // `.env` is in config/protected-paths.json. The refusal must be an AUTHORITY
      // decision, not an incidental write failure.
      const blocked = await runPlan('protected', {
        actions: [{ operation: 'writeFile', args: { path: '.env', content: 'SECRET=leaked' } }], complete: true
      });
      assert(blocked.run.status === 'failed',
        `1: a protected-path mutation fails the run (got ${blocked.run.status})`);
      assert(/protected/i.test(String(blocked.run.error || '')),
        `1: the failure names the protected path (got ${blocked.run.error})`);
      assert(!exists('.env'), '1: the protected file was never created');

      const denials = blocked.events.filter(event => event.type === 'authority.denied');
      assert(denials.length > 0, '1: the refusal is recorded as an authority denial');
      // The denial must carry the structured rule and the pattern that matched, not
      // just prose — an operator reconstructing why a run was refused reads these.
      const protectedDenial = denials.find(event => {
        const payload = event.payload || event;
        return payload.rule === 'protected_path'
          || /protected/i.test(String(payload.reason || ''));
      });
      assert(Boolean(protectedDenial),
        `1: the denial names the protected-path rule (got ${JSON.stringify(denials.map(d => (d.payload || {}).rule || (d.payload || {}).reason))})`);
      const denialPayload = protectedDenial.payload || protectedDenial;
      assert(String(denialPayload.path || '').includes('.env') || /\.env/.test(String(denialPayload.reason || '')),
        '1: the denial names the path it refused');

      // Evidence truthfulness: nothing may claim the write happened.
      const committed = blocked.operations.filter(op =>
        op.operation === 'writeFile' && !op.error && op.outcome !== 'failed' && op.outcome !== 'refused');
      assert(committed.length === 0,
        `1: no receipt claims a successful write to the protected path (got ${committed.length})`);

      // ── 2. Containment: escaping the workspace root is refused too ──────────
      const escape = await runPlan('escape', {
        actions: [{ operation: 'writeFile', args: { path: '../escaped.txt', content: 'out' } }], complete: true
      });
      assert(escape.run.status === 'failed',
        `2: a path escaping the workspace root fails the run (got ${escape.run.status})`);
      assert(!fs.existsSync(path.join(workspaceRoot, '..', 'escaped.txt')),
        '2: nothing was written outside the workspace root');
      const escapeCommitted = escape.operations.filter(op =>
        op.operation === 'writeFile' && !op.error && op.outcome !== 'failed' && op.outcome !== 'refused');
      assert(escapeCommitted.length === 0,
        '2: no receipt claims a successful write outside the root');

      // ── 3. POSITIVE CONTROL — the same agent, an ordinary path ─────────────
      // Without this, every assertion above also passes against a runtime that
      // refuses everything, or one that never runs anything at all.
      const allowed = await runPlan('allowed', {
        actions: [{ operation: 'writeFile', args: { path: `authority-gate-allowed-${STAMP}.txt`, content: 'ok' } }],
        complete: true
      });
      assert(allowed.run.status === 'completed',
        `3: an ordinary mutation by the same agent succeeds (got ${allowed.run.status}: ${allowed.run.error})`);
      assert(exists(`authority-gate-allowed-${STAMP}.txt`),
        '3: the ordinary mutation actually reached the workspace');
      const allowedCommitted = allowed.operations.filter(op =>
        op.operation === 'writeFile' && !op.error && op.outcome !== 'failed' && op.outcome !== 'refused');
      assert(allowedCommitted.length === 1,
        `3: exactly one successful receipt was recorded (got ${allowedCommitted.length})`);
      assert(allowed.events.filter(event => event.type === 'authority.denied').length === 0,
        '3: an ordinary mutation records no authority denial');

      assertScenariosExecuted({
        label: 'workspace authority gate',
        assertions: assert.count(),
        scenarios: scenariosRun,
        minAssertions: 14,
        minScenarios: 3
      });
      console.log(`\nPASS: workspace authority gates — ${scenariosRun} scenarios, ${assert.count()} assertions (PostgreSQL-native)`);
    }, { schemaSlug: 'authority_gate' });
  } finally {
    try { fs.unlinkSync(preloadPath); } catch (_) { /* best effort */ }
  }
}

main().catch(error => {
  console.error(`\nFAIL: workspace authority gates — ${error && error.stack ? error.stack : error}`);
  process.exit(1);
});

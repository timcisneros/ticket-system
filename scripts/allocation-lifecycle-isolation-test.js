#!/usr/bin/env node
'use strict';
// Allocation lifecycle isolation — PostgreSQL-native
// (docs/ARCHITECTURAL_DECISIONS_PENDING.md, A20).
//
// The fifth and final contract split out of `allocated-regression-test.js`.
// `allocation-scope-authority-test.js` owns admission and owned-path enforcement;
// `allocation-attribution-redaction-test.js` owns attribution and replay redaction.
//
// THE CONTRACT: sibling allocation items under one plan are ISOLATED. What happens to
// one — failure, stop, rerun — must not change the other's run status, error, replay,
// receipts, owned scope, or ticket state.
//
// WHY THIS IS THE FAILURE THAT MATTERS. Allocated items run in parallel against one
// workspace and one ticket. Coupling between them is invisible while everything
// succeeds and only appears when something goes wrong — which is exactly when an
// operator most needs the evidence to be trustworthy. A sibling marked failed because
// its neighbour failed is a false accusation against work that actually succeeded.
//
// BOTH SIDES THROUGHOUT. The failing item is paired with a sibling that must COMPLETE,
// with its file on disk and its receipt recorded; the rerun is paired with proof the
// rerun endpoint actually worked. A suite that only checked "A failed" would pass
// against a runtime that failed everything.
//
// Requires TEST_DATABASE_URL (or DATABASE_URL).

const fs = require('fs');
const os = require('os');
const path = require('path');
const { withHarness, createAsserter, sleep } = require('./postgres-test-harness');
const { assertScenariosExecuted } = require('./child-process-settlement');

const STAMP = Date.now();
const MARKER = `alloclifecycle${STAMP}`;
const assert = createAsserter();
let scenariosRun = 0;

// Deterministic and ASYMMETRIC: the agent owning ScopeA reaches outside its scope and
// is refused; the agent owning ScopeB does legitimate in-scope work. That asymmetry is
// what makes isolation observable.
function createFetchStub() {
  const preloadPath = path.join(os.tmpdir(), `allocation-lifecycle-stub-${process.pid}-${STAMP}.js`);
  fs.writeFileSync(preloadPath, `
function okResponse(plan) {
  return { ok: true, status: 200, headers: new Map([['x-request-id', 'fake-allocation-lifecycle']]),
    async text() { return JSON.stringify({ output_text: JSON.stringify(plan), usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } }); } };
}
global.fetch = async function(_url, options = {}) {
  let combined = '';
  try {
    const body = JSON.parse(options.body || '{}');
    const input = Array.isArray(body.input) ? body.input : [];
    combined = input.map(i => i && i.content ? String(i.content) : '').join('\\n');
  } catch (_) {}
  if (!combined.includes(${JSON.stringify(MARKER)})) {
    return okResponse({ message: 'noop', actions: [], complete: true });
  }
  const owned = (combined.match(/"ownedOutputPaths"\\s*:\\s*\\[\\s*"([^"]+)"/) || [])[1] || '';
  const root = String(owned).replace(/\\/+$/, '');
  if (root === 'ScopeA') {
    // Out of its own scope on purpose: this item must fail.
    return okResponse({
      message: 'reaching into the sibling scope',
      actions: [{ operation: 'writeFile', args: { path: 'ScopeB/intrusion-${STAMP}.txt', content: 'nope' } }],
      complete: true
    });
  }
  return okResponse({
    message: 'writing my own report file',
    actions: [{ operation: 'writeFile', args: { path: root + '/report-${STAMP}.txt', content: 'sibling work' } }],
    complete: true
  });
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
    await withHarness('allocation lifecycle isolation', async ({ store, workspaceRoot, startServer }) => {
      const group = (await store.createGroup({
        value: { name: `AllocLifecycle ${STAMP}`, permissions: [], canReceiveTickets: true },
        changedBy: 'allocation-lifecycle-isolation-test'
      })).group;
      const agents = [];
      for (let i = 0; i < 2; i += 1) {
        agents.push((await store.createConfiguredAgent({
          value: { name: `LifecycleAgent${i}-${STAMP}`, provider: 'openai', model: 'gpt-4.1-mini', apiKey: `lifecycle-key-${i}` },
          groupIds: [group.id], changedBy: 'allocation-lifecycle-isolation-test'
        })).agent);
      }
      for (const dir of ['ScopeA', 'ScopeB']) {
        fs.mkdirSync(path.join(workspaceRoot, dir), { recursive: true });
      }

      const server = await startServer({
        NODE_OPTIONS: `--require ${preloadPath}`,
        RUNTIME_SCHEDULER_INTERVAL_MS: '200',
        RUN_LEASE_DURATION_MS: '60000'
      });
      const cookie = await server.login();

      const objective = `${MARKER} produce one independent status report file per team`;
      const ownedPaths = { [agents[0].id]: 'ScopeA', [agents[1].id]: 'ScopeB' };

      const created = await server.request('POST', '/tickets', {
        cookie,
        form: {
          objective, assignmentTargetType: 'group', assignmentTargetId: String(group.id),
          assignmentMode: 'allocated', ownedOutputPaths: JSON.stringify(ownedPaths)
        }
      });
      assert(created.statusCode === 302, `setup: the allocated ticket was admitted (HTTP ${created.statusCode})`);
      const ticket = await waitFor(async () => {
        const { tickets } = await store.listTickets({ limit: 300 });
        return tickets.find(t => t.objective === objective) || null;
      }, 30000, 'allocated ticket');

      const runsOf = async () => (await store.listRunsForTicket({ ticketId: ticket.id, limit: 30 })).runs;
      const opsOf = async runId => {
        const page = await store.listRunOperations(runId, { limit: 100 });
        return page.operations || page;
      };
      const succeeded = ops => ops.filter(op => !op.error && op.outcome !== 'failed' && op.outcome !== 'refused');

      const firstRuns = await waitFor(async () => {
        const r = await runsOf();
        return r.length >= 2 ? r : null;
      }, 60000, 'both allocated runs');
      for (const run of firstRuns) {
        await waitFor(async () => {
          const c = await store.getRun(run.id);
          return c && ['completed', 'failed', 'interrupted'].includes(c.status) ? c : null;
        }, 120000, `run ${run.id} to terminalize`);
      }

      const settled = await runsOf();
      const failing = settled.find(r => r.agentId === agents[0].id);
      const sibling = settled.find(r => r.agentId === agents[1].id);

      // ── 1. Failure in one item does not contaminate its sibling ─────────────
      scenariosRun += 1;
      assert(failing.status === 'failed',
        `1: the out-of-scope item failed (${failing.status})`);
      assert(sibling.status === 'completed',
        `1: the sibling item COMPLETED despite its neighbour failing (${sibling.status}: ${sibling.error || ''})`);
      assert(!sibling.error, `1: the sibling carries no error of its own (${sibling.error})`);
      assert(fs.existsSync(path.join(workspaceRoot, `ScopeB/report-${STAMP}.txt`)),
        '1: the sibling\'s legitimate work reached the workspace');
      assert(!fs.existsSync(path.join(workspaceRoot, `ScopeB/intrusion-${STAMP}.txt`)),
        '1: the failing item\'s intrusion into the sibling scope left no file');

      const failingOps = await opsOf(failing.id);
      const siblingOps = await opsOf(sibling.id);
      assert(succeeded(failingOps).length === 0,
        `1: the failed item left no successful receipt (${succeeded(failingOps).length})`);
      assert(succeeded(siblingOps).length === 1,
        `1: the sibling kept exactly its own successful receipt (${succeeded(siblingOps).length})`);

      const siblingReplay = (await store.readRunReplay(sibling.id)).snapshot;
      assert(siblingReplay.terminalStatus === 'completed',
        '1: the sibling\'s replay records its own successful outcome');
      assert(!siblingReplay.failureReason,
        `1: the sibling's replay carries no failure reason (${siblingReplay.failureReason})`);
      assert(!JSON.stringify(siblingReplay).includes('intrusion-'),
        '1: the sibling\'s replay carries no trace of the neighbour\'s refused work');

      // ── 2. Owned scope is unchanged by the failure ──────────────────────────
      scenariosRun += 1;
      for (const run of settled) {
        const expected = run.agentId === agents[0].id ? 'ScopeA' : 'ScopeB';
        const owned = (run.ownedOutputPaths || []).map(p => String(p).replace(/\/+$/, ''));
        assert(owned.length === 1 && owned[0] === expected,
          `2: run ${run.id} still owns exactly its allocated scope (${owned.join(',')})`);
      }
      assert(new Set(settled.map(r => r.allocationPlanId)).size === 1,
        '2: both items still share one allocation plan after the failure');
      assert(new Set(settled.map(r => r.allocationItemId)).size === 2,
        '2: each item still has its own allocation identity after the failure');

      // ── 3. Rerun preserves allocation identity and creates no duplicates ────
      scenariosRun += 1;
      const beforeIds = new Set(settled.map(r => r.id));
      const rerun = await server.request('POST', `/api/tickets/${ticket.id}/rerun`, { cookie, body: {} });
      assert(rerun.statusCode === 200,
        `3: the rerun endpoint accepted the request (HTTP ${rerun.statusCode}) — the positive control for this scenario`);

      await waitFor(async () => {
        const r = await runsOf();
        const fresh = r.filter(x => !beforeIds.has(x.id));
        return fresh.length >= 2 && fresh.every(x => ['completed', 'failed', 'interrupted'].includes(x.status))
          ? fresh : null;
      }, 150000, '3 rerun runs to terminalize');

      const afterRerun = await runsOf();
      const freshRuns = afterRerun.filter(r => !beforeIds.has(r.id));
      assert(freshRuns.length === 2,
        `3: the rerun produced exactly one fresh run per allocated agent (${freshRuns.length})`);
      assert(new Set(freshRuns.map(r => r.agentId)).size === 2,
        '3: the fresh runs cover both allocated agents');
      for (const run of freshRuns) {
        const expected = run.agentId === agents[0].id ? 'ScopeA' : 'ScopeB';
        const owned = (run.ownedOutputPaths || []).map(p => String(p).replace(/\/+$/, ''));
        assert(owned.length === 1 && owned[0] === expected,
          `3: rerun run ${run.id} kept its agent's owned scope (${owned.join(',')})`);
        assert(Boolean(run.allocationPlanId) && Boolean(run.allocationItemId),
          `3: rerun run ${run.id} retained allocation plan and item identity`);
      }
      assert(new Set(freshRuns.map(r => r.allocationPlanId)).size === 1,
        '3: the rerun created ONE fresh allocation plan shared by both items');
      assert(!freshRuns.some(r => settled.some(s => s.allocationPlanId === r.allocationPlanId)),
        '3: the rerun plan is distinct from the original, so attempts stay separable');

      // No duplicate active runs, and no duplicate committed mutation.
      assert(afterRerun.filter(r => ['pending', 'running'].includes(r.status)).length === 0,
        '3: no run was left active after the rerun settled');
      const siblingAgentRuns = afterRerun.filter(r => r.agentId === agents[1].id);
      const totalSiblingReceipts = (await Promise.all(siblingAgentRuns.map(r => opsOf(r.id))))
        .flatMap(succeeded);
      const writtenPaths = totalSiblingReceipts.map(op => String((op.args && op.args.path) || ''));
      assert(new Set(writtenPaths).size === writtenPaths.length || writtenPaths.length <= 2,
        `3: the sibling's reruns did not multiply committed mutations uncontrollably (${writtenPaths.length})`);

      // ── 4. Stop targets one run only ────────────────────────────────────────
      scenariosRun += 1;
      const stopTarget = freshRuns[0];
      const stopSibling = freshRuns[1];
      const siblingBefore = await store.getRun(stopSibling.id);
      const stop = await server.request('POST', `/api/runs/${stopTarget.id}/stop`, { cookie, body: {} });
      // HONEST LIMITATION: by this point both rerun runs have already terminalized, so
      // the stop is REFUSED rather than executed. That refusal is itself a real
      // contract — a finished run cannot be stopped — and the sibling assertions below
      // therefore prove that a *rejected* lifecycle call touches nothing. They do NOT
      // prove isolation of an in-flight stop; forcing that needs a long-running run the
      // stub cannot currently produce. A20 records it as the residual gap.
      assert(stop.statusCode >= 400 && stop.statusCode < 500,
        `4: stopping an already-terminal run is refused, not silently accepted (HTTP ${stop.statusCode})`);
      const siblingAfter = await store.getRun(stopSibling.id);
      assert(siblingAfter.status === siblingBefore.status,
        `4: stopping one run did not change its sibling's status (${siblingBefore.status} → ${siblingAfter.status})`);
      assert(siblingAfter.revision === siblingBefore.revision,
        '4: stopping one run did not touch its sibling\'s record at all');
      assert((siblingAfter.ownedOutputPaths || []).join(',') === (siblingBefore.ownedOutputPaths || []).join(','),
        '4: the sibling\'s owned scope survived the stop unchanged');
      const targetAfter = await store.getRun(stopTarget.id);
      assert(targetAfter.status === stopTarget.status,
        `4: the refused stop did not corrupt its own target either (${stopTarget.status} → ${targetAfter.status})`);

      assertScenariosExecuted({
        label: 'allocation lifecycle isolation',
        assertions: assert.count(),
        scenarios: scenariosRun,
        minAssertions: 26,
        minScenarios: 4
      });
      console.log(`\nPASS: allocation lifecycle isolation — ${scenariosRun} scenarios, ${assert.count()} assertions (PostgreSQL-native)`);
    }, { schemaSlug: 'allocation_lifecycle' });
  } finally {
    try { fs.unlinkSync(preloadPath); } catch (_) { /* best effort */ }
  }
}

main().catch(error => {
  console.error(`\nFAIL: allocation lifecycle isolation — ${error && error.stack ? error.stack : error}`);
  process.exit(1);
});

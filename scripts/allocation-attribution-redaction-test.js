#!/usr/bin/env node
'use strict';
// Allocation attribution and replay redaction — PostgreSQL-native
// (docs/ARCHITECTURAL_DECISIONS_PENDING.md, A20).
//
// Contracts 2 and 3 of the five recorded in `allocated-regression-test.js`.
// `allocation-scope-authority-test.js` already owns admission and owned-path
// enforcement; the retry/rerun/stop lifecycle is the remaining one.
//
// ATTRIBUTION. Parallel allocation items run concurrently against one workspace, so
// every piece of evidence has to name which item produced it. The failure that matters
// is not "attribution is missing" but "attribution is WRONG" — item B's receipt filed
// under item A is worse than no receipt, because it is confidently false. So this
// asserts the mapping is a bijection: each run belongs to exactly one item, items are
// distinct, and no run carries a sibling's identifiers.
//
// REDACTION. Provider credentials must never reach replay evidence or rendered
// diagnostics. Absence assertions are only meaningful against DISTINCTIVE values, so
// each agent gets a unique high-entropy fake key: a test asserting "the snapshot does
// not contain 'sk-test'" would pass on an empty snapshot.
//
// WHAT THE REDACTION HALF ACTUALLY IS, stated honestly. Two mutations were attempted
// against it and both showed the same thing: the agent's `apiKey` never reaches the
// replay path at all. Disabling `sanitizeSnapshotValue`'s key redaction changed
// nothing, because the snapshot records `assignedAgentId`, `provider` and `model` —
// not the agent record. Credentials are therefore kept out BY CONSTRUCTION, not by an
// active redaction step on this path. These assertions are a REGRESSION GUARD on a leak
// that does not currently exist, which is worth having and worth not overstating.
//
// THE POSITIVE CONTROL IS THE LOAD-BEARING PART OF REDACTION. Every "secret absent"
// assertion is paired with proof that the snapshot is genuinely POPULATED — allocation
// identity, owned scope, provider name, model, actions and terminal status all present.
// Without that, deleting the replay snapshot entirely would make this suite greener.
//
// Requires TEST_DATABASE_URL (or DATABASE_URL).

const fs = require('fs');
const os = require('os');
const path = require('path');
const { withHarness, createAsserter, sleep } = require('./postgres-test-harness');
const { assertScenariosExecuted } = require('./child-process-settlement');

const STAMP = Date.now();
const MARKER = `allocattrib${STAMP}`;
// Distinctive, high-entropy, and structurally unlike anything the runtime emits, so a
// match is unambiguous and an absence assertion means something.
const SECRETS = [
  `sk-ALLOCSECRETZERO-${STAMP}-aaaaaaaaaaaa`,
  `sk-ALLOCSECRETONE-${STAMP}-bbbbbbbbbbbb`
];
const assert = createAsserter();
let scenariosRun = 0;

function createFetchStub() {
  const preloadPath = path.join(os.tmpdir(), `allocation-attrib-stub-${process.pid}-${STAMP}.js`);
  fs.writeFileSync(preloadPath, `
function okResponse(plan) {
  return { ok: true, status: 200, headers: new Map([['x-request-id', 'fake-allocation-attrib']]),
    async text() { return JSON.stringify({ output_text: JSON.stringify(plan), usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } }); } };
}
global.fetch = async function(_url, options = {}) {
  let combined = '';
  try {
    const body = JSON.parse(options.body || '{}');
    const input = Array.isArray(body.input) ? body.input : [];
    combined = input.map(i => i && i.content ? String(i.content) : '').join('\\n');
  } catch (_) {}
  const owned = (combined.match(/"ownedOutputPaths"\\s*:\\s*\\[\\s*"([^"]+)"/) || [])[1] || 'ScopeA';
  const root = String(owned).replace(/\\/+$/, '');
  if (combined.includes(${JSON.stringify(MARKER)})) {
    return okResponse({
      message: 'writing my own report',
      actions: [{ operation: 'writeFile', args: { path: root + '/report-${STAMP}.txt', content: 'report for ' + root } }],
      complete: true
    });
  }
  return okResponse({ message: 'noop', actions: [], complete: true });
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
    await withHarness('allocation attribution and redaction', async ({ store, workspaceRoot, startServer }) => {
      const group = (await store.createGroup({
        value: { name: `AllocAttrib ${STAMP}`, permissions: [], canReceiveTickets: true },
        changedBy: 'allocation-attribution-redaction-test'
      })).group;
      const agents = [];
      for (let i = 0; i < 2; i += 1) {
        agents.push((await store.createConfiguredAgent({
          value: { name: `AttribAgent${i}-${STAMP}`, provider: 'openai', model: 'gpt-4.1-mini', apiKey: SECRETS[i] },
          groupIds: [group.id], changedBy: 'allocation-attribution-redaction-test'
        })).agent);
      }
      for (const dir of ['ScopeA', 'ScopeB']) {
        fs.mkdirSync(path.join(workspaceRoot, dir), { recursive: true });
      }

      const server = await startServer({ env: {
        NODE_OPTIONS: `--require ${preloadPath}`,
        RUNTIME_SCHEDULER_INTERVAL_MS: '200',
        RUN_LEASE_DURATION_MS: '60000'
      } });
      const cookie = await server.login();

      const objective = `${MARKER} produce one independent status report file per team`;
      const created = await server.request('POST', '/tickets', {
        cookie,
        form: {
          objective, assignmentTargetType: 'group', assignmentTargetId: String(group.id),
          assignmentMode: 'allocated',
          ownedOutputPaths: JSON.stringify({ [agents[0].id]: 'ScopeA', [agents[1].id]: 'ScopeB' })
        }
      });
      assert(created.statusCode === 302, `setup: the allocated ticket was admitted (HTTP ${created.statusCode})`);
      const ticket = await waitFor(async () => {
        const { tickets } = await store.listTickets({ limit: 300 });
        return tickets.find(t => t.objective === objective) || null;
      }, 30000, 'allocated ticket');
      const runs = await waitFor(async () => {
        const { runs: r } = await store.listRunsForTicket({ ticketId: ticket.id, limit: 20 });
        return r.length >= 2 ? r : null;
      }, 60000, 'both allocated runs');
      for (const run of runs) {
        await waitFor(async () => {
          const current = await store.getRun(run.id);
          return current && ['completed', 'failed', 'interrupted'].includes(current.status) ? current : null;
        }, 120000, `run ${run.id} to terminalize`);
      }
      const terminal = (await store.listRunsForTicket({ ticketId: ticket.id, limit: 20 })).runs;
      assert(terminal.every(r => r.status === 'completed'),
        `setup: both allocated runs completed (${terminal.map(r => r.status).join(',')})`);

      // ── 1. Attribution is a bijection, not merely present ───────────────────
      scenariosRun += 1;
      const byAgent = new Map(terminal.map(r => [r.agentId, r]));
      assert(byAgent.size === 2, '1: the two runs belong to two distinct agents');
      assert(new Set(terminal.map(r => r.allocationPlanId)).size === 1,
        '1: both runs name the same allocation plan');
      assert(new Set(terminal.map(r => r.allocationItemId)).size === 2,
        '1: each run names its own allocation item');
      for (const run of terminal) {
        assert(run.ticketId === ticket.id, `1: run ${run.id} names its parent ticket`);
        const expected = run.agentId === agents[0].id ? 'ScopeA' : 'ScopeB';
        const owned = (run.ownedOutputPaths || []).map(p => String(p).replace(/\/+$/, ''));
        assert(owned.length === 1 && owned[0] === expected,
          `1: run ${run.id} owns exactly the scope its agent was allocated (${owned.join(',')})`);
      }

      // ── 2. Evidence does not cross between parallel items ───────────────────
      scenariosRun += 1;
      const runA = byAgent.get(agents[0].id);
      const runB = byAgent.get(agents[1].id);
      const opsOf = async runId => {
        const page = await store.listRunOperations(runId, { limit: 100 });
        return (page.operations || page);
      };
      const opsA = await opsOf(runA.id);
      const opsB = await opsOf(runB.id);
      const pathsOf = ops => ops.map(op => String((op.args && op.args.path) || op.artifactPath || ''));

      assert(opsA.length >= 1 && opsB.length >= 1, '2: both items produced operation receipts');
      assert(pathsOf(opsA).every(p => p.startsWith('ScopeA')),
        `2: item A's receipts stay inside its own scope (${pathsOf(opsA).join(',')})`);
      assert(pathsOf(opsB).every(p => p.startsWith('ScopeB')),
        `2: item B's receipts stay inside its own scope (${pathsOf(opsB).join(',')})`);
      assert(opsA.every(op => op.runId === runA.id) && opsB.every(op => op.runId === runB.id),
        '2: every receipt is filed under the run that produced it');

      // Negative control: a sibling's identifiers must not appear on the wrong run.
      assert(runA.allocationItemId !== runB.allocationItemId,
        '2: neither run carries its sibling\'s allocation item id');
      const eventsA = await store.listRunEvents(runA.id, { afterSeq: -1, limit: 500 });
      assert((eventsA || []).every(e => !e.runId || e.runId === runA.id),
        '2: item A\'s event stream carries no sibling run');
      assert(!JSON.stringify(eventsA || []).includes('ScopeB'),
        '2: item A\'s events never mention its sibling\'s scope');

      // ── 3. Replay is POPULATED — the control for every absence below ────────
      scenariosRun += 1;
      const replays = {};
      for (const run of terminal) {
        const record = await store.readRunReplay(run.id);
        assert(Boolean(record && record.snapshot), `3: run ${run.id} has a replay snapshot`);
        replays[run.id] = record.snapshot;
      }
      for (const run of terminal) {
        const snap = replays[run.id];
        const expected = run.agentId === agents[0].id ? 'ScopeA' : 'ScopeB';
        assert(snap.runId === run.id && snap.ticketId === ticket.id,
          `3: replay ${run.id} records its own run and ticket identity`);
        assert(snap.assignedAgentId === run.agentId,
          `3: replay ${run.id} records the agent that executed it`);
        assert(snap.terminalStatus === run.status,
          `3: replay ${run.id} agrees with the run's terminal status`);
        assert(Array.isArray(snap.workspaceOperations) && snap.workspaceOperations.length >= 1,
          `3: replay ${run.id} records the actions it performed`);
        assert(JSON.stringify(snap).includes(expected),
          `3: replay ${run.id} records its owned scope, so the absence checks below are meaningful`);
        assert(Boolean(snap.provider) && Boolean(snap.model),
          `3: replay ${run.id} records provider and model`);
      }

      // ── 4. REDACTION — no provider credential reaches durable evidence ──────
      scenariosRun += 1;
      for (const run of terminal) {
        const serialized = JSON.stringify(replays[run.id]);
        for (const secret of SECRETS) {
          assert(!serialized.includes(secret),
            `4: replay ${run.id} does not contain provider key ${secret.slice(0, 22)}…`);
        }
        assert(!/"apiKey"\s*:\s*"[^"]+"/.test(serialized),
          `4: replay ${run.id} carries no populated apiKey field at all`);
        assert(!/Bearer\s+sk-/.test(serialized),
          `4: replay ${run.id} carries no bearer credential`);
      }

      // Cross-item leakage of the OTHER agent's secret is the sharper case: it would
      // mean one allocation could read a sibling's credentials out of shared evidence.
      assert(!JSON.stringify(replays[runA.id]).includes(SECRETS[1]),
        '4: item A\'s replay does not contain item B\'s provider key');
      assert(!JSON.stringify(replays[runB.id]).includes(SECRETS[0]),
        '4: item B\'s replay does not contain item A\'s provider key');

      // ── 5. Rendered operator output is redacted too ─────────────────────────
      scenariosRun += 1;
      for (const run of terminal) {
        const page = await server.request('GET', `/runs/${run.id}`, { cookie });
        assert(page.statusCode === 200, `5: run detail for ${run.id} renders (HTTP ${page.statusCode})`);
        for (const secret of SECRETS) {
          assert(!page.body.includes(secret),
            `5: run detail ${run.id} does not leak provider key ${secret.slice(0, 22)}…`);
        }
        assert(!page.body.includes('passwordHash') && !page.body.includes('sessionId'),
          `5: run detail ${run.id} leaks no password hash or session id`);
        // Control: the page really did render this run's evidence.
        assert(page.body.includes(String(run.id)),
          `5: run detail ${run.id} rendered actual run content, so the absence checks mean something`);
      }

      assertScenariosExecuted({
        label: 'allocation attribution and redaction',
        assertions: assert.count(),
        scenarios: scenariosRun,
        minAssertions: 34,
        minScenarios: 5
      });
      console.log(`\nPASS: allocation attribution and redaction — ${scenariosRun} scenarios, ${assert.count()} assertions (PostgreSQL-native)`);
    }, { schemaSlug: 'allocation_attrib' });
  } finally {
    try { fs.unlinkSync(preloadPath); } catch (_) { /* best effort */ }
  }
}

main().catch(error => {
  console.error(`\nFAIL: allocation attribution and redaction — ${error && error.stack ? error.stack : error}`);
  process.exit(1);
});

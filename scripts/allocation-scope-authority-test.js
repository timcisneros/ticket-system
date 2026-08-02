#!/usr/bin/env node
'use strict';
// Allocation scope authority — PostgreSQL-native
// (docs/ARCHITECTURAL_DECISIONS_PENDING.md, A20).
//
// The authority core of `allocated-regression-test.js`, which A20 splits rather than
// ports: its 1,372 lines carry five separable contracts. This suite owns the two that
// are authority boundaries — scope ADMISSION and owned-path ENFORCEMENT.
//
// HOW THE POSITIVE CONTROL WAS ACHIEVED, because the previous attempt failed here and
// the recorded hypothesis was wrong. A20 guessed that the embedded `#ACTIONS=`
// directive made the objective infeasible. It does not. The real gate is
// `assertAllocatedObjectiveSupported`: an allocated objective must contain an ADDITIVE
// noun (file/folder/report/document/…) and must contain NO destructive verb
// (delete/remove/rename/move/edit/update existing/…). "Write status notes" fails
// because "notes" is not an additive noun — nothing to do with the directive.
//
// So the objectives here are natural language that genuinely describes additive
// independent outputs, and the provider stub keys off a distinct MARKER WORD embedded
// in that objective rather than off an encoded action plan. The feasibility gate is
// exercised for real; nothing is bypassed, disabled, or mocked away.
//
// THE CONTRACT:
//   ADMISSION   malformed owned scopes — overlapping, non-directory, absent — are
//               refused at creation and not persisted
//   ENFORCEMENT an admitted allocated run may mutate only inside its own owned path
//   ATTRIBUTION every run names its plan, item and owned path
//
// BOTH SIDES THROUGHOUT. Refusals are paired with a valid ticket being ADMITTED and
// reaching a real completed run, and the out-of-scope write is paired with an in-scope
// write by the same agent. A rejection-only suite passes against a runtime that refuses
// every allocated ticket — which is exactly why the previous attempt was not committed.
//
// Requires TEST_DATABASE_URL (or DATABASE_URL).

const fs = require('fs');
const os = require('os');
const path = require('path');
const { withHarness, createAsserter, sleep } = require('./postgres-test-harness');
const { assertScenariosExecuted } = require('./child-process-settlement');

const STAMP = Date.now();
const IN_SCOPE_MARKER = `allocinscope${STAMP}`;
const OUT_SCOPE_MARKER = `allocoutscope${STAMP}`;
const assert = createAsserter();
let scenariosRun = 0;

// The stub keys off marker WORDS carried in a natural-language objective, so the
// objective stays valid input to the real feasibility gate.
function createFetchStub() {
  const preloadPath = path.join(os.tmpdir(), `allocation-scope-stub-${process.pid}-${STAMP}.js`);
  fs.writeFileSync(preloadPath, `
function okResponse(plan) {
  return { ok: true, status: 200, headers: new Map([['x-request-id', 'fake-allocation-scope']]),
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
  if (combined.includes(${JSON.stringify(IN_SCOPE_MARKER)})) {
    return okResponse({
      message: 'writing inside my own scope',
      actions: [{ operation: 'writeFile', args: { path: root + '/report-${STAMP}.txt', content: 'in-scope' } }],
      complete: true
    });
  }
  if (combined.includes(${JSON.stringify(OUT_SCOPE_MARKER)})) {
    return okResponse({
      message: 'reaching outside my scope',
      actions: [{ operation: 'writeFile', args: { path: 'ScopeC/stolen-${STAMP}.txt', content: 'out-of-scope' } }],
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
    await withHarness('allocation scope authority', async ({ store, workspaceRoot, startServer }) => {
      const group = (await store.createGroup({
        value: { name: `Allocated ${STAMP}`, permissions: [], canReceiveTickets: true },
        changedBy: 'allocation-scope-authority-test'
      })).group;
      const agents = [];
      for (let i = 0; i < 2; i += 1) {
        agents.push((await store.createConfiguredAgent({
          value: { name: `AllocAgent${i}-${STAMP}`, provider: 'openai', model: 'gpt-4.1-mini', apiKey: `alloc-key-${i}` },
          groupIds: [group.id], changedBy: 'allocation-scope-authority-test'
        })).agent);
      }

      for (const dir of ['ScopeA', 'ScopeB', 'ScopeC']) {
        fs.mkdirSync(path.join(workspaceRoot, dir), { recursive: true });
      }
      fs.writeFileSync(path.join(workspaceRoot, 'NotADirectory.txt'), 'file');

      const server = await startServer({ env: {
        NODE_OPTIONS: `--require ${preloadPath}`,
        RUNTIME_SCHEDULER_INTERVAL_MS: '200',
        RUN_LEASE_DURATION_MS: '60000'
      } });
      const cookie = await server.login();

      const allTickets = async () => (await store.listTickets({ limit: 500 })).tickets;
      const ownedFor = (a0, a1) => ({ [agents[0].id]: a0, [agents[1].id]: a1 });

      async function createAllocated(objective, owned) {
        const form = {
          objective, assignmentTargetType: 'group', assignmentTargetId: String(group.id),
          assignmentMode: 'allocated'
        };
        if (owned !== undefined) form.ownedOutputPaths = JSON.stringify(owned);
        return server.request('POST', '/tickets', { cookie, form });
      }

      // Natural language that genuinely describes additive independent outputs, which
      // is what the real gate requires.
      const objectiveFor = marker => `${marker} produce one independent status report file per team`;

      // ── 1–3. Malformed owned scopes are refused, and nothing is persisted ────
      const rejections = [
        { label: 'overlapping scopes', owned: ownedFor('ScopeA', 'ScopeA'), why: 'two agents cannot own the same path' },
        { label: 'non-directory scope', owned: ownedFor('NotADirectory.txt', 'ScopeB'), why: 'an owned scope must be a directory' },
        { label: 'missing owned paths', owned: undefined, why: 'an allocated ticket must declare owned scopes' }
      ];

      for (const rejection of rejections) {
        scenariosRun += 1;
        const objective = objectiveFor(`reject${rejection.label.replace(/\W/g, '')}${STAMP}`);
        const before = (await allTickets()).length;
        const response = await createAllocated(objective, rejection.owned);
        assert(response.statusCode >= 400 && response.statusCode < 500,
          `${rejection.label}: refused at creation — ${rejection.why} (HTTP ${response.statusCode})`);
        assert((await allTickets()).length === before,
          `${rejection.label}: the refused ticket was not persisted anyway`);
        assert(!(await allTickets()).some(t => t.objective === objective),
          `${rejection.label}: no ticket exists with the refused objective`);
      }

      // ── 4. POSITIVE CONTROL — a well-formed allocation is ADMITTED ───────────
      scenariosRun += 1;
      const inScopeObjective = objectiveFor(IN_SCOPE_MARKER);
      const admitted = await createAllocated(inScopeObjective, ownedFor('ScopeA', 'ScopeB'));
      assert(admitted.statusCode === 302,
        `4: a well-formed allocated ticket is admitted through the real feasibility gate (HTTP ${admitted.statusCode})`);
      const validTicket = await waitFor(async () =>
        (await allTickets()).find(t => t.objective === inScopeObjective) || null, 30000, '4 admitted ticket');
      assert(validTicket.status !== 'blocked',
        `4: the admitted ticket was not blocked by feasibility (status ${validTicket.status})`);

      const validRuns = await waitFor(async () => {
        const { runs } = await store.listRunsForTicket({ ticketId: validTicket.id, limit: 20 });
        return runs.length >= 2 ? runs : null;
      }, 60000, '4 one run per allocated agent');
      assert(validRuns.length === 2, `4: one run per allocated agent (got ${validRuns.length})`);

      // ── 5. Attribution ──────────────────────────────────────────────────────
      scenariosRun += 1;
      for (const run of validRuns) {
        assert(Boolean(run.allocationPlanId), `5: run ${run.id} names its allocation plan`);
        assert(Boolean(run.allocationItemId), `5: run ${run.id} names its allocation item`);
        const owned = (run.ownedOutputPaths || []).map(p => String(p).replace(/\/+$/, ''));
        assert(owned.length === 1, `5: run ${run.id} owns exactly one path (got ${owned.length})`);
        const expected = run.agentId === agents[0].id ? 'ScopeA' : 'ScopeB';
        assert(owned[0] === expected,
          `5: run ${run.id} owns the path its agent was allocated (got ${owned[0]}, expected ${expected})`);
      }
      assert(new Set(validRuns.map(r => r.allocationPlanId)).size === 1,
        '5: both runs share one allocation plan');
      assert(new Set(validRuns.map(r => r.allocationItemId)).size === 2,
        '5: each run has its own allocation item');

      // ── 6. In-scope mutation succeeds ───────────────────────────────────────
      scenariosRun += 1;
      const inScopeRun = validRuns.find(r => r.agentId === agents[0].id);
      const inScopeTerminal = await waitFor(async () => {
        const current = await store.getRun(inScopeRun.id);
        return current && ['completed', 'failed', 'interrupted'].includes(current.status) ? current : null;
      }, 120000, '6 in-scope run to terminalize');
      assert(inScopeTerminal.status === 'completed',
        `6: the in-scope write completed (${inScopeTerminal.status}: ${inScopeTerminal.error || ''})`);
      assert(fs.existsSync(path.join(workspaceRoot, `ScopeA/report-${STAMP}.txt`)),
        '6: the in-scope write reached the agent\'s own scope');
      const inScopeOps = await store.listRunOperations(inScopeRun.id, { limit: 100 });
      assert((inScopeOps.operations || inScopeOps)
        .filter(op => !op.error && op.outcome !== 'failed' && op.outcome !== 'refused').length === 1,
        '6: the in-scope write left exactly one successful receipt');

      // ── 7. ENFORCEMENT — out-of-scope mutation is denied ────────────────────
      scenariosRun += 1;
      const outObjective = objectiveFor(OUT_SCOPE_MARKER);
      const outAdmitted = await createAllocated(outObjective, ownedFor('ScopeA', 'ScopeB'));
      assert(outAdmitted.statusCode === 302,
        `7: the ticket was ADMITTED, so the refusal below comes from enforcement not admission (HTTP ${outAdmitted.statusCode})`);
      const outTicket = await waitFor(async () =>
        (await allTickets()).find(t => t.objective === outObjective) || null, 30000, '7 out-of-scope ticket');
      const outRuns = await waitFor(async () => {
        const { runs } = await store.listRunsForTicket({ ticketId: outTicket.id, limit: 20 });
        return runs.length >= 2 ? runs : null;
      }, 60000, '7 out-of-scope runs');
      const offender = outRuns.find(r => r.agentId === agents[0].id);
      const outTerminal = await waitFor(async () => {
        const current = await store.getRun(offender.id);
        return current && ['completed', 'failed', 'interrupted'].includes(current.status) ? current : null;
      }, 120000, '7 offending run to terminalize');

      assert(outTerminal.status === 'failed',
        `7: writing outside the owned path failed the run (${outTerminal.status})`);
      assert(!fs.existsSync(path.join(workspaceRoot, `ScopeC/stolen-${STAMP}.txt`)),
        '7: the out-of-scope write left no filesystem effect');
      const outOps = await store.listRunOperations(offender.id, { limit: 100 });
      assert((outOps.operations || outOps)
        .filter(op => !op.error && op.outcome !== 'failed' && op.outcome !== 'refused').length === 0,
        '7: the refused write left no successful receipt');
      assert(/scope|owned|ownership/i.test(String(outTerminal.error || '')),
        `7: the failure names the ownership boundary rather than a generic error (${outTerminal.error})`);
      assert(String(outTerminal.error || '').includes('ScopeC')
        || /stolen-/.test(String(outTerminal.error || '')),
        `7: the failure names the refused target (${outTerminal.error})`);

      assertScenariosExecuted({
        label: 'allocation scope authority',
        assertions: assert.count(),
        scenarios: scenariosRun,
        minAssertions: 28,
        minScenarios: 7
      });
      console.log(`\nPASS: allocation scope authority — ${scenariosRun} scenarios, ${assert.count()} assertions (PostgreSQL-native)`);
    }, { schemaSlug: 'allocation_scope' });
  } finally {
    try { fs.unlinkSync(preloadPath); } catch (_) { /* best effort */ }
  }
}

main().catch(error => {
  console.error(`\nFAIL: allocation scope authority — ${error && error.stack ? error.stack : error}`);
  process.exit(1);
});

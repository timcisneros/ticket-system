#!/usr/bin/env node
'use strict';
// Prepared target-effect reconciliation — PostgreSQL-native
// (docs/ARCHITECTURAL_DECISIONS_PENDING.md, A20).
//
// THE SEAM NOTHING ELSE DRIVES. Post-A22 the runtime's nine deterministic crash seams
// are covered five ways; `after_first_workspace_target_effect` is one of the four that
// are not, and this is the only suite in the repository that drives it.
//
// It is also the most dangerous window in the runtime: the external effect has already
// landed on the filesystem, and the evidence describing it has not been written yet. A
// restart must decide what happened using only the prepared intent and the current
// state of the world.
//
// THE CONTRACT — two outcomes, and the refusal is the safety-critical one:
//
//   APPLIED    the world matches what the intent predicted. Recovery RECONCILES:
//              exactly one receipt, marked as recovery, retaining the stable operation
//              key, with one completion event and replay linkage. The effect is not
//              re-applied and no second receipt appears.
//
//   UNCERTAIN  a third party changed the target between the effect and the restart.
//              Recovery must REFUSE: manufacture no receipt, leave the divergent state
//              alone rather than "repairing" it, and emit
//              `workspace.operation_reconciliation_required` so a human decides.
//
// Reconciling under divergence would fabricate evidence for an effect nobody can prove
// this run produced, which is why the uncertain half is not optional.
//
// Repaired, not rewritten: both scenarios and their assertions are the original ones.
// Seeding and observation move to the store; the JSON-era `DATA_DIR` seeding,
// `operation-history.json` reads and `events.jsonl` string matching are not ported.
//
// Requires TEST_DATABASE_URL (or DATABASE_URL).

const fs = require('fs');
const os = require('os');
const path = require('path');
const { withHarness, createAsserter, sleep } = require('./postgres-test-harness');
const { settleChild, assertScenariosExecuted } = require('./child-process-settlement');

const STAMP = Date.now();
const assert = createAsserter();
let scenariosRun = 0;

const INTENDED = 'intended-reconciliation-content';
const THIRD_PARTY = 'unexpected-third-party-content';

function encodeActions(plan) {
  return Buffer.from(JSON.stringify(plan), 'utf8').toString('base64url');
}

function createFetchStub() {
  const preloadPath = path.join(os.tmpdir(), `reconciliation-stub-${process.pid}-${STAMP}.js`);
  fs.writeFileSync(preloadPath, `
function okResponse(plan) {
  return { ok: true, status: 200, headers: new Map([['x-request-id', 'fake-reconciliation']]),
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
    await withHarness('target operation reconciliation', async ({ store, workspaceRoot, startServer }) => {
      const agent = (await store.createConfiguredAgent({
        value: { name: `Reconciliation-${STAMP}`, provider: 'openai', model: 'gpt-4.1-mini', apiKey: 'test-key-reconcile' },
        groupIds: [], changedBy: 'target-operation-reconciliation-test'
      })).agent;

      const baseEnv = {
        NODE_OPTIONS: `--require ${preloadPath}`,
        RUNTIME_SCHEDULER_INTERVAL_MS: '200',
        // The killed process keeps its lease until it expires; recovery cannot claim
        // the run before then. Test-environment knob only.
        RUN_LEASE_DURATION_MS: '4000'
      };

      // Only one server may own the schema at a time: a leftover clean server would
      // claim the next scenario's run and finish it without ever reaching the seam.
      let liveServer = null;
      async function retireLiveServer() {
        if (!liveServer) return;
        const previous = liveServer;
        liveServer = null;
        await previous.stop();
        await settleChild(previous.child, { timeoutMs: 30000 });
      }

      async function crashAtTargetEffect(label, fileName) {
        scenariosRun += 1;
        await retireLiveServer();

        const crashing = await startServer({ env: {
          ...baseEnv, TEST_INTERRUPTION_POINT: 'after_first_workspace_target_effect'
        } });
        const cookie = await crashing.login();

        const objective = `reconciliation ${label} ${STAMP} #ACTIONS=${encodeActions({
          actions: [{ operation: 'writeFile', args: { path: fileName, content: INTENDED } }], complete: true
        })}`;
        await crashing.request('POST', '/tickets', {
          cookie,
          form: { objective, assignmentTargetType: 'agent', assignmentTargetId: String(agent.id), assignmentMode: 'individual' }
        }).catch(error => {
          if (/ECONNRESET|socket hang up/i.test(String(error && error.message))) return null;
          throw error;
        });

        const ticket = await waitFor(async () => {
          const { tickets } = await store.listTickets({ limit: 300 });
          return tickets.find(t => t.objective === objective) || null;
        }, 30000, `${label} ticket`);
        const run = await waitFor(async () => {
          const { runs } = await store.listRunsForTicket({ ticketId: ticket.id, limit: 10 });
          return runs[0] || null;
        }, 30000, `${label} run dispatch`);

        // The seam must fire and the process must die, or the "recovery" below would be
        // an ordinary run and would prove nothing.
        await waitFor(async () => {
          const events = await store.listRunEvents(run.id, { afterSeq: -1, limit: 500 });
          return (events || []).find(e => e.type === 'interruption.test_hook'
            && (e.payload || e).point === 'after_first_workspace_target_effect') || null;
        }, 30000, `${label} interruption hook`);
        const death = await settleChild(crashing.child, { timeoutMs: 30000 });
        assert(death.code !== 0 || death.signal !== null,
          `${label}: the process died at the target-effect seam`);

        // The defining property of this window: the effect landed, the receipt did not.
        assert(fs.readFileSync(path.join(workspaceRoot, fileName), 'utf8') === INTENDED,
          `${label}: the external effect landed before the crash`);
        const beforeOps = await store.listRunOperations(run.id, { limit: 50 });
        assert((beforeOps.operations || beforeOps).length === 0,
          `${label}: no receipt existed before the crash boundary`);
        const events = await store.listRunEvents(run.id, { afterSeq: -1, limit: 500 });
        assert((events || []).some(e => e.type === 'workspace.operation_prepared'),
          `${label}: the prepared intent survived the crash`);

        return { ticket, run, fileName };
      }

      async function resumeAndSettle(label, runId) {
        const resumed = await startServer({ env: baseEnv });
        liveServer = resumed;
        await resumed.login();
        return waitFor(async () => {
          const current = await store.getRun(runId);
          return current && ['completed', 'failed', 'interrupted'].includes(current.status) ? current : null;
        }, 120000, `${label} run to terminalize after resume`);
      }

      // ── 1. APPLIED — the world matches the intent, so reconcile ─────────────
      {
        const fileName = `reconcile-applied-${STAMP}.txt`;
        const crashed = await crashAtTargetEffect('applied', fileName);
        const terminal = await resumeAndSettle('applied', crashed.run.id);

        assert(terminal.status === 'completed',
          `1: the reconciled run completed (${terminal.status}: ${terminal.error || ''})`);
        const ops = await store.listRunOperations(crashed.run.id, { limit: 100 });
        const receipts = ops.operations || ops;
        assert(receipts.length === 1,
          `1: reconciliation produced exactly one receipt (found ${receipts.length})`);
        assert(receipts[0].isRecovery === true,
          '1: the receipt identifies itself as reconciliation rather than fresh work');
        assert(Boolean(receipts[0].operationKey),
          '1: the receipt retains its stable operation key');
        assert(fs.readFileSync(path.join(workspaceRoot, fileName), 'utf8') === INTENDED,
          '1: the effect was not re-applied — the file is unchanged');

        const events = await store.listRunEvents(crashed.run.id, { afterSeq: -1, limit: 500 });
        const completions = (events || []).filter(e => e.type === 'workspace.operation');
        assert(completions.length === 1,
          `1: exactly one completion event was emitted (found ${completions.length})`);
        assert((completions[0].payload || {}).isRecovery === true,
          '1: the completion event exposes that it was reconciled');

        const replay = (await store.readRunReplay(crashed.run.id)).snapshot;
        assert((replay.workspaceOperations || []).length === 1,
          '1: replay links exactly one reconciled workspace operation');
      }

      // ── 2. UNCERTAIN — a third party diverged the target, so REFUSE ─────────
      {
        const fileName = `reconcile-uncertain-${STAMP}.txt`;
        const crashed = await crashAtTargetEffect('uncertain', fileName);

        // Diverge the target while the runtime is down.
        fs.writeFileSync(path.join(workspaceRoot, fileName), THIRD_PARTY);

        const terminal = await resumeAndSettle('uncertain', crashed.run.id);
        assert(['failed', 'interrupted'].includes(terminal.status),
          `2: the run did not complete over divergent state (${terminal.status})`);

        const ops = await store.listRunOperations(crashed.run.id, { limit: 100 });
        const receipts = ops.operations || ops;
        const succeeded = receipts.filter(op => !op.error && op.outcome !== 'failed' && op.outcome !== 'refused');
        assert(succeeded.length === 0,
          `2: an uncertain effect manufactures no successful receipt (found ${succeeded.length})`);
        assert(fs.readFileSync(path.join(workspaceRoot, fileName), 'utf8') === THIRD_PARTY,
          '2: the divergent state was left alone — not retried, not overwritten');

        const events = await store.listRunEvents(crashed.run.id, { afterSeq: -1, limit: 500 });
        assert((events || []).some(e => e.type === 'workspace.operation_reconciliation_required'),
          '2: the runtime emitted reconciliation-required evidence for a human to decide');
      }

      await retireLiveServer();
      assertScenariosExecuted({
        label: 'target operation reconciliation',
        assertions: assert.count(),
        scenarios: scenariosRun,
        minAssertions: 16,
        minScenarios: 2
      });
      console.log(`\nPASS: prepared target-effect reconciliation — ${scenariosRun} scenarios, ${assert.count()} assertions (PostgreSQL-native)`);
    }, { schemaSlug: 'target_reconciliation' });
  } finally {
    try { fs.unlinkSync(preloadPath); } catch (_) { /* best effort */ }
  }
}

main().catch(error => {
  console.error(`\nFAIL: prepared target-effect reconciliation — ${error && error.stack ? error.stack : error}`);
  process.exit(1);
});

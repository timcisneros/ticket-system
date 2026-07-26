#!/usr/bin/env node
'use strict';
// Resumable execution across process death — PostgreSQL-native
// (docs/ARCHITECTURAL_DECISIONS_PENDING.md, A20).
//
// Contract under test, preserved from the JSON-era original: when the runtime dies
// mid-run, a restart resumes that run and finishes it EXACTLY ONCE. No mutation is
// repeated, no mutation is lost, and the run reaches a truthful terminal state with
// its evidence finalized.
//
// WHY THIS SUITE IS NOT REDUNDANT. A20 tested and rejected the hypothesis that it
// duplicated existing coverage. The runtime exposes nine deterministic crash seams;
// the entire registered checkpoint drives two. This suite drives four, and three of
// them — `after_first_authority.allowed`, `after_run.started` and
// `before_run.snapshot_finalized` — had no live crash-recovery coverage anywhere.
// `recovery-state-reconstruction-test.js` does not close that: it is a pure classifier
// over synthetic snapshots and never kills a real server, so it cannot show the
// RUNTIME reaches the conclusion the classifier does.
//
// Scope note: the original's corrupt-chain and missing-authority scenarios assert the
// reconstruction classifier's refusal to resume unsafe evidence, which
// `recovery-state-reconstruction-test.js` covers directly and exhaustively over
// synthetic inputs. They are not re-driven here; what this suite uniquely owns is that
// a REAL process death at each seam resumes correctly.
//
// THIS SUITE PREVIOUSLY EXITED 0 WHILE ASSERTING NOTHING. Its runner ended with
// `process.exit(failed > 0 ? 1 : 0)`, so zero executed scenarios exited zero, and its
// cleanup awaited `child.once('exit')` on an already-dead child. Both are gone: crash
// scenarios now use scripts/child-process-settlement.js, and a scenario that cannot
// reach its own preconditions is a HARD FAILURE, never skipped or not-proven.
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

function encodeActions(plan) {
  return Buffer.from(JSON.stringify(plan), 'utf8').toString('base64url');
}

// Deterministic model-free provider, so each crash seam is reached reliably rather
// than depending on what a real model happens to propose.
function createFetchStub() {
  const preloadPath = path.join(os.tmpdir(), `resumable-stub-${process.pid}-${STAMP}.js`);
  fs.writeFileSync(preloadPath, `
function okResponse(plan) {
  return { ok: true, status: 200, headers: new Map([['x-request-id', 'fake-resumable']]),
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
  // Deliberately a throw, not a null return. A crash scenario whose precondition is
  // never reached has not been observed, and must not be reported as anything else.
  throw new Error(`timed out waiting for ${label}`);
}

async function main() {
  const preloadPath = createFetchStub();
  try {
    await withHarness('resumable execution', async ({ store, workspaceRoot, startServer }) => {
      const agent = (await store.createConfiguredAgent({
        value: { name: `Resumable-${STAMP}`, provider: 'openai', model: 'gpt-4.1-mini', apiKey: 'test-key-resumable' },
        groupIds: [], changedBy: 'resumable-execution-test'
      })).agent;

      // The crashed process keeps its lease until it expires; recovery cannot claim
      // the run before then. Short lease so a resume takes seconds, not the default
      // three minutes. Test-environment knob only.
      const baseEnv = {
        NODE_OPTIONS: `--require ${preloadPath}`,
        RUNTIME_SCHEDULER_INTERVAL_MS: '200',
        RUN_LEASE_DURATION_MS: '4000'
      };

      const opsFor = async runId => {
        const page = await store.listRunOperations(runId, { limit: 200 });
        return page.operations || page;
      };

      // One crash scenario: run until the seam kills the process, restart clean, and
      // require the run to finish exactly once.
      // Only ONE server may be live at a time. A leftover clean server from a previous
      // scenario would claim the next scenario's run and complete it without ever
      // reaching the seam — the scenario would look fine and prove nothing.
      let liveServer = null;
      async function retireLiveServer() {
        if (!liveServer) return;
        const previous = liveServer;
        liveServer = null;
        await previous.stop();
        await settleChild(previous.child, { timeoutMs: 30000 });
      }

      async function crashAndResume({ label, point, target, content }) {
        scenariosRun += 1;
        console.log(`\n--- ${label} (${point}) ---`);
        await retireLiveServer();

        const crashing = await startServer({ ...baseEnv, TEST_INTERRUPTION_POINT: point });
        const cookie = await crashing.login();

        const objective = `resumable ${label} ${STAMP} #ACTIONS=${encodeActions({
          actions: [{ operation: 'writeFile', args: { path: target, content } }], complete: true
        })}`;
        const created = await crashing.request('POST', '/tickets', {
          cookie,
          form: { objective, assignmentTargetType: 'agent', assignmentTargetId: String(agent.id), assignmentMode: 'individual' }
        }).catch(error => {
          // The socket can hang up when the seam kills the process mid-request; the
          // ticket is still created, so this is not a failure.
          if (/ECONNRESET|socket hang up/i.test(String(error && error.message))) return { statusCode: 0 };
          throw error;
        });
        assert(created.statusCode === 302 || created.statusCode === 0,
          `${label}: ticket create was accepted or the seam cut the socket (HTTP ${created.statusCode})`);

        const ticket = await waitFor(async () => {
          const { tickets } = await store.listTickets({ limit: 300 });
          return tickets.find(t => t.objective === objective) || null;
        }, 30000, `${label} ticket`);
        const run = await waitFor(async () => {
          const { runs } = await store.listRunsForTicket({ ticketId: ticket.id, limit: 10 });
          return runs[0] || null;
        }, 30000, `${label} run dispatch`);

        // The seam must actually fire, and the process must actually die. Without
        // both, the "resume" below would be an ordinary run and prove nothing.
        const hook = await waitFor(async () => {
          const events = await store.listRunEvents(run.id, { afterSeq: -1, limit: 500 });
          return (events || []).find(e => e.type === 'interruption.test_hook'
            && (e.payload || e).point === point) || null;
        }, 30000, `${label} interruption hook at ${point}`);
        assert(Boolean(hook), `${label}: the runtime recorded reaching ${point}`);

        const death = await settleChild(crashing.child, { timeoutMs: 30000 });
        assert(death.code !== 0 || death.signal !== null,
          `${label}: the process died at the seam rather than exiting cleanly`);

        const midRun = await store.getRun(run.id);
        assert(!['completed', 'failed'].includes(midRun.status),
          `${label}: the run was still unfinished when the process died (was ${midRun.status})`);

        // ── Restart clean and let recovery finish the run ────────────────────
        const resumed = await startServer(baseEnv);
        liveServer = resumed;
        await resumed.login();

        const terminal = await waitFor(async () => {
          const current = await store.getRun(run.id);
          return current && ['completed', 'failed', 'interrupted'].includes(current.status) ? current : null;
        }, 120000, `${label} run to terminalize after resume`);

        return { ticket, run: terminal, target, content };
      }

      // ── 1. Crash after authority, before the operation ──────────────────────
      // The dangerous shape: authority was granted and durably recorded, but the
      // mutation had not run. Resume must perform it — once.
      {
        const target = `resume-authority-${STAMP}.txt`;
        const outcome = await crashAndResume({
          label: 'authority-before-op', point: 'after_first_authority.allowed', target, content: 'hello'
        });
        assert(outcome.run.status === 'completed',
          `1: the resumed run completed (${outcome.run.status}: ${outcome.run.error})`);
        assert(fs.existsSync(path.join(workspaceRoot, target))
          && fs.readFileSync(path.join(workspaceRoot, target), 'utf8') === 'hello',
          '1: the mutation that had not run before the crash was performed on resume');
        const writes = (await opsFor(outcome.run.id)).filter(op => op.operation === 'writeFile' && !op.error);
        assert(writes.length === 1,
          `1: the mutation was committed exactly once (got ${writes.length} receipts)`);
      }

      // ── 2. Crash after the workspace operation ──────────────────────────────
      // The mirror-image danger: the mutation already landed. Resume must NOT repeat it.
      {
        const target = `resume-afterop-${STAMP}.txt`;
        const outcome = await crashAndResume({
          label: 'after-workspace-op', point: 'after_first_workspace.operation', target, content: 'world'
        });
        assert(outcome.run.status === 'completed',
          `2: the resumed run completed (${outcome.run.status}: ${outcome.run.error})`);
        assert(fs.readFileSync(path.join(workspaceRoot, target), 'utf8') === 'world',
          '2: the already-committed mutation survived the crash intact');
        const writes = (await opsFor(outcome.run.id)).filter(op => op.operation === 'writeFile' && !op.error);
        assert(writes.length === 1,
          `2: resume did not duplicate the committed mutation (got ${writes.length} receipts)`);
      }

      // ── 3. Crash before the replay snapshot is finalized ────────────────────
      // Work is done; the evidence is not yet sealed. Resume must finalize it rather
      // than leave a run whose record is permanently incomplete.
      {
        const target = `resume-snapshot-${STAMP}.txt`;
        const outcome = await crashAndResume({
          label: 'before-replay-finalized', point: 'before_run.snapshot_finalized', target, content: 'sealed'
        });
        assert(['completed', 'failed'].includes(outcome.run.status),
          `3: the run reached a terminal state after resume (${outcome.run.status})`);
        const record = await store.readRunReplay(outcome.run.id);
        assert(Boolean(record && record.snapshot), '3: a replay snapshot exists after resume');
        assert(Boolean(record.snapshot.finalizedAt),
          '3: the replay snapshot was finalized rather than left open');
        assert(record.snapshot.terminalStatus === outcome.run.status,
          `3: the finalized snapshot agrees with the run's terminal status`);
        const leaseCleared = (await store.getRun(outcome.run.id)).leaseOwner;
        assert(!leaseCleared, '3: the terminal run holds no lease');
      }

      // ── 4. Crash immediately after the run starts ───────────────────────────
      // The earliest seam: almost nothing is durable yet. Resume must still converge
      // on a truthful terminal state rather than stranding the run.
      {
        const target = `resume-started-${STAMP}.txt`;
        const outcome = await crashAndResume({
          label: 'after-run-started', point: 'after_run.started', target, content: 'early'
        });
        assert(['completed', 'failed', 'interrupted'].includes(outcome.run.status),
          `4: the run reached a terminal state after resume (${outcome.run.status})`);
        assert(!(await store.getRun(outcome.run.id)).leaseOwner,
          '4: the terminal run holds no lease');
        const writes = (await opsFor(outcome.run.id)).filter(op => op.operation === 'writeFile' && !op.error);
        assert(writes.length <= 1,
          `4: the mutation was never committed more than once (got ${writes.length} receipts)`);
      }

      await retireLiveServer();

      assertScenariosExecuted({
        label: 'resumable execution',
        assertions: assert.count(),
        scenarios: scenariosRun,
        minAssertions: 24,
        minScenarios: 4
      });
      console.log(`\nPASS: resumable execution — ${scenariosRun} crash seams, ${assert.count()} assertions (PostgreSQL-native)`);
    }, { schemaSlug: 'resumable_execution' });
  } finally {
    try { fs.unlinkSync(preloadPath); } catch (_) { /* best effort */ }
  }
}

main().catch(error => {
  console.error(`\nFAIL: resumable execution — ${error && error.stack ? error.stack : error}`);
  process.exit(1);
});

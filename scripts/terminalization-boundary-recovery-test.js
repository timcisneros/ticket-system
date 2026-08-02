#!/usr/bin/env node
'use strict';
// Terminalization-boundary crash recovery — PostgreSQL-native
// (docs/ARCHITECTURAL_DECISIONS_PENDING.md, A23).
//
// The deterministic crash seams at the terminal boundary, including the
// Tranche 6 completion-decision projection:
//
//   after_run.created                — the run row exists and nothing else has happened
//   before_run.consequence_recorded  — death immediately before the atomic
//                                      terminalization bundle
//   after_run.snapshot_finalized     — death immediately after that bundle committed
//   after_run.completion_decided      — death after the immutable completion
//                                      decision/evidence commit and before ticket projection
//
// WHAT THE SEAM NAMES NO LONGER IMPLY. `before_run.snapshot_finalized` and
// `before_run.consequence_recorded` fire back to back at the same point, and
// `server.js` records why: "The old interruption points now sit before the repository
// boundary. They can abort before the bundle, but cannot create a partially committed
// PostgreSQL terminal state between its constituent records." Terminalization is one
// transaction, so a crash there leaves the run NON-TERMINAL — not terminal-with-missing-
// consequence, which is the state the seam names were coined for and which the current
// runtime cannot produce. This suite asserts what is reachable and proves the
// unreachable state stays unreachable, rather than encoding a shape that no longer
// exists.
//
// Every scenario proves the hook fired, the process died, the run was in the expected
// incomplete durable state at death, and recovery converged exactly once. A scenario
// that cannot reach its own precondition fails hard: no skips, no NOT_PROVEN.
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

function createFetchStub() {
  const preloadPath = path.join(os.tmpdir(), `terminalization-stub-${process.pid}-${STAMP}.js`);
  fs.writeFileSync(preloadPath, `
function okResponse(plan) {
  return { ok: true, status: 200, headers: new Map([['x-request-id', 'fake-terminalization']]),
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
    await withHarness('terminalization boundary recovery', async ({ store, workspaceRoot, startServer }) => {
      const agent = (await store.createConfiguredAgent({
        value: { name: `TerminalBoundary-${STAMP}`, provider: 'openai', model: 'gpt-4.1-mini', apiKey: 'test-key-terminal' },
        groupIds: [], changedBy: 'terminalization-boundary-recovery-test'
      })).agent;

      const baseEnv = {
        NODE_OPTIONS: `--require ${preloadPath}`,
        RUNTIME_SCHEDULER_INTERVAL_MS: '200',
        RUN_LEASE_DURATION_MS: '4000'
      };

      let liveServer = null;
      async function retireLiveServer() {
        if (!liveServer) return;
        const previous = liveServer;
        liveServer = null;
        await previous.stop();
        await settleChild(previous.child, { timeoutMs: 30000 });
      }

      const opsFor = async runId => {
        const page = await store.listRunOperations(runId, { limit: 200 });
        return page.operations || page;
      };

      // Crash at `seam`, then restart clean and let startup recovery converge.
      async function crashAt(label, seam, fileName) {
        scenariosRun += 1;
        console.log(`\n--- ${label} (${seam}) ---`);
        await retireLiveServer();

        const crashing = await startServer({ env: { ...baseEnv, TEST_INTERRUPTION_POINT: seam } });
        const cookie = await crashing.login();
        const objective = `terminal-boundary ${label} ${STAMP} #ACTIONS=${encodeActions({
          actions: [{ operation: 'writeFile', args: { path: fileName, content: 'boundary' } }], complete: true
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
        }, 30000, `${label} run row`);

        const hook = await waitFor(async () => {
          const events = await store.listRunEvents(run.id, { afterSeq: -1, limit: 500 });
          return (events || []).find(e => e.type === 'interruption.test_hook'
            && (e.payload || e).point === seam) || null;
        }, 40000, `${label} interruption hook at ${seam}`);
        assert(Boolean(hook), `${label}: the runtime recorded reaching ${seam}`);

        const death = await settleChild(crashing.child, { timeoutMs: 30000 });
        assert(death.code !== 0 || death.signal !== null,
          `${label}: the process died at the seam rather than exiting cleanly`);

        const atDeath = await store.getRun(run.id);
        const replayAtDeath = await store.readRunReplay(run.id);
        return { ticket, run, atDeath, replayAtDeath };
      }

      async function recover(label, runId) {
        const resumed = await startServer({ env: baseEnv });
        liveServer = resumed;
        await resumed.login();
        return waitFor(async () => {
          const current = await store.getRun(runId);
          return current && ['completed', 'failed', 'interrupted'].includes(current.status) ? current : null;
        }, 120000, `${label} run to reach a terminal state`);
      }

      // Shared convergence proof: whatever the seam, the recovered run must be
      // internally consistent and singular.
      async function assertConverged(label, ticketId, runId, terminal) {
        const { runs } = await store.listRunsForTicket({ ticketId, limit: 20 });
        assert(runs.length === 1,
          `${label}: recovery created no duplicate run (found ${runs.length})`);
        assert(runs[0].id === runId, `${label}: the original run is the one that recovered`);
        assert(runs[0].agentId === agent.id, `${label}: ownership and assignment survived recovery`);
        assert(!terminal.leaseOwner, `${label}: the terminal run holds no stale lease`);

        const replay = await store.readRunReplay(runId);
        assert(Boolean(replay && replay.snapshot), `${label}: a replay snapshot exists`);
        assert(Boolean(replay.snapshot.finalizedAt),
          `${label}: exactly one authoritative finalized snapshot`);
        assert(replay.snapshot.terminalStatus === terminal.status,
          `${label}: the finalized snapshot agrees with the run's terminal status (${replay.snapshot.terminalStatus} vs ${terminal.status})`);

        const consequence = await store.getRunConsequence(runId);
        assert(Boolean(consequence), `${label}: a consequence was recorded`);
        assert(Boolean(consequence && consequence.consequence &&
          consequence.consequence.completionDecision),
        `${label}: one canonical completion decision was recorded`);

        const events = await store.listRunEvents(runId, { afterSeq: -1, limit: 500 });
        const terminalized = (events || []).filter(e => e.type === 'run.terminalized');
        assert(terminalized.length <= 1,
          `${label}: terminalization evidence was not duplicated (found ${terminalized.length})`);
        const consequenceEvents = (events || []).filter(e => e.type === 'run.consequence_recorded');
        assert(consequenceEvents.length <= 1,
          `${label}: consequence evidence was not duplicated (found ${consequenceEvents.length})`);
        const completionEvents = (events || []).filter(e => e.type === 'run.completion_decided');
        assert(completionEvents.length === 1,
          `${label}: completion-decision evidence was recorded exactly once (found ${completionEvents.length})`);
        assert(completionEvents[0].payload.decisionHash ===
          consequence.consequence.completionDecision.decisionHash,
        `${label}: completion evidence binds the persisted decision hash`);

        const receipts = (await opsFor(runId))
          .filter(op => !op.error && op.outcome !== 'failed' && op.outcome !== 'refused');
        assert(receipts.length <= 1,
          `${label}: the mutation was never committed twice (found ${receipts.length})`);
        return { receipts, consequence };
      }

      // ── 1. after_run.created — nothing but the run row exists ───────────────
      {
        const label = 'after-run-created';
        const fileName = `boundary-created-${STAMP}.txt`;
        const crashed = await crashAt(label, 'after_run.created', fileName);
        assert(!['completed', 'failed'].includes(crashed.atDeath.status),
          `1: the run was still incomplete at death (was ${crashed.atDeath.status})`);
        assert(!crashed.replayAtDeath || !crashed.replayAtDeath.snapshot
          || !crashed.replayAtDeath.snapshot.finalizedAt,
          '1: no finalized snapshot existed at death');

        const terminal = await recover(label, crashed.run.id);
        assert(terminal.status === 'completed',
          `1: the recovered run reached a truthful terminal state (${terminal.status}: ${terminal.error || ''})`);
        const { receipts } = await assertConverged('1', crashed.ticket.id, crashed.run.id, terminal);
        assert(receipts.length === 1, '1: the planned mutation ran exactly once after recovery');
        assert(fs.readFileSync(path.join(workspaceRoot, fileName), 'utf8') === 'boundary',
          '1: the mutation actually reached the workspace');
      }

      // ── 2. before_run.consequence_recorded — death before the bundle ────────
      {
        const label = 'before-consequence';
        const fileName = `boundary-consequence-${STAMP}.txt`;
        const crashed = await crashAt(label, 'before_run.consequence_recorded', fileName);

        // The state this seam was named for — terminal run, missing consequence —
        // is unreachable: terminalization is one transaction. Asserting that keeps
        // the suite honest about what it is actually proving.
        assert(!['completed', 'failed'].includes(crashed.atDeath.status),
          `2: the run was NOT terminal at death — the bundle is atomic (was ${crashed.atDeath.status})`);
        const consequenceAtDeath = await store.getRunConsequence(crashed.run.id);
        assert(!consequenceAtDeath,
          '2: no consequence was committed at death, consistent with an aborted bundle');

        const terminal = await recover(label, crashed.run.id);
        const { consequence } = await assertConverged('2', crashed.ticket.id, crashed.run.id, terminal);
        assert(Boolean(consequence),
          '2: recovery recorded the consequence exactly once on restart');
        // The consequence document is nested under `.consequence`. Cross-checked
        // against the receipts rather than merely asserted present: A16 exists because
        // a consequence that records no mutations while receipts say otherwise is the
        // failure that matters.
        const doc = consequence.consequence || {};
        const committed = (await opsFor(crashed.run.id))
          .filter(op => !op.error && op.outcome !== 'failed' && op.outcome !== 'refused');
        assert(Array.isArray(doc.mutations),
          `2: the consequence records a mutations array (got ${typeof doc.mutations})`);
        assert(doc.mutations.length === committed.length,
          `2: the consequence's mutations match the authoritative receipts (${doc.mutations.length} vs ${committed.length}) — the A16 property`);
        assert(doc.verification && typeof doc.verification.postconditionsStatus === 'string',
          '2: the consequence carries its verification status');
        const finalTicket = await store.getTicket(crashed.ticket.id);
        assert(['completed', 'failed', 'closed', 'in_progress'].includes(finalTicket.status),
          `2: ticket finalization stayed consistent with the run (${finalTicket.status})`);
      }

      // ── 3. after_run.snapshot_finalized — the bundle already committed ──────
      {
        const label = 'after-snapshot-finalized';
        const fileName = `boundary-finalized-${STAMP}.txt`;
        const crashed = await crashAt(label, 'after_run.snapshot_finalized', fileName);

        // Here the durable terminal state DOES exist at death; the crash lands in
        // post-terminal bookkeeping. Recovery must add nothing and contradict nothing.
        assert(['completed', 'failed'].includes(crashed.atDeath.status),
          `3: the run was already terminal at death (was ${crashed.atDeath.status})`);
        assert(Boolean(crashed.replayAtDeath && crashed.replayAtDeath.snapshot
          && crashed.replayAtDeath.snapshot.finalizedAt),
          '3: the replay snapshot was already finalized at death');
        const statusAtDeath = crashed.atDeath.status;
        const finalizedAtDeath = crashed.replayAtDeath.snapshot.finalizedAt;

        const terminal = await recover(label, crashed.run.id);
        assert(terminal.status === statusAtDeath,
          `3: recovery did not contradict the committed terminal status (${statusAtDeath} → ${terminal.status})`);
        const after = await assertConverged('3', crashed.ticket.id, crashed.run.id, terminal);
        const replayAfter = await store.readRunReplay(crashed.run.id);
        assert(replayAfter.snapshot.finalizedAt === finalizedAtDeath,
          '3: the snapshot was not finalized a second time');
        assert(after.receipts.length <= 1,
          '3: no duplicate mutation receipt appeared after restart');
      }

      // ── 4. after_run.completion_decided — decision committed, ticket pending ─
      {
        const label = 'after-completion-decided';
        const fileName = `boundary-decision-${STAMP}.txt`;
        const crashed = await crashAt(label, 'after_run.completion_decided', fileName);
        assert(['completed', 'failed'].includes(crashed.atDeath.status),
          `4: the run and completion decision were terminal at death (was ${crashed.atDeath.status})`);
        const atDeathConsequence = await store.getRunConsequence(crashed.run.id);
        assert(Boolean(atDeathConsequence && atDeathConsequence.consequence &&
          atDeathConsequence.consequence.completionDecision),
        '4: the immutable completion decision existed before ticket projection');
        const decisionHashAtDeath =
          atDeathConsequence.consequence.completionDecision.decisionHash;

        const terminal = await recover(label, crashed.run.id);
        const after = await assertConverged('4', crashed.ticket.id, crashed.run.id, terminal);
        assert(after.consequence.consequence.completionDecision.decisionHash === decisionHashAtDeath,
          '4: recovery preserved the exact completion decision hash');
        const projectedTicket = await waitFor(async () => {
          const current = await store.getTicket(crashed.ticket.id);
          return current && current.status !== 'in_progress' ? current : null;
        }, 30000, '4 ticket completion projection');
        assert(projectedTicket.status !== 'completed',
          '4: the unrecognized objective remains incomplete after recovery rather than following model prose');
      }

      await retireLiveServer();
      assertScenariosExecuted({
        label: 'terminalization boundary recovery',
        assertions: assert.count(),
        scenarios: scenariosRun,
        minAssertions: 40,
        minScenarios: 4
      });
      console.log(`\nPASS: terminalization boundary recovery — ${scenariosRun} seams, ${assert.count()} assertions (PostgreSQL-native)`);
    }, { schemaSlug: 'terminal_boundary' });
  } finally {
    try { fs.unlinkSync(preloadPath); } catch (_) { /* best effort */ }
  }
}

main().catch(error => {
  console.error(`\nFAIL: terminalization boundary recovery — ${error && error.stack ? error.stack : error}`);
  process.exit(1);
});

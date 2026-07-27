#!/usr/bin/env node
'use strict';
// Integration test for bounded repeated model-response contract-violation
// termination (server.js action-count gates + runtime/action-contract-streak.js).
//
// Real server + real store (isolated schema) + mock ollama that scripts
// responses per scenario. Proves:
//   1. Two consecutive oversized-TOTAL-action responses terminate after exactly
//      two provider responses with the structured model-contract failure — no
//      timeout, zero operations executed.
//   2. Two consecutive excessive-MUTATING-action responses do the same.
//   3. One violation followed by a response that passes both gates resets the
//      streak (even when its operations resolve as valid no-ops) — the run does
//      NOT fail as a contract violation.
//   5. The corrective feedback names both effective configured limits.
// Plus: the terminated snapshot reconstructs to the threshold (durable evidence,
// the mechanism a recovered run re-seeds from — scenario 4), and the failure is
// classified distinctly from provider/timeout (scenario 6).
//
// Requires TEST_DATABASE_URL (or DATABASE_URL).

const crypto = require('crypto');
const http = require('http');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const { PostgresRuntimeStore } = require('../persistence/postgres/store');
const { currentRuntimeLimitsSnapshot } = require('./current-run-fixture');
const { reconstructActionContractViolationStreak } = require('../runtime/action-contract-streak');
const { allocateTestPort } = require('./test-port');

const DATABASE_URL = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('TEST_DATABASE_URL (or DATABASE_URL) is required for the model-contract-violation test');
  process.exit(1);
}

const SCHEMA = `model_contract_${process.pid}_${crypto.randomBytes(4).toString('hex')}`;
let PORT = null;
const WORKSPACE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'model-contract-ws-'));

const OVERSIZED = 'MCV_OVERSIZED';
const MUTATING = 'MCV_MUTATING';
const RESET = 'MCV_RESET';

function assert(c, m) { if (!c) throw new Error(m); }
const sleep = ms => new Promise(r => setTimeout(r, ms));
let serverEnvMutatingCap = null;

// Read-only health probe used by the first-failure diagnostics below, so a latched or
// backpressured deployment is distinguishable from a genuine feedback change.
async function healthSnapshot() {
  try {
    const response = await fetch(`http://127.0.0.1:${PORT}/health`);
    return { status: response.status, body: (await response.text()).slice(0, 120) };
  } catch (error) {
    return { error: error && error.message };
  }
}

const folders = names => names.map(p => ({ operation: 'createFolder', args: { path: p } }));
const A_TO_Z = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');

// Mock ollama: branches on the scenario marker in the objective, tracks per-
// scenario call count, and records each request body so feedback can be asserted.
function startMockProvider() {
  const calls = { [OVERSIZED]: 0, [MUTATING]: 0, [RESET]: 0, other: 0 };
  const requestBodies = { [OVERSIZED]: [], [MUTATING]: [], [RESET]: [], other: [] };
  const server = http.createServer((req, res) => {
    if (req.method !== 'POST' || !req.url.startsWith('/api/chat')) { res.writeHead(404); res.end(); return; }
    let raw = '';
    req.on('data', c => { raw += c; });
    req.on('end', () => {
      const marker = raw.includes(OVERSIZED) ? OVERSIZED
        : raw.includes(MUTATING) ? MUTATING
        : raw.includes(RESET) ? RESET : 'other';
      requestBodies[marker].push(raw);
      const n = (calls[marker] += 1);
      let plan;
      if (marker === OVERSIZED) {
        plan = { message: 'creating A-Z', actions: folders(A_TO_Z), complete: false }; // 26 > 8 total
      } else if (marker === MUTATING) {
        plan = { message: 'creating four', actions: folders(['A', 'B', 'C', 'D']), complete: false }; // 4 ≤ 8 total, 4 > 2 mutating
      } else if (marker === RESET) {
        plan = n === 1
          ? { message: 'creating A-Z', actions: folders(A_TO_Z), complete: false } // violate once
          : { message: 'creating two (no-op)', actions: folders(['A', 'B']), complete: true }; // passes both gates
      } else {
        plan = { message: 'noop', actions: [], complete: true };
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        model: 'mock-model', created_at: new Date().toISOString(),
        message: { role: 'assistant', content: JSON.stringify(plan) },
        done: true, done_reason: 'stop', eval_count: 10, prompt_eval_count: 100, total_duration: 1e6
      }));
    });
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({
    server, url: `http://127.0.0.1:${server.address().port}`,
    callCount: m => calls[m], requestBodies: m => requestBodies[m]
  })));
}

async function allEvents(store, runId) {
  const events = [];
  let afterSeq = -1;
  while (true) {
    const page = await store.listRunEvents(runId, { afterSeq, limit: 100 });
    if (!Array.isArray(page) || page.length === 0) break;
    events.push(...page);
    afterSeq = page[page.length - 1].seq;
  }
  return events;
}

async function main() {
  // OS-allocated ephemeral port: see scripts/test-port.js. Fixed or pid-derived
  // ports collided across suites and surfaced as a misleading start failure.
  PORT = String(await allocateTestPort());
  const store = new PostgresRuntimeStore({ connectionString: DATABASE_URL, schema: SCHEMA });
  await store.migrate();
  const provider = await startMockProvider();
  // Pre-create A and B so the reset scenario's second response resolves as no-ops.
  fs.mkdirSync(path.join(WORKSPACE_ROOT, 'A'), { recursive: true });
  fs.mkdirSync(path.join(WORKSPACE_ROOT, 'B'), { recursive: true });

  const server = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      NODE_ENV: 'test', DATABASE_URL, POSTGRES_SCHEMA: SCHEMA,
      SESSION_SECRET: 'model-contract-session-secret-0123456789abcdef0123456789abcdef',
      ADMIN_BOOTSTRAP_PASSWORD: 'admin123', PORT, WORKSPACE_ROOT,
      OLLAMA_BASE_URL: provider.url,
      RUN_LEASE_DURATION_MS: '60000',
      TEST_SKIP_STARTUP_RUN_RECOVERY: 'true',
      RUNTIME_SCHEDULER_INTERVAL_MS: '200',
      PROCESS_TEMPLATE_SCHEDULER_INTERVAL_MS: '3600000'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  serverEnvMutatingCap = process.env.AGENT_MAX_MUTATING_ACTIONS_PER_RESPONSE;
  let out = '';
  server.stdout.on('data', c => { out += c; });
  server.stderr.on('data', c => { out += c; });

  try {
    let up = false;
    for (let i = 0; i < 80; i++) {
      if (server.exitCode !== null) throw new Error('server exited:\n' + out.slice(-3000));
      try { if ((await fetch(`http://127.0.0.1:${PORT}/login`)).status === 200) { up = true; break; } } catch (_) {}
      await sleep(400);
    }
    assert(up, 'server did not start:\n' + out.slice(-3000));

    const agent = (await store.createConfiguredAgent({
      value: { name: 'Model Contract Agent', provider: 'ollama', model: 'mock-model', apiKey: '' },
      groupIds: [], changedBy: 'model-contract-test'
    })).agent;

    const now = () => new Date().toISOString();
    async function makeRun(objective) {
      const ticket = (await store.createTicketWithEvent({
        ticket: {
          objective, acceptanceCriteria: null,
          assignmentTargetType: 'agent', assignmentTargetId: agent.id, assignmentMode: 'individual',
          ownedOutputPaths: null, targetRef: null, executionMode: 'agent',
          workflowId: null, workflowInput: null,
          capabilityType: 'directAction', capabilityId: 'agent-selected-actions', capabilityInput: null,
          executionPolicy: {
            mode: 'assisted', requireVerification: 'when_declared', autoRetry: false,
            maxAttempts: null, maxRuntimeMs: null, maxModelRequests: null, maxWorkspaceOperations: null,
            allowWorkspaceWrites: true, allowParallelRuns: false, allowChildTickets: false, workspaceScope: 'shared'
          },
          workTypeId: null, workTypeSnapshot: null, workContextId: null, workContextSnapshot: null,
          status: 'open', createdBy: 'admin', changedBy: 'admin', changedAt: now(), createdAt: now(), updatedAt: now()
        },
        eventPayload: { source: 'model-contract-test' }
      })).ticket;
      return store.createRun({
        ticketId: ticket.id, agentId: agent.id, agentName: agent.name,
        runtimeLimitsSnapshot: currentRuntimeLimitsSnapshot(),
        executionPolicySnapshot: { requireVerification: 'when_declared' }, status: 'pending'
      });
    }

    // Vague (model_driven) objectives so the deterministic feasibility/contract
    // path stays out of the way — this test targets the per-response gates only.
    const oversizedRun = await makeRun(`${OVERSIZED} please make many folders`);
    const mutatingRun = await makeRun(`${MUTATING} please make several folders`);
    const resetRun = await makeRun(`${RESET} please make a couple folders`);

    async function waitTerminal(runId) {
      for (let i = 0; i < 140; i++) {
        const r = await store.getRun(runId);
        if (r && ['completed', 'failed', 'interrupted'].includes(r.status)) return r;
        await sleep(400);
      }
      throw new Error(`run ${runId} did not terminate:\n` + out.slice(-2500));
    }

    // ── Scenario 1: two oversized-total responses → model-contract failure ──
    const oversized = await waitTerminal(oversizedRun.id);
    const oversizedSnap = (await store.getReplaySnapshot(oversizedRun.id)).snapshot;
    assert(oversized.status === 'failed', `oversized run must fail; got ${oversized.status}`);
    assert(oversizedSnap.failure && oversizedSnap.failure.code === 'MODEL_RESPONSE_CONTRACT_VIOLATION',
      `oversized failure code must be MODEL_RESPONSE_CONTRACT_VIOLATION; got ${JSON.stringify(oversizedSnap.failure)}`);
    assert(oversizedSnap.failure.kind === 'no_progress', `oversized failureKind must be no_progress; got ${oversizedSnap.failure.kind}`);
    assert(oversizedSnap.failure.kind !== 'timeout' && oversizedSnap.failure.code !== 'RUN_LIMIT_EXCEEDED', 'must NOT be a timeout / RUN_LIMIT_EXCEEDED');
    assert(oversized.triage && oversized.triage.reasonCode === 'model_contract_failed',
      `oversized triage reasonCode must be model_contract_failed; got ${oversized.triage && oversized.triage.reasonCode}`);
    assert(provider.callCount(OVERSIZED) === 2, `oversized must terminate after exactly 2 provider responses; got ${provider.callCount(OVERSIZED)}`);
    assert((oversizedSnap.workspaceOperations || []).length === 0, 'oversized must execute zero operations');
    assert((await store.listRunOperations(oversizedRun.id, { limit: 10 })).length === 0, 'oversized must have zero operation history');
    const oversizedViolations = (oversizedSnap.events || []).filter(e => e.type === 'model:action_limit');
    assert(oversizedViolations.length === 2 && oversizedViolations.every(e => e.violationType === 'total_action'),
      'oversized must record two total_action violation events');
    assert(reconstructActionContractViolationStreak(oversizedSnap) === 2,
      'durable snapshot must reconstruct the streak to the threshold (recovery-durability evidence)');

    // ── Scenario 5: corrective feedback names BOTH effective limits ──
    const oversizedBodies = provider.requestBodies(OVERSIZED);
    const secondOversizedRequest = oversizedBodies[1] || '';
    // FIRST-FAILURE CAPTURE. This assertion reads the SECOND provider request, and has
    // failed twice under checkpoint load while passing standalone. The summary line alone
    // cannot distinguish "the corrective feedback changed" from "the second request was
    // never captured", so record the actual inputs before failing. Diagnostics only: no
    // retry, no timeout change, no weakened condition. See A20.
    if (!/at most 8 total action/.test(secondOversizedRequest) ||
        !/at most 2 mutating action/.test(secondOversizedRequest)) {
      console.error('\n  ── corrective-feedback diagnostics ──');
      console.error(`  captured OVERSIZED requests: ${oversizedBodies.length}`);
      console.error(`  run status: ${oversized && oversized.status} error: ${oversized && oversized.error}`);
      console.error(`  violation events: ${oversizedViolations.length} streak: ${reconstructActionContractViolationStreak(oversizedSnap)}`);
      oversizedBodies.forEach((body, index) => {
        const text = String(body || '');
        const feedback = text.match(/at most[^"]{0,120}/g);
        console.error(`  [request ${index}] bytes=${text.length} feedbackMatches=${JSON.stringify(feedback)}`);
      });
      console.error(`  health: ${JSON.stringify(await healthSnapshot())}`);
      // BOUNDARY VALUES. The failure message renders the PROCESS CONSTANTS
      // (MAX_AGENT_ACTIONS_PER_RESPONSE / MAX_MUTATING_ACTIONS_PER_RESPONSE), so a wrong
      // number there means the constant itself was wrong in the server process — not a
      // snapshot, hydration or rendering fault. These three lines separate the four
      // candidate boundaries: the env this test process saw, the env it passed to the
      // server, and what the admitted run durably RECORDED.
      console.error(`  test-process env AGENT_MAX_MUTATING_ACTIONS_PER_RESPONSE=${JSON.stringify(process.env.AGENT_MAX_MUTATING_ACTIONS_PER_RESPONSE)}`);
      console.error(`  server env passed: ${JSON.stringify(serverEnvMutatingCap)}`);
      try {
        const snap = oversizedRun && oversizedRun.runtimeLimitsSnapshot;
        const semantics = snap && snap.semantics;
        console.error(`  recorded semantics: total=${semantics && semantics.maxActionsPerResponse} mutating=${semantics && semantics.maxMutatingActionsPerResponse}`);
      } catch (error) {
        console.error(`  recorded semantics unavailable: ${error && error.message}`);
      }
      console.error('  ── end diagnostics ──\n');
    }
    assert(/at most 8 total action/.test(secondOversizedRequest) && /at most 2 mutating action/.test(secondOversizedRequest),
      `corrective feedback must state both the total (8) and mutating (2) limits, single-sourced from the constants ` +
      `(captured ${oversizedBodies.length} request(s))`);

    // ── Scenario 2: two excessive-mutating responses → same bounded behavior ──
    const mutating = await waitTerminal(mutatingRun.id);
    const mutatingSnap = (await store.getReplaySnapshot(mutatingRun.id)).snapshot;
    assert(mutating.status === 'failed', `mutating run must fail; got ${mutating.status}`);
    assert(mutatingSnap.failure && mutatingSnap.failure.code === 'MODEL_RESPONSE_CONTRACT_VIOLATION',
      `mutating failure code must be MODEL_RESPONSE_CONTRACT_VIOLATION; got ${JSON.stringify(mutatingSnap.failure)}`);
    assert(mutating.triage && mutating.triage.reasonCode === 'model_contract_failed', 'mutating triage must be model_contract_failed');
    assert(provider.callCount(MUTATING) === 2, `mutating must terminate after exactly 2 provider responses; got ${provider.callCount(MUTATING)}`);
    assert((mutatingSnap.workspaceOperations || []).length === 0, 'mutating must execute zero operations');
    const mutatingViolations = (mutatingSnap.events || []).filter(e => e.type === 'model:mutating_action_limit');
    assert(mutatingViolations.length === 2 && mutatingViolations.every(e => e.violationType === 'mutating_action'),
      'mutating must record two mutating_action violation events');

    // ── Scenario 3: one violation then a passing (no-op) response resets ──
    const reset = await waitTerminal(resetRun.id);
    const resetSnap = (await store.getReplaySnapshot(resetRun.id)).snapshot;
    assert(reset.status === 'completed', `reset run must complete after the streak resets; got ${reset.status}: ${reset.error || ''}`);
    assert(!(reset.triage && reset.triage.reasonCode === 'model_contract_failed'), 'reset run must NOT be classified as a model-contract failure');
    assert(!resetSnap.failure, `reset run must have no failure; got ${JSON.stringify(resetSnap.failure)}`);
    assert(provider.callCount(RESET) === 2, `reset must take exactly 2 provider responses; got ${provider.callCount(RESET)}`);
    assert((resetSnap.events || []).filter(e => e.type === 'model:action_limit').length === 1,
      'reset must record exactly one violation before the passing response');

    console.log('PASS: model-contract violation — two consecutive over-limit responses (total or mutating) terminate as model_contract_failed after exactly two responses with zero operations; a passing/no-op response resets the streak; feedback states both limits; durable snapshot reconstructs the streak');
  } finally {
    server.kill('SIGTERM');
    await sleep(1000);
    if (server.exitCode === null) server.kill('SIGKILL');
    provider.server.close();
    try { await store.pool.query(`DROP SCHEMA IF EXISTS ${store.schemaSql} CASCADE`); } catch (_) {}
    await store.close();
    fs.rmSync(WORKSPACE_ROOT, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error.stack || error.message); process.exit(1); });

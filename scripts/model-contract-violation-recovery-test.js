#!/usr/bin/env node
'use strict';
// Crash/restart recovery test for the action-contract violation streak
// (server.js + runtime/action-contract-streak.js). Proves the streak survives
// real process death across a genuine server restart, using the deterministic
// `after_action_contract_violation` interrupt seam (not timing-dependent
// killing):
//
//   1. Boot the real server with a mock provider; return one over-limit response.
//   2. The violation decision is persisted durably.
//   3. The seam SIGKILLs the process after that evidence is durable and before
//      any further provider request.
//   4. Restart against the same schema.
//   5. The recovered run seeds its streak (= 1) from the durable snapshot and
//      returns one further over-limit response.
//   6. Assert: exactly one provider call before the crash and exactly one after;
//      the second violation reaches threshold 2; the run terminates with
//      MODEL_RESPONSE_CONTRACT_VIOLATION / triage model_contract_failed; zero
//      operations executed; not a timeout / RUN_LIMIT_EXCEEDED.
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
const { allocateTestPorts } = require('./test-port');

const DATABASE_URL = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('TEST_DATABASE_URL (or DATABASE_URL) is required for the model-contract recovery test');
  process.exit(1);
}

const SCHEMA = `model_contract_recovery_${process.pid}_${crypto.randomBytes(4).toString('hex')}`;
let PORT_1 = null;
let PORT_2 = null;
const WORKSPACE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'model-contract-recovery-ws-'));
const LEASE_MS = 2500;

function assert(c, m) { if (!c) throw new Error(m); }
const sleep = ms => new Promise(r => setTimeout(r, ms));
const A_TO_Z = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');

// Mock ollama: always returns 26 createFolder actions (over the total gate).
function startMockProvider() {
  let calls = 0;
  const plan = { message: 'creating A-Z', actions: A_TO_Z.map(p => ({ operation: 'createFolder', args: { path: p } })), complete: false };
  const server = http.createServer((req, res) => {
    if (req.method !== 'POST' || !req.url.startsWith('/api/chat')) { res.writeHead(404); res.end(); return; }
    req.on('data', () => {});
    req.on('end', () => {
      calls += 1;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        model: 'mock-model', created_at: new Date().toISOString(),
        message: { role: 'assistant', content: JSON.stringify(plan) },
        done: true, done_reason: 'stop', eval_count: 10, prompt_eval_count: 100, total_duration: 1e6
      }));
    });
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({
    server, url: `http://127.0.0.1:${server.address().port}`, callCount: () => calls
  })));
}

function bootServer(providerUrl, { interrupt, port }) {
  const server = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      NODE_ENV: 'test', DATABASE_URL, POSTGRES_SCHEMA: SCHEMA,
      SESSION_SECRET: 'model-contract-recovery-secret-0123456789abcdef0123456789abcdef',
      ADMIN_BOOTSTRAP_PASSWORD: 'admin123', PORT: String(port), WORKSPACE_ROOT,
      OLLAMA_BASE_URL: providerUrl,
      RUN_LEASE_DURATION_MS: String(LEASE_MS),
      RUNTIME_SCHEDULER_INTERVAL_MS: '200',
      PROCESS_TEMPLATE_SCHEDULER_INTERVAL_MS: '3600000',
      ...(interrupt ? { TEST_INTERRUPTION_POINT: 'after_action_contract_violation' } : {})
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let out = '';
  server.stdout.on('data', c => { out += c; });
  server.stderr.on('data', c => { out += c; });
  return { server, out: () => out };
}

async function waitReady(handle, port) {
  for (let i = 0; i < 80; i++) {
    if (handle.server.exitCode !== null || handle.server.signalCode !== null) {
      throw new Error('server exited during startup:\n' + handle.out().slice(-3000));
    }
    try { if ((await fetch(`http://127.0.0.1:${port}/login`)).status === 200) return; } catch (_) {}
    await sleep(400);
  }
  throw new Error('server did not become ready:\n' + handle.out().slice(-3000));
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
  // Two OS-allocated ephemeral ports from ONE call, so the probes are open
  // simultaneously and cannot alias. The old scheme used PORT_1 + 1, which
  // assumed the neighbouring port was free.
  [PORT_1, PORT_2] = await allocateTestPorts(2);
  const store = new PostgresRuntimeStore({ connectionString: DATABASE_URL, schema: SCHEMA, disposableMigrations: true });
  await store.migrate();
  const provider = await startMockProvider();
  let handle = null;

  try {
    const agent = (await store.createConfiguredAgent({
      value: { name: 'Contract Recovery Agent', provider: 'ollama', model: 'mock-model', apiKey: '' },
      groupIds: [], changedBy: 'contract-recovery-test'
    })).agent;
    const now = new Date().toISOString();
    const ticket = (await store.createTicketWithEvent({
      ticket: {
        objective: 'please make many folders', acceptanceCriteria: null,
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
        status: 'open', createdBy: 'admin', changedBy: 'admin', changedAt: now, createdAt: now, updatedAt: now
      },
      eventPayload: { source: 'contract-recovery-test' }
    })).ticket;
    const run = await store.createRun({
      ticketId: ticket.id, agentId: agent.id, agentName: agent.name,
      runtimeLimitsSnapshot: currentRuntimeLimitsSnapshot(),
      executionPolicySnapshot: { requireVerification: 'when_declared' }, status: 'pending'
    });

    // ── Boot 1: one violation, then a deterministic crash at the seam. ──
    handle = bootServer(provider.url, { interrupt: true, port: PORT_1 });
    let hookSeen = false;
    for (let i = 0; i < 150; i++) {
      const events = await allEvents(store, run.id);
      if (events.some(e => e.type === 'interruption.test_hook'
        && e.payload && e.payload.point === 'after_action_contract_violation')) { hookSeen = true; break; }
      if (handle.server.exitCode !== null || handle.server.signalCode !== null) break;
      await sleep(300);
    }
    assert(hookSeen, 'run did not reach the action-contract violation crash seam:\n' + handle.out().slice(-3000));
    for (let i = 0; i < 50 && handle.server.exitCode === null && handle.server.signalCode === null; i++) await sleep(200);
    assert(handle.server.exitCode !== null || handle.server.signalCode !== null, 'crash seam did not terminate the server');

    // Durable state before restart: exactly one provider call, one violation
    // decision, streak reconstructs to 1, run not yet terminal.
    assert(provider.callCount() === 1, `expected exactly one provider call before the crash, got ${provider.callCount()}`);
    const crashSnap = (await store.getReplaySnapshot(run.id)).snapshot;
    const crashViolations = (crashSnap.events || []).filter(e => e.type === 'model:action_limit');
    assert(crashViolations.length === 1, `expected one durable violation decision pre-restart, got ${crashViolations.length}`);
    assert(reconstructActionContractViolationStreak(crashSnap) === 1, 'durable snapshot must reconstruct the streak to 1 before restart');
    assert(!['completed', 'failed', 'interrupted'].includes((await store.getRun(run.id)).status), 'run must not be terminal before restart');

    // Let the crashed run's lease expire so restart recovery can resume it.
    await sleep(LEASE_MS + 800);

    // ── Boot 2: recovery resumes the run; one further violation reaches the
    // threshold and terminates. ──
    handle = bootServer(provider.url, { interrupt: false, port: PORT_2 });
    await waitReady(handle, PORT_2);
    let finalRun = null;
    for (let i = 0; i < 150; i++) {
      const r = await store.getRun(run.id);
      if (r && ['completed', 'failed', 'interrupted'].includes(r.status)) { finalRun = r; break; }
      await sleep(400);
    }
    assert(finalRun, 'run did not terminate after restart:\n' + handle.out().slice(-2500));

    // Exactly one ADDITIONAL provider call after restart (total 2).
    assert(provider.callCount() === 2, `expected exactly one additional provider call after restart (total 2), got ${provider.callCount()}`);

    const finalSnap = (await store.getReplaySnapshot(run.id)).snapshot;
    assert(finalRun.status === 'failed', `recovered run must fail; got ${finalRun.status}`);
    assert(finalSnap.failure && finalSnap.failure.code === 'MODEL_RESPONSE_CONTRACT_VIOLATION',
      `failure must be MODEL_RESPONSE_CONTRACT_VIOLATION; got ${JSON.stringify(finalSnap.failure)}`);
    assert(finalSnap.failure.kind === 'no_progress', `failureKind must be no_progress; got ${finalSnap.failure.kind}`);
    assert(finalSnap.failure.kind !== 'timeout' && finalSnap.failure.code !== 'RUN_LIMIT_EXCEEDED', 'must NOT be a timeout / RUN_LIMIT_EXCEEDED');
    assert(finalRun.triage && finalRun.triage.reasonCode === 'model_contract_failed',
      `triage must be model_contract_failed; got ${finalRun.triage && finalRun.triage.reasonCode}`);
    assert(finalSnap.failure.detail && finalSnap.failure.detail.consecutiveViolations >= 2,
      `failure detail must report the threshold streak; got ${JSON.stringify(finalSnap.failure.detail)}`);
    assert((finalSnap.workspaceOperations || []).length === 0, 'no workspace operation may execute');
    assert((await store.listRunOperations(run.id, { limit: 10 })).length === 0, 'no operation history may exist');

    console.log('PASS: model-contract recovery — one violation persisted, process crashed at the deterministic seam, restart reconstructed the streak (=1), one further violation reached threshold 2, run terminated as model_contract_failed with exactly two provider calls and zero operations');
  } finally {
    if (handle) { handle.server.kill('SIGKILL'); await sleep(300); }
    provider.server.close();
    try { await store.pool.query(`DROP SCHEMA IF EXISTS ${store.schemaSql} CASCADE`); } catch (_) {}
    await store.close();
    fs.rmSync(WORKSPACE_ROOT, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error.stack || error.message); process.exit(1); });

#!/usr/bin/env node
// Regression test for the two defects behind run-3's false failure
// ("Resume denied: operation_non_integer_turn", 2026-07-24):
//
// 1. Lease renewal: a model call that outlasts the run lease must not lose
//    the lease mid-flight. Before the fix, the scheduler declared the lease
//    stale during every long provider call and forced a recovery/resume
//    cycle against a healthy worker. Here each mock model call takes ~2.5x
//    the lease duration; the run must complete with NO recovery claims.
//
// 2. Recorder identity: executed workspace operations must carry the
//    execution-turn identity (executionTurn / planKey / actionIndex) that the
//    resume safety contract (runtime/recovery-state.js) requires. Before the
//    fix the recorder never stamped these, so any resume after a committed
//    operation was denied as unsafe. Here the recorded evidence is fed back
//    through reconstructAgentRecoveryState mid-run-shaped and must be safe.
//
// Real server, real PostgreSQL store (isolated schema), mock ollama provider.
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
const { reconstructAgentRecoveryState, RECOVERY_STATE } = require('../runtime/recovery-state');
const { allocateTestPort } = require('./test-port');

const DATABASE_URL = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('TEST_DATABASE_URL (or DATABASE_URL) is required for the lease renewal test');
  process.exit(1);
}

const SCHEMA = `lease_renewal_${process.pid}_${crypto.randomBytes(4).toString('hex')}`;
let PORT = null;
const WORKSPACE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'lease-renewal-ws-'));
const LEASE_MS = 2000;
const MODEL_CALL_DELAY_MS = 5000; // ~2.5x the lease: guarantees mid-call expiry without renewal

function assert(c, m) { if (!c) throw new Error(m); }
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Mock ollama: first call proposes two mutations (complete:false), second call
// reports completion. Each response takes MODEL_CALL_DELAY_MS.
function startMockProvider() {
  let calls = 0;
  const plans = [
    { message: 'Creating folders A and B', actions: [{ operation: 'createFolder', args: { path: 'A' } }, { operation: 'createFolder', args: { path: 'B' } }], complete: false },
    { message: 'Both folders exist; objective satisfied.', actions: [], complete: true }
  ];
  const server = http.createServer((req, res) => {
    if (req.method !== 'POST' || !req.url.startsWith('/api/chat')) {
      res.writeHead(404); res.end(); return;
    }
    req.on('data', () => {});
    req.on('end', () => {
      const plan = plans[Math.min(calls, plans.length - 1)];
      calls += 1;
      setTimeout(() => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          model: 'mock-model',
          created_at: new Date().toISOString(),
          message: { role: 'assistant', content: JSON.stringify(plan) },
          done: true,
          done_reason: 'stop',
          eval_count: 10,
          prompt_eval_count: 100,
          total_duration: MODEL_CALL_DELAY_MS * 1e6
        }));
      }, MODEL_CALL_DELAY_MS);
    });
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({
    server,
    url: `http://127.0.0.1:${server.address().port}`,
    callCount: () => calls
  })));
}

async function main() {
  // OS-allocated ephemeral port: see scripts/test-port.js. Fixed or pid-derived
  // ports collided across suites and surfaced as a misleading start failure.
  PORT = String(await allocateTestPort());
  const store = new PostgresRuntimeStore({ connectionString: DATABASE_URL, schema: SCHEMA, disposableMigrations: true });
  await store.migrate();
  const provider = await startMockProvider();

  const server = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      DATABASE_URL,
      POSTGRES_SCHEMA: SCHEMA,
      SESSION_SECRET: 'lease-renewal-session-secret-0123456789abcdef0123456789abcdef',
      ADMIN_BOOTSTRAP_PASSWORD: 'admin123',
      PORT,
      WORKSPACE_ROOT,
      OLLAMA_BASE_URL: provider.url,
      RUN_LEASE_DURATION_MS: String(LEASE_MS),
      TEST_SKIP_STARTUP_RUN_RECOVERY: 'true',
      RUNTIME_SCHEDULER_INTERVAL_MS: '500',
      PROCESS_TEMPLATE_SCHEDULER_INTERVAL_MS: '3600000'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let out = '';
  server.stdout.on('data', c => { out += c; });
  server.stderr.on('data', c => { out += c; });

  try {
    let up = false;
    for (let i = 0; i < 60; i++) {
      if (server.exitCode !== null) break;
      try { if ((await fetch(`http://127.0.0.1:${PORT}/login`)).status === 200) { up = true; break; } } catch (_) {}
      await sleep(400);
    }
    assert(up, 'server did not start:\n' + out.slice(-4000));

    const agent = (await store.createConfiguredAgent({
      value: { name: 'Lease Renewal Agent', provider: 'ollama', model: 'mock-model', apiKey: '' },
      groupIds: [],
      changedBy: 'lease-renewal-test'
    })).agent;
    const now = new Date().toISOString();
    const ticket = (await store.createTicketWithEvent({
      ticket: {
        objective: 'create folders A and B in the workspace',
        acceptanceCriteria: null,
        assignmentTargetType: 'agent',
        assignmentTargetId: agent.id,
        assignmentMode: 'individual',
        ownedOutputPaths: null,
        targetRef: null,
        executionMode: 'agent',
        workflowId: null,
        workflowInput: null,
        capabilityType: 'directAction',
        capabilityId: 'agent-selected-actions',
        capabilityInput: null,
        executionPolicy: {
          mode: 'assisted', requireVerification: 'when_declared', autoRetry: false,
          maxAttempts: null, maxRuntimeMs: null, maxModelRequests: null,
          maxWorkspaceOperations: null, allowWorkspaceWrites: true,
          allowParallelRuns: false, allowChildTickets: false, workspaceScope: 'shared'
        },
        workTypeId: null, workTypeSnapshot: null, workContextId: null, workContextSnapshot: null,
        status: 'open',
        createdBy: 'admin', changedBy: 'admin', changedAt: now, createdAt: now, updatedAt: now
      },
      eventPayload: { source: 'lease-renewal-test' }
    })).ticket;
    const run = await store.createRun({
      ticketId: ticket.id,
      agentId: agent.id,
      agentName: agent.name,
      runtimeLimitsSnapshot: currentRuntimeLimitsSnapshot(),
      executionPolicySnapshot: { requireVerification: 'when_declared' },
      status: 'pending'
    });

    // Wait for the scheduler to pick the run up and drive it to a terminal
    // state through two 5s model calls against a 2s lease.
    let finalRun = null;
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      const current = await store.getRun(run.id);
      if (current && ['completed', 'failed', 'interrupted'].includes(current.status)) { finalRun = current; break; }
      await sleep(1000);
    }
    assert(finalRun, 'run did not reach a terminal state:\n' + out.slice(-4000));
    assert(provider.callCount() >= 2, `mock provider expected >=2 calls, saw ${provider.callCount()}`);
    assert(finalRun.status === 'completed',
      `run must complete despite model calls outlasting the lease; got ${finalRun.status}: ${finalRun.error || ''}\n` + out.slice(-2000));

    // 1. Lease renewal: no recovery was ever claimed — the lease stayed live
    // through both provider calls, and heartbeats were recorded mid-call.
    // Raw seq-ordered journal events (the same read the runtime's resume path
    // uses) — the timeline projection lacks the hash-chain fields.
    const eventList = [];
    let afterSeq = -1;
    while (true) {
      const page = await store.listRunEvents(run.id, { afterSeq, limit: 100 });
      if (!Array.isArray(page) || page.length === 0) break;
      eventList.push(...page);
      afterSeq = page[page.length - 1].seq;
    }
    const recoveryEvents = eventList.filter(e => e && /recover/i.test(e.type));
    assert(recoveryEvents.length === 0,
      'no recovery claim may occur while the worker holds a renewed lease; saw: ' + recoveryEvents.map(e => e.type).join(', '));
    const inFlightHeartbeats = eventList.filter(e => e && e.type === 'run.heartbeat'
      && e.payload && e.payload.phase === 'provider_call_in_flight');
    assert(inFlightHeartbeats.length >= 2, `expected in-flight lease renewals during 2x${MODEL_CALL_DELAY_MS}ms calls, saw ${inFlightHeartbeats.length}`);

    // 2. Recorder identity: every recorded workspace operation carries the
    // execution-turn identity the resume contract requires.
    const replay = await store.getReplaySnapshot(run.id);
    const snapshot = replay ? replay.snapshot : null;
    assert(snapshot && Array.isArray(snapshot.workspaceOperations) && snapshot.workspaceOperations.length === 2,
      'expected 2 recorded workspace operations');
    for (const op of snapshot.workspaceOperations) {
      assert(Number.isInteger(op.executionTurn) && op.executionTurn >= 0, 'operation must carry integer executionTurn');
      assert(typeof op.planKey === 'string' && op.planKey.length > 0, 'operation must carry planKey');
      assert(Number.isInteger(op.actionIndex) && op.actionIndex >= 0, 'operation must carry actionIndex');
      assert(typeof op.operationKey === 'string' && op.operationKey.length > 0, 'operation must carry operationKey');
    }

    // 3. Resumability: the same evidence viewed mid-run (pre-terminal events)
    // must pass the resume safety contract — this exact shape was denied with
    // operation_non_integer_turn before the recorder fix.
    const terminalIndex = eventList.findIndex(e => e && e.type === 'run.execution_completed');
    const preTerminalEvents = terminalIndex >= 0 ? eventList.slice(0, terminalIndex) : eventList;
    const operationHistory = await store.listRunOperations(run.id, { limit: 100 });
    const historyList = Array.isArray(operationHistory) ? operationHistory : (operationHistory.operations || []);
    // Same operation-key verifier as production (buildRecoveredOperationKeyVerifier):
    // recompute run:{id}:slot:sha256(slot):input:sha256(canonical op json).
    const canonicalOperationJson = value => {
      if (Array.isArray(value)) return `[${value.map(canonicalOperationJson).join(',')}]`;
      if (value && typeof value === 'object') {
        return `{${Object.keys(value).filter(k => value[k] !== undefined).sort()
          .map(k => `${JSON.stringify(k)}:${canonicalOperationJson(value[k])}`).join(',')}}`;
      }
      const encoded = JSON.stringify(value);
      return encoded === undefined ? 'null' : encoded;
    };
    const verifyOperationKey = ({ operationKey, operation, expectedOperation, args, turn, actionIndex }) => {
      if (operation !== expectedOperation) return { valid: false, reason: 'operation_mismatch' };
      const slotHash = crypto.createHash('sha256').update(`agent:${turn}:${actionIndex}`).digest('hex');
      const inputHash = crypto.createHash('sha256')
        .update(canonicalOperationJson({ operation, args: args || {} })).digest('hex');
      return { valid: operationKey === `run:${finalRun.id}:slot:${slotHash}:input:${inputHash}` };
    };
    const recoveryState = reconstructAgentRecoveryState({
      run: { ...finalRun, status: 'running' },
      replaySnapshot: snapshot,
      events: preTerminalEvents,
      operationHistory: historyList,
      mutatingOperations: ['createFolder', 'writeFile', 'renamePath', 'deletePath'],
      verifyOperationKey
    });
    assert(recoveryState.state !== RECOVERY_STATE.UNSAFE_TO_CONTINUE,
      'recorded evidence must satisfy the resume identity contract; inconsistencies: '
      + JSON.stringify(recoveryState.inconsistencies) + ' detail: ' + JSON.stringify(recoveryState.inconsistencyDetail));

    console.log('PASS: lease renewal + resume safety — model calls outlasting the lease complete without recovery claims, and recorded operations satisfy the resume identity contract');
  } finally {
    server.kill('SIGTERM');
    await new Promise(r => setTimeout(r, 1200));
    if (server.exitCode === null) server.kill('SIGKILL');
    provider.server.close();
    try { await store.pool.query(`DROP SCHEMA IF EXISTS ${store.schemaSql} CASCADE`); } catch (_) {}
    await store.close();
    fs.rmSync(WORKSPACE_ROOT, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error.stack || error.message); process.exit(1); });

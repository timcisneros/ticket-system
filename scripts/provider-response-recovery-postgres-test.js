#!/usr/bin/env node
'use strict';
// PostgreSQL-native provider-response restart-recovery test — the replacement
// for the retired JSON provider-response-recovery-test. It proves the durable
// provider-response recovery boundary against real PostgreSQL evidence:
//
//   * a provider response persisted just before a crash survives the restart;
//   * recovery reuses that durable response — the provider is NOT re-invoked;
//   * the recovered response is attributed to its original execution turn and
//     consumes exactly one model-request unit (no duplicate budget draw);
//   * the run reaches the correct terminal outcome, executing the durable plan.
//
// Real server + real store (isolated schema) + mock ollama HTTP provider. The
// crash is the production test seam TEST_INTERRUPT_AFTER_AGENT_PROVIDER_RESPONSE_PERSISTED
// (SIGKILL right after the response is persisted, before it is parsed). A short
// run lease makes the crashed run recoverable on restart deterministically.
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

const DATABASE_URL = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('TEST_DATABASE_URL (or DATABASE_URL) is required for the provider-response recovery test');
  process.exit(1);
}

const SCHEMA = `provider_recovery_${process.pid}_${crypto.randomBytes(4).toString('hex')}`;
// Each boot gets its own port: the crashed (SIGKILLed) boot-1 server can leave a
// stale pooled connection on its port in the test process, so reusing it for
// boot 2 makes readiness fetches hang. Distinct ports sidestep it entirely.
const PORT_1 = Number(process.env.PORT || 3660 + (process.pid % 120));
const PORT_2 = PORT_1 + 1;
const WORKSPACE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-recovery-ws-'));
const LEASE_MS = 2500;
const FOLDER = 'recovered-folder';

function assert(c, m) { if (!c) throw new Error(m); }
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Mock ollama that returns a single complete plan (createFolder). It counts
// invocations so a duplicate provider call after recovery is caught.
function startMockProvider() {
  let calls = 0;
  const plan = { message: 'Creating the recovered folder', actions: [{ operation: 'createFolder', args: { path: FOLDER } }], complete: true };
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
      NODE_ENV: 'test',
      DATABASE_URL,
      POSTGRES_SCHEMA: SCHEMA,
      SESSION_SECRET: 'provider-recovery-session-secret-0123456789abcdef0123456789abcdef',
      ADMIN_BOOTSTRAP_PASSWORD: 'admin123',
      PORT: String(port),
      WORKSPACE_ROOT,
      OLLAMA_BASE_URL: providerUrl,
      RUN_LEASE_DURATION_MS: String(LEASE_MS),
      RUNTIME_SCHEDULER_INTERVAL_MS: '200',
      PROCESS_TEMPLATE_SCHEDULER_INTERVAL_MS: '3600000',
      ...(interrupt ? { TEST_INTERRUPT_AFTER_AGENT_PROVIDER_RESPONSE_PERSISTED: 'true' } : {})
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
    if (handle.server.exitCode !== null || handle.server.signalCode !== null) throw new Error('server exited during startup:\n' + handle.out().slice(-3000));
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
  const store = new PostgresRuntimeStore({ connectionString: DATABASE_URL, schema: SCHEMA });
  await store.migrate();
  const provider = await startMockProvider();

  let handle = null;
  try {
    const agent = (await store.createConfiguredAgent({
      value: { name: 'Provider Recovery Agent', provider: 'ollama', model: 'mock-model', apiKey: '' },
      groupIds: [], changedBy: 'provider-recovery-test'
    })).agent;
    const now = new Date().toISOString();
    const ticket = (await store.createTicketWithEvent({
      ticket: {
        objective: `Create folder ${FOLDER}`, acceptanceCriteria: null,
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
      eventPayload: { source: 'provider-recovery-test' }
    })).ticket;
    const run = await store.createRun({
      ticketId: ticket.id, agentId: agent.id, agentName: agent.name,
      runtimeLimitsSnapshot: currentRuntimeLimitsSnapshot(),
      executionPolicySnapshot: { requireVerification: 'when_declared' }, status: 'pending'
    });

    // ── Boot 1: the run executes to the durable provider response then crashes.
    // The 200ms scheduler runs the pending run and the interrupt seam SIGKILLs
    // the server almost immediately, so we do NOT gate on /login readiness —
    // boot 1 exists only to reach the crash seam. Wait for the hook event, then
    // for the process to die. ──
    handle = bootServer(provider.url, { interrupt: true, port: PORT_1 });
    let hookSeen = false;
    for (let i = 0; i < 150; i++) {
      const events = await allEvents(store, run.id);
      if (events.some(e => e.type === 'interruption.test_hook')) { hookSeen = true; break; }
      if (handle.server.exitCode !== null || handle.server.signalCode !== null) break;
      await sleep(300);
    }
    assert(hookSeen, 'run did not reach the provider-response crash seam:\n' + handle.out().slice(-3000));
    for (let i = 0; i < 50 && handle.server.exitCode === null && handle.server.signalCode === null; i++) await sleep(200);
    assert(handle.server.exitCode !== null || handle.server.signalCode !== null, 'interrupt seam did not terminate the server');

    // Durable evidence before restart: exactly one request + one response, no plan yet.
    const crashReplay = await store.getReplaySnapshot(run.id);
    const crashSnap = crashReplay ? crashReplay.snapshot : {};
    assert((crashSnap.providerRequests || []).length === 1, `expected 1 durable provider request pre-restart, got ${(crashSnap.providerRequests || []).length}`);
    assert((crashSnap.modelResponses || []).length === 1, `expected 1 durable provider response pre-restart, got ${(crashSnap.modelResponses || []).length}`);
    assert((crashSnap.parsedModelPlans || []).length === 0, 'crash seam must precede plan parsing');
    assert(provider.callCount() === 1, `provider must have been called once pre-crash, got ${provider.callCount()}`);

    // Let the crashed run's lease expire so restart recovery can reclaim it.
    await sleep(LEASE_MS + 800);

    // ── Boot 2: no interrupt. Startup recovery + scheduler resume the run from
    // the durable response — no new provider call. ──
    handle = bootServer(provider.url, { interrupt: false, port: PORT_2 });
    await waitReady(handle, PORT_2);
    let finalRun = null;
    for (let i = 0; i < 120; i++) {
      const current = await store.getRun(run.id);
      if (current && ['completed', 'failed', 'interrupted'].includes(current.status)) { finalRun = current; break; }
      await sleep(500);
    }
    assert(finalRun, 'run did not reach a terminal state after restart:\n' + handle.out().slice(-3000));

    // 1. Provider was NOT re-invoked — the durable response was reused.
    assert(provider.callCount() === 1, `provider must not be re-invoked on recovery; total calls=${provider.callCount()}`);

    // 2. Correct terminal outcome, durable plan executed.
    assert(finalRun.status === 'completed', `recovered run must complete; got ${finalRun.status}: ${finalRun.error || ''}\n` + handle.out().slice(-2000));
    assert(fs.existsSync(path.join(WORKSPACE_ROOT, FOLDER)), 'recovered durable plan did not execute its createFolder action');

    // 3. Exactly one request/response/plan; recovered response keeps its turn.
    const finalReplay = await store.getReplaySnapshot(run.id);
    const snap = finalReplay ? finalReplay.snapshot : {};
    assert((snap.providerRequests || []).length === 1, `recovery must not draw a second model-request unit; requests=${(snap.providerRequests || []).length}`);
    assert((snap.modelResponses || []).length === 1, `recovery must not persist a duplicate response; responses=${(snap.modelResponses || []).length}`);
    assert((snap.parsedModelPlans || []).length === 1, `recovered response must parse exactly one plan; plans=${(snap.parsedModelPlans || []).length}`);
    assert(snap.modelResponses[0].executionTurn === 0 && snap.modelResponses[0].modelCallKey === 'agent:0:provider',
      'recovered response must keep its original execution turn / model-call identity');
    assert(snap.parsedModelPlans[0].executionTurn === 0, 'recovered plan must be attributed to the original execution turn');

    // 4. No duplicate terminalization, one resume-parse observability event.
    const events = await allEvents(store, run.id);
    assert(events.filter(e => e.type === 'run.terminalized').length === 1, 'exactly one terminalization');

    console.log('PASS: provider-response restart recovery (postgres) — durable response survives the crash, provider not re-invoked, single model-request unit consumed on the original turn, run completes executing the durable plan');
  } finally {
    if (handle) { handle.server.kill('SIGKILL'); await sleep(300); }
    provider.server.close();
    try { await store.pool.query(`DROP SCHEMA IF EXISTS ${store.schemaSql} CASCADE`); } catch (_) {}
    await store.close();
    fs.rmSync(WORKSPACE_ROOT, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error.stack || error.message); process.exit(1); });

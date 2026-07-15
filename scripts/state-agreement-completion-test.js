#!/usr/bin/env node
// State-agreement and completion-semantics hardening — P1 tests.
//
// Two self-contained server boots over seeded data:
//   Phase 1 (reconcile): startup convergence of the terminalized-run /
//     unfinalized-ticket crash window and immutable run-snapshot verification.
//   Phase 2 (manual guard): manual ticket completion accept/reject matrix,
//     including Option A (postcondition-free completed-but-unverified accepts).
//
// All state is seeded before the server starts, so there are no cache or
// scheduler races: startup reconciliation runs before fastify.listen().

const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { sealCurrentRunEventChains } = require('./current-event-fixture');

const ROOT = path.resolve(__dirname, '..');
// argon2 hash for password 'admin123'
const ADMIN_HASH = '$argon2id$v=19$m=65536,t=3,p=4$az+Aa/Vt5AjalPiSGPNdXQ$i+hlbZS1OGPnBIw16HfGY/u0A4VUqXdFkd5Y+JtXh/g';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function request(baseUrl, method, urlPath, options = {}) {
  const body = options.form
    ? new URLSearchParams(options.form).toString()
    : options.json
      ? JSON.stringify(options.json)
      : null;
  return new Promise((resolve, reject) => {
    const req = http.request(baseUrl + urlPath, {
      method,
      headers: {
        ...(options.form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
        ...(options.json ? { 'Content-Type': 'application/json' } : {}),
        ...(body ? { 'Content-Length': Buffer.byteLength(body) } : {}),
        ...(options.cookie ? { Cookie: options.cookie } : {})
      }
    }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({
        statusCode: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks).toString('utf8')
      }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function cookieFrom(response) {
  return (response.headers['set-cookie'] || []).map(cookie => cookie.split(';')[0]).join('; ');
}

function makeDirs() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'state-agree-data-'));
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'state-agree-ws-'));
  fs.mkdirSync(path.join(dataDir, 'replay-snapshots'), { recursive: true });
  return { dataDir, workspaceRoot };
}

function writeJson(dataDir, file, value) {
  fs.writeFileSync(path.join(dataDir, file), JSON.stringify(value, null, 2));
}

function writeEvents(dataDir, events) {
  const currentEvents = sealCurrentRunEventChains(events);
  fs.writeFileSync(path.join(dataDir, 'events.jsonl'), currentEvents.map(e => JSON.stringify(e)).join('\n') + '\n');
}

function readJson(dataDir, file) {
  return JSON.parse(fs.readFileSync(path.join(dataDir, file), 'utf8'));
}

function readEvents(dataDir) {
  const raw = fs.readFileSync(path.join(dataDir, 'events.jsonl'), 'utf8');
  return raw.split('\n').filter(Boolean).map(line => JSON.parse(line));
}

function seedCommon(dataDir, workspaceRoot, { workflows = [] } = {}) {
  writeJson(dataDir, 'users.json', [{
    id: 1, username: 'admin', passwordHash: ADMIN_HASH,
    createdAt: new Date().toISOString(), type: 'user'
  }]);
  writeJson(dataDir, 'permissions.json', ['ticket:create', 'ticket:read', 'ticket:update']);
  writeJson(dataDir, 'groups.json', [{
    id: 1, name: 'Administrators',
    permissions: ['ticket:create', 'ticket:read', 'ticket:update'], canReceiveTickets: false
  }]);
  writeJson(dataDir, 'memberships.json', [{ id: 1, principalType: 'user', principalId: 1, groupId: 1 }]);
  writeJson(dataDir, 'agents.json', [{
    id: 1, name: 'State Agree Agent', type: 'agent',
    provider: 'openai', model: 'gpt-test', apiKey: 'test-key',
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
  }]);
  writeJson(dataDir, 'workflows.json', workflows);
  writeJson(dataDir, 'allocation-plans.json', []);
  writeJson(dataDir, 'operation-history.json', []);
  writeJson(dataDir, 'logs.json', []);
  void workspaceRoot;
}

const ISO = '2026-02-01T00:00:00.000Z';

function ticketBase(id, status, overrides = {}) {
  return {
    id,
    objective: `State agreement ticket #${id}`,
    assignmentTargetType: 'agent',
    assignmentTargetId: 1,
    assignmentMode: 'individual',
    ownedOutputPaths: null,
    executionMode: 'agent',
    workflowId: null,
    workflowInput: null,
    capabilityType: 'directAction',
    capabilityId: 'agent-selected-actions',
    capabilityInput: null,
    status,
    createdBy: 'admin',
    changedBy: 'admin',
    changedAt: ISO,
    createdAt: ISO,
    updatedAt: ISO,
    ...overrides
  };
}

function runBase(id, ticketId, status, overrides = {}) {
  return {
    id,
    ticketId,
    agentId: 1,
    agentName: 'State Agree Agent',
    workspaceRoot: '/tmp',
    mainWorkspaceRoot: '/tmp',
    executionWorkspaceType: 'main',
    allocationPlanId: null,
    allocationItemId: null,
    ownedOutputPaths: [],
    executionMode: 'agent',
    workflowId: null,
    workflowInput: null,
    capabilityType: 'directAction',
    capabilityId: 'agent-selected-actions',
    capabilityInput: null,
    executionPolicySnapshot: { requireVerification: 'when_declared' },
    currentPhase: 'terminalization',
    leaseOwner: null,
    leaseExpiresAt: null,
    currentStepId: null,
    currentWorkflowAction: null,
    lastHeartbeatAt: null,
    status,
    createdAt: ISO,
    updatedAt: ISO,
    startedAt: ISO,
    completedAt: status === 'completed' || status === 'failed' || status === 'interrupted' ? ISO : undefined,
    ...overrides
  };
}

function startServer(dataDir, workspaceRoot, port) {
  const proc = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, NODE_ENV: 'test', PORT: String(port), DATA_DIR: dataDir, WORKSPACE_ROOT: workspaceRoot },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let output = '';
  proc.stdout.on('data', c => { output += String(c); });
  proc.stderr.on('data', c => { output += String(c); });
  proc.getOutput = () => output;
  return proc;
}

function waitForReady(baseUrl, proc, timeoutMs = 12000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const poll = () => {
      if (proc.exitCode !== null) return reject(new Error('Server exited early:\n' + proc.getOutput()));
      http.get(baseUrl + '/api/health', res => {
        res.resume();
        if (res.statusCode === 200) return resolve();
        if (Date.now() > deadline) return reject(new Error('Server readiness timeout'));
        setTimeout(poll, 200);
      }).on('error', () => {
        if (Date.now() > deadline) return reject(new Error('Server readiness timeout'));
        setTimeout(poll, 200);
      });
    };
    setTimeout(poll, 400);
  });
}

async function stopServer(proc) {
  if (!proc) return;
  proc.kill('SIGTERM');
  await sleep(400);
  if (proc.exitCode === null) proc.kill('SIGKILL');
}

async function login(baseUrl) {
  const response = await request(baseUrl, 'POST', '/login', { form: { username: 'admin', password: 'admin123' } });
  assert(response.statusCode === 302, 'Admin login failed with HTTP ' + response.statusCode);
  const cookie = cookieFrom(response);
  assert(cookie.includes('sessionId='), 'Login did not return a session cookie');
  return cookie;
}

// ── Phase 1: startup reconciliation and immutable verification snapshot ──────
async function runReconcilePhase() {
  const { dataDir, workspaceRoot } = makeDirs();
  const port = 3486;
  const baseUrl = 'http://127.0.0.1:' + port;
  let server = null;
  try {
    fs.writeFileSync(path.join(workspaceRoot, 'snapshot-ok.txt'), 'present');

    seedCommon(dataDir, workspaceRoot, {
      workflows: [{
        id: 'wf-current', name: 'Current workflow', version: '1',
        inputSchema: {},
        actions: [{ id: 'done', action: 'stop', input: {} }],
        postconditions: [{ id: 'current-pc', type: 'fileExists', path: 'snapshot-ok.txt' }]
      }]
    });

    // Ticket 11: completed+terminalized run, ticket stuck in_progress (crash window).
    // Ticket 12: failed+terminalized run, ticket stuck in_progress.
    // Ticket 13: current workflow run with its immutable verification snapshot, needs reconcile.
    // Ticket 14: interrupted+terminalized run, ticket stuck in_progress.
    writeJson(dataDir, 'tickets.json', [
      ticketBase(11, 'in_progress'),
      ticketBase(12, 'in_progress'),
      ticketBase(13, 'in_progress', {
        executionMode: 'workflow', workflowId: 'wf-current',
        capabilityType: 'workflow', capabilityId: 'wf-current', workflowInput: {}
      }),
      ticketBase(14, 'in_progress')
    ]);

    writeJson(dataDir, 'runs.json', [
      runBase(101, 11, 'completed', { replaySnapshotPath: 'replay-snapshots/run-101.json' }),
      runBase(102, 12, 'failed', { error: 'boom', replaySnapshotPath: 'replay-snapshots/run-102.json' }),
      runBase(103, 13, 'completed', {
        executionMode: 'workflow', workflowId: 'wf-current',
        capabilityType: 'workflow', capabilityId: 'wf-current', workflowInput: {},
        replaySnapshotPath: 'replay-snapshots/run-103.json',
        verificationContractSnapshot: {
          workflowId: 'wf-current', workflowName: 'Current workflow', workflowVersion: '1',
          postconditions: [{ id: 'current-pc', type: 'fileExists', path: 'snapshot-ok.txt' }],
          verifierContract: null, capturedAt: ISO
        }
      }),
      runBase(104, 14, 'interrupted', { error: 'process restarted', replaySnapshotPath: 'replay-snapshots/run-104.json' })
    ]);

    [101, 102, 103, 104].forEach(id => {
      fs.writeFileSync(path.join(dataDir, 'replay-snapshots', `run-${id}.json`), JSON.stringify({
        runId: id, providerRequests: [], modelResponses: [], workspaceOperations: [], events: []
      }));
    });

    writeEvents(dataDir, [
      // Run 101: fully terminalized completed; ticket never finalized.
      { id: 'e101a', ts: ISO, type: 'run.created', ticketId: 11, runId: 101, payload: { status: 'pending' } },
      { id: 'e101b', ts: ISO, type: 'run.execution_completed', ticketId: 11, runId: 101, payload: { status: 'completed' } },
      { id: 'e101c', ts: ISO, type: 'run.snapshot_finalized', ticketId: 11, runId: 101, payload: { status: 'completed' } },
      { id: 'e101d', ts: ISO, type: 'run.terminalized', ticketId: 11, runId: 101, payload: { status: 'completed' } },
      // Run 102: fully terminalized failed; ticket never finalized.
      { id: 'e102a', ts: ISO, type: 'run.created', ticketId: 12, runId: 102, payload: { status: 'pending' } },
      { id: 'e102b', ts: ISO, type: 'run.execution_completed', ticketId: 12, runId: 102, payload: { status: 'failed', error: 'boom' } },
      { id: 'e102c', ts: ISO, type: 'run.snapshot_finalized', ticketId: 12, runId: 102, payload: { status: 'failed' } },
      { id: 'e102d', ts: ISO, type: 'run.terminalized', ticketId: 12, runId: 102, payload: { status: 'failed', error: 'boom' } },
      // Run 103: execution completed, not terminalized, current snapshot present.
      { id: 'e103a', ts: ISO, type: 'run.created', ticketId: 13, runId: 103, payload: { status: 'pending' } },
      { id: 'e103b', ts: ISO, type: 'run.execution_completed', ticketId: 13, runId: 103, payload: { status: 'completed' } },
      // Run 104: fully terminalized interrupted; ticket never finalized.
      { id: 'e104a', ts: ISO, type: 'run.created', ticketId: 14, runId: 104, payload: { status: 'pending' } },
      { id: 'e104b', ts: ISO, type: 'run.execution_completed', ticketId: 14, runId: 104, payload: { status: 'interrupted', error: 'process restarted' } },
      { id: 'e104c', ts: ISO, type: 'run.snapshot_finalized', ticketId: 14, runId: 104, payload: { status: 'interrupted' } },
      { id: 'e104d', ts: ISO, type: 'run.terminalized', ticketId: 14, runId: 104, payload: { status: 'interrupted', error: 'process restarted' } }
    ]);

    server = startServer(dataDir, workspaceRoot, port);
    await waitForReady(baseUrl, server);
    await sleep(300); // let startup reconciliation settle to disk

    const tickets = readJson(dataDir, 'tickets.json');
    const runs = readJson(dataDir, 'runs.json');
    const events = readEvents(dataDir);

    // Crash-window convergence — completed, failed, and interrupted terminal runs.
    const t11 = tickets.find(t => t.id === 11);
    const t12 = tickets.find(t => t.id === 12);
    const t14 = tickets.find(t => t.id === 14);
    assert(t11.status === 'completed', `stuck completed-run ticket should converge to completed, got ${t11.status}`);
    assert(t12.status === 'failed', `stuck failed-run ticket must converge to failed (never completed), got ${t12.status}`);
    // Interrupted runs revert the ticket to 'open' (existing interrupt lifecycle),
    // never to completed/failed. Convergence itself starts no run.
    assert(t14.status === 'open', `stuck interrupted-run ticket should converge to open, got ${t14.status}`);

    // No new runs / retries created
    assert(runs.length === 4, `startup convergence must not create new runs, got ${runs.length}`);
    assert(runs.find(r => r.id === 101).status === 'completed', 'run 101 should remain completed');
    assert(runs.find(r => r.id === 102).status === 'failed', 'run 102 should remain failed');
    assert(runs.find(r => r.id === 104).status === 'interrupted', 'run 104 should remain interrupted');

    // No duplicate terminalized events
    const t101 = events.filter(e => e.runId === 101 && e.type === 'run.terminalized');
    const t102 = events.filter(e => e.runId === 102 && e.type === 'run.terminalized');
    const t104 = events.filter(e => e.runId === 104 && e.type === 'run.terminalized');
    assert(t101.length === 1, `run 101 must have exactly one run.terminalized, got ${t101.length}`);
    assert(t102.length === 1, `run 102 must have exactly one run.terminalized, got ${t102.length}`);
    assert(t104.length === 1, `run 104 must have exactly one run.terminalized, got ${t104.length}`);

    // Verification always uses the immutable run snapshot.
    const checked103 = events.find(e => e.runId === 103 && e.type === 'run.postconditions_checked');
    assert(checked103, 'current run reconciliation should emit run.postconditions_checked');
    assert(checked103.payload.contractSource === 'run_snapshot',
      `run must label contractSource run_snapshot, got ${checked103.payload.contractSource}`);
    const passed103 = events.find(e => e.runId === 103 && e.type === 'run.verification_passed');
    assert(passed103 && passed103.payload.contractSource === 'run_snapshot',
      'run verification_passed should label run_snapshot');

    console.log('PASS: startup converges completed/failed/interrupted terminalized tickets and uses immutable verification snapshots');
  } finally {
    await stopServer(server);
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
}

// ── Phase 2: manual completion guard accept/reject matrix ─────────────────────
async function runManualGuardPhase() {
  const { dataDir, workspaceRoot } = makeDirs();
  const port = 3487;
  const baseUrl = 'http://127.0.0.1:' + port;
  let server = null;
  try {
    seedCommon(dataDir, workspaceRoot, {
      workflows: [{
        id: 'wf-req', name: 'Verification-required workflow', version: '1',
        inputSchema: {},
        actions: [{ id: 'done', action: 'stop', input: {} }],
        postconditions: [{ id: 'req-pc', type: 'fileExists', path: 'out.txt' }]
      }]
    });

    const reqSnapshot = {
      workflowId: 'wf-req', workflowName: 'Verification-required workflow', workflowVersion: '1',
      postconditions: [{ id: 'req-pc', type: 'fileExists', path: 'out.txt' }],
      verifierContract: null, capturedAt: ISO
    };
    const neutralEval = { effectiveness: { status: 'unknown' } };

    writeJson(dataDir, 'tickets.json', [
      ticketBase(1, 'in_progress'),                                   // no runs
      ticketBase(2, 'in_progress'),                                   // interrupted latest run
      ticketBase(3, 'in_progress'),                                   // failed latest run
      ticketBase(4, 'in_progress'),                                   // Option A: direct completed-unverified
      ticketBase(5, 'in_progress', {                                  // verification required, not passed
        executionMode: 'workflow', workflowId: 'wf-req',
        capabilityType: 'workflow', capabilityId: 'wf-req', workflowInput: {}
      }),
      ticketBase(6, 'in_progress')                                    // run-level triage required
    ]);

    writeJson(dataDir, 'runs.json', [
      runBase(2, 2, 'interrupted', { error: 'stopped', replaySnapshotPath: 'replay-snapshots/run-2.json' }),
      runBase(3, 3, 'failed', { error: 'crash', replaySnapshotPath: 'replay-snapshots/run-3.json' }),
      runBase(4, 4, 'completed', { runEvaluation: neutralEval, replaySnapshotPath: 'replay-snapshots/run-4.json' }),
      runBase(5, 5, 'completed', {
        executionMode: 'workflow', workflowId: 'wf-req',
        capabilityType: 'workflow', capabilityId: 'wf-req', workflowInput: {},
        verificationContractSnapshot: reqSnapshot, runEvaluation: neutralEval,
        replaySnapshotPath: 'replay-snapshots/run-5.json'
      }),
      runBase(6, 6, 'completed', {
        runEvaluation: neutralEval, replaySnapshotPath: 'replay-snapshots/run-6.json',
        triage: {
          required: true, reasonCode: 'runtime_failed', requiredDecision: 'review_failure',
          summary: 'needs review', allowedActions: ['review'], prohibitedActions: ['automatic_retry'],
          evidenceRefs: [], createdAt: ISO, resolvedAt: null, resolvedBy: null, resolution: null
        }
      })
    ]);

    [2, 3, 4, 5, 6].forEach(id => {
      fs.writeFileSync(path.join(dataDir, 'replay-snapshots', `run-${id}.json`), JSON.stringify({
        runId: id, providerRequests: [], modelResponses: [], workspaceOperations: [], events: []
      }));
    });

    // No events seeded: these runs are already in their terminal run.status and
    // must remain unfinalized at the ticket level so the manual PATCH exercises
    // the guard. Without run.terminalized events the startup pass correctly skips
    // them (it only heals genuinely terminalized runs), leaving tickets in_progress.
    fs.writeFileSync(path.join(dataDir, 'events.jsonl'), '');

    server = startServer(dataDir, workspaceRoot, port);
    await waitForReady(baseUrl, server);
    const cookie = await login(baseUrl);

    async function complete(ticketId) {
      return request(baseUrl, 'PATCH', `/api/tickets/${ticketId}/status`, { cookie, json: { status: 'completed' } });
    }
    function reason(res) { try { return JSON.parse(res.body).error || ''; } catch (_) { return ''; } }

    // 1. No runs → reject
    const r1 = await complete(1);
    assert(r1.statusCode === 409, `no-run ticket must reject, got HTTP ${r1.statusCode}`);
    assert(reason(r1).includes('without supporting runtime evidence'), `no-run rejection reason wrong: ${reason(r1)}`);

    // 2. Interrupted latest run → reject
    const r2 = await complete(2);
    assert(r2.statusCode === 409, `interrupted-run ticket must reject, got HTTP ${r2.statusCode}`);
    assert(reason(r2).includes('latest run is interrupted'), `interrupted rejection reason wrong: ${reason(r2)}`);

    // 3. Failed latest run → reject
    const r3 = await complete(3);
    assert(r3.statusCode === 409, `failed-run ticket must reject, got HTTP ${r3.statusCode}`);
    assert(reason(r3).includes('latest run is failed'), `failed rejection reason wrong: ${reason(r3)}`);

    // 4. Option A: postcondition-free direct completed-but-unverified → accept
    const r4 = await complete(4);
    assert(r4.statusCode === 200, `Option A direct completed-unverified ticket must accept, got HTTP ${r4.statusCode}: ${reason(r4)}`);
    assert(readJson(dataDir, 'tickets.json').find(t => t.id === 4).status === 'completed', 'ticket 4 should be completed after accept');

    // 5. Verification required but not passed → reject
    const r5 = await complete(5);
    assert(r5.statusCode === 409, `verification-required-not-passed ticket must reject, got HTTP ${r5.statusCode}`);
    assert(reason(r5).includes('no verified objective-success evidence'), `verification-required rejection reason wrong: ${reason(r5)}`);

    // 6. Run-level triage required → reject
    const r6 = await complete(6);
    assert(r6.statusCode === 409, `triage-required ticket must reject, got HTTP ${r6.statusCode}`);
    assert(reason(r6).includes('requires triage'), `triage rejection reason wrong: ${reason(r6)}`);

    console.log('PASS: manual completion guard accepts Option A unverified and rejects all unsafe states');
  } finally {
    await stopServer(server);
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
}

async function main() {
  await runReconcilePhase();
  await runManualGuardPhase();
  console.log('PASS: state-agreement and completion-semantics hardening');
}

main().catch(error => {
  console.error(error.stack || error.message);
  process.exit(1);
});

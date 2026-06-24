#!/usr/bin/env node
// Attempt accounting / usage visibility — measurement only.
//
// Proves attempt numbers, attempt counts, and per-run usage are derived and
// surfaced truthfully, that a manual rerun produces attempt 2 (not a retry
// policy), that nothing here auto-creates runs, and that unobservable metrics
// render as "unavailable" rather than fabricated. No budgets are enforced.

const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const ADMIN_HASH = '$argon2id$v=19$m=65536,t=3,p=4$az+Aa/Vt5AjalPiSGPNdXQ$i+hlbZS1OGPnBIw16HfGY/u0A4VUqXdFkd5Y+JtXh/g';
const ISO_START = '2026-02-01T00:00:00.000Z';
const ISO_END = '2026-02-01T00:00:01.234Z';
const PORT = '3489';
const BASE_URL = 'http://127.0.0.1:' + PORT;

let server = null;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

function request(method, urlPath, options = {}) {
  const body = options.form
    ? new URLSearchParams(options.form).toString()
    : options.json ? JSON.stringify(options.json) : null;
  return new Promise((resolve, reject) => {
    const req = http.request(BASE_URL + urlPath, {
      method,
      headers: {
        ...(options.form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
        ...(options.json ? { 'Content-Type': 'application/json' } : {}),
        ...(body ? { 'Content-Length': Buffer.byteLength(body) } : {}),
        ...(options.cookie ? { Cookie: options.cookie } : {})
      }
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ statusCode: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}
function cookieFrom(res) { return (res.headers['set-cookie'] || []).map(c => c.split(';')[0]).join('; '); }

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'attempt-usage-data-'));
const WORKSPACE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'attempt-usage-ws-'));
function writeJson(file, value) { fs.writeFileSync(path.join(DATA_DIR, file), JSON.stringify(value, null, 2)); }
function readJsonData(file) { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, file), 'utf8')); }

function ticket(id, status, extra = {}) {
  return {
    id, objective: `Attempt usage ticket #${id}`,
    assignmentTargetType: 'agent', assignmentTargetId: 1, assignmentMode: 'individual',
    ownedOutputPaths: null, executionMode: 'agent', workflowId: null, workflowInput: null,
    capabilityType: 'directAction', capabilityId: 'agent-selected-actions', capabilityInput: null,
    status, createdBy: 'admin', changedBy: 'admin', changedAt: ISO_START,
    createdAt: ISO_START, updatedAt: ISO_START, ...extra
  };
}
function run(id, ticketId, status, extra = {}) {
  return {
    id, ticketId, agentId: 1, agentName: 'Usage Agent',
    workspaceRoot: WORKSPACE_ROOT, mainWorkspaceRoot: WORKSPACE_ROOT, executionWorkspaceType: 'main',
    allocationPlanId: null, allocationItemId: null, ownedOutputPaths: [],
    executionMode: 'agent', workflowId: null, workflowInput: null,
    capabilityType: 'directAction', capabilityId: 'agent-selected-actions', capabilityInput: null,
    executionPolicySnapshot: { requireVerification: 'when_declared' },
    currentPhase: 'terminalization', leaseOwner: null, leaseExpiresAt: null,
    currentStepId: null, currentWorkflowAction: null, lastHeartbeatAt: null,
    status, createdAt: ISO_START, updatedAt: ISO_END, startedAt: ISO_START,
    completedAt: ['completed', 'failed', 'interrupted'].includes(status) ? ISO_END : undefined,
    ...extra
  };
}
const evalWith = (over = {}) => ({
  effectiveness: { status: 'unknown', postconditionsPassed: 0, postconditionsFailed: 0, errors: [] },
  efficiency: { durationMs: 1234, workflowSteps: 0, providerRequests: 2, modelResponses: 2, workspaceOperations: 3, mutationCount: 1, retryCount: 0 },
  violations: { status: 'unknown', items: [] }, effectiveRuntimeConfig: null, ...over
});
const wfSnapshot = {
  workflowId: 'wf-v', workflowName: 'Verified workflow', workflowVersion: '1',
  postconditions: [{ id: 'pc', type: 'fileExists', path: 'out.txt' }], verifierContract: null, capturedAt: ISO_START
};

function seed() {
  fs.mkdirSync(path.join(DATA_DIR, 'replay-snapshots'), { recursive: true });
  writeJson('users.json', [{ id: 1, username: 'admin', passwordHash: ADMIN_HASH, createdAt: ISO_START, type: 'user' }]);
  writeJson('permissions.json', ['ticket:create', 'ticket:read', 'ticket:update']);
  writeJson('groups.json', [{ id: 1, name: 'Admins', permissions: ['ticket:create', 'ticket:read', 'ticket:update'], canReceiveTickets: false }]);
  writeJson('memberships.json', [{ id: 1, principalType: 'user', principalId: 1, groupId: 1 }]);
  writeJson('agents.json', [{ id: 1, name: 'Usage Agent', type: 'agent', provider: 'openai', model: 'gpt-test', apiKey: 'k', createdAt: ISO_START, updatedAt: ISO_START }]);
  writeJson('workflows.json', [{ id: 'wf-v', name: 'Verified workflow', version: '1', inputSchema: {}, actions: [{ id: 'done', action: 'stop', input: {} }], postconditions: [{ id: 'pc', type: 'fileExists', path: 'out.txt' }] }]);
  writeJson('allocation-plans.json', []);
  writeJson('operation-history.json', []);
  writeJson('logs.json', []);

  // Ticket 10: completed verified workflow run (attempt 1, real metrics) — also reran below.
  // Ticket 11: failed run. Ticket 12: interrupted run.
  writeJson('tickets.json', [
    // maxAttempts 2 so the manual rerun below is permitted (1 run + 1 rerun);
    // maxAttempts is now enforced for manual rerun-from-start.
    ticket(10, 'completed', { executionMode: 'workflow', workflowId: 'wf-v', capabilityType: 'workflow', capabilityId: 'wf-v', workflowInput: {}, executionPolicy: { maxAttempts: 2 } }),
    ticket(11, 'failed'),
    ticket(12, 'in_progress')
  ]);
  writeJson('runs.json', [
    run(100, 10, 'completed', {
      executionMode: 'workflow', workflowId: 'wf-v', capabilityType: 'workflow', capabilityId: 'wf-v', workflowInput: {},
      verificationContractSnapshot: wfSnapshot, runEvaluation: evalWith({ effectiveness: { status: 'passed', postconditionsPassed: 1, postconditionsFailed: 0, errors: [] } }),
      replaySnapshotPath: 'replay-snapshots/run-100.json'
    }),
    run(110, 11, 'failed', { error: 'boom', runEvaluation: evalWith(), replaySnapshotPath: 'replay-snapshots/run-110.json' }),
    run(120, 12, 'interrupted', { error: 'stopped', runEvaluation: evalWith(), replaySnapshotPath: 'replay-snapshots/run-120.json' })
  ]);
  [100, 110, 120].forEach(id => fs.writeFileSync(path.join(DATA_DIR, 'replay-snapshots', `run-${id}.json`), JSON.stringify({ runId: id, providerRequests: [], modelResponses: [], workspaceOperations: [], events: [] })));
  fs.writeFileSync(path.join(DATA_DIR, 'events.jsonl'), [
    { id: 'v100', ts: ISO_END, type: 'run.verification_passed', ticketId: 10, runId: 100, payload: { status: 'passed' } }
  ].map(e => JSON.stringify(e)).join('\n') + '\n');
}

function waitForReady(timeoutMs = 12000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const poll = () => {
      if (server.exitCode !== null) return reject(new Error('Server exited early'));
      http.get(BASE_URL + '/api/health', res => { res.resume(); res.statusCode === 200 ? resolve() : (Date.now() > deadline ? reject(new Error('timeout')) : setTimeout(poll, 200)); })
        .on('error', () => Date.now() > deadline ? reject(new Error('timeout')) : setTimeout(poll, 200));
    };
    setTimeout(poll, 400);
  });
}

async function login() {
  const res = await request('POST', '/login', { form: { username: 'admin', password: 'admin123' } });
  assert(res.statusCode === 302, 'login failed HTTP ' + res.statusCode);
  return cookieFrom(res);
}

// Run-state API: GET /api/runs/:id/state → serializeRunRuntimeState (incl. attemptUsage).
async function getRunState(id, cookie) {
  const res = await request('GET', `/api/runs/${id}/state`, { cookie });
  assert(res.statusCode === 200, `/api/runs/${id}/state HTTP ${res.statusCode}`);
  return JSON.parse(res.body);
}

async function main() {
  seed();
  server = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    // High scheduler interval keeps the reran pending run from executing, so the
    // "attempt 2 + unavailable metrics" assertions stay deterministic.
    env: { ...process.env, NODE_ENV: 'test', PORT, DATA_DIR, WORKSPACE_ROOT, RUNTIME_SCHEDULER_INTERVAL_MS: '3600000' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let out = '';
  server.stdout.on('data', c => { out += String(c); });
  server.stderr.on('data', c => { out += String(c); });

  try {
    await waitForReady();
    const cookie = await login();

    // 1 + 4: first/only run is attempt 1, run detail shows attempt number + real usage.
    const run100Page = await request('GET', '/runs/100', { cookie });
    assert(run100Page.statusCode === 200, 'run 100 page HTTP ' + run100Page.statusCode);
    assert(run100Page.body.includes('Usage / Attempt'), 'run detail should show Usage / Attempt section');
    assert(run100Page.body.includes('attempt 1 of 1'), 'run 100 should be attempt 1 of 1');
    assert(/Model requests<\/dt><dd>2</.test(run100Page.body), 'run 100 should show derived model request count 2');
    assert(/Mutating workspace operations<\/dt><dd>1</.test(run100Page.body), 'run 100 should show mutating op count 1');
    assert(run100Page.body.includes('required · passed'), 'run 100 verification should show required · passed');

    // 3: ticket detail shows total attempts (1 so far).
    const ticket10Page = await request('GET', '/tickets/10', { cookie });
    assert(ticket10Page.statusCode === 200, 'ticket 10 page HTTP ' + ticket10Page.statusCode);
    assert(ticket10Page.body.includes('Execution Attempts (1)'), 'ticket 10 should show Execution Attempts (1)');
    assert(ticket10Page.body.includes('Run #100'), 'ticket 10 attempts table should list run 100');

    // 6: failed and interrupted runs are counted consistently as attempt 1 with their outcome.
    const ticket11Page = await request('GET', '/tickets/11', { cookie });
    assert(ticket11Page.body.includes('Execution Attempts (1)'), 'failed-run ticket should show Execution Attempts (1)');
    const run120Page = await request('GET', '/runs/120', { cookie });
    assert(run120Page.body.includes('attempt 1 of 1'), 'interrupted run should be attempt 1 of 1');
    assert(run120Page.body.includes('<code>interrupted</code>'), 'interrupted run should show interrupted outcome');

    // API coverage: /api/runs/:id/state exposes attemptUsage truthfully.
    // Completed verified workflow run → attempt 1 of 1, observable counts, verified.
    const state100 = await getRunState(100, cookie);
    assert(state100.attemptUsage, 'run-state API should expose attemptUsage');
    const u100 = state100.attemptUsage;
    assert(u100.attemptNumber === 1, `API attemptNumber should be 1, got ${u100.attemptNumber}`);
    assert(u100.attemptCount === 1, `API attemptCount should match ticket run count (1), got ${u100.attemptCount}`);
    assert(u100.outcome === 'completed', `API outcome should be completed, got ${u100.outcome}`);
    assert(u100.modelRequestCount === 2, `API modelRequestCount should be observable (2), got ${u100.modelRequestCount}`);
    assert(u100.workspaceOperationCount === 3, `API workspaceOperationCount should be observable (3), got ${u100.workspaceOperationCount}`);
    assert(u100.mutatingWorkspaceOperationCount === 1, `API mutatingWorkspaceOperationCount should be observable (1), got ${u100.mutatingWorkspaceOperationCount}`);
    assert(u100.durationMs === 1234, `API durationMs should be observable (1234), got ${u100.durationMs}`);
    assert(u100.verificationRequired === true, 'API run 100 verificationRequired should be true');
    assert(u100.verificationOutcome === 'passed', `API run 100 verificationOutcome should be passed, got ${u100.verificationOutcome}`);

    // Failed direct run → terminal observable counts, verification not_required (truthful).
    const state110 = await getRunState(110, cookie);
    const u110 = state110.attemptUsage;
    assert(u110 && u110.attemptNumber === 1 && u110.attemptCount === 1, 'API failed run should be attempt 1 of 1');
    assert(u110.outcome === 'failed', `API failed run outcome should be failed, got ${u110.outcome}`);
    assert(u110.modelRequestCount === 2, 'API failed (terminal) run should report observable counts');
    assert(u110.verificationRequired === false && u110.verificationOutcome === 'not_required',
      `API direct run should report verification not_required, got required=${u110.verificationRequired} outcome=${u110.verificationOutcome}`);

    // 5 + 7: viewing/measuring (pages AND API) created no runs and changed no statuses.
    const runsBefore = readJsonData('runs.json');
    assert(runsBefore.length === 3, 'measurement views/API must not create runs, got ' + runsBefore.length);
    assert(runsBefore.find(r => r.id === 100).status === 'completed', 'run 100 must remain completed (measurement does not alter semantics)');

    // 2: a manual rerun creates attempt 2 (one new run), not a retry policy cascade.
    const rerun = await request('POST', '/api/tickets/10/rerun', { cookie, json: { mode: 'retry' } });
    assert(rerun.statusCode === 200, 'manual rerun HTTP ' + rerun.statusCode + ': ' + rerun.body);
    const runsAfterRerun = readJsonData('runs.json').filter(r => r.ticketId === 10).sort((a, b) => a.id - b.id);
    assert(runsAfterRerun.length === 2, `manual rerun should create exactly one new attempt, got ${runsAfterRerun.length} runs for ticket 10`);
    const newRun = runsAfterRerun[1];
    assert(newRun.id !== 100, 'rerun should create a new run id');

    const ticket10AfterRerun = await request('GET', '/tickets/10', { cookie });
    assert(ticket10AfterRerun.body.includes('Execution Attempts (2)'), 'ticket 10 should show Execution Attempts (2) after rerun');

    // 8: the new pending attempt has no observable usage yet → shown as unavailable, not fabricated.
    const newRunPage = await request('GET', `/runs/${newRun.id}`, { cookie });
    assert(newRunPage.body.includes(`attempt 2 of 2`), 'new run should be attempt 2 of 2');
    assert(/Model requests<\/dt><dd>unavailable</.test(newRunPage.body), 'pending attempt should show model requests as unavailable');
    assert(/Duration<\/dt><dd>unavailable</.test(newRunPage.body), 'pending attempt should show duration as unavailable');

    // API coverage: non-terminal (pending) run reports null usage counts, not fabricated.
    const stateNew = await getRunState(newRun.id, cookie);
    const uNew = stateNew.attemptUsage;
    assert(uNew, 'API should expose attemptUsage for the pending rerun');
    assert(uNew.attemptNumber === 2, `API pending run attemptNumber should be 2, got ${uNew.attemptNumber}`);
    assert(uNew.attemptCount === 2, `API pending run attemptCount should be 2, got ${uNew.attemptCount}`);
    assert(uNew.modelRequestCount === null, `API pending run modelRequestCount should be null, got ${uNew.modelRequestCount}`);
    assert(uNew.workspaceOperationCount === null, `API pending run workspaceOperationCount should be null, got ${uNew.workspaceOperationCount}`);
    assert(uNew.mutatingWorkspaceOperationCount === null, `API pending run mutatingWorkspaceOperationCount should be null, got ${uNew.mutatingWorkspaceOperationCount}`);
    assert(uNew.durationMs === null, `API pending run durationMs should be null, got ${uNew.durationMs}`);

    // 7: no automatic rerun — count stays at 2 after a wait (scheduler is parked).
    await sleep(800);
    const runsLater = readJsonData('runs.json').filter(r => r.ticketId === 10);
    assert(runsLater.length === 2, `no automatic rerun should occur, got ${runsLater.length} runs for ticket 10`);

    console.log('PASS: attempt accounting and usage visibility are derived and truthful (measurement only)');
  } catch (error) {
    if (out) process.stderr.write(out);
    throw error;
  } finally {
    if (server) {
      server.kill('SIGTERM');
      await sleep(400);
      if (server.exitCode === null) server.kill('SIGKILL');
    }
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
    fs.rmSync(WORKSPACE_ROOT, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error.stack || error.message); process.exit(1); });

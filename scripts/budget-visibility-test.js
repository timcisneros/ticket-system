#!/usr/bin/env node
// Advisory budget threshold visibility. Compares recorded run usage against the
// run's recorded executionPolicySnapshot thresholds. ADVISORY ONLY — never blocks,
// stops, fails, or reruns anything. Derived from existing usage metrics.

const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const ADMIN_HASH = '$argon2id$v=19$m=65536,t=3,p=4$az+Aa/Vt5AjalPiSGPNdXQ$i+hlbZS1OGPnBIw16HfGY/u0A4VUqXdFkd5Y+JtXh/g';
const T0 = '2026-02-01T00:00:00.000Z';
const T2 = '2026-02-01T00:00:02.000Z'; // 2000ms after T0
const PORT = '3493';
const BASE_URL = 'http://127.0.0.1:' + PORT;

let server = null;
function assert(c, m) { if (!c) throw new Error(m); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function request(method, urlPath, options = {}) {
  const body = options.form ? new URLSearchParams(options.form).toString() : options.json !== undefined ? JSON.stringify(options.json) : null;
  return new Promise((resolve, reject) => {
    const req = http.request(BASE_URL + urlPath, {
      method,
      headers: {
        ...(options.form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
        ...(options.json !== undefined ? { 'Content-Type': 'application/json' } : {}),
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

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'budget-vis-data-'));
const WORKSPACE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'budget-vis-ws-'));
function writeJson(file, value) { fs.writeFileSync(path.join(DATA_DIR, file), JSON.stringify(value, null, 2)); }
function readJsonData(file) { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, file), 'utf8')); }
function runsForTicket(id) { return readJsonData('runs.json').filter(r => r.ticketId === id); }

function ticket(id, maxAttempts) {
  return {
    id, objective: `Budget ticket #${id}`,
    assignmentTargetType: 'agent', assignmentTargetId: 1, assignmentMode: 'individual',
    ownedOutputPaths: null, executionMode: 'agent', workflowId: null, workflowInput: null,
    capabilityType: 'directAction', capabilityId: 'agent-selected-actions', capabilityInput: null,
    executionPolicy: { maxAttempts }, status: 'completed',
    createdBy: 'admin', changedBy: 'admin', changedAt: T0, createdAt: T0, updatedAt: T0
  };
}
function run(id, ticketId, status, snapshot, efficiency, completedAt) {
  const r = {
    id, ticketId, agentId: 1, agentName: 'Budget Agent',
    workspaceRoot: WORKSPACE_ROOT, mainWorkspaceRoot: WORKSPACE_ROOT, executionWorkspaceType: 'main',
    allocationPlanId: null, allocationItemId: null, ownedOutputPaths: [],
    executionMode: 'agent', workflowId: null, workflowInput: null,
    capabilityType: 'directAction', capabilityId: 'agent-selected-actions', capabilityInput: null,
    executionPolicySnapshot: snapshot,
    currentPhase: 'terminalization', leaseOwner: null, leaseExpiresAt: null,
    currentStepId: null, currentWorkflowAction: null, lastHeartbeatAt: null,
    status, createdAt: T0, updatedAt: T0, startedAt: T0
  };
  if (completedAt) r.completedAt = completedAt;
  if (efficiency) r.runEvaluation = { effectiveness: { status: 'unknown' }, efficiency, violations: { status: 'unknown', items: [] }, effectiveRuntimeConfig: null };
  return r;
}
const eff = (providerRequests, workspaceOperations) => ({ durationMs: 100, workflowSteps: 0, providerRequests, modelResponses: providerRequests, workspaceOperations, mutationCount: 1, retryCount: 0 });
const THRESH = { requireVerification: 'when_declared', maxRuntimeMs: 1000, maxModelRequests: 10, maxWorkspaceOperations: 3 };
const NO_THRESH = { requireVerification: 'when_declared' };

function seed() {
  fs.mkdirSync(path.join(DATA_DIR, 'replay-snapshots'), { recursive: true });
  writeJson('users.json', [{ id: 1, username: 'admin', passwordHash: ADMIN_HASH, createdAt: T0, type: 'user' }]);
  writeJson('permissions.json', ['ticket:create', 'ticket:read', 'ticket:update']);
  writeJson('groups.json', [{ id: 1, name: 'Admins', permissions: ['ticket:create', 'ticket:read', 'ticket:update'], canReceiveTickets: false }]);
  writeJson('memberships.json', [{ id: 1, principalType: 'user', principalId: 1, groupId: 1 }]);
  writeJson('agents.json', [{ id: 1, name: 'Budget Agent', type: 'agent', provider: 'openai', model: 'gpt-test', apiKey: 'k', createdAt: T0, updatedAt: T0 }]);
  writeJson('workflows.json', []);
  writeJson('allocation-plans.json', []);
  writeJson('operation-history.json', []);
  writeJson('logs.json', []);
  writeJson('tickets.json', [ticket(1, null), ticket(2, null), ticket(3, null), ticket(4, null), ticket(5, null), ticket(6, 1)]);
  writeJson('runs.json', [
    run(10, 1, 'completed', { ...NO_THRESH }, eff(5, 2), T0),         // no thresholds → not_configured
    // Completed but no completedAt + zero recorded duration → runtime usage is
    // not observable → unavailable (terminal so startup does not interrupt it).
    run(20, 2, 'completed', { ...THRESH }, { durationMs: 0, workflowSteps: 0, providerRequests: 0, modelResponses: 0, workspaceOperations: 0, mutationCount: 0, retryCount: 0 }, null),
    run(30, 3, 'completed', { ...THRESH }, eff(5, 2), T0),            // below → within
    run(40, 4, 'completed', { ...THRESH }, eff(10, 2), T0),           // equal → within
    run(50, 5, 'completed', { ...THRESH }, eff(12, 5), T2),           // above (12>10, 5>3, 2000ms>1000) → exceeded
    run(60, 6, 'completed', { ...NO_THRESH }, eff(1, 1), T0)          // for maxAttempts unchanged check
  ]);
  fs.writeFileSync(path.join(DATA_DIR, 'events.jsonl'), '');
}

function waitForReady(timeoutMs = 12000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const poll = () => {
      if (server.exitCode !== null) return reject(new Error('server exited early'));
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
async function budget(runId, cookie) {
  const res = await request('GET', `/api/runs/${runId}/state`, { cookie });
  assert(res.statusCode === 200, `/api/runs/${runId}/state HTTP ${res.statusCode}`);
  return JSON.parse(res.body).budgetStatus;
}

async function main() {
  seed();
  server = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, NODE_ENV: 'test', PORT, DATA_DIR, WORKSPACE_ROOT, RUNTIME_SCHEDULER_INTERVAL_MS: '3600000' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let out = '';
  server.stdout.on('data', c => { out += String(c); });
  server.stderr.on('data', c => { out += String(c); });

  try {
    await waitForReady();
    const cookie = await login();

    // 10 (API): advisory present and marked advisory.
    const b50 = await budget(50, cookie);
    assert(b50 && b50.advisory === true, 'budgetStatus should be present and advisory');

    // 1: null thresholds → not_configured (and no usage fabrication).
    const b10 = await budget(10, cookie);
    assert(b10.modelRequests.status === 'not_configured', `null threshold → not_configured, got ${b10.modelRequests.status}`);
    assert(b10.runtimeMs.status === 'not_configured' && b10.workspaceOperations.status === 'not_configured', 'all null thresholds → not_configured');

    // 2: usage unavailable (runtime not observable) → unavailable, NOT exceeded.
    const b20 = await budget(20, cookie);
    assert(b20.runtimeMs.status === 'unavailable', `unavailable usage → unavailable, got ${b20.runtimeMs.status}`);
    assert(b20.runtimeMs.usage === null, 'unavailable usage must not be fabricated');

    // 3: below threshold → within_threshold.
    assert((await budget(30, cookie)).modelRequests.status === 'within_threshold', 'usage below threshold → within_threshold');

    // 4: equal to threshold → within_threshold.
    const b40 = await budget(40, cookie);
    assert(b40.modelRequests.status === 'within_threshold', `usage equal to threshold → within_threshold, got ${b40.modelRequests.status}`);
    assert(b40.modelRequests.usage === 10 && b40.modelRequests.threshold === 10, 'equal case values should be truthful');

    // 5 + 10: above threshold → exceeded (all three metrics), truthful values.
    assert(b50.modelRequests.status === 'exceeded' && b50.modelRequests.usage === 12 && b50.modelRequests.threshold === 10, 'model requests over threshold → exceeded');
    assert(b50.workspaceOperations.status === 'exceeded', 'workspace operations over threshold → exceeded');
    assert(b50.runtimeMs.status === 'exceeded' && b50.runtimeMs.usage === 2000, 'runtime over threshold → exceeded');

    // 9: run detail renders advisory budget truthfully.
    const page50 = await request('GET', '/runs/50', { cookie });
    assert(page50.statusCode === 200, 'run 50 page HTTP ' + page50.statusCode);
    assert(page50.body.includes('Budget (advisory)'), 'run detail should show Budget (advisory) section');
    assert(page50.body.includes('Advisory only — no execution is blocked'), 'run detail should state advisory only');
    assert(page50.body.includes('exceeded (advisory)'), 'run detail should render an exceeded advisory');

    // 6 + 7: exceeded advisory changed no run or ticket status; created no run.
    const runsCountBefore = readJsonData('runs.json').length;
    assert(readJsonData('runs.json').find(r => r.id === 50).status === 'completed', 'exceeded advisory must not change run status');
    assert(readJsonData('tickets.json').find(t => t.id === 5).status === 'completed', 'exceeded advisory must not change ticket status');
    assert(runsCountBefore === 6, 'viewing budget must not create runs');

    // 8: exceeded advisory does not block manual rerun (ticket 5 has unlimited maxAttempts).
    const rerun5 = await request('POST', '/api/tickets/5/rerun', { cookie, json: { mode: 'retry' } });
    assert(rerun5.statusCode === 200, `exceeded advisory must not block rerun, got HTTP ${rerun5.statusCode}: ${rerun5.body}`);

    // 11: existing maxAttempts behavior unchanged (ticket 6: maxAttempts 1, 1 run → blocked).
    const rerun6 = await request('POST', '/api/tickets/6/rerun', { cookie, json: { mode: 'retry' } });
    assert(rerun6.statusCode === 409, `maxAttempts ceiling must still block, got HTTP ${rerun6.statusCode}`);

    console.log('PASS: advisory budget thresholds are derived, truthful, and block nothing');
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

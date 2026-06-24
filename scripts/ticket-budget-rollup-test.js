#!/usr/bin/env node
// Ticket-level advisory budget rollup. Summarizes run-level budgetStatus across a
// ticket's runs, using each run's own executionPolicySnapshot. Advisory ONLY —
// never blocks, stops, fails, or reruns anything.

const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const ADMIN_HASH = '$argon2id$v=19$m=65536,t=3,p=4$az+Aa/Vt5AjalPiSGPNdXQ$i+hlbZS1OGPnBIw16HfGY/u0A4VUqXdFkd5Y+JtXh/g';
const T0 = '2026-02-01T00:00:00.000Z';
const THALF = '2026-02-01T00:00:00.500Z'; // 500ms after T0
const PORT = '3494';
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

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ticket-budget-data-'));
const WORKSPACE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'ticket-budget-ws-'));
function writeJson(file, value) { fs.writeFileSync(path.join(DATA_DIR, file), JSON.stringify(value, null, 2)); }
function readJsonData(file) { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, file), 'utf8')); }
function runsForTicket(id) { return readJsonData('runs.json').filter(r => r.ticketId === id); }

function ticket(id, executionPolicy) {
  return {
    id, objective: `Ticket budget #${id}`,
    assignmentTargetType: 'agent', assignmentTargetId: 1, assignmentMode: 'individual',
    ownedOutputPaths: null, executionMode: 'agent', workflowId: null, workflowInput: null,
    capabilityType: 'directAction', capabilityId: 'agent-selected-actions', capabilityInput: null,
    executionPolicy, status: 'completed',
    createdBy: 'admin', changedBy: 'admin', changedAt: T0, createdAt: T0, updatedAt: T0
  };
}
function run(id, ticketId, snapshot, efficiency, completedAt) {
  const r = {
    id, ticketId, agentId: 1, agentName: 'Rollup Agent',
    workspaceRoot: WORKSPACE_ROOT, mainWorkspaceRoot: WORKSPACE_ROOT, executionWorkspaceType: 'main',
    allocationPlanId: null, allocationItemId: null, ownedOutputPaths: [],
    executionMode: 'agent', workflowId: null, workflowInput: null,
    capabilityType: 'directAction', capabilityId: 'agent-selected-actions', capabilityInput: null,
    executionPolicySnapshot: snapshot,
    currentPhase: 'terminalization', leaseOwner: null, leaseExpiresAt: null,
    currentStepId: null, currentWorkflowAction: null, lastHeartbeatAt: null,
    status: 'completed', createdAt: T0, updatedAt: T0, startedAt: T0,
    runEvaluation: { effectiveness: { status: 'unknown' }, efficiency, violations: { status: 'unknown', items: [] }, effectiveRuntimeConfig: null }
  };
  if (completedAt) r.completedAt = completedAt;
  return r;
}
const eff = (providerRequests, workspaceOperations, durationMs) => ({ durationMs: durationMs || 0, workflowSteps: 0, providerRequests, modelResponses: providerRequests, workspaceOperations, mutationCount: 1, retryCount: 0 });
const THRESH = { requireVerification: 'when_declared', maxRuntimeMs: 1000, maxModelRequests: 10, maxWorkspaceOperations: 3 };
const NO_THRESH = { requireVerification: 'when_declared' };

function seed() {
  fs.mkdirSync(path.join(DATA_DIR, 'replay-snapshots'), { recursive: true });
  writeJson('users.json', [{ id: 1, username: 'admin', passwordHash: ADMIN_HASH, createdAt: T0, type: 'user' }]);
  writeJson('permissions.json', ['ticket:create', 'ticket:read', 'ticket:update']);
  writeJson('groups.json', [{ id: 1, name: 'Admins', permissions: ['ticket:create', 'ticket:read', 'ticket:update'], canReceiveTickets: false }]);
  writeJson('memberships.json', [{ id: 1, principalType: 'user', principalId: 1, groupId: 1 }]);
  writeJson('agents.json', [{ id: 1, name: 'Rollup Agent', type: 'agent', provider: 'openai', model: 'gpt-test', apiKey: 'k', createdAt: T0, updatedAt: T0 }]);
  writeJson('workflows.json', []);
  writeJson('allocation-plans.json', []);
  writeJson('operation-history.json', []);
  writeJson('logs.json', []);
  writeJson('tickets.json', [
    ticket(1, { maxAttempts: null }),                                  // no runs
    ticket(2, { maxAttempts: null }),                                  // null thresholds → not_configured
    ticket(3, { maxAttempts: null }),                                  // one exceeded → exceeded
    ticket(4, { maxAttempts: null }),                                  // configured + unavailable → unavailable
    ticket(5, { maxAttempts: null }),                                  // all within/equal → within
    ticket(6, { maxAttempts: null }),                                  // current policy unset, snapshot exceeded
    ticket(7, { maxAttempts: 1 })                                      // maxAttempts unchanged check
  ]);
  writeJson('runs.json', [
    // ticket 2: null thresholds
    run(20, 2, { ...NO_THRESH }, eff(5, 2), T0),
    run(21, 2, { ...NO_THRESH }, eff(9, 1), T0),
    // ticket 3: one within, one exceeded (12 > 10 model requests)
    run(30, 3, { ...THRESH }, eff(5, 2), T0),
    run(31, 3, { ...THRESH }, eff(12, 2), T0),
    // ticket 4: configured, runtime usage unavailable (no completedAt, durationMs 0), others within
    run(40, 4, { ...THRESH }, eff(5, 2, 0), null),
    // ticket 5: all within / equal (model 10==10, ws 3==3, runtime 500<1000)
    run(50, 5, { ...THRESH }, eff(10, 3, 0), THALF),
    // ticket 6: snapshot has threshold and is exceeded; current ticket policy has none
    run(60, 6, { requireVerification: 'when_declared', maxModelRequests: 10 }, eff(12, 2), T0),
    // ticket 7: maxAttempts 1, one run
    run(70, 7, { ...NO_THRESH }, eff(1, 1), T0)
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
async function page(id, cookie) {
  const res = await request('GET', `/tickets/${id}`, { cookie });
  assert(res.statusCode === 200, `/tickets/${id} HTTP ${res.statusCode}`);
  return res.body;
}
const overall = label => `<dt>Overall</dt><dd>${label}</dd>`;

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

    // 1: no runs → no Budget Advisory section / no misleading summary.
    const p1 = await page(1, cookie);
    assert(!p1.includes('Budget Advisory'), 'ticket with no runs must not render a budget advisory');

    // 2: all null thresholds → not_configured.
    const p2 = await page(2, cookie);
    assert(p2.includes('Budget Advisory'), 'ticket with runs should render Budget Advisory');
    assert(p2.includes(overall('not configured')), 'null thresholds → overall not configured');

    // 3 + 9: one exceeded run → exceeded; advisory wording present.
    const p3 = await page(3, cookie);
    assert(p3.includes(overall('exceeded (advisory)')), 'one exceeded run → overall exceeded');
    assert(p3.includes('Advisory only — no execution is blocked'), 'ticket detail should state advisory only');
    assert(p3.includes('1 exceeded'), 'rollup should count one exceeded run');

    // 4: configured threshold + unavailable usage → unavailable, not exceeded.
    const p4 = await page(4, cookie);
    assert(p4.includes(overall('unavailable')), 'configured + unavailable usage → overall unavailable');
    assert(!p4.includes(overall('exceeded (advisory)')), 'unavailable must not become exceeded');

    // 5: all observable usage within/equal → within_threshold.
    const p5 = await page(5, cookie);
    assert(p5.includes(overall('within limit')), 'all within/equal → overall within limit');

    // 6: rollup uses each run's snapshot, not the current (empty) ticket policy.
    const p6 = await page(6, cookie);
    assert(p6.includes(overall('exceeded (advisory)')), 'rollup must use run snapshot threshold (exceeded), not current empty ticket policy');

    // 7 + 8: exceeded advisory changes no ticket status and does not block manual rerun.
    assert(readJsonData('tickets.json').find(t => t.id === 3).status === 'completed', 'exceeded advisory must not change ticket status');
    const rerun3 = await request('POST', '/api/tickets/3/rerun', { cookie, json: { mode: 'retry' } });
    assert(rerun3.statusCode === 200, `exceeded advisory must not block rerun, got HTTP ${rerun3.statusCode}: ${rerun3.body}`);

    // 10: run-level budgetStatus still works and is truthful.
    const state31 = JSON.parse((await request('GET', '/api/runs/31/state', { cookie })).body);
    assert(state31.budgetStatus && state31.budgetStatus.modelRequests.status === 'exceeded', 'run-level budgetStatus should remain unchanged (exceeded)');

    // 11: maxAttempts behavior unchanged (ticket 7: maxAttempts 1, 1 run → blocked).
    const rerun7 = await request('POST', '/api/tickets/7/rerun', { cookie, json: { mode: 'retry' } });
    assert(rerun7.statusCode === 409, `maxAttempts ceiling must still block, got HTTP ${rerun7.statusCode}`);

    console.log('PASS: ticket-level budget rollup is advisory, derived per-run snapshot, and blocks nothing');
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

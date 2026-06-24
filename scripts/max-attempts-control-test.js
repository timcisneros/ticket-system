#!/usr/bin/env node
// Operator-editable maxAttempts on ticket detail. Narrowly scoped: edits only
// ticket.executionPolicy.maxAttempts, preserves all other policy fields, mutates
// no runs and creates no runs. The manual rerun guard reads the updated ceiling.

const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const ADMIN_HASH = '$argon2id$v=19$m=65536,t=3,p=4$az+Aa/Vt5AjalPiSGPNdXQ$i+hlbZS1OGPnBIw16HfGY/u0A4VUqXdFkd5Y+JtXh/g';
const ISO = '2026-02-01T00:00:00.000Z';
const PORT = '3492';
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

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'max-attempts-data-'));
const WORKSPACE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'max-attempts-ws-'));
function writeJson(file, value) { fs.writeFileSync(path.join(DATA_DIR, file), JSON.stringify(value, null, 2)); }
function readJsonData(file) { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, file), 'utf8')); }
function ticketPolicy(id) { return readJsonData('tickets.json').find(t => t.id === id).executionPolicy; }
function runsForTicket(id) { return readJsonData('runs.json').filter(r => r.ticketId === id); }

// A complete, distinctive policy so "preserve other fields" is meaningful.
const FULL_POLICY = {
  mode: 'manual', requireVerification: 'when_declared', maxAttempts: null,
  maxRuntimeMs: 12345, maxModelRequests: 7, maxWorkspaceOperations: 9,
  allowWorkspaceWrites: false, allowParallelRuns: true, allowChildTickets: true, workspaceScope: 'shared'
};
const NON_MAX_FIELDS = ['mode', 'requireVerification', 'maxRuntimeMs', 'maxModelRequests', 'maxWorkspaceOperations', 'allowWorkspaceWrites', 'allowParallelRuns', 'allowChildTickets', 'workspaceScope'];

function seed() {
  fs.mkdirSync(path.join(DATA_DIR, 'replay-snapshots'), { recursive: true });
  writeJson('users.json', [{ id: 1, username: 'admin', passwordHash: ADMIN_HASH, createdAt: ISO, type: 'user' }]);
  writeJson('permissions.json', ['ticket:create', 'ticket:read', 'ticket:update']);
  writeJson('groups.json', [{ id: 1, name: 'Admins', permissions: ['ticket:create', 'ticket:read', 'ticket:update'], canReceiveTickets: false }]);
  writeJson('memberships.json', [{ id: 1, principalType: 'user', principalId: 1, groupId: 1 }]);
  writeJson('agents.json', [{ id: 1, name: 'MA Agent', type: 'agent', provider: 'openai', model: 'gpt-test', apiKey: 'k', createdAt: ISO, updatedAt: ISO }]);
  writeJson('workflows.json', []);
  writeJson('allocation-plans.json', []);
  writeJson('operation-history.json', []);
  writeJson('logs.json', []);
  writeJson('tickets.json', [{
    id: 1, objective: 'Max attempts control ticket',
    assignmentTargetType: 'agent', assignmentTargetId: 1, assignmentMode: 'individual',
    ownedOutputPaths: null, executionMode: 'agent', workflowId: null, workflowInput: null,
    capabilityType: 'directAction', capabilityId: 'agent-selected-actions', capabilityInput: null,
    executionPolicy: { ...FULL_POLICY }, status: 'completed',
    createdBy: 'admin', changedBy: 'admin', changedAt: ISO, createdAt: ISO, updatedAt: ISO
  }]);
  writeJson('runs.json', [{
    id: 10, ticketId: 1, agentId: 1, agentName: 'MA Agent',
    workspaceRoot: WORKSPACE_ROOT, mainWorkspaceRoot: WORKSPACE_ROOT, executionWorkspaceType: 'main',
    allocationPlanId: null, allocationItemId: null, ownedOutputPaths: [],
    executionMode: 'agent', workflowId: null, workflowInput: null,
    capabilityType: 'directAction', capabilityId: 'agent-selected-actions', capabilityInput: null,
    // Distinctive snapshot ceiling — must NOT change when the ticket policy is edited.
    executionPolicySnapshot: { ...FULL_POLICY, maxAttempts: 7 },
    currentPhase: 'terminalization', leaseOwner: null, leaseExpiresAt: null,
    currentStepId: null, currentWorkflowAction: null, lastHeartbeatAt: null,
    status: 'completed', createdAt: ISO, updatedAt: ISO, startedAt: ISO, completedAt: ISO
  }]);
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
const setMax = (value, cookie) => request('POST', '/api/tickets/1/execution-policy/max-attempts', { cookie, json: { maxAttempts: value } });
const rerun = cookie => request('POST', '/api/tickets/1/rerun', { cookie, json: { mode: 'retry' } });

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

    const policyBefore = ticketPolicy(1);
    const snapshotBefore = JSON.stringify(readJsonData('runs.json').find(r => r.id === 10).executionPolicySnapshot);
    const runsBefore = runsForTicket(1).length;
    assert(policyBefore.maxAttempts === null, 'precondition: maxAttempts starts null');

    // 1: set null → 2.
    const set2 = await setMax(2, cookie);
    assert(set2.statusCode === 200, `set maxAttempts 2 should succeed, got HTTP ${set2.statusCode}: ${set2.body}`);
    assert(ticketPolicy(1).maxAttempts === 2, 'maxAttempts should now be 2');

    // 4: all other policy fields preserved.
    const policyAfter = ticketPolicy(1);
    NON_MAX_FIELDS.forEach(f => assert(JSON.stringify(policyAfter[f]) === JSON.stringify(policyBefore[f]), `policy field ${f} must be preserved (was ${JSON.stringify(policyBefore[f])}, now ${JSON.stringify(policyAfter[f])})`));

    // 5: existing run snapshot is not mutated.
    assert(JSON.stringify(readJsonData('runs.json').find(r => r.id === 10).executionPolicySnapshot) === snapshotBefore, 'run executionPolicySnapshot must not be mutated by a ticket policy edit');

    // 9: editing created no runs and did not change ticket/run status.
    assert(runsForTicket(1).length === runsBefore, 'editing maxAttempts must not create runs');
    assert(readJsonData('tickets.json').find(t => t.id === 1).status === 'completed', 'editing maxAttempts must not change ticket status');
    assert(readJsonData('runs.json').find(r => r.id === 10).status === 'completed', 'editing maxAttempts must not change run status');

    // 8: UI renders explicit value truthfully.
    const pageSet = await request('GET', '/tickets/1', { cookie });
    assert(pageSet.body.includes('<dt>Max attempts</dt><dd>2 · enforced for manual rerun-from-start</dd>'), 'ticket detail should render explicit maxAttempts truthfully');

    // 3: invalid values rejected without changing the ticket.
    for (const bad of [0, -1, 1.5, 'abc', '0', '-3', '2.5']) {
      const res = await setMax(bad, cookie);
      assert(res.statusCode === 400, `invalid maxAttempts ${JSON.stringify(bad)} must be rejected, got HTTP ${res.statusCode}`);
      assert(ticketPolicy(1).maxAttempts === 2, `rejected value ${JSON.stringify(bad)} must not change the ticket (still 2)`);
    }

    // 6: at maxAttempts 1 with one existing run → manual rerun blocked.
    assert((await setMax(1, cookie)).statusCode === 200, 'set maxAttempts 1 should succeed');
    assert(runsForTicket(1).length === 1, 'precondition: ticket has exactly one run');
    const blocked = await rerun(cookie);
    assert(blocked.statusCode === 409, `manual rerun should be blocked at maxAttempts 1, got HTTP ${blocked.statusCode}`);
    assert(runsForTicket(1).length === 1, 'blocked rerun must not create a run');

    // 2 + 7: clear back to null/unlimited → rerun allowed again.
    const cleared = await setMax('', cookie);
    assert(cleared.statusCode === 200, `clear maxAttempts should succeed, got HTTP ${cleared.statusCode}`);
    assert(ticketPolicy(1).maxAttempts === null, 'maxAttempts should be cleared to null (unlimited)');
    const pageClear = await request('GET', '/tickets/1', { cookie });
    assert(pageClear.body.includes('<dt>Max attempts</dt><dd>unlimited · enforced for manual rerun-from-start when set</dd>'), 'ticket detail should render unlimited truthfully');
    const allowed = await rerun(cookie);
    assert(allowed.statusCode === 200, `manual rerun should be allowed after clearing the ceiling, got HTTP ${allowed.statusCode}: ${allowed.body}`);
    assert(runsForTicket(1).length === 2, 'allowed rerun after clear should create exactly one new run');

    console.log('PASS: operator can set/clear maxAttempts; edits preserve policy/snapshots and create no runs');
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

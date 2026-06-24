#!/usr/bin/env node
// Manual rerun attempt ceiling — maxAttempts enforced ONLY for manual
// rerun-from-start. Not automatic retry: nothing here schedules, backs off, or
// retries on failure. Attempt count is derived from existing runs.

const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const ADMIN_HASH = '$argon2id$v=19$m=65536,t=3,p=4$az+Aa/Vt5AjalPiSGPNdXQ$i+hlbZS1OGPnBIw16HfGY/u0A4VUqXdFkd5Y+JtXh/g';
const ISO = '2026-02-01T00:00:00.000Z';
const PORT = '3491';
const BASE_URL = 'http://127.0.0.1:' + PORT;

let server = null;
function assert(c, m) { if (!c) throw new Error(m); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function request(method, urlPath, options = {}) {
  const body = options.form ? new URLSearchParams(options.form).toString() : options.json ? JSON.stringify(options.json) : null;
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

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'rerun-ceiling-data-'));
const WORKSPACE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'rerun-ceiling-ws-'));
function writeJson(file, value) { fs.writeFileSync(path.join(DATA_DIR, file), JSON.stringify(value, null, 2)); }
function readRunsData() { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'runs.json'), 'utf8')); }
function readTicketsData() { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'tickets.json'), 'utf8')); }
function runsForTicket(id) { return readRunsData().filter(r => r.ticketId === id); }

function ticket(id, status, maxAttempts) {
  return {
    id, objective: `Rerun ceiling ticket #${id}`,
    assignmentTargetType: 'agent', assignmentTargetId: 1, assignmentMode: 'individual',
    ownedOutputPaths: null, executionMode: 'agent', workflowId: null, workflowInput: null,
    capabilityType: 'directAction', capabilityId: 'agent-selected-actions', capabilityInput: null,
    executionPolicy: { maxAttempts },
    status, createdBy: 'admin', changedBy: 'admin', changedAt: ISO, createdAt: ISO, updatedAt: ISO
  };
}
function run(id, ticketId, status) {
  return {
    id, ticketId, agentId: 1, agentName: 'Ceiling Agent',
    workspaceRoot: WORKSPACE_ROOT, mainWorkspaceRoot: WORKSPACE_ROOT, executionWorkspaceType: 'main',
    allocationPlanId: null, allocationItemId: null, ownedOutputPaths: [],
    executionMode: 'agent', workflowId: null, workflowInput: null,
    capabilityType: 'directAction', capabilityId: 'agent-selected-actions', capabilityInput: null,
    executionPolicySnapshot: { requireVerification: 'when_declared' },
    currentPhase: 'terminalization', leaseOwner: null, leaseExpiresAt: null,
    currentStepId: null, currentWorkflowAction: null, lastHeartbeatAt: null,
    status, error: status === 'failed' ? 'boom' : undefined,
    createdAt: ISO, updatedAt: ISO, startedAt: ISO, completedAt: ISO
  };
}

function seed() {
  fs.mkdirSync(path.join(DATA_DIR, 'replay-snapshots'), { recursive: true });
  writeJson('users.json', [{ id: 1, username: 'admin', passwordHash: ADMIN_HASH, createdAt: ISO, type: 'user' }]);
  writeJson('permissions.json', ['ticket:create', 'ticket:read', 'ticket:update']);
  writeJson('groups.json', [{ id: 1, name: 'Admins', permissions: ['ticket:create', 'ticket:read', 'ticket:update'], canReceiveTickets: false }]);
  writeJson('memberships.json', [{ id: 1, principalType: 'user', principalId: 1, groupId: 1 }]);
  writeJson('agents.json', [{ id: 1, name: 'Ceiling Agent', type: 'agent', provider: 'openai', model: 'gpt-test', apiKey: 'k', createdAt: ISO, updatedAt: ISO }]);
  writeJson('workflows.json', []);
  writeJson('allocation-plans.json', []);
  writeJson('operation-history.json', []);
  writeJson('logs.json', []);
  // T1: below ceiling (maxAttempts 2, 1 run) → allow.
  // T2: at ceiling (maxAttempts 1, 1 run) → reject.
  // T3: generous ceiling (maxAttempts 50, 1 run) → allow (non-constraining, behaves as today).
  // T4: at ceiling (maxAttempts 1) with a failed run → /retry route also rejects.
  writeJson('tickets.json', [
    ticket(1, 'completed', 2),
    ticket(2, 'completed', 1),
    ticket(3, 'completed', 50),
    ticket(4, 'failed', 1)
  ]);
  writeJson('runs.json', [run(10, 1, 'completed'), run(20, 2, 'completed'), run(30, 3, 'completed'), run(40, 4, 'failed')]);
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
const rerun = (id, cookie) => request('POST', `/api/tickets/${id}/rerun`, { cookie, json: { mode: 'retry' } });
const reason = res => { try { return JSON.parse(res.body).error || ''; } catch (_) { return ''; } };

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

    // 1: below ceiling → allowed, one new run created.
    assert(runsForTicket(1).length === 1, 'precondition: ticket 1 has 1 run');
    const r1 = await rerun(1, cookie);
    assert(r1.statusCode === 200, `below-ceiling rerun should be allowed, got HTTP ${r1.statusCode}: ${reason(r1)}`);
    assert(runsForTicket(1).length === 2, `allowed rerun should create exactly one new run, got ${runsForTicket(1).length}`);

    // 6 (practical): generous ceiling (well above attempt count) behaves as today → allowed.
    const r3 = await rerun(3, cookie);
    assert(r3.statusCode === 200, `non-constraining maxAttempts should preserve allow behavior, got HTTP ${r3.statusCode}`);
    assert(runsForTicket(3).length === 2, 'generous-ceiling rerun should create a run');

    // 2 + 3 + 4 + 5: at ceiling → rejected, no new run, status unchanged, clear reason.
    const t2Before = readTicketsData().find(t => t.id === 2).status;
    const runs2Before = runsForTicket(2).length;
    const r2 = await rerun(2, cookie);
    assert(r2.statusCode === 409, `at-ceiling rerun must be rejected with 409, got HTTP ${r2.statusCode}`);
    assert(reason(r2).includes('maxAttempts is enforced for manual rerun-from-start'), `rejection reason should be clear, got: ${reason(r2)}`);
    assert(reason(r2).includes('1 of 1 allowed attempt'), `rejection should state attempts used, got: ${reason(r2)}`);
    assert(runsForTicket(2).length === runs2Before, 'rejected rerun must not create a new run');
    assert(readTicketsData().find(t => t.id === 2).status === t2Before, 'rejected rerun must not change ticket status');

    // /api/runs/:id/retry route enforces the ceiling too.
    const retry40 = await request('POST', '/api/runs/40/retry', { cookie, json: {} });
    assert(retry40.statusCode === 409, `at-ceiling run retry must be rejected with 409, got HTTP ${retry40.statusCode}`);
    assert(runsForTicket(4).length === 1, 'rejected run retry must not create a new run');

    // 7 + 8: only maxAttempts wording changed; other fields remain recorded intent.
    const ticket2Page = await request('GET', '/tickets/2', { cookie });
    assert(ticket2Page.statusCode === 200, 'ticket 2 page HTTP ' + ticket2Page.statusCode);
    assert(ticket2Page.body.includes('<dt>Max attempts</dt><dd>1 · enforced for manual rerun-from-start</dd>'), 'Max attempts should be labeled enforced for manual rerun-from-start');
    assert(ticket2Page.body.includes('recorded intent, not enforced'), 'other policy fields must remain recorded intent, not enforced');
    assert(/<dt>Mode<\/dt><dd><code>[^<]*<\/code> · recorded intent, not enforced/.test(ticket2Page.body), 'Mode should remain recorded intent, not enforced');

    // 9: no automatic rerun — after the rejected rerun, count stays put (scheduler parked).
    await sleep(800);
    assert(runsForTicket(2).length === runs2Before, 'no automatic rerun should occur after a rejected manual rerun');

    console.log('PASS: maxAttempts is enforced for manual rerun-from-start only (no automatic retry)');
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

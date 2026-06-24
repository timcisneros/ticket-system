#!/usr/bin/env node
// Operator-facing triage inbox at /triage. Read-only visibility/navigation surface:
// lists unresolved ticket-level and run-level triage, links to existing detail pages,
// and mutates nothing.

const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const ADMIN_HASH = '$argon2id$v=19$m=65536,t=3,p=4$az+Aa/Vt5AjalPiSGPNdXQ$i+hlbZS1OGPnBIw16HfGY/u0A4VUqXdFkd5Y+JtXh/g';
const T0 = '2026-02-01T00:00:00.000Z';

function assert(c, m) { if (!c) throw new Error(m); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function request(baseUrl, method, urlPath, options = {}) {
  return new Promise((resolve, reject) => {
    const body = options.form ? new URLSearchParams(options.form).toString() : null;
    const req = http.request(baseUrl + urlPath, {
      method,
      headers: {
        ...(options.form ? { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) } : {}),
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

const TICKET_TRIAGE = {
  required: true, reasonCode: 'authority_blocked', summary: 'TICKET-UNRESOLVED-SUMMARY',
  requiredDecision: 'change_scope', evidenceRefs: ['event:ticket.blocked'],
  allowedActions: ['review', 'edit_ticket'], prohibitedActions: ['start_run_without_scope_change'],
  createdAt: T0, resolvedAt: null, resolvedBy: null, resolution: null
};
const TICKET_TRIAGE_RESOLVED = {
  required: false, reasonCode: 'runtime_failed', summary: 'TICKET-RESOLVED-SHOULD-NOT-APPEAR',
  requiredDecision: 'review_failure', evidenceRefs: [], allowedActions: ['review'], prohibitedActions: ['automatic_retry'],
  createdAt: T0, resolvedAt: T0, resolvedBy: 'admin', resolution: 'done'
};
const RUN_TRIAGE = {
  required: true, reasonCode: 'verification_failed', summary: 'RUN-UNRESOLVED-SUMMARY',
  requiredDecision: 'review_failure', evidenceRefs: ['event:run.verification_failed'],
  allowedActions: ['review', 'rerun_from_start'], prohibitedActions: ['mark_completed_without_verification'],
  createdAt: T0, resolvedAt: null, resolvedBy: null, resolution: null
};
const RUN_TRIAGE_RESOLVED = {
  required: false, reasonCode: 'runtime_failed', summary: 'RUN-RESOLVED-SHOULD-NOT-APPEAR',
  requiredDecision: 'review_failure', evidenceRefs: [], allowedActions: ['review'], prohibitedActions: ['automatic_retry'],
  createdAt: T0, resolvedAt: T0, resolvedBy: 'admin', resolution: 'done'
};

function ticket(id, status, triage) {
  return {
    id, objective: `Inbox ticket #${id}`,
    assignmentTargetType: 'agent', assignmentTargetId: 1, assignmentMode: 'individual',
    ownedOutputPaths: null, executionMode: 'agent', workflowId: null, workflowInput: null,
    capabilityType: 'directAction', capabilityId: 'agent-selected-actions', capabilityInput: null,
    executionPolicy: { maxAttempts: null }, status, triage: triage || undefined,
    createdBy: 'admin', changedBy: 'admin', changedAt: T0, createdAt: T0, updatedAt: T0
  };
}
function run(id, ticketId, status, triage, workspaceRoot) {
  return {
    id, ticketId, agentId: 1, agentName: 'Inbox Agent',
    workspaceRoot, mainWorkspaceRoot: workspaceRoot, executionWorkspaceType: 'main',
    allocationPlanId: null, allocationItemId: null, ownedOutputPaths: [],
    executionMode: 'agent', workflowId: null, workflowInput: null,
    capabilityType: 'directAction', capabilityId: 'agent-selected-actions', capabilityInput: null,
    executionPolicySnapshot: { requireVerification: 'when_declared' },
    currentPhase: 'terminalization', leaseOwner: null, leaseExpiresAt: null,
    currentStepId: null, currentWorkflowAction: null, lastHeartbeatAt: null,
    status, triage: triage || undefined, createdAt: T0, updatedAt: T0, startedAt: T0, completedAt: T0
  };
}

function seedCommon(dataDir) {
  fs.mkdirSync(path.join(dataDir, 'replay-snapshots'), { recursive: true });
  const writeJson = (f, v) => fs.writeFileSync(path.join(dataDir, f), JSON.stringify(v, null, 2));
  writeJson('users.json', [
    { id: 1, username: 'admin', passwordHash: ADMIN_HASH, createdAt: T0, type: 'user' },
    { id: 2, username: 'viewer', passwordHash: ADMIN_HASH, createdAt: T0, type: 'user' },
    { id: 3, username: 'noread', passwordHash: ADMIN_HASH, createdAt: T0, type: 'user' }
  ]);
  writeJson('permissions.json', ['ticket:create', 'ticket:read', 'ticket:update', 'user:read']);
  writeJson('groups.json', [
    { id: 1, name: 'Admins', permissions: ['ticket:create', 'ticket:read', 'ticket:update', 'user:read'], canReceiveTickets: false },
    { id: 2, name: 'Viewers', permissions: ['ticket:read'], canReceiveTickets: false },
    { id: 3, name: 'NoRead', permissions: ['user:read'], canReceiveTickets: false }
  ]);
  writeJson('memberships.json', [
    { id: 1, principalType: 'user', principalId: 1, groupId: 1 },
    { id: 2, principalType: 'user', principalId: 2, groupId: 2 },
    { id: 3, principalType: 'user', principalId: 3, groupId: 3 }
  ]);
  writeJson('agents.json', [{ id: 1, name: 'Inbox Agent', type: 'agent', provider: 'openai', model: 'gpt-test', apiKey: 'k', createdAt: T0, updatedAt: T0 }]);
  writeJson('workflows.json', []);
  writeJson('allocation-plans.json', []);
  writeJson('operation-history.json', []);
  writeJson('logs.json', []);
  fs.writeFileSync(path.join(dataDir, 'events.jsonl'), '');
}

function startServer(dataDir, workspaceRoot, port) {
  const proc = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, NODE_ENV: 'test', PORT: String(port), DATA_DIR: dataDir, WORKSPACE_ROOT: workspaceRoot, RUNTIME_SCHEDULER_INTERVAL_MS: '3600000' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let out = '';
  proc.stdout.on('data', c => { out += String(c); });
  proc.stderr.on('data', c => { out += String(c); });
  proc.getOutput = () => out;
  return proc;
}
function waitForReady(baseUrl, proc, timeoutMs = 12000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const poll = () => {
      if (proc.exitCode !== null) return reject(new Error('server exited early:\n' + proc.getOutput()));
      http.get(baseUrl + '/api/health', res => { res.resume(); res.statusCode === 200 ? resolve() : (Date.now() > deadline ? reject(new Error('timeout')) : setTimeout(poll, 200)); })
        .on('error', () => Date.now() > deadline ? reject(new Error('timeout')) : setTimeout(poll, 200));
    };
    setTimeout(poll, 400);
  });
}
async function stop(proc) { if (!proc) return; proc.kill('SIGTERM'); await sleep(400); if (proc.exitCode === null) proc.kill('SIGKILL'); }
async function login(baseUrl, username) {
  const res = await request(baseUrl, 'POST', '/login', { form: { username, password: 'admin123' } });
  assert(res.statusCode === 302, `login ${username} failed HTTP ${res.statusCode}`);
  return cookieFrom(res);
}

async function populatedPhase() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'triage-inbox-data-'));
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'triage-inbox-ws-'));
  const port = 3496; const baseUrl = 'http://127.0.0.1:' + port;
  let server = null;
  try {
    seedCommon(dataDir);
    const writeJson = (f, v) => fs.writeFileSync(path.join(dataDir, f), JSON.stringify(v, null, 2));
    writeJson('tickets.json', [
      ticket(1, 'blocked', { ...TICKET_TRIAGE }),         // unresolved ticket-level
      ticket(2, 'failed', { ...TICKET_TRIAGE_RESOLVED }), // resolved → excluded
      ticket(3, 'failed', null)                            // hosts run triage
    ]);
    writeJson('runs.json', [
      run(30, 3, 'failed', { ...RUN_TRIAGE }, workspaceRoot),          // unresolved run-level
      run(31, 3, 'failed', { ...RUN_TRIAGE_RESOLVED }, workspaceRoot)  // resolved → excluded
    ]);

    server = startServer(dataDir, workspaceRoot, port);
    await waitForReady(baseUrl, server);

    const ticketsBefore = fs.readFileSync(path.join(dataDir, 'tickets.json'), 'utf8');
    const runsBefore = fs.readFileSync(path.join(dataDir, 'runs.json'), 'utf8');
    const runCountBefore = JSON.parse(runsBefore).length;

    // 1: ticket:read user gets 200.
    const viewer = await login(baseUrl, 'viewer');
    const page = await request(baseUrl, 'GET', '/triage', { cookie: viewer });
    assert(page.statusCode === 200, 'ticket:read user should GET /triage 200, got ' + page.statusCode);
    const body = page.body;

    // 2 + 5 + 7: unresolved ticket-level listed truthfully with link.
    assert(body.includes('href="/tickets/1"'), 'ticket-level row should link to /tickets/1');
    assert(body.includes('<code>authority_blocked</code>'), 'ticket reasonCode should render');
    assert(body.includes('<code>change_scope</code>'), 'ticket requiredDecision should render');
    assert(body.includes('TICKET-UNRESOLVED-SUMMARY'), 'ticket summary should render');
    assert(body.includes('review, edit_ticket'), 'ticket allowedActions should render joined');
    assert(body.includes('start_run_without_scope_change'), 'ticket prohibitedActions should render');
    assert(body.includes(T0), 'triage createdAt should render');

    // 3 + 6 + 7: unresolved run-level listed truthfully with both links.
    assert(body.includes('href="/runs/30"'), 'run-level row should link to /runs/30');
    assert(body.includes('href="/tickets/3"'), 'run-level row should link to parent /tickets/3');
    assert(body.includes('<code>verification_failed</code>'), 'run reasonCode should render');
    assert(body.includes('RUN-UNRESOLVED-SUMMARY'), 'run summary should render');
    assert(body.includes('review, rerun_from_start'), 'run allowedActions should render joined');
    assert(body.includes('mark_completed_without_verification'), 'run prohibitedActions should render');

    // 4: resolved triage is NOT listed.
    assert(!body.includes('TICKET-RESOLVED-SHOULD-NOT-APPEAR'), 'resolved ticket triage must not be listed');
    assert(!body.includes('RUN-RESOLVED-SHOULD-NOT-APPEAR'), 'resolved run triage must not be listed');
    assert(!body.includes('href="/runs/31"'), 'resolved run must not be linked');

    // 13: nav link present for ticket:read user.
    assert(body.includes('href="/triage"'), 'nav should include Triage link for ticket:read user');

    // 8: user without ticket:read → 403, no triage content leaked.
    const noread = await login(baseUrl, 'noread');
    const denied = await request(baseUrl, 'GET', '/triage', { cookie: noread });
    assert(denied.statusCode === 403, 'user without ticket:read must get 403, got ' + denied.statusCode);
    assert(!denied.body.includes('authority_blocked') && !denied.body.includes('verification_failed'), '403 must not leak triage content');

    // 14: nav link absent for users without ticket:read (checked on a page they can load).
    const adminPage = await request(baseUrl, 'GET', '/admin', { cookie: noread });
    assert(adminPage.statusCode === 200, 'noread (user:read) should load /admin, got ' + adminPage.statusCode);
    assert(!adminPage.body.includes('href="/triage"'), 'nav Triage link must be hidden from users without ticket:read');

    // 9 + 10 + 11: GET /triage mutates nothing and creates no run.
    assert(fs.readFileSync(path.join(dataDir, 'tickets.json'), 'utf8') === ticketsBefore, 'GET /triage must not mutate tickets.json');
    assert(fs.readFileSync(path.join(dataDir, 'runs.json'), 'utf8') === runsBefore, 'GET /triage must not mutate runs.json');
    assert(JSON.parse(fs.readFileSync(path.join(dataDir, 'runs.json'), 'utf8')).length === runCountBefore, 'GET /triage must not create a run');

    console.log('PASS: triage inbox lists unresolved triage, links out, gates on ticket:read, and mutates nothing');
  } finally {
    await stop(server);
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
}

async function emptyPhase() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'triage-inbox-empty-data-'));
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'triage-inbox-empty-ws-'));
  const port = 3497; const baseUrl = 'http://127.0.0.1:' + port;
  let server = null;
  try {
    seedCommon(dataDir);
    const writeJson = (f, v) => fs.writeFileSync(path.join(dataDir, f), JSON.stringify(v, null, 2));
    // No required triage anywhere: one resolved-triage ticket, one no-triage ticket, one resolved run.
    writeJson('tickets.json', [ticket(1, 'failed', { ...TICKET_TRIAGE_RESOLVED }), ticket(2, 'completed', null)]);
    writeJson('runs.json', [run(20, 2, 'completed', { ...RUN_TRIAGE_RESOLVED }, workspaceRoot)]);

    server = startServer(dataDir, workspaceRoot, port);
    await waitForReady(baseUrl, server);
    const admin = await login(baseUrl, 'admin');

    // 12: empty state renders.
    const page = await request(baseUrl, 'GET', '/triage', { cookie: admin });
    assert(page.statusCode === 200, 'empty /triage should be 200');
    assert(page.body.includes('No unresolved triage.'), 'empty state message should render');
    assert(!page.body.includes('TICKET-RESOLVED-SHOULD-NOT-APPEAR') && !page.body.includes('RUN-RESOLVED-SHOULD-NOT-APPEAR'), 'resolved triage must not appear in empty inbox');

    console.log('PASS: triage inbox renders empty state when no unresolved triage');
  } finally {
    await stop(server);
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
}

async function main() {
  await populatedPhase();
  await emptyPhase();
  console.log('PASS: operator triage inbox');
}

main().catch(error => { console.error(error.stack || error.message); process.exit(1); });

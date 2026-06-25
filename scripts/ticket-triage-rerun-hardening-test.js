#!/usr/bin/env node
// Ticket-level triage rerun hardening.
//
// Invariant: No production run may be created while unresolved ticket-level triage exists.
//
// Tests:
// 1. Blocked ticket with unresolved triage: rerun button not active, rerun 409.
// 2. Retry on run whose parent ticket has unresolved triage: 409.
// 3. PATCH status to open on ticket with unresolved triage: no run created.
// 4. Resolved triage: rerun still allowed.
// 5. Non-triaged failed/triaged-completed ticket: rerun still works.

const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const ADMIN_HASH = '$argon2id$v=19$m=65536,t=3,p=4$az+Aa/Vt5AjalPiSGPNdXQ$i+hlbZS1OGPnBIw16HfGY/u0A4VUqXdFkd5Y+JtXh/g';
const T0 = '2026-02-01T00:00:00.000Z';
const PORT = '3522';
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

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'triage-rerun-harden-data-'));
const WORKSPACE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'triage-rerun-harden-ws-'));
function writeJson(file, value) { fs.writeFileSync(path.join(DATA_DIR, file), JSON.stringify(value, null, 2)); }
function readJsonData(file) { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, file), 'utf8')); }

function seedCommon() {
  fs.mkdirSync(path.join(DATA_DIR, 'replay-snapshots'), { recursive: true });
  writeJson('users.json', [
    { id: 1, username: 'admin', passwordHash: ADMIN_HASH, createdAt: T0, type: 'user' },
    { id: 2, username: 'viewer', passwordHash: ADMIN_HASH, createdAt: T0, type: 'user' }
  ]);
  writeJson('permissions.json', ['ticket:create', 'ticket:read', 'ticket:update', 'user:read']);
  writeJson('groups.json', [
    { id: 1, name: 'Admins', permissions: ['ticket:create', 'ticket:read', 'ticket:update', 'user:read'], canReceiveTickets: false }
  ]);
  writeJson('memberships.json', [
    { id: 1, principalType: 'user', principalId: 1, groupId: 1 },
    { id: 2, principalType: 'user', principalId: 2, groupId: 1 }
  ]);
  writeJson('agents.json', [
    { id: 1, name: 'Test Agent', type: 'agent', provider: 'openai', model: 'gpt-test', apiKey: 'k', createdAt: T0, updatedAt: T0 }
  ]);
  writeJson('workflows.json', []);
  writeJson('allocation-plans.json', []);
  writeJson('operation-history.json', []);
  writeJson('logs.json', []);
  fs.writeFileSync(path.join(DATA_DIR, 'events.jsonl'), '');
}

function startServer() {
  const proc = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env, NODE_ENV: 'test', PORT,
      DATA_DIR, WORKSPACE_ROOT,
      RUNTIME_SCHEDULER_INTERVAL_MS: '3600000'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let out = '';
  proc.stdout.on('data', c => { out += String(c); });
  proc.stderr.on('data', c => { out += String(c); });
  proc.getOutput = () => out;
  return proc;
}

function waitForReady(timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const poll = () => {
      if (server.exitCode !== null) return reject(new Error('server exited early:\n' + server.getOutput()));
      http.get(BASE_URL + '/api/health', res => {
        res.resume();
        res.statusCode === 200 ? resolve() : (Date.now() > deadline ? reject(new Error('timeout')) : setTimeout(poll, 200));
      }).on('error', () => Date.now() > deadline ? reject(new Error('timeout')) : setTimeout(poll, 200));
    };
    setTimeout(poll, 400);
  });
}

async function stop() {
  if (!server) return;
  server.kill('SIGTERM');
  await sleep(400);
  if (server.exitCode === null) server.kill('SIGKILL');
}

async function login() {
  const res = await request('POST', '/login', { form: { username: 'admin', password: 'admin123' } });
  assert(res.statusCode === 302, `admin login failed HTTP ${res.statusCode}`);
  return cookieFrom(res);
}

// ── Test 1: Blocked ticket with unresolved triage ──────────────────────

async function test1BlockedTicketRerunRejected() {
  const runsBefore = readJsonData('runs.json');
  const opsBefore = readJsonData('operation-history.json');
  const wsBefore = fs.existsSync(WORKSPACE_ROOT) ? fs.readdirSync(WORKSPACE_ROOT) : [];

  const cookie = await login();

  // Create a ticket with ambiguous objective → gets blocked with triage.
  const createRes = await request('POST', '/tickets', {
    cookie,
    form: {
      objective: 'Create 3 folders each named Michael Jackson songs',
      assignmentTargetType: 'agent',
      assignmentTargetId: '1'
    }
  });
  assert(createRes.statusCode === 302, `create ticket failed HTTP ${createRes.statusCode}`);
  await sleep(300);

  const tickets = readJsonData('tickets.json');
  const blockedTicket = tickets.find(t => t.objective === 'Create 3 folders each named Michael Jackson songs');
  assert(blockedTicket, 'blocked ticket must exist');
  assert(blockedTicket.status === 'blocked', `ticket must be blocked, got ${blockedTicket.status}`);
  assert(blockedTicket.triage && blockedTicket.triage.required === true, 'ticket must have required triage');
  assert(!blockedTicket.triage.resolvedAt, 'triage must be unresolved');

  // 1a. Ticket detail should not show active Rerun button.
  const ticketPage = await request('GET', `/tickets/${blockedTicket.id}`, { cookie });
  assert(ticketPage.statusCode === 200, `ticket detail HTTP ${ticketPage.statusCode}`);
  const rerunButtonPattern = new RegExp(`<button[^>]*data-rerun-ticket-id="${blockedTicket.id}"`);
  const hasRerunButtonElement = rerunButtonPattern.test(ticketPage.body);
  const hasDisabledText = ticketPage.body.includes('Rerun disabled');
  assert(!hasRerunButtonElement, 'blocked ticket with unresolved triage must not render Rerun button element');
  assert(hasDisabledText, 'blocked ticket must show rerun disabled explanation');

  // 1b. Rerun endpoint should reject with 409.
  const rerunRes = await request('POST', `/api/tickets/${blockedTicket.id}/rerun`, { cookie });
  assert(rerunRes.statusCode === 409, `rerun must return 409, got ${rerunRes.statusCode}`);
  const body = JSON.parse(rerunRes.body);
  assert(body.error && body.error.includes('unresolved ticket-level triage'),
    `error must reference triage, got: ${JSON.stringify(body)}`);

  // 1c. Ticket remains blocked.
  const ticketsAfter = readJsonData('tickets.json');
  const ticketAfter = ticketsAfter.find(t => t.id === blockedTicket.id);
  assert(ticketAfter.status === 'blocked', `ticket must remain blocked, got ${ticketAfter.status}`);
  assert(ticketAfter.triage.required === true, 'triage must still be required');
  assert(!ticketAfter.triage.resolvedAt, 'triage must still be unresolved');

  // 1d. No run created.
  assert(readJsonData('runs.json').length === runsBefore.length, 'no run must be created');

  // 1e. Operation-history unchanged.
  assert(readJsonData('operation-history.json').length === opsBefore.length, 'operation-history must be unchanged');

  // 1f. Workspace unchanged.
  const wsAfter = fs.existsSync(WORKSPACE_ROOT) ? fs.readdirSync(WORKSPACE_ROOT) : [];
  assert(wsAfter.length === wsBefore.length, 'workspace must be unchanged');

  console.log('PASS: test 1 — blocked ticket with unresolved triage rejects rerun');
}

// ── Test 2: Retry on run whose parent ticket has unresolved triage ─────

async function test2RetryRejectedWhenParentTicketHasTriage() {
  const cookie = await login();
  const runsBefore = readJsonData('runs.json').length;
  const opsBefore = readJsonData('operation-history.json').length;

  // Create a failed run on a ticket with unresolved triage.
  // We seed a ticket with unresolved triage and a failed run attached.
  const triageTicket = {
    id: 50, objective: 'Parent with triage and failed run',
    assignmentTargetType: 'agent', assignmentTargetId: 1, assignmentMode: 'individual',
    ownedOutputPaths: null, executionMode: 'agent', workflowId: null, workflowInput: null,
    capabilityType: 'directAction', capabilityId: 'agent-selected-actions', capabilityInput: null,
    executionPolicy: { maxAttempts: null },
    status: 'blocked',
    blockedReason: 'test triage',
    triage: {
      required: true, reasonCode: 'objective_ambiguous', summary: 'test triage for retry test',
      requiredDecision: 'clarify_objective', evidenceRefs: [],
      allowedActions: ['edit_objective', 'clarify_ticket'],
      prohibitedActions: ['mutate_workspace_without_clarification', 'start_run_without_clarification'],
      createdAt: T0, resolvedAt: null, resolvedBy: null, resolution: null
    },
    createdBy: 'admin', changedBy: 'admin', changedAt: T0, createdAt: T0, updatedAt: T0
  };
  const failedRun = {
    id: 51, ticketId: 50, agentId: 1, agentName: 'Test Agent',
    executionMode: 'agent', workflowId: null,
    executionPolicySnapshot: { maxAttempts: null },
    verificationContractSnapshot: null,
    allocationPlanId: null, allocationItemId: null, allocationSubtask: null,
    ownedOutputPaths: [], currentPhase: 'planning',
    status: 'failed', leaseOwner: null, leaseExpiresAt: null,
    currentStepId: null,
    ticketOpenedAt: T0, createdAt: T0, updatedAt: T0
  };
  // Merge into persistent data.
  const existingTickets = readJsonData('tickets.json');
  existingTickets.push(triageTicket);
  writeJson('tickets.json', existingTickets);
  const existingRuns = readJsonData('runs.json');
  existingRuns.push(failedRun);
  writeJson('runs.json', existingRuns);

  // Attempt retry on the failed run.
  const retryRes = await request('POST', `/api/runs/51/retry`, { cookie });
  assert(retryRes.statusCode === 409, `retry must return 409, got ${retryRes.statusCode}`);

  // No new run created.
  assert(readJsonData('runs.json').length === runsBefore + 1, 'no new run must be created (only the seeded failed run)');
  assert(readJsonData('operation-history.json').length === opsBefore, 'operation-history must be unchanged');

  // Parent ticket still blocked.
  const parentAfter = readJsonData('tickets.json').find(t => t.id === 50);
  assert(parentAfter.status === 'blocked', `parent ticket must remain blocked, got ${parentAfter.status}`);

  console.log('PASS: test 2 — retry with parent triage returns 409');
}

// ── Test 3: PATCH status to open on ticket with unresolved triage ──────

async function test3StatusPatchToOpenWithTriage() {
  const cookie = await login();
  const runsBefore = readJsonData('runs.json').length;
  const opsBefore = readJsonData('operation-history.json').length;

  // Create a ticket that gets blocked with triage.
  const createRes = await request('POST', '/tickets', {
    cookie,
    form: {
      objective: 'Create 5 folders each called something',
      assignmentTargetType: 'agent',
      assignmentTargetId: '1'
    }
  });
  assert(createRes.statusCode === 302, `create ticket HTTP ${createRes.statusCode}`);
  await sleep(300);

  const tickets = readJsonData('tickets.json');
  const blockedTicket = tickets.find(t => t.objective === 'Create 5 folders each called something');
  assert(blockedTicket && blockedTicket.status === 'blocked', 'ticket must be blocked');
  assert(blockedTicket.triage && blockedTicket.triage.required && !blockedTicket.triage.resolvedAt, 'ticket must have unresolved triage');

  // Now PATCH status to open (this bypasses the gate but should be caught by createRunsForTicket).
  const patchRes = await request('PATCH', `/api/tickets/${blockedTicket.id}/status`, {
    cookie,
    json: { status: 'open' }
  });
  assert(patchRes.statusCode === 200, `PATCH status to open HTTP ${patchRes.statusCode}`);

  // Wait for async processing.
  await sleep(300);

  // The ticket should now have status 'open' (PATCH set it).
  const ticketsAfter = readJsonData('tickets.json');
  const ticketAfter = ticketsAfter.find(t => t.id === blockedTicket.id);
  assert(ticketAfter.status === 'open', `ticket status should be open, got ${ticketAfter.status}`);

  // No new run should have been created (createRunsForTicket defensive check returned []).
  assert(readJsonData('runs.json').length === runsBefore,
    `no run should be created despite status being open, before: ${runsBefore}, after: ${readJsonData('runs.json').length}`);
  assert(readJsonData('operation-history.json').length === opsBefore, 'operation-history must be unchanged');

  console.log('PASS: test 3 — PATCH to open with unresolved triage creates no run');
}

// ── Test 4: Resolved triage still allows rerun ─────────────────────────

async function test4ResolvedTriageAllowsRerun() {
  const cookie = await login();
  const runsBefore = readJsonData('runs.json').length;

  // Seed a ticket with resolved triage.
  const resolvedTriageTicket = {
    id: 80, objective: 'Resolved triage ticket',
    assignmentTargetType: 'agent', assignmentTargetId: 1, assignmentMode: 'individual',
    ownedOutputPaths: null, executionMode: 'agent', workflowId: null, workflowInput: null,
    capabilityType: 'directAction', capabilityId: 'agent-selected-actions', capabilityInput: null,
    executionPolicy: { maxAttempts: null },
    status: 'failed',
    triage: {
      required: true, reasonCode: 'objective_ambiguous', summary: 'Resolved test triage',
      requiredDecision: 'clarify_objective', evidenceRefs: [],
      allowedActions: ['edit_objective', 'clarify_ticket'],
      prohibitedActions: [],
      createdAt: T0, resolvedAt: T0, resolvedBy: 'admin', resolution: 'test resolution'
    },
    createdBy: 'admin', changedBy: 'admin', changedAt: T0, createdAt: T0, updatedAt: T0
  };
  const existingTickets = readJsonData('tickets.json');
  existingTickets.push(resolvedTriageTicket);
  writeJson('tickets.json', existingTickets);

  // Rerun should succeed (resolved triage is not a blocker).
  const rerunRes = await request('POST', `/api/tickets/80/rerun`, { cookie });
  assert(rerunRes.statusCode === 200, `rerun with resolved triage must succeed, got ${rerunRes.statusCode}`);

  await sleep(300);

  // A run should be created (or at least a rerun attempt made).
  // Since the ticket is 'failed' with a clear objective, the gate passes and runs are created.
  const runsAfter = readJsonData('runs.json');
  assert(runsAfter.length > runsBefore, 'rerun with resolved triage must create a run');

  console.log('PASS: test 4 — resolved triage allows rerun');
}

// ── Test 5: Non-triaged failed ticket rerun still works ────────────────

async function test5NonTriagedRerunWorks() {
  const cookie = await login();
  const runsBefore = readJsonData('runs.json').length;

  // Seed a non-triaged failed ticket.
  const nonTriagedTicket = {
    id: 90, objective: 'Create folders TestFolder',
    assignmentTargetType: 'agent', assignmentTargetId: 1, assignmentMode: 'individual',
    ownedOutputPaths: null, executionMode: 'agent', workflowId: null, workflowInput: null,
    capabilityType: 'directAction', capabilityId: 'agent-selected-actions', capabilityInput: null,
    executionPolicy: { maxAttempts: null },
    status: 'failed',
    createdBy: 'admin', changedBy: 'admin', changedAt: T0, createdAt: T0, updatedAt: T0
  };
  const existingTickets = readJsonData('tickets.json');
  existingTickets.push(nonTriagedTicket);
  writeJson('tickets.json', existingTickets);

  // Rerun should succeed.
  const rerunRes = await request('POST', `/api/tickets/90/rerun`, { cookie });
  assert(rerunRes.statusCode === 200, `rerun on non-triaged failed ticket must succeed, got ${rerunRes.statusCode}`);

  await sleep(300);

  const runsAfter = readJsonData('runs.json');
  assert(runsAfter.length > runsBefore, 'rerun on non-triaged ticket must create a run');

  console.log('PASS: test 5 — non-triaged failed ticket rerun works');
}

// ── Main ───────────────────────────────────────────────────────────────

async function main() {
  seedCommon();
  server = startServer();
  await waitForReady();

  try {
    await test1BlockedTicketRerunRejected();
    await test2RetryRejectedWhenParentTicketHasTriage();
    await test3StatusPatchToOpenWithTriage();
    await test4ResolvedTriageAllowsRerun();
    await test5NonTriagedRerunWorks();
    console.log('PASS: ticket-triage-rerun-hardening');
  } catch (error) {
    console.error(error.stack || error.message);
    process.exit(1);
  } finally {
    await stop();
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
    fs.rmSync(WORKSPACE_ROOT, { recursive: true, force: true });
  }
}

main();

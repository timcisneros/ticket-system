#!/usr/bin/env node
// Objective clarification gate tests.
//
// Phase 1: direct gate function (pure, no server).
// Phase 2: server integration — ambiguous objective blocks, triage created,
//          no run created, /triage shows item, clear objectives pass through,
//          existing behavior unchanged.

const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const ADMIN_HASH = '$argon2id$v=19$m=65536,t=3,p=4$az+Aa/Vt5AjalPiSGPNdXQ$i+hlbZS1OGPnBIw16HfGY/u0A4VUqXdFkd5Y+JtXh/g';
const T0 = '2026-02-01T00:00:00.000Z';
const DATA_FILES = [
  'agents.json', 'allocation-plans.json', 'events.jsonl', 'groups.json',
  'logs.json', 'memberships.json', 'operation-history.json', 'permissions.json',
  'runs.json', 'tickets.json', 'users.json', 'workflows.json'
];

function assert(c, m) { if (!c) throw new Error(m); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function request(baseUrl, method, urlPath, options = {}) {
  return new Promise((resolve, reject) => {
    const body = options.form ? new URLSearchParams(options.form).toString()
      : options.body ? JSON.stringify(options.body) : null;
    const req = http.request(baseUrl + urlPath, {
      method,
      headers: {
        ...(options.form ? { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) } : {}),
        ...(options.body ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } : {}),
        ...(options.cookie ? { Cookie: options.cookie } : {})
      }
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({
        statusCode: res.statusCode, headers: res.headers,
        body: Buffer.concat(chunks).toString('utf8')
      }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}
function cookieFrom(res) { return (res.headers['set-cookie'] || []).map(c => c.split(';')[0]).join('; '); }

function readJson(dir, file) {
  return JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
}
function writeJson(dir, file, value) {
  fs.writeFileSync(path.join(dir, file), JSON.stringify(value, null, 2));
}

// ── Phase 1: Direct gate function tests ──────────────────────────────────

function phase1GateFunction() {
  const { runObjectiveClarificationGate } = require(path.join(ROOT, 'objective-contract.js'));

  // 1. Ambiguous objective blocks.
  const ambiguous = runObjectiveClarificationGate('Create 3 folders each named Michael Jackson songs');
  assert(ambiguous.verdict === 'ambiguous', `expected ambiguous, got ${ambiguous.verdict}`);
  assert(ambiguous.canExecuteWithoutClarification === false, 'ambiguous must not allow execution without clarification');
  assert(Array.isArray(ambiguous.ambiguityPatterns) && ambiguous.ambiguityPatterns.includes('quantified_generated_folder_names'),
    'ambiguityPatterns must include quantified_generated_folder_names');
  assert(ambiguous.reasonCode === 'objective_ambiguous', 'reasonCode must be objective_ambiguous');
  assert(ambiguous.requiredDecision === 'clarify_objective', 'requiredDecision must be clarify_objective');
  assert(Array.isArray(ambiguous.allowedActions), 'allowedActions must be an array');
  assert(Array.isArray(ambiguous.prohibitedActions), 'prohibitedActions must be an array');

  // 2. Explicit folder names are allowed (recognized deterministic form).
  const explicit = runObjectiveClarificationGate('Create folders Thriller BillieJean BeatIt');
  assert(explicit.verdict === 'clear', `expected clear for explicit names, got ${explicit.verdict}`);
  assert(explicit.canExecuteWithoutClarification === true, 'explicit names must allow execution');

  // 3. Quoted literal names are allowed (no quantified+ambiguous pattern).
  const quoted = runObjectiveClarificationGate('Create folders "Thriller" "Billie Jean" "Beat It"');
  assert(quoted.verdict === 'clear', `expected clear for quoted names, got ${quoted.verdict}`);
  assert(quoted.canExecuteWithoutClarification === true, 'quoted names must allow execution');

  // 4. Singular folder is allowed.
  const singular = runObjectiveClarificationGate('Create folder Michael Jackson songs');
  assert(singular.verdict === 'clear', `expected clear for singular folder, got ${singular.verdict}`);
  assert(singular.canExecuteWithoutClarification === true, 'singular folder must allow execution');

  // 5. Semantic/generated name pattern blocks.
  const semantic = runObjectiveClarificationGate('Create 3 folders named after Michael Jackson songs');
  assert(semantic.verdict === 'ambiguous', `expected ambiguous for semantic names, got ${semantic.verdict}`);
  assert(semantic.canExecuteWithoutClarification === false, 'semantic names must not allow execution without clarification');

  // 6. "each called" variant blocks.
  const eachCalled = runObjectiveClarificationGate('Create 5 folders each called something');
  assert(eachCalled.verdict === 'ambiguous', `expected ambiguous for 'each called', got ${eachCalled.verdict}`);

  // 7. Workflow-mode ticket always returns clear.
  const workflow = runObjectiveClarificationGate('Create 3 folders each named Michael Jackson songs', { executionMode: 'workflow' });
  assert(workflow.verdict === 'clear', `expected clear for workflow mode, got ${workflow.verdict}`);
  assert(workflow.canExecuteWithoutClarification === true, 'workflow mode must allow execution');

  // 8. Empty objective returns clear.
  const empty = runObjectiveClarificationGate('');
  assert(empty.verdict === 'clear', `expected clear for empty objective, got ${empty.verdict}`);

  // 9. Null objective returns clear.
  const nullObj = runObjectiveClarificationGate(null);
  assert(nullObj.verdict === 'clear', `expected clear for null objective, got ${nullObj.verdict}`);

  // 10. Simple delete objective is clear.
  const del = runObjectiveClarificationGate('delete folder someFolder');
  assert(del.verdict === 'clear', `expected clear for delete objective, got ${del.verdict}`);

  // ── New quantified category folder blocking patterns ──

  // 11. "Create 3 Michael Jackson songs folders" → ambiguous (false negative fix).
  const mj = runObjectiveClarificationGate('Create 3 Michael Jackson songs folders');
  assert(mj.verdict === 'ambiguous', `expected ambiguous for 'Create 3 Michael Jackson songs folders', got ${mj.verdict}`);
  assert(mj.canExecuteWithoutClarification === false, 'Michael Jackson songs folders must not allow execution without clarification');
  assert(mj.ambiguityPatterns.includes('quantified_category_folder_creation'),
    `must include quantified_category_folder_creation pattern, got ${JSON.stringify(mj.ambiguityPatterns)}`);

  // 12. "Create 3 Beatles albums folders" → ambiguous (same category).
  const beatles = runObjectiveClarificationGate('Create 3 Beatles albums folders');
  assert(beatles.verdict === 'ambiguous', `expected ambiguous for 'Create 3 Beatles albums folders', got ${beatles.verdict}`);
  assert(beatles.canExecuteWithoutClarification === false, 'Beatles albums folders must not allow execution without clarification');
  assert(beatles.ambiguityPatterns.includes('quantified_category_folder_creation'),
    `must include quantified_category_folder_creation pattern, got ${JSON.stringify(beatles.ambiguityPatterns)}`);

  // 13. "Create folder Michael Jackson songs" → still clear (singular, no count).
  const singular2 = runObjectiveClarificationGate('Create folder Michael Jackson songs');
  assert(singular2.verdict === 'clear', `expected clear for singular folder, got ${singular2.verdict}`);

  // 14. "Create 3 Michael Jackson songs files" → ambiguous (files variant).
  const files = runObjectiveClarificationGate('Create 3 Michael Jackson songs files');
  assert(files.verdict === 'ambiguous', `expected ambiguous for files variant, got ${files.verdict}`);

  // ── Existing cases still passing ──

  // 15. Existing blocked examples still ambiguous.
  const existingAmbiguous = runObjectiveClarificationGate('Create 3 folders each named Michael Jackson songs');
  assert(existingAmbiguous.verdict === 'ambiguous', `existing blocked example must still be ambiguous, got ${existingAmbiguous.verdict}`);

  // 16. Existing allowed examples still clear.
  const existingExplicit = runObjectiveClarificationGate('Create folders Thriller BillieJean BeatIt');
  assert(existingExplicit.verdict === 'clear', `existing allowed example must still be clear, got ${existingExplicit.verdict}`);
  const existingQuoted = runObjectiveClarificationGate('Create folders "Thriller" "Billie Jean" "Beat It"');
  assert(existingQuoted.verdict === 'clear', `existing quoted example must still be clear, got ${existingQuoted.verdict}`);
  const existingWorkflow = runObjectiveClarificationGate('Create 3 folders each named Michael Jackson songs', { executionMode: 'workflow' });
  assert(existingWorkflow.verdict === 'clear', `workflow mode must still be clear, got ${existingWorkflow.verdict}`);

  console.log('PASS: phase 1 — gate function pure tests');
}

// ── Phase 2: Server integration tests ────────────────────────────────────

function seedCommon(dataDir) {
  fs.mkdirSync(path.join(dataDir, 'replay-snapshots'), { recursive: true });
  writeJson(dataDir, 'users.json', [
    { id: 1, username: 'admin', passwordHash: ADMIN_HASH, createdAt: T0, type: 'user' },
    { id: 2, username: 'viewer', passwordHash: ADMIN_HASH, createdAt: T0, type: 'user' }
  ]);
  writeJson(dataDir, 'permissions.json', ['ticket:create', 'ticket:read', 'ticket:update', 'user:read']);
  writeJson(dataDir, 'groups.json', [
    { id: 1, name: 'Admins', permissions: ['ticket:create', 'ticket:read', 'ticket:update', 'user:read'], canReceiveTickets: false }
  ]);
  writeJson(dataDir, 'memberships.json', [
    { id: 1, principalType: 'user', principalId: 1, groupId: 1 },
    { id: 2, principalType: 'user', principalId: 2, groupId: 1 }
  ]);
  writeJson(dataDir, 'agents.json', [
    { id: 1, name: 'Test Agent', type: 'agent', provider: 'openai', model: 'gpt-test', apiKey: 'k', createdAt: T0, updatedAt: T0 }
  ]);
  writeJson(dataDir, 'workflows.json', []);
  writeJson(dataDir, 'allocation-plans.json', []);
  writeJson(dataDir, 'operation-history.json', []);
  writeJson(dataDir, 'logs.json', []);
  fs.writeFileSync(path.join(dataDir, 'events.jsonl'), '');
}

function startServer(dataDir, workspaceRoot, port) {
  const proc = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env, NODE_ENV: 'test', PORT: String(port),
      DATA_DIR: dataDir, WORKSPACE_ROOT: workspaceRoot,
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

function waitForReady(baseUrl, proc, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const poll = () => {
      if (proc.exitCode !== null) return reject(new Error('server exited early:\n' + proc.getOutput()));
      http.get(baseUrl + '/api/health', res => {
        res.resume();
        res.statusCode === 200 ? resolve() : (Date.now() > deadline ? reject(new Error('timeout')) : setTimeout(poll, 200));
      }).on('error', () => Date.now() > deadline ? reject(new Error('timeout')) : setTimeout(poll, 200));
    };
    setTimeout(poll, 400);
  });
}

async function stop(proc) {
  if (!proc) return;
  proc.kill('SIGTERM');
  await sleep(400);
  if (proc.exitCode === null) proc.kill('SIGKILL');
}

async function login(baseUrl) {
  const res = await request(baseUrl, 'POST', '/login', { form: { username: 'admin', password: 'admin123' } });
  assert(res.statusCode === 302, `admin login failed HTTP ${res.statusCode}`);
  return cookieFrom(res);
}

async function phase2AmbiguousBlocksBeforeRun() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'objective-gate-data-'));
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'objective-gate-ws-'));
  const port = 3510;
  const baseUrl = 'http://127.0.0.1:' + port;
  let server = null;

  try {
    seedCommon(dataDir);
    server = startServer(dataDir, workspaceRoot, port);
    await waitForReady(baseUrl, server);

    const cookie = await login(baseUrl);

    // Record state before creating the ambiguous ticket.
    const ticketsBefore = fs.readFileSync(path.join(dataDir, 'tickets.json'), 'utf8');
    const runsBefore = readJson(dataDir, 'runs.json');
    const opsBefore = readJson(dataDir, 'operation-history.json');
    const workspaceBefore = fs.existsSync(workspaceRoot) ? fs.readdirSync(workspaceRoot) : [];

    // Create a ticket with an ambiguous objective.
    const response = await request(baseUrl, 'POST', '/tickets', {
      cookie,
      form: {
        objective: 'Create 3 folders each named Michael Jackson songs',
        assignmentTargetType: 'agent',
        assignmentTargetId: '1'
      }
    });
    assert(response.statusCode === 302, `Ambiguous ticket create failed HTTP ${response.statusCode}`);

    // Allow event loop to process.
    await sleep(300);

    // 1. Ticket is blocked with triage.
    const tickets = readJson(dataDir, 'tickets.json');
    const blockedTicket = tickets.find(t => t.objective === 'Create 3 folders each named Michael Jackson songs');
    assert(blockedTicket, 'Blocked ticket must be persisted');
    assert(blockedTicket.status === 'blocked', `Ticket should be blocked, got ${blockedTicket.status}`);
    assert(blockedTicket.triage && blockedTicket.triage.required === true,
      'Blocked ticket must have required triage');
    assert(blockedTicket.triage.reasonCode === 'objective_ambiguous',
      `Triage reasonCode must be objective_ambiguous, got ${blockedTicket.triage.reasonCode}`);
    assert(blockedTicket.triage.requiredDecision === 'clarify_objective',
      `Triage requiredDecision must be clarify_objective, got ${blockedTicket.triage.requiredDecision}`);
    assert(!blockedTicket.blockedReason || blockedTicket.blockedReason.length > 0,
      'Blocked ticket should have a blockedReason');

    // 2. No run was created.
    const runs = readJson(dataDir, 'runs.json');
    assert(runs.length === runsBefore.length,
      `No runs should be created (before: ${runsBefore.length}, after: ${runs.length})`);

    // 3. No operation-history entries.
    const ops = readJson(dataDir, 'operation-history.json');
    assert(ops.length === opsBefore.length,
      `No operation-history entries should be added (before: ${opsBefore.length}, after: ${ops.length})`);

    // 4. Workspace unchanged.
    const workspaceAfter = fs.existsSync(workspaceRoot) ? fs.readdirSync(workspaceRoot) : [];
    assert(workspaceAfter.length === workspaceBefore.length,
      `Workspace should be unchanged (before: ${workspaceBefore.length} entries, after: ${workspaceAfter.length})`);

    // 5. Ticket detail shows triage.
    const ticketPage = await request(baseUrl, 'GET', `/tickets/${blockedTicket.id}`, { cookie });
    assert(ticketPage.statusCode === 200, `Ticket detail failed HTTP ${ticketPage.statusCode}`);
    assert(ticketPage.body.includes('Ticket-Level Triage'), 'Ticket detail must show triage section');
    assert(ticketPage.body.includes('objective_ambiguous'), 'Ticket detail must show reason code');

    // 6. /inbox surfaces the blocker thread.
    const triagePage = await request(baseUrl, 'GET', '/inbox', { cookie });
    assert(triagePage.statusCode === 200, `Inbox page failed HTTP ${triagePage.statusCode}`);
    assert(triagePage.body.includes('objective_ambiguous'), 'Inbox must show objective_ambiguous reasonCode');
    assert(triagePage.body.includes('clarify_objective'), 'Inbox must show clarify_objective requiredDecision');
    assert(triagePage.body.includes(`"ticketId":${blockedTicket.id},`), 'Inbox must carry the blocked ticket thread');

    // 7. Blocked ticket cannot be manually completed.
    const completeAttempt = await request(baseUrl, 'PATCH', `/api/tickets/${blockedTicket.id}/status`, {
      cookie,
      body: { status: 'completed' }
    });
    assert(completeAttempt.statusCode === 409,
      `Blocked ticket must reject manual completion, got ${completeAttempt.statusCode}`);
    const errBody = JSON.parse(completeAttempt.body);
    assert(errBody.error && errBody.error.includes('ticket-level triage'),
      'Completion rejection must reference required ticket-level triage');

    console.log('PASS: phase 2 — ambiguous objective blocks before run');
  } finally {
    await stop(server);
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
}

async function phase3ClearObjectivePassesThrough() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'objective-gate-clear-data-'));
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'objective-gate-clear-ws-'));
  const port = 3511;
  const baseUrl = 'http://127.0.0.1:' + port;
  let server = null;

  try {
    seedCommon(dataDir);
    server = startServer(dataDir, workspaceRoot, port);
    await waitForReady(baseUrl, server);
    const cookie = await login(baseUrl);

    // Create ticket with explicit folder names (should pass through).
    const response = await request(baseUrl, 'POST', '/tickets', {
      cookie,
      form: {
        objective: 'Create folders Thriller BillieJean BeatIt',
        assignmentTargetType: 'agent',
        assignmentTargetId: '1'
      }
    });
    assert(response.statusCode === 302, `Clear ticket create failed HTTP ${response.statusCode}`);
    await sleep(300);

    const tickets = readJson(dataDir, 'tickets.json');
    const clearTicket = tickets.find(t => t.objective === 'Create folders Thriller BillieJean BeatIt');
    assert(clearTicket, 'Clear ticket must be persisted');

    // Ticket should NOT be blocked.
    assert(clearTicket.status !== 'blocked',
      `Clear ticket should not be blocked, got ${clearTicket.status}`);

    // A run should be created (pending status).
    const runs = readJson(dataDir, 'runs.json');
    const ticketRuns = runs.filter(r => r.ticketId === clearTicket.id);
    assert(ticketRuns.length > 0,
      'Clear ticket should have at least one run created');

    // No triage should be present.
    assert(!clearTicket.triage || !clearTicket.triage.required,
      'Clear ticket should not have required triage');

    console.log('PASS: phase 3 — clear objective creates run normally');
  } finally {
    await stop(server);
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
}

async function phase4ExistingTriageAndWorkflowUnchanged() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'objective-gate-regression-data-'));
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'objective-gate-regression-ws-'));
  const port = 3512;
  const baseUrl = 'http://127.0.0.1:' + port;
  let server = null;

  try {
    seedCommon(dataDir);

    // Seed a ticket with existing authority_blocked triage.
    const existingTriageTicket = {
      id: 10, objective: 'Quarter report for Q1',
      assignmentTargetType: 'agent', assignmentTargetId: 1, assignmentMode: 'individual',
      ownedOutputPaths: null, executionMode: 'agent', workflowId: null, workflowInput: null,
      capabilityType: 'directAction', capabilityId: 'agent-selected-actions', capabilityInput: null,
      executionPolicy: { maxAttempts: null },
      status: 'blocked',
      triage: {
        required: true, reasonCode: 'authority_blocked', summary: 'Existing authority blocked',
        requiredDecision: 'change_scope', evidenceRefs: ['event:ticket.blocked'],
        allowedActions: ['review', 'edit_ticket'], prohibitedActions: ['start_run_without_scope_change'],
        createdAt: T0, resolvedAt: null, resolvedBy: null, resolution: null
      },
      createdBy: 'admin', changedBy: 'admin', changedAt: T0, createdAt: T0, updatedAt: T0
    };
    writeJson(dataDir, 'tickets.json', [existingTriageTicket]);

    server = startServer(dataDir, workspaceRoot, port);
    await waitForReady(baseUrl, server);
    const cookie = await login(baseUrl);

    // Verify existing authority_blocked triage still renders correctly.
    const triagePage = await request(baseUrl, 'GET', '/inbox', { cookie });
    assert(triagePage.statusCode === 200, `Inbox page failed HTTP ${triagePage.statusCode}`);
    assert(triagePage.body.includes('authority_blocked'),
      'Existing authority_blocked triage must still appear');
    assert(triagePage.body.includes('change_scope'),
      'Existing authority_blocked triage must show requiredDecision');
    assert(!triagePage.body.includes('No unresolved triage.'),
      'Triage page should not be empty when unresolved triage exists');

    // Verify existing triage resolution still works.
    const resolveResponse = await request(baseUrl, 'POST', `/api/tickets/10/triage/resolve`, {
      cookie,
      body: { resolvedBy: 'admin', resolution: 'test resolution' }
    });
    assert(resolveResponse.statusCode === 200,
      `Triage resolution should succeed, got ${resolveResponse.statusCode}`);

    console.log('PASS: phase 4 — existing triage and workflow behavior unchanged');
  } finally {
    await stop(server);
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
}

async function phase5QuantifiedCategoryAmbiguousBlocksBeforeRun() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'objective-gate-cat-data-'));
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'objective-gate-cat-ws-'));
  const port = 3513;
  const baseUrl = 'http://127.0.0.1:' + port;
  let server = null;

  try {
    seedCommon(dataDir);
    server = startServer(dataDir, workspaceRoot, port);
    await waitForReady(baseUrl, server);

    const cookie = await login(baseUrl);

    const runsBefore = readJson(dataDir, 'runs.json');
    const opsBefore = readJson(dataDir, 'operation-history.json');
    const workspaceBefore = fs.existsSync(workspaceRoot) ? fs.readdirSync(workspaceRoot) : [];

    // Create ticket with quantified category folder objective.
    const response = await request(baseUrl, 'POST', '/tickets', {
      cookie,
      form: {
        objective: 'Create 3 Michael Jackson songs folders',
        assignmentTargetType: 'agent',
        assignmentTargetId: '1'
      }
    });
    assert(response.statusCode === 302, `Quantified category ticket create failed HTTP ${response.statusCode}`);

    await sleep(300);

    // 1. Ticket is blocked with triage.
    const tickets = readJson(dataDir, 'tickets.json');
    const blockedTicket = tickets.find(t => t.objective === 'Create 3 Michael Jackson songs folders');
    assert(blockedTicket, 'Blocked ticket must be persisted');
    assert(blockedTicket.status === 'blocked', `Ticket should be blocked, got ${blockedTicket.status}`);
    assert(blockedTicket.triage && blockedTicket.triage.required === true,
      'Blocked ticket must have required triage');
    assert(blockedTicket.triage.reasonCode === 'objective_ambiguous',
      `Triage reasonCode must be objective_ambiguous, got ${blockedTicket.triage.reasonCode}`);
    assert(blockedTicket.triage.requiredDecision === 'clarify_objective',
      `Triage requiredDecision must be clarify_objective, got ${blockedTicket.triage.requiredDecision}`);

    // 2. No run was created.
    const runs = readJson(dataDir, 'runs.json');
    assert(runs.length === runsBefore.length,
      `No runs should be created (before: ${runsBefore.length}, after: ${runs.length})`);

    // 3. No operation-history entries.
    const ops = readJson(dataDir, 'operation-history.json');
    assert(ops.length === opsBefore.length,
      `No operation-history entries should be added (before: ${opsBefore.length}, after: ${ops.length})`);

    // 4. Workspace unchanged.
    const workspaceAfter = fs.existsSync(workspaceRoot) ? fs.readdirSync(workspaceRoot) : [];
    assert(workspaceAfter.length === workspaceBefore.length,
      `Workspace should be unchanged (before: ${workspaceBefore.length} entries, after: ${workspaceAfter.length})`);

    // 5. Ticket detail shows triage.
    const ticketPage = await request(baseUrl, 'GET', `/tickets/${blockedTicket.id}`, { cookie });
    assert(ticketPage.statusCode === 200, `Ticket detail failed HTTP ${ticketPage.statusCode}`);
    assert(ticketPage.body.includes('Ticket-Level Triage'), 'Ticket detail must show triage section');

    // 6. /inbox shows the item.
    const triagePage = await request(baseUrl, 'GET', '/inbox', { cookie });
    assert(triagePage.statusCode === 200, `Inbox page failed HTTP ${triagePage.statusCode}`);
    assert(triagePage.body.includes('objective_ambiguous'), 'Inbox must show objective_ambiguous');
    assert(triagePage.body.includes(`"ticketId":${blockedTicket.id},`), 'Inbox must carry the blocked ticket thread');

    console.log('PASS: phase 5 — quantified category ambiguous blocks before run');
  } finally {
    await stop(server);
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
}

async function main() {
  phase1GateFunction();
  await phase2AmbiguousBlocksBeforeRun();
  await phase3ClearObjectivePassesThrough();
  await phase4ExistingTriageAndWorkflowUnchanged();
  await phase5QuantifiedCategoryAmbiguousBlocksBeforeRun();
  console.log('PASS: objective clarification gate');
}

main().catch(error => {
  console.error(error.stack || error.message);
  process.exit(1);
});

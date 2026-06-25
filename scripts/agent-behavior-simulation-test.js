#!/usr/bin/env node
// Agent behavior simulation harness tests.
//
// Phase 1: Permission checks (gate-only vs model-plan).
// Phase 2: Gate-only simulation (no model call, returns gate verdict).
// Phase 3: Model-plan simulation with a real agent (calls model, parses,
//          validates, no run/workspace mutation, no event logging beyond system log).
// Phase 4: No production run created, no workspace mutation.
// Phase 5: Regression — existing routes still work.

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
    { id: 1, name: 'Test Agent', type: 'agent', provider: 'openai', model: 'gpt-test', apiKey: 'sk-test', createdAt: T0, updatedAt: T0 }
  ]);
  writeJson(dataDir, 'workflows.json', []);
  writeJson(dataDir, 'allocation-plans.json', []);
  writeJson(dataDir, 'operation-history.json', []);
  writeJson(dataDir, 'logs.json', []);
  writeJson(dataDir, 'runs.json', []);
  fs.writeFileSync(path.join(dataDir, 'events.jsonl'), '');
}

function seedTicket(dataDir, overrides = {}) {
  const ticket = {
    id: 100,
    objective: 'Create folders reports notes',
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
    executionPolicy: { maxAttempts: null },
    status: 'open',
    triage: null,
    createdBy: 'admin',
    changedBy: 'admin',
    changedAt: T0,
    createdAt: T0,
    updatedAt: T0,
    ...overrides
  };
  writeJson(dataDir, 'tickets.json', [ticket]);
  return ticket;
}

function startServer(dataDir, workspaceRoot, port) {
  const proc = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env, NODE_ENV: 'test', PORT: String(port),
      DATA_DIR: dataDir, WORKSPACE_ROOT: workspaceRoot,
      RUNTIME_SCHEDULER_INTERVAL_MS: '3600000',
      OPENAI_API_KEY: 'sk-test', OPENAI_MODEL: 'gpt-test'
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

async function loginAdmin(baseUrl) {
  const res = await request(baseUrl, 'POST', '/login', { form: { username: 'admin', password: 'admin123' } });
  assert(res.statusCode === 302, `admin login failed HTTP ${res.statusCode}`);
  return cookieFrom(res);
}

// ── Phase 1: Permission checks ─────────────────────────────────────────

async function phase1PermissionChecks() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sim-perm-data-'));
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sim-perm-ws-'));
  const port = 3581;
  const baseUrl = 'http://127.0.0.1:' + port;
  let server = null;

  try {
    seedCommon(dataDir);
    // Override viewer to have only ticket:read (not ticket:update).
    writeJson(dataDir, 'memberships.json', [
      { id: 1, principalType: 'user', principalId: 1, groupId: 1 }
    ]);
    writeJson(dataDir, 'groups.json', [
      { id: 1, name: 'Admins', permissions: ['ticket:create', 'ticket:read', 'ticket:update', 'user:read'], canReceiveTickets: false },
      { id: 2, name: 'Viewers', permissions: ['ticket:read'], canReceiveTickets: false }
    ]);
    writeJson(dataDir, 'memberships.json', [
      { id: 1, principalType: 'user', principalId: 1, groupId: 1 },
      { id: 2, principalType: 'user', principalId: 2, groupId: 2 }
    ]);
    seedTicket(dataDir);
    server = startServer(dataDir, workspaceRoot, port);
    await waitForReady(baseUrl, server);

    // Login as viewer (ticket:read but NOT ticket:update).
    const viewRes = await request(baseUrl, 'POST', '/login', { form: { username: 'viewer', password: 'admin123' } });
    assert(viewRes.statusCode === 302, 'viewer login failed');
    const viewerCookie = cookieFrom(viewRes);

    // Gate-only (includeModelPlan=false) uses ticket:read → viewer should succeed.
    const gateRes = await request(baseUrl, 'POST', '/api/tickets/100/simulate-plan', {
      cookie: viewerCookie,
      body: { includeModelPlan: false }
    });
    const gateBody = JSON.parse(gateRes.body);
    assert(gateRes.statusCode === 200,
      `Gate-only should succeed for viewer, got HTTP ${gateRes.statusCode}: ${gateRes.body}`);

    // Model-plan (includeModelPlan=true) uses ticket:update → viewer should be denied.
    const modelRes = await request(baseUrl, 'POST', '/api/tickets/100/simulate-plan', {
      cookie: viewerCookie,
      body: { includeModelPlan: true }
    });
    assert(modelRes.statusCode === 403,
      `Model-plan should be denied for viewer, got HTTP ${modelRes.statusCode}`);

    // Admin should succeed at both.
    const adminCookie = await loginAdmin(baseUrl);
    const adminGate = await request(baseUrl, 'POST', '/api/tickets/100/simulate-plan', {
      cookie: adminCookie,
      body: { includeModelPlan: false }
    });
    assert(adminGate.statusCode === 200,
      `Admin gate-only should succeed, got HTTP ${adminGate.statusCode}`);

    const adminModel = await request(baseUrl, 'POST', '/api/tickets/100/simulate-plan', {
      cookie: adminCookie,
      body: { includeModelPlan: true }
    });
    assert(adminModel.statusCode === 200,
      `Admin model-plan should succeed, got HTTP ${adminModel.statusCode}: ${adminModel.body}`);

    console.log('PASS: phase 1 — permission checks');
  } finally {
    await stop(server);
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
}

// ── Phase 2: Gate-only simulation ──────────────────────────────────────

async function phase2GateOnlySimulation() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sim-gate-data-'));
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sim-gate-ws-'));
  const port = 3582;
  const baseUrl = 'http://127.0.0.1:' + port;
  let server = null;

  try {
    seedCommon(dataDir);
    seedTicket(dataDir);
    server = startServer(dataDir, workspaceRoot, port);
    await waitForReady(baseUrl, server);
    const cookie = await loginAdmin(baseUrl);

    // Gate-only simulation for a clear objective.
    const res = await request(baseUrl, 'POST', '/api/tickets/100/simulate-plan', {
      cookie,
      body: { includeModelPlan: false }
    });
    const body = JSON.parse(res.body);
    assert(res.statusCode === 200, `Gate-only should succeed, got HTTP ${res.statusCode}`);
    assert(body.ticketId === 100, 'ticketId must match');
    assert(body.objective === 'Create folders reports notes', 'objective must match');
    assert(body.gateVerdict === 'clear', `expected gateVerdict 'clear', got ${body.gateVerdict}`);
    assert(body.modelCalled === false, 'gate-only must not call model');
    assert(body.productionRunCreated === false, 'no production run created');
    assert(body.workspaceMutated === false, 'no workspace mutation');
    assert(body.actionsExecuted === 0, 'no actions executed');
    assert(Array.isArray(body.actionsProposed), 'actionsProposed must be an array');
    assert(body.actionsProposed.length === 0, 'no actions proposed in gate-only');
    assert(Array.isArray(body.validationFindings), 'validationFindings must be an array');

    // Verify no runs were created.
    const runs = readJson(dataDir, 'runs.json');
    assert(runs.length === 0, 'No runs should exist after gate-only simulation');

    // Verify no operation-history entries.
    const ops = readJson(dataDir, 'operation-history.json');
    assert(ops.length === 0, 'No operation-history should exist');

    // Verify workspace unchanged.
    const wsEntries = fs.readdirSync(workspaceRoot);
    assert(wsEntries.length === 0, 'Workspace should be empty');

    // Verify a system log entry was created with full shape.
    const logs = readJson(dataDir, 'logs.json');
    const simLog = logs.find(l => l.type === 'ticket:simulation_plan');
    assert(simLog, 'A system log entry of type ticket:simulation_plan must exist');
    assert(simLog.message.includes('gate only'), 'Log message must indicate gate-only mode');
    assert(simLog.contextTicketId === 100, 'Log must reference the correct ticket');
    assert(simLog.gateVerdict === 'clear', 'Log must include gateVerdict');
    assert(simLog.modelCalled === false, 'Log must include modelCalled');
    assert(simLog.productionRunCreated === false, 'Log must include productionRunCreated: false');
    assert(simLog.workspaceMutated === false, 'Log must include workspaceMutated: false');
    assert(simLog.actionsExecuted === 0, 'Log must include actionsExecuted: 0');
    assert(simLog.actionsProposed === 0, 'Log must include actionsProposed count');
    assert(simLog.validationFindings === 0, 'Log must include validationFindings count');

    console.log('PASS: phase 2 — gate-only simulation');
  } finally {
    await stop(server);
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
}

// ── Phase 3: Ambiguous objective gate-only ─────────────────────────────

async function phase3AmbiguousGateOnly() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sim-ambig-data-'));
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sim-ambig-ws-'));
  const port = 3583;
  const baseUrl = 'http://127.0.0.1:' + port;
  let server = null;

  try {
    seedCommon(dataDir);
    seedTicket(dataDir, {
      objective: 'Create 3 folders each named Michael Jackson songs',
      status: 'blocked',
      triage: {
        required: true,
        reasonCode: 'objective_ambiguous',
        requiredDecision: 'clarify_objective',
        summary: 'The objective asks to create a specific number of folders with generated names...',
        ambiguityPatterns: ['quantified_generated_folder_names'],
        allowedActions: ['edit_objective', 'clarify_ticket'],
        prohibitedActions: ['mutate_workspace_without_clarification', 'start_run_without_clarification'],
        createdAt: T0, resolvedAt: null, resolvedBy: null, resolution: null
      },
      blockedReason: 'Objective is ambiguous: requires clarification before execution'
    });
    server = startServer(dataDir, workspaceRoot, port);
    await waitForReady(baseUrl, server);
    const cookie = await loginAdmin(baseUrl);

    // By default runObjectiveClarificationGate re-evaluates the objective string,
    // not the stored triage. For a simulated ambiguous objective the gate
    // should return its live verdict from the objective string.
    const res = await request(baseUrl, 'POST', '/api/tickets/100/simulate-plan', {
      cookie,
      body: { includeModelPlan: false }
    });
    const body = JSON.parse(res.body);
    assert(res.statusCode === 200, `Ambiguous gate-only should succeed, got HTTP ${res.statusCode}`);
    assert(body.gateVerdict === 'ambiguous',
      `expected gateVerdict 'ambiguous', got ${body.gateVerdict}`);
    assert(body.reasonCode === 'objective_ambiguous', 'reasonCode must be objective_ambiguous');
    assert(body.requiredDecision === 'clarify_objective', 'requiredDecision must be clarify_objective');
    assert(body.modelCalled === false, 'gate-only must not call model');
    assert(body.productionRunCreated === false, 'no production run created');

    // Verify no new runs were created.
    const runs = readJson(dataDir, 'runs.json');
    assert(runs.length === 0, 'No runs should exist after ambiguous gate-only simulation');

    console.log('PASS: phase 3 — ambiguous objective gate-only');
  } finally {
    await stop(server);
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
}

// ── Phase 4: Invalid ticket id ─────────────────────────────────────────

async function phase4InvalidTicketId() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sim-invalid-data-'));
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sim-invalid-ws-'));
  const port = 3584;
  const baseUrl = 'http://127.0.0.1:' + port;
  let server = null;

  try {
    seedCommon(dataDir);
    server = startServer(dataDir, workspaceRoot, port);
    await waitForReady(baseUrl, server);
    const cookie = await loginAdmin(baseUrl);

    // Non-numeric id.
    const badId = await request(baseUrl, 'POST', '/api/tickets/abc/simulate-plan', {
      cookie,
      body: { includeModelPlan: false }
    });
    assert(badId.statusCode === 400, `Non-numeric id should return 400, got ${badId.statusCode}`);

    // Non-existent ticket id.
    const missing = await request(baseUrl, 'POST', '/api/tickets/9999/simulate-plan', {
      cookie,
      body: { includeModelPlan: false }
    });
    assert(missing.statusCode === 404, `Missing ticket should return 404, got ${missing.statusCode}`);

    console.log('PASS: phase 4 — invalid ticket id handling');
  } finally {
    await stop(server);
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
}

// ── Phase 5: No production run or workspace mutation side effects ──────

async function phase5NoSideEffects() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sim-side-data-'));
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sim-side-ws-'));
  const port = 3585;
  const baseUrl = 'http://127.0.0.1:' + port;
  let server = null;

  try {
    seedCommon(dataDir);
    seedTicket(dataDir);
    server = startServer(dataDir, workspaceRoot, port);
    await waitForReady(baseUrl, server);
    const cookie = await loginAdmin(baseUrl);

    // Capture baseline.
    const runsBefore = readJson(dataDir, 'runs.json').length;
    const opsBefore = readJson(dataDir, 'operation-history.json').length;
    const wsBefore = fs.existsSync(workspaceRoot) ? fs.readdirSync(workspaceRoot).length : 0;
    const eventsBefore = fs.readFileSync(path.join(dataDir, 'events.jsonl'), 'utf8').trim().length;
    const ticketsBefore = readJson(dataDir, 'tickets.json');

    // Run gate-only simulation.
    const gateRes = await request(baseUrl, 'POST', '/api/tickets/100/simulate-plan', {
      cookie,
      body: { includeModelPlan: false }
    });
    const gateBody = JSON.parse(gateRes.body);
    assert(gateRes.statusCode === 200, `Gate-only should succeed, got HTTP ${gateRes.statusCode}`);

    // Run model-plan simulation (will fail to reach model since no real API key,
    // but should not create side effects).
    const modelRes = await request(baseUrl, 'POST', '/api/tickets/100/simulate-plan', {
      cookie,
      body: { includeModelPlan: true }
    });
    const modelBody = JSON.parse(modelRes.body);
    assert(modelRes.statusCode === 200,
      `Model-plan should return 200 even on model error, got HTTP ${modelRes.statusCode}: ${modelRes.body}`);

    // After both simulations:
    // 1. No new runs.
    const runsAfter = readJson(dataDir, 'runs.json');
    assert(runsAfter.length === runsBefore,
      `No runs should be created (before: ${runsBefore}, after: ${runsAfter.length})`);

    // 2. No operation-history entries.
    const opsAfter = readJson(dataDir, 'operation-history.json');
    assert(opsAfter.length === opsBefore,
      `No operation-history entries should be added (before: ${opsBefore}, after: ${opsAfter.length})`);

    // 3. Workspace unchanged.
    const wsAfter = fs.existsSync(workspaceRoot) ? fs.readdirSync(workspaceRoot).length : 0;
    assert(wsAfter === wsBefore,
      `Workspace should be unchanged (before: ${wsBefore}, after: ${wsAfter})`);

    // 4. Events file unchanged.
    const eventsAfter = fs.readFileSync(path.join(dataDir, 'events.jsonl'), 'utf8').trim().length;
    assert(eventsAfter === eventsBefore,
      `Events file should be unchanged (before: ${eventsBefore} chars, after: ${eventsAfter})`);

    // 5. Tickets unchanged (except system log which is in logs.json, not tickets).
    const ticketsAfter = readJson(dataDir, 'tickets.json');
    assert(JSON.stringify(ticketsAfter) === JSON.stringify(ticketsBefore),
      'Tickets should be unchanged after simulation');

    // 6. System log entries were created for both simulations.
    const logs = readJson(dataDir, 'logs.json');
    const simLogs = logs.filter(l => l.type === 'ticket:simulation_plan');
    assert(simLogs.length >= 2, `At least 2 simulation logs expected, got ${simLogs.length}`);

    // Validate log shape on both.
    simLogs.forEach((log, idx) => {
      assert(log.contextTicketId === 100, `Log ${idx} must have contextTicketId`);
      assert(log.gateVerdict !== undefined, `Log ${idx} must have gateVerdict`);
      assert(log.modelCalled !== undefined, `Log ${idx} must have modelCalled`);
      assert(log.productionRunCreated === false, `Log ${idx} must have productionRunCreated: false`);
      assert(log.workspaceMutated === false, `Log ${idx} must have workspaceMutated: false`);
      assert(log.actionsExecuted === 0, `Log ${idx} must have actionsExecuted: 0`);
      assert(typeof log.actionsProposed === 'number', `Log ${idx} must have actionsProposed count`);
      assert(typeof log.validationFindings === 'number', `Log ${idx} must have validationFindings count`);
    });

    console.log('PASS: phase 5 — no production run or workspace mutation side effects');
  } finally {
    await stop(server);
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
}

// ── Phase 6: Model-plan with model call ────────────────────────────────

async function phase6ModelPlanWithModelCall() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sim-model-data-'));
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sim-model-ws-'));
  const port = 3586;
  const baseUrl = 'http://127.0.0.1:' + port;
  let server = null;

  try {
    seedCommon(dataDir);
    seedTicket(dataDir);
    server = startServer(dataDir, workspaceRoot, port);
    await waitForReady(baseUrl, server);
    const cookie = await loginAdmin(baseUrl);

    // Model-plan will attempt to call the model. Since the agent config uses
    // openai with sk-test and gpt-test, the call will fail with a transport
    // error (no real API). The response should still return 200 with modelError set.
    const runsBefore = readJson(dataDir, 'runs.json').length;
    const wsBefore = fs.existsSync(workspaceRoot) ? fs.readdirSync(workspaceRoot).length : 0;

    const res = await request(baseUrl, 'POST', '/api/tickets/100/simulate-plan', {
      cookie,
      body: { includeModelPlan: true }
    });
    const body = JSON.parse(res.body);
    assert(res.statusCode === 200,
      `Model-plan should return 200, got HTTP ${res.statusCode}: ${res.body}`);

    // The model call will fail because sk-test is not a real key. The response
    // should indicate the model was called but an error occurred.
    assert(body.modelCalled === true,
      `modelCalled should be true, got ${body.modelCalled}`);
    assert(body.modelError || body.parseError || body.rawModelResponse !== undefined,
      'Model-plan should either have modelError, parseError, or rawModelResponse');

    // No side effects.
    const runsAfter = readJson(dataDir, 'runs.json');
    assert(runsAfter.length === runsBefore,
      `No runs should be created (before: ${runsBefore}, after: ${runsAfter.length})`);
    const wsAfter = fs.existsSync(workspaceRoot) ? fs.readdirSync(workspaceRoot).length : 0;
    assert(wsAfter === wsBefore,
      `Workspace should be unchanged (before: ${wsBefore}, after: ${wsAfter})`);

    console.log('PASS: phase 6 — model-plan with model call (expected transport error)');
  } finally {
    await stop(server);
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
}

// ── Phase 7: Regression — existing routes still work ──────────────────

async function phase7Regression() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sim-regr-data-'));
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sim-regr-ws-'));
  const port = 3587;
  const baseUrl = 'http://127.0.0.1:' + port;
  let server = null;

  try {
    seedCommon(dataDir);
    seedTicket(dataDir);
    server = startServer(dataDir, workspaceRoot, port);
    await waitForReady(baseUrl, server);
    const cookie = await loginAdmin(baseUrl);

    // 1. Ticket create still works.
    const createRes = await request(baseUrl, 'POST', '/tickets', {
      cookie,
      form: {
        objective: 'Test regression',
        assignmentTargetType: 'agent',
        assignmentTargetId: '1'
      }
    });
    assert(createRes.statusCode === 302, `Ticket create should work, got HTTP ${createRes.statusCode}`);

    await sleep(300);

    // 2. Ticket list still works.
    const listRes = await request(baseUrl, 'GET', '/tickets', { cookie });
    assert(listRes.statusCode === 200, `Ticket list should work, got HTTP ${listRes.statusCode}`);

    // 3. Ticket detail still works.
    const detailRes = await request(baseUrl, 'GET', '/tickets/100', { cookie });
    assert(detailRes.statusCode === 200, `Ticket detail should work, got HTTP ${detailRes.statusCode}`);

    // 4. API ticket list still works.
    const apiRes = await request(baseUrl, 'GET', '/api/tickets', { cookie });
    assert(apiRes.statusCode === 200, `API ticket list should work, got HTTP ${apiRes.statusCode}`);

    // 5. Health check still works.
    const healthRes = await request(baseUrl, 'GET', '/api/health', { cookie });
    assert(healthRes.statusCode === 200, `Health check should work, got HTTP ${healthRes.statusCode}`);

    console.log('PASS: phase 7 — regression, existing routes still work');
  } finally {
    await stop(server);
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
}

// ── Phase 8: Model-plan success path with mock ollama server ──────────

async function phase8ModelPlanSuccessPath() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sim-success-data-'));
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sim-success-ws-'));
  const mockPort = 3890;
  const serverPort = 3588;
  const baseUrl = 'http://127.0.0.1:' + serverPort;
  let mockServer = null;
  let server = null;

  try {
    // Seed data with an ollama agent (no real model needed).
    seedCommon(dataDir);
    writeJson(dataDir, 'agents.json', [
      { id: 1, name: 'Test Agent', type: 'agent', provider: 'ollama', model: 'test-model', createdAt: T0, updatedAt: T0 }
    ]);
    seedTicket(dataDir);

    // Known valid model response — a valid JSON string that parseModelActions
    // will parse into actions.
    const VALID_ACTIONS_JSON = JSON.stringify({
      message: 'I will create the requested folders.',
      actions: [
        { operation: 'createFolder', args: { path: 'reports' } },
        { operation: 'createFolder', args: { path: 'notes' } }
      ],
      complete: true
    });

    // Start a minimal mock ollama HTTP server that returns a deterministic response.
    mockServer = http.createServer((req, res) => {
      let body = '';
      req.on('data', c => { body += c; });
      req.on('end', () => {
        // Accept only /api/chat (the ollama endpoint).
        if (req.method === 'POST' && req.url === '/api/chat') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            model: 'test-model',
            message: { role: 'assistant', content: VALID_ACTIONS_JSON }
          }));
        } else {
          res.writeHead(404);
          res.end();
        }
      });
    });

    await new Promise(resolve => mockServer.listen(mockPort, resolve));

    // Start the app server targeting the mock ollama.
    server = spawn(process.execPath, ['server.js'], {
      cwd: ROOT,
      env: {
        ...process.env, NODE_ENV: 'test', PORT: String(serverPort),
        DATA_DIR: dataDir, WORKSPACE_ROOT: workspaceRoot,
        RUNTIME_SCHEDULER_INTERVAL_MS: '3600000',
        OLLAMA_BASE_URL: 'http://127.0.0.1:' + mockPort,
        OLLAMA_MODEL: 'test-model'
      },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let out = '';
    server.stdout.on('data', c => { out += String(c); });
    server.stderr.on('data', c => { out += String(c); });
    server.getOutput = () => out;

    await waitForReady(baseUrl, server);
    const cookie = await loginAdmin(baseUrl);

    // Capture baseline.
    const runsBefore = readJson(dataDir, 'runs.json').length;
    const opsBefore = readJson(dataDir, 'operation-history.json').length;
    const wsBefore = fs.existsSync(workspaceRoot) ? fs.readdirSync(workspaceRoot).length : 0;
    const eventsBefore = fs.readFileSync(path.join(dataDir, 'events.jsonl'), 'utf8').trim().length;
    const ticketsBefore = readJson(dataDir, 'tickets.json');

    // Call simulate-plan with includeModelPlan: true.
    const res = await request(baseUrl, 'POST', '/api/tickets/100/simulate-plan', {
      cookie,
      body: { includeModelPlan: true }
    });
    const body = JSON.parse(res.body);
    assert(res.statusCode === 200,
      `Success path should return 200, got HTTP ${res.statusCode}: ${res.body}`);

    // 1. Model was called and response parsed.
    assert(body.modelCalled === true, 'modelCalled must be true');
    assert(body.modelError === undefined, `modelError must not be set, got ${body.modelError}`);
    assert(body.parseError === undefined, `parseError must not be set, got ${body.parseError}`);

    // 2. rawModelResponse contains the original JSON.
    assert(typeof body.rawModelResponse === 'string' && body.rawModelResponse.length > 0,
      'rawModelResponse must be a non-empty string');
    assert(body.rawModelResponse === VALID_ACTIONS_JSON,
      'rawModelResponse must match the mock response');

    // 3. actionsProposed contains parsed actions.
    assert(Array.isArray(body.actionsProposed), 'actionsProposed must be an array');
    assert(body.actionsProposed.length === 2,
      `Expected 2 proposed actions, got ${body.actionsProposed.length}`);
    assert(body.actionsProposed[0].operation === 'createFolder',
      `First action should be createFolder, got ${body.actionsProposed[0].operation}`);
    assert(body.actionsProposed[0].args.path === 'reports',
      `First action path should be reports, got ${body.actionsProposed[0].args.path}`);

    // 4. validationFindings returned (empty for valid actions).
    assert(Array.isArray(body.validationFindings), 'validationFindings must be an array');
    assert(body.validationFindings.length === 0,
      `validationFindings should be empty for valid actions, got ${body.validationFindings.length}`);

    // 5. modelMessage and modelComplete.
    assert(body.modelMessage === 'I will create the requested folders.',
      `modelMessage mismatch: ${body.modelMessage}`);
    assert(body.modelComplete === true, 'modelComplete must be true');

    // 6. Safety invariants.
    assert(body.productionRunCreated === false, 'productionRunCreated must be false');
    assert(body.workspaceMutated === false, 'workspaceMutated must be false');
    assert(body.actionsExecuted === 0, 'actionsExecuted must be 0');

    // 7. No side effects.
    const runsAfter = readJson(dataDir, 'runs.json');
    assert(runsAfter.length === runsBefore,
      `No runs should be created (before: ${runsBefore}, after: ${runsAfter.length})`);

    const opsAfter = readJson(dataDir, 'operation-history.json');
    assert(opsAfter.length === opsBefore,
      `No operation-history entries should be added (before: ${opsBefore}, after: ${opsAfter.length})`);

    const wsAfter = fs.existsSync(workspaceRoot) ? fs.readdirSync(workspaceRoot).length : 0;
    assert(wsAfter === wsBefore,
      `Workspace should be unchanged (before: ${wsBefore}, after: ${wsAfter})`);

    const eventsAfter = fs.readFileSync(path.join(dataDir, 'events.jsonl'), 'utf8').trim().length;
    assert(eventsAfter === eventsBefore,
      `Events file should be unchanged (before: ${eventsBefore} chars, after: ${eventsAfter})`);

    const ticketsAfter = readJson(dataDir, 'tickets.json');
    assert(JSON.stringify(ticketsAfter) === JSON.stringify(ticketsBefore),
      'Tickets should be unchanged after simulation');

    // 8. System log has correct shape.
    const logs = readJson(dataDir, 'logs.json');
    const simLog = logs.find(l => l.type === 'ticket:simulation_plan');
    assert(simLog, 'System log must exist');
    assert(simLog.productionRunCreated === false, 'Log productionRunCreated must be false');
    assert(simLog.workspaceMutated === false, 'Log workspaceMutated must be false');
    assert(simLog.actionsExecuted === 0, 'Log actionsExecuted must be 0');
    assert(simLog.actionsProposed === 2, `Log actionsProposed must be 2, got ${simLog.actionsProposed}`);
    assert(simLog.validationFindings === 0, `Log validationFindings must be 0, got ${simLog.validationFindings}`);

    console.log('PASS: phase 8 — model-plan success path (mock ollama)');
  } finally {
    await stop(server);
    if (mockServer) await new Promise(resolve => mockServer.close(resolve));
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
}

async function main() {
  await phase1PermissionChecks();
  await phase2GateOnlySimulation();
  await phase3AmbiguousGateOnly();
  await phase4InvalidTicketId();
  await phase5NoSideEffects();
  await phase6ModelPlanWithModelCall();
  await phase7Regression();
  await phase8ModelPlanSuccessPath();
  console.log('PASS: agent behavior simulation harness');
}

main().catch(error => {
  console.error(error.stack || error.message);
  process.exit(1);
});

#!/usr/bin/env node
const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { sealCurrentRunEventChains } = require('./current-event-fixture');

const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'run-state-warning-data-'));
const WORKSPACE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'run-state-warning-workspace-'));
const PORT = String(5900 + Math.floor(Math.random() * 300));
const BASE_URL = 'http://127.0.0.1:' + PORT;
const WARNING_TEXT = 'State inconsistency detected: this run’s evidence includes events from before this run (often left over from an earlier reset). Review reset/run history before relying on this run’s status.';
const STAMP = Date.now();

let server = null;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function writeJson(file, value) {
  fs.writeFileSync(path.join(DATA_DIR, file), JSON.stringify(value, null, 2));
}

function request(method, urlPath, options = {}) {
  const body = options.form ? new URLSearchParams(options.form).toString() : null;
  return new Promise((resolve, reject) => {
    const req = http.request(BASE_URL + urlPath, {
      method,
      headers: {
        ...(body ? {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(body)
        } : {}),
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

function seedData() {
  fs.mkdirSync(path.join(DATA_DIR, 'replay-snapshots'), { recursive: true });
  fs.mkdirSync(WORKSPACE_ROOT, { recursive: true });

  writeJson('users.json', [{
    id: 1,
    username: 'admin',
    passwordHash: '$argon2id$v=19$m=65536,t=3,p=4$az+Aa/Vt5AjalPiSGPNdXQ$i+hlbZS1OGPnBIw16HfGY/u0A4VUqXdFkd5Y+JtXh/g',
    createdAt: new Date().toISOString(),
    type: 'user'
  }]);
  writeJson('permissions.json', ['ticket:create', 'ticket:read', 'ticket:update', 'user:update', 'workspace:reset']);
  writeJson('groups.json', [{
    id: 1,
    name: 'Administrators',
    permissions: ['ticket:create', 'ticket:read', 'ticket:update', 'user:update', 'workspace:reset'],
    canReceiveTickets: false
  }]);
  writeJson('memberships.json', [{ id: 1, principalType: 'user', principalId: 1, groupId: 1 }]);
  writeJson('agents.json', [{
    id: 1,
    name: 'Warning Test Agent',
    type: 'agent',
    provider: 'openai',
    model: 'gpt-test',
    apiKey: 'test-key',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  }]);
  writeJson('workflows.json', []);
  writeJson('allocation-plans.json', []);
  writeJson('operation-history.json', [{
    id: 1,
    timestamp: '2026-01-01T00:00:02.000Z',
    ticketId: 1,
    runId: 1,
    allocationPlanId: null,
    allocationItemId: null,
    step: 0,
    operation: 'createFolder',
    args: { path: 'D-' + STAMP },
    preState: { existed: false },
    postState: { existed: true, type: 'directory' },
    result: { path: 'D-' + STAMP },
    error: null
  }]);

  writeJson('tickets.json', [1, 2, 3].map(id => ({
    id,
    objective: 'Warning test ticket #' + id,
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
    status: id === 3 ? 'completed' : 'in_progress',
    createdBy: 'admin',
    changedBy: 'admin',
    changedAt: '2026-01-02T00:00:00.000Z',
    createdAt: '2026-01-02T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z'
  })));

  writeJson('runs.json', [
    {
      id: 1,
      ticketId: 1,
      status: 'running',
      createdAt: '2026-01-02T00:00:00.000Z',
      updatedAt: '2026-01-02T00:00:00.000Z',
      startedAt: '2026-01-02T00:00:01.000Z',
      leaseOwner: 'current-owner',
      leaseExpiresAt: '2099-01-01T00:00:00.000Z',
      replaySnapshotPath: 'replay-snapshots/run-1.json'
    },
    {
      id: 2,
      ticketId: 2,
      status: 'running',
      createdAt: '2026-01-02T00:00:00.000Z',
      updatedAt: '2026-01-02T00:00:00.000Z',
      startedAt: '2026-01-02T00:00:01.000Z',
      leaseOwner: 'current-owner',
      leaseExpiresAt: '2099-01-01T00:00:00.000Z',
      replaySnapshotPath: 'replay-snapshots/run-2.json'
    },
    {
      id: 3,
      ticketId: 3,
      status: 'completed',
      createdAt: '2026-01-02T00:00:00.000Z',
      updatedAt: '2026-01-02T00:00:02.000Z',
      startedAt: '2026-01-02T00:00:01.000Z',
      completedAt: '2026-01-02T00:00:02.000Z',
      replaySnapshotPath: 'replay-snapshots/run-3.json'
    }
  ].map(run => ({
    agentId: 1,
    agentName: 'Warning Test Agent',
    workspaceRoot: WORKSPACE_ROOT,
    mainWorkspaceRoot: WORKSPACE_ROOT,
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
    currentPhase: run.status === 'completed' ? 'terminalization' : 'planning',
    leaseOwner: null,
    leaseExpiresAt: null,
    currentStepId: null,
    currentWorkflowAction: null,
    lastHeartbeatAt: null,
    ...run
  })));

  writeJson('logs.json', [
    {
      id: 1,
      timestamp: '2026-01-01T00:00:03.000Z',
      runId: 1,
      ticketId: 1,
      agentId: 1,
      agentName: 'Warning Test Agent',
      type: 'run:resume_check',
      message: 'Resumable state detected: 40 prior events, execution=false, reconcile=false, unsafe=false, nextPhase=model_request',
      workspaceAction: null
    },
    {
      id: 2,
      timestamp: '2026-01-01T00:00:04.000Z',
      runId: 1,
      ticketId: 1,
      agentId: 1,
      agentName: 'Warning Test Agent',
      type: 'run:skip_terminal',
      message: 'Run already in terminal state (legacy)',
      workspaceAction: null
    },
    {
      id: 3,
      timestamp: '2026-01-01T00:00:05.000Z',
      runId: 1,
      ticketId: 1,
      agentId: 1,
      agentName: 'Warning Test Agent',
      type: 'run:interrupted',
      message: 'Run lease expired for owner stale-owner',
      workspaceAction: null
    },
    {
      id: 4,
      timestamp: '2026-01-02T00:00:01.000Z',
      runId: 2,
      ticketId: 2,
      agentId: 1,
      agentName: 'Warning Test Agent',
      type: 'run:started',
      message: 'Agent run started',
      workspaceAction: null
    },
    {
      id: 5,
      timestamp: '2026-01-02T00:00:02.000Z',
      runId: 3,
      ticketId: 3,
      agentId: 1,
      agentName: 'Warning Test Agent',
      type: 'run:completed',
      message: 'Agent run completed',
      workspaceAction: null
    }
  ]);

  fs.writeFileSync(path.join(DATA_DIR, 'events.jsonl'), sealCurrentRunEventChains([
    { id: 'old-created', ts: '2026-01-01T00:00:00.000Z', type: 'run.created', ticketId: 1, runId: 1, payload: { status: 'pending' } },
    { id: 'old-mutation', ts: '2026-01-01T00:00:01.000Z', type: 'workspace.operation', ticketId: 1, runId: 1, stepId: '0', payload: { operation: 'createFolder', path: 'D-' + STAMP, mutating: true, result: { path: 'D-' + STAMP } } },
    { id: 'old-completed', ts: '2026-01-01T00:00:02.000Z', type: 'run.terminalized', ticketId: 1, runId: 1, payload: { status: 'completed' } },
    { id: 'normal-started', ts: '2026-01-02T00:00:01.000Z', type: 'run.started', ticketId: 2, runId: 2, payload: { status: 'running' } },
    { id: 'normal-terminal', ts: '2026-01-02T00:00:02.000Z', type: 'run.terminalized', ticketId: 3, runId: 3, payload: { status: 'completed' } }
  ]).map(event => JSON.stringify(event)).join('\n') + '\n');

  fs.writeFileSync(path.join(DATA_DIR, 'replay-snapshots', 'run-1.json'), JSON.stringify({
    runId: 1,
    ticketId: 1,
    providerRequests: [],
    modelResponses: [],
    workspaceOperations: [],
    events: []
  }, null, 2));
  fs.writeFileSync(path.join(DATA_DIR, 'replay-snapshots', 'run-2.json'), JSON.stringify({
    runId: 2,
    ticketId: 2,
    providerRequests: [],
    modelResponses: [],
    workspaceOperations: [],
    events: [{ type: 'run.started' }]
  }, null, 2));
  fs.writeFileSync(path.join(DATA_DIR, 'replay-snapshots', 'run-3.json'), JSON.stringify({
    runId: 3,
    ticketId: 3,
    terminalStatus: 'completed',
    providerRequests: [{ ok: true }],
    modelResponses: [{ ok: true }],
    workspaceOperations: [],
    events: [{ type: 'run.terminalized' }]
  }, null, 2));
}

async function waitForReady(timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (server && server.exitCode !== null) throw new Error('Server exited before ready');
    try {
      const response = await request('GET', '/health');
      if (response.statusCode === 200 && JSON.parse(response.body).ready) return;
    } catch (_) {}
    await sleep(100);
  }
  throw new Error('Timed out waiting for server');
}

async function login() {
  const response = await request('POST', '/login', {
    form: { username: 'admin', password: 'admin123' }
  });
  assert(response.statusCode === 302, 'Admin login failed with HTTP ' + response.statusCode);
  const cookie = cookieFrom(response);
  assert(cookie.includes('sessionId='), 'Login did not return a session cookie');
  return cookie;
}

async function assertPageWarning(cookie, pathName, expected) {
  const response = await request('GET', pathName, { cookie });
  assert(response.statusCode === 200, pathName + ' failed with HTTP ' + response.statusCode);
  const hasWarning = response.body.includes(WARNING_TEXT);
  assert(hasWarning === expected, pathName + ' warning expected=' + expected + ' actual=' + hasWarning);
  return response.body;
}

async function main() {
  seedData();
  let output = '';

  try {
    server = spawn(process.execPath, ['server.js'], {
      cwd: ROOT,
      env: { ...process.env, NODE_ENV: 'test', PORT, DATA_DIR, WORKSPACE_ROOT, TEST_SKIP_STARTUP_RUN_RECOVERY: 'true' },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    server.stdout.on('data', chunk => { output += String(chunk); });
    server.stderr.on('data', chunk => { output += String(chunk); });

    await waitForReady();
    const cookie = await login();
    const contaminatedRunPage = await assertPageWarning(cookie, '/runs/1', true);
    assert(contaminatedRunPage.includes('Terminal event appears on a running run.'), 'Contaminated run page missing terminal reason');
    assert(contaminatedRunPage.includes('Event-derived mutation exists but replay has no workspace operations.'), 'Contaminated run page missing mutation/replay reason');
    assert(contaminatedRunPage.includes('Resume detected prior events before any provider request.'), 'Contaminated run page missing resume reason');
    await assertPageWarning(cookie, '/tickets/1', true);

    await assertPageWarning(cookie, '/runs/2', false);
    await assertPageWarning(cookie, '/tickets/2', false);
    await assertPageWarning(cookie, '/runs/3', false);
    await assertPageWarning(cookie, '/tickets/3', false);

    console.log('PASS: run state inconsistency warning appears only for contaminated active state');
  } catch (error) {
    if (output) process.stderr.write(output);
    throw error;
  } finally {
    if (server) {
      server.kill('SIGTERM');
      await sleep(500);
      if (server.exitCode === null) server.kill('SIGKILL');
    }
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
    fs.rmSync(WORKSPACE_ROOT, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(error.stack || error.message);
  process.exit(1);
});

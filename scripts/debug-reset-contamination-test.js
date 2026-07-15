#!/usr/bin/env node
const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { sealCurrentRunEventChains } = require('./current-event-fixture');

const ROOT = path.resolve(__dirname, '..');
const STAMP = Date.now();
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'debug-reset-contamination-data-'));
const WORKSPACE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'debug-reset-contamination-workspace-'));
const PORT = String(5600 + Math.floor(Math.random() * 300));
const BASE_URL = 'http://127.0.0.1:' + PORT;
const STALE_MARKER = 'STALE-RESET-CONTAMINATION-' + STAMP;
const NEW_MARKER = 'NEW-RESET-CONTAMINATION-' + STAMP;

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

function readJson(file) {
  return JSON.parse(fs.readFileSync(path.join(DATA_DIR, file), 'utf8'));
}

function readEvents() {
  const file = path.join(DATA_DIR, 'events.jsonl');
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8')
    .split('\n')
    .filter(line => line.trim())
    .map(line => JSON.parse(line));
}

function sealEventChain(events) {
  return sealCurrentRunEventChains(events);
}

function seedData() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(path.join(DATA_DIR, 'replay-snapshots'), { recursive: true });
  fs.mkdirSync(WORKSPACE_ROOT, { recursive: true });
  fs.writeFileSync(path.join(WORKSPACE_ROOT, 'stale-workspace-file.txt'), 'debug reset should keep existing workspace reset semantics\n');

  writeJson('users.json', [{
    id: 1,
    username: 'admin',
    passwordHash: '$argon2id$v=19$m=65536,t=3,p=4$az+Aa/Vt5AjalPiSGPNdXQ$i+hlbZS1OGPnBIw16HfGY/u0A4VUqXdFkd5Y+JtXh/g',
    createdAt: new Date().toISOString(),
    type: 'user'
  }]);
  writeJson('permissions.json', [
    'ticket:create', 'ticket:read', 'ticket:update', 'user:update', 'workspace:reset'
  ]);
  writeJson('groups.json', [{
    id: 1,
    name: 'Administrators',
    permissions: ['ticket:create', 'ticket:read', 'ticket:update', 'user:update', 'workspace:reset'],
    canReceiveTickets: false
  }]);
  writeJson('memberships.json', [{
    id: 1,
    principalType: 'user',
    principalId: 1,
    groupId: 1
  }]);
  writeJson('agents.json', [{
    id: 1,
    name: 'Reset Test Agent',
    type: 'agent',
    provider: 'openai',
    model: 'gpt-test',
    apiKey: 'test-key',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  }]);
  writeJson('workflows.json', [{
    id: 'preserved-workflow',
    name: 'Preserved Workflow',
    enabled: true,
    inputSchema: {},
    actions: [{ id: 'done', action: 'stop', input: { result: { ok: true } } }],
    postconditions: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  }]);

  const staleTs = new Date(Date.now() - 60000).toISOString();
  writeJson('tickets.json', [{
    id: 1,
    objective: 'stale ticket ' + STALE_MARKER,
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
    status: 'completed',
    createdBy: 'admin',
    changedBy: 'admin',
    changedAt: staleTs,
    createdAt: staleTs,
    updatedAt: staleTs
  }]);
  writeJson('runs.json', [{
    id: 1,
    ticketId: 1,
    agentId: 1,
    agentName: 'Reset Test Agent',
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
    currentPhase: 'terminalization',
    leaseOwner: 'stale-owner-' + STAMP,
    leaseExpiresAt: staleTs,
    status: 'completed',
    createdAt: staleTs,
    updatedAt: staleTs,
    completedAt: staleTs,
    replaySnapshotPath: 'replay-snapshots/run-1.json'
  }]);
  writeJson('logs.json', [{
    id: 1,
    timestamp: staleTs,
    runId: 1,
    ticketId: 1,
    agentId: 1,
    agentName: 'Reset Test Agent',
    type: 'run:interrupted',
    message: 'Run lease expired for owner stale-owner-' + STAMP,
    workspaceAction: null
  }]);
  writeJson('operation-history.json', [{
    id: 1,
    timestamp: staleTs,
    ticketId: 1,
    runId: 1,
    allocationPlanId: null,
    allocationItemId: null,
    step: 0,
    operation: 'createFolder',
    args: { path: 'D-' + STALE_MARKER },
    preState: { existed: false },
    postState: { existed: true, type: 'directory' },
    result: { path: 'D-' + STALE_MARKER },
    error: null
  }]);
  writeJson('allocation-plans.json', [{ id: 1, ticketId: 1, mode: 'owned_paths', status: 'completed', items: [], createdAt: staleTs }]);
  fs.writeFileSync(path.join(DATA_DIR, 'events.jsonl'), sealEventChain([
    {
      id: 'stale-run-created-' + STAMP,
      ts: staleTs,
      type: 'run.created',
      ticketId: 1,
      runId: 1,
      stepId: null,
      seq: 0,
      prevHash: null,
      payload: { status: 'pending', marker: STALE_MARKER }
    },
    {
      id: 'stale-workspace-' + STAMP,
      ts: staleTs,
      type: 'workspace.operation',
      ticketId: 1,
      runId: 1,
      stepId: '0',
      seq: 1,
      payload: {
        operation: 'createFolder',
        path: 'D-' + STALE_MARKER,
        mutating: true,
        result: { path: 'D-' + STALE_MARKER }
      }
    },
    {
      id: 'stale-terminal-' + STAMP,
      ts: staleTs,
      type: 'run.terminalized',
      ticketId: 1,
      runId: 1,
      stepId: null,
      seq: 2,
      payload: { status: 'completed', marker: STALE_MARKER }
    }
  ]).map(event => JSON.stringify(event)).join('\n') + '\n');
  fs.writeFileSync(path.join(DATA_DIR, 'replay-snapshots', 'run-1.json'), JSON.stringify({
    runId: 1,
    ticketId: 1,
    terminalStatus: 'completed',
    providerRequests: [{ marker: STALE_MARKER }],
    modelResponses: [{ marker: STALE_MARKER }],
    workspaceOperations: [{ operation: { operation: 'createFolder', args: { path: 'D-' + STALE_MARKER } } }],
    events: [{ type: 'run.terminalized', marker: STALE_MARKER }]
  }, null, 2));
}

function createFakeOpenAIPreload() {
  const preloadPath = path.join(os.tmpdir(), 'debug-reset-openai-' + process.pid + '-' + STAMP + '.js');
  const source = `
global.fetch = async function(_url, options = {}) {
  const body = JSON.parse(options.body || '{}');
  const combined = (Array.isArray(body.input) ? body.input : [])
    .map(item => item && item.content ? String(item.content) : '')
    .join('\\n');
  if (!combined.includes('${NEW_MARKER}')) {
    throw new Error('Unexpected prompt in debug reset contamination test');
  }
  return {
    ok: true,
    status: 200,
    headers: new Map([['x-request-id', 'debug-reset-contamination']]),
    async text() {
      return JSON.stringify({
        output_text: JSON.stringify({
          message: 'New run completed cleanly for ${NEW_MARKER}.',
          actions: [],
          complete: true
        }),
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 }
      });
    }
  };
};
`;
  fs.writeFileSync(preloadPath, source);
  return preloadPath;
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

async function waitFor(fn, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await fn();
    if (result) return result;
    await sleep(100);
  }
  throw new Error('Timed out waiting for condition');
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

async function main() {
  seedData();
  const preloadPath = createFakeOpenAIPreload();
  let output = '';

  try {
    server = spawn(process.execPath, ['server.js'], {
      cwd: ROOT,
      env: {
        ...process.env,
        NODE_ENV: 'test',
        PORT,
        DATA_DIR,
        WORKSPACE_ROOT,
        NODE_OPTIONS: '--require ' + preloadPath
      },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    server.stdout.on('data', chunk => { output += String(chunk); });
    server.stderr.on('data', chunk => { output += String(chunk); });

    await waitForReady();
    const cookie = await login();
    const resetResponse = await request('POST', '/admin/debug-reset', {
      cookie,
      form: { confirmation: 'RESET DEBUG DATA' }
    });
    assert(resetResponse.statusCode === 302, 'Debug reset failed with HTTP ' + resetResponse.statusCode + ': ' + resetResponse.body);

    assert(readJson('tickets.json').length === 0, 'Debug reset did not clear tickets');
    assert(readJson('runs.json').length === 0, 'Debug reset did not clear runs');
    assert(readJson('operation-history.json').length === 0, 'Debug reset did not clear operation history');
    assert(readJson('allocation-plans.json').length === 0, 'Debug reset did not clear allocation plans');
    assert(!fs.existsSync(path.join(DATA_DIR, 'replay-snapshots', 'run-1.json')), 'Debug reset did not clear stale replay snapshot file');
    assert(!JSON.stringify(readEvents()).includes(STALE_MARKER), 'Debug reset left stale run events in events.jsonl');
    assert(readJson('users.json').some(user => user.username === 'admin'), 'Debug reset cleared users');
    assert(readJson('groups.json').some(group => group.name === 'Administrators'), 'Debug reset cleared groups');
    assert(readJson('agents.json').some(agent => agent.name === 'Reset Test Agent'), 'Debug reset cleared agents');
    assert(readJson('workflows.json').some(workflow => workflow.id === 'preserved-workflow'), 'Debug reset cleared workflows');

    const createResponse = await request('POST', '/tickets', {
      cookie,
      form: {
        objective: 'Run after destructive reset ' + NEW_MARKER,
        assignmentTargetType: 'agent',
        assignmentTargetId: '1',
        assignmentMode: 'individual'
      }
    });
    assert(createResponse.statusCode === 302, 'Ticket create failed with HTTP ' + createResponse.statusCode + ': ' + createResponse.body);

    const run = await waitFor(() => {
      const runs = readJson('runs.json');
      return runs.find(item => item.id === 1 && ['completed', 'failed', 'interrupted'].includes(item.status));
    });
    assert(run.ticketId === 1, 'New run did not reuse Ticket #1 / Run #1');
    assert(run.status === 'completed', 'New run should complete, got ' + run.status);

    const logs = readJson('logs.json');
    const logText = JSON.stringify(logs);
    assert(!logText.includes(STALE_MARKER), 'Logs retained stale marker after reset');
    assert(!logText.includes('run:skip_terminal'), 'New run triggered terminal skip from stale events');
    assert(!logText.includes('stale-owner-' + STAMP), 'New run retained stale lease owner message');

    const events = readEvents();
    const eventText = JSON.stringify(events);
    assert(!eventText.includes(STALE_MARKER), 'events.jsonl contains stale run events after reset and new run');
    assert(!events.some(event => event.type === 'run.terminalized' && event.payload && event.payload.marker === STALE_MARKER), 'Stale terminal event survived reset');
    assert(!events.some(event => event.type === 'workspace.operation' && event.payload && String(event.payload.path || '').includes(STALE_MARKER)), 'Stale workspace mutation survived reset');

    const runEventsResponse = await request('GET', '/api/runs/1/events', { cookie });
    assert(runEventsResponse.statusCode === 200, 'Run events API failed with HTTP ' + runEventsResponse.statusCode);
    const runEventsPayload = JSON.parse(runEventsResponse.body);
    assert(!JSON.stringify(runEventsPayload).includes(STALE_MARKER), 'Run events API attached stale event state');
    assert(!runEventsPayload.summary.latestWorkspaceMutation, 'Run event summary attached stale latest workspace mutation');

    const operationsResponse = await request('GET', '/api/runs/1/operations', { cookie });
    assert(operationsResponse.statusCode === 200, 'Run operations API failed with HTTP ' + operationsResponse.statusCode);
    assert(JSON.parse(operationsResponse.body).operations.length === 0, 'Run operations API attached stale operation history');

    const ticketPage = await request('GET', '/tickets/1', { cookie });
    assert(ticketPage.statusCode === 200, 'Ticket detail failed with HTTP ' + ticketPage.statusCode);
    assert(!ticketPage.body.includes(STALE_MARKER), 'Ticket detail attached stale artifact/activity state');

    const runPage = await request('GET', '/runs/1', { cookie });
    assert(runPage.statusCode === 200, 'Run detail failed with HTTP ' + runPage.statusCode);
    assert(!runPage.body.includes(STALE_MARKER), 'Run detail attached stale replay/event state');
    assert(runPage.body.includes('Provider Requests (1)'), 'Run detail did not show new provider request replay data');
    assert(runPage.body.includes('Model Responses (1)'), 'Run detail did not show new model response replay data');
    assert(runPage.body.includes('No workspace operations captured.'), 'Run detail should have no stale workspace operations');

    const snapshotPath = path.join(DATA_DIR, 'replay-snapshots', 'run-1.json');
    assert(fs.existsSync(snapshotPath), 'New run did not write a replay snapshot');
    const snapshotText = fs.readFileSync(snapshotPath, 'utf8');
    assert(snapshotText.includes(NEW_MARKER), 'Replay snapshot does not belong to the new run');
    assert(!snapshotText.includes(STALE_MARKER), 'Replay snapshot retained stale run data');

    console.log('PASS: debug reset clears stale run/ticket attachment state before ID reuse');
  } catch (error) {
    if (output) process.stderr.write(output);
    throw error;
  } finally {
    if (server) {
      server.kill('SIGTERM');
      await sleep(500);
      if (server.exitCode === null) server.kill('SIGKILL');
    }
    try { fs.rmSync(preloadPath, { force: true }); } catch (_) {}
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
    fs.rmSync(WORKSPACE_ROOT, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(error.stack || error.message);
  process.exit(1);
});

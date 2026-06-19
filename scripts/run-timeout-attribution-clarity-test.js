#!/usr/bin/env node
const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const REAL_DATA = path.join(ROOT, 'data');
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'run-timeout-clarity-data-'));
const WORKSPACE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'run-timeout-clarity-workspace-'));
const PORT = process.env.PORT || String(18000 + Math.floor(Math.random() * 1000));
const BASE_URL = 'http://127.0.0.1:' + PORT;
const now = new Date().toISOString();

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(path.join(DATA_DIR, file), 'utf8'));
}

function writeJson(file, value) {
  fs.writeFileSync(path.join(DATA_DIR, file), JSON.stringify(value, null, 2));
}

function seedData() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(WORKSPACE_ROOT, { recursive: true });

  [
    'agents.json',
    'allocation-plans.json',
    'groups.json',
    'memberships.json',
    'permissions.json',
    'users.json',
    'workflows.json'
  ].forEach(file => {
    const source = path.join(REAL_DATA, file);
    fs.writeFileSync(path.join(DATA_DIR, file), fs.existsSync(source) ? fs.readFileSync(source) : '[]');
  });

  const agents = readJson('agents.json');
  const agent = agents[0] || {
    id: 1,
    name: 'Agent 1',
    type: 'agent',
    provider: 'ollama',
    model: 'gemma4',
    createdAt: now,
    updatedAt: now
  };
  if (!agents.some(item => item.id === agent.id)) {
    agents.push(agent);
    writeJson('agents.json', agents);
  }

  const ticket = {
    id: 9001,
    objective: 'Create folder A B C and D',
    assignmentTargetType: 'agent',
    assignmentTargetId: agent.id,
    assignmentMode: 'individual',
    status: 'failed',
    createdBy: 'admin',
    changedBy: 'admin',
    createdAt: now,
    updatedAt: now
  };
  const run = {
    id: 9001,
    ticketId: ticket.id,
    agentId: agent.id,
    agentName: agent.name,
    workspaceRoot: WORKSPACE_ROOT,
    mainWorkspaceRoot: WORKSPACE_ROOT,
    executionWorkspaceType: 'main',
    status: 'failed',
    currentPhase: 'mutation',
    ticketOpenedAt: now,
    createdAt: now,
    startedAt: now,
    updatedAt: now,
    completedAt: now,
    error: 'Agent run exceeded runtime duration limit of 120000ms',
    replaySnapshot: {
      version: 1,
      runId: 9001,
      ticketId: ticket.id,
      assignedAgentId: agent.id,
      agentNameSnapshot: agent.name,
      provider: 'ollama',
      model: 'gemma4',
      runtimeEnvelope: {},
      ticketObjectiveSnapshot: ticket.objective,
      systemInstructionSnapshot: 'test instruction',
      primitiveContract: {},
      workspaceRoot: WORKSPACE_ROOT,
      mainWorkspaceRoot: WORKSPACE_ROOT,
      executionWorkspaceType: 'main',
      providerRequests: [
        { body: { model: 'gemma4' }, startedAt: now },
        { body: { model: 'gemma4' }, startedAt: now },
        { body: { model: 'gemma4' }, startedAt: now }
      ],
      modelResponses: [
        {
          text: JSON.stringify({
            message: 'Create folders A, B, C, and D.',
            actions: [
              { operation: 'createFolder', args: { path: 'A' } },
              { operation: 'createFolder', args: { path: 'B' } },
              { operation: 'createFolder', args: { path: 'C' } },
              { operation: 'createFolder', args: { path: 'D' } }
            ],
            complete: true
          })
        },
        {
          text: JSON.stringify({
            message: 'Create folders A and B.',
            actions: [
              { operation: 'createFolder', args: { path: 'A' } },
              { operation: 'createFolder', args: { path: 'B' } }
            ],
            complete: false
          })
        }
      ],
      parsedModelPlans: [
        {
          message: 'Create folders A, B, C, and D.',
          actions: [
            { operation: 'createFolder', args: { path: 'A' } },
            { operation: 'createFolder', args: { path: 'B' } },
            { operation: 'createFolder', args: { path: 'C' } },
            { operation: 'createFolder', args: { path: 'D' } }
          ],
          complete: true,
          step: 0
        },
        {
          message: 'Create folders A and B.',
          actions: [
            { operation: 'createFolder', args: { path: 'A' } },
            { operation: 'createFolder', args: { path: 'B' } }
          ],
          complete: false,
          step: 1
        }
      ],
      workspaceOperations: [
        { operation: { operation: 'createFolder', args: { path: 'A' } }, result: { path: 'A', status: 'created' }, historyId: 1 },
        { operation: { operation: 'createFolder', args: { path: 'B' } }, result: { path: 'B', status: 'created' }, historyId: 2 }
      ],
      events: [
        {
          type: 'model:mutating_action_limit',
          message: 'Model returned 4 mutating workspace actions, exceeding the per-response mutating limit of 2',
          actionCount: 4,
          mutatingActionCount: 4,
          maxMutatingActionsPerResponse: 2,
          step: 0
        }
      ],
      terminalStatus: 'failed',
      failureReason: 'Agent run exceeded runtime duration limit of 120000ms',
      failure: {
        code: 'RUN_LIMIT_EXCEEDED',
        kind: 'timeout',
        detail: { limitType: 'timeout', configuredLimit: 120000 }
      },
      mutationCount: 2,
      mutationOutcome: 'partial_mutations',
      finalizedAt: now
    }
  };

  writeJson('tickets.json', [ticket]);
  writeJson('runs.json', [run]);
  writeJson('logs.json', [
    { id: 1, timestamp: now, runId: run.id, ticketId: ticket.id, agentId: agent.id, type: 'run:started', message: 'Agent run started' },
    { id: 2, timestamp: now, runId: run.id, ticketId: ticket.id, agentId: agent.id, type: 'model:request', message: 'ollama request sent with model gemma4' },
    { id: 3, timestamp: now, runId: run.id, ticketId: ticket.id, agentId: agent.id, type: 'model:response', message: run.replaySnapshot.modelResponses[0].text },
    { id: 4, timestamp: now, runId: run.id, ticketId: ticket.id, agentId: agent.id, type: 'model:mutating_action_limit', message: 'Model returned 4 mutating workspace actions, exceeding the per-response mutating limit of 2' },
    { id: 5, timestamp: now, runId: run.id, ticketId: ticket.id, agentId: agent.id, type: 'model:request', message: 'ollama request sent with model gemma4' },
    { id: 6, timestamp: now, runId: run.id, ticketId: ticket.id, agentId: agent.id, type: 'model:response', message: run.replaySnapshot.modelResponses[1].text },
    { id: 7, timestamp: now, runId: run.id, ticketId: ticket.id, agentId: agent.id, type: 'workspace:create', message: 'Ran createFolder on A' },
    { id: 8, timestamp: now, runId: run.id, ticketId: ticket.id, agentId: agent.id, type: 'workspace:create', message: 'Ran createFolder on B' },
    { id: 9, timestamp: now, runId: run.id, ticketId: ticket.id, agentId: agent.id, type: 'model:request', message: 'ollama request sent with model gemma4' },
    { id: 10, timestamp: now, runId: run.id, ticketId: ticket.id, agentId: agent.id, type: 'run:timeout', message: 'Agent run exceeded runtime duration limit of 120000ms' },
    { id: 11, timestamp: now, runId: run.id, ticketId: ticket.id, agentId: agent.id, type: 'run:failed', message: 'Agent run failed: Agent run exceeded runtime duration limit of 120000ms' }
  ]);
  writeJson('operation-history.json', [
    { id: 1, timestamp: now, ticketId: ticket.id, runId: run.id, step: 1, operation: 'createFolder', args: { path: 'A' }, result: { path: 'A', status: 'created' }, error: null },
    { id: 2, timestamp: now, ticketId: ticket.id, runId: run.id, step: 1, operation: 'createFolder', args: { path: 'B' }, result: { path: 'B', status: 'created' }, error: null }
  ]);
  writeJson('allocation-plans.json', []);
  fs.writeFileSync(path.join(DATA_DIR, 'events.jsonl'), '');
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

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitForReady(server, output) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error('Server exited before ready: ' + output.text);
    try {
      const response = await request('GET', '/health');
      if (response.statusCode === 200 && JSON.parse(response.body).ready) return;
    } catch (_) {}
    await sleep(100);
  }
  throw new Error('Timed out waiting for server readiness: ' + output.text);
}

async function main() {
  seedData();
  const output = { text: '' };
  const server = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, NODE_ENV: 'test', PORT, DATA_DIR, WORKSPACE_ROOT },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  server.stdout.on('data', chunk => { output.text += String(chunk); });
  server.stderr.on('data', chunk => { output.text += String(chunk); });

  try {
    await waitForReady(server, output);
    const login = await request('POST', '/login', {
      form: { username: 'admin', password: 'admin123' }
    });
    const cookie = cookieFrom(login);
    assert(cookie.includes('sessionId='), 'Login failed');

    const page = (await request('GET', '/runs/9001', { cookie })).body;
    assert(page.includes('Why this run stopped'), 'Run detail did not render stop explanation');
    assert(page.includes('Run timed out after 2 minutes.'), 'Timeout duration note missing');
    assert(page.includes('Latest observed phase: waiting for model response.'), 'Latest phase attribution missing');
    assert(page.includes('timed out after the last model request and before a matching model response was recorded'), 'Request/response timeout attribution missing');
    assert(page.includes('Model calls: 3 request(s), 2 response(s). Last request had no recorded response before timeout.'), 'Model call imbalance note missing');
    assert(page.includes('Workspace progress before failure: 2 action(s).'), 'Partial workspace progress note missing');
    assert(page.includes('An over-cap model response was suppressed and not treated as completed'), 'Over-cap suppression completion note missing');
    assert(!page.includes('required postconditions verified'), 'Timeout page must not claim objective satisfaction');
    assert(!page.includes('Completed: workspace objective satisfied'), 'Timeout page must not claim workspace objective satisfaction');

    console.log('PASS: run timeout attribution clarity render test');
  } finally {
    server.kill('SIGTERM');
    await sleep(200);
    if (server.exitCode === null) server.kill('SIGKILL');
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
    fs.rmSync(WORKSPACE_ROOT, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(error.stack || error.message);
  process.exit(1);
});

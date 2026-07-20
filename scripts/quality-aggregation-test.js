#!/usr/bin/env node
const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { currentRuntimeLimitsSnapshot } = require('./current-run-fixture');
const { createTempWorkspaceRoot, removeTempWorkspaceRoot } = require('./test-workspace');

const ROOT = path.resolve(__dirname, '..');
const REAL_DATA_DIR = path.join(ROOT, 'data');
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'quality-aggregation-data-'));
const WORKSPACE_ROOT = createTempWorkspaceRoot('quality-aggregation');
const PORT = String(5600 + Math.floor(Math.random() * 300));
const BASE_URL = 'http://127.0.0.1:' + PORT;
const STAMP = Date.now();
let server = null;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

function writeJson(file, value) {
  fs.writeFileSync(path.join(DATA_DIR, file), JSON.stringify(value, null, 2));
}

function copySeed(file) {
  const src = path.join(REAL_DATA_DIR, file);
  fs.writeFileSync(path.join(DATA_DIR, file), fs.existsSync(src) ? fs.readFileSync(src, 'utf8') : '[]');
}

function writeReplay(runId, snapshot) {
  const dir = path.join(DATA_DIR, 'replay-snapshots');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'run-' + runId + '.json'), JSON.stringify(snapshot, null, 2));
  return path.join('replay-snapshots', 'run-' + runId + '.json');
}

function request(method, urlPath, options = {}) {
  const body = options.form ? new URLSearchParams(options.form).toString() : null;
  return new Promise((resolve, reject) => {
    const req = http.request(BASE_URL + urlPath, {
      method,
      headers: {
        ...(body ? { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) } : {}),
        ...(options.cookie ? { Cookie: options.cookie } : {})
      }
    }, res => {
      let responseBody = '';
      res.on('data', chunk => { responseBody += String(chunk); });
      res.on('end', () => resolve({ statusCode: res.statusCode, headers: res.headers, body: responseBody }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function cookieFrom(response) {
  return (response.headers['set-cookie'] || []).map(cookie => cookie.split(';')[0]).join('; ');
}

async function waitForReady() {
  const started = Date.now();
  while (Date.now() - started < 15000) {
    try {
      const response = await request('GET', '/health');
      if (response.statusCode === 200 && JSON.parse(response.body).ready) return;
    } catch (_) {}
    await sleep(100);
  }
  throw new Error('Timed out waiting for server ready');
}

async function login() {
  const response = await request('POST', '/login', { form: { username: 'admin', password: 'admin123' } });
  assert(response.statusCode === 302, 'login should redirect, got HTTP ' + response.statusCode);
  return cookieFrom(response);
}

function seedData() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(WORKSPACE_ROOT, { recursive: true });
  for (const file of ['users.json', 'groups.json', 'memberships.json', 'permissions.json', 'workflows.json']) copySeed(file);
  const seedAgents = JSON.parse(fs.readFileSync(path.join(REAL_DATA_DIR, 'agents.json'), 'utf8'));
  writeJson('agents.json', [...seedAgents, {
    id: 9902, name: 'Quality Aggregation Agent', provider: 'openai', model: 'model-quality-a',
    apiKey: 'fake-key', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
  }]);
  writeJson('logs.json', []);
  writeJson('allocation-plans.json', []);
  fs.writeFileSync(path.join(DATA_DIR, 'events.jsonl'), '');

  const now = new Date().toISOString();
  const tickets = [
    { id: 9101, objective: 'Write qa-perfect-' + STAMP + '.txt', status: 'completed' },
    { id: 9102, objective: 'Create qa-source-' + STAMP + '.txt then rename it to qa-final-' + STAMP + '.txt', status: 'completed' },
    { id: 9103, objective: 'Overwrite package.json with exactly: blocked ' + STAMP, status: 'failed' }
  ].map(ticket => ({
    ...ticket,
    assignmentTargetType: 'agent',
    assignmentTargetId: 9902,
    assignmentMode: 'individual',
    executionMode: 'agent',
    capabilityType: 'directAction',
    capabilityId: 'agent-selected-actions',
    createdBy: 'test',
    changedBy: 'test',
    changedAt: now,
    createdAt: now,
    updatedAt: now
  }));

  const snapshots = {
    9201: {
      model: 'model-quality-a',
      artifactPrediction: { version: 1, source: 'parsedModelPlans', artifacts: [{ type: 'file', artifact: 'qa-perfect-' + STAMP + '.txt', operation: 'writeFile', step: 0, actionIndex: 0 }] },
      parsedModelPlans: [],
      workspaceOperations: [],
      workflowDrafts: []
    },
    9202: {
      model: 'model-quality-a',
      artifactPrediction: { version: 1, source: 'parsedModelPlans', artifacts: [{ type: 'file', artifact: 'qa-source-' + STAMP + '.txt', operation: 'writeFile', step: 0, actionIndex: 0 }] },
      parsedModelPlans: [],
      workspaceOperations: [],
      workflowDrafts: []
    },
    9203: {
      model: 'model-quality-a',
      artifactPrediction: { version: 1, source: 'parsedModelPlans', artifacts: [{ type: 'file', artifact: 'package.json', operation: 'writeFile', step: 0, actionIndex: 0 }] },
      parsedModelPlans: [],
      workspaceOperations: [{ operation: { operation: 'writeFile', args: { path: 'package.json', content: 'blocked' } }, error: 'Blocked protected workspace path mutation: writeFile package.json' }],
      workflowDrafts: []
    }
  };

  const runs = [
    { id: 9201, ticketId: 9101, status: 'completed', error: null },
    { id: 9202, ticketId: 9102, status: 'completed', error: null },
    { id: 9203, ticketId: 9103, status: 'failed', error: 'Blocked protected workspace path mutation: writeFile package.json' }
  ].map(run => ({
    ...run,
    agentId: 9902,
    agentName: 'Quality Aggregation Agent',
    executionWorkspaceType: 'main',
    ownedOutputPaths: [],
    executionMode: 'agent',
    capabilityType: 'directAction',
    capabilityId: 'agent-selected-actions',
    runtimeLimitsSnapshot: currentRuntimeLimitsSnapshot(),
    runEvaluation: { effectiveness: { status: run.status === 'completed' ? 'passed' : 'failed' } },
    ticketOpenedAt: now,
    createdAt: now,
    updatedAt: now,
    startedAt: now,
    completedAt: now,
    replaySnapshotPath: writeReplay(run.id, snapshots[run.id]),
    replaySummary: { model: 'model-quality-a', terminalStatus: run.status, mutationCount: run.id === 9203 ? 0 : 1 }
  }));

  writeJson('tickets.json', tickets);
  writeJson('runs.json', runs);
  writeJson('operation-history.json', [
    { id: 9301, timestamp: now, ticketId: 9101, runId: 9201, step: 0, operation: 'writeFile', args: { path: 'qa-perfect-' + STAMP + '.txt', content: 'ok' }, preState: { existed: false }, postState: { existed: true, type: 'file' }, result: { path: 'qa-perfect-' + STAMP + '.txt' }, error: null },
    { id: 9302, timestamp: now, ticketId: 9102, runId: 9202, step: 0, operation: 'writeFile', args: { path: 'qa-source-' + STAMP + '.txt', content: 'ok' }, preState: { existed: false }, postState: { existed: true, type: 'file' }, result: { path: 'qa-source-' + STAMP + '.txt' }, error: null }
  ]);
}

async function startServer() {
  server = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, NODE_ENV: 'test', PORT, DATA_DIR, WORKSPACE_ROOT },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let output = '';
  server.stdout.on('data', chunk => { output += String(chunk); });
  server.stderr.on('data', chunk => { output += String(chunk); });
  await waitForReady().catch(error => {
    throw new Error(error.message + ': ' + output.slice(-1000));
  });
}

async function stopServer() {
  if (!server) return;
  server.kill('SIGTERM');
  await sleep(300);
  if (server.exitCode === null) server.kill('SIGKILL');
  server = null;
}

async function main() {
  seedData();
  try {
    await startServer();
    const cookie = await login();
    const agentsPage = await request('GET', '/agents', { cookie });
    assert(agentsPage.statusCode === 200, '/agents should render, got HTTP ' + agentsPage.statusCode + ': ' + agentsPage.body.slice(0, 500));
    const body = agentsPage.body;
    ['Agent Quality Metrics', 'Model Quality Metrics', 'Quality Aggregation Agent', 'model-quality-a'].forEach(text => {
      assert(body.includes(text), '/agents missing ' + text);
    });
    assert(body.includes('67%'), 'quality averages should include rounded 67% values');
    assert(body.includes('83%'), 'path coverage average should include rounded 83%');
    assert(body.includes('A/S: 0 · S/C: 2 · A/C: 2'), 'agent disagreement summary should be 0/2/2: ' + (body.match(/A\/S:[^<]*/g) || []).join(' | '));
    assert(body.includes('<td>0</td>') && body.includes('<td>2</td>'), 'model disagreement counts should render');
    console.log(JSON.stringify({ qualityAggregation: true, agent: 'Quality Aggregation Agent', model: 'model-quality-a' }));
  } finally {
    await stopServer();
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
    removeTempWorkspaceRoot(WORKSPACE_ROOT);
  }
}

main().catch(async error => {
  await stopServer();
  console.error(error.stack || error.message);
  process.exit(1);
});

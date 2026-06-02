#!/usr/bin/env node
const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'artifact-projection-status-data-'));
const WORKSPACE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'artifact-projection-status-workspace-'));
const PORT = String(4900 + Math.floor(Math.random() * 400));
const BASE_URL = 'http://127.0.0.1:' + PORT;
let server = null;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

function writeJson(file, value) {
  fs.writeFileSync(path.join(DATA_DIR, file), JSON.stringify(value, null, 2));
}

function seedData() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  for (const file of ['users.json', 'agents.json', 'groups.json', 'memberships.json', 'permissions.json', 'workflows.json']) {
    fs.copyFileSync(path.join(ROOT, 'data', file), path.join(DATA_DIR, file));
  }

  writeJson('tickets.json', [{
    id: 1,
    objective: 'Ticket 10 style artifact projection fixture',
    assignmentTargetType: 'agent',
    assignmentTargetId: 1,
    assignmentMode: 'individual',
    executionMode: 'agent',
    capabilityType: 'directAction',
    capabilityId: 'agent-selected-actions',
    status: 'completed',
    createdBy: 'test',
    changedBy: 'test',
    changedAt: '2026-06-02T00:00:00.000Z',
    createdAt: '2026-06-02T00:00:00.000Z',
    updatedAt: '2026-06-02T00:02:00.000Z'
  }]);

  writeJson('runs.json', [
    {
      id: 1,
      ticketId: 1,
      agentId: 1,
      agentName: 'Agent 1',
      executionWorkspaceType: 'main',
      ownedOutputPaths: [],
      executionMode: 'agent',
      capabilityType: 'directAction',
      capabilityId: 'agent-selected-actions',
      status: 'completed',
      ticketOpenedAt: '2026-06-02T00:00:00.000Z',
      createdAt: '2026-06-02T00:00:00.000Z',
      updatedAt: '2026-06-02T00:01:00.000Z',
      startedAt: '2026-06-02T00:00:01.000Z',
      completedAt: '2026-06-02T00:01:00.000Z'
    },
    {
      id: 2,
      ticketId: 1,
      agentId: 1,
      agentName: 'Agent 1',
      executionWorkspaceType: 'main',
      ownedOutputPaths: [],
      executionMode: 'agent',
      capabilityType: 'directAction',
      capabilityId: 'agent-selected-actions',
      rerunMode: 'retry',
      status: 'completed',
      ticketOpenedAt: '2026-06-02T00:02:00.000Z',
      createdAt: '2026-06-02T00:02:00.000Z',
      updatedAt: '2026-06-02T00:03:00.000Z',
      startedAt: '2026-06-02T00:02:01.000Z',
      completedAt: '2026-06-02T00:03:00.000Z'
    }
  ]);

  writeJson('operation-history.json', [
    {
      id: 1,
      timestamp: '2026-06-02T00:00:10.000Z',
      ticketId: 1,
      runId: 1,
      step: 0,
      operation: 'writeFile',
      args: { path: 'observations/correction.txt', content: 'corrected' },
      preState: { existed: false },
      postState: { existed: true, type: 'file' },
      result: { path: 'observations/correction.txt' },
      error: null
    },
    {
      id: 2,
      timestamp: '2026-06-02T00:02:10.000Z',
      ticketId: 1,
      runId: 2,
      step: 0,
      operation: 'createFolder',
      args: { path: 'observations' },
      preState: { existed: true, type: 'directory' },
      postState: { existed: true, type: 'directory' },
      result: { path: 'observations', status: 'already_exists_noop' },
      error: null
    },
    {
      id: 3,
      timestamp: '2026-06-02T00:02:20.000Z',
      ticketId: 1,
      runId: 2,
      step: 0,
      operation: 'writeFile',
      args: { path: 'observations/correction.txt', content: 'corrected' },
      preState: { existed: true, type: 'file', content: 'corrected' },
      postState: { existed: true, type: 'file' },
      result: { path: 'observations/correction.txt' },
      error: null
    },
    {
      id: 4,
      timestamp: '2026-06-02T00:02:30.000Z',
      ticketId: 1,
      runId: 2,
      step: 0,
      operation: 'writeFile',
      args: { path: 'observations/same-run-update.txt', content: 'updated' },
      preState: { existed: true, type: 'file', content: 'old' },
      postState: { existed: true, type: 'file' },
      result: { path: 'observations/same-run-update.txt' },
      error: null
    }
  ]);

  writeJson('logs.json', []);
  writeJson('allocation-plans.json', []);
  fs.writeFileSync(path.join(DATA_DIR, 'events.jsonl'), '');
}

function httpReq(method, urlPath, options = {}) {
  return new Promise((resolve, reject) => {
    const body = options.form ? new URLSearchParams(options.form).toString() : null;
    const req = http.request(BASE_URL + urlPath, {
      method,
      headers: {
        ...(body ? { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) } : {}),
        ...(options.cookie ? { Cookie: options.cookie } : {})
      }
    }, res => {
      let responseBody = '';
      res.on('data', chunk => { responseBody += String(chunk); });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: responseBody }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function waitFor(fn, timeoutMs = 15000, intervalMs = 100) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await fn();
    if (result) return result;
    await sleep(intervalMs);
  }
  throw new Error('Timed out waiting for condition');
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
  await waitFor(async () => {
    if (server && server.exitCode !== null) throw new Error('server exited during startup: ' + output.slice(-1000));
    try {
      const res = await httpReq('GET', '/login');
      return res.status === 200;
    } catch (_) {
      return false;
    }
  });
}

async function stopServer() {
  if (!server) return;
  server.kill('SIGTERM');
  await sleep(500);
  if (server && server.exitCode === null) server.kill('SIGKILL');
  server = null;
}

async function login() {
  const res = await httpReq('POST', '/login', {
    form: { username: 'admin', password: 'admin123' }
  });
  assert(res.status === 302, 'login should redirect after success');
  const setCookie = Array.isArray(res.headers['set-cookie']) ? res.headers['set-cookie'][0] : res.headers['set-cookie'];
  const match = String(setCookie || '').match(/sessionId=([^;]+)/);
  assert(match, 'login should set session cookie');
  return 'sessionId=' + match[1];
}

async function main() {
  seedData();
  try {
    await startServer();
    const cookie = await login();
    const res = await httpReq('GET', '/tickets/1', { cookie });
    assert(res.status === 200, 'ticket detail should render, got HTTP ' + res.status);
    assert(res.body.includes('>created</span>'), 'first write artifact should show created status');
    assert(res.body.includes('>rewritten</span>'), 'rerun write artifact should show rewritten status');
    assert(res.body.includes('>updated</span>'), 'same-run existing-path write without earlier different-run write should show updated status');
    assert(!res.body.includes('Operation #2'), 'already_exists_noop folder operation should not appear as an artifact');
    console.log(JSON.stringify({ artifactProjectionStatus: true }));
  } finally {
    await stopServer();
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
    fs.rmSync(WORKSPACE_ROOT, { recursive: true, force: true });
  }
}

main().catch(async error => {
  await stopServer();
  console.error(error.stack || error.message);
  process.exit(1);
});

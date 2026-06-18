#!/usr/bin/env node
const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const STAMP = Date.now();
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'direct-folder-postcondition-data-'));
const WORKSPACE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'direct-folder-postcondition-workspace-'));
const PORT = String(17000 + Math.floor(Math.random() * 1000));
const BASE_URL = 'http://127.0.0.1:' + PORT;
const NEGATIVE_OBJECTIVE = 'Create folder A B C and D';
const SINGLE_FOLDER = 'single-folder-' + STAMP;
const AMBIGUOUS_FOLDER = 'ambiguous-folder-' + STAMP;

let server = null;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(path.join(DATA_DIR, file), 'utf8'));
}

function writeJson(file, value) {
  fs.writeFileSync(path.join(DATA_DIR, file), JSON.stringify(value, null, 2));
}

function setupDataDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(path.join(DATA_DIR, 'replay-snapshots'), { recursive: true });
  fs.mkdirSync(WORKSPACE_ROOT, { recursive: true });

  for (const file of ['users.json', 'agents.json', 'groups.json', 'memberships.json', 'permissions.json', 'workflows.json']) {
    fs.copyFileSync(path.join(ROOT, 'data', file), path.join(DATA_DIR, file));
  }

  for (const file of ['tickets.json', 'runs.json', 'logs.json', 'operation-history.json', 'allocation-plans.json']) {
    writeJson(file, []);
  }
  fs.writeFileSync(path.join(DATA_DIR, 'events.jsonl'), '');

  const agents = readJson('agents.json').filter(agent => agent.name !== 'Direct Folder Test Agent');
  agents.push({
    id: 9901,
    name: 'Direct Folder Test Agent',
    type: 'agent',
    provider: 'openai',
    model: 'fake-model',
    apiKey: 'fake-key',
    runtimeConfig: {},
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  });
  writeJson('agents.json', agents);
}

function createPreload() {
  const preloadPath = path.join(os.tmpdir(), 'direct-folder-postcondition-openai-' + process.pid + '-' + STAMP + '.js');
  const source = `
let negativeCallCount = 0;

function ok(plan) {
  return {
    ok: true,
    status: 200,
    headers: new Map([['x-request-id', 'direct-folder-postcondition']]),
    async text() {
      return JSON.stringify({
        output_text: JSON.stringify(plan),
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 }
      });
    }
  };
}

global.fetch = async function(_url, options = {}) {
  const body = JSON.parse(options.body || '{}');
  const combined = (Array.isArray(body.input) ? body.input : [])
    .map(item => item && item.content ? String(item.content) : '')
    .join('\\n');

  if (combined.includes(${JSON.stringify(NEGATIVE_OBJECTIVE)})) {
    negativeCallCount += 1;
    if (negativeCallCount === 1) {
      return ok({
        message: 'Create folders A, B, C, and D.',
        actions: [
          { operation: 'createFolder', args: { path: 'A' } },
          { operation: 'createFolder', args: { path: 'B' } },
          { operation: 'createFolder', args: { path: 'C' } },
          { operation: 'createFolder', args: { path: 'D' } }
        ],
        complete: true
      });
    }
    if (negativeCallCount === 2) {
      return ok({
        message: 'Create only A and B.',
        actions: [
          { operation: 'createFolder', args: { path: 'A' } },
          { operation: 'createFolder', args: { path: 'B' } }
        ],
        complete: false
      });
    }
    return ok({
      message: 'Cannot be completed with the allowed operations in this synthetic test.',
      actions: [],
      complete: false
    });
  }

  return ok({
    message: 'Cannot be completed with the allowed operations in this synthetic test.',
    actions: [],
    complete: false
  });
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

async function waitFor(fn, timeoutMs = 20000, intervalMs = 100) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await fn();
    if (result) return result;
    await sleep(intervalMs);
  }
  throw new Error('Timed out waiting for condition');
}

async function waitForReady() {
  await waitFor(async () => {
    if (server && server.exitCode !== null) throw new Error('Server exited before ready with code ' + server.exitCode);
    try {
      const response = await request('GET', '/health');
      return response.statusCode === 200 && JSON.parse(response.body).ready;
    } catch (_) {
      return false;
    }
  }, 15000);
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

async function createTicket(cookie, objective) {
  const response = await request('POST', '/tickets', {
    cookie,
    form: {
      objective,
      assignmentTargetType: 'agent',
      assignmentTargetId: '9901',
      assignmentMode: 'individual'
    }
  });
  assert(response.statusCode === 302, 'Ticket create failed with HTTP ' + response.statusCode + ': ' + response.body);
  return waitFor(() => {
    const tickets = readJson('tickets.json').filter(item => item.objective === objective);
    const ticket = tickets[tickets.length - 1];
    if (!ticket) return null;
    const run = readJson('runs.json').find(item => item.ticketId === ticket.id);
    return run ? { ticket, run } : null;
  });
}

async function waitForTerminalRun(runId) {
  return waitFor(() => {
    const run = readJson('runs.json').find(item => item.id === runId);
    return run && ['completed', 'failed', 'interrupted'].includes(run.status) ? run : null;
  }, 30000);
}

function readSnapshot(runId) {
  return JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'replay-snapshots', 'run-' + runId + '.json'), 'utf8'));
}

function hasPostconditionCompleted(snapshot) {
  return Array.isArray(snapshot.events) && snapshot.events.some(event => event.type === 'run:postcondition_completed');
}

function postconditionEvent(snapshot) {
  return (snapshot.events || []).find(event => event.type === 'run:postcondition_completed') || null;
}

function workspaceFolderExists(relativePath) {
  return fs.existsSync(path.join(WORKSPACE_ROOT, relativePath)) &&
    fs.statSync(path.join(WORKSPACE_ROOT, relativePath)).isDirectory();
}

async function main() {
  setupDataDir();
  const preloadPath = createPreload();
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
        NODE_OPTIONS: '--require ' + preloadPath,
        AGENT_MAX_MUTATING_ACTIONS_PER_RESPONSE: '2',
        AGENT_MAX_EXECUTION_STEPS: '4',
        AGENT_MAX_MODEL_REQUESTS_PER_RUN: '4',
        AGENT_MAX_WORKSPACE_OPERATIONS_PER_RUN: '10',
        AGENT_MAX_RUNTIME_DURATION_MS: '10000'
      },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    server.stdout.on('data', chunk => { output += String(chunk); });
    server.stderr.on('data', chunk => { output += String(chunk); });
    server.on('exit', (code, signal) => {
      output += `\n[server exited code=${code} signal=${signal}]\n`;
    });

    await waitForReady();
    const cookie = await login();

    const negative = await createTicket(cookie, NEGATIVE_OBJECTIVE);
    const negativeRun = await waitForTerminalRun(negative.run.id);
    const negativeSnapshot = readSnapshot(negativeRun.id);
    assert(negativeRun.status !== 'completed', 'Partial folder-list run must not complete as satisfied');
    assert(!hasPostconditionCompleted(negativeSnapshot), 'Partial folder-list run emitted run:postcondition_completed');
    assert(workspaceFolderExists('A'), 'Negative fixture did not create A');
    assert(workspaceFolderExists('B'), 'Negative fixture did not create B');
    assert(!workspaceFolderExists('C'), 'Negative fixture unexpectedly created C');
    assert(!workspaceFolderExists('D'), 'Negative fixture unexpectedly created D');

    fs.mkdirSync(path.join(WORKSPACE_ROOT, 'C'), { recursive: true });
    fs.mkdirSync(path.join(WORKSPACE_ROOT, 'D'), { recursive: true });
    const positive = await createTicket(cookie, NEGATIVE_OBJECTIVE);
    const positiveRun = await waitForTerminalRun(positive.run.id);
    const positiveSnapshot = readSnapshot(positiveRun.id);
    const positiveEvent = postconditionEvent(positiveSnapshot);
    assert(positiveRun.status === 'completed', 'Complete folder-list run should complete');
    assert(positiveEvent, 'Complete folder-list run did not emit run:postcondition_completed');
    assert(JSON.stringify(positiveEvent.checkedPaths || []) === JSON.stringify([
      { type: 'folder', path: 'A' },
      { type: 'folder', path: 'B' },
      { type: 'folder', path: 'C' },
      { type: 'folder', path: 'D' }
    ]), 'Complete folder-list run did not check every requested folder');

    fs.mkdirSync(path.join(WORKSPACE_ROOT, SINGLE_FOLDER), { recursive: true });
    const single = await createTicket(cookie, 'Create folder ' + SINGLE_FOLDER);
    const singleRun = await waitForTerminalRun(single.run.id);
    const singleSnapshot = readSnapshot(singleRun.id);
    const singleEvent = postconditionEvent(singleSnapshot);
    assert(singleRun.status === 'completed', 'Single-folder run should still complete');
    assert(singleEvent, 'Single-folder run did not emit run:postcondition_completed');
    assert(JSON.stringify(singleEvent.checkedPaths || []) === JSON.stringify([
      { type: 'folder', path: SINGLE_FOLDER }
    ]), 'Single-folder run checked unexpected paths');

    fs.mkdirSync(path.join(WORKSPACE_ROOT, AMBIGUOUS_FOLDER), { recursive: true });
    const ambiguous = await createTicket(cookie, 'Create folder ' + AMBIGUOUS_FOLDER + ' and write summary');
    const ambiguousRun = await waitForTerminalRun(ambiguous.run.id);
    const ambiguousSnapshot = readSnapshot(ambiguousRun.id);
    assert(!hasPostconditionCompleted(ambiguousSnapshot), 'Ambiguous prose emitted run:postcondition_completed');
    assert(ambiguousRun.status !== 'completed', 'Ambiguous prose should not complete through the obvious shortcut');

    console.log('PASS: direct folder-list postconditions require every requested folder');
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

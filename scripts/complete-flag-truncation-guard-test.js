#!/usr/bin/env node
const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const STAMP = Date.now();
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'complete-truncation-data-'));
const WORKSPACE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'complete-truncation-workspace-'));
const PORT = String(6100 + Math.floor(Math.random() * 300));
const BASE_URL = 'http://127.0.0.1:' + PORT;
const CAPTURE_FILE = path.join(os.tmpdir(), 'complete-truncation-capture-' + process.pid + '-' + STAMP + '.json');
const OBJECTIVE_MARKER = 'COMPLETE-TRUNCATION-' + STAMP;
const FOLDER_A = 'complete-truncation-a-' + STAMP;
const FOLDER_B = 'complete-truncation-b-' + STAMP;
const FOLDER_C = 'complete-truncation-c-' + STAMP;

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

  const agents = readJson('agents.json').filter(agent => agent.name !== 'Complete Truncation Agent');
  agents.push({
    id: 9801,
    name: 'Complete Truncation Agent',
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
  const preloadPath = path.join(os.tmpdir(), 'complete-truncation-openai-' + process.pid + '-' + STAMP + '.js');
  const source = `
const fs = require('fs');
const captureFile = ${JSON.stringify(CAPTURE_FILE)};
const marker = ${JSON.stringify(OBJECTIVE_MARKER)};
let callCount = 0;

function readCapture() {
  try { return JSON.parse(fs.readFileSync(captureFile, 'utf8')); }
  catch (_) { return { prompts: [] }; }
}

function writeCapture(value) {
  fs.writeFileSync(captureFile, JSON.stringify(value, null, 2));
}

function ok(plan) {
  return {
    ok: true,
    status: 200,
    headers: new Map([['x-request-id', 'complete-truncation']]),
    async text() {
      return JSON.stringify({
        output_text: JSON.stringify(plan),
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 }
      });
    }
  };
}

global.fetch = async function(_url, options = {}) {
  callCount += 1;
  const body = JSON.parse(options.body || '{}');
  const combined = (Array.isArray(body.input) ? body.input : [])
    .map(item => item && item.content ? String(item.content) : '')
    .join('\\n');
  const capture = readCapture();
  capture.prompts.push({ callCount, combined });
  writeCapture(capture);

  if (!combined.includes(marker)) {
    throw new Error('Unexpected prompt in complete truncation test');
  }

  if (callCount === 1) {
    return ok({
      message: 'Create all three folders and mark complete.',
      actions: [
        { operation: 'createFolder', args: { path: 'complete-truncation-a-${STAMP}' } },
        { operation: 'createFolder', args: { path: 'complete-truncation-b-${STAMP}' } },
        { operation: 'createFolder', args: { path: 'complete-truncation-c-${STAMP}' } }
      ],
      complete: true
    });
  }

  if (!combined.includes('complete:true was not honored because 1 proposed action(s) were not applied')) {
    throw new Error('Second prompt did not explain deferred complete:true after truncation');
  }

  return ok({
    message: 'Apply the remaining dropped folder.',
    actions: [
      { operation: 'createFolder', args: { path: 'complete-truncation-c-${STAMP}' } }
    ],
    complete: true
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

async function waitFor(fn, timeoutMs = 30000, intervalMs = 100) {
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
    if (server && server.exitCode !== null) throw new Error('Server exited before ready');
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

async function createTicket(cookie) {
  const response = await request('POST', '/tickets', {
    cookie,
    form: {
      objective: OBJECTIVE_MARKER + ' create folders a, b, and c',
      assignmentTargetType: 'agent',
      assignmentTargetId: '9801',
      assignmentMode: 'individual'
    }
  });
  assert(response.statusCode === 302, 'Ticket create failed with HTTP ' + response.statusCode + ': ' + response.body);
  return waitFor(() => {
    const ticket = readJson('tickets.json').find(item => item.objective.includes(OBJECTIVE_MARKER));
    if (!ticket) return null;
    const run = readJson('runs.json').find(item => item.ticketId === ticket.id);
    return run ? { ticket, run } : null;
  });
}

function readEvents() {
  return fs.readFileSync(path.join(DATA_DIR, 'events.jsonl'), 'utf8')
    .split('\n')
    .filter(line => line.trim())
    .map(line => JSON.parse(line));
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
        ENABLE_PREFIX_TRUNCATION: 'true',
        AGENT_MAX_MUTATING_ACTIONS_PER_RESPONSE: '2'
      },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    server.stdout.on('data', chunk => { output += String(chunk); });
    server.stderr.on('data', chunk => { output += String(chunk); });

    await waitForReady();
    const cookie = await login();
    const { run } = await createTicket(cookie);
    const finalRun = await waitFor(() => {
      const latest = readJson('runs.json').find(item => item.id === run.id);
      return latest && ['completed', 'failed', 'interrupted'].includes(latest.status) ? latest : null;
    });

    assert(finalRun.status === 'completed', 'Run should complete after remaining action is applied, got ' + finalRun.status);

    const history = readJson('operation-history.json').filter(item => item.runId === run.id);
    const createdPaths = history.map(item => item.result && item.result.path).filter(Boolean).sort();
    assert(createdPaths.includes(FOLDER_A), 'First allowed action did not execute');
    assert(createdPaths.includes(FOLDER_B), 'Second allowed action did not execute');
    assert(createdPaths.includes(FOLDER_C), 'Dropped action was not applied by later response');
    assert(history.length === 3, 'Expected exactly 3 committed mutating operations, got ' + history.length);

    const capture = JSON.parse(fs.readFileSync(CAPTURE_FILE, 'utf8'));
    assert(capture.prompts.length >= 2, 'Expected at least two model calls');
    assert(capture.prompts[1].combined.includes('complete:true was not honored because 1 proposed action(s) were not applied'), 'Second prompt did not include deferred complete:true truncation warning');

    // Post-terminal evidence lands through several sinks. operation-history is
    // persisted synchronously, but events.jsonl is appended asynchronously
    // (eventAppendChain), and the replay snapshot is finalized around the same
    // time. Under back-to-back load the run can read terminal in runs.json before
    // the final workspace.operation / run.terminalized events have flushed, so
    // poll until all the evidence is present rather than reading once. This is a
    // test-timing fix only; it changes no runtime behavior and still fails if the
    // evidence never appears (waitFor times out → evidence is null).
    const evidence = await waitFor(() => {
      const logs = readJson('logs.json').filter(log => log.runId === run.id);
      const hasDeferredLog = logs.some(log => log.type === 'run:completion_deferred_truncation');
      let snapshot;
      try {
        snapshot = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'replay-snapshots', 'run-' + run.id + '.json'), 'utf8'));
      } catch (_) {
        return null;
      }
      const hasDeferredReplayEvent = Array.isArray(snapshot.events) && snapshot.events.some(event => event.type === 'run:completion_deferred_truncation');
      const events = readEvents();
      const finalMutationIndex = events.findIndex(event =>
        event.type === 'workspace.operation' &&
        event.payload &&
        event.payload.path === FOLDER_C
      );
      const terminalIndex = events.findIndex(event => event.type === 'run.terminalized');
      if (hasDeferredLog && hasDeferredReplayEvent && finalMutationIndex !== -1 && terminalIndex !== -1) {
        return { hasDeferredLog, hasDeferredReplayEvent, finalMutationIndex, terminalIndex };
      }
      return null;
    });
    assert(evidence, 'Deferred-completion evidence (logs/replay snapshot/events) did not become available before timeout');
    assert(evidence.hasDeferredLog, 'Deferred completion log was not emitted');
    assert(evidence.hasDeferredReplayEvent, 'Deferred completion replay event was not emitted');
    assert(evidence.finalMutationIndex !== -1, 'Final dropped mutation event was not emitted');
    assert(evidence.terminalIndex !== -1, 'Terminal event was not emitted');
    assert(evidence.finalMutationIndex < evidence.terminalIndex, 'Run terminalized before the remaining dropped action was applied');

    console.log('PASS: complete:true is deferred after prefix truncation drops mutating actions');
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
    try { fs.rmSync(CAPTURE_FILE, { force: true }); } catch (_) {}
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
    fs.rmSync(WORKSPACE_ROOT, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(error.stack || error.message);
  process.exit(1);
});

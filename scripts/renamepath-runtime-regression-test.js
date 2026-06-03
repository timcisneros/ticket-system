#!/usr/bin/env node
// RenamePath Conflict Fix — Runtime-Level Regression Test
// Verifies the findConflictingMutation carve-out works end-to-end
// through the actual server runtime with mocked model responses.

const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const STAMP = Date.now();
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'rename-runtime-data-'));
const WORKSPACE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'rename-runtime-workspace-'));
const PORT = String(5400 + Math.floor(Math.random() * 400));
const BASE_URL = 'http://127.0.0.1:' + PORT;
let server = null;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

function writeJson(file, value) {
  fs.writeFileSync(path.join(DATA_DIR, file), JSON.stringify(value, null, 2));
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(path.join(DATA_DIR, file), 'utf8'));
}

function copySeed(file) {
  const src = path.join(ROOT, 'data', file);
  const dst = path.join(DATA_DIR, file);
  fs.writeFileSync(dst, fs.existsSync(src) ? fs.readFileSync(src, 'utf8') : '[]');
}

function seedData() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(path.join(DATA_DIR, 'replay-snapshots'), { recursive: true });
  fs.mkdirSync(WORKSPACE_ROOT, { recursive: true });
  for (const file of ['users.json', 'agents.json', 'groups.json', 'memberships.json', 'permissions.json', 'workflows.json']) {
    copySeed(file);
  }
  const agents = readJson('agents.json').filter(agent => agent.name !== 'Runtime Conflict Agent');
  agents.push({
    id: 9901,
    name: 'Runtime Conflict Agent',
    description: 'Mocked runtime conflict regression agent',
    provider: 'openai',
    model: 'gpt-test',
    apiKey: 'test-key',
    groupIds: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  });
  writeJson('agents.json', agents);
  writeJson('tickets.json', []);
  writeJson('runs.json', []);
  writeJson('logs.json', []);
  writeJson('operation-history.json', []);
  writeJson('allocation-plans.json', []);
  fs.writeFileSync(path.join(DATA_DIR, 'events.jsonl'), '');

  // Pre-seed workspace for case 5 (double rename)
  fs.writeFileSync(path.join(WORKSPACE_ROOT, 'source-5.txt'), 'preseed');
}

function createFakeOpenAIPreload() {
  const preloadPath = path.join(os.tmpdir(), 'rename-runtime-openai-' + process.pid + '-' + STAMP + '.js');
  const source = `
function okResponse(plan) {
  return {
    ok: true,
    status: 200,
    headers: new Map([['x-request-id', 'fake-rename-runtime']]),
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
  const input = Array.isArray(body.input) ? body.input : [];
  const combined = input.map(item => item && item.content ? String(item.content) : '').join('\\n');

  if (combined.includes('RENAME-RUNTIME-1')) {
    return okResponse({
      message: 'Create source then rename to destination.',
      actions: [
        { operation: 'writeFile', args: { path: 'source-1-' + '${STAMP}' + '.txt', content: 'test1' } },
        { operation: 'renamePath', args: { path: 'source-1-' + '${STAMP}' + '.txt', nextPath: 'dest-1-' + '${STAMP}' + '.txt' } }
      ],
      complete: true
    });
  }

  if (combined.includes('RENAME-RUNTIME-2')) {
    return okResponse({
      message: 'Create folder then rename to destination.',
      actions: [
        { operation: 'createFolder', args: { path: 'source-2-' + '${STAMP}' } },
        { operation: 'renamePath', args: { path: 'source-2-' + '${STAMP}', nextPath: 'dest-2-' + '${STAMP}' } }
      ],
      complete: true
    });
  }

  if (combined.includes('RENAME-RUNTIME-3')) {
    return okResponse({
      message: 'Write then delete.',
      actions: [
        { operation: 'writeFile', args: { path: 'conflict-3-' + '${STAMP}' + '.txt', content: 'test3' } },
        { operation: 'deletePath', args: { path: 'conflict-3-' + '${STAMP}' + '.txt' } }
      ],
      complete: true
    });
  }

  if (combined.includes('RENAME-RUNTIME-4')) {
    return okResponse({
      message: 'Create folder then write file.',
      actions: [
        { operation: 'createFolder', args: { path: 'conflict-4-' + '${STAMP}' } },
        { operation: 'writeFile', args: { path: 'conflict-4-' + '${STAMP}', content: 'test4' } }
      ],
      complete: true
    });
  }

  if (combined.includes('RENAME-RUNTIME-5')) {
    return okResponse({
      message: 'Double rename.',
      actions: [
        { operation: 'renamePath', args: { path: 'source-5.txt', nextPath: 'dest-5a-' + '${STAMP}' + '.txt' } },
        { operation: 'renamePath', args: { path: 'source-5.txt', nextPath: 'dest-5b-' + '${STAMP}' + '.txt' } }
      ],
      complete: true
    });
  }

  return okResponse({ message: 'No matching fixture.', actions: [], complete: true });
};
`;
  fs.writeFileSync(preloadPath, source);
  return preloadPath;
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

async function waitFor(fn, timeoutMs = 30000, intervalMs = 100) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await fn();
    if (result) return result;
    await sleep(intervalMs);
  }
  throw new Error('Timed out waiting for condition');
}

async function startServer(preloadPath) {
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
  const res = await httpReq('POST', '/login', { form: { username: 'admin', password: 'admin123' } });
  assert(res.status === 302, 'login should redirect after success');
  const setCookie = Array.isArray(res.headers['set-cookie']) ? res.headers['set-cookie'][0] : res.headers['set-cookie'];
  const match = String(setCookie || '').match(/sessionId=([^;]+)/);
  assert(match, 'login should set session cookie');
  return 'sessionId=' + match[1];
}

async function createTicket(cookie, objective) {
  const res = await httpReq('POST', '/tickets', {
    cookie,
    form: {
      objective,
      assignmentTargetType: 'agent',
      assignmentTargetId: '9901',
      assignmentMode: 'individual'
    }
  });
  assert(res.status === 302, 'ticket create should redirect, got HTTP ' + res.status);
  return waitFor(() => {
    const ticket = readJson('tickets.json').find(item => item.objective === objective);
    if (!ticket) return null;
    const run = readJson('runs.json').find(item => item.ticketId === ticket.id);
    return run ? { ticket, run } : null;
  });
}

async function waitForTerminalRun(runId) {
  return waitFor(() => {
    const run = readJson('runs.json').find(item => item.id === runId);
    return run && ['completed', 'failed', 'interrupted'].includes(run.status) ? run : null;
  }, 45000, 100);
}

async function runCase(cookie, marker, expectedStatus, expectedErrorContains = null) {
  const objective = marker + ' RenamePath runtime conflict regression ' + STAMP;
  const { run } = await createTicket(cookie, objective);
  const finalRun = await waitForTerminalRun(run.id);
  assert(finalRun.status === expectedStatus, marker + ' should end as ' + expectedStatus + ', got ' + finalRun.status + ': ' + (finalRun.error || ''));
  if (expectedErrorContains) {
    assert(finalRun.error && finalRun.error.includes(expectedErrorContains), marker + ' error should contain "' + expectedErrorContains + '", got: ' + (finalRun.error || ''));
  }
  return finalRun;
}

async function main() {
  seedData();
  const preloadPath = createFakeOpenAIPreload();
  try {
    await startServer(preloadPath);
    const cookie = await login();

    // Case 1: writeFile(source) -> renamePath(source -> destination) should succeed
    const case1 = await runCase(cookie, 'RENAME-RUNTIME-1', 'completed');
    assert(!fs.existsSync(path.join(WORKSPACE_ROOT, 'source-1-' + STAMP + '.txt')), 'Case 1: source should not exist after rename');
    assert(fs.existsSync(path.join(WORKSPACE_ROOT, 'dest-1-' + STAMP + '.txt')), 'Case 1: destination should exist after rename');
    console.log('  ✓ Case 1: writeFile -> renamePath succeeds');

    // Case 2: createFolder(source) -> renamePath(source -> destination) should succeed
    const case2 = await runCase(cookie, 'RENAME-RUNTIME-2', 'completed');
    assert(!fs.existsSync(path.join(WORKSPACE_ROOT, 'source-2-' + STAMP)), 'Case 2: source folder should not exist after rename');
    assert(fs.existsSync(path.join(WORKSPACE_ROOT, 'dest-2-' + STAMP)), 'Case 2: destination folder should exist after rename');
    console.log('  ✓ Case 2: createFolder -> renamePath succeeds');

    // Case 3: writeFile(path) -> deletePath(path) should fail with conflict
    const case3 = await runCase(cookie, 'RENAME-RUNTIME-3', 'failed', 'Conflicting mutation already committed');
    console.log('  ✓ Case 3: writeFile -> deletePath still blocked');

    // Case 4: createFolder(path) -> writeFile(path) should fail with conflict
    const case4 = await runCase(cookie, 'RENAME-RUNTIME-4', 'failed', 'Conflicting mutation already committed');
    console.log('  ✓ Case 4: createFolder -> writeFile still blocked');

    // Case 5: renamePath(source->a) -> renamePath(source->b) should fail with conflict
    const case5 = await runCase(cookie, 'RENAME-RUNTIME-5', 'failed', 'Conflicting mutation already committed');
    assert(fs.existsSync(path.join(WORKSPACE_ROOT, 'dest-5a-' + STAMP + '.txt')), 'Case 5: first rename destination should exist');
    assert(!fs.existsSync(path.join(WORKSPACE_ROOT, 'dest-5b-' + STAMP + '.txt')), 'Case 5: second rename destination should not exist');
    console.log('  ✓ Case 5: renamePath -> renamePath on same source still blocked');

    console.log('\nAll renamePath runtime conflict regression assertions passed.\n');
  } finally {
    await stopServer();
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
    fs.rmSync(WORKSPACE_ROOT, { recursive: true, force: true });
    try { fs.unlinkSync(preloadPath); } catch (_) {}
  }
}

main().catch(async error => {
  await stopServer();
  console.error(error.stack || error.message);
  process.exit(1);
});

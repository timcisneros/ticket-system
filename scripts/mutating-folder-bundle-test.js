#!/usr/bin/env node
const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const STAMP = Date.now();
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mutating-folder-bundle-data-'));
const WORKSPACE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'mutating-folder-bundle-workspace-'));
const PORT = String(4500 + Math.floor(Math.random() * 400));
const BASE_URL = 'http://127.0.0.1:' + PORT;

let server = null;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

function readJson(file) {
  return JSON.parse(fs.readFileSync(path.join(DATA_DIR, file), 'utf8'));
}

function writeJson(file, value) {
  fs.writeFileSync(path.join(DATA_DIR, file), JSON.stringify(value, null, 2));
}

function httpReq(method, urlPath, options = {}) {
  return new Promise((resolve, reject) => {
    const body = options.form
      ? new URLSearchParams(options.form).toString()
      : options.body
        ? JSON.stringify(options.body)
        : null;
    const req = http.request(BASE_URL + urlPath, {
      method,
      headers: {
        ...(body ? { 'Content-Type': options.form ? 'application/x-www-form-urlencoded' : 'application/json', 'Content-Length': Buffer.byteLength(body) } : {}),
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

async function waitFor(fn, timeoutMs = 45000, intervalMs = 100) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await fn();
    if (result) return result;
    await sleep(intervalMs);
  }
  throw new Error('Timed out waiting for condition');
}

function seedData() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  for (const file of ['users.json', 'agents.json', 'groups.json', 'memberships.json', 'permissions.json', 'workflows.json']) {
    fs.copyFileSync(path.join(ROOT, 'data', file), path.join(DATA_DIR, file));
  }
  writeJson('tickets.json', []);
  writeJson('runs.json', []);
  writeJson('logs.json', []);
  writeJson('operation-history.json', []);
  writeJson('allocation-plans.json', []);
  fs.writeFileSync(path.join(DATA_DIR, 'events.jsonl'), '');

  const agents = readJson('agents.json');
  const agentId = agents.reduce((max, agent) => Math.max(max, agent.id || 0), 0) + 1;
  agents.push({ id: agentId, name: 'Mutating Bundle Agent', provider: 'openai', model: 'fake-mutating-bundle', apiKey: 'fake-key', createdAt: new Date().toISOString(), runtimeConfig: {} });
  writeJson('agents.json', agents);
  return agentId;
}

function createFakeOpenAIPreload() {
  const preloadPath = path.join(os.tmpdir(), 'mutating-folder-bundle-openai-' + process.pid + '-' + STAMP + '.js');
  const source = `
function okResponse(plan) {
  return {
    ok: true,
    status: 200,
    headers: new Map([['x-request-id', 'fake-mutating-folder-bundle']]),
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
  const stamp = '${STAMP}';

  if (combined.includes('VALID-BUNDLE-' + stamp)) {
    return okResponse({
      message: 'Create one folder and two files inside it.',
      actions: [
        { operation: 'createFolder', args: { path: 'bundle-' + stamp } },
        { operation: 'writeFile', args: { path: 'bundle-' + stamp + '/a.txt', content: 'a-' + stamp } },
        { operation: 'writeFile', args: { path: 'bundle-' + stamp + '/b.txt', content: 'b-' + stamp } }
      ],
      complete: true
    });
  }

  if (combined.includes('THREE-WRITES-' + stamp)) {
    return okResponse({
      message: 'Propose three independent writes.',
      actions: [
        { operation: 'writeFile', args: { path: 'three-' + stamp + '-a.txt', content: 'a' } },
        { operation: 'writeFile', args: { path: 'three-' + stamp + '-b.txt', content: 'b' } },
        { operation: 'writeFile', args: { path: 'three-' + stamp + '-c.txt', content: 'c' } }
      ],
      complete: true
    });
  }

  if (combined.includes('OUTSIDE-BUNDLE-' + stamp)) {
    return okResponse({
      message: 'Propose a folder bundle with one outside write.',
      actions: [
        { operation: 'createFolder', args: { path: 'outside-bundle-' + stamp } },
        { operation: 'writeFile', args: { path: 'outside-bundle-' + stamp + '/inside.txt', content: 'inside' } },
        { operation: 'writeFile', args: { path: 'outside-bundle-' + stamp + '-outside.txt', content: 'outside' } }
      ],
      complete: true
    });
  }

  if (combined.includes('FOUR-MUTATIONS-' + stamp)) {
    return okResponse({
      message: 'Propose four mutations.',
      actions: [
        { operation: 'createFolder', args: { path: 'four-' + stamp } },
        { operation: 'writeFile', args: { path: 'four-' + stamp + '/a.txt', content: 'a' } },
        { operation: 'writeFile', args: { path: 'four-' + stamp + '/b.txt', content: 'b' } },
        { operation: 'writeFile', args: { path: 'four-' + stamp + '/c.txt', content: 'c' } }
      ],
      complete: true
    });
  }

  return okResponse({ message: 'No matching objective.', actions: [], complete: true });
};
`;
  fs.writeFileSync(preloadPath, source);
  return preloadPath;
}

function startServer(preloadPath) {
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
  return waitFor(async () => {
    if (server && server.exitCode !== null) {
      throw new Error('server exited during startup: ' + output.slice(-1000));
    }
    try {
      const res = await httpReq('GET', '/login');
      return res.status === 200;
    } catch (_) {
      return false;
    }
  }, 15000, 100);
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

async function createTicket(cookie, agentId, objective) {
  const res = await httpReq('POST', '/tickets', {
    cookie,
    form: {
      objective,
      assignmentTargetType: 'agent',
      assignmentTargetId: String(agentId),
      assignmentMode: 'individual'
    }
  });
  assert(res.status === 302, 'ticket create should redirect, got HTTP ' + res.status);
  return waitFor(() => {
    const ticket = readJson('tickets.json').find(item => item.objective === objective);
    if (!ticket) return null;
    const run = readJson('runs.json').find(item => item.ticketId === ticket.id);
    return run ? { ticket, run } : null;
  }, 15000, 100);
}

async function waitForTerminalRun(runId) {
  return waitFor(() => {
    const run = readJson('runs.json').find(item => item.id === runId);
    return run && ['completed', 'failed', 'interrupted'].includes(run.status) ? run : null;
  }, 45000, 100);
}

function readFile(relativePath) {
  const fullPath = path.join(WORKSPACE_ROOT, relativePath);
  return fs.existsSync(fullPath) ? fs.readFileSync(fullPath, 'utf8') : null;
}

async function runCase(cookie, agentId, marker, expectedStatus) {
  const objective = marker + ': execute mutating folder bundle regression ' + STAMP + '.';
  const { ticket, run } = await createTicket(cookie, agentId, objective);
  const finalRun = await waitForTerminalRun(run.id);
  const finalTicket = readJson('tickets.json').find(item => item.id === ticket.id);
  assert(finalRun.status === expectedStatus, marker + ' run expected ' + expectedStatus + ', got ' + finalRun.status + ': ' + (finalRun.error || ''));
  assert(finalTicket.status === expectedStatus, marker + ' ticket expected ' + expectedStatus + ', got ' + finalTicket.status);
  return { ticket, run: finalRun };
}

async function main() {
  const agentId = seedData();
  const preloadPath = createFakeOpenAIPreload();
  try {
    await startServer(preloadPath);
    const cookie = await login();

    const valid = await runCase(cookie, agentId, 'VALID-BUNDLE-' + STAMP, 'completed');
    assert(readFile('bundle-' + STAMP + '/a.txt') === 'a-' + STAMP, 'valid bundle should write a.txt');
    assert(readFile('bundle-' + STAMP + '/b.txt') === 'b-' + STAMP, 'valid bundle should write b.txt');
    const validHistory = readJson('operation-history.json').filter(item => item.runId === valid.run.id);
    assert(validHistory.length === 3, 'valid bundle should commit three mutations');

    const threeWrites = await runCase(cookie, agentId, 'THREE-WRITES-' + STAMP, 'failed');
    assert(String(threeWrites.run.error || '').includes('Model repeatedly proposed too many mutating actions'), 'three independent writes should fail on mutating limit');
    assert(readJson('operation-history.json').filter(item => item.runId === threeWrites.run.id).length === 0, 'three independent writes should not commit mutations');

    const outside = await runCase(cookie, agentId, 'OUTSIDE-BUNDLE-' + STAMP, 'failed');
    assert(String(outside.run.error || '').includes('Model repeatedly proposed too many mutating actions'), 'outside-folder write shape should fail on mutating limit');
    assert(readJson('operation-history.json').filter(item => item.runId === outside.run.id).length === 0, 'outside-folder write shape should not commit mutations');

    const four = await runCase(cookie, agentId, 'FOUR-MUTATIONS-' + STAMP, 'failed');
    assert(String(four.run.error || '').includes('Model repeatedly proposed too many mutating actions'), 'four mutations should fail on mutating limit');
    assert(readJson('operation-history.json').filter(item => item.runId === four.run.id).length === 0, 'four mutations should not commit mutations');

    console.log(JSON.stringify({
      mutatingFolderBundle: true,
      validRunStatus: valid.run.status,
      threeWritesStatus: threeWrites.run.status,
      outsideBundleStatus: outside.run.status,
      fourMutationsStatus: four.run.status,
      validHistoryCount: validHistory.length
    }));
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

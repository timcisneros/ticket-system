#!/usr/bin/env node
const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const STAMP = Date.now();
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'write-conflict-protection-data-'));
const WORKSPACE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'write-conflict-protection-workspace-'));
const PORT = String(3900 + Math.floor(Math.random() * 400));
const BASE_URL = 'http://127.0.0.1:' + PORT;
const TARGET = 'write-conflict-' + STAMP + '.txt';
const CONTENT_A = 'ticket-a-' + STAMP;
const CONTENT_B = 'ticket-b-' + STAMP;

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

async function waitFor(fn, timeoutMs = 30000, intervalMs = 100) {
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
  const seed = ['users.json', 'agents.json', 'groups.json', 'memberships.json', 'permissions.json', 'workflows.json'];
  for (const file of seed) {
    fs.copyFileSync(path.join(ROOT, 'data', file), path.join(DATA_DIR, file));
  }
  writeJson('tickets.json', []);
  writeJson('runs.json', []);
  writeJson('logs.json', []);
  writeJson('operation-history.json', []);
  writeJson('allocation-plans.json', []);
  fs.writeFileSync(path.join(DATA_DIR, 'events.jsonl'), '');

  const agents = readJson('agents.json');
  const nextAgentId = agents.reduce((max, agent) => Math.max(max, agent.id || 0), 0) + 1;
  agents.push({ id: nextAgentId, name: 'Write Conflict Agent A', provider: 'openai', model: 'fake-openai-a', apiKey: 'fake-key-a', createdAt: new Date().toISOString(), runtimeConfig: {} });
  agents.push({ id: nextAgentId + 1, name: 'Write Conflict Agent B', provider: 'openai', model: 'fake-openai-b', apiKey: 'fake-key-b', createdAt: new Date().toISOString(), runtimeConfig: {} });
  writeJson('agents.json', agents);
  return { agentA: nextAgentId, agentB: nextAgentId + 1 };
}

function createFakeOpenAIPreload() {
  const preloadPath = path.join(os.tmpdir(), 'write-conflict-openai-' + process.pid + '-' + STAMP + '.js');
  const lines = [
    'function okResponse(plan) {',
    '  return {',
    '    ok: true,',
    '    status: 200,',
    "    headers: new Map([['x-request-id', 'fake-write-conflict']]),",
    '    async text() {',
    '      return JSON.stringify({',
    '        output_text: JSON.stringify(plan),',
    '        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 }',
    '      });',
    '    }',
    '  };',
    '}',
    'global.fetch = async function(_url, options = {}) {',
    "  const body = JSON.parse(options.body || '{}');",
    '  const input = Array.isArray(body.input) ? body.input : [];',
    "  const combined = input.map(item => item && item.content ? String(item.content) : '').join('\\n');",
    '  if (combined.includes(process.env.TEST_WRITE_CONFLICT_CONTENT_A)) {',
    "    return okResponse({ message: 'write ticket A output', actions: [{ operation: 'writeFile', args: { path: process.env.TEST_WRITE_CONFLICT_TARGET, content: process.env.TEST_WRITE_CONFLICT_CONTENT_A } }], complete: true });",
    '  }',
    '  if (combined.includes(process.env.TEST_WRITE_CONFLICT_CONTENT_B)) {',
    "    return okResponse({ message: 'write ticket B output', actions: [{ operation: 'writeFile', args: { path: process.env.TEST_WRITE_CONFLICT_TARGET, content: process.env.TEST_WRITE_CONFLICT_CONTENT_B } }], complete: true });",
    '  }',
    "  return okResponse({ message: 'no matching objective', actions: [], complete: true });",
    '};'
  ];
  fs.writeFileSync(preloadPath, lines.join('\n'));
  return preloadPath;
}

function startServer(preloadPath) {
  const env = {
    ...process.env,
    NODE_ENV: 'test',
    PORT,
    DATA_DIR,
    WORKSPACE_ROOT,
    NODE_OPTIONS: '--require ' + preloadPath,
    TEST_WRITE_CONFLICT_TARGET: TARGET,
    TEST_WRITE_CONFLICT_CONTENT_A: CONTENT_A,
    TEST_WRITE_CONFLICT_CONTENT_B: CONTENT_B
  };
  server = spawn(process.execPath, ['server.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
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

async function waitForFreshTerminalRun(ticketId, priorRunIds) {
  return waitFor(() => {
    const run = readJson('runs.json').find(item => item.ticketId === ticketId && !priorRunIds.has(item.id) && ['completed', 'failed', 'interrupted'].includes(item.status));
    return run || null;
  }, 45000, 100);
}

async function main() {
  const agents = seedData();
  const preloadPath = createFakeOpenAIPreload();
  const objectiveA = 'Cross-ticket write conflict regression ' + STAMP + ': write file ' + TARGET + ' containing exactly ' + CONTENT_A + '.';
  const objectiveB = 'Cross-ticket write conflict regression ' + STAMP + ': write file ' + TARGET + ' containing exactly ' + CONTENT_B + '.';

  try {
    await startServer(preloadPath);
    const cookie = await login();
    const first = await createTicket(cookie, agents.agentA, objectiveA);
    const firstRun = await waitForTerminalRun(first.run.id);
    assert(firstRun.status === 'completed', 'first ticket should complete, got ' + firstRun.status);

    const second = await createTicket(cookie, agents.agentB, objectiveB);
    const secondRun = await waitForTerminalRun(second.run.id);
    assert(secondRun.status === 'failed', 'second ticket should fail on write conflict, got ' + secondRun.status);
    assert(String(secondRun.error || '').includes('Workspace write conflict: path was previously produced by ticket ' + first.ticket.id + ', run ' + firstRun.id), 'second run error should identify prior ticket/run conflict');

    const historyAfterConflict = readJson('operation-history.json').filter(item => item.args && item.args.path === TARGET);
    assert(historyAfterConflict.length === 1, 'failed cross-ticket write must not create operation history');
    assert(historyAfterConflict[0].ticketId === first.ticket.id, 'only first ticket should own the path after conflict');

    const rerunRes = await httpReq('POST', '/api/tickets/' + first.ticket.id + '/rerun', { cookie, body: {} });
    assert(rerunRes.status === 200, 'same-ticket rerun should be accepted, got HTTP ' + rerunRes.status + ': ' + rerunRes.body);
    const rerunRun = await waitForFreshTerminalRun(first.ticket.id, new Set([firstRun.id]));
    assert(rerunRun.status === 'completed', 'same-ticket rerun should complete, got ' + rerunRun.status);

    const finalHistory = readJson('operation-history.json').filter(item => item.args && item.args.path === TARGET);
    assert(finalHistory.length === 2, 'same-ticket rerun should create a second write history record');
    assert(finalHistory[1].ticketId === first.ticket.id, 'same-ticket rerun history should belong to first ticket');
    assert(finalHistory[1].runId === rerunRun.id, 'same-ticket rerun history should belong to rerun run');
    assert(finalHistory[1].preState && finalHistory[1].preState.existed === true, 'same-ticket rerun should write over existing own output');
    assert(fs.readFileSync(path.join(WORKSPACE_ROOT, TARGET), 'utf8') === CONTENT_A, 'final content should remain ticket A content');

    console.log(JSON.stringify({
      writeConflictProtection: true,
      firstRunStatus: firstRun.status,
      secondRunStatus: secondRun.status,
      secondRunError: secondRun.error,
      rerunRunStatus: rerunRun.status,
      historyCount: finalHistory.length,
      target: TARGET
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

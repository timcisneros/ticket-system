#!/usr/bin/env node
const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const STAMP = Date.now();
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-obvious-postcondition-data-'));
const WORKSPACE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-obvious-postcondition-workspace-'));
const PORT = String(3600 + Math.floor(Math.random() * 500));
const BASE_URL = 'http://127.0.0.1:' + PORT;
const FOLDER = 'restart-validation-' + STAMP;
const FILE_A = FOLDER + '/a.txt';
const FILE_B = FOLDER + '/b.txt';
const CONTENT_A = 'A-' + STAMP;
const CONTENT_B = 'B-' + STAMP;

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

function readEvents() {
  const fp = path.join(DATA_DIR, 'events.jsonl');
  if (!fs.existsSync(fp)) return [];
  return fs.readFileSync(fp, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
}

function httpReq(method, urlPath, options = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(BASE_URL + urlPath, { method, headers: options.headers || {} }, res => {
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    if (options.body) req.write(options.body);
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

function createFakeOpenAIPreload() {
  const preloadPath = path.join(os.tmpdir(), 'resume-obvious-postcondition-openai-' + process.pid + '-' + Date.now() + '.js');
  const source = `
const fs = require('fs');
const path = require('path');
const workspaceRoot = process.env.WORKSPACE_ROOT;
const folder = process.env.TEST_RESTART_FOLDER;
const fileA = process.env.TEST_RESTART_FILE_A;
const fileB = process.env.TEST_RESTART_FILE_B;
const contentA = process.env.TEST_RESTART_CONTENT_A;
const contentB = process.env.TEST_RESTART_CONTENT_B;

function exists(relativePath) {
  return fs.existsSync(path.join(workspaceRoot, relativePath));
}

function okResponse(plan) {
  return {
    ok: true,
    status: 200,
    headers: new Map([['x-request-id', 'fake-resume-obvious-postcondition']]),
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

  if (combined.includes('restart recovery obvious postcondition regression')) {
    if (exists(folder) && !exists(fileA)) {
      return okResponse({
        message: 'Resume by writing the first missing file.',
        actions: [
          { operation: 'writeFile', args: { path: fileA, content: contentA } }
        ],
        complete: false
      });
    }

    if (exists(folder) && exists(fileA) && !exists(fileB)) {
      return okResponse({
        message: 'Continue resumed execution by writing the second missing file.',
        actions: [
          { operation: 'writeFile', args: { path: fileB, content: contentB } }
        ],
        complete: true
      });
    }

    return okResponse({
      message: 'Create folder and first file before continuing.',
      actions: [
        { operation: 'createFolder', args: { path: folder } },
        { operation: 'writeFile', args: { path: fileA, content: contentA } }
      ],
      complete: false
    });
  }

  return okResponse({ message: 'No matching objective.', actions: [], complete: true });
};
`;
  fs.writeFileSync(preloadPath, source);
  return preloadPath;
}

function seedData() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const seed = ['users.json', 'agents.json', 'groups.json', 'memberships.json', 'permissions.json', 'workflows.json'];
  for (const file of seed) {
    const source = path.join(ROOT, 'data', file);
    fs.copyFileSync(source, path.join(DATA_DIR, file));
  }
  writeJson('tickets.json', []);
  writeJson('runs.json', []);
  writeJson('logs.json', []);
  writeJson('operation-history.json', []);
  writeJson('allocation-plans.json', []);
  fs.writeFileSync(path.join(DATA_DIR, 'events.jsonl'), '');
}

function startServer(preloadPath, interruptionPoint = '') {
  const env = {
    ...process.env,
    NODE_ENV: 'test',
    PORT,
    DATA_DIR,
    WORKSPACE_ROOT,
    NODE_OPTIONS: '--require ' + preloadPath,
    TEST_RESTART_FOLDER: FOLDER,
    TEST_RESTART_FILE_A: FILE_A,
    TEST_RESTART_FILE_B: FILE_B,
    TEST_RESTART_CONTENT_A: CONTENT_A,
    TEST_RESTART_CONTENT_B: CONTENT_B
  };
  if (interruptionPoint) env.TEST_INTERRUPTION_POINT = interruptionPoint;
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

async function waitForInterruptionAndStop(runId) {
  try {
    await waitFor(() => readEvents().some(event => event.runId === runId && event.type === 'interruption.test_hook'), 15000, 100);
  } catch (error) {
    let details = '';
    try {
      details = JSON.stringify({
        runs: readJson('runs.json'),
        logs: readJson('logs.json'),
        history: readJson('operation-history.json'),
        events: readEvents().map(event => ({ type: event.type, runId: event.runId, payload: event.payload }))
      }, null, 2);
    } catch (_) {}
    throw new Error('interruption point was not reached: ' + details);
  }

  if (server && server.exitCode === null) {
    server.kill('SIGKILL');
    await sleep(500);
  }
  server = null;
}

async function login() {
  const res = await httpReq('POST', '/login', {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'username=admin&password=admin123'
  });
  assert(res.status === 302, 'login should redirect after success');
  const setCookie = Array.isArray(res.headers['set-cookie']) ? res.headers['set-cookie'][0] : res.headers['set-cookie'];
  const match = String(setCookie || '').match(/sessionId=([^;]+)/);
  assert(match, 'login should set session cookie');
  return match[1];
}

async function createTicket(cookie, objective) {
  const res = await httpReq('POST', '/tickets', {
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Cookie: 'sessionId=' + cookie
    },
    body: 'objective=' + encodeURIComponent(objective) + '&assignmentTargetType=agent&assignmentTargetId=1&assignmentMode=individual'
  });
  assert(res.status === 302, 'ticket create should redirect, got HTTP ' + res.status);
  return waitFor(() => {
    const tickets = readJson('tickets.json');
    const ticket = tickets.find(item => item.objective === objective);
    if (!ticket) return null;
    const run = readJson('runs.json').find(item => item.ticketId === ticket.id);
    return run ? { ticket, run } : null;
  }, 15000, 100);
}

async function waitForTerminal(runId) {
  return waitFor(() => {
    const run = readJson('runs.json').find(item => item.id === runId);
    return run && ['completed', 'failed', 'interrupted'].includes(run.status) ? run : null;
  }, 45000, 200);
}

async function main() {
  seedData();
  const preloadPath = createFakeOpenAIPreload();
  const objective = 'restart recovery obvious postcondition regression ' + STAMP + ': create folder ' + FOLDER + ', write file ' + FILE_A + ' containing exactly ' + CONTENT_A + ', and write file ' + FILE_B + ' containing exactly ' + CONTENT_B + '.';

  try {
    await startServer(preloadPath, 'after_first_workspace.operation');
    const cookie = await login();
    const { run } = await createTicket(cookie, objective);
    await waitForInterruptionAndStop(run.id);

    await startServer(preloadPath);
    const finalRun = await waitForTerminal(run.id);

    const history = readJson('operation-history.json').filter(item => item.runId === run.id);
    const events = readEvents().filter(event => event.runId === run.id || event.ticketId === run.ticketId);
    const workspaceFolder = fs.existsSync(path.join(WORKSPACE_ROOT, FOLDER));
    const fileAContent = fs.existsSync(path.join(WORKSPACE_ROOT, FILE_A)) ? fs.readFileSync(path.join(WORKSPACE_ROOT, FILE_A), 'utf8') : null;
    const fileBContent = fs.existsSync(path.join(WORKSPACE_ROOT, FILE_B)) ? fs.readFileSync(path.join(WORKSPACE_ROOT, FILE_B), 'utf8') : null;
    const preModelPostcondition = events.some(event => event.type === 'run:postcondition_completed' && event.payload && event.payload.source === 'pre_model');
    const workspaceObjectiveSatisfied = events.some(event => event.type === 'workspace.objective_satisfied');
    const writeFileHistory = history.filter(item => item.operation === 'writeFile');
    const firstWrite = writeFileHistory[0];
    const secondWrite = writeFileHistory[1];

    assert(finalRun.status === 'completed', 'run should complete after resumed execution, got ' + finalRun.status);
    assert(workspaceFolder, 'folder should exist after first committed mutation');
    assert(fileAContent === CONTENT_A, 'resumed execution should write file A');
    assert(fileBContent === CONTENT_B, 'resumed execution should write file B');
    assert(history.filter(item => item.operation === 'createFolder' && item.args && item.args.path === FOLDER).length === 1, 'createFolder should be committed exactly once');
    assert(writeFileHistory.length === 2, 'two writeFile mutations should be committed after resume');
    assert(firstWrite && firstWrite.args && firstWrite.args.path === FILE_A, 'file A should be the first resumed write');
    assert(secondWrite && secondWrite.args && secondWrite.args.path === FILE_B, 'file B should only be written after the run continues past the partial mutation point');
    assert(!preModelPostcondition, 'resumed run must not complete through pre-model obvious postcondition shortcut');
    assert(!workspaceObjectiveSatisfied, 'resumed run must not complete through post-action workspace objective satisfaction shortcut');

    console.log(JSON.stringify({
      resumeObviousPostconditionRegression: true,
      runStatus: finalRun.status,
      historyCount: history.length,
      fileA: fileAContent,
      fileB: fileBContent
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

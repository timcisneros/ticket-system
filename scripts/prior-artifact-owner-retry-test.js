#!/usr/bin/env node
// Provider-free regression for recoverable prior-artifact ownership conflicts.

const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ticket-owner-retry-data-'));
const WORKSPACE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'ticket-owner-retry-ws-'));
const CAPTURE_FILE = path.join(DATA_DIR, 'requests.jsonl');
const PORT = String(5120 + Math.floor(Math.random() * 200));
const BASE_URL = `http://127.0.0.1:${PORT}`;
const PRIOR_PATH = 'Q1/top-level-folder-names.txt';
const RECOVERY_PATH = 'Q1/top-level-folder-names-ticket-29.txt';
const PRIOR_CONTENT = 'prior artifact\n';
const NEW_CONTENT = 'A\nB\nE\nF\nMichael Jackson songs 1\nMichael Jackson songs 2\nMichael Jackson songs 3\nQ1\nQ2\n';
const VAGUE_OBJECTIVE = 'in Q1 put a txt with all the top-level folder names.';
const EXACT_OBJECTIVE = 'write Q1/top-level-folder-names.txt';

let server = null;
let failures = 0;

function assert(name, condition, detail = '') {
  if (condition) console.log(`  · ${name}: PASS`);
  else { failures += 1; console.log(`  ✗ ${name}: FAIL${detail ? ` — ${detail}` : ''}`); }
}

function readJson(file) { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, file), 'utf8')); }
function writeJson(file, value) { fs.writeFileSync(path.join(DATA_DIR, file), JSON.stringify(value, null, 2)); }
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

function readRuns() {
  return readJson('runs.json').map(run => {
    if (!run.replaySnapshotPath) return run;
    const replayPath = path.join(DATA_DIR, run.replaySnapshotPath);
    return fs.existsSync(replayPath) ? { ...run, replaySnapshot: JSON.parse(fs.readFileSync(replayPath, 'utf8')) } : run;
  });
}

function readEvents() {
  try {
    return fs.readFileSync(path.join(DATA_DIR, 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
  } catch (_) { return []; }
}

function readCaptures() {
  try {
    return fs.readFileSync(CAPTURE_FILE, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
  } catch (_) { return []; }
}

function seedData() {
  for (const file of ['users.json', 'agents.json', 'groups.json', 'memberships.json', 'permissions.json', 'workflows.json']) {
    fs.copyFileSync(path.join(ROOT, 'data', file), path.join(DATA_DIR, file));
  }
  const now = new Date().toISOString();
  const agents = readJson('agents.json');
  const id = Math.max(0, ...agents.map(agent => agent.id || 0)) + 1;
  agents.push({ id, name: 'Owner Retry Agent', provider: 'openai', model: 'fake-owner-retry', apiKey: 'fake-key', createdAt: now, runtimeConfig: {} });
  writeJson('agents.json', agents);
  writeJson('tickets.json', [{ id: 28, objective: 'Prior artifact owner', status: 'completed', createdAt: now, updatedAt: now, createdBy: 'admin' }]);
  writeJson('runs.json', [{
    id: 45,
    ticketId: 28,
    agentId: id,
    agentName: 'Prior Owner Agent',
    workspaceRoot: WORKSPACE_ROOT,
    mainWorkspaceRoot: WORKSPACE_ROOT,
    executionWorkspaceType: 'main',
    executionMode: 'agent',
    capabilityType: 'directAction',
    capabilityId: 'agent-selected-actions',
    executionPolicySnapshot: { requireVerification: 'when_declared' },
    currentPhase: 'terminalization',
    leaseOwner: null,
    leaseExpiresAt: null,
    status: 'completed',
    createdAt: now,
    updatedAt: now,
    startedAt: now,
    completedAt: now
  }]);
  writeJson('logs.json', []);
  writeJson('allocation-plans.json', []);
  writeJson('operation-history.json', [{
    id: 1,
    timestamp: now,
    ticketId: 28,
    runId: 45,
    operation: 'writeFile',
    args: { path: PRIOR_PATH, content: PRIOR_CONTENT },
    preState: { existed: false },
    postState: { existed: true, type: 'file' },
    result: { path: PRIOR_PATH },
    error: null
  }]);
  fs.writeFileSync(path.join(DATA_DIR, 'events.jsonl'), '');
  fs.mkdirSync(path.join(WORKSPACE_ROOT, 'Q1'), { recursive: true });
  fs.writeFileSync(path.join(WORKSPACE_ROOT, PRIOR_PATH), PRIOR_CONTENT);

  return id;
}

function createPreload() {
  const preloadPath = path.join(os.tmpdir(), `owner-retry-preload-${process.pid}-${Date.now()}.js`);
  const source = `
const fs = require('fs');
const captureFile = ${JSON.stringify(CAPTURE_FILE)};
const vagueObjective = ${JSON.stringify(VAGUE_OBJECTIVE)};
const exactObjective = ${JSON.stringify(EXACT_OBJECTIVE)};
const priorPath = ${JSON.stringify(PRIOR_PATH)};
const recoveryPath = ${JSON.stringify(RECOVERY_PATH)};
const newContent = ${JSON.stringify(NEW_CONTENT)};
const counts = new Map();
function ok(plan) { return { ok: true, status: 200, headers: new Map([['x-request-id', 'fake-owner-retry']]), async text() { return JSON.stringify({ output_text: JSON.stringify(plan), usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } }); } }; }
global.fetch = async function(_url, options = {}) {
  const body = JSON.parse(options.body || '{}');
  const input = Array.isArray(body.input) ? body.input : [];
  const combined = input.map(item => item && item.content ? String(item.content) : '').join('\\n');
  let objective = '';
  for (const item of input) { try { const parsed = JSON.parse(item.content); if (parsed && parsed.ticketObjective) objective = parsed.ticketObjective; } catch (_) {} }
  fs.appendFileSync(captureFile, JSON.stringify({ objective, combined }) + '\\n');
  const count = (counts.get(objective) || 0) + 1;
  counts.set(objective, count);
  if (objective === vagueObjective && count > 1) return ok({ message: 'Using a non-conflicting name under Q1.', actions: [{ operation: 'writeFile', args: { path: recoveryPath, content: newContent } }], complete: true });
  if (objective === vagueObjective || objective === exactObjective) return ok({ message: 'Writing the requested file.', actions: [{ operation: 'writeFile', args: { path: priorPath, content: newContent } }], complete: true });
  return ok({ message: 'No action.', actions: [], complete: true });
};
`;
  fs.writeFileSync(preloadPath, source);
  return preloadPath;
}

function request(method, urlPath, options = {}) {
  return new Promise((resolve, reject) => {
    const body = options.form ? new URLSearchParams(options.form).toString() : null;
    const req = http.request(BASE_URL + urlPath, {
      method,
      headers: {
        ...(body ? { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) } : {}),
        ...(options.cookie ? { Cookie: options.cookie } : {})
      }
    }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function waitFor(fn, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await fn();
    if (value) return value;
    await sleep(80);
  }
  return null;
}

async function start(preloadPath) {
  const env = { ...process.env, NODE_ENV: 'test', PORT, DATA_DIR, WORKSPACE_ROOT, NODE_OPTIONS: `--require ${preloadPath}` };
  server = spawn(process.execPath, ['server.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  server.stdout.on('data', chunk => { output += String(chunk); });
  server.stderr.on('data', chunk => { output += String(chunk); });
  const ready = await waitFor(async () => {
    if (server.exitCode !== null) throw new Error(`server exited: ${output.slice(-800)}`);
    try { return (await request('GET', '/login')).status === 200; } catch (_) { return false; }
  }, 15000);
  if (!ready) throw new Error('server did not start');
}

async function login() {
  const response = await request('POST', '/login', { form: { username: 'admin', password: 'admin123' } });
  const header = Array.isArray(response.headers['set-cookie']) ? response.headers['set-cookie'][0] : response.headers['set-cookie'];
  const match = String(header || '').match(/sessionId=([^;]+)/);
  if (!match) throw new Error('login failed');
  return `sessionId=${match[1]}`;
}

async function createTicket(cookie, agentId, objective) {
  await request('POST', '/tickets', { cookie, form: { objective, assignmentTargetType: 'agent', assignmentTargetId: String(agentId), assignmentMode: 'individual' } });
  return readJson('tickets.json').find(ticket => ticket.objective === objective);
}

async function waitForTerminal(ticketId) {
  return waitFor(() => readRuns().find(run => run.ticketId === ticketId && ['completed', 'failed', 'interrupted'].includes(run.status)), 45000);
}

async function main() {
  const agentId = seedData();
  const preloadPath = createPreload();
  console.log('Prior artifact owner retry regression');
  console.log('='.repeat(60));
  try {
    await start(preloadPath);
    const cookie = await login();

    const vagueTicket = await createTicket(cookie, agentId, VAGUE_OBJECTIVE);
    assert('vague objective receives ticket id 29', vagueTicket && vagueTicket.id === 29, `id=${vagueTicket && vagueTicket.id}`);
    const recoveredRun = await waitForTerminal(vagueTicket.id);
    assert('vague objective completes after conflict retry', recoveredRun && recoveredRun.status === 'completed', `status=${recoveredRun && recoveredRun.status}`);
    const captures = readCaptures().filter(item => item.objective === VAGUE_OBJECTIVE);
    assert('runtime made a second model request', captures.length === 2, `requests=${captures.length}`);
    const retryPrompt = captures[1] ? captures[1].combined : '';
    assert('retry names ticket 28/run 45 ownership', /owned by ticket 28\/run 45/.test(retryPrompt));
    assert('retry requires a new non-conflicting filename under Q1', /new non-conflicting filename under Q1\//.test(retryPrompt));
    assert('retry forbids overwrite and delete', /Do not overwrite or delete the existing file/.test(retryPrompt));

    const runHistory = readJson('operation-history.json').filter(item => item.runId === recoveredRun.id && !item.error);
    assert('only recovery write committed for ticket 29', runHistory.length === 1 && runHistory[0].operation === 'writeFile' && runHistory[0].args.path === RECOVERY_PATH, JSON.stringify(runHistory));
    assert('recovery artifact has expected content', fs.readFileSync(path.join(WORKSPACE_ROOT, RECOVERY_PATH), 'utf8') === NEW_CONTENT);
    assert('prior artifact remains untouched', fs.readFileSync(path.join(WORKSPACE_ROOT, PRIOR_PATH), 'utf8') === PRIOR_CONTENT);
    const blockedOp = recoveredRun.replaySnapshot.workspaceOperations.find(item => item.operation && item.operation.args && item.operation.args.path === PRIOR_PATH);
    assert('blocked replay shape is internally consistent', blockedOp && blockedOp.blocked === true && blockedOp.reason === 'prior_artifact_owner' && blockedOp.operation.blocked === true && blockedOp.operation.reason === 'prior_artifact_owner', JSON.stringify(blockedOp));
    const recoveredEvents = readEvents().filter(event => event.runId === recoveredRun.id);
    assert('recovered run has no phase violation', !recoveredEvents.some(event => event.type === 'execution.phase_violation'));
    assert('recovered run has no model stall', !recoveredEvents.some(event => event.type === 'model:stalled'));
    assert('recovered run has no run limit failure', !recoveredEvents.some(event => /RUN_LIMIT_EXCEEDED/.test(JSON.stringify(event))));

    const exactTicket = await createTicket(cookie, agentId, EXACT_OBJECTIVE);
    const exactRun = await waitForTerminal(exactTicket.id);
    assert('explicit path objective remains blocked', exactRun && exactRun.status === 'failed', `status=${exactRun && exactRun.status}`);
    assert('explicit path objective requires review', exactRun && exactRun.triage && exactRun.triage.required === true);
    assert('explicit path conflict does not retry model', readCaptures().filter(item => item.objective === EXACT_OBJECTIVE).length === 1);
    assert('explicit path conflict commits no mutation', readJson('operation-history.json').filter(item => item.runId === exactRun.id && !item.error).length === 0);
    assert('explicit path conflict does not create recovery artifact', readJson('operation-history.json').filter(item => item.runId === exactRun.id && item.args && item.args.path === RECOVERY_PATH).length === 0);
    assert('prior artifact still remains untouched', fs.readFileSync(path.join(WORKSPACE_ROOT, PRIOR_PATH), 'utf8') === PRIOR_CONTENT);

    console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'}: ${failures} failure(s)`);
  } finally {
    if (server) { server.kill('SIGTERM'); await sleep(300); if (server.exitCode === null) server.kill('SIGKILL'); }
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
    fs.rmSync(WORKSPACE_ROOT, { recursive: true, force: true });
    fs.rmSync(preloadPath, { force: true });
  }
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(error => { console.error(error.stack || error); process.exit(1); });

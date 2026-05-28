#!/usr/bin/env node
// Batch Workload Validation (focused) — ab-folder-org and archive-txt only.
// Verifies bounded operation batches fit within runtime limits:
//   maxExecutionSteps=4, maxListDirectoryPerRun=2, maxMutatingActionsPerResponse=2

const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { createTempWorkspaceRoot, removeTempWorkspaceRoot } = require('./test-workspace');

const ROOT = path.resolve(__dirname, '..');
const REAL_DATA_DIR = path.join(ROOT, 'data');
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'batch-workload-data-'));
const WORKSPACE_ROOT = createTempWorkspaceRoot('batch-workload');
const PORT = process.env.PORT || '3449';
const BASE_URL = `http://127.0.0.1:${PORT}`;
const STAMP = Date.now();

const DATA_FILES = [
  'agents.json', 'events.jsonl', 'groups.json', 'logs.json', 'operation-history.json',
  'permissions.json', 'runs.json', 'tickets.json', 'users.json', 'workflows.json'
];

for (const file of DATA_FILES) {
  const src = path.join(REAL_DATA_DIR, file);
  const dst = path.join(DATA_DIR, file);
  if (file === 'events.jsonl') fs.writeFileSync(dst, '');
  else fs.writeFileSync(dst, fs.existsSync(src) ? fs.readFileSync(src, 'utf8') : '[]');
}

function readJson(file) { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, file), 'utf8')); }
function readEvents() {
  const fp = path.join(DATA_DIR, 'events.jsonl');
  if (!fs.existsSync(fp)) return [];
  return fs.readFileSync(fp, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean);
}

function request(method, urlPath, options = {}) {
  const body = options.form ? new URLSearchParams(options.form).toString() : null;
  return new Promise((resolve, reject) => {
    const req = http.request(`${BASE_URL}${urlPath}`, {
      method,
      headers: {
        ...(options.form ? { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) } : {}),
        ...(options.cookie ? { Cookie: options.cookie } : {})
      }
    }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ statusCode: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function cookieFrom(response) {
  return (response.headers['set-cookie'] || []).map(cookie => cookie.split(';')[0]).join('; ');
}

function assert(condition, message) { if (!condition) throw new Error(message); }

function seedAgent() {
  const agents = readJson('agents.json');
  const agent = {
    id: Math.max(0, ...agents.map(a => a.id || 0)) + 1,
    name: `BatchWorkloadAgent-${STAMP}`,
    type: 'agent', provider: 'openai', model: 'gpt-4.1-mini',
    apiKey: 'test-key-batch-workload', createdAt: new Date().toISOString()
  };
  fs.writeFileSync(path.join(DATA_DIR, 'agents.json'), JSON.stringify([...agents.filter(a => a.name !== agent.name), agent], null, 2));
  return agent;
}

function createFakeOpenAIPreload() {
  const preloadPath = path.join(os.tmpdir(), `batch-workload-openai-${process.pid}-${STAMP}.js`);
  const source = `
function okResponse(plan) {
  return {
    ok: true, status: 200,
    headers: new Map([['x-request-id', 'fake-batch-workload']]),
    async text() {
      return JSON.stringify({
        output_text: JSON.stringify(plan),
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 }
      });
    }
  };
}

const PLANS = new Map();

// ab-folder-org: 4 steps, 1 listDirectory, mutation batches of 2
PLANS.set('ab-folder-org', [
  { message: 'Listing workspace root', actions: [{ operation: 'listDirectory', args: { path: '' } }], complete: false },
  { message: 'Creating folders A and B', actions: [
    { operation: 'createFolder', args: { path: 'A' } },
    { operation: 'createFolder', args: { path: 'B' } }
  ], complete: false },
  { message: 'Moving Alpha and Beta', actions: [
    { operation: 'renamePath', args: { path: 'Alpha', nextPath: 'A/Alpha' } },
    { operation: 'renamePath', args: { path: 'Beta', nextPath: 'B/Beta' } }
  ], complete: false },
  { message: 'Organization complete', actions: [], complete: true }
]);

// archive-txt: 4 steps, 1 listDirectory, mutation batches of 2
PLANS.set('archive-txt', [
  { message: 'Listing workspace root', actions: [{ operation: 'listDirectory', args: { path: '' } }], complete: false },
  { message: 'Creating archive and moving first file', actions: [
    { operation: 'createFolder', args: { path: 'archive' } },
    { operation: 'renamePath', args: { path: 'a.txt', nextPath: 'archive/a.txt' } }
  ], complete: false },
  { message: 'Moving remaining .txt files', actions: [
    { operation: 'renamePath', args: { path: 'b.txt', nextPath: 'archive/b.txt' } },
    { operation: 'renamePath', args: { path: 'd.txt', nextPath: 'archive/d.txt' } }
  ], complete: false },
  { message: 'Archive complete', actions: [], complete: true }
]);

const RESPONSE_INDEX = new Map();

global.fetch = async function(_url, options = {}) {
  const body = JSON.parse(options.body || '{}');
  const input = Array.isArray(body.input) ? body.input : [];
  const combined = input.map(item => item && item.content ? String(item.content) : '').join('\\n');
  let planKey = null;
  if (combined.includes('A/B folder')) planKey = 'ab-folder-org';
  else if (combined.includes('archive .txt')) planKey = 'archive-txt';
  if (!planKey) return okResponse({ message: 'No plan matched', actions: [], complete: true });
  const index = RESPONSE_INDEX.get(planKey) || 0;
  const plan = PLANS.get(planKey);
  const response = plan[index] || { message: 'Done', actions: [], complete: true };
  RESPONSE_INDEX.set(planKey, index + 1);
  return okResponse(response);
};
`;
  fs.writeFileSync(preloadPath, source);
  return preloadPath;
}

async function waitForReady() {
  const started = Date.now();
  while (Date.now() - started < 15000) {
    try {
      const response = await request('GET', '/health');
      if (response.statusCode === 200 && JSON.parse(response.body).ready) return;
    } catch (error) {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Timed out waiting for server ready');
}

async function login() {
  const response = await request('POST', '/login', { form: { username: 'admin', password: 'admin123' } });
  assert(response.statusCode === 302, `Admin login failed with HTTP ${response.statusCode}`);
  return cookieFrom(response);
}

async function createAgentTicket(cookie, agent, objective) {
  const response = await request('POST', '/tickets', {
    cookie,
    form: { objective, assignmentTargetType: 'agent', assignmentTargetId: String(agent.id), assignmentMode: 'individual' }
  });
  assert(response.statusCode === 302, `Agent ticket create failed with HTTP ${response.statusCode}: ${response.body}`);
  return readJson('tickets.json').find(t => t.objective === objective);
}

async function waitForTerminalRun(ticketId) {
  const started = Date.now();
  while (Date.now() - started < 30000) {
    const runs = readJson('runs.json');
    const run = runs.find(r => r.ticketId === ticketId && (r.status === 'completed' || r.status === 'failed' || r.status === 'interrupted'));
    if (run) return run;
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error(`Timed out waiting for terminal run for ticket ${ticketId}`);
}

function setupWorkspaceFixture(caseName) {
  fs.rmSync(WORKSPACE_ROOT, { recursive: true, force: true });
  fs.mkdirSync(WORKSPACE_ROOT, { recursive: true });
  if (caseName === 'ab-folder-org') {
    fs.mkdirSync(path.join(WORKSPACE_ROOT, 'Alpha'));
    fs.mkdirSync(path.join(WORKSPACE_ROOT, 'Beta'));
    fs.mkdirSync(path.join(WORKSPACE_ROOT, 'Gamma'));
    fs.writeFileSync(path.join(WORKSPACE_ROOT, 'Alpha', 'file1.txt'), 'alpha1');
    fs.writeFileSync(path.join(WORKSPACE_ROOT, 'Beta', 'file2.txt'), 'beta1');
    fs.writeFileSync(path.join(WORKSPACE_ROOT, 'Gamma', 'file3.txt'), 'gamma1');
  } else if (caseName === 'archive-txt') {
    fs.writeFileSync(path.join(WORKSPACE_ROOT, 'a.txt'), 'a');
    fs.writeFileSync(path.join(WORKSPACE_ROOT, 'b.txt'), 'b');
    fs.writeFileSync(path.join(WORKSPACE_ROOT, 'c.md'), 'c');
    fs.writeFileSync(path.join(WORKSPACE_ROOT, 'd.txt'), 'd');
  }
}

function assertWorkspaceState(caseName) {
  if (caseName === 'ab-folder-org') {
    assert(fs.existsSync(path.join(WORKSPACE_ROOT, 'A', 'Alpha', 'file1.txt')), 'A/Alpha/file1.txt should exist');
    assert(fs.existsSync(path.join(WORKSPACE_ROOT, 'B', 'Beta', 'file2.txt')), 'B/Beta/file2.txt should exist');
    assert(!fs.existsSync(path.join(WORKSPACE_ROOT, 'Alpha')), 'Alpha should no longer exist at root');
    assert(!fs.existsSync(path.join(WORKSPACE_ROOT, 'Beta')), 'Beta should no longer exist at root');
    assert(fs.existsSync(path.join(WORKSPACE_ROOT, 'Gamma', 'file3.txt')), 'Gamma/file3.txt should still exist');
  } else if (caseName === 'archive-txt') {
    assert(fs.existsSync(path.join(WORKSPACE_ROOT, 'archive', 'a.txt')), 'archive/a.txt should exist');
    assert(fs.existsSync(path.join(WORKSPACE_ROOT, 'archive', 'b.txt')), 'archive/b.txt should exist');
    assert(fs.existsSync(path.join(WORKSPACE_ROOT, 'archive', 'd.txt')), 'archive/d.txt should exist');
    assert(!fs.existsSync(path.join(WORKSPACE_ROOT, 'a.txt')), 'a.txt should no longer exist at root');
    assert(!fs.existsSync(path.join(WORKSPACE_ROOT, 'b.txt')), 'b.txt should no longer exist at root');
    assert(!fs.existsSync(path.join(WORKSPACE_ROOT, 'd.txt')), 'd.txt should no longer exist at root');
    assert(fs.existsSync(path.join(WORKSPACE_ROOT, 'c.md')), 'c.md should still exist at root');
  }
}

function validateContract(run, events, logs, caseName) {
  const runEvents = events.filter(e => e.runId === run.id);
  const runLogs = logs.filter(l => l.runId === run.id);
  const modelRequests = runLogs.filter(l => l.type === 'model:request').length;
  const workspaceOps = runEvents.filter(e => e.type === 'workspace.operation').length;
  const verificationEvents = runEvents.filter(e => e.type === 'batch.verification_failed').length;
  const phaseViolations = runEvents.filter(e => e.type === 'execution.phase_violation').length;
  const noProgressEvents = runEvents.filter(e => e.type === 'run.limit_exceeded' && e.payload && e.payload.failureKind === 'no_progress').length;

  // Extract failure reason if failed
  let failureReason = null;
  if (run.status === 'failed') {
    const failLog = runLogs.find(l => l.type === 'run:failed');
    if (failLog) failureReason = failLog.message;
  }

  return {
    caseName,
    runId: run.id,
    status: run.status,
    modelRequests,
    workspaceOps,
    verificationEvents,
    phaseViolations,
    noProgressEvents,
    failureReason,
    passed: run.status === 'completed' && phaseViolations === 0 && noProgressEvents === 0 && verificationEvents === 0
  };
}

const CASES = [
  { name: 'ab-folder-org', objective: 'A/B folder organization: Create folders A and B, then move all folders starting with A into A and all folders starting with B into B.' },
  { name: 'archive-txt', objective: 'archive .txt files: Create an archive folder and move all .txt files into it.' }
];

async function main() {
  console.log('Batch Workload Validation (Focused)');
  console.log('='.repeat(70));

  const preloadPath = createFakeOpenAIPreload();
  const server = spawn('node', ['--require', preloadPath, path.join(ROOT, 'server.js')], {
    env: { ...process.env, PORT, DATA_DIR, WORKSPACE_ROOT, NODE_ENV: 'test' },
    stdio: 'ignore'
  });

  let allPassed = true;

  try {
    await waitForReady();
    const cookie = await login();
    const agent = seedAgent();

    for (const testCase of CASES) {
      console.log(`\nCase: ${testCase.name}`);
      console.log('-'.repeat(70));

      setupWorkspaceFixture(testCase.name);

      let run;
      let contract;
      let error = null;

      try {
        const ticket = await createAgentTicket(cookie, agent, testCase.objective);
        run = await waitForTerminalRun(ticket.id);
        const events = readEvents();
        const logs = readJson('logs.json');
        contract = validateContract(run, events, logs, testCase.name);
        assertWorkspaceState(testCase.name);
      } catch (err) {
        error = err.message;
        contract = { caseName: testCase.name, status: run ? run.status : 'unknown', passed: false, error };
        allPassed = false;
      }

      const display = (v) => v === undefined || v === null ? 'N/A' : v;
      console.log(`  Status:       ${contract.status}`);
      console.log(`  Model reqs:   ${display(contract.modelRequests)}`);
      console.log(`  Workspace ops: ${display(contract.workspaceOps)}`);
      console.log(`  Verification failures: ${display(contract.verificationEvents)}`);
      console.log(`  Phase violations: ${display(contract.phaseViolations)}`);
      console.log(`  No-progress events: ${display(contract.noProgressEvents)}`);
      if (contract.failureReason) console.log(`  Failure reason: ${contract.failureReason.slice(0, 120)}`);
      console.log(`  Workspace state: ${error ? 'FAIL (' + error + ')' : 'PASS'}`);
      console.log(`  Contract:       ${contract.passed ? 'PASS' : 'FAIL'}`);

      if (!contract.passed) allPassed = false;
    }

    console.log('\n' + '='.repeat(70));
    console.log(allPassed ? 'Result: PASS' : 'Result: FAIL');
    process.exitCode = allPassed ? 0 : 1;
  } finally {
    server.kill('SIGTERM');
    try { removeTempWorkspaceRoot(WORKSPACE_ROOT); } catch (e) {}
    try { fs.unlinkSync(preloadPath); } catch (e) {}
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});

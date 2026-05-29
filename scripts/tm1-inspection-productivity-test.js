const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { createTempWorkspaceRoot, removeTempWorkspaceRoot } = require('./test-workspace');

const ROOT = path.resolve(__dirname, '..');
const REAL_DATA_DIR = path.join(ROOT, 'data');
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tm1-inspection-productivity-data-'));
const WORKSPACE_ROOT = createTempWorkspaceRoot('tm1-inspection');
const PORT = process.env.PORT || '3435';
const BASE_URL = `http://127.0.0.1:${PORT}`;
const STAMP = Date.now();

const DATA_FILES = [
  'agents.json', 'allocation-plans.json', 'groups.json', 'logs.json',
  'memberships.json', 'operation-history.json', 'permissions.json',
  'runs.json', 'tickets.json', 'users.json'
];

for (const file of DATA_FILES) {
  const src = path.join(REAL_DATA_DIR, file);
  fs.writeFileSync(path.join(DATA_DIR, file), fs.existsSync(src) ? fs.readFileSync(src, 'utf8') : '[]');
}

function readJson(file) {
  const value = JSON.parse(fs.readFileSync(path.join(DATA_DIR, file), 'utf8'));
  if (file !== 'runs.json' || !Array.isArray(value)) return value;
  return value.map(run => {
    if (run.replaySnapshot || !run.replaySnapshotPath) return run;
    if (!fs.existsSync(path.join(DATA_DIR, run.replaySnapshotPath))) return run;
    return { ...run, replaySnapshot: readJson(run.replaySnapshotPath) };
  });
}

function writeJson(file, value) {
  fs.writeFileSync(path.join(DATA_DIR, file), JSON.stringify(value, null, 2));
}

function request(method, urlPath, options = {}) {
  const body = options.form
    ? new URLSearchParams(options.form).toString()
    : options.body ? JSON.stringify(options.body) : null;
  return new Promise((resolve, reject) => {
    const req = http.request(`${BASE_URL}${urlPath}`, {
      method,
      headers: {
        ...(options.form ? { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) } : {}),
        ...(options.body ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } : {}),
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

function waitForExit(child) {
  return new Promise(resolve => {
    if (child.exitCode !== null || child.killed) return resolve();
    child.once('exit', () => resolve());
  });
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
  if (response.statusCode !== 302) throw new Error(`Admin login failed with HTTP ${response.statusCode}`);
  return cookieFrom(response);
}

function seedAgent() {
  const agents = readJson('agents.json');
  const agent = {
    id: Math.max(0, ...agents.map(item => item.id || 0)) + 1,
    name: `TM1-${STAMP}`,
    type: 'agent',
    provider: 'openai',
    model: 'gpt-4.1-mini',
    apiKey: 'test-key-tm1',
    createdAt: new Date().toISOString()
  };
  writeJson('agents.json', [...agents, agent]);
  return agent;
}

async function createTicket(cookie, agent, objective) {
  const response = await request('POST', '/tickets', {
    cookie,
    form: { objective, assignmentTargetType: 'agent', assignmentTargetId: String(agent.id) }
  });
  if (response.statusCode !== 302) throw new Error(`Ticket create failed with HTTP ${response.statusCode}: ${response.body}`);
  return readJson('tickets.json').find(ticket => ticket.objective === objective);
}

async function waitForRun(ticketId, status, timeoutMs = 20000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const run = readJson('runs.json').find(item => item.ticketId === ticketId);
    if (run && run.status === status && run.replaySnapshot && run.replaySnapshot.terminalStatus === status) return run;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ticket ${ticketId} run ${status}`);
}

function createFakeOpenAIPreload() {
  const preloadPath = path.join(os.tmpdir(), `tm1-openai-${process.pid}-${Date.now()}.js`);
  const source = `
function okResponse(plan) {
  return {
    ok: true, status: 200,
    headers: new Map([['x-request-id', 'fake-tm1']]),
    async text() {
      return JSON.stringify({
        output_text: JSON.stringify(plan),
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 }
      });
    }
  };
}

let callCount = 0;
global.fetch = async function(url, options = {}) {
  const body = JSON.parse(options.body || '{}');
  const input = Array.isArray(body.input) ? body.input : [];
  const combined = input.map(item => item && item.content ? String(item.content) : '').join('\\n');
  callCount++;

  if (combined.includes('tm1-inspect-then-write')) {
    if (callCount === 1) {
      return okResponse({
        message: 'Inspecting workspace first.',
        actions: [{ operation: 'listDirectory', args: { path: '' } }],
        complete: false
      });
    }
    return okResponse({
      message: 'Writing file after inspection.',
      actions: [{ operation: 'writeFile', args: { path: 'test-inspect-write.txt', content: 'hello' } }],
      complete: true
    });
  }

  if (combined.includes('tm1-double-inspect')) {
    return okResponse({
      message: 'Inspecting workspace again.',
      actions: [{ operation: 'listDirectory', args: { path: '' } }],
      complete: false
    });
  }

  return okResponse({ message: 'Default.', actions: [], complete: true });
};
`;
  fs.writeFileSync(preloadPath, source);
  return preloadPath;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function main() {
  fs.writeFileSync(path.join(WORKSPACE_ROOT, 'seed.txt'), 'seed\n');
  const agent = seedAgent();
  const preloadPath = createFakeOpenAIPreload();
  let server = null;

  try {
    server = spawn(process.execPath, ['server.js'], {
      cwd: ROOT,
      env: { ...process.env, NODE_ENV: 'test', PORT, NODE_OPTIONS: `--require ${preloadPath}`, WORKSPACE_ROOT, DATA_DIR },
      stdio: ['ignore', 'pipe', 'pipe']
    });

    await waitForReady();
    const cookie = await login();

    // ── Test 1: Single inspection step does NOT trigger no-progress ──
    const inspectTicket = await createTicket(cookie, agent, `tm1-inspect-then-write ${STAMP}`);
    const inspectRun = await waitForRun(inspectTicket.id, 'completed');

    assert(inspectRun.status === 'completed', `Run should complete, got ${inspectRun.status}`);
    assert(inspectRun.error == null, `Run should have no error, got: ${inspectRun.error}`);

    const noProgressEvents = inspectRun.replaySnapshot.events.filter(e => e.type === 'model:no_progress');
    assert(noProgressEvents.length === 0, `First inspection should NOT emit no_progress events, got ${noProgressEvents.length}`);

    const stepLimitEvents = inspectRun.replaySnapshot.events.filter(e => e.type === 'run:step_limit');
    assert(stepLimitEvents.length === 0, `First inspection should NOT trigger step limit, got ${stepLimitEvents.length}`);

    // The run should have proceeded to the writeFile step
    const writeOps = inspectRun.replaySnapshot.workspaceOperations.filter(
      op => op.operation && op.operation.operation === 'writeFile'
    );
    assert(writeOps.length === 1, `Should have exactly one writeFile operation, got ${writeOps.length}`);

    assert(fs.existsSync(path.join(WORKSPACE_ROOT, 'test-inspect-write.txt')), 'writeFile should have created the file');

    console.log('  ✓ first-inspection-not-penalized: single listDirectory does not trigger no-progress');

    // ── Test 2: Double inspection DOES trigger no-progress ──
    const doubleTicket = await createTicket(cookie, agent, `tm1-double-inspect ${STAMP}`);
    const doubleRun = await waitForRun(doubleTicket.id, 'failed');

    assert(doubleRun.status === 'failed', `Double inspect run should fail, got ${doubleRun.status}`);

    const doubleNoProgressEvents = doubleRun.replaySnapshot.events.filter(e => e.type === 'model:no_progress');
    assert(doubleNoProgressEvents.length >= 1, `Double inspection should emit no_progress, got ${doubleNoProgressEvents.length}`);

    const doubleStepLimitEvents = doubleRun.replaySnapshot.events.filter(e => e.type === 'run:step_limit');
    assert(doubleStepLimitEvents.length >= 1, `Double inspection should trigger step limit, got ${doubleStepLimitEvents.length}`);

    console.log('  ✓ double-inspection-penalized: repeated listDirectory still triggers no-progress');

    // ── Test 3: Evidence preserved in replay snapshot ──
    // The inspect-then-write run should have the listDirectory result in workspaceOperations
    const listOps = inspectRun.replaySnapshot.workspaceOperations.filter(
      op => op.operation && op.operation.operation === 'listDirectory'
    );
    assert(listOps.length === 1, `Should have exactly one listDirectory operation, got ${listOps.length}`);
    assert(listOps[0].result && listOps[0].result.entries, 'listDirectory result should contain entries');

    // Verify the run did not fail at the inspection step
    assert(inspectRun.replaySnapshot.parsedModelPlans.length >= 2, `Should have at least 2 model plans (inspect + write), got ${inspectRun.replaySnapshot.parsedModelPlans.length}`);

    console.log('  ✓ evidence-preserved: inspection result preserved in replay and run proceeds');

    console.log(JSON.stringify({ tm1InspectionProductivity: true }));
  } finally {
    if (server) {
      server.kill();
      await waitForExit(server);
    }
    removeTempWorkspaceRoot(WORKSPACE_ROOT);
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
    fs.rmSync(preloadPath, { force: true });
  }
}

main().catch(error => {
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});

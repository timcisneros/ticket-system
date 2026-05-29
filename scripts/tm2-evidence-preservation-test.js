const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { createTempWorkspaceRoot, removeTempWorkspaceRoot } = require('./test-workspace');

const ROOT = path.resolve(__dirname, '..');
const REAL_DATA_DIR = path.join(ROOT, 'data');
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tm2-evidence-preservation-data-'));
const WORKSPACE_ROOT = createTempWorkspaceRoot('tm2-evidence');
const PORT = process.env.PORT || '3436';
const BASE_URL = `http://127.0.0.1:${PORT}`;
const STAMP = Date.now();
const CAPTURE_FILE = path.join(os.tmpdir(), `tm2-capture-${STAMP}.json`);

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
    name: `TM2-${STAMP}`,
    type: 'agent',
    provider: 'openai',
    model: 'gpt-4.1-mini',
    apiKey: 'test-key-tm2',
    createdAt: new Date().toISOString()
  };
  const newAgents = [...agents, agent];
  fs.writeFileSync(path.join(DATA_DIR, 'agents.json'), JSON.stringify(newAgents, null, 2));
  return agent;
}

async function createTicket(cookie, agent, objective) {
  const response = await request('POST', '/tickets', {
    cookie,
    form: { objective, assignmentTargetType: 'agent', assignmentTargetId: String(agent.id) }
  });
  if (response.statusCode !== 302) throw new Error(`Ticket create failed with HTTP ${response.statusCode}: ${response.body}`);
  const tickets = readJson('tickets.json');
  return tickets.find(ticket => ticket.objective === objective);
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
  const preloadPath = path.join(os.tmpdir(), `tm2-openai-${process.pid}-${Date.now()}.js`);
  const captureFile = CAPTURE_FILE;
  const source = `
const fs = require('fs');
const captureFile = '${captureFile.replace(/\\/g, '\\\\')}';

function okResponse(plan) {
  return {
    ok: true, status: 200,
    headers: new Map([['x-request-id', 'fake-tm2']]),
    async text() {
      return JSON.stringify({
        output_text: JSON.stringify(plan),
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 }
      });
    }
  };
}

let callCount = 0;
const capturedInputs = [];

global.fetch = async function(url, options = {}) {
  const body = JSON.parse(options.body || '{}');
  const input = Array.isArray(body.input) ? body.input : [];
  const combined = input.map(item => item && item.content ? String(item.content) : '').join('\\n');
  callCount++;
  capturedInputs.push({ callCount, combined });

  // Write captured inputs after each call so test can inspect
  fs.writeFileSync(captureFile, JSON.stringify(capturedInputs, null, 2));

  if (combined.includes('tm2-inspect-twice')) {
    if (callCount === 1) {
      return okResponse({
        message: 'First inspection.',
        actions: [{ operation: 'listDirectory', args: { path: '' } }],
        complete: false
      });
    }
    if (callCount === 2) {
      return okResponse({
        message: 'Second inspection (should trigger no-progress).',
        actions: [{ operation: 'listDirectory', args: { path: '' } }],
        complete: false
      });
    }
    return okResponse({
      message: 'Third response after warning.',
      actions: [{ operation: 'writeFile', args: { path: 'test-evidence.txt', content: 'hello' } }],
      complete: true
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
    server = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
      cwd: ROOT,
      env: { ...process.env, NODE_ENV: 'test', PORT, NODE_OPTIONS: `--require ${preloadPath}`, WORKSPACE_ROOT, DATA_DIR },
      stdio: ['ignore', 'pipe', 'pipe']
    });

    await waitForReady();
    const cookie = await login();

    // ── Test: Evidence preserved through no-progress enforcement ──
    const inspectTicket = await createTicket(cookie, agent, `tm2-inspect-twice ${STAMP}`);
    const inspectRun = await waitForRun(inspectTicket.id, 'completed');

    assert(inspectRun.status === 'completed', `Run should complete, got ${inspectRun.status}`);
    assert(inspectRun.error == null, `Run should have no error, got: ${inspectRun.error}`);

    // The run should have 3 model requests: inspect, re-inspect (warning), write
    assert(inspectRun.replaySnapshot.parsedModelPlans.length === 3, `Should have 3 model plans, got ${inspectRun.replaySnapshot.parsedModelPlans.length}`);

    // Read captured inputs from the fake model
    assert(fs.existsSync(CAPTURE_FILE), 'Capture file should exist');
    const capturedInputs = JSON.parse(fs.readFileSync(CAPTURE_FILE, 'utf8'));
    assert(capturedInputs.length === 3, `Should have 3 captured inputs, got ${capturedInputs.length}`);

    // ── Test 1: First inspection result preserved in second prompt ──
    const secondInput = capturedInputs[1].combined;
    assert(secondInput.includes('previousActionResults'), 'Second prompt should include previousActionResults');
    assert(secondInput.includes('listDirectory'), 'Second prompt should contain listDirectory result');
    assert(secondInput.includes('entries'), 'Second prompt should contain listDirectory entries');

    console.log('  ✓ first-inspection-evidence-preserved: listDirectory result survives to second prompt');

    // ── Test 2: Second inspection result AND warning both in third prompt ──
    const thirdInput = capturedInputs[2].combined;
    assert(thirdInput.includes('previousActionResults'), 'Third prompt should include previousActionResults');
    // Should contain the warning from the no-progress enforcement
    assert(thirdInput.includes('model:no_progress'), 'Third prompt should contain no_progress warning');
    // Should ALSO contain the listDirectory result from step 1
    // Look for the specific pattern in previousActionResults where both items coexist
    const paIndex = thirdInput.indexOf('previousActionResults');
    const paSection = thirdInput.substring(paIndex, paIndex + 4000);
    // After previousActionResults, we should find listDirectory (from operation) AND model:no_progress (from warning)
    const hasListDirInPA = paSection.includes('"operation"') && paSection.includes('listDirectory');
    const hasWarningInPA = paSection.includes('model:no_progress');
    assert(hasListDirInPA, 'previousActionResults section should contain listDirectory operation');
    assert(hasWarningInPA, 'previousActionResults section should contain no_progress warning');

    console.log('  ✓ enforcement-evidence-coexistent: no-progress warning and inspection result both in prompt');

    // ── Test 3: Model adapts after receiving preserved evidence ──
    const writeOps = inspectRun.replaySnapshot.workspaceOperations.filter(
      op => op.operation && op.operation.operation === 'writeFile'
    );
    assert(writeOps.length === 1, `Should have exactly one writeFile, got ${writeOps.length}`);
    assert(fs.existsSync(path.join(WORKSPACE_ROOT, 'test-evidence.txt')), 'writeFile should have created the file');

    console.log('  ✓ transition-guidance-functional: model adapts after preserved evidence');

    // ── Test 4: Replay snapshot preserves both operation and enforcement ──
    const noProgressEvents = inspectRun.replaySnapshot.events.filter(e => e.type === 'model:no_progress');
    assert(noProgressEvents.length >= 1, 'Replay should contain no_progress event');
    const listOps = inspectRun.replaySnapshot.workspaceOperations.filter(
      op => op.operation && op.operation.operation === 'listDirectory'
    );
    assert(listOps.length >= 1, 'Replay should contain listDirectory operation');

    console.log('  ✓ replay-preserves-both: replay snapshot contains operation and enforcement event');

    // ── Test 5: Run completed despite no-progress warning ──
    assert(inspectRun.replaySnapshot.terminalStatus === 'completed', 'Run should terminalize as completed');

    console.log('  ✓ run-completes-through-warning: run succeeds despite no-progress enforcement');

    console.log(JSON.stringify({ tm2EvidencePreservation: true }));
  } finally {
    if (server) {
      server.kill();
      await waitForExit(server);
    }
    removeTempWorkspaceRoot(WORKSPACE_ROOT);
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
    fs.rmSync(preloadPath, { force: true });
    fs.rmSync(CAPTURE_FILE, { force: true });
  }
}

main().catch(error => {
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});

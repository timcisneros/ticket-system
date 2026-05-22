const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { createTempWorkspaceRoot, removeTempWorkspaceRoot } = require('./test-workspace');

const ROOT = path.resolve(__dirname, '..');
const REAL_DATA_DIR = path.join(ROOT, 'data');
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bounded-transition-data-'));
const WORKSPACE_ROOT = createTempWorkspaceRoot('bounded-transition');
const PORT = process.env.PORT || '3433';
const BASE_URL = `http://127.0.0.1:${PORT}`;
const STAMP = Date.now();
const DATA_FILES = [
  'agents.json',
  'allocation-plans.json',
  'groups.json',
  'logs.json',
  'memberships.json',
  'operation-history.json',
  'permissions.json',
  'runs.json',
  'tickets.json',
  'users.json'
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
    return { ...run, replaySnapshot: readJson(run.replaySnapshotPath) };
  });
}

function writeJson(file, value) {
  fs.writeFileSync(path.join(DATA_DIR, file), JSON.stringify(value, null, 2));
}

function request(method, urlPath, options = {}) {
  const body = options.form
    ? new URLSearchParams(options.form).toString()
    : options.body
      ? JSON.stringify(options.body)
      : null;

  return new Promise((resolve, reject) => {
    const req = http.request(`${BASE_URL}${urlPath}`, {
      method,
      headers: {
        ...(options.form ? {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(body)
        } : {}),
        ...(options.body ? {
          'Content-Type': 'application/json',
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

function waitForExit(child) {
  return new Promise(resolve => {
    if (child.exitCode !== null || child.killed) return resolve();
    child.once('exit', () => resolve());
  });
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function waitForReady() {
  const started = Date.now();
  while (Date.now() - started < 15000) {
    try {
      const response = await request('GET', '/health');
      if (response.statusCode === 200 && JSON.parse(response.body).ready) return;
    } catch (error) {
      // Server is starting.
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Timed out waiting for server ready');
}

async function login() {
  const response = await request('POST', '/login', {
    form: { username: 'admin', password: 'admin123' }
  });
  assert(response.statusCode === 302, `Admin login failed with HTTP ${response.statusCode}`);
  return cookieFrom(response);
}

function seedAgent() {
  const agents = readJson('agents.json');
  const agent = {
    id: Math.max(0, ...agents.map(item => item.id || 0)) + 1,
    name: `BoundedTransition-${STAMP}`,
    type: 'agent',
    provider: 'openai',
    model: 'gpt-4.1-mini',
    apiKey: 'test-key-bounded-transition',
    createdAt: new Date().toISOString()
  };
  writeJson('agents.json', [...agents, agent]);
  return agent;
}

async function createTicket(cookie, agent, objective) {
  const response = await request('POST', '/tickets', {
    cookie,
    form: {
      objective,
      assignmentTargetType: 'agent',
      assignmentTargetId: String(agent.id)
    }
  });
  assert(response.statusCode === 302, `Ticket create failed with HTTP ${response.statusCode}: ${response.body}`);
  return readJson('tickets.json').find(ticket => ticket.objective === objective);
}

async function waitForRun(ticketId, status) {
  const started = Date.now();
  while (Date.now() - started < 20000) {
    const run = readJson('runs.json').find(item => item.ticketId === ticketId);
    if (run && run.status === status && run.replaySnapshot && run.replaySnapshot.terminalStatus === status) return run;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ticket ${ticketId} run ${status}`);
}

function createFakeOpenAIPreload() {
  const preloadPath = path.join(os.tmpdir(), `bounded-transition-openai-${process.pid}-${Date.now()}.js`);
  const source = `
function okResponse(plan) {
  return {
    ok: true,
    status: 200,
    headers: new Map([['x-request-id', 'fake-bounded-transition']]),
    async text() {
      return JSON.stringify({
        output_text: JSON.stringify(plan),
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 }
      });
    }
  };
}

global.fetch = async function(url, options = {}) {
  const body = JSON.parse(options.body || '{}');
  const input = Array.isArray(body.input) ? body.input : [];
  const combined = input.map(item => item && item.content ? String(item.content) : '').join('\\n');

  if (combined.includes('bounded-transition-too-many')) {
    return okResponse({
      message: 'Attempting too many mutations.',
      actions: [
        { operation: 'writeFile', args: { path: 'too-many-a.txt', content: 'a' } },
        { operation: 'writeFile', args: { path: 'too-many-b.txt', content: 'b' } },
        { operation: 'writeFile', args: { path: 'too-many-c.txt', content: 'c' } }
      ],
      complete: false
    });
  }

  if (combined.includes('bounded-transition-mixed')) {
    return okResponse({
      message: 'Inspecting and performing a bounded transition.',
      actions: [
        { operation: 'listDirectory', args: { path: '' } },
        { operation: 'readFile', args: { path: 'seed.txt' } },
        { operation: 'writeFile', args: { path: 'mixed-a.txt', content: 'a' } },
        { operation: 'writeFile', args: { path: 'mixed-b.txt', content: 'b' } }
      ],
      complete: true
    });
  }

  return okResponse({
    message: 'Single mutation.',
    actions: [
      { operation: 'writeFile', args: { path: 'single-write.txt', content: 'ok' } }
    ],
    complete: true
  });
};
`;
  fs.writeFileSync(preloadPath, source);
  return preloadPath;
}

async function main() {
  fs.writeFileSync(path.join(WORKSPACE_ROOT, 'seed.txt'), 'seed\n');
  const agent = seedAgent();
  const preloadPath = createFakeOpenAIPreload();
  let server = null;

  try {
    server = spawn(process.execPath, ['server.js'], {
      cwd: ROOT,
      env: {
        ...process.env,
        NODE_ENV: 'test',
        PORT,
        NODE_OPTIONS: `--require ${preloadPath}`,
        WORKSPACE_ROOT,
        DATA_DIR
      },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    server.stdout.on('data', chunk => process.stdout.write(String(chunk)));
    server.stderr.on('data', chunk => process.stderr.write(String(chunk)));

    await waitForReady();
    const cookie = await login();

    const tooManyTicket = await createTicket(cookie, agent, `bounded-transition-too-many ${STAMP}`);
    const tooManyRun = await waitForRun(tooManyTicket.id, 'failed');
    assert(!fs.existsSync(path.join(WORKSPACE_ROOT, 'too-many-a.txt')), 'Oversized mutating batch should not write first file');
    assert(!fs.existsSync(path.join(WORKSPACE_ROOT, 'too-many-b.txt')), 'Oversized mutating batch should not write second file');
    assert(!fs.existsSync(path.join(WORKSPACE_ROOT, 'too-many-c.txt')), 'Oversized mutating batch should not write third file');
    assert(tooManyRun.replaySnapshot.runtimeEnvelope.maxMutatingActionsPerResponse === 2, 'Runtime envelope missing mutating action cap');
    const mutatingLimitEvents = tooManyRun.replaySnapshot.events.filter(event => event.type === 'model:mutating_action_limit');
    assert(mutatingLimitEvents.length === 2, `Repeated oversized batch should stop after 2 violations, got ${mutatingLimitEvents.length}`);
    assert(mutatingLimitEvents[1].repeatedViolationCount === 2, 'Replay should record repeated mutating action violation count');
    assert(tooManyRun.replaySnapshot.parsedModelPlans.length === 2, 'Repeated oversized batch should stop before max steps');
    assert(tooManyRun.error === 'Model repeatedly proposed too many mutating actions; no workspace mutations were executed.', 'Early stop reason should be explicit');
    assert(tooManyRun.replaySnapshot.failureReason === tooManyRun.error, 'Replay failure reason should preserve early stop reason');
    assert(tooManyRun.replaySnapshot.events.some(event => event.type === 'run:mutating_action_limit'), 'Replay should record early stop as a typed mutating action limit event');
    assert((tooManyRun.replaySnapshot.workspaceOperations || []).length === 0, 'Rejected mutating batch should not execute workspace operations');
    assert(tooManyRun.replaySnapshot.mutationCount === 0, 'Rejected mutating batch should record zero mutations');

    const mixedTicket = await createTicket(cookie, agent, `bounded-transition-mixed ${STAMP}`);
    const mixedRun = await waitForRun(mixedTicket.id, 'completed');
    assert(fs.existsSync(path.join(WORKSPACE_ROOT, 'mixed-a.txt')), 'Mixed bounded transition should write first file');
    assert(fs.existsSync(path.join(WORKSPACE_ROOT, 'mixed-b.txt')), 'Mixed bounded transition should write second file');
    assert(mixedRun.replaySnapshot.workspaceOperations.length === 4, 'Mixed transition should record reads/lists plus two mutations');

    const singleTicket = await createTicket(cookie, agent, `bounded-transition-single ${STAMP}`);
    await waitForRun(singleTicket.id, 'completed');
    assert(fs.existsSync(path.join(WORKSPACE_ROOT, 'single-write.txt')), 'Single write should still work');

    console.log(JSON.stringify({ boundedTransition: true }));
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

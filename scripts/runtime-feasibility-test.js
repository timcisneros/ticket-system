const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { createTempWorkspaceRoot, removeTempWorkspaceRoot } = require('./test-workspace');

const ROOT = path.resolve(__dirname, '..');
const REAL_DATA_DIR = path.join(ROOT, 'data');
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-feasibility-data-'));
const WORKSPACE_ROOT = createTempWorkspaceRoot('runtime-feasibility');
const PORT = process.env.PORT || '3432';
const BASE_URL = `http://127.0.0.1:${PORT}`;
const STAMP = Date.now();
const DATA_FILES = ['agents.json', 'allocation-plans.json', 'groups.json', 'logs.json', 'memberships.json', 'operation-history.json', 'permissions.json', 'runs.json', 'tickets.json', 'users.json'];

for (const file of DATA_FILES) {
  const src = path.join(REAL_DATA_DIR, file);
  const dst = path.join(DATA_DIR, file);
  if (fs.existsSync(src)) {
    fs.copyFileSync(src, dst);
  } else {
    fs.writeFileSync(dst, '[]');
  }
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(path.join(DATA_DIR, file), 'utf8'));
}

function readEvents() {
  const file = path.join(DATA_DIR, 'events.jsonl');
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8')
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => {
      try { return JSON.parse(line); } catch { return null; }
    })
    .filter(Boolean);
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

async function waitForReady() {
  const started = Date.now();
  while (Date.now() - started < 15000) {
    try {
      const response = await request('GET', '/health');
      if (response.statusCode === 200) {
        const body = JSON.parse(response.body);
        if (body.ready) return;
      }
    } catch (error) {
      // Server is still starting.
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Timed out waiting for server ready');
}

async function waitForExit(child) {
  return new Promise(resolve => {
    if (child.exitCode !== null || child.killed) return resolve();
    child.once('exit', () => resolve());
  });
}

async function login() {
  const response = await request('POST', '/login', {
    form: { username: 'admin', password: 'admin123' }
  });
  if (response.statusCode !== 302) {
    throw new Error(`Admin login failed with HTTP ${response.statusCode}`);
  }
  return cookieFrom(response);
}

function seedAgent() {
  const agents = readJson('agents.json');
  const agent = {
    id: Math.max(0, ...agents.map(item => item.id)) + 1,
    name: `RuntimeFeasibilityAgent-${STAMP}`,
    type: 'agent',
    provider: 'openai',
    model: 'gpt-4.1-mini',
    apiKey: 'test-key-runtime-feasibility',
    createdAt: new Date().toISOString()
  };
  writeJson('agents.json', [...agents, agent]);
  return agent;
}

function createFakeOpenAIPreload() {
  const preloadPath = path.join(os.tmpdir(), `runtime-feasibility-openai-${process.pid}-${Date.now()}.js`);
  const source = `
global.fetch = async function() {
  return {
    ok: true,
    status: 200,
    headers: new Map([['x-request-id', 'fake-runtime-feasibility']]),
    async text() {
      return JSON.stringify({
        output_text: JSON.stringify({ message: 'Should not be called', actions: [], complete: true }),
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 }
      });
    }
  };
};
`;
  fs.writeFileSync(preloadPath, source);
  return preloadPath;
}

function startServer(preloadPath) {
  const server = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      PORT,
      NODE_OPTIONS: `--require ${preloadPath}`,
      WORKSPACE_ROOT,
      DATA_DIR,
      AGENT_MAX_EXECUTION_STEPS: '4',
      AGENT_MAX_MUTATING_ACTIONS_PER_RESPONSE: '2',
      AGENT_MAX_MODEL_REQUESTS_PER_RUN: '10',
      AGENT_MAX_WORKSPACE_OPERATIONS_PER_RUN: '20',
      AGENT_MAX_RUNTIME_DURATION_MS: '5000'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  server.stdout.on('data', chunk => process.stdout.write(String(chunk)));
  server.stderr.on('data', chunk => process.stderr.write(String(chunk)));
  return server;
}

async function createAssignedTicket(cookie, agentId, objective) {
  const response = await request('POST', '/tickets', {
    cookie,
    form: {
      objective,
      assignmentTargetType: 'agent',
      assignmentTargetId: String(agentId)
    }
  });
  if (response.statusCode !== 302) {
    throw new Error(`Ticket create failed with HTTP ${response.statusCode}: ${response.body}`);
  }
  const ticket = readJson('tickets.json').find(item => item.objective === objective);
  if (!ticket) throw new Error('Ticket was not persisted');
  return ticket;
}

async function waitForFailedRun(ticketId) {
  const started = Date.now();
  while (Date.now() - started < 15000) {
    const runs = readJson('runs.json').filter(run => run.ticketId === ticketId);
    if (runs.length === 1 && runs[0].status === 'failed' && runs[0].triage && runs[0].triage.reasonCode) {
      const runId = runs[0].id;
      const terminalized = readEvents().some(event => event.type === 'run.terminalized' && event.runId === runId);
      if (terminalized) return runs[0];
    }
    if (runs.length === 1 && (runs[0].status === 'completed' || runs[0].status === 'succeeded')) {
      throw new Error(`Run completed unexpectedly: ${JSON.stringify(runs[0])}`);
    }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  const runs = readJson('runs.json').filter(run => run.ticketId === ticketId);
  throw new Error(`Timed out waiting for failed run for ticket ${ticketId}; runs=${JSON.stringify(runs)}`);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function rmDirectoryWithRetry(dir) {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      return;
    } catch (error) {
      if (attempt === 9) throw error;
      try {
        fs.accessSync(dir);
      } catch {
        return;
      }
    }
  }
}

async function main() {
  const preloadPath = createFakeOpenAIPreload();
  const targets = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J'];

  try {
    for (const name of targets) {
      fs.writeFileSync(path.join(WORKSPACE_ROOT, name), `target ${name}\n`);
    }

    const agent = seedAgent();
    const server = startServer(preloadPath);
    await waitForReady();
    const cookie = await login();
    const objective = `Delete files ${targets.join(', ')}`;
    const ticket = await createAssignedTicket(cookie, agent.id, objective);
    const run = await waitForFailedRun(ticket.id);

    assert(run.status === 'failed', `Expected run status failed, got ${run.status}`);
    assert(/Runtime budget infeasible/i.test(run.error || ''), `Expected budget infeasibility error, got: ${run.error}`);
    assert(run.triage && run.triage.reasonCode === 'runtime_budget_insufficient', `Expected triage reason runtime_budget_insufficient, got ${run.triage && run.triage.reasonCode}`);
    assert(run.triage && run.triage.allowedActions.includes('raise_limit'), 'Expected raise_limit allowed action');
    assert(run.triage && run.triage.allowedActions.includes('split_task'), 'Expected split_task allowed action');
    assert(run.triage && run.triage.allowedActions.includes('manual_recovery'), 'Expected manual_recovery allowed action');

    for (const name of targets) {
      assert(fs.existsSync(path.join(WORKSPACE_ROOT, name)), `Target ${name} should not have been mutated`);
    }

    console.log(JSON.stringify({ runtimeBudgetFeasibility: true, reasonCode: run.triage.reasonCode }));
    server.kill('SIGTERM');
    await waitForExit(server);
  } finally {
    rmDirectoryWithRetry(DATA_DIR);
    try {
      removeTempWorkspaceRoot(WORKSPACE_ROOT);
    } catch {
      rmDirectoryWithRetry(WORKSPACE_ROOT);
    }
    fs.rmSync(preloadPath, { force: true });
  }
}

main().catch(error => {
  console.error(error.stack || error.message);
  process.exit(1);
});

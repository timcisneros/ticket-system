const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { createTempWorkspaceRoot, removeTempWorkspaceRoot } = require('./test-workspace');

const ROOT = path.resolve(__dirname, '..');
const REAL_DATA_DIR = path.join(ROOT, 'data');
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-budget-data-'));
const WORKSPACE_ROOT = createTempWorkspaceRoot('runtime-budget');
const PORT = process.env.PORT || '3431';
const BASE_URL = `http://127.0.0.1:${PORT}`;
const STAMP = Date.now();
const FIXTURE_FILE = `runtime-budget-fixture-${STAMP}.txt`;
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

function readRunReplaySnapshot(run) {
  if (!run || typeof run !== 'object') return null;
  if (run.replaySnapshot && typeof run.replaySnapshot === 'object') return run.replaySnapshot;
  if (!run.replaySnapshotPath) return null;

  const snapshotPath = path.resolve(DATA_DIR, run.replaySnapshotPath);
  if (!snapshotPath.startsWith(DATA_DIR + path.sep)) return null;
  if (!fs.existsSync(snapshotPath)) return null;
  return JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));
}

function hydrateRunReplaySnapshot(run) {
  if (!run || typeof run !== 'object') return run;
  const replaySnapshot = readRunReplaySnapshot(run);
  return replaySnapshot ? { ...run, replaySnapshot } : run;
}

function readJson(file) {
  const value = JSON.parse(fs.readFileSync(path.join(DATA_DIR, file), 'utf8'));
  if (file !== 'runs.json' || !Array.isArray(value)) return value;
  return value.map(hydrateRunReplaySnapshot);
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
    name: `RuntimeBudgetAgent-${STAMP}`,
    type: 'agent',
    provider: 'openai',
    model: 'gpt-4.1-mini',
    apiKey: 'test-key-runtime-budget',
    createdAt: new Date().toISOString()
  };

  writeJson('agents.json', [...agents, agent]);
  return agent;
}

function createFakeOpenAIPreload() {
  const preloadPath = path.join(os.tmpdir(), `runtime-budget-openai-${process.pid}-${Date.now()}.js`);
  const source = `
function abortError() {
  const error = new Error('The operation was aborted');
  error.name = 'AbortError';
  return error;
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(resolve, ms);
    if (signal) {
      signal.addEventListener('abort', () => {
        clearTimeout(timeout);
        reject(abortError());
      }, { once: true });
    }
  });
}

function okResponse(plan) {
  return {
    ok: true,
    status: 200,
    headers: new Map([['x-request-id', 'fake-runtime-budget']]),
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

  if (combined.includes('runtime-budget-timeout')) {
    await sleep(500, options.signal);
    return okResponse({ message: 'late response', actions: [], complete: true });
  }

  await sleep(25, options.signal);

  if (combined.includes('runtime-budget-operation-limit')) {
    return okResponse({
      message: 'Too many workspace operations.',
      actions: Array.from({ length: 5 }, () => ({
        operation: 'readFile',
        args: { path: '${FIXTURE_FILE}' }
      })),
      complete: false
    });
  }

  return okResponse({
    message: 'Request another step.',
    actions: [{
      operation: 'readFile',
      args: { path: '${FIXTURE_FILE}' }
    }],
    complete: false
  });
};
`;

  fs.writeFileSync(preloadPath, source);
  return preloadPath;
}

function startServer(preloadPath, env) {
  const server = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      PORT,
      NODE_OPTIONS: `--require ${preloadPath}`,
      WORKSPACE_ROOT,
      DATA_DIR,
      ...env
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
    if (runs.length === 1 && runs[0].status === 'failed' && runs[0].replaySummary && runs[0].replaySummary.terminalStatus === 'failed') {
      return runs[0];
    }

    await new Promise(resolve => setTimeout(resolve, 50));
  }

  throw new Error(`Timed out waiting for failed run for ticket ${ticketId}`);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function runLimitScenario(preloadPath, agent, objective, env, expectedEventType) {
  let server = null;

  try {
    server = startServer(preloadPath, agent ? env : env);
    await waitForReady();
    const cookie = await login();
    const ticket = await createAssignedTicket(cookie, agent.id, `${objective} ${STAMP}`);
    const run = await waitForFailedRun(ticket.id);
    const logs = readJson('logs.json').filter(log => log.runId === run.id);
    const snapshotEvents = run.replaySnapshot.events || [];

    assert(logs.some(log => log.type === expectedEventType), `Missing ${expectedEventType} log`);
    assert(snapshotEvents.some(event =>
      event.type === expectedEventType &&
      typeof event.currentValue === 'number' &&
      typeof event.configuredLimit === 'number'
    ), `Missing ${expectedEventType} replay event`);

    return run;
  } finally {
    if (server) {
      server.kill('SIGTERM');
      await waitForExit(server);
    }
  }
}

async function main() {
  const preloadPath = createFakeOpenAIPreload();

  try {
    fs.writeFileSync(path.join(WORKSPACE_ROOT, FIXTURE_FILE), 'runtime budget fixture\n');
    const agent = seedAgent();

    await runLimitScenario(preloadPath, agent, 'runtime-budget-operation-limit', {
      AGENT_MAX_EXECUTION_STEPS: '10',
      AGENT_MAX_MODEL_REQUESTS_PER_RUN: '10',
      AGENT_MAX_WORKSPACE_OPERATIONS_PER_RUN: '4',
      AGENT_MAX_RUNTIME_DURATION_MS: '5000'
    }, 'run:operation_limit');

    await runLimitScenario(preloadPath, agent, 'runtime-budget-request-limit', {
      AGENT_MAX_EXECUTION_STEPS: '10',
      AGENT_MAX_MODEL_REQUESTS_PER_RUN: '2',
      AGENT_MAX_WORKSPACE_OPERATIONS_PER_RUN: '20',
      AGENT_MAX_RUNTIME_DURATION_MS: '5000'
    }, 'run:model_request_limit');

    await runLimitScenario(preloadPath, agent, 'runtime-budget-timeout', {
      AGENT_MAX_EXECUTION_STEPS: '10',
      AGENT_MAX_MODEL_REQUESTS_PER_RUN: '10',
      AGENT_MAX_WORKSPACE_OPERATIONS_PER_RUN: '20',
      AGENT_MAX_RUNTIME_DURATION_MS: '100'
    }, 'run:timeout');

    console.log(JSON.stringify({ operationLimit: true, modelRequestLimit: true, timeout: true }));
  } finally {
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
    removeTempWorkspaceRoot(WORKSPACE_ROOT);
    fs.rmSync(preloadPath, { force: true });
  }
}

main().catch(error => {
  console.error(error.stack || error.message);
  process.exit(1);
});

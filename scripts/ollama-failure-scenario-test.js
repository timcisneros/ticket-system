const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { createTempWorkspaceRoot, removeTempWorkspaceRoot } = require('./test-workspace');

const ROOT = path.resolve(__dirname, '..');
const REAL_DATA_DIR = path.join(ROOT, 'data');
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ollama-scenario-data-'));
const WORKSPACE_ROOT = createTempWorkspaceRoot('ollama-scenario');
const PORT = process.env.PORT || '3445';
const BASE_URL = `http://127.0.0.1:${PORT}`;
const STAMP = Date.now();
const DATA_FILES = ['agents.json', 'allocation-plans.json', 'groups.json', 'logs.json', 'memberships.json', 'operation-history.json', 'permissions.json', 'runs.json', 'tickets.json', 'users.json'];

for (const file of DATA_FILES) {
  const src = path.join(REAL_DATA_DIR, file);
  const dst = path.join(DATA_DIR, file);
  if (fs.existsSync(src)) fs.copyFileSync(src, dst);
  else fs.writeFileSync(dst, '[]');
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
  const body = options.form ? new URLSearchParams(options.form).toString() : options.body ? JSON.stringify(options.body) : null;
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
    } catch (error) {}
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
  const response = await request('POST', '/login', { form: { username: 'admin', password: 'admin123' } });
  if (response.statusCode !== 302) throw new Error(`Admin login failed with HTTP ${response.statusCode}`);
  return cookieFrom(response);
}

function seedAgent() {
  const agents = readJson('agents.json');
  const agent = {
    id: Math.max(0, ...agents.map(item => item.id)) + 1,
    name: `OllamaScenarioAgent-${STAMP}`,
    type: 'agent',
    provider: 'ollama',
    model: 'llama3.2',
    apiKey: '',
    createdAt: new Date().toISOString()
  };
  writeJson('agents.json', [...agents, agent]);
  return agent;
}

function createFakeOllamaPreload() {
  const preloadPath = path.join(os.tmpdir(), `ollama-scenario-preload-${process.pid}-${Date.now()}.js`);
  const source = [
    "const responseCounts = new Map();",
    "",
    "function nextCount(key) {",
    "  const count = (responseCounts.get(key) || 0) + 1;",
    "  responseCounts.set(key, count);",
    "  return count;",
    "}",
    "",
    "function okResponse(plan) {",
    "  return {",
    "    ok: true,",
    "    status: 200,",
    "    headers: new Map([['x-request-id', 'fake-ollama-request']]),",
    "    async text() {",
    "      return JSON.stringify({",
    "        message: { content: JSON.stringify(plan) },",
    "        usage: { prompt_eval_count: 1, eval_count: 1, total_duration: 50000000 }",
    "      });",
    "    }",
    "  };",
    "}",
    "",
    "global.fetch = async function(url, options = {}) {",
    "  const body = JSON.parse(options.body || '{}');",
    "  const messages = Array.isArray(body.messages) ? body.messages : [];",
    "  const combined = messages.map(item => item && item.content ? String(item.content) : '').join('\\n');",
    "",
    "  await new Promise(resolve => setTimeout(resolve, 50));",
    "",
    "  if (combined.includes('ollama-scenario-folder-file-repeat')) {",
    "    const count = nextCount('folder-file-repeat');",
    "    if (count === 1) {",
    "      return okResponse({",
    "        message: 'Creating folder and writing file.',",
    "        actions: [",
    "          { operation: 'createFolder', args: { path: '1' } },",
    "          { operation: 'writeFile', args: { path: '1/today.txt', content: '2026-05-23' } }",
    "        ],",
    "        complete: false",
    "      });",
    "    }",
    "    return okResponse({",
    "      message: 'Ensuring folder and file exist.',",
    "      actions: [",
    "        { operation: 'createFolder', args: { path: '1' } },",
    "        { operation: 'writeFile', args: { path: '1/today.txt', content: '2026-05-23' } }",
    "      ],",
    "      complete: false",
    "    });",
    "  }",
    "",
    "  return okResponse({ message: 'default', actions: [], complete: true });",
    "};",
    ""
  ].join('\n');

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
    form: { objective, assignmentTargetType: 'agent', assignmentTargetId: String(agentId) }
  });
  if (response.statusCode !== 302) throw new Error(`Ticket create failed with HTTP ${response.statusCode}: ${response.body}`);
  const ticket = readJson('tickets.json').find(item => item.objective === objective);
  if (!ticket) throw new Error('Ticket was not persisted');
  return ticket;
}

async function waitForTerminalRun(ticketId, expectedStatus) {
  const started = Date.now();
  while (Date.now() - started < 15000) {
    const runs = readJson('runs.json').filter(run => run.ticketId === ticketId);
    if (runs.length >= 1 && runs[0].status === expectedStatus && runs[0].replaySummary && runs[0].replaySummary.terminalStatus === expectedStatus) {
      return runs[0];
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for terminal run for ticket ${ticketId}`);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function main() {
  const preloadPath = createFakeOllamaPreload();
  const agent = seedAgent();

  let server = null;
  try {
    server = startServer(preloadPath, {
      AGENT_MAX_EXECUTION_STEPS: '4',
      AGENT_MAX_MODEL_REQUESTS_PER_RUN: '4',
      AGENT_MAX_WORKSPACE_OPERATIONS_PER_RUN: '10',
      AGENT_MAX_RUNTIME_DURATION_MS: '5000'
    });
    await waitForReady();
    const cookie = await login();
    const ticket = await createAssignedTicket(cookie, agent.id, `ollama-scenario-folder-file-repeat ${STAMP}`);
    const run = await waitForTerminalRun(ticket.id, 'completed');
    const snapshot = run.replaySnapshot;

    // 1. Run completed
    assert(run.status === 'completed', `Run ${run.id} status ${run.status} !== completed`);

    // 2. No provider timeout / abort
    assert(!snapshot.events.some(e => e.type === 'run:timeout'), `Unexpected run:timeout event for run ${run.id}`);
    assert(!snapshot.events.some(e => e.type === 'run:step_limit'), `Unexpected run:step_limit event for run ${run.id}`);

    // 3. Replay contains run:postcondition_completed
    const postconditionEvents = snapshot.events.filter(e => e.type === 'run:postcondition_completed');
    assert(postconditionEvents.length >= 1, `Missing run:postcondition_completed event for run ${run.id}`);

    // 4. Outcome shows completed_with_verified_postcondition
    const operationalOutcome = snapshot.events.some(e => e.type === 'run:postcondition_completed') ? 'completed_with_verified_postcondition' : null;
    assert(operationalOutcome === 'completed_with_verified_postcondition', `Run ${run.id} did not classify as postcondition completed`);

    // 5. Operation history still records actual mutations
    const history = readJson('operation-history.json');
    const runHistory = history.filter(h => h.runId === run.id);
    assert(runHistory.length >= 1, `Operation history missing mutations for run ${run.id}`);
    assert(runHistory.some(h => h.operation === 'createFolder'), `Missing createFolder in history for run ${run.id}`);
    assert(runHistory.some(h => h.operation === 'writeFile'), `Missing writeFile in history for run ${run.id}`);

    // 6. Redundant repeated writes do not continue forever (at most 2 model requests)
    assert(snapshot.providerRequests.length <= 2, `Too many provider requests (${snapshot.providerRequests.length}), postcondition did not stop the run`);
    assert(snapshot.parsedModelPlans.length <= 2, `Too many parsed model plans (${snapshot.parsedModelPlans.length}), postcondition did not stop the run`);

    // 7. Workspace state actually satisfied
    assert(fs.existsSync(path.join(WORKSPACE_ROOT, '1')), `Folder '1' should exist`);
    assert(fs.existsSync(path.join(WORKSPACE_ROOT, '1/today.txt')), `File '1/today.txt' should exist`);
    const content = fs.readFileSync(path.join(WORKSPACE_ROOT, '1/today.txt'), 'utf8');
    assert(content === '2026-05-23', `File content mismatch: ${content}`);

    console.log(JSON.stringify({
      ollamaScenarioCompleted: true,
      noTimeout: true,
      hasPostconditionEvent: true,
      outcomeCorrect: true,
      historyPreserved: true,
      noInfiniteLoop: true,
      workspaceSatisfied: true
    }));
  } finally {
    if (server) {
      server.kill('SIGTERM');
      await waitForExit(server);
    }
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
    removeTempWorkspaceRoot(WORKSPACE_ROOT);
    fs.rmSync(preloadPath, { force: true });
  }
}

main().catch(error => {
  console.error(error.stack || error.message);
  process.exit(1);
});

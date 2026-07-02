const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { createTempWorkspaceRoot, removeTempWorkspaceRoot } = require('./test-workspace');

const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-limits-config-data-'));
const WORKSPACE_ROOT = createTempWorkspaceRoot('runtime-limits-config');
const PORT = process.env.PORT || '3497';
const BASE_URL = `http://127.0.0.1:${PORT}`;
const LIMIT_KEYS = ['maxExecutionSteps', 'maxModelRequestsPerRun', 'maxWorkspaceOperationsPerRun', 'maxRuntimeDurationMs'];
const DEPLOYMENT = {
  maxExecutionSteps: 20,
  maxModelRequestsPerRun: 20,
  maxWorkspaceOperationsPerRun: 40,
  maxRuntimeDurationMs: 20000
};

function writeJson(file, value) {
  fs.writeFileSync(path.join(DATA_DIR, file), JSON.stringify(value, null, 2));
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(path.join(DATA_DIR, file), 'utf8'));
}

function seedData() {
  for (const file of ['agents.json', 'permissions.json', 'workflows.json']) {
    fs.copyFileSync(path.join(ROOT, 'data', file), path.join(DATA_DIR, file));
  }
  const agents = readJson('agents.json');
  agents[0] = { ...agents[0], provider: 'openai', model: 'gpt-4.1-mini', apiKey: 'test-runtime-limits-key' };
  writeJson('agents.json', agents);
  const seededAdmin = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'users.json'), 'utf8'))[0];
  writeJson('users.json', [
    { ...seededAdmin, id: 1, username: 'admin', type: 'user' },
    { ...seededAdmin, id: 2, username: 'viewer', type: 'user' }
  ]);
  writeJson('groups.json', [
    { id: 1, name: 'Administrators', permissions: [], canReceiveTickets: false },
    { id: 2, name: 'Viewers', permissions: ['ticket:read'], canReceiveTickets: false }
  ]);
  writeJson('memberships.json', [
    { id: 1, principalType: 'user', principalId: 1, groupId: 1 },
    { id: 2, principalType: 'user', principalId: 2, groupId: 2 }
  ]);
  for (const file of ['tickets.json', 'runs.json', 'logs.json', 'operation-history.json', 'allocation-plans.json']) writeJson(file, []);
  fs.writeFileSync(path.join(DATA_DIR, 'events.jsonl'), '');
}

function createPreload() {
  const file = path.join(os.tmpdir(), `runtime-limits-config-preload-${process.pid}-${Date.now()}.js`);
  const source = `
global.fetch = async function(url, options) {
  await new Promise(resolve => setTimeout(resolve, 350));
  return {
    ok: true,
    status: 200,
    headers: new Map([['x-request-id', 'runtime-limits-config-test']]),
    async text() {
      return JSON.stringify({
        output_text: JSON.stringify({ message: 'done', actions: [], complete: true }),
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 }
      });
    }
  };
};
`;
  fs.writeFileSync(file, source);
  return file;
}

function request(method, urlPath, options = {}) {
  const body = options.form
    ? new URLSearchParams(options.form).toString()
    : options.body !== undefined
      ? JSON.stringify(options.body)
      : null;
  return new Promise((resolve, reject) => {
    const req = http.request(`${BASE_URL}${urlPath}`, {
      method,
      headers: {
        ...(options.form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
        ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(body !== null ? { 'Content-Length': Buffer.byteLength(body) } : {}),
        ...(options.cookie ? { Cookie: options.cookie } : {})
      }
    }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch (_) {}
        resolve({ statusCode: res.statusCode, headers: res.headers, body: text, json });
      });
    });
    req.on('error', reject);
    if (body !== null) req.write(body);
    req.end();
  });
}

function cookieFrom(response) {
  return (response.headers['set-cookie'] || []).map(value => value.split(';')[0]).join('; ');
}

async function waitFor(fn, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await fn();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('Timed out waiting for test state');
}

async function login(username) {
  const response = await request('POST', '/login', { form: { username, password: 'admin123' } });
  if (response.statusCode !== 302) throw new Error(`Login failed for ${username}: ${response.statusCode}`);
  return cookieFrom(response);
}

async function createTicket(cookie, objective) {
  const response = await request('POST', '/tickets', {
    cookie,
    form: { objective, assignmentTargetType: 'agent', assignmentTargetId: '1', assignmentMode: 'individual' }
  });
  if (response.statusCode !== 302) throw new Error(`Ticket creation failed: ${response.statusCode} ${response.body}`);
  return readJson('tickets.json').find(ticket => ticket.objective === objective);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertLimits(actual, expected, label) {
  for (const key of LIMIT_KEYS) assert(actual[key] === expected[key], `${label}: ${key}=${actual[key]}, expected ${expected[key]}`);
}

async function main() {
  seedData();
  const preload = createPreload();
  const server = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      PORT,
      DATA_DIR,
      WORKSPACE_ROOT,
      NODE_OPTIONS: `--require ${preload}`,
      RUNTIME_SCHEDULER_INTERVAL_MS: '25',
      AGENT_MAX_EXECUTION_STEPS: String(DEPLOYMENT.maxExecutionSteps),
      AGENT_MAX_MODEL_REQUESTS_PER_RUN: String(DEPLOYMENT.maxModelRequestsPerRun),
      AGENT_MAX_WORKSPACE_OPERATIONS_PER_RUN: String(DEPLOYMENT.maxWorkspaceOperationsPerRun),
      AGENT_MAX_RUNTIME_DURATION_MS: String(DEPLOYMENT.maxRuntimeDurationMs),
      LOCAL_MODEL_CONCURRENCY: '4',
      MAX_LOCAL_MODEL_CONCURRENCY: '8'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  server.stdout.on('data', chunk => process.stdout.write(String(chunk)));
  server.stderr.on('data', chunk => process.stderr.write(String(chunk)));

  try {
    await waitFor(async () => {
      try { return (await request('GET', '/health')).statusCode === 200; } catch (_) { return false; }
    });
    const admin = await login('admin');
    const viewer = await login('viewer');

    assert((await request('GET', '/api/runtime-limits', { cookie: viewer })).statusCode === 403, 'viewer must not read runtime limits');
    assert((await request('POST', '/api/runtime-limits', { cookie: viewer, body: { maxExecutionSteps: 1 } })).statusCode === 403, 'viewer must not update runtime limits');

    const inherited = await request('GET', '/api/runtime-limits', { cookie: admin });
    assert(inherited.statusCode === 200, 'authorized GET should succeed');
    assertLimits(inherited.json.effectiveLimits, DEPLOYMENT, 'missing config inherits deployment caps');
    assert(LIMIT_KEYS.every(key => inherited.json.config[key] === null), 'missing config should materialize as all-null config');

    const allNull = Object.fromEntries(LIMIT_KEYS.map(key => [key, null]));
    const nullUpdate = await request('POST', '/api/runtime-limits', { cookie: admin, body: allNull });
    assert(nullUpdate.statusCode === 200, 'all-null config should be accepted');
    assertLimits(nullUpdate.json.effectiveLimits, DEPLOYMENT, 'null config inherits deployment caps');

    const invalidCases = [
      { maxExecutionSteps: 0 },
      { maxExecutionSteps: -1 },
      { maxExecutionSteps: 1.5 },
      { maxExecutionSteps: '2' },
      { maxRuntimeDurationMs: 4999 },
      { maxExecutionSteps: DEPLOYMENT.maxExecutionSteps + 1 },
      { maxRuntimeDurationMs: DEPLOYMENT.maxRuntimeDurationMs + 1 }
    ];
    for (const body of invalidCases) {
      const response = await request('POST', '/api/runtime-limits', { cookie: admin, body });
      assert(response.statusCode === 400, `invalid config should be rejected: ${JSON.stringify(body)}`);
    }

    const configured = {
      maxExecutionSteps: 3,
      maxModelRequestsPerRun: 3,
      maxWorkspaceOperationsPerRun: 10,
      maxRuntimeDurationMs: 5000
    };
    const valid = await request('POST', '/api/runtime-limits', { cookie: admin, body: configured });
    assert(valid.statusCode === 200, `valid config rejected: ${valid.body}`);
    assertLimits(valid.json.effectiveLimits, configured, 'valid UI values become effective');
    const stored = readJson('runtime-limits.json');
    assertLimits(stored, configured, 'valid config persisted');
    assert(stored.updatedBy === 'admin' && typeof stored.updatedAt === 'string', 'config audit metadata missing');

    // System config keys (localModelConcurrency) must round-trip through validate -> persist -> read.
    // Regression: the validator previously returned only pickRuntimeLimitValues(), silently dropping
    // localModelConcurrency so it always persisted as null and the setting was inert.
    // The ceiling (MAX_LOCAL_MODEL_CONCURRENCY=8) is decoupled from the inherited default
    // (LOCAL_MODEL_CONCURRENCY=4), so the UI may raise concurrency above the default up to the ceiling.
    for (const body of [{ localModelConcurrency: 0 }, { localModelConcurrency: -1 }, { localModelConcurrency: 1.5 }, { localModelConcurrency: '2' }, { localModelConcurrency: 9 }]) {
      const response = await request('POST', '/api/runtime-limits', { cookie: admin, body });
      assert(response.statusCode === 400, `invalid localModelConcurrency should be rejected: ${JSON.stringify(body)}`);
    }
    // 6 exceeds the inherited default (4) but is within the ceiling (8); this was wrongly rejected
    // before the deployment-cap decoupling.
    const concurrencyUpdate = await request('POST', '/api/runtime-limits', { cookie: admin, body: { localModelConcurrency: 6 } });
    assert(concurrencyUpdate.statusCode === 200, `valid localModelConcurrency rejected: ${concurrencyUpdate.body}`);
    assert(concurrencyUpdate.json.config.localModelConcurrency === 6, `localModelConcurrency not returned: ${concurrencyUpdate.body}`);
    assert(readJson('runtime-limits.json').localModelConcurrency === 6, 'localModelConcurrency must persist to disk');
    // A subsequent limit-only update that omits the system key must not wipe the persisted value.
    // (Re-applying `configured` also restores the limit state the run-snapshot assertions below expect.)
    assert((await request('POST', '/api/runtime-limits', { cookie: admin, body: configured })).statusCode === 200, 'limit-only update failed');
    assert(readJson('runtime-limits.json').localModelConcurrency === 6, 'localModelConcurrency must survive unrelated updates');
    assertLimits(readJson('runtime-limits.json'), configured, 'limit-only update preserves configured limits');

    const objective = `Create a runtime snapshot ${Date.now()}`;
    const ticket = await createTicket(admin, objective);
    const createdRun = await waitFor(() => readJson('runs.json').find(run => run.ticketId === ticket.id));
    assertLimits(createdRun.runtimeLimitsSnapshot, configured, 'new run snapshot');
    assert(createdRun.runtimeLimitsSnapshot.source.uiConfigured === true, 'snapshot should identify UI configuration');

    await waitFor(() => readJson('logs.json').some(log => log.runId === createdRun.id && log.type === 'model:request'));
    const lowered = { ...configured, maxExecutionSteps: 1, maxModelRequestsPerRun: 1, maxWorkspaceOperationsPerRun: 1 };
    const changedMidRun = await request('POST', '/api/runtime-limits', { cookie: admin, body: lowered });
    assert(changedMidRun.statusCode === 200, 'mid-run settings update should succeed for future runs');
    const terminal = await waitFor(() => {
      const run = readJson('runs.json').find(item => item.id === createdRun.id);
      return run && ['completed', 'failed'].includes(run.status) ? run : null;
    });
    assertLimits(terminal.runtimeLimitsSnapshot, configured, 'active run snapshot remains immutable');
    const replay = JSON.parse(fs.readFileSync(path.join(DATA_DIR, terminal.replaySnapshotPath), 'utf8'));
    assertLimits(replay.runtimeLimitsSnapshot, configured, 'replay snapshot uses run-start limits');
    assert(replay.runtimeEnvelope.maxExecutionSteps === configured.maxExecutionSteps, 'runtime envelope should use run-start limits');

    const profileConfig = {
      maxExecutionSteps: 15,
      maxModelRequestsPerRun: 15,
      maxWorkspaceOperationsPerRun: 30,
      maxRuntimeDurationMs: 10000
    };
    assert((await request('POST', '/api/runtime-limits', { cookie: admin, body: profileConfig })).statusCode === 200, 'profile config update failed');
    const reportTicket = await createTicket(admin, `Write report-summary-${Date.now()}.txt with a report summary`);
    const reportRun = await waitFor(() => readJson('runs.json').find(run => run.ticketId === reportTicket.id));
    assert(reportRun.runtimeLimitsSnapshot.maxExecutionSteps === 12, 'report profile must cap execution steps at 12');
    assert(reportRun.runtimeLimitsSnapshot.maxModelRequestsPerRun === 8, 'report profile must cap model requests at 8');
    assert(reportRun.runtimeLimitsSnapshot.maxListDirectoryPerRun === 3, 'report listDirectory cap must be snapshotted');
    assert(reportRun.runtimeLimitsSnapshot.maxReadFilePerRun === 8, 'report readFile cap must be snapshotted');

    await waitFor(() => fs.readFileSync(path.join(DATA_DIR, 'events.jsonl'), 'utf8').includes('runtime_limits.updated'));
    const eventsText = fs.readFileSync(path.join(DATA_DIR, 'events.jsonl'), 'utf8');
    assert(eventsText.includes('oldValues') && eventsText.includes('newValues') && eventsText.includes('"actor":"admin"'), 'runtime limit audit event is incomplete');
    assert(readJson('logs.json').some(log => log.type === 'runtime_limits.updated' && log.actor === 'admin'), 'runtime limit operator log missing');

    console.log('PASS: configurable runtime limits are permissioned, validated, capped, audited, and immutable per run');
  } finally {
    server.kill('SIGTERM');
    if (server.exitCode === null) await new Promise(resolve => server.once('exit', resolve));
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
    removeTempWorkspaceRoot(WORKSPACE_ROOT);
    fs.rmSync(preload, { force: true });
  }
}

main().catch(error => {
  console.error(error.stack || error.message);
  process.exit(1);
});

const { execFile } = require('child_process');
const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { createTempWorkspaceRoot, removeTempWorkspaceRoot } = require('./test-workspace');

const ROOT = path.resolve(__dirname, '..');
const REAL_DATA_DIR = path.join(ROOT, 'data');
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'replay-snapshot-storage-'));
const WORKSPACE_ROOT = createTempWorkspaceRoot('replay-snapshot-storage');
const PORT = process.env.PORT || '3431';
const BASE_URL = `http://127.0.0.1:${PORT}`;
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
  const dst = path.join(DATA_DIR, file);
  fs.writeFileSync(dst, fs.existsSync(src) ? fs.readFileSync(src, 'utf8') : '[]');
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(path.join(DATA_DIR, file), 'utf8'));
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

async function waitForReady() {
  const started = Date.now();
  while (Date.now() - started < 15000) {
    try {
      const response = await request('GET', '/health');
      if (response.statusCode === 200 && JSON.parse(response.body).ready) return;
    } catch (error) {
      // Server is still starting.
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Timed out waiting for server ready');
}

function waitForExit(child) {
  return new Promise(resolve => {
    if (child.exitCode !== null || child.killed) return resolve();
    child.once('exit', () => resolve());
  });
}

async function login() {
  const response = await request('POST', '/login', {
    form: { username: 'admin', password: 'admin123' }
  });
  if (response.statusCode !== 302) throw new Error(`Admin login failed with HTTP ${response.statusCode}`);
  return cookieFrom(response);
}

function execNode(args) {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, args, {
      cwd: ROOT,
      env: { ...process.env, DATA_DIR, WORKSPACE_ROOT }
    }, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function seedInlineReplayFixture() {
  const now = new Date().toISOString();
  const agent = readJson('agents.json')[0] || { id: 1, name: 'Fixture Agent', provider: 'openai', model: 'gpt-5.1-mini' };
  const ticketId = Math.max(0, ...readJson('tickets.json').map(item => item.id || 0)) + 1;
  const runId = Math.max(0, ...readJson('runs.json').map(item => item.id || 0)) + 1;
  const ticket = {
    id: ticketId,
    objective: 'replay snapshot storage fixture',
    assignmentTargetType: 'agent',
    assignmentTargetId: agent.id,
    assignmentMode: 'individual',
    status: 'failed',
    createdBy: 'admin',
    createdAt: now,
    updatedAt: now
  };
  const replaySnapshot = {
    version: 1,
    runId,
    ticketId,
    assignedAgentId: agent.id,
    agentNameSnapshot: agent.name,
    provider: 'openai',
    model: agent.model || 'gpt-5.1-mini',
    runtimeEnvelope: {},
    ticketObjectiveSnapshot: ticket.objective,
    systemInstructionSnapshot: 'fixture',
    primitiveContract: {},
    workspaceRoot: WORKSPACE_ROOT,
    mainWorkspaceRoot: WORKSPACE_ROOT,
    executionWorkspaceType: 'main',
    runtimeLimits: { maxExecutionSteps: 4, maxModelRequestsPerRun: 4, maxWorkspaceOperationsPerRun: 32 },
    providerRequests: [{ requestId: 'fixture-request' }],
    modelResponses: [{ text: '{"actions":[],"complete":false}' }],
    parsedModelPlans: [{ actions: [], complete: false }],
    workspaceOperations: [],
    events: [{ type: 'model:no_progress', message: 'fixture no progress' }],
    terminalStatus: 'failed',
    failureReason: 'fixture structured failure',
    failure: { code: 'RUN_LIMIT_EXCEEDED', kind: 'no_progress', detail: { limitType: 'execution_steps' } },
    mutationCount: 0,
    mutationOutcome: 'no_mutations',
    createdAt: now,
    finalizedAt: now
  };
  const run = {
    id: runId,
    ticketId,
    agentId: agent.id,
    agentName: agent.name,
    workspaceRoot: WORKSPACE_ROOT,
    mainWorkspaceRoot: WORKSPACE_ROOT,
    executionWorkspaceType: 'main',
    status: 'failed',
    ticketOpenedAt: now,
    createdAt: now,
    updatedAt: now,
    startedAt: now,
    completedAt: now,
    error: 'fixture structured failure',
    replaySnapshot
  };

  writeJson('tickets.json', [...readJson('tickets.json'), ticket]);
  writeJson('runs.json', [...readJson('runs.json'), run]);
  writeJson('logs.json', [
    ...readJson('logs.json'),
    {
      id: Math.max(0, ...readJson('logs.json').map(item => item.id || 0)) + 1,
      timestamp: now,
      runId,
      ticketId,
      agentId: agent.id,
      agentName: agent.name,
      type: 'run:failed',
      message: 'fixture structured failure',
      workspaceAction: null
    }
  ]);
  return { ticket, run, replaySnapshot };
}

async function main() {
  const fixture = seedInlineReplayFixture();
  const extraction = await execNode(['scripts/extract-replay-snapshots.js']);
  const extractionPayload = JSON.parse(extraction.stdout);
  assert(extractionPayload.extracted >= 1, 'Extraction helper should extract inline replay snapshots');
  const migratedRun = readJson('runs.json').find(run => run.id === fixture.run.id);
  assert(migratedRun && !migratedRun.replaySnapshot, 'Extraction helper should remove inline replay snapshot');
  assert(migratedRun.replaySnapshotPath === `replay-snapshots/run-${fixture.run.id}.json`, 'Extraction helper should write replay snapshot pointer');
  const migratedSnapshot = readJson(migratedRun.replaySnapshotPath);
  assert(JSON.stringify(migratedSnapshot) === JSON.stringify(fixture.replaySnapshot), 'Extraction helper should preserve snapshot equality');
  let server = null;

  try {
    server = spawn(process.execPath, ['server.js'], {
      cwd: ROOT,
      env: { ...process.env, NODE_ENV: 'test', PORT, WORKSPACE_ROOT, DATA_DIR },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    server.stdout.on('data', chunk => process.stdout.write(String(chunk)));
    server.stderr.on('data', chunk => process.stderr.write(String(chunk)));

    await waitForReady();
    const cookie = await login();

    const rawRun = readJson('runs.json').find(run => run.id === fixture.run.id);
    assert(rawRun && !rawRun.replaySnapshot, 'Server should keep runs.json metadata-only');
    assert(rawRun.replaySnapshotPath === `replay-snapshots/run-${fixture.run.id}.json`, 'Run should point at replay snapshot file');
    assert(rawRun.replaySummary && rawRun.replaySummary.failure.kind === 'no_progress', 'Run should keep structured replay summary');
    const storedSnapshot = readJson(rawRun.replaySnapshotPath);
    assert(JSON.stringify(storedSnapshot) === JSON.stringify(fixture.replaySnapshot), 'Extracted replay snapshot should preserve equality');

    const runDetail = await request('GET', `/runs/${fixture.run.id}`, { cookie });
    assert(runDetail.statusCode === 200, `Run detail returned HTTP ${runDetail.statusCode}`);
    assert(runDetail.body.includes('Provider Requests (1)'), 'Run detail should hydrate replay snapshot file');

    const replay = await execNode(['scripts/oquery.js', 'replay', String(fixture.run.id)]);
    assert(replay.stdout.includes(`Replay: Run #${fixture.run.id}`), 'oquery replay should hydrate replay snapshot file');

    const failures = await execNode(['scripts/oquery.js', 'failures', '--run', String(fixture.run.id)]);
    assert(failures.stdout.includes('NO_PROGRESS'), 'oquery failures should classify from hydrated replay snapshot');

    const tickets = await request('GET', '/tickets?limit=1', { cookie });
    assert(tickets.statusCode === 200, `Tickets page returned HTTP ${tickets.statusCode}`);
    const agents = await request('GET', '/agents', { cookie });
    assert(agents.statusCode === 200, `Agents page returned HTTP ${agents.statusCode}`);

    console.log(JSON.stringify({ replaySnapshotStorage: true, runId: fixture.run.id }));
  } finally {
    if (server) {
      server.kill();
      await waitForExit(server);
    }
    removeTempWorkspaceRoot(WORKSPACE_ROOT);
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});

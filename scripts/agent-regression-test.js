const { execSync, spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { createTempWorkspaceRoot, removeTempWorkspaceRoot } = require('./test-workspace');

const ROOT = path.resolve(__dirname, '..');
const OQUERY = `node ${path.join(ROOT, 'scripts', 'oquery.js')}`;
const REAL_DATA_DIR = path.join(ROOT, 'data');
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-regression-data-'));
const WORKSPACE_ROOT = createTempWorkspaceRoot('agent-regression');
const PORT = process.env.PORT || '3422';
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
const STAMP = Date.now();
const TEST_FILE = `single-agent-regression-${STAMP}.txt`;
const MANUAL_RETRY_FILE = `single-agent-manual-retry-${STAMP}.txt`;
const PATH_CONFLICT_FILE = `single-agent-path-conflict-${STAMP}.txt`;
const ACTION_LIMIT_DIR_PREFIX = `single-agent-action-limit-${STAMP}`;
const MAX_STEP_READ_FILE = `single-agent-max-step-${STAMP}.txt`;
const BULK_DELETE_DIR_PREFIX = `single-agent-bulk-delete-${STAMP}`;
const BULK_CREATE_DIR_PREFIX = `single-agent-bulk-create-${STAMP}`;
const BULK_WRITE_FILE_PREFIX = `single-agent-bulk-write-${STAMP}`;
const PROTECTED_TEST_FILE = `.env.protected-${STAMP}`;
const MISSING_DIR_PREFIX = `single-agent-missing-dir-${STAMP}`;

for (const file of DATA_FILES) {
  const src = path.join(REAL_DATA_DIR, file);
  const dst = path.join(DATA_DIR, file);
  if (fs.existsSync(src)) {
    fs.copyFileSync(src, dst);
  } else {
    fs.writeFileSync(dst, '[]');
  }
}

const REAL_REPLAY_SNAPSHOT_DIR = path.join(REAL_DATA_DIR, 'replay-snapshots');
const REPLAY_SNAPSHOT_DIR = path.join(DATA_DIR, 'replay-snapshots');
if (fs.existsSync(REAL_REPLAY_SNAPSHOT_DIR)) {
  fs.cpSync(REAL_REPLAY_SNAPSHOT_DIR, REPLAY_SNAPSHOT_DIR, { recursive: true });
}

function readJson(file) {
  const value = JSON.parse(fs.readFileSync(path.join(DATA_DIR, file), 'utf8'));
  if (file !== 'runs.json' || !Array.isArray(value)) return value;
  return value.map(hydrateRunReplaySnapshot);
}

function readRawJson(file) {
  return JSON.parse(fs.readFileSync(path.join(DATA_DIR, file), 'utf8'));
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
      res.on('end', () => {
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks).toString('utf8')
        });
      });
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
  const nextAgentId = Math.max(0, ...agents.map(agent => agent.id)) + 1;
  const agent = {
    id: nextAgentId,
    name: `SingleAgentRegression-${STAMP}`,
    type: 'agent',
    provider: 'openai',
    model: 'gpt-4.1-mini',
    apiKey: 'test-key-single-agent',
    createdAt: new Date().toISOString()
  };

  writeJson('agents.json', [...agents, agent]);
  return agent;
}

function seedStaleRunningRun(agent) {
  const tickets = readJson('tickets.json');
  const runs = readJson('runs.json');
  const now = new Date().toISOString();
  const ticket = {
    id: Math.max(0, ...tickets.map(item => item.id)) + 1,
    objective: `single-agent stale-interrupted ${STAMP}`,
    assignmentTargetType: 'agent',
    assignmentTargetId: agent.id,
    assignmentMode: 'individual',
    status: 'in_progress',
    createdBy: 'admin',
    createdAt: now,
    updatedAt: now
  };
  const run = {
    id: Math.max(0, ...runs.map(item => item.id)) + 1,
    ticketId: ticket.id,
    agentId: agent.id,
    agentName: agent.name,
    workspaceRoot: WORKSPACE_ROOT,
    mainWorkspaceRoot: WORKSPACE_ROOT,
    executionWorkspaceType: 'main',
    status: 'running',
    ticketOpenedAt: now,
    createdAt: now,
    updatedAt: now,
    startedAt: now
  };

  writeJson('tickets.json', [...tickets, ticket]);
  writeJson('runs.json', [...runs, run]);
  return { ticket, run };
}

function seedStaleProviderCallRun(agent) {
  const tickets = readJson('tickets.json');
  const runs = readJson('runs.json');
  const logs = readJson('logs.json');
  const now = new Date().toISOString();
  const ticket = {
    id: Math.max(0, ...tickets.map(item => item.id)) + 1,
    objective: `single-agent stale-provider-call ${STAMP}`,
    assignmentTargetType: 'agent',
    assignmentTargetId: agent.id,
    assignmentMode: 'individual',
    status: 'in_progress',
    createdBy: 'admin',
    createdAt: now,
    updatedAt: now
  };
  const run = {
    id: Math.max(0, ...runs.map(item => item.id)) + 1,
    ticketId: ticket.id,
    agentId: agent.id,
    agentName: agent.name,
    workspaceRoot: WORKSPACE_ROOT,
    mainWorkspaceRoot: WORKSPACE_ROOT,
    executionWorkspaceType: 'main',
    status: 'running',
    ticketOpenedAt: now,
    createdAt: now,
    updatedAt: now,
    startedAt: now,
    replaySnapshot: {
      version: 1,
      runId: Math.max(0, ...runs.map(item => item.id)) + 1,
      ticketId: ticket.id,
      assignedAgentId: agent.id,
      agentNameSnapshot: agent.name,
      provider: 'openai',
      model: agent.model,
      providerRequests: [{
        url: 'https://api.openai.com/v1/responses',
        method: 'POST',
        headers: { Authorization: '[redacted]', 'Content-Type': 'application/json' },
        body: { model: agent.model, input: [{ role: 'user', content: ticket.objective }] },
        capturedAt: now
      }],
      modelResponses: [],
      parsedModelPlans: [],
      workspaceOperations: [],
      events: [],
      terminalStatus: null,
      failureReason: null,
      createdAt: now
    }
  };
  const log = {
    id: Math.max(0, ...logs.map(item => item.id)) + 1,
    timestamp: now,
    runId: run.id,
    ticketId: ticket.id,
    agentId: agent.id,
    agentName: agent.name,
    type: 'model:request',
    message: `OpenAI request sent with model ${agent.model}`,
    workspaceAction: null
  };

  writeJson('tickets.json', [...tickets, ticket]);
  writeJson('runs.json', [...runs, run]);
  writeJson('logs.json', [...logs, log]);
  return { ticket, run };
}

function seedManualStopRun(agent) {
  const tickets = readJson('tickets.json');
  const runs = readJson('runs.json');
  const now = new Date().toISOString();
  const ticket = {
    id: Math.max(0, ...tickets.map(item => item.id)) + 1,
    objective: `single-agent manual-stop ${STAMP}`,
    assignmentTargetType: 'agent',
    assignmentTargetId: agent.id,
    assignmentMode: 'individual',
    status: 'in_progress',
    createdBy: 'admin',
    createdAt: now,
    updatedAt: now
  };
  const run = {
    id: Math.max(0, ...runs.map(item => item.id)) + 1,
    ticketId: ticket.id,
    agentId: agent.id,
    agentName: agent.name,
    workspaceRoot: WORKSPACE_ROOT,
    mainWorkspaceRoot: WORKSPACE_ROOT,
    executionWorkspaceType: 'main',
    status: 'pending',
    ticketOpenedAt: now,
    createdAt: now,
    updatedAt: now
  };

  writeJson('tickets.json', [...tickets, ticket]);
  writeJson('runs.json', [...runs, run]);
  return { ticket, run };
}

function createFakeOpenAIPreload() {
  const preloadPath = path.join(os.tmpdir(), `agent-regression-openai-${process.pid}-${Date.now()}.js`);
  const source = `
const responseCounts = new Map();

function nextCount(key) {
  const count = (responseCounts.get(key) || 0) + 1;
  responseCounts.set(key, count);
  return count;
}

function okResponse(plan) {
  return {
    ok: true,
    status: 200,
    headers: new Map([['x-request-id', 'fake-single-agent-request']]),
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

  await new Promise(resolve => setTimeout(resolve, combined.includes('single-agent slow-provider') ? 1000 : 150));

  if (combined.includes('single-agent transport-failure')) {
    throw new Error('single-agent simulated transport failure');
  }

  if (combined.includes('single-agent fail-one')) {
    return {
      ok: false,
      status: 401,
      headers: new Map([['x-request-id', 'fake-single-agent-failure']]),
      async text() {
        return JSON.stringify({ error: { message: 'single-agent regression forced failure' } });
      }
    };
  }

  if (combined.includes('single-agent malformed-response')) {
    return {
      ok: true,
      status: 200,
      headers: new Map([['x-request-id', 'fake-single-agent-malformed']]),
      async text() {
        return JSON.stringify({
          output_text: 'I will do this later.',
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 }
        });
      }
    };
  }

  if (combined.includes('single-agent stall-recover')) {
    const count = nextCount('stall-recover');

    if (count === 1) {
      return okResponse({
        message: 'I will do this next.',
        actions: [],
        complete: false
      });
    }
  }

  if (combined.includes('single-agent stall-repeat')) {
    nextCount('stall-repeat');
    return okResponse({
      message: 'I will do this later.',
      actions: [],
      complete: false
    });
  }

  if (combined.includes('single-agent list-loop-recover')) {
    const count = nextCount('list-loop-recover');

    if (count <= 2) {
      return okResponse({
        message: 'Inspecting workspace.',
        actions: [{
          operation: 'listDirectory',
          args: { path: '' }
        }],
        complete: false
      });
    }
  }

  if (combined.includes('single-agent list-loop-repeat')) {
    nextCount('list-loop-repeat');
    return okResponse({
      message: 'Inspecting workspace again.',
      actions: [{
        operation: 'listDirectory',
        args: { path: '' }
      }],
      complete: false
    });
  }

  if (combined.includes('single-agent missing-dir-inspect-create')) {
    const count = nextCount('missing-dir-inspect-create');

    if (count === 1) {
      return okResponse({
        message: 'Checking if target directory exists.',
        actions: [{
          operation: 'listDirectory',
          args: { path: '${MISSING_DIR_PREFIX}' }
        }],
        complete: false
      });
    }

    if (count === 2) {
      return okResponse({
        message: 'Creating the missing directory.',
        actions: [{
          operation: 'createFolder',
          args: { path: '${MISSING_DIR_PREFIX}' }
        }],
        complete: true
      });
    }
  }

  if (combined.includes('single-agent action-limit-repeat')) {
    return okResponse({
      message: 'Creating too many folders repeatedly.',
      actions: Array.from({ length: 12 }, (_, index) => ({
        operation: 'createFolder',
        args: { path: 'action-limit-repeat-${STAMP}-' + String(index + 1).padStart(2, '0') }
      })),
      complete: false
    });
  }

  if (combined.includes('single-agent action-limit')) {
    const count = nextCount('action-limit');
    if (count === 1) {
      return okResponse({
        message: 'Creating too many folders.',
        actions: Array.from({ length: 12 }, (_, index) => ({
          operation: 'createFolder',
          args: { path: '${ACTION_LIMIT_DIR_PREFIX}-' + String(index + 1).padStart(2, '0') }
        })),
        complete: false
      });
    }
    const start = count === 2 ? 1 : 9;
    const end = count === 2 ? 8 : 12;
    return okResponse({
      message: 'Creating bounded batch after correction.',
      actions: Array.from({ length: end - start + 1 }, (_, index) => ({
        operation: 'createFolder',
        args: { path: '${ACTION_LIMIT_DIR_PREFIX}-' + String(start + index).padStart(2, '0') }
      })),
      complete: count !== 2
    });
  }

  if (combined.includes('single-agent operation-limit')) {
    return okResponse({
      message: 'Reading several files.',
      actions: Array.from({ length: 5 }, () => ({
        operation: 'readFile',
        args: { path: '${MAX_STEP_READ_FILE}' }
      })),
      complete: false
    });
  }

  if (combined.includes('single-agent request-limit')) {
    return okResponse({
      message: 'Requesting another step.',
      actions: [{
        operation: 'readFile',
        args: { path: '${MAX_STEP_READ_FILE}' }
      }],
      complete: false
    });
  }

  if (combined.includes('single-agent workspace-error')) {
    return okResponse({
      message: 'Trying to read a missing file.',
      actions: [{
        operation: 'readFile',
        args: { path: 'missing-workspace-error-${STAMP}.txt' }
      }],
      complete: false
    });
  }

  if (combined.includes('single-agent write-creates-parent')) {
    return okResponse({
      message: 'Writing a file and creating its missing parent directory.',
      actions: [{
        operation: 'writeFile',
        args: {
          path: 'missing-parent-${STAMP}/child.txt',
          content: 'written with auto parent'
        }
      }],
      complete: false
    });
  }

  if (combined.includes('single-agent create-missing-parent')) {
    return okResponse({
      message: 'Trying to create a folder inside a missing parent directory.',
      actions: [{
        operation: 'createFolder',
        args: { path: 'missing-folder-parent-${STAMP}/child' }
      }],
      complete: false
    });
  }

  if (combined.includes('single-agent folder-file-conflict')) {
    return okResponse({
      message: 'Trying to create a folder where a file already exists.',
      actions: [{
        operation: 'createFolder',
        args: { path: '${PATH_CONFLICT_FILE}' }
      }],
      complete: false
    });
  }

  if (combined.includes('single-agent path-traversal')) {
    return okResponse({
      message: 'Trying to read outside the mounted workspace.',
      actions: [{
        operation: 'readFile',
        args: { path: '../outside-workspace.txt' }
      }],
      complete: false
    });
  }

  if (combined.includes('single-agent max-steps')) {
    return okResponse({
      message: 'Returning a mixed-phase batch without completing.',
      actions: [
        {
          operation: 'readFile',
          args: { path: '${MAX_STEP_READ_FILE}' }
        },
        {
          operation: 'writeFile',
          args: { path: 'max-step-should-not-write-${STAMP}.txt', content: 'must not be written' }
        }
      ],
      complete: false
    });
  }

  if (combined.includes('single-agent bulk-delete')) {
    const count = nextCount('bulk-delete');
    const start = count === 1 ? 1 : 9;
    const end = count === 1 ? 8 : 12;

    return okResponse({
      message: 'Deleting bounded batch.',
      actions: Array.from({ length: end - start + 1 }, (_, index) => ({
        operation: 'deletePath',
        args: { path: '${BULK_DELETE_DIR_PREFIX}-' + String(start + index).padStart(2, '0') }
      })),
      complete: count !== 1
    });
  }

  if (combined.includes('single-agent bulk-create-12-folders')) {
    const count = nextCount('bulk-create-12-folders');
    const start = count === 1 ? 1 : 9;
    const end = count === 1 ? 8 : 12;

    return okResponse({
      message: 'Creating folders in batches.',
      actions: Array.from({ length: end - start + 1 }, (_, index) => ({
        operation: 'createFolder',
        args: { path: '${BULK_CREATE_DIR_PREFIX}-' + String(start + index).padStart(2, '0') }
      })),
      complete: count !== 1
    });
  }

  if (combined.includes('single-agent bulk-write-12-files')) {
    const count = nextCount('bulk-write-12-files');
    const start = count === 1 ? 1 : 9;
    const end = count === 1 ? 8 : 12;

    return okResponse({
      message: 'Writing files in batches.',
      actions: Array.from({ length: end - start + 1 }, (_, index) => ({
        operation: 'writeFile',
        args: {
          path: '${BULK_WRITE_FILE_PREFIX}-' + String(start + index).padStart(2, '0') + '.txt',
          content: 'bulk-write-' + String(start + index).padStart(2, '0')
        }
      })),
      complete: count !== 1
    });
  }

  if (combined.includes('single-agent noop-complete')) {
    return okResponse({
      message: 'Nothing to change.',
      actions: [],
      complete: true
    });
  }

  if (combined.includes('single-agent protected-overwrite')) {
    return okResponse({
      message: 'Trying to overwrite a protected file.',
      actions: [{
        operation: 'writeFile',
        args: {
          path: '${PROTECTED_TEST_FILE}',
          content: 'agent-overwrite-should-not-happen'
        }
      }],
      complete: true
    });
  }

  if (combined.includes('single-agent manual-stop')) {
    return okResponse({
      message: 'single-agent manual retry complete',
      actions: [{
        operation: 'writeFile',
        args: {
          path: '${MANUAL_RETRY_FILE}',
          content: 'single-agent-manual-retry-ok'
        }
      }],
      complete: true
    });
  }

  if (combined.includes('single-agent complete-write')) {
    return okResponse({
      message: 'single-agent regression complete',
      actions: [{
        operation: 'writeFile',
        args: {
          path: '${TEST_FILE}',
          content: 'single-agent-regression-ok'
        }
      }],
      complete: true
    });
  }

  const genericOutputId = require('crypto').createHash('sha256').update(combined).digest('hex').slice(0, 16);

  return okResponse({
    message: 'single-agent regression complete',
    actions: [{
      operation: 'writeFile',
      args: {
        path: 'single-agent-generic-' + genericOutputId + '.txt',
        content: 'single-agent-regression-ok'
      }
    }],
    complete: true
  });
};
`;

  fs.writeFileSync(preloadPath, source);
  return preloadPath;
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
    throw new Error(`Assigned ticket create failed with HTTP ${response.statusCode}: ${response.body}`);
  }

  const ticket = readJson('tickets.json').find(item => item.objective === objective);
  if (!ticket) throw new Error('Assigned ticket was not persisted');
  return ticket;
}

async function waitForTicketStatus(ticketId, expectedStatus) {
  const started = Date.now();

  while (Date.now() - started < 30000) {
    const ticket = readJson('tickets.json').find(item => item.id === ticketId);
    if (ticket && ticket.status === expectedStatus) return ticket;
    await new Promise(resolve => setTimeout(resolve, 50));
  }

  throw new Error(`Timed out waiting for ticket ${ticketId} to become ${expectedStatus}`);
}

async function waitForRuns(ticketId, expectedCount, predicate) {
  const started = Date.now();

  while (Date.now() - started < 30000) {
    const runs = readJson('runs.json').filter(run => run.ticketId === ticketId);
    const terminalSnapshotsReady = runs.every(run =>
      !['completed', 'failed', 'interrupted'].includes(run.status) ||
      run.replaySnapshot && run.replaySnapshot.terminalStatus === run.status
    );

    if (runs.length >= expectedCount && terminalSnapshotsReady && (!predicate || predicate(runs))) return runs;
    await new Promise(resolve => setTimeout(resolve, 100));
  }

  const runs = readJson('runs.json').filter(run => run.ticketId === ticketId);
  throw new Error(`Timed out waiting for ${expectedCount} runs for ticket ${ticketId}: ${JSON.stringify(runs.map(run => ({
    id: run.id,
    status: run.status,
    error: run.error,
    terminalStatus: run.replaySnapshot && run.replaySnapshot.terminalStatus
  })))}`);
}

async function waitForRunLog(runId, type) {
  const started = Date.now();

  while (Date.now() - started < 30000) {
    const log = readJson('logs.json').find(item => item.runId === runId && item.type === type);
    if (log) return log;
    await new Promise(resolve => setTimeout(resolve, 50));
  }

  throw new Error(`Timed out waiting for ${type} log for run ${runId}`);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function verifyStructuredFailure(run, expected) {
  const failure = run.replaySnapshot && run.replaySnapshot.failure;
  assert(failure, `Replay snapshot missing structured failure for run ${run.id}`);
  assert(failure.code === expected.code, `Run ${run.id} failure code ${failure.code} !== ${expected.code}`);
  assert(failure.kind === expected.kind, `Run ${run.id} failure kind ${failure.kind} !== ${expected.kind}`);
  if (expected.limitType) {
    assert(failure.detail && failure.detail.limitType === expected.limitType, `Run ${run.id} failure detail missing limitType ${expected.limitType}`);
  }
  if (expected.pathIncludes) {
    assert(failure.detail && String(failure.detail.path || '').includes(expected.pathIncludes), `Run ${run.id} failure detail missing path ${expected.pathIncludes}`);
  }
}

function runOquery(args) {
  return execSync(`${OQUERY} ${args}`, {
    cwd: ROOT,
    env: { ...process.env, DATA_DIR },
    timeout: 15000,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe']
  });
}

function verifyOqueryFailureSurface(run, expected) {
  const failuresText = runOquery(`failures --run ${run.id}`);
  assert(failuresText.includes(expected.displayTag), `oquery failures did not show ${expected.displayTag} for run ${run.id}: ${failuresText}`);

  const failuresJsonText = runOquery(`failures --run ${run.id} --json`);
  const failuresJson = JSON.parse(failuresJsonText);
  assert(Array.isArray(failuresJson) && failuresJson.length === 1, `oquery failures JSON did not return one row for run ${run.id}`);
  assert(failuresJson[0].failureType === expected.failureType, `oquery failures JSON type ${failuresJson[0].failureType} !== ${expected.failureType}`);

  const runsText = runOquery(`runs --id ${run.id}`);
  const displayedOutcome = expected.runOutcome === 'failed_execution'
    ? 'failed'
    : expected.runOutcome === 'blocked/rejected'
      ? 'blocked'
      : expected.runOutcome;
  assert(runsText.includes(displayedOutcome), `oquery runs did not show ${displayedOutcome} for run ${run.id}: ${runsText}`);

  const runsJsonText = runOquery(`runs --id ${run.id} --json`);
  const runsJson = JSON.parse(runsJsonText);
  assert(Array.isArray(runsJson) && runsJson.length === 1, `oquery runs JSON did not return one row for run ${run.id}`);
  assert(runsJson[0].operationalOutcome === expected.runOutcome, `oquery runs JSON outcome ${runsJson[0].operationalOutcome} !== ${expected.runOutcome}`);

  const replayText = runOquery(`replay ${run.id}`);
  assert(replayText.includes(`Replay: Run #${run.id}`), `oquery replay did not render run ${run.id}`);
  if (expected.replayIncludes) {
    assert(replayText.includes(expected.replayIncludes), `oquery replay missing ${expected.replayIncludes} for run ${run.id}: ${replayText}`);
  }
}

function verifyRunLogs(ticketId, runs, options = {}) {
  const logs = readJson('logs.json').filter(log => log.ticketId === ticketId);

  runs.forEach(run => {
    const runLogs = logs.filter(log => log.runId === run.id);
    const snapshot = run.replaySnapshot;

    assert(snapshot, `Missing replay snapshot for run ${run.id}`);
    assert(snapshot.runId === run.id, `Replay snapshot has wrong runId for run ${run.id}`);
    assert(snapshot.ticketId === run.ticketId, `Replay snapshot has wrong ticketId for run ${run.id}`);
    assert(snapshot.assignedAgentId === run.agentId, `Replay snapshot has wrong agent id for run ${run.id}`);
    assert(snapshot.agentNameSnapshot === run.agentName, `Replay snapshot has wrong agent name for run ${run.id}`);
    assert(snapshot.model === run.model || typeof snapshot.model === 'string', `Replay snapshot missing model for run ${run.id}`);
    assert(snapshot.runtimeEnvelope && snapshot.runtimeEnvelope.runId === run.id, `Replay snapshot missing runtime envelope for run ${run.id}`);
    assert(snapshot.ticketObjectiveSnapshot, `Replay snapshot missing ticket objective for run ${run.id}`);
    assert(snapshot.systemInstructionSnapshot && snapshot.systemInstructionSnapshot.includes('contained workspace'), `Replay snapshot missing system instructions for run ${run.id}`);
    assert(snapshot.primitiveContract && Array.isArray(snapshot.primitiveContract.allowedOperations), `Replay snapshot missing primitive contract for run ${run.id}`);
    assert(snapshot.workspaceRoot, `Replay snapshot missing workspace root for run ${run.id}`);
    assert(run.executionWorkspaceType === 'main', `Single-agent run ${run.id} should use main workspace execution`);
    assert(run.workspaceRoot === WORKSPACE_ROOT, `Single-agent run ${run.id} has wrong workspace root`);
    assert(run.mainWorkspaceRoot === WORKSPACE_ROOT, `Single-agent run ${run.id} has wrong main workspace root`);
    assert(snapshot.executionWorkspaceType === 'main', `Single-agent replay ${run.id} should use main workspace execution`);
    assert(snapshot.runtimeEnvelope.workspaceRoot === WORKSPACE_ROOT, `Single-agent runtime envelope ${run.id} should point to main workspace`);
    assert(snapshot.runtimeEnvelope.executionWorkspaceType === 'main', `Single-agent runtime envelope ${run.id} should use main workspace type`);
    assert(snapshot.ticketOpenedAt === run.ticketOpenedAt, `Replay snapshot missing ticketOpenedAt for run ${run.id}`);
    assert(Array.isArray(snapshot.providerRequests) && snapshot.providerRequests.length > 0, `Replay snapshot missing provider request for run ${run.id}`);
    assert(Array.isArray(snapshot.modelResponses), `Replay snapshot model responses is not an array for run ${run.id}`);
    if (!options.allowNoModelResponse) {
      assert(snapshot.modelResponses.length > 0, `Replay snapshot missing model response for run ${run.id}`);
    }
    assert(snapshot.terminalStatus === run.status, `Replay snapshot terminal status mismatch for run ${run.id}`);
    assert(JSON.stringify(snapshot).includes('[redacted]'), `Replay snapshot did not redact provider secrets for run ${run.id}`);
    assert(!JSON.stringify(snapshot).includes('test-key-single-agent'), `Replay snapshot exposed agent API key for run ${run.id}`);
    assert(!JSON.stringify(snapshot).includes('Bearer test-key-single-agent'), `Replay snapshot exposed Authorization value for run ${run.id}`);
    assert(snapshot.providerRequests.every(request =>
      request.headers && request.headers.Authorization === '[redacted]'
    ), `Replay snapshot did not redact Authorization header for run ${run.id}`);

    assert(runLogs.length > 0, `Missing logs for run ${run.id}`);
    assert(runLogs.some(log => log.type === 'run:created'), `Missing run:created log for run ${run.id}`);
    assert(runLogs.some(log => log.type === 'run:started'), `Missing run:started log for run ${run.id}`);
    assert(runLogs.some(log => log.type === 'model:request'), `Missing model:request log for run ${run.id}`);
    assert(runLogs.some(log => log.type === 'model:response') || run.status === 'failed', `Missing model:response log for run ${run.id}`);
    assert(
      runLogs.every(log =>
        log.ticketId === run.ticketId &&
        log.agentId === run.agentId &&
        log.agentName === run.agentName
      ),
      `Incorrect run/ticket/agent log identity for run ${run.id}`
    );

    if (options.expectWorkspaceWrite) {
      assert(runLogs.some(log => log.type === 'workspace:write'), `Missing workspace write log for run ${run.id}`);
      assert(
        runLogs.some(log => log.workspaceAction && log.workspaceAction.operation === 'writeFile'),
        `Missing strict writeFile primitive log for run ${run.id}`
      );
      assert(
        snapshot.workspaceOperations.some(item => item.operation && item.operation.operation === 'writeFile' && item.result),
        `Replay snapshot missing writeFile operation result for run ${run.id}`
      );
      assert(
        snapshot.modelResponses.some(item => item.usage && item.usage.total_tokens === 2),
        `Replay snapshot did not preserve provider usage metadata for run ${run.id}`
      );
      assert(
        snapshot.modelResponses.some(item => item.providerResponsePayload && item.providerResponsePayload.requestId === 'fake-single-agent-request'),
        `Replay snapshot did not preserve provider request id for run ${run.id}`
      );
      assert(
        runLogs.some(log => log.type === 'model:response' && log.requestId === 'fake-single-agent-request'),
        `Model response log did not preserve provider request id for run ${run.id}`
      );
    }

    if (options.expectFailure) {
      assert(runLogs.some(log => log.type === 'run:failed'), `Missing run:failed log for run ${run.id}`);
      assert(snapshot.failureReason, `Replay snapshot missing failure reason for run ${run.id}`);
    }

    if (options.expectProviderFailure) {
      verifyStructuredFailure(run, {
        code: options.expectProviderFailure.code,
        kind: 'provider_error'
      });
      assert(snapshot.providerRequests.length > 0, `Provider failure run ${run.id} missing provider request snapshot`);
      if (options.expectProviderFailure.requestId) {
        assert(snapshot.modelResponses.some(item =>
          item.providerResponsePayload &&
          item.providerResponsePayload.requestId === options.expectProviderFailure.requestId
        ), `Provider failure run ${run.id} missing provider request id ${options.expectProviderFailure.requestId}`);
      }
    }

    if (options.expectStalled) {
      assert(runLogs.some(log => log.type === 'model:stalled'), `Missing model:stalled log for run ${run.id}`);
      assert(snapshot.events.some(event => event.type === 'model:stalled'), `Replay snapshot missing stalled event for run ${run.id}`);
    }

    if (options.expectNoProgress) {
      assert(runLogs.some(log => log.type === 'model:no_progress'), `Missing model:no_progress log for run ${run.id}`);
      assert(snapshot.events.some(event => event.type === 'model:no_progress'), `Replay snapshot missing no-progress event for run ${run.id}`);
    }

    if (options.expectMaxStepFailure) {
      assert(snapshot.events.some(event => event.type === 'run:step_limit'), `Replay snapshot missing step-limit event for run ${run.id}`);
    }

    if (options.expectStructuredRunLimitFailure) {
      verifyStructuredFailure(run, {
        code: 'RUN_LIMIT_EXCEEDED',
        kind: 'budget_exhausted',
        limitType: 'step'
      });
    }

    if (options.expectOperationLimit) {
      assert(runLogs.some(log => log.type === 'run:operation_limit'), `Missing run:operation_limit log for run ${run.id}`);
      assert(snapshot.events.some(event =>
        event.type === 'run:operation_limit' &&
        event.limitType === 'operation' &&
        typeof event.currentValue === 'number' &&
        typeof event.configuredLimit === 'number'
      ), `Replay snapshot missing operation-limit event for run ${run.id}`);
    }

    if (options.expectModelRequestLimit) {
      assert(runLogs.some(log => log.type === 'run:model_request_limit'), `Missing run:model_request_limit log for run ${run.id}`);
      assert(snapshot.events.some(event =>
        event.type === 'run:model_request_limit' &&
        event.limitType === 'model_request' &&
        typeof event.currentValue === 'number' &&
        typeof event.configuredLimit === 'number'
      ), `Replay snapshot missing model-request-limit event for run ${run.id}`);
    }

    if (options.expectActionLimit) {
      assert(runLogs.some(log => log.type === 'model:action_limit'), `Missing model:action_limit log for run ${run.id}`);
      assert(snapshot.events.some(event =>
        event.type === 'model:action_limit' &&
        event.actionCount === 12 &&
        event.maxActionsPerResponse === 8
      ), `Replay snapshot missing action-limit event for run ${run.id}`);
      assert(
        snapshot.workspaceOperations.length === 0,
        `Replay snapshot captured workspace operations after rejecting oversized batch for run ${run.id}`
      );
      assert(!runLogs.some(log => log.type.startsWith('workspace:')), `Oversized batch partially executed workspace actions for run ${run.id}`);
    }

    if (options.expectActionLimitRecover) {
      assert(runLogs.some(log => log.type === 'model:action_limit'), `Missing model:action_limit log for run ${run.id}`);
      assert(snapshot.events.some(event =>
        event.type === 'model:action_limit' &&
        event.actionCount === 12 &&
        event.maxActionsPerResponse === 8
      ), `Replay snapshot missing action-limit recover event for run ${run.id}`);
    }

    if (options.expectNoopCompletion) {
      assert(runLogs.some(log => log.type === 'run:completed_noop'), `Missing run:completed_noop log for run ${run.id}`);
      assert(snapshot.events.some(event => event.type === 'run:completed_noop'), `Replay snapshot missing no-op completion event for run ${run.id}`);
      assert(snapshot.workspaceOperations.length === 0, `No-op completion captured unexpected workspace operations for run ${run.id}`);
    }

    if (options.expectWorkspaceError) {
      assert(runLogs.some(log => log.type === 'run:failed'), `Missing run:failed log for workspace error run ${run.id}`);
      assert(snapshot.workspaceOperations.some(item =>
        item.operation &&
        item.operation.operation === 'readFile' &&
        item.error
      ), `Replay snapshot missing workspace operation error for run ${run.id}`);
    }

    if (options.expectRecoverableEnoentExhaustion) {
      const failedRead = snapshot.workspaceOperations.find(item =>
        item.operation &&
        item.operation.operation === 'readFile' &&
        item.error
      );
      assert(failedRead && failedRead.operation.args.path === `missing-workspace-error-${STAMP}.txt`, `Replay snapshot missing ENOENT read path for run ${run.id}`);
      assert(failedRead.error.includes('ENOENT'), `Replay snapshot missing ENOENT read error for run ${run.id}`);
      verifyStructuredFailure(run, {
        code: 'RUN_LIMIT_EXCEEDED',
        kind: 'no_progress'
      });
    }

    if (options.expectRecoverableCreateMissingParentExhaustion) {
      assert(snapshot.workspaceOperations.some(item =>
        item.operation &&
        item.operation.operation === 'createFolder' &&
        item.error &&
        item.error.includes('ENOENT') &&
        item.historyId
      ), `Replay snapshot missing createFolder missing-parent operation for run ${run.id}`);
      verifyStructuredFailure(run, {
        code: 'RUN_LIMIT_EXCEEDED',
        kind: 'budget_exhausted'
      });
    }

    if (options.expectRecoverablePathConflictExhaustion) {
      assert(snapshot.workspaceOperations.some(item =>
        item.operation &&
        item.operation.operation === 'createFolder' &&
        item.operation.args.path === PATH_CONFLICT_FILE &&
        item.error === 'Path already exists and is not a directory' &&
        item.historyId
      ), `Replay snapshot missing createFolder path conflict operation for run ${run.id}`);
      verifyStructuredFailure(run, {
        code: 'RUN_LIMIT_EXCEEDED',
        kind: 'budget_exhausted'
      });
    }

    if (options.expectPathTraversalBlocked) {
      assert(snapshot.workspaceOperations.some(item =>
        item.operation &&
        item.operation.operation === 'readFile' &&
        item.blocked === true &&
        item.error === 'Path traversal is not allowed'
      ), `Replay snapshot missing blocked path traversal operation for run ${run.id}`);
      verifyStructuredFailure(run, {
        code: 'WORKSPACE_PATH_TRAVERSAL',
        kind: 'protected_path',
        pathIncludes: '../outside-workspace.txt'
      });
    }

    if (options.expectProtectedBlocked) {
      assert(snapshot.authorityChecks.some(check =>
        check.status === 'denied' &&
        check.rule === 'protected_path' &&
        check.operation === 'writeFile' &&
        check.path === PROTECTED_TEST_FILE
      ), `Replay snapshot missing protected-path authority denial for run ${run.id}`);
      assert(snapshot.workspaceOperations.some(item =>
        item.operation &&
        item.operation.operation === 'writeFile' &&
        item.blocked === true &&
        item.reason
      ), `Replay snapshot missing protected path blocked operation for run ${run.id}`);
      assert(snapshot.failureReason && snapshot.failureReason.includes('Blocked protected workspace path mutation'), `Protected path failure reason was not persisted for run ${run.id}`);
      verifyStructuredFailure(run, {
        code: 'WORKSPACE_PROTECTED_PATH',
        kind: 'protected_path',
        pathIncludes: PROTECTED_TEST_FILE
      });
    }

    if (options.expectMalformedResponse) {
      assert(runLogs.some(log => log.type === 'model:malformed'), `Missing model:malformed log for run ${run.id}`);
      assert(snapshot.events.some(event =>
        event.type === 'model:malformed' &&
        event.rawText === 'I will do this later.' &&
        event.parseError
      ), `Replay snapshot missing malformed response event for run ${run.id}`);
      assert(snapshot.modelResponses.some(item =>
        item.text === 'I will do this later.' &&
        item.providerResponsePayload &&
        item.providerResponsePayload.body &&
        item.providerResponsePayload.body.output_text === 'I will do this later.'
      ), `Replay snapshot missing raw malformed provider response for run ${run.id}`);
      verifyStructuredFailure(run, {
        code: 'MODEL_MALFORMED_JSON',
        kind: 'invalid_action'
      });
    }

    if (options.expectBulkDelete) {
      const deleteLogs = runLogs.filter(log => log.type === 'workspace:delete');
      const deleteSnapshots = snapshot.workspaceOperations.filter(item =>
        item.operation &&
        item.operation.operation === 'deletePath' &&
        item.result
      );

      assert(deleteLogs.length === 12, `Expected 12 workspace delete logs for run ${run.id}, found ${deleteLogs.length}`);
      assert(deleteSnapshots.length === 12, `Expected 12 replay delete results for run ${run.id}, found ${deleteSnapshots.length}`);
      assert(!runLogs.some(log => log.type === 'model:no_progress'), `Bulk delete run was incorrectly flagged no-progress for run ${run.id}`);
      assert(!snapshot.events.some(event => event.type === 'model:no_progress'), `Bulk delete replay was incorrectly flagged no-progress for run ${run.id}`);
    }

    if (options.expectBulkCreate) {
      const createLogs = runLogs.filter(log => log.type === 'workspace:create');
      const createSnapshots = snapshot.workspaceOperations.filter(item =>
        item.operation &&
        item.operation.operation === 'createFolder' &&
        item.result
      );

      assert(createLogs.length === 12, `Expected 12 workspace create logs for run ${run.id}, found ${createLogs.length}`);
      assert(createSnapshots.length === 12, `Expected 12 replay create results for run ${run.id}, found ${createSnapshots.length}`);
      assert(!runLogs.some(log => log.type === 'model:no_progress'), `Bulk create run was incorrectly flagged no-progress for run ${run.id}`);
      assert(!snapshot.events.some(event => event.type === 'model:no_progress'), `Bulk create replay was incorrectly flagged no-progress for run ${run.id}`);
    }

    if (options.expectBulkWrite) {
      const writeLogs = runLogs.filter(log => log.type === 'workspace:write');
      const writeSnapshots = snapshot.workspaceOperations.filter(item =>
        item.operation &&
        item.operation.operation === 'writeFile' &&
        item.result
      );

      assert(writeLogs.length === 12, `Expected 12 workspace write logs for run ${run.id}, found ${writeLogs.length}`);
      assert(writeSnapshots.length === 12, `Expected 12 replay write results for run ${run.id}, found ${writeSnapshots.length}`);
      assert(!runLogs.some(log => log.type === 'model:no_progress'), `Bulk write run was incorrectly flagged no-progress for run ${run.id}`);
      assert(!snapshot.events.some(event => event.type === 'model:no_progress'), `Bulk write replay was incorrectly flagged no-progress for run ${run.id}`);
    }
  });
}

async function verifyDuplicateActiveBlocking(cookie, agent) {
  const duplicateTicketId = Math.max(0, ...readJson('tickets.json').map(ticket => ticket.id)) + 1;
  const openedAt = new Date().toISOString();

  writeJson('tickets.json', [
    ...readJson('tickets.json'),
    {
      id: duplicateTicketId,
      objective: `single-agent duplicate-active ${STAMP}`,
      assignmentTargetType: 'agent',
      assignmentTargetId: agent.id,
      assignmentMode: 'individual',
      status: 'closed',
      createdBy: 'admin',
      createdAt: openedAt,
      updatedAt: openedAt
    }
  ]);

  const nextRunId = Math.max(0, ...readJson('runs.json').map(run => run.id)) + 1;
  writeJson('runs.json', [
    ...readJson('runs.json'),
    {
      id: nextRunId,
      ticketId: duplicateTicketId,
      agentId: agent.id,
      agentName: agent.name,
      workspaceRoot: WORKSPACE_ROOT,
      mainWorkspaceRoot: WORKSPACE_ROOT,
      executionWorkspaceType: 'main',
      status: 'pending',
      ticketOpenedAt: openedAt,
      createdAt: openedAt,
      updatedAt: openedAt
    }
  ]);

  const reopen = await request('PATCH', `/api/tickets/${duplicateTicketId}/status`, {
    cookie,
    body: { status: 'open' }
  });
  assert(reopen.statusCode === 200, `Duplicate active reopen failed with HTTP ${reopen.statusCode}`);

  await new Promise(resolve => setTimeout(resolve, 300));
  const duplicateRuns = readJson('runs.json').filter(run => run.ticketId === duplicateTicketId);
  assert(duplicateRuns.length === 1, 'Duplicate active single-agent run was created');
}

async function verifyRunDetailPage(cookie, run) {
  const response = await request('GET', `/runs/${run.id}`, { cookie });

  assert(response.statusCode === 200, `/runs/${run.id} returned HTTP ${response.statusCode}`);
  assert(response.body.includes(`Run #${run.id}`), 'Run detail page missing run heading');
  assert(response.body.includes('Technical Runtime Details'), 'Run detail page missing runtime details section');
  assert(response.body.includes('Provider Requests'), 'Run detail page missing provider requests section');
  assert(response.body.includes('Workspace Actions'), 'Run detail page missing workspace actions section');
  assert(!response.body.includes('test-key-single-agent'), 'Run detail page exposed agent API key');
  assert(!response.body.includes('Bearer test-key-single-agent'), 'Run detail page exposed Authorization value');
}

async function verifyFilteredLogNavigation(cookie, run) {
  const runLogsResponse = await request('GET', `/api/logs?runId=${run.id}`, { cookie });
  assert(runLogsResponse.statusCode === 200, `Filtered run logs returned HTTP ${runLogsResponse.statusCode}`);
  const runLogs = JSON.parse(runLogsResponse.body).logs;
  assert(runLogs.length > 0, 'Filtered run logs returned no logs');
  assert(runLogs.every(log => log.runId === run.id), 'Filtered run logs included another run');

  const ticketLogsResponse = await request('GET', `/api/logs?ticketId=${run.ticketId}`, { cookie });
  assert(ticketLogsResponse.statusCode === 200, `Filtered ticket logs returned HTTP ${ticketLogsResponse.statusCode}`);
  const ticketLogs = JSON.parse(ticketLogsResponse.body).logs;
  assert(ticketLogs.length > 0, 'Filtered ticket logs returned no logs');
  assert(ticketLogs.every(log => log.ticketId === run.ticketId), 'Filtered ticket logs included another ticket');

  const runLogsPage = await request('GET', `/logs?runId=${run.id}`, { cookie });
  assert(runLogsPage.statusCode === 200, `Filtered run logs page returned HTTP ${runLogsPage.statusCode}`);
  assert(runLogsPage.body.includes(`Showing logs for`) && runLogsPage.body.includes(`Run #${run.id}`), 'Filtered run logs page missing filter banner');

  const runDetailPage = await request('GET', `/runs/${run.id}`, { cookie });
  assert(runDetailPage.body.includes(`/logs?runId=${run.id}`), 'Run detail page does not link to filtered run logs');

  const ticketDetailPage = await request('GET', `/tickets/${run.ticketId}`, { cookie });
  assert(ticketDetailPage.body.includes(`/logs?ticketId=${run.ticketId}`), 'Ticket detail page does not link to filtered ticket logs');
}

async function verifyStartupInterruptedRun(cookie, staleRunId, staleTicketId) {
  const runs = readJson('runs.json');
  const run = runs.find(item => item.id === staleRunId);
  const logs = readJson('logs.json').filter(log => log.runId === staleRunId);
  const ticket = readJson('tickets.json').find(item => item.id === staleTicketId);

  assert(run, 'Seeded stale run is missing');
  assert(run.status === 'interrupted', 'Stale run was not marked interrupted on startup');
  assert(run.completedAt, 'Interrupted run missing completedAt');
  assert(run.updatedAt, 'Interrupted run missing updatedAt');
  assert(run.error === 'process restarted before run completed', 'Interrupted run missing reason');
  assert(ticket && ticket.status === 'open', 'Interrupted stale run did not reopen in-progress ticket');
  assert(logs.some(log =>
    log.type === 'run:interrupted' &&
    log.message === 'process restarted before run completed'
  ), 'Interrupted run missing run:interrupted log');
  assert(run.replaySnapshot, 'Interrupted run missing replay snapshot');
  assert(run.replaySnapshot.terminalStatus === 'interrupted', 'Interrupted replay snapshot terminal status mismatch');
  assert(run.replaySnapshot.failureReason === 'process restarted before run completed', 'Interrupted replay snapshot missing reason');
  assert(run.replaySnapshot.events.some(event => event.type === 'run:interrupted'), 'Interrupted replay snapshot missing event');

  const agentsPage = await request('GET', '/agents', { cookie });
  assert(agentsPage.statusCode === 200, `/agents returned HTTP ${agentsPage.statusCode}`);

  return run;
}

async function verifyStartupProviderCallInterruptedRun(cookie, staleRunId, staleTicketId) {
  const runs = readJson('runs.json');
  const run = runs.find(item => item.id === staleRunId);
  const logs = readJson('logs.json').filter(log => log.runId === staleRunId);
  const ticket = readJson('tickets.json').find(item => item.id === staleTicketId);

  assert(run, 'Seeded stale provider-call run is missing');
  assert(run.status === 'interrupted', 'Stale provider-call run was not marked interrupted on startup');
  assert(run.error === 'process restarted before run completed', 'Stale provider-call run missing restart reason');
  assert(ticket && ticket.status === 'open', 'Interrupted stale provider-call ticket did not reopen');
  assert(run.replaySnapshot.providerRequests.length === 1, 'Stale provider-call run did not preserve provider request payload');
  assert(run.replaySnapshot.modelResponses.length === 0, 'Stale provider-call run unexpectedly gained a provider response');
  assert(run.replaySnapshot.failure && run.replaySnapshot.failure.detail && run.replaySnapshot.failure.detail.phase === 'during_provider_call', 'Stale provider-call run missing during-provider interruption phase');
  assert(run.replaySnapshot.events.some(event => event.type === 'run:interrupted' && event.phase === 'during_provider_call'), 'Stale provider-call replay event missing phase');
  assert(logs.some(log => log.type === 'run:interrupted' && log.phase === 'during_provider_call'), 'Stale provider-call log missing interruption phase');

  return run;
}

async function verifyManualStopAndRetry(cookie, agent) {
  const seeded = seedManualStopRun(agent);
  const stopResponse = await request('POST', `/api/runs/${seeded.run.id}/stop`, { cookie });

  assert(stopResponse.statusCode === 200, `Manual stop failed with HTTP ${stopResponse.statusCode}`);

  const stoppedRun = readJson('runs.json').find(run => run.id === seeded.run.id);
  const stoppedTicket = readJson('tickets.json').find(ticket => ticket.id === seeded.ticket.id);
  const stopLogs = readJson('logs.json').filter(log => log.runId === seeded.run.id);

  assert(stoppedRun.status === 'interrupted', 'Manual stop did not mark run interrupted');
  assert(stoppedRun.error === 'manually stopped', 'Manual stop did not persist reason');
  assert(stoppedTicket.status === 'open', 'Manual stop did not reopen ticket');
  assert(stopLogs.some(log => log.type === 'run:interrupted' && log.message === 'manually stopped'), 'Manual stop did not log run:interrupted');
  assert(stoppedRun.replaySnapshot.terminalStatus === 'interrupted', 'Manual stop replay snapshot terminal status mismatch');
  assert(stoppedRun.replaySnapshot.failureReason === 'manually stopped', 'Manual stop replay snapshot missing reason');
  assert(stoppedRun.replaySnapshot.failure && stoppedRun.replaySnapshot.failure.detail && stoppedRun.replaySnapshot.failure.detail.phase === 'before_provider_call', 'Manual stop before provider call missing interruption phase');
  assert(stoppedRun.replaySnapshot.events.some(event => event.type === 'run:interrupted' && event.phase === 'before_provider_call'), 'Manual stop replay event missing before-provider phase');
  assert(stopLogs.some(log => log.type === 'run:interrupted' && log.phase === 'before_provider_call'), 'Manual stop log missing before-provider phase');

  const retryResponse = await request('POST', `/api/runs/${seeded.run.id}/retry`, { cookie });
  assert(retryResponse.statusCode === 200, `Manual retry failed with HTTP ${retryResponse.statusCode}`);
  await waitForTicketStatus(seeded.ticket.id, 'in_progress');
  const retryRuns = await waitForRuns(
    seeded.ticket.id,
    2,
    runs => runs.some(run => run.status === 'interrupted') && runs.some(run => run.status === 'completed')
  );
  const retriedTicket = await waitForTicketStatus(seeded.ticket.id, 'completed');
  const freshRun = retryRuns.find(run => run.status === 'completed');

  assert(retriedTicket.status === 'completed', 'Manual retry did not complete ticket');
  assert(freshRun.id !== seeded.run.id, 'Manual retry reused interrupted run');
  verifyRunLogs(seeded.ticket.id, [freshRun], { expectWorkspaceWrite: true });

  return { stoppedRun, freshRun };
}

async function verifyManualStopDuringProviderCall(cookie, agent) {
  const ticket = await createAssignedTicket(cookie, agent.id, `single-agent slow-provider ${STAMP}`);
  await waitForTicketStatus(ticket.id, 'in_progress');
  const [run] = await waitForRuns(ticket.id, 1, runs => runs.some(item => ['pending', 'running'].includes(item.status)));
  await waitForRunLog(run.id, 'model:request');

  const stopResponse = await request('POST', `/api/runs/${run.id}/stop`, { cookie });
  assert(stopResponse.statusCode === 200, `Manual stop during provider call failed with HTTP ${stopResponse.statusCode}`);
  const stoppedBeforeResponse = readJson('runs.json').find(item => item.id === run.id);
  assert(stoppedBeforeResponse.replaySnapshot.providerRequests.length > 0, 'Provider-race interrupted run did not preserve provider request before response arrived');
  assert(stoppedBeforeResponse.replaySnapshot.modelResponses.length === 0, 'Provider-race interrupted run recorded provider response before delayed response arrived');

  await waitForRuns(ticket.id, 1, runs => runs.every(item => item.status === 'interrupted'));
  await new Promise(resolve => setTimeout(resolve, 1200));
  const stoppedRun = readJson('runs.json').find(item => item.id === run.id);
  const stopLogs = readJson('logs.json').filter(log => log.runId === run.id);

  assert(stoppedRun.status === 'interrupted', 'Provider-race manual stop did not remain interrupted');
  assert(stoppedRun.replaySnapshot.terminalStatus === 'interrupted', 'Provider-race manual stop terminal status mismatch');
  assert(stoppedRun.replaySnapshot.failure && stoppedRun.replaySnapshot.failure.detail && stoppedRun.replaySnapshot.failure.detail.phase === 'during_provider_call', 'Provider-race manual stop missing interruption phase');
  assert(stoppedRun.replaySnapshot.events.some(event => event.type === 'run:interrupted' && event.phase === 'during_provider_call'), 'Provider-race replay event missing during-provider phase');
  assert(stopLogs.some(log => log.type === 'run:interrupted' && log.phase === 'during_provider_call'), 'Provider-race stop log missing during-provider phase');
  assert(stoppedRun.replaySnapshot.providerRequests.length > 0, 'Provider-race interrupted run did not preserve provider request after response arrived');
  assert(stoppedRun.replaySnapshot.modelResponses.length > 0, 'Provider-race interrupted run did not preserve provider response after response arrived');
  assert(stoppedRun.replaySnapshot.workspaceOperations.length === 0, 'Provider-race interrupted run executed workspace operations after stop');

  return stoppedRun;
}

async function main() {
  const agent = seedAgent();
  const stale = seedStaleRunningRun(agent);
  const staleProviderCall = seedStaleProviderCallRun(agent);
  const preloadPath = createFakeOpenAIPreload();
  let server = null;

  try {
    fs.writeFileSync(path.join(WORKSPACE_ROOT, MAX_STEP_READ_FILE), 'max step fixture\n');
    fs.writeFileSync(path.join(WORKSPACE_ROOT, PATH_CONFLICT_FILE), 'path conflict fixture\n');
    for (let index = 1; index <= 12; index += 1) {
      fs.mkdirSync(path.join(WORKSPACE_ROOT, `${BULK_DELETE_DIR_PREFIX}-${String(index).padStart(2, '0')}`), {
        recursive: true
      });
    }

    server = spawn(process.execPath, ['server.js'], {
      cwd: ROOT,
      env: {
        ...process.env,
        NODE_ENV: 'test',
        PORT,
        NODE_OPTIONS: `--require ${preloadPath}`,
        WORKSPACE_ROOT,
        DATA_DIR,
        AGENT_MAX_MUTATING_ACTIONS_PER_RESPONSE: '8'
      },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    server.stdout.on('data', chunk => process.stdout.write(String(chunk)));
    server.stderr.on('data', chunk => process.stderr.write(String(chunk)));

    await waitForReady();
    const cookie = await login();
    const interruptedRun = await verifyStartupInterruptedRun(cookie, stale.run.id, stale.ticket.id);
    const providerCallInterruptedRun = await verifyStartupProviderCallInterruptedRun(cookie, staleProviderCall.run.id, staleProviderCall.ticket.id);
    const manualControlRuns = await verifyManualStopAndRetry(cookie, agent);
    const providerRaceStopRun = await verifyManualStopDuringProviderCall(cookie, agent);

    const completeTicket = await createAssignedTicket(cookie, agent.id, `single-agent complete-write ${STAMP}`);
    await waitForTicketStatus(completeTicket.id, 'in_progress');
    const completeRuns = await waitForRuns(
      completeTicket.id,
      1,
      runs => runs.every(run => run.status === 'completed')
    );
    const completedTicket = await waitForTicketStatus(completeTicket.id, 'completed');
    assert(completedTicket.status === 'completed', 'Single-agent ticket did not complete');
    assert(completeRuns.length === 1, 'Single-agent ticket did not create exactly one run');
    assert(completeRuns[0].agentId === agent.id, 'Single-agent run used the wrong agent');
    const rawCompleteRun = readRawJson('runs.json').find(run => run.id === completeRuns[0].id);
    assert(rawCompleteRun && !rawCompleteRun.replaySnapshot, 'runs.json should not store inline replaySnapshot for new runs');
    assert(rawCompleteRun.replaySnapshotPath === `replay-snapshots/run-${completeRuns[0].id}.json`, 'Run metadata should point at replay snapshot file');
    assert(rawCompleteRun.replaySummary && rawCompleteRun.replaySummary.terminalStatus === 'completed', 'Run metadata should include replay summary');
    assert(fs.existsSync(path.join(DATA_DIR, rawCompleteRun.replaySnapshotPath)), 'Replay snapshot file should exist for new run');
    verifyRunLogs(completeTicket.id, completeRuns, { expectWorkspaceWrite: true });
    await verifyRunDetailPage(cookie, completeRuns[0]);
    await verifyFilteredLogNavigation(cookie, completeRuns[0]);
    assert(fs.existsSync(path.join(WORKSPACE_ROOT, TEST_FILE)), 'Expected workspace file was not created');

    const completeOpHistory = readJson('operation-history.json').filter(h => h.runId === completeRuns[0].id);
    assert(completeOpHistory.length > 0, 'Missing operation history for complete write run');
    const writeOp = completeOpHistory.find(h => h.operation === 'writeFile');
    assert(writeOp, 'Missing writeFile operation history');
    assert(writeOp.preState, 'writeFile preState should be captured');
    assert(writeOp.postState && writeOp.postState.existed === true && writeOp.postState.type === 'file', 'writeFile postState should show file');
    assert(typeof writeOp.postState.contentHash === 'string' && writeOp.postState.contentHash.length === 64, 'writeFile postState should have SHA-256 content hash');
    const replayOp = completeRuns[0].replaySnapshot.workspaceOperations.find(op => op.operation && op.operation.operation === 'writeFile');
    assert(replayOp && replayOp.historyId === writeOp.id, `Replay workspace operation should reference historyId ${writeOp.id}, got ${replayOp?.historyId}`);

    const reopen = await request('PATCH', `/api/tickets/${completeTicket.id}/status`, {
      cookie,
      body: { status: 'open' }
    });
    assert(reopen.statusCode === 200, `Single-agent rerun reopen failed with HTTP ${reopen.statusCode}`);
    await waitForTicketStatus(completeTicket.id, 'in_progress');
    const rerunRuns = await waitForRuns(
      completeTicket.id,
      2,
      runs => runs.length === 2 && runs.every(run => run.status === 'completed')
    );
    assert(new Set(rerunRuns.map(run => run.ticketOpenedAt)).size === 2, 'Single-agent rerun did not create a fresh batch marker');
    verifyRunLogs(completeTicket.id, rerunRuns, { expectWorkspaceWrite: true });

    const rerunOpHistory = readJson('operation-history.json').filter(h => h.runId === rerunRuns[1].id);
    assert(rerunOpHistory.length > 0, 'Missing operation history for rerun');
    assert(rerunOpHistory.every(h => h.runId === rerunRuns[1].id), 'Rerun operation history should belong to rerun run');
    assert(!rerunOpHistory.some(h => h.runId === completeRuns[0].id), 'Rerun operation history should not include original run records');

    const apiRerun = await request('POST', `/api/tickets/${completeTicket.id}/rerun`, { cookie });
    assert(apiRerun.statusCode === 200, `Ticket rerun control failed with HTTP ${apiRerun.statusCode}`);
    await waitForTicketStatus(completeTicket.id, 'in_progress');
    const ticketControlRerunRuns = await waitForRuns(
      completeTicket.id,
      3,
      runs => runs.length === 3 && runs.every(run => run.status === 'completed')
    );
    const ticketControlRerun = await waitForTicketStatus(completeTicket.id, 'completed');
    assert(ticketControlRerun.status === 'completed', 'Ticket rerun control did not complete ticket');
    assert(new Set(ticketControlRerunRuns.map(run => run.ticketOpenedAt)).size === 3, 'Ticket rerun control did not create a fresh batch marker');

    const failTicket = await createAssignedTicket(cookie, agent.id, `single-agent fail-one ${STAMP}`);
    await waitForTicketStatus(failTicket.id, 'in_progress');
    const failedRuns = await waitForRuns(
      failTicket.id,
      1,
      runs => runs.every(run => run.status === 'failed')
    );
    const failedTicket = await waitForTicketStatus(failTicket.id, 'failed');
    assert(failedTicket.status === 'failed', 'Single-agent ticket did not fail when OpenAI failed');
    verifyRunLogs(failTicket.id, failedRuns, {
      expectFailure: true,
      expectProviderFailure: { code: 'OPENAI_HTTP_ERROR', requestId: 'fake-single-agent-failure' }
    });
    verifyOqueryFailureSurface(failedRuns[0], {
      displayTag: 'PROVIDER',
      failureType: 'provider_error',
      runOutcome: 'failed_execution'
    });

    const transportFailureTicket = await createAssignedTicket(cookie, agent.id, `single-agent transport-failure ${STAMP}`);
    await waitForTicketStatus(transportFailureTicket.id, 'in_progress');
    const transportFailureRuns = await waitForRuns(
      transportFailureTicket.id,
      1,
      runs => runs.every(run => run.status === 'failed')
    );
    const transportFailureTicketAfterRun = await waitForTicketStatus(transportFailureTicket.id, 'failed');
    assert(transportFailureTicketAfterRun.status === 'failed', 'Single-agent ticket did not fail when provider transport failed');
    verifyRunLogs(transportFailureTicket.id, transportFailureRuns, {
      expectFailure: true,
      expectProviderFailure: { code: 'OPENAI_TRANSPORT_ERROR' },
      allowNoModelResponse: true
    });
    assert(
      transportFailureRuns[0].replaySnapshot.modelResponses.length === 0,
      'Transport failure before provider response should not create a model response snapshot'
    );
    verifyOqueryFailureSurface(transportFailureRuns[0], {
      displayTag: 'PROVIDER',
      failureType: 'provider_error',
      runOutcome: 'failed_execution'
    });

    const recoveredTicket = await createAssignedTicket(cookie, agent.id, `single-agent stall-recover ${STAMP}`);
    await waitForTicketStatus(recoveredTicket.id, 'in_progress');
    const recoveredRuns = await waitForRuns(
      recoveredTicket.id,
      1,
      runs => runs.every(run => run.status === 'completed')
    );
    const recoveredTicketAfterRun = await waitForTicketStatus(recoveredTicket.id, 'completed');
    assert(recoveredTicketAfterRun.status === 'completed', 'Single-agent stalled recovery ticket did not complete');
    verifyRunLogs(recoveredTicket.id, recoveredRuns, { expectWorkspaceWrite: true, expectStalled: true });

    const stalledTicket = await createAssignedTicket(cookie, agent.id, `single-agent stall-repeat ${STAMP}`);
    await waitForTicketStatus(stalledTicket.id, 'in_progress');
    const stalledRuns = await waitForRuns(
      stalledTicket.id,
      1,
      runs => runs.every(run => run.status === 'failed')
    );
    const stalledTicketAfterRun = await waitForTicketStatus(stalledTicket.id, 'failed');
    assert(stalledTicketAfterRun.status === 'failed', 'Repeated stalled ticket did not fail');
    verifyRunLogs(stalledTicket.id, stalledRuns, { expectFailure: true, expectStalled: true, expectMaxStepFailure: true });

    const listRecoveredTicket = await createAssignedTicket(cookie, agent.id, `single-agent list-loop-recover ${STAMP}`);
    await waitForTicketStatus(listRecoveredTicket.id, 'in_progress');
    const listRecoveredRuns = await waitForRuns(
      listRecoveredTicket.id,
      1,
      runs => runs.every(run => run.status === 'completed')
    );
    const listRecoveredTicketAfterRun = await waitForTicketStatus(listRecoveredTicket.id, 'completed');
    assert(listRecoveredTicketAfterRun.status === 'completed', 'List-only recovery ticket did not complete');
    verifyRunLogs(listRecoveredTicket.id, listRecoveredRuns, { expectWorkspaceWrite: true, expectNoProgress: true });

    const listLoopTicket = await createAssignedTicket(cookie, agent.id, `single-agent list-loop-repeat ${STAMP}`);
    await waitForTicketStatus(listLoopTicket.id, 'in_progress');
    const listLoopRuns = await waitForRuns(
      listLoopTicket.id,
      1,
      runs => runs.every(run => run.status === 'failed')
    );
    const listLoopTicketAfterRun = await waitForTicketStatus(listLoopTicket.id, 'failed');
    assert(listLoopTicketAfterRun.status === 'failed', 'Repeated list-only ticket did not fail');
    verifyRunLogs(listLoopTicket.id, listLoopRuns, { expectFailure: true, expectNoProgress: true, expectMaxStepFailure: true });

    const missingDirTicket = await createAssignedTicket(cookie, agent.id, `single-agent missing-dir-inspect-create ${STAMP}`);
    await waitForTicketStatus(missingDirTicket.id, 'in_progress');
    const missingDirRuns = await waitForRuns(
      missingDirTicket.id,
      1,
      runs => runs.every(run => run.status === 'completed')
    );
    const missingDirTicketAfterRun = await waitForTicketStatus(missingDirTicket.id, 'completed');
    assert(missingDirTicketAfterRun.status === 'completed', 'Missing-dir inspect-create ticket did not complete');
    verifyRunLogs(missingDirTicket.id, missingDirRuns);
    const missingDirLogs = readJson('logs.json').filter(log => log.runId === missingDirRuns[0].id);
    assert(
      missingDirLogs.some(log => log.type === 'workspace:list' && log.workspaceAction && log.workspaceAction.status === 'not_found'),
      'Missing workspace:list not_found log'
    );
    assert(
      missingDirLogs.some(log => log.type === 'workspace:create' && log.workspaceAction && log.workspaceAction.operation === 'createFolder'),
      'Missing workspace:create createFolder log'
    );
    assert(
      missingDirRuns[0].replaySnapshot.workspaceOperations.some(
        op => op.operation && op.operation.operation === 'listDirectory' && op.result && op.result.status === 'not_found'
      ),
      'Replay snapshot missing listDirectory not_found result'
    );
    assert(
      missingDirRuns[0].replaySnapshot.workspaceOperations.some(
        op => op.operation && op.operation.operation === 'createFolder' && op.result
      ),
      'Replay snapshot missing createFolder operation result'
    );
    const missingDirPath = path.join(WORKSPACE_ROOT, MISSING_DIR_PREFIX);
    assert(fs.existsSync(missingDirPath) && fs.lstatSync(missingDirPath).isDirectory(), `Missing-dir inspect-create did not create directory: ${missingDirPath}`);

    const actionLimitTicket = await createAssignedTicket(cookie, agent.id, `single-agent action-limit ${STAMP}`);
    await waitForTicketStatus(actionLimitTicket.id, 'in_progress');
    const actionLimitRuns = await waitForRuns(
      actionLimitTicket.id,
      1,
      runs => runs.every(run => run.status === 'completed')
    );
    const actionLimitTicketAfterRun = await waitForTicketStatus(actionLimitTicket.id, 'completed');
    assert(actionLimitTicketAfterRun.status === 'completed', 'Action-limit recovery ticket did not complete');
    verifyRunLogs(actionLimitTicket.id, actionLimitRuns, { expectActionLimitRecover: true });
    for (let index = 1; index <= 12; index += 1) {
      const folderPath = path.join(WORKSPACE_ROOT, `${ACTION_LIMIT_DIR_PREFIX}-${String(index).padStart(2, '0')}`);
      assert(fs.existsSync(folderPath) && fs.lstatSync(folderPath).isDirectory(), `Action-limit recovery missing folder: ${folderPath}`);
    }
    const actionLimitOpHistory = readJson('operation-history.json').filter(h => h.runId === actionLimitRuns[0].id);
    assert(actionLimitOpHistory.length === 12, `Expected 12 createFolder operation history records after recovery, found ${actionLimitOpHistory.length}`);
    assert(actionLimitRuns[0].replaySnapshot.mutationCount === 12, `Action-limit recovery mutation count should be 12, got ${actionLimitRuns[0].replaySnapshot.mutationCount}`);
    assert(actionLimitRuns[0].replaySnapshot.mutationOutcome === 'all_intended', `Action-limit recovery mutation outcome should be all_intended, got ${actionLimitRuns[0].replaySnapshot.mutationOutcome}`);

    const actionLimitRepeatTicket = await createAssignedTicket(cookie, agent.id, `single-agent action-limit-repeat ${STAMP}`);
    await waitForTicketStatus(actionLimitRepeatTicket.id, 'in_progress');
    const actionLimitRepeatRuns = await waitForRuns(
      actionLimitRepeatTicket.id,
      1,
      runs => runs.every(run => run.status === 'failed')
    );
    const actionLimitRepeatTicketAfterRun = await waitForTicketStatus(actionLimitRepeatTicket.id, 'failed');
    assert(actionLimitRepeatTicketAfterRun.status === 'failed', 'Repeated action-limit violation did not fail');
    verifyRunLogs(actionLimitRepeatTicket.id, actionLimitRepeatRuns, { expectFailure: true, expectActionLimit: true, expectMaxStepFailure: true });
    for (let index = 1; index <= 12; index += 1) {
      const folderPath = path.join(WORKSPACE_ROOT, `action-limit-repeat-${STAMP}-${String(index).padStart(2, '0')}`);
      assert(!fs.existsSync(folderPath), `Repeated action-limit violation created folder: ${folderPath}`);
    }

    const workspaceErrorTicket = await createAssignedTicket(cookie, agent.id, `single-agent workspace-error ${STAMP}`);
    await waitForTicketStatus(workspaceErrorTicket.id, 'in_progress');
    const workspaceErrorRuns = await waitForRuns(
      workspaceErrorTicket.id,
      1,
      runs => runs.every(run => run.status === 'failed')
    );
    const workspaceErrorTicketAfterRun = await waitForTicketStatus(workspaceErrorTicket.id, 'failed');
    assert(workspaceErrorTicketAfterRun.status === 'failed', 'Workspace error ticket did not fail');
    verifyRunLogs(workspaceErrorTicket.id, workspaceErrorRuns, { expectFailure: true, expectWorkspaceError: true, expectRecoverableEnoentExhaustion: true });
    verifyOqueryFailureSurface(workspaceErrorRuns[0], {
      displayTag: 'NO_PROGRESS',
      failureType: 'no_progress',
      runOutcome: 'failed_execution',
      replayIncludes: 'ENOENT'
    });

    const writeMissingParentTicket = await createAssignedTicket(cookie, agent.id, `single-agent write-creates-parent ${STAMP}`);
    await waitForTicketStatus(writeMissingParentTicket.id, 'in_progress');
    const writeMissingParentRuns = await waitForRuns(
      writeMissingParentTicket.id,
      1,
      runs => runs.every(run => run.status === 'completed')
    );
    const writeMissingParentTicketAfterRun = await waitForTicketStatus(writeMissingParentTicket.id, 'completed');
    assert(writeMissingParentTicketAfterRun.status === 'completed', 'Write auto-parent ticket did not complete');
    verifyRunLogs(writeMissingParentTicket.id, writeMissingParentRuns, { expectWorkspaceWrite: true });
    const autoParentFile = path.join(WORKSPACE_ROOT, `missing-parent-${STAMP}`, 'child.txt');
    assert(fs.readFileSync(autoParentFile, 'utf8') === 'written with auto parent', 'writeFile did not create the expected missing parent and file');

    const createMissingParentTicket = await createAssignedTicket(cookie, agent.id, `single-agent create-missing-parent ${STAMP}`);
    await waitForTicketStatus(createMissingParentTicket.id, 'in_progress');
    const createMissingParentRuns = await waitForRuns(
      createMissingParentTicket.id,
      1,
      runs => runs.every(run => run.status === 'failed')
    );
    const createMissingParentTicketAfterRun = await waitForTicketStatus(createMissingParentTicket.id, 'failed');
    assert(createMissingParentTicketAfterRun.status === 'failed', 'Create missing-parent ticket did not fail');
    verifyRunLogs(createMissingParentTicket.id, createMissingParentRuns, { expectFailure: true, expectRecoverableCreateMissingParentExhaustion: true });
    verifyOqueryFailureSurface(createMissingParentRuns[0], {
      displayTag: 'BUDGET',
      failureType: 'budget_exhausted',
      runOutcome: 'failed_execution',
      replayIncludes: 'ENOENT'
    });

    const pathConflictTicket = await createAssignedTicket(cookie, agent.id, `single-agent folder-file-conflict ${STAMP}`);
    await waitForTicketStatus(pathConflictTicket.id, 'in_progress');
    const pathConflictRuns = await waitForRuns(
      pathConflictTicket.id,
      1,
      runs => runs.every(run => run.status === 'failed')
    );
    const pathConflictTicketAfterRun = await waitForTicketStatus(pathConflictTicket.id, 'failed');
    assert(pathConflictTicketAfterRun.status === 'failed', 'Path conflict ticket did not fail');
    verifyRunLogs(pathConflictTicket.id, pathConflictRuns, { expectFailure: true, expectRecoverablePathConflictExhaustion: true });
    verifyOqueryFailureSurface(pathConflictRuns[0], {
      displayTag: 'BUDGET',
      failureType: 'budget_exhausted',
      runOutcome: 'failed_execution',
      replayIncludes: 'Path already exists and is not a directory'
    });

    const pathTraversalTicket = await createAssignedTicket(cookie, agent.id, `single-agent path-traversal ${STAMP}`);
    await waitForTicketStatus(pathTraversalTicket.id, 'in_progress');
    const pathTraversalRuns = await waitForRuns(
      pathTraversalTicket.id,
      1,
      runs => runs.every(run => run.status === 'failed')
    );
    const pathTraversalTicketAfterRun = await waitForTicketStatus(pathTraversalTicket.id, 'failed');
    assert(pathTraversalTicketAfterRun.status === 'failed', 'Path traversal ticket did not fail');
    verifyRunLogs(pathTraversalTicket.id, pathTraversalRuns, { expectFailure: true, expectPathTraversalBlocked: true });
    verifyOqueryFailureSurface(pathTraversalRuns[0], {
      displayTag: 'PROTECTED_PATH',
      failureType: 'protected_path',
      runOutcome: 'blocked/rejected',
      replayIncludes: 'BLOCKED'
    });

    const maxStepsTicket = await createAssignedTicket(cookie, agent.id, `single-agent max-steps ${STAMP}`);
    await waitForTicketStatus(maxStepsTicket.id, 'in_progress');
    const maxStepsRuns = await waitForRuns(
      maxStepsTicket.id,
      1,
      runs => runs.every(run => run.status === 'failed')
    );
    const maxStepsTicketAfterRun = await waitForTicketStatus(maxStepsTicket.id, 'failed');
    assert(maxStepsTicketAfterRun.status === 'failed', 'Max-step ticket did not fail');
    verifyRunLogs(maxStepsTicket.id, maxStepsRuns, { expectFailure: true, expectMaxStepFailure: true, expectStructuredRunLimitFailure: true });
    verifyOqueryFailureSurface(maxStepsRuns[0], {
      displayTag: 'BUDGET',
      failureType: 'budget_exhausted',
      runOutcome: 'failed_execution'
    });

    const bulkDeleteTicket = await createAssignedTicket(cookie, agent.id, `single-agent bulk-delete ${STAMP}`);
    await waitForTicketStatus(bulkDeleteTicket.id, 'in_progress');
    const bulkDeleteRuns = await waitForRuns(
      bulkDeleteTicket.id,
      1,
      runs => runs.every(run => run.status === 'completed')
    );
    const bulkDeleteTicketAfterRun = await waitForTicketStatus(bulkDeleteTicket.id, 'completed');
    assert(bulkDeleteTicketAfterRun.status === 'completed', 'Bulk delete ticket did not complete');
    verifyRunLogs(bulkDeleteTicket.id, bulkDeleteRuns, { expectBulkDelete: true });
    const bulkDeleteOpHistory = readJson('operation-history.json').filter(h => h.runId === bulkDeleteRuns[0].id);
    assert(bulkDeleteOpHistory.length === 12, `Expected 12 deletePath operation history records, found ${bulkDeleteOpHistory.length}`);
    assert(bulkDeleteOpHistory.every(h => h.operation === 'deletePath'), 'All bulk delete history records should be deletePath');
    assert(bulkDeleteOpHistory.every(h => h.preState && h.preState.existed === true), 'All deletePath preStates should show existed');
    assert(bulkDeleteOpHistory.every(h => h.postState && h.postState.existed === false), 'All deletePath postStates should show not existed');
    assert(bulkDeleteOpHistory.every((h, i) => i === 0 || h.id > bulkDeleteOpHistory[i - 1].id), 'Operation history should be deterministically ordered by id');
    for (let index = 1; index <= 12; index += 1) {
      const folderPath = path.join(WORKSPACE_ROOT, `${BULK_DELETE_DIR_PREFIX}-${String(index).padStart(2, '0')}`);
      assert(!fs.existsSync(folderPath), `Bulk delete left folder behind: ${folderPath}`);
    }

    const bulkCreateTicket = await createAssignedTicket(cookie, agent.id, `single-agent bulk-create-12-folders ${STAMP}`);
    await waitForTicketStatus(bulkCreateTicket.id, 'in_progress');
    const bulkCreateRuns = await waitForRuns(
      bulkCreateTicket.id,
      1,
      runs => runs.every(run => run.status === 'completed')
    );
    const bulkCreateTicketAfterRun = await waitForTicketStatus(bulkCreateTicket.id, 'completed');
    assert(bulkCreateTicketAfterRun.status === 'completed', 'Bulk create ticket did not complete');
    verifyRunLogs(bulkCreateTicket.id, bulkCreateRuns, { expectBulkCreate: true });
    const bulkCreateOpHistory = readJson('operation-history.json').filter(h => h.runId === bulkCreateRuns[0].id);
    assert(bulkCreateOpHistory.length === 12, `Expected 12 createFolder operation history records, found ${bulkCreateOpHistory.length}`);
    assert(bulkCreateOpHistory.every(h => h.operation === 'createFolder'), 'All bulk create history records should be createFolder');
    assert(bulkCreateOpHistory.every(h => h.preState && h.preState.existed === false), 'All createFolder preStates should show non-existent');
    assert(bulkCreateOpHistory.every(h => h.postState && h.postState.existed === true && h.postState.type === 'directory'), 'All createFolder postStates should show directory');
    for (let index = 1; index <= 12; index += 1) {
      const folderPath = path.join(WORKSPACE_ROOT, `${BULK_CREATE_DIR_PREFIX}-${String(index).padStart(2, '0')}`);
      assert(fs.existsSync(folderPath) && fs.lstatSync(folderPath).isDirectory(), `Bulk create missing folder: ${folderPath}`);
    }
    assert(bulkCreateRuns[0].replaySnapshot.mutationCount === 12, `Bulk create run mutation count should be 12, got ${bulkCreateRuns[0].replaySnapshot.mutationCount}`);
    assert(bulkCreateRuns[0].replaySnapshot.mutationOutcome === 'all_intended', `Bulk create run mutation outcome should be all_intended, got ${bulkCreateRuns[0].replaySnapshot.mutationOutcome}`);

    const bulkWriteTicket = await createAssignedTicket(cookie, agent.id, `single-agent bulk-write-12-files ${STAMP}`);
    await waitForTicketStatus(bulkWriteTicket.id, 'in_progress');
    const bulkWriteRuns = await waitForRuns(
      bulkWriteTicket.id,
      1,
      runs => runs.every(run => run.status === 'completed')
    );
    const bulkWriteTicketAfterRun = await waitForTicketStatus(bulkWriteTicket.id, 'completed');
    assert(bulkWriteTicketAfterRun.status === 'completed', 'Bulk write ticket did not complete');
    verifyRunLogs(bulkWriteTicket.id, bulkWriteRuns, { expectBulkWrite: true });
    const bulkWriteOpHistory = readJson('operation-history.json').filter(h => h.runId === bulkWriteRuns[0].id);
    assert(bulkWriteOpHistory.length === 12, `Expected 12 writeFile operation history records, found ${bulkWriteOpHistory.length}`);
    assert(bulkWriteOpHistory.every(h => h.operation === 'writeFile'), 'All bulk write history records should be writeFile');
    for (let index = 1; index <= 12; index += 1) {
      const filePath = path.join(WORKSPACE_ROOT, `${BULK_WRITE_FILE_PREFIX}-${String(index).padStart(2, '0')}.txt`);
      assert(fs.existsSync(filePath), `Bulk write missing file: ${filePath}`);
    }
    assert(bulkWriteRuns[0].replaySnapshot.mutationCount === 12, `Bulk write run mutation count should be 12, got ${bulkWriteRuns[0].replaySnapshot.mutationCount}`);
    assert(bulkWriteRuns[0].replaySnapshot.mutationOutcome === 'all_intended', `Bulk write run mutation outcome should be all_intended, got ${bulkWriteRuns[0].replaySnapshot.mutationOutcome}`);

    const noopTicket = await createAssignedTicket(cookie, agent.id, `single-agent noop-complete ${STAMP}`);
    await waitForTicketStatus(noopTicket.id, 'in_progress');
    const noopRuns = await waitForRuns(
      noopTicket.id,
      1,
      runs => runs.every(run => run.status === 'completed')
    );
    const noopTicketAfterRun = await waitForTicketStatus(noopTicket.id, 'completed');
    assert(noopTicketAfterRun.status === 'completed', 'No-op ticket did not complete');
    verifyRunLogs(noopTicket.id, noopRuns, { expectNoopCompletion: true });

    await verifyDuplicateActiveBlocking(cookie, agent);

    const protectedCreate = await request('POST', '/api/workspace/file', {
      cookie,
      body: { path: PROTECTED_TEST_FILE }
    });
    assert(protectedCreate.statusCode === 200, `Admin protected file create failed with HTTP ${protectedCreate.statusCode}: ${protectedCreate.body}`);
    const protectedWrite = await request('PATCH', '/api/workspace/file', {
      cookie,
      body: { path: PROTECTED_TEST_FILE, content: 'admin-protected-content' }
    });
    assert(protectedWrite.statusCode === 200, `Admin protected file write failed with HTTP ${protectedWrite.statusCode}: ${protectedWrite.body}`);

    const protectedTicket = await createAssignedTicket(cookie, agent.id, `single-agent protected-overwrite ${STAMP}`);
    await waitForTicketStatus(protectedTicket.id, 'in_progress');
    const protectedRuns = await waitForRuns(
      protectedTicket.id,
      1,
      runs => runs.every(run => run.status === 'failed')
    );
    const protectedTicketAfterRun = await waitForTicketStatus(protectedTicket.id, 'failed');
    assert(protectedTicketAfterRun.status === 'failed', 'Protected overwrite ticket did not fail');
    assert(
      fs.readFileSync(path.join(WORKSPACE_ROOT, PROTECTED_TEST_FILE), 'utf8') === 'admin-protected-content',
      'Agent overwrote protected workspace file'
    );
    verifyRunLogs(protectedTicket.id, protectedRuns, { expectFailure: true, expectProtectedBlocked: true });
    verifyOqueryFailureSurface(protectedRuns[0], {
      displayTag: 'PROTECTED_PATH',
      failureType: 'protected_path',
      runOutcome: 'blocked/rejected',
      replayIncludes: 'BLOCKED'
    });
    const protectedOpHistory = readJson('operation-history.json').filter(h => h.runId === protectedRuns[0].id);
    assert(protectedOpHistory.length === 0, 'Blocked protected path operation should not create history record');
    const protectedDelete = await request('DELETE', '/api/workspace', {
      cookie,
      body: { path: PROTECTED_TEST_FILE }
    });
    assert(protectedDelete.statusCode === 200, `Admin protected file delete failed with HTTP ${protectedDelete.statusCode}: ${protectedDelete.body}`);
    assert(!fs.existsSync(path.join(WORKSPACE_ROOT, PROTECTED_TEST_FILE)), 'Admin protected file delete did not remove the file');
    const operatorMutationLogs = readJson('logs.json').filter(log =>
      log.type === 'workspace:operator_mutation' &&
      log.source === 'operator_workspace_api' &&
      log.requestedBy === 'admin' &&
      log.workspaceAction &&
      [PROTECTED_TEST_FILE].includes(log.workspaceAction.args.path)
    );
    assert(operatorMutationLogs.some(log => log.workspaceAction.operation === 'createFile'), 'Admin createFile workspace mutation was not logged');
    assert(operatorMutationLogs.some(log => log.workspaceAction.operation === 'writeFile'), 'Admin writeFile workspace mutation was not logged');
    assert(operatorMutationLogs.some(log => log.workspaceAction.operation === 'deletePath'), 'Admin deletePath workspace mutation was not logged');
    assert(operatorMutationLogs.every(log => Array.isArray(log.preState) && Array.isArray(log.postState)), 'Admin workspace mutation logs missing pre/post state');
    assert(operatorMutationLogs.every(log => log.runId == null), 'Admin workspace mutation logs should not pretend to be agent run logs');

    const fixtureResponse = await request('POST', '/api/workspace/fixture', {
      cookie,
      body: { fixtureId: 'empty' }
    });
    assert(fixtureResponse.statusCode === 200, `Workspace fixture reset failed with HTTP ${fixtureResponse.statusCode}: ${fixtureResponse.body}`);
    const fixtureLogs = readJson('logs.json').filter(log => log.type === 'workspace:fixture' && log.source === 'operator_workspace_fixture');
    assert(fixtureLogs.some(log =>
      log.requestedBy === 'admin' &&
      log.workspaceAction &&
      log.workspaceAction.operation === 'resetWorkspaceFixture' &&
      log.workspaceAction.args.fixtureId === 'empty' &&
      log.preState &&
      log.postState
    ), 'Workspace fixture reset did not preserve operator provenance and pre/post state');

    const malformedTicket = await createAssignedTicket(cookie, agent.id, `single-agent malformed-response ${STAMP}`);
    await waitForTicketStatus(malformedTicket.id, 'in_progress');
    const malformedRuns = await waitForRuns(
      malformedTicket.id,
      1,
      runs => runs.every(run => run.status === 'failed')
    );
    const malformedTicketAfterRun = await waitForTicketStatus(malformedTicket.id, 'failed');
    assert(malformedTicketAfterRun.status === 'failed', 'Malformed response ticket did not fail');
    verifyRunLogs(malformedTicket.id, malformedRuns, { expectFailure: true, expectMalformedResponse: true });
    verifyOqueryFailureSurface(malformedRuns[0], {
      displayTag: 'INVALID',
      failureType: 'invalid_action',
      runOutcome: 'failed_execution'
    });

    const agentsPage = await request('GET', '/agents', { cookie });
    assert(agentsPage.statusCode === 200, `/agents returned HTTP ${agentsPage.statusCode}`);
    assert(agentsPage.body.includes(agent.name), '/agents page missing single-agent regression agent');

    console.log(JSON.stringify({
      completedRuns: ticketControlRerunRuns.length,
      recoveredRuns: recoveredRuns.length,
      listRecoveredRuns: listRecoveredRuns.length,
      bulkDeleteRuns: bulkDeleteRuns.length,
      bulkCreateRuns: bulkCreateRuns.length,
      bulkWriteRuns: bulkWriteRuns.length,
      actionLimitRecoverRuns: actionLimitRuns.length,
      actionLimitRepeatRuns: actionLimitRepeatRuns.length,
      noopRuns: noopRuns.length,
      interruptedRuns: interruptedRun.status === 'interrupted' ? 1 : 0,
      providerCallInterruptedRuns: providerCallInterruptedRun.status === 'interrupted' ? 1 : 0,
      manualStopRuns: manualControlRuns.stoppedRun.status === 'interrupted' ? 1 : 0,
      providerRaceStopRuns: providerRaceStopRun.status === 'interrupted' ? 1 : 0,
      manualRetryRuns: manualControlRuns.freshRun.status === 'completed' ? 1 : 0,
      protectedBlockedRuns: protectedRuns.length,
      malformedRuns: malformedRuns.length,
      failedRuns: failedRuns.length + transportFailureRuns.length + stalledRuns.length + listLoopRuns.length + actionLimitRepeatRuns.length + workspaceErrorRuns.length + createMissingParentRuns.length + pathConflictRuns.length + pathTraversalRuns.length + maxStepsRuns.length + protectedRuns.length + malformedRuns.length,
      duplicateActiveBlocked: true
    }));
  } finally {
    if (server) {
      server.kill('SIGTERM');
      await waitForExit(server);
    }
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
    fs.rmSync(preloadPath, { force: true });
    removeTempWorkspaceRoot(WORKSPACE_ROOT);
  }
}

main().catch(error => {
  console.error(error.stack || error.message);
  process.exit(1);
});

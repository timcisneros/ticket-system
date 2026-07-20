const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { createTempWorkspaceRoot, removeTempWorkspaceRoot } = require('./test-workspace');

const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-limits-ui-data-'));
const WORKSPACE_ROOT = createTempWorkspaceRoot('runtime-limits-ui');
const PORT = String(35000 + (process.pid % 1000));
const BASE_URL = `http://127.0.0.1:${PORT}`;
const T0 = '2026-06-27T12:00:00.000Z';
const T1 = '2026-06-27T12:00:04.000Z';

function writeJson(file, value) { fs.writeFileSync(path.join(DATA_DIR, file), JSON.stringify(value, null, 2)); }
function readJson(file) { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, file), 'utf8')); }

function replay(runId, values = {}) {
  return {
    version: 1,
    runId,
    ticketId: runId,
    provider: 'openai',
    model: 'gpt-4.1-mini',
    providerRequests: values.providerRequests || [],
    modelResponses: values.modelResponses || [],
    parsedModelPlans: values.parsedModelPlans || [],
    workspaceOperations: values.workspaceOperations || [],
    events: [],
    terminalStatus: values.terminalStatus || 'completed',
    failureReason: values.failureReason || null,
    failure: values.failure || null,
    ...(values.runtimeLimitsSnapshot ? { runtimeLimitsSnapshot: values.runtimeLimitsSnapshot } : {})
  };
}

function seedData() {
  for (const file of ['agents.json', 'permissions.json', 'workflows.json']) {
    fs.copyFileSync(path.join(ROOT, 'data', file), path.join(DATA_DIR, file));
  }
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
  writeJson('tickets.json', [
    { id: 1, objective: 'Create applied.txt', status: 'failed', assignmentTargetType: 'agent', assignmentTargetId: 1, assignmentMode: 'individual', executionMode: 'agent', executionPolicy: {}, createdBy: 'admin', createdAt: T0, updatedAt: T1 }
  ]);
  const appliedLimits = {
    maxExecutionSteps: 3,
    maxModelRequestsPerRun: 4,
    maxWorkspaceOperationsPerRun: 8,
    maxRuntimeDurationMs: 5000,
    source: { uiConfigured: true, deploymentCapped: true, workloadProfile: null, workflowLimits: null }
  };
  writeJson('runs.json', [
    {
      id: 1, ticketId: 1, agentId: 1, agentName: 'Agent 1', status: 'failed', executionMode: 'agent',
      capabilityType: 'directAction', capabilityId: 'agent-selected-actions', executionPolicySnapshot: {},
      runtimeLimitsSnapshot: appliedLimits, createdAt: T0, startedAt: T0, completedAt: T1, updatedAt: T1,
      error: 'Agent run exceeded runtime duration limit of 5000ms',
      runEvaluation: { effectiveness: { status: 'unknown' }, efficiency: { durationMs: 4000, providerRequests: 2, modelResponses: 1, workspaceOperations: 3, mutationCount: 0, workflowSteps: 0, retryCount: 0 }, violations: { status: 'none', items: [] }, effectiveRuntimeConfig: null },
      replaySnapshot: replay(1, {
        terminalStatus: 'failed', runtimeLimitsSnapshot: appliedLimits,
        failureReason: 'Agent run exceeded runtime duration limit of 5000ms',
        failure: { code: 'RUN_LIMIT_EXCEEDED', kind: 'timeout', detail: { limitType: 'timeout', currentValue: 5001, configuredLimit: 5000 } },
        providerRequests: [{ durationMs: 1 }, { durationMs: 1 }], modelResponses: [{ durationMs: 100 }],
        parsedModelPlans: [{ step: 0, message: 'continue', actions: [], complete: false }, { step: 1, message: 'continue', actions: [], complete: false }],
        workspaceOperations: [{ operation: { operation: 'readFile', args: { path: 'a.txt' } }, result: {} }, { operation: { operation: 'readFile', args: { path: 'b.txt' } }, result: {} }, { operation: { operation: 'readFile', args: { path: 'c.txt' } }, result: {} }]
      })
    }
  ]);
  for (const file of ['logs.json', 'operation-history.json', 'allocation-plans.json']) writeJson(file, []);
  fs.writeFileSync(path.join(DATA_DIR, 'events.jsonl'), '');
}

function request(method, urlPath, options = {}) {
  const body = options.form ? new URLSearchParams(options.form).toString() : null;
  return new Promise((resolve, reject) => {
    const req = http.request(`${BASE_URL}${urlPath}`, {
      method,
      headers: {
        ...(body !== null ? { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) } : {}),
        ...(options.cookie ? { Cookie: options.cookie } : {})
      }
    }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ statusCode: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.setTimeout(5000, () => req.destroy(new Error(`Request timed out: ${method} ${urlPath}`)));
    if (body !== null) req.write(body);
    req.end();
  });
}

async function updateRuntimeLimitsForm(cookie, form) {
  const current = await request('GET', '/admin/runtime-limits', { cookie });
  const match = current.body.match(/name="expectedRevision" value="([1-9]\d*)"/);
  if (!match) throw new Error('Runtime limits form did not expose expectedRevision');
  return request('POST', '/admin/runtime-limits', {
    cookie,
    form: { ...form, expectedRevision: match[1] }
  });
}

async function waitForReady() {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try { if ((await request('GET', '/health')).statusCode === 200) return; } catch (_) {}
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('Server did not become ready');
}

async function login(username) {
  const response = await request('POST', '/login', { form: { username, password: 'admin123' } });
  if (response.statusCode !== 302) throw new Error(`Login failed for ${username}: ${response.statusCode}`);
  return (response.headers['set-cookie'] || []).map(value => value.split(';')[0]).join('; ');
}

function assert(condition, message) { if (!condition) throw new Error(message); }

async function main() {
  seedData();
  const server = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env, NODE_ENV: 'test', PORT, DATA_DIR, WORKSPACE_ROOT,
      RUNTIME_SCHEDULER_INTERVAL_MS: '60000',
      AGENT_MAX_EXECUTION_STEPS: '10', AGENT_MAX_MODEL_REQUESTS_PER_RUN: '10',
      AGENT_MAX_WORKSPACE_OPERATIONS_PER_RUN: '20', AGENT_MAX_RUNTIME_DURATION_MS: '20000'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  server.stdout.on('data', chunk => process.stdout.write(chunk));
  server.stderr.on('data', chunk => process.stderr.write(chunk));

  try {
    await waitForReady();
    const admin = await login('admin');
    const viewer = await login('viewer');

    assert((await request('GET', '/admin/runtime-limits', { cookie: viewer })).statusCode === 403, 'unauthorized GET must be forbidden');
    assert((await request('POST', '/admin/runtime-limits', { cookie: viewer, form: { maxExecutionSteps: '2' } })).statusCode === 403, 'unauthorized POST must be forbidden');

    const initial = await request('GET', '/admin/runtime-limits', { cookie: admin });
    assert(initial.statusCode === 200 && initial.body.includes('Runtime Limits'), 'authorized page should render');
    assert(initial.body.includes('newly started agent runs'), 'new-run scope note missing');
    assert(initial.body.includes('<code>10</code>') && initial.body.includes('<code>20000</code>'), 'deployment/effective values missing');
    assert(initial.body.includes('name="maxExecutionSteps"') && initial.body.includes('value=""'), 'inherit input should render blank');
    assert(initial.body.includes('name="expectedRevision" value="1"'), 'optimistic revision field is missing');
    assert(initial.body.includes('Max active runs in this process') && initial.body.includes('name="maxActiveRuns"'), 'process-wide run admission setting is missing');

    const validForm = { maxExecutionSteps: '3', maxModelRequestsPerRun: '4', maxWorkspaceOperationsPerRun: '8', maxRuntimeDurationMs: '5000' };
    const saved = await updateRuntimeLimitsForm(admin, validForm);
    assert(saved.statusCode === 302 && saved.headers.location === '/admin/runtime-limits?saved=1', 'valid form should redirect with confirmation');
    const stored = readJson('runtime-limits.json');
    assert(stored.maxExecutionSteps === 3 && stored.maxRuntimeDurationMs === 5000, 'valid form did not persist');
    const confirmation = await request('GET', '/admin/runtime-limits?saved=1', { cookie: admin });
    assert(confirmation.body.includes('Runtime limits saved.'), 'success confirmation missing');
    assert(confirmation.body.includes('value="3"') && confirmation.body.includes('<code>3</code>'), 'configured/effective values missing');

    const blanks = { maxExecutionSteps: '', maxModelRequestsPerRun: '', maxWorkspaceOperationsPerRun: '', maxRuntimeDurationMs: '' };
    assert((await updateRuntimeLimitsForm(admin, blanks)).statusCode === 302, 'blank inherit form should save');
    assert(Object.values(readJson('runtime-limits.json')).filter(value => value !== null).length === 3, 'blank fields should persist as null apart from revision and audit metadata');

    const invalid = await updateRuntimeLimitsForm(admin, { ...blanks, maxExecutionSteps: '1.5' });
    assert(invalid.statusCode === 400 && invalid.body.includes('must be a positive integer or null'), 'fractional value should render validation error');
    const tooLow = await updateRuntimeLimitsForm(admin, { ...blanks, maxRuntimeDurationMs: '4999' });
    assert(tooLow.statusCode === 400 && tooLow.body.includes('must be at least 5000'), 'runtime minimum should render validation error');
    const overCap = await updateRuntimeLimitsForm(admin, { ...blanks, maxExecutionSteps: '11' });
    assert(overCap.statusCode === 302, 'over-cap value should be accepted for admins');
    const overCapStored = readJson('runtime-limits.json');
    assert(overCapStored.maxExecutionSteps === 11, 'over-cap value should persist');

    const applied = await request('GET', '/runs/1', { cookie: admin });
    assert(applied.statusCode === 200 && applied.body.includes('Runtime limits and usage'), 'run detail limits section missing');
    assert(applied.body.includes('Applied run-start limits'), 'applied snapshot source missing');
    assert(applied.body.includes('2 / 3') && applied.body.includes('2 / 4') && applied.body.includes('3 / 8'), 'usage/limit formatting missing');
    assert(applied.body.includes('<code>timeout</code>'), 'timeout limit outcome missing');
    assert(applied.body.includes('request recorded without matching response'), 'neutral provider symptom missing');
    assert(applied.body.includes('Limit source: Applied run-start limits'), 'diagnostics applied-limit source missing');
    assert(applied.body.includes('Execution turns: 2 / 3'), 'diagnostics usage/limit pair missing');

    console.log('PASS: runtime limits admin UI, immutable current-format run snapshots, and diagnostics render correctly');
  } finally {
    server.kill('SIGTERM');
    if (server.exitCode === null) {
      await Promise.race([
        new Promise(resolve => server.once('exit', resolve)),
        new Promise(resolve => setTimeout(resolve, 2000))
      ]);
    }
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
    removeTempWorkspaceRoot(WORKSPACE_ROOT);
  }
}

main().then(() => process.exit(0)).catch(error => { console.error(error.stack || error.message); process.exit(1); });

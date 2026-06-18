#!/usr/bin/env node
const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const STAMP = Date.now();
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'artifact-prediction-data-'));
const WORKSPACE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'artifact-prediction-workspace-'));
const PORT = String(5300 + Math.floor(Math.random() * 400));
const BASE_URL = 'http://127.0.0.1:' + PORT;
let server = null;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

function writeJson(file, value) {
  fs.writeFileSync(path.join(DATA_DIR, file), JSON.stringify(value, null, 2));
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(path.join(DATA_DIR, file), 'utf8'));
}

function copySeed(file) {
  const src = path.join(ROOT, 'data', file);
  const dst = path.join(DATA_DIR, file);
  fs.writeFileSync(dst, fs.existsSync(src) ? fs.readFileSync(src, 'utf8') : '[]');
}

function seedData() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(path.join(DATA_DIR, 'replay-snapshots'), { recursive: true });
  fs.mkdirSync(WORKSPACE_ROOT, { recursive: true });
  for (const file of ['users.json', 'agents.json', 'groups.json', 'memberships.json', 'permissions.json', 'workflows.json']) {
    copySeed(file);
  }
  const agents = readJson('agents.json').filter(agent => agent.name !== 'Prediction Agent');
  agents.push({
    id: 9901,
    name: 'Prediction Agent',
    description: 'Mocked prediction regression agent',
    provider: 'openai',
    model: 'gpt-test',
    apiKey: 'test-key',
    groupIds: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  });
  writeJson('agents.json', agents);
  writeJson('tickets.json', []);
  writeJson('runs.json', []);
  writeJson('logs.json', []);
  writeJson('operation-history.json', []);
  writeJson('allocation-plans.json', []);
  fs.writeFileSync(path.join(DATA_DIR, 'events.jsonl'), '');
}

function createFakeOpenAIPreload() {
  const preloadPath = path.join(os.tmpdir(), 'artifact-prediction-openai-' + process.pid + '-' + STAMP + '.js');
  const source = `
function okResponse(plan) {
  return {
    ok: true,
    status: 200,
    headers: new Map([['x-request-id', 'fake-artifact-prediction']]),
    async text() {
      return JSON.stringify({
        output_text: JSON.stringify(plan),
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 }
      });
    }
  };
}

global.fetch = async function(_url, options = {}) {
  const body = JSON.parse(options.body || '{}');
  const input = Array.isArray(body.input) ? body.input : [];
  const combined = input.map(item => item && item.content ? String(item.content) : '').join('\\n');
  const stamp = '${STAMP}';

  if (combined.includes('PREDICT-SIMPLE-' + stamp)) {
    return okResponse({
      message: 'Write simple prediction file.',
      actions: [{ operation: 'writeFile', args: { path: 'prediction-simple-' + stamp + '.txt', content: 'simple-' + stamp } }],
      complete: true
    });
  }

  if (combined.includes('PREDICT-BUNDLE-' + stamp)) {
    return okResponse({
      message: 'Create folder prediction bundle.',
      actions: [
        { operation: 'createFolder', args: { path: 'prediction-bundle-' + stamp } },
        { operation: 'writeFile', args: { path: 'prediction-bundle-' + stamp + '/a.txt', content: 'a-' + stamp } },
        { operation: 'writeFile', args: { path: 'prediction-bundle-' + stamp + '/b.txt', content: 'b-' + stamp } }
      ],
      complete: true
    });
  }

  if (combined.includes('PREDICT-WORKFLOW-' + stamp)) {
    return okResponse({
      message: 'Create workflow draft intent.',
      actions: [{
        operation: 'createWorkflowDraftIntent',
        args: {
          id: 'draft-prediction-' + stamp,
          name: 'Prediction draft ' + stamp,
          writes: [{ path: 'prediction-workflow-' + stamp + '.txt', content: 'workflow-' + stamp }],
          postconditions: [{ type: 'fileExists', path: 'prediction-workflow-' + stamp + '.txt' }]
        }
      }],
      complete: false
    });
  }

  if (combined.includes('PREDICT-MISSING-' + stamp)) {
    return okResponse({
      message: 'Predict a protected write that will fail.',
      actions: [{ operation: 'writeFile', args: { path: 'package.json', content: 'blocked' } }],
      complete: true
    });
  }

  return okResponse({ message: 'No matching prediction fixture.', actions: [], complete: true });
};
`;
  fs.writeFileSync(preloadPath, source);
  return preloadPath;
}

function httpReq(method, urlPath, options = {}) {
  return new Promise((resolve, reject) => {
    const body = options.form ? new URLSearchParams(options.form).toString() : null;
    const req = http.request(BASE_URL + urlPath, {
      method,
      headers: {
        ...(body ? { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) } : {}),
        ...(options.cookie ? { Cookie: options.cookie } : {})
      }
    }, res => {
      let responseBody = '';
      res.on('data', chunk => { responseBody += String(chunk); });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: responseBody }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function waitFor(fn, timeoutMs = 30000, intervalMs = 100) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await fn();
    if (result) return result;
    await sleep(intervalMs);
  }
  throw new Error('Timed out waiting for condition');
}

async function startServer(preloadPath) {
  server = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      PORT,
      DATA_DIR,
      WORKSPACE_ROOT,
      NODE_OPTIONS: '--require ' + preloadPath
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let output = '';
  server.stdout.on('data', chunk => { output += String(chunk); });
  server.stderr.on('data', chunk => { output += String(chunk); });
  await waitFor(async () => {
    if (server && server.exitCode !== null) throw new Error('server exited during startup: ' + output.slice(-1000));
    try {
      const res = await httpReq('GET', '/login');
      return res.status === 200;
    } catch (_) {
      return false;
    }
  });
}

async function stopServer() {
  if (!server) return;
  server.kill('SIGTERM');
  await sleep(500);
  if (server && server.exitCode === null) server.kill('SIGKILL');
  server = null;
}

async function login() {
  const res = await httpReq('POST', '/login', { form: { username: 'admin', password: 'admin123' } });
  assert(res.status === 302, 'login should redirect after success');
  const setCookie = Array.isArray(res.headers['set-cookie']) ? res.headers['set-cookie'][0] : res.headers['set-cookie'];
  const match = String(setCookie || '').match(/sessionId=([^;]+)/);
  assert(match, 'login should set session cookie');
  return 'sessionId=' + match[1];
}

async function createTicket(cookie, objective) {
  const res = await httpReq('POST', '/tickets', {
    cookie,
    form: {
      objective,
      assignmentTargetType: 'agent',
      assignmentTargetId: '9901',
      assignmentMode: 'individual'
    }
  });
  assert(res.status === 302, 'ticket create should redirect, got HTTP ' + res.status);
  return waitFor(() => {
    const ticket = readJson('tickets.json').find(item => item.objective === objective);
    if (!ticket) return null;
    const run = readJson('runs.json').find(item => item.ticketId === ticket.id);
    return run ? { ticket, run } : null;
  });
}

async function waitForTerminalRun(runId) {
  return waitFor(() => {
    const run = readJson('runs.json').find(item => item.id === runId);
    return run && ['completed', 'failed', 'interrupted'].includes(run.status) ? run : null;
  }, 45000, 100);
}

function readReplay(run) {
  assert(run.replaySnapshotPath, 'run should have replay snapshot path');
  return JSON.parse(fs.readFileSync(path.join(DATA_DIR, run.replaySnapshotPath), 'utf8'));
}

async function runPredictionCase(cookie, marker, expectedArtifacts, expectedStatus = 'completed') {
  const objective = marker + ': create artifact prediction fixture ' + STAMP;
  const { run } = await createTicket(cookie, objective);
  const finalRun = await waitForTerminalRun(run.id);
  assert(finalRun.status === expectedStatus, marker + ' should end as ' + expectedStatus + ', got ' + finalRun.status + ': ' + (finalRun.error || ''));
  const snapshot = readReplay(finalRun);
  const prediction = snapshot.artifactPrediction;
  assert(prediction, marker + ' should capture artifactPrediction');
  assert(!snapshot.artifactPredictionComparison, marker + ' should not persist artifactPredictionComparison');
  assert(prediction.version === 1, marker + ' prediction version should be 1');
  assert(prediction.source === 'parsedModelPlans', marker + ' prediction source should be parsedModelPlans');
  assert(prediction.firstPredictedAtStep === 0, marker + ' prediction should capture step 0');
  assert(Array.isArray(prediction.artifacts), marker + ' prediction artifacts should be an array');
  assert(prediction.artifacts.length === expectedArtifacts.length, marker + ' expected ' + expectedArtifacts.length + ' predicted artifact(s), got ' + prediction.artifacts.length);
  expectedArtifacts.forEach(expected => {
    assert(prediction.artifacts.some(item => item.type === expected.type && item.artifact === expected.artifact && item.operation === expected.operation),
      marker + ' missing predicted artifact ' + JSON.stringify(expected) + ' in ' + JSON.stringify(prediction.artifacts));
  });
  return { run: finalRun, snapshot };
}

function writeReplaySnapshot(runId, snapshot) {
  const relativePath = path.join('replay-snapshots', 'run-' + runId + '.json');
  fs.writeFileSync(path.join(DATA_DIR, relativePath), JSON.stringify(snapshot, null, 2));
  return relativePath;
}

function appendJsonRecord(file, record) {
  const records = readJson(file);
  records.push(record);
  writeJson(file, records);
}

function normalizePredictedFixtureArtifact(value, actionIndex) {
  if (value && typeof value === 'object') {
    return {
      type: value.type || 'file',
      artifact: value.artifact || value.path,
      operation: value.operation || (value.type === 'folder' ? 'createFolder' : 'writeFile'),
      step: 0,
      actionIndex
    };
  }
  return {
    type: 'file',
    artifact: value,
    operation: 'writeFile',
    step: 0,
    actionIndex
  };
}

function normalizeActualFixtureRecord(value, fixtureNumber, index, ticketId, runId, now) {
  if (value && typeof value === 'object') {
    const operation = value.operation || (value.type === 'folder' ? 'createFolder' : 'writeFile');
    const artifact = value.artifact || value.path;
    const status = value.status || (operation === 'createFolder' ? 'created' : undefined);
    return {
      id: 990000 + fixtureNumber * 10 + index,
      timestamp: now,
      ticketId,
      runId,
      step: 0,
      operation,
      args: operation === 'renamePath'
        ? { path: value.path || artifact, nextPath: value.nextPath || artifact }
        : { path: artifact, ...(operation === 'writeFile' ? { content: 'fixture' } : {}) },
      preState: value.preState || (operation === 'createFolder'
        ? { existed: status === 'already_exists_noop', type: status === 'already_exists_noop' ? 'directory' : undefined }
        : { existed: false }),
      postState: value.postState || (operation === 'createFolder'
        ? { existed: true, type: 'directory' }
        : { existed: true, type: 'file' }),
      result: value.result || { path: artifact, ...(status ? { status } : {}) },
      error: value.error || null
    };
  }
  return {
    id: 990000 + fixtureNumber * 10 + index,
    timestamp: now,
    ticketId,
    runId,
    step: 0,
    operation: 'writeFile',
    args: { path: value, content: 'fixture' },
    preState: { existed: false },
    postState: { existed: true, type: 'file' },
    result: { path: value },
    error: null
  };
}

function addAccuracyFixtureRun(name, predictions, actualArtifacts, options = {}) {
  const fixtureNumber = addAccuracyFixtureRun.nextId++;
  const ticketId = 9000 + fixtureNumber;
  const runId = 9100 + fixtureNumber;
  const now = new Date().toISOString();
  const status = options.status || 'completed';
  const error = options.error || null;
  appendJsonRecord('tickets.json', {
    id: ticketId,
    objective: options.objective || ('Artifact accuracy fixture ' + name),
    assignmentTargetType: 'agent',
    assignmentTargetId: 9901,
    assignmentMode: 'individual',
    executionMode: 'agent',
    capabilityType: 'directAction',
    capabilityId: 'agent-selected-actions',
    status,
    createdBy: 'test',
    changedBy: 'test',
    changedAt: now,
    createdAt: now,
    updatedAt: now
  });

  const replaySnapshotPath = writeReplaySnapshot(runId, {
    runId,
    ticketId,
    assignedAgentId: 9901,
    agentNameSnapshot: 'Prediction Agent',
    providerRequests: [],
    modelResponses: [],
    parsedModelPlans: [],
    workspaceOperations: [],
    events: [],
    artifactPrediction: predictions
      ? {
        version: 1,
        source: 'parsedModelPlans',
        capturedAt: now,
        firstPredictedAtStep: 0,
        artifacts: predictions.map((artifact, actionIndex) => normalizePredictedFixtureArtifact(artifact, actionIndex))
      }
      : null,
    terminalStatus: status,
    failureReason: error,
    createdAt: now
  });

  appendJsonRecord('runs.json', {
    id: runId,
    ticketId,
    agentId: 9901,
    agentName: 'Prediction Agent',
    executionWorkspaceType: 'main',
    ownedOutputPaths: [],
    executionMode: 'agent',
    capabilityType: 'directAction',
    capabilityId: 'agent-selected-actions',
    status,
    ticketOpenedAt: now,
    createdAt: now,
    updatedAt: now,
    startedAt: now,
    completedAt: ['completed', 'failed', 'interrupted'].includes(status) ? now : null,
    error,
    replaySnapshotPath,
    replaySummary: { steps: 0, providerRequests: 0, modelResponses: 0, workspaceOperations: actualArtifacts.length, mutationCount: actualArtifacts.length, terminalStatus: status, failureReason: error }
  });

  const history = readJson('operation-history.json');
  actualArtifacts.forEach((artifact, index) => {
    history.push(normalizeActualFixtureRecord(artifact, fixtureNumber, index, ticketId, runId, now));
  });
  writeJson('operation-history.json', history);
  return { ticketId, runId };
}
addAccuracyFixtureRun.nextId = 1;

async function assertRunDetailContains(cookie, runId, expected) {
  const res = await httpReq('GET', '/runs/' + runId, { cookie });
  assert(res.status === 200, 'fixture run detail should render, got HTTP ' + res.status);
  expected.forEach(text => {
    assert(res.body.includes(text), 'run detail for ' + runId + ' should include ' + JSON.stringify(text));
  });
  return res;
}

async function main() {
  seedData();
  const preloadPath = createFakeOpenAIPreload();
  try {
    await startServer(preloadPath);
    const cookie = await login();

    const simple = await runPredictionCase(cookie, 'PREDICT-SIMPLE-' + STAMP, [
      { type: 'file', artifact: 'prediction-simple-' + STAMP + '.txt', operation: 'writeFile' }
    ]);

    await runPredictionCase(cookie, 'PREDICT-BUNDLE-' + STAMP, [
      { type: 'folder', artifact: 'prediction-bundle-' + STAMP, operation: 'createFolder' },
      { type: 'file', artifact: 'prediction-bundle-' + STAMP + '/a.txt', operation: 'writeFile' },
      { type: 'file', artifact: 'prediction-bundle-' + STAMP + '/b.txt', operation: 'writeFile' }
    ]);

    const workflow = await runPredictionCase(cookie, 'PREDICT-WORKFLOW-' + STAMP, [
      { type: 'workflowDraft', artifact: 'draft-prediction-' + STAMP, operation: 'createWorkflowDraftIntent' }
    ]);

    const missing = await runPredictionCase(cookie, 'PREDICT-MISSING-' + STAMP, [
      { type: 'file', artifact: 'package.json', operation: 'writeFile' }
    ], 'failed');

    const history = readJson('operation-history.json');
    history.push({
      id: 999001,
      timestamp: new Date().toISOString(),
      ticketId: simple.run.ticketId,
      runId: simple.run.id,
      step: 0,
      operation: 'writeFile',
      args: { path: 'prediction-unexpected-' + STAMP + '.txt', content: 'unexpected' },
      preState: { existed: false },
      postState: { existed: true, type: 'file' },
      result: { path: 'prediction-unexpected-' + STAMP + '.txt' },
      error: null
    });
    writeJson('operation-history.json', history);

    const runDetail = await httpReq('GET', '/runs/' + simple.run.id, { cookie });
    assert(runDetail.status === 200, 'run detail should render, got HTTP ' + runDetail.status);
    assert(runDetail.body.includes('Artifact Prediction'), 'run detail should show Artifact Prediction section');
    assert(runDetail.body.includes('prediction-simple-' + STAMP + '.txt'), 'run detail should show predicted simple file');
    assert(runDetail.body.includes('matched'), 'run detail should show matched prediction state');
    assert(runDetail.body.includes('Unexpected Actual Artifacts'), 'run detail should show unexpected actual artifacts');
    assert(runDetail.body.includes('prediction-unexpected-' + STAMP + '.txt'), 'run detail should show unexpected file artifact');

    const missingDetail = await httpReq('GET', '/runs/' + missing.run.id, { cookie });
    assert(missingDetail.status === 200, 'missing run detail should render, got HTTP ' + missingDetail.status);
    assert(missingDetail.body.includes('package.json'), 'missing run detail should show predicted protected file');
    assert(missingDetail.body.includes('missing'), 'missing run detail should show missing prediction state');

    const workflowDetail = await httpReq('GET', '/runs/' + workflow.run.id, { cookie });
    assert(workflowDetail.status === 200, 'workflow run detail should render, got HTTP ' + workflowDetail.status);
    assert(workflowDetail.body.includes('draft-prediction-' + STAMP), 'workflow run detail should show predicted workflow draft');
    assert(workflowDetail.body.includes('matched'), 'workflow draft prediction should match actual draft artifact');
    assert(workflowDetail.body.includes('100% · 1/1 matched'), 'workflow draft created during current run should score as matched');

    const perfectFixture = addAccuracyFixtureRun('perfect', [
      'accuracy-perfect-' + STAMP + '-a.txt',
      'accuracy-perfect-' + STAMP + '-b.txt'
    ], [
      'accuracy-perfect-' + STAMP + '-a.txt',
      'accuracy-perfect-' + STAMP + '-b.txt'
    ]);
    await assertRunDetailContains(cookie, perfectFixture.runId, ['Run Completed:</strong> Yes', '100% · 2/2 matched']);

    const failedFixture = addAccuracyFixtureRun('failed-objective', [
      'accuracy-failed-' + STAMP + '-a.txt'
    ], [], { status: 'failed', error: 'Fixture failure' });
    await assertRunDetailContains(cookie, failedFixture.runId, ['Run Completed:</strong> No · failed', '0% · 0/1 matched']);

    const interruptedFixture = addAccuracyFixtureRun('interrupted-objective', [
      'accuracy-interrupted-' + STAMP + '-a.txt'
    ], [], { status: 'interrupted', error: 'Fixture interrupted' });
    await assertRunDetailContains(cookie, interruptedFixture.runId, ['Run Completed:</strong> No · interrupted', '0% · 0/1 matched']);

    const pendingFixture = addAccuracyFixtureRun('pending-objective', [
      'accuracy-pending-' + STAMP + '-a.txt'
    ], [], { status: 'running' });
    await assertRunDetailContains(cookie, pendingFixture.runId, ['Run Completed:</strong> Not scored']);

    const partialFailedFixture = addAccuracyFixtureRun('partial-failed-objective', [
      'accuracy-partial-' + STAMP + '-source.txt',
      { type: 'renamed', artifact: 'accuracy-partial-' + STAMP + '-final.txt', operation: 'renamePath' }
    ], [
      'accuracy-partial-' + STAMP + '-source.txt'
    ], { status: 'failed', error: 'Fixture rename failed' });
    await assertRunDetailContains(cookie, partialFailedFixture.runId, ['Run Completed:</strong> No · failed', '50% · 1/2 matched', 'missing']);

    const partialPathCoverageFixture = addAccuracyFixtureRun('partial-path-coverage', [
      'coverage-source-' + STAMP + '.txt'
    ], [
      'coverage-source-' + STAMP + '.txt'
    ], {
      objective: 'Create coverage-source-' + STAMP + '.txt then rename it to coverage-final-' + STAMP + '.txt'
    });
    await assertRunDetailContains(cookie, partialPathCoverageFixture.runId, ['Objective Path Coverage:</strong> 50% · 1/2 covered']);

    const fullPathCoverageFixture = addAccuracyFixtureRun('full-path-coverage', [
      'coverage-full-a-' + STAMP + '.txt',
      'coverage-full-b-' + STAMP + '.txt'
    ], [
      'coverage-full-a-' + STAMP + '.txt',
      'coverage-full-b-' + STAMP + '.txt'
    ], {
      objective: 'Write coverage-full-a-' + STAMP + '.txt and coverage-full-b-' + STAMP + '.txt'
    });
    await assertRunDetailContains(cookie, fullPathCoverageFixture.runId, ['Objective Path Coverage:</strong> 100% · 2/2 covered']);

    const workflowCoverageFixture = addAccuracyFixtureRun('workflow-path-coverage', [
      { type: 'workflowDraft', artifact: 'coverage-workflow-draft-' + STAMP, operation: 'createWorkflowDraftIntent' }
    ], [], {
      objective: 'Create a workflow draft that writes coverage-workflow-output-' + STAMP + '.txt'
    });
    const workflowCoverageSnapshot = readReplay({ replaySnapshotPath: path.join('replay-snapshots', 'run-' + workflowCoverageFixture.runId + '.json') });
    workflowCoverageSnapshot.parsedModelPlans = [{
      message: 'Create workflow draft coverage fixture.',
      actions: [{
        operation: 'createWorkflowDraftIntent',
        args: {
          id: 'coverage-workflow-draft-' + STAMP,
          name: 'Coverage Workflow Draft ' + STAMP,
          writes: [{ path: 'coverage-workflow-output-' + STAMP + '.txt', content: 'ok' }],
          postconditions: [{ type: 'fileExists', path: 'coverage-workflow-output-' + STAMP + '.txt' }]
        }
      }],
      complete: true,
      step: 0
    }];
    writeReplaySnapshot(workflowCoverageFixture.runId, workflowCoverageSnapshot);
    await assertRunDetailContains(cookie, workflowCoverageFixture.runId, [
      'Objective Path Coverage:</strong> 100% · 1/1 covered',
      'Artifact Accuracy:</strong> 0% · 0/1 matched'
    ]);

    const noPathCoverageFixture = addAccuracyFixtureRun('no-path-coverage', [
      'coverage-no-path-' + STAMP + '.txt'
    ], [
      'coverage-no-path-' + STAMP + '.txt'
    ], {
      objective: 'Write a brief status note for this task'
    });
    await assertRunDetailContains(cookie, noPathCoverageFixture.runId, ['Objective Path Coverage:</strong> Not scored']);

    const missingFixture = addAccuracyFixtureRun('missing', [
      'accuracy-missing-' + STAMP + '-a.txt',
      'accuracy-missing-' + STAMP + '-b.txt',
      'accuracy-missing-' + STAMP + '-c.txt'
    ], [
      'accuracy-missing-' + STAMP + '-a.txt',
      'accuracy-missing-' + STAMP + '-b.txt'
    ]);
    await assertRunDetailContains(cookie, missingFixture.runId, ['67% · 2/3 matched', 'missing']);

    const unexpectedFixture = addAccuracyFixtureRun('unexpected', [
      'accuracy-unexpected-' + STAMP + '-a.txt',
      'accuracy-unexpected-' + STAMP + '-b.txt'
    ], [
      'accuracy-unexpected-' + STAMP + '-a.txt',
      'accuracy-unexpected-' + STAMP + '-b.txt',
      'accuracy-unexpected-' + STAMP + '-c.txt'
    ]);
    await assertRunDetailContains(cookie, unexpectedFixture.runId, ['67% · 2/3 matched', 'Unexpected Actual Artifacts']);

    const mixedFixture = addAccuracyFixtureRun('mixed', [
      'accuracy-mixed-' + STAMP + '-a.txt',
      'accuracy-mixed-' + STAMP + '-b.txt',
      'accuracy-mixed-' + STAMP + '-c.txt'
    ], [
      'accuracy-mixed-' + STAMP + '-a.txt',
      'accuracy-mixed-' + STAMP + '-b.txt',
      'accuracy-mixed-' + STAMP + '-d.txt'
    ]);
    await assertRunDetailContains(cookie, mixedFixture.runId, ['50% · 2/4 matched', 'Unexpected Actual Artifacts', 'missing']);

    const staleWorkflowFixture = addAccuracyFixtureRun('stale-workflow-attribution', [
      'accuracy-stale-workflow-' + STAMP + '.txt'
    ], [
      'accuracy-stale-workflow-' + STAMP + '.txt'
    ]);
    const workflows = readJson('workflows.json');
    workflows.push({
      id: 'stale-workflow-' + STAMP,
      name: 'Stale Workflow ' + STAMP,
      enabled: false,
      createdByType: 'agent',
      createdByAgentId: 9901,
      createdByRunId: staleWorkflowFixture.runId,
      createdAt: new Date(Date.now() - 86400000).toISOString(),
      updatedAt: new Date(Date.now() - 86400000).toISOString(),
      inputSchema: {},
      actions: [],
      postconditions: []
    });
    writeJson('workflows.json', workflows);
    const staleWorkflowDetail = await assertRunDetailContains(cookie, staleWorkflowFixture.runId, ['100% · 1/1 matched']);
    assert(!staleWorkflowDetail.body.includes('Unexpected Actual Artifacts'), 'stale workflow with matching createdByRunId should not appear as an unexpected actual artifact');

    const noPredictionFixture = addAccuracyFixtureRun('no-prediction', null, [
      'accuracy-no-prediction-' + STAMP + '.txt'
    ]);
    await assertRunDetailContains(cookie, noPredictionFixture.runId, ['Artifact Accuracy:</strong> Not scored', 'No artifact prediction captured.']);

    const newFolderFixture = addAccuracyFixtureRun('new-folder', [
      { type: 'folder', artifact: 'accuracy-new-folder-' + STAMP, operation: 'createFolder' }
    ], [
      { type: 'folder', artifact: 'accuracy-new-folder-' + STAMP, operation: 'createFolder', status: 'created' }
    ]);
    await assertRunDetailContains(cookie, newFolderFixture.runId, ['100% · 1/1 matched']);

    const existingFolderFixture = addAccuracyFixtureRun('existing-folder', [
      { type: 'folder', artifact: 'accuracy-existing-folder-' + STAMP, operation: 'createFolder' },
      { type: 'file', artifact: 'accuracy-existing-folder-' + STAMP + '/note.txt', operation: 'writeFile' }
    ], [
      {
        type: 'folder',
        artifact: 'accuracy-existing-folder-' + STAMP,
        operation: 'createFolder',
        status: 'already_exists_noop',
        preState: { existed: true, type: 'directory' },
        postState: { existed: true, type: 'directory' }
      },
      'accuracy-existing-folder-' + STAMP + '/note.txt'
    ]);
    await assertRunDetailContains(cookie, existingFolderFixture.runId, ['100% · 2/2 matched']);

    const missingFolderFixture = addAccuracyFixtureRun('missing-folder', [
      { type: 'folder', artifact: 'accuracy-missing-folder-' + STAMP, operation: 'createFolder' }
    ], []);
    await assertRunDetailContains(cookie, missingFolderFixture.runId, ['0% · 0/1 matched', 'missing']);

    console.log(JSON.stringify({ artifactPredictionCapture: true, artifactPredictionComparison: true, artifactAccuracy: true, satisfiedFolderPredictions: true, workflowAttribution: true, simpleRunId: simple.run.id }));
  } finally {
    await stopServer();
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
    fs.rmSync(WORKSPACE_ROOT, { recursive: true, force: true });
    try { fs.unlinkSync(preloadPath); } catch (_) {}
  }
}

main().catch(async error => {
  await stopServer();
  console.error(error.stack || error.message);
  process.exit(1);
});

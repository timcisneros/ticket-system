'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { createTempWorkspaceRoot, removeTempWorkspaceRoot } = require('./test-workspace');

const ROOT = path.resolve(__dirname, '..');
const REAL_DATA_DIR = path.join(ROOT, 'data');
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-read-result-data-'));
const WORKSPACE_ROOT = createTempWorkspaceRoot('browser-read-result');
const APP_PORT = Number(process.env.BROWSER_READ_RESULT_TEST_PORT || 3621);
const FIXTURE_PORT = Number(process.env.BROWSER_READ_RESULT_FIXTURE_PORT || 3622);
const BASE_URL = `http://127.0.0.1:${APP_PORT}`;
const FIXTURE_ORIGIN = `http://127.0.0.1:${FIXTURE_PORT}`;
const STAMP = `${process.pid}-${Date.now()}`;
const FILESYSTEM_FILE = `browser-report-fs-${STAMP}.txt`;

const DATA_FILES = [
  'agents.json', 'browser-targets.json', 'groups.json', 'logs.json',
  'memberships.json', 'operation-history.json', 'permissions.json', 'runs.json', 'tickets.json',
  'users.json', 'workflows.json', 'allocation-plans.json'
];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(path.join(DATA_DIR, file), 'utf8'));
}

function writeJson(file, value) {
  fs.writeFileSync(path.join(DATA_DIR, file), JSON.stringify(value, null, 2));
}

function readReplay(run) {
  assert(run && run.replaySnapshotPath, `Run ${run && run.id} has no replay snapshot path`);
  return JSON.parse(fs.readFileSync(path.join(DATA_DIR, run.replaySnapshotPath), 'utf8'));
}

for (const file of DATA_FILES) {
  const source = path.join(REAL_DATA_DIR, file);
  fs.writeFileSync(path.join(DATA_DIR, file), fs.existsSync(source) ? fs.readFileSync(source) : '[]');
}
fs.writeFileSync(path.join(DATA_DIR, 'events.jsonl'), '');

const targetLimits = {
  maxNavigationsPerRun: 4,
  maxActionsPerRun: 8,
  navTimeoutMs: 5000,
  waitTimeoutMsCap: 1000,
  maxPageTextBytes: 4096,
  maxScreenshotsPerRun: 2
};

writeJson('browser-targets.json', [
  {
    id: 'report-test', name: 'Report Test', status: 'active',
    allowedOrigins: [FIXTURE_ORIGIN], startUrl: `${FIXTURE_ORIGIN}/content`,
    limits: targetLimits
  }
]);

function seedAgent() {
  const agents = readJson('agents.json');
  const agent = {
    id: Math.max(0, ...agents.map(item => item.id || 0)) + 1,
    name: `ReportAgent-${STAMP}`,
    type: 'agent', provider: 'openai', model: 'gpt-4.1-mini', apiKey: 'report-test-key',
    createdAt: new Date().toISOString()
  };
  writeJson('agents.json', [...agents, agent]);
  return agent;
}

function request(method, urlPath, options = {}) {
  const body = options.form
    ? new URLSearchParams(options.form).toString()
    : options.body ? JSON.stringify(options.body) : null;
  return new Promise((resolve, reject) => {
    const req = http.request(`${BASE_URL}${urlPath}`, {
      method,
      headers: {
        ...(options.form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
        ...(body ? { 'Content-Length': Buffer.byteLength(body) } : {}),
        ...(options.cookie ? { Cookie: options.cookie } : {})
      }
    }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({
        statusCode: response.statusCode,
        headers: response.headers,
        body: Buffer.concat(chunks).toString('utf8')
      }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function cookieFrom(response) {
  return (response.headers['set-cookie'] || []).map(value => value.split(';')[0]).join('; ');
}

async function waitForReady() {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try {
      const response = await request('GET', '/health');
      if (response.statusCode === 200 && JSON.parse(response.body).ready) return;
    } catch (_) {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Timed out waiting for ticket server readiness');
}

async function login() {
  const response = await request('POST', '/login', { form: { username: 'admin', password: 'admin123' } });
  assert(response.statusCode === 302, `Login failed with HTTP ${response.statusCode}`);
  return cookieFrom(response);
}

async function createTicket(cookie, agentId, objective, browserTargetId = null) {
  const form = {
    objective,
    assignmentTargetType: 'agent',
    assignmentTargetId: String(agentId)
  };
  if (browserTargetId) {
    form.targetRef = JSON.stringify({ kind: 'browser', browserTargetId });
  }
  const response = await request('POST', '/tickets', { cookie, form });
  assert(response.statusCode === 302, `Ticket creation failed with HTTP ${response.statusCode}: ${response.body}`);
  const ticket = readJson('tickets.json').find(item => item.objective === objective);
  assert(ticket, `Ticket was not persisted: ${objective}`);
  return ticket;
}

async function waitForTerminalRun(ticketId) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const run = readJson('runs.json').filter(item => item.ticketId === ticketId).sort((a, b) => b.id - a.id)[0];
    if (run && ['completed', 'failed', 'interrupted'].includes(run.status)) return run;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for terminal run for ticket ${ticketId}`);
}

async function waitForRunEvaluation(ticketId) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const run = readJson('runs.json').filter(item => item.ticketId === ticketId).sort((a, b) => b.id - a.id)[0];
    if (run && run.runEvaluation && typeof run.runEvaluation === 'object') return run;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  const run = readJson('runs.json').filter(item => item.ticketId === ticketId).sort((a, b) => b.id - a.id)[0];
  return run;
}

// ---- Model preload with deterministic browser report scenarios ----
function createModelPreload() {
  const preloadPath = path.join(os.tmpdir(), `browser-report-model-${STAMP}.js`);
  const source = `
global.fetch = async function(_url, options = {}) {
  const body = JSON.parse(options.body || '{}');
  const combined = (body.input || []).map(item => String(item && item.content || '')).join('\\\\n');
  let plan;
  if (combined.includes('BROWSER_REPORT_AVAILABLE')) {
    plan = { message: 'Example.com is a reserved example domain used for documentation and illustrative examples.', actions: [
      { operation: 'navigate', args: { url: process.env.TEST_FIXTURE_URL } },
      { operation: 'wait', args: { forMs: 200 } },
      { operation: 'readPageText', args: {} },
      { operation: 'observe', args: {} }
    ], complete: true };
  } else if (combined.includes('BROWSER_REPORT_NOT_AVAILABLE')) {
    plan = { message: null, actions: [
      { operation: 'navigate', args: { url: process.env.TEST_MINIMAL_URL } },
      { operation: 'wait', args: { forMs: 200 } },
      { operation: 'observe', args: {} }
    ], complete: true };
  } else if (combined.includes('browser-filesystem-nonregression')) {
    plan = { message: 'Write a file to test filesystem isolation.', actions: [{ operation: 'writeFile', args: { path: process.env.TEST_FILESYSTEM_FILE, content: 'report-fs-ok' } }], complete: true };
  } else {
    plan = { message: 'No matching test plan.', actions: [], complete: true };
  }
  return {
    ok: true, status: 200, headers: new Map([['x-request-id', 'report-test']]),
    async text() { return JSON.stringify({ output_text: JSON.stringify(plan), usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } }); }
  };
};
`;
  fs.writeFileSync(preloadPath, source);
  return preloadPath;
}

function waitForExit(child) {
  return new Promise(resolve => {
    if (!child || child.exitCode !== null) return resolve();
    child.once('exit', resolve);
  });
}

async function startServer(preloadPath, executablePath) {
  const env = {
    ...process.env,
    NODE_ENV: 'test', PORT: String(APP_PORT), DATA_DIR, WORKSPACE_ROOT,
    NODE_OPTIONS: `--require ${preloadPath}`,
    TEST_FIXTURE_URL: `${FIXTURE_ORIGIN}/content`,
    TEST_MINIMAL_URL: `${FIXTURE_ORIGIN}/minimal`,
    TEST_FILESYSTEM_FILE: FILESYSTEM_FILE
  };
  if (executablePath) env.BROWSER_ENGINE_EXECUTABLE = executablePath;
  else delete env.BROWSER_ENGINE_EXECUTABLE;
  const child = spawn(process.execPath, ['server.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', chunk => process.stdout.write(String(chunk)));
  child.stderr.on('data', chunk => process.stderr.write(String(chunk)));
  await waitForReady();
  return child;
}

async function stopServer(child) {
  if (!child || child.exitCode !== null) return;
  const exited = waitForExit(child);
  child.kill('SIGTERM');
  await exited;
}

function startFixtureServer(port, handler) {
  const server = http.createServer(handler);
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

function findEngineExecutable() {
  const candidates = [
    process.env.BROWSER_ENGINE_EXECUTABLE,
    '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable', '/snap/bin/chromium'
  ].filter(Boolean);
  return candidates.find(candidate => {
    try { fs.accessSync(candidate, fs.constants.X_OK); return fs.statSync(candidate).isFile(); }
    catch (_) { return false; }
  }) || null;
}

function getBrowserEvidenceFromRun(run) {
  const evaluation = run.runEvaluation;
  assert(evaluation, 'Run has no runEvaluation');
  const browserEvidence = evaluation.browserEvidence;
  assert(browserEvidence, 'Run evaluation has no browserEvidence field');
  return browserEvidence;
}

// ---- Test 1: Browser run with readPageText persists browserReport on run ----
async function assertBrowserReportAvailableOnRun(cookie, agent, fixtureCounts) {
  const objective = `BROWSER_REPORT_AVAILABLE ${STAMP}: navigate and read page text with report`;
  const ticket = await createTicket(cookie, agent.id, objective, 'report-test');
  const run = await waitForTerminalRun(ticket.id);
  assert(run.status === 'completed', `Report run should complete: ${run.error || run.status}`);
  assert(fixtureCounts.content > 0, 'Content fixture was never reached');
  const runWithEval = await waitForRunEvaluation(ticket.id);

  // Verify browserReport on run record
  const report = runWithEval.browserReport;
  assert(report, 'run.browserReport should exist');
  assert(report.status === 'available', `Expected available, got: ${report.status}`);
  assert(report.text && report.text.length > 0, 'browserReport.text should be non-empty');
  assert(report.text.includes('Example.com'), `Report text should mention example, got: ${report.text}`);
  assert(report.generatedAt, 'browserReport.generatedAt should be set');
  assert(report.source === 'terminal_browser_model_message', `Expected terminal_browser_model_message source, got: ${report.source}`);
  assert(typeof report.sourceStep === 'number', `sourceStep should be a number, got: ${typeof report.sourceStep}`);
  assert(typeof report.sourceOperationCount === 'number' && report.sourceOperationCount > 0,
    `sourceOperationCount should be > 0, got: ${report.sourceOperationCount}`);

  return { run: runWithEval, ticket };
}

// ---- Test 2: Same report is persisted on replaySnapshot ----
async function assertBrowserReportOnSnapshot(runRecord) {
  const snapshot = readReplay(runRecord.run);
  const report = snapshot.browserReport;
  assert(report, 'Snapshot browserReport should exist');
  assert(report.status === 'available', `Snapshot expected available, got: ${report.status}`);
  assert(report.text === runRecord.run.browserReport.text,
    'Snapshot report text should match run report text');
  assert(report.generatedAt, 'Snapshot browserReport.generatedAt should be set');
}

// ---- Test 3: Browser evidence status remains independent ----
async function assertEvidenceIndependent(runRecord) {
  const runWithEval = runRecord.run;
  const evidence = getBrowserEvidenceFromRun(runWithEval);
  assert(evidence.status === 'evidence_available',
    `Expected evidence_available, got: ${evidence.status} (detail: ${evidence.detail})`);
}

// ---- Test 4: Objective success remains unverified ----
async function assertObjectiveUnverified(runRecord) {
  const runWithEval = runRecord.run;
  const evaluation = runWithEval.runEvaluation || {};
  assert(evaluation.objectiveSuccess === undefined || evaluation.objectiveSuccess === null,
    'Objective success should not be set in runEvaluation');
}

// ---- Test 5: Browser run with no usable terminal message ----
async function assertBrowserReportNotAvailable(cookie, agent, fixtureCounts) {
  const objective = `BROWSER_REPORT_NOT_AVAILABLE ${STAMP}: minimal page, no report message`;
  const ticket = await createTicket(cookie, agent.id, objective, 'report-test');
  const run = await waitForTerminalRun(ticket.id);
  assert(run.status === 'completed', `No-report run should complete: ${run.error || run.status}`);
  const runWithEval = await waitForRunEvaluation(ticket.id);

  const report = runWithEval.browserReport;
  assert(report, 'run.browserReport should exist');
  assert(report.status === 'not_available',
    `Expected not_available, got: ${report.status}`);
  assert(report.text === null, 'browserReport.text should be null when not available');

  const snapshot = readReplay(run);
  const snapshotReport = snapshot.browserReport;
  assert(snapshotReport, 'Snapshot browserReport should exist');
  assert(snapshotReport.status === 'not_available',
    `Snapshot expected not_available, got: ${snapshotReport.status}`);
}

// ---- Test 6: Non-browser run never gets browserReport ----
async function assertNonBrowserNoReport(cookie, agent) {
  const objective = `browser-filesystem-nonregression ${STAMP}: write file with no browser`;
  const ticket = await createTicket(cookie, agent.id, objective);
  const run = await waitForTerminalRun(ticket.id);
  assert(run.status === 'completed', `Filesystem run should complete: ${run.error || run.status}`);
  assert(fs.readFileSync(path.join(WORKSPACE_ROOT, FILESYSTEM_FILE), 'utf8') === 'report-fs-ok',
    'Filesystem run did not write expected content');
  const runWithEval = await waitForRunEvaluation(ticket.id);

  assert(runWithEval.browserReport === undefined || runWithEval.browserReport === null,
    'Non-browser run should not have browserReport');

  const snapshot = readReplay(run);
  // Snapshot may have browserReport:null from snapshot base initialization
  // but should not have browserReport set to 'available'
  if (snapshot.browserReport) {
    assert(snapshot.browserReport.status !== 'available',
      'Non-browser run snapshot should not have available browserReport');
  }
}

// ---- Test 7: Browser allowed operations remain unchanged ----
async function assertAllowedOperationsUnchanged(cookie, agent) {
  const objective = `BROWSER_REPORT_AVAILABLE ${STAMP}: verify allowed ops via report run`;
  const ticket = await createTicket(cookie, agent.id, objective, 'report-test');
  const run = await waitForTerminalRun(ticket.id);
  assert(run.status === 'completed', `Allowed ops test run should complete: ${run.error || run.status}`);
  await waitForRunEvaluation(ticket.id);
  const snapshot = readReplay(run);
  const primitiveContract = snapshot.primitiveContract || {};
  const allowedOps = primitiveContract.allowedOperations || [];
  assert(allowedOps.includes('navigate'), 'navigate should be allowed');
  assert(allowedOps.includes('observe'), 'observe should be allowed');
  assert(allowedOps.includes('readPageText'), 'readPageText should be allowed');
  assert(allowedOps.includes('screenshot'), 'screenshot should be allowed');
  assert(allowedOps.includes('wait'), 'wait should be allowed');
  assert(allowedOps.length === 5, `Expected exactly 5 browser allowed operations, got ${allowedOps.length}`);
  const mutatingOps = primitiveContract.mutatingOperations || [];
  assert(mutatingOps.length === 0, 'Browser operations should have no mutating operations');
}

async function main() {
  const fixtureCounts = { content: 0 };
  const fixtureServer = await startFixtureServer(FIXTURE_PORT, (req, res) => {
    if (req.url && req.url.includes('/minimal')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<html><head><title>Minimal</title></head><body><p>A page with no interactive elements.</p></body></html>');
    } else {
      fixtureCounts.content += 1;
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<html><head><title>Content page</title></head><body><h1>Heading</h1><p>Some page text for testing.</p><a href="/page2">Link 1</a><button>Click</button><input placeholder="search"/></body></html>');
    }
  });
  const preloadPath = createModelPreload();
  const agent = seedAgent();
  let appServer = null;
  try {
    const executablePath = findEngineExecutable();
    if (!executablePath) {
      console.log('SKIP: no browser engine executable found (BROWSER_ENGINE_EXECUTABLE or system Chromium)');
      console.log('Tests require a live browser engine to produce real browser operations.');
      process.exit(0);
    }

    appServer = await startServer(preloadPath, executablePath);
    let cookie = await login();

    // 1. Browser report available on run
    const reportRecord = await assertBrowserReportAvailableOnRun(cookie, agent, fixtureCounts);
    console.log('PASS browser report available on run record');

    // 2. Browser report persisted on replay snapshot
    await assertBrowserReportOnSnapshot(reportRecord);
    console.log('PASS browser report persisted on replay snapshot');

    // 3. Browser evidence status independent
    await assertEvidenceIndependent(reportRecord);
    console.log('PASS browser evidence status independent');

    // 4. Objective success remains unverified
    await assertObjectiveUnverified(reportRecord);
    console.log('PASS objective success remains unverified');

    // 5. Browser report not available for runs without usable message
    await assertBrowserReportNotAvailable(cookie, agent, fixtureCounts);
    console.log('PASS browser report not available for no-message runs');

    // 6. Non-browser run never gets browserReport
    await assertNonBrowserNoReport(cookie, agent);
    console.log('PASS non-browser run does not get browserReport');

    // 7. Browser allowed operations unchanged
    await assertAllowedOperationsUnchanged(cookie, agent);
    console.log('PASS browser allowed operations unchanged');

    console.log(JSON.stringify({
      reportAvailableOnRun: true,
      reportOnSnapshot: true,
      evidenceIndependent: true,
      objectiveUnverified: true,
      reportNotAvailable: true,
      nonBrowserNoReport: true,
      allowedOpsUnchanged: true
    }));
  } finally {
    await stopServer(appServer);
    fixtureServer.closeAllConnections();
    await new Promise(resolve => fixtureServer.close(resolve));
    fs.rmSync(preloadPath, { force: true });
    removeTempWorkspaceRoot(WORKSPACE_ROOT);
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
  }
}

main().then(() => process.exit(0)).catch(error => {
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});

'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { createTempWorkspaceRoot, removeTempWorkspaceRoot } = require('./test-workspace');

const ROOT = path.resolve(__dirname, '..');
const REAL_DATA_DIR = path.join(ROOT, 'data');
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-evidence-data-'));
const WORKSPACE_ROOT = createTempWorkspaceRoot('browser-evidence-audit');
const APP_PORT = Number(process.env.BROWSER_EVIDENCE_TEST_PORT || 3611);
const FIXTURE_PORT = Number(process.env.BROWSER_EVIDENCE_FIXTURE_PORT || 3612);
const BLOCKED_PORT = Number(process.env.BROWSER_EVIDENCE_BLOCKED_PORT || 3613);
const BASE_URL = `http://127.0.0.1:${APP_PORT}`;
const FIXTURE_ORIGIN = `http://127.0.0.1:${FIXTURE_PORT}`;
const BLOCKED_ORIGIN = `http://127.0.0.1:${BLOCKED_PORT}`;
const STAMP = `${process.pid}-${Date.now()}`;
const FILESYSTEM_FILE = `browser-evidence-fs-${STAMP}.txt`;

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
    id: 'evidence-test', name: 'Evidence Test', status: 'active',
    allowedOrigins: [FIXTURE_ORIGIN], startUrl: `${FIXTURE_ORIGIN}/content`,
    limits: targetLimits
  }
]);

function seedAgent() {
  const agents = readJson('agents.json');
  const agent = {
    id: Math.max(0, ...agents.map(item => item.id || 0)) + 1,
    name: `EvidenceAgent-${STAMP}`,
    type: 'agent', provider: 'openai', model: 'gpt-4.1-mini', apiKey: 'evidence-test-key',
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

// ---- Model preload with deterministic evidence audit scenarios ----
function createModelPreload() {
  const preloadPath = path.join(os.tmpdir(), `browser-evidence-model-${STAMP}.js`);
  const source = `
global.fetch = async function(_url, options = {}) {
  const body = JSON.parse(options.body || '{}');
  const combined = (body.input || []).map(item => String(item && item.content || '')).join('\\\\n');
  let plan;
  if (combined.includes('EVIDENCE_SORRY')) {
    plan = { message: 'Navigate, see the sorry page, complete.', actions: [
      { operation: 'navigate', args: { url: process.env.TEST_SORRY_URL } },
      { operation: 'wait', args: { forMs: 500 } },
      { operation: 'observe', args: {} }
    ], complete: true };
  } else if (combined.includes('EVIDENCE_STATIC_CONTENT')) {
    plan = { message: 'Navigate to static page, read text, observe.', actions: [
      { operation: 'navigate', args: { url: process.env.TEST_FIXTURE_URL } },
      { operation: 'wait', args: { forMs: 200 } },
      { operation: 'readPageText', args: {} },
      { operation: 'observe', args: {} }
    ], complete: true };
  } else if (combined.includes('EVIDENCE_LOW_OBSERVE')) {
    plan = { message: 'Navigate to minimal page, observe few elements, complete without reading text.', actions: [
      { operation: 'navigate', args: { url: process.env.TEST_MINIMAL_URL } },
      { operation: 'observe', args: {} }
    ], complete: true };
  } else if (combined.includes('EVIDENCE_NO_BROWSER_OPS')) {
    plan = { message: 'Complete without any browser operations.', actions: [], complete: true };
  } else if (combined.includes('EVIDENCE_COMPLETED_NOOP')) {
    plan = { message: 'Navigate to minimal page, wait, complete without content.', actions: [
      { operation: 'navigate', args: { url: process.env.TEST_MINIMAL_URL } },
      { operation: 'wait', args: { forMs: 200 } }
    ], complete: true };
  } else if (combined.includes('browser-filesystem-nonregression')) {
    plan = { message: 'Write a file to test filesystem isolation.', actions: [{ operation: 'writeFile', args: { path: process.env.TEST_FILESYSTEM_FILE, content: 'fs-ok' } }], complete: true };
  } else {
    plan = { message: 'No matching test plan.', actions: [], complete: true };
  }
  return {
    ok: true, status: 200, headers: new Map([['x-request-id', 'evidence-test']]),
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
    TEST_SORRY_URL: `${FIXTURE_ORIGIN}/sorry/index`,
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

function getBrowserEvidenceFromSnapshot(snapshot) {
  assert(snapshot, 'Snapshot is null');
  return {
    status: snapshot.browserEvidenceStatus || null,
    detail: snapshot.browserEvidenceDetail || null
  };
}

// ---- Test: not_applicable for non-browser runs ----
async function assertFilesystemNonRegression(cookie, agent) {
  const objective = `browser-filesystem-nonregression ${STAMP}: write file to test filesystem isolation`;
  const ticket = await createTicket(cookie, agent.id, objective);
  const run = await waitForTerminalRun(ticket.id);
  assert(run.status === 'completed', `Filesystem run did not complete: ${run.error || run.status}`);
  assert(fs.readFileSync(path.join(WORKSPACE_ROOT, FILESYSTEM_FILE), 'utf8') === 'fs-ok', 'Filesystem run did not write expected content');
  const runWithEval = await waitForRunEvaluation(ticket.id);
  const evaluation = runWithEval.runEvaluation || {};
  const browserEvidence = evaluation.browserEvidence || {};
  assert(browserEvidence.status === 'not_applicable', `Non-browser run should have not_applicable browser evidence, got: ${browserEvidence.status}`);
  const snapshot = readReplay(run);
  assert(!Object.prototype.hasOwnProperty.call(snapshot, 'browserOperations'), 'Filesystem replay gained browserOperations');
  assert(snapshot.browserEvidenceStatus == null || snapshot.browserEvidenceStatus === 'not_applicable', 'Snapshot should not have browser evidence status for non-browser run');
}

// ---- Test: target_blocked_or_redirected for /sorry/index ----
async function assertSorryIndexClassified(cookie, agent, fixtureCounts) {
  const objective = `EVIDENCE_SORRY ${STAMP}: navigate to sorry page`;
  const ticket = await createTicket(cookie, agent.id, objective, 'evidence-test');
  const run = await waitForTerminalRun(ticket.id);
  assert(run.status === 'completed', `Sorry-index run should complete: ${run.error || run.status}`);
  const runWithEval = await waitForRunEvaluation(ticket.id);
  const evidence = getBrowserEvidenceFromRun(runWithEval);
  assert(evidence.status === 'target_blocked_or_redirected',
    `Expected target_blocked_or_redirected, got: ${evidence.status} (detail: ${evidence.detail})`);
  assert(evidence.detail && evidence.detail.includes('/sorry/'),
    `Detail should mention /sorry/, got: ${evidence.detail}`);
  const snapshot = readReplay(run);
  const snapshotEvidence = getBrowserEvidenceFromSnapshot(snapshot);
  assert(snapshotEvidence.status === 'target_blocked_or_redirected',
    `Snapshot browserEvidenceStatus should be target_blocked_or_redirected, got: ${snapshotEvidence.status}`);
}

// ---- Test: evidence_available for static page with readPageText ----
async function assertStaticContentClassified(cookie, agent, fixtureCounts) {
  const objective = `EVIDENCE_STATIC_CONTENT ${STAMP}: navigate and read page text`;
  const ticket = await createTicket(cookie, agent.id, objective, 'evidence-test');
  const run = await waitForTerminalRun(ticket.id);
  assert(run.status === 'completed', `Static content run should complete: ${run.error || run.status}`);
  assert(fixtureCounts.content > 0, 'Static content fixture was never reached');
  const runWithEval = await waitForRunEvaluation(ticket.id);
  const evidence = getBrowserEvidenceFromRun(runWithEval);
  assert(evidence.status === 'evidence_available',
    `Expected evidence_available, got: ${evidence.status} (detail: ${evidence.detail})`);
  const snapshot = readReplay(run);
  const snapshotEvidence = getBrowserEvidenceFromSnapshot(snapshot);
  assert(snapshotEvidence.status === 'evidence_available',
    `Snapshot browserEvidenceStatus should be evidence_available, got: ${snapshotEvidence.status}`);
}

// ---- Test: browser_evidence_insufficient for low observe / no readPageText ----
async function assertLowObserveClassified(cookie, agent, fixtureCounts) {
  const objective = `EVIDENCE_LOW_OBSERVE ${STAMP}: navigate and observe only`;
  const ticket = await createTicket(cookie, agent.id, objective, 'evidence-test');
  const run = await waitForTerminalRun(ticket.id);
  assert(run.status === 'completed', `Low observe run should complete: ${run.error || run.status}`);
  const runWithEval = await waitForRunEvaluation(ticket.id);
  const evidence = getBrowserEvidenceFromRun(runWithEval);
  assert(evidence.status === 'browser_evidence_insufficient' || evidence.status === 'objective_unverified',
    `Expected insufficient/unverified, got: ${evidence.status}`);
}

// ---- Test: objective_unverified for model completing without browser operations ----
async function assertNoOpsClassified(cookie, agent) {
  const objective = `EVIDENCE_NO_BROWSER_OPS ${STAMP}: complete without browser ops`;
  const ticket = await createTicket(cookie, agent.id, objective, 'evidence-test');
  const run = await waitForTerminalRun(ticket.id);
  assert(run.status === 'completed', `No-ops run should complete: ${run.error || run.status}`);
  const runWithEval = await waitForRunEvaluation(ticket.id);
  const evidence = getBrowserEvidenceFromRun(runWithEval);
  assert(evidence.status === 'objective_unverified',
    `Expected objective_unverified, got: ${evidence.status}`);
}

// ---- Test: operational completion coexists with insufficient evidence ----
async function assertCompletionSeparateFromEvidence(cookie, agent, fixtureCounts) {
  const objective = `EVIDENCE_COMPLETED_NOOP ${STAMP}: complete with weak evidence`;
  const ticket = await createTicket(cookie, agent.id, objective, 'evidence-test');
  const run = await waitForTerminalRun(ticket.id);
  assert(run.status === 'completed', `Completion+weak run should complete: ${run.error || run.status}`);
  const runWithEval = await waitForRunEvaluation(ticket.id);
  const evidence = getBrowserEvidenceFromRun(runWithEval);
  assert(evidence.status === 'browser_evidence_insufficient' || evidence.status === 'objective_unverified',
    `Expected insufficient/unverified for weak evidence, got: ${evidence.status}`);
  // Terminal status is completed (not failed) — independent of browser evidence
  assert(run.status === 'completed', 'Runtime status should remain completed regardless of browser evidence');
}

// ---- Test: allowed operations unchanged ----
async function assertAllowedOperationsUnchanged(cookie, agent) {
  const objective = `EVIDENCE_STATIC_CONTENT ${STAMP}: verify allowed ops via navigate`;
  const ticket = await createTicket(cookie, agent.id, objective, 'evidence-test');
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
  const fixtureCounts = { content: 0, sorry: 0 };
  const fixtureServer = await startFixtureServer(FIXTURE_PORT, (req, res) => {
    if (req.url && req.url.includes('/sorry/index')) {
      fixtureCounts.sorry += 1;
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<html><head><title>Sorry</title></head><body><p>Our systems have detected unusual traffic from your computer network.</p></body></html>');
    } else if (req.url && req.url.includes('/minimal')) {
      fixtureCounts.content += 1;
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

    // 1. Filesystem non-regression: not_applicable
    await assertFilesystemNonRegression(cookie, agent);
    console.log('PASS not_applicable for non-browser run');

    // 2. /sorry/index → target_blocked_or_redirected
    await assertSorryIndexClassified(cookie, agent, fixtureCounts);
    console.log('PASS target_blocked_or_redirected for /sorry/index');

    // 3. Static content with readPageText → evidence_available
    await assertStaticContentClassified(cookie, agent, fixtureCounts);
    console.log('PASS evidence_available for static content');

    // 4. Low observe / no readPageText → browser_evidence_insufficient
    await assertLowObserveClassified(cookie, agent, fixtureCounts);
    console.log('PASS browser_evidence_insufficient for low observe');

    // 5. No browser ops → objective_unverified
    await assertNoOpsClassified(cookie, agent);
    console.log('PASS objective_unverified for no browser ops');

    // 6. Completion status separate from browser evidence
    await assertCompletionSeparateFromEvidence(cookie, agent, fixtureCounts);
    console.log('PASS completion status independent of browser evidence');

    // 7. Allowed browser operations unchanged
    await assertAllowedOperationsUnchanged(cookie, agent);
    console.log('PASS allowed browser operations unchanged');

    console.log(JSON.stringify({
      notApplicable: true,
      targetBlockedOrRedirected: true,
      evidenceAvailable: true,
      evidenceInsufficient: true,
      objectiveUnverified: true,
      completionSeparate: true,
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

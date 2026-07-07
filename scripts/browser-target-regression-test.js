'use strict';

const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { createTempWorkspaceRoot, removeTempWorkspaceRoot } = require('./test-workspace');

const ROOT = path.resolve(__dirname, '..');
const REAL_DATA_DIR = path.join(ROOT, 'data');
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-target-data-'));
const WORKSPACE_ROOT = createTempWorkspaceRoot('browser-target');
const APP_PORT = Number(process.env.BROWSER_TARGET_TEST_PORT || 3433);
const FIXTURE_PORT = Number(process.env.BROWSER_TARGET_FIXTURE_PORT || 3434);
const BLOCKED_PORT = Number(process.env.BROWSER_TARGET_BLOCKED_PORT || 3435);
const BASE_URL = `http://127.0.0.1:${APP_PORT}`;
const FIXTURE_ORIGIN = `http://127.0.0.1:${FIXTURE_PORT}`;
const BLOCKED_ORIGIN = `http://127.0.0.1:${BLOCKED_PORT}`;
const PAGE_SECRET = 'PAGE_SECRET_SHOULD_NOT_PERSIST';
const STAMP = `${process.pid}-${Date.now()}`;
const FILESYSTEM_FILE = `browser-target-filesystem-${STAMP}.txt`;

const DATA_FILES = [
  'agents.json', 'allocation-plans.json', 'browser-targets.json', 'groups.json', 'logs.json',
  'memberships.json', 'operation-history.json', 'permissions.json', 'runs.json', 'tickets.json',
  'users.json', 'workflows.json'
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

function sha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
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
  waitTimeoutMsCap: 10,
  maxPageTextBytes: 128,
  maxScreenshotsPerRun: 2
};
writeJson('browser-targets.json', [
  {
    id: 'loopback-readonly', name: 'Loopback read-only', status: 'active',
    allowedOrigins: [FIXTURE_ORIGIN], startUrl: `${FIXTURE_ORIGIN}/oversized`, limits: targetLimits
  },
  {
    id: 'loopback-budget', name: 'Loopback navigation budget', status: 'active',
    allowedOrigins: [FIXTURE_ORIGIN], startUrl: `${FIXTURE_ORIGIN}/oversized`,
    limits: { ...targetLimits, maxNavigationsPerRun: 1 }
  }
]);

function seedAgent() {
  const agents = readJson('agents.json');
  const agent = {
    id: Math.max(0, ...agents.map(item => item.id || 0)) + 1,
    name: `BrowserTargetAgent-${STAMP}`,
    type: 'agent', provider: 'openai', model: 'gpt-4.1-mini', apiKey: 'browser-target-test-key',
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
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    const run = readJson('runs.json').filter(item => item.ticketId === ticketId).sort((a, b) => b.id - a.id)[0];
    if (run && ['completed', 'failed', 'interrupted'].includes(run.status)) return run;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for terminal run for ticket ${ticketId}`);
}

async function waitForFileText(file, predicate, label) {
  const filePath = path.join(DATA_DIR, file);
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const text = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '';
    if (predicate(text)) return text;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

function createModelPreload() {
  const preloadPath = path.join(os.tmpdir(), `browser-target-model-${STAMP}.js`);
  const source = `
global.fetch = async function(_url, options = {}) {
  const body = JSON.parse(options.body || '{}');
  const combined = (body.input || []).map(item => String(item && item.content || '')).join('\\n');
  let plan;
  if (combined.includes('browser-engine-missing')) {
    plan = { message: 'Attempt navigation.', actions: [{ operation: 'navigate', args: { url: process.env.TEST_FIXTURE_URL } }], complete: true };
  } else if (combined.includes('browser-origin-blocked')) {
    plan = { message: 'Attempt blocked navigation.', actions: [{ operation: 'navigate', args: { url: process.env.TEST_BLOCKED_URL } }], complete: true };
  } else if (combined.includes('browser-navigation-budget')) {
    plan = { message: 'Navigate twice.', actions: [
      { operation: 'navigate', args: { url: process.env.TEST_FIXTURE_URL } },
      { operation: 'navigate', args: { url: process.env.TEST_FIXTURE_URL } }
    ], complete: true };
  } else if (combined.includes('browser-read-receipts')) {
    plan = { message: 'Collect bounded evidence.', actions: [
      { operation: 'navigate', args: { url: process.env.TEST_FIXTURE_URL } },
      { operation: 'observe', args: {} },
      { operation: 'readPageText', args: {} },
      { operation: 'screenshot', args: {} },
      { operation: 'wait', args: { forMs: 25 } }
    ], complete: true };
  } else if (combined.includes('browser-filesystem-nonregression')) {
    plan = { message: 'Write filesystem fixture.', actions: [{ operation: 'writeFile', args: { path: process.env.TEST_FILESYSTEM_FILE, content: 'filesystem-ok' } }], complete: true };
  } else {
    plan = { message: 'No matching test plan.', actions: [], complete: true };
  }
  return {
    ok: true, status: 200, headers: new Map([['x-request-id', 'browser-target-test']]),
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
    TEST_FIXTURE_URL: `${FIXTURE_ORIGIN}/oversized`,
    TEST_BLOCKED_URL: `${BLOCKED_ORIGIN}/blocked`,
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

async function assertEngineMissing(cookie, agent) {
  const objective = `browser-engine-missing ${STAMP}: navigate to the configured target and report the page`;
  const ticket = await createTicket(cookie, agent.id, objective, 'loopback-readonly');
  const run = await waitForTerminalRun(ticket.id);
  assert(run.status === 'failed', 'Engine-missing browser run did not fail');
  assert(run.error && run.error.includes('Browser engine is unavailable'), 'Engine-missing failure message was not structured');
  const snapshot = readReplay(run);
  const refusal = (snapshot.browserOperations || []).find(item => item.errorCode === 'BROWSER_TARGET_UNAVAILABLE');
  assert(refusal && refusal.status === 'refused', 'Engine-missing refusal missing from browser replay evidence');
  assert(readJson('logs.json').some(log => log.runId === run.id && log.type === 'browser:navigate' && log.errorCode === 'BROWSER_TARGET_UNAVAILABLE'), 'Engine-missing refusal missing from logs');
  await waitForFileText('events.jsonl', text => text.includes('BROWSER_TARGET_UNAVAILABLE'), 'engine-missing refusal event');
  assert(readJson('operation-history.json').some(item => item.runId === run.id && item.errorCode === 'BROWSER_TARGET_UNAVAILABLE'), 'Engine-missing refusal missing from operation history');
}

async function assertFilesystemNonRegression(cookie, agent) {
  const objective = `browser-filesystem-nonregression ${STAMP}: write the requested deterministic test file`;
  const ticket = await createTicket(cookie, agent.id, objective);
  const run = await waitForTerminalRun(ticket.id);
  assert(run.status === 'completed', `Filesystem non-regression run did not complete: ${run.error || run.status}`);
  assert(fs.readFileSync(path.join(WORKSPACE_ROOT, FILESYSTEM_FILE), 'utf8') === 'filesystem-ok', 'Filesystem run did not write expected content');
  assert(run.targetRef == null && run.browserTargetSnapshot == null, 'Filesystem run gained browser target state');
  const snapshot = readReplay(run);
  assert(!Object.prototype.hasOwnProperty.call(snapshot, 'browserOperations'), 'Filesystem replay gained browserOperations');
  assert(!Object.prototype.hasOwnProperty.call(snapshot, 'browserTargetSnapshot'), 'Filesystem replay gained browserTargetSnapshot');
}

async function assertRerunBlockForInactiveTarget(cookie, agent) {
  const targetId = 'rerun-test-target';
  const targets = readJson('browser-targets.json');
  if (!targets.find(t => t.id === targetId)) {
    writeJson('browser-targets.json', [...targets, {
      id: targetId, name: 'Rerun Test Target', status: 'active',
      allowedOrigins: ['https://example.com'], startUrl: 'https://example.com/start',
      limits: { maxNavigationsPerRun: 4, maxActionsPerRun: 8, navTimeoutMs: 5000, waitTimeoutMsCap: 10, maxPageTextBytes: 128, maxScreenshotsPerRun: 2 }
    }]);
  }
  const objective = `rerun-guardrails ${STAMP}: test rerun block for inactive browser target`;
  const ticket = await createTicket(cookie, agent.id, objective, targetId);

  writeJson('browser-targets.json', readJson('browser-targets.json').map(t =>
    t.id === targetId ? { ...t, status: 'inactive' } : t
  ));

  const blockedRerun = await request('POST', `/api/tickets/${ticket.id}/rerun`, { cookie, body: {} });
  assert(blockedRerun.statusCode === 409, `Inactive-target rerun should be blocked with 409, got HTTP ${blockedRerun.statusCode}: ${blockedRerun.body}`);
  assert(blockedRerun.body.includes('no longer active'), `Inactive-target rerun error should mention target status, got: ${blockedRerun.body}`);

  writeJson('browser-targets.json', readJson('browser-targets.json').map(t =>
    t.id === targetId ? { ...t, status: 'active' } : t
  ));

  const allowedRerun = await request('POST', `/api/tickets/${ticket.id}/rerun`, { cookie, body: {} });
  assert(allowedRerun.statusCode === 200, `Active-target rerun should succeed with 200, got HTTP ${allowedRerun.statusCode}: ${allowedRerun.body}`);
  const rerunTicket = JSON.parse(allowedRerun.body).ticket;
  assert(rerunTicket && rerunTicket.id === ticket.id, 'Active-target rerun should return the same ticket');

  writeJson('browser-targets.json', readJson('browser-targets.json').filter(t => t.id !== targetId));
}

async function assertLiveBrowserRuns(cookie, agent, fixtureCounts, blockedCounts) {
  const blockedBefore = blockedCounts.requests;
  const blockedTicket = await createTicket(
    cookie, agent.id,
    `browser-origin-blocked ${STAMP}: navigate to the requested blocked origin and report refusal`,
    'loopback-readonly'
  );
  const blockedRun = await waitForTerminalRun(blockedTicket.id);
  assert(blockedRun.status === 'failed' && blockedRun.error.includes('not allowed'), 'Disallowed origin did not fail');
  const blockedReplay = readReplay(blockedRun);
  assert(blockedReplay.browserOperations.some(item => item.errorCode === 'BROWSER_ORIGIN_BLOCKED'), 'Blocked-origin replay evidence missing');
  assert(blockedCounts.requests === blockedBefore, 'Disallowed origin reached the blocked fixture server');

  const allowedTicket = await createTicket(
    cookie, agent.id,
    `browser-read-receipts ${STAMP}: navigate to the authorized fixture, observe it, read text, capture a screenshot, wait briefly, then complete`,
    'loopback-readonly'
  );
  const allowedRun = await waitForTerminalRun(allowedTicket.id);
  assert(allowedRun.status === 'completed', `Allowed browser run did not complete: ${allowedRun.error || allowedRun.status}`);
  assert(fixtureCounts.requests > 0, 'Allowed loopback navigation did not reach fixture server');
  const snapshot = readReplay(allowedRun);
  assert(snapshot.browserTargetSnapshot && snapshot.browserTargetSnapshot.id === 'loopback-readonly', 'Browser target snapshot missing');
  const operations = snapshot.browserOperations || [];
  assert(operations.length === 5, `Expected five browser receipts, got ${operations.length}`);
  const byName = Object.fromEntries(operations.map(item => [item.operation.operation, item]));
  assert(byName.navigate.receipt.metadata.status === 200, 'Navigation receipt missing HTTP status');
  assert(byName.navigate.receipt.metadata.finalUrl === `${FIXTURE_ORIGIN}/oversized`, 'Navigation receipt final URL mismatch');
  assert(byName.observe.receipt.metadata.elementCount > 0 && byName.observe.receipt.metadata.pageStateHash, 'Observe receipt incomplete');
  assert(byName.readPageText.receipt.truncated === true && byName.readPageText.receipt.metadata.contentHash, 'Page text truncation/hash receipt incomplete');
  assert(byName.wait.receipt.truncated === true && byName.wait.receipt.metadata.waitedMs === 10, 'Wait cap/truncation receipt incomplete');
  const screenshotReceipt = byName.screenshot.receipt.metadata;
  const screenshotPath = path.resolve(DATA_DIR, screenshotReceipt.artifactPath);
  assert(screenshotPath.startsWith(path.resolve(DATA_DIR) + path.sep), 'Screenshot artifact escaped DATA_DIR');
  assert(!screenshotPath.startsWith(path.resolve(WORKSPACE_ROOT) + path.sep), 'Screenshot artifact was placed under WORKSPACE_ROOT');
  assert(fs.existsSync(screenshotPath), 'Screenshot artifact file is missing');
  assert(sha256(screenshotPath) === screenshotReceipt.sha256, 'Screenshot sha256 does not match artifact file');

  const eventLines = fs.readFileSync(path.join(DATA_DIR, 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map(JSON.parse);
  assert(eventLines.filter(event => event.runId === allowedRun.id && event.type === 'browser.operation').length === 5, 'Browser events missing durable operation evidence');
  assert(readJson('logs.json').filter(log => log.runId === allowedRun.id && String(log.type).startsWith('browser:')).length >= 5, 'Browser logs missing durable operation evidence');
  assert(readJson('operation-history.json').filter(item => item.runId === allowedRun.id && item.targetKind === 'browser').length === 5, 'Browser operation history missing durable evidence');
  for (const file of ['events.jsonl', 'logs.json', 'operation-history.json', snapshot.browserOperations ? allowedRun.replaySnapshotPath : '']) {
    if (!file) continue;
    assert(!fs.readFileSync(path.join(DATA_DIR, file), 'utf8').includes(PAGE_SECRET), `Page secret leaked into ${file}`);
  }

  const fixtureBeforeBudget = fixtureCounts.requests;
  const budgetTicket = await createTicket(
    cookie, agent.id,
    `browser-navigation-budget ${STAMP}: attempt two authorized navigations to verify the configured limit`,
    'loopback-budget'
  );
  const budgetRun = await waitForTerminalRun(budgetTicket.id);
  assert(budgetRun.status === 'failed' && budgetRun.error.includes('navigation limit'), 'Navigation budget did not fail the run');
  const budgetReplay = readReplay(budgetRun);
  assert(budgetReplay.browserOperations.some(item => item.errorCode === 'BROWSER_NAV_LIMIT_EXCEEDED'), 'Navigation budget refusal missing from replay');
  assert(fixtureCounts.requests === fixtureBeforeBudget + 1, 'Navigation budget allowed more than one page load');
}

async function main() {
  const fixtureCounts = { requests: 0 };
  const blockedCounts = { requests: 0 };
  const oversizedText = `${PAGE_SECRET} ${'bounded browser page text '.repeat(80)}`;
  const fixtureServer = await startFixtureServer(FIXTURE_PORT, (req, res) => {
    fixtureCounts.requests += 1;
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<html><head><title>Browser fixture</title></head><body><h1>Fixture heading</h1><button>Visible control</button><p>${oversizedText}</p></body></html>`);
  });
  const blockedServer = await startFixtureServer(BLOCKED_PORT, (_req, res) => {
    blockedCounts.requests += 1;
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('must not load');
  });
  const preloadPath = createModelPreload();
  const agent = seedAgent();
  let appServer = null;
  try {
    appServer = await startServer(preloadPath, '/definitely/missing/browser-engine');
    let cookie = await login();
    await assertEngineMissing(cookie, agent);
    console.log('PASS engine-missing refusal');
    await assertFilesystemNonRegression(cookie, agent);
    console.log('PASS filesystem non-regression');
    await stopServer(appServer);
    console.log('PASS missing-engine server shutdown');
    appServer = null;

    const executablePath = findEngineExecutable();
    if (!executablePath) {
      console.log('SKIP live browser checks: no executable BROWSER_ENGINE_EXECUTABLE or system Chromium found');
    } else {
      appServer = await startServer(preloadPath, executablePath);
      cookie = await login();
      await assertRerunBlockForInactiveTarget(cookie, agent);
      await assertLiveBrowserRuns(cookie, agent, fixtureCounts, blockedCounts);
    }
    console.log(JSON.stringify({
      engineMissingRefusal: true,
      filesystemNonRegression: true,
      rerunGuardrails: Boolean(executablePath),
      liveBrowserChecks: Boolean(executablePath)
    }));
  } finally {
    await stopServer(appServer);
    fixtureServer.closeAllConnections();
    blockedServer.closeAllConnections();
    await new Promise(resolve => fixtureServer.close(resolve));
    await new Promise(resolve => blockedServer.close(resolve));
    fs.rmSync(preloadPath, { force: true });
    removeTempWorkspaceRoot(WORKSPACE_ROOT);
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
  }
}

main().then(() => process.exit(0)).catch(error => {
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});

#!/usr/bin/env node
'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const TEST_CASE = process.env.TEST_PROVIDER_RECOVERY_CASE === 'budget' ? 'budget' : 'complete';
const IS_BUDGET_CASE = TEST_CASE === 'budget';
const STAMP = Date.now();
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), `provider-response-recovery-${TEST_CASE}-data-`));
const WORKSPACE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), `provider-response-recovery-${TEST_CASE}-workspace-`));
const PORT = String(5700 + Math.floor(Math.random() * 300));
const BASE_URL = `http://127.0.0.1:${PORT}`;
const INVOCATION_FILE = path.join(DATA_DIR, 'mock-provider-invocations.jsonl');
const FOLDER = `provider-response-recovered-${TEST_CASE}-${STAMP}`;
const REQUIRED_FILE = `${FOLDER}/required.txt`;
const REQUIRED_CONTENT = 'provider-response-budget-recovery';
const OBJECTIVE = IS_BUDGET_CASE
  ? `Create folder ${FOLDER}. Inside it create file required.txt containing exactly ${REQUIRED_CONTENT}`
  : `Create folder ${FOLDER}.`;
const EXPECTED_PLAN = {
  message: IS_BUDGET_CASE
    ? 'Create the first recovery fixture folder, then continue for the required file.'
    : 'Create the recovery fixture folder from the durable provider response.',
  actions: [{ operation: 'createFolder', args: { path: FOLDER } }],
  complete: !IS_BUDGET_CASE
};
const EXPECTED_RESPONSE_TEXT = JSON.stringify(EXPECTED_PLAN);

let server = null;
let serverOutput = '';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(path.join(DATA_DIR, file), 'utf8'));
}

function writeJson(file, value) {
  fs.writeFileSync(path.join(DATA_DIR, file), JSON.stringify(value, null, 2));
}

function readEvents() {
  const file = path.join(DATA_DIR, 'events.jsonl');
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line));
}

function readInvocations() {
  if (!fs.existsSync(INVOCATION_FILE)) return [];
  return fs.readFileSync(INVOCATION_FILE, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line));
}

function readReplay(run) {
  assert(run && run.replaySnapshotPath, `Run ${run && run.id} has no replay snapshot path`);
  return readJson(run.replaySnapshotPath);
}

function httpReq(method, route, options = {}) {
  return new Promise((resolve, reject) => {
    const body = options.form ? new URLSearchParams(options.form).toString() : null;
    const request = http.request(BASE_URL + route, {
      method,
      headers: {
        ...(body ? {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(body)
        } : {}),
        ...(options.cookie ? { Cookie: options.cookie } : {})
      }
    }, response => {
      let responseBody = '';
      response.on('data', chunk => { responseBody += String(chunk); });
      response.on('end', () => resolve({
        status: response.statusCode,
        headers: response.headers,
        body: responseBody
      }));
    });
    request.on('error', reject);
    if (body) request.write(body);
    request.end();
  });
}

async function waitFor(check, timeoutMs = 30000, intervalMs = 100) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await check();
    if (result) return result;
    await sleep(intervalMs);
  }
  throw new Error('Timed out waiting for provider-response recovery test state');
}

function seedData() {
  for (const file of ['users.json', 'agents.json', 'groups.json', 'memberships.json', 'permissions.json', 'workflows.json']) {
    fs.copyFileSync(path.join(ROOT, 'data', file), path.join(DATA_DIR, file));
  }
  writeJson('tickets.json', []);
  writeJson('runs.json', []);
  writeJson('logs.json', []);
  writeJson('operation-history.json', []);
  writeJson('allocation-plans.json', []);
  fs.writeFileSync(path.join(DATA_DIR, 'events.jsonl'), '');

  const agents = readJson('agents.json');
  const agentId = agents.reduce((maximum, agent) => Math.max(maximum, Number(agent.id) || 0), 0) + 1;
  agents.push({
    id: agentId,
    name: 'Provider Response Recovery Agent',
    description: 'Deterministic restart-boundary regression agent',
    provider: 'openai',
    model: 'provider-response-recovery-test',
    apiKey: 'test-key',
    groupIds: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  });
  writeJson('agents.json', agents);
  return agentId;
}

function createProviderPreload() {
  const preloadPath = path.join(os.tmpdir(), `provider-response-recovery-preload-${process.pid}-${STAMP}.js`);
  const source = `
'use strict';
const fs = require('fs');

function recordInvocation(record) {
  const descriptor = fs.openSync(process.env.TEST_PROVIDER_INVOCATION_FILE, 'a');
  try {
    fs.writeSync(descriptor, JSON.stringify(record) + '\\n');
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

global.fetch = async function(_url, options = {}) {
  const requestBody = JSON.parse(options.body || '{}');
  recordInvocation({
    invokedAt: new Date().toISOString(),
    model: requestBody.model || null,
    requestBody
  });
  const plan = {
    message: process.env.TEST_PROVIDER_RECOVERY_MESSAGE,
    actions: [{ operation: 'createFolder', args: { path: process.env.TEST_PROVIDER_RECOVERY_FOLDER } }],
    complete: process.env.TEST_PROVIDER_RECOVERY_COMPLETE === 'true'
  };
  return {
    ok: true,
    status: 200,
    headers: new Map([['x-request-id', 'provider-response-recovery-test']]),
    async text() {
      return JSON.stringify({
        output_text: JSON.stringify(plan),
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 }
      });
    }
  };
};
`;
  fs.writeFileSync(preloadPath, source);
  return preloadPath;
}

async function startServer(preloadPath, interruptAfterResponse) {
  serverOutput = '';
  const env = {
    ...process.env,
    NODE_ENV: 'test',
    PORT,
    DATA_DIR,
    WORKSPACE_ROOT,
    NODE_OPTIONS: [process.env.NODE_OPTIONS, `--require ${preloadPath}`].filter(Boolean).join(' '),
    TEST_PROVIDER_INVOCATION_FILE: INVOCATION_FILE,
    TEST_PROVIDER_RECOVERY_FOLDER: FOLDER,
    TEST_PROVIDER_RECOVERY_MESSAGE: EXPECTED_PLAN.message,
    TEST_PROVIDER_RECOVERY_COMPLETE: String(EXPECTED_PLAN.complete),
    RUNTIME_SCHEDULER_INTERVAL_MS: '100',
    AGENT_MAX_MODEL_REQUESTS_PER_RUN: '1'
  };
  if (interruptAfterResponse) {
    env.TEST_INTERRUPT_AFTER_AGENT_PROVIDER_RESPONSE_PERSISTED = 'true';
  }
  server = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  server.stdout.on('data', chunk => { serverOutput += String(chunk); });
  server.stderr.on('data', chunk => { serverOutput += String(chunk); });
  await waitFor(async () => {
    if (server && server.exitCode !== null) {
      throw new Error(`Server exited during startup: ${serverOutput.slice(-2000)}`);
    }
    try {
      const response = await httpReq('GET', '/login');
      return response.status === 200;
    } catch (_) {
      return false;
    }
  }, 15000, 100);
}

async function stopServer() {
  if (!server) return;
  if (server.exitCode === null && server.signalCode === null) {
    server.kill('SIGTERM');
    await sleep(500);
  }
  if (server.exitCode === null && server.signalCode === null) server.kill('SIGKILL');
  server = null;
}

async function waitForCrash(runId) {
  try {
    await waitFor(() => readEvents().some(event => event.runId === runId &&
      event.type === 'interruption.test_hook' &&
      event.payload && event.payload.point === 'after_agent_provider_response_persisted'
    ), 15000, 100);
  } catch (error) {
    const run = readJson('runs.json').find(item => item.id === runId) || null;
    const replay = run && run.replaySnapshotPath && fs.existsSync(path.join(DATA_DIR, run.replaySnapshotPath))
      ? readReplay(run)
      : null;
    throw new Error(`Provider-response interruption was not reached: ${JSON.stringify({
      run,
      invocations: readInvocations(),
      replay,
      logs: runLogs(runId),
      events: readEvents().filter(event => event.runId === runId)
    })}`);
  }
  await waitFor(() => server && (server.exitCode !== null || server.signalCode !== null), 15000, 100);
  server = null;
}

async function login() {
  const response = await httpReq('POST', '/login', {
    form: { username: 'admin', password: 'admin123' }
  });
  assert(response.status === 302, `Login returned HTTP ${response.status}`);
  const setCookie = Array.isArray(response.headers['set-cookie'])
    ? response.headers['set-cookie'][0]
    : response.headers['set-cookie'];
  const match = String(setCookie || '').match(/sessionId=([^;]+)/);
  assert(match, 'Login did not set a session cookie');
  return `sessionId=${match[1]}`;
}

async function createTicket(cookie, agentId) {
  const response = await httpReq('POST', '/tickets', {
    cookie,
    form: {
      objective: OBJECTIVE,
      assignmentTargetType: 'agent',
      assignmentTargetId: String(agentId),
      assignmentMode: 'individual'
    }
  });
  assert(response.status === 302, `Ticket creation returned HTTP ${response.status}`);
  return waitFor(() => {
    const ticket = readJson('tickets.json').find(item => item.objective === OBJECTIVE);
    if (!ticket) return null;
    const run = readJson('runs.json').find(item => item.ticketId === ticket.id);
    return run ? { ticket, run } : null;
  }, 15000, 100);
}

async function waitForTerminalRun(runId) {
  return waitFor(() => {
    const run = readJson('runs.json').find(item => item.id === runId);
    return run && ['completed', 'failed', 'interrupted'].includes(run.status) ? run : null;
  }, 45000, 100);
}

function runLogs(runId) {
  const logs = fs.existsSync(path.join(DATA_DIR, 'logs.json')) ? readJson('logs.json') : [];
  return logs.filter(log => log && log.runId === runId);
}

async function runScenario() {
  const agentId = seedData();
  const preloadPath = createProviderPreload();

  try {
    await startServer(preloadPath, true);
    const cookie = await login();
    const { run } = await createTicket(cookie, agentId);
    await waitForCrash(run.id);

    const crashedRun = readJson('runs.json').find(item => item.id === run.id);
    const beforeReplay = readReplay(crashedRun);
    const beforeRequests = beforeReplay.providerRequests || [];
    const beforeResponses = beforeReplay.modelResponses || [];
    const beforePlans = beforeReplay.parsedModelPlans || [];
    const originalRequest = beforeRequests[0];
    const originalResponse = beforeResponses[0];

    assert(readInvocations().length === 1, 'Expected exactly one provider invocation before restart');
    assert(beforeRequests.length === 1, `Expected one provider request before restart, got ${beforeRequests.length}`);
    assert(beforeResponses.length === 1, `Expected one provider response before restart, got ${beforeResponses.length}`);
    assert(beforePlans.length === 0, `Expected zero parsed plans before restart, got ${beforePlans.length}`);
    assert(originalResponse.text === EXPECTED_RESPONSE_TEXT, 'Durable response text differs from the provider response');

    await startServer(preloadPath, false);
    const finalRun = await waitForTerminalRun(run.id);
    const afterReplay = readReplay(finalRun);
    const matchingRequests = (afterReplay.providerRequests || []).filter(request =>
      request.executionTurn === originalRequest.executionTurn &&
      request.modelCallKey === originalRequest.modelCallKey
    );
    const matchingResponses = (afterReplay.modelResponses || []).filter(response =>
      response.executionTurn === originalResponse.executionTurn &&
      response.modelCallKey === originalResponse.modelCallKey
    );
    const matchingPlans = (afterReplay.parsedModelPlans || []).filter(plan =>
      plan.executionTurn === originalResponse.executionTurn &&
      plan.modelCallKey === originalResponse.modelCallKey
    );
    const parsedPlan = matchingPlans[0];
    const logs = runLogs(run.id);
    const events = readEvents().filter(event => event.runId === run.id);

    assert(readInvocations().length === 1, `Recovery issued a replacement provider invocation; count=${readInvocations().length}`);
    assert(matchingRequests.length === 1, `Expected one request for the recovered turn, got ${matchingRequests.length}`);
    assert(matchingResponses.length === 1, `Expected one response for the recovered turn, got ${matchingResponses.length}`);
    assert(matchingPlans.length === 1, `Expected one parsed plan for the recovered turn, got ${matchingPlans.length}`);
    assert(originalResponse.providerRequestEvidenceKey === originalRequest.evidenceKey,
      'Response does not directly link to the original request evidence');
    assert(parsedPlan.providerResponseEvidenceKey === originalResponse.evidenceKey,
      'Parsed plan does not directly link to the original response evidence');
    assert(parsedPlan.executionTurn === originalResponse.executionTurn,
      'Parsed plan executionTurn differs from the durable response');
    assert(parsedPlan.modelCallKey === originalResponse.modelCallKey,
      'Parsed plan modelCallKey differs from the durable response');
    assert(parsedPlan.message === EXPECTED_PLAN.message, 'Production parser did not preserve the durable plan message');
    assert(Array.isArray(parsedPlan.actions) && parsedPlan.actions.length === 1 &&
      parsedPlan.actions[0].operation === 'createFolder' &&
      parsedPlan.actions[0].args.path === FOLDER,
    'Production parser did not produce the intended durable action');
    assert(fs.existsSync(path.join(WORKSPACE_ROOT, FOLDER)), 'Recovered parsed plan did not execute its intended action');
    assert((afterReplay.providerRequests || []).length === 1,
      'Recovery consumed another persisted provider budget unit');
    assert((afterReplay.modelResponses || []).length === 1,
      'Recovery persisted a duplicate provider response');
    assert((afterReplay.parsedModelPlans || []).length === 1,
      'Recovery persisted the parsed plan more than once');
    assert(logs.filter(log => log.type === 'model:request').length === 1,
      'Recovery appended a second model:request log');
    assert(logs.filter(log => log.type === 'model:response').length === 0,
      'The crash seam deliberately precedes model:response logging; recovery must not add a replacement log');
    assert(logs.filter(log => log.type === 'run:resume_response_parse').length === 1,
      'Expected exactly one run:resume_response_parse observability log');

    if (IS_BUDGET_CASE) {
      const failure = afterReplay.failure || (finalRun.replaySnapshot && finalRun.replaySnapshot.failure) || null;
      const limitLogs = logs.filter(log => log.type === 'run:model_request_limit');
      assert(finalRun.status === 'failed', `Budget recovery run ended with status ${finalRun.status}`);
      assert(failure && failure.code === 'RUN_LIMIT_EXCEEDED',
        `Expected RUN_LIMIT_EXCEEDED failure, got ${JSON.stringify(failure)}`);
      assert(failure.kind === 'budget_exhausted',
        `Expected budget_exhausted failure kind, got ${failure.kind}`);
      assert(failure.detail && failure.detail.limitType === 'model_request' &&
        failure.detail.currentValue === 1 && failure.detail.configuredLimit === 1,
      `Unexpected model-request failure detail: ${JSON.stringify(failure.detail)}`);
      assert(limitLogs.length === 1,
        `Expected one run:model_request_limit log, got ${limitLogs.length}`);
      assert(!fs.existsSync(path.join(WORKSPACE_ROOT, REQUIRED_FILE)),
        'Budget fixture unexpectedly completed without its required next-turn action');
    } else {
      assert(finalRun.status === 'completed', `Recovered run ended with status ${finalRun.status}`);
      assert(!finalRun.triage || finalRun.triage.required !== true, 'Valid recovered response entered triage');
      assert(!events.some(event => event.type === 'run.triage_created'), 'Valid recovered response emitted RUN_RESUME_UNSAFE triage');
    }

    console.log(JSON.stringify({
      providerResponseRecovery: true,
      scenario: TEST_CASE,
      runStatus: finalRun.status,
      providerInvocations: readInvocations().length,
      providerRequests: (afterReplay.providerRequests || []).length,
      providerResponses: (afterReplay.modelResponses || []).length,
      parsedPlans: (afterReplay.parsedModelPlans || []).length,
      modelRequestLogs: logs.filter(log => log.type === 'model:request').length,
      modelResponseLogs: logs.filter(log => log.type === 'model:response').length,
      requestEvidenceKey: originalRequest.evidenceKey,
      responseProviderRequestEvidenceKey: originalResponse.providerRequestEvidenceKey,
      responseEvidenceKey: originalResponse.evidenceKey,
      planProviderResponseEvidenceKey: parsedPlan.providerResponseEvidenceKey,
      executionTurn: originalResponse.executionTurn,
      modelCallKey: originalResponse.modelCallKey,
      failure: afterReplay.failure || null
    }));
  } finally {
    await stopServer();
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
    fs.rmSync(WORKSPACE_ROOT, { recursive: true, force: true });
    try { fs.unlinkSync(preloadPath); } catch (_) {}
  }
}

function runBudgetScenario() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [__filename], {
      cwd: ROOT,
      env: { ...process.env, TEST_PROVIDER_RECOVERY_CASE: 'budget' },
      stdio: 'inherit'
    });
    child.on('error', reject);
    child.on('exit', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`Budget recovery scenario failed with ${signal || `exit code ${code}`}`));
    });
  });
}

async function main() {
  await runScenario();
  if (!IS_BUDGET_CASE) await runBudgetScenario();
}

main().catch(async error => {
  await stopServer();
  console.error(error.stack || error.message);
  if (serverOutput) console.error(serverOutput.slice(-3000));
  process.exit(1);
});

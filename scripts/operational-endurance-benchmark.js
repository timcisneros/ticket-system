const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { createTempWorkspaceRoot, removeTempWorkspaceRoot } = require('./test-workspace');

const ROOT = path.resolve(__dirname, '..');
const REAL_DATA_DIR = path.join(ROOT, 'data');
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'operational-endurance-data-'));
const WORKSPACE_ROOT = createTempWorkspaceRoot('operational-endurance');
const PORT = process.env.PORT || '3448';
const BASE_URL = `http://127.0.0.1:${PORT}`;
const STAMP = Date.now();
const REAL_MODE = process.env.REAL_MODEL_BENCHMARK === '1';
function positiveIntegerEnv(name, fallback) {
  const value = parseInt(process.env[name] || '', 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}
const BENCHMARK_AGENT_RUNTIME_MS = positiveIntegerEnv('BENCHMARK_AGENT_RUNTIME_MS', 5000);
const RUN_WAIT_TIMEOUT_MS = positiveIntegerEnv('BENCHMARK_RUN_WAIT_TIMEOUT_MS', 20000);
function isTimeoutFailure(reason) {
  return /timeout|timed out|runtime duration limit/i.test(String(reason || ''));
}
function maybeWarnSlowLocalModelBudget() {
  if (!REAL_MODE) return;
  if (BENCHMARK_AGENT_RUNTIME_MS < 180000 || RUN_WAIT_TIMEOUT_MS < 180000) {
    console.warn('[benchmark] REAL_MODEL_BENCHMARK=1 with runtimeLimitMs=' + BENCHMARK_AGENT_RUNTIME_MS + ' waitTimeoutMs=' + RUN_WAIT_TIMEOUT_MS + '; slow local models may need BENCHMARK_AGENT_RUNTIME_MS=180000 and BENCHMARK_RUN_WAIT_TIMEOUT_MS=180000 minimum, 300000 comfortable.');
  }
}
const CYCLES = Math.max(1, parseInt(process.env.ENDURANCE_CYCLES || process.argv[2] || '10', 10) || 10);
const DATA_FILES = [
  'agents.json',
  'allocation-plans.json',
  'events.jsonl',
  'groups.json',
  'logs.json',
  'memberships.json',
  'operation-history.json',
  'permissions.json',
  'runs.json',
  'tickets.json',
  'users.json',
  'workflows.json'
];

for (const file of DATA_FILES) {
  const src = path.join(REAL_DATA_DIR, file);
  const dst = path.join(DATA_DIR, file);
  if (file === 'events.jsonl') {
    fs.writeFileSync(dst, '');
  } else {
    fs.writeFileSync(dst, fs.existsSync(src) ? fs.readFileSync(src, 'utf8') : '[]');
  }
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

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function seedAgent() {
  const agents = readJson('agents.json');
  const agent = {
    id: Math.max(0, ...agents.map(item => item.id || 0)) + 1,
    name: `OperationalEnduranceAgent-${STAMP}`,
    type: 'agent',
    provider: 'openai',
    model: 'gpt-4.1-mini',
    apiKey: 'test-key-operational-endurance',
    createdAt: new Date().toISOString()
  };
  writeJson('agents.json', [...agents.filter(item => item.name !== agent.name), agent]);
  return agent;
}

function createFakeOpenAIPreload() {
  const preloadPath = path.join(os.tmpdir(), `operational-endurance-openai-${process.pid}-${STAMP}.js`);
  const source = `
function okResponse(plan) {
  return {
    ok: true,
    status: 200,
    headers: new Map([['x-request-id', 'fake-operational-endurance']]),
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
  const match = combined.match(/endurance-repair-cycle-(\\d+)-${STAMP}/);
  const cycle = match ? Number(match[1]) : 0;
  const repairId = 'endurance-repair-' + cycle + '-${STAMP}';
  const path = 'endurance-cycle-' + cycle + '-repaired-${STAMP}.txt';
  return okResponse({
    message: 'Creating disabled endurance repair workflow draft.',
    actions: [{
      operation: 'createWorkflowDraft',
      args: {
        workflow: {
          id: repairId,
          name: 'Endurance repaired workflow ' + cycle,
          inputSchema: { content: 'string' },
          actions: [
            { id: 'write', action: 'writeFile', input: { path, content: '{{workflow.input.content}}' }, next: 'done' },
            { id: 'done', action: 'stop', input: { result: { path, repaired: true } } }
          ],
          postconditions: [
            { id: 'file-exists', type: 'fileExists', path },
            { id: 'file-contains', type: 'fileContains', path, contains: '{{workflow.input.content}}' },
            { id: 'repaired-output', type: 'outputFieldEquals', field: 'repaired', equals: true }
          ]
        }
      }
    }],
    complete: true
  });
};
`;
  fs.writeFileSync(preloadPath, source);
  return preloadPath;
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

async function login() {
  const response = await request('POST', '/login', {
    form: { username: 'admin', password: 'admin123' }
  });
  assert(response.statusCode === 302, `Admin login failed with HTTP ${response.statusCode}`);
  return cookieFrom(response);
}

async function createWorkflowDraft(cookie, workflow) {
  const response = await request('POST', '/admin/workflows', {
    cookie,
    form: { definition: JSON.stringify({ ...workflow, enabled: false }, null, 2) }
  });
  assert(response.statusCode === 302, `Workflow draft create failed with HTTP ${response.statusCode}: ${response.body}`);
  const draft = readJson('workflows.json').find(item => item.id === workflow.id);
  assert(draft && draft.enabled === false, `Workflow draft ${workflow.id} was not saved disabled`);
  return draft;
}

async function enableWorkflow(cookie, workflow) {
  const response = await request('POST', `/admin/workflows/${encodeURIComponent(workflow.id)}`, {
    cookie,
    form: {
      definition: JSON.stringify({
        ...workflow,
        enabled: true,
        updatedAt: new Date().toISOString()
      }, null, 2)
    }
  });
  assert(response.statusCode === 302, `Workflow enable failed with HTTP ${response.statusCode}: ${response.body}`);
  const enabled = readJson('workflows.json').find(item => item.id === workflow.id);
  assert(enabled && enabled.enabled === true, `Workflow ${workflow.id} was not enabled`);
  return enabled;
}

async function createAgentTicket(cookie, agent, objective) {
  const response = await request('POST', '/tickets', {
    cookie,
    form: {
      objective,
      assignmentTargetType: 'agent',
      assignmentTargetId: String(agent.id),
      assignmentMode: 'individual'
    }
  });
  assert(response.statusCode === 302, `Agent ticket create failed with HTTP ${response.statusCode}: ${response.body}`);
  return readJson('tickets.json').find(ticket => ticket.objective === objective);
}

async function createWorkflowTicket(cookie, agent, workflow, workflowInput, objective) {
  const response = await request('POST', '/tickets', {
    cookie,
    form: {
      objective,
      capabilityType: 'workflow',
      workflowId: workflow.id,
      workflowInput: JSON.stringify(workflowInput || {}),
      assignmentTargetType: 'agent',
      assignmentTargetId: String(agent.id),
      assignmentMode: 'individual'
    }
  });
  assert(response.statusCode === 302, `Workflow ticket create failed with HTTP ${response.statusCode}: ${response.body}`);
  return readJson('tickets.json').find(ticket => ticket.objective === objective);
}

async function waitForTerminalRun(ticketId) {
  const started = Date.now();
  while (Date.now() - started < RUN_WAIT_TIMEOUT_MS) {
    const runs = readJson('runs.json').filter(run => run.ticketId === ticketId);
    const run = runs[runs.length - 1];
    if (run && ['completed', 'failed', 'interrupted'].includes(run.status)) return run;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for terminal run for ticket ${ticketId}`);
}

async function getRunState(cookie, runId) {
  const response = await request('GET', `/api/runs/${runId}/state`, { cookie });
  assert(response.statusCode === 200, `Run state API returned HTTP ${response.statusCode}: ${response.body}`);
  return JSON.parse(response.body);
}

async function getRunEvents(cookie, runId) {
  const response = await request('GET', `/api/runs/${runId}/events`, { cookie });
  assert(response.statusCode === 200, `Run events API returned HTTP ${response.statusCode}: ${response.body}`);
  return JSON.parse(response.body).events || [];
}

function workflowForCycle(cycle) {
  const failing = cycle % 3 === 0;
  const filePath = `endurance-cycle-${cycle}-${STAMP}.txt`;
  return {
    id: `endurance-draft-${cycle}-${STAMP}`,
    name: `Endurance draft ${cycle}`,
    inputSchema: { content: 'string' },
    actions: [
      {
        id: 'write',
        action: 'writeFile',
        input: {
          path: filePath,
          content: failing ? 'actual content' : '{{workflow.input.content}}'
        },
        next: 'done'
      },
      {
        id: 'done',
        action: 'stop',
        input: {
          result: {
            path: filePath,
            cycle
          }
        }
      }
    ],
    postconditions: [
      { id: 'file-exists', type: 'fileExists', path: filePath },
      { id: 'file-contains', type: 'fileContains', path: filePath, contains: '{{workflow.input.content}}' }
    ],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
}

function countMissingEvidence(summary, runState, events) {
  const hasAuthority = Array.isArray(runState.authorityEvidence) && runState.authorityEvidence.length > 0;
  const hasEvaluation = Boolean(runState.runEvaluation);
  const hasConsequence = Boolean(runState.runConsequence);
  const hasPostconditionCheck = events.some(event => event.type === 'run.postconditions_checked');
  const hasViolationCheck = events.some(event => event.type === 'run.violations_checked' || event.type === 'run.violation_detected');
  const hasReplaySummary = Boolean(runState.replaySummary);

  if (!hasAuthority) summary.authorityEvidenceMissing += 1;
  if (!hasEvaluation) summary.evaluationMissing += 1;
  if (!hasConsequence) summary.consequenceMissing += 1;
  if (!hasPostconditionCheck) summary.postconditionCheckMissing += 1;
  if (!hasViolationCheck) summary.violationCheckMissing += 1;

  assert(events.length > 0, `Run ${runState.id} has no events`);
  assert(hasReplaySummary, `Run ${runState.id} has no replay summary`);
}

function assertRunEvidence(summary, runState, events) {
  countMissingEvidence(summary, runState, events);
  assert(Array.isArray(runState.authorityEvidence) && runState.authorityEvidence.length > 0, `Run ${runState.id} missing authority evidence`);
  assert(runState.runEvaluation, `Run ${runState.id} missing runEvaluation`);
  assert(runState.runConsequence, `Run ${runState.id} missing runConsequence`);
  assert(events.some(event => event.type === 'run.postconditions_checked'), `Run ${runState.id} missing postcondition check event`);
  assert(events.some(event => event.type === 'run.violations_checked' || event.type === 'run.violation_detected'), `Run ${runState.id} missing violation check event`);
}

async function repairFailedWorkflow(cookie, agent, cycle, failedState, failedEvents) {
  const objective = [
    `endurance-repair-cycle-${cycle}-${STAMP}`,
    'Create a corrected disabled workflow draft from this runtime evidence.',
    JSON.stringify({
      runEvaluation: failedState.runEvaluation,
      runConsequence: failedState.runConsequence,
      authorityEvidence: failedState.authorityEvidence,
      events: failedEvents.map(event => ({ type: event.type, stepId: event.stepId, payload: event.payload || {} }))
    })
  ].join('\n');
  const repairTicket = await createAgentTicket(cookie, agent, objective);
  const repairRun = await waitForTerminalRun(repairTicket.id);
  const draft = readJson('workflows.json').find(workflow => workflow.createdByRunId === repairRun.id) ||
    readJson('workflows.json').find(workflow => workflow.id === `endurance-repair-${cycle}-${STAMP}`);
  assert(draft, `Repair draft missing for cycle ${cycle}`);
  assert(draft.enabled === false, `Repair draft should be disabled for cycle ${cycle}`);
  return draft;
}

async function runCycle(cookie, agent, cycle, summary) {
  const workflowInput = { content: `expected content for cycle ${cycle}` };
  const draft = await createWorkflowDraft(cookie, workflowForCycle(cycle));
  const enabled = await enableWorkflow(cookie, draft);
  const ticket = await createWorkflowTicket(cookie, agent, enabled, workflowInput, `endurance-cycle-${cycle}-${STAMP}`);
  const run = await waitForTerminalRun(ticket.id);
  const runState = await getRunState(cookie, run.id);
  const events = await getRunEvents(cookie, run.id);
  assertRunEvidence(summary, runState, events);

  const passed = run.status === 'completed' &&
    runState.runEvaluation &&
    runState.runEvaluation.effectiveness &&
    runState.runEvaluation.effectiveness.status === 'passed' &&
    runState.runEvaluation.violations &&
    runState.runEvaluation.violations.status === 'none';

  if (passed) return true;

  summary.repairsAttempted += 1;
  const repairDraft = await repairFailedWorkflow(cookie, agent, cycle, runState, events);
  const enabledRepair = await enableWorkflow(cookie, repairDraft);
  const repairedTicket = await createWorkflowTicket(
    cookie,
    agent,
    enabledRepair,
    workflowInput,
    `endurance-cycle-${cycle}-repaired-${STAMP}`
  );
  const repairedRun = await waitForTerminalRun(repairedTicket.id);
  const repairedState = await getRunState(cookie, repairedRun.id);
  const repairedEvents = await getRunEvents(cookie, repairedRun.id);
  assertRunEvidence(summary, repairedState, repairedEvents);

  const repairPassed = repairedRun.status === 'completed' &&
    repairedState.runEvaluation &&
    repairedState.runEvaluation.effectiveness &&
    repairedState.runEvaluation.effectiveness.status === 'passed' &&
    repairedState.runEvaluation.violations &&
    repairedState.runEvaluation.violations.status === 'none';
  assert(repairPassed, `Repaired run failed for cycle ${cycle}`);
  summary.repairsSucceeded += 1;
  return true;
}

async function main() {
  maybeWarnSlowLocalModelBudget();
  const startedAt = Date.now();
  const preloadPath = createFakeOpenAIPreload();
  const agent = seedAgent();
  const summary = {
    cycles: CYCLES,
    passed: 0,
    failed: 0,
    repairsAttempted: 0,
    repairsSucceeded: 0,
    authorityEvidenceMissing: 0,
    evaluationMissing: 0,
    consequenceMissing: 0,
    postconditionCheckMissing: 0,
    violationCheckMissing: 0,
    durationMs: 0,
    runtimeLimitMs: BENCHMARK_AGENT_RUNTIME_MS,
    waitTimeoutMs: RUN_WAIT_TIMEOUT_MS,
    model: null,
    timeoutCompatible: null
  };
  summary.model = agent.model || null;

  const server = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      NODE_OPTIONS: `--require ${preloadPath}`,
      AGENT_ALLOW_CANONICAL_WORKFLOW_DRAFT: '1',
      PORT,
      DATA_DIR,
      WORKSPACE_ROOT,
      AGENT_MAX_EXECUTION_STEPS: '4',
      AGENT_MAX_MODEL_REQUESTS_PER_RUN: '4',
      AGENT_MAX_WORKSPACE_OPERATIONS_PER_RUN: '10',
      AGENT_MAX_RUNTIME_DURATION_MS: String(BENCHMARK_AGENT_RUNTIME_MS),
      WORKFLOW_MAX_MUTATIONS: '4'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  let childOutput = '';
  server.stdout.on('data', chunk => { childOutput += chunk.toString(); });
  server.stderr.on('data', chunk => { childOutput += chunk.toString(); });

  try {
    await waitForReady();
    const cookie = await login();

    for (let cycle = 1; cycle <= CYCLES; cycle += 1) {
      try {
        await runCycle(cookie, agent, cycle, summary);
        summary.passed += 1;
      } catch (error) {
        summary.failed += 1;
        summary.timeoutCompatible = !isTimeoutFailure(error.message || String(error));
        throw error;
      }
    }
  } finally {
    summary.durationMs = Date.now() - startedAt;
    if (summary.timeoutCompatible === null) summary.timeoutCompatible = true;
    console.log(JSON.stringify(summary));

    server.kill();
    await new Promise(resolve => server.once('exit', resolve));
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
    removeTempWorkspaceRoot(WORKSPACE_ROOT);
    fs.rmSync(preloadPath, { force: true });

    if (server.exitCode && server.exitCode !== 0) {
      process.stderr.write(childOutput);
    }
  }
}

main().catch(error => {
  console.error(error.stack || error.message);
  process.exit(1);
});

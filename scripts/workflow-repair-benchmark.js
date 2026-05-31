const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { createTempWorkspaceRoot, removeTempWorkspaceRoot } = require('./test-workspace');

const ROOT = path.resolve(__dirname, '..');
const REAL_DATA_DIR = path.join(ROOT, 'data');
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-repair-benchmark-data-'));
const WORKSPACE_ROOT = createTempWorkspaceRoot('workflow-repair-benchmark');
const PORT = process.env.PORT || '3447';
const BASE_URL = `http://127.0.0.1:${PORT}`;
const STAMP = Date.now();
const REAL_MODE = process.env.REAL_MODEL_BENCHMARK === '1';
const RESULTS_FILE = path.join(REAL_DATA_DIR, 'benchmark-results.jsonl');
function positiveIntegerEnv(name, fallback) {
  const value = parseInt(process.env[name] || '', 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}
const BENCHMARK_AGENT_RUNTIME_MS = positiveIntegerEnv('BENCHMARK_AGENT_RUNTIME_MS', 5000);
const RUN_WAIT_TIMEOUT_MS = positiveIntegerEnv('BENCHMARK_RUN_WAIT_TIMEOUT_MS', 15000);
function isTimeoutFailure(reason) {
  return /timeout|timed out|runtime duration limit/i.test(String(reason || ''));
}
function timeoutCompatibleFromFailure(reason) {
  return reason ? !isTimeoutFailure(reason) : true;
}
function maybeWarnSlowLocalModelBudget() {
  if (!REAL_MODE) return;
  if (BENCHMARK_AGENT_RUNTIME_MS < 180000 || RUN_WAIT_TIMEOUT_MS < 180000) {
    console.warn('[benchmark] REAL_MODEL_BENCHMARK=1 with runtimeLimitMs=' + BENCHMARK_AGENT_RUNTIME_MS + ' waitTimeoutMs=' + RUN_WAIT_TIMEOUT_MS + '; slow local models may need BENCHMARK_AGENT_RUNTIME_MS=180000 and BENCHMARK_RUN_WAIT_TIMEOUT_MS=180000 minimum, 300000 comfortable.');
  }
}
const HARVESTED_CASES_FILE = path.join(REAL_DATA_DIR, 'benchmark-cases.jsonl');
const INCLUDE_HARVESTED = process.env.INCLUDE_HARVESTED_BENCHMARK_CASES === '1';
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

function appendBenchmarkResult(record) {
  if (!REAL_MODE) return;
  fs.appendFileSync(RESULTS_FILE, `${JSON.stringify(record)}\n`);
}

function seedFailingWorkflows() {
  const now = new Date().toISOString();
  const workflows = readJson('workflows.json').filter(workflow => !String(workflow.id || '').startsWith(`repair-benchmark-`));
  const seeded = [
    {
      id: `repair-benchmark-missing-folder-${STAMP}`,
      name: 'Repair benchmark missing folder',
      enabled: true,
      inputSchema: { content: 'string' },
      actions: [
        { id: 'write', action: 'writeFile', input: { path: `missing-folder-${STAMP}/summary.md`, content: '{{workflow.input.content}}' }, next: 'done' },
        { id: 'done', action: 'stop', input: { result: { path: `missing-folder-${STAMP}/summary.md` } } }
      ],
      postconditions: [
        { id: 'file-exists', type: 'fileExists', path: `missing-folder-${STAMP}/summary.md` },
        { id: 'file-contains', type: 'fileContains', path: `missing-folder-${STAMP}/summary.md`, contains: '{{workflow.input.content}}' }
      ],
      createdAt: now,
      updatedAt: now
    },
    {
      id: `repair-benchmark-failing-postcondition-${STAMP}`,
      name: 'Repair benchmark failing postcondition',
      enabled: true,
      inputSchema: {},
      actions: [
        { id: 'write', action: 'writeFile', input: { path: `failing-postcondition-${STAMP}.txt`, content: 'actual' }, next: 'done' },
        { id: 'done', action: 'stop', input: { result: { path: `failing-postcondition-${STAMP}.txt` } } }
      ],
      postconditions: [
        { id: 'contains-expected', type: 'fileContains', path: `failing-postcondition-${STAMP}.txt`, contains: 'expected' }
      ],
      createdAt: now,
      updatedAt: now
    },
    {
      id: `repair-benchmark-invalid-next-${STAMP}`,
      name: 'Repair benchmark invalid next step',
      enabled: true,
      inputSchema: {},
      actions: [
        { id: 'write', action: 'writeFile', input: { path: `invalid-next-${STAMP}.txt`, content: 'fixed next' }, next: 'missing_step' },
        { id: 'done', action: 'stop', input: { result: { path: `invalid-next-${STAMP}.txt` } } }
      ],
      postconditions: [
        { id: 'file-exists', type: 'fileExists', path: `invalid-next-${STAMP}.txt` }
      ],
      createdAt: now,
      updatedAt: now
    },
    {
      id: `repair-benchmark-protected-path-${STAMP}`,
      name: 'Repair benchmark protected path',
      enabled: true,
      inputSchema: {},
      actions: [
        { id: 'write', action: 'writeFile', input: { path: 'package.json', content: 'blocked' }, next: 'done' },
        { id: 'done', action: 'stop', input: { result: { path: 'package.json' } } }
      ],
      postconditions: [
        { id: 'file-exists', type: 'fileExists', path: 'package.json' }
      ],
      createdAt: now,
      updatedAt: now
    }
  ];
  writeJson('workflows.json', [...workflows, ...seeded]);
  return seeded;
}

function createFakeOpenAIPreload() {
  const preloadPath = path.join(os.tmpdir(), `workflow-repair-benchmark-openai-${process.pid}-${STAMP}.js`);
  const source = `
function okResponse(plan) {
  return {
    ok: true,
    status: 200,
    headers: new Map([['x-request-id', 'fake-workflow-repair-benchmark']]),
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

  if (combined.includes('repair-missing-folder')) {
    return okResponse({
      message: 'Repairing missing folder workflow.',
      actions: [{ operation: 'createWorkflowDraft', args: { workflow: {
        id: 'repair-draft-missing-folder-${STAMP}',
        name: 'Repair draft missing folder',
        inputSchema: { content: 'string' },
        actions: [
          { id: 'folder', action: 'createFolder', input: { path: 'missing-folder-${STAMP}' }, next: 'write' },
          { id: 'write', action: 'writeFile', input: { path: 'missing-folder-${STAMP}/summary.md', content: '{{workflow.input.content}}' }, next: 'done' },
          { id: 'done', action: 'stop', input: { result: { path: 'missing-folder-${STAMP}/summary.md' } } }
        ],
        postconditions: [
          { id: 'file-exists', type: 'fileExists', path: 'missing-folder-${STAMP}/summary.md' },
          { id: 'file-contains', type: 'fileContains', path: 'missing-folder-${STAMP}/summary.md', contains: '{{workflow.input.content}}' }
        ]
      } } }],
      complete: true
    });
  }

  if (combined.includes('repair-failing-postcondition')) {
    return okResponse({
      message: 'Repairing failing postcondition workflow.',
      actions: [{ operation: 'createWorkflowDraft', args: { workflow: {
        id: 'repair-draft-failing-postcondition-${STAMP}',
        name: 'Repair draft failing postcondition',
        inputSchema: {},
        actions: [
          { id: 'write', action: 'writeFile', input: { path: 'failing-postcondition-${STAMP}.txt', content: 'expected' }, next: 'done' },
          { id: 'done', action: 'stop', input: { result: { path: 'failing-postcondition-${STAMP}.txt' } } }
        ],
        postconditions: [
          { id: 'contains-expected', type: 'fileContains', path: 'failing-postcondition-${STAMP}.txt', contains: 'expected' }
        ]
      } } }],
      complete: true
    });
  }

  if (combined.includes('repair-invalid-next')) {
    return okResponse({
      message: 'Repairing invalid next workflow.',
      actions: [{ operation: 'createWorkflowDraft', args: { workflow: {
        id: 'repair-draft-invalid-next-${STAMP}',
        name: 'Repair draft invalid next',
        inputSchema: {},
        actions: [
          { id: 'write', action: 'writeFile', input: { path: 'invalid-next-${STAMP}.txt', content: 'fixed next' }, next: 'done' },
          { id: 'done', action: 'stop', input: { result: { path: 'invalid-next-${STAMP}.txt' } } }
        ],
        postconditions: [
          { id: 'file-exists', type: 'fileExists', path: 'invalid-next-${STAMP}.txt' },
          { id: 'file-contains', type: 'fileContains', path: 'invalid-next-${STAMP}.txt', contains: 'fixed next' }
        ]
      } } }],
      complete: true
    });
  }

  if (combined.includes('repair-protected-path')) {
    return okResponse({
      message: 'Repairing protected path workflow.',
      actions: [{ operation: 'createWorkflowDraft', args: { workflow: {
        id: 'repair-draft-protected-path-${STAMP}',
        name: 'Repair draft protected path',
        inputSchema: {},
        actions: [
          { id: 'write', action: 'writeFile', input: { path: 'protected-path-repaired-${STAMP}.txt', content: 'safe output' }, next: 'done' },
          { id: 'done', action: 'stop', input: { result: { path: 'protected-path-repaired-${STAMP}.txt' } } }
        ],
        postconditions: [
          { id: 'safe-file-exists', type: 'fileExists', path: 'protected-path-repaired-${STAMP}.txt' },
          { id: 'safe-file-contains', type: 'fileContains', path: 'protected-path-repaired-${STAMP}.txt', contains: 'safe output' }
        ]
      } } }],
      complete: true
    });
  }

  return okResponse({ message: 'No repair draft created.', actions: [], complete: true });
};
`;
  fs.writeFileSync(preloadPath, source);
  return preloadPath;
}

function seedAgent() {
  const agents = readJson('agents.json');
  if (REAL_MODE) {
    const requestedName = String(process.env.BENCHMARK_AGENT_NAME || 'Mike').trim();
    const agent = agents.find(item => item.name === requestedName) || agents[0];
    if (!agent) throw new Error('REAL_MODEL_BENCHMARK=1 requires at least one configured agent');
    return agent;
  }

  const agent = {
    id: Math.max(0, ...agents.map(item => item.id || 0)) + 1,
    name: `WorkflowRepairBenchmarkAgent-${STAMP}`,
    type: 'agent',
    provider: 'openai',
    model: 'gpt-4.1-mini',
    apiKey: 'test-key-workflow-repair-benchmark',
    createdAt: new Date().toISOString()
  };
  writeJson('agents.json', [...agents.filter(item => item.name !== agent.name), agent]);
  return agent;
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
  assert(response.statusCode === 200, `Run state API returned HTTP ${response.statusCode}`);
  return JSON.parse(response.body);
}

async function getRunEvents(cookie, runId) {
  const response = await request('GET', `/api/runs/${runId}/events`, { cookie });
  assert(response.statusCode === 200, `Run events API returned HTTP ${response.statusCode}`);
  return JSON.parse(response.body).events;
}

function assertUsesOnlyExistingActions(workflow) {
  const existingActions = new Set(['agentStructuredOutput', 'condition', 'writeFile', 'stop', 'createFolder', 'renamePath', 'deletePath', 'readFile', 'listDirectory']);
  workflow.actions.forEach(step => {
    assert(existingActions.has(step.action), `Workflow ${workflow.id} uses unknown action ${step.action}`);
  });
}

function assertMutatingWorkflowHasPostconditions(workflow) {
  const mutatingActions = new Set(['createFolder', 'writeFile', 'renamePath', 'deletePath']);
  const hasMutatingAction = workflow.actions.some(step => mutatingActions.has(step.action));
  assert(!hasMutatingAction || (Array.isArray(workflow.postconditions) && workflow.postconditions.length > 0), `Mutating workflow ${workflow.id} lacks postconditions`);
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
  assert(response.statusCode === 302, `Operator enable returned HTTP ${response.statusCode}: ${response.body}`);
  return readJson('workflows.json').find(item => item.id === workflow.id);
}

function summarizeRepairEvidence(runState, events) {
  return {
    workflowValidationErrors: runState.error || null,
    runEvaluation: runState.runEvaluation || null,
    violations: runState.runEvaluation ? runState.runEvaluation.violations : null,
    consequence: runState.runConsequence || null,
    replaySummary: runState.replaySummary || null,
    events: events.map(event => ({ type: event.type, stepId: event.stepId, payload: event.payload || {} }))
  };
}

function readHarvestedCases() {
  if (!INCLUDE_HARVESTED || !fs.existsSync(HARVESTED_CASES_FILE)) return [];
  return fs.readFileSync(HARVESTED_CASES_FILE, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(line => {
      try {
        return JSON.parse(line);
      } catch (error) {
        return null;
      }
    })
    .filter(Boolean);
}

function normalizeHarvestedRepairCase(caseRecord, index) {
  const originalWorkflow = caseRecord.workflow && typeof caseRecord.workflow === 'object'
    ? {
      ...caseRecord.workflow,
      id: `harvested-${caseRecord.sourceRunId || index}-${STAMP}`,
      enabled: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    }
    : null;
  if (!originalWorkflow) return null;

  return {
    marker: `harvested-${caseRecord.sourceRunId || index}`,
    originalWorkflow,
    originalInput: caseRecord.workflowInput || {},
    replacementWorkflowId: `repair-draft-harvested-${caseRecord.sourceRunId || index}-${STAMP}`,
    replacementInput: caseRecord.workflowInput || {},
    harvestedCase: caseRecord
  };
}

async function runRepairCase(cookie, agent, repairCase) {
  const startedAt = Date.now();
  const base = {
    benchmark: 'workflow-repair',
    case: repairCase.marker,
    model: agent.model || null,
    runtimeLimitMs: BENCHMARK_AGENT_RUNTIME_MS,
    waitTimeoutMs: RUN_WAIT_TIMEOUT_MS,
    timeoutCompatible: null,
    passed: false,
    durationMs: 0,
    draftCreated: false,
    validWorkflow: false,
    executedSuccessfully: false,
    postconditionsPassed: false,
    violationsStatus: 'unknown',
    repairSucceeded: false,
    repairIterations: 0,
    failureReason: null
  };

  try {
    const originalTicket = await createWorkflowTicket(
      cookie,
      agent,
      repairCase.originalWorkflow,
      repairCase.originalInput,
      `${repairCase.marker} original ${STAMP}`
    );
    const originalRun = await waitForTerminalRun(originalTicket.id);
    const originalState = await getRunState(cookie, originalRun.id);
    const originalEvents = await getRunEvents(cookie, originalRun.id);
    const evidence = summarizeRepairEvidence(originalState, originalEvents);

  const repairObjective = [
    `${repairCase.marker} repair ${STAMP}`,
    'Use the following runtime evidence to create a corrected disabled workflow draft.',
    repairCase.harvestedCase ? 'This is a harvested real operational failure case.' : 'This is a synthetic benchmark case.',
    repairCase.harvestedCase ? JSON.stringify(repairCase.harvestedCase) : '',
    JSON.stringify(evidence)
  ].join('\n');
    const repairTicket = await createAgentTicket(cookie, agent, repairObjective);
    const repairRun = await waitForTerminalRun(repairTicket.id);
    const workflows = readJson('workflows.json');
    const replacementDraft = workflows.find(workflow => workflow.id === repairCase.replacementWorkflowId) ||
      workflows.find(workflow => workflow.createdByRunId === repairRun.id);
    const repairAttempted = Boolean(repairRun);

    assert(replacementDraft, `Replacement draft missing for ${repairCase.marker}`);
    assert(replacementDraft.enabled === false, `Replacement draft should be disabled for ${repairCase.marker}`);
    assertUsesOnlyExistingActions(replacementDraft);
    assertMutatingWorkflowHasPostconditions(replacementDraft);

    const enabledDraft = await enableWorkflow(cookie, replacementDraft);
    const repairedTicket = await createWorkflowTicket(
      cookie,
      agent,
      enabledDraft,
      repairCase.replacementInput,
      `${repairCase.marker} repaired execution ${STAMP}`
    );
    const repairedRun = await waitForTerminalRun(repairedTicket.id);
    const repairedState = await getRunState(cookie, repairedRun.id);
    const postconditionsResolved = repairedState.runEvaluation &&
      repairedState.runEvaluation.effectiveness &&
      repairedState.runEvaluation.effectiveness.status === 'passed';
    const violationsResolved = repairedState.runEvaluation &&
      repairedState.runEvaluation.violations &&
      repairedState.runEvaluation.violations.status === 'none';
    const repairSucceeded = repairAttempted &&
      repairRun.status === 'completed' &&
      replacementDraft.enabled === false &&
      repairedRun.status === 'completed' &&
      postconditionsResolved &&
      violationsResolved;
    const result = {
      ...base,
      passed: repairSucceeded,
      timeoutCompatible: true,
      durationMs: Date.now() - startedAt,
      draftCreated: Boolean(replacementDraft),
      validWorkflow: Boolean(enabledDraft && enabledDraft.enabled === true),
      executedSuccessfully: repairedRun.status === 'completed',
      postconditionsPassed: Boolean(postconditionsResolved),
      violationsStatus: repairedState.runEvaluation && repairedState.runEvaluation.violations
        ? repairedState.runEvaluation.violations.status
        : 'unknown',
      repairSucceeded,
      repairIterations: 1
    };

    assert(result.repairSucceeded, `Repair did not succeed for ${repairCase.marker}: ${JSON.stringify(result)}`);
    return result;
  } catch (error) {
    const result = {
      ...base,
      durationMs: Date.now() - startedAt,
      failureReason: error.message || String(error),
      timeoutCompatible: timeoutCompatibleFromFailure(error.message || String(error))
    };
    if (!REAL_MODE) throw error;
    return result;
  }
}

async function main() {
  maybeWarnSlowLocalModelBudget();
  const failingWorkflows = seedFailingWorkflows();
  const preloadPath = REAL_MODE ? null : createFakeOpenAIPreload();
  const agent = seedAgent();
  const server = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      ...(preloadPath ? { NODE_OPTIONS: `--require ${preloadPath}`, AGENT_ALLOW_CANONICAL_WORKFLOW_DRAFT: '1' } : {}),
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
    const cases = [
      {
        marker: 'repair-missing-folder',
        originalWorkflow: failingWorkflows[0],
        originalInput: { content: 'missing folder repaired' },
        replacementWorkflowId: `repair-draft-missing-folder-${STAMP}`,
        replacementInput: { content: 'missing folder repaired' }
      },
      {
        marker: 'repair-failing-postcondition',
        originalWorkflow: failingWorkflows[1],
        originalInput: {},
        replacementWorkflowId: `repair-draft-failing-postcondition-${STAMP}`,
        replacementInput: {}
      },
      {
        marker: 'repair-invalid-next',
        originalWorkflow: failingWorkflows[2],
        originalInput: {},
        replacementWorkflowId: `repair-draft-invalid-next-${STAMP}`,
        replacementInput: {}
      },
      {
        marker: 'repair-protected-path',
        originalWorkflow: failingWorkflows[3],
        originalInput: {},
        replacementWorkflowId: `repair-draft-protected-path-${STAMP}`,
        replacementInput: {}
      }
    ];
    readHarvestedCases().forEach((caseRecord, index) => {
      const harvestedCase = normalizeHarvestedRepairCase(caseRecord, index);
      if (harvestedCase) cases.push(harvestedCase);
    });

    const results = [];
    for (const repairCase of cases) {
      const result = await runRepairCase(cookie, agent, repairCase);
      appendBenchmarkResult(result);
      results.push(result);
    }

    console.log(JSON.stringify({
      runtimeLimitMs: BENCHMARK_AGENT_RUNTIME_MS,
      waitTimeoutMs: RUN_WAIT_TIMEOUT_MS,
      model: agent.model || null,
      timeoutCompatible: results.every(result => result.timeoutCompatible !== false),
      results
    }));
  } finally {
    server.kill();
    await new Promise(resolve => server.once('exit', resolve));
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
    removeTempWorkspaceRoot(WORKSPACE_ROOT);
    if (preloadPath) fs.rmSync(preloadPath, { force: true });

    if (server.exitCode && server.exitCode !== 0) {
      process.stderr.write(childOutput);
    }
  }
}

main().catch(error => {
  console.error(error.stack || error.message);
  process.exit(1);
});

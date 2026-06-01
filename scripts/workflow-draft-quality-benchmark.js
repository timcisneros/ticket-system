const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { createTempWorkspaceRoot, removeTempWorkspaceRoot } = require('./test-workspace');

const ROOT = path.resolve(__dirname, '..');
const REAL_DATA_DIR = path.join(ROOT, 'data');
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-draft-benchmark-data-'));
const WORKSPACE_ROOT = createTempWorkspaceRoot('workflow-draft-benchmark');
const PORT = process.env.PORT || '3446';
const BASE_URL = `http://127.0.0.1:${PORT}`;
const STAMP = Date.now();
const REAL_MODE = process.env.REAL_MODEL_BENCHMARK === '1';
const RESULTS_FILE = path.join(REAL_DATA_DIR, 'benchmark-results.jsonl');
const ARTIFACT_DIR = path.join(REAL_DATA_DIR, 'benchmark-artifacts', 'workflow-draft');
function positiveIntegerEnv(name, fallback) {
  const value = parseInt(process.env[name] || '', 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}
const BENCHMARK_AGENT_RUNTIME_MS = positiveIntegerEnv('BENCHMARK_AGENT_RUNTIME_MS', positiveIntegerEnv('AGENT_MAX_RUNTIME_DURATION_MS', 5000));
const RUN_WAIT_TIMEOUT_MS = positiveIntegerEnv('BENCHMARK_RUN_WAIT_TIMEOUT_MS', positiveIntegerEnv('AGENT_MAX_RUNTIME_DURATION_MS', 15000));
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

function readJsonIfExists(filePath) {
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    return { readError: error.message };
  }
}

function safeFileSegment(value) {
  return String(value || 'unknown').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'unknown';
}

function compactWorkflowDraft(workflow) {
  if (!workflow || typeof workflow !== 'object') return null;
  return {
    id: workflow.id || null,
    name: workflow.name || null,
    enabled: workflow.enabled === true,
    createdByRunId: workflow.createdByRunId || null,
    createdByAgentId: workflow.createdByAgentId || null,
    createdByType: workflow.createdByType || null,
    actionTypes: Array.isArray(workflow.actions) ? workflow.actions.map(step => step && step.action || null) : [],
    actionCount: Array.isArray(workflow.actions) ? workflow.actions.length : 0,
    postconditionCount: Array.isArray(workflow.postconditions) ? workflow.postconditions.length : 0
  };
}

function extractModelResponseTextPrefix(replaySnapshot) {
  const responses = replaySnapshot && Array.isArray(replaySnapshot.modelResponses)
    ? replaySnapshot.modelResponses
    : [];
  const lastWithText = responses.filter(item => typeof item.text === 'string').pop();
  return lastWithText ? lastWithText.text.slice(0, 2000) : null;
}

function writeFailureArtifact(benchmarkCase, agent, result, evidence) {
  if (!REAL_MODE || result.passed) return;

  const run = evidence.draftRun || null;
  const replaySnapshotPath = run && run.id
    ? path.join(DATA_DIR, 'replay-snapshots', `run-${run.id}.json`)
    : null;
  const replaySnapshot = replaySnapshotPath ? readJsonIfExists(replaySnapshotPath) : null;
  const providerRequests = replaySnapshot && Array.isArray(replaySnapshot.providerRequests)
    ? replaySnapshot.providerRequests
    : [];
  const modelResponses = replaySnapshot && Array.isArray(replaySnapshot.modelResponses)
    ? replaySnapshot.modelResponses
    : [];
  const parsedPlans = replaySnapshot && Array.isArray(replaySnapshot.parsedModelPlans)
    ? replaySnapshot.parsedModelPlans
    : [];
  const emittedActions = parsedPlans.flatMap(plan => Array.isArray(plan.actions) ? plan.actions : []);
  const workflows = evidence.workflows || readJson('workflows.json');
  const workflowsMatchingExpectedId = workflows
    .filter(workflow => workflow.id === benchmarkCase.workflowId)
    .map(compactWorkflowDraft);
  const workflowsMatchingCreatedByRunId = run && run.id
    ? workflows.filter(workflow => workflow.createdByRunId === run.id).map(compactWorkflowDraft)
    : [];

  const artifact = {
    case: benchmarkCase.case,
    timestamp: new Date().toISOString(),
    runtimeLimitMs: BENCHMARK_AGENT_RUNTIME_MS,
    waitTimeoutMs: RUN_WAIT_TIMEOUT_MS,
    model: agent.model || null,
    timeoutCompatible: result.timeoutCompatible,
    failureReason: result.failureReason,
    ticketId: evidence.draftTicket ? evidence.draftTicket.id : null,
    runId: run ? run.id : null,
    runStatus: run ? run.status || null : null,
    runError: run ? run.error || null : null,
    providerRequestCount: providerRequests.length,
    modelResponseCount: modelResponses.length,
    parsedPlanCount: parsedPlans.length,
    actionCount: emittedActions.length,
    emittedActionTypes: emittedActions.map(action => action && action.operation || null),
    modelResponseTextPrefix: extractModelResponseTextPrefix(replaySnapshot),
    workflowsMatchingExpectedId,
    workflowsMatchingCreatedByRunId,
    validation: evidence.validation
  };

  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
  const fileName = `${STAMP}-${safeFileSegment(benchmarkCase.case)}-${safeFileSegment(run ? run.id : 'no-run')}.json`;
  fs.writeFileSync(path.join(ARTIFACT_DIR, fileName), JSON.stringify(artifact, null, 2));
}

function createFakeOpenAIPreload() {
  const preloadPath = path.join(os.tmpdir(), `workflow-draft-benchmark-openai-${process.pid}-${STAMP}.js`);
  const summaryWorkflowId = `draft-summary-${STAMP}`;
  const urgencyWorkflowId = `draft-urgency-${STAMP}`;
  const verifiedWorkflowId = `draft-verified-${STAMP}`;
  const canonicalBranchWorkflowId = `draft-canonical-branch-${STAMP}`;
  const source = `
function okResponse(plan) {
  return {
    ok: true,
    status: 200,
    headers: new Map([['x-request-id', 'fake-workflow-draft-benchmark']]),
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

  if (combined.includes('create a workflow that writes a summary file')) {
    return okResponse({
      message: 'Creating disabled summary workflow draft.',
      actions: [{
        operation: 'createWorkflowDraft',
        args: {
          workflow: {
            id: '${summaryWorkflowId}',
            name: 'Draft benchmark summary writer',
            inputSchema: { path: 'string', summary: 'string' },
            actions: [
              { id: 'write', action: 'writeFile', input: { path: '{{workflow.input.path}}', content: '# Summary\\n{{workflow.input.summary}}\\n' }, next: 'done' },
              { id: 'done', action: 'stop', input: { result: { path: '{{workflow.input.path}}' } } }
            ],
            postconditions: [
              { id: 'summary-file-exists', type: 'fileExists', path: '{{workflow.input.path}}' },
              { id: 'summary-file-contains', type: 'fileContains', path: '{{workflow.input.path}}', contains: '{{workflow.input.summary}}' }
            ]
          }
        }
      }],
      complete: true
    });
  }

  if (combined.includes('create a workflow that branches on urgency')) {
    return okResponse({
      message: 'Creating disabled urgency branch workflow draft.',
      actions: [{
        operation: 'createWorkflowDraft',
        args: {
          workflow: {
            id: '${urgencyWorkflowId}',
            name: 'Draft benchmark urgency branch',
            inputSchema: { urgency: 'string', summary: 'string' },
            actions: [
              { id: 'check', action: 'condition', input: { value: '{{workflow.input.urgency}}', equals: 'high' }, trueNext: 'write_urgent', falseNext: 'write_normal' },
              { id: 'write_urgent', action: 'writeFile', input: { path: 'urgent-summary-${STAMP}.md', content: 'URGENT\\n{{workflow.input.summary}}\\n' }, next: 'stop_urgent' },
              { id: 'write_normal', action: 'writeFile', input: { path: 'normal-summary-${STAMP}.md', content: 'NORMAL\\n{{workflow.input.summary}}\\n' }, next: 'stop_normal' },
              { id: 'stop_urgent', action: 'stop', input: { result: { path: 'urgent-summary-${STAMP}.md', urgency: '{{workflow.input.urgency}}' } } },
              { id: 'stop_normal', action: 'stop', input: { result: { path: 'normal-summary-${STAMP}.md', urgency: '{{workflow.input.urgency}}' } } }
            ],
            postconditions: [
              { id: 'urgent-file-exists', type: 'fileExists', path: 'urgent-summary-${STAMP}.md' },
              { id: 'urgent-file-contains', type: 'fileContains', path: 'urgent-summary-${STAMP}.md', contains: '{{workflow.input.summary}}' },
              { id: 'output-urgency', type: 'outputFieldEquals', field: 'urgency', equals: 'high' }
            ]
          }
        }
      }],
      complete: true
    });
  }

  if (combined.includes('canonical branching workflow')) {
    return okResponse({
      message: 'Creating disabled canonical branch workflow draft.',
      actions: [{
        operation: 'createWorkflowDraft',
        args: {
          workflow: {
            id: '${canonicalBranchWorkflowId}',
            name: 'Draft benchmark canonical branch',
            inputSchema: { route: 'string' },
            actions: [
              { id: 'choose', action: 'condition', input: { value: '{{workflow.input.route}}', equals: 'a' }, trueNext: 'write_a', falseNext: 'write_b' },
              { id: 'write_a', action: 'writeFile', input: { path: 'branch-a-${STAMP}.txt', content: 'A' }, next: 'done' },
              { id: 'write_b', action: 'writeFile', input: { path: 'branch-b-${STAMP}.txt', content: 'B' }, next: 'done' },
              { id: 'done', action: 'stop', input: { result: { branched: true, path: 'branch-a-${STAMP}.txt' } } }
            ],
            postconditions: [
              { id: 'branch-a-exists', type: 'fileExists', path: 'branch-a-${STAMP}.txt' },
              { id: 'branch-a-contains', type: 'fileContains', path: 'branch-a-${STAMP}.txt', contains: 'A' }
            ]
          }
        }
      }],
      complete: true
    });
  }

  if (combined.includes('create a workflow that verifies output with postconditions')) {
    return okResponse({
      message: 'Creating disabled verified-output workflow draft.',
      actions: [{
        operation: 'createWorkflowDraft',
        args: {
          workflow: {
            id: '${verifiedWorkflowId}',
            name: 'Draft benchmark verified output',
            inputSchema: { path: 'string', content: 'string' },
            actions: [
              { id: 'write', action: 'writeFile', input: { path: '{{workflow.input.path}}', content: '{{workflow.input.content}}' }, next: 'done' },
              { id: 'done', action: 'stop', input: { result: { path: '{{workflow.input.path}}', verified: true } } }
            ],
            postconditions: [
              { id: 'verified-file-exists', type: 'fileExists', path: '{{workflow.input.path}}' },
              { id: 'verified-file-contains', type: 'fileContains', path: '{{workflow.input.path}}', contains: '{{workflow.input.content}}' },
              { id: 'verified-output', type: 'outputFieldEquals', field: 'verified', equals: true }
            ]
          }
        }
      }],
      complete: true
    });
  }

  return okResponse({ message: 'No draft created.', actions: [], complete: true });
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
    name: `WorkflowDraftBenchmarkAgent-${STAMP}`,
    type: 'agent',
    provider: 'openai',
    model: 'gpt-4.1-mini',
    apiKey: 'test-key-workflow-draft-benchmark',
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
      workflowInput: JSON.stringify(workflowInput),
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

function assertCanonicalBranchWorkflow(workflow) {
  const conditionStep = workflow.actions.find(step => step && step.action === 'condition');
  assert(conditionStep, `Workflow ${workflow.id} does not contain a condition action`);
  assert(typeof conditionStep.trueNext === 'string' && conditionStep.trueNext, `Workflow ${workflow.id} condition lacks trueNext`);
  assert(typeof conditionStep.falseNext === 'string' && conditionStep.falseNext, `Workflow ${workflow.id} condition lacks falseNext`);
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

async function runBenchmarkCase(cookie, agent, benchmarkCase) {
  const startedAt = Date.now();
  const evidence = {
    draftTicket: null,
    draftRun: null,
    workflows: null,
    validation: {
      expectedWorkflowFound: false,
      createdByRunWorkflowFound: false,
      draftCreated: false,
      actionValidationPassed: false,
      postconditionValidationPassed: false,
      enabledByOperator: false,
      executionRunCompleted: false,
      postconditionsPassed: false,
      violationsClear: false
    }
  };
  const base = {
    benchmark: 'workflow-draft',
    case: benchmarkCase.case,
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
    repairSucceeded: null,
    repairIterations: null,
    failureReason: null
  };

  try {
    const draftTicket = await createAgentTicket(cookie, agent, benchmarkCase.prompt);
    evidence.draftTicket = draftTicket || null;
    const draftRun = await waitForTerminalRun(draftTicket.id);
    evidence.draftRun = draftRun || null;
    const workflows = readJson('workflows.json');
    evidence.workflows = workflows;
    const expectedDraft = workflows.find(workflow => workflow.id === benchmarkCase.workflowId);
    const runDraft = workflows.find(workflow => workflow.createdByRunId === draftRun.id);
    evidence.validation.expectedWorkflowFound = Boolean(expectedDraft);
    evidence.validation.createdByRunWorkflowFound = Boolean(runDraft);
    const draft = expectedDraft || runDraft;
    const draftCreated = Boolean(draft && draft.createdByType === 'agent' && draft.createdByAgentId === agent.id && draft.createdByRunId === draftRun.id && draft.enabled === false);
    evidence.validation.draftCreated = draftCreated;

    assert(draftCreated, `Draft was not created correctly for ${benchmarkCase.workflowId}`);
    assertUsesOnlyExistingActions(draft);
    evidence.validation.actionValidationPassed = true;
    assertMutatingWorkflowHasPostconditions(draft);
    evidence.validation.postconditionValidationPassed = true;
    if (benchmarkCase.expectCanonicalBranch) {
      assertCanonicalBranchWorkflow(draft);
    }

    const enabledDraft = await enableWorkflow(cookie, draft);
    const enabledByOperator = Boolean(enabledDraft && enabledDraft.enabled === true);
    evidence.validation.enabledByOperator = enabledByOperator;
    assert(enabledByOperator, `Draft was not enabled by operator for ${draft.id}`);

    const executionTicket = await createWorkflowTicket(
      cookie,
      agent,
      enabledDraft,
      benchmarkCase.workflowInput,
      `${benchmarkCase.prompt} execution ${STAMP}`
    );
    const executionRun = await waitForTerminalRun(executionTicket.id);
    const runState = await getRunState(cookie, executionRun.id);
    if (benchmarkCase.expectedArtifactPath) {
      assert(fs.existsSync(path.join(WORKSPACE_ROOT, benchmarkCase.expectedArtifactPath)), `Expected branch artifact missing: ${benchmarkCase.expectedArtifactPath}`);
    }
    evidence.validation.executionRunCompleted = executionRun.status === 'completed';
    evidence.validation.postconditionsPassed = Boolean(runState.runEvaluation &&
      runState.runEvaluation.effectiveness &&
      runState.runEvaluation.effectiveness.status === 'passed');
    evidence.validation.violationsClear = Boolean(runState.runEvaluation &&
      runState.runEvaluation.violations &&
      runState.runEvaluation.violations.status === 'none');
    const result = {
      ...base,
      passed: true,
      timeoutCompatible: true,
      durationMs: Date.now() - startedAt,
      draftCreated,
      validWorkflow: draftCreated && enabledByOperator,
      executedSuccessfully: executionRun.status === 'completed',
      postconditionsPassed: runState.runEvaluation &&
        runState.runEvaluation.effectiveness &&
        runState.runEvaluation.effectiveness.status === 'passed',
      violationsStatus: runState.runEvaluation && runState.runEvaluation.violations
        ? runState.runEvaluation.violations.status
        : 'unknown'
    };

    result.passed = result.validWorkflow &&
      result.executedSuccessfully &&
      result.postconditionsPassed &&
      result.violationsStatus === 'none';
    assert(result.passed, `Benchmark case failed: ${JSON.stringify(result)}`);
    return result;
  } catch (error) {
    const result = {
      ...base,
      durationMs: Date.now() - startedAt,
      failureReason: error.message || String(error),
      timeoutCompatible: timeoutCompatibleFromFailure(error.message || String(error))
    };
    writeFailureArtifact(benchmarkCase, agent, result, evidence);
    if (!REAL_MODE) throw error;
    return result;
  }
}

async function main() {
  maybeWarnSlowLocalModelBudget();
  const preloadPath = REAL_MODE ? null : createFakeOpenAIPreload();
  const agent = seedAgent();
  const server = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      ...(preloadPath ? { NODE_OPTIONS: `--require ${preloadPath}` } : {}),
      PORT,
      DATA_DIR,
      WORKSPACE_ROOT,
      ...(preloadPath ? { AGENT_ALLOW_CANONICAL_WORKFLOW_DRAFT: '1' } : {}),
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
        case: 'summary-file',
        prompt: `create a workflow that writes a summary file ${STAMP}`,
        workflowId: `draft-summary-${STAMP}`,
        workflowInput: {
          path: `summary-${STAMP}.md`,
          summary: 'Benchmark summary content'
        }
      },
      {
        case: 'urgency-branch',
        prompt: `create a workflow that branches on urgency ${STAMP}`,
        workflowId: `draft-urgency-${STAMP}`,
        workflowInput: {
          urgency: 'high',
          summary: 'Urgent benchmark content'
        }
      },
      {
        case: 'canonical-branch',
        prompt: `create a canonical branching workflow where route="a" takes the true branch, the true branch writes exactly branch-a-${STAMP}.txt, the false branch writes exactly branch-b-${STAMP}.txt, and postconditions check branch-a-${STAMP}.txt. Use createWorkflowDraft, not createWorkflowDraftIntent. ${STAMP}`,
        workflowId: `draft-canonical-branch-${STAMP}`,
        workflowInput: {
          route: 'a'
        },
        expectCanonicalBranch: true,
        expectedArtifactPath: `branch-a-${STAMP}.txt`
      },
      {
        case: 'verified-output',
        prompt: `create a workflow that verifies output with postconditions ${STAMP}`,
        workflowId: `draft-verified-${STAMP}`,
        workflowInput: {
          path: `verified-${STAMP}.txt`,
          content: 'Verified benchmark content'
        }
      }
    ];

    const requestedCase = String(process.env.BENCHMARK_CASE || '').trim();
    const selectedCases = requestedCase
      ? cases.filter(benchmarkCase => benchmarkCase.case === requestedCase)
      : cases;
    if (requestedCase && selectedCases.length === 0) {
      throw new Error(`Unknown BENCHMARK_CASE "${requestedCase}". Valid cases: ${cases.map(benchmarkCase => benchmarkCase.case).join(', ')}`);
    }

    const results = [];
    for (const benchmarkCase of selectedCases) {
      const result = await runBenchmarkCase(cookie, agent, benchmarkCase);
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

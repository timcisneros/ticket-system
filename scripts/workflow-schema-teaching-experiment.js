const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { createTempWorkspaceRoot, removeTempWorkspaceRoot } = require('./test-workspace');

const ROOT = path.resolve(__dirname, '..');
const REAL_DATA_DIR = path.join(ROOT, 'data');
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-schema-teaching-data-'));
const WORKSPACE_ROOT = createTempWorkspaceRoot('workflow-schema-teaching');
const PORT = process.env.PORT || '3452';
const BASE_URL = `http://127.0.0.1:${PORT}`;
const STAMP = Date.now();
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
  fs.writeFileSync(dst, file === 'events.jsonl' ? '' : fs.existsSync(src) ? fs.readFileSync(src, 'utf8') : '[]');
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(path.join(DATA_DIR, file), 'utf8'));
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

async function waitForTerminalRun(ticketId) {
  const started = Date.now();
  while (Date.now() - started < 120000) {
    const runs = readJson('runs.json').filter(run => run.ticketId === ticketId);
    const run = runs[runs.length - 1];
    if (run && ['completed', 'failed', 'interrupted'].includes(run.status)) return run;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for terminal run for ticket ${ticketId}`);
}

function readReplaySnapshot(run) {
  if (!run || !run.replaySnapshotPath) return null;
  return JSON.parse(fs.readFileSync(path.join(DATA_DIR, run.replaySnapshotPath), 'utf8'));
}

function chooseAgent() {
  const agents = readJson('agents.json');
  const requestedName = String(process.env.BENCHMARK_AGENT_NAME || 'Mike').trim();
  return agents.find(agent => agent.name === requestedName) || agents.find(agent => agent.name === 'Mike') || agents[0];
}

function extractedWorkflowFromPlan(plan) {
  const action = (plan.actions || []).find(item => item && item.operation === 'createWorkflowDraft');
  return action && action.args ? action.args.workflow || null : null;
}

function validateOuterActionJson(snapshot) {
  return Array.isArray(snapshot.parsedModelPlans) && snapshot.parsedModelPlans.length > 0;
}

function validateWorkflowShape(workflow) {
  const errors = [];
  if (!workflow || typeof workflow !== 'object' || Array.isArray(workflow)) errors.push('workflow must be an object');
  if (!errors.length && typeof workflow.id !== 'string') errors.push('workflow.id is required');
  if (!errors.length && typeof workflow.name !== 'string') errors.push('workflow.name is required');
  if (!errors.length && (!workflow.inputSchema || typeof workflow.inputSchema !== 'object' || Array.isArray(workflow.inputSchema))) errors.push('workflow.inputSchema must be an object');
  if (!errors.length && !Array.isArray(workflow.actions)) errors.push('workflow.actions must be an array');
  if (!errors.length && !Array.isArray(workflow.postconditions)) errors.push('workflow.postconditions must be an array');

  if (!errors.length) {
    workflow.actions.forEach((step, index) => {
      if (!step || typeof step !== 'object') errors.push(`workflow.actions[${index}] must be an object`);
      else {
        if (typeof step.id !== 'string') errors.push(`workflow.actions[${index}].id is required`);
        if (typeof step.action !== 'string') errors.push(`workflow.actions[${index}].action is required`);
        if (!step.input || typeof step.input !== 'object' || Array.isArray(step.input)) errors.push(`workflow.actions[${index}].input must be an object`);
      }
    });
  }

  return errors;
}

function summarizeRun(ticket, run, snapshot) {
  const plans = Array.isArray(snapshot.parsedModelPlans) ? snapshot.parsedModelPlans : [];
  const firstPlan = plans[0] || {};
  const workflow = extractedWorkflowFromPlan(firstPlan);
  const workflowShapeErrors = validateWorkflowShape(workflow);
  const modelResponses = Array.isArray(snapshot.modelResponses) ? snapshot.modelResponses : [];
  const response = modelResponses[0] || null;
  const workspaceOperations = Array.isArray(snapshot.workspaceOperations) ? snapshot.workspaceOperations : [];
  const workflowDraftError = workspaceOperations
    .map(item => item && item.error)
    .find(Boolean) || null;
  const savedDrafts = readJson('workflows.json').filter(workflowItem => workflowItem.createdByRunId === run.id);

  return {
    ticketObjective: ticket.objective,
    runId: run.id,
    status: run.status,
    failureReason: snapshot.failureReason || run.error || null,
    responseLatencyMs: response ? response.durationMs : null,
    providerRequests: Array.isArray(snapshot.providerRequests) ? snapshot.providerRequests.length : 0,
    modelResponses: modelResponses.length,
    rawResponseText: response ? response.text : null,
    validOuterActionJson: validateOuterActionJson(snapshot),
    parsedActions: plans.map(plan => plan.actions || []),
    createWorkflowDraftAttempted: plans.some(plan => (plan.actions || []).some(action => action.operation === 'createWorkflowDraft')),
    workflowShapeErrors,
    validWorkflowSchemaShape: workflowShapeErrors.length === 0,
    workflowValidationSuccess: savedDrafts.length > 0,
    postconditionInclusion: Boolean(workflow && Array.isArray(workflow.postconditions) && workflow.postconditions.length > 0),
    savedDrafts: savedDrafts.map(item => ({ id: item.id, name: item.name, enabled: item.enabled, postconditions: item.postconditions })),
    workflowDraftError
  };
}

function prompts() {
  const exampleWorkflow = {
    id: 'example-write-note',
    name: 'Example write note',
    inputSchema: { path: 'string', content: 'string' },
    actions: [
      {
        id: 'write',
        action: 'writeFile',
        input: {
          path: '{{workflow.input.path}}',
          content: '{{workflow.input.content}}'
        },
        next: 'done'
      },
      {
        id: 'done',
        action: 'stop',
        input: {
          result: {
            path: '{{workflow.input.path}}'
          }
        }
      }
    ],
    postconditions: [
      { id: 'file-exists', type: 'fileExists', path: '{{workflow.input.path}}' },
      { id: 'file-contains', type: 'fileContains', path: '{{workflow.input.path}}', contains: '{{workflow.input.content}}' }
    ]
  };
  const exampleAction = {
    operation: 'createWorkflowDraft',
    args: {
      workflow: exampleWorkflow
    }
  };

  return [
    {
      variant: 'no-example',
      objective: `create a workflow that verifies output with postconditions ${STAMP}`
    },
    {
      variant: 'one-example',
      objective: [
        `create a workflow that verifies output with postconditions ${STAMP}`,
        'Use this exact workflow schema shape:',
        JSON.stringify({
          id: 'string',
          name: 'string',
          inputSchema: {},
          actions: [
            { id: 'string', action: 'writeFile|stop', input: {}, next: 'optional-step-id' }
          ],
          postconditions: [
            { id: 'string', type: 'fileExists|fileContains', path: 'string', contains: 'string for fileContains' }
          ]
        }),
        'Valid createWorkflowDraft action example:',
        JSON.stringify(exampleAction),
        'Now create a new draft, not the example, that writes teaching-output.txt with content grounded-ok and verifies fileExists and fileContains.'
      ].join('\n')
    }
  ];
}

async function runVariant(cookie, agent, variant) {
  const ticket = await createAgentTicket(cookie, agent, variant.objective);
  const run = await waitForTerminalRun(ticket.id);
  const snapshot = readReplaySnapshot(run) || {};
  return {
    variant: variant.variant,
    agent: {
      id: agent.id,
      name: agent.name,
      provider: agent.provider,
      model: agent.model
    },
    ...summarizeRun(ticket, run, snapshot)
  };
}

async function main() {
  const agent = chooseAgent();
  assert(agent, 'No configured agent available');

  const server = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      PORT,
      DATA_DIR,
      WORKSPACE_ROOT,
      AGENT_MAX_EXECUTION_STEPS: '1',
      AGENT_MAX_MODEL_REQUESTS_PER_RUN: '1',
      AGENT_MAX_WORKSPACE_OPERATIONS_PER_RUN: '10',
      AGENT_MAX_RUNTIME_DURATION_MS: String(process.env.SCHEMA_EXPERIMENT_RUNTIME_MS || 90000),
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
    const results = [];
    for (const variant of prompts()) {
      results.push(await runVariant(cookie, agent, variant));
    }

    console.log(JSON.stringify({
      experiment: 'workflow-schema-teaching',
      runtimeDurationMs: Number(process.env.SCHEMA_EXPERIMENT_RUNTIME_MS || 90000),
      results
    }, null, 2));
  } finally {
    server.kill();
    await new Promise(resolve => server.once('exit', resolve));
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
    removeTempWorkspaceRoot(WORKSPACE_ROOT);

    if (server.exitCode && server.exitCode !== 0) {
      process.stderr.write(childOutput);
    }
  }
}

main().catch(error => {
  console.error(error.stack || error.message);
  process.exit(1);
});

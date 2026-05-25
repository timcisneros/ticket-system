const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { createTempWorkspaceRoot, removeTempWorkspaceRoot } = require('./test-workspace');

const ROOT = path.resolve(__dirname, '..');
const REAL_DATA_DIR = path.join(ROOT, 'data');
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-composition-data-'));
const WORKSPACE_ROOT = createTempWorkspaceRoot('workflow-composition');
const PORT = process.env.PORT || '3435';
const BASE_URL = `http://127.0.0.1:${PORT}`;
const DATA_FILES = [
  'agents.json',
  'allocation-plans.json',
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

async function waitForCompletedRun(ticketId) {
  const started = Date.now();

  while (Date.now() - started < 10000) {
    const runs = readJson('runs.json').filter(run => run.ticketId === ticketId);
    const run = runs[runs.length - 1];
    if (run && ['completed', 'failed', 'interrupted'].includes(run.status)) return run;
    await new Promise(resolve => setTimeout(resolve, 100));
  }

  throw new Error(`Timed out waiting for ticket #${ticketId} run`);
}

function seedWorkflowAgent() {
  const agents = readJson('agents.json');
  const now = new Date().toISOString();
  const agent = {
    id: Math.max(0, ...agents.map(item => item.id || 0)) + 1,
    name: 'WorkflowTestAgent',
    type: 'agent',
    provider: 'ollama',
    model: 'workflow-test-model',
    apiKey: '',
    createdAt: now
  };
  writeJson('agents.json', [...agents.filter(item => item.name !== agent.name), agent]);
  return agent;
}

async function createWorkflow(cookie, definition) {
  return request('POST', '/admin/workflows', {
    cookie,
    form: { definition: JSON.stringify(definition, null, 2) }
  });
}

async function main() {
  const agent = seedWorkflowAgent();
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      PORT,
      DATA_DIR,
      WORKSPACE_ROOT,
      OLLAMA_MODEL: 'workflow-test-model'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  let childOutput = '';
  child.stdout.on('data', chunk => { childOutput += chunk.toString(); });
  child.stderr.on('data', chunk => { childOutput += chunk.toString(); });

  try {
    await waitForReady();
    const cookie = await login();

    const invalidUnknown = await createWorkflow(cookie, {
      id: 'invalid-unknown-action',
      name: 'Invalid unknown action',
      inputSchema: {},
      actions: [{ id: 'mystery', action: 'unknownAction', input: {} }]
    });
    assert(invalidUnknown.statusCode === 400, 'unknown workflow action should be rejected');
    assert(invalidUnknown.body.includes('unknown action'), 'unknown action rejection should explain the action problem');

    const invalidInvoke = await createWorkflow(cookie, {
      id: 'invalid-invoke-workflow',
      name: 'Invalid invoke workflow',
      inputSchema: {},
      actions: [{ id: 'invoke', action: 'invokeWorkflow', input: { workflowId: 'demo', input: {} } }]
    });
    assert(invalidInvoke.statusCode === 400, 'non-workflow invokeWorkflow action should be rejected');
    assert(invalidInvoke.body.includes('non-workflow action'), 'invokeWorkflow rejection should explain it is not workflow-usable');

    const invalidInput = await createWorkflow(cookie, {
      id: 'invalid-write-input',
      name: 'Invalid write input',
      inputSchema: { path: 'string' },
      actions: [{ id: 'write', action: 'writeFile', input: { path: '{{workflow.input.path}}' } }]
    });
    assert(invalidInput.statusCode === 400, 'workflow action input should be validated against action contracts');
    assert(invalidInput.body.includes('writeFile.input.content'), 'invalid action input rejection should name the missing content');

    const workflowDefinition = {
      id: 'test-write-file-workflow',
      name: 'Test write file workflow',
      enabled: true,
      inputSchema: {
        path: 'string',
        content: 'string'
      },
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
              written: true,
              path: '{{workflow.input.path}}'
            }
          }
        }
      ]
    };
    const createResponse = await createWorkflow(cookie, workflowDefinition);
    assert(createResponse.statusCode === 302, `valid workflow save returned HTTP ${createResponse.statusCode}`);

    fs.mkdirSync(path.join(WORKSPACE_ROOT, 'workflow-output'), { recursive: true });
    const workflowInput = { path: 'workflow-output/result.txt', content: 'workflow composition works\n' };
    const ticketResponse = await request('POST', '/tickets', {
      cookie,
      form: {
        objective: 'Run the test write workflow',
        executionMode: 'workflow',
        workflowId: workflowDefinition.id,
        workflowInput: JSON.stringify(workflowInput),
        assignmentTargetType: 'agent',
        assignmentTargetId: String(agent.id),
        assignmentMode: 'individual'
      }
    });
    assert(ticketResponse.statusCode === 302, `workflow ticket create returned HTTP ${ticketResponse.statusCode}`);

    const tickets = readJson('tickets.json');
    const ticket = tickets[tickets.length - 1];
    assert(ticket.executionMode === 'workflow', 'ticket should persist workflow execution mode');
    assert(ticket.workflowId === workflowDefinition.id, 'ticket should persist workflow id');

    const run = await waitForCompletedRun(ticket.id);
    assert(run.status === 'completed', `workflow run should complete, got ${run.status}: ${run.error || ''}`);
    assert(fs.readFileSync(path.join(WORKSPACE_ROOT, workflowInput.path), 'utf8') === workflowInput.content, 'workflow writeFile should mutate workspace through runtime');

    const snapshotPath = path.join(DATA_DIR, run.replaySnapshotPath);
    const snapshot = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));
    assert(snapshot.workflowInvocation.some(item => item.workflowId === workflowDefinition.id), 'workflow run should record workflow invocation');
    assert(snapshot.workflowActions.some(item => item.action === 'writeFile'), 'workflow run should record writeFile workflow action');
    assert(snapshot.workflowActions.some(item => item.action === 'stop'), 'workflow run should record stop workflow action');
    assert(snapshot.workspaceOperations.some(item => item.workflowId === workflowDefinition.id && item.workflowStepId === 'write'), 'workflow workspace action should record workflow provenance');
    assert(snapshot.providerRequests.length === 0, 'no-model workflow should not create provider requests');
    assert(snapshot.modelResponses.length === 0, 'no-model workflow should not create model responses');

    const history = readJson('operation-history.json');
    assert(history.some(item => item.runId === run.id && item.operation === 'writeFile'), 'workflow writeFile should persist operation history');

    console.log(JSON.stringify({
      workflowValidation: true,
      workflowRun: true,
      replayEvents: snapshot.workflowActions.length,
      workspaceOperations: snapshot.workspaceOperations.length
    }));
  } finally {
    child.kill();
    await new Promise(resolve => child.once('exit', resolve));
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
    removeTempWorkspaceRoot(WORKSPACE_ROOT);

    if (child.exitCode && child.exitCode !== 0) {
      process.stderr.write(childOutput);
    }
  }
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});

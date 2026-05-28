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

async function waitForRunStatus(runId, status) {
  const started = Date.now();

  while (Date.now() - started < 5000) {
    const run = readJson('runs.json').find(item => item.id === runId);
    if (run && run.status === status) return run;
    await new Promise(resolve => setTimeout(resolve, 100));
  }

  throw new Error(`Timed out waiting for run #${runId} status ${status}`);
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
      ],
      postconditions: [
        {
          id: 'result-file-exists',
          type: 'fileExists',
          path: 'workflow-output/result.txt'
        },
        {
          id: 'result-file-contains',
          type: 'fileContains',
          path: 'workflow-output/result.txt',
          contains: 'workflow composition works'
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
        capabilityType: 'workflow',
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
    assert(ticket.capabilityType === 'workflow', 'ticket should persist workflow capability type');
    assert(ticket.capabilityId === workflowDefinition.id, 'ticket should persist selected capability id');
    assert(ticket.workflowId === workflowDefinition.id, 'ticket should persist workflow id');

    const run = await waitForCompletedRun(ticket.id);
    assert(run.status === 'completed', `workflow run should complete, got ${run.status}: ${run.error || ''}`);
    assert(typeof run.leaseOwner === 'string' && run.leaseOwner.length > 0, 'workflow run should persist lease owner');
    assert(typeof run.leaseExpiresAt === 'string' && run.leaseExpiresAt.length > 0, 'workflow run should persist lease expiration');
    assert(typeof run.lastHeartbeatAt === 'string' && run.lastHeartbeatAt.length > 0, 'workflow run should persist heartbeat time');
    assert(run.currentStepId === 'done', 'workflow run should persist last completed workflow step id');
    assert(run.currentWorkflowAction === 'stop', 'workflow run should persist last completed workflow action');
    assert(fs.readFileSync(path.join(WORKSPACE_ROOT, workflowInput.path), 'utf8') === workflowInput.content, 'workflow writeFile should mutate workspace through runtime');

    const snapshotPath = path.join(DATA_DIR, run.replaySnapshotPath);
    const snapshot = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));
    assert(snapshot.capabilitySelection.some(item => item.capability && item.capability.id === workflowDefinition.id), 'workflow run should record selected capability');
    assert(snapshot.capabilityOutputs.some(item => item.capabilityId === workflowDefinition.id && item.output), 'workflow run should record capability output');
    assert(snapshot.workflowInvocation.some(item => item.workflowId === workflowDefinition.id), 'workflow run should record workflow invocation');
    assert(snapshot.workflowActions.some(item => item.action === 'writeFile'), 'workflow run should record writeFile workflow action');
    assert(snapshot.workflowActions.some(item => item.action === 'stop'), 'workflow run should record stop workflow action');
    assert(snapshot.authorityChecks.some(item => item.status === 'allowed' && item.operation === 'writeFile' && item.path === workflowInput.path), 'workflow run should record allowed authority evidence');
    assert(snapshot.workspaceOperations.some(item => item.workflowId === workflowDefinition.id && item.workflowStepId === 'write'), 'workflow workspace action should record workflow provenance');
    assert(snapshot.providerRequests.length === 0, 'no-model workflow should not create provider requests');
    assert(snapshot.modelResponses.length === 0, 'no-model workflow should not create model responses');

    const history = readJson('operation-history.json');
    assert(history.some(item => item.runId === run.id && item.operation === 'writeFile'), 'workflow writeFile should persist operation history');

    const eventsResponse = await request('GET', `/api/runs/${run.id}/events`, { cookie });
    assert(eventsResponse.statusCode === 200, `run events API returned HTTP ${eventsResponse.statusCode}`);
    const eventsPayload = JSON.parse(eventsResponse.body);
    const eventTypes = eventsPayload.events.map(event => event.type);
    assert(eventTypes.includes('scheduler.run_selected'), 'events should include scheduler.run_selected');
    assert(eventTypes.includes('ticket.created'), 'events should include ticket.created');
    assert(eventTypes.includes('run.created'), 'events should include run.created');
    assert(eventTypes.includes('run.lease_acquired'), 'events should include run.lease_acquired');
    assert(eventTypes.includes('run.heartbeat'), 'events should include run.heartbeat');
    assert(eventTypes.includes('run.started'), 'events should include run.started');
    assert(eventTypes.includes('authority.allowed'), 'events should include authority.allowed');
    assert(eventTypes.includes('workflow.step.persisted'), 'events should include workflow.step.persisted');
    assert(eventTypes.includes('workflow.step.started'), 'events should include workflow.step.started');
    assert(eventTypes.includes('workflow.step.completed'), 'events should include workflow.step.completed');
    assert(eventTypes.includes('workspace.operation'), 'events should include workspace.operation');
    assert(eventTypes.includes('run.snapshot_finalized') || eventTypes.includes('replay.snapshot.finalized'), 'events should include snapshot finalized');
    assert(eventTypes.includes('run.execution_completed'), 'events should include run.execution_completed');
    assert(eventTypes.includes('run.terminalized'), 'events should include run.terminalized');
    assert(eventTypes.includes('run.postconditions_checked'), 'events should include run.postconditions_checked');
    assert(eventTypes.includes('run.violations_checked'), 'events should include run.violations_checked');
    assert(eventTypes.includes('run.evaluation_completed'), 'events should include run.evaluation_completed');
    assert(eventTypes.includes('run.consequence_recorded'), 'events should include run.consequence_recorded');
    assert(eventsPayload.summary.latestStatus.status === 'completed', 'recentEventSummary should report completed status');
    assert(eventsPayload.summary.latestWorkspaceMutation.operation === 'writeFile', 'recentEventSummary should report latest writeFile mutation');

    const runtimeStatusResponse = await request('GET', '/api/runtime/status', { cookie });
    assert(runtimeStatusResponse.statusCode === 200, `runtime status API returned HTTP ${runtimeStatusResponse.statusCode}`);
    const runtimeStatus = JSON.parse(runtimeStatusResponse.body);
    assert(runtimeStatus.scheduler && typeof runtimeStatus.scheduler.running === 'boolean', 'runtime status should include scheduler status');
    assert(typeof runtimeStatus.leaseOwner === 'string' && runtimeStatus.leaseOwner.length > 0, 'runtime status should include lease owner');
    assert(Array.isArray(runtimeStatus.activeRuns), 'runtime status should include active runs');
    assert(Array.isArray(runtimeStatus.pendingRuns), 'runtime status should include pending runs');
    assert(Array.isArray(runtimeStatus.expiredLeases), 'runtime status should include expired leases');
    assert(runtimeStatus.concurrencyLimits && typeof runtimeStatus.concurrencyLimits.localModel === 'number', 'runtime status should include concurrency limits');

    const runStateResponse = await request('GET', `/api/runs/${run.id}/state`, { cookie });
    assert(runStateResponse.statusCode === 200, `run state API returned HTTP ${runStateResponse.statusCode}`);
    const runState = JSON.parse(runStateResponse.body);
    assert(runState.id === run.id, 'run state should include run id');
    assert(runState.status === 'completed', 'run state should include current status');
    assert(runState.lease && runState.lease.leaseOwner === run.leaseOwner, 'run state should include lease fields');
    assert(runState.currentStepId === 'done', 'run state should include current step id');
    assert(runState.currentWorkflowAction === 'stop', 'run state should include current workflow action');
    assert(runState.latestEventSummary.latestStatus.status === 'completed', 'run state should include latest event summary');
    assert(runState.replaySummary.workspaceOperations === 1, 'run state should include replay summary');
    assert(runState.runEvaluation.effectiveness.status === 'passed', 'run state should include passed effectiveness evaluation');
    assert(runState.runEvaluation.effectiveness.postconditionsPassed === 2, 'workflow run should report deterministic postcondition pass count');
    assert(runState.runEvaluation.effectiveness.postconditionsFailed === 0, 'workflow run should report deterministic postcondition failure count');
    assert(Array.isArray(runState.runEvaluation.effectiveness.errors), 'run evaluation should include errors array');
    assert(runState.runEvaluation.efficiency.workflowSteps === snapshot.workflowActions.length, 'run evaluation should count workflow steps');
    assert(runState.runEvaluation.efficiency.providerRequests === 0, 'run evaluation should count provider requests');
    assert(runState.runEvaluation.efficiency.modelResponses === 0, 'run evaluation should count model responses');
    assert(runState.runEvaluation.efficiency.workspaceOperations === 1, 'run evaluation should count workspace operations');
    assert(runState.runEvaluation.efficiency.mutationCount === 1, 'run evaluation should count mutations');
    assert(runState.runEvaluation.efficiency.retryCount === 0, 'first workflow run should report zero retries');
    assert(runState.runEvaluation.violations.status === 'none', 'normal workflow run should complete formal violation checks with none');
    assert(Array.isArray(runState.runEvaluation.violations.items), 'run evaluation should include violation items array');
    assert(runState.runEvaluation.violations.items.length === 0, 'normal workflow run should not report violation items');
    assert(runState.authorityEvidence.some(item => item.status === 'allowed' && item.operation === 'writeFile' && item.path === workflowInput.path), 'run state should expose allowed authority evidence');
    assert(runState.runConsequence.verification.postconditionsStatus === 'passed', 'run consequence should include passed postcondition verification status');
    assert(runState.runConsequence.verification.violationsStatus === 'none', 'run consequence should include none violation status');
    assert(runState.runConsequence.mutations.some(item => item.operation === 'writeFile' && item.path === workflowInput.path), 'run consequence should record writeFile mutation path');
    assert(runState.runConsequence.created.some(item => item.operation === 'writeFile' && item.path === workflowInput.path), 'run consequence should record created file path');
    assert(runState.runConsequence.updated.length === 0, 'new writeFile workflow should not record updated paths');

    const storedRun = readJson('runs.json').find(item => item.id === run.id);
    assert(storedRun.runEvaluation.efficiency.workspaceOperations === 1, 'run evaluation should be persisted on run');
    assert(storedRun.runEvaluation.violations.status === 'none', 'persisted run evaluation should keep formal none violation state');
    assert(storedRun.runConsequence.created.some(item => item.path === workflowInput.path), 'run consequence should be persisted on run');

    const ticketRuntimeResponse = await request('GET', `/api/tickets/${ticket.id}/runtime`, { cookie });
    assert(ticketRuntimeResponse.statusCode === 200, `ticket runtime API returned HTTP ${ticketRuntimeResponse.statusCode}`);
    const ticketRuntime = JSON.parse(ticketRuntimeResponse.body);
    assert(ticketRuntime.ticket.id === ticket.id, 'ticket runtime should include ticket');
    assert(ticketRuntime.latestRun.id === run.id, 'ticket runtime should include latest run');
    assert(Object.prototype.hasOwnProperty.call(ticketRuntime, 'currentMessage'), 'ticket runtime should include current message field');
    assert(ticketRuntime.currentStep.stepId === 'done', 'ticket runtime should include current step');
    assert(ticketRuntime.leaseState.leaseOwner === run.leaseOwner, 'ticket runtime should include lease state');
    assert(typeof ticketRuntime.outcome === 'string', 'ticket runtime should include outcome');

    const persistedEventTypes = fs.readFileSync(path.join(DATA_DIR, 'events.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map(line => JSON.parse(line).type);
    assert(persistedEventTypes.includes('scheduler.tick'), 'events.jsonl should include scheduler.tick');
    assert(persistedEventTypes.length >= eventsPayload.events.length, 'events.jsonl should persist event lines');

    const failingPostconditionWorkflow = {
      id: `workflow-failing-postcondition-${Date.now()}`,
      name: 'Failing postcondition workflow',
      inputSchema: {},
      actions: [
        {
          id: 'write',
          action: 'writeFile',
          input: {
            path: 'workflow-output/failing-postcondition.txt',
            content: 'actual content'
          },
          next: 'done'
        },
        {
          id: 'done',
          action: 'stop',
          input: {
            result: {
              path: 'workflow-output/failing-postcondition.txt'
            }
          }
        }
      ],
      postconditions: [
        {
          id: 'failing-file-contains',
          type: 'fileContains',
          path: 'workflow-output/failing-postcondition.txt',
          contains: 'expected content'
        }
      ]
    };
    const failingPostconditionResponse = await createWorkflow(cookie, failingPostconditionWorkflow);
    assert(failingPostconditionResponse.statusCode === 302, `failing postcondition workflow save returned HTTP ${failingPostconditionResponse.statusCode}`);
    const failingPostconditionTicketResponse = await request('POST', '/tickets', {
      cookie,
      form: {
        objective: 'Run the failing postcondition workflow',
        capabilityType: 'workflow',
        workflowId: failingPostconditionWorkflow.id,
        workflowInput: '{}',
        assignmentTargetType: 'agent',
        assignmentTargetId: String(agent.id),
        assignmentMode: 'individual'
      }
    });
    assert(failingPostconditionTicketResponse.statusCode === 302, `failing postcondition ticket create returned HTTP ${failingPostconditionTicketResponse.statusCode}`);
    const failingPostconditionTicket = readJson('tickets.json')[readJson('tickets.json').length - 1];
    const failingPostconditionRun = await waitForCompletedRun(failingPostconditionTicket.id);
    assert(failingPostconditionRun.status === 'completed', 'failing postcondition workflow should still complete runtime execution');
    const failingPostconditionStateResponse = await request('GET', `/api/runs/${failingPostconditionRun.id}/state`, { cookie });
    assert(failingPostconditionStateResponse.statusCode === 200, `failing postcondition run state returned HTTP ${failingPostconditionStateResponse.statusCode}`);
    const failingPostconditionState = JSON.parse(failingPostconditionStateResponse.body);
    assert(failingPostconditionState.runEvaluation.effectiveness.status === 'failed', 'failing postcondition should report failed effectiveness');
    assert(failingPostconditionState.runEvaluation.effectiveness.postconditionsPassed === 0, 'failing postcondition should report zero passed postconditions');
    assert(failingPostconditionState.runEvaluation.effectiveness.postconditionsFailed === 1, 'failing postcondition should report one failed postcondition');
    const failingPostconditionEvents = await request('GET', `/api/runs/${failingPostconditionRun.id}/events`, { cookie });
    assert(failingPostconditionEvents.statusCode === 200, `failing postcondition events returned HTTP ${failingPostconditionEvents.statusCode}`);
    assert(JSON.parse(failingPostconditionEvents.body).events.some(event => event.type === 'run.postcondition_failed'), 'failing postcondition should emit run.postcondition_failed');

    const protectedWorkflowDefinition = {
      id: `workflow-protected-write-${Date.now()}`,
      name: 'Protected write workflow',
      inputSchema: {},
      actions: [
        {
          id: 'write',
          action: 'writeFile',
          input: {
            path: 'package.json',
            content: 'should-not-write'
          },
          next: 'done'
        },
        {
          id: 'done',
          action: 'stop',
          input: {}
        }
      ]
    };
    const protectedWorkflowResponse = await createWorkflow(cookie, protectedWorkflowDefinition);
    assert(protectedWorkflowResponse.statusCode === 302, `protected workflow save returned HTTP ${protectedWorkflowResponse.statusCode}`);
    const protectedTicketResponse = await request('POST', '/tickets', {
      cookie,
      form: {
        objective: 'Run the protected write workflow',
        capabilityType: 'workflow',
        workflowId: protectedWorkflowDefinition.id,
        workflowInput: '{}',
        assignmentTargetType: 'agent',
        assignmentTargetId: String(agent.id),
        assignmentMode: 'individual'
      }
    });
    assert(protectedTicketResponse.statusCode === 302, `protected workflow ticket create returned HTTP ${protectedTicketResponse.statusCode}`);
    const protectedTicket = readJson('tickets.json')[readJson('tickets.json').length - 1];
    const protectedRun = await waitForRunStatus(
      Math.max(0, ...readJson('runs.json').filter(item => item.ticketId === protectedTicket.id).map(item => item.id || 0)),
      'failed'
    );
    const protectedRunStateResponse = await request('GET', `/api/runs/${protectedRun.id}/state`, { cookie });
    assert(protectedRunStateResponse.statusCode === 200, `protected run state API returned HTTP ${protectedRunStateResponse.statusCode}`);
    const protectedRunState = JSON.parse(protectedRunStateResponse.body);
    assert(protectedRunState.runEvaluation.violations.status === 'present', 'protected mutation should report present violation status');
    assert(protectedRunState.runEvaluation.violations.items.some(item => item.payload && item.payload.rule === 'protected_path'), 'protected mutation should report protected_path violation item');
    assert(protectedRunState.authorityEvidence.some(item => item.status === 'denied' && item.rule === 'protected_path' && item.operation === 'writeFile' && item.path === 'package.json'), 'protected mutation should expose denied authority evidence');
    assert(protectedRunState.runConsequence.verification.violationsStatus === 'present', 'protected mutation consequence should include present violation status');
    assert(protectedRunState.runConsequence.mutations.some(item => item.attempted === true && item.operation === 'writeFile' && item.path === 'package.json'), 'protected mutation consequence should record attempted writeFile path');
    const protectedEventsResponse = await request('GET', `/api/runs/${protectedRun.id}/events`, { cookie });
    assert(protectedEventsResponse.statusCode === 200, `protected run events API returned HTTP ${protectedEventsResponse.statusCode}`);
    const protectedEvents = JSON.parse(protectedEventsResponse.body).events;
    assert(protectedEvents.some(event => event.type === 'authority.denied'), 'protected mutation should emit authority.denied');
    assert(protectedEvents.some(event => event.type === 'run.violation_detected'), 'protected mutation should emit run.violation_detected');

    const staleRunId = Math.max(0, ...readJson('runs.json').map(item => item.id || 0)) + 1;
    const staleAt = new Date(Date.now() - 60000).toISOString();
    writeJson('runs.json', [
      ...readJson('runs.json'),
      {
        id: staleRunId,
        ticketId: ticket.id,
        agentId: agent.id,
        agentName: agent.name,
        workspaceRoot: WORKSPACE_ROOT,
        mainWorkspaceRoot: WORKSPACE_ROOT,
        executionWorkspaceType: 'main',
        allocationPlanId: null,
        allocationItemId: null,
        allocationSubtask: null,
        ownedOutputPaths: [],
        executionMode: 'workflow',
        workflowId: workflowDefinition.id,
        workflowInput,
        capabilityType: 'workflow',
        capabilityId: workflowDefinition.id,
        capabilityInput: workflowInput,
        status: 'running',
        ticketOpenedAt: ticket.updatedAt,
        createdAt: staleAt,
        updatedAt: staleAt,
        startedAt: staleAt,
        leaseOwner: 'stale-owner',
        leaseExpiresAt: staleAt,
        currentStepId: 'write',
        currentWorkflowAction: 'writeFile',
        lastHeartbeatAt: staleAt
      }
    ]);
    const interruptedStaleRun = await waitForRunStatus(staleRunId, 'interrupted');
    assert(interruptedStaleRun.currentStepId === 'write', 'interrupted stale run should retain last known step id');
    assert(interruptedStaleRun.currentWorkflowAction === 'writeFile', 'interrupted stale run should retain last known workflow action');
    const staleEvents = await request('GET', `/api/runs/${staleRunId}/events`, { cookie });
    assert(staleEvents.statusCode === 200, `stale run events API returned HTTP ${staleEvents.statusCode}`);
    assert(JSON.parse(staleEvents.body).events.some(event => event.type === 'run.lease_expired'), 'expired lease should append run.lease_expired');
    const staleRunStateResponse = await request('GET', `/api/runs/${staleRunId}/state`, { cookie });
    assert(staleRunStateResponse.statusCode === 200, `stale run state API returned HTTP ${staleRunStateResponse.statusCode}`);
    const staleRunState = JSON.parse(staleRunStateResponse.body);
    assert(staleRunState.status === 'interrupted', 'stale run state should report interrupted status');
    assert(staleRunState.currentStepId === 'write', 'stale run state should retain current step id');
    assert(staleRunState.currentWorkflowAction === 'writeFile', 'stale run state should retain current workflow action');
    assert(staleRunState.lease.expired === true, 'stale run state should report expired lease');

    console.log(JSON.stringify({
      workflowValidation: true,
      workflowRun: true,
      leaseExpiry: true,
      operationalEvents: eventTypes.length,
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

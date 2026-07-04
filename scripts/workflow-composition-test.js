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

async function waitForTicketStatus(ticketId, status) {
  const started = Date.now();

  while (Date.now() - started < 5000) {
    const ticket = readJson('tickets.json').find(item => item.id === ticketId);
    if (ticket && ticket.status === status) return ticket;
    await new Promise(resolve => setTimeout(resolve, 100));
  }

  throw new Error(`Timed out waiting for ticket #${ticketId} status ${status}`);
}

async function waitForRunTriage(runId, reasonCode) {
  const started = Date.now();
  let lastRun = null;

  while (Date.now() - started < 5000) {
    const run = readJson('runs.json').find(item => item.id === runId);
    lastRun = run || lastRun;
    const snapshotPath = run && run.replaySnapshotPath
      ? path.join(DATA_DIR, run.replaySnapshotPath)
      : null;
    const replaySnapshot = snapshotPath && fs.existsSync(snapshotPath)
      ? JSON.parse(fs.readFileSync(snapshotPath, 'utf8'))
      : null;
    if (run && run.triage && run.triage.reasonCode === reasonCode &&
        replaySnapshot && replaySnapshot.triage &&
        replaySnapshot.triage.reasonCode === reasonCode) {
      return { ...run, replaySnapshot };
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }

  throw new Error(`Timed out waiting for run #${runId} triage ${reasonCode}: ${JSON.stringify(lastRun)}`);
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

function seedLegacyTicketWithoutExecutionPolicy(assignedAgentId) {
  const tickets = readJson('tickets.json');
  const now = new Date().toISOString();
  const ticket = {
    id: Math.max(0, ...tickets.map(item => item.id || 0)) + 1,
    objective: 'Legacy ticket fixture without executionPolicy',
    assignmentTargetType: 'agent',
    assignmentTargetId: assignedAgentId,
    assignmentMode: 'individual',
    status: 'closed',
    createdBy: 'admin',
    changedBy: 'admin',
    changedAt: now,
    createdAt: now,
    updatedAt: now
  };
  writeJson('tickets.json', [...tickets, ticket]);
  return ticket.id;
}

async function main() {
  const agent = seedWorkflowAgent();
  const seededLegacyTicketId = seedLegacyTicketWithoutExecutionPolicy(agent.id);
  const legacyTicketId = (readJson('tickets.json').find(item => item.id === seededLegacyTicketId && !item.executionPolicy && item.assignmentTargetType === 'agent') || {}).id;
  assert(legacyTicketId, 'test fixture should include an old ticket without executionPolicy before startup normalization');
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
    const legacyTicketsResponse = await request('GET', '/api/tickets?limit=1000', { cookie });
    assert(legacyTicketsResponse.statusCode === 200, `legacy ticket normalization API returned HTTP ${legacyTicketsResponse.statusCode}`);
    const normalizedLegacyTicket = JSON.parse(legacyTicketsResponse.body).tickets.find(item => item.id === legacyTicketId);
    assert(normalizedLegacyTicket && normalizedLegacyTicket.executionPolicy, 'old tickets should normalize with an execution policy');
    assert(normalizedLegacyTicket.executionPolicy.mode === 'assisted', 'old ticket default policy should use assisted mode');
    assert(normalizedLegacyTicket.executionPolicy.requireVerification === 'when_declared', 'old ticket default policy should verify when declared');
    assert(normalizedLegacyTicket.executionPolicy.maxAttempts === null, 'old ticket default policy should normalize maxAttempts to unlimited (null)');
    assert(normalizedLegacyTicket.executionPolicy.workspaceScope === 'shared', 'old individual ticket default policy should record shared workspace scope');

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
      version: '1',
      enabled: true,
      policy: {
        id: 'test-workflow-policy',
        version: '1',
        text: 'Write the requested workflow output exactly as provided.'
      },
      verifierContract: {
        id: 'test-workflow-verifier',
        version: '1',
        fixture: 'workflow-composition',
        expectedArtifacts: ['workflow-output/result.txt']
      },
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
    const suppliedExecutionPolicy = {
      mode: 'assisted',
      requireVerification: 'when_declared',
      autoRetry: false,
      maxAttempts: 3,
      maxRuntimeMs: 45000,
      maxModelRequests: 5,
      maxWorkspaceOperations: 8,
      allowWorkspaceWrites: true,
      allowParallelRuns: false,
      allowChildTickets: false,
      workspaceScope: 'shared'
    };
    const ticketResponse = await request('POST', '/tickets', {
      cookie,
      form: {
        objective: 'Run the test write workflow',
        capabilityType: 'workflow',
        workflowId: workflowDefinition.id,
        workflowInput: JSON.stringify(workflowInput),
        assignmentTargetType: 'agent',
        assignmentTargetId: String(agent.id),
        assignmentMode: 'individual',
        executionPolicy: JSON.stringify(suppliedExecutionPolicy)
      }
    });
    assert(ticketResponse.statusCode === 302, `workflow ticket create returned HTTP ${ticketResponse.statusCode}`);

    const tickets = readJson('tickets.json');
    const ticket = tickets[tickets.length - 1];
    assert(ticket.executionMode === 'workflow', 'ticket should persist workflow execution mode');
    assert(ticket.capabilityType === 'workflow', 'ticket should persist workflow capability type');
    assert(ticket.capabilityId === workflowDefinition.id, 'ticket should persist selected capability id');
    assert(ticket.workflowId === workflowDefinition.id, 'ticket should persist workflow id');
    assert(JSON.stringify(ticket.executionPolicy) === JSON.stringify(suppliedExecutionPolicy), 'new ticket should persist the supplied normalized execution policy');

    const run = await waitForCompletedRun(ticket.id);
    assert(run.status === 'completed', `workflow run should complete, got ${run.status}: ${run.error || ''}`);
    assert((await waitForTicketStatus(ticket.id, 'completed')).status === 'completed', 'ticket should complete after required workflow verification passes');
    assert(typeof run.leaseOwner === 'string' && run.leaseOwner.length > 0, 'workflow run should persist lease owner');
    assert(typeof run.leaseExpiresAt === 'string' && run.leaseExpiresAt.length > 0, 'workflow run should persist lease expiration');
    assert(typeof run.lastHeartbeatAt === 'string' && run.lastHeartbeatAt.length > 0, 'workflow run should persist heartbeat time');
    assert(run.currentStepId === 'done', 'workflow run should persist last completed workflow step id');
    assert(run.currentWorkflowAction === 'stop', 'workflow run should persist last completed workflow action');
    assert(JSON.stringify(run.executionPolicySnapshot) === JSON.stringify(suppliedExecutionPolicy), 'run should copy the ticket execution policy at creation');
    assert(run.verificationContractSnapshot && run.verificationContractSnapshot.workflowId === workflowDefinition.id, 'workflow run should snapshot its verification contract');
    assert(JSON.stringify(run.verificationContractSnapshot.postconditions) === JSON.stringify(workflowDefinition.postconditions), 'verification contract snapshot should preserve declared postconditions');
    assert(run.verificationContractSnapshot.verifierContract.id === workflowDefinition.verifierContract.id, 'verification contract snapshot should preserve verifier contract metadata');
    assert(fs.readFileSync(path.join(WORKSPACE_ROOT, workflowInput.path), 'utf8') === workflowInput.content, 'workflow writeFile should mutate workspace through runtime');

    const snapshotPath = path.join(DATA_DIR, run.replaySnapshotPath);
    const snapshot = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));
    assert(snapshot.capabilitySelection.some(item => item.capability && item.capability.id === workflowDefinition.id), 'workflow run should record selected capability');
    assert(snapshot.capabilityOutputs.some(item => item.capabilityId === workflowDefinition.id && item.output), 'workflow run should record capability output');
    const workflowInvocation = snapshot.workflowInvocation.find(item => item.workflowId === workflowDefinition.id);
    assert(workflowInvocation, 'workflow run should record workflow invocation');
    assert(workflowInvocation.workflowVersion === '1', 'workflow invocation should record workflow version');
    assert(workflowInvocation.policyId === 'test-workflow-policy', 'workflow invocation should record policy id');
    assert(workflowInvocation.policyVersion === '1', 'workflow invocation should record policy version');
    assert(typeof workflowInvocation.policyTextHash === 'string' && workflowInvocation.policyTextHash.length === 64, 'workflow invocation should record policy text hash');
    assert(workflowInvocation.verifierContractId === 'test-workflow-verifier', 'workflow invocation should record verifier contract id');
    assert(workflowInvocation.verifierContractVersion === '1', 'workflow invocation should record verifier contract version');
    assert(snapshot.workflowActions.some(item => item.action === 'writeFile'), 'workflow run should record writeFile workflow action');
    assert(snapshot.workflowActions.some(item => item.action === 'stop'), 'workflow run should record stop workflow action');
    assert(snapshot.authorityChecks.some(item => item.status === 'allowed' && item.operation === 'writeFile' && item.path === workflowInput.path), 'workflow run should record allowed authority evidence');
    assert(snapshot.workspaceOperations.some(item => item.workflowId === workflowDefinition.id && item.workflowStepId === 'write'), 'workflow workspace action should record workflow provenance');
    assert(JSON.stringify(snapshot.executionPolicySnapshot) === JSON.stringify(suppliedExecutionPolicy), 'replay snapshot should preserve the run execution policy snapshot');
    assert(JSON.stringify(snapshot.verificationContractSnapshot) === JSON.stringify(run.verificationContractSnapshot), 'replay snapshot should preserve the run verification contract snapshot');
    assert(snapshot.triage === null, 'successful replay snapshot should not require triage');
    assert(ticket.triage === null, 'successful runnable ticket should not require ticket-level triage');
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
    assert(eventTypes.includes('run.verification_passed'), 'events should include run.verification_passed before completed terminalization');
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
    assert(runState.triage === null, 'successful completion should not create required triage');
    assert(JSON.stringify(runState.executionPolicySnapshot) === JSON.stringify(suppliedExecutionPolicy), 'run state API should expose the execution policy snapshot');
    assert(JSON.stringify(runState.verificationContractSnapshot) === JSON.stringify(run.verificationContractSnapshot), 'run state API should expose the verification contract snapshot');
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
    const verifiedRunPage = await request('GET', `/runs/${run.id}`, { cookie });
    assert(verifiedRunPage.statusCode === 200, `verified run detail returned HTTP ${verifiedRunPage.statusCode}`);
    assert(verifiedRunPage.body.includes('<strong>Objective Success:</strong> Yes'), 'passing required verification should report objective success');
    assert(verifiedRunPage.body.includes('Execution Policy Snapshot'), 'run detail should show the execution policy snapshot');
    assert(verifiedRunPage.body.includes('<code>when_declared</code>'), 'run detail should show the snapshot verification mode');
    assert(verifiedRunPage.body.includes('recorded intent, not enforced'), 'run detail should label unenforced policy fields as recorded intent');
    assert(!verifiedRunPage.body.includes('<dt>Workspace writes</dt><dd>Allowed'), 'run detail must not present workspace-write intent as enforced permission');

    const ticketsAfterRun = readJson('tickets.json');
    const changedTicket = ticketsAfterRun.find(item => item.id === ticket.id);
    changedTicket.executionPolicy = { ...changedTicket.executionPolicy, maxAttempts: 9, maxRuntimeMs: 90000 };
    writeJson('tickets.json', ticketsAfterRun);
    const runAfterTicketPolicyChange = readJson('runs.json').find(item => item.id === run.id);
    const replayAfterTicketPolicyChange = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));
    assert(runAfterTicketPolicyChange.executionPolicySnapshot.maxAttempts === 3, 'changing ticket policy must not mutate the run policy snapshot');
    assert(runAfterTicketPolicyChange.executionPolicySnapshot.maxRuntimeMs === 45000, 'run policy snapshot should retain its original runtime value');
    assert(replayAfterTicketPolicyChange.executionPolicySnapshot.maxAttempts === 3, 'changing ticket policy must not mutate replay policy evidence');
    const changedTicketPage = await request('GET', `/tickets/${ticket.id}`, { cookie });
    assert(changedTicketPage.statusCode === 200, `changed ticket detail returned HTTP ${changedTicketPage.statusCode}`);
    assert(changedTicketPage.body.includes('Execution policy'), 'ticket detail should show the current execution policy');
    assert(changedTicketPage.body.includes('recorded intent') && changedTicketPage.body.includes('not enforced'), 'ticket detail should label unenforced policy fields as recorded intent');
    assert(!changedTicketPage.body.includes('<dt>Workspace writes</dt><dd>Allowed'), 'ticket detail must not present workspace-write intent as enforced permission');
    const closeVerifiedTicketResponse = await request('PATCH', `/api/tickets/${ticket.id}/status`, {
      cookie,
      body: { status: 'closed' }
    });
    assert(closeVerifiedTicketResponse.statusCode === 200, `verified ticket close returned HTTP ${closeVerifiedTicketResponse.statusCode}`);
    const completeVerifiedTicketResponse = await request('PATCH', `/api/tickets/${ticket.id}/status`, {
      cookie,
      body: { status: 'completed' }
    });
    assert(completeVerifiedTicketResponse.statusCode === 200, `verified ticket should allow manual completed transition, got HTTP ${completeVerifiedTicketResponse.statusCode}`);
    assert(changedTicketPage.body.includes('<dt>Max attempts</dt><dd>9 · enforced for manual rerun-from-start</dd>'), 'ticket detail should show the changed current policy independently of the run snapshot');

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

    const invalidBranchWorkflow = {
      id: `workflow-invalid-branch-${Date.now()}`,
      name: 'Invalid branch workflow',
      inputSchema: { route: 'string' },
      actions: [
        {
          id: 'choose',
          action: 'condition',
          input: { value: '{{workflow.input.route}}', equals: 'a' },
          trueNext: 'missing-write',
          falseNext: 'write-b'
        },
        {
          id: 'write-b',
          action: 'writeFile',
          input: { path: 'workflow-output/branch-b.txt', content: 'B' },
          next: 'done'
        },
        { id: 'done', action: 'stop', input: {} }
      ]
    };
    const invalidBranchResponse = await createWorkflow(cookie, invalidBranchWorkflow);
    assert(invalidBranchResponse.statusCode === 400, 'invalid trueNext reference should be rejected');
    assert(invalidBranchResponse.body.includes('points to unknown next action'), 'invalid trueNext rejection should name the branch reference problem');

    const branchWorkflow = {
      id: `workflow-branch-v1-${Date.now()}`,
      name: 'Branch V1 workflow',
      inputSchema: { route: 'string' },
      actions: [
        {
          id: 'choose',
          action: 'condition',
          input: { value: '{{workflow.input.route}}', equals: 'a' },
          trueNext: 'write-a',
          falseNext: 'write-b'
        },
        {
          id: 'write-a',
          action: 'writeFile',
          input: { path: 'workflow-output/branch-a.txt', content: 'A' },
          next: 'done'
        },
        {
          id: 'write-b',
          action: 'writeFile',
          input: { path: 'workflow-output/branch-b.txt', content: 'B' },
          next: 'done'
        },
        { id: 'done', action: 'stop', input: { result: { branched: true } } }
      ]
    };
    const branchResponse = await createWorkflow(cookie, branchWorkflow);
    assert(branchResponse.statusCode === 302, `branch workflow save returned HTTP ${branchResponse.statusCode}`);

    const branchTrueTicketResponse = await request('POST', '/tickets', {
      cookie,
      form: {
        objective: 'Run branch workflow true path',
        capabilityType: 'workflow',
        workflowId: branchWorkflow.id,
        workflowInput: JSON.stringify({ route: 'a' }),
        assignmentTargetType: 'agent',
        assignmentTargetId: String(agent.id),
        assignmentMode: 'individual'
      }
    });
    assert(branchTrueTicketResponse.statusCode === 302, `branch true ticket create returned HTTP ${branchTrueTicketResponse.statusCode}`);
    const branchTrueTicket = readJson('tickets.json')[readJson('tickets.json').length - 1];
    assert(branchTrueTicket.executionPolicy.mode === 'assisted', 'new ticket without supplied policy should persist assisted mode');
    assert(branchTrueTicket.executionPolicy.requireVerification === 'when_declared', 'new ticket without supplied policy should persist when_declared verification');
    assert(branchTrueTicket.executionPolicy.maxAttempts === null, 'new ticket without supplied policy should persist unlimited (null) max attempts');
    assert(branchTrueTicket.executionPolicy.maxRuntimeMs === null, 'new ticket without supplied policy should preserve runtime default');
    assert(branchTrueTicket.executionPolicy.allowWorkspaceWrites === true, 'new ticket default policy should allow existing workspace writes');
    assert(branchTrueTicket.executionPolicy.allowParallelRuns === false, 'new ticket default policy should disallow parallel runs');
    assert(branchTrueTicket.executionPolicy.allowChildTickets === false, 'new ticket default policy should disallow child tickets');
    assert(branchTrueTicket.executionPolicy.workspaceScope === 'shared', 'new individual ticket default policy should record shared workspace scope');
    const branchTrueRun = await waitForCompletedRun(branchTrueTicket.id);
    assert(branchTrueRun.status === 'completed', 'branch true path should complete');
    assert(fs.readFileSync(path.join(WORKSPACE_ROOT, 'workflow-output/branch-a.txt'), 'utf8') === 'A', 'trueNext path should write branch A file');
    assert(!fs.existsSync(path.join(WORKSPACE_ROOT, 'workflow-output/branch-b.txt')), 'trueNext path should not write branch B file');
    const unverifiedCompletedRunPage = await request('GET', `/runs/${branchTrueRun.id}`, { cookie });
    assert(unverifiedCompletedRunPage.statusCode === 200, `unverified completed run detail returned HTTP ${unverifiedCompletedRunPage.statusCode}`);
    assert(unverifiedCompletedRunPage.body.includes('<strong>Objective Success:</strong> Unverified'), 'completed status alone must not report 100% objective success');
    const closeUnverifiedTicketResponse = await request('PATCH', `/api/tickets/${branchTrueTicket.id}/status`, {
      cookie,
      body: { status: 'closed' }
    });
    assert(closeUnverifiedTicketResponse.statusCode === 200, `unverified ticket close returned HTTP ${closeUnverifiedTicketResponse.statusCode}`);
    const completeUnverifiedTicketResponse = await request('PATCH', `/api/tickets/${branchTrueTicket.id}/status`, {
      cookie,
      body: { status: 'completed' }
    });
    // Option A: a postcondition-free run requires no verification, so operational
    // completion is a legitimate completed-but-unverified state and may be
    // completed manually. The run detail still reports objective success as
    // Unverified (asserted above) — completed != verified.
    assert(completeUnverifiedTicketResponse.statusCode === 200, `verification-free completed ticket should allow manual completed transition, got HTTP ${completeUnverifiedTicketResponse.statusCode}`);
    const ticketListAfterUnverifiedCompletion = await request('GET', '/tickets', { cookie });
    assert(ticketListAfterUnverifiedCompletion.statusCode === 200, 'ticket list should remain available after unverified completion');
    assert(ticketListAfterUnverifiedCompletion.body.includes('Ticket status change was rejected.'), 'ticket status UI should still surface rejected status changes');

    const branchFalseTicketResponse = await request('POST', '/tickets', {
      cookie,
      form: {
        objective: 'Run branch workflow false path',
        capabilityType: 'workflow',
        workflowId: branchWorkflow.id,
        workflowInput: JSON.stringify({ route: 'b' }),
        assignmentTargetType: 'agent',
        assignmentTargetId: String(agent.id),
        assignmentMode: 'individual'
      }
    });
    assert(branchFalseTicketResponse.statusCode === 302, `branch false ticket create returned HTTP ${branchFalseTicketResponse.statusCode}`);
    const branchFalseTicket = readJson('tickets.json')[readJson('tickets.json').length - 1];
    const branchFalseRun = await waitForCompletedRun(branchFalseTicket.id);
    assert(branchFalseRun.status === 'completed', 'branch false path should complete');
    assert(fs.readFileSync(path.join(WORKSPACE_ROOT, 'workflow-output/branch-b.txt'), 'utf8') === 'B', 'falseNext path should write branch B file');

    const exactMutationCapWorkflow = {
      id: `workflow-exact-mutation-cap-${Date.now()}`,
      name: 'Exact mutation cap workflow',
      inputSchema: {},
      actions: [
        {
          id: 'write-a',
          action: 'writeFile',
          input: { path: 'workflow-output/exact-cap-a.txt', content: 'A' },
          next: 'write-b'
        },
        {
          id: 'write-b',
          action: 'writeFile',
          input: { path: 'workflow-output/exact-cap-b.txt', content: 'B' },
          next: 'done'
        },
        { id: 'done', action: 'stop', input: { result: { completed: true } } }
      ]
    };
    const exactMutationCapResponse = await createWorkflow(cookie, exactMutationCapWorkflow);
    assert(exactMutationCapResponse.statusCode === 302, `exact mutation cap workflow save returned HTTP ${exactMutationCapResponse.statusCode}`);
    const exactMutationCapTicketResponse = await request('POST', '/tickets', {
      cookie,
      form: {
        objective: 'Run exact mutation cap workflow',
        capabilityType: 'workflow',
        workflowId: exactMutationCapWorkflow.id,
        workflowInput: '{}',
        assignmentTargetType: 'agent',
        assignmentTargetId: String(agent.id),
        assignmentMode: 'individual'
      }
    });
    assert(exactMutationCapTicketResponse.statusCode === 302, `exact mutation cap ticket create returned HTTP ${exactMutationCapTicketResponse.statusCode}`);
    const exactMutationCapTicket = readJson('tickets.json')[readJson('tickets.json').length - 1];
    const exactMutationCapRun = await waitForCompletedRun(exactMutationCapTicket.id);
    assert(exactMutationCapRun.status === 'completed', `exactly two mutating workflow writes followed by stop should complete, got ${exactMutationCapRun.status}: ${exactMutationCapRun.error || ''}`);
    assert(exactMutationCapRun.currentWorkflowAction === 'stop', 'exact mutation cap workflow should execute non-mutating stop after two writes');
    assert(fs.readFileSync(path.join(WORKSPACE_ROOT, 'workflow-output/exact-cap-a.txt'), 'utf8') === 'A', 'exact mutation cap workflow should write first file');
    assert(fs.readFileSync(path.join(WORKSPACE_ROOT, 'workflow-output/exact-cap-b.txt'), 'utf8') === 'B', 'exact mutation cap workflow should write second file');
    const exactMutationCapSnapshot = JSON.parse(fs.readFileSync(path.join(DATA_DIR, exactMutationCapRun.replaySnapshotPath), 'utf8'));
    assert(exactMutationCapSnapshot.workflowActions.some(item => item.stepId === 'done' && item.action === 'stop'), 'exact mutation cap replay should record stop step');


    fs.writeFileSync(path.join(WORKSPACE_ROOT, 'workflow-output/rename-source.txt'), 'rename me', 'utf8');
    const renameOutputWorkflow = {
      id: `workflow-rename-output-contract-${Date.now()}`,
      name: 'Rename output contract workflow',
      inputSchema: {},
      actions: [
        {
          id: 'rename-file',
          action: 'renamePath',
          input: {
            path: 'workflow-output/rename-source.txt',
            nextPath: 'workflow-output/rename-destination.txt'
          },
          next: 'done'
        },
        { id: 'done', action: 'stop', input: { result: { completed: true } } }
      ],
      postconditions: [
        { id: 'renamed-file-exists', type: 'fileExists', path: 'workflow-output/rename-destination.txt' }
      ]
    };
    const renameOutputResponse = await createWorkflow(cookie, renameOutputWorkflow);
    assert(renameOutputResponse.statusCode === 302, `rename output workflow save returned HTTP ${renameOutputResponse.statusCode}`);
    const renameOutputTicketResponse = await request('POST', '/tickets', {
      cookie,
      form: {
        objective: 'Run rename output contract workflow',
        capabilityType: 'workflow',
        workflowId: renameOutputWorkflow.id,
        workflowInput: '{}',
        assignmentTargetType: 'agent',
        assignmentTargetId: String(agent.id),
        assignmentMode: 'individual'
      }
    });
    assert(renameOutputTicketResponse.statusCode === 302, `rename output ticket create returned HTTP ${renameOutputTicketResponse.statusCode}`);
    const renameOutputTicket = readJson('tickets.json')[readJson('tickets.json').length - 1];
    const renameOutputRun = await waitForCompletedRun(renameOutputTicket.id);
    assert(renameOutputRun.status === 'completed', `renamePath workflow should complete, got ${renameOutputRun.status}: ${renameOutputRun.error || ''}`);
    assert(!fs.existsSync(path.join(WORKSPACE_ROOT, 'workflow-output/rename-source.txt')), 'renamePath workflow should move source file');
    assert(fs.readFileSync(path.join(WORKSPACE_ROOT, 'workflow-output/rename-destination.txt'), 'utf8') === 'rename me', 'renamePath workflow should preserve file content');
    const renameOutputSnapshot = JSON.parse(fs.readFileSync(path.join(DATA_DIR, renameOutputRun.replaySnapshotPath), 'utf8'));
    const renameWorkflowAction = renameOutputSnapshot.workflowActions.find(item => item.stepId === 'rename-file' && item.action === 'renamePath');
    assert(renameWorkflowAction, 'renamePath workflow action should be recorded in replay');
    assert(renameWorkflowAction.result.status === 'renamed', 'renamePath workflow action result should satisfy status contract');
    assert(renameWorkflowAction.result.path === 'workflow-output/rename-destination.txt', 'renamePath workflow action result should preserve destination path');
    assert(renameWorkflowAction.result.historyId, 'renamePath workflow action result should preserve historyId');
    const renameHistory = readJson('operation-history.json').find(item => item.runId === renameOutputRun.id && item.operation === 'renamePath');
    assert(renameHistory, 'renamePath workflow should persist operation history');
    assert(renameHistory.result.status === 'renamed', 'renamePath operation history should preserve status');
    assert(renameHistory.result.path === 'workflow-output/rename-destination.txt', 'renamePath operation history should preserve destination path');


    fs.writeFileSync(path.join(WORKSPACE_ROOT, 'workflow-output/plan-source.txt'), 'plan move', 'utf8');
    const actionPlanWorkflow = {
      id: `workflow-action-plan-valid-${Date.now()}`,
      name: 'Valid action plan workflow',
      inputSchema: {},
      actions: [
        {
          id: 'execute-plan',
          action: 'executeActionPlan',
          input: {
            actions: [
              { operation: 'createFolder', args: { path: 'workflow-output/plan-dest' }, reason: 'prepare destination' },
              { operation: 'renamePath', args: { path: 'workflow-output/plan-source.txt', nextPath: 'workflow-output/plan-dest/plan-source.txt' }, reason: 'move selected file' }
            ],
            allowedOperations: ['createFolder', 'renamePath'],
            maxActions: 8,
            maxMutations: 6
          },
          next: 'done'
        },
        { id: 'done', action: 'stop', input: { result: { completed: true } } }
      ],
      postconditions: [
        { id: 'plan-destination-exists', type: 'fileExists', path: 'workflow-output/plan-dest/plan-source.txt' }
      ]
    };
    const actionPlanResponse = await createWorkflow(cookie, actionPlanWorkflow);
    assert(actionPlanResponse.statusCode === 302, `action plan workflow save returned HTTP ${actionPlanResponse.statusCode}`);
    const actionPlanTicketResponse = await request('POST', '/tickets', {
      cookie,
      form: {
        objective: 'Run valid action plan workflow',
        capabilityType: 'workflow',
        workflowId: actionPlanWorkflow.id,
        workflowInput: '{}',
        assignmentTargetType: 'agent',
        assignmentTargetId: String(agent.id),
        assignmentMode: 'individual'
      }
    });
    assert(actionPlanTicketResponse.statusCode === 302, `action plan ticket create returned HTTP ${actionPlanTicketResponse.statusCode}`);
    const actionPlanTicket = readJson('tickets.json')[readJson('tickets.json').length - 1];
    const actionPlanRun = await waitForCompletedRun(actionPlanTicket.id);
    assert(actionPlanRun.status === 'completed', `valid executeActionPlan workflow should complete, got ${actionPlanRun.status}: ${actionPlanRun.error || ''}`);
    assert(!fs.existsSync(path.join(WORKSPACE_ROOT, 'workflow-output/plan-source.txt')), 'executeActionPlan should move source file');
    assert(fs.readFileSync(path.join(WORKSPACE_ROOT, 'workflow-output/plan-dest/plan-source.txt'), 'utf8') === 'plan move', 'executeActionPlan should preserve moved file content');
    const actionPlanSnapshot = JSON.parse(fs.readFileSync(path.join(DATA_DIR, actionPlanRun.replaySnapshotPath), 'utf8'));
    const actionPlanEvidence = (actionPlanSnapshot.workflowActionPlans || []).find(item => item.stepId === 'execute-plan');
    assert(actionPlanEvidence, 'executeActionPlan should record workflowActionPlans evidence');
    assert(actionPlanEvidence.proposedActions.length === 2, 'executeActionPlan replay should record proposed actions');
    assert(actionPlanEvidence.acceptedActions.length === 2, 'executeActionPlan replay should record accepted actions');
    assert(actionPlanEvidence.rejectedActions.length === 0, 'valid executeActionPlan should not reject actions');
    assert(actionPlanEvidence.executedActions.length === 2, 'executeActionPlan replay should record executed actions');
    const actionPlanWorkflowAction = actionPlanSnapshot.workflowActions.find(item => item.stepId === 'execute-plan' && item.action === 'executeActionPlan');
    assert(actionPlanWorkflowAction.result.status === 'executed', 'executeActionPlan workflow action should report executed status');
    const actionPlanRenamed = actionPlanSnapshot.workspaceOperations.find(item => item.workflowStepId === 'execute-plan' && item.operation.operation === 'renamePath');
    assert(actionPlanRenamed && actionPlanRenamed.result.status === 'renamed', 'executeActionPlan renamePath should preserve status/path/historyId result');

    fs.writeFileSync(path.join(WORKSPACE_ROOT, 'workflow-output/reject-delete.txt'), 'keep me', 'utf8');
    const invalidActionPlanWorkflow = {
      id: `workflow-action-plan-invalid-${Date.now()}`,
      name: 'Invalid action plan workflow',
      inputSchema: {},
      actions: [
        {
          id: 'execute-plan',
          action: 'executeActionPlan',
          input: {
            actions: [
              { operation: 'deletePath', args: { path: 'workflow-output/reject-delete.txt' }, reason: 'not allowed' }
            ],
            allowedOperations: ['createFolder', 'renamePath'],
            maxActions: 8,
            maxMutations: 6
          },
          next: 'done'
        },
        { id: 'done', action: 'stop', input: { result: { completed: true } } }
      ]
    };
    await createWorkflow(cookie, invalidActionPlanWorkflow);
    const invalidPlanTicketResponse = await request('POST', '/tickets', {
      cookie,
      form: {
        objective: 'Run invalid action plan workflow',
        capabilityType: 'workflow',
        workflowId: invalidActionPlanWorkflow.id,
        workflowInput: '{}',
        assignmentTargetType: 'agent',
        assignmentTargetId: String(agent.id),
        assignmentMode: 'individual'
      }
    });
    assert(invalidPlanTicketResponse.statusCode === 302, `invalid action plan ticket create returned HTTP ${invalidPlanTicketResponse.statusCode}`);
    const invalidPlanTicket = readJson('tickets.json')[readJson('tickets.json').length - 1];
    const invalidPlanRun = await waitForCompletedRun(invalidPlanTicket.id);
    assert(invalidPlanRun.status === 'completed', 'invalid operation should be rejected without failing workflow execution');
    assert(fs.existsSync(path.join(WORKSPACE_ROOT, 'workflow-output/reject-delete.txt')), 'rejected deletePath should not execute');
    const invalidPlanSnapshot = JSON.parse(fs.readFileSync(path.join(DATA_DIR, invalidPlanRun.replaySnapshotPath), 'utf8'));
    const invalidPlanEvidence = (invalidPlanSnapshot.workflowActionPlans || []).find(item => item.stepId === 'execute-plan');
    assert(invalidPlanEvidence.proposedActions.length === 1, 'invalid action plan should record proposed action');
    assert(invalidPlanEvidence.acceptedActions.length === 0, 'invalid action plan should accept no actions');
    assert(invalidPlanEvidence.rejectedActions.length === 1, 'invalid action plan should record rejected action');
    assert(invalidPlanEvidence.executedActions.length === 0, 'invalid action plan should execute no actions');
    assert(invalidPlanEvidence.rejectedActions[0].validationReasons.some(reason => reason.includes('not in allowedOperations')), 'rejection should explain allowed operation failure');
    assert(!invalidPlanSnapshot.workspaceOperations.some(item => item.operation.operation === 'deletePath'), 'rejected operation should not appear as workspace execution');

    const overMaxActionPlanWorkflow = {
      id: `workflow-action-plan-over-max-${Date.now()}`,
      name: 'Over max action plan workflow',
      inputSchema: {},
      actions: [
        {
          id: 'execute-plan',
          action: 'executeActionPlan',
          input: {
            actions: [
              { operation: 'createFolder', args: { path: 'workflow-output/over-max-a' }, reason: 'one' },
              { operation: 'createFolder', args: { path: 'workflow-output/over-max-b' }, reason: 'two' }
            ],
            allowedOperations: ['createFolder', 'renamePath'],
            maxActions: 1,
            maxMutations: 6
          },
          next: 'done'
        },
        { id: 'done', action: 'stop', input: { result: { completed: true } } }
      ]
    };
    await createWorkflow(cookie, overMaxActionPlanWorkflow);
    const overMaxPlanTicketResponse = await request('POST', '/tickets', {
      cookie,
      form: {
        objective: 'Run over max action plan workflow',
        capabilityType: 'workflow',
        workflowId: overMaxActionPlanWorkflow.id,
        workflowInput: '{}',
        assignmentTargetType: 'agent',
        assignmentTargetId: String(agent.id),
        assignmentMode: 'individual'
      }
    });
    assert(overMaxPlanTicketResponse.statusCode === 302, `over max action plan ticket create returned HTTP ${overMaxPlanTicketResponse.statusCode}`);
    const overMaxPlanTicket = readJson('tickets.json')[readJson('tickets.json').length - 1];
    const overMaxPlanRun = await waitForCompletedRun(overMaxPlanTicket.id);
    assert(overMaxPlanRun.status === 'completed', 'over max action plan should reject deterministically without executing actions');
    assert(!fs.existsSync(path.join(WORKSPACE_ROOT, 'workflow-output/over-max-a')), 'over max action plan should not execute first action');
    assert(!fs.existsSync(path.join(WORKSPACE_ROOT, 'workflow-output/over-max-b')), 'over max action plan should not execute second action');
    const overMaxPlanSnapshot = JSON.parse(fs.readFileSync(path.join(DATA_DIR, overMaxPlanRun.replaySnapshotPath), 'utf8'));
    const overMaxPlanEvidence = (overMaxPlanSnapshot.workflowActionPlans || []).find(item => item.stepId === 'execute-plan');
    assert(overMaxPlanEvidence.acceptedActions.length === 0, 'over max action plan should accept no actions');
    assert(overMaxPlanEvidence.rejectedActions.length === 2, 'over max action plan should reject all proposed actions');

    fs.writeFileSync(path.join(WORKSPACE_ROOT, 'workflow-output/budget-source.txt'), 'budget move', 'utf8');
    const budgetActionPlanWorkflow = {
      id: `workflow-action-plan-budget-${Date.now()}`,
      name: 'Budget action plan workflow',
      inputSchema: {},
      actions: [
        {
          id: 'execute-plan',
          action: 'executeActionPlan',
          input: {
            actions: [
              { operation: 'createFolder', args: { path: 'workflow-output/budget-dest' }, reason: 'prepare' },
              { operation: 'renamePath', args: { path: 'workflow-output/budget-source.txt', nextPath: 'workflow-output/budget-dest/budget-source.txt' }, reason: 'move' }
            ],
            allowedOperations: ['createFolder', 'renamePath'],
            maxActions: 8,
            maxMutations: 1
          },
          next: 'done'
        },
        { id: 'done', action: 'stop', input: { result: { completed: true } } }
      ]
    };
    await createWorkflow(cookie, budgetActionPlanWorkflow);
    const budgetPlanTicketResponse = await request('POST', '/tickets', {
      cookie,
      form: {
        objective: 'Run budget action plan workflow',
        capabilityType: 'workflow',
        workflowId: budgetActionPlanWorkflow.id,
        workflowInput: '{}',
        assignmentTargetType: 'agent',
        assignmentTargetId: String(agent.id),
        assignmentMode: 'individual'
      }
    });
    assert(budgetPlanTicketResponse.statusCode === 302, `budget action plan ticket create returned HTTP ${budgetPlanTicketResponse.statusCode}`);
    const budgetPlanTicket = readJson('tickets.json')[readJson('tickets.json').length - 1];
    const budgetPlanRun = await waitForCompletedRun(budgetPlanTicket.id);
    assert(budgetPlanRun.status === 'completed', 'budget-limited action plan should complete with rejected excess mutation');
    assert(fs.existsSync(path.join(WORKSPACE_ROOT, 'workflow-output/budget-dest')), 'budget action plan should execute first accepted mutation');
    assert(fs.existsSync(path.join(WORKSPACE_ROOT, 'workflow-output/budget-source.txt')), 'budget action plan should not execute mutation rejected by maxMutations');
    const budgetPlanSnapshot = JSON.parse(fs.readFileSync(path.join(DATA_DIR, budgetPlanRun.replaySnapshotPath), 'utf8'));
    const budgetPlanEvidence = (budgetPlanSnapshot.workflowActionPlans || []).find(item => item.stepId === 'execute-plan');
    assert(budgetPlanEvidence.acceptedActions.length === 1, 'budget action plan should accept only one mutation');
    assert(budgetPlanEvidence.rejectedActions.length === 1, 'budget action plan should reject mutation over maxMutations');
    assert(budgetPlanEvidence.rejectedActions[0].validationReasons.some(reason => reason.includes('maxMutations')), 'budget rejection should mention maxMutations');


    const childWorkflow = {
      id: `workflow-ticket-plan-child-${Date.now()}`,
      name: 'Ticket plan child workflow',
      enabled: true,
      inputSchema: { basePath: 'string', vendorId: 'string' },
      actions: [
        { id: 'done', action: 'stop', input: { result: { child: true, vendorId: '{{workflow.input.vendorId}}' } } }
      ]
    };
    const childWorkflowResponse = await createWorkflow(cookie, childWorkflow);
    assert(childWorkflowResponse.statusCode === 302, `child workflow save returned HTTP ${childWorkflowResponse.statusCode}`);

    const ticketPlanWorkflow = {
      id: `workflow-ticket-plan-valid-${Date.now()}`,
      name: 'Valid ticket plan workflow',
      enabled: true,
      inputSchema: {},
      actions: [
        {
          id: 'execute-ticket-plan',
          action: 'executeTicketPlan',
          input: {
            tickets: [
              {
                workflowId: childWorkflow.id,
                objective: 'Vendor Remediation Task - DataSync Corp',
                workflowInput: { basePath: 'vendors', vendorId: 'vendor-002' },
                reason: 'Conditional Approve due to expired certification'
              },
              {
                workflowId: childWorkflow.id,
                objective: 'Vendor Remediation Task - SecureMail Ltd',
                workflowInput: { basePath: 'vendors', vendorId: 'vendor-003' },
                reason: 'Conditional Approve due to active incident'
              }
            ],
            allowedWorkflowIds: [childWorkflow.id],
            maxTickets: 5
          },
          next: 'done'
        },
        { id: 'done', action: 'stop', input: { result: { completed: true } } }
      ]
    };
    const ticketPlanResponse = await createWorkflow(cookie, ticketPlanWorkflow);
    assert(ticketPlanResponse.statusCode === 302, `ticket plan workflow save returned HTTP ${ticketPlanResponse.statusCode}: ${ticketPlanResponse.body}`);
    const ticketPlanTicketResponse = await request('POST', '/tickets', {
      cookie,
      form: {
        objective: 'Run valid ticket plan workflow',
        capabilityType: 'workflow',
        workflowId: ticketPlanWorkflow.id,
        workflowInput: '{}',
        assignmentTargetType: 'agent',
        assignmentTargetId: String(agent.id),
        assignmentMode: 'individual',
        // maxAttempts is now enforced for manual rerun-from-start; allow the
        // parent rerun below (first run + one rerun = 2 attempts).
        executionPolicy: JSON.stringify({ maxAttempts: 2 })
      }
    });
    assert(ticketPlanTicketResponse.statusCode === 302, `ticket plan ticket create returned HTTP ${ticketPlanTicketResponse.statusCode}`);
    const ticketPlanParentTicket = readJson('tickets.json')[readJson('tickets.json').length - 1];
    const ticketPlanRun = await waitForCompletedRun(ticketPlanParentTicket.id);
    assert(ticketPlanRun.status === 'completed', `valid executeTicketPlan workflow should complete, got ${ticketPlanRun.status}: ${ticketPlanRun.error || ''}`);
    const ticketPlanSnapshot = JSON.parse(fs.readFileSync(path.join(DATA_DIR, ticketPlanRun.replaySnapshotPath), 'utf8'));
    const ticketPlanEvidence = (ticketPlanSnapshot.workflowTicketPlans || []).find(item => item.stepId === 'execute-ticket-plan');
    assert(ticketPlanEvidence, 'executeTicketPlan should record workflowTicketPlans evidence');
    assert(ticketPlanEvidence.proposedTickets.length === 2, 'executeTicketPlan replay should record proposed tickets');
    assert(ticketPlanEvidence.acceptedTickets.length === 2, 'executeTicketPlan replay should record accepted tickets');
    assert(ticketPlanEvidence.rejectedTickets.length === 0, 'valid executeTicketPlan should not reject tickets');
    assert(ticketPlanEvidence.createdTicketIds.length === 2, 'executeTicketPlan should record created ticket ids');
    const ticketPlanWorkflowAction = ticketPlanSnapshot.workflowActions.find(item => item.stepId === 'execute-ticket-plan' && item.action === 'executeTicketPlan');
    assert(ticketPlanWorkflowAction.result.status === 'created', 'executeTicketPlan workflow action should report created status');
    const childTickets = readJson('tickets.json').filter(item => ticketPlanEvidence.createdTicketIds.includes(item.id));
    assert(childTickets.length === 2, 'executeTicketPlan should persist two child tickets');
    assert(childTickets.every(item => item.workflowId === childWorkflow.id), 'child tickets should use requested workflow id');
    assert(childTickets.every(item => item.status === 'blocked'), 'child tickets should not auto-run in v1');
    assert(childTickets.every(item => item.blockedReason && item.blockedReason.includes('not automatic')), 'child tickets should explain blocked execution state');
    assert(childTickets.every(item => item.parentTicketId === ticketPlanParentTicket.id), 'child tickets should record parent ticket id');
    assert(childTickets.every(item => item.parentRunId === ticketPlanRun.id), 'child tickets should record parent run id');
    assert(childTickets.every(item => item.parentWorkflowId === ticketPlanWorkflow.id), 'child tickets should record parent workflow id');
    assert(childTickets.every(item => item.spawnedByStepId === 'execute-ticket-plan'), 'child tickets should record spawning step id');
    assert(childTickets.every(item => item.spawnPlanId && item.spawnPlanId.includes(ticketPlanRun.id + ':' + ticketPlanWorkflow.id + ':execute-ticket-plan')), 'child tickets should record spawn plan id');
    assert(childTickets.every(item => item.spawnIdempotencyKey && item.spawnIdempotencyKey.startsWith(ticketPlanParentTicket.id + ':' + childWorkflow.id + ':')), 'child tickets should record parent-ticket-scoped idempotency key');
    assert(childTickets.some(item => item.workflowInput.vendorId === 'vendor-002'), 'child ticket should preserve vendor-002 workflow input');
    assert(childTickets.some(item => item.workflowInput.vendorId === 'vendor-003'), 'child ticket should preserve vendor-003 workflow input');
    assert(!readJson('runs.json').some(item => childTickets.map(ticket => ticket.id).includes(item.ticketId)), 'executeTicketPlan v1 should not create child runs');

    const ticketPlanRerunResponse = await request('POST', `/api/tickets/${ticketPlanParentTicket.id}/rerun`, {
      cookie,
      body: { mode: 'retry' }
    });
    assert(ticketPlanRerunResponse.statusCode === 200, `ticket plan parent rerun returned HTTP ${ticketPlanRerunResponse.statusCode}: ${ticketPlanRerunResponse.body}`);
    const ticketPlanRerun = await waitForCompletedRun(ticketPlanParentTicket.id);
    assert(ticketPlanRerun.id !== ticketPlanRun.id, 'ticket plan parent rerun should create a new parent run');
    assert(ticketPlanRerun.status === 'completed', `ticket plan parent rerun should complete, got ${ticketPlanRerun.status}: ${ticketPlanRerun.error || ''}`);
    const childTicketsAfterParentRerun = readJson('tickets.json').filter(item => item.parentTicketId === ticketPlanParentTicket.id);
    assert(childTicketsAfterParentRerun.length === 2, `parent rerun should not create duplicate child tickets, found ${childTicketsAfterParentRerun.length}`);
    const ticketPlanRerunSnapshot = JSON.parse(fs.readFileSync(path.join(DATA_DIR, ticketPlanRerun.replaySnapshotPath), 'utf8'));
    const ticketPlanRerunEvidence = (ticketPlanRerunSnapshot.workflowTicketPlans || []).find(item => item.stepId === 'execute-ticket-plan');
    assert(ticketPlanRerunEvidence, 'executeTicketPlan parent rerun should record workflowTicketPlans evidence');
    assert(ticketPlanRerunEvidence.proposedTickets.length === 2, 'parent rerun should record proposed child tickets');
    assert(ticketPlanRerunEvidence.acceptedTickets.length === 0, 'parent rerun should accept no duplicate child tickets');
    assert(ticketPlanRerunEvidence.rejectedTickets.length === 2, 'parent rerun should reject duplicate child tickets');
    assert(ticketPlanRerunEvidence.createdTicketIds.length === 0, 'parent rerun should create no duplicate child tickets');
    assert(ticketPlanRerunEvidence.rejectedTickets.every(ticket => ticket.idempotencyKey && ticket.idempotencyKey.startsWith(ticketPlanParentTicket.id + ':' + childWorkflow.id + ':')), 'parent rerun duplicate rejections should preserve parent-ticket-scoped idempotency key');
    assert(ticketPlanRerunEvidence.rejectedTickets.every(ticket => (ticket.validationReasons || []).some(reason => reason.includes('duplicate child ticket already exists'))), 'parent rerun duplicate rejections should explain existing child tickets');
    assert(!readJson('runs.json').some(item => childTicketsAfterParentRerun.map(ticket => ticket.id).includes(item.ticketId)), 'parent rerun should not auto-create child runs');

    const invalidTicketPlanWorkflow = {
      id: `workflow-ticket-plan-invalid-${Date.now()}`,
      name: 'Invalid ticket plan workflow',
      enabled: true,
      inputSchema: {},
      actions: [
        {
          id: 'execute-ticket-plan',
          action: 'executeTicketPlan',
          input: {
            tickets: [
              { workflowId: 'missing-child-workflow', objective: 'Invalid child', workflowInput: { basePath: 'vendors', vendorId: 'vendor-999' }, reason: 'invalid workflow' }
            ],
            allowedWorkflowIds: [childWorkflow.id],
            maxTickets: 5
          },
          next: 'done'
        },
        { id: 'done', action: 'stop', input: { result: { completed: true } } }
      ]
    };
    await createWorkflow(cookie, invalidTicketPlanWorkflow);
    const invalidTicketPlanTicketResponse = await request('POST', '/tickets', {
      cookie,
      form: {
        objective: 'Run invalid ticket plan workflow',
        capabilityType: 'workflow',
        workflowId: invalidTicketPlanWorkflow.id,
        workflowInput: '{}',
        assignmentTargetType: 'agent',
        assignmentTargetId: String(agent.id),
        assignmentMode: 'individual'
      }
    });
    assert(invalidTicketPlanTicketResponse.statusCode === 302, `invalid ticket plan ticket create returned HTTP ${invalidTicketPlanTicketResponse.statusCode}`);
    const invalidTicketPlanParentTicket = readJson('tickets.json')[readJson('tickets.json').length - 1];
    const invalidTicketPlanRun = await waitForCompletedRun(invalidTicketPlanParentTicket.id);
    assert(invalidTicketPlanRun.status === 'completed', 'invalid workflowId should be rejected without failing workflow execution');
    const invalidTicketPlanSnapshot = JSON.parse(fs.readFileSync(path.join(DATA_DIR, invalidTicketPlanRun.replaySnapshotPath), 'utf8'));
    const invalidTicketPlanEvidence = (invalidTicketPlanSnapshot.workflowTicketPlans || []).find(item => item.stepId === 'execute-ticket-plan');
    assert(invalidTicketPlanEvidence.acceptedTickets.length === 0, 'invalid ticket plan should accept no tickets');
    assert(invalidTicketPlanEvidence.rejectedTickets.length === 1, 'invalid ticket plan should record rejected ticket');
    assert(invalidTicketPlanEvidence.rejectedTickets[0].validationReasons.some(reason => reason.includes('not in allowedWorkflowIds')), 'invalid ticket rejection should explain allowed workflow failure');
    assert(invalidTicketPlanEvidence.createdTicketIds.length === 0, 'invalid ticket plan should create no tickets');

    const overMaxTicketPlanWorkflow = {
      id: `workflow-ticket-plan-over-max-${Date.now()}`,
      name: 'Over max ticket plan workflow',
      enabled: true,
      inputSchema: {},
      actions: [
        {
          id: 'execute-ticket-plan',
          action: 'executeTicketPlan',
          input: {
            tickets: [
              { workflowId: childWorkflow.id, objective: 'Child A', workflowInput: { basePath: 'vendors', vendorId: 'vendor-010' }, reason: 'one' },
              { workflowId: childWorkflow.id, objective: 'Child B', workflowInput: { basePath: 'vendors', vendorId: 'vendor-011' }, reason: 'two' }
            ],
            allowedWorkflowIds: [childWorkflow.id],
            maxTickets: 1
          },
          next: 'done'
        },
        { id: 'done', action: 'stop', input: { result: { completed: true } } }
      ]
    };
    await createWorkflow(cookie, overMaxTicketPlanWorkflow);
    const overMaxTicketPlanTicketResponse = await request('POST', '/tickets', {
      cookie,
      form: {
        objective: 'Run over max ticket plan workflow',
        capabilityType: 'workflow',
        workflowId: overMaxTicketPlanWorkflow.id,
        workflowInput: '{}',
        assignmentTargetType: 'agent',
        assignmentTargetId: String(agent.id),
        assignmentMode: 'individual'
      }
    });
    assert(overMaxTicketPlanTicketResponse.statusCode === 302, `over max ticket plan ticket create returned HTTP ${overMaxTicketPlanTicketResponse.statusCode}`);
    const overMaxTicketPlanParentTicket = readJson('tickets.json')[readJson('tickets.json').length - 1];
    const overMaxTicketPlanRun = await waitForCompletedRun(overMaxTicketPlanParentTicket.id);
    assert(overMaxTicketPlanRun.status === 'completed', 'over max ticket plan should reject deterministically without creating tickets');
    const overMaxTicketPlanSnapshot = JSON.parse(fs.readFileSync(path.join(DATA_DIR, overMaxTicketPlanRun.replaySnapshotPath), 'utf8'));
    const overMaxTicketPlanEvidence = (overMaxTicketPlanSnapshot.workflowTicketPlans || []).find(item => item.stepId === 'execute-ticket-plan');
    assert(overMaxTicketPlanEvidence.acceptedTickets.length === 0, 'over max ticket plan should accept no tickets');
    assert(overMaxTicketPlanEvidence.rejectedTickets.length === 2, 'over max ticket plan should reject all proposed tickets');
    assert(overMaxTicketPlanEvidence.createdTicketIds.length === 0, 'over max ticket plan should create no tickets');

    const duplicateTicketPlanWorkflow = {
      id: `workflow-ticket-plan-duplicate-${Date.now()}`,
      name: 'Duplicate ticket plan workflow',
      enabled: true,
      inputSchema: {},
      actions: [
        {
          id: 'execute-ticket-plan-a',
          action: 'executeTicketPlan',
          input: {
            tickets: [
              { workflowId: childWorkflow.id, objective: 'Vendor Remediation Task - Duplicate Vendor', workflowInput: { basePath: 'vendors', vendorId: 'vendor-012' }, reason: 'first proposal' }
            ],
            allowedWorkflowIds: [childWorkflow.id],
            maxTickets: 5
          },
          next: 'execute-ticket-plan-b'
        },
        {
          id: 'execute-ticket-plan-b',
          action: 'executeTicketPlan',
          input: {
            tickets: [
              { workflowId: childWorkflow.id, objective: 'Vendor Remediation Task - Duplicate Vendor Again', workflowInput: { basePath: 'vendors', vendorId: 'vendor-012' }, reason: 'duplicate proposal' }
            ],
            allowedWorkflowIds: [childWorkflow.id],
            maxTickets: 5
          },
          next: 'done'
        },
        { id: 'done', action: 'stop', input: { result: { completed: true } } }
      ]
    };
    await createWorkflow(cookie, duplicateTicketPlanWorkflow);
    const duplicateTicketPlanTicketResponse = await request('POST', '/tickets', {
      cookie,
      form: {
        objective: 'Run duplicate ticket plan workflow',
        capabilityType: 'workflow',
        workflowId: duplicateTicketPlanWorkflow.id,
        workflowInput: '{}',
        assignmentTargetType: 'agent',
        assignmentTargetId: String(agent.id),
        assignmentMode: 'individual'
      }
    });
    assert(duplicateTicketPlanTicketResponse.statusCode === 302, `duplicate ticket plan ticket create returned HTTP ${duplicateTicketPlanTicketResponse.statusCode}`);
    const duplicateTicketPlanParentTicket = readJson('tickets.json')[readJson('tickets.json').length - 1];
    const duplicateTicketPlanRun = await waitForCompletedRun(duplicateTicketPlanParentTicket.id);
    assert(duplicateTicketPlanRun.status === 'completed', 'duplicate ticket plan workflow should complete with deterministic rejection');
    const duplicateTicketPlanSnapshot = JSON.parse(fs.readFileSync(path.join(DATA_DIR, duplicateTicketPlanRun.replaySnapshotPath), 'utf8'));
    const duplicatePlanA = (duplicateTicketPlanSnapshot.workflowTicketPlans || []).find(item => item.stepId === 'execute-ticket-plan-a');
    const duplicatePlanB = (duplicateTicketPlanSnapshot.workflowTicketPlans || []).find(item => item.stepId === 'execute-ticket-plan-b');
    assert(duplicatePlanA.createdTicketIds.length === 1, 'first duplicate plan step should create one child ticket');
    assert(duplicatePlanB.createdTicketIds.length === 0, 'second duplicate plan step should create no duplicate child ticket');
    assert(duplicatePlanB.rejectedTickets.length === 1, 'second duplicate plan step should reject duplicate child ticket');
    assert(duplicatePlanB.rejectedTickets[0].validationReasons.some(reason => reason.includes('duplicate child ticket already exists')), 'duplicate rejection should explain idempotency');

    const overMutationCapWorkflow = {
      id: `workflow-over-mutation-cap-${Date.now()}`,
      name: 'Over mutation cap workflow',
      inputSchema: {},
      actions: [
        {
          id: 'write-a',
          action: 'writeFile',
          input: { path: 'workflow-output/over-cap-a.txt', content: 'A' },
          next: 'write-b'
        },
        {
          id: 'write-b',
          action: 'writeFile',
          input: { path: 'workflow-output/over-cap-b.txt', content: 'B' },
          next: 'write-c'
        },
        {
          id: 'write-c',
          action: 'writeFile',
          input: { path: 'workflow-output/over-cap-c.txt', content: 'C' },
          next: 'done'
        },
        { id: 'done', action: 'stop', input: {} }
      ]
    };
    const overMutationCapResponse = await createWorkflow(cookie, overMutationCapWorkflow);
    assert(overMutationCapResponse.statusCode === 302, `over mutation cap workflow save returned HTTP ${overMutationCapResponse.statusCode}`);
    const overMutationCapTicketResponse = await request('POST', '/tickets', {
      cookie,
      form: {
        objective: 'Run over mutation cap workflow',
        capabilityType: 'workflow',
        workflowId: overMutationCapWorkflow.id,
        workflowInput: '{}',
        assignmentTargetType: 'agent',
        assignmentTargetId: String(agent.id),
        assignmentMode: 'individual'
      }
    });
    assert(overMutationCapTicketResponse.statusCode === 302, `over mutation cap ticket create returned HTTP ${overMutationCapTicketResponse.statusCode}`);
    const overMutationCapTicket = readJson('tickets.json')[readJson('tickets.json').length - 1];
    const overMutationCapRun = await waitForRunStatus(
      Math.max(0, ...readJson('runs.json').filter(item => item.ticketId === overMutationCapTicket.id).map(item => item.id || 0)),
      'failed'
    );
    assert(overMutationCapRun.error && overMutationCapRun.error.includes('Workflow exceeded mutation limit of 2'), 'third mutating workflow write should be blocked by mutation cap');
    const overMutationCapTriagedRun = await waitForRunTriage(overMutationCapRun.id, 'runtime_failed');
    assert(overMutationCapTriagedRun.triage.requiredDecision === 'manual_recovery', 'runtime failure after mutations should require manual recovery review');
    assert(overMutationCapTriagedRun.replaySnapshot.triage.reasonCode === 'runtime_failed', 'runtime failure replay should include triage');
    assert(fs.readFileSync(path.join(WORKSPACE_ROOT, 'workflow-output/over-cap-a.txt'), 'utf8') === 'A', 'over mutation cap workflow should execute first write');
    assert(fs.readFileSync(path.join(WORKSPACE_ROOT, 'workflow-output/over-cap-b.txt'), 'utf8') === 'B', 'over mutation cap workflow should execute second write');
    assert(!fs.existsSync(path.join(WORKSPACE_ROOT, 'workflow-output/over-cap-c.txt')), 'over mutation cap workflow should block third write');
    const completeRuntimeFailedTicketResponse = await request('PATCH', `/api/tickets/${overMutationCapTicket.id}/status`, {
      cookie,
      body: { status: 'completed' }
    });
    assert(completeRuntimeFailedTicketResponse.statusCode === 409, 'runtime-failed ticket must reject manual completed transition');
    assert(JSON.parse(completeRuntimeFailedTicketResponse.body).error.includes('latest run is failed'), 'runtime failure completion rejection should expose the failed latest run');

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
    const failingPostconditionRunId = Math.max(
      0,
      ...readJson('runs.json')
        .filter(item => item.ticketId === failingPostconditionTicket.id)
        .map(item => item.id || 0)
    );
    const failingPostconditionRun = await waitForRunStatus(failingPostconditionRunId, 'failed');
    const failingPostconditionTriagedRun = await waitForRunTriage(failingPostconditionRun.id, 'verification_failed');
    assert(failingPostconditionRun.status === 'failed', 'failing postcondition workflow must not be marked completed');
    assert(failingPostconditionRun.error && failingPostconditionRun.error.includes('Verification failed'), 'failing postcondition run should persist a visible verification failure reason');
    assert(failingPostconditionTriagedRun.triage.requiredDecision === 'review_failure', 'verification failure should require failure review');
    assert(failingPostconditionTriagedRun.triage.allowedActions.includes('rerun_from_start'), 'verification triage should list manual rerun from start');
    assert(failingPostconditionTriagedRun.replaySnapshot.triage.reasonCode === 'verification_failed', 'verification failure replay should include triage');
    const failingPostconditionStoredTicket = await waitForTicketStatus(failingPostconditionTicket.id, 'failed');
    assert(failingPostconditionStoredTicket.status === 'failed', 'ticket must not be marked completed when required verification fails');
    assert(failingPostconditionStoredTicket.triage === null, 'run-level verification triage must not be duplicated into ticket-level triage');
    const failingPostconditionStateResponse = await request('GET', `/api/runs/${failingPostconditionRun.id}/state`, { cookie });
    assert(failingPostconditionStateResponse.statusCode === 200, `failing postcondition run state returned HTTP ${failingPostconditionStateResponse.statusCode}`);
    const failingPostconditionState = JSON.parse(failingPostconditionStateResponse.body);
    assert(failingPostconditionState.triage && failingPostconditionState.triage.reasonCode === 'verification_failed', 'run state should expose verification triage');
    assert(failingPostconditionState.runEvaluation.effectiveness.status === 'failed', 'failing postcondition should report failed effectiveness');
    assert(failingPostconditionState.runEvaluation.effectiveness.postconditionsPassed === 0, 'failing postcondition should report zero passed postconditions');
    assert(failingPostconditionState.runEvaluation.effectiveness.postconditionsFailed === 1, 'failing postcondition should report one failed postcondition');
    const failingPostconditionEvents = await request('GET', `/api/runs/${failingPostconditionRun.id}/events`, { cookie });
    assert(failingPostconditionEvents.statusCode === 200, `failing postcondition events returned HTTP ${failingPostconditionEvents.statusCode}`);
    const failingPostconditionEventItems = JSON.parse(failingPostconditionEvents.body).events;
    assert(failingPostconditionEventItems.some(event => event.type === 'run.execution_completed'), 'failing postcondition should preserve execution-finished evidence');
    assert(failingPostconditionEventItems.some(event => event.type === 'run.postcondition_failed'), 'failing postcondition should emit run.postcondition_failed');
    assert(failingPostconditionEventItems.some(event => event.type === 'run.verification_failed'), 'failing postcondition should emit run.verification_failed');
    assert(failingPostconditionEventItems.some(event => event.type === 'run.triage_created'), 'failing postcondition should emit run.triage_created');
    assert(failingPostconditionEventItems.some(event => event.type === 'run.terminalized' && event.payload && event.payload.status === 'failed'), 'failing postcondition should terminalize as failed');
    const failingPostconditionRunPage = await request('GET', `/runs/${failingPostconditionRun.id}`, { cookie });
    assert(failingPostconditionRunPage.statusCode === 200, `failing postcondition run detail returned HTTP ${failingPostconditionRunPage.statusCode}`);
    assert(failingPostconditionRunPage.body.includes('Verification failed'), 'run detail should show the verification failure reason');
    assert(failingPostconditionRunPage.body.includes('<strong>Objective Success:</strong> No · failed'), 'objective success must not report success when verification failed');
    assert(failingPostconditionRunPage.body.includes('Triage Required') && failingPostconditionRunPage.body.includes('<code>verification_failed</code>'), 'run detail should render verification triage');
    const failingPostconditionTicketPage = await request('GET', `/tickets/${failingPostconditionTicket.id}`, { cookie });
    assert(failingPostconditionTicketPage.statusCode === 200, `failing postcondition ticket detail returned HTTP ${failingPostconditionTicketPage.statusCode}`);
    assert(failingPostconditionTicketPage.body.includes('Verification failed'), 'ticket detail should expose the verification failure reason from the latest run');
    assert(failingPostconditionTicketPage.body.includes('Latest Run Triage') && failingPostconditionTicketPage.body.includes('<code>verification_failed</code>'), 'ticket detail should render latest-run triage');
    assert(!failingPostconditionTicketPage.body.includes('Ticket-Level Triage'), 'run-level triage must not be labeled as ticket-level triage');
    const completeVerificationFailedTicketResponse = await request('PATCH', `/api/tickets/${failingPostconditionTicket.id}/status`, {
      cookie,
      body: { status: 'completed' }
    });
    assert(completeVerificationFailedTicketResponse.statusCode === 409, 'verification-failed ticket must reject manual completed transition');
    assert(JSON.parse(completeVerificationFailedTicketResponse.body).error.includes('latest run is failed'), 'verification failure completion rejection should expose the failed latest run');
    await new Promise(resolve => setTimeout(resolve, 600));
    assert(readJson('runs.json').filter(item => item.ticketId === failingPostconditionTicket.id).length === 1, 'triage creation must not automatically retry or create another run');

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
    const protectedTriagedRun = await waitForRunTriage(protectedRun.id, 'authority_blocked');
    const protectedRunStateResponse = await request('GET', `/api/runs/${protectedRun.id}/state`, { cookie });
    assert(protectedRunStateResponse.statusCode === 200, `protected run state API returned HTTP ${protectedRunStateResponse.statusCode}`);
    const protectedRunState = JSON.parse(protectedRunStateResponse.body);
    assert(protectedRunState.triage && protectedRunState.triage.reasonCode === 'authority_blocked', 'protected path failure should create authority_blocked triage');
    assert(protectedRunState.triage.requiredDecision === 'change_scope', 'authority triage should require a scope decision');
    assert(protectedRunState.triage.prohibitedActions.includes('bypass_authority'), 'authority triage should prohibit authority bypass');
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
    assert(protectedTriagedRun.replaySnapshot.triage.reasonCode === 'authority_blocked', 'protected path replay should include authority triage');

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

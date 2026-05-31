const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { createTempWorkspaceRoot, removeTempWorkspaceRoot } = require('./test-workspace');

const ROOT = path.resolve(__dirname, '..');
const REAL_DATA_DIR = path.join(ROOT, 'data');
const STAMP = Date.now();

const DATA_FILES = [
  'agents.json', 'allocation-plans.json', 'events.jsonl', 'groups.json', 'logs.json',
  'memberships.json', 'operation-history.json', 'permissions.json', 'runs.json',
  'tickets.json', 'users.json', 'workflows.json'
];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function request(baseUrl, method, urlPath, options = {}) {
  const body = options.form
    ? new URLSearchParams(options.form).toString()
    : options.body ? JSON.stringify(options.body) : null;
  return new Promise((resolve, reject) => {
    const req = http.request(baseUrl + urlPath, {
      method,
      headers: {
        ...(options.form ? { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) } : {}),
        ...(options.body ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } : {}),
        ...(options.cookie ? { Cookie: options.cookie } : {})
      }
    }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ statusCode: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function cookieFrom(response) {
  return (response.headers['set-cookie'] || []).map(cookie => cookie.split(';')[0]).join('; ');
}

function createFakeOpenAIPreload(label) {
  const preloadPath = path.join(os.tmpdir(), `conditional-workflow-prompt-${label}-${process.pid}-${Date.now()}.js`);
  const source = `
function okResponse(plan) {
  return {
    ok: true,
    status: 200,
    headers: new Map([['x-request-id', 'fake-conditional-workflow-prompt']]),
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

  if (combined.includes('conditional previous results prompt')) {
    if (combined.includes('previousActionResults')) {
      return okResponse({
        message: 'Previous action results preserved.',
        actions: [],
        complete: true
      });
    }

    return okResponse({
      message: 'Reading file first.',
      actions: [{ operation: 'readFile', args: { path: 'previous-source-${label}.txt' } }],
      complete: false
    });
  }

  if (combined.includes('conditional reassess prompt')) {
    if (combined.includes('priorFailureContext')) {
      return okResponse({
        message: 'Prior failure context preserved.',
        actions: [],
        complete: true
      });
    }

    return okResponse({
      message: 'Triggering protected path failure.',
      actions: [{ operation: 'writeFile', args: { path: 'package.json', content: 'blocked' } }],
      complete: true
    });
  }

  if (combined.includes('conditional allocated prompt')) {
    return okResponse({
      message: 'Writing allocated file.',
      actions: [{ operation: 'writeFile', args: { path: 'allocated-${label}/owned.txt', content: 'ok' } }],
      complete: true
    });
  }

  if (combined.includes('conditional handoff prompt handoff')) {
    return okResponse({
      message: 'Creating handoff task.',
      actions: [{
        operation: 'createHandoffTask',
        args: {
          executor: 'ConditionalPrompt-${label}-${STAMP}',
          operation: 'writeFile',
          args: { path: 'handoff-${label}.txt', content: 'ok' }
        }
      }],
      complete: true
    });
  }

  if (combined.includes('conditional workflow prompt workflow')) {
    return okResponse({
      message: 'Creating workflow draft intent.',
      actions: [{
        operation: 'createWorkflowDraftIntent',
        args: {
          id: 'conditional-workflow-${label}',
          name: 'Conditional workflow ${label}',
          writes: [{ path: 'conditional-workflow-${label}.txt', content: 'ok' }],
          postconditions: [
            { type: 'fileExists', path: 'conditional-workflow-${label}.txt' },
            { type: 'fileContains', path: 'conditional-workflow-${label}.txt', contains: 'ok' }
          ]
        }
      }],
      complete: true
    });
  }

  return okResponse({
    message: 'Writing ordinary file.',
    actions: [{ operation: 'writeFile', args: { path: 'ordinary-${label}.txt', content: 'ok' } }],
    complete: true
  });
};
`;
  fs.writeFileSync(preloadPath, source);
  return preloadPath;
}

function readJson(dataDir, file) {
  return JSON.parse(fs.readFileSync(path.join(dataDir, file), 'utf8'));
}

function readSnapshot(dataDir, run) {
  if (run.replaySnapshot) return run.replaySnapshot;
  assert(run.replaySnapshotPath, `Run ${run.id} missing replaySnapshotPath`);
  return JSON.parse(fs.readFileSync(path.join(dataDir, run.replaySnapshotPath), 'utf8'));
}

async function waitForReady(baseUrl) {
  const started = Date.now();
  while (Date.now() - started < 15000) {
    try {
      const response = await request(baseUrl, 'GET', '/health');
      if (response.statusCode === 200 && JSON.parse(response.body).ready) return;
    } catch (error) {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Timed out waiting for server ready');
}

async function waitForRun(dataDir, ticketId, timeoutMs = 20000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const runs = readJson(dataDir, 'runs.json').filter(run => run.ticketId === ticketId);
    const run = runs[runs.length - 1];
    if (run && ['completed', 'failed', 'interrupted'].includes(run.status)) return run;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for terminal run for ticket ${ticketId}`);
}

async function createTicket(baseUrl, cookie, agent, objective) {
  const response = await request(baseUrl, 'POST', '/tickets', {
    cookie,
    form: {
      objective,
      assignmentTargetType: 'agent',
      assignmentTargetId: String(agent.id),
      assignmentMode: 'individual'
    }
  });
  assert(response.statusCode === 302, `Ticket create failed with HTTP ${response.statusCode}: ${response.body}`);
}

async function createAllocatedTicket(baseUrl, cookie, group, agent, objective, ownedPath) {
  const response = await request(baseUrl, 'POST', '/tickets', {
    cookie,
    form: {
      objective,
      assignmentTargetType: 'group',
      assignmentTargetId: String(group.id),
      assignmentMode: 'allocated',
      ownedOutputPaths: JSON.stringify({ [agent.id]: ownedPath })
    }
  });
  assert(response.statusCode === 302, `Allocated ticket create failed with HTTP ${response.statusCode}: ${response.body}`);
}

function providerInput(snapshot) {
  assert(Array.isArray(snapshot.providerRequests) && snapshot.providerRequests.length > 0, 'snapshot should include provider request');
  const input = snapshot.providerRequests[0].body && snapshot.providerRequests[0].body.input;
  assert(Array.isArray(input), 'provider request should include input array');
  return input;
}

function combinedProviderInput(snapshot, requestIndex = 0) {
  assert(Array.isArray(snapshot.providerRequests) && snapshot.providerRequests.length > requestIndex, `snapshot should include provider request ${requestIndex}`);
  const input = snapshot.providerRequests[requestIndex].body && snapshot.providerRequests[requestIndex].body.input;
  assert(Array.isArray(input), 'provider request should include input array');
  return input.map(item => item && item.content ? String(item.content) : '').join('\n');
}

async function runScenario({ label, port, canonicalEnabled }) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), `conditional-workflow-prompt-${label}-data-`));
  const workspaceRoot = createTempWorkspaceRoot(`conditional-workflow-prompt-${label}`);
  const preloadPath = createFakeOpenAIPreload(label);
  const baseUrl = `http://127.0.0.1:${port}`;

  for (const file of DATA_FILES) {
    const src = path.join(REAL_DATA_DIR, file);
    fs.writeFileSync(path.join(dataDir, file), file === 'events.jsonl' ? '' : fs.existsSync(src) ? fs.readFileSync(src, 'utf8') : '[]');
  }

  const agents = readJson(dataDir, 'agents.json');
  const agent = {
    id: Math.max(0, ...agents.map(item => item.id || 0)) + 1,
    name: `ConditionalPrompt-${label}-${STAMP}`,
    type: 'agent',
    provider: 'openai',
    model: 'gpt-4.1-mini',
    apiKey: `test-key-${label}`,
    createdAt: new Date().toISOString()
  };
  fs.writeFileSync(path.join(dataDir, 'agents.json'), JSON.stringify([...agents, agent], null, 2));

  const groups = readJson(dataDir, 'groups.json');
  const group = {
    id: Math.max(0, ...groups.map(item => item.id || 0)) + 1,
    name: `ConditionalPromptGroup-${label}-${STAMP}`,
    permissions: [],
    canReceiveTickets: true
  };
  fs.writeFileSync(path.join(dataDir, 'groups.json'), JSON.stringify([...groups, group], null, 2));

  const memberships = readJson(dataDir, 'memberships.json');
  fs.writeFileSync(path.join(dataDir, 'memberships.json'), JSON.stringify([
    ...memberships,
    {
      id: Math.max(0, ...memberships.map(item => item.id || 0)) + 1,
      principalType: 'agent',
      principalId: agent.id,
      groupId: group.id
    }
  ], null, 2));

  fs.mkdirSync(path.join(workspaceRoot, `allocated-${label}`), { recursive: true });
  fs.writeFileSync(path.join(workspaceRoot, `previous-source-${label}.txt`), 'previous content');

  const server = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      PORT: String(port),
      DATA_DIR: dataDir,
      WORKSPACE_ROOT: workspaceRoot,
      NODE_OPTIONS: `--require ${preloadPath}`,
      ...(canonicalEnabled ? { AGENT_ALLOW_CANONICAL_WORKFLOW_DRAFT: '1' } : {})
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  let output = '';
  server.stdout.on('data', chunk => { output += chunk.toString(); });
  server.stderr.on('data', chunk => { output += chunk.toString(); });

  try {
    await waitForReady(baseUrl);
    const login = await request(baseUrl, 'POST', '/login', { form: { username: 'admin', password: 'admin123' } });
    assert(login.statusCode === 302, `Login failed with HTTP ${login.statusCode}`);
    const cookie = cookieFrom(login);

    const ordinaryObjective = `conditional prompt ordinary write ${label} ${STAMP}`;
    const workflowObjective = `conditional workflow prompt workflow ${label} ${STAMP}`;
    const handoffObjective = `conditional handoff prompt handoff ${label} ${STAMP}`;
    const previousResultsObjective = `conditional previous results prompt ${label} ${STAMP}`;
    const reassessObjective = `conditional reassess prompt ${label} ${STAMP}`;
    const allocatedObjective = `conditional allocated prompt file ${label} ${STAMP}`;
    await createTicket(baseUrl, cookie, agent, ordinaryObjective);
    await createTicket(baseUrl, cookie, agent, workflowObjective);
    await createTicket(baseUrl, cookie, agent, handoffObjective);
    await createTicket(baseUrl, cookie, agent, previousResultsObjective);
    await createTicket(baseUrl, cookie, agent, reassessObjective);
    await createAllocatedTicket(baseUrl, cookie, group, agent, allocatedObjective, `allocated-${label}/`);

    const tickets = readJson(dataDir, 'tickets.json');
    const ordinaryTicket = tickets.find(ticket => ticket.objective === ordinaryObjective);
    const workflowTicket = tickets.find(ticket => ticket.objective === workflowObjective);
    const handoffTicket = tickets.find(ticket => ticket.objective === handoffObjective);
    const previousResultsTicket = tickets.find(ticket => ticket.objective === previousResultsObjective);
    const reassessTicket = tickets.find(ticket => ticket.objective === reassessObjective);
    const allocatedTicket = tickets.find(ticket => ticket.objective === allocatedObjective);
    const ordinaryRun = await waitForRun(dataDir, ordinaryTicket.id);
    const workflowRun = await waitForRun(dataDir, workflowTicket.id);
    const handoffRun = await waitForRun(dataDir, handoffTicket.id);
    const previousResultsRun = await waitForRun(dataDir, previousResultsTicket.id);
    const firstReassessRun = await waitForRun(dataDir, reassessTicket.id);
    assert(firstReassessRun.status === 'failed', 'initial reassess fixture run should fail before rerun');
    const reassessResponse = await request(baseUrl, 'POST', `/api/tickets/${reassessTicket.id}/rerun`, {
      cookie,
      body: { mode: 'reassess' }
    });
    assert(reassessResponse.statusCode === 200, `Reassess rerun failed with HTTP ${reassessResponse.statusCode}: ${reassessResponse.body}`);
    const reassessRun = await waitForRun(dataDir, reassessTicket.id);
    const allocatedRun = await waitForRun(dataDir, allocatedTicket.id);
    const ordinarySnapshot = readSnapshot(dataDir, ordinaryRun);
    const workflowSnapshot = readSnapshot(dataDir, workflowRun);
    const handoffSnapshot = readSnapshot(dataDir, handoffRun);
    const previousResultsSnapshot = readSnapshot(dataDir, previousResultsRun);
    const reassessSnapshot = readSnapshot(dataDir, reassessRun);
    const allocatedSnapshot = readSnapshot(dataDir, allocatedRun);

    return {
      ordinaryPrompt: ordinarySnapshot.systemInstructionSnapshot,
      workflowPrompt: workflowSnapshot.systemInstructionSnapshot,
      handoffPrompt: handoffSnapshot.systemInstructionSnapshot,
      ordinaryAllowedOperations: ordinarySnapshot.runtimeEnvelope.allowedOperations,
      workflowAllowedOperations: workflowSnapshot.runtimeEnvelope.allowedOperations,
      handoffAllowedOperations: handoffSnapshot.runtimeEnvelope.allowedOperations,
      ordinaryInput: providerInput(ordinarySnapshot),
      ordinaryCombinedInput: combinedProviderInput(ordinarySnapshot),
      previousResultsSecondInput: combinedProviderInput(previousResultsSnapshot, 1),
      reassessCombinedInput: combinedProviderInput(reassessSnapshot),
      allocatedCombinedInput: combinedProviderInput(allocatedSnapshot),
      allocatedRuntimeEnvelope: allocatedSnapshot.runtimeEnvelope
    };
  } finally {
    server.kill();
    await new Promise(resolve => server.once('exit', resolve));
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(preloadPath, { force: true });
    removeTempWorkspaceRoot(workspaceRoot);
    if (server.exitCode && server.exitCode !== 0) process.stderr.write(output);
  }
}

async function main() {
  const defaultScenario = await runScenario({ label: 'default', port: 3463, canonicalEnabled: false });
  const canonicalScenario = await runScenario({ label: 'canonical', port: 3464, canonicalEnabled: true });

  const workflowIntentProse = 'If the ticket asks to create, draft, define, or repair a simple workflow that writes files';
  const workflowIntentArgs = 'createWorkflowDraftIntent args:';
  const workflowIntentField = '"writes":"for createWorkflowDraftIntent"';
  const canonicalDisabled = 'Do not emit createWorkflowDraft. Normal agents are not allowed to submit canonical workflow JSON.';
  const canonicalEnabled = 'Trusted canonical workflow draft mode is enabled.';
  const handoffProse = 'To hand one bounded write task to another agent, emit createHandoffTask.';
  const handoffArgs = 'createHandoffTask args:';
  const budgetPrompt = defaultScenario.ordinaryPrompt;

  assert(budgetPrompt.includes('runtimeEnvelope.maxExecutionSteps'), 'compact budget guidance should include max steps');
  assert(budgetPrompt.includes('runtimeEnvelope.maxActionsPerResponse'), 'compact budget guidance should include max actions');
  assert(budgetPrompt.includes('runtimeEnvelope.maxMutatingActionsPerResponse'), 'compact budget guidance should include max mutating actions');
  assert(budgetPrompt.includes('every response consumes one step, including retries'), 'compact budget guidance should state retries consume budget');
  assert(budgetPrompt.includes('bounded batch'), 'compact budget guidance should preserve batching guidance');
  assert(budgetPrompt.includes('complete:false'), 'compact budget guidance should preserve continuation discipline');
  assert(!budgetPrompt.includes('Do not fail or return an error just because the total task exceeds one response.'), 'verbose budget prose should be compacted');

  const ordinaryCombinedInput = defaultScenario.ordinaryCombinedInput;
  assert(!ordinaryCombinedInput.includes('"allocationPlanId":null'), 'ordinary prompt should omit null allocationPlanId');
  assert(!ordinaryCombinedInput.includes('"allocationItemId":null'), 'ordinary prompt should omit null allocationItemId');
  assert(!ordinaryCombinedInput.includes('"allocationItem":null'), 'ordinary prompt should omit null allocationItem');
  assert(!ordinaryCombinedInput.includes('"allocationSubtask":null'), 'ordinary prompt should omit null allocationSubtask');
  assert(!ordinaryCombinedInput.includes('"ownedOutputPaths":[]'), 'ordinary prompt should omit empty ownedOutputPaths');
  assert(!ordinaryCombinedInput.includes('"workloadProfile":null'), 'ordinary prompt should omit null workloadProfile');
  assert(!ordinaryCombinedInput.includes('"previousActionResults"'), 'ordinary prompt should omit empty previousActionResults');
  assert(!ordinaryCombinedInput.includes('"priorFailureContext":null'), 'ordinary prompt should omit null priorFailureContext');

  assert(defaultScenario.allocatedCombinedInput.includes('"allocationPlanId":'), 'allocated prompt should include populated allocationPlanId');
  assert(defaultScenario.allocatedCombinedInput.includes('"allocationItemId":'), 'allocated prompt should include populated allocationItemId');
  assert(defaultScenario.allocatedCombinedInput.includes('"allocationItem":{'), 'allocated prompt should include populated allocationItem');
  assert(defaultScenario.allocatedCombinedInput.includes('"allocationSubtask":"'), 'allocated prompt should include populated allocationSubtask');
  assert(defaultScenario.allocatedCombinedInput.includes('"ownedOutputPaths":["allocated-default/"'), 'allocated prompt should include populated ownedOutputPaths');
  assert(defaultScenario.allocatedRuntimeEnvelope.allocationPlanId, 'replay runtimeEnvelope should keep allocationPlanId');
  assert(defaultScenario.allocatedRuntimeEnvelope.allocationItemId, 'replay runtimeEnvelope should keep allocationItemId');

  assert(defaultScenario.previousResultsSecondInput.includes('"previousActionResults"'), 'second-step prompt should include non-empty previousActionResults');
  assert(defaultScenario.previousResultsSecondInput.includes('readFile'), 'second-step previousActionResults should include prior readFile result');
  assert(defaultScenario.reassessCombinedInput.includes('"priorFailureContext"'), 'reassess prompt should include priorFailureContext');
  assert(defaultScenario.reassessCombinedInput.includes('"recoveryClassification":"failed"'), 'reassess priorFailureContext should preserve failure classification');

  assert(!defaultScenario.ordinaryPrompt.includes(workflowIntentProse), 'ordinary prompt should not include workflow draft intent prose');
  assert(!defaultScenario.ordinaryPrompt.includes(workflowIntentArgs), 'ordinary prompt should not include workflow draft intent args reminder');
  assert(!defaultScenario.ordinaryPrompt.includes(workflowIntentField), 'ordinary prompt should not include workflow draft intent response schema fields');
  assert(!defaultScenario.ordinaryPrompt.includes(canonicalDisabled), 'ordinary prompt should not include canonical disabled warning');
  assert(defaultScenario.ordinaryAllowedOperations.includes('createWorkflowDraftIntent'), 'ordinary runtimeEnvelope.allowedOperations should still include createWorkflowDraftIntent');
  assert(defaultScenario.ordinaryAllowedOperations.includes('createHandoffTask'), 'ordinary runtimeEnvelope.allowedOperations should still include createHandoffTask');
  assert(!defaultScenario.ordinaryPrompt.includes(handoffProse), 'ordinary prompt should not include handoff prose');
  assert(!defaultScenario.ordinaryPrompt.includes(handoffArgs), 'ordinary prompt should not include handoff args reminder');

  assert(defaultScenario.workflowPrompt.includes(workflowIntentProse), 'workflow prompt should include workflow draft intent prose');
  assert(defaultScenario.workflowPrompt.includes(workflowIntentArgs), 'workflow prompt should include workflow draft intent args reminder');
  assert(defaultScenario.workflowPrompt.includes(workflowIntentField), 'workflow prompt should include workflow draft intent response schema fields');
  assert(defaultScenario.workflowPrompt.includes(canonicalDisabled), 'workflow prompt should include canonical disabled warning when canonical env is off');
  assert(!defaultScenario.workflowPrompt.includes(handoffProse), 'workflow prompt should not include handoff prose');
  assert(!defaultScenario.workflowPrompt.includes(handoffArgs), 'workflow prompt should not include handoff args reminder');

  assert(defaultScenario.handoffPrompt.includes(handoffProse), 'handoff prompt should include handoff prose');
  assert(defaultScenario.handoffPrompt.includes(handoffArgs), 'handoff prompt should include handoff args reminder');
  assert(defaultScenario.handoffAllowedOperations.includes('createHandoffTask'), 'handoff runtimeEnvelope.allowedOperations should include createHandoffTask');

  assert(!canonicalScenario.ordinaryPrompt.includes(workflowIntentProse), 'canonical ordinary prompt should not include workflow draft intent prose');
  assert(!canonicalScenario.ordinaryPrompt.includes(canonicalEnabled), 'canonical ordinary prompt should not include canonical enabled guidance');
  assert(!canonicalScenario.ordinaryPrompt.includes(canonicalDisabled), 'canonical ordinary prompt should not include canonical disabled warning');
  assert(canonicalScenario.ordinaryAllowedOperations.includes('createWorkflowDraftIntent'), 'canonical ordinary allowedOperations should still include createWorkflowDraftIntent');
  assert(canonicalScenario.ordinaryAllowedOperations.includes('createHandoffTask'), 'canonical ordinary allowedOperations should still include createHandoffTask');
  assert(!canonicalScenario.ordinaryPrompt.includes(handoffProse), 'canonical ordinary prompt should not include handoff prose');
  assert(!canonicalScenario.ordinaryPrompt.includes(handoffArgs), 'canonical ordinary prompt should not include handoff args reminder');

  assert(canonicalScenario.workflowPrompt.includes(workflowIntentProse), 'canonical workflow prompt should include workflow draft intent prose');
  assert(canonicalScenario.workflowPrompt.includes(canonicalEnabled), 'canonical workflow prompt should include canonical enabled guidance');
  assert(canonicalScenario.workflowPrompt.includes('"workflow":"for createWorkflowDraft only"'), 'canonical workflow response schema should include canonical workflow field');
  assert(!canonicalScenario.workflowPrompt.includes(handoffProse), 'canonical workflow prompt should not include handoff prose');
  assert(!canonicalScenario.workflowPrompt.includes(handoffArgs), 'canonical workflow prompt should not include handoff args reminder');
  assert(canonicalScenario.handoffPrompt.includes(handoffProse), 'canonical handoff prompt should include handoff prose');
  assert(canonicalScenario.handoffPrompt.includes(handoffArgs), 'canonical handoff prompt should include handoff args reminder');

  console.log(JSON.stringify({ conditionalWorkflowPrompt: true }));
}

main().catch(error => {
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});

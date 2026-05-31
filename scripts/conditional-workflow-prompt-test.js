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
    await createTicket(baseUrl, cookie, agent, ordinaryObjective);
    await createTicket(baseUrl, cookie, agent, workflowObjective);

    const tickets = readJson(dataDir, 'tickets.json');
    const ordinaryTicket = tickets.find(ticket => ticket.objective === ordinaryObjective);
    const workflowTicket = tickets.find(ticket => ticket.objective === workflowObjective);
    const ordinaryRun = await waitForRun(dataDir, ordinaryTicket.id);
    const workflowRun = await waitForRun(dataDir, workflowTicket.id);
    const ordinarySnapshot = readSnapshot(dataDir, ordinaryRun);
    const workflowSnapshot = readSnapshot(dataDir, workflowRun);

    return {
      ordinaryPrompt: ordinarySnapshot.systemInstructionSnapshot,
      workflowPrompt: workflowSnapshot.systemInstructionSnapshot,
      ordinaryAllowedOperations: ordinarySnapshot.runtimeEnvelope.allowedOperations,
      workflowAllowedOperations: workflowSnapshot.runtimeEnvelope.allowedOperations
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

  assert(!defaultScenario.ordinaryPrompt.includes(workflowIntentProse), 'ordinary prompt should not include workflow draft intent prose');
  assert(!defaultScenario.ordinaryPrompt.includes(workflowIntentArgs), 'ordinary prompt should not include workflow draft intent args reminder');
  assert(!defaultScenario.ordinaryPrompt.includes(workflowIntentField), 'ordinary prompt should not include workflow draft intent response schema fields');
  assert(!defaultScenario.ordinaryPrompt.includes(canonicalDisabled), 'ordinary prompt should not include canonical disabled warning');
  assert(defaultScenario.ordinaryAllowedOperations.includes('createWorkflowDraftIntent'), 'ordinary runtimeEnvelope.allowedOperations should still include createWorkflowDraftIntent');

  assert(defaultScenario.workflowPrompt.includes(workflowIntentProse), 'workflow prompt should include workflow draft intent prose');
  assert(defaultScenario.workflowPrompt.includes(workflowIntentArgs), 'workflow prompt should include workflow draft intent args reminder');
  assert(defaultScenario.workflowPrompt.includes(workflowIntentField), 'workflow prompt should include workflow draft intent response schema fields');
  assert(defaultScenario.workflowPrompt.includes(canonicalDisabled), 'workflow prompt should include canonical disabled warning when canonical env is off');

  assert(!canonicalScenario.ordinaryPrompt.includes(workflowIntentProse), 'canonical ordinary prompt should not include workflow draft intent prose');
  assert(!canonicalScenario.ordinaryPrompt.includes(canonicalEnabled), 'canonical ordinary prompt should not include canonical enabled guidance');
  assert(!canonicalScenario.ordinaryPrompt.includes(canonicalDisabled), 'canonical ordinary prompt should not include canonical disabled warning');
  assert(canonicalScenario.ordinaryAllowedOperations.includes('createWorkflowDraftIntent'), 'canonical ordinary allowedOperations should still include createWorkflowDraftIntent');

  assert(canonicalScenario.workflowPrompt.includes(workflowIntentProse), 'canonical workflow prompt should include workflow draft intent prose');
  assert(canonicalScenario.workflowPrompt.includes(canonicalEnabled), 'canonical workflow prompt should include canonical enabled guidance');
  assert(canonicalScenario.workflowPrompt.includes('"workflow":"for createWorkflowDraft only"'), 'canonical workflow response schema should include canonical workflow field');

  console.log(JSON.stringify({ conditionalWorkflowPrompt: true }));
}

main().catch(error => {
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});

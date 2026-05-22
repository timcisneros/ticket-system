const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { createTempWorkspaceRoot, removeTempWorkspaceRoot } = require('./test-workspace');

const ROOT = path.resolve(__dirname, '..');
const REAL_DATA_DIR = path.join(ROOT, 'data');
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'page-render-data-'));
const WORKSPACE_ROOT = createTempWorkspaceRoot('page-render');
const PORT = process.env.PORT || '3425';
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
  'users.json'
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

function waitForExit(child) {
  return new Promise(resolve => {
    if (child.exitCode !== null || child.killed) return resolve();
    child.once('exit', () => resolve());
  });
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

  if (response.statusCode !== 302) {
    throw new Error(`Admin login failed with HTTP ${response.statusCode}`);
  }

  return cookieFrom(response);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function seedNavigationFixture() {
  const agents = readJson('agents.json');
  const tickets = readJson('tickets.json');
  const runs = readJson('runs.json');
  const logs = readJson('logs.json');
  const now = new Date().toISOString();
  const agent = agents[0] || {
    id: 1,
    name: 'PageRenderAgent',
    type: 'agent',
    provider: 'openai',
    model: 'gpt-4.1-mini',
    apiKey: 'test-key',
    createdAt: now
  };

  if (!agents.some(item => item.id === agent.id)) {
    writeJson('agents.json', [...agents, agent]);
  }

  const ticketId = Math.max(0, ...tickets.map(item => item.id || 0)) + 1;
  const runId = Math.max(0, ...runs.map(item => item.id || 0)) + 1;
  const ticket = {
    id: ticketId,
    objective: 'page render fixture',
    assignmentTargetType: 'agent',
    assignmentTargetId: agent.id,
    assignmentMode: 'individual',
    status: 'completed',
    createdBy: 'admin',
    createdAt: now,
    updatedAt: now
  };
  const run = {
    id: runId,
    ticketId,
    agentId: agent.id,
    agentName: agent.name,
    workspaceRoot: WORKSPACE_ROOT,
    mainWorkspaceRoot: WORKSPACE_ROOT,
    executionWorkspaceType: 'main',
    status: 'completed',
    ticketOpenedAt: now,
    createdAt: now,
    updatedAt: now,
    startedAt: now,
    completedAt: now,
    replaySnapshot: {
      version: 1,
      runId,
      ticketId,
      assignedAgentId: agent.id,
      agentNameSnapshot: agent.name,
      provider: 'openai',
      model: agent.model,
      runtimeEnvelope: {},
      ticketObjectiveSnapshot: ticket.objective,
      systemInstructionSnapshot: 'fixture',
      primitiveContract: {},
      workspaceRoot: WORKSPACE_ROOT,
      mainWorkspaceRoot: WORKSPACE_ROOT,
      executionWorkspaceType: 'main',
      providerRequests: [],
      modelResponses: [],
      parsedModelPlans: [],
      workspaceOperations: [],
      events: [{ type: 'run:completed_noop', message: 'fixture' }],
      terminalStatus: 'completed',
      failureReason: null,
      mutationCount: 0,
      mutationOutcome: 'no_mutations',
      createdAt: now,
      finalizedAt: now
    }
  };
  const log = {
    id: Math.max(0, ...logs.map(item => item.id || 0)) + 1,
    timestamp: now,
    runId,
    ticketId,
    agentId: agent.id,
    agentName: agent.name,
    type: 'run:completed',
    message: 'Page render fixture completed',
    workspaceAction: null
  };

  writeJson('tickets.json', [...tickets, ticket]);
  writeJson('runs.json', [...runs, run]);
  writeJson('logs.json', [...logs, log]);
  return { ticket, run };
}

async function assertMainFormRenders(cookie, label) {
  const response = await request('GET', '/', { cookie });
  assert(response.statusCode === 200, `${label}: GET / returned HTTP ${response.statusCode}: ${response.body.slice(0, 240)}`);
  assert(response.body.includes('Create New Ticket'), `${label}: main form heading missing`);
  assert(response.body.includes('Manual folder scopes'), `${label}: manual scope option missing`);
  assert(response.body.includes('Automatic folder scopes'), `${label}: dynamic scope option missing`);
  assert(response.body.includes('const agentGroupMembers = '), `${label}: agentGroupMembers script missing`);
}

async function assertPageRenders(cookie, pathValue, label, expectedText) {
  const response = await request('GET', pathValue, { cookie });
  assert(response.statusCode === 200, `${label}: GET ${pathValue} returned HTTP ${response.statusCode}: ${response.body.slice(0, 240)}`);
  if (expectedText) {
    assert(response.body.includes(expectedText), `${label}: expected text missing: ${expectedText}`);
  }
  return response;
}

async function main() {
  let server = null;

  try {
    server = spawn(process.execPath, ['server.js'], {
      cwd: ROOT,
      env: {
        ...process.env,
        NODE_ENV: 'test',
        PORT,
        WORKSPACE_ROOT,
        DATA_DIR
      },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    server.stdout.on('data', chunk => process.stdout.write(String(chunk)));
    server.stderr.on('data', chunk => process.stderr.write(String(chunk)));

    await waitForReady();
    const cookie = await login();
    const fixture = seedNavigationFixture();

    await assertMainFormRenders(cookie, 'groups present');
    await assertPageRenders(cookie, '/logs', 'logs', 'Logs');
    await assertPageRenders(cookie, `/logs?runId=${fixture.run.id}`, 'run-filtered logs', `Run #${fixture.run.id}`);
    await assertPageRenders(cookie, `/logs?ticketId=${fixture.ticket.id}`, 'ticket-filtered logs', `Ticket #${fixture.ticket.id}`);
    await assertPageRenders(cookie, '/tickets', 'tickets', 'Live Work');
    await assertPageRenders(cookie, `/tickets/${fixture.ticket.id}`, 'ticket detail', 'Run Outcome');
    await assertPageRenders(cookie, `/runs/${fixture.run.id}`, 'run detail', 'Run Outcome');

    writeJson('groups.json', readJson('groups.json').map(group => ({ ...group, canReceiveTickets: false })));
    writeJson('memberships.json', readJson('memberships.json').filter(membership => membership.principalType !== 'agent'));
    await assertMainFormRenders(cookie, 'no ticket-capable groups');

    console.log(JSON.stringify({ mainFormRender: true, noTicketCapableGroupsRender: true }));
  } finally {
    if (server) {
      server.kill();
      await waitForExit(server);
    }
    removeTempWorkspaceRoot(WORKSPACE_ROOT);
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});

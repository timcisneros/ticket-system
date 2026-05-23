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

  const extraTickets = Array.from({ length: 3 }, (_, index) => ({
    ...ticket,
    id: ticketId + index + 1,
    objective: `page render extra ticket ${index + 1}`,
    updatedAt: new Date(Date.now() - index - 1000).toISOString()
  }));

  writeJson('tickets.json', [...tickets, ticket, ...extraTickets]);
  writeJson('runs.json', [...runs, run]);
  writeJson('logs.json', [
    ...logs,
    ...Array.from({ length: 6 }, (_, index) => ({
      ...log,
      id: log.id + index,
      timestamp: new Date(Date.now() + index).toISOString(),
      message: `Page render fixture log ${index + 1}`
    }))
  ]);
  return { ticket, run };
}

async function assertMainFormRenders(cookie, label) {
  const response = await request('GET', '/', { cookie });
  assert(response.statusCode === 200, `${label}: GET / returned HTTP ${response.statusCode}: ${response.body.slice(0, 240)}`);
  assert(response.body.includes('Create New Ticket'), `${label}: main form heading missing`);
  assert(response.body.includes('Write a small, concrete output'), `${label}: bounded objective guidance missing`);
  assert(response.body.includes('Avoid vague requests'), `${label}: vague objective warning missing`);
  assert(response.body.includes('independent additive output'), `${label}: group bounded output guidance missing`);
  assert(response.body.includes('Suggest bounded version'), `${label}: ticket shaping button missing`);
  assert(response.body.includes('/api/tickets/shape-objective'), `${label}: ticket shaping endpoint wiring missing`);
  assert(response.body.includes('Manual folder scopes'), `${label}: manual scope option missing`);
  assert(response.body.includes('Automatic folder scopes'), `${label}: dynamic scope option missing`);
  assert(response.body.includes('const agentGroupMembers = '), `${label}: agentGroupMembers script missing`);
  assert(response.body.includes('value="agent" selected'), `${label}: one-agent path is not the default`);
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
    const logsPage = await assertPageRenders(cookie, '/logs?limit=2', 'logs', 'Showing 1-2 of');
    assert(!logsPage.body.includes('data-log-time'), 'logs page should not require client-side timestamp replacement');
    assert(logsPage.body.includes('Next'), 'logs page should include next pagination');
    assert((logsPage.body.match(/<tr data-log-id=/g) || []).length === 2, 'logs page should render only the requested page size');
    assert(logsPage.body.includes('rows.slice(maxRows).forEach'), 'live log inserts should trim rows beyond the page size');
    await assertPageRenders(cookie, `/logs?runId=${fixture.run.id}&limit=2`, 'run-filtered logs', `Run #${fixture.run.id}`);
    await assertPageRenders(cookie, `/logs?ticketId=${fixture.ticket.id}&limit=2`, 'ticket-filtered logs', `Ticket #${fixture.ticket.id}`);
    const logsApi = await request('GET', `/api/logs?runId=${fixture.run.id}&limit=2`, { cookie });
    assert(logsApi.statusCode === 200, `logs API returned HTTP ${logsApi.statusCode}`);
    const logsPayload = JSON.parse(logsApi.body);
    assert(logsPayload.logs.length === 2, 'logs API should return requested page size');
    assert(logsPayload.pagination && logsPayload.pagination.total >= 6, 'logs API should include pagination total');
    await assertPageRenders(cookie, '/tickets', 'tickets', 'Live Work');
    const ticketsPage = await assertPageRenders(cookie, '/tickets?limit=1', 'paginated tickets', 'Showing 1-1 of');
    assert((ticketsPage.body.match(/class="ticket-card /g) || []).length === 1, 'tickets page should render only the requested page size');
    const ticketsApi = await request('GET', '/api/tickets?limit=1', { cookie });
    assert(ticketsApi.statusCode === 200, `tickets API returned HTTP ${ticketsApi.statusCode}`);
    const ticketsPayload = JSON.parse(ticketsApi.body);
    assert(ticketsPayload.tickets.length === 1, 'tickets API should return requested page size');
    assert(ticketsPayload.pagination && ticketsPayload.pagination.total >= 4, 'tickets API should include pagination total');
    const ticketDetail = await assertPageRenders(cookie, `/tickets/${fixture.ticket.id}`, 'ticket detail', 'Run Outcome');
    assert(ticketDetail.body.includes('<summary>Ticket Details</summary>'), 'ticket detail should collapse metadata');
    assert(ticketDetail.body.includes('Recent Activity'), 'ticket detail should include inline recent activity');
    assert(!ticketDetail.body.includes('<th>Work Unit</th>'), 'single-agent ticket detail should not show group-only work unit column');
    const runDetail = await assertPageRenders(cookie, `/runs/${fixture.run.id}`, 'run detail', 'Run Outcome');
    assert(runDetail.body.includes('Recent Activity'), 'run detail should include inline recent activity');
    assert(runDetail.body.includes('<summary>Ticket Objective</summary>'), 'run detail should collapse repeated ticket objective');
    assert(runDetail.body.includes('<summary>Prompt Instructions</summary>'), 'run detail should collapse prompt instructions');
    await assertPageRenders(cookie, '/admin', 'admin dashboard', 'Admin Dashboard');
    const actionsPage = await assertPageRenders(cookie, '/admin/actions', 'actions catalog', 'Actions Catalog');
    assert(actionsPage.body.includes('listDirectory'), 'actions catalog should list listDirectory');
    assert(actionsPage.body.includes('writeFile'), 'actions catalog should list writeFile');
    assert(actionsPage.body.includes('Provider/Model Call'), 'actions catalog should list provider/model call');
    assert(actionsPage.body.includes('Stop / Interruption'), 'actions catalog should list stop/interruption');
    assert(actionsPage.body.includes('Ticket Shaping'), 'actions catalog should list ticket shaping');
    assert(actionsPage.body.includes('Retry / Rerun'), 'actions catalog should list retry/rerun');
    assert(actionsPage.body.includes('Recovery'), 'actions catalog should list recovery');
    assert(actionsPage.body.includes('Actions Catalog'), 'actions catalog page heading should render');
    assert(actionsPage.body.includes('workspace'), 'actions catalog should include workspace category');
    assert(actionsPage.body.includes('provider'), 'actions catalog should include provider category');
    assert(actionsPage.body.includes('operator'), 'actions catalog should include operator category');
    assert(actionsPage.body.includes('system'), 'actions catalog should include system category');
    assert(actionsPage.body.includes('agent'), 'actions catalog should include agent invoker');
    assert(actionsPage.body.includes('Show contract'), 'actions catalog should have expandable contract');
    assert(actionsPage.body.includes('Request'), 'actions catalog should label request shape');
    assert(actionsPage.body.includes('Response'), 'actions catalog should label response shape');
    assert(actionsPage.body.includes('Error'), 'actions catalog should label error shape');
    assert(actionsPage.body.includes('Authority:'), 'actions catalog should show authority constraint');
    assert(actionsPage.body.includes('Provenance:'), 'actions catalog should show provenance surface');

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

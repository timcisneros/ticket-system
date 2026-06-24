const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { createTempWorkspaceRoot, removeTempWorkspaceRoot } = require('./test-workspace');

const ROOT = path.resolve(__dirname, '..');
const REAL_DATA_DIR = path.join(ROOT, 'data');
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ticket-feasibility-data-'));
const WORKSPACE_ROOT = createTempWorkspaceRoot('ticket-feasibility');
const PORT = process.env.PORT || '3433';
const BASE_URL = `http://127.0.0.1:${PORT}`;
const DATA_FILES = [
  'agents.json', 'allocation-plans.json', 'events.jsonl', 'groups.json',
  'logs.json', 'memberships.json', 'operation-history.json', 'permissions.json',
  'runs.json', 'tickets.json', 'users.json', 'workflows.json'
];

function copyDataFiles(targetDir) {
  for (const file of DATA_FILES) {
    const src = path.join(REAL_DATA_DIR, file);
    const dst = path.join(targetDir, file);
    if (fs.existsSync(src)) fs.copyFileSync(src, dst);
    else fs.writeFileSync(dst, file.endsWith('.jsonl') ? '' : '[]');
  }
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
      res.on('end', () => resolve({
        statusCode: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks).toString('utf8')
      }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function cookieFrom(response) {
  return (response.headers['set-cookie'] || []).map(c => c.split(';')[0]).join('; ');
}

function waitForExit(child) {
  return new Promise(resolve => {
    if (child.exitCode !== null || child.killed) return resolve();
    child.once('exit', () => resolve());
  });
}

async function waitForReady(timeout = 15000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    try {
      const response = await request('GET', '/health');
      if (response.statusCode === 200 && JSON.parse(response.body).ready) return;
    } catch (_) {}
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

function seedGroup() {
  const agents = readJson('agents.json');
  const groups = readJson('groups.json');
  const memberships = readJson('memberships.json');
  const nextAgentId = Math.max(0, ...agents.map(a => a.id)) + 1;
  const nextGroupId = Math.max(0, ...groups.map(g => g.id)) + 1;
  const nextMembershipId = Math.max(0, ...memberships.map(m => m.id)) + 1;
  const seededAgents = [
    { id: nextAgentId, name: 'FeasibilityA', type: 'agent', provider: 'openai', model: 'gpt-4.1-mini', apiKey: 'test-key-a', createdAt: new Date().toISOString() },
    { id: nextAgentId + 1, name: 'FeasibilityB', type: 'agent', provider: 'openai', model: 'gpt-4.1-mini', apiKey: 'test-key-b', createdAt: new Date().toISOString() }
  ];
  const group = { id: nextGroupId, name: 'Feasibility Gate', permissions: [], canReceiveTickets: true };

  writeJson('agents.json', [...agents, ...seededAgents]);
  writeJson('groups.json', [...groups, group]);
  writeJson('memberships.json', [
    ...memberships,
    { id: nextMembershipId, principalType: 'agent', principalId: seededAgents[0].id, groupId: group.id },
    { id: nextMembershipId + 1, principalType: 'agent', principalId: seededAgents[1].id, groupId: group.id }
  ]);
  return { agents: seededAgents, group };
}

function seedQuarterWorkspace() {
  for (const dir of ['Q1', 'Q2', 'Q3', 'Q4']) {
    fs.mkdirSync(path.join(WORKSPACE_ROOT, dir), { recursive: true });
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function main() {
  copyDataFiles(DATA_DIR);
  const { agents, group } = seedGroup();
  seedQuarterWorkspace();
  let server = null;

  try {
    server = spawn(process.execPath, ['server.js'], {
      cwd: ROOT,
      env: { ...process.env, NODE_ENV: 'test', PORT, WORKSPACE_ROOT, DATA_DIR },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    server.stdout.on('data', chunk => process.stdout.write(String(chunk)));
    server.stderr.on('data', chunk => process.stderr.write(String(chunk)));

    await waitForReady();
    const cookie = await login();
    const objective = 'inside the folders for quarters, put the months for those specific quarters';
    const response = await request('POST', '/tickets', {
      cookie,
      form: {
        objective,
        assignmentTargetType: 'group',
        assignmentTargetId: String(group.id),
        assignmentMode: 'allocated',
        ownedOutputPaths: JSON.stringify({
          [agents[0].id]: 'Q1',
          [agents[1].id]: 'Q2'
        })
      }
    });

    assert(response.statusCode === 302, `Ticket create failed with HTTP ${response.statusCode}: ${response.body}`);
    await new Promise(resolve => setTimeout(resolve, 300));

    const ticket = readJson('tickets.json').find(t => t.objective === objective);
    assert(ticket, 'Ticket was not persisted');
    assert(ticket.status === 'blocked', `Ticket should be blocked, got ${ticket.status}`);
    assert(ticket.blockedReason === 'Ticket objective requires paths not granted by authority:\nQ3/\nQ4/', 'Blocked reason did not list Q3/Q4 exactly');
    assert(JSON.stringify(ticket.feasibility.requiredWritableRoots) === JSON.stringify(['Q1/', 'Q2/', 'Q3/', 'Q4/']), 'Required roots were not captured');
    assert(JSON.stringify(ticket.feasibility.grantedWritableRoots) === JSON.stringify(['Q1/', 'Q2/']), 'Granted roots were not captured');
    assert(JSON.stringify(ticket.feasibility.missingAuthorityGrants) === JSON.stringify(['Q3/', 'Q4/']), 'Missing grants were not captured');
    assert(ticket.triage && ticket.triage.required === true, 'Blocked ticket should persist required ticket-level triage');
    assert(ticket.triage.reasonCode === 'authority_blocked', 'Missing authority grants should map to authority_blocked triage');
    assert(ticket.triage.requiredDecision === 'change_scope', 'Missing authority grants should require a scope change');
    assert(ticket.triage.allowedActions.includes('edit_ticket'), 'Ticket triage should allow editing the ticket');
    assert(ticket.triage.prohibitedActions.includes('start_run_without_scope_change'), 'Ticket triage should prohibit starting without a scope change');
    assert(readJson('runs.json').filter(r => r.ticketId === ticket.id).length === 0, 'Blocked ticket created agent runs');
    assert(readJson('allocation-plans.json').filter(p => p.ticketId === ticket.id).length === 0, 'Blocked ticket created allocation plan');
    assert(!readJson('logs.json').some(log => log.ticketId === ticket.id && log.type === 'workspace:ownership_blocked'), 'Blocked ticket produced protected_path runtime failures');
    const ticketPage = await request('GET', `/tickets/${ticket.id}`, { cookie });
    assert(ticketPage.statusCode === 200, `Ticket detail failed with HTTP ${ticketPage.statusCode}`);
    assert(ticketPage.body.includes('Ticket-Level Triage'), 'Ticket detail should identify pre-run ticket triage');
    assert(ticketPage.body.includes('<code>authority_blocked</code>'), 'Ticket detail should show the ticket triage reason');
    assert(ticketPage.body.includes('<code>change_scope</code>'), 'Ticket detail should show the required decision');
    assert(!ticketPage.body.includes('Latest Run Triage'), 'Pre-run ticket triage should not be rendered as latest-run triage');
    const completeBlockedTicket = await request('PATCH', `/api/tickets/${ticket.id}/status`, {
      cookie,
      body: { status: 'completed' }
    });
    assert(completeBlockedTicket.statusCode === 409, 'Pre-run blocked ticket must reject manual completed transition');
    assert(JSON.parse(completeBlockedTicket.body).error.includes('ticket-level triage'), 'Blocked ticket completion rejection should explain required ticket triage');

    console.log('PASS: ticket feasibility gate blocks missing Q3/Q4 grants before runs');
  } finally {
    if (server) {
      server.kill('SIGTERM');
      await waitForExit(server);
    }
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
    removeTempWorkspaceRoot(WORKSPACE_ROOT);
  }
}

main().catch(error => {
  console.error(error.stack || error.message);
  process.exit(1);
});

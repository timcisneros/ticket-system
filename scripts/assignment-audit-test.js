const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { createTempWorkspaceRoot, removeTempWorkspaceRoot } = require('./test-workspace');

const ROOT = path.resolve(__dirname, '..');
const REAL_DATA_DIR = path.join(ROOT, 'data');
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'assignment-audit-data-'));
const WORKSPACE_ROOT = createTempWorkspaceRoot('assignment-audit');
const PORT = process.env.PORT || '3444';
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

function readEvents() {
  return fs.readFileSync(path.join(DATA_DIR, 'events.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line));
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

function seedFixture() {
  const now = new Date('2026-01-01T00:00:00.000Z').toISOString();
  const agents = readJson('agents.json');
  const nextAgentId = Math.max(0, ...agents.map(agent => agent.id || 0)) + 1;
  const fromAgent = { id: nextAgentId, name: 'Assignment Audit From', type: 'agent', provider: 'openai', model: 'gpt-4.1-mini', apiKey: 'test-key', createdAt: now };
  const toAgent = { id: nextAgentId + 1, name: 'Assignment Audit To', type: 'agent', provider: 'openai', model: 'gpt-4.1-mini', apiKey: 'test-key', createdAt: now };
  writeJson('agents.json', [...agents, fromAgent, toAgent]);

  const tickets = readJson('tickets.json');
  const ticket = {
    id: Math.max(0, ...tickets.map(item => item.id || 0)) + 1,
    objective: 'assignment audit trail regression',
    assignmentTargetType: 'agent',
    assignmentTargetId: fromAgent.id,
    assignmentMode: 'individual',
    ownedOutputPaths: null,
    executionMode: 'agent',
    workflowId: null,
    workflowInput: null,
    capabilityType: 'directAction',
    capabilityId: 'agent-selected-actions',
    capabilityInput: null,
    status: 'open',
    createdBy: 'seed',
    changedBy: 'seed',
    changedAt: now,
    createdAt: now,
    updatedAt: now
  };
  writeJson('tickets.json', [...tickets, ticket]);
  return { ticket, fromAgent, toAgent };
}

async function main() {
  const { ticket, fromAgent, toAgent } = seedFixture();
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      PORT,
      DATA_DIR,
      WORKSPACE_ROOT
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  let childOutput = '';
  child.stdout.on('data', chunk => { childOutput += chunk.toString(); });
  child.stderr.on('data', chunk => { childOutput += chunk.toString(); });

  try {
    await waitForReady();
    const cookie = await login();

    const beforeLogCount = readJson('logs.json').filter(log => log.type === 'ticket:assignment_change').length;
    const updateResponse = await request('PATCH', `/api/tickets/${ticket.id}/assignment`, {
      cookie,
      body: { agentId: toAgent.id }
    });
    assert(updateResponse.statusCode === 200, `assignment update returned HTTP ${updateResponse.statusCode}`);

    const updatedTicket = readJson('tickets.json').find(item => item.id === ticket.id);
    assert(updatedTicket.assignmentTargetId === toAgent.id, 'assignment update should change agent');
    assert(updatedTicket.changedBy === 'admin', 'assignment update should set changedBy');
    assert(updatedTicket.changedAt && updatedTicket.changedAt !== ticket.changedAt, 'assignment update should set a new changedAt');
    assert(updatedTicket.updatedAt === updatedTicket.changedAt, 'assignment update should keep updatedAt equal to changedAt');

    const updatedEvent = readEvents().find(event =>
      event.type === 'ticket.updated' &&
      event.ticketId === ticket.id &&
      event.payload &&
      event.payload.assignmentTargetId === toAgent.id &&
      event.payload.changedBy === 'admin'
    );
    assert(updatedEvent, 'assignment update should emit ticket.updated with changedBy');
    assert(updatedEvent.payload.changedAt === updatedTicket.changedAt, 'assignment ticket.updated should include changedAt');

    const logsAfterChange = readJson('logs.json').filter(log => log.type === 'ticket:assignment_change');
    assert(logsAfterChange.length === beforeLogCount + 1, 'assignment update should append ticket:assignment_change log');
    const auditLog = logsAfterChange[logsAfterChange.length - 1];
    assert(auditLog.changedBy === 'admin', 'assignment change log should include changedBy');
    assert(auditLog.changedAt === updatedTicket.changedAt, 'assignment change log should include changedAt');
    assert(auditLog.previousAssignment.assignmentTargetId === fromAgent.id, 'assignment change log should include previous assignment');
    assert(auditLog.nextAssignment.assignmentTargetId === toAgent.id, 'assignment change log should include next assignment');

    const beforeNoopTicket = { ...updatedTicket };
    const logsBeforeNoop = readJson('logs.json').filter(log => log.type === 'ticket:assignment_change').length;
    const eventsBeforeNoop = readEvents().filter(event => event.type === 'ticket.updated' && event.ticketId === ticket.id).length;
    const noopResponse = await request('PATCH', `/api/tickets/${ticket.id}/assignment`, {
      cookie,
      body: { agentId: toAgent.id }
    });
    assert(noopResponse.statusCode === 200, `no-op assignment update returned HTTP ${noopResponse.statusCode}`);

    const afterNoopTicket = readJson('tickets.json').find(item => item.id === ticket.id);
    assert(afterNoopTicket.changedBy === beforeNoopTicket.changedBy, 'no-op assignment should not rewrite changedBy');
    assert(afterNoopTicket.changedAt === beforeNoopTicket.changedAt, 'no-op assignment should not rewrite changedAt');
    assert(afterNoopTicket.updatedAt === beforeNoopTicket.updatedAt, 'no-op assignment should not rewrite updatedAt');
    assert(readJson('logs.json').filter(log => log.type === 'ticket:assignment_change').length === logsBeforeNoop, 'no-op assignment should not append assignment_change log');
    assert(readEvents().filter(event => event.type === 'ticket.updated' && event.ticketId === ticket.id).length === eventsBeforeNoop, 'no-op assignment should not append ticket.updated event');

    console.log(JSON.stringify({
      assignmentAuditTrail: true,
      changedBy: updatedTicket.changedBy,
      updatedAtEqualsChangedAt: updatedTicket.updatedAt === updatedTicket.changedAt,
      noOpPreservedAudit: true
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

const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { createTempWorkspaceRoot, removeTempWorkspaceRoot } = require('./test-workspace');

const ROOT = path.resolve(__dirname, '..');
const REAL_DATA_DIR = path.join(ROOT, 'data');
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'status-transition-evidence-data-'));
const WORKSPACE_ROOT = createTempWorkspaceRoot('status-transition-evidence');
const PORT = process.env.PORT || '3445';
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
  const agent = { id: nextAgentId, name: 'Status Evidence Agent', type: 'agent', provider: 'openai', model: 'gpt-4.1-mini', apiKey: 'test-key', createdAt: now };
  writeJson('agents.json', [...agents, agent]);

  const tickets = readJson('tickets.json');
  const ticket = {
    id: Math.max(0, ...tickets.map(item => item.id || 0)) + 1,
    objective: 'status transition evidence trail regression',
    assignmentTargetType: 'agent',
    assignmentTargetId: agent.id,
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
  return { ticket, agent };
}

async function main() {
  const { ticket } = seedFixture();
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

    const statusChangesBefore = readJson('logs.json').filter(log => log.type === 'ticket:status_change' && log.contextTicketId === ticket.id).length;

    const blockResponse = await request('PATCH', `/api/tickets/${ticket.id}/status`, {
      cookie,
      body: { status: 'blocked' }
    });
    assert(blockResponse.statusCode === 200, `block transition returned HTTP ${blockResponse.statusCode}: ${blockResponse.body}`);

    const openResponse = await request('PATCH', `/api/tickets/${ticket.id}/status`, {
      cookie,
      body: { status: 'open' }
    });
    assert(openResponse.statusCode === 200, `open transition returned HTTP ${openResponse.statusCode}: ${openResponse.body}`);

    const statusChangeLogs = readJson('logs.json').filter(log => log.type === 'ticket:status_change' && log.contextTicketId === ticket.id);
    assert(statusChangeLogs.length === statusChangesBefore + 2, `expected ${statusChangesBefore + 2} status change logs, got ${statusChangeLogs.length}`);

    const openLog = statusChangeLogs[statusChangeLogs.length - 1];
    assert(openLog.fromStatus === 'blocked', `open log fromStatus should be blocked, got ${openLog.fromStatus}`);
    assert(openLog.toStatus === 'open', `open log toStatus should be open, got ${openLog.toStatus}`);
    assert(openLog.changedBy === 'admin', `open log changedBy should be admin, got ${openLog.changedBy}`);
    assert(typeof openLog.changedAt === 'string' && openLog.changedAt.length > 0, 'open log should include changedAt');

    const timelineResponse = await request('GET', `/api/tickets/${ticket.id}/timeline`, { cookie });
    assert(timelineResponse.statusCode === 200, `timeline endpoint failed: ${timelineResponse.statusCode} ${timelineResponse.body}`);
    const timeline = JSON.parse(timelineResponse.body);
    assert(Array.isArray(timeline.entries), 'timeline entries missing');
    const statusEntry = timeline.entries.find(entry =>
      entry.type === 'ticket:status_change' &&
      entry.title === 'Ticket status changed' &&
      entry.details && entry.details.toStatus === 'open'
    );
    assert(statusEntry, 'timeline should include ticket status change entry for open transition');
    assert(statusEntry.summary && statusEntry.summary.includes('blocked') && statusEntry.summary.includes('open'), `timeline summary should include transition: ${statusEntry.summary}`);
    assert(statusEntry.details && statusEntry.details.fromStatus === 'blocked' && statusEntry.details.toStatus === 'open', 'timeline details should include fromStatus and toStatus');
    assert(statusEntry.details && statusEntry.details.changedBy === 'admin', 'timeline details should include changedBy');

    const logsApiResponse = await request('GET', `/api/logs?ticketId=${ticket.id}`, { cookie });
    assert(logsApiResponse.statusCode === 200, `/api/logs endpoint failed: ${logsApiResponse.statusCode} ${logsApiResponse.body}`);
    const logsApi = JSON.parse(logsApiResponse.body);
    assert(Array.isArray(logsApi.logs), 'api logs array missing');
    const apiStatusLog = logsApi.logs.find(log => log.type === 'ticket:status_change');
    assert(apiStatusLog, '/api/logs?ticketId=N should include ticket:status_change log');
    assert(apiStatusLog.fromStatus === 'blocked' && apiStatusLog.toStatus === 'open', 'api log should preserve fromStatus/toStatus');

    const logsPageResponse = await request('GET', `/logs?ticketId=${ticket.id}`, { cookie });
    assert(logsPageResponse.statusCode === 200, `/logs page failed: ${logsPageResponse.statusCode} ${logsPageResponse.body}`);
    assert(logsPageResponse.body.includes('Ticket #' + ticket.id), '/logs page should show ticket context for status change log');
    assert(logsPageResponse.body.includes('ticket:status_change'), '/logs page should render ticket:status_change type');
    assert(logsPageResponse.body.includes('Changed by') || logsPageResponse.body.includes('Changed by <strong>admin</strong>'), '/logs page should render changedBy audit meta');

    const reopenedTicket = readJson('tickets.json').find(item => item.id === ticket.id);
    assert(reopenedTicket.status !== 'blocked', 'explicit open should leave ticket unblocked (may advance to in_progress via run creation)');
    assert(reopenedTicket.changedBy === 'admin', 'ticket changedBy should reflect operator');

    console.log(JSON.stringify({
      statusTransitionEvidenceVisible: true,
      timelineIncludesStatusChange: true,
      logsApiIncludesContextTicketIdLogs: true,
      logsPageShowsTicketContext: true,
      fromStatusPreserved: openLog.fromStatus,
      toStatusPreserved: openLog.toStatus,
      changedByPreserved: openLog.changedBy
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

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
const BROWSER_TARGET_ID = 'page-render-browser';
const DATA_FILES = [
  'agents.json',
  'allocation-plans.json',
  'browser-targets.json',
  'groups.json',
  'logs.json',
  'memberships.json',
  'operation-history.json',
  'permissions.json',
  'runs.json',
  'tickets.json',
  'users.json',
  'workflows.json',
  'work-types.json'
];

for (const file of DATA_FILES) {
  const src = path.join(REAL_DATA_DIR, file);
  const dst = path.join(DATA_DIR, file);
  fs.writeFileSync(dst, fs.existsSync(src) ? fs.readFileSync(src, 'utf8') : '[]');
}

fs.writeFileSync(path.join(DATA_DIR, 'events.jsonl'), '');

function readJson(file) {
  return JSON.parse(fs.readFileSync(path.join(DATA_DIR, file), 'utf8'));
}

function writeJson(file, value) {
  fs.writeFileSync(path.join(DATA_DIR, file), JSON.stringify(value, null, 2));
}

function appendEvent(event) {
  fs.appendFileSync(path.join(DATA_DIR, 'events.jsonl'), JSON.stringify(event) + '\n');
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
  const workType = {
    id: 'meeting-brief',
    name: 'Meeting Brief',
    description: 'Prepare a brief from available context.',
    status: 'active',
    allowedTargetKinds: ['workspace', 'browser']
  };
  const workTypeSnapshot = { ...workType, capturedAt: now };
  writeJson('work-types.json', [workType]);
  const browserTarget = {
    id: BROWSER_TARGET_ID,
    name: 'Page Render Browser',
    status: 'active',
    allowedOrigins: ['https://example.com'],
    startUrl: 'https://example.com/start',
    limits: {
      maxNavigationsPerRun: 4,
      maxActionsPerRun: 8,
      navTimeoutMs: 10000,
      waitTimeoutMsCap: 1000,
      maxPageTextBytes: 4096,
      maxScreenshotsPerRun: 2
    }
  };
  writeJson('browser-targets.json', [browserTarget]);
  const workflows = readJson('workflows.json');
  const verificationWorkflow = {
    id: 'page-render-verified-note',
    name: 'Page Render Verified Note',
    version: '1',
    enabled: true,
    inputSchema: { path: 'string', content: 'string' },
    actions: [
      { id: 'done', action: 'stop', input: { result: { written: true } } }
    ],
    postconditions: [
      { id: 'note-exists', type: 'fileExists', path: '{{workflow.input.path}}' },
      { id: 'note-contains', type: 'fileContains', path: '{{workflow.input.path}}', contains: '{{workflow.input.content}}' }
    ],
    createdAt: now,
    updatedAt: now
  };
  if (!workflows.some(item => item.id === verificationWorkflow.id)) {
    writeJson('workflows.json', [...workflows, verificationWorkflow]);
  }
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
    acceptanceCriteria: 'Page renders without errors and shows the example heading.',
    assignmentTargetType: 'agent',
    assignmentTargetId: agent.id,
    assignmentMode: 'individual',
    workTypeId: workType.id,
    workTypeSnapshot,
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
    workTypeId: workType.id,
    workTypeSnapshot,
    acceptanceCriteriaSnapshot: ticket.acceptanceCriteria,
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
      workTypeId: workType.id,
      workTypeSnapshot,
      workTypeSnapshotSource: 'ticket_snapshot',
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
  const activeTicket = {
    ...ticket,
    id: ticketId + 1,
    objective: 'page render active ticket',
    status: 'in_progress',
    updatedAt: new Date(Date.now() + 1000).toISOString()
  };
  const activeRun = {
    ...run,
    id: runId + 1,
    ticketId: activeTicket.id,
    status: 'running',
    ticketOpenedAt: activeTicket.updatedAt,
    updatedAt: activeTicket.updatedAt,
    completedAt: null,
    replaySnapshot: {
      ...run.replaySnapshot,
      runId: runId + 1,
      ticketId: activeTicket.id,
      ticketObjectiveSnapshot: activeTicket.objective,
      parsedModelPlans: [{ message: 'Writing file...', actions: [], complete: false, step: 0 }],
      events: [],
      terminalStatus: null,
      finalizedAt: null
    }
  };
  const activeLog = {
    ...log,
    id: log.id + 100,
    timestamp: activeTicket.updatedAt,
    runId: activeRun.id,
    ticketId: activeTicket.id,
    type: 'workspace:write',
    message: 'Writing file...'
  };

  const extraTickets = Array.from({ length: 3 }, (_, index) => ({
    ...ticket,
    id: ticketId + index + 2,
    objective: `page render extra ticket ${index + 1}`,
    updatedAt: new Date(Date.now() - index - 1000).toISOString(),
    ...(index === 0 ? { workTypeId: null, workTypeSnapshot: null, acceptanceCriteria: null } : {})
  }));

  const browserTicket = {
    ...ticket,
    id: ticketId + 5,
    objective: 'Inspect the allowed example page and capture read-only evidence',
    targetRef: { kind: 'browser', browserTargetId: browserTarget.id },
    updatedAt: new Date(Date.now() + 2000).toISOString()
  };
  const browserRun = {
    ...run,
    id: runId + 2,
    ticketId: browserTicket.id,
    targetRef: browserTicket.targetRef,
    browserTargetSnapshot: browserTarget,
    replaySnapshot: {
      ...run.replaySnapshot,
      runId: runId + 2,
      ticketId: browserTicket.id,
      ticketObjectiveSnapshot: browserTicket.objective,
      browserTargetSnapshot: browserTarget,
      primitiveContract: { allowedOperations: ['navigate', 'observe', 'readPageText', 'screenshot', 'wait'] },
      browserOperations: [
        {
          operation: { operation: 'navigate', args: { url: 'https://example.com/start' } },
          status: 'ok',
          durationMs: 21,
          targetResourceId: 'https://example.com/final',
          receipt: {
            resourceUrl: 'https://example.com/final', truncated: false,
            metadata: { requestedUrl: 'https://example.com/start', finalUrl: 'https://example.com/final', status: 200, pageStateHash: 'page-state-hash' }
          }
        },
        {
          operation: { operation: 'readPageText', args: {} },
          status: 'ok', durationMs: 8, targetResourceId: 'https://example.com/final',
          receipt: { resourceUrl: 'https://example.com/final', truncated: true, metadata: { contentHash: 'content-hash', pageStateHash: 'text-page-hash', bytes: 4096, fullBytes: 9000 } }
        },
        {
          operation: { operation: 'screenshot', args: {} },
          status: 'ok', durationMs: 15, targetResourceId: 'https://example.com/final',
          receipt: { resourceUrl: 'https://example.com/final', truncated: false, metadata: { artifactPath: 'browser-artifacts/run-fixture/step-2-1.png', sha256: 'fixture-screenshot-sha256', pageStateHash: 'screenshot-page-hash' } }
        },
        {
          operation: { operation: 'navigate', args: { url: 'https://blocked.example/' } },
          status: 'refused', errorCode: 'BROWSER_ORIGIN_BLOCKED', error: 'Browser origin is not allowed', durationMs: 1,
          targetResourceId: 'https://blocked.example/',
          receipt: { resourceUrl: 'https://blocked.example/', truncated: false, metadata: { status: 'refused', code: 'BROWSER_ORIGIN_BLOCKED' } }
        }
      ],
      terminalStatus: 'completed'
    }
  };

  const runWithoutAcceptanceCriteriaSnapshot = {
    ...run,
    id: runId + 3,
    ticketId: extraTickets[0].id,
    workTypeId: null,
    workTypeSnapshot: null,
    acceptanceCriteriaSnapshot: null,
    replaySnapshot: {
      ...run.replaySnapshot,
      runId: runId + 3,
      ticketId: extraTickets[0].id,
      workTypeId: null,
      workTypeSnapshot: null
    }
  };

  const verifiedTicketId = ticketId + 6;
  const verifiedRunId = runId + 4;
  const verificationContractSnapshot = {
    workflowId: verificationWorkflow.id,
    workflowName: verificationWorkflow.name,
    workflowVersion: verificationWorkflow.version,
    postconditions: verificationWorkflow.postconditions,
    verifierContract: null,
    capturedAt: now
  };
  const verifiedTicket = {
    id: verifiedTicketId,
    objective: 'verified note fixture',
    assignmentTargetType: 'agent',
    assignmentTargetId: agent.id,
    assignmentMode: 'individual',
    workTypeId: workType.id,
    workTypeSnapshot,
    capabilityType: 'workflow',
    executionMode: 'workflow',
    workflowId: verificationWorkflow.id,
    status: 'completed',
    createdBy: 'admin',
    createdAt: now,
    updatedAt: now
  };
  const verifiedRun = {
    ...run,
    id: verifiedRunId,
    ticketId: verifiedTicketId,
    capabilityType: 'workflow',
    executionMode: 'workflow',
    workflowId: verificationWorkflow.id,
    verificationContractSnapshot,
    replaySnapshot: {
      ...run.replaySnapshot,
      runId: verifiedRunId,
      ticketId: verifiedTicketId,
      ticketObjectiveSnapshot: verifiedTicket.objective,
      terminalStatus: 'completed'
    }
  };
  const postconditionsCheckedEvent = {
    type: 'run.postconditions_checked',
    ticketId: verifiedTicketId,
    runId: verifiedRunId,
    seq: 1,
    ts: now,
    payload: {
      workflowId: verificationWorkflow.id,
      contractSource: 'run_snapshot',
      status: 'failed',
      passed: 1,
      failed: 1,
      total: 2,
      results: [
        {
          id: 'note-exists',
          type: 'fileExists',
          passed: true,
          expected: { path: '{{workflow.input.path}}', exists: true, type: 'file' },
          actual: { exists: true, type: 'file' }
        },
        {
          id: 'note-contains',
          type: 'fileContains',
          passed: false,
          expected: { path: '{{workflow.input.path}}', contains: '{{workflow.input.content}}' },
          actual: { exists: true }
        }
      ]
    }
  };

  writeJson('tickets.json', [...tickets, ticket, activeTicket, ...extraTickets, browserTicket, verifiedTicket]);
  writeJson('runs.json', [...runs, run, activeRun, browserRun, runWithoutAcceptanceCriteriaSnapshot, verifiedRun]);
  writeJson('logs.json', [
    ...logs,
    activeLog,
    ...Array.from({ length: 6 }, (_, index) => ({
      ...log,
      id: log.id + index,
      timestamp: new Date(Date.now() + index).toISOString(),
      message: `Page render fixture log ${index + 1}`
    }))
  ]);
  appendEvent(postconditionsCheckedEvent);
  return { ticket, run, activeTicket, activeRun, browserTarget, browserTicket, browserRun, agent, workType, ticketWithoutAcceptanceCriteria: extraTickets[0], runWithoutAcceptanceCriteriaSnapshot, verifiedRun };
}

function seedAttentionFixture() {
  const agents = readJson('agents.json');
  const tickets = readJson('tickets.json');
  const now = new Date().toISOString();
  const agent = agents[0];
  const ticketId = Math.max(0, ...tickets.map(t => t.id || 0)) + 1;
  const ticket = {
    id: ticketId, objective: 'attention fixture', assignmentTargetType: 'agent',
    assignmentTargetId: agent.id, assignmentMode: 'individual', status: 'failed',
    createdBy: 'admin', createdAt: now, updatedAt: now,
    blockedReason: 'Missing authority grant for /reports/q3',
    triage: { required: true, reasonCode: 'authority.missing_grant', requiredDecision: 'grant_or_rescope',
      summary: 'Objective clarification required', allowedActions: ['grant'], prohibitedActions: [],
      evidenceRefs: ['/reports/q3'], resolvedAt: null }
  };
  writeJson('tickets.json', [...tickets, ticket]);
  return { ticketId };
}

async function assertMainFormRenders(cookie, label) {
  const response = await request('GET', '/', { cookie });
  assert(response.statusCode === 200, `${label}: GET / returned HTTP ${response.statusCode}: ${response.body.slice(0, 240)}`);
  assert(response.body.includes('Create New Ticket'), `${label}: main form heading missing`);
  assert(response.body.includes('Describe the concrete result you want. Avoid vague requests like: &quot;improve the project&quot;'), `${label}: objective guidance missing`);
  assert(response.body.includes('independent additive output'), `${label}: group bounded output guidance missing`);
  assert(response.body.includes('Suggest bounded version'), `${label}: ticket shaping button missing`);
  assert(response.body.includes('/api/tickets/shape-objective'), `${label}: ticket shaping endpoint wiring missing`);
  assert(response.body.includes('Manual folder scopes'), `${label}: manual scope option missing`);
  assert(response.body.includes('Automatic folder scopes'), `${label}: dynamic scope option missing`);
  assert(response.body.includes('const agentGroupMembers = '), `${label}: agentGroupMembers script missing`);
  assert(response.body.includes('value="agent" selected'), `${label}: one-agent path is not the default`);
  assert(response.body.includes('id="executionTargetKind"'), `${label}: execution target selector missing`);
  assert(response.body.includes('id="workTypeId"'), `${label}: Work Type selector missing`);
  assert(response.body.includes('Unspecified'), `${label}: Work Type selector must default to Unspecified`);
  assert(response.body.includes('Meeting Brief'), `${label}: active Work Type option missing`);
  assert(response.body.includes('does not grant target access or operations'), `${label}: Work Type authority boundary missing`);
  assert(response.body.includes('id="acceptanceCriteria"'), `${label}: Acceptance Criteria textarea missing`);
  assert(response.body.includes('Acceptance Criteria'), `${label}: Acceptance Criteria label missing`);
  assert(response.body.includes('Stored for review; not automatically verified'), `${label}: Acceptance Criteria semantic boundary missing`);
  assert(response.body.includes('id="browserTargetId"'), `${label}: browser target selector missing`);
  assert(response.body.includes('Page Render Browser'), `${label}: active browser target missing`);
  assert(response.body.includes('Browser Phase 1 supports only'), `${label}: browser read-only warning missing`);
}

function browserTargetForm(overrides = {}) {
  return {
    id: 'ui-created-browser',
    name: 'UI Created Browser',
    status: 'active',
    allowedOrigins: 'https://ui.example.com',
    startUrl: 'https://ui.example.com/start',
    maxNavigationsPerRun: '3',
    maxActionsPerRun: '7',
    navTimeoutMs: '9000',
    waitTimeoutMsCap: '750',
    maxPageTextBytes: '2048',
    maxScreenshotsPerRun: '2',
    ...overrides
  };
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
    const ticketsIndex = await assertPageRenders(cookie, '/tickets', 'tickets', 'Tickets');
    assert(ticketsIndex.body.includes('Writing file...'), 'tickets page should show real current run output');
    assert(!ticketsIndex.body.includes('ticket-card__output'), 'tickets page should render current output inline with metadata');
    assert(!ticketsIndex.body.includes('>Rerun</button>'), 'tickets page should not show rerun control');
    assert(!ticketsIndex.body.includes('>Retry</button>'), 'tickets page should not show retry control');
    assert(!ticketsIndex.body.includes('data-stop-run-id'), 'tickets page should not show stop controls');
    const activeCardStart = ticketsIndex.body.indexOf('page render active ticket');
    const activeCardEnd = activeCardStart === -1 ? -1 : ticketsIndex.body.indexOf('</div>', ticketsIndex.body.indexOf('ticket-card__meta', activeCardStart));
    const activeCardSnippet = activeCardStart === -1 || activeCardEnd === -1 ? '' : ticketsIndex.body.slice(activeCardStart, activeCardEnd + 6);
    assert(activeCardSnippet && !activeCardSnippet.includes('ticket-card__actions'), 'running ticket card should not render an empty action footer');
    const closeActive = await request('PATCH', `/api/tickets/${fixture.activeTicket.id}/status`, {
      cookie,
      body: { status: 'closed' }
    });
    assert(closeActive.statusCode === 200, `closing active ticket returned HTTP ${closeActive.statusCode}`);
    const interruptedRun = readJson('runs.json').find(run => run.id === fixture.activeRun.id);
    assert(interruptedRun && interruptedRun.status === 'interrupted', 'closing ticket from dropdown should interrupt active run');
    const ticketsPage = await assertPageRenders(cookie, '/tickets?limit=1', 'paginated tickets', 'Showing 1-1 of');
    assert((ticketsPage.body.match(/class="ticket-card /g) || []).length === 1, 'tickets page should render only the requested page size');
    const ticketsApi = await request('GET', '/api/tickets?limit=1', { cookie });
    assert(ticketsApi.statusCode === 200, `tickets API returned HTTP ${ticketsApi.statusCode}`);
    const ticketsPayload = JSON.parse(ticketsApi.body);
    assert(ticketsPayload.tickets.length === 1, 'tickets API should return requested page size');
    assert(ticketsPayload.pagination && ticketsPayload.pagination.total >= 4, 'tickets API should include pagination total');
    const ticketDetail = await assertPageRenders(cookie, `/tickets/${fixture.ticket.id}`, 'ticket detail', 'Runs &amp; attempts');
    assert(ticketDetail.body.includes('>At a glance<'), 'ticket detail should render Zone 1 eyebrow');
    assert(ticketDetail.body.includes('>Needs your attention<') || ticketDetail.body.includes('data-attn-zone'), 'ticket detail should support Zone 2 attention');
    assert(ticketDetail.body.includes('>How it&#39;s set up<') || ticketDetail.body.includes("How it's set up"), 'ticket detail should render Zone 3 eyebrow');
    assert(ticketDetail.body.includes('>What has happened<'), 'ticket detail should render Zone 4 eyebrow');
    assert(ticketDetail.body.includes('id="ticket-runtime-section"'), 'hero must keep the live runtime container id');
    assert(ticketDetail.body.includes('id="ticket-live-status"'), 'hero must keep the live status id');
    assert(!ticketDetail.body.includes('>Execution State<'), 'standalone Execution State heading should be gone (merged into hero)');
    assert(!ticketDetail.body.includes('>Runtime</h2>'), 'standalone Runtime heading should be gone (merged into hero)');
    // ticket status badge appears once in the hero, not duplicated in a separate Runtime block
    assert((ticketDetail.body.match(/id="ticket-live-status"/g) || []).length === 1, 'live status id must be unique');
    assert(ticketDetail.body.includes('Assignment &amp; work split') || ticketDetail.body.includes('Assignment & work split'), 'Zone 3 should have an assignment disclosure');
    assert(ticketDetail.body.includes('class="disclosure"'), 'Zone 3 config should use disclosure rows');
    assert(ticketDetail.body.includes('Ticket details'), 'Zone 3 should keep ticket metadata');
    assert(!ticketDetail.body.includes('>Recent Activity<'), 'Recent Activity section should be removed (folded into Timeline)');
    assert(!ticketDetail.body.includes('>Execution Attempts'), 'Execution Attempts should be merged into the Runs table');
    assert(ticketDetail.body.includes('Runs &amp; attempts') || ticketDetail.body.includes('Runs & attempts'), 'Zone 4 should have a merged runs/attempts table');
    assert(!ticketDetail.body.includes('<th>Work Unit</th>'), 'single-agent ticket detail should not show group-only work unit column');
    assert(ticketDetail.body.includes('Work Type'), 'ticket detail should show Work Type section');
    assert(ticketDetail.body.includes(fixture.workType.name), 'ticket detail should show Work Type snapshot name');
    assert(ticketDetail.body.includes('does not grant authority or operations'), 'ticket detail should state Work Type authority boundary');
    assert(ticketDetail.body.includes('Acceptance Criteria'), 'ticket detail should show Acceptance Criteria section');
    assert(ticketDetail.body.includes(fixture.ticket.acceptanceCriteria), 'ticket detail should show declared acceptance criteria');
    assert(ticketDetail.body.includes('Stored for review; not automatically verified'), 'ticket detail should state acceptance criteria boundary');
    const ticketWithoutAcceptanceCriteriaPage = await assertPageRenders(cookie, `/tickets/${fixture.ticketWithoutAcceptanceCriteria.id}`, 'ticket without acceptance criteria detail', 'Acceptance Criteria');
    assert(ticketWithoutAcceptanceCriteriaPage.body.includes('Unspecified'), 'ticket without acceptance criteria detail should show an unspecified Work Type');
    assert(ticketWithoutAcceptanceCriteriaPage.body.includes('None declared'), 'ticket without acceptance criteria detail should show none declared for missing acceptance criteria');
    assert(ticketWithoutAcceptanceCriteriaPage.body.includes('Run completed &ne; objective verified') || ticketWithoutAcceptanceCriteriaPage.body.includes('Run completed ≠ objective verified'), 'ticket without acceptance criteria detail should state acceptance criteria boundary');
    const attention = seedAttentionFixture();
    const attnPage = await assertPageRenders(cookie, `/tickets/${attention.ticketId}`, 'attention ticket', 'Needs your attention');
    assert(attnPage.body.includes('class="attn critical"'), 'required triage should render a critical attention card');
    assert(attnPage.body.includes('Missing authority grant for /reports/q3'), 'blocked reason should appear in the attention zone');
    // clean completed ticket with no runs (so reviewStatus/latestTriage/runStateInconsistency
    // never apply — unlike the shared `ticketDetail` run-bearing fixture, whose completed run
    // always trips reviewStatus.needsReview because its objective has no scoreable file path;
    // that's pre-existing Task-1 hasAttention behavior, not a Zone-2 layout concern) has no attention zone
    const cleanTicketPage = await assertPageRenders(cookie, `/tickets/${fixture.ticket.id + 3}`, 'clean ticket', 'At a glance');
    assert(!cleanTicketPage.body.includes('Needs your attention'), 'completed ticket without triage or runs should omit the attention zone');
    const runDetail = await assertPageRenders(cookie, `/runs/${fixture.run.id}`, 'run detail', 'Run Outcome');
    assert(runDetail.body.includes('Recent Activity'), 'run detail should include inline recent activity');
    assert(runDetail.body.includes('<summary>Ticket Objective</summary>'), 'run detail should collapse repeated ticket objective');
    assert(runDetail.body.includes('<summary>Prompt Instructions</summary>'), 'run detail should collapse prompt instructions');
    assert(runDetail.body.includes('Work Type Snapshot'), 'run detail should show immutable Work Type snapshot');
    assert(runDetail.body.includes(fixture.workType.name), 'run detail should show Work Type snapshot name');
    assert(runDetail.body.includes('It is not authority and does not grant operations'), 'run detail should state Work Type authority boundary');
    assert(runDetail.body.includes('Acceptance Criteria Snapshot'), 'run detail should show Acceptance Criteria Snapshot section');
    assert(runDetail.body.includes(fixture.run.acceptanceCriteriaSnapshot), 'run detail should show frozen acceptance criteria snapshot');
    assert(runDetail.body.includes('Frozen at run creation for review'), 'run detail should state acceptance criteria snapshot boundary');
    assert(runDetail.body.includes('Workflow Postconditions'), 'run detail should show Workflow Postconditions section');
    assert(runDetail.body.includes('No workflow postconditions were declared for this run'), 'run detail should show no-postconditions message for runs without a verification contract');
    const verifiedRunDetail = await assertPageRenders(cookie, `/runs/${fixture.verifiedRun.id}`, 'verified workflow run detail', 'Workflow Postconditions');
    assert(verifiedRunDetail.body.includes('Deterministic checks declared by the workflow'), 'verified run detail should explain postconditions are deterministic');
    assert(verifiedRunDetail.body.includes('file exists: {{workflow.input.path}}'), 'verified run detail should render fileExists assertion');
    assert(verifiedRunDetail.body.includes('file {{workflow.input.path}} contains'), 'verified run detail should render fileContains assertion');
    assert(verifiedRunDetail.body.includes('{{workflow.input.content}}'), 'verified run detail should render fileContains expected content');
    assert(verifiedRunDetail.body.includes('passed') && verifiedRunDetail.body.includes('failed'), 'verified run detail should render passed and failed status badges');
    assert(verifiedRunDetail.body.includes('not checked') || verifiedRunDetail.body.includes('passed'), 'verified run detail should render postcondition status');
    assert(verifiedRunDetail.body.includes('Expected:'), 'verified run detail should show expected value for failed postcondition');
    assert(verifiedRunDetail.body.includes('Acceptance Criteria Snapshot'), 'verified run detail should keep acceptance criteria section separate');
    const missingAcceptanceCriteriaSnapshotRunDetail = await assertPageRenders(cookie, `/runs/${fixture.runWithoutAcceptanceCriteriaSnapshot.id}`, 'run without acceptance criteria snapshot detail', 'Acceptance Criteria Snapshot');
    assert(missingAcceptanceCriteriaSnapshotRunDetail.body.includes('No acceptance criteria were captured for this run'), 'run without acceptance criteria snapshot detail should show missing captured criteria wording');
    assert(missingAcceptanceCriteriaSnapshotRunDetail.body.includes('Runs capture acceptance criteria at creation time; this run has no captured criteria'), 'run without acceptance criteria snapshot detail should explain creation-time capture');
    assert(missingAcceptanceCriteriaSnapshotRunDetail.body.includes('Frozen at run creation for review'), 'run without acceptance criteria snapshot detail should state snapshot boundary');
    assert(runDetail.body.includes('Routing decision'), 'run detail should show routing decision section');
    assert(runDetail.body.includes('Routing reason'), 'run detail should show routing reason field');
    assert(runDetail.body.includes('Fallback used'), 'run detail should show fallback status field');
    const browserTicketDetail = await assertPageRenders(cookie, `/tickets/${fixture.browserTicket.id}`, 'browser ticket detail', 'Execution target');
    assert(browserTicketDetail.body.includes(fixture.browserTarget.name), 'browser ticket detail should show target name');
    assert(browserTicketDetail.body.includes(fixture.browserTarget.startUrl), 'browser ticket detail should show start URL');
    assert(browserTicketDetail.body.includes('maxScreenshotsPerRun'), 'browser ticket detail should show configured limits');
    assert(browserTicketDetail.body.includes('No click, fill, press'), 'browser ticket detail should show Phase 1 boundary');
    // Verify no warning when target is active
    assert(!browserTicketDetail.body.includes('Browser target unavailable'), 'active target should not show warning banner');
    const browserRunDetail = await assertPageRenders(cookie, `/runs/${fixture.browserRun.id}`, 'browser run detail', 'Browser Operations (4)');
    assert(browserRunDetail.body.includes('Browser Target Snapshot'), 'browser run detail should show target snapshot');
    assert(browserRunDetail.body.includes('Resource / final URL'), 'browser run detail should show final URL field');
    assert(browserRunDetail.body.includes('BROWSER_ORIGIN_BLOCKED'), 'browser run detail should show refusal code');
    assert(browserRunDetail.body.includes('fixture-screenshot-sha256'), 'browser run detail should show screenshot hash');
    assert(browserRunDetail.body.includes('browser-artifacts/run-fixture/step-2-1.png'), 'browser run detail should show screenshot artifact path');
    assert(browserRunDetail.body.includes('Screenshot artifacts remain server-side'), 'browser run detail should explain path-only artifact access');
    assert(browserRunDetail.body.includes('Routing decision'), 'browser run detail should show routing decision section');
    assert(browserRunDetail.body.includes('Provider'), 'browser run detail should show routing provider');
    assert(browserRunDetail.body.includes('Model'), 'browser run detail should show routing model');

    // Inactive browser target warning renders on ticket detail
    const deactivateForWarning = await request('POST', `/admin/browser-targets/${fixture.browserTarget.id}/status`, {
      cookie, form: { status: 'inactive' }
    });
    assert(deactivateForWarning.statusCode === 302, `deactivate browser target returned HTTP ${deactivateForWarning.statusCode}`);
    const inactiveWarningPage = await assertPageRenders(cookie, `/tickets/${fixture.browserTicket.id}`, 'browser ticket detail with inactive target', 'Browser target unavailable');
    assert(inactiveWarningPage.body.includes('no longer active'), 'inactive target should show warning about target unavailability');
    const reactivateForWarning = await request('POST', `/admin/browser-targets/${fixture.browserTarget.id}/status`, {
      cookie, form: { status: 'active' }
    });
    assert(reactivateForWarning.statusCode === 302, `reactivate browser target returned HTTP ${reactivateForWarning.statusCode}`);
    const reactivatedWarningPage = await request('GET', `/tickets/${fixture.browserTicket.id}`, { cookie });
    assert(reactivatedWarningPage.statusCode === 200, `browser ticket detail after reactivation returned HTTP ${reactivatedWarningPage.statusCode}`);
    assert(!reactivatedWarningPage.body.includes('no longer active'), 'reactivated target should not show warning');

    const browserTicketCreate = await request('POST', '/tickets', {
      cookie,
      form: {
        objective: 'improve things',
        capabilityType: 'directAction',
        executionTargetKind: 'browser',
        browserTargetId: fixture.browserTarget.id,
        assignmentTargetType: 'agent',
        assignmentTargetId: String(fixture.agent.id),
        assignmentMode: 'individual'
      }
    });
    assert(browserTicketCreate.statusCode === 302, `browser ticket form returned HTTP ${browserTicketCreate.statusCode}: ${browserTicketCreate.body}`);
    const createdBrowserTicket = readJson('tickets.json').slice().sort((a, b) => b.id - a.id)[0];
    assert(createdBrowserTicket.targetRef && createdBrowserTicket.targetRef.kind === 'browser', 'browser ticket form did not create browser targetRef');
    assert(createdBrowserTicket.targetRef.browserTargetId === fixture.browserTarget.id, 'browser ticket form stored the wrong browserTargetId');
    assert(createdBrowserTicket.acceptanceCriteria === null, 'ticket form should default missing acceptance criteria to null');

    await assertPageRenders(cookie, '/admin', 'admin dashboard', 'Admin Dashboard');
    const browserTargetsPage = await assertPageRenders(cookie, '/admin/browser-targets', 'browser targets admin', 'Browser Targets');
    assert(browserTargetsPage.body.includes(fixture.browserTarget.id), 'browser targets admin should list target id');
    assert(browserTargetsPage.body.includes('Browser Runtime'), 'browser targets admin should show engine status');
    assert(browserTargetsPage.body.includes('Runtime available'), 'browser targets admin should show runtime availability');
    assert(browserTargetsPage.body.includes('Engine version'), 'browser targets admin should show engine version status');
    assert(browserTargetsPage.body.includes('No click, fill, press'), 'browser targets admin should show Phase 1 boundary');

    const wildcardTarget = await request('POST', '/admin/browser-targets', {
      cookie,
      form: browserTargetForm({ id: 'wildcard-target', allowedOrigins: 'https://*.example.com', startUrl: 'https://example.com' })
    });
    assert(wildcardTarget.statusCode === 400 && wildcardTarget.body.includes('exact HTTP(S) origin'), 'browser target admin should reject wildcard origins');
    const outsideStart = await request('POST', '/admin/browser-targets', {
      cookie,
      form: browserTargetForm({ id: 'outside-start', startUrl: 'https://outside.example.com/' })
    });
    assert(outsideStart.statusCode === 400 && outsideStart.body.includes('inside an allowed origin'), 'browser target admin should reject an out-of-origin start URL');
    const credentialLikeStart = await request('POST', '/admin/browser-targets', {
      cookie,
      form: browserTargetForm({ id: 'credential-like-start', startUrl: 'https://ui.example.com/start?token=must-not-persist' })
    });
    assert(credentialLikeStart.statusCode === 400 && credentialLikeStart.body.includes('query parameters'), 'browser target admin should reject start URL query credentials');
    const invalidLimit = await request('POST', '/admin/browser-targets', {
      cookie,
      form: browserTargetForm({ id: 'invalid-limit', maxActionsPerRun: '0' })
    });
    assert(invalidLimit.statusCode === 400 && invalidLimit.body.includes('positive integer'), 'browser target admin should reject non-positive limits');
    const forbiddenCapability = await request('POST', '/admin/browser-targets', {
      cookie,
      form: browserTargetForm({ id: 'forbidden-capability', credentials: 'must-not-persist' })
    });
    assert(forbiddenCapability.statusCode === 400 && forbiddenCapability.body.includes('not supported in Phase 1'), 'browser target admin should reject Phase 2 fields');

    const createBrowserTarget = await request('POST', '/admin/browser-targets', { cookie, form: browserTargetForm() });
    assert(createBrowserTarget.statusCode === 302, `browser target create returned HTTP ${createBrowserTarget.statusCode}: ${createBrowserTarget.body}`);
    const editBrowserTarget = await request('POST', '/admin/browser-targets/ui-created-browser', {
      cookie,
      form: browserTargetForm({ name: 'UI Browser Updated' })
    });
    assert(editBrowserTarget.statusCode === 302, `browser target edit returned HTTP ${editBrowserTarget.statusCode}: ${editBrowserTarget.body}`);
    const deactivateBrowserTarget = await request('POST', '/admin/browser-targets/ui-created-browser/status', {
      cookie, form: { status: 'inactive' }
    });
    assert(deactivateBrowserTarget.statusCode === 302, `browser target deactivate returned HTTP ${deactivateBrowserTarget.statusCode}`);
    assert(readJson('browser-targets.json').find(target => target.id === 'ui-created-browser').status === 'inactive', 'browser target was not deactivated');
    const reactivateBrowserTarget = await request('POST', '/admin/browser-targets/ui-created-browser/status', {
      cookie, form: { status: 'active' }
    });
    assert(reactivateBrowserTarget.statusCode === 302, `browser target reactivate returned HTTP ${reactivateBrowserTarget.statusCode}`);
    const managedTarget = readJson('browser-targets.json').find(target => target.id === 'ui-created-browser');
    assert(managedTarget && managedTarget.name === 'UI Browser Updated' && managedTarget.status === 'active', 'browser target create/edit/reactivate state is incorrect');
    assert(!JSON.stringify(readJson('browser-targets.json')).includes('must-not-persist'), 'browser target admin persisted forbidden credential data');

    const workflowsPage = await assertPageRenders(cookie, '/admin/workflows', 'workflow capabilities admin', 'Workflow Capabilities');
    assert(workflowsPage.body.includes('demo-agent-write-if-approved'), 'workflows admin should list demo workflow');
    assert(workflowsPage.body.includes('Edit JSON'), 'workflows admin should expose JSON editing');
    assert(workflowsPage.body.includes('Postconditions'), 'workflows admin should render Postconditions column header');
    assert(workflowsPage.body.includes('None'), 'workflows admin should show None for workflow without postconditions');
    assert(workflowsPage.body.includes('legal-intake'), 'workflows admin should list legal-intake workflow with postconditions');
    assert(workflowsPage.body.includes('file exists: {{workflow.input.basePath}}/intake-register.csv'), 'workflows admin should render fileExists assertion for legal-intake workflow');
    assert(workflowsPage.body.includes('file {{workflow.input.basePath}}/intake-register.csv contains'), 'workflows admin should render fileContains assertion for legal-intake workflow');
    const workflowFormPage = await assertPageRenders(cookie, '/admin/workflows/demo-agent-write-if-approved/edit', 'workflow edit', 'Edit Workflow');
    assert(workflowFormPage.body.includes('agentStructuredOutput'), 'workflow edit should render workflow JSON');
    const actionsPage = await assertPageRenders(cookie, '/admin/actions', 'actions catalog', 'Actions Catalog');
    assert(actionsPage.body.includes('listDirectory'), 'actions catalog should list listDirectory');
    assert(actionsPage.body.includes('writeFile'), 'actions catalog should list writeFile');
    assert(actionsPage.body.includes('Agent Structured Output'), 'actions catalog should list structured output');
    assert(actionsPage.body.includes('Condition'), 'actions catalog should list condition');
    assert(actionsPage.body.includes('Stop'), 'actions catalog should list workflow stop');
    assert(!actionsPage.body.includes('Provider/Model Call'), 'actions catalog should not list provider/model capability');
    assert(!actionsPage.body.includes('Stop / Interruption'), 'actions catalog should not list operator interruption');
    assert(!actionsPage.body.includes('Ticket Shaping'), 'actions catalog should not list ticket shaping');
    assert(!actionsPage.body.includes('Retry / Rerun'), 'actions catalog should not list retry/rerun');
    assert(!actionsPage.body.includes('Recovery'), 'actions catalog should not list recovery');
    assert(!actionsPage.body.includes('Operator: Write File'), 'actions catalog should not list operator write file');
    assert(!actionsPage.body.includes('Invoke Workflow'), 'actions catalog should not list agent workflow invocation');
    assert(actionsPage.body.includes('Actions Catalog'), 'actions catalog page heading should render');
    assert(actionsPage.body.includes('agent'), 'actions catalog should include agent invoker');
    assert(actionsPage.body.includes('Contract'), 'actions catalog should have expandable contract');
    assert(actionsPage.body.includes('Input'), 'actions catalog should label input shape');
    assert(actionsPage.body.includes('Output'), 'actions catalog should label output shape');
    assert(actionsPage.body.includes('Error'), 'actions catalog should label error shape');
    assert(!actionsPage.body.includes('<th>Category</th>'), 'actions catalog should not show category column');
    assert(!actionsPage.body.includes('<th>Type</th>'), 'actions catalog should not show type column');
    assert(!actionsPage.body.includes('>Request</div>'), 'actions catalog should not show request envelope');
    assert(!actionsPage.body.includes('Normalized input schema'), 'actions catalog should not expose normalized input label');
    assert(!actionsPage.body.includes('Authority:'), 'actions catalog should not show authority constraint');
    assert(!actionsPage.body.includes('Provenance:'), 'actions catalog should not show provenance surface');
    assert(!actionsPage.body.includes('Executable:'), 'actions catalog should not show executable flag');

    writeJson('groups.json', readJson('groups.json').map(group => ({ ...group, canReceiveTickets: false })));
    writeJson('memberships.json', readJson('memberships.json').filter(membership => membership.principalType !== 'agent'));
    await assertMainFormRenders(cookie, 'no ticket-capable groups');

    console.log(JSON.stringify({
      mainFormRender: true,
      noTicketCapableGroupsRender: true,
      browserTargetsAdminRender: true,
      browserTicketTargetRef: true,
      browserTicketDetailRender: true,
      browserRunEvidenceRender: true,
      browserTargetValidation: true,
      browserTargetWarningRender: true,
      browserTargetRerunGuard: true,
      routingDecisionRender: true
    }));
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

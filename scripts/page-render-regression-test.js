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
    updatedAt: new Date(Date.now() - index - 1000).toISOString()
  }));

  writeJson('tickets.json', [...tickets, ticket, activeTicket, ...extraTickets]);
  writeJson('runs.json', [...runs, run, activeRun]);
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
  return { ticket, run, activeTicket, activeRun };
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
    const attention = seedAttentionFixture();
    const attnPage = await assertPageRenders(cookie, `/tickets/${attention.ticketId}`, 'attention ticket', 'Needs your attention');
    assert(attnPage.body.includes('class="attn critical"'), 'required triage should render a critical attention card');
    assert(attnPage.body.includes('Missing authority grant for /reports/q3'), 'blocked reason should appear in the attention zone');
    // clean completed ticket with no runs (so reviewStatus/latestTriage/runStateInconsistency
    // never apply — unlike the shared `ticketDetail` run-bearing fixture, whose completed run
    // always trips reviewStatus.needsReview because its objective has no scoreable file path;
    // that's pre-existing Task-1 hasAttention behavior, not a Zone-2 layout concern) has no attention zone
    const cleanTicketPage = await assertPageRenders(cookie, `/tickets/${fixture.ticket.id + 2}`, 'clean ticket', 'At a glance');
    assert(!cleanTicketPage.body.includes('Needs your attention'), 'completed ticket without triage or runs should omit the attention zone');
    const runDetail = await assertPageRenders(cookie, `/runs/${fixture.run.id}`, 'run detail', 'Run Outcome');
    assert(runDetail.body.includes('>At a glance<'), 'run detail should render Zone 1 eyebrow');
    assert(runDetail.body.includes("How it's set up") || runDetail.body.includes('>How it&#39;s set up<'), 'run detail should render Zone 3 eyebrow');
    assert(runDetail.body.includes('>What has happened<'), 'run detail should render Zone 4 eyebrow');
    assert(runDetail.body.includes('id="run-live-status"'), 'hero must keep the live status id');
    assert((runDetail.body.match(/id="run-live-status"/g) || []).length === 1, 'live status id must be unique');
    assert(!runDetail.body.includes('>Run Summary</h2>'), 'standalone Run Summary heading should be merged into the hero');
    assert(runDetail.body.includes('Run Outcome'), 'hero must still expose Run Outcome');
    assert(!runDetail.body.includes('>Recent Activity<'), 'Recent Activity should be removed from run detail (duplicates Events)');
    assert(runDetail.body.includes('class="evidence-group"'), 'Zone 4 should have a collapsed developer-evidence group');
    assert(runDetail.body.includes('id="replay-workspace-actions"'), 'Workspace Actions (jump target) must remain present');
    assert(runDetail.body.includes('<summary>Prompt Instructions</summary>'), 'deep replay content stays reachable in the evidence group');
    assert(runDetail.body.includes('<summary>Ticket Objective</summary>'), 'run detail should collapse repeated ticket objective');
    assert(runDetail.body.includes('<summary>Prompt Instructions</summary>'), 'run detail should collapse prompt instructions');
    assert(runDetail.body.includes('class="attn'), 'run detail attention items should render as .attn cards');
    assert(!runDetail.body.includes('<section class="detail-section failure-summary">'), 'Failure Summary should be an attention card, not a standalone detail-section');
    // "Why this run stopped" is gated to abnormal completions (failed/interrupted/capped/timed-out).
    // The regression fixture run is a clean 'completed' run, so the card must be absent for it.
    assert(!runDetail.body.includes('Why this run stopped</h3>'), 'completed fixture run should not show the abnormal-only "Why this run stopped" card');
    assert((runDetail.body.match(/State Warning<\/h3>/g) || []).length <= 1, 'State Warning should appear at most once');
    assert((runDetail.body.match(/Failure Summary<\/h3>/g) || []).length <= 1, 'Failure Summary should appear at most once');
    const attnZoneIdx = runDetail.body.indexOf('data-attn-zone');
    const zone3Idx = runDetail.body.indexOf("How it's set up");
    assert(zone3Idx !== -1 && (attnZoneIdx === -1 || attnZoneIdx < zone3Idx), 'Zone 2 attention header, when present, should render before Zone 3');
    assert(runDetail.body.includes('<summary>Execution policy snapshot'), 'Zone 3 should present execution policy in a disclosure');
    assert(runDetail.body.includes('<summary>Authority &amp; scope') || runDetail.body.includes('<summary>Authority &amp; Scope'), 'Zone 3 should present authority & scope in a disclosure');
    assert(runDetail.body.includes('<summary>Run context') || runDetail.body.includes('<summary>Run Context'), 'Zone 3 should present run context in an open disclosure');
    assert(runDetail.body.includes('<summary>Usage / attempt') || runDetail.body.includes('<summary>Usage / Attempt'), 'Zone 3 should present usage/attempt in a disclosure');
    assert(runDetail.body.includes('<summary>Runtime limits'), 'Zone 3 should present runtime limits in a disclosure');
    assert((runDetail.body.match(/Execution policy snapshot/gi) || []).length === 1, 'Execution policy snapshot should appear exactly once (moved, not duplicated)');
    assert((runDetail.body.match(/Authority (?:&amp;|&) [Ss]cope/g) || []).length === 1, 'Authority & scope should appear exactly once (moved, not duplicated)');
    assert(!runDetail.body.includes('id="run-zone-carry-config"'), 'run-zone-carry-config carry div should be removed after folding into Run context disclosure');
    await assertPageRenders(cookie, '/admin', 'admin dashboard', 'Admin Dashboard');
    const workflowsPage = await assertPageRenders(cookie, '/admin/workflows', 'workflow capabilities admin', 'Workflow Capabilities');
    assert(workflowsPage.body.includes('demo-agent-write-if-approved'), 'workflows admin should list demo workflow');
    assert(workflowsPage.body.includes('Edit JSON'), 'workflows admin should expose JSON editing');
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

const fastify = require('fastify')({ logger: false });
const path = require('path');
const fs = require('fs');
const argon2 = require('argon2');
const crypto = require('crypto');
require('dotenv').config()

const PORT = process.env.PORT || 3099;

// Data file paths
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}
const DATA_FILE = path.join(DATA_DIR, 'tickets.json');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const AGENTS_FILE = path.join(DATA_DIR, 'agents.json');
const GROUPS_FILE = path.join(DATA_DIR, 'groups.json');
const PERMISSIONS_FILE = path.join(DATA_DIR, 'permissions.json');
const MEMBERSHIPS_FILE = path.join(DATA_DIR, 'memberships.json');
const RUNS_FILE = path.join(DATA_DIR, 'runs.json');
const LOGS_FILE = path.join(DATA_DIR, 'logs.json');
const ALLOCATION_PLANS_FILE = path.join(DATA_DIR, 'allocation-plans.json');
const OPERATION_HISTORY_FILE = path.join(DATA_DIR, 'operation-history.json');
const REPLAY_SNAPSHOTS_DIR = path.join(DATA_DIR, 'replay-snapshots');
const PROTECTED_PATHS_FILE = path.join(__dirname, 'config', 'protected-paths.json');
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const PROVIDERS = ['openai', 'ollama'];
const MODELS = ['gpt-5.1', 'gpt-5.1-mini', 'gpt-4.1', 'gpt-4.1-mini'];
const TICKET_STATUSES = ['open', 'in_progress', 'completed', 'failed', 'closed'];
const WORKSPACE_ROOT = path.resolve(process.env.WORKSPACE_ROOT || path.join(__dirname, 'workspace-root'));
const AGENT_ALLOWED_OPERATIONS = ['listDirectory', 'readFile', 'createFolder', 'writeFile', 'renamePath', 'deletePath'];
const AGENT_MUTATING_OPERATIONS = ['createFolder', 'writeFile', 'renamePath', 'deletePath'];
const AGENT_OPERATION_ARGS = {
  listDirectory: ['path'],
  readFile: ['path'],
  createFolder: ['path'],
  writeFile: ['path', 'content'],
  renamePath: ['path', 'nextPath'],
  deletePath: ['path']
};
const MAX_AGENT_ACTIONS_PER_RESPONSE = 8;
const MAX_MUTATING_ACTIONS_PER_RESPONSE = parseInt(process.env.AGENT_MAX_MUTATING_ACTIONS_PER_RESPONSE || '2', 10) || 2;
const DEFAULT_AGENT_RUNTIME_LIMITS = {
  maxExecutionSteps: 4,
  maxWorkspaceOperationsPerRun: 32,
  maxModelRequestsPerRun: 4,
  maxRuntimeDurationMs: 120000
};
const DEFAULT_PROTECTED_WORKSPACE_PATHS = ['.git', '.env', '.env.*', 'node_modules', 'package.json', 'pnpm-lock.yaml'];
const WORKSPACE_FIXTURES = [
  { id: 'empty', name: 'Empty workspace' },
  { id: 'simple-files', name: 'Simple files' },
  { id: 'nested-folders', name: 'Nested folders' },
  { id: 'existing-target-folder', name: 'Existing target folder' },
  { id: 'conflicting-file-names', name: 'Conflicting file names' },
  { id: 'read-only-like', name: 'Read-only-like scenario' },
  { id: 'large-file', name: 'Large-ish file scenario' },
  { id: 'many-small-files', name: 'Many small files scenario' }
];
const AGENT_PRIMITIVE_METADATA = {
  listDirectory: {
    responseShape: { path: 'string', entries: [{ name: 'string', type: 'file', size: 'number', modifiedAt: 'string' }] },
    errorShape: { error: 'string' },
    authorityConstraints: 'Agent workspace scope; protected/sensitive paths blocked',
    provenanceSurface: 'Run replay snapshot workspaceOperations; run log workspace:list'
  },
  readFile: {
    responseShape: { path: 'string', content: 'string' },
    errorShape: { error: 'string' },
    authorityConstraints: 'Agent workspace scope; sensitive application paths blocked',
    provenanceSurface: 'Run replay snapshot workspaceOperations; run log workspace:read'
  },
  createFolder: {
    responseShape: { path: 'string', status: 'created' },
    errorShape: { error: 'string' },
    authorityConstraints: 'Agent workspace scope; allocated ownership required; protected paths blocked',
    provenanceSurface: 'Run replay snapshot workspaceOperations; operation-history; run log workspace:create; recovery preview'
  },
  writeFile: {
    responseShape: { path: 'string', size: 'number' },
    errorShape: { error: 'string' },
    authorityConstraints: 'Agent workspace scope; allocated ownership required; existing protected files blocked',
    provenanceSurface: 'Run replay snapshot workspaceOperations; operation-history; run log workspace:write; recovery preview'
  },
  renamePath: {
    responseShape: { path: 'string', status: 'renamed' },
    errorShape: { error: 'string' },
    authorityConstraints: 'Agent workspace scope; allocated ownership on both source and dest; protected paths blocked',
    provenanceSurface: 'Run replay snapshot workspaceOperations; operation-history; run log workspace:rename; recovery preview'
  },
  deletePath: {
    responseShape: { path: 'string', status: 'deleted' },
    errorShape: { error: 'string' },
    authorityConstraints: 'Agent workspace scope; allocated ownership required; protected paths blocked',
    provenanceSurface: 'Run replay snapshot workspaceOperations; operation-history; run log workspace:delete; recovery preview'
  }
};
const GENERATED_AGENT_ACTIONS = AGENT_ALLOWED_OPERATIONS.map(op => ({
  name: op, category: 'workspace', invoker: 'agent', mutating: AGENT_MUTATING_OPERATIONS.includes(op),
  requestShape: { operation: op, args: Object.fromEntries(AGENT_OPERATION_ARGS[op].map(k => [k, 'string'])) },
  optionalShape: null,
  ...AGENT_PRIMITIVE_METADATA[op]
}));
const ACTIONS_CATALOG = [
  ...GENERATED_AGENT_ACTIONS,
  {
    name: 'providerModelCall', displayName: 'Provider/Model Call', category: 'provider', invoker: 'agent', mutating: false,
    requestShape: { model: 'string', input: [{ role: 'system', content: 'string' }], text: { format: { type: 'json_object' } } },
    optionalShape: null,
    responseShape: { text: 'string', usage: { promptTokens: 'number', completionTokens: 'number' }, provider: 'string', model: 'string' },
    errorShape: { error: 'string' },
    authorityConstraints: 'Agent-scoped API key; OpenAI or Ollama provider; model constrained by agent config; no shell/network access outside LLM API',
    provenanceSurface: 'Run replay snapshot providerRequests and modelResponses; run log model:request'
  },
  {
    name: 'ticketShaping', displayName: 'Ticket Shaping', category: 'provider', invoker: 'operator', mutating: false,
    requestShape: { objective: 'string', assignmentTargetType: 'string', assignmentMode: 'string' },
    optionalShape: null,
    responseShape: { suggestedObjective: 'string', expectedOutputs: ['string'], decomposition: ['string'], warnings: ['string'], tooBroadForOneRun: 'boolean', groupModeFit: 'string', providerRequestId: 'string', usage: {} },
    errorShape: { error: 'string' },
    authorityConstraints: 'Requires ticket:create permission; uses agent-scoped OpenAI call; no execution side effects',
    provenanceSurface: 'HTTP response; system log ticket:shaped; no replay snapshot (pre-execution)'
  },
  {
    name: 'retryRerun', displayName: 'Retry / Rerun', category: 'operator', invoker: 'operator', mutating: true,
    requestShape: null, optionalShape: null,
    responseShape: { ticket: {} },
    errorShape: { error: 'string' },
    authorityConstraints: 'Requires ticket:update permission; only failed/interrupted runs; allocation constraints re-checked',
    provenanceSurface: 'System log ticket:rerun; run log run:interrupted; old run replay snapshot finalized as interrupted'
  },
  {
    name: 'stopInterruption', displayName: 'Stop / Interruption', category: 'operator', invoker: 'operator', mutating: true,
    requestShape: null, optionalShape: null,
    responseShape: { run: {} },
    errorShape: { error: 'string' },
    authorityConstraints: 'Requires ticket:update permission; only pending or running runs; triggers replay snapshot finalization',
    provenanceSurface: 'Run replay snapshot finalized as interrupted; run log run:interrupted; system log'
  },
  {
    name: 'operatorWorkspaceCreateFile', displayName: 'Operator: Create File', category: 'operator', invoker: 'operator', mutating: true,
    requestShape: { path: 'string' }, optionalShape: null,
    responseShape: { path: 'string' },
    errorShape: { error: 'string' },
    authorityConstraints: 'Requires workspace:write permission; bypasses agent scope checks; allows hidden paths',
    provenanceSurface: 'System log workspace:operator_mutation with pre/post state capture'
  },
  {
    name: 'operatorWorkspaceCreateFolder', displayName: 'Operator: Create Folder', category: 'operator', invoker: 'operator', mutating: true,
    requestShape: { path: 'string' }, optionalShape: null,
    responseShape: { path: 'string', status: 'created' },
    errorShape: { error: 'string' },
    authorityConstraints: 'Requires workspace:write permission; bypasses agent scope checks; allows hidden paths',
    provenanceSurface: 'System log workspace:operator_mutation with pre/post state capture'
  },
  {
    name: 'operatorWorkspaceWriteFile', displayName: 'Operator: Write File', category: 'operator', invoker: 'operator', mutating: true,
    requestShape: { path: 'string', content: 'string' }, optionalShape: null,
    responseShape: { path: 'string', size: 'number' },
    errorShape: { error: 'string' },
    authorityConstraints: 'Requires workspace:write permission; bypasses agent scope checks; allows hidden paths',
    provenanceSurface: 'System log workspace:operator_mutation with pre/post state capture'
  },
  {
    name: 'operatorWorkspaceRenamePath', displayName: 'Operator: Rename', category: 'operator', invoker: 'operator', mutating: true,
    requestShape: { path: 'string', nextPath: 'string' }, optionalShape: null,
    responseShape: { path: 'string', status: 'renamed' },
    errorShape: { error: 'string' },
    authorityConstraints: 'Requires workspace:write permission; bypasses agent scope checks; allows hidden paths',
    provenanceSurface: 'System log workspace:operator_mutation with pre/post state capture'
  },
  {
    name: 'operatorWorkspaceDeletePath', displayName: 'Operator: Delete', category: 'operator', invoker: 'operator', mutating: true,
    requestShape: { path: 'string' }, optionalShape: null,
    responseShape: { path: 'string', status: 'deleted' },
    errorShape: { error: 'string' },
    authorityConstraints: 'Requires workspace:write permission; bypasses agent scope checks; allows hidden paths',
    provenanceSurface: 'System log workspace:operator_mutation with pre/post state capture'
  },
  {
    name: 'workspaceFixtureReset', displayName: 'Workspace Fixture Reset', category: 'workspace', invoker: 'operator', mutating: true,
    requestShape: { fixtureId: 'string' }, optionalShape: null,
    responseShape: { path: 'string', entries: [] },
    errorShape: { error: 'string' },
    authorityConstraints: 'Requires workspace:reset permission; destructive; clears entire workspace root and applies fixture',
    provenanceSurface: 'System log workspace:fixture with pre/post workspace listing'
  },
  {
    name: 'recovery', displayName: 'Recovery', category: 'workspace', invoker: 'operator', mutating: true,
    requestShape: { confirmed: true }, optionalShape: null,
    responseShape: { recovery: { id: 'number', originalId: 'number', operation: 'string', args: {}, preState: {}, restoredState: {} } },
    errorShape: { error: 'string' },
    authorityConstraints: 'Requires ticket:update permission; only recovers failed/interrupted operations; undoes previous mutation',
    provenanceSurface: 'Operation-history record with original and recovery pair; system log workspace:recovery'
  },
  {
    name: 'ticketAssignment', displayName: 'Ticket Assignment', category: 'operator', invoker: 'operator', mutating: true,
    requestShape: { agentId: 'number' }, optionalShape: null,
    responseShape: { ticket: {} },
    errorShape: { error: 'string' },
    authorityConstraints: 'Requires ticket:update permission; only open tickets; triggers maybeStartTicketRuns',
    provenanceSurface: 'Ticket record updated (assignmentTargetType, assignmentTargetId); broadcastTicketChange; system log'
  },
  {
    name: 'ticketStatusUpdate', displayName: 'Ticket Status Update', category: 'operator', invoker: 'operator', mutating: true,
    requestShape: { status: 'string' }, optionalShape: null,
    responseShape: { ticket: {} },
    errorShape: { error: 'string' },
    authorityConstraints: 'Requires ticket:update permission; triggers maybeStartTicketRuns',
    provenanceSurface: 'Ticket record updated; broadcastTicketChange; system log'
  },
  {
    name: 'adminCreateAccount', displayName: 'Admin: Create User/Agent', category: 'operator', invoker: 'operator', mutating: true,
    requestShape: { accountType: 'string', username: 'string', password: 'string', agentName: 'string', model: 'string', apiKey: 'string' },
    optionalShape: { provider: 'string', groupIds: 'string' },
    responseShape: { redirect: 'string' },
    errorShape: { error: 'string' },
    authorityConstraints: 'Requires user:create permission; admin only',
    provenanceSurface: 'Data file updated (users.json / agents.json); system log (user:created / agent:created)'
  },
  {
    name: 'adminUpdateAccount', displayName: 'Admin: Update User/Agent', category: 'operator', invoker: 'operator', mutating: true,
    requestShape: { accountType: 'string' },
    optionalShape: { username: 'string', password: 'string', agentName: 'string', provider: 'string', model: 'string', apiKey: 'string', groupIds: 'string' },
    responseShape: { redirect: 'string' },
    errorShape: { error: 'string' },
    authorityConstraints: 'Requires user:update permission; admin only',
    provenanceSurface: 'Data file updated (users.json / agents.json / memberships.json); system log'
  },
  {
    name: 'adminDeleteAccount', displayName: 'Admin: Delete User/Agent', category: 'operator', invoker: 'operator', mutating: true,
    requestShape: { accountType: 'string' }, optionalShape: null,
    responseShape: { redirect: 'string' },
    errorShape: { error: 'string' },
    authorityConstraints: 'Requires user:delete permission; cannot delete self if user type; admin only',
    provenanceSurface: 'Data file updated (users.json / agents.json); memberships cleaned up; system log'
  },
  {
    name: 'adminCreateGroup', displayName: 'Admin: Create Group', category: 'operator', invoker: 'operator', mutating: true,
    requestShape: { name: 'string' },
    optionalShape: { canReceiveTickets: 'boolean', permissions: ['string'] },
    responseShape: { redirect: 'string' },
    errorShape: { error: 'string' },
    authorityConstraints: 'Requires group:create permission; admin only',
    provenanceSurface: 'Data file updated (groups.json); system log'
  },
  {
    name: 'adminUpdateGroup', displayName: 'Admin: Update Group', category: 'operator', invoker: 'operator', mutating: true,
    requestShape: {},
    optionalShape: { name: 'string', canReceiveTickets: 'boolean', permissions: ['string'] },
    responseShape: { redirect: 'string' },
    errorShape: { error: 'string' },
    authorityConstraints: 'Requires group:update permission; admin only',
    provenanceSurface: 'Data file updated (groups.json); system log'
  },
  {
    name: 'adminDeleteGroup', displayName: 'Admin: Delete Group', category: 'operator', invoker: 'operator', mutating: true,
    requestShape: null, optionalShape: null,
    responseShape: { redirect: 'string' },
    errorShape: { error: 'string' },
    authorityConstraints: 'Requires group:delete permission; group id 1 (Administrators) protected; admin only',
    provenanceSurface: 'Data file updated (groups.json); memberships cleaned up; system log'
  },
  {
    name: 'debugReset', displayName: 'Debug Reset', category: 'system', invoker: 'operator', mutating: true,
    requestShape: { confirmation: 'RESET DEBUG DATA' }, optionalShape: null,
    responseShape: { redirect: 'string' },
    errorShape: { error: 'string' },
    authorityConstraints: 'Requires user:update permission; disabled in NODE_ENV=production; destroys all ticket/run/log/history/workspace data',
    provenanceSurface: 'System log system:reset; all volatile data files emptied; workspace cleared'
  },
  {
    name: 'systemInterruptStaleRuns', displayName: 'System: Interrupt Stale Runs', category: 'system', invoker: 'system', mutating: true,
    requestShape: null, optionalShape: null,
    responseShape: { status: 'interrupted', runs: ['number'] },
    errorShape: { error: 'string' },
    authorityConstraints: 'Automatic on server start; only affects pending/running runs; invokes interruptAgentRun per stale run',
    provenanceSurface: 'Run replay snapshots finalized as interrupted; run logs run:interrupted'
  },
  {
    name: 'systemAutoStartRuns', displayName: 'System: Auto-Start Ticket Runs', category: 'system', invoker: 'system', mutating: true,
    requestShape: null, optionalShape: null,
    responseShape: { runs: [{}] },
    errorShape: { error: 'string' },
    authorityConstraints: 'Triggered by ticket creation, assignment, or status change to open; respects agent group canReceiveTickets; enforces allocation constraints',
    provenanceSurface: 'Run record created; runs.json updated; replay snapshot initialized; run log run:started'
  }
];

const ticketEventClients = new Set();
const logEventClients = new Set();
const runningRunKeys = new Set();
let lastLogTimestampNs = 0n;
let serverReady = false;
let dataVersion = 0;
const pageRenderCache = new Map();
const pageRenderInFlight = new Map();
const PAGE_RENDER_CACHE_TTL_MS = 10000;
const PAGE_RENDER_CACHE_MAX_ENTRIES = 100;

// Register Fastify plugins
fastify.register(require('@fastify/cookie'));
fastify.register(require('@fastify/session'), {
  secret: SESSION_SECRET,
  cookie: {
    secure: false,
    maxAge: 24 * 60 * 60 * 1000
  }
});
fastify.register(require('@fastify/formbody'));

fastify.get('/styles.css', async (request, reply) => {
  reply.type('text/css; charset=utf-8');
  return fs.readFileSync(path.join(__dirname, 'src', 'styles.css'), 'utf8');
});

fastify.get('/health', async (request, reply) => {
  if (!serverReady) {
    reply.code(503);
    return { status: 'starting', ready: false };
  }
  return { status: 'ok', ready: true };
});

fastify.register(require('@fastify/view'), {
  engine: { ejs: require('ejs') },
  root: path.join(__dirname, 'views'),
  layout: 'layout.ejs'
});

fastify.addHook('onRequest', async request => {
  request.routeStartedAtNs = process.hrtime.bigint();
});

fastify.addHook('onSend', async (request, reply, payload) => {
  if (request.routeStartedAtNs) {
    const elapsedMs = Number(process.hrtime.bigint() - request.routeStartedAtNs) / 1e6;
    reply.header('X-Route-Time-Ms', elapsedMs.toFixed(1));
    reply.header('X-Heap-Used-Mb', (process.memoryUsage().heapUsed / 1024 / 1024).toFixed(1));
  }

  return payload;
});

// ==================== DATA HELPERS ====================

const jsonReadCache = new Map();

function nextId(items) {
  return items.length > 0 ? Math.max(...items.map(item => item.id)) + 1 : 1;
}

function readJsonArrayCached(filePath) {
  try {
    const stat = fs.statSync(filePath);
    const cached = jsonReadCache.get(filePath);
    const mtimeNs = stat.mtimeNs !== undefined ? stat.mtimeNs.toString() : String(stat.mtimeMs);

    if (cached && cached.size === stat.size && cached.mtimeNs === mtimeNs) {
      return cached.value;
    }

    const value = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const arrayValue = Array.isArray(value) ? value : [];
    jsonReadCache.set(filePath, { size: stat.size, mtimeNs, value: arrayValue });
    return arrayValue;
  } catch (error) {
    jsonReadCache.delete(filePath);
    return [];
  }
}

function readTickets() {
  return readJsonArrayCached(DATA_FILE);
}

function cachePageRender(key, html) {
  pageRenderCache.set(key, {
    html,
    dataVersion,
    expiresAt: Date.now() + PAGE_RENDER_CACHE_TTL_MS
  });

  if (pageRenderCache.size > PAGE_RENDER_CACHE_MAX_ENTRIES) {
    const oldestKey = pageRenderCache.keys().next().value;
    if (oldestKey) pageRenderCache.delete(oldestKey);
  }
}

async function renderCachedView(request, reply, template, data) {
  if (request.method !== 'GET' || !request.session || !request.session.userId) {
    return reply.view(template, data);
  }

  const key = `${request.session.userId}:${template}:${request.url}`;
  const cached = pageRenderCache.get(key);

  if (cached && cached.dataVersion === dataVersion && cached.expiresAt > Date.now()) {
    reply.header('X-Page-Cache', 'hit');
    reply.type('text/html; charset=utf-8');
    return reply.send(cached.html);
  }

  let renderPromise = pageRenderInFlight.get(key);

  if (!renderPromise) {
    const renderDataVersion = dataVersion;
    renderPromise = reply.viewAsync(template, data)
      .then(html => {
        if (renderDataVersion === dataVersion) cachePageRender(key, html);
        return html;
      })
      .finally(() => {
        pageRenderInFlight.delete(key);
      });
    pageRenderInFlight.set(key, renderPromise);
  }

  const html = await renderPromise;
  reply.header('X-Page-Cache', cached ? 'stale' : 'miss');
  reply.type('text/html; charset=utf-8');
  return reply.send(html);
}

function normalizeTickets(tickets) {
  const seenTicketIds = new Set();

  return tickets.filter(ticket => {
    const ticketId = parseInt(ticket.id, 10);
    const assignmentTargetId = parseInt(ticket.assignmentTargetId, 10);

    if (Number.isNaN(ticketId) || seenTicketIds.has(ticketId)) return false;

    seenTicketIds.add(ticketId);
    ticket.id = ticketId;

    if (!['agent', 'group'].includes(ticket.assignmentTargetType)) {
      ticket.assignmentTargetType = 'agent';
    }

    ticket.assignmentTargetId = Number.isNaN(assignmentTargetId) ? 0 : assignmentTargetId;

    if (ticket.assignmentTargetType === 'agent') {
      ticket.assignmentMode = 'individual';
    } else if (!['allocated', 'dynamic'].includes(ticket.assignmentMode)) {
      ticket.assignmentMode = 'allocated';
    }

    ticket.ownedOutputPaths = (typeof ticket.ownedOutputPaths === 'object' && ticket.ownedOutputPaths !== null && !Array.isArray(ticket.ownedOutputPaths))
      ? ticket.ownedOutputPaths
      : null;

    return true;
  });
}

function writeTickets(tickets) {
  writeFileAtomic(DATA_FILE, JSON.stringify(normalizeTickets(tickets), null, 2));
}

function getTicketsForDisplay() {
  const agents = readAgents();
  const agentGroups = getTicketAssignableGroups();
  const runs = readRuns();
  const history = readOperationHistory();
  const runsByTicketId = groupBy(runs, run => run.ticketId);
  const mutationCountByRunId = buildMutationCountByRunId(history);
  const tickets = readTickets().map(ticket => enrichTicketForDisplay(ticket, {
    agents,
    agentGroups,
    runsByTicketId,
    mutationCountByRunId
  }));

  tickets.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
  return tickets;
}

function enrichTicketForDisplay(ticket, context) {
  const target = ticket.assignmentTargetType === 'agent'
    ? context.agents.find(agent => agent.id === ticket.assignmentTargetId)
    : context.agentGroups.find(group => group.id === ticket.assignmentTargetId);
  const ticketRuns = context.runsByTicketId.get(ticket.id) || [];
  const activeRuns = ticketRuns.filter(run => ['pending', 'running'].includes(run.status));
  const lastRun = ticketRuns
    .slice()
    .sort((a, b) => new Date(b.updatedAt || b.createdAt || 0) - new Date(a.updatedAt || a.createdAt || 0))[0] || null;
  const lastRunPartialMutationCount = lastRun ? (context.mutationCountByRunId.get(lastRun.id) || 0) : 0;

  return {
    ...ticket,
    assignmentTargetName: target ? target.name : 'Unknown target',
    activeRunIds: activeRuns.map(run => run.id),
    lastRunStatus: lastRun ? lastRun.status : null,
    lastRunOperationalOutcome: lastRun ? classifyRunOperationalOutcome(lastRun) : null,
    lastRunPartialMutationCount,
    lastRunHadPartialMutations: lastRunPartialMutationCount > 0
  };
}

function ticketsPageHref(page, limit) {
  const params = new URLSearchParams();
  params.set('page', String(page));
  params.set('limit', String(limit));
  return `/tickets?${params.toString()}`;
}

function getPaginatedTickets(query = {}) {
  const { page, limit } = getPagination(query, 25);
  const allTickets = readTickets()
    .slice()
    .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
  const agents = readAgents();
  const agentGroups = getTicketAssignableGroups();
  const runs = readRuns();
  const history = readOperationHistory();
  const runsByTicketId = groupBy(runs, run => run.ticketId);
  const mutationCountByRunId = buildMutationCountByRunId(history);
  const total = allTickets.length;
  const pageCount = Math.max(1, Math.ceil(total / limit));
  const currentPage = Math.min(page, pageCount);
  const offset = (currentPage - 1) * limit;
  const pageTickets = allTickets
    .slice(offset, offset + limit)
    .map(ticket => enrichTicketForDisplay(ticket, {
      agents,
      agentGroups,
      runsByTicketId,
      mutationCountByRunId
    }));

  return {
    tickets: pageTickets,
    pagination: {
      page: currentPage,
      limit,
      total,
      pageCount,
      start: total === 0 ? 0 : offset + 1,
      end: Math.min(offset + pageTickets.length, total),
      previousHref: currentPage > 1 ? ticketsPageHref(currentPage - 1, limit) : null,
      nextHref: currentPage < pageCount ? ticketsPageHref(currentPage + 1, limit) : null
    }
  };
}

function getRunMutationCount(run) {
  if (run && run.mutationCount !== undefined) return run.mutationCount;
  if (run && run.replaySummary && run.replaySummary.mutationCount !== undefined) return run.replaySummary.mutationCount;
  if (run && run.replaySnapshot && run.replaySnapshot.mutationCount !== undefined) return run.replaySnapshot.mutationCount;
  return run ? countRunMutatingOperations(run.id) : 0;
}

function classifyRunOperationalOutcome(run) {
  if (!run) return null;
  const snapshot = run.replaySnapshot || {};
  const summary = run.replaySummary || extractReplaySummary(snapshot) || {};
  const workspaceOperations = Array.isArray(snapshot.workspaceOperations) ? snapshot.workspaceOperations : [];
  const events = Array.isArray(snapshot.events) ? snapshot.events : [];

  if (summary.hasBlockedOrRejected || workspaceOperations.some(item => item && (item.blocked || item.reason))) return 'blocked/rejected';
  if (run.status === 'interrupted') return 'interrupted';

  if (run.status === 'completed') {
    if (getRunMutationCount(run) > 0) return 'completed_with_mutations';
    if (workspaceOperations.some(item =>
      (item.result && item.result.status === 'not_found') ||
      (item.error && /not_found|enoent/i.test(item.error))
    )) return 'impossible_within_boundary';
    if (summary.hasCompletedNoop || events.some(event => event && event.type === 'run:completed_noop')) return 'completed_noop';
    return 'completed_noop';
  }

  if (run.status === 'failed') return 'failed_execution';
  return run.status || 'unknown';
}

const ALLOWANCE_MAP = {
  allowed_by_op: { allowed: true, type: 'allow', label: 'Operation permitted' },
  allowed_by_budget: { allowed: true, type: 'allow', label: 'Mutating budget available' },
  allowed_noop: { allowed: true, type: 'noop', label: 'No-op (already in desired state)' },
  blocked_sensitive_path: { allowed: false, type: 'block', label: 'Sensitive application path' },
  blocked_protected_path: { allowed: false, type: 'block', label: 'Protected path' },
  blocked_ownership: { allowed: false, type: 'block', label: 'Outside owned scope' },
  blocked_budget: { allowed: false, type: 'block', label: 'Budget exhausted' },
  blocked_unsupported_op: { allowed: false, type: 'block', label: 'Operation not permitted' },
  blocked_malformed: { allowed: false, type: 'block', label: 'Malformed action' },
  blocked_ownership_no_mutation: { allowed: false, type: 'block', label: 'Outside owned scope' },
  blocked_run_interrupted: { allowed: false, type: 'block', label: 'Run interrupted' }
};

function classifyOperationAllowance(source) {
  if (!source) return ALLOWANCE_MAP.blocked_malformed;

  // Snapshot workspace operation shape: { operation: { operation, args }, result, error, ... }
  // History record shape: { operation, args, result, error, ... }
  const opName = source.operation && typeof source.operation === 'object' ? source.operation.operation : source.operation;
  const err = source.error;
  const result = source.result;

  if (err) {
    const code = typeof err === 'string' ? err : (err.code || '');
    const msg = typeof err === 'string' ? err : (err.message || '');

    // Classify by error code (preferred path)
    if (code === 'WORKSPACE_SENSITIVE_PATH') return ALLOWANCE_MAP.blocked_sensitive_path;
    if (code === 'WORKSPACE_PROTECTED_PATH') return ALLOWANCE_MAP.blocked_protected_path;
    if (code === 'WORKSPACE_OWNERSHIP_VIOLATION') return ALLOWANCE_MAP.blocked_ownership;
    if (code === 'RUN_LIMIT_EXCEEDED') return ALLOWANCE_MAP.blocked_budget;
    if (code === 'WORKSPACE_MALFORMED_ACTION') return ALLOWANCE_MAP.blocked_malformed;
    if (code === 'WORKSPACE_UNSUPPORTED_OPERATION') return ALLOWANCE_MAP.blocked_unsupported_op;
    if (code === 'RUN_INTERRUPTED') return ALLOWANCE_MAP.blocked_run_interrupted;

    // Backward-compatible message fallback for legacy records
    // stored before error codes were added
    if (msg.includes('sensitive application path')) return ALLOWANCE_MAP.blocked_sensitive_path;
    if (msg.includes('protected workspace path')) return ALLOWANCE_MAP.blocked_protected_path;
    if (msg.includes('outside owned output paths')) return ALLOWANCE_MAP.blocked_ownership;
    if (msg.includes('limit')) return ALLOWANCE_MAP.blocked_budget;
    if (msg.includes('Unsupported workspace operation') || msg.includes('unsupported field') || msg.includes('must be an object') || msg.includes('is required') || msg.includes('must be a string') || msg.includes('cannot be blank')) return ALLOWANCE_MAP.blocked_malformed;
    if (msg.includes('Run interrupted')) return ALLOWANCE_MAP.blocked_run_interrupted;
    return { allowed: false, type: 'block', label: 'Operation error' };
  }

  if (result && result.status) {
    if (result.status === 'already_exists_noop' || result.status === 'already_missing_noop') return ALLOWANCE_MAP.allowed_noop;
    if (result.status === 'not_found') return { allowed: true, type: 'noop', label: 'Target not found' };
  }

  if (opName && AGENT_MUTATING_OPERATIONS.includes(opName)) return ALLOWANCE_MAP.allowed_by_budget;
  return ALLOWANCE_MAP.allowed_by_op;
}

const ERROR_CODE_EXPLANATIONS = {
  WORKSPACE_SENSITIVE_PATH: 'Blocked because the path is a sensitive application file or directory.',
  WORKSPACE_PROTECTED_PATH: 'Blocked because the path is protected from agent mutation.',
  WORKSPACE_OWNERSHIP_VIOLATION: 'Blocked because the operation is outside the run owned scope.',
  RUN_LIMIT_EXCEEDED: 'Stopped because a bounded runtime limit was exceeded.',
  WORKSPACE_MALFORMED_ACTION: 'Rejected because the workspace action contract was malformed.',
  WORKSPACE_UNSUPPORTED_OPERATION: 'Rejected because the operation is not in the allowed action vocabulary.',
  WORKSPACE_ACTION_INTERRUPTED: 'Stopped because the run was interrupted during workspace execution.',
  RUN_INTERRUPTED: 'Stopped because an operator or runtime interruption ended the run.'
};

function explainErrorCode(code) {
  return ERROR_CODE_EXPLANATIONS[code] || 'The operation failed; inspect the payload for full details.';
}

function getErrorCodeFromSource(source) {
  if (!source) return null;
  const err = source.error || source.failure || null;
  if (err && typeof err === 'object' && err.code) return err.code;
  if (typeof err === 'string' && ERROR_CODE_EXPLANATIONS[err]) return err;
  if (source.code) return source.code;
  return null;
}

function getErrorMessageFromSource(source) {
  if (!source) return null;
  const err = source.error || source.failure || null;
  if (typeof err === 'string') return err;
  if (err && typeof err === 'object') return err.message || err.reason || null;
  return source.reason || source.failureReason || null;
}

function buildOperationErrorInfo(source) {
  const code = getErrorCodeFromSource(source);
  const message = getErrorMessageFromSource(source);
  if (!code && !message) return null;
  return {
    code: code || 'OPERATION_ERROR',
    explanation: code ? explainErrorCode(code) : 'The operation failed; inspect the payload for full details.',
    message
  };
}

function displayWorkspaceRootLabel(executionWorkspaceType) {
  return executionWorkspaceType === 'scoped' ? 'scoped workspace' : 'workspace-root';
}

function sanitizeWorkspaceDisplayValue(value, executionWorkspaceType = 'main') {
  if (typeof value === 'string') {
    return value.split(WORKSPACE_ROOT).join(displayWorkspaceRootLabel(executionWorkspaceType));
  }
  if (Array.isArray(value)) return value.map(item => sanitizeWorkspaceDisplayValue(item, executionWorkspaceType));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, sanitizeWorkspaceDisplayValue(item, executionWorkspaceType)]));
  }
  return value;
}

function createDisplaySnapshot(snapshot) {
  if (!snapshot) return null;
  return sanitizeWorkspaceDisplayValue(snapshot, snapshot.executionWorkspaceType || 'main');
}

function countBoundedTransitionRejections(snapshot) {
  const events = snapshot && Array.isArray(snapshot.events) ? snapshot.events : [];
  return events.filter(event => {
    const type = event && event.type ? event.type : '';
    return type.includes('limit') || type.includes('stalled') || type.includes('no_progress') || type.includes('blocked');
  }).length;
}

function describeFirstFailedOperation(source) {
  if (!source) return '-';
  const operation = source.operation && typeof source.operation === 'object' ? source.operation.operation : source.operation;
  const args = source.operation && typeof source.operation === 'object' ? source.operation.args : source.args;
  const pathValue = args && args.path ? ` ${args.path}` : '';
  return `${operation || 'operation'}${pathValue}`;
}

function buildRunFailureSummary(run, snapshot, operationHistory, mutationCount, recoveryAvailable) {
  if (!['failed', 'interrupted'].includes(run.status)) return null;

  const workspaceOps = snapshot && Array.isArray(snapshot.workspaceOperations) ? snapshot.workspaceOperations : [];
  const firstFailedOperation = workspaceOps.find(op => op && (op.error || op.blocked || op.reason))
    || (operationHistory || []).find(record => record && record.error)
    || null;
  const snapshotFailure = snapshot && snapshot.failure ? snapshot.failure : null;
  const code = getErrorCodeFromSource(firstFailedOperation) || getErrorCodeFromSource(snapshotFailure) || (run.status === 'interrupted' ? 'RUN_INTERRUPTED' : null);
  const rootCause = (snapshot && snapshot.failureReason) || run.error || getErrorMessageFromSource(firstFailedOperation) || (code ? explainErrorCode(code) : 'Run ended without a structured failure reason.');

  return {
    status: run.status,
    rootCause,
    blockingErrorCode: code || '-',
    blockingErrorExplanation: code ? explainErrorCode(code) : '-',
    firstFailedOperation: describeFirstFailedOperation(firstFailedOperation),
    mutationCount: mutationCount || 0,
    mutationsBeforeFailure: (mutationCount || 0) > 0,
    recoveryAvailable: recoveryAvailable === true,
    boundedTransitionRejectionCount: countBoundedTransitionRejections(snapshot)
  };
}

function buildRunAuthorityContext(run, ticket, agent, snapshot) {
  const s = snapshot || {};
  const allocationItem = getRunAllocationItem(run);
  const allocationPlanId = run.allocationPlanId || s.allocationPlanId || null;
  const allocationItemId = run.allocationItemId || s.allocationItemId || null;
  const ownedOutputPaths = getRunOwnedOutputPaths(run);
  const limits = getAgentRuntimeLimits();
  const groups = readGroups();
  const agentGroupNames = agent
    ? getPrincipalGroupIds('agent', agent.id).map(groupId => (groups.find(group => group.id === groupId) || {}).name).filter(Boolean)
    : [];
  const assignmentGroup = ticket && ticket.assignmentTargetType === 'group'
    ? groups.find(group => group.id === ticket.assignmentTargetId)
    : null;
  const executionWorkspaceType = run.executionWorkspaceType || s.executionWorkspaceType || 'main';

  return {
    principal: {
      agentId: run.agentId,
      agentName: agent ? agent.name : (run.agentName || s.agentNameSnapshot || 'Unknown'),
      allocationPlanId,
      allocationItemId,
      allocationSubtask: run.allocationSubtask || s.allocationSubtask || null,
      ownedOutputPaths: ownedOutputPaths.length > 0 ? ownedOutputPaths : (Array.isArray(s.ownedOutputPaths) ? s.ownedOutputPaths : [])
    },
    authority: {
      allowedOperations: (s.primitiveContract && s.primitiveContract.allowedOperations) || AGENT_ALLOWED_OPERATIONS,
      mutatingOperations: (s.primitiveContract && s.primitiveContract.mutatingOperations) || AGENT_MUTATING_OPERATIONS,
      maxActionsPerResponse: MAX_AGENT_ACTIONS_PER_RESPONSE,
      maxMutatingActionsPerResponse: MAX_MUTATING_ACTIONS_PER_RESPONSE,
      maxSteps: limits.maxExecutionSteps,
      maxWorkspaceOperations: limits.maxWorkspaceOperationsPerRun,
      maxModelRequests: limits.maxModelRequestsPerRun,
      maxRuntimeDurationMs: limits.maxRuntimeDurationMs,
      provider: s.provider || (agent ? agent.provider : null) || '-',
      model: s.model || (agent ? agent.model : null) || '-',
      executionWorkspaceType,
      workspaceRoot: displayWorkspaceRootLabel(executionWorkspaceType)
    },
    provenance: {
      assignment: assignmentGroup
        ? `Granted via ticket assignment group "${assignmentGroup.name}"`
        : 'Granted via direct ticket assignment',
      groups: agentGroupNames.length > 0 ? agentGroupNames.join(', ') : 'No agent group grant recorded',
      runtimePolicy: 'Default bounded workspace runtime policy',
      scope: allocationPlanId ? 'Owned-scope allocation plan' : 'Direct assignment workspace scope'
    },
    controls: {
      interruptible: ['pending', 'running'].includes(run.status),
      recoverable: run.status === 'failed' || run.status === 'interrupted',
      replayAvailable: !!snapshot,
      recoveryAvailable: null
    }
  };
}

function broadcastTicketChange() {
  const event = `event: tickets-changed\ndata: ${JSON.stringify({ updatedAt: new Date().toISOString() })}\n\n`;
  ticketEventClients.forEach(client => {
    try {
      client.write(event);
    } catch (error) {
      ticketEventClients.delete(client);
    }
  });
}

function broadcastLogEntry(log) {
  const event = `event: log\ndata: ${JSON.stringify(sanitizeWorkspaceDisplayValue(log))}\n\n`;
  logEventClients.forEach(client => {
    try {
      client.write(event);
    } catch (error) {
      logEventClients.delete(client);
    }
  });
}

function sanitizeLogMessage(message) {
  return String(message || '').replace(/sk-[A-Za-z0-9_*\-]+/g, '[redacted-api-key]');
}

function isSensitiveSnapshotKey(key) {
  const lowerKey = String(key || '').toLowerCase();

  return lowerKey === 'authorization' ||
    lowerKey === 'api_key' ||
    lowerKey === 'apikey' ||
    lowerKey === 'api-key' ||
    lowerKey === 'secret' ||
    lowerKey.endsWith('_secret') ||
    lowerKey.endsWith('-secret') ||
    lowerKey === 'token' ||
    lowerKey === 'access_token' ||
    lowerKey === 'refresh_token' ||
    lowerKey === 'id_token' ||
    lowerKey.endsWith('_token') && !lowerKey.endsWith('_tokens') ||
    lowerKey.endsWith('-token') && !lowerKey.endsWith('-tokens');
}

function sanitizeSnapshotValue(value) {
  if (typeof value === 'string') return sanitizeLogMessage(value);
  if (Array.isArray(value)) return value.map(item => sanitizeSnapshotValue(item));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => {
      return [key, isSensitiveSnapshotKey(key) ? '[redacted]' : sanitizeSnapshotValue(item)];
    }));
  }

  return value;
}

function createLogTimestamp() {
  const wallClockNs = BigInt(Date.now()) * 1000000n;
  const highPrecisionRemainderNs = process.hrtime.bigint() % 1000000n;
  let timestampNs = wallClockNs + highPrecisionRemainderNs;

  if (timestampNs <= lastLogTimestampNs) {
    timestampNs = lastLogTimestampNs + 1n;
  }

  lastLogTimestampNs = timestampNs;

  const timestampMs = timestampNs / 1000000n;
  const fractionalNs = timestampNs % 1000000000n;
  const baseIso = new Date(Number(timestampMs)).toISOString().replace(/\.\d{3}Z$/, '');

  return `${baseIso}.${fractionalNs.toString().padStart(9, '0')}Z`;
}

function isValidIsoTimestamp(value) {
  if (typeof value !== 'string') return false;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3,9})?Z$/.test(value)) return false;
  return !Number.isNaN(Date.parse(value));
}

function appendRunLog(run, type, message, workspaceAction = null, extraFields = {}) {
  const logs = readLogs();
  const log = {
    id: nextId(logs),
    timestamp: createLogTimestamp(),
    runId: run.id,
    ticketId: run.ticketId,
    agentId: run.agentId,
    agentName: run.agentName,
    type,
    message: sanitizeLogMessage(message),
    workspaceAction,
    ...extraFields
  };

  logs.push(log);
  writeLogs(logs);
  broadcastLogEntry(log);
  return log;
}

function appendSystemLog(type, message, workspaceAction = null, extraFields = {}) {
  const logs = readLogs();
  const contextFields = { ...extraFields };
  if (Object.prototype.hasOwnProperty.call(contextFields, 'ticketId')) {
    contextFields.contextTicketId = contextFields.ticketId;
    delete contextFields.ticketId;
  }
  if (Object.prototype.hasOwnProperty.call(contextFields, 'runId')) {
    contextFields.contextRunId = contextFields.runId;
    delete contextFields.runId;
  }
  delete contextFields.agentId;
  delete contextFields.agentName;
  const log = {
    id: nextId(logs),
    timestamp: createLogTimestamp(),
    runId: null,
    ticketId: null,
    agentId: null,
    agentName: 'System',
    type,
    message: sanitizeLogMessage(message),
    workspaceAction,
    ...contextFields
  };

  logs.push(log);
  writeLogs(logs);
  broadcastLogEntry(log);
  return log;
}

function updateTicketStatusById(ticketId, status) {
  const tickets = readTickets();
  const ticket = tickets.find(item => item.id === ticketId);

  if (!ticket) return null;
  if (ticket.status === status) return ticket;

  ticket.status = status;
  ticket.updatedAt = new Date().toISOString();
  writeTickets(tickets);
  broadcastTicketChange();
  return ticket;
}

function readUsers() {
  return readJsonArrayCached(USERS_FILE);
}

function normalizeUsers(users) {
  const seenUserIds = new Set();

  return users.filter(user => {
    const userId = parseInt(user.id, 10);
    if (Number.isNaN(userId) || seenUserIds.has(userId)) return false;

    seenUserIds.add(userId);
    user.id = userId;
    user.type = 'user';
    return true;
  });
}

function writeUsers(users) {
  writeFileAtomic(USERS_FILE, JSON.stringify(normalizeUsers(users), null, 2));
}

function readGroups() {
  return readJsonArrayCached(GROUPS_FILE);
}

function normalizeGroups(groups) {
  const seenGroupIds = new Set();
  const validPermissions = new Set(readPermissions());

  return groups.reduce((normalized, group) => {
    const groupId = parseInt(group.id, 10);

    if (Number.isNaN(groupId) || seenGroupIds.has(groupId)) return normalized;

    seenGroupIds.add(groupId);
    const submittedPermissions = Array.isArray(group.permissions) ? group.permissions : [];

    const permissions = [];
    submittedPermissions.forEach(permission => {
      const normalizedPermission = String(permission || '').trim();
      if (normalizedPermission && validPermissions.has(normalizedPermission) && !permissions.includes(normalizedPermission)) {
        permissions.push(normalizedPermission);
      }
    });

    normalized.push({
      id: groupId,
      name: String(group.name || '').trim() || `Group ${groupId}`,
      permissions,
      canReceiveTickets: group.canReceiveTickets === true
    });

    return normalized;
  }, []);
}

function writeGroups(groups) {
  writeFileAtomic(GROUPS_FILE, JSON.stringify(normalizeGroups(groups), null, 2));
}

function readPermissions() {
  return readJsonArrayCached(PERMISSIONS_FILE);
}

function readMemberships() {
  return readJsonArrayCached(MEMBERSHIPS_FILE);
}

function normalizeMemberships(memberships) {
  const seenMemberships = new Set();
  const normalized = [];
  const userIds = new Set(readUsers().map(user => user.id));
  const agentIds = new Set(readAgents().map(agent => agent.id));
  const groupIds = new Set(readGroups().map(group => group.id));

  memberships.forEach(membership => {
    const principalType = membership.principalType === 'agent' ? 'agent' : 'user';
    const principalId = parseInt(membership.principalId ?? membership.userId, 10);
    const groupId = parseInt(membership.groupId, 10);

    if (Number.isNaN(principalId) || Number.isNaN(groupId) || !groupIds.has(groupId)) return;
    if (principalType === 'user' && !userIds.has(principalId)) return;
    if (principalType === 'agent' && !agentIds.has(principalId)) return;

    const membershipKey = `${principalType}:${principalId}:${groupId}`;
    if (seenMemberships.has(membershipKey)) return;

    seenMemberships.add(membershipKey);
    normalized.push({
      id: normalized.length + 1,
      principalType,
      principalId,
      groupId
    });
  });

  return normalized;
}

function writeMemberships(memberships) {
  writeFileAtomic(MEMBERSHIPS_FILE, JSON.stringify(normalizeMemberships(memberships), null, 2));
}

function normalizeSubmittedGroupIds(groupIds) {
  if (!groupIds) return [];

  const validGroupIds = new Set(readGroups().map(group => group.id));
  const submittedGroupIds = Array.isArray(groupIds) ? groupIds : [groupIds];
  const normalizedGroupIds = [];

  submittedGroupIds.forEach(groupId => {
    const normalizedGroupId = parseInt(groupId, 10);

    if (Number.isNaN(normalizedGroupId)) {
      throw new Error('Invalid group selection');
    }

    if (!validGroupIds.has(normalizedGroupId)) {
      throw new Error('Selected group does not exist');
    }

    if (!normalizedGroupIds.includes(normalizedGroupId)) {
      normalizedGroupIds.push(normalizedGroupId);
    }
  });

  return normalizedGroupIds;
}

function setPrincipalGroupMemberships(principalType, principalId, groupIds) {
  const normalizedPrincipalType = principalType === 'agent' ? 'agent' : 'user';
  const normalizedPrincipalId = parseInt(principalId, 10);

  if (Number.isNaN(normalizedPrincipalId)) {
    throw new Error('Account not found for group assignment');
  }

  if (normalizedPrincipalType === 'user' && !readUsers().some(user => user.id === normalizedPrincipalId)) {
    throw new Error('User account not found for group assignment');
  }

  if (normalizedPrincipalType === 'agent' && !readAgents().some(agent => agent.id === normalizedPrincipalId)) {
    throw new Error('Agent account not found for group assignment');
  }

  const normalizedGroupIds = normalizeSubmittedGroupIds(groupIds);
  const existingMemberships = readMemberships().filter(membership =>
    membership.principalType !== normalizedPrincipalType || membership.principalId !== normalizedPrincipalId
  );
  const nextMemberships = normalizedGroupIds.map((groupId, index) => ({
    id: existingMemberships.length + index + 1,
    principalType: normalizedPrincipalType,
    principalId: normalizedPrincipalId,
    groupId
  }));

  writeMemberships([...existingMemberships, ...nextMemberships]);
}

function normalizeSubmittedPermissions(permissions) {
  if (!permissions) return [];

  const validPermissions = new Set(readPermissions());
  const submittedPermissions = Array.isArray(permissions) ? permissions : [permissions];
  const normalizedPermissions = [];

  submittedPermissions.forEach(permission => {
    const normalizedPermission = String(permission || '').trim();

    if (!normalizedPermission || !validPermissions.has(normalizedPermission)) {
      throw new Error('Invalid permission selection');
    }

    if (!normalizedPermissions.includes(normalizedPermission)) {
      normalizedPermissions.push(normalizedPermission);
    }
  });

  return normalizedPermissions;
}

function readAgents() {
  return readJsonArrayCached(AGENTS_FILE);
}

function normalizeAgents(agents) {
  const seenAgentIds = new Set();

  return agents.filter(agent => {
    const agentId = parseInt(agent.id, 10);
    if (Number.isNaN(agentId) || seenAgentIds.has(agentId)) return false;

    seenAgentIds.add(agentId);
    agent.id = agentId;
    agent.type = 'agent';
    agent.provider = PROVIDERS.includes(agent.provider) ? agent.provider : 'openai';
    return true;
  });
}

function writeAgents(agents) {
  writeFileAtomic(AGENTS_FILE, JSON.stringify(normalizeAgents(agents), null, 2));
}

function readRuns() {
  return readJsonArrayCached(RUNS_FILE);
}

function replaySnapshotRelativePath(runId) {
  return path.join('replay-snapshots', `run-${runId}.json`);
}

function replaySnapshotFilePath(runId) {
  return path.join(DATA_DIR, replaySnapshotRelativePath(runId));
}

function extractReplaySummary(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return null;
  const workspaceOperations = Array.isArray(snapshot.workspaceOperations) ? snapshot.workspaceOperations : [];
  const events = Array.isArray(snapshot.events) ? snapshot.events : [];
  const parsedModelPlans = Array.isArray(snapshot.parsedModelPlans) ? snapshot.parsedModelPlans : [];
  const providerRequests = Array.isArray(snapshot.providerRequests) ? snapshot.providerRequests : [];
  const modelResponses = Array.isArray(snapshot.modelResponses) ? snapshot.modelResponses : [];

  return {
    model: snapshot.model || null,
    terminalStatus: snapshot.terminalStatus || null,
    failureReason: snapshot.failureReason || null,
    failure: snapshot.failure || null,
    mutationCount: snapshot.mutationCount,
    mutationOutcome: snapshot.mutationOutcome || null,
    finalizedAt: snapshot.finalizedAt || null,
    continuationOf: snapshot.continuationOf || null,
    steps: parsedModelPlans.length,
    workspaceOperations: workspaceOperations.length,
    providerRequests: providerRequests.length,
    modelResponses: modelResponses.length,
    hasBlockedOrRejected: workspaceOperations.some(item => item && (item.blocked || item.reason || (item.operation && item.operation.blocked))),
    hasCompletedNoop: events.some(item => item && item.type === 'run:completed_noop')
  };
}

function readRunReplaySnapshot(run) {
  if (!run || typeof run !== 'object') return null;
  if (run.replaySnapshot && typeof run.replaySnapshot === 'object') return run.replaySnapshot;
  if (!run.replaySnapshotPath) return null;

  const snapshotPath = path.resolve(DATA_DIR, run.replaySnapshotPath);
  if (!snapshotPath.startsWith(DATA_DIR + path.sep)) return null;
  if (!fs.existsSync(snapshotPath)) return null;

  try {
    return JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));
  } catch (error) {
    return null;
  }
}

function hydrateRunReplaySnapshot(run) {
  if (!run || typeof run !== 'object') return run;
  const replaySnapshot = readRunReplaySnapshot(run);
  return replaySnapshot ? { ...run, replaySnapshot } : { ...run };
}

function writeReplaySnapshotFile(runId, snapshot) {
  if (!fs.existsSync(REPLAY_SNAPSHOTS_DIR)) {
    fs.mkdirSync(REPLAY_SNAPSHOTS_DIR, { recursive: true });
  }

  const filePath = replaySnapshotFilePath(runId);
  writeFileAtomic(filePath, JSON.stringify(snapshot, null, 2));
  return replaySnapshotRelativePath(runId);
}

function attachReplayMetadata(run, snapshot) {
  const summary = extractReplaySummary(snapshot);
  run.replaySnapshotPath = replaySnapshotRelativePath(run.id);
  run.replaySummary = summary;
  if (summary && summary.mutationCount !== undefined) run.mutationCount = summary.mutationCount;
  if (summary && summary.mutationOutcome) run.mutationOutcome = summary.mutationOutcome;
  delete run.replaySnapshot;
  return run;
}

function writeRunReplaySnapshot(runId, snapshot) {
  const runs = readRuns();
  const run = runs.find(item => item.id === runId);

  if (!run) return null;

  const sanitizedSnapshot = sanitizeSnapshotValue(snapshot);
  writeReplaySnapshotFile(runId, sanitizedSnapshot);
  attachReplayMetadata(run, sanitizedSnapshot);
  writeRuns(runs);
  return sanitizedSnapshot;
}

function normalizeRuns(runs) {
  const seenRunIds = new Set();

  return runs.filter(run => {
    const runId = parseInt(run.id, 10);
    const ticketId = parseInt(run.ticketId, 10);
    const agentId = parseInt(run.agentId, 10);

    if (Number.isNaN(runId) || Number.isNaN(ticketId) || Number.isNaN(agentId)) return false;
    if (seenRunIds.has(runId)) return false;

    seenRunIds.add(runId);
    run.id = runId;
    run.ticketId = ticketId;
    run.agentId = agentId;
    run.workspaceRoot = run.workspaceRoot || WORKSPACE_ROOT;
    run.mainWorkspaceRoot = run.mainWorkspaceRoot || run.workspaceRoot || WORKSPACE_ROOT;
    run.executionWorkspaceType = run.executionWorkspaceType === 'main_owned_paths'
      ? run.executionWorkspaceType
      : 'main';
    run.allocationPlanId = run.allocationPlanId ? parseInt(run.allocationPlanId, 10) : null;
    run.allocationPlanId = Number.isNaN(run.allocationPlanId) ? null : run.allocationPlanId;
    run.allocationItemId = run.allocationItemId ? parseInt(run.allocationItemId, 10) : null;
    run.allocationItemId = Number.isNaN(run.allocationItemId) ? null : run.allocationItemId;
    run.ownedOutputPaths = Array.isArray(run.ownedOutputPaths) ? run.ownedOutputPaths : [];
    run.allocationSubtask = typeof run.allocationSubtask === 'string' ? run.allocationSubtask : null;
    if (run.replaySnapshot && typeof run.replaySnapshot === 'object') {
      const snapshot = sanitizeSnapshotValue(run.replaySnapshot);
      writeReplaySnapshotFile(run.id, snapshot);
      attachReplayMetadata(run, snapshot);
    } else {
      run.replaySnapshotPath = typeof run.replaySnapshotPath === 'string' ? run.replaySnapshotPath : null;
      run.replaySummary = run.replaySummary && typeof run.replaySummary === 'object' ? run.replaySummary : null;
    }
    return true;
  });
}

function writeRuns(runs) {
  writeFileAtomic(RUNS_FILE, JSON.stringify(normalizeRuns(runs), null, 2));
}

function readAllocationPlans() {
  return readJsonArrayCached(ALLOCATION_PLANS_FILE);
}

function normalizeAllocationPlans(plans) {
  const seenPlanIds = new Set();
  const seenItemIds = new Set();

  return plans.filter(plan => {
    const planId = parseInt(plan.id, 10);
    const ticketId = parseInt(plan.ticketId, 10);

    if (Number.isNaN(planId) || Number.isNaN(ticketId) || seenPlanIds.has(planId)) return false;

    seenPlanIds.add(planId);
    plan.id = planId;
    plan.ticketId = ticketId;
    plan.mode = plan.mode === 'owned_paths' ? plan.mode : 'owned_paths';
    plan.ticketOpenedAt = typeof plan.ticketOpenedAt === 'string' ? plan.ticketOpenedAt : null;
    plan.status = ['pending', 'running', 'completed', 'failed', 'interrupted'].includes(plan.status) ? plan.status : 'pending';
    plan.createdAt = typeof plan.createdAt === 'string' ? plan.createdAt : new Date().toISOString();
    plan.items = Array.isArray(plan.items) ? plan.items.filter(item => {
      const allocationItemId = parseInt(item.allocationItemId, 10);
      const assignedAgentId = parseInt(item.assignedAgentId, 10);

      if (Number.isNaN(allocationItemId) || Number.isNaN(assignedAgentId) || seenItemIds.has(allocationItemId)) return false;

      seenItemIds.add(allocationItemId);
      item.allocationItemId = allocationItemId;
      item.assignedAgentId = assignedAgentId;
      item.allocationSubtask = typeof item.allocationSubtask === 'string' ? item.allocationSubtask : '';
      item.ownedOutputPaths = Array.isArray(item.ownedOutputPaths)
        ? item.ownedOutputPaths.map(normalizeWorkspaceOwnershipPath).filter(Boolean)
        : [];
      item.status = ['pending', 'running', 'completed', 'failed', 'interrupted'].includes(item.status) ? item.status : 'pending';
      item.createdAt = typeof item.createdAt === 'string' ? item.createdAt : plan.createdAt;
      return true;
    }) : [];

    return true;
  });
}

function writeAllocationPlans(plans) {
  writeFileAtomic(ALLOCATION_PLANS_FILE, JSON.stringify(normalizeAllocationPlans(plans), null, 2));
}

function readLogs() {
  return readJsonArrayCached(LOGS_FILE);
}

function normalizeLogs(logs) {
  const seenLogIds = new Set();
  const runsById = new Map(readRuns().map(run => [run.id, run]));

  return logs.filter(log => {
    const logId = parseInt(log.id, 10);
    const isSystemLog = log.runId === null && log.ticketId === null;
    const runId = isSystemLog ? null : parseInt(log.runId, 10);
    const ticketId = isSystemLog ? null : parseInt(log.ticketId, 10);
    const run = runsById.get(runId);

    if (Number.isNaN(logId)) return false;
    if (!isSystemLog && (Number.isNaN(runId) || Number.isNaN(ticketId))) return false;
    if (!isValidIsoTimestamp(log.timestamp)) return false;
    if (!isSystemLog && (!run || run.ticketId !== ticketId)) return false;
    if (seenLogIds.has(logId)) return false;

    seenLogIds.add(logId);
    log.id = logId;
    log.runId = runId;
    log.ticketId = ticketId;
    log.agentId = isSystemLog ? null : run.agentId;
    log.message = sanitizeLogMessage(log.message);
    return true;
  });
}

function writeLogs(logs) {
  writeFileAtomic(LOGS_FILE, JSON.stringify(normalizeLogs(logs), null, 2));
}

function readOperationHistory() {
  return readJsonArrayCached(OPERATION_HISTORY_FILE);
}

function normalizeOperationHistory(history) {
  const seenIds = new Set();
  const runsById = new Map(readRuns().map(run => [run.id, run]));

  return history.filter(record => {
    const id = parseInt(record.id, 10);
    if (Number.isNaN(id) || seenIds.has(id)) return false;
    seenIds.add(id);
    record.id = id;
    record.ticketId = parseInt(record.ticketId, 10);
    record.runId = parseInt(record.runId, 10);
    record.allocationPlanId = record.allocationPlanId ? parseInt(record.allocationPlanId, 10) : null;
    record.allocationItemId = record.allocationItemId ? parseInt(record.allocationItemId, 10) : null;
    record.step = parseInt(record.step, 10);
    record.isRecovery = record.isRecovery === true;
    record.recoveredHistoryId = record.recoveredHistoryId ? parseInt(record.recoveredHistoryId, 10) : null;
    if (!isValidIsoTimestamp(record.timestamp)) return false;
    const run = runsById.get(record.runId);
    if (!run || run.ticketId !== record.ticketId) return false;
    if (!AGENT_MUTATING_OPERATIONS.includes(record.operation)) return false;
    return true;
  });
}

function writeFileAtomic(filePath, data) {
  const tempPath = `${filePath}.tmp`;
  fs.writeFileSync(tempPath, data);
  fs.renameSync(tempPath, filePath);
  jsonReadCache.delete(filePath);
  dataVersion += 1;
  pageRenderCache.clear();
  pageRenderInFlight.clear();
}

function writeOperationHistory(history) {
  writeFileAtomic(OPERATION_HISTORY_FILE, JSON.stringify(normalizeOperationHistory(history), null, 2));
}

function getOperationHistoryForRun(runId, history = readOperationHistory()) {
  return history.filter(record => record.runId === runId);
}

function getOperationHistoryForTicket(ticketId, history = readOperationHistory()) {
  return history.filter(record => record.ticketId === ticketId);
}

function findOperationHistoryRecord(recordId) {
  return readOperationHistory().find(record => record.id === recordId) || null;
}

function isActualWorkspaceMutation(record) {
  if (record.error) return false;
  if (!AGENT_MUTATING_OPERATIONS.includes(record.operation)) return false;

  if (record.operation === 'createFolder') {
    return record.result && record.result.status === 'created';
  }

  if (record.operation === 'deletePath') {
    return record.result && record.result.status === 'deleted';
  }

  if (record.operation === 'writeFile') {
    return true;
  }

  if (record.operation === 'renamePath') {
    return true;
  }

  return false;
}

function countRunMutatingOperations(runId, history = readOperationHistory()) {
  return history.filter(record =>
    record.runId === runId && isActualWorkspaceMutation(record)
  ).length;
}

function groupBy(items, keyFn) {
  const grouped = new Map();
  items.forEach(item => {
    const key = keyFn(item);
    const existing = grouped.get(key) || [];
    existing.push(item);
    grouped.set(key, existing);
  });
  return grouped;
}

function buildMutationCountByRunId(history) {
  const counts = new Map();
  history.forEach(record => {
    if (!isActualWorkspaceMutation(record)) return;
    counts.set(record.runId, (counts.get(record.runId) || 0) + 1);
  });
  return counts;
}

function getCurrentWorkspacePathInfo(relativePath) {
  try {
    return workspaceProvider.getPathInfo(relativePath);
  } catch (error) {
    return { exists: false, error: error.message || 'Workspace path access failed' };
  }
}

function getOperatorWorkspacePathInfo(relativePath) {
  try {
    return workspaceProvider.getPathInfo(relativePath, { allowHidden: true });
  } catch (error) {
    return { exists: false, error: error.message || 'Workspace path access failed' };
  }
}

function captureOperatorWorkspaceState(paths) {
  return Array.from(new Set(paths.filter(pathValue => pathValue != null).map(pathValue => String(pathValue)))).map(pathValue => ({
    path: pathValue,
    info: getOperatorWorkspacePathInfo(pathValue)
  }));
}

function captureWorkspaceRootListing() {
  try {
    return workspaceProvider.list('', { allowHidden: true });
  } catch (error) {
    return { error: error.message || 'Workspace root listing failed' };
  }
}

function classifyOperationRecoverability(record, recoveredIds = null) {
  if (record.isRecovery) {
    return { status: 'recovery_action', reason: 'This operation is a recovery action' };
  }
  if (record.error) {
    return { status: 'unrecoverable', reason: 'Operation failed' };
  }

  if (recoveredIds && recoveredIds.has(record.id)) {
    return { status: 'recovery_available', reason: 'Already recovered' };
  }

  const histories = readOperationHistory();
  const existingRecovery = histories.find(h => h.recoveredHistoryId === record.id);
  if (existingRecovery) {
    return { status: 'recovery_available', reason: `Recovered in history #${existingRecovery.id}` };
  }

  if (record.operation === 'writeFile') {
    if (!record.preState) {
      return { status: 'unrecoverable', reason: 'Missing pre-state' };
    }
    if (record.preState.existed === false) {
      return { status: 'recoverable', reason: 'Delete created file' };
    }
    if (record.preState.existed === true && record.preState.content != null) {
      return { status: 'recoverable', reason: 'Restore previous contents' };
    }
    return { status: 'unrecoverable', reason: 'Previous content not captured' };
  }

  if (record.operation === 'renamePath') {
    if (!record.preState || !record.preState.source) {
      return { status: 'unrecoverable', reason: 'Missing pre-state' };
    }
    if (record.preState.source.existed === true) {
      return { status: 'recoverable', reason: 'Restore original path' };
    }
    return { status: 'unrecoverable', reason: 'Source did not exist before rename' };
  }

  if (record.operation === 'deletePath') {
    return { status: 'unrecoverable', reason: 'Deleted content not stored' };
  }

  return { status: 'unrecoverable', reason: 'Operation type not supported for recovery' };
}

function validateRecoveryWorkspaceState(record) {
  if (record.operation === 'writeFile') {
    const currentInfo = getCurrentWorkspacePathInfo(record.args.path);
    if (currentInfo.error) {
      return { valid: false, reason: `Cannot access workspace path: ${currentInfo.error}` };
    }
    if (!currentInfo.exists) {
      return { valid: false, reason: `File no longer exists at ${record.args.path}` };
    }
    if (currentInfo.type !== 'file') {
      return { valid: false, reason: `Path ${record.args.path} is no longer a file` };
    }
    if (!record.postState || !record.postState.contentHash) {
      return { valid: false, reason: 'Missing post-state content hash for validation' };
    }
    if (currentInfo.contentHash !== record.postState.contentHash) {
      return { valid: false, reason: `File content has diverged from expected state at ${record.args.path}` };
    }
    return { valid: true };
  }

  if (record.operation === 'renamePath') {
    const sourceInfo = getCurrentWorkspacePathInfo(record.args.path);
    const destInfo = getCurrentWorkspacePathInfo(record.args.nextPath);
    if (sourceInfo.error) {
      return { valid: false, reason: `Cannot access workspace path: ${sourceInfo.error}` };
    }
    if (destInfo.error) {
      return { valid: false, reason: `Cannot access workspace path: ${destInfo.error}` };
    }
    if (sourceInfo.exists) {
      return { valid: false, reason: `Original source path still exists: ${record.args.path}` };
    }
    if (!destInfo.exists) {
      return { valid: false, reason: `Destination path no longer exists: ${record.args.nextPath}` };
    }
    if (record.postState && record.postState.destination && record.postState.destination.type) {
      if (destInfo.type !== record.postState.destination.type) {
        return { valid: false, reason: `Destination type has changed at ${record.args.nextPath}` };
      }
    }
    if (record.postState && record.postState.destination && record.postState.destination.contentHash) {
      if (destInfo.contentHash !== record.postState.destination.contentHash) {
        return { valid: false, reason: `Destination content has diverged from expected state at ${record.args.nextPath}` };
      }
    }
    return { valid: true };
  }

  return { valid: false, reason: 'Unsupported operation for recovery validation' };
}

function buildRecoveryAction(record) {
  if (record.operation === 'writeFile') {
    if (record.preState && record.preState.existed === true && record.preState.content != null) {
      return { operation: 'writeFile', args: { path: record.args.path, content: record.preState.content } };
    }
    return { operation: 'deletePath', args: { path: record.args.path } };
  }

  if (record.operation === 'renamePath') {
    return { operation: 'renamePath', args: { path: record.args.nextPath, nextPath: record.args.path } };
  }

  return null;
}

function previewRecovery(record) {
  const classification = classifyOperationRecoverability(record);

  if (classification.status !== 'recoverable') {
    return { ...classification, canProceed: false, proposedAction: null, validation: null };
  }

  const proposedAction = buildRecoveryAction(record);
  if (!proposedAction) {
    return { ...classification, canProceed: false, proposedAction: null, validation: { valid: false, reason: 'Could not determine recovery action' } };
  }

  const validation = validateRecoveryWorkspaceState(record);

  return {
    ...classification,
    canProceed: validation.valid,
    proposedAction,
    validation
  };
}

function persistRecoveryOperationHistory(originalRecord, recoveryAction, preState, postState, result, error) {
  const histories = readOperationHistory();
  const newId = nextId(histories);
  const record = {
    id: newId,
    timestamp: createLogTimestamp(),
    ticketId: originalRecord.ticketId,
    allocationPlanId: originalRecord.allocationPlanId || null,
    allocationItemId: originalRecord.allocationItemId || null,
    runId: originalRecord.runId,
    step: originalRecord.step,
    operation: recoveryAction.operation,
    args: sanitizeSnapshotValue(recoveryAction.args),
    preState,
    postState,
    result: error ? null : sanitizeSnapshotValue(result),
    error: error ? (error.message || String(error)) : null,
    isRecovery: true,
    recoveredHistoryId: originalRecord.id
  };
  histories.push(record);
  writeOperationHistory(histories);
  return record;
}

function executeRecovery(record, confirmed = false) {
  const preview = previewRecovery(record);

  if (!preview.canProceed) {
    const reason = preview.validation && preview.validation.reason ? preview.validation.reason : 'Recovery not possible';
    throw new Error(reason);
  }

  if (!confirmed) {
    throw new Error('Recovery requires explicit confirmation');
  }

  const recoveryAction = preview.proposedAction;

  if (recoveryAction.operation === 'deletePath') {
    const preState = { existed: true, type: 'file', contentHash: getCurrentWorkspacePathInfo(recoveryAction.args.path).contentHash || undefined };
    let result = null;
    let error = null;
    try {
      result = workspaceProvider.delete(recoveryAction.args.path);
    } catch (e) {
      error = e;
    }
    const postState = { existed: false };
    const recoveryRecord = persistRecoveryOperationHistory(record, recoveryAction, preState, postState, result, error);
    if (error) throw error;
    return recoveryRecord;
  }

  if (recoveryAction.operation === 'writeFile') {
    const preInfo = getCurrentWorkspacePathInfo(recoveryAction.args.path);
    const preState = { existed: preInfo.exists, type: preInfo.type || undefined, contentHash: preInfo.contentHash || undefined };
    let result = null;
    let error = null;
    try {
      result = workspaceProvider.writeFile(recoveryAction.args.path, recoveryAction.args.content);
    } catch (e) {
      error = e;
    }
    const postInfo = getCurrentWorkspacePathInfo(recoveryAction.args.path);
    const postState = { existed: postInfo.exists, type: postInfo.type || undefined, contentHash: postInfo.contentHash || undefined };
    const recoveryRecord = persistRecoveryOperationHistory(record, recoveryAction, preState, postState, result, error);
    if (error) throw error;
    return recoveryRecord;
  }

  if (recoveryAction.operation === 'renamePath') {
    const sourceInfo = getCurrentWorkspacePathInfo(recoveryAction.args.path);
    const destInfo = getCurrentWorkspacePathInfo(recoveryAction.args.nextPath);
    const preState = {
      source: { existed: sourceInfo.exists, type: sourceInfo.type || undefined, contentHash: sourceInfo.contentHash || undefined },
      destination: { existed: destInfo.exists, type: destInfo.type || undefined }
    };
    let result = null;
    let error = null;
    try {
      result = workspaceProvider.rename(recoveryAction.args.path, recoveryAction.args.nextPath);
    } catch (e) {
      error = e;
    }
    const postSourceInfo = getCurrentWorkspacePathInfo(recoveryAction.args.path);
    const postDestInfo = getCurrentWorkspacePathInfo(recoveryAction.args.nextPath);
    const postState = {
      source: { existed: postSourceInfo.exists, type: postSourceInfo.type || undefined },
      destination: { existed: postDestInfo.exists, type: postDestInfo.type || undefined, contentHash: postDestInfo.contentHash || undefined }
    };
    const recoveryRecord = persistRecoveryOperationHistory(record, recoveryAction, preState, postState, result, error);
    if (error) throw error;
    return recoveryRecord;
  }

  throw new Error('Unsupported recovery action');
}

function enrichOperationHistoryForDisplay(history) {
  const recoveredIds = new Set(
    history.filter(h => h.recoveredHistoryId != null).map(h => h.recoveredHistoryId)
  );
  return history.map(record => ({
    ...record,
    recoveryStatus: classifyOperationRecoverability(record, recoveredIds)
  }));
}

function usageTokenTotal(usage) {
  if (!usage || typeof usage !== 'object') return null;
  if (typeof usage.total_tokens === 'number') return usage.total_tokens;

  const promptTokens = typeof usage.prompt_tokens === 'number' ? usage.prompt_tokens : 0;
  const completionTokens = typeof usage.completion_tokens === 'number' ? usage.completion_tokens : 0;
  const inputTokens = typeof usage.input_tokens === 'number' ? usage.input_tokens : 0;
  const outputTokens = typeof usage.output_tokens === 'number' ? usage.output_tokens : 0;
  const total = promptTokens + completionTokens + inputTokens + outputTokens;

  return total > 0 ? total : null;
}

function buildRunMetrics(run, runLogs) {
  const startedAt = run.startedAt || null;
  const completedAt = run.completedAt || null;
  const durationMs = startedAt && completedAt
    ? Math.max(0, new Date(completedAt) - new Date(startedAt))
    : null;
  const totalTokens = runLogs.reduce((total, log) => {
    const tokenTotal = usageTokenTotal(log.usage);
    return tokenTotal === null ? total : total + tokenTotal;
  }, 0);

  return {
    runId: run.id,
    agentId: run.agentId,
    ticketId: run.ticketId,
    startedAt,
    completedAt,
    durationMs,
    status: run.status,
    totalModelRequests: runLogs.filter(log => log.type === 'model:request').length,
    totalModelResponses: runLogs.filter(log => log.type === 'model:response').length,
    totalWorkspaceReads: runLogs.filter(log => log.type === 'workspace:read').length,
    totalWorkspaceWrites: runLogs.filter(log => log.type === 'workspace:write').length,
    // This guard relies on createFolder logs setting workspaceAction.kind to 'folder'.
    totalFilesCreated: runLogs.filter(log => log.type === 'workspace:create' && (!log.workspaceAction || log.workspaceAction.kind !== 'folder')).length,
    totalFilesModified: runLogs.filter(log => log.type === 'workspace:write').length,
    totalFilesDeleted: runLogs.filter(log => log.type === 'workspace:delete').length,
    totalTokensUsed: totalTokens > 0 ? totalTokens : null,
    totalEstimatedCost: null
  };
}

function average(values) {
  const numericValues = values.filter(value => typeof value === 'number' && Number.isFinite(value));
  if (numericValues.length === 0) return null;
  return numericValues.reduce((total, value) => total + value, 0) / numericValues.length;
}

function getAgentPerformanceMetrics() {
  const runs = readRuns();
  const logs = readLogs();
  const runsByAgentId = groupBy(runs, run => run.agentId);
  const logsByRunId = groupBy(logs, log => log.runId);
  const workspaceActionTypes = new Set([
    'workspace:list',
    'workspace:read',
    'workspace:write',
    'workspace:create',
    'workspace:rename',
    'workspace:delete'
  ]);

  return readAgents().map(agent => {
    const agentRuns = runsByAgentId.get(agent.id) || [];
    const runMetrics = agentRuns.map(run => buildRunMetrics(run, logsByRunId.get(run.id) || []));
    const completedRuns = runMetrics.filter(run => run.status === 'completed');
    const failedRuns = runMetrics.filter(run => run.status === 'failed');
    const activeRuns = runMetrics.filter(run => ['pending', 'running'].includes(run.status));
    const totalWorkspaceActions = agentRuns.reduce((total, run) => {
      return total + (logsByRunId.get(run.id) || []).filter(log => workspaceActionTypes.has(log.type)).length;
    }, 0);
    const lastRun = agentRuns
      .slice()
      .sort((a, b) => new Date(b.updatedAt || b.completedAt || b.startedAt || b.createdAt || 0) - new Date(a.updatedAt || a.completedAt || a.startedAt || a.createdAt || 0))[0];

    return {
      agent,
      runMetrics,
      totalRuns: runMetrics.length,
      successfulRuns: completedRuns.length,
      failedRuns: failedRuns.length,
      activeRuns: activeRuns.length,
      averageDurationMs: average(runMetrics.map(run => run.durationMs)),
      averageTokenUsage: average(runMetrics.map(run => run.totalTokensUsed)),
      averageEstimatedCost: null,
      totalWorkspaceActions,
      lastRunTimestamp: lastRun ? (lastRun.completedAt || lastRun.startedAt || lastRun.createdAt || null) : null
    };
  });
}

function getTicketAssignableGroups() {
  return readGroups().filter(group => group.canReceiveTickets === true);
}

function getMembershipGroups() {
  return readGroups();
}

function getPrincipalGroupIds(principalType, principalId) {
  return readMemberships()
    .filter(membership => membership.principalType === principalType && membership.principalId === principalId)
    .map(membership => membership.groupId);
}

function getGroupPermissionNames(groupId) {
  const group = readGroups().find(item => item.id === groupId);
  return group && Array.isArray(group.permissions) ? group.permissions : [];
}

function renderAdminUserForm(reply, request, options = {}) {
  const accountType = options.accountType === 'agent' ? 'agent' : 'user';
  const editAccount = options.editAccount || null;
  const userGroups = options.userGroups ?? (
    editAccount ? getPrincipalGroupIds(accountType, editAccount.id) : []
  );

  return reply.view('admin/user-form.ejs', viewData({
    user: request.user,
    editAccount,
    accountType,
    groups: getMembershipGroups(),
    userGroups,
    providers: PROVIDERS,
    models: MODELS,
    hasOpenAIApiKeyFallback: Boolean(String(process.env.OPENAI_API_KEY || '').trim()),
    hasOpenAIModelFallback: Boolean(String(process.env.OPENAI_MODEL || '').trim()),
    hasOllamaModelFallback: Boolean(String(process.env.OLLAMA_MODEL || '').trim()),
    error: options.error || null
  }, request.session.userId));
}

function renderAdminGroupForm(reply, request, options = {}) {
  const editGroup = options.editGroup || null;
  const groupPermissions = options.groupPermissions ?? (editGroup ? getGroupPermissionNames(editGroup.id) : []);

  return reply.view('admin/group-form.ejs', viewData({
    user: request.user,
    editGroup,
    allPermissions: readPermissions(),
    groupPermissions,
    error: options.error || null
  }, request.session.userId));
}

// ==================== PERMISSION SYSTEM ====================

function getUserPermissions(userId) {
  const userGroupIds = getPrincipalGroupIds('user', userId);
  const groups = readGroups();
  const permissions = new Set();
  
  groups.forEach(group => {
    if (userGroupIds.includes(group.id)) {
      group.permissions.forEach(permission => permissions.add(permission));
    }
  });
  
  return Array.from(permissions);
}

function hasPermission(userId, permission) {
  const userPermissions = getUserPermissions(userId);
  return userPermissions.includes(permission);
}

// ==================== AGENT RUNS ====================

function updateRunStatus(runId, status, error = null) {
  const runs = readRuns();
  const run = runs.find(item => item.id === runId);

  if (!run) return null;
  if (run.status === 'interrupted' && status !== 'interrupted') return run;
  if (run.status === status && !error) return run;

  run.status = status;
  run.updatedAt = new Date().toISOString();
  if (status === 'running') run.startedAt = run.startedAt || run.updatedAt;
  if (status === 'completed' || status === 'failed' || status === 'interrupted') run.completedAt = run.updatedAt;
  if (error) run.error = sanitizeLogMessage(error);
  writeRuns(runs);
  updateAllocationItemStatus(run, status);
  return run;
}

function updateRunReplaySnapshot(runId, updater) {
  const run = readRuns().find(item => item.id === runId);

  if (!run) return null;

  const currentSnapshot = readRunReplaySnapshot(run);
  const nextSnapshot = updater(currentSnapshot);
  if (!nextSnapshot) return null;
  return writeRunReplaySnapshot(runId, nextSnapshot);
}

function createReplaySnapshotBase(run, overrides = {}) {
  return {
    version: 1,
    runId: run.id,
    ticketId: run.ticketId,
    assignedAgentId: run.agentId,
    agentNameSnapshot: run.agentName,
    primitiveContract: {
      allowedOperations: [...AGENT_ALLOWED_OPERATIONS],
      mutatingOperations: [...AGENT_MUTATING_OPERATIONS],
      requiredArgs: AGENT_OPERATION_ARGS
    },
    workspaceRoot: run.workspaceRoot || workspaceProvider.root,
    mainWorkspaceRoot: run.mainWorkspaceRoot || workspaceProvider.root,
    executionWorkspaceType: run.executionWorkspaceType || 'main',
    allocationPlanId: run.allocationPlanId || null,
    allocationItemId: run.allocationItemId || null,
    allocationItem: getRunAllocationItem(run),
    allocationSubtask: run.allocationSubtask || null,
    ownedOutputPaths: getRunOwnedOutputPaths(run),
    ticketOpenedAt: run.ticketOpenedAt || null,
    runtimeLimits: getAgentRuntimeLimits(),
    providerRequests: [],
    modelResponses: [],
    parsedModelPlans: [],
    workspaceOperations: [],
    events: [],
    terminalStatus: null,
    failureReason: null,
    createdAt: new Date().toISOString(),
    ...overrides
  };
}

function createRunReplaySnapshot(run, ticket, agent, providerConfig, runtimeEnvelope, systemInstructionSnapshot) {
  updateRunReplaySnapshot(run.id, currentSnapshot => currentSnapshot || createReplaySnapshotBase(run, {
    provider: providerConfig.provider,
    model: providerConfig.model,
    runtimeEnvelope,
    ticketObjectiveSnapshot: ticket.objective,
    systemInstructionSnapshot
  }));
}

function appendRunReplaySnapshotItem(runId, key, item) {
  updateRunReplaySnapshot(runId, snapshot => {
    if (!snapshot) return snapshot;
    const items = Array.isArray(snapshot[key]) ? snapshot[key] : [];

    return {
      ...snapshot,
      [key]: [...items, { ...item, capturedAt: new Date().toISOString() }]
    };
  });
}

function recordRunEvent(run, type, message, details = {}) {
  appendRunLog(run, type, message);
  appendRunReplaySnapshotItem(run.id, 'events', {
    type,
    message,
    ...details
  });
}

function recordReplayEvent(run, type, message, details = {}) {
  appendRunReplaySnapshotItem(run.id, 'events', {
    type,
    message,
    ...details
  });
}

function getPositiveIntegerEnv(name, fallback) {
  const value = parseInt(process.env[name] || '', 10);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function getAgentRuntimeLimits() {
  return {
    maxExecutionSteps: getPositiveIntegerEnv('AGENT_MAX_EXECUTION_STEPS', DEFAULT_AGENT_RUNTIME_LIMITS.maxExecutionSteps),
    maxWorkspaceOperationsPerRun: getPositiveIntegerEnv('AGENT_MAX_WORKSPACE_OPERATIONS_PER_RUN', DEFAULT_AGENT_RUNTIME_LIMITS.maxWorkspaceOperationsPerRun),
    maxModelRequestsPerRun: getPositiveIntegerEnv('AGENT_MAX_MODEL_REQUESTS_PER_RUN', DEFAULT_AGENT_RUNTIME_LIMITS.maxModelRequestsPerRun),
    maxRuntimeDurationMs: getPositiveIntegerEnv('AGENT_MAX_RUNTIME_DURATION_MS', DEFAULT_AGENT_RUNTIME_LIMITS.maxRuntimeDurationMs)
  };
}

function createRunLimitError(run, type, message, details) {
  const eventTypeByLimitType = {
    step: 'run:step_limit',
    operation: 'run:operation_limit',
    model_request: 'run:model_request_limit',
    mutating_action: 'run:mutating_action_limit',
    timeout: 'run:timeout'
  };
  const eventType = eventTypeByLimitType[type];

  recordRunEvent(run, eventType, message, {
    limitType: type,
    ...details
  });

  const error = new Error(message);
  error.code = 'RUN_LIMIT_EXCEEDED';
  error.limitType = type;
  error.details = details || {};
  return error;
}

function assertRunNotTimedOut(run, startedAtMs, limits) {
  const elapsedMs = Date.now() - startedAtMs;

  if (elapsedMs > limits.maxRuntimeDurationMs) {
    throw createRunLimitError(run, 'timeout', `Agent run exceeded runtime duration limit of ${limits.maxRuntimeDurationMs}ms`, {
      currentValue: elapsedMs,
      configuredLimit: limits.maxRuntimeDurationMs
    });
  }
}

function getRemainingRunTimeMs(startedAtMs, limits) {
  return Math.max(0, limits.maxRuntimeDurationMs - (Date.now() - startedAtMs));
}

async function callModelProviderWithRunTimeout(run, agent, input, startedAtMs, limits, options = {}) {
  const remainingMs = getRemainingRunTimeMs(startedAtMs, limits);

  if (remainingMs <= 0) {
    throw createRunLimitError(run, 'timeout', `Agent run exceeded runtime duration limit of ${limits.maxRuntimeDurationMs}ms`, {
      currentValue: Date.now() - startedAtMs,
      configuredLimit: limits.maxRuntimeDurationMs
    });
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), remainingMs);

  try {
    return await callModelProvider(agent, input, {
      signal: controller.signal,
      onRequest: options.onRequest
    });
  } catch (error) {
    if (error && error.name === 'AbortError') {
      throw createRunLimitError(run, 'timeout', `Agent run exceeded runtime duration limit of ${limits.maxRuntimeDurationMs}ms`, {
        currentValue: Date.now() - startedAtMs,
        configuredLimit: limits.maxRuntimeDurationMs
      });
    }

    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function assertRunModelRequestAllowed(run, currentCount, limits) {
  if (currentCount >= limits.maxModelRequestsPerRun) {
    throw createRunLimitError(run, 'model_request', `Agent run exceeded model request limit of ${limits.maxModelRequestsPerRun}`, {
      currentValue: currentCount,
      configuredLimit: limits.maxModelRequestsPerRun
    });
  }
}

function assertRunStepAllowed(run, currentStep, limits) {
  if (currentStep >= limits.maxExecutionSteps) {
    throw createRunLimitError(run, 'step', `Agent run exceeded execution step limit of ${limits.maxExecutionSteps}`, {
      currentValue: currentStep,
      configuredLimit: limits.maxExecutionSteps
    });
  }
}

function assertRunWorkspaceOperationAllowed(run, currentCount, incomingCount, limits) {
  const nextCount = currentCount + incomingCount;

  if (nextCount > limits.maxWorkspaceOperationsPerRun) {
    throw createRunLimitError(run, 'operation', `Agent run exceeded workspace operation limit of ${limits.maxWorkspaceOperationsPerRun}`, {
      currentValue: nextCount,
      configuredLimit: limits.maxWorkspaceOperationsPerRun
    });
  }
}

function buildFailureMetadata(error, status, failureReason = null, detail = {}) {
  if (status === 'interrupted') {
    return {
      code: 'RUN_INTERRUPTED',
      kind: 'interrupted',
      detail: {
        ...(failureReason ? { reason: sanitizeLogMessage(failureReason) } : {}),
        ...sanitizeSnapshotValue(detail)
      }
    };
  }

  if (!error) return null;

  if (error.failureKind) {
    return {
      code: error.code || error.failureCode || null,
      kind: error.failureKind,
      detail: sanitizeSnapshotValue(error.details || {})
    };
  }

  if (error.code === 'RUN_LIMIT_EXCEEDED') {
    return {
      code: error.code,
      kind: error.limitType === 'timeout' ? 'timeout' : 'budget_exhausted',
      detail: sanitizeSnapshotValue({
        limitType: error.limitType || null,
        ...(error.details || {})
      })
    };
  }

  if (error.code === 'WORKSPACE_PROTECTED_PATH') {
    return {
      code: error.code,
      kind: 'protected_path',
      detail: sanitizeSnapshotValue({
        operation: error.operation || null,
        path: error.path || null,
        reason: error.reason || null
      })
    };
  }

  if (error.code === 'WORKSPACE_OWNERSHIP_VIOLATION') {
    return {
      code: error.code,
      kind: 'protected_path',
      detail: sanitizeSnapshotValue({
        operation: error.operation || null,
        path: error.path || null,
        reason: error.reason || null
      })
    };
  }

  return null;
}

// mutationCount parameter is reserved but never passed by callers; count is always derived.
function finalizeRunReplaySnapshot(run, status, failureReason = null, mutationCount = null, failure = null) {
  const effectiveMutationCount = mutationCount !== null ? mutationCount : countRunMutatingOperations(run.id);
  updateRunReplaySnapshot(run.id, snapshot => snapshot ? {
    ...snapshot,
    terminalStatus: status,
    failureReason: failureReason ? sanitizeLogMessage(failureReason) : null,
    failure: failure ? sanitizeSnapshotValue(failure) : null,
    mutationOutcome: effectiveMutationCount === 0 ? 'no_mutations' : status === 'completed' ? 'all_intended' : 'partial_mutations',
    mutationCount: effectiveMutationCount,
    finalizedAt: new Date().toISOString()
  } : snapshot);
}

function classifyInterruptionPhase(run) {
  const latestRun = readRuns().find(item => item.id === run.id) || run;
  const snapshot = readRunReplaySnapshot(latestRun) || latestRun.replaySnapshot || {};
  const logs = readLogs().filter(log => log.runId === run.id);
  const providerRequestLogs = logs.filter(log => log.type === 'model:request').length;
  const providerResponseLogs = logs.filter(log => log.type === 'model:response').length;
  const providerRequests = Array.isArray(snapshot.providerRequests) ? snapshot.providerRequests.length : 0;
  const modelResponses = Array.isArray(snapshot.modelResponses) ? snapshot.modelResponses.length : 0;
  const parsedPlans = Array.isArray(snapshot.parsedModelPlans) ? snapshot.parsedModelPlans.length : 0;
  const workspaceOperations = Array.isArray(snapshot.workspaceOperations) ? snapshot.workspaceOperations.length : 0;

  if (workspaceOperations > 0) return 'after_workspace_operation';
  if (parsedPlans > 0) return 'after_model_plan';
  if (modelResponses > 0 || providerResponseLogs > 0) return 'after_provider_response';
  if (providerRequestLogs > providerResponseLogs) return 'during_provider_call';
  if (providerRequests > 0 || providerRequestLogs > 0) return 'after_provider_request';
  if (latestRun.status === 'pending' || !latestRun.startedAt) return 'before_provider_call';
  return 'unknown';
}

function ensureInterruptedRunReplaySnapshot(run, reason, phase = null) {
  const ticket = readTickets().find(item => item.id === run.ticketId) || null;
  const agent = readAgents().find(item => item.id === run.agentId) || null;

  updateRunReplaySnapshot(run.id, snapshot => snapshot || createReplaySnapshotBase(run, {
    agentNameSnapshot: run.agentName || (agent ? agent.name : 'Unknown agent'),
    provider: agent ? (agent.provider || 'openai') : null,
    model: agent ? (agent.model || null) : null,
    runtimeEnvelope: null,
    ticketObjectiveSnapshot: ticket ? ticket.objective : null,
    systemInstructionSnapshot: null,
    primitiveContract: {
      allowedOperations: [...AGENT_ALLOWED_OPERATIONS],
      mutatingOperations: [...AGENT_MUTATING_OPERATIONS]
    },
    note: 'Run was interrupted before execution snapshot capture completed'
  }));

  recordReplayEvent(run, 'run:interrupted', reason, phase ? { phase } : {});
}

function runExecutionKey(run) {
  return `${run.ticketId}:${run.agentId}`;
}

function isRunInterrupted(runId) {
  return readRuns().some(run => run.id === runId && run.status === 'interrupted');
}

function getAgentsInGroup(groupId) {
  const agentIds = new Set(readMemberships()
    .filter(membership => membership.principalType === 'agent' && membership.groupId === groupId)
    .map(membership => membership.principalId));

  return readAgents().filter(agent => agentIds.has(agent.id));
}

function getAgentGroupMembers() {
  const memberships = readMemberships().filter(m => m.principalType === 'agent');
  const agents = readAgents();
  const agentMap = Object.fromEntries(agents.map(a => [a.id, a]));
  const groupMap = {};

  for (const m of memberships) {
    if (!groupMap[m.groupId]) groupMap[m.groupId] = [];
    const agent = agentMap[m.principalId];
    if (agent) {
      groupMap[m.groupId].push({ id: agent.id, name: agent.name });
    }
  }

  return groupMap;
}

function deriveDynamicOwnedPaths(agents) {
  if (agents.length === 0) {
    throw new Error('Dynamic allocation rejected: selected group has no agents');
  }

  const rootListing = workspaceProvider.list('');

  const candidates = rootListing.entries
    .filter(e => e.type === 'folder')
    .filter(e => e.name !== 'data')
    .sort((a, b) => a.name.localeCompare(b.name));

  if (candidates.length < agents.length) {
    const error = new Error(
      `Dynamic allocation rejected: only ${candidates.length} usable workspace director${candidates.length === 1 ? 'y' : 'ies'} found, need ${agents.length} for ${agents.length} agent${agents.length === 1 ? '' : 's'}`
    );
    error.code = 'DYNAMIC_ALLOCATION_INSUFFICIENT_SCOPES';
    throw error;
  }

  const sortedAgents = [...agents].sort((a, b) => a.id - b.id);
  const pathMap = {};

  sortedAgents.forEach((agent, index) => {
    pathMap[agent.id] = candidates[index].path;
  });

  return pathMap;
}

function usesOwnedScopeAllocation(ticket) {
  return ticket &&
    ticket.assignmentTargetType === 'group' &&
    (ticket.assignmentMode === 'allocated' || ticket.assignmentMode === 'dynamic');
}

function getRunWorkspaceProvider(run) {
  return workspaceProvider;
}

function normalizeWorkspaceOwnershipPath(relativePath) {
  const normalized = path.posix.normalize(String(relativePath || '').replace(/\\/g, '/').trim());
  const cleanPath = normalized === '.' ? '' : normalized.replace(/^\/+/, '');

  if (!cleanPath) return '';
  return cleanPath.endsWith('/') ? cleanPath : `${cleanPath}/`;
}

function isPathInsideOwnedOutputPaths(relativePath, ownedOutputPaths) {
  const normalizedPath = path.posix.normalize(String(relativePath || '').replace(/\\/g, '/').trim()).replace(/^\/+/, '');

  return ownedOutputPaths.some(ownedPath => {
    const normalizedOwnedPath = normalizeWorkspaceOwnershipPath(ownedPath);
    return normalizedPath === normalizedOwnedPath.slice(0, -1) || normalizedPath.startsWith(normalizedOwnedPath);
  });
}

function createWorkspaceOwnershipError(run, operation, relativePath) {
  const error = new Error(`Workspace operation blocked outside owned output paths: ${operation} ${relativePath}`);

  error.code = 'WORKSPACE_OWNERSHIP_VIOLATION';
  error.operation = operation;
  error.path = relativePath;
  error.reason = 'Owned-scope runs may only mutate owned output paths';
  error.ownedOutputPaths = getRunOwnedOutputPaths(run);
  return error;
}

function blockWorkspaceOwnershipViolation(run, operation, args, relativePath, runWorkspaceProvider) {
  const error = createWorkspaceOwnershipError(run, operation, relativePath);
  const workspaceAction = {
    operation,
    args,
    path: relativePath,
    workspaceRoot: runWorkspaceProvider ? runWorkspaceProvider.root : null,
    executionWorkspaceType: run.executionWorkspaceType || 'main',
    allocationPlanId: run.allocationPlanId || null,
    allocationItemId: run.allocationItemId || null,
    ownedOutputPaths: getRunOwnedOutputPaths(run),
    blocked: true,
    reason: error.reason
  };

  appendRunLog(run, 'workspace:ownership_blocked', error.message, workspaceAction);
  error.workspaceAction = workspaceAction;
  throw error;
}

function buildWorkspaceActionMetadata(run, runWorkspaceProvider, extra = {}) {
  return {
    ...extra,
    workspaceRoot: runWorkspaceProvider ? runWorkspaceProvider.root : null,
    executionWorkspaceType: run.executionWorkspaceType || 'main',
    allocationPlanId: run.allocationPlanId || null,
    allocationItemId: run.allocationItemId || null,
    ownedOutputPaths: getRunOwnedOutputPaths(run)
  };
}

function assertAllocatedOwnershipAllowsMutation(run, operation, args, relativePath, runWorkspaceProvider) {
  if (run.executionWorkspaceType !== 'main_owned_paths') return;

  if (!isPathInsideOwnedOutputPaths(relativePath, getRunOwnedOutputPaths(run))) {
    blockWorkspaceOwnershipViolation(run, operation, args, relativePath, runWorkspaceProvider);
  }
}

function assertNoOverlappingOwnedPaths(planItems) {
  const ownedPaths = planItems.flatMap(item => item.ownedOutputPaths.map(normalizeWorkspaceOwnershipPath));

  ownedPaths.forEach((ownedPath, index) => {
    ownedPaths.forEach((otherPath, otherIndex) => {
      if (index === otherIndex) return;
      if (ownedPath === otherPath || ownedPath.startsWith(otherPath) || otherPath.startsWith(ownedPath)) {
        throw new Error(`Owned-scope paths overlap: ${ownedPath} and ${otherPath}`);
      }
    });
  });
}

function assertAllocatedOwnedPathsExist(planItems) {
  planItems.forEach(item => {
    (item.ownedOutputPaths || []).forEach(ownedPath => {
      const normalizedPath = normalizeWorkspaceOwnershipPath(ownedPath);
      const info = workspaceProvider.getPathInfo(normalizedPath, { allowHidden: true });

      if (!info.exists) {
        const error = new Error(`Owned-scope path does not exist: ${normalizedPath}`);
        error.code = 'WORKSPACE_ALLOCATION_PATH_MISSING';
        error.path = normalizedPath;
        error.assignedAgentId = item.assignedAgentId || null;
        throw error;
      }

      if (info.type !== 'directory') {
        const error = new Error(`Owned-scope path is not a directory: ${normalizedPath}`);
        error.code = 'WORKSPACE_ALLOCATION_NOT_DIRECTORY';
        error.path = normalizedPath;
        error.assignedAgentId = item.assignedAgentId || null;
        throw error;
      }
    });
  });
}

function assertAllocatedTicketCanStart(ticket, agents) {
  const planDraft = buildAllocatedOwnershipPlan(ticket, agents);
  assertAllocatedOwnedPathsExist(planDraft.items);
  return planDraft;
}

function assertAllocatedObjectiveSupported(objective) {
  const normalizedObjective = String(objective || '').toLowerCase();
  const destructivePattern = /\b(delete|remove|rename|move|refactor|fix|modify|overwrite|update existing|edit|cleanup|clean up|restructure|reorganize|replace)\b/;
  const additivePattern = /\b(file|files|folder|folders|report|reports|proposal|proposals|doc|docs|document|documents|fixture|fixtures|variant|variants|draft|drafts|analysis|analyses|deliverable|deliverables)\b/;

  if (destructivePattern.test(normalizedObjective)) {
    throw new Error('Owned-scope execution rejected: objective appears destructive or edits existing workspace state');
  }

  if (!additivePattern.test(normalizedObjective)) {
    throw new Error('Owned-scope execution rejected: objective does not clearly describe additive independent outputs');
  }
}

function buildAllocatedOwnershipPlan(ticket, agents) {
  assertAllocatedObjectiveSupported(ticket.objective);

  if (agents.length === 0) {
    throw new Error('Owned-scope execution rejected: selected group has no agents');
  }

  const userPaths = (typeof ticket.ownedOutputPaths === 'object' && ticket.ownedOutputPaths !== null && !Array.isArray(ticket.ownedOutputPaths))
    ? ticket.ownedOutputPaths
    : {};

  if (Object.keys(userPaths).length === 0) {
    throw new Error('Owned-scope execution rejected: ownedOutputPaths are required');
  }

  const missing = agents.filter(a => !userPaths[a.id]);
  if (missing.length > 0) {
    throw new Error(`Owned-scope execution rejected: missing owned output path for agent(s): ${missing.map(a => `${a.id} (${a.name})`).join(', ')}`);
  }

  const items = agents.map(agent => ({
    assignedAgentId: agent.id,
    allocationSubtask: `Produce your allocated output for ticket ${ticket.id} inside your owned path only.`,
    ownedOutputPaths: [normalizeWorkspaceOwnershipPath(userPaths[agent.id])]
  }));

  assertNoOverlappingOwnedPaths(items);
  return {
    ticketId: ticket.id,
    ticketOpenedAt: ticket.updatedAt,
    mode: 'owned_paths',
    status: 'pending',
    items
  };
}

function createAllocationPlan(ticket, agents) {
  const plans = readAllocationPlans();
  const planDraft = buildAllocatedOwnershipPlan(ticket, agents);
  assertAllocatedOwnedPathsExist(planDraft.items);
  const now = new Date().toISOString();
  const nextPlanId = nextId(plans);
  const maxItemId = plans.flatMap(plan => plan.items || []).reduce((maxId, item) => {
    return Math.max(maxId, parseInt(item.allocationItemId, 10) || 0);
  }, 0);
  const plan = {
    id: nextPlanId,
    ticketId: ticket.id,
    ticketOpenedAt: ticket.updatedAt,
    mode: planDraft.mode,
    status: 'pending',
    createdAt: now,
    items: planDraft.items.map((item, index) => ({
      allocationItemId: maxItemId + index + 1,
      allocationSubtask: item.allocationSubtask,
      ownedOutputPaths: item.ownedOutputPaths.map(normalizeWorkspaceOwnershipPath),
      assignedAgentId: item.assignedAgentId,
      status: 'pending',
      createdAt: now
    }))
  };

  writeAllocationPlans([...plans, plan]);
  return plan;
}

function findAllocationPlan(planId) {
  return readAllocationPlans().find(plan => plan.id === planId) || null;
}

function findAllocationItem(planId, itemId) {
  const plan = findAllocationPlan(planId);
  if (!plan) return null;
  return (plan.items || []).find(item => item.allocationItemId === itemId) || null;
}

function getRunAllocationItem(run) {
  if (!run || !run.allocationPlanId || !run.allocationItemId) return null;
  return findAllocationItem(run.allocationPlanId, run.allocationItemId);
}

function getRunOwnedOutputPaths(run) {
  const allocationItem = getRunAllocationItem(run);
  if (allocationItem && Array.isArray(allocationItem.ownedOutputPaths)) {
    return allocationItem.ownedOutputPaths;
  }

  return run.ownedOutputPaths || [];
}

function getTicketAllocationPlan(ticketId) {
  return readAllocationPlans().find(plan => plan.ticketId === ticketId) || null;
}

function getTicketRuns(ticketId, history = readOperationHistory()) {
  const runs = readRuns().filter(run => run.ticketId === ticketId);
  const agents = readAgents();
  const mutationCountByRunId = buildMutationCountByRunId(history);
  return runs.map(run => {
    const partialMutationCount = mutationCountByRunId.get(run.id) || 0;
    return {
      ...run,
      agentName: agents.find(agent => agent.id === run.agentId)?.name || `Agent ${run.agentId}`,
      partialMutationCount,
      operationalOutcome: classifyRunOperationalOutcome(run)
    };
  });
}

function getRecentLogsForTicket(ticketId, limit = 5) {
  const logs = readLogs();
  const recentLogs = [];

  for (let index = logs.length - 1; index >= 0 && recentLogs.length < limit; index -= 1) {
    if (logs[index].ticketId === ticketId) recentLogs.push(logs[index]);
  }

  return sanitizeWorkspaceDisplayValue(recentLogs.reverse());
}

function getRecentLogsForRun(runId, limit = 5) {
  const logs = readLogs();
  const recentLogs = [];

  for (let index = logs.length - 1; index >= 0 && recentLogs.length < limit; index -= 1) {
    if (logs[index].runId === runId) recentLogs.push(logs[index]);
  }

  return sanitizeWorkspaceDisplayValue(recentLogs.reverse());
}

function updateAllocationItemStatus(run, status) {
  if (!run || !run.allocationPlanId || !run.allocationItemId) return null;

  const plans = readAllocationPlans();
  const plan = plans.find(item => item.id === run.allocationPlanId);
  if (!plan) return null;
  const allocationItem = (plan.items || []).find(item => item.allocationItemId === run.allocationItemId);
  if (!allocationItem) return null;

  allocationItem.status = status;
  plan.status = plan.items.some(item => item.status === 'failed') ? 'failed'
    : plan.items.some(item => item.status === 'interrupted') ? 'interrupted'
      : plan.items.every(item => item.status === 'completed') ? 'completed'
        : plan.items.some(item => item.status === 'running') ? 'running'
          : 'pending';
  writeAllocationPlans(plans);
  return allocationItem;
}

function updateTicketInProgressForRun(run) {
  const ticket = readTickets().find(item => item.id === run.ticketId);

  if (!ticket || ticket.status !== 'open') return ticket || null;
  return updateTicketStatusById(run.ticketId, 'in_progress');
}

function finalizeTicketForRun(run, terminalStatus) {
  const ticket = readTickets().find(item => item.id === run.ticketId);

  if (!ticket) return null;

  if (!usesOwnedScopeAllocation(ticket)) {
    return updateTicketStatusById(run.ticketId, terminalStatus);
  }

  const batchRuns = readRuns().filter(item =>
    item.ticketId === run.ticketId &&
    item.ticketOpenedAt === run.ticketOpenedAt
  );

  if (terminalStatus === 'failed' || batchRuns.some(item => item.status === 'failed')) {
    return updateTicketStatusById(run.ticketId, 'failed');
  }

  if (batchRuns.length > 0 && batchRuns.every(item => item.status === 'completed')) {
    return updateTicketStatusById(run.ticketId, 'completed');
  }

  return ticket;
}

function updateTicketAfterRunInterrupted(run) {
  const ticket = readTickets().find(item => item.id === run.ticketId);

  if (!ticket || ticket.status !== 'in_progress') return ticket || null;

  const currentBatchRuns = readRuns().filter(item =>
    item.ticketId === run.ticketId &&
    item.ticketOpenedAt === run.ticketOpenedAt
  );
  const hasActiveCurrentBatchRun = currentBatchRuns.some(item => ['pending', 'running'].includes(item.status));

  if (hasActiveCurrentBatchRun) return ticket;
  return updateTicketStatusById(run.ticketId, 'open');
}

function allocationLogSuffix(run) {
  if (!run || !run.allocationPlanId || !run.allocationItemId) return '';
  return ` (allocation plan ${run.allocationPlanId}, item ${run.allocationItemId})`;
}

function interruptAgentRun(run, reason) {
  const phase = classifyInterruptionPhase(run);
  ensureInterruptedRunReplaySnapshot(run, reason, phase);
  const interruptedRun = updateRunStatus(run.id, 'interrupted', reason) || {
    ...run,
    status: 'interrupted',
    updatedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    error: sanitizeLogMessage(reason)
  };

  const failure = buildFailureMetadata(null, 'interrupted', reason, { phase });
  finalizeRunReplaySnapshot(interruptedRun, 'interrupted', reason, null, failure);
  appendRunLog(interruptedRun, 'run:interrupted', `${reason}${allocationLogSuffix(interruptedRun)}`, null, {
    allocationPlanId: interruptedRun.allocationPlanId || null,
    allocationItemId: interruptedRun.allocationItemId || null,
    phase,
    failure
  });
  runningRunKeys.delete(runExecutionKey(interruptedRun));
  updateTicketAfterRunInterrupted(interruptedRun);
  return interruptedRun;
}

function forceTicketOpenForRerun(ticketId) {
  const tickets = readTickets();
  const ticket = tickets.find(item => item.id === ticketId);

  if (!ticket) return null;

  ticket.status = 'open';
  ticket.updatedAt = new Date().toISOString();
  writeTickets(tickets);
  broadcastTicketChange();
  return ticket;
}

function rerunTicketFromBeginning(ticketId, changedBy = 'operator') {
  const ticket = readTickets().find(item => item.id === ticketId);

  if (!ticket) return null;

  if (usesOwnedScopeAllocation(ticket)) {
    assertAllocatedTicketCanStart({
      ...ticket,
      status: 'open',
      updatedAt: new Date().toISOString()
    }, getAgentsInGroup(ticket.assignmentTargetId));
  }

  readRuns()
    .filter(run => run.ticketId === ticketId && ['pending', 'running'].includes(run.status))
    .forEach(run => interruptAgentRun(run, `${changedBy} rerun requested`));

  const reopenedTicket = forceTicketOpenForRerun(ticketId);
  appendSystemLog('ticket:rerun', `Ticket #${ticketId} rerun requested by ${changedBy}`, null, {
    ticketId,
    changedBy,
    changedAt: new Date().toISOString()
  });
  maybeStartTicketRuns(reopenedTicket);
  return reopenedTicket;
}

function interruptStaleRunsOnStartup() {
  const staleRuns = readRuns().filter(run => ['pending', 'running'].includes(run.status));

  staleRuns.forEach(run => {
    interruptAgentRun(run, 'process restarted before run completed');
  });

  if (staleRuns.length > 0) {
    console.log(`Marked ${staleRuns.length} stale agent run(s) interrupted`);
  }
}

function failAgentRun(run, error, workspaceAction = null) {
  let message = error && error.message ? error.message : String(error || 'Agent run failed');
  const failure = buildFailureMetadata(error, 'failed', message);

  if (error && error.code === 'RUN_LIMIT_EXCEEDED' && error.limitType === 'step') {
    const mutationCount = countRunMutatingOperations(run.id);
    if (mutationCount > 0) {
      message = `${message} The model performed ${mutationCount} successful workspace mutation${mutationCount === 1 ? '' : 's'} but did not signal completion before the limit was reached.`;
    }
  }

  const failedRun = updateRunStatus(run.id, 'failed', message) || {
    ...run,
    status: 'failed',
    updatedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    error: sanitizeLogMessage(message)
  };

  if (failedRun.status === 'interrupted') return failedRun;
  finalizeRunReplaySnapshot(failedRun, 'failed', message, null, failure);
  appendRunLog(failedRun, 'run:failed', `${message}${allocationLogSuffix(failedRun)}`, workspaceAction, {
    allocationPlanId: failedRun.allocationPlanId || null,
    allocationItemId: failedRun.allocationItemId || null,
    failure
  });
  finalizeTicketForRun(failedRun, 'failed');
  return failedRun;
}

function completeAgentRun(run) {
  const completedRun = updateRunStatus(run.id, 'completed');
  if (completedRun.status === 'interrupted') return completedRun;
  finalizeRunReplaySnapshot(completedRun, 'completed');
  appendRunLog(completedRun, 'run:completed', `Agent run completed${allocationLogSuffix(completedRun)}`, null, {
    allocationPlanId: completedRun.allocationPlanId || null,
    allocationItemId: completedRun.allocationItemId || null
  });
  finalizeTicketForRun(completedRun, 'completed');
  return completedRun;
}

function createAgentRun(ticket, agent, allocationItem = null, allocationPlanId = null) {
  const runs = readRuns();
  const activeRun = runs.find(run =>
    run.ticketId === ticket.id &&
    run.agentId === agent.id &&
    ['pending', 'running'].includes(run.status)
  );
  const pendingRunKey = `${ticket.id}:${agent.id}`;

  if (activeRun || runningRunKeys.has(pendingRunKey)) return activeRun || null;
  if (usesOwnedScopeAllocation(ticket) && (!allocationPlanId || !allocationItem)) {
    throw new Error('Owned-scope run creation requires an allocation plan item');
  }

  const now = new Date().toISOString();
  const isRerun = runs.some(run => run.ticketId === ticket.id);
  const usesOwnedScope = usesOwnedScopeAllocation(ticket);
  const nextRunId = nextId(runs);
  const ownedOutputPaths = allocationItem ? allocationItem.ownedOutputPaths.map(normalizeWorkspaceOwnershipPath) : [];
  const run = {
    id: nextRunId,
    ticketId: ticket.id,
    agentId: agent.id,
    agentName: agent.name,
    workspaceRoot: workspaceProvider.root,
    mainWorkspaceRoot: workspaceProvider.root,
    executionWorkspaceType: usesOwnedScope ? 'main_owned_paths' : 'main',
    allocationPlanId: allocationPlanId || null,
    allocationItemId: allocationItem ? allocationItem.allocationItemId : null,
    allocationSubtask: allocationItem ? allocationItem.allocationSubtask : null,
    ownedOutputPaths,
    status: 'pending',
    ticketOpenedAt: ticket.updatedAt,
    createdAt: now,
    updatedAt: now
  };

  runs.push(run);
  writeRuns(runs);
  appendRunLog(run, 'run:created', `${isRerun ? 'Agent rerun created' : 'Agent run created'}${allocationLogSuffix(run)}`, null, {
    allocationPlanId: run.allocationPlanId,
    allocationItemId: run.allocationItemId
  });
  setImmediate(() => runAgentTicket(run.id));
  return run;
}

function maybeStartTicketRuns(ticket) {
  if (!ticket || ticket.status !== 'open') return [];

  if (ticket.assignmentTargetType === 'agent') {
    const agent = readAgents().find(item => item.id === ticket.assignmentTargetId);
    return agent ? [createAgentRun(ticket, agent)].filter(Boolean) : [];
  }

  if (usesOwnedScopeAllocation(ticket)) {
    const agents = getAgentsInGroup(ticket.assignmentTargetId);
    const existingRuns = readRuns();
    const agentsToRun = agents.filter(agent => {
      const pendingRunKey = `${ticket.id}:${agent.id}`;
      return !runningRunKeys.has(pendingRunKey) && !existingRuns.some(run =>
        run.ticketId === ticket.id &&
        run.agentId === agent.id &&
        ['pending', 'running'].includes(run.status)
      );
    });

    if (agentsToRun.length === 0) return [];

    const allocationPlan = createAllocationPlan(ticket, agentsToRun);

    return agentsToRun
      .map(agent => createAgentRun(
        ticket,
        agent,
        allocationPlan.items.find(item => item.assignedAgentId === agent.id),
        allocationPlan.id
      ))
      .filter(Boolean);
  }

  return [];
}

function parseModelActions(text) {
  try {
    const parsed = JSON.parse(text);
    return {
      message: parsed.message || '',
      actions: Array.isArray(parsed.actions) ? parsed.actions : [],
      complete: Boolean(parsed.complete),
      parseError: null
    };
  } catch (error) {
    return {
      message: text,
      actions: [],
      complete: false,
      parseError: error.message
    };
  }
}

function extractOpenAIText(data) {
  if (data.output_text) return data.output_text;

  const responseText = (data.output || [])
    .flatMap(item => item.content || [])
    .map(content => content.text || '')
    .filter(Boolean)
    .join('\n');

  if (responseText) return responseText;
  if (data.choices && data.choices[0] && data.choices[0].message) {
    return data.choices[0].message.content || '';
  }

  return JSON.stringify(data);
}

function getRuntimeTimezone() {
  return process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

function formatDateTimeForTimezone(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  }).formatToParts(date).reduce((values, part) => {
    if (part.type !== 'literal') values[part.type] = part.value;
    return values;
  }, {});

  const hour = parts.hour === '24' ? '00' : parts.hour;
  const localTimeAsUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(hour),
    Number(parts.minute),
    Number(parts.second)
  );
  const offsetMinutes = Math.round((localTimeAsUtc - date.getTime()) / 60000);
  const offsetSign = offsetMinutes >= 0 ? '+' : '-';
  const absoluteOffsetMinutes = Math.abs(offsetMinutes);
  const offsetHours = String(Math.floor(absoluteOffsetMinutes / 60)).padStart(2, '0');
  const offsetRemainder = String(absoluteOffsetMinutes % 60).padStart(2, '0');

  return `${parts.year}-${parts.month}-${parts.day}T${hour}:${parts.minute}:${parts.second}${offsetSign}${offsetHours}:${offsetRemainder}`;
}

function buildRuntimeEnvelope(run, step = 0) {
  const timezone = getRuntimeTimezone();
  const workspaceRoot = run.workspaceRoot || workspaceProvider.root;
  const limits = getAgentRuntimeLimits();

  return {
    runId: run.id,
    ticketId: run.ticketId,
    assignedAgentId: run.agentId,
    currentDateTime: formatDateTimeForTimezone(new Date(), timezone),
    timezone,
    workspaceRoot,
    mainWorkspaceRoot: run.mainWorkspaceRoot || workspaceProvider.root,
    executionWorkspaceType: run.executionWorkspaceType || 'main',
    allocationPlanId: run.allocationPlanId || null,
    allocationItemId: run.allocationItemId || null,
    allocationItem: getRunAllocationItem(run),
    allocationSubtask: run.allocationSubtask || null,
    ownedOutputPaths: getRunOwnedOutputPaths(run),
    allowedOperations: AGENT_ALLOWED_OPERATIONS,
    maxActionsPerResponse: MAX_AGENT_ACTIONS_PER_RESPONSE,
    maxMutatingActionsPerResponse: MAX_MUTATING_ACTIONS_PER_RESPONSE,
    currentStep: step,
    maxExecutionSteps: limits.maxExecutionSteps
  };
}

function countMutatingActions(actions) {
  return (actions || []).filter(action =>
    action && typeof action === 'object' && AGENT_MUTATING_OPERATIONS.includes(action.operation)
  ).length;
}

function parseTicketShapeSuggestion(text) {
  try {
    const parsed = JSON.parse(text);
    const suggestedObjective = typeof parsed.suggestedObjective === 'string'
      ? parsed.suggestedObjective.trim()
      : '';
    const expectedOutputs = Array.isArray(parsed.expectedOutputs)
      ? parsed.expectedOutputs.map(item => String(item || '').trim()).filter(Boolean).slice(0, 8)
      : [];
    const decomposition = Array.isArray(parsed.decomposition)
      ? parsed.decomposition.map(item => String(item || '').trim()).filter(Boolean).slice(0, 8)
      : [];
    const warnings = Array.isArray(parsed.warnings)
      ? parsed.warnings.map(item => String(item || '').trim()).filter(Boolean).slice(0, 5)
      : [];

    return {
      suggestedObjective,
      expectedOutputs,
      decomposition,
      warnings,
      tooBroadForOneRun: parsed.tooBroadForOneRun === true,
      groupModeFit: typeof parsed.groupModeFit === 'string' ? parsed.groupModeFit.trim() : '',
      parseError: null
    };
  } catch (error) {
    return {
      suggestedObjective: '',
      expectedOutputs: [],
      decomposition: [],
      warnings: ['The suggestion response was not valid JSON.'],
      tooBroadForOneRun: false,
      groupModeFit: '',
      parseError: error.message
    };
  }
}

function getTicketShapeAgent(body = {}) {
  const assignmentTargetType = body.assignmentTargetType === 'agent' ? 'agent' : null;
  const assignmentTargetId = parseInt(body.assignmentTargetId, 10);

  if (assignmentTargetType === 'agent' && !Number.isNaN(assignmentTargetId)) {
    const selectedAgent = readAgents().find(agent => agent.id === assignmentTargetId);
    if (selectedAgent) return selectedAgent;
  }

  return {
    id: null,
    name: 'Ticket shaping assistant',
    provider: process.env.OLLAMA_MODEL && !process.env.OPENAI_MODEL ? 'ollama' : 'openai',
    apiKey: process.env.OPENAI_API_KEY || '',
    model: process.env.OPENAI_MODEL || process.env.OLLAMA_MODEL || ''
  };
}

async function suggestBoundedTicketObjective(body = {}) {
  const objective = String(body.objective || '').trim();
  if (!objective) {
    const error = new Error('Objective is required for ticket shaping');
    error.statusCode = 400;
    throw error;
  }

  const agent = getTicketShapeAgent(body);
  const input = [
    {
      role: 'system',
      content: [
        'You help an operator shape a ticket before execution.',
        'The system works best with small concrete additive tasks that fit bounded execution.',
        `A model response can perform at most ${MAX_MUTATING_ACTIONS_PER_RESPONSE} mutating workspace actions before verification.`,
        'Do not create a plan for autonomous execution.',
        'Do not spawn tickets.',
        'Suggest wording only. The operator must decide whether to accept or edit it.',
        'Prefer concrete expected files, paths, or outputs.',
        'For group or dynamic mode, call out whether the work has independent outputs/scopes.',
        'Respond only as JSON with this shape:',
        '{"suggestedObjective":"clear bounded objective","expectedOutputs":["output path or result"],"decomposition":["smaller additive ticket if needed"],"warnings":["risk or vague wording"],"tooBroadForOneRun":true|false,"groupModeFit":"short assessment"}'
      ].join('\n')
    },
    {
      role: 'user',
      content: JSON.stringify({
        objective,
        assignmentTargetType: body.assignmentTargetType || 'agent',
        assignmentMode: body.assignmentMode || 'individual',
        maxMutatingActionsPerResponse: MAX_MUTATING_ACTIONS_PER_RESPONSE
      })
    }
  ];

  const response = await callOpenAI(agent, input);
  const suggestion = parseTicketShapeSuggestion(response.text);

  if (!suggestion.suggestedObjective && !suggestion.parseError) {
    suggestion.warnings.push('The suggestion did not include a clearer objective.');
  }

  return {
    ...suggestion,
    providerRequestId: response.responsePayload && response.responsePayload.requestId || null,
    usage: response.usage || null
  };
}

function createStructuredWorkspaceError(message, code, kind, detail = {}) {
  const error = new Error(message);
  error.code = code;
  error.failureKind = kind;
  error.details = detail;
  return error;
}

function createStructuredWorkspaceFsError(error, operation, relativePath) {
  if (error && error.code === 'ENOENT') {
    const parentPath = path.posix.dirname(String(relativePath || ''));
    return createStructuredWorkspaceError(error.message, 'WORKSPACE_FS_ENOENT', 'workspace_error', {
      operation,
      path: relativePath,
      parentPath: parentPath === '.' ? '' : parentPath,
      fsCode: error.code
    });
  }
  return error;
}

function assertAgentWorkspacePathAllowed(relativePath) {
  const normalized = path.posix.normalize(String(relativePath || '').replace(/\\/g, '/'));
  const cleanPath = normalized === '.' ? '' : normalized;

  if (!cleanPath) return;

  const sensitivePaths = [
    'data',
    'server.js',
    'views/admin',
    'views/login.ejs',
    'views/layout.ejs',
    'package.json',
    'pnpm-lock.yaml'
  ];

  if (sensitivePaths.some(sensitivePath => cleanPath === sensitivePath || cleanPath.startsWith(`${sensitivePath}/`))) {
    throw createStructuredWorkspaceError('Agent action blocked for sensitive application path', 'WORKSPACE_SENSITIVE_PATH', 'protected_path', {
      path: cleanPath
    });
  }
}

function getAgentOpenAIConfig(agent) {
  const apiKey = String(agent.apiKey || process.env.OPENAI_API_KEY || '').trim();
  const model = String(agent.model || process.env.OPENAI_MODEL || '').trim();

  if (!apiKey) {
    throw new Error('Agent API key is missing');
  }

  if (!model) {
    throw new Error('Agent model is missing');
  }

  return { apiKey, model };
}

function getAgentOllamaConfig(agent) {
  const model = String(agent.model || process.env.OLLAMA_MODEL || '').trim();
  const baseUrl = String(agent.baseUrl || process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434').trim().replace(/\/+$/, '');

  if (!model) {
    throw new Error('Ollama model is missing');
  }

  return { provider: 'ollama', model, baseUrl };
}

function getAgentProviderConfig(agent) {
  const provider = PROVIDERS.includes(agent && agent.provider) ? agent.provider : 'openai';

  if (provider === 'ollama') {
    return getAgentOllamaConfig(agent);
  }

  return {
    provider: 'openai',
    ...getAgentOpenAIConfig(agent)
  };
}

function hasProviderModelFallback(provider) {
  return provider === 'ollama'
    ? Boolean(String(process.env.OLLAMA_MODEL || '').trim())
    : Boolean(String(process.env.OPENAI_MODEL || '').trim());
}

function hasProviderApiKeyFallback(provider) {
  return provider === 'ollama' || Boolean(String(process.env.OPENAI_API_KEY || '').trim());
}

function providerRequestId(headers) {
  if (!headers || typeof headers !== 'object') return null;
  return headers['x-request-id'] || headers['openai-request-id'] || headers['request-id'] || null;
}

function createProviderError(message, code, detail = {}) {
  const error = new Error(message);
  error.code = code;
  error.failureKind = 'provider_error';
  error.details = detail;
  return error;
}

async function callOpenAI(agent, input, options = {}) {
  const openAIConfig = getAgentOpenAIConfig(agent);

  const responseBody = {
    model: openAIConfig.model,
    input,
    text: {
      format: {
        type: 'json_object'
      }
    }
  };
  const requestSnapshot = {
    url: 'https://api.openai.com/v1/responses',
    method: 'POST',
    headers: {
      Authorization: '[redacted]',
      'Content-Type': 'application/json'
    },
    body: responseBody
  };

  if (typeof options.onRequest === 'function') {
    options.onRequest(requestSnapshot);
  }

  let response = null;
  try {
    response = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${openAIConfig.apiKey}`,
        'Content-Type': 'application/json'
      },
      signal: options.signal,
      body: JSON.stringify(responseBody)
    });
  } catch (fetchError) {
    const error = createProviderError(fetchError.message || 'OpenAI request failed before response', 'OPENAI_TRANSPORT_ERROR', {
      phase: 'request',
      provider: 'openai',
      model: openAIConfig.model
    });
    error.providerRequestPayload = requestSnapshot;
    throw error;
  }
  const responseHeaders = Object.fromEntries(response.headers.entries());
  const requestId = providerRequestId(responseHeaders);

  const responseText = await response.text();
  let data = null;

  if (responseText) {
    try {
      data = JSON.parse(responseText);
    } catch (error) {
      const providerError = createProviderError(!response.ok
        ? `OpenAI request failed with HTTP ${response.status}: ${responseText.slice(0, 240)}`
        : 'OpenAI response was not valid JSON', 'OPENAI_MALFORMED_RESPONSE', {
        phase: 'response_parse',
        provider: 'openai',
        status: response.status,
        requestId
      });
      providerError.providerRequestPayload = requestSnapshot;
      providerError.providerResponsePayload = {
        ok: response.ok,
        status: response.status,
        requestId,
        headers: sanitizeSnapshotValue(responseHeaders),
        body: responseText.slice(0, 2000)
      };
      throw providerError;
    }
  }

  if (!response.ok) {
    const errorMessage = data && data.error && data.error.message
      ? data.error.message
      : `OpenAI request failed with HTTP ${response.status}`;
    const error = createProviderError(errorMessage, 'OPENAI_HTTP_ERROR', {
      phase: 'response_status',
      provider: 'openai',
      status: response.status,
      requestId
    });
    error.providerRequestPayload = requestSnapshot;
    error.providerResponsePayload = {
      ok: response.ok,
      status: response.status,
      requestId,
      headers: sanitizeSnapshotValue(responseHeaders),
      body: data || responseText
    };
    throw error;
  }

  if (!data || typeof data !== 'object') {
    const error = createProviderError('OpenAI response was empty', 'OPENAI_EMPTY_RESPONSE', {
      phase: 'response_body',
      provider: 'openai',
      status: response.status,
      requestId
    });
    error.providerRequestPayload = requestSnapshot;
    error.providerResponsePayload = {
      ok: response.ok,
      status: response.status,
      requestId,
      headers: sanitizeSnapshotValue(responseHeaders),
      body: data
    };
    throw error;
  }

  const text = extractOpenAIText(data);

  if (!String(text || '').trim()) {
    const error = createProviderError('OpenAI response did not include model output', 'OPENAI_NO_OUTPUT', {
      phase: 'model_output',
      provider: 'openai',
      status: response.status,
      requestId
    });
    error.providerRequestPayload = requestSnapshot;
    error.providerResponsePayload = {
      ok: response.ok,
      status: response.status,
      requestId,
      headers: sanitizeSnapshotValue(responseHeaders),
      body: data
    };
    throw error;
  }

  return {
    text,
    usage: data.usage,
    provider: 'openai',
    model: openAIConfig.model,
    requestPayload: requestSnapshot,
    responsePayload: {
      ok: response.ok,
      status: response.status,
      requestId,
      headers: sanitizeSnapshotValue(responseHeaders),
      body: data
    }
  };
}

async function callOllama(agent, input, options = {}) {
  const ollamaConfig = getAgentOllamaConfig(agent);
  const messages = input.map(item => ({
    role: item.role || 'user',
    content: String(item.content || '')
  }));
  const responseBody = {
    model: ollamaConfig.model,
    messages,
    stream: false,
    format: 'json'
  };
  const requestSnapshot = {
    url: `${ollamaConfig.baseUrl}/api/chat`,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: responseBody
  };

  if (typeof options.onRequest === 'function') {
    options.onRequest(requestSnapshot);
  }

  let response = null;
  try {
    response = await fetch(`${ollamaConfig.baseUrl}/api/chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      signal: options.signal,
      body: JSON.stringify(responseBody)
    });
  } catch (fetchError) {
    const error = createProviderError(fetchError.message || 'Ollama request failed before response', 'OLLAMA_TRANSPORT_ERROR', {
      phase: 'request',
      provider: 'ollama',
      model: ollamaConfig.model,
      baseUrl: ollamaConfig.baseUrl
    });
    error.providerRequestPayload = requestSnapshot;
    throw error;
  }

  const responseHeaders = Object.fromEntries(response.headers.entries());
  const requestId = providerRequestId(responseHeaders);
  const responseText = await response.text();
  let data = null;

  if (responseText) {
    try {
      data = JSON.parse(responseText);
    } catch (error) {
      const providerError = createProviderError(!response.ok
        ? `Ollama request failed with HTTP ${response.status}: ${responseText.slice(0, 240)}`
        : 'Ollama response was not valid JSON', 'OLLAMA_MALFORMED_RESPONSE', {
        phase: 'response_parse',
        provider: 'ollama',
        status: response.status,
        requestId
      });
      providerError.providerRequestPayload = requestSnapshot;
      providerError.providerResponsePayload = {
        ok: response.ok,
        status: response.status,
        requestId,
        headers: sanitizeSnapshotValue(responseHeaders),
        body: responseText.slice(0, 2000)
      };
      throw providerError;
    }
  }

  if (!response.ok) {
    const errorMessage = data && data.error
      ? String(data.error)
      : `Ollama request failed with HTTP ${response.status}`;
    const error = createProviderError(errorMessage, 'OLLAMA_HTTP_ERROR', {
      phase: 'response_status',
      provider: 'ollama',
      status: response.status,
      requestId
    });
    error.providerRequestPayload = requestSnapshot;
    error.providerResponsePayload = {
      ok: response.ok,
      status: response.status,
      requestId,
      headers: sanitizeSnapshotValue(responseHeaders),
      body: data || responseText
    };
    throw error;
  }

  if (!data || typeof data !== 'object') {
    const error = createProviderError('Ollama response was empty', 'OLLAMA_EMPTY_RESPONSE', {
      phase: 'response_body',
      provider: 'ollama',
      status: response.status,
      requestId
    });
    error.providerRequestPayload = requestSnapshot;
    error.providerResponsePayload = {
      ok: response.ok,
      status: response.status,
      requestId,
      headers: sanitizeSnapshotValue(responseHeaders),
      body: data
    };
    throw error;
  }

  const text = data.message && typeof data.message.content === 'string'
    ? data.message.content
    : typeof data.response === 'string'
      ? data.response
      : '';

  if (!String(text || '').trim()) {
    const error = createProviderError('Ollama response did not include model output', 'OLLAMA_NO_OUTPUT', {
      phase: 'model_output',
      provider: 'ollama',
      status: response.status,
      requestId
    });
    error.providerRequestPayload = requestSnapshot;
    error.providerResponsePayload = {
      ok: response.ok,
      status: response.status,
      requestId,
      headers: sanitizeSnapshotValue(responseHeaders),
      body: data
    };
    throw error;
  }

  return {
    text,
    usage: {
      prompt_eval_count: data.prompt_eval_count || null,
      eval_count: data.eval_count || null,
      total_duration: data.total_duration || null
    },
    provider: 'ollama',
    model: ollamaConfig.model,
    requestPayload: requestSnapshot,
    responsePayload: {
      ok: response.ok,
      status: response.status,
      requestId,
      headers: sanitizeSnapshotValue(responseHeaders),
      body: data
    }
  };
}

async function callModelProvider(agent, input, options = {}) {
  const provider = PROVIDERS.includes(agent && agent.provider) ? agent.provider : 'openai';
  if (provider === 'ollama') return callOllama(agent, input, options);
  return callOpenAI(agent, input, options);
}

function assertOnlyKeys(value, allowedKeys, label) {
  const keys = Object.keys(value || {});
  const unexpectedKey = keys.find(key => !allowedKeys.includes(key));

  if (unexpectedKey) {
    const error = new Error(`${label} includes unsupported field: ${unexpectedKey}`);
    error.code = 'WORKSPACE_MALFORMED_ACTION';
    throw error;
  }
}

function requireStringArg(args, name, options = {}) {
  if (!Object.prototype.hasOwnProperty.call(args, name)) {
    const error = new Error(`Workspace operation missing required arg: ${name}`);
    error.code = 'WORKSPACE_MALFORMED_ACTION';
    throw error;
  }

  if (typeof args[name] !== 'string') {
    const error = new Error(`Workspace operation arg must be a string: ${name}`);
    error.code = 'WORKSPACE_MALFORMED_ACTION';
    throw error;
  }

  if (options.nonEmpty && !args[name].trim()) {
    const error = new Error(`Workspace operation arg cannot be blank: ${name}`);
    error.code = 'WORKSPACE_MALFORMED_ACTION';
    throw error;
  }

  return args[name];
}

function readProtectedWorkspacePaths() {
  try {
    const configuredPaths = JSON.parse(fs.readFileSync(PROTECTED_PATHS_FILE, 'utf8'));

    if (!Array.isArray(configuredPaths)) {
      throw new Error('Protected workspace paths config must be an array');
    }

    return configuredPaths
      .filter(item => typeof item === 'string')
      .map(item => item.trim())
      .filter(Boolean);
  } catch (error) {
    return [...DEFAULT_PROTECTED_WORKSPACE_PATHS];
  }
}

function normalizeWorkspacePattern(pattern) {
  return String(pattern || '').trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
}

function workspacePatternMatches(pattern, relativePath) {
  const normalizedPattern = normalizeWorkspacePattern(pattern);
  const normalizedPath = normalizeWorkspacePattern(relativePath);

  if (!normalizedPattern || !normalizedPath) return false;

  if (normalizedPattern.endsWith('.*')) {
    const prefix = normalizedPattern.slice(0, -1);
    return normalizedPath === prefix.slice(0, -1) ||
      normalizedPath.startsWith(prefix) ||
      normalizedPath.includes(`/${prefix}`);
  }

  return normalizedPath === normalizedPattern ||
    normalizedPath.startsWith(`${normalizedPattern}/`) ||
    normalizedPath.endsWith(`/${normalizedPattern}`) ||
    normalizedPath.includes(`/${normalizedPattern}/`);
}

function getProtectedWorkspacePathMatch(relativePath) {
  return readProtectedWorkspacePaths().find(pattern => workspacePatternMatches(pattern, relativePath)) || null;
}

function createProtectedWorkspaceError(operation, relativePath, matchedPattern) {
  const error = new Error(`Blocked protected workspace path mutation: ${operation} ${relativePath}`);

  error.code = 'WORKSPACE_PROTECTED_PATH';
  error.operation = operation;
  error.path = relativePath;
  error.reason = `Path matches protected workspace pattern: ${matchedPattern}`;
  return error;
}

function blockProtectedWorkspaceOperation(run, operation, args, relativePath, runWorkspaceProvider) {
  const matchedPattern = getProtectedWorkspacePathMatch(relativePath);

  if (!matchedPattern) return;

  const error = createProtectedWorkspaceError(operation, relativePath, matchedPattern);
  const workspaceAction = {
    operation,
    args,
    path: relativePath,
    ...buildWorkspaceActionMetadata(run, runWorkspaceProvider),
    blocked: true,
    reason: error.reason
  };

  appendRunLog(run, 'workspace:blocked', error.message, workspaceAction);
  error.workspaceAction = workspaceAction;
  throw error;
}

function hashContent(content) {
  return crypto.createHash('sha256').update(String(content || '')).digest('hex');
}

function captureWorkspacePreState(runWorkspaceProvider, operation, args) {
  if (operation === 'createFolder') {
    const info = runWorkspaceProvider.getPathInfo(args.path);
    return { existed: info.exists, type: info.type || undefined };
  }
  if (operation === 'writeFile') {
    const info = runWorkspaceProvider.getPathInfo(args.path);
    const content = info.exists && info.type === 'file' ? runWorkspaceProvider.readFile(args.path) : undefined;
    return { existed: info.exists, type: info.type || undefined, contentHash: info.contentHash || undefined, content };
  }
  if (operation === 'renamePath') {
    const sourceInfo = runWorkspaceProvider.getPathInfo(args.path);
    const sourceContent = sourceInfo.exists && sourceInfo.type === 'file' ? runWorkspaceProvider.readFile(args.path) : undefined;
    const destInfo = runWorkspaceProvider.getPathInfo(args.nextPath);
    return {
      source: { existed: sourceInfo.exists, type: sourceInfo.type || undefined, contentHash: sourceInfo.contentHash || undefined, content: sourceContent },
      destination: { existed: destInfo.exists, type: destInfo.type || undefined }
    };
  }
  if (operation === 'deletePath') {
    const info = runWorkspaceProvider.getPathInfo(args.path);
    const content = info.exists && info.type === 'file' ? runWorkspaceProvider.readFile(args.path) : undefined;
    return { existed: info.exists, type: info.type || undefined, contentHash: info.contentHash || undefined, content };
  }
  return null;
}

function captureWorkspacePostState(runWorkspaceProvider, operation, args) {
  if (operation === 'createFolder') {
    const info = runWorkspaceProvider.getPathInfo(args.path);
    return { existed: info.exists, type: info.type || undefined };
  }
  if (operation === 'writeFile') {
    const info = runWorkspaceProvider.getPathInfo(args.path);
    return { existed: info.exists, type: info.type || undefined, contentHash: info.contentHash || undefined };
  }
  if (operation === 'renamePath') {
    const sourceInfo = runWorkspaceProvider.getPathInfo(args.path);
    const destInfo = runWorkspaceProvider.getPathInfo(args.nextPath);
    return {
      source: { existed: sourceInfo.exists, type: sourceInfo.type || undefined },
      destination: { existed: destInfo.exists, type: destInfo.type || undefined, contentHash: destInfo.contentHash || undefined }
    };
  }
  if (operation === 'deletePath') {
    const info = runWorkspaceProvider.getPathInfo(args.path);
    return { existed: info.exists, type: info.type || undefined };
  }
  return null;
}

function persistWorkspaceOperationHistory(run, step, operation, args, preState, postState, result, error) {
  const histories = readOperationHistory();
  const newId = nextId(histories);
  const record = {
    id: newId,
    timestamp: createLogTimestamp(),
    ticketId: run.ticketId,
    allocationPlanId: run.allocationPlanId || null,
    allocationItemId: run.allocationItemId || null,
    runId: run.id,
    step,
    operation,
    args: sanitizeSnapshotValue(args),
    preState,
    postState,
    result: error ? null : sanitizeSnapshotValue(result),
    error: error ? (error.message || String(error)) : null
  };
  histories.push(record);
  writeOperationHistory(histories);
  return record;
}

function parseWorkspaceOperation(action) {
  if (!action || typeof action !== 'object' || Array.isArray(action)) {
    const error = new Error('Workspace action must be an object');
    error.code = 'WORKSPACE_MALFORMED_ACTION';
    throw error;
  }

  assertOnlyKeys(action, ['operation', 'args'], 'Workspace action');

  if (typeof action.operation !== 'string' || !action.operation.trim()) {
    const error = new Error('Workspace action operation is required');
    error.code = 'WORKSPACE_MALFORMED_ACTION';
    throw error;
  }

  if (!AGENT_ALLOWED_OPERATIONS.includes(action.operation)) {
    const error = new Error(`Unsupported workspace operation: ${action.operation}`);
    error.code = 'WORKSPACE_UNSUPPORTED_OPERATION';
    throw error;
  }

  if (!action.args || typeof action.args !== 'object' || Array.isArray(action.args)) {
    const error = new Error('Workspace action args must be an object');
    error.code = 'WORKSPACE_MALFORMED_ACTION';
    throw error;
  }

  return {
    operation: action.operation,
    args: action.args
  };
}

function executeWorkspaceOperation(run, action, step = 0) {
  const { operation, args } = parseWorkspaceOperation(action);
  const runWorkspaceProvider = getRunWorkspaceProvider(run);
  let result;

  if (operation === 'listDirectory') {
    assertOnlyKeys(args, AGENT_OPERATION_ARGS.listDirectory, 'listDirectory args');
    const pathValue = requireStringArg(args, 'path');
    assertAgentWorkspacePathAllowed(pathValue);
    try {
      result = runWorkspaceProvider.list(pathValue);
    } catch (error) {
      if (error.code === 'ENOENT') {
        result = { status: 'not_found', path: pathValue, entries: [] };
      } else {
        throw error;
      }
    }
    const logMessage = result.status === 'not_found'
      ? `Ran listDirectory on ${pathValue || '/'} (not_found)`
      : `Ran listDirectory on ${pathValue || '/'}`;
    appendRunLog(run, 'workspace:list', logMessage, {
      operation,
      args: { path: pathValue },
      ...(result.status === 'not_found' ? { status: result.status } : {}),
      ...buildWorkspaceActionMetadata(run, runWorkspaceProvider)
    });
    return result;
  }

  if (operation === 'readFile') {
    assertOnlyKeys(args, AGENT_OPERATION_ARGS.readFile, 'readFile args');
    const pathValue = requireStringArg(args, 'path', { nonEmpty: true });
    assertAgentWorkspacePathAllowed(pathValue);
    result = { path: pathValue, content: runWorkspaceProvider.readFile(pathValue) };
    appendRunLog(run, 'workspace:read', `Ran readFile on ${pathValue}`, {
      operation,
      args: { path: pathValue },
      ...buildWorkspaceActionMetadata(run, runWorkspaceProvider)
    });
    return result;
  }

  if (operation === 'createFolder') {
    assertOnlyKeys(args, AGENT_OPERATION_ARGS.createFolder, 'createFolder args');
    const pathValue = requireStringArg(args, 'path', { nonEmpty: true });
    assertAllocatedOwnershipAllowsMutation(run, operation, { path: pathValue }, pathValue, runWorkspaceProvider);
    assertAgentWorkspacePathAllowed(pathValue);
    const preState = captureWorkspacePreState(runWorkspaceProvider, operation, args);
    let historyRecord = null;
    try {
      result = runWorkspaceProvider.createFolder(pathValue);
      const postState = captureWorkspacePostState(runWorkspaceProvider, operation, args);
      historyRecord = persistWorkspaceOperationHistory(run, step, operation, args, preState, postState, result, null);
    } catch (error) {
      const postState = captureWorkspacePostState(runWorkspaceProvider, operation, args);
      historyRecord = persistWorkspaceOperationHistory(run, step, operation, args, preState, postState, null, error);
      if (historyRecord) error.historyId = historyRecord.id;
      throw error;
    }
    const message = result.status === 'already_exists_noop'
      ? `Ran createFolder on ${result.path} (already exists, no-op)`
      : `Ran createFolder on ${result.path}`;
    appendRunLog(run, 'workspace:create', message, {
      operation,
      args: { path: result.path },
      status: result.status,
      kind: 'folder',
      ...buildWorkspaceActionMetadata(run, runWorkspaceProvider)
    });
    return { ...result, historyId: historyRecord ? historyRecord.id : null };
  }

  if (operation === 'writeFile') {
    assertOnlyKeys(args, AGENT_OPERATION_ARGS.writeFile, 'writeFile args');
    const pathValue = requireStringArg(args, 'path', { nonEmpty: true });
    const content = requireStringArg(args, 'content');
    assertAllocatedOwnershipAllowsMutation(run, operation, { path: pathValue }, pathValue, runWorkspaceProvider);
    if (runWorkspaceProvider.exists(pathValue, { allowHidden: true })) {
      blockProtectedWorkspaceOperation(run, operation, { path: pathValue }, pathValue, runWorkspaceProvider);
    }
    assertAgentWorkspacePathAllowed(pathValue);
    const preState = captureWorkspacePreState(runWorkspaceProvider, operation, args);
    let historyRecord = null;
    try {
      result = runWorkspaceProvider.writeFile(pathValue, content);
      const postState = { existed: true, type: 'file', contentHash: hashContent(content) };
      historyRecord = persistWorkspaceOperationHistory(run, step, operation, args, preState, postState, result, null);
    } catch (error) {
      const postState = captureWorkspacePostState(runWorkspaceProvider, operation, args);
      historyRecord = persistWorkspaceOperationHistory(run, step, operation, args, preState, postState, null, error);
      if (historyRecord) error.historyId = historyRecord.id;
      throw error;
    }
    appendRunLog(run, 'workspace:write', `Ran writeFile on ${result.path}`, {
      operation,
      args: { path: result.path },
      ...buildWorkspaceActionMetadata(run, runWorkspaceProvider)
    });
    return { ...result, historyId: historyRecord ? historyRecord.id : null };
  }

  if (operation === 'renamePath') {
    assertOnlyKeys(args, AGENT_OPERATION_ARGS.renamePath, 'renamePath args');
    const pathValue = requireStringArg(args, 'path', { nonEmpty: true });
    const nextPath = requireStringArg(args, 'nextPath', { nonEmpty: true });
    assertAllocatedOwnershipAllowsMutation(run, operation, { path: pathValue, nextPath }, pathValue, runWorkspaceProvider);
    assertAllocatedOwnershipAllowsMutation(run, operation, { path: pathValue, nextPath }, nextPath, runWorkspaceProvider);
    blockProtectedWorkspaceOperation(run, operation, { path: pathValue, nextPath }, pathValue, runWorkspaceProvider);
    blockProtectedWorkspaceOperation(run, operation, { path: pathValue, nextPath }, nextPath, runWorkspaceProvider);
    assertAgentWorkspacePathAllowed(pathValue);
    assertAgentWorkspacePathAllowed(nextPath);
    const preState = captureWorkspacePreState(runWorkspaceProvider, operation, args);
    let historyRecord = null;
    try {
      result = runWorkspaceProvider.rename(pathValue, nextPath);
      const postState = captureWorkspacePostState(runWorkspaceProvider, operation, args);
      historyRecord = persistWorkspaceOperationHistory(run, step, operation, args, preState, postState, result, null);
    } catch (error) {
      const postState = captureWorkspacePostState(runWorkspaceProvider, operation, args);
      historyRecord = persistWorkspaceOperationHistory(run, step, operation, args, preState, postState, null, error);
      if (historyRecord) error.historyId = historyRecord.id;
      throw error;
    }
    appendRunLog(run, 'workspace:rename', `Ran renamePath from ${pathValue} to ${result.path}`, {
      operation,
      args: { path: pathValue, nextPath: result.path },
      ...buildWorkspaceActionMetadata(run, runWorkspaceProvider)
    });
    return { ...result, historyId: historyRecord ? historyRecord.id : null };
  }

  if (operation === 'deletePath') {
    assertOnlyKeys(args, AGENT_OPERATION_ARGS.deletePath, 'deletePath args');
    const pathValue = requireStringArg(args, 'path', { nonEmpty: true });
    assertAllocatedOwnershipAllowsMutation(run, operation, { path: pathValue }, pathValue, runWorkspaceProvider);
    blockProtectedWorkspaceOperation(run, operation, { path: pathValue }, pathValue, runWorkspaceProvider);
    assertAgentWorkspacePathAllowed(pathValue);
    const preState = captureWorkspacePreState(runWorkspaceProvider, operation, args);
    let historyRecord = null;
    try {
      result = runWorkspaceProvider.delete(pathValue);
      const postState = result.status === 'already_missing_noop'
        ? { existed: false }
        : { existed: false };
      historyRecord = persistWorkspaceOperationHistory(run, step, operation, args, preState, postState, result, null);
    } catch (error) {
      const postState = captureWorkspacePostState(runWorkspaceProvider, operation, args);
      historyRecord = persistWorkspaceOperationHistory(run, step, operation, args, preState, postState, null, error);
      if (historyRecord) error.historyId = historyRecord.id;
      throw error;
    }
    const logMessage = result.status === 'already_missing_noop'
      ? `Ran deletePath on ${result.path} (already missing, no-op)`
      : `Ran deletePath on ${result.path}`;
    appendRunLog(run, 'workspace:delete', logMessage, {
      operation,
      args: { path: result.path },
      status: result.status,
      ...buildWorkspaceActionMetadata(run, runWorkspaceProvider)
    });
    return { ...result, historyId: historyRecord ? historyRecord.id : null };
  }

  throw new Error(`Unsupported workspace operation: ${operation}`);
}

function buildAgentPrompt(ticket, runtimeEnvelope, actionResults = []) {
  return [
    {
      role: 'system',
      content: [
        'You are an agent working inside a contained workspace.',
        'You may only request workspace CRUD actions. Do not request shell commands, terminal access, admin data, auth data, or files outside the workspace root.',
        'Use runtimeEnvelope.currentDateTime and runtimeEnvelope.timezone for any current date or time facts. Do not invent timestamps.',
        'Inspect workspace contents by requesting list or read actions. No prior logs, history, or workspace tree is included.',
        'If the ticket requires creating or changing files, request the necessary workspace actions.',
        'Do not say you will do work later. Do not describe future work instead of performing it.',
        'If no workspace operation is needed and the task is truly done, set complete to true.',
        'If the task cannot be completed, explain the failure reason clearly in the message.',
        'Never return complete false with an empty actions array.',
        'Before setting complete:true, verify the ticket requirements have actually been satisfied. Do not assume an existing folder already contains required files or that earlier steps completed them.',
        'If the target path is clear or can be overwritten or created safely, emit the create or write operation.',
        'You have runtimeEnvelope.maxExecutionSteps execution steps total. Each response consumes one step. Inspect enough to identify all remaining work, then act. Balance verification and mutation within your remaining steps.',
        `The per-response workspace action limit is runtimeEnvelope.maxActionsPerResponse (${MAX_AGENT_ACTIONS_PER_RESPONSE}).`,
        'Never emit more than that many workspace actions in a single response.',
        `The per-response mutating action limit is runtimeEnvelope.maxMutatingActionsPerResponse (${MAX_MUTATING_ACTIONS_PER_RESPONSE}). Mutating actions are createFolder, writeFile, renamePath, and deletePath.`,
        'Prefer one small verified transition per response. Usually emit only 1-2 mutating actions, then inspect the returned results before continuing.',
        'Read/list actions may share a response with up to the mutating limit, but do not batch a large set of workspace mutations.',
        'If a task requires more mutations than the mutating limit, split the work across multiple responses.',
        'Emit up to the mutating limit, set complete:false, and continue with the remaining items in the next response.',
        'Do not fail or return an error just because the total task exceeds one response.',
        'For bounded bulk work, perform one small verified transition, then continue with remaining items in later responses.',
        'Use only the workspace operations listed in runtimeEnvelope.allowedOperations.',
        'If runtimeEnvelope.ownedOutputPaths is not empty, all create/write/rename/delete actions must stay inside those owned paths.',
        'If runtimeEnvelope.allocationSubtask is present, perform that subtask and put all output under your owned paths.',
        'Each action must be exactly {"operation":"operationName","args":{...}} with no extra fields.',
        'Required args: listDirectory {path}; readFile {path}; createFolder {path}; writeFile {path,content}; renamePath {path,nextPath}; deletePath {path}. Use path "" only for the workspace root in listDirectory.',
        'Respond only as JSON with this shape:',
        '{"message":"short summary","actions":[{"operation":"listDirectory|readFile|createFolder|writeFile|renamePath|deletePath","args":{"path":"relative/path","content":"for writeFile only","nextPath":"for renamePath only"}}],"complete":true|false}'
      ].join('\n')
    },
    {
      role: 'user',
      content: JSON.stringify({
        runtimeEnvelope
      })
    },
    {
      role: 'user',
      content: JSON.stringify({
        ticketObjective: ticket.objective,
        previousActionResults: actionResults
      })
    }
  ];
}

async function runAgentTicket(runId) {
  let run = updateRunStatus(runId, 'running');
  if (!run) return;
  if (run.status !== 'running') return;

  runningRunKeys.add(runExecutionKey(run));
  appendRunLog(run, 'run:started', `Agent run started${allocationLogSuffix(run)}`, null, {
    allocationPlanId: run.allocationPlanId || null,
    allocationItemId: run.allocationItemId || null
  });
  updateTicketInProgressForRun(run);
  let currentProviderRequestPersisted = false;
  let providerConfig = null;

  try {
    const ticket = readTickets().find(item => item.id === run.ticketId);
    const agent = readAgents().find(item => item.id === run.agentId);

    if (!ticket) throw new Error('Ticket not found');
    if (!agent) throw new Error('Agent not found');
    providerConfig = getAgentProviderConfig(agent);
    const runtimeEnvelope = buildRuntimeEnvelope(run);
    const initialInput = buildAgentPrompt(ticket, runtimeEnvelope, []);
    createRunReplaySnapshot(run, ticket, agent, providerConfig, runtimeEnvelope, initialInput[0].content);
    appendRunLog(run, 'run:runtime', JSON.stringify(runtimeEnvelope));

    let actionResults = [];
    let stalledResponses = 0;
    let noProgressResponses = 0;
    let repeatedMutatingActionLimitViolations = 0;
    let lastMutatingActionLimitSignature = null;
    let modelRequestCount = 0;
    let workspaceOperationCount = 0;
    const listedDirectoryPaths = new Set();
    let completed = false;
    const limits = getAgentRuntimeLimits();
    const runStartedAtMs = Date.now();

    for (let step = 0; !completed; step += 1) {
      assertRunNotTimedOut(run, runStartedAtMs, limits);
      assertRunStepAllowed(run, step, limits);
      assertRunModelRequestAllowed(run, modelRequestCount, limits);

      const currentEnvelope = buildRuntimeEnvelope(run, step);
      const input = buildAgentPrompt(ticket, currentEnvelope, actionResults);
      appendRunLog(run, 'model:request', `${providerConfig.provider} request sent with model ${providerConfig.model}`);
      modelRequestCount += 1;
      currentProviderRequestPersisted = false;
      const modelRequestStartedAt = Date.now();
      const modelResponse = await callModelProviderWithRunTimeout(run, agent, input, runStartedAtMs, limits, {
        onRequest: requestPayload => {
          appendRunReplaySnapshotItem(run.id, 'providerRequests', {
            ...requestPayload,
            startedAt: new Date(modelRequestStartedAt).toISOString(),
            durationMs: Date.now() - modelRequestStartedAt
          });
          currentProviderRequestPersisted = true;
        }
      });
      const modelResponseCompletedAt = Date.now();
      const modelCallDurationMs = modelResponseCompletedAt - modelRequestStartedAt;
      assertRunNotTimedOut(run, runStartedAtMs, limits);
      const modelText = modelResponse.text;
      appendRunLog(
        run,
        'model:response',
        modelText,
        null,
        {
          ...(modelResponse.usage ? { usage: modelResponse.usage } : {}),
          requestId: modelResponse.responsePayload ? modelResponse.responsePayload.requestId || null : null
        }
      );
      appendRunReplaySnapshotItem(run.id, 'modelResponses', {
        text: modelText,
        usage: modelResponse.usage || null,
        provider: modelResponse.provider || providerConfig.provider,
        model: modelResponse.model || providerConfig.model,
        providerResponsePayload: modelResponse.responsePayload,
        startedAt: new Date(modelRequestStartedAt).toISOString(),
        completedAt: new Date(modelResponseCompletedAt).toISOString(),
        durationMs: modelCallDurationMs
      });

      const modelPlan = parseModelActions(modelText);
      if (modelPlan.parseError) {
        recordRunEvent(run, 'model:malformed', 'Model response was not valid execution JSON', {
          parseError: modelPlan.parseError,
          rawText: modelText,
          step
        });
        const error = new Error(`Model response was not valid execution JSON: ${modelPlan.parseError}`);
        error.code = 'MODEL_MALFORMED_JSON';
        error.failureKind = 'invalid_action';
        error.details = { parseError: modelPlan.parseError, step };
        throw error;
      }

      appendRunReplaySnapshotItem(run.id, 'parsedModelPlans', {
        message: modelPlan.message,
        actions: modelPlan.actions,
        complete: modelPlan.complete,
        step
      });
      actionResults = [];
      const actions = modelPlan.actions;

      if (isRunInterrupted(run.id)) {
        const error = new Error('Run interrupted');
        error.code = 'RUN_INTERRUPTED';
        throw error;
      }

      if (actions.length > MAX_AGENT_ACTIONS_PER_RESPONSE) {
        const message = `Model returned ${actions.length} workspace actions, exceeding the per-response limit of ${MAX_AGENT_ACTIONS_PER_RESPONSE}`;

        recordRunEvent(run, 'model:action_limit', message, {
          actionCount: actions.length,
          maxActionsPerResponse: MAX_AGENT_ACTIONS_PER_RESPONSE,
          step
        });
        actionResults = [{
          warning: 'model:action_limit',
          message: `You returned ${actions.length} workspace actions, exceeding the per-response limit of ${MAX_AGENT_ACTIONS_PER_RESPONSE}. Retry with at most ${MAX_AGENT_ACTIONS_PER_RESPONSE} actions. If more work remains, emit up to the limit, set complete:false, and continue in the next response.`
        }];
        continue;
      }

      const mutatingActionCount = countMutatingActions(actions);
      if (mutatingActionCount > MAX_MUTATING_ACTIONS_PER_RESPONSE) {
        const message = `Model returned ${mutatingActionCount} mutating workspace actions, exceeding the per-response mutating limit of ${MAX_MUTATING_ACTIONS_PER_RESPONSE}`;
        const mutatingActionLimitSignature = actions
          .filter(action => action && typeof action === 'object' && AGENT_MUTATING_OPERATIONS.includes(action.operation))
          .map(action => `${action.operation}:${action.args && action.args.path ? action.args.path : ''}:${action.args && action.args.nextPath ? action.args.nextPath : ''}`)
          .join('|');

        repeatedMutatingActionLimitViolations = mutatingActionLimitSignature === lastMutatingActionLimitSignature
          ? repeatedMutatingActionLimitViolations + 1
          : 1;
        lastMutatingActionLimitSignature = mutatingActionLimitSignature;

        recordRunEvent(run, 'model:mutating_action_limit', message, {
          actionCount: actions.length,
          mutatingActionCount,
          maxActionsPerResponse: MAX_AGENT_ACTIONS_PER_RESPONSE,
          maxMutatingActionsPerResponse: MAX_MUTATING_ACTIONS_PER_RESPONSE,
          repeatedViolationCount: repeatedMutatingActionLimitViolations,
          step
        });

        if (repeatedMutatingActionLimitViolations >= 2) {
          const error = createRunLimitError(
            run,
            'mutating_action',
            'Model repeatedly proposed too many mutating actions; no workspace mutations were executed.',
            {
              currentValue: repeatedMutatingActionLimitViolations,
              configuredLimit: 1,
              mutatingActionCount,
              maxMutatingActionsPerResponse: MAX_MUTATING_ACTIONS_PER_RESPONSE,
              step
            }
          );
          error.failureKind = 'invalid_action';
          throw error;
        }

        actionResults = [{
          warning: 'model:mutating_action_limit',
          message: `You returned ${mutatingActionCount} mutating workspace actions, exceeding the per-response mutating limit of ${MAX_MUTATING_ACTIONS_PER_RESPONSE}. Retry with at most ${MAX_MUTATING_ACTIONS_PER_RESPONSE} createFolder/writeFile/renamePath/deletePath action(s). You may include read/list actions if needed. If more work remains, set complete:false and continue in the next response.`
        }];
        continue;
      }

      if (!modelPlan.complete && actions.length === 0) {
        stalledResponses += 1;
        recordRunEvent(run, 'model:stalled', 'Model returned complete:false with no workspace actions', { step });

        if (stalledResponses >= 2) {
          throw createRunLimitError(run, 'step', 'Model stalled twice with complete:false and no workspace actions', {
            currentValue: stalledResponses,
            configuredLimit: 1,
            step
          });
        }

        const remainingSteps = limits.maxExecutionSteps - step - 1;
        actionResults = [{
          warning: 'model:stalled',
          message: `You returned complete:false with no workspace actions. You have ${remainingSteps} remaining execution step(s). Emit the next required workspace operation now or fail explicitly.`
        }];
        continue;
      }

      let hasMutatingAction = false;
      const repeatedListPaths = [];
      const listPathsThisStep = new Set();

      assertRunWorkspaceOperationAllowed(run, workspaceOperationCount, actions.length, limits);

      for (const action of actions) {
        let operation = null;
        const actionStartedAt = Date.now();
        try {
          if (isRunInterrupted(run.id)) {
            const error = new Error('Run interrupted');
            error.code = 'RUN_INTERRUPTED';
            throw error;
          }

          assertRunNotTimedOut(run, runStartedAtMs, limits);
          operation = parseWorkspaceOperation(action);
          const result = executeWorkspaceOperation(run, action, step);
          const opDurationMs = Date.now() - actionStartedAt;
          workspaceOperationCount += 1;

          actionResults.push({ action, result });
          // INVARIANT: Success replay entry shape must remain structurally
          // compatible with the error replay entry below (line ~2744).
          // operation is the object from parseWorkspaceOperation:
          //   { operation: string, args: object }.
          // Downstream consumers (EJS template, test assertions) access
          // item.operation.operation and item.result — any shape change
          // here must be mirrored in the error entry and all consumers.
          appendRunReplaySnapshotItem(run.id, 'workspaceOperations', {
            operation,
            result,
            startedAt: new Date(actionStartedAt).toISOString(),
            durationMs: opDurationMs,
            historyId: result && result.historyId ? result.historyId : null,
            workspaceRoot: getRunWorkspaceProvider(run).root,
            executionWorkspaceType: run.executionWorkspaceType || 'main',
            allocationPlanId: run.allocationPlanId || null,
            allocationItemId: run.allocationItemId || null,
            ownedOutputPaths: getRunOwnedOutputPaths(run)
          });

          if (AGENT_MUTATING_OPERATIONS.includes(operation.operation)) {
            hasMutatingAction = true;
          }

          if (operation.operation === 'listDirectory') {
            const listedPath = result && typeof result.path === 'string' ? result.path : operation.args.path;

            if (listedDirectoryPaths.has(listedPath) || listPathsThisStep.has(listedPath)) {
              repeatedListPaths.push(listedPath || '/');
            }

            listPathsThisStep.add(listedPath);
          }
        } catch (error) {
          const opDurationMs = Date.now() - actionStartedAt;
          actionResults.push({ action, error: error.message });
          if (operation || error.workspaceAction) {
            // INVARIANT: Error replay entry shape must remain structurally
            // compatible with the success replay entry above (line ~2717).
            // operation may be either the parseWorkspaceOperation object
            // { operation: string, args: object } or the richer metadata
            // object from error.workspaceAction (which adds path, blocked,
            // reason, etc.). Downstream consumers access item.operation and
            // item.error — any shape change here must be mirrored in the
            // success entry and all consumers.
            appendRunReplaySnapshotItem(run.id, 'workspaceOperations', {
              operation: error.workspaceAction || operation,
              error: error.message,
              blocked: error.failureKind === 'protected_path' || ['WORKSPACE_PROTECTED_PATH', 'WORKSPACE_OWNERSHIP_VIOLATION'].includes(error.code),
              reason: error.reason || null,
              durationMs: opDurationMs,
              historyId: error.historyId || null,
              ownedOutputPaths: error.ownedOutputPaths || getRunOwnedOutputPaths(run),
              workspaceRoot: getRunWorkspaceProvider(run).root,
              executionWorkspaceType: run.executionWorkspaceType || 'main',
              allocationPlanId: run.allocationPlanId || null,
              allocationItemId: run.allocationItemId || null
            });
          }
          error.workspaceAction = error.workspaceAction || action;
          throw error;
        }
      }

      if (hasMutatingAction) {
        listedDirectoryPaths.clear();
      }

      listPathsThisStep.forEach(listedPath => listedDirectoryPaths.add(listedPath));

      if (!modelPlan.complete && !hasMutatingAction && repeatedListPaths.length > 0) {
        noProgressResponses += 1;
        const uniqueRepeatedPaths = Array.from(new Set(repeatedListPaths));
        const message = `Model repeated listDirectory without a write/create/rename/delete action: ${uniqueRepeatedPaths.join(', ')}`;
        recordRunEvent(run, 'model:no_progress', message, {
          repeatedListPaths: uniqueRepeatedPaths,
          step
        });

        if (noProgressResponses >= 2) {
          const error = createRunLimitError(run, 'step', 'Model repeated list-only non-progress twice', {
            currentValue: noProgressResponses,
            configuredLimit: 1,
            step,
            repeatedListPaths: uniqueRepeatedPaths
          });
          error.failureKind = 'no_progress';
          throw error;
        }

        const remainingSteps = limits.maxExecutionSteps - step - 1;
        actionResults = [{
          warning: 'model:no_progress',
          repeatedListPaths: uniqueRepeatedPaths,
          message: `You repeated listDirectory without progress. You have ${remainingSteps} remaining execution step(s). Perform the next required createFolder, writeFile, renamePath, or deletePath operation now, or fail explicitly with a reason.`
        }];
        continue;
      }

      if (modelPlan.complete) {
        if (actions.length === 0) {
          recordRunEvent(run, 'run:completed_noop', 'Agent run completed with no workspace changes', { step });
        }

        completed = true;
        break;
      }
    }

    run = completeAgentRun(run);
  } catch (error) {
    if (error.providerRequestPayload && !currentProviderRequestPersisted) {
      appendRunReplaySnapshotItem(run.id, 'providerRequests', error.providerRequestPayload);
    }

    if (error.providerResponsePayload) {
      appendRunReplaySnapshotItem(run.id, 'modelResponses', {
        error: error.message,
        provider: providerConfig ? providerConfig.provider : null,
        model: providerConfig ? providerConfig.model : null,
        providerResponsePayload: error.providerResponsePayload
      });
    }

    run = failAgentRun(run, error, error.workspaceAction || null);
  } finally {
    runningRunKeys.delete(runExecutionKey(run));
  }
}

// ==================== WORKSPACE PROVIDER ====================

function createLocalWorkspaceProvider(root) {
  const workspaceRoot = path.resolve(root);

  function ensureRoot() {
    fs.mkdirSync(workspaceRoot, { recursive: true });
  }

  function assertRealPathInside(resolvedPath) {
    const realRoot = fs.realpathSync(workspaceRoot);
    let probePath = resolvedPath;

    while (!fs.existsSync(probePath)) {
      const parentPath = path.dirname(probePath);
      if (parentPath === probePath) break;
      probePath = parentPath;
    }

    const realProbe = fs.realpathSync(probePath);
    const relativeRealPath = path.relative(realRoot, realProbe);

    if (relativeRealPath.startsWith('..') || path.isAbsolute(relativeRealPath)) {
      throw createStructuredWorkspaceError('Path is outside workspace root', 'WORKSPACE_OUTSIDE_ROOT', 'protected_path', {
        path: path.relative(workspaceRoot, resolvedPath)
      });
    }
  }

  function normalizeRelative(inputPath = '', options = {}) {
    const rawPath = String(inputPath || '').trim();

    if (path.isAbsolute(rawPath)) {
      throw createStructuredWorkspaceError('Absolute paths are not allowed', 'WORKSPACE_ABSOLUTE_PATH', 'protected_path', {
        path: rawPath
      });
    }

    const normalized = path.posix.normalize(rawPath.replace(/\\/g, '/'));
    const relativePath = normalized === '.' ? '' : normalized;
    const segments = relativePath.split('/').filter(Boolean);

    if (relativePath.startsWith('../') || relativePath === '..' || segments.includes('..')) {
      throw createStructuredWorkspaceError('Path traversal is not allowed', 'WORKSPACE_PATH_TRAVERSAL', 'protected_path', {
        path: rawPath
      });
    }

    if (!options.allowHidden && segments.some(segment => segment.startsWith('.'))) {
      throw createStructuredWorkspaceError('Hidden and system paths are not allowed', 'WORKSPACE_HIDDEN_PATH', 'protected_path', {
        path: rawPath
      });
    }

    return relativePath;
  }

  function resolveInside(inputPath = '', options = {}) {
    ensureRoot();
    const relativePath = normalizeRelative(inputPath, options);
    const resolvedPath = path.resolve(workspaceRoot, relativePath);
    const relativeFromRoot = path.relative(workspaceRoot, resolvedPath);

    if (relativeFromRoot.startsWith('..') || path.isAbsolute(relativeFromRoot)) {
      throw new Error('Path is outside workspace root');
    }

    assertRealPathInside(resolvedPath);

    return { relativePath, resolvedPath };
  }

  function toWorkspaceEntry(parentRelativePath, dirent) {
    const entryRelativePath = path.posix.join(parentRelativePath, dirent.name);
    return {
      name: dirent.name,
      path: entryRelativePath,
      type: dirent.isDirectory() ? 'folder' : 'file'
    };
  }

  return {
    root: workspaceRoot,

    exists(relativePath = '', options = {}) {
      const resolved = resolveInside(relativePath, options);
      return fs.existsSync(resolved.resolvedPath);
    },

    getPathInfo(relativePath = '', options = {}) {
      const resolved = resolveInside(relativePath, options);
      if (!fs.existsSync(resolved.resolvedPath)) {
        return { exists: false };
      }
      const stat = fs.lstatSync(resolved.resolvedPath);
      const type = stat.isFile() ? 'file' : stat.isDirectory() ? 'directory' : 'other';
      let contentHash = null;
      if (stat.isFile()) {
        try {
          const content = fs.readFileSync(resolved.resolvedPath, 'utf8');
          contentHash = crypto.createHash('sha256').update(content).digest('hex');
        } catch (error) {
          contentHash = null;
        }
      }
      return { exists: true, type, contentHash };
    },

    list(relativePath = '', options = {}) {
      const resolved = resolveInside(relativePath, options);
      const entries = fs.readdirSync(resolved.resolvedPath, { withFileTypes: true })
        .filter(dirent => options.allowHidden || !dirent.name.startsWith('.'))
        .filter(dirent => dirent.isDirectory() || dirent.isFile())
        .map(dirent => toWorkspaceEntry(resolved.relativePath, dirent))
        .sort((a, b) => {
          if (a.type !== b.type) return a.type === 'folder' ? -1 : 1;
          return a.name.localeCompare(b.name);
        });

      return { path: resolved.relativePath, entries };
    },

    readFile(relativePath, options = {}) {
      const resolved = resolveInside(relativePath, options);
      let stat;
      try {
        stat = fs.lstatSync(resolved.resolvedPath);
      } catch (error) {
        throw createStructuredWorkspaceFsError(error, 'readFile', resolved.relativePath);
      }

      if (!stat.isFile()) {
        throw new Error('Path is not a file');
      }

      try {
        return fs.readFileSync(resolved.resolvedPath, 'utf8');
      } catch (error) {
        throw createStructuredWorkspaceFsError(error, 'readFile', resolved.relativePath);
      }
    },

    writeFile(relativePath, content, options = {}) {
      const resolved = resolveInside(relativePath, options);
      const stat = fs.existsSync(resolved.resolvedPath) ? fs.lstatSync(resolved.resolvedPath) : null;

      if (stat && !stat.isFile()) {
        throw new Error('Path is not a file');
      }

      try {
        fs.writeFileSync(resolved.resolvedPath, String(content || ''), 'utf8');
      } catch (error) {
        throw createStructuredWorkspaceFsError(error, 'writeFile', resolved.relativePath);
      }
      return { path: resolved.relativePath };
    },

    createFile(relativePath, options = {}) {
      const resolved = resolveInside(relativePath, options);

      if (fs.existsSync(resolved.resolvedPath)) {
        throw new Error('Path already exists');
      }

      fs.mkdirSync(path.dirname(resolved.resolvedPath), { recursive: true });
      fs.writeFileSync(resolved.resolvedPath, '', 'utf8');
      return { path: resolved.relativePath };
    },

    createFolder(relativePath, options = {}) {
      const resolved = resolveInside(relativePath, options);

      if (fs.existsSync(resolved.resolvedPath)) {
        const stat = fs.lstatSync(resolved.resolvedPath);
        if (stat.isDirectory()) {
          return { path: resolved.relativePath, status: 'already_exists_noop' };
        }
        throw createStructuredWorkspaceError('Path already exists and is not a directory', 'WORKSPACE_PATH_TYPE_CONFLICT', 'workspace_error', {
          operation: 'createFolder',
          path: resolved.relativePath,
          expectedType: 'directory',
          actualType: stat.isFile() ? 'file' : 'other'
        });
      }

      try {
        fs.mkdirSync(resolved.resolvedPath, { recursive: false });
      } catch (error) {
        throw createStructuredWorkspaceFsError(error, 'createFolder', resolved.relativePath);
      }
      return { path: resolved.relativePath, status: 'created' };
    },

    rename(relativePath, nextRelativePath, options = {}) {
      const current = resolveInside(relativePath, options);
      const next = resolveInside(nextRelativePath, options);

      if (!fs.existsSync(current.resolvedPath)) {
        throw new Error('Path does not exist');
      }

      if (fs.existsSync(next.resolvedPath)) {
        throw new Error('Destination already exists');
      }

      fs.mkdirSync(path.dirname(next.resolvedPath), { recursive: true });
      fs.renameSync(current.resolvedPath, next.resolvedPath);
      return { path: next.relativePath };
    },

    delete(relativePath, options = {}) {
      const resolved = resolveInside(relativePath, options);

      if (!resolved.relativePath) {
        throw new Error('Cannot delete workspace root');
      }

      if (!fs.existsSync(resolved.resolvedPath)) {
        return { path: resolved.relativePath, status: 'already_missing_noop' };
      }

      fs.rmSync(resolved.resolvedPath, { recursive: true, force: false });
      return { path: resolved.relativePath, status: 'deleted' };
    }
  };
}

const workspaceProvider = createLocalWorkspaceProvider(WORKSPACE_ROOT);

function assertWorkspaceChildPath(fullPath) {
  const relativePath = path.relative(workspaceProvider.root, fullPath);

  if (!relativePath || relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
    throw new Error('Fixture reset path is outside workspace root');
  }
}

function clearWorkspaceRoot() {
  fs.mkdirSync(workspaceProvider.root, { recursive: true });
  fs.readdirSync(workspaceProvider.root).forEach(entryName => {
    const entryPath = path.join(workspaceProvider.root, entryName);
    assertWorkspaceChildPath(entryPath);
    fs.rmSync(entryPath, { recursive: true, force: false });
  });
}

function writeFixtureFile(relativePath, content) {
  workspaceProvider.writeFile(relativePath, content);
}

function createFixtureFolder(relativePath) {
  workspaceProvider.createFolder(relativePath);
}

function applyWorkspaceFixture(fixtureId) {
  if (!WORKSPACE_FIXTURES.some(fixture => fixture.id === fixtureId)) {
    throw new Error('Unknown workspace fixture');
  }

  clearWorkspaceRoot();

  if (fixtureId === 'empty') return;

  if (fixtureId === 'simple-files') {
    writeFixtureFile('README.md', '# Workspace fixture\n\nUse this file for basic edit tests.\n');
    writeFixtureFile('todo.txt', 'one\ntwo\nthree\n');
    return;
  }

  if (fixtureId === 'nested-folders') {
    createFixtureFolder('src');
    createFixtureFolder('src/components');
    createFixtureFolder('docs');
    writeFixtureFile('src/index.js', 'console.log("fixture");\n');
    writeFixtureFile('src/components/card.txt', 'component placeholder\n');
    writeFixtureFile('docs/notes.md', '# Notes\n');
    return;
  }

  if (fixtureId === 'existing-target-folder') {
    createFixtureFolder('target');
    writeFixtureFile('target/existing.txt', 'existing target content\n');
    writeFixtureFile('source.txt', 'move or copy this into target if requested\n');
    return;
  }

  if (fixtureId === 'conflicting-file-names') {
    writeFixtureFile('report.txt', 'current report\n');
    writeFixtureFile('report-copy.txt', 'existing copy\n');
    createFixtureFolder('archive');
    writeFixtureFile('archive/report.txt', 'archived report\n');
    return;
  }

  if (fixtureId === 'read-only-like') {
    writeFixtureFile('READ_ONLY_NOTICE.txt', 'Treat this fixture as read-only for scenario testing.\n');
    writeFixtureFile('locked-config.json', '{\n  "locked": true\n}\n');
    return;
  }

  if (fixtureId === 'large-file') {
    const lines = Array.from({ length: 1500 }, (_, index) => `Line ${index + 1}: deterministic large fixture content.`);
    writeFixtureFile('large-notes.txt', `${lines.join('\n')}\n`);
    return;
  }

  if (fixtureId === 'many-small-files') {
    createFixtureFolder('items');
    for (let index = 1; index <= 40; index += 1) {
      writeFixtureFile(`items/item-${String(index).padStart(2, '0')}.txt`, `item ${index}\n`);
    }
  }
}

function resetDebugData(changedBy = 'system') {
  writeFileAtomic(DATA_FILE, '[]');
  writeFileAtomic(RUNS_FILE, '[]');
  writeFileAtomic(LOGS_FILE, '[]');
  writeFileAtomic(ALLOCATION_PLANS_FILE, '[]');
  writeFileAtomic(OPERATION_HISTORY_FILE, '[]');

  clearWorkspaceRoot();
  runningRunKeys.clear();

  appendSystemLog('system:reset', `Debug data reset completed by ${changedBy}`, null, {
    changedBy,
    changedAt: new Date().toISOString()
  });
}

function viewData(data, userId = null) {
  const permissions = userId ? getUserPermissions(userId) : [];
  return {
    ...data,
    assets: { css: '/styles.css', js: null },
    userPermissions: permissions
  };
}

// ==================== AUTH DECORATORS ====================

fastify.decorate('requireAuth', async function(request, reply) {
  if (!request.session.userId) {
    return reply.redirect('/login');
  }
});

// ==================== HOOKS ====================

fastify.addHook('preHandler', async (request, reply) => {
  if (request.session.userId) {
    const users = readUsers();
    const user = users.find(u => u.id === request.session.userId);
    request.user = user || null;
  }
});

function setupSSEConnection(reply, request, clientSet) {
  reply.hijack();
  reply.raw.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  reply.raw.write('retry: 5000\n\n');
  clientSet.add(reply.raw);
  request.raw.on('close', () => {
    clientSet.delete(reply.raw);
  });
}

// ==================== PUBLIC ROUTES ====================

fastify.get('/login', async (request, reply) => {
  if (request.session.userId) {
    return reply.redirect('/');
  }
  return reply.view('login.ejs', viewData({ error: null, user: null }));
});

fastify.post('/login', async (request, reply) => {
  const { username, password } = request.body;

  if (!username || !password) {
    return reply.view('login.ejs', viewData({ error: 'Username and password are required', user: null }));
  }

  const users = readUsers();
  const user = users.find(u => u.username === username);

  if (!user) {
    return reply.view('login.ejs', viewData({ error: 'Invalid username or password', user: null }));
  }

  const validPassword = await argon2.verify(user.passwordHash, password);

  if (!validPassword) {
    return reply.view('login.ejs', viewData({ error: 'Invalid username or password', user: null }));
  }

  request.session.userId = user.id;
  return reply.redirect('/');
});

fastify.get('/logout', async (request, reply) => {
  request.session.destroy();
  return reply.redirect('/login');
});

// ==================== TICKET ROUTES ====================

fastify.get('/', { preHandler: fastify.requireAuth }, async (request, reply) => {
  if (!hasPermission(request.session.userId, 'ticket:create')) {
    return reply.redirect('/tickets');
  }

  return reply.view('index.ejs', viewData({
    user: request.user,
    agents: readAgents(),
    agentGroups: getTicketAssignableGroups(),
    agentGroupMembers: getAgentGroupMembers(),
    error: null
  }, request.session.userId));
});

fastify.post('/tickets', { preHandler: fastify.requireAuth }, async (request, reply) => {
  if (!hasPermission(request.session.userId, 'ticket:create')) {
    reply.code(403);
    return 'Permission denied';
  }

  const { objective, assignmentTargetType, assignmentTargetId, assignmentMode } = request.body;

  function renderTicketForm(error) {
    reply.code(400);
    return reply.view('index.ejs', viewData({
      user: request.user,
      agents: readAgents(),
      agentGroups: getTicketAssignableGroups(),
      agentGroupMembers: getAgentGroupMembers(),
      error
    }, request.session.userId));
  }

  if (!objective || !objective.trim() || !assignmentTargetType || !assignmentTargetId) {
    return renderTicketForm('Objective, assignment target type, and assignment target are required');
  }

  const parsedAssignmentTargetId = parseInt(assignmentTargetId, 10);

  if (!['agent', 'group'].includes(assignmentTargetType) || Number.isNaN(parsedAssignmentTargetId)) {
    return renderTicketForm('Invalid assignment target');
  }

  const resolvedAssignmentMode = assignmentTargetType === 'agent' ? 'individual' : assignmentMode;

  if (assignmentTargetType === 'group' && !['allocated', 'dynamic'].includes(resolvedAssignmentMode)) {
    return renderTicketForm('Group assignments require allocated or dynamic mode');
  }

  if (assignmentTargetType === 'agent' && !readAgents().some(agent => agent.id === parsedAssignmentTargetId)) {
    return renderTicketForm('Selected agent does not exist');
  }

  if (assignmentTargetType === 'group' && !getTicketAssignableGroups().some(group => group.id === parsedAssignmentTargetId)) {
    return renderTicketForm('Selected ticket-capable group does not exist');
  }

  const tickets = readTickets();
  const now = new Date().toISOString();
  const nextTicketId = nextId(tickets);

  let parsedOwnedPaths = null;
  if (request.body.ownedOutputPaths) {
    try {
      parsedOwnedPaths = JSON.parse(request.body.ownedOutputPaths);
    } catch (e) {
      return renderTicketForm('Owned output paths must be valid JSON');
    }
    if (typeof parsedOwnedPaths !== 'object' || parsedOwnedPaths === null || Array.isArray(parsedOwnedPaths)) {
      return renderTicketForm('Owned output paths must be a mapping of agent ID to path');
    }
  }
  
  const newTicket = {
    id: nextTicketId,
    objective: objective.trim(),
    assignmentTargetType,
    assignmentTargetId: parsedAssignmentTargetId,
    assignmentMode: resolvedAssignmentMode,
    ownedOutputPaths: parsedOwnedPaths,
    status: 'open',
    createdBy: request.user ? request.user.username : String(request.session.userId),
    changedBy: request.user ? request.user.username : String(request.session.userId),
    changedAt: now,
    createdAt: now,
    updatedAt: now
  };

  if (newTicket.assignmentMode === 'dynamic') {
    try {
      const agents = getAgentsInGroup(newTicket.assignmentTargetId);
      newTicket.ownedOutputPaths = deriveDynamicOwnedPaths(agents);
    } catch (error) {
      appendSystemLog('allocation:setup_failed', error.message, null, {
        code: error.code || 'DYNAMIC_ALLOCATION_ERROR',
        ticketId: newTicket.id,
        assignmentTargetId: newTicket.assignmentTargetId,
        createdBy: newTicket.createdBy
      });
      return renderTicketForm(error.message);
    }
  }

  if (usesOwnedScopeAllocation(newTicket)) {
    try {
      assertAllocatedTicketCanStart(newTicket, getAgentsInGroup(newTicket.assignmentTargetId));
    } catch (error) {
      appendSystemLog('allocation:setup_failed', error.message, null, {
        code: error.code || 'VALIDATION_ERROR',
        path: error.path || null,
        assignedAgentId: error.assignedAgentId || null,
        ticketId: newTicket.id,
        assignmentTargetId: newTicket.assignmentTargetId,
        createdBy: newTicket.createdBy
      });
      return renderTicketForm(error.message);
    }
  }

  tickets.push(newTicket);
  writeTickets(tickets);
  broadcastTicketChange();
  maybeStartTicketRuns(newTicket);

  return reply.redirect('/tickets');
});

fastify.get('/tickets', { preHandler: fastify.requireAuth }, async (request, reply) => {
  if (!hasPermission(request.session.userId, 'ticket:read')) {
    reply.code(403);
    return 'Permission denied';
  }

  const ticketPage = getPaginatedTickets(request.query || {});

  return renderCachedView(request, reply, 'tickets.ejs', viewData({
    tickets: ticketPage.tickets,
    pagination: ticketPage.pagination,
    user: request.user,
    canUpdateTickets: hasPermission(request.session.userId, 'ticket:update'),
    agents: readAgents(),
    ticketStatuses: TICKET_STATUSES
  }, request.session.userId));
});

fastify.get('/tickets/:id', { preHandler: fastify.requireAuth }, async (request, reply) => {
  if (!hasPermission(request.session.userId, 'ticket:read')) {
    reply.code(403);
    return reply.view('error.ejs', viewData({
      message: 'Access denied',
      user: request.user
    }, request.session.userId));
  }

  const ticketId = parseInt(request.params.id, 10);

  if (Number.isNaN(ticketId)) {
    reply.code(404);
    return reply.view('error.ejs', viewData({
      message: 'Ticket not found',
      user: request.user
    }, request.session.userId));
  }

  const ticket = readTickets().find(item => item.id === ticketId);

  if (!ticket) {
    reply.code(404);
    return reply.view('error.ejs', viewData({
      message: 'Ticket not found',
      user: request.user
    }, request.session.userId));
  }

  const allocationPlan = getTicketAllocationPlan(ticketId);
  const history = readOperationHistory();
  const ticketRuns = getTicketRuns(ticketId, history);
  const agents = readAgents();

  return renderCachedView(request, reply, 'ticket-detail.ejs', viewData({
    user: request.user,
    ticket,
    allocationPlan,
    ticketRuns,
    agents,
    recentLogs: getRecentLogsForTicket(ticketId),
    operationHistory: enrichOperationHistoryForDisplay(getOperationHistoryForTicket(ticketId, history)),
    canUpdateTickets: hasPermission(request.session.userId, 'ticket:update')
  }, request.session.userId));
});

fastify.get('/api/health', async (request, reply) => {
   return { status: 'ok', dataDir: 'data', workspaceRoot: 'workspace-root', port: PORT, uptime: Math.floor(process.uptime()) };
});

fastify.get('/api/tickets', { preHandler: fastify.requireAuth }, async (request, reply) => {
  if (!hasPermission(request.session.userId, 'ticket:read')) {
    reply.code(403);
    return { error: 'Permission denied' };
  }

  return {
    ...getPaginatedTickets(request.query || {}),
    canUpdateTickets: hasPermission(request.session.userId, 'ticket:update'),
    agents: readAgents().map(agent => ({ id: agent.id, name: agent.name })),
    ticketStatuses: TICKET_STATUSES
  };
});

fastify.post('/api/tickets/shape-objective', { preHandler: fastify.requireAuth }, async (request, reply) => {
  if (!hasPermission(request.session.userId, 'ticket:create')) {
    reply.code(403);
    return { error: 'Permission denied' };
  }

  try {
    return await suggestBoundedTicketObjective(request.body || {});
  } catch (error) {
    reply.code(error.statusCode || 400);
    return { error: error.message || 'Ticket shaping failed' };
  }
});

fastify.patch('/api/tickets/:id/assignment', { preHandler: fastify.requireAuth }, async (request, reply) => {
  if (!hasPermission(request.session.userId, 'ticket:update')) {
    reply.code(403);
    return { error: 'Permission denied' };
  }

  const ticketId = parseInt(request.params.id, 10);
  const agentId = parseInt(request.body && request.body.agentId, 10);
  const tickets = readTickets();
  const ticket = tickets.find(item => item.id === ticketId);
  const agent = readAgents().find(item => item.id === agentId);

  if (!ticket) {
    reply.code(404);
    return { error: 'Ticket not found' };
  }

  if (!agent) {
    reply.code(400);
    return { error: 'Agent not found' };
  }

  const assignmentChanged = (
    ticket.assignmentTargetType !== 'agent' ||
    ticket.assignmentTargetId !== agent.id ||
    ticket.assignmentMode !== 'individual'
  );

  if (ticket.status !== 'open' && assignmentChanged) {
    reply.code(400);
    return { error: 'Only open tickets can be assigned to an agent run' };
  }

  if (assignmentChanged) {
    ticket.assignmentTargetType = 'agent';
    ticket.assignmentTargetId = agent.id;
    ticket.assignmentMode = 'individual';
    ticket.updatedAt = new Date().toISOString();
    writeTickets(tickets);
    broadcastTicketChange();
  }

  maybeStartTicketRuns(ticket);

  return { ticket };
});

fastify.get('/api/tickets/events', { preHandler: fastify.requireAuth }, async (request, reply) => {
  if (!hasPermission(request.session.userId, 'ticket:read')) {
    reply.code(403);
    return { error: 'Permission denied' };
  }

  setupSSEConnection(reply, request, ticketEventClients);
});

fastify.patch('/api/tickets/:id/status', { preHandler: fastify.requireAuth }, async (request, reply) => {
  if (!hasPermission(request.session.userId, 'ticket:update')) {
    reply.code(403);
    return { error: 'Permission denied' };
  }

  const ticketId = parseInt(request.params.id, 10);
  const { status } = request.body || {};

  if (Number.isNaN(ticketId) || !TICKET_STATUSES.includes(status)) {
    reply.code(400);
    return { error: 'Invalid ticket status' };
  }

  const tickets = readTickets();
  const ticket = tickets.find(item => item.id === ticketId);

  if (!ticket) {
    reply.code(404);
    return { error: 'Ticket not found' };
  }

  if (ticket.status === status) {
    return { ticket };
  }

  const changedBy = request.user ? request.user.username : String(request.session.userId);
  const changedAt = new Date().toISOString();

  if (status === 'open' && usesOwnedScopeAllocation(ticket)) {
    try {
      assertAllocatedTicketCanStart({
        ...ticket,
        status,
        updatedAt: changedAt
      }, getAgentsInGroup(ticket.assignmentTargetId));
    } catch (error) {
      appendSystemLog('allocation:setup_failed', error.message, null, {
        code: error.code || 'VALIDATION_ERROR',
        path: error.path || null,
        assignedAgentId: error.assignedAgentId || null,
        ticketId: ticket.id,
        assignmentTargetId: ticket.assignmentTargetId,
        changedBy,
        changedAt
      });
      reply.code(400);
      return { error: error.message || 'Owned-scope execution rejected' };
    }
  }

  const previousStatus = ticket.status;
  ticket.status = status;
  ticket.updatedAt = changedAt;
  ticket.changedBy = changedBy;
  ticket.changedAt = changedAt;
  writeTickets(tickets);
  broadcastTicketChange();

  appendSystemLog('ticket:status_change', `Ticket #${ticketId} status changed from ${previousStatus} to ${status} by ${changedBy}`, null, {
    ticketId,
    changedBy,
    changedAt,
    fromStatus: previousStatus,
    toStatus: status
  });

  if (status === 'open') {
    try {
      maybeStartTicketRuns(ticket);
    } catch (error) {
      ticket.status = 'failed';
      ticket.updatedAt = changedAt;
      writeTickets(tickets);
      broadcastTicketChange();
      reply.code(400);
      return { error: error.message || 'Owned-scope execution rejected' };
    }
  }

  return { ticket };
});

fastify.post('/api/tickets/:id/rerun', { preHandler: fastify.requireAuth }, async (request, reply) => {
  if (!hasPermission(request.session.userId, 'ticket:update')) {
    reply.code(403);
    return { error: 'Permission denied' };
  }

  const ticketId = parseInt(request.params.id, 10);

  if (Number.isNaN(ticketId)) {
    reply.code(400);
    return { error: 'Invalid ticket id' };
  }

  const changedBy = request.user ? request.user.username : 'operator';
  let ticket = null;

  try {
    ticket = rerunTicketFromBeginning(ticketId, changedBy);
  } catch (error) {
    appendSystemLog('allocation:setup_failed', error.message, null, {
      code: error.code || 'VALIDATION_ERROR',
      path: error.path || null,
      assignedAgentId: error.assignedAgentId || null,
      ticketId,
      changedBy,
      changedAt: new Date().toISOString()
    });
    reply.code(400);
    return { error: error.message || 'Ticket rerun rejected' };
  }

  if (!ticket) {
    reply.code(404);
    return { error: 'Ticket not found' };
  }

  return { ticket };
});

// ==================== RECOVERY ROUTES ====================

fastify.get('/api/operations/:id/recovery-preview', { preHandler: fastify.requireAuth }, async (request, reply) => {
  if (!hasPermission(request.session.userId, 'ticket:update')) {
    reply.code(403);
    return { error: 'Permission denied' };
  }

  const recordId = parseInt(request.params.id, 10);

  if (Number.isNaN(recordId)) {
    reply.code(400);
    return { error: 'Invalid operation history id' };
  }

  const record = findOperationHistoryRecord(recordId);

  if (!record) {
    reply.code(404);
    return { error: 'Operation history record not found' };
  }

  try {
    const preview = previewRecovery(record);
    return { preview };
  } catch (error) {
    reply.code(400);
    return { error: error.message || 'Recovery preview failed' };
  }
});

fastify.post('/api/operations/:id/recover', { preHandler: fastify.requireAuth }, async (request, reply) => {
  if (!hasPermission(request.session.userId, 'ticket:update')) {
    reply.code(403);
    return { error: 'Permission denied' };
  }

  const recordId = parseInt(request.params.id, 10);
  const { confirmed } = request.body || {};

  if (Number.isNaN(recordId)) {
    reply.code(400);
    return { error: 'Invalid operation history id' };
  }

  const record = findOperationHistoryRecord(recordId);

  if (!record) {
    reply.code(404);
    return { error: 'Operation history record not found' };
  }

  try {
    const recoveryRecord = executeRecovery(record, confirmed === true);
    const changedBy = request.user ? request.user.username : String(request.session.userId);
    appendSystemLog('workspace:recovery', `Recovered operation history #${recordId} as #${recoveryRecord.id} by ${changedBy}`, {
      operation: 'recovery',
      args: { originalHistoryId: recordId, recoveryHistoryId: recoveryRecord.id }
    }, {
      changedBy,
      changedAt: new Date().toISOString()
    });
    return { recovery: recoveryRecord };
  } catch (error) {
    reply.code(400);
    return { error: error.message || 'Recovery failed' };
  }
});

// ==================== LOG ROUTES ====================

function getLogFilters(query = {}) {
  const runId = query.runId !== undefined ? parseInt(query.runId, 10) : null;
  const ticketId = query.ticketId !== undefined ? parseInt(query.ticketId, 10) : null;
  return {
    runId: Number.isInteger(runId) ? runId : null,
    ticketId: Number.isInteger(ticketId) ? ticketId : null
  };
}

function filterLogsForQuery(logs, query = {}) {
  const filters = getLogFilters(query);
  return logs.filter(log => {
    if (filters.runId !== null && log.runId !== filters.runId) return false;
    if (filters.ticketId !== null && log.ticketId !== filters.ticketId) return false;
    return true;
  });
}

function formatDisplayTimestamp(timestamp) {
  if (!timestamp) return '-';
  const match = String(timestamp).match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?Z$/);
  if (!match) return timestamp;
  const [, year, month, day, hour, minute, second] = match;
  return `${month}/${day}/${year} ${hour}:${minute}:${second}`;
}

function getPagination(query = {}, defaultLimit = 50) {
  const page = parseInt(query.page || '1', 10);
  const limit = parseInt(query.limit || String(defaultLimit), 10);
  return {
    page: Number.isInteger(page) && page > 0 ? page : 1,
    limit: Number.isInteger(limit) && limit > 0 ? Math.min(limit, 100) : defaultLimit
  };
}

function logsPageHref(filters, page, limit) {
  const params = new URLSearchParams();
  if (filters.runId !== null) params.set('runId', String(filters.runId));
  if (filters.ticketId !== null) params.set('ticketId', String(filters.ticketId));
  params.set('page', String(page));
  params.set('limit', String(limit));
  return `/logs?${params.toString()}`;
}

function getPaginatedLogs(query = {}) {
  const filters = getLogFilters(query);
  const { page, limit } = getPagination(query);
  const logs = readLogs();
  const matchesFilter = log => {
    if (filters.runId !== null && log.runId !== filters.runId) return false;
    if (filters.ticketId !== null && log.ticketId !== filters.ticketId) return false;
    return true;
  };
  let total = 0;

  for (let index = logs.length - 1; index >= 0; index -= 1) {
    if (matchesFilter(logs[index])) total += 1;
  }

  const pageCount = Math.max(1, Math.ceil(total / limit));
  const currentPage = Math.min(page, pageCount);
  const offset = (currentPage - 1) * limit;
  const pageLogs = [];
  let matched = 0;

  for (let index = logs.length - 1; index >= 0 && pageLogs.length < limit; index -= 1) {
    const log = logs[index];
    if (!matchesFilter(log)) continue;
    if (matched >= offset) {
      pageLogs.push({
        ...log,
        displayTimestamp: formatDisplayTimestamp(log.timestamp)
      });
    }
    matched += 1;
  }

  return {
    logs: sanitizeWorkspaceDisplayValue(pageLogs),
    filters,
    pagination: {
      page: currentPage,
      limit,
      total,
      pageCount,
      start: total === 0 ? 0 : offset + 1,
      end: Math.min(offset + pageLogs.length, total),
      previousHref: currentPage > 1 ? logsPageHref(filters, currentPage - 1, limit) : null,
      nextHref: currentPage < pageCount ? logsPageHref(filters, currentPage + 1, limit) : null
    }
  };
}

fastify.get('/logs', { preHandler: fastify.requireAuth }, async (request, reply) => {
  if (!hasPermission(request.session.userId, 'ticket:read')) {
    reply.code(403);
    return reply.view('error.ejs', viewData({
      message: 'Access denied',
      user: request.user
    }, request.session.userId));
  }

  const logPage = getPaginatedLogs(request.query || {});
  return renderCachedView(request, reply, 'logs.ejs', viewData({
    user: request.user,
    logs: logPage.logs,
    filters: logPage.filters,
    pagination: logPage.pagination
  }, request.session.userId));
});

fastify.get('/api/logs', { preHandler: fastify.requireAuth }, async (request, reply) => {
  if (!hasPermission(request.session.userId, 'ticket:read')) {
    reply.code(403);
    return { error: 'Permission denied' };
  }

  const logPage = getPaginatedLogs(request.query || {});
  return {
    logs: logPage.logs,
    filters: logPage.filters,
    pagination: logPage.pagination
  };
});

fastify.get('/api/export', { preHandler: fastify.requireAuth }, async (request, reply) => {
  if (!hasPermission(request.session.userId, 'ticket:read')) {
    reply.code(403);
    return { error: 'Permission denied' };
  }
  return {
    tickets: readTickets(),
    runs: sanitizeWorkspaceDisplayValue(readRuns().map(hydrateRunReplaySnapshot)),
    logs: sanitizeWorkspaceDisplayValue(readLogs()),
    history: sanitizeWorkspaceDisplayValue(readOperationHistory()),
    plans: sanitizeWorkspaceDisplayValue(readAllocationPlans())
  };
});

fastify.get('/api/logs/events', { preHandler: fastify.requireAuth }, async (request, reply) => {
  if (!hasPermission(request.session.userId, 'ticket:read')) {
    reply.code(403);
    return { error: 'Permission denied' };
  }

  setupSSEConnection(reply, request, logEventClients);
});

fastify.get('/runs/:id', { preHandler: fastify.requireAuth }, async (request, reply) => {
  if (!hasPermission(request.session.userId, 'ticket:read')) {
    reply.code(403);
    return reply.view('error.ejs', viewData({
      message: 'Access denied',
      user: request.user
    }, request.session.userId));
  }

  const runId = parseInt(request.params.id, 10);

  if (Number.isNaN(runId)) {
    reply.code(404);
    return reply.view('error.ejs', viewData({
      message: 'Run not found',
      user: request.user
    }, request.session.userId));
  }

  const run = hydrateRunReplaySnapshot(readRuns().find(item => item.id === runId));

  if (!run) {
    reply.code(404);
    return reply.view('error.ejs', viewData({
      message: 'Run not found',
      user: request.user
    }, request.session.userId));
  }

  const history = readOperationHistory();
  const runPartialMutationCount = countRunMutatingOperations(runId, history);
  const agent = readAgents().find(a => a.id === run.agentId) || null;
  const ticket = readTickets().find(item => item.id === run.ticketId) || null;
  const snapshot = run.replaySnapshot || null;
  const authorityContext = buildRunAuthorityContext(run, ticket, agent, snapshot);

  if (authorityContext.controls.recoverable && history.some(h => h.runId === runId && h.error && h.operation !== 'recovery')) {
    authorityContext.controls.recoveryAvailable = true;
  }

  const opAllowance = {};
  const opErrorInfo = {};
  if (snapshot && Array.isArray(snapshot.workspaceOperations)) {
    snapshot.workspaceOperations.forEach((op, i) => {
      const key = op.historyId != null ? 'h:' + op.historyId : 's:' + i;
      opAllowance[key] = classifyOperationAllowance(op);
      opErrorInfo[key] = buildOperationErrorInfo(op);
    });
  }
  const enrichedHistory = enrichOperationHistoryForDisplay(getOperationHistoryForRun(runId, history));
  enrichedHistory.forEach(record => {
    record.allowance = classifyOperationAllowance(record);
    record.errorInfo = buildOperationErrorInfo(record);
  });
  const failureSummary = buildRunFailureSummary(run, snapshot, enrichedHistory, runPartialMutationCount, authorityContext.controls.recoveryAvailable);
  const displaySnapshot = createDisplaySnapshot(snapshot);

  return renderCachedView(request, reply, 'run-detail.ejs', viewData({
    user: request.user,
    run,
    ticket,
    snapshot: displaySnapshot,
    agent,
    authorityContext,
    opAllowance,
    opErrorInfo,
    failureSummary,
    recentLogs: getRecentLogsForRun(runId),
    operationHistory: enrichedHistory,
    partialMutationCount: runPartialMutationCount,
    operationalOutcome: classifyRunOperationalOutcome(run),
    canUpdateRuns: hasPermission(request.session.userId, 'ticket:update')
  }, request.session.userId));
});

fastify.get('/api/runs/:id/operations', { preHandler: fastify.requireAuth }, async (request, reply) => {
  if (!hasPermission(request.session.userId, 'ticket:read')) {
    reply.code(403);
    return { error: 'Permission denied' };
  }

  const runId = parseInt(request.params.id, 10);

  if (Number.isNaN(runId)) {
    reply.code(400);
    return { error: 'Invalid run id' };
  }

  const run = readRuns().find(item => item.id === runId);

  if (!run) {
    reply.code(404);
    return { error: 'Run not found' };
  }

  return { operations: getOperationHistoryForRun(runId) };
});

fastify.post('/api/runs/:id/stop', { preHandler: fastify.requireAuth }, async (request, reply) => {
  if (!hasPermission(request.session.userId, 'ticket:update')) {
    reply.code(403);
    return { error: 'Permission denied' };
  }

  const runId = parseInt(request.params.id, 10);
  const run = readRuns().find(item => item.id === runId);

  if (Number.isNaN(runId)) {
    reply.code(400);
    return { error: 'Invalid run id' };
  }

  if (!run) {
    reply.code(404);
    return { error: 'Run not found' };
  }

  if (!['pending', 'running'].includes(run.status)) {
    reply.code(400);
    return { error: 'Only pending or running runs can be stopped' };
  }

  return { run: interruptAgentRun(run, 'manually stopped') };
});

fastify.post('/api/runs/:id/retry', { preHandler: fastify.requireAuth }, async (request, reply) => {
  if (!hasPermission(request.session.userId, 'ticket:update')) {
    reply.code(403);
    return { error: 'Permission denied' };
  }

  const runId = parseInt(request.params.id, 10);
  const run = readRuns().find(item => item.id === runId);

  if (Number.isNaN(runId)) {
    reply.code(400);
    return { error: 'Invalid run id' };
  }

  if (!run) {
    reply.code(404);
    return { error: 'Run not found' };
  }

  if (!['failed', 'interrupted'].includes(run.status)) {
    reply.code(400);
    return { error: 'Only failed or interrupted runs can be retried' };
  }

  return { ticket: rerunTicketFromBeginning(run.ticketId, request.user ? request.user.username : 'operator') };
});

// ==================== AGENT METRICS ROUTES ====================

fastify.get('/agents', { preHandler: fastify.requireAuth }, async (request, reply) => {
  if (!hasPermission(request.session.userId, 'ticket:read')) {
    reply.code(403);
    return reply.view('error.ejs', viewData({
      message: 'Access denied',
      user: request.user
    }, request.session.userId));
  }

  return reply.view('agents.ejs', viewData({
    user: request.user,
    agentMetrics: getAgentPerformanceMetrics()
  }, request.session.userId));
});

// ==================== WORKSPACE ROUTES ====================

function workspaceApi(request, reply, permission, operation) {
  if (!hasPermission(request.session.userId, permission)) {
    reply.code(403);
    return { error: 'Permission denied' };
  }

  try {
    return operation();
  } catch (error) {
    reply.code(400);
    return { error: error.message || 'Workspace operation failed' };
  }
}

function operatorWorkspaceMutationApi(request, reply, operationName, args, affectedPaths, operation) {
  if (!hasPermission(request.session.userId, 'workspace:write')) {
    reply.code(403);
    return { error: 'Permission denied' };
  }

  const requestedBy = request.user ? request.user.username : String(request.session.userId);
  const preState = captureOperatorWorkspaceState(affectedPaths);
  let result = null;
  let error = null;

  try {
    result = operation();
    return result;
  } catch (operationError) {
    error = operationError;
    reply.code(400);
    return { error: error.message || 'Workspace operation failed' };
  } finally {
    const postState = captureOperatorWorkspaceState(affectedPaths);
    appendSystemLog('workspace:operator_mutation', `Operator workspace ${operationName} by ${requestedBy}`, {
      operation: operationName,
      args: sanitizeSnapshotValue(args)
    }, {
      source: 'operator_workspace_api',
      requestedBy,
      preState,
      postState,
      result: result ? sanitizeSnapshotValue(result) : null,
      error: error ? (error.message || String(error)) : null
    });
  }
}

fastify.get('/workspace', { preHandler: fastify.requireAuth }, async (request, reply) => {
  if (!hasPermission(request.session.userId, 'workspace:read')) {
    reply.code(403);
    return reply.view('error.ejs', viewData({
      message: 'Access denied',
      user: request.user
    }, request.session.userId));
  }

  try {
    const workspaceListing = workspaceProvider.list(request.query.path || '');

    return reply.view('workspace.ejs', viewData({
      user: request.user,
      workspaceRoot: workspaceProvider.root,
      workspacePath: workspaceListing.path,
      workspaceEntries: workspaceListing.entries,
      workspaceFixtures: WORKSPACE_FIXTURES,
      canResetWorkspaceFixtures: hasPermission(request.session.userId, 'workspace:reset')
    }, request.session.userId));
  } catch (error) {
    reply.code(400);
    return reply.view('error.ejs', viewData({
      message: error.message || 'Workspace operation failed',
      user: request.user
    }, request.session.userId));
  }
});

fastify.get('/api/workspace/list', { preHandler: fastify.requireAuth }, async (request, reply) => {
  return workspaceApi(request, reply, 'workspace:read', () => {
    const relativePath = request.query.path || '';
    return workspaceProvider.list(relativePath);
  });
});

fastify.get('/api/workspace/file', { preHandler: fastify.requireAuth }, async (request, reply) => {
  return workspaceApi(request, reply, 'workspace:read', () => {
    return {
      path: request.query.path || '',
      content: workspaceProvider.readFile(request.query.path || '')
    };
  });
});

fastify.post('/api/workspace/file', { preHandler: fastify.requireAuth }, async (request, reply) => {
  const args = { path: request.body.path };
  return operatorWorkspaceMutationApi(request, reply, 'createFile', args, [request.body.path], () =>
    workspaceProvider.createFile(request.body.path, { allowHidden: true })
  );
});

fastify.post('/api/workspace/folder', { preHandler: fastify.requireAuth }, async (request, reply) => {
  const args = { path: request.body.path };
  return operatorWorkspaceMutationApi(request, reply, 'createFolder', args, [request.body.path], () =>
    workspaceProvider.createFolder(request.body.path, { allowHidden: true })
  );
});

fastify.patch('/api/workspace/file', { preHandler: fastify.requireAuth }, async (request, reply) => {
  const args = { path: request.body.path };
  return operatorWorkspaceMutationApi(request, reply, 'writeFile', args, [request.body.path], () =>
    workspaceProvider.writeFile(request.body.path, request.body.content, { allowHidden: true })
  );
});

fastify.patch('/api/workspace/rename', { preHandler: fastify.requireAuth }, async (request, reply) => {
  const args = { path: request.body.path, nextPath: request.body.nextPath };
  return operatorWorkspaceMutationApi(request, reply, 'renamePath', args, [request.body.path, request.body.nextPath], () =>
    workspaceProvider.rename(request.body.path, request.body.nextPath, { allowHidden: true })
  );
});

fastify.delete('/api/workspace', { preHandler: fastify.requireAuth }, async (request, reply) => {
  const args = { path: request.body.path };
  return operatorWorkspaceMutationApi(request, reply, 'deletePath', args, [request.body.path], () =>
    workspaceProvider.delete(request.body.path, { allowHidden: true })
  );
});

fastify.post('/api/workspace/fixture', { preHandler: fastify.requireAuth }, async (request, reply) => {
  if (!hasPermission(request.session.userId, 'workspace:reset')) {
    reply.code(403);
    return { error: 'Permission denied' };
  }

  try {
    const fixtureId = String(request.body.fixtureId || '').trim();
    const fixture = WORKSPACE_FIXTURES.find(item => item.id === fixtureId);

    if (!fixture) {
      reply.code(400);
      return { error: 'Unknown workspace fixture' };
    }

    const requestedBy = request.user ? request.user.username : String(request.session.userId);
    const preState = captureWorkspaceRootListing();
    applyWorkspaceFixture(fixtureId);
    const postState = captureWorkspaceRootListing();
    appendSystemLog('workspace:fixture', `Workspace fixture reset: ${fixture.name}`, {
      operation: 'resetWorkspaceFixture',
      args: { fixtureId, workspaceRoot: workspaceProvider.root }
    }, {
      source: 'operator_workspace_fixture',
      requestedBy,
      preState,
      postState
    });

    return workspaceProvider.list('');
  } catch (error) {
    reply.code(400);
    return { error: error.message || 'Workspace fixture reset failed' };
  }
});

// ==================== ADMIN DASHBOARD ====================

fastify.get('/admin', { preHandler: fastify.requireAuth }, async (request, reply) => {
  if (!hasPermission(request.session.userId, 'user:read')) {
    reply.code(403);
    return reply.view('error.ejs', viewData({
      message: 'Access denied',
      user: request.user
    }, request.session.userId));
  }

  const users = readUsers();
  const agents = readAgents();
  const groups = readGroups();
  const memberships = readMemberships();
  const tickets = readTickets();
  const allPermissions = readPermissions();
  const adminMutationTypes = new Set([
    'ticket:status_change',
    'ticket:rerun',
    'workspace:recovery',
    'admin:user_create',
    'admin:user_edit',
    'admin:user_delete',
    'admin:agent_create',
    'admin:agent_edit',
    'admin:agent_delete',
    'admin:group_create',
    'admin:group_edit',
    'admin:group_delete',
    'system:reset'
  ]);
  const recentAdminActivity = readLogs()
    .filter(log => adminMutationTypes.has(log.type))
    .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
    .slice(0, 12);

  const usersWithGroups = users.map(account => {
    const accountGroupIds = Array.from(new Set(memberships
      .filter(membership => membership.principalType === 'user' && membership.principalId === account.id)
      .map(membership => membership.groupId)));
    const accountGroups = groups.filter(group => accountGroupIds.includes(group.id));
    return { ...account, type: 'user', groups: accountGroups };
  });

  const agentsWithMaskedKeys = agents.map(agent => {
    const accountGroupIds = Array.from(new Set(memberships
      .filter(membership => membership.principalType === 'agent' && membership.principalId === agent.id)
      .map(membership => membership.groupId)));
    const accountGroups = groups.filter(group => accountGroupIds.includes(group.id));
    return { ...agent, type: 'agent', groups: accountGroups };
  });

  const accounts = [...usersWithGroups, ...agentsWithMaskedKeys].sort(
    (a, b) => new Date(b.createdAt) - new Date(a.createdAt)
  );

  const groupsWithPermissions = groups.map(group => {
    const permissions = getGroupPermissionNames(group.id);
    return { ...group, permissions };
  });

  return reply.view('admin/dashboard.ejs', viewData({
    users,
    agents,
    groups,
    membershipGroups: groups,
    accounts,
    groupsWithPermissions,
    recentAdminActivity,
    tickets,
    permissions: allPermissions,
    providers: PROVIDERS,
    models: MODELS,
    hasOpenAIApiKeyFallback: Boolean(String(process.env.OPENAI_API_KEY || '').trim()),
    hasOpenAIModelFallback: Boolean(String(process.env.OPENAI_MODEL || '').trim()),
    hasOllamaModelFallback: Boolean(String(process.env.OLLAMA_MODEL || '').trim()),
    user: request.user,
    resetError: request.query.resetError || null,
    resetSuccess: request.query.resetSuccess || null
  }, request.session.userId));
});

fastify.post('/admin/debug-reset', { preHandler: fastify.requireAuth }, async (request, reply) => {
  if (process.env.NODE_ENV === 'production') {
    reply.code(403);
    return 'Debug reset is disabled in production';
  }

  if (!hasPermission(request.session.userId, 'user:update')) {
    reply.code(403);
    return 'Permission denied';
  }

  const confirmation = String(request.body.confirmation || '').trim();
  if (confirmation !== 'RESET DEBUG DATA') {
    return reply.redirect('/admin?resetError=' + encodeURIComponent('Confirmation phrase did not match. Type RESET DEBUG DATA exactly.'));
  }

  try {
    resetDebugData(request.user ? request.user.username : String(request.session.userId));
    return reply.redirect('/admin?resetSuccess=1');
  } catch (error) {
    return reply.redirect('/admin?resetError=' + encodeURIComponent(error.message || 'Reset failed'));
  }
});

// ==================== USER MANAGEMENT ====================

fastify.post('/admin/users', { preHandler: fastify.requireAuth }, async (request, reply) => {
  if (!hasPermission(request.session.userId, 'user:create')) {
    reply.code(403);
    return 'Permission denied';
  }

  const { accountType, username, password, groupIds, agentName, apiKey, model } = request.body;

  if (accountType === 'agent') {
    const provider = PROVIDERS.includes(request.body.provider) ? request.body.provider : 'openai';
    const hasApiKey = provider === 'ollama' || Boolean(apiKey && apiKey.trim()) || hasProviderApiKeyFallback(provider);
    const hasModel = Boolean(model && model.trim()) || hasProviderModelFallback(provider);

    if (!agentName || !hasApiKey || !hasModel) {
      return renderAdminUserForm(reply, request, {
        accountType: 'agent',
        error: provider === 'ollama'
          ? 'Agent name and Ollama model are required unless OLLAMA_MODEL is configured'
          : 'Agent name, API key, and model are required unless OpenAI env fallbacks are configured'
      });
    }

    const agents = readAgents();

    if (agents.find(a => a.name === agentName)) {
      return renderAdminUserForm(reply, request, {
        accountType: 'agent',
        error: 'Agent name already exists'
      });
    }

    let normalizedGroupIds;
    try {
      normalizedGroupIds = normalizeSubmittedGroupIds(groupIds);
    } catch (error) {
      return renderAdminUserForm(reply, request, {
        accountType: 'agent',
        error: error.message
      });
    }

    const newAgent = {
      id: nextId(agents),
      name: agentName.trim(),
      type: 'agent',
      provider,
      model: model ? model.trim() : '',
      apiKey: apiKey ? apiKey.trim() : '',
      createdAt: new Date().toISOString(),
      changedBy: request.user ? request.user.username : String(request.session.userId),
      changedAt: new Date().toISOString()
    };

    const changedBy = request.user ? request.user.username : String(request.session.userId);
    const changedAt = new Date().toISOString();

    agents.push(newAgent);
    writeAgents(agents);
    setPrincipalGroupMemberships('agent', newAgent.id, normalizedGroupIds);

    appendSystemLog('admin:agent_create', `Agent "${agentName.trim()}" created by ${changedBy}`, null, {
      changedBy,
      changedAt,
      targetAgentId: newAgent.id,
      targetAgentName: agentName.trim(),
      provider
    });

    return reply.redirect('/admin');
  }

  if (!username || !password) {
    return renderAdminUserForm(reply, request, {
      accountType: 'user',
      error: 'Username and password are required'
    });
  }

  let normalizedGroupIds;
  try {
    normalizedGroupIds = normalizeSubmittedGroupIds(groupIds);
  } catch (error) {
    return renderAdminUserForm(reply, request, {
      accountType: 'user',
      error: error.message
    });
  }

  const users = readUsers();

  if (users.find(u => u.username === username)) {
    return renderAdminUserForm(reply, request, {
      accountType: 'user',
      error: 'Username already exists'
    });
  }

  const passwordHash = await argon2.hash(password);

  const newUser = {
    id: nextId(users),
    username: username.trim(),
    type: 'user',
    passwordHash,
    createdAt: new Date().toISOString(),
    changedBy: request.user ? request.user.username : String(request.session.userId),
    changedAt: new Date().toISOString()
  };

  users.push(newUser);
  writeUsers(users);

  setPrincipalGroupMemberships('user', newUser.id, normalizedGroupIds);

  const changedBy = request.user ? request.user.username : String(request.session.userId);
  const changedAt = new Date().toISOString();
  appendSystemLog('admin:user_create', `User "${username.trim()}" created by ${changedBy}`, null, {
    changedBy,
    changedAt,
    userId: newUser.id,
    username: username.trim()
  });

  return reply.redirect('/admin');
});

fastify.get('/admin/users/:id/edit', { preHandler: fastify.requireAuth }, async (request, reply) => {
  if (!hasPermission(request.session.userId, 'user:update')) {
    reply.code(403);
    return reply.view('error.ejs', viewData({ 
      message: 'Access denied',
      user: request.user
    }, request.session.userId));
  }
  
  const accountId = parseInt(request.params.id);
  const accountType = request.query.type === 'agent' ? 'agent' : 'user';
  const accounts = accountType === 'agent' ? readAgents() : readUsers();
  const foundAccount = accounts.find(a => a.id === accountId);
  
  if (!foundAccount) {
    return reply.redirect('/admin');
  }

  const editAccount = accountType === 'user'
    ? { ...foundAccount, type: 'user' }
    : foundAccount;

  return renderAdminUserForm(reply, request, {
    editAccount,
    accountType
  });
});

fastify.post('/admin/users/:id', { preHandler: fastify.requireAuth }, async (request, reply) => {
  if (!hasPermission(request.session.userId, 'user:update')) {
    reply.code(403);
    return 'Permission denied';
  }
  
  const accountId = parseInt(request.params.id);
  const { accountType, username, password, groupIds, agentName, apiKey, model } = request.body;

  if (accountType === 'agent') {
    const provider = PROVIDERS.includes(request.body.provider) ? request.body.provider : 'openai';
    const hasModel = Boolean(model && model.trim()) || hasProviderModelFallback(provider);

    if (!agentName || !hasModel) {
      const agents = readAgents();
      const editAccount = agents.find(a => a.id === accountId);

      return renderAdminUserForm(reply, request, {
        editAccount,
        accountType: 'agent',
        error: provider === 'ollama'
          ? 'Agent name and Ollama model are required unless OLLAMA_MODEL is configured'
          : 'Agent name and model are required unless OPENAI_MODEL is configured'
      });
    }

    const agents = readAgents();
    const agentIndex = agents.findIndex(a => a.id === accountId);

    if (agentIndex === -1) {
      return reply.redirect('/admin');
    }

    if (agents.find(a => a.name === agentName && a.id !== accountId)) {
      return renderAdminUserForm(reply, request, {
        editAccount: agents[agentIndex],
        accountType: 'agent',
        error: 'Agent name already exists'
      });
    }

    let normalizedGroupIds;
    try {
      normalizedGroupIds = normalizeSubmittedGroupIds(groupIds);
    } catch (error) {
      return renderAdminUserForm(reply, request, {
        editAccount: agents[agentIndex],
        accountType: 'agent',
        error: error.message
      });
    }

    agents[agentIndex].name = agentName.trim();
    agents[agentIndex].provider = provider;
    agents[agentIndex].model = model ? model.trim() : '';
    agents[agentIndex].changedBy = request.user ? request.user.username : String(request.session.userId);
    agents[agentIndex].changedAt = new Date().toISOString();

    if (apiKey && apiKey.trim()) {
      agents[agentIndex].apiKey = apiKey.trim();
    }

    writeAgents(agents);
    setPrincipalGroupMemberships('agent', accountId, normalizedGroupIds);

    const changedBy = request.user ? request.user.username : String(request.session.userId);
    appendSystemLog('admin:agent_edit', `Agent "${agentName.trim()}" (#${accountId}) edited by ${changedBy}`, null, {
      changedBy,
      changedAt: new Date().toISOString(),
      targetAgentId: accountId,
      targetAgentName: agentName.trim()
    });

    return reply.redirect('/admin');
  }
  
  if (!username) {
    const users = readUsers();
    const editAccount = users.find(u => u.id === accountId);

    return renderAdminUserForm(reply, request, {
      editAccount: editAccount ? { ...editAccount, type: 'user' } : null,
      accountType: 'user',
      error: 'Username is required'
    });
  }
  
  const users = readUsers();
  const userIndex = users.findIndex(u => u.id === accountId);
  
  if (userIndex === -1) {
    return reply.redirect('/admin');
  }

  if (users.find(u => u.username === username && u.id !== accountId)) {
    const editAccount = users.find(u => u.id === accountId);

    return renderAdminUserForm(reply, request, {
      editAccount: editAccount ? { ...editAccount, type: 'user' } : null,
      accountType: 'user',
      error: 'Username already exists'
    });
  }

  let normalizedGroupIds;
  try {
    normalizedGroupIds = normalizeSubmittedGroupIds(groupIds);
  } catch (error) {
    const editAccount = users.find(u => u.id === accountId);

    return renderAdminUserForm(reply, request, {
      editAccount: editAccount ? { ...editAccount, type: 'user' } : null,
      accountType: 'user',
      error: error.message
    });
  }

  users[userIndex].username = username.trim();
  users[userIndex].type = 'user';
  users[userIndex].changedBy = request.user ? request.user.username : String(request.session.userId);
  users[userIndex].changedAt = new Date().toISOString();
  
  if (password) {
    users[userIndex].passwordHash = await argon2.hash(password);
  }
	  
  writeUsers(users);
  setPrincipalGroupMemberships('user', accountId, normalizedGroupIds);

  const changedBy = request.user ? request.user.username : String(request.session.userId);
  appendSystemLog('admin:user_edit', `User "${username.trim()}" (#${accountId}) edited by ${changedBy}`, null, {
    changedBy,
    changedAt: new Date().toISOString(),
    userId: accountId,
    username: username.trim()
  });

  return reply.redirect('/admin');
});

fastify.post('/admin/users/:id/delete', { preHandler: fastify.requireAuth }, async (request, reply) => {
  if (!hasPermission(request.session.userId, 'user:delete')) {
    reply.code(403);
    return 'Permission denied';
  }

  const accountId = parseInt(request.params.id);
  const { accountType } = request.body;

    const changedBy = request.user ? request.user.username : String(request.session.userId);
    const changedAt = new Date().toISOString();

	  if (accountType === 'agent') {
	    // Delete agent
	    let agents = readAgents();
	    const deletedAgent = agents.find(a => a.id === accountId);
	    agents = agents.filter(a => a.id !== accountId);
	    writeAgents(agents);
	    let memberships = readMemberships();
	    memberships = memberships.filter(membership =>
	      membership.principalType !== 'agent' || membership.principalId !== accountId
	    );
	    writeMemberships(memberships);

      appendSystemLog('admin:agent_delete', `Agent "${deletedAgent ? deletedAgent.name : '#' + accountId}" deleted by ${changedBy}`, null, {
        changedBy,
        changedAt,
        targetAgentId: accountId,
        targetAgentName: deletedAgent ? deletedAgent.name : null
      });
	  } else {
    // Delete user
    // Don't allow deleting yourself
    if (accountId === request.session.userId) {
      return reply.redirect('/admin');
    }

    let users = readUsers();
    const deletedUser = users.find(u => u.id === accountId);
    users = users.filter(u => u.id !== accountId);
    writeUsers(users);

	    let memberships = readMemberships();
	    memberships = memberships.filter(membership =>
	      membership.principalType !== 'user' || membership.principalId !== accountId
	    );
	    writeMemberships(memberships);

    appendSystemLog('admin:user_delete', `User "${deletedUser ? deletedUser.username : '#' + accountId}" deleted by ${changedBy}`, null, {
      changedBy,
      changedAt,
      userId: accountId,
      username: deletedUser ? deletedUser.username : null
    });
	  }

  return reply.redirect('/admin');
});

// ==================== GROUP MANAGEMENT ====================

fastify.post('/admin/groups', { preHandler: fastify.requireAuth }, async (request, reply) => {
  if (!hasPermission(request.session.userId, 'group:create')) {
    reply.code(403);
    return 'Permission denied';
  }
  
  const { name, permissions, canReceiveTickets } = request.body;
  const ticketAssignable = canReceiveTickets === 'on';
  
  if (!name) {
    return renderAdminGroupForm(reply, request, {
      error: 'Group name is required'
    });
  }
  
  const groups = readGroups();
  
  if (groups.find(g => g.name === name)) {
    return renderAdminGroupForm(reply, request, {
      error: 'Group name already exists'
    });
  }

  let normalizedPermissions = [];
  try {
    normalizedPermissions = normalizeSubmittedPermissions(permissions);
  } catch (error) {
    return renderAdminGroupForm(reply, request, {
      error: error.message
    });
  }
	  
  const newGroup = {
    id: nextId(groups),
    name: name.trim(),
    permissions: normalizedPermissions,
    canReceiveTickets: ticketAssignable,
    changedBy: request.user ? request.user.username : String(request.session.userId),
    changedAt: new Date().toISOString()
  };
  
  groups.push(newGroup);
  writeGroups(groups);

  const changedBy = request.user ? request.user.username : String(request.session.userId);
  appendSystemLog('admin:group_create', `Group "${name.trim()}" created by ${changedBy}`, null, {
    changedBy,
    changedAt: new Date().toISOString(),
    groupId: newGroup.id,
    groupName: name.trim()
  });

  return reply.redirect('/admin');
});

fastify.get('/admin/groups/:id/edit', { preHandler: fastify.requireAuth }, async (request, reply) => {
  if (!hasPermission(request.session.userId, 'group:update')) {
    reply.code(403);
    return reply.view('error.ejs', viewData({ 
      message: 'Access denied',
      user: request.user
    }, request.session.userId));
  }
  
  const groupId = parseInt(request.params.id);
  const groups = readGroups();
  const editGroup = groups.find(g => g.id === groupId);
  
  if (!editGroup) {
    return reply.redirect('/admin');
  }
  
  return renderAdminGroupForm(reply, request, {
    editGroup
  });
});

fastify.post('/admin/groups/:id', { preHandler: fastify.requireAuth }, async (request, reply) => {
  if (!hasPermission(request.session.userId, 'group:update')) {
    reply.code(403);
    return 'Permission denied';
  }
  
  const groupId = parseInt(request.params.id);
  const { name, permissions, canReceiveTickets } = request.body;
  const ticketAssignable = canReceiveTickets === 'on';
  
  if (!name) {
    const groups = readGroups();
    const editGroup = groups.find(g => g.id === groupId);

    return renderAdminGroupForm(reply, request, {
      editGroup,
      error: 'Group name is required'
    });
  }
  
  const groups = readGroups();
  const groupIndex = groups.findIndex(g => g.id === groupId);
  
  if (groupIndex === -1) {
    return reply.redirect('/admin');
  }

	  if (groups.find(g => g.name === name && g.id !== groupId)) {
	    const editGroup = groups.find(g => g.id === groupId);

    return renderAdminGroupForm(reply, request, {
      editGroup,
      error: 'Group name already exists'
	    });
	  }

	  const hasGroupTickets = readTickets().some(ticket =>
	    ticket.assignmentTargetType === 'group' && ticket.assignmentTargetId === groupId
	  );

	  if (!ticketAssignable && hasGroupTickets) {
	    return renderAdminGroupForm(reply, request, {
	      editGroup: groups[groupIndex],
	      error: 'Group has assigned tickets and must remain ticket-capable'
	    });
	  }

	  let normalizedPermissions = [];
  try {
    normalizedPermissions = normalizeSubmittedPermissions(permissions);
  } catch (error) {
    const editGroup = groups.find(g => g.id === groupId);

    return renderAdminGroupForm(reply, request, {
      editGroup,
      error: error.message
    });
  }

  groups[groupIndex].name = name.trim();
  groups[groupIndex].permissions = normalizedPermissions;
  groups[groupIndex].canReceiveTickets = ticketAssignable;
  groups[groupIndex].changedBy = request.user ? request.user.username : String(request.session.userId);
  groups[groupIndex].changedAt = new Date().toISOString();
  writeGroups(groups);

  const changedBy = request.user ? request.user.username : String(request.session.userId);
  appendSystemLog('admin:group_edit', `Group "${name.trim()}" (#${groupId}) edited by ${changedBy}`, null, {
    changedBy,
    changedAt: new Date().toISOString(),
    groupId,
    groupName: name.trim()
  });

  return reply.redirect('/admin');
});

fastify.post('/admin/groups/:id/delete', { preHandler: fastify.requireAuth }, async (request, reply) => {
  if (!hasPermission(request.session.userId, 'group:delete')) {
    reply.code(403);
    return 'Permission denied';
  }
  
	  const groupId = parseInt(request.params.id);

  if (readTickets().some(ticket => ticket.assignmentTargetType === 'group' && ticket.assignmentTargetId === groupId)) {
    reply.code(400);
    return reply.view('error.ejs', viewData({
      message: 'Cannot delete a group with assigned tickets',
      user: request.user
    }, request.session.userId));
  }
	  
  let groups = readGroups();
  const deletedGroup = groups.find(g => g.id === groupId);
  groups = groups.filter(g => g.id !== groupId);
  writeGroups(groups);
  
  let memberships = readMemberships();
  memberships = memberships.filter(membership => membership.groupId !== groupId);
  writeMemberships(memberships);

  const changedBy = request.user ? request.user.username : String(request.session.userId);
  appendSystemLog('admin:group_delete', `Group "${deletedGroup ? deletedGroup.name : '#' + groupId}" deleted by ${changedBy}`, null, {
    changedBy,
    changedAt: new Date().toISOString(),
    groupId,
    groupName: deletedGroup ? deletedGroup.name : null
  });
  
  return reply.redirect('/admin');
});

// ==================== ACTIONS CATALOG ====================

fastify.get('/admin/actions', { preHandler: fastify.requireAuth }, async (request, reply) => {
  if (!hasPermission(request.session.userId, 'user:read')) {
    reply.code(403);
    return reply.view('error.ejs', viewData({
      message: 'Access denied',
      user: request.user
    }, request.session.userId));
  }

  const categories = [...new Set(ACTIONS_CATALOG.map(a => a.category))];
  const invokers = [...new Set(ACTIONS_CATALOG.map(a => a.invoker))];

  return reply.view('admin/actions.ejs', viewData({
    user: request.user,
    actions: ACTIONS_CATALOG,
    categories,
    invokers
  }, request.session.userId));
});

// ==================== INITIALIZATION ====================

// Note: this does not validate integrity. It rewrites all data files through
// their normalize functions to ensure clean serialization on startup.
function normalizeDataIntegrity() {
  writeUsers(readUsers());
  writeAgents(readAgents());
  writeGroups(readGroups());
  writeMemberships(readMemberships());
  writeTickets(readTickets());
  writeRuns(readRuns());
  writeLogs(readLogs());
}

async function createDefaultData() {
  normalizeDataIntegrity();

  const users = readUsers();
  let adminUser = users.find(user => user.username === 'admin');

  if (users.length === 0) {
    const bootstrapPassword = String(process.env.ADMIN_BOOTSTRAP_PASSWORD || 'admin123');
    const passwordHash = await argon2.hash(bootstrapPassword);
    adminUser = {
      id: 1,
      username: 'admin',
      passwordHash,
      createdAt: new Date().toISOString()
    };
    users.push(adminUser);
    writeUsers(users);
    console.log(`Default admin user created: username=admin, password=${bootstrapPassword}`);
  }

  const groups = readGroups();
  let adminGroup = groups.find(group => group.name === 'Administrators');

  if (!adminGroup) {
    adminGroup = {
      id: nextId(groups),
      name: 'Administrators',
      permissions: readPermissions(),
      canReceiveTickets: false
    };
    groups.push(adminGroup);
    console.log('Created Administrators group');
  } else {
    adminGroup.permissions = readPermissions();
    adminGroup.canReceiveTickets = false;
  }

  if (!groups.some(group => group.canReceiveTickets)) {
    groups.push({
      id: nextId(groups),
      name: 'Agent Support',
      permissions: [],
      canReceiveTickets: true
    });
    console.log('Created Agent Support group');
  }

  writeGroups(groups);

  if (adminUser) {
    const memberships = readMemberships();
    const hasAdminMembership = memberships.some(membership =>
      membership.principalType === 'user' &&
      membership.principalId === adminUser.id &&
      membership.groupId === adminGroup.id
    );

    if (!hasAdminMembership) {
      memberships.push({
        id: nextId(memberships),
        principalType: 'user',
        principalId: adminUser.id,
        groupId: adminGroup.id
      });
      writeMemberships(memberships);
      console.log('Assigned admin user to Administrators group');
    }
  }
}

// Start server
async function start() {
  try {
    await createDefaultData();
    interruptStaleRunsOnStartup();
    serverReady = true;
    await fastify.listen({ port: PORT, host: '0.0.0.0' });
    console.log(`Server running on http://localhost:${PORT}`);
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
}

start();

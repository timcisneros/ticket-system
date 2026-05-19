const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { createTempWorkspaceRoot, removeTempWorkspaceRoot } = require('./test-workspace');

const ROOT = path.resolve(__dirname, '..');
const PORT = process.env.PORT || '3426';
const BASE_URL = `http://127.0.0.1:${PORT}`;

const STAMP = Date.now();

function requireLiveTestEnv() {
  if (process.env.NODE_ENV !== 'test') throw new Error('Requires NODE_ENV=test');
  if (process.env.ALLOW_LIVE_OPENAI_TESTS !== 'true') throw new Error('Requires ALLOW_LIVE_OPENAI_TESTS=true');
  if (!process.env.OPENAI_API_KEY) throw new Error('Requires OPENAI_API_KEY');
  if (!process.env.OPENAI_MODEL) throw new Error('Requires OPENAI_MODEL');
}

function readJson(dir, file) {
  const filePath = path.join(dir, file);
  for (let i = 0; i < 60; i++) {
    try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch (e) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25); }
  }
  throw new Error(`Cannot read ${filePath}`);
}

function writeJson(dir, file, value) {
  fs.writeFileSync(path.join(dir, file), JSON.stringify(value, null, 2));
}

function request(method, urlPath, options = {}) {
  const body = options.form
    ? new URLSearchParams(options.form).toString()
    : options.body ? JSON.stringify(options.body) : null;
  return new Promise((resolve, reject) => {
    const req = http.request(`${BASE_URL}${urlPath}`, {
      method,
      headers: {
        ...(body ? { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) } : {}),
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
  return (response.headers['set-cookie'] || []).map(c => c.split(';')[0]).join('; ');
}

function waitForExit(child) {
  return new Promise(resolve => { if (child.exitCode !== null || child.killed) return resolve(); child.once('exit', () => resolve()); });
}

async function waitForServer() {
  const started = Date.now();
  while (Date.now() - started < 15000) {
    try { const r = await request('GET', '/login'); if (r.statusCode === 200) return; } catch (e) {}
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  throw new Error('Timed out waiting for server');
}

async function login() {
  const response = await request('POST', '/login', { form: { username: 'admin', password: 'admin123' } });
  if (response.statusCode !== 302) throw new Error(`Admin login failed with HTTP ${response.statusCode}`);
  return cookieFrom(response);
}

function seedInitialData(dataDir) {
  const agents = [
    { id: 1, name: `InspAgentA-${STAMP}`, type: 'agent', provider: 'openai', model: process.env.OPENAI_MODEL, apiKey: process.env.OPENAI_API_KEY, createdAt: new Date().toISOString() },
    { id: 2, name: `InspAgentB-${STAMP}`, type: 'agent', provider: 'openai', model: process.env.OPENAI_MODEL, apiKey: process.env.OPENAI_API_KEY, createdAt: new Date().toISOString() }
  ];
  const groups = [
    { id: 1, name: 'Administrators', permissions: ['ticket:create','ticket:read','ticket:update','ticket:delete','user:create','user:read','user:update','user:delete','group:create','group:read','group:update','group:delete','permission:assign','workspace:read','workspace:write','workspace:reset'], canReceiveTickets: false },
    { id: 2, name: `InspGroup-${STAMP}`, permissions: [], canReceiveTickets: true }
  ];
  const memberships = [
    { id: 1, principalType: 'user', principalId: 1, groupId: 1 },
    { id: 2, principalType: 'agent', principalId: 1, groupId: 2 },
    { id: 3, principalType: 'agent', principalId: 2, groupId: 2 }
  ];
  const permissions = ['ticket:create','ticket:read','ticket:update','ticket:delete','user:create','user:read','user:update','user:delete','group:create','group:read','group:update','group:delete','permission:assign','workspace:read','workspace:write','workspace:reset'];
  const users = [{ id: 1, username: 'admin', passwordHash: '$argon2id$v=19$m=65536,t=3,p=4$SeE86x2lbtBr1rW+vBvyYw$Vk7owQNnteofOEq3nnd1/M0nTvxpyl2wERBgJLK0zGc', createdAt: new Date().toISOString(), type: 'user' }];
  writeJson(dataDir, 'agents.json', agents);
  writeJson(dataDir, 'groups.json', groups);
  writeJson(dataDir, 'memberships.json', memberships);
  writeJson(dataDir, 'permissions.json', permissions);
  writeJson(dataDir, 'users.json', users);
  writeJson(dataDir, 'tickets.json', []);
  writeJson(dataDir, 'runs.json', []);
  writeJson(dataDir, 'allocation-plans.json', []);
  writeJson(dataDir, 'logs.json', []);
  writeJson(dataDir, 'operation-history.json', []);
  return { agents, groups };
}

function buildExplicitSubtask(ticketId, agentId, inspectionRule) {
  let base = `[owned path]: allocated/ticket-${ticketId}/agent-${agentId}/
Create January through December folders.
Do not recreate existing folders.
Once all 12 folders exist, set complete:true.
Total expected work: 12 folder creates.`;

  if (inspectionRule === 'no_list_first') {
    base += '\nDo not list first.';
  } else if (inspectionRule === 'list_on_error') {
    base += '\nList only if a create fails.';
  }

  return base;
}

async function createTicketViaApi(dataDir, cookie, groupId, objective) {
  const response = await request('POST', '/tickets', {
    cookie,
    form: { objective, assignmentTargetType: 'group', assignmentTargetId: String(groupId), assignmentMode: 'allocated' }
  });
  if (response.statusCode !== 302) throw new Error(`Ticket create failed with HTTP ${response.statusCode}: ${response.body}`);
  const tickets = readJson(dataDir, 'tickets.json');
  const ticket = tickets.find(t => t.objective === objective);
  if (!ticket) throw new Error('Ticket was not persisted');
  return ticket;
}

function modifyAllocationSubtask(dataDir, ticketId, agents, inspectionRule) {
  const plans = readJson(dataDir, 'allocation-plans.json');
  const plan = plans.find(p => p.ticketId === ticketId);
  if (!plan) throw new Error(`No allocation plan for ticket ${ticketId}`);
  plan.items.forEach(item => {
    const agent = agents.find(a => a.id === item.assignedAgentId);
    if (agent) item.allocationSubtask = buildExplicitSubtask(ticketId, agent.id, inspectionRule);
  });
  writeJson(dataDir, 'allocation-plans.json', plans);
  const runs = readJson(dataDir, 'runs.json');
  runs.forEach(run => {
    if (run.ticketId === ticketId) {
      const agent = agents.find(a => a.id === run.agentId);
      if (agent) run.allocationSubtask = buildExplicitSubtask(ticketId, agent.id, inspectionRule);
    }
  });
  writeJson(dataDir, 'runs.json', runs);
}

async function waitForTerminalRuns(dataDir, ticketId, expectedCount) {
  const started = Date.now();
  while (Date.now() - started < 300000) {
    const runs = readJson(dataDir, 'runs.json').filter(r => r.ticketId === ticketId);
    if (runs.length >= expectedCount && runs.every(r => ['completed', 'failed'].includes(r.status))) return runs;
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  throw new Error(`Timed out waiting for ${expectedCount} terminal runs for ticket ${ticketId}`);
}

function checkFalseCompletion(agentRun, logs, history, ownedPath, wsRoot) {
  const stepLogs = logs.filter(l => l.type === 'model:response');
  const completions = stepLogs.filter(l => {
    try { const p = JSON.parse(l.message); return p.complete === true; } catch (e) { return false; }
  });
  if (completions.length === 0) return { falseCompletion: false, reason: 'never signaled complete' };

  const workspacePath = path.join(wsRoot, ownedPath);
  let actualFolders = [];
  try {
    if (fs.existsSync(workspacePath)) actualFolders = fs.readdirSync(workspacePath).filter(f => {
      return fs.statSync(path.join(workspacePath, f)).isDirectory();
    });
  } catch (e) {}

  const expectedMonths = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  const missing = expectedMonths.filter(m => !actualFolders.includes(m));
  const extras = actualFolders.filter(f => !expectedMonths.includes(f));

  if (missing.length > 0) {
    return { falseCompletion: true, reason: `signaled complete but missing folders: ${missing.join(', ')}`, actualCount: actualFolders.length };
  }
  return { falseCompletion: false, reason: 'all 12 present on complete', actualCount: actualFolders.length };
}

function checkPathDrift(history, ownedPath) {
  const expectedPrefix = ownedPath.replace(/\/?$/, '/');
  const writesOutside = history.filter(h => {
    const p = h.args && h.args.path ? h.args.path : '';
    return !p.startsWith(expectedPrefix);
  });
  return writesOutside.map(h => ({ operation: h.operation, path: h.args.path }));
}

function collectMetrics(dataDir, ticketId, agents, label, wsRoot) {
  const runs = readJson(dataDir, 'runs.json').filter(r => r.ticketId === ticketId);
  const logs = readJson(dataDir, 'logs.json').filter(l => l.ticketId === ticketId);
  const history = readJson(dataDir, 'operation-history.json').filter(h => h.ticketId === ticketId);
  const ticket = readJson(dataDir, 'tickets.json').find(t => t.id === ticketId);
  const plans = readJson(dataDir, 'allocation-plans.json').filter(p => p.ticketId === ticketId);
  const plan = plans[plans.length - 1] || null;

  const agentMetrics = agents.map(agent => {
    const agentRun = runs.find(r => r.agentId === agent.id);
    if (!agentRun) return { agentId: agent.id, error: 'No run found' };

    const runHistory = history.filter(h => h.runId === agentRun.id);
    const runLogs = logs.filter(l => l.runId === agentRun.id);
    const listLogs = runLogs.filter(l => l.type === 'workspace:list');
    const createLogs = runLogs.filter(l => l.type === 'workspace:create' && l.workspaceAction && l.workspaceAction.operation === 'createFolder');
    const modelResponseLogs = runLogs.filter(l => l.type === 'model:response');
    const writeLogs = runLogs.filter(l => l.type === 'workspace:write' || (l.type === 'workspace:create' && (!l.workspaceAction || l.workspaceAction.kind !== 'folder')));

    const alreadyExistsNoops = createLogs.filter(l => l.workspaceAction && l.workspaceAction.status === 'already_exists_noop');
    const createdFolders = createLogs.filter(l => l.workspaceAction && l.workspaceAction.status === 'created');
    const duplicateAttempts = runHistory.filter(h => h.operation === 'createFolder');
    const allListOps = runLogs.filter(l => l.type === 'workspace:list');
    const uniqueListPaths = new Set(allListOps.map(l => l.workspaceAction ? l.workspaceAction.args.path : null).filter(Boolean));

    const ownedPath = agentRun.ownedOutputPaths && agentRun.ownedOutputPaths[0] ? agentRun.ownedOutputPaths[0] : '';
    const falseCompletion = checkFalseCompletion(agentRun, runLogs, runHistory, ownedPath, wsRoot);
    const pathDrift = checkPathDrift(runHistory, ownedPath);

    const actualFolders = [];
    if (ownedPath) {
      const fullPath = path.join(wsRoot, ownedPath);
      try {
        if (fs.existsSync(fullPath)) {
          const entries = fs.readdirSync(fullPath);
          entries.forEach(f => {
            try { if (fs.statSync(path.join(fullPath, f)).isDirectory()) actualFolders.push(f); } catch (e) {}
          });
        }
      } catch (e) {}
    }

    const mutationThroughput = modelResponseLogs.length > 0
      ? (createdFolders.length / modelResponseLogs.length).toFixed(1)
      : '0.0';

    return {
      agentId: agent.id,
      agentName: agent.name,
      runId: agentRun.id,
      status: agentRun.status,
      subtask: agentRun.allocationSubtask || '(none)',
      stepsUsed: modelResponseLogs.length,
      totalModelRequests: runLogs.filter(l => l.type === 'model:request').length,
      totalCreateFolderAttempts: duplicateAttempts.length,
      alreadyExistsNoopCount: alreadyExistsNoops.length,
      successfulFolderCreates: createdFolders.length,
      actualFolderCount: actualFolders.length,
      totalListOperations: allListOps.length,
      uniqueListPaths: uniqueListPaths.size,
      listPaths: Array.from(uniqueListPaths).sort(),
      completedAll12: actualFolders.length === 12,
      signedAll12: createdFolders.length === 12,
      falseCompletion,
      pathDrift,
      pathDriftCount: pathDrift.length,
      mutationThroughput: parseFloat(mutationThroughput),
      error: agentRun.error || null
    };
  });

  const aggregated = {
    totalCreateAttempts: agentMetrics.reduce((s, m) => s + (m.totalCreateFolderAttempts || 0), 0),
    totalNoops: agentMetrics.reduce((s, m) => s + (m.alreadyExistsNoopCount || 0), 0),
    totalLists: agentMetrics.reduce((s, m) => s + (m.totalListOperations || 0), 0),
    totalSteps: agentMetrics.reduce((s, m) => s + (m.stepsUsed || 0), 0),
    totalSuccessfulCreates: agentMetrics.reduce((s, m) => s + (m.successfulFolderCreates || 0), 0),
    allCompleted12: agentMetrics.every(m => m.completedAll12),
    anyFalseComplete: agentMetrics.some(m => m.falseCompletion && m.falseCompletion.falseCompletion),
    anyPathDrift: agentMetrics.some(m => m.pathDriftCount > 0),
    totalPathDriftOps: agentMetrics.reduce((s, m) => s + (m.pathDriftCount || 0), 0),
    avgMutationThroughput: agentMetrics.reduce((s, m) => s + (m.mutationThroughput || 0), 0) / agentMetrics.length
  };

  return { label, ticketId, ticketStatus: ticket ? ticket.status : 'unknown', agentMetrics, aggregated };
}

function printComparison(results) {
  console.log('\n=============================================');
  console.log('   INSPECTION NECESSITY EXPERIMENT RESULTS');
  console.log('=============================================\n');

  results.forEach(r => {
    console.log(`--- ${r.label} ---`);
    console.log(`  Ticket #${r.ticketId} (status: ${r.ticketStatus})`);
    console.log('');
    r.agentMetrics.forEach(m => {
      console.log(`  Agent ${m.agentId} (${m.agentName}):`);
      console.log(`    Run #${m.runId} | Status: ${m.status}${m.error ? ' | ' + m.error.slice(0, 120) : ''}`);
      console.log(`    Steps: ${m.stepsUsed} | Creates: ${m.totalCreateFolderAttempts} | No-ops: ${m.alreadyExistsNoopCount} | Created: ${m.successfulFolderCreates}/12`);
      console.log(`    Actual folders on disk: ${m.actualFolderCount}/12`);
      console.log(`    List ops: ${m.totalListOperations} (${m.uniqueListPaths} unique)`);
      if (m.listPaths.length > 0 && m.listPaths.length <= 6) console.log(`    Listed paths: ${m.listPaths.join(', ')}`);
      console.log(`    Mutation throughput: ${m.mutationThroughput.toFixed(1)} creates/step`);
      if (m.falseCompletion) console.log(`    False completion: ${m.falseCompletion.falseCompletion} | ${m.falseCompletion.reason}`);
      if (m.pathDriftCount > 0) console.log(`    Path drift: ${m.pathDriftCount} operations outside owned path`);
      if (m.pathDrift.length > 0) m.pathDrift.forEach(d => console.log(`      ${d.operation}: ${d.path}`));
    });
    console.log('');
  });

  console.log('=============================================');
  console.log('   COMPARISON TABLE');
  console.log('=============================================\n');

  const header = `  Metric                          | A (explicit)     | B (no list)      | C (list on err)  `;
  const sep =    `  ${'─'.repeat(75)}`;
  console.log(header);
  console.log(sep);

  const metrics = [
    ['Total create attempts', 'totalCreateAttempts', false],
    ['already_exists_noop', 'totalNoops', false],
    ['No-op rate', (r) => r.aggregated.totalCreateAttempts > 0 ? ((r.aggregated.totalNoops / r.aggregated.totalCreateAttempts) * 100).toFixed(1) + '%' : '0%', true],
    ['Total list operations', 'totalLists', false],
    ['Total steps', 'totalSteps', false],
    ['All 12 on disk', 'allCompleted12', false],
    ['False completion', 'anyFalseComplete', false],
    ['Path drift ops', 'totalPathDriftOps', false],
    ['Any path drift', 'anyPathDrift', false],
    ['Avg creates/step', (r) => r.aggregated.avgMutationThroughput.toFixed(2), true],
  ];

  metrics.forEach(([name, key, isFn]) => {
    const vals = results.map(r => {
      const v = isFn ? key(r) : r.aggregated[key];
      return typeof v === 'boolean' ? String(v).padStart(16) : typeof v === 'number' ? String(v).padStart(16) : String(v).padStart(16);
    });
    console.log(`  ${name.padEnd(30)} | ${vals[0]} | ${vals[1]} | ${vals[2]}`);
  });

  console.log('\n  Per-agent list ops:');
  results.forEach(r => {
    const listBreakdown = r.agentMetrics.map(m => `A${m.agentId}:${m.totalListOperations}`).join(', ');
    console.log(`    ${r.label.padEnd(22)} ${listBreakdown}`);
  });

  console.log('\n  Per-agent steps:');
  results.forEach(r => {
    const stepBreakdown = r.agentMetrics.map(m => `A${m.agentId}:${m.stepsUsed}`).join(', ');
    console.log(`    ${r.label.padEnd(22)} ${stepBreakdown}`);
  });
}

async function runVariant(dataDir, cookie, agents, groupId, inspectionRule, label, wsRoot) {
  const objective = [
    `Create folders for January through December inside your owned output path.`,
    `Each folder should be named the full month name (e.g. "January").`,
    `Create exactly 12 folders.`,
    `Do not create anything outside your owned path.`,
    `Once all 12 folders exist, set complete:true.`
  ].join(' ');

  console.log(`\n[${label}] Creating ticket...`);
  const ticket = await createTicketViaApi(dataDir, cookie, groupId, objective);
  console.log(`[${label}] Ticket #${ticket.id} created.`);

  if (inspectionRule) {
    console.log(`[${label}] Modifying subtask with rule: ${inspectionRule}...`);
    modifyAllocationSubtask(dataDir, ticket.id, agents, inspectionRule);
  } else {
    console.log(`[${label}] Using explicit subtask without inspection rule.`);
  }

  console.log(`[${label}] Waiting for runs...`);
  const runs = await waitForTerminalRuns(dataDir, ticket.id, agents.length);
  console.log(`[${label}] Done: ${runs.map(r => `R${r.id} A${r.agentId}=${r.status}`).join(', ')}`);

  return collectMetrics(dataDir, ticket.id, agents, label, wsRoot);
}

async function main() {
  requireLiveTestEnv();

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'insp-exp-data-'));
  const globalWorkspaceRoot = createTempWorkspaceRoot('insp-exp-ws');
  let server = null;

  const results = [];

  try {
    seedInitialData(dataDir);

    server = spawn(process.execPath, ['server.js'], {
      cwd: ROOT,
      env: {
        ...process.env,
        NODE_ENV: 'test',
        PORT,
        WORKSPACE_ROOT: globalWorkspaceRoot,
        DATA_DIR: dataDir,
        OPENAI_API_KEY: undefined
      },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    server.stdout.on('data', chunk => process.stdout.write(String(chunk)));
    server.stderr.on('data', chunk => process.stderr.write(String(chunk)));

    await waitForServer();
    const cookie = await login();

    const agents = readJson(dataDir, 'agents.json').filter(a => a.name.startsWith('InspAgent'));
    const group = readJson(dataDir, 'groups.json').find(g => g.name.startsWith('InspGroup-'));
    if (agents.length < 2 || !group) throw new Error('Seed data not found');
    console.log(`Agents: ${agents.map(a => a.name).join(', ')}`);
    console.log(`Group: ${group.name}`);

    const variants = [
      { rule: null, label: 'A (explicit only)' },
      { rule: 'no_list_first', label: 'B (no list first)' },
      { rule: 'list_on_error', label: 'C (list on error)' },
    ];

    for (const variant of variants) {
      const r = await runVariant(dataDir, cookie, agents, group.id, variant.rule, variant.label, globalWorkspaceRoot);
      results.push(r);
      fs.rmSync(globalWorkspaceRoot, { recursive: true, force: true });
      fs.mkdirSync(globalWorkspaceRoot, { recursive: true });
    }

    printComparison(results);
  } finally {
    if (server) { server.kill('SIGTERM'); await waitForExit(server); }
    removeTempWorkspaceRoot(globalWorkspaceRoot);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(error.stack || error.message);
  process.exit(1);
});

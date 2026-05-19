const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { createTempWorkspaceRoot, removeTempWorkspaceRoot } = require('./test-workspace');

const ROOT = path.resolve(__dirname, '..');
const PORT = process.env.PORT || '3425';
const BASE_URL = `http://127.0.0.1:${PORT}`;
const DATA_FILES = [
  'agents.json', 'allocation-plans.json', 'groups.json', 'logs.json',
  'memberships.json', 'operation-history.json', 'permissions.json',
  'runs.json', 'tickets.json', 'users.json'
];
const VAGUE_SUBTASK_PREFIX = 'Produce your allocated output for ticket';
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

function seedInitialData(dataDir, workspaceRoot) {
  const agents = [
    { id: 1, name: `ExpAgentA-${STAMP}`, type: 'agent', provider: 'openai', model: process.env.OPENAI_MODEL, apiKey: process.env.OPENAI_API_KEY, createdAt: new Date().toISOString() },
    { id: 2, name: `ExpAgentB-${STAMP}`, type: 'agent', provider: 'openai', model: process.env.OPENAI_MODEL, apiKey: process.env.OPENAI_API_KEY, createdAt: new Date().toISOString() }
  ];
  const groups = [
    { id: 1, name: 'Administrators', permissions: ['ticket:create','ticket:read','ticket:update','ticket:delete','user:create','user:read','user:update','user:delete','group:create','group:read','group:update','group:delete','permission:assign','workspace:read','workspace:write','workspace:reset'], canReceiveTickets: false },
    { id: 2, name: `ExpGroup-${STAMP}`, permissions: [], canReceiveTickets: true }
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
}

function buildExplicitSubtask(ticketId, agentId) {
  return `[owned path]: allocated/ticket-${ticketId}/agent-${agentId}/
Create January through December folders.
Do not recreate existing folders.
Once all 12 folders exist, set complete:true.
Total expected work: 12 folder creates.`;
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

function modifyAllocationSubtask(dataDir, ticketId, agents) {
  const plans = readJson(dataDir, 'allocation-plans.json');
  const plan = plans.find(p => p.ticketId === ticketId);
  if (!plan) throw new Error(`No allocation plan for ticket ${ticketId}`);
  plan.items.forEach(item => {
    const agent = agents.find(a => a.id === item.assignedAgentId);
    if (agent) {
      item.allocationSubtask = buildExplicitSubtask(ticketId, agent.id);
    }
  });
  writeJson(dataDir, 'allocation-plans.json', plans);
  const runs = readJson(dataDir, 'runs.json');
  runs.forEach(run => {
    if (run.ticketId === ticketId) {
      const agent = agents.find(a => a.id === run.agentId);
      if (agent) run.allocationSubtask = buildExplicitSubtask(ticketId, agent.id);
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

function collectMetrics(dataDir, ticketId, agents, label) {
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
    const stepLogs = runLogs.filter(l => l.type === 'model:response');

    const alreadyExistsNoops = createLogs.filter(l => l.workspaceAction && l.workspaceAction.status === 'already_exists_noop');
    const createdFolders = createLogs.filter(l => l.workspaceAction && l.workspaceAction.status === 'created');
    const duplicateAttempts = runHistory.filter(h => h.operation === 'createFolder');
    const noopHistoryEntries = runHistory.filter(h => h.operation === 'createFolder' && h.result && h.result.status === 'already_exists_noop');
    const allListOps = runLogs.filter(l => l.type === 'workspace:list');
    const uniqueListPaths = new Set(allListOps.map(l => l.workspaceAction ? l.workspaceAction.args.path : null).filter(Boolean));

    return {
      agentId: agent.id,
      agentName: agent.name,
      runId: agentRun.id,
      status: agentRun.status,
      subtask: agentRun.allocationSubtask || '(none)',
      stepsUsed: stepLogs.length,
      totalModelRequests: runLogs.filter(l => l.type === 'model:request').length,
      totalCreateFolderAttempts: duplicateAttempts.length,
      alreadyExistsNoopCount: alreadyExistsNoops.length,
      successfulFolderCreates: createdFolders.length,
      noopHistoryCount: noopHistoryEntries.length,
      totalListOperations: allListOps.length,
      uniqueListPaths: uniqueListPaths.size,
      listPaths: Array.from(uniqueListPaths).sort(),
      completedAll12: createdFolders.length === 12,
      timedOutOrFailed: agentRun.status === 'failed',
      error: agentRun.error || null
    };
  });

  const allAlreadyExistsNoops = agentMetrics.reduce((sum, m) => sum + (m.alreadyExistsNoopCount || 0), 0);
  const allCreates = agentMetrics.reduce((sum, m) => sum + (m.totalCreateFolderAttempts || 0), 0);
  const totalLists = agentMetrics.reduce((sum, m) => sum + (m.totalListOperations || 0), 0);
  const totalSteps = agentMetrics.reduce((sum, m) => sum + (m.stepsUsed || 0), 0);
  const allCompleted = agentMetrics.every(m => m.completedAll12);
  const anyFailed = agentMetrics.some(m => m.timedOutOrFailed);

  const result = {
    label,
    ticketId,
    ticketStatus: ticket ? ticket.status : 'unknown',
    planSubtask: plan && plan.items && plan.items[0] ? plan.items[0].allocationSubtask : '(no plan)',
    agentMetrics,
    aggregates: {
      totalCreateFolderAttempts: allCreates,
      totalAlreadyExistsNoops: allAlreadyExistsNoops,
      noopRate: allCreates > 0 ? (allAlreadyExistsNoops / allCreates * 100).toFixed(1) + '%' : '0%',
      totalListOperations: totalLists,
      listsPerAgent: totalLists > 0 ? (totalLists / agents.length).toFixed(1) : '0.0',
      totalSteps: totalSteps,
      stepsPerAgent: totalSteps > 0 ? (totalSteps / agents.length).toFixed(1) : '0.0',
      allAgentsCompletedAll12: allCompleted,
      anyAgentFailed: anyFailed
    }
  };

  return result;
}

function printComparison(a, b) {
  console.log('\n===========================================');
  console.log('   ALLOCATION SUBTASK EXPERIMENT RESULTS');
  console.log('===========================================\n');

  console.log('--- EXPERIMENT A: Vague Subtask (Baseline) ---');
  printResult(a);

  console.log('\n--- EXPERIMENT B: Explicit Subtask ---');
  printResult(b);

  console.log('\n===========================================');
  console.log('   COMPARISON');
  console.log('===========================================\n');

  const aAgg = a.aggregates;
  const bAgg = b.aggregates;

  console.log(`  Metric                          | Vague     | Explicit  | Delta`);
  console.log(`  ${'─'.repeat(68)}`);
  console.log(`  Total create attempts           | ${String(aAgg.totalCreateFolderAttempts).padStart(9)} | ${String(bAgg.totalCreateFolderAttempts).padStart(9)} | ${signedDiff(aAgg.totalCreateFolderAttempts, bAgg.totalCreateFolderAttempts)}`);
  console.log(`  already_exists_noop count       | ${String(aAgg.totalAlreadyExistsNoops).padStart(9)} | ${String(bAgg.totalAlreadyExistsNoops).padStart(9)} | ${signedDiff(aAgg.totalAlreadyExistsNoops, bAgg.totalAlreadyExistsNoops)}`);
  console.log(`  No-op rate                      | ${aAgg.noopRate.padStart(9)} | ${bAgg.noopRate.padStart(9)} |`);
  console.log(`  Total list operations           | ${String(aAgg.totalListOperations).padStart(9)} | ${String(bAgg.totalListOperations).padStart(9)} | ${signedDiff(aAgg.totalListOperations, bAgg.totalListOperations)}`);
  console.log(`  Lists per agent                 | ${aAgg.listsPerAgent.padStart(9)} | ${bAgg.listsPerAgent.padStart(9)} |`);
  console.log(`  Total steps                     | ${String(aAgg.totalSteps).padStart(9)} | ${String(bAgg.totalSteps).padStart(9)} | ${signedDiff(aAgg.totalSteps, bAgg.totalSteps)}`);
  console.log(`  Steps per agent                 | ${aAgg.stepsPerAgent.padStart(9)} | ${bAgg.stepsPerAgent.padStart(9)} |`);
  console.log(`  All agents completed all 12     | ${String(aAgg.allAgentsCompletedAll12).padStart(9)} | ${String(bAgg.allAgentsCompletedAll12).padStart(9)} |`);
  console.log(`  Any agent failed                | ${String(aAgg.anyAgentFailed).padStart(9)} | ${String(bAgg.anyAgentFailed).padStart(9)} |`);
}

function printResult(r) {
  console.log(`  Ticket #${r.ticketId} (status: ${r.ticketStatus})`);
  console.log(`  Subtask (first agent): ${r.planSubtask.slice(0, 120)}...`);
  console.log('');
  r.agentMetrics.forEach(m => {
    console.log(`  Agent ${m.agentId} (${m.agentName}):`);
    console.log(`    Run #${m.runId} | Status: ${m.status}${m.error ? ' | Error: ' + m.error : ''}`);
    console.log(`    Steps used: ${m.stepsUsed}`);
    console.log(`    Create attempts: ${m.totalCreateFolderAttempts} | No-ops: ${m.alreadyExistsNoopCount} | Created: ${m.successfulFolderCreates}/12`);
    console.log(`    List operations: ${m.totalListOperations} (${m.uniqueListPaths} unique paths)`);
    if (m.listPaths.length > 0 && m.listPaths.length <= 10) console.log(`    Listed paths: ${m.listPaths.join(', ')}`);
    console.log(`    Completed all 12: ${m.completedAll12}`);
  });
}

function signedDiff(a, b) {
  const diff = b - a;
  if (diff > 0) return `+${diff}`;
  if (diff < 0) return `${diff}`;
  return '0';
}

function cleanupExperimentData(dataDir, ticketId) {
  const tickets = readJson(dataDir, 'tickets.json').filter(t => t.id !== ticketId);
  const runs = readJson(dataDir, 'runs.json').filter(r => r.ticketId !== ticketId);
  const plans = readJson(dataDir, 'allocation-plans.json').filter(p => p.ticketId !== ticketId);
  const logs = readJson(dataDir, 'logs.json').filter(l => l.ticketId !== ticketId);
  const history = readJson(dataDir, 'operation-history.json').filter(h => h.ticketId !== ticketId);
  writeJson(dataDir, 'tickets.json', tickets);
  writeJson(dataDir, 'runs.json', runs);
  writeJson(dataDir, 'allocation-plans.json', plans);
  writeJson(dataDir, 'logs.json', logs);
  writeJson(dataDir, 'operation-history.json', history);
}

async function runExperiment(dataDir, workspaceRoot, cookie, agents, groupId, subtaskType, label) {
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

  if (subtaskType === 'explicit') {
    console.log(`[${label}] Modifying allocation subtask to explicit...`);
    modifyAllocationSubtask(dataDir, ticket.id, agents);
  } else {
    console.log(`[${label}] Using default vague subtask.`);
  }

  console.log(`[${label}] Waiting for runs to complete...`);
  const runs = await waitForTerminalRuns(dataDir, ticket.id, agents.length);
  console.log(`[${label}] Runs complete:`);
  runs.forEach(r => console.log(`  Run #${r.id}: agent=${r.agentId} status=${r.status}${r.error ? ' error=' + r.error.slice(0, 100) : ''}`));

  const metrics = collectMetrics(dataDir, ticket.id, agents, label);
  return metrics;
}

async function main() {
  requireLiveTestEnv();

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'exp-data-'));
  const workspaceRoot = createTempWorkspaceRoot('exp-workspace');
  let server = null;

  try {
    seedInitialData(dataDir, workspaceRoot);

    server = spawn(process.execPath, ['server.js'], {
      cwd: ROOT,
      env: {
        ...process.env,
        NODE_ENV: 'test',
        PORT,
        WORKSPACE_ROOT: workspaceRoot,
        DATA_DIR: dataDir,
        OPENAI_API_KEY: undefined
      },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    server.stdout.on('data', chunk => process.stdout.write(String(chunk)));
    server.stderr.on('data', chunk => process.stderr.write(String(chunk)));

    await waitForServer();
    const cookie = await login();

    const agents = readJson(dataDir, 'agents.json').filter(a => a.name.startsWith('ExpAgent'));
    const group = readJson(dataDir, 'groups.json').find(g => g.name.startsWith('ExpGroup-'));

    if (agents.length < 2 || !group) throw new Error('Seed data not found');
    console.log(`Using agents: ${agents.map(a => a.name).join(', ')}`);
    console.log(`Using group: ${group.name}`);

    const a = await runExperiment(dataDir, workspaceRoot, cookie, agents, group.id, 'vague', 'Experiment A');
    cleanupExperimentData(dataDir, a.ticketId);
    await fs.promises.rm(workspaceRoot, { recursive: true, force: true }).catch(() => {});
    fs.mkdirSync(workspaceRoot, { recursive: true });

    const b = await runExperiment(dataDir, workspaceRoot, cookie, agents, group.id, 'explicit', 'Experiment B');
    cleanupExperimentData(dataDir, b.ticketId);

    printComparison(a, b);
  } finally {
    if (server) { server.kill('SIGTERM'); await waitForExit(server); }
    removeTempWorkspaceRoot(workspaceRoot);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(error.stack || error.message);
  process.exit(1);
});

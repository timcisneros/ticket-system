const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { createTempWorkspaceRoot, removeTempWorkspaceRoot } = require('./test-workspace');

const ROOT = path.resolve(__dirname, '..');
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
    const req = http.request(`${urlPath}`, {
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

async function waitForServer(baseUrl) {
  const started = Date.now();
  while (Date.now() - started < 15000) {
    try { const r = await request('GET', `${baseUrl}/login`); if (r.statusCode === 200) return; } catch (e) {}
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  throw new Error('Timed out waiting for server');
}

async function login(baseUrl) {
  const response = await request('POST', `${baseUrl}/login`, { form: { username: 'admin', password: 'admin123' } });
  if (response.statusCode !== 302) throw new Error(`Admin login failed with HTTP ${response.statusCode}`);
  return cookieFrom(response);
}

function seedInitialData(dataDir) {
  const agents = [
    { id: 1, name: `Insp2AgentA-${STAMP}`, type: 'agent', provider: 'openai', model: process.env.OPENAI_MODEL, apiKey: process.env.OPENAI_API_KEY, createdAt: new Date().toISOString() },
    { id: 2, name: `Insp2AgentB-${STAMP}`, type: 'agent', provider: 'openai', model: process.env.OPENAI_MODEL, apiKey: process.env.OPENAI_API_KEY, createdAt: new Date().toISOString() }
  ];
  const groups = [
    { id: 1, name: 'Administrators', permissions: ['ticket:create','ticket:read','ticket:update','ticket:delete','user:create','user:read','user:update','user:delete','group:create','group:read','group:update','group:delete','permission:assign','workspace:read','workspace:write','workspace:reset'], canReceiveTickets: false },
    { id: 2, name: `Insp2Group-${STAMP}`, permissions: [], canReceiveTickets: true }
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

async function createTicketViaApi(baseUrl, dataDir, cookie, groupId, objective) {
  const response = await request('POST', `${baseUrl}/tickets`, {
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

function checkModelCompletions(agentRun, logs) {
  const stepLogs = logs.filter(l => l.type === 'model:response');
  const completions = [];
  stepLogs.forEach(l => {
    try {
      const p = JSON.parse(l.message);
      if (p.complete === true) completions.push({ step: stepLogs.indexOf(l), message: (p.message || '').slice(0, 80) });
    } catch (e) {}
  });
  return completions;
}

function collectMetrics(dataDir, ticketId, agents, label, wsRoot) {
  const runs = readJson(dataDir, 'runs.json').filter(r => r.ticketId === ticketId);
  const logs = readJson(dataDir, 'logs.json').filter(l => l.ticketId === ticketId);
  const history = readJson(dataDir, 'operation-history.json').filter(h => h.ticketId === ticketId);
  const ticket = readJson(dataDir, 'tickets.json').find(t => t.id === ticketId);

  const agentMetrics = agents.map(agent => {
    const agentRun = runs.find(r => r.agentId === agent.id);
    if (!agentRun) return { agentId: agent.id, error: 'No run found' };
    const runHistory = history.filter(h => h.runId === agentRun.id);
    const runLogs = logs.filter(l => l.runId === agentRun.id);
    const listLogs = runLogs.filter(l => l.type === 'workspace:list');
    const createLogs = runLogs.filter(l => l.type === 'workspace:create');
    const modelResponseLogs = runLogs.filter(l => l.type === 'model:response');

    const alreadyExistsNoops = createLogs.filter(l => l.workspaceAction && l.workspaceAction.status === 'already_exists_noop').length;
    const createdFolders = createLogs.filter(l => l.workspaceAction && l.workspaceAction.status === 'created').length;
    const totalCreateAttempts = createLogs.length;
    const totalListOps = listLogs.length;
    const uniqueListPaths = new Set(listLogs.map(l => l.workspaceAction ? l.workspaceAction.args.path : null).filter(Boolean));
    const completionSignals = checkModelCompletions(agentRun, runLogs);
    const ownedPath = agentRun.ownedOutputPaths && agentRun.ownedOutputPaths[0] ? agentRun.ownedOutputPaths[0] : '';

    const actualFolders = [];
    if (ownedPath && wsRoot) {
      const fullPath = path.resolve(path.join(wsRoot, ownedPath));
      try {
        if (fs.existsSync(fullPath)) {
          const entries = fs.readdirSync(fullPath);
          entries.forEach(f => {
            try { if (fs.statSync(path.join(fullPath, f)).isDirectory()) actualFolders.push(f); } catch (e) {}
          });
        }
      } catch (e) {}
    }

    const pathDrift = [];
    if (ownedPath) {
      const expectedPrefix = ownedPath.replace(/\/?$/, '/');
      runHistory.forEach(h => {
        const p = h.args && h.args.path ? h.args.path : '';
        if (!p.startsWith(expectedPrefix)) pathDrift.push({ operation: h.operation, path: p });
      });
    }

    const expectedMonths = ['January','February','March','April','May','June','July','August','September','October','November','December'];
    const missing = actualFolders.length > 0 ? expectedMonths.filter(m => !actualFolders.includes(m)) : expectedMonths;
    const falseCompletion = completionSignals.length > 0 && actualFolders.length < 12;

    return {
      agentId: agent.id,
      agentName: agent.name,
      runId: agentRun.id,
      status: agentRun.status,
      stepsUsed: modelResponseLogs.length,
      totalCreateAttempts,
      alreadyExistsNoops,
      createdFolders,
      actualFolderCount: actualFolders.length,
      missingFolders: falseCompletion ? missing.join(',') : '',
      totalListOps,
      uniqueListPaths: uniqueListPaths.size,
      listPaths: Array.from(uniqueListPaths).sort(),
      completionSignals: completionSignals.length,
      completionOnStep: completionSignals.length > 0 ? completionSignals[0].step : null,
      falseCompletion,
      pathDriftCount: pathDrift.length,
      pathDrift: pathDrift,
      mutationThroughput: modelResponseLogs.length > 0 ? (createdFolders / modelResponseLogs.length).toFixed(2) : '0',
      error: agentRun.error || null
    };
  });

  return { label, ticketId, ticketStatus: ticket ? ticket.status : 'unknown', agentMetrics };
}

function printComparison(results) {
  results.forEach(r => {
    console.log(`\n--- ${r.label} ---`);
    r.agentMetrics.forEach(m => {
      console.log(`  A${m.agentId}: ${m.status} | steps=${m.stepsUsed} | creates=${m.totalCreateAttempts} | noops=${m.alreadyExistsNoops} | actual=${m.actualFolderCount}/12 | lists=${m.totalListOps} | drift=${m.pathDriftCount}`);
      if (m.falseCompletion) console.log(`    ⚠ FALSE COMPLETE on step ${m.completionOnStep} | missing: ${m.missingFolders}`);
      if (m.completionSignals > 0) console.log(`    completion signals: ${m.completionSignals} (step ${m.completionOnStep})`);
      if (m.listPaths.length > 0) console.log(`    listed: ${m.listPaths.join(', ')}`);
      if (m.pathDrift.length > 0) m.pathDrift.forEach(d => console.log(`    path drift: ${d.operation} ${d.path}`));
    });
  });

  console.log('\n=============================================');
  console.log('   COMPARISON');
  console.log('=============================================\n');
  console.log(`  ${'Metric'.padEnd(28)} A(exp only)  B(no list)   C(list err)`);
  console.log(`  ${'─'.repeat(60)}`);
  ['totalCreateAttempts','alreadyExistsNoops','createdFolders','actualFolderCount','totalListOps','stepsUsed','falseCompletion','pathDriftCount'].forEach(metric => {
    const vals = results.map(r => {
      const sum = r.agentMetrics.reduce((s, m) => {
        const v = m[metric];
        return typeof v === 'boolean' ? s + (v ? 1 : 0) : s + (v || 0);
      }, 0);
      return typeof r.agentMetrics[0][metric] === 'boolean'
        ? (r.agentMetrics.some(m => m[metric]) ? 'yes' : 'no ').padStart(12)
        : String(sum).padStart(12);
    });
    console.log(`  ${metric.padEnd(28)} ${vals[0]} ${vals[1]} ${vals[2]}`);
  });
}

async function runVariant(port, dataDir, wsRoot, agents, groupId, inspectionRule, label) {
  const baseUrl = `http://127.0.0.1:${port}`;

  const server = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      PORT: String(port),
      WORKSPACE_ROOT: wsRoot,
      DATA_DIR: dataDir,
      OPENAI_API_KEY: undefined
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  server.stdout.on('data', chunk => process.stdout.write(String(chunk)));
  server.stderr.on('data', chunk => process.stderr.write(String(chunk)));

  try {
    await waitForServer(baseUrl);
    const cookie = await login(baseUrl);

    const objective = [
      `Create folders for January through December inside your owned output path.`,
      `Each folder should be named the full month name (e.g. "January").`,
      `Create exactly 12 folders.`,
      `Do not create anything outside your owned path.`,
      `Once all 12 folders exist, set complete:true.`
    ].join(' ');

    console.log(`[${label}] Creating ticket...`);
    const ticket = await createTicketViaApi(baseUrl, dataDir, cookie, groupId, objective);
    if (inspectionRule) {
      modifyAllocationSubtask(dataDir, ticket.id, agents, inspectionRule);
    }

    console.log(`[${label}] Waiting for runs...`);
    const runs = await waitForTerminalRuns(dataDir, ticket.id, agents.length);
    console.log(`[${label}] Done: ${runs.map(r => `A${r.agentId}=${r.status}`).join(', ')}`);

    return collectMetrics(dataDir, ticket.id, agents, label, wsRoot);
  } finally {
    server.kill('SIGTERM');
    await waitForExit(server);
  }
}

async function main() {
  requireLiveTestEnv();

  const dataDirA = fs.mkdtempSync(path.join(os.tmpdir(), 'insp2-data-A-'));
  const dataDirB = fs.mkdtempSync(path.join(os.tmpdir(), 'insp2-data-B-'));
  const dataDirC = fs.mkdtempSync(path.join(os.tmpdir(), 'insp2-data-C-'));
  const wsRootA = createTempWorkspaceRoot('insp2-ws-A');
  const wsRootB = createTempWorkspaceRoot('insp2-ws-B');
  const wsRootC = createTempWorkspaceRoot('insp2-ws-C');

  try {
    const variants = [
      { port: 3521, dataDir: dataDirA, wsRoot: wsRootA, rule: null, label: 'A (explicit only)' },
      { port: 3522, dataDir: dataDirB, wsRoot: wsRootB, rule: 'no_list_first', label: 'B (no list first)' },
      { port: 3523, dataDir: dataDirC, wsRoot: wsRootC, rule: 'list_on_error', label: 'C (list on error)' },
    ];

    const results = [];
    for (const v of variants) {
      const { agents } = seedInitialData(v.dataDir);
      const group = readJson(v.dataDir, 'groups.json').find(g => g.name.startsWith('Insp2Group-'));
      if (!group) throw new Error('Seed data missing');
      console.log(`\nStarting variant on port ${v.port}...`);
      const r = await runVariant(v.port, v.dataDir, v.wsRoot, agents, group.id, v.rule, v.label);
      results.push(r);
    }

    printComparison(results);
  } finally {
    [dataDirA, dataDirB, dataDirC].forEach(d => fs.rmSync(d, { recursive: true, force: true }));
    [wsRootA, wsRootB, wsRootC].forEach(w => removeTempWorkspaceRoot(w));
  }
}

main().catch(error => {
  console.error(error.stack || error.message);
  process.exit(1);
});

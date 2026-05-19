const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { createTempWorkspaceRoot, removeTempWorkspaceRoot } = require('./test-workspace');

const ROOT = path.resolve(__dirname, '..');
const PORT_BASE = 3520;
const STAMP = Date.now();

function requireLiveTestEnv() {
  if (process.env.NODE_ENV !== 'test') throw new Error('Requires NODE_ENV=test');
  if (process.env.ALLOW_LIVE_OPENAI_TESTS !== 'true') throw new Error('Requires ALLOW_LIVE_OPENAI_TESTS=true');
  if (!process.env.OPENAI_API_KEY) throw new Error('Requires OPENAI_API_KEY');
  if (!process.env.OPENAI_MODEL) throw new Error('Requires OPENAI_MODEL');
}

function readJson(dir, file) {
  const fp = path.join(dir, file);
  for (let i = 0; i < 60; i++) {
    try { return JSON.parse(fs.readFileSync(fp, 'utf8')); } catch (e) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25); }
  }
  throw new Error(`Cannot read ${fp}`);
}

function writeJson(dir, file, value) {
  fs.writeFileSync(path.join(dir, file), JSON.stringify(value, null, 2));
}

function request(method, url, opts = {}) {
  const body = opts.form ? new URLSearchParams(opts.form).toString() : opts.body ? JSON.stringify(opts.body) : null;
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method, headers: {
      ...(body ? { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) } : {}),
      ...(opts.cookie ? { Cookie: opts.cookie } : {})
    } }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ statusCode: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function cookieFrom(r) { return (r.headers['set-cookie'] || []).map(c => c.split(';')[0]).join('; '); }
function waitForExit(child) { return new Promise(resolve => { if (child.exitCode !== null || child.killed) return resolve(); child.once('exit', () => resolve()); }); }

async function waitForServer(baseUrl) {
  const start = Date.now();
  while (Date.now() - start < 20000) {
    try { const r = await request('GET', `${baseUrl}/health`); if (r.statusCode === 200) { const b = JSON.parse(r.body); if (b.ready) return; } } catch (e) {}
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error('Server timeout');
}

async function login(baseUrl) {
  const r = await request('POST', `${baseUrl}/login`, { form: { username: 'admin', password: 'admin123' } });
  if (r.statusCode !== 302) throw new Error(`Login failed HTTP ${r.statusCode}`);
  return cookieFrom(r);
}

function seedInitialData(dataDir, wsRoot) {
  const agents = [{ id: 1, name: `BudgetAgent-${STAMP}`, type: 'agent', provider: 'openai', model: process.env.OPENAI_MODEL, apiKey: process.env.OPENAI_API_KEY, createdAt: new Date().toISOString() }];
  const groups = [
    { id: 1, name: 'Administrators', permissions: ['ticket:create','ticket:read','ticket:update','ticket:delete','user:create','user:read','user:update','user:delete','group:create','group:read','group:update','group:delete','permission:assign','workspace:read','workspace:write','workspace:reset'], canReceiveTickets: false },
  ];
  const memberships = [{ id: 1, principalType: 'user', principalId: 1, groupId: 1 }];
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

async function createTicket(baseUrl, dataDir, cookie, agentId, objective) {
  const r = await request('POST', `${baseUrl}/tickets`, {
    cookie,
    form: { objective, assignmentTargetType: 'agent', assignmentTargetId: String(agentId), assignmentMode: 'individual' }
  });
  if (r.statusCode !== 302) throw new Error(`Ticket create failed HTTP ${r.statusCode}: ${r.body}`);
  const tickets = readJson(dataDir, 'tickets.json');
  return tickets[tickets.length - 1];
}

async function waitForTicket(dataDir, ticketId) {
  const start = Date.now();
  while (Date.now() - start < 180000) {
    const runs = readJson(dataDir, 'runs.json').filter(r => r.ticketId === ticketId);
    if (runs.length > 0 && runs.every(r => ['completed', 'failed'].includes(r.status))) return ticketId;
    await new Promise(r => setTimeout(r, 500));
  }
  throw new Error(`Timeout ticket ${ticketId}`);
}

function collectMetrics(dataDir, ticketId, label, wsRoot, expectedCount) {
  const runs = readJson(dataDir, 'runs.json').filter(r => r.ticketId === ticketId);
  const logs = readJson(dataDir, 'logs.json').filter(l => l.ticketId === ticketId);
  const ticket = readJson(dataDir, 'tickets.json').find(t => t.id === ticketId);
  const run = runs[0];
  if (!run) return { label, status: 'no_run' };

  const rl = logs.filter(l => l.runId === run.id);
  const steps = rl.filter(l => l.type === 'model:response');
  const lists = rl.filter(l => l.type === 'workspace:list');
  const creates = rl.filter(l => l.type === 'workspace:create');
  const noopCreates = creates.filter(l => l.workspaceAction && l.workspaceAction.status === 'already_exists_noop').length;
  const realCreates = creates.filter(l => l.workspaceAction && l.workspaceAction.status === 'created').length;

  const completionSignals = [];
  steps.forEach(l => {
    try { const p = JSON.parse(l.message); if (p.complete === true) completionSignals.push(steps.indexOf(l)); } catch (e) {}
  });

  const expectedFolders = [];
  for (let i = 1; i <= expectedCount; i++) expectedFolders.push(`F${i}`);
  const foldersOnDisk = expectedFolders.filter(f => fs.existsSync(path.join(wsRoot, f)) && fs.statSync(path.join(wsRoot, f)).isDirectory());

  const stepBreakdown = steps.map((l, i) => {
    try {
      const p = JSON.parse(l.message);
      const actionPaths = (p.actions || []).map(a => ({ op: a.operation, path: a.args && a.args.path }));
      return { step: i, complete: p.complete || false, actions: actionPaths, message: (p.message || '').substring(0, 80) };
    } catch (e) {
      return { step: i, complete: false, actions: [], message: '(parse error)' };
    }
  });

  const budget = run.replaySnapshot ? run.replaySnapshot.runtimeLimits : {};
  return {
    label, ticketId, status: run.status, error: run.error || null,
    steps: steps.length, lists: lists.length,
    creates: creates.length, realCreates, noopCreates,
    foldersOnDisk: foldersOnDisk.length, expectedFolders: expectedCount,
    completionSignals: completionSignals.length,
    completionStep: completionSignals.length > 0 ? completionSignals[0] : null,
    budget,
    stepBreakdown,
  };
}

async function runVariant(port, dataDir, wsRoot, maxSteps, label) {
  const baseUrl = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      PORT: String(port),
      WORKSPACE_ROOT: wsRoot,
      DATA_DIR: dataDir,
      OPENAI_API_KEY: undefined,
      AGENT_MAX_EXECUTION_STEPS: String(maxSteps),
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  server.stdout.on('data', c => process.stdout.write(String(c)));
  server.stderr.on('data', c => process.stderr.write(String(c)));

  const objective = [
    `Required output: F1 through F24 folders.`,
    `Do not recreate existing folders.`,
    `List only if a create fails.`,
    `Once all 24 folders exist, set complete:true.`,
  ].join('\n');

  try {
    await waitForServer(baseUrl);
    const cookie = await login(baseUrl);
    const agent = readJson(dataDir, 'agents.json')[0];

    console.log(`[${label}] Creating ticket (${maxSteps} step budget)...`);
    const ticket = await createTicket(baseUrl, dataDir, cookie, agent.id, objective);
    console.log(`[${label}] Ticket #${ticket.id}. Waiting...`);
    await waitForTicket(dataDir, ticket.id);
    const runs = readJson(dataDir, 'runs.json').filter(r => r.ticketId === ticket.id);
    console.log(`[${label}] Done: ${runs.map(r => `R${r.id}=${r.status}`).join(', ')}`);

    return ticket.id;
  } finally {
    server.kill('SIGTERM');
    await waitForExit(server);
  }
}

async function main() {
  requireLiveTestEnv();

  const scenarios = [
    { label: 'Baseline: 4 steps', maxSteps: 4 },
    { label: 'Extra: 5 steps', maxSteps: 5 },
    { label: 'Extra: 6 steps', maxSteps: 6 },
  ];

  const results = [];
  for (const s of scenarios) {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'budget-data-'));
    const wsRoot = createTempWorkspaceRoot('budget-ws');
    seedInitialData(dataDir, wsRoot);

    const port = PORT_BASE + scenarios.indexOf(s);
    const ticketId = await runVariant(port, dataDir, wsRoot, s.maxSteps, s.label);
    const m = collectMetrics(dataDir, ticketId, s.label, wsRoot, 24);
    results.push(m);

    fs.rmSync(dataDir, { recursive: true, force: true });
    removeTempWorkspaceRoot(wsRoot);
  }

  console.log('\n============================================');
  console.log('   BUDGET EXPERIMENT RESULTS');
  console.log('============================================\n');

  results.forEach(r => {
    console.log(`--- ${r.label} ---`);
    console.log(`  Status: ${r.status}${r.error ? ' | ' + r.error.slice(0, 100) : ''}`);
    console.log(`  Budget: ${r.budget.maxExecutionSteps || '?'} steps max`);
    console.log(`  Steps used: ${r.steps} | Lists: ${r.lists} | Creates: ${r.creates} (${r.realCreates}r, ${r.noopCreates}n)`);
    console.log(`  Folders on disk: ${r.foldersOnDisk}/${r.expectedFolders}`);
    console.log(`  Completion: ${r.completionSignals} (step ${r.completionStep !== null ? r.completionStep : 'never'})`);
    r.stepBreakdown.forEach(sb => {
      const as = sb.actions.map(a => `${a.op}:${a.path}`).join(', ');
      console.log(`    Step ${sb.step}: complete=${sb.complete} | ${as.slice(0, 180)}`);
    });
    console.log('');
  });

  console.log('============================================');
  console.log('   COMPARISON');
  console.log('============================================\n');
  const h = `  ${'Metric'.padEnd(20)} ${results.map(r => r.label.padEnd(22)).join(' ')}`;
  console.log(h);
  console.log(`  ${'─'.repeat(20 + 23 * results.length)}`);
  ['status','steps','lists','noopCreates','realCreates','foldersOnDisk','expectedFolders'].forEach(k => {
    const vals = results.map(r => {
      const v = r[k] !== undefined && r[k] !== null ? String(r[k]) : '-';
      return v.padEnd(22);
    });
    console.log(`  ${k.padEnd(20)} ${vals.join(' ')}`);
  });
  console.log('');
}

main().catch(e => { console.error(e.stack || e.message); process.exit(1); });

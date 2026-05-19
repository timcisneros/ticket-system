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
  for (let i = 0; i < 120; i++) {
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
    const req = http.request(urlPath, { method, headers: {
      ...(body ? { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) } : {}),
      ...(options.cookie ? { Cookie: options.cookie } : {})
    } }, res => {
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
    try { const r = await request('GET', `${baseUrl}/health`); if (r.statusCode === 200) { const b = JSON.parse(r.body); if (b.ready) return; } } catch (e) {}
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  throw new Error('Timed out waiting for server');
}

async function login(baseUrl) {
  const response = await request('POST', `${baseUrl}/login`, { form: { username: 'admin', password: 'admin123' } });
  if (response.statusCode !== 302) throw new Error(`Admin login failed with HTTP ${response.statusCode}`);
  return cookieFrom(response);
}

function seedAllData(dataDir, wsRoot) {
  fs.mkdirSync(path.join(wsRoot, 'continuation-work'), { recursive: true });
  const preExisting = ['January','February','March','April','May','June'];
  preExisting.forEach(m => fs.mkdirSync(path.join(wsRoot, 'continuation-work', m)));

  const agents = [
    { id: 1, name: 'SingleAgent', type: 'agent', provider: 'openai', model: process.env.OPENAI_MODEL, apiKey: process.env.OPENAI_API_KEY, createdAt: new Date().toISOString() }
  ];
  const groups = [
    { id: 1, name: 'Administrators', permissions: ['ticket:create','ticket:read','ticket:update','ticket:delete','user:create','user:read','user:update','user:delete','group:create','group:read','group:update','group:delete','permission:assign','workspace:read','workspace:write','workspace:reset'], canReceiveTickets: false },
  ];
  const memberships = [
    { id: 1, principalType: 'user', principalId: 1, groupId: 1 },
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
  return agents[0];
}

async function createTicket(baseUrl, dataDir, cookie, agentId, objective) {
  const response = await request('POST', `${baseUrl}/tickets`, {
    cookie,
    form: { objective, assignmentTargetType: 'agent', assignmentTargetId: String(agentId) }
  });
  if (response.statusCode !== 302) throw new Error(`Ticket create failed HTTP ${response.statusCode}: ${response.body.slice(0, 200)}`);
  const tickets = readJson(dataDir, 'tickets.json');
  return tickets[tickets.length - 1];
}

async function waitForTerminalRun(dataDir, ticketId) {
  const started = Date.now();
  while (Date.now() - started < 180000) {
    const runs = readJson(dataDir, 'runs.json').filter(r => r.ticketId === ticketId);
    if (runs.length > 0 && runs.every(r => ['completed', 'failed'].includes(r.status))) return runs;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error(`Timed out waiting for terminal run for ticket ${ticketId}`);
}

function collectMetrics(dataDir, ticketId, label, wsRoot) {
  const runs = readJson(dataDir, 'runs.json').filter(r => r.ticketId === ticketId);
  const logs = readJson(dataDir, 'logs.json').filter(l => l.ticketId === ticketId);
  const history = readJson(dataDir, 'operation-history.json').filter(h => h.ticketId === ticketId);
  const ticket = readJson(dataDir, 'tickets.json').find(t => t.id === ticketId);
  const run = runs[0];

  if (!run) return { label, error: 'No run found', ticketId };

  const runLogs = logs.filter(l => l.runId === run.id);
  const runHistory = history.filter(h => h.runId === run.id);
  const modelResponseLogs = runLogs.filter(l => l.type === 'model:response');
  const listLogs = runLogs.filter(l => l.type === 'workspace:list');
  const createLogs = runLogs.filter(l => l.type === 'workspace:create');

  const alreadyExistsNoops = createLogs.filter(l => l.workspaceAction && l.workspaceAction.status === 'already_exists_noop').length;
  const createdFolders = createLogs.filter(l => l.workspaceAction && l.workspaceAction.status === 'created').length;
  const totalCreateAttempts = createLogs.length;
  const totalListOps = listLogs.length;
  const uniqueListPaths = new Set(listLogs.map(l => l.workspaceAction ? l.workspaceAction.args.path : null).filter(Boolean));

  const targetDir = path.join(wsRoot, 'continuation-work');
  let actualFolders = [];
  try {
    if (fs.existsSync(targetDir)) {
      const entries = fs.readdirSync(targetDir);
      entries.forEach(f => {
        try { if (fs.statSync(path.join(targetDir, f)).isDirectory()) actualFolders.push(f); } catch (e) {}
      });
    }
  } catch (e) {}

  const expected = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  const present = expected.filter(m => actualFolders.includes(m));
  const missing = expected.filter(m => !actualFolders.includes(m));
  const extras = actualFolders.filter(f => !expected.includes(f));

  const completionSignals = [];
  modelResponseLogs.forEach(l => {
    try { const p = JSON.parse(l.message); if (p.complete === true) completionSignals.push({ step: modelResponseLogs.indexOf(l) }); } catch (e) {}
  });

  const pathDrift = runHistory.filter(h => {
    const p = h.args && h.args.path ? h.args.path : '';
    return !p.startsWith('continuation-work/');
  });

  return {
    label,
    ticketId,
    ticketObjective: ticket ? ticket.objective.slice(0, 120) : 'unknown',
    runStatus: run.status,
    runError: run.error || null,
    stepsUsed: modelResponseLogs.length,
    totalCreateAttempts,
    alreadyExistsNoops,
    createdFolders,
    actualFolders: present.length,
    totalMissing: missing.length,
    missing,
    extras,
    totalListOps,
    uniqueListPaths: uniqueListPaths.size,
    listPaths: Array.from(uniqueListPaths).sort(),
    completionSignals: completionSignals.length,
    completionOnStep: completionSignals.length > 0 ? completionSignals[0].step : null,
    pathDriftCount: pathDrift.length,
    pathDrift: pathDrift.map(h => ({ op: h.operation, path: (h.args && h.args.path) || '' })),
    mutationThroughput: modelResponseLogs.length > 0 ? (createdFolders / modelResponseLogs.length).toFixed(2) : '0'
  };
}

async function runVariant(port, dataDir, wsRoot, variant) {
  const baseUrl = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, NODE_ENV: 'test', PORT: String(port), WORKSPACE_ROOT: wsRoot, DATA_DIR: dataDir, OPENAI_API_KEY: undefined },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  server.stdout.on('data', chunk => process.stdout.write(String(chunk)));
  server.stderr.on('data', chunk => process.stderr.write(String(chunk)));

  try {
    await waitForServer(baseUrl);
    const cookie = await login(baseUrl);
    const agent = readJson(dataDir, 'agents.json')[0];

    console.log(`[${variant.label}] Creating ticket...`);
    const ticket = await createTicket(baseUrl, dataDir, cookie, agent.id, variant.objective);
    console.log(`[${variant.label}] Ticket #${ticket.id} created.`);

    console.log(`[${variant.label}] Waiting for run...`);
    const runs = await waitForTerminalRun(dataDir, ticket.id);
    console.log(`[${variant.label}] Done: ${runs.map(r => `R${r.id}=${r.status}`).join(', ')}`);

    return collectMetrics(dataDir, ticket.id, variant.label, wsRoot);
  } finally {
    server.kill('SIGTERM');
    await waitForExit(server);
  }
}

async function main() {
  requireLiveTestEnv();

  const existingMonths = ['January','February','March','April','May','June'];
  const missingMonths = ['July','August','September','October','November','December'];
  const monthList = missingMonths.join(', ');
  const pathList = missingMonths.map(m => `continuation-work/${m}`).join('\n- ');

  const variants = [
    {
      label: 'A (defensive)',
      objective: [
        `Continue work.`,
        `A previous run created month folders January through June inside continuation-work/.`,
        `Inspect existing structure first.`,
        `Create only the missing month folders: ${monthList}.`,
        `Do not recreate existing folders.`,
        `Once all 6 missing folders exist, set complete:true.`
      ].join(' ')
    },
    {
      label: 'B (optimistic)',
      objective: [
        `Continue work.`,
        `A previous run created month folders January through June inside continuation-work/.`,
        `Create exactly these remaining folders:`,
        `- ${pathList}`,
        `List only if a create fails.`,
        `Do not recreate existing folders.`,
        `Once all 6 folders exist, set complete:true.`
      ].join(' ')
    }
  ];

  const results = [];
  for (const v of variants) {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cont-data-'));
    const wsRoot = createTempWorkspaceRoot('cont-ws');
    const agent = seedAllData(dataDir, wsRoot);
    console.log(`\nPre-seeded: 6/12 folders (Jan-Jun exist). Task: create ${missingMonths.length} remaining.`);

    const port = v.label === 'A (defensive)' ? 3531 : 3532;
    const r = await runVariant(port, dataDir, wsRoot, { ...v, objective: v.objective });
    results.push(r);

    fs.rmSync(dataDir, { recursive: true, force: true });
    removeTempWorkspaceRoot(wsRoot);
  }

  console.log('\n============================================');
  console.log('   CONTINUATION STRATEGY EXPERIMENT');
  console.log('============================================\n');

  results.forEach(r => {
    console.log(`--- ${r.label} ---`);
    console.log(`  Run status: ${r.runStatus}${r.runError ? ' | error: ' + r.runError.slice(0, 100) : ''}`);
    console.log(`  Steps: ${r.stepsUsed} | Creates: ${r.totalCreateAttempts} | No-ops: ${r.alreadyExistsNoops} | Created: ${r.createdFolders}`);
    console.log(`  Folders on disk: ${r.actualFolders}/12 | Missing: ${r.totalMissing > 0 ? r.missing.join(', ') : 'none'}`);
    console.log(`  List ops: ${r.totalListOps} (${r.uniqueListPaths} unique)${r.listPaths.length > 0 ? ': ' + r.listPaths.join(', ') : ''}`);
    console.log(`  Completion signals: ${r.completionSignals}${r.completionOnStep !== null ? ' (step ' + r.completionOnStep + ')' : ''}`);
    console.log(`  Path drift: ${r.pathDriftCount}${r.pathDrift.length > 0 ? ' | ' + r.pathDrift.map(d => d.op + ' ' + d.path).join(', ') : ''}`);
    console.log(`  Mutation throughput: ${r.mutationThroughput} creates/step`);
    if (r.extras.length > 0) console.log(`  Extra folders created: ${r.extras.join(', ')}`);
    console.log('');
  });

  console.log('============================================');
  console.log('   COMPARISON');
  console.log('============================================\n');
  const header = `  ${'Metric'.padEnd(28)} A (defensive)   B (optimistic)`;
  console.log(header);
  console.log(`  ${'─'.repeat(55)}`);
  [
    ['stepsUsed', false],
    ['totalCreateAttempts', false],
    ['alreadyExistsNoops', false],
    ['createdFolders', false],
    ['actualFolders', false],
    ['totalMissing', false],
    ['totalListOps', false],
    ['uniqueListPaths', false],
    ['completionSignals', false],
    ['pathDriftCount', false],
  ].forEach(([key]) => {
    const vals = results.map(r => String(r[key] || 0).padStart(13));
    console.log(`  ${key.padEnd(28)} ${vals[0]} ${vals[1]}`);
  });
  console.log(`  ${'extras'.padEnd(28)} ${(results[0].extras || []).join(',').padStart(13)} ${(results[1].extras || []).join(',').padStart(13)}`);
  console.log(`  ${'completion step'.padEnd(28)} ${String(results[0].completionOnStep ?? '-').padStart(13)} ${String(results[1].completionOnStep ?? '-').padStart(13)}`);
  console.log(`  ${'mutation/step'.padEnd(28)} ${results[0].mutationThroughput.padStart(13)} ${results[1].mutationThroughput.padStart(13)}`);
}

main().catch(error => {
  console.error(error.stack || error.message);
  process.exit(1);
});

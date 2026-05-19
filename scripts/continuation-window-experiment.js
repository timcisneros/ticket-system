const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { createTempWorkspaceRoot, removeTempWorkspaceRoot } = require('./test-workspace');

const ROOT = path.resolve(__dirname, '..');
const PORT = process.env.PORT || '3450';
const BASE_URL = `http://127.0.0.1:${PORT}`;
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

function request(method, urlPath, opts = {}) {
  const body = opts.form ? new URLSearchParams(opts.form).toString() : opts.body ? JSON.stringify(opts.body) : null;
  return new Promise((resolve, reject) => {
    const req = http.request(`${BASE_URL}${urlPath}`, {
      method,
      headers: {
        ...(body ? { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) } : {}),
        ...(opts.cookie ? { Cookie: opts.cookie } : {})
      }
    }, res => {
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

async function waitForServer() {
  const start = Date.now();
  while (Date.now() - start < 15000) {
    try { const r = await request('GET', '/login'); if (r.statusCode === 200) return; } catch (e) {}
    await new Promise(r => setTimeout(r, 150));
  }
  throw new Error('Timeout');
}

async function login() {
  const r = await request('POST', '/login', { form: { username: 'admin', password: 'admin123' } });
  if (r.statusCode !== 302) throw new Error(`Login failed HTTP ${r.statusCode}`);
  return cookieFrom(r);
}

function seedInitialData(dataDir, wsRoot) {
  const agents = [{ id: 1, name: `ContAgent-${STAMP}`, type: 'agent', provider: 'openai', model: process.env.OPENAI_MODEL, apiKey: process.env.OPENAI_API_KEY, createdAt: new Date().toISOString() }];
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

async function createTicket(dataDir, cookie, agentId, objective) {
  const r = await request('POST', '/tickets', {
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

function makeExpectedFolders(count) {
  const result = [];
  for (let i = 1; i <= count; i++) result.push(`F${i}`);
  return result;
}

function collectMetrics(dataDir, ticketId, label, wsRoot, expectedCount) {
  const runs = readJson(dataDir, 'runs.json').filter(r => r.ticketId === ticketId);
  const logs = readJson(dataDir, 'logs.json').filter(l => l.ticketId === ticketId);
  const history = readJson(dataDir, 'operation-history.json').filter(h => h.ticketId === ticketId);
  const ticket = readJson(dataDir, 'tickets.json').find(t => t.id === ticketId);
  const run = runs[0];
  if (!run) return { label, status: 'no_run', ticketId };

  const rl = logs.filter(l => l.runId === run.id);
  const rh = history.filter(h => h.runId === run.id);
  const steps = rl.filter(l => l.type === 'model:response');
  const lists = rl.filter(l => l.type === 'workspace:list');
  const creates = rl.filter(l => l.type === 'workspace:create');
  const noopCreates = creates.filter(l => l.workspaceAction && l.workspaceAction.status === 'already_exists_noop').length;
  const realCreates = creates.filter(l => l.workspaceAction && l.workspaceAction.status === 'created').length;
  const uniqueListPaths = new Set(lists.map(l => l.workspaceAction ? l.workspaceAction.args.path : null).filter(Boolean));

  const completionSignals = [];
  steps.forEach(l => {
    try { const p = JSON.parse(l.message); if (p.complete === true) completionSignals.push(steps.indexOf(l)); } catch (e) {}
  });

  const expectedFolders = makeExpectedFolders(expectedCount);
  const foldersOnDisk = expectedFolders.filter(f => fs.existsSync(path.join(wsRoot, f)) && fs.statSync(path.join(wsRoot, f)).isDirectory());

  const pathDrift = rh.filter(h => {
    const p = h.args && h.args.path ? h.args.path : '';
    if (!p || h.operation === 'listDirectory') return false;
    return !expectedFolders.includes(p);
  });

  const stepBreakdown = steps.map((l, i) => {
    try {
      const p = JSON.parse(l.message);
      const actionPaths = (p.actions || []).map(a => ({ op: a.operation, path: a.args && a.args.path }));
      return { step: i, complete: p.complete || false, actions: actionPaths };
    } catch (e) {
      return { step: i, complete: false, actions: [] };
    }
  });

  return {
    label,
    ticketId,
    status: run.status,
    error: run.error || null,
    steps: steps.length,
    lists: lists.length,
    uniqueListPaths: uniqueListPaths.size,
    creates: creates.length,
    realCreates,
    noopCreates,
    totalMutations: realCreates,
    foldersOnDisk: foldersOnDisk.length,
    expectedFolders: expectedCount,
    completionSignals: completionSignals.length,
    completionStep: completionSignals.length > 0 ? completionSignals[0] : null,
    pathDrift: pathDrift.length,
    stepBreakdown,
  };
}

async function main() {
  requireLiveTestEnv();

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cont-data-'));
  const wsRoot = createTempWorkspaceRoot('cont-ws');
  let server = null;

  try {
    seedInitialData(dataDir, wsRoot);

    server = spawn(process.execPath, ['server.js'], {
      cwd: ROOT,
      env: {
        ...process.env,
        NODE_ENV: 'test',
        PORT,
        WORKSPACE_ROOT: wsRoot,
        DATA_DIR: dataDir,
        OPENAI_API_KEY: undefined
      },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    server.stdout.on('data', c => process.stdout.write(String(c)));
    server.stderr.on('data', c => process.stderr.write(String(c)));

    await waitForServer();
    const cookie = await login();
    const agent = readJson(dataDir, 'agents.json')[0];

    // ====================================================================
    // Phase 1: Create F1-F24 (known to fail at ~16)
    // ====================================================================
    console.log('\n=== PHASE 1: Create 24 folders (exceeds 2-step ceiling) ===');
    const p1Obj = [
      `Required output: F1 through F24 folders.`,
      `Do not recreate existing folders.`,
      `List only if a create fails.`,
      `Once all 24 folders exist, set complete:true.`,
    ].join('\n');

    console.log('Creating ticket...');
    const p1Ticket = await createTicket(dataDir, cookie, agent.id, p1Obj);
    console.log(`Ticket #${p1Ticket.id}. Waiting...`);
    const p1Id = await waitForTicket(dataDir, p1Ticket.id);
    console.log(`Phase 1 ticket #${p1Id} done.`);
    const m1 = collectMetrics(dataDir, p1Id, 'Phase 1: 24 folders', wsRoot, 24);

    // Check what's actually on disk
    const foldersOnDisk = [];
    for (let i = 1; i <= 24; i++) {
      if (fs.existsSync(path.join(wsRoot, `F${i}`)) && fs.statSync(path.join(wsRoot, `F${i}`)).isDirectory()) {
        foldersOnDisk.push(`F${i}`);
      }
    }
    const missingFolders = [];
    for (let i = 1; i <= 24; i++) {
      if (!foldersOnDisk.includes(`F${i}`)) missingFolders.push(`F${i}`);
    }
    console.log(`\nFolders on disk after Phase 1: ${foldersOnDisk.length}/24`);
    console.log(`Existing: ${foldersOnDisk.join(', ')}`);
    console.log(`Missing: ${missingFolders.join(', ')}`);

    // ====================================================================
    // Phase 2: Continuation ticket enumerating missing items
    // ====================================================================
    console.log('\n=== PHASE 2: Continuation (OPERATIONS.md Section 3 template) ===');
    const missingList = missingFolders.map(f => `- ${f}`).join('\n');
    const p2Obj = [
      `Remaining work after previous run:`,
      ``,
      `Existing folders: ${foldersOnDisk.join(', ')}`,
      `Missing folders:`,
      `${missingList}`,
      ``,
      `Create only these missing folders.`,
      `List only if a create fails.`,
      `Once all ${missingFolders.length} folders exist, set complete:true.`,
      `Total expected work: ${missingFolders.length} folder creates.`,
    ].join('\n');

    console.log('Creating continuation ticket...');
    const p2Ticket = await createTicket(dataDir, cookie, agent.id, p2Obj);
    console.log(`Ticket #${p2Ticket.id}. Waiting...`);
    const p2Id = await waitForTicket(dataDir, p2Ticket.id);
    console.log(`Phase 2 ticket #${p2Id} done.`);
    const m2 = collectMetrics(dataDir, p2Id, 'Phase 2: Continuation', wsRoot, 24);

    // Final state
    const finalFolders = [];
    for (let i = 1; i <= 24; i++) {
      if (fs.existsSync(path.join(wsRoot, `F${i}`)) && fs.statSync(path.join(wsRoot, `F${i}`)).isDirectory()) {
        finalFolders.push(`F${i}`);
      }
    }

    // ====================================================================
    // Report
    // ====================================================================
    console.log('\n============================================');
    console.log('   CONTINUATION RESETS WINDOW');
    console.log('============================================\n');

    [m1, m2].forEach(m => {
      console.log(`--- ${m.label} ---`);
      console.log(`  Status: ${m.status}${m.error ? ' | ' + m.error.slice(0, 120) : ''}`);
      console.log(`  Steps: ${m.steps} | Lists: ${m.lists} | Creates: ${m.creates} (${m.realCreates} real, ${m.noopCreates} noop)`);
      console.log(`  Folders on disk: ${m.foldersOnDisk}/${m.expectedFolders}`);
      console.log(`  Completion signals: ${m.completionSignals} (step ${m.completionStep !== null ? m.completionStep : 'never'})`);
      console.log(`  Path drift: ${m.pathDrift}`);
      console.log(`  Step breakdown:`);
      m.stepBreakdown.forEach(sb => {
        const as = sb.actions.map(a => `${a.op}:${a.path}`).join(', ');
        console.log(`    Step ${sb.step}: complete=${sb.complete} | ${as.slice(0, 160)}`);
      });
      console.log('');
    });

    console.log(`Final state: ${finalFolders.length}/24 folders on disk`);
    console.log(`Missing after Phase 2: ${missingFolders.filter(f => !finalFolders.includes(f)).join(', ') || 'none'}`);

    console.log('\n============================================');
    console.log('   PASS/FAIL');
    console.log('============================================\n');
    const checks = [
      { name: 'Phase 1: fails (expected — exceeds 2-step ceiling)', pass: m1.status === 'failed' },
      { name: 'Phase 1: created ~16 folders', pass: m1.foldersOnDisk >= 14 && m1.foldersOnDisk <= 18, detail: `(${m1.foldersOnDisk})` },
      { name: 'Phase 2: completes (continuation resets window)', pass: m2.status === 'completed' },
      { name: 'Phase 2: 0 no-op creates', pass: m2.noopCreates === 0 },
      { name: 'Phase 2: 0 lists or 1 list only', pass: m2.lists <= 1, detail: `(${m2.lists})` },
      { name: 'Phase 2: all missing folders created', pass: finalFolders.length === 24, detail: `(${finalFolders.length}/24)` },
      { name: 'Phase 2: completed in ≤ 2 steps', pass: m2.steps <= 2, detail: `(${m2.steps} steps)` },
    ];
    checks.forEach(c => {
      const icon = c.pass ? 'PASS' : 'FAIL';
      const detail = c.detail || '';
      console.log(`  [${icon}] ${c.name} ${detail}`);
    });
    const allPass = checks.every(c => c.pass);
    console.log(`\n  Overall: ${allPass ? 'ALL PASS - Continuation resets the progress tracking window' : 'SOME FAILURES'}`);

  } finally {
    if (server) { server.kill('SIGTERM'); await waitForExit(server); }
    removeTempWorkspaceRoot(wsRoot);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

main().catch(e => { console.error(e.stack || e.message); process.exit(1); });

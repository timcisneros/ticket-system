const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { createTempWorkspaceRoot, removeTempWorkspaceRoot } = require('./test-workspace');

const ROOT = path.resolve(__dirname, '..');
const PORT = process.env.PORT || '3428';
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
  throw new Error('Timeout waiting for server');
}

async function login() {
  const r = await request('POST', '/login', { form: { username: 'admin', password: 'admin123' } });
  if (r.statusCode !== 302) throw new Error(`Login failed HTTP ${r.statusCode}`);
  return cookieFrom(r);
}

function seedInitialData(dataDir, wsRoot) {
  const agents = [{ id: 1, name: `ValAgent-${STAMP}`, type: 'agent', provider: 'openai', model: process.env.OPENAI_MODEL, apiKey: process.env.OPENAI_API_KEY, createdAt: new Date().toISOString() }];
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
  return agents[0];
}

async function createTicket(baseUrl, dataDir, cookie, agentId, objective) {
  const r = await request('POST', '/tickets', {
    cookie,
    form: { objective, assignmentTargetType: 'agent', assignmentTargetId: String(agentId), assignmentMode: 'individual' }
  });
  if (r.statusCode !== 302) throw new Error(`Ticket create failed HTTP ${r.statusCode}`);
  const tickets = readJson(dataDir, 'tickets.json');
  return tickets[tickets.length - 1];
}

async function waitForRun(dataDir, ticketId) {
  const start = Date.now();
  while (Date.now() - start < 180000) {
    const runs = readJson(dataDir, 'runs.json').filter(r => r.ticketId === ticketId);
    if (runs.length > 0 && runs.every(r => ['completed', 'failed'].includes(r.status))) return runs;
    await new Promise(r => setTimeout(r, 500));
  }
  throw new Error(`Timeout ticket ${ticketId}`);
}

function collectMetrics(dataDir, ticketId, label, wsRoot) {
  const runs = readJson(dataDir, 'runs.json').filter(r => r.ticketId === ticketId);
  const logs = readJson(dataDir, 'logs.json').filter(l => l.ticketId === ticketId);
  const history = readJson(dataDir, 'operation-history.json').filter(h => h.ticketId === ticketId);
  const ticket = readJson(dataDir, 'tickets.json').find(t => t.id === ticketId);
  const run = runs[0];
  if (!run) return { label, status: 'no_run', ticketId, ticketObjective: ticket ? ticket.objective : '(unknown)' };

  const rl = logs.filter(l => l.runId === run.id);
  const rh = history.filter(h => h.runId === run.id);
  const steps = rl.filter(l => l.type === 'model:response');
  const lists = rl.filter(l => l.type === 'workspace:list');
  const creates = rl.filter(l => l.type === 'workspace:create');
  const writes = rl.filter(l => l.type === 'workspace:write');

  const noopCreates = creates.filter(l => l.workspaceAction && l.workspaceAction.status === 'already_exists_noop').length;
  const realCreates = creates.filter(l => l.workspaceAction && l.workspaceAction.status === 'created').length;
  const writeCount = writes.filter(l => l.workspaceAction && l.workspaceAction.status === 'created').length;
  const noopWrites = writes.filter(l => l.workspaceAction && l.workspaceAction.status === 'already_exists_noop').length;

  const completionSignals = [];
  steps.forEach(l => {
    try { const p = JSON.parse(l.message); if (p.complete === true) completionSignals.push(steps.indexOf(l)); } catch (e) {}
  });

  const pathDrift = rh.filter(h => {
    const p = h.args && h.args.path ? h.args.path : '';
    return !p.startsWith('docs/') && h.operation !== 'listDirectory';
  });

  const uniqueListPaths = new Set(lists.map(l => l.workspaceAction ? l.workspaceAction.args.path : null).filter(Boolean));

  // Check what was actually created on disk
  const expectedPaths = [
    'docs/getting-started/index.md',
    'docs/guides/index.md',
    'docs/api/index.md',
    'docs/reference/index.md',
  ];
  const expectedPhase2 = [
    'docs/getting-started/installation.md',
    'docs/guides/basic-usage.md',
    'docs/api/endpoints.md',
    'docs/reference/configuration.md',
  ];

  const existingFiles = expectedPaths.map(p => ({ path: p, exists: fs.existsSync(path.join(wsRoot, p)) }));
  const existingPhase2Files = expectedPhase2.map(p => ({ path: p, exists: fs.existsSync(path.join(wsRoot, p)) }));

  const foldersOnDisk = ['docs','docs/getting-started','docs/guides','docs/api','docs/reference'].filter(f => {
    const fp = path.join(wsRoot, f);
    return fs.existsSync(fp) && fs.statSync(fp).isDirectory();
  });

  return {
    label,
    ticketId,
    ticketObjective: ticket ? ticket.objective.slice(0, 200) : '(unknown)',
    status: run.status,
    error: run.error || null,
    steps: steps.length,
    lists: lists.length,
    uniqueListPaths: uniqueListPaths.size,
    creates: creates.length,
    realCreates,
    noopCreates,
    writes: writes.length,
    realWrites: writeCount,
    noopWrites,
    totalMutations: realCreates + writeCount,
    completionSignals: completionSignals.length,
    completionStep: completionSignals.length > 0 ? completionSignals[0] : null,
    foldersOnDisk: foldersOnDisk.length,
    expectedFolders: 5,
    filesOnDisk: existingFiles.filter(f => f.exists).length,
    expectedFiles: 4,
    phase2FilesOnDisk: existingPhase2Files.filter(f => f.exists).length,
    expectedPhase2Files: 4,
    pathDrift: pathDrift.length,
    pathDriftItems: pathDrift.map(h => ({ op: h.operation, path: (h.args && h.args.path) || '' })),
  };
}

async function runPhase(dataDir, wsRoot, cookie, agent, phaseNum, objective) {
  console.log(`\n=== Phase ${phaseNum} ===`);
  console.log(`Creating ticket...`);
  const ticket = await createTicket(BASE_URL, dataDir, cookie, agent.id, objective);
  console.log(`Ticket #${ticket.id} created. Waiting for run...`);
  const runs = await waitForRun(dataDir, ticket.id);
  console.log(`Done: ${runs.map(r => `R${r.id}=${r.status}`).join(', ')}`);
  return ticket.id;
}

async function main() {
  requireLiveTestEnv();

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'val-data-'));
  const wsRoot = createTempWorkspaceRoot('val-ws');
  let server = null;

  try {
    const agent = seedInitialData(dataDir, wsRoot);

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

    // ====================================================================
    // Phase 1: Create docs structure using docs/OPERATIONS.md Section 4 template
    // ====================================================================
    const phase1Objective = [
      `Create a documentation project inside workspace:`,
      ``,
      `Required output:`,
      `- docs/`,
      `- docs/getting-started/`,
      `- docs/getting-started/index.md with content "# Getting Started"`,
      `- docs/guides/`,
      `- docs/guides/index.md with content "# Guides"`,
      `- docs/api/`,
      `- docs/api/index.md with content "# API Reference"`,
      `- docs/reference/`,
      `- docs/reference/index.md with content "# Reference"`,
      ``,
      `List only if a create/write fails.`,
      `Once all 4 section folders and 4 index files exist, set complete:true.`,
      `Total expected work: 5 folder creates + 4 file writes = 9 operations.`,
    ].join('\n');

    console.log('\n=== PHASE 1: Create docs structure (docs/OPERATIONS.md Section 4 template) ===');
    const t1Id = await runPhase(dataDir, wsRoot, cookie, agent, 1, phase1Objective);
    const m1 = collectMetrics(dataDir, t1Id, 'Phase 1 - Docs scaffold', wsRoot);

    // ====================================================================
    // Phase 2: Continuation using docs/OPERATIONS.md Section 3 template
    // ====================================================================
    const phase2Objective = [
      `Remaining work after docs scaffold:`,
      ``,
      `Existing state: docs/ folder with getting-started/, guides/, api/, reference/ sections. Each section has index.md.`,
      ``,
      `Missing files to create:`,
      `- docs/getting-started/installation.md`,
      `- docs/guides/basic-usage.md`,
      `- docs/api/endpoints.md`,
      `- docs/reference/configuration.md`,
      ``,
      `Create only these 4 files. Content is up to you (a few lines each).`,
      `List only if a create/write fails.`,
      `Once all 4 files exist, set complete:true.`,
      `Total expected work: 4 file writes.`,
    ].join('\n');

    console.log('\n=== PHASE 2: Continuation (docs/OPERATIONS.md Section 3 template) ===');
    const t2Id = await runPhase(dataDir, wsRoot, cookie, agent, 2, phase2Objective);
    const m2 = collectMetrics(dataDir, t2Id, 'Phase 2 - Continuation', wsRoot);

    // ====================================================================
    // Report
    // ====================================================================
    console.log('\n============================================');
    console.log('   docs/OPERATIONS.md VALIDATION RESULTS');
    console.log('============================================\n');

    [m1, m2].forEach(m => {
      console.log(`--- ${m.label} ---`);
      console.log(`  Ticket #${m.ticketId} | Status: ${m.status}${m.error ? ' | ' + m.error.slice(0, 100) : ''}`);
      console.log(`  Steps: ${m.steps} | Lists: ${m.lists} (${m.uniqueListPaths} paths) | Creates: ${m.creates} (${m.realCreates} real, ${m.noopCreates} noop) | Writes: ${m.writes} (${m.realWrites} real, ${m.noopWrites} noop)`);
      console.log(`  Total mutations: ${m.totalMutations}`);
      console.log(`  Folders on disk: ${m.foldersOnDisk}/${m.expectedFolders}`);
      console.log(`  Files on disk: ${m.filesOnDisk}/${m.expectedFiles}${m.phase2FilesOnDisk !== undefined ? ` | Continuation files: ${m.phase2FilesOnDisk}/${m.expectedPhase2Files}` : ''}`);
      console.log(`  Completion signals: ${m.completionSignals}${m.completionStep !== null ? ' (step ' + m.completionStep + ')' : ''}`);
      console.log(`  Path drift: ${m.pathDrift}${m.pathDriftItems.length ? ' | ' + m.pathDriftItems.map(d => d.op + ' ' + d.path).join(', ') : ''}`);
      console.log('');
    });

    console.log('============================================');
    console.log('   PASS/FAIL');
    console.log('============================================\n');

    const checks = [
      { name: 'Phase 1: completed', pass: m1.status === 'completed' },
      { name: 'Phase 1: 0 no-op creates', pass: m1.noopCreates === 0 },
      { name: 'Phase 1: 0 no-op writes', pass: m1.noopWrites === 0 },
      { name: 'Phase 1: all 5 folders on disk', pass: m1.foldersOnDisk === m1.expectedFolders },
      { name: 'Phase 1: all 4 files on disk', pass: m1.filesOnDisk === m1.expectedFiles },
      { name: 'Phase 1: completed in ≤ 2 steps', pass: m1.steps <= 2, detail: `(${m1.steps} steps)` },
      { name: 'Phase 1: ≤ 1 list operation', pass: m1.lists <= 1, detail: `(${m1.lists} lists)` },
      { name: 'Phase 2: completed', pass: m2.status === 'completed' },
      { name: 'Phase 2: 0 no-op creates', pass: m2.noopCreates === 0 },
      { name: 'Phase 2: 0 no-op writes', pass: m2.noopWrites === 0 },
      { name: 'Phase 2: all 4 continuation files on disk', pass: m2.phase2FilesOnDisk === m2.expectedPhase2Files },
      { name: 'Phase 2: completed in ≤ 2 steps', pass: m2.steps <= 2, detail: `(${m2.steps} steps)` },
      { name: 'Phase 2: 0 path drift (mutations outside docs/)', pass: m2.pathDrift === 0 },
      { name: 'No data is overwritten or deleted (existing files preserved)', pass: m1.filesOnDisk === 4 && m2.filesOnDisk === 4 },
    ];

    checks.forEach(c => {
      const icon = c.pass ? 'PASS' : 'FAIL';
      const detail = c.detail || '';
      console.log(`  [${icon}] ${c.name} ${detail}`);
    });

    const allPass = checks.every(c => c.pass);
    console.log(`\n  Overall: ${allPass ? 'ALL PASS - docs/OPERATIONS.md guidance validated' : 'SOME FAILURES - review above'}`);

  } finally {
    if (server) { server.kill('SIGTERM'); await waitForExit(server); }
    removeTempWorkspaceRoot(wsRoot);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

main().catch(e => { console.error(e.stack || e.message); process.exit(1); });

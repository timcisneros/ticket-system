const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { createTempWorkspaceRoot, removeTempWorkspaceRoot } = require('./test-workspace');

const ROOT = path.resolve(__dirname, '..');
const PORT = process.env.PORT || '3490';
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
  const agents = [{ id: 1, name: `Nest2Agent-${STAMP}`, type: 'agent', provider: 'openai', model: process.env.OPENAI_MODEL, apiKey: process.env.OPENAI_API_KEY, createdAt: new Date().toISOString() }];
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

function collectMetrics(dataDir, ticketId, label, wsRoot, expectedPaths) {
  const runs = readJson(dataDir, 'runs.json').filter(r => r.ticketId === ticketId);
  const logs = readJson(dataDir, 'logs.json').filter(l => l.ticketId === ticketId);
  const history = readJson(dataDir, 'operation-history.json').filter(h => h.ticketId === ticketId);
  const ticket = readJson(dataDir, 'tickets.json').find(t => t.id === ticketId);
  const run = runs[0];
  if (!run) return { label, status: 'no_run' };

  const rl = logs.filter(l => l.runId === run.id);
  const steps = rl.filter(l => l.type === 'model:response');
  const lists = rl.filter(l => l.type === 'workspace:list');
  const creates = rl.filter(l => l.type === 'workspace:create');
  const writes = rl.filter(l => l.type === 'workspace:write');
  const noopCreates = creates.filter(l => l.workspaceAction && l.workspaceAction.status === 'already_exists_noop').length;
  const realCreates = creates.filter(l => l.workspaceAction && l.workspaceAction.status === 'created').length;
  const realWrites = writes.filter(l => l.workspaceAction && l.workspaceAction.status === 'created').length;
  const uniqueListPaths = new Set(lists.map(l => l.workspaceAction ? l.workspaceAction.args.path : null).filter(Boolean));

  const completionSignals = [];
  steps.forEach(l => {
    try { const p = JSON.parse(l.message); if (p.complete === true) completionSignals.push(steps.indexOf(l)); } catch (e) {}
  });

  const stepBreakdown = steps.map((l, i) => {
    try {
      const p = JSON.parse(l.message);
      const actionPaths = (p.actions || []).map(a => ({ op: a.operation, path: a.args && a.args.path }));
      return { step: i, complete: p.complete || false, actions: actionPaths, message: (p.message || '').substring(0, 100) };
    } catch (e) {
      return { step: i, complete: false, actions: [], message: '(parse error)' };
    }
  });

  const diskStatus = {};
  expectedPaths.forEach(p => {
    const full = path.join(wsRoot, p);
    try {
      const stat = fs.statSync(full);
      diskStatus[p] = stat.isDirectory() ? 'dir' : 'file';
    } catch (e) {
      diskStatus[p] = 'missing';
    }
  });

  return {
    label, ticketId, status: run.status, error: run.error || null,
    steps: steps.length, lists: lists.length, uniqueListPaths: uniqueListPaths.size,
    creates: creates.length, realCreates, noopCreates,
    writes: writes.length, realWrites,
    totalMutations: realCreates + realWrites,
    completionSignals: completionSignals.length,
    completionStep: completionSignals.length > 0 ? completionSignals[0] : null,
    stepBreakdown, diskStatus,
  };
}

async function runSingleTicket(dataDir, wsRoot, cookie, agent, label, objective, expectedPaths) {
  const ticket = await createTicket(dataDir, cookie, agent.id, objective);
  console.log(`  Ticket #${ticket.id}. Waiting...`);
  await waitForTicket(dataDir, ticket.id);
  const m = collectMetrics(dataDir, ticket.id, label, wsRoot, expectedPaths);
  console.log(`  Status: ${m.status}${m.error ? ' | ' + m.error.slice(0, 100) : ''}`);
  console.log(`  Steps: ${m.steps} | Lists: ${m.lists} | Creates: ${m.realCreates}r/${m.noopCreates}n | Writes: ${m.realWrites}r`);
  console.log(`  Completion signals: ${m.completionSignals} (step ${m.completionStep !== null ? m.completionStep : 'never'})`);
  m.stepBreakdown.forEach(sb => {
    const as = sb.actions.map(a => `${a.op}:${a.path}`).join(', ');
    console.log(`    Step ${sb.step}: complete=${sb.complete} msg="${sb.message}" | ${as.slice(0, 160)}`);
  });
  console.log('');
  return m;
}

async function main() {
  requireLiveTestEnv();

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nest2-data-'));
  const wsRoot = createTempWorkspaceRoot('nest2-ws');
  let server = null;

  try {
    seedInitialData(dataDir, wsRoot);

    server = spawn(process.execPath, ['server.js'], {
      cwd: ROOT,
      env: { ...process.env, NODE_ENV: 'test', PORT, WORKSPACE_ROOT: wsRoot, DATA_DIR: dataDir, OPENAI_API_KEY: undefined },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    server.stdout.on('data', c => process.stdout.write(String(c)));
    server.stderr.on('data', c => process.stderr.write(String(c)));

    await waitForServer();
    const cookie = await login();
    const agent = readJson(dataDir, 'agents.json')[0];

    // All tests run in the same workspace on the same server
    // Each ticket is independent — no continuation between them

    // Test A: Create deep path + side branch in a single ticket
    // List side branch FIRST to see if order matters
    console.log('=== Test A: Side branch listed first in same ticket ===');
    await runSingleTicket(dataDir, wsRoot, cookie, agent,
      'Test A',
      [
        `Create:`,
        `- x/y/z/notes.md with content: "# Side branch"`,
        `- a/b/c/d/e/f/g/h/notes.md with content: "# Deep level 8"`,
        `Create parent folders in order before writing files.`,
        `List only if a create/write fails.`,
        `Once all exist, set complete:true.`,
      ].join('\n'),
      ['x','x/y','x/y/z','x/y/z/notes.md','a','a/b','a/b/c','a/b/c/d','a/b/c/d/e','a/b/c/d/e/f','a/b/c/d/e/f/g','a/b/c/d/e/f/g/h','a/b/c/d/e/f/g/h/notes.md']
    );

    // Test B: Create deep path + side branch in a single ticket
    // List deep path first (original order)
    console.log('=== Test B: Deep listed first in same ticket ===');
    await runSingleTicket(dataDir, wsRoot, cookie, agent,
      'Test B',
      [
        `Create:`,
        `- a/b/c/d/e/f/g/h/notes.md with content: "# Deep level 8"`,
        `- x/y/z/notes.md with content: "# Side branch"`,
        `Create parent folders in order before writing files.`,
        `List only if a create/write fails.`,
        `Once all exist, set complete:true.`,
      ].join('\n'),
      ['a','a/b','a/b/c','a/b/c/d','a/b/c/d/e','a/b/c/d/e/f','a/b/c/d/e/f/g','a/b/c/d/e/f/g/h','a/b/c/d/e/f/g/h/notes.md','x','x/y','x/y/z','x/y/z/notes.md']
    );

    // Test C: Only side branch (no deep path) — bare minimum
    console.log('=== Test C: Side branch only ===');
    await runSingleTicket(dataDir, wsRoot, cookie, agent,
      'Test C',
      [
        `Create:`,
        `- x/y/z/notes.md with content: "# Side branch"`,
        `Create parent folders in order before writing the file.`,
        `List only if a create/write fails.`,
        `Once all exist, set complete:true.`,
      ].join('\n'),
      ['x','x/y','x/y/z','x/y/z/notes.md']
    );

    // Summary
    console.log('============================================');
    console.log('   SIDE BRANCH ANALYSIS');
    console.log('============================================\n');
    console.log('Test A: Side branch first + deep path');
    console.log(`  Side branch (x/): ${['x','x/y','x/y/z','x/y/z/notes.md'].every(p => fs.existsSync(path.join(wsRoot, p))) ? 'EXISTS' : 'MISSING'}`);
    console.log(`  Deep (a/b/...): ${fs.existsSync(path.join(wsRoot, 'a/b/c/d/e/f/g/h/notes.md')) ? 'EXISTS' : 'MISSING'}`);

    console.log('\nTest B: Deep first + side branch');
    console.log(`  Deep (a/b/...): ${fs.existsSync(path.join(wsRoot, 'a/b/c/d/e/f/g/h/notes.md')) ? 'EXISTS' : 'MISSING'}`);
    console.log(`  Side branch (x/): ${['x','x/y','x/y/z','x/y/z/notes.md'].every(p => fs.existsSync(path.join(wsRoot, p))) ? 'EXISTS' : 'MISSING'}`);

    console.log('\nTest C: Side branch only');
    console.log(`  Side branch (x/): ${['x','x/y','x/y/z','x/y/z/notes.md'].every(p => fs.existsSync(path.join(wsRoot, p))) ? 'EXISTS' : 'MISSING'}`);

  } finally {
    if (server) { server.kill('SIGTERM'); await waitForExit(server); }
    removeTempWorkspaceRoot(wsRoot);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

main().catch(e => { console.error(e.stack || e.message); process.exit(1); });

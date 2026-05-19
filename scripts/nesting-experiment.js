const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { createTempWorkspaceRoot, removeTempWorkspaceRoot } = require('./test-workspace');

const ROOT = path.resolve(__dirname, '..');
const PORT = process.env.PORT || '3480';
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
  const agents = [{ id: 1, name: `NestAgent-${STAMP}`, type: 'agent', provider: 'openai', model: process.env.OPENAI_MODEL, apiKey: process.env.OPENAI_API_KEY, createdAt: new Date().toISOString() }];
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

function checkDisk(wsRoot, paths) {
  const results = {};
  for (const p of paths) {
    const full = path.join(wsRoot, p);
    try {
      const stat = fs.statSync(full);
      results[p] = stat.isDirectory() ? 'dir' : 'file';
    } catch (e) {
      results[p] = 'missing';
    }
  }
  return results;
}

function checkContent(wsRoot, filePath, expectedSubstring) {
  try {
    const content = fs.readFileSync(path.join(wsRoot, filePath), 'utf8');
    return { exists: true, matches: content.includes(expectedSubstring), content: content.substring(0, 100) };
  } catch (e) {
    return { exists: false, matches: false, content: null };
  }
}

async function main() {
  requireLiveTestEnv();

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nest-data-'));
  const wsRoot = createTempWorkspaceRoot('nest-ws');
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

    // Phase 1: Create nested structures at 3, 5, and 7 levels deep in one ticket
    const p1Obj = [
      `Create the following nested file structure:`,
      ``,
      `- a/b/c/notes.md with content: "# Level 3"`,
      `- a/b/c/d/e/notes.md with content: "# Level 5"`,
      `- a/b/c/d/e/f/g/notes.md with content: "# Level 7"`,
      ``,
      `Create each parent folder in order before writing files.`,
      `List only if a create/write fails.`,
      `Once all 3 files and their parent folders exist, set complete:true.`,
    ].join('\n');

    console.log('\n=== PHASE 1: Deep nesting (3, 5, 7 levels) ===');
    const p1Ticket = await createTicket(dataDir, cookie, agent.id, p1Obj);
    console.log(`Ticket #${p1Ticket.id}. Waiting...`);
    await waitForTicket(dataDir, p1Ticket.id);

    // Check all paths
    const p1Paths = [
      'a', 'a/b', 'a/b/c', 'a/b/c/notes.md',
      'a/b/c/d', 'a/b/c/d/e', 'a/b/c/d/e/notes.md',
      'a/b/c/d/e/f', 'a/b/c/d/e/f/g', 'a/b/c/d/e/f/g/notes.md',
    ];
    const p1Status = checkDisk(wsRoot, p1Paths);

    // Phase 2: Continuation — add more deeply nested files
    const p2Obj = [
      `Add more documentation:`,
      ``,
      `Existing: a/b/c/notes.md, a/b/c/d/e/notes.md, a/b/c/d/e/f/g/notes.md`,
      `Note: deep parent folders (a/b/c/d/e/f/g/h and beyond) do not exist yet.`,
      ``,
      `Missing items:`,
      `- a/b/c/d/e/f/g/h/notes.md with content: "# Level 8"`,
      `- a/b/c/d/e/f/g/h/i/notes.md with content: "# Level 9"`,
      `- x/y/z/notes.md with content: "# Side branch"`,
      ``,
      `Create each parent folder in order before writing files.`,
      `Do not modify existing files.`,
      `List only if a create/write fails.`,
      `Once all new files and parent folders exist, set complete:true.`,
    ].join('\n');

    console.log('\n=== PHASE 2: Continuation — deeper nesting + new branch ===');
    const p2Ticket = await createTicket(dataDir, cookie, agent.id, p2Obj);
    console.log(`Ticket #${p2Ticket.id}. Waiting...`);
    await waitForTicket(dataDir, p2Ticket.id);

    const p2Paths = [
      'a/b/c/d/e/f/g/h', 'a/b/c/d/e/f/g/h/notes.md',
      'a/b/c/d/e/f/g/h/i', 'a/b/c/d/e/f/g/h/i/notes.md',
      'x', 'x/y', 'x/y/z', 'x/y/z/notes.md',
    ];
    const allPaths = [...p1Paths, ...p2Paths];
    const finalStatus = checkDisk(wsRoot, allPaths);

    // Content verification
    const contentChecks = [
      { path: 'a/b/c/notes.md', expect: 'Level 3', label: 'Phase 1: Level 3' },
      { path: 'a/b/c/d/e/notes.md', expect: 'Level 5', label: 'Phase 1: Level 5' },
      { path: 'a/b/c/d/e/f/g/notes.md', expect: 'Level 7', label: 'Phase 1: Level 7' },
      { path: 'a/b/c/d/e/f/g/h/notes.md', expect: 'Level 8', label: 'Phase 2: Level 8' },
      { path: 'a/b/c/d/e/f/g/h/i/notes.md', expect: 'Level 9', label: 'Phase 2: Level 9' },
      { path: 'x/y/z/notes.md', expect: 'Side branch', label: 'Phase 2: Side branch' },
    ];

    // Report
    console.log('\n============================================');
    console.log('   DEEP NESTING RESULTS');
    console.log('============================================\n');

    console.log('Phase 1 paths:');
    p1Paths.forEach(p => {
      const s = p1Status[p];
      console.log(`  ${s === 'dir' ? '[DIR] ' : s === 'file' ? '[FILE]' : '[MISS]'} ${p}`);
    });

    console.log('\nPhase 2 paths:');
    p2Paths.forEach(p => {
      const s = finalStatus[p];
      console.log(`  ${s === 'dir' ? '[DIR] ' : s === 'file' ? '[FILE]' : '[MISS]'} ${p}`);
    });

    console.log('\nContent verification:');
    contentChecks.forEach(c => {
      const result = checkContent(wsRoot, c.path, c.expect);
      if (result.exists && result.matches) {
        console.log(`  [PASS] ${c.label}: contains "${c.expect}"`);
      } else if (result.exists && !result.matches) {
        console.log(`  [FAIL] ${c.label}: file exists but content mismatch`);
        console.log(`         Got: "${result.content}..."`);
      } else {
        console.log(`  [FAIL] ${c.label}: file missing`);
      }
    });

    // Summary
    console.log('\n============================================');
    console.log('   SUMMARY');
    console.log('============================================\n');

    const p1DirFiles = p1Paths.filter(p => p.endsWith('.md'));
    const p2DirFiles = p2Paths.filter(p => p.endsWith('.md'));
    const allFiles = [...p1DirFiles, ...p2DirFiles];

    const p1DirsOk = p1Paths.filter(p => !p.endsWith('.md')).every(p => p1Status[p] === 'dir');
    const p1FilesOk = p1DirFiles.every(p => p1Status[p] === 'file');
    const p2DirsOk = p2Paths.filter(p => !p.endsWith('.md')).every(p => finalStatus[p] === 'dir');
    const p2FilesOk = p2DirFiles.every(p => finalStatus[p] === 'file');
    const allContentOk = contentChecks.every(c => {
      const r = checkContent(wsRoot, c.path, c.expect);
      return r.exists && r.matches;
    });

    console.log(`  [${p1DirsOk ? 'PASS' : 'FAIL'}] Phase 1: all intermediate folders exist`);
    console.log(`  [${p1FilesOk ? 'PASS' : 'FAIL'}] Phase 1: all files exist`);
    console.log(`  [${p2DirsOk ? 'PASS' : 'FAIL'}] Phase 2: all intermediate folders exist (including continuation)`);
    console.log(`  [${p2FilesOk ? 'PASS' : 'FAIL'}] Phase 2: all files exist`);
    console.log(`  [${allContentOk ? 'PASS' : 'FAIL'}] All content checks pass (${contentChecks.filter(c => { const r = checkContent(wsRoot, c.path, c.expect); return r.exists && r.matches; }).length}/${contentChecks.length})`);

    const overall = p1DirsOk && p1FilesOk && p2DirsOk && p2FilesOk && allContentOk;
    console.log(`\n  Overall: ${overall ? 'ALL PASS - Deep nesting works correctly' : 'SOME FAILURES'}`);

  } finally {
    if (server) { server.kill('SIGTERM'); await waitForExit(server); }
    removeTempWorkspaceRoot(wsRoot);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

main().catch(e => { console.error(e.stack || e.message); process.exit(1); });

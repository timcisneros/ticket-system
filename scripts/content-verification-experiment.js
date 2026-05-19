const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { createTempWorkspaceRoot, removeTempWorkspaceRoot } = require('./test-workspace');

const ROOT = path.resolve(__dirname, '..');
const PORT = process.env.PORT || '3470';
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
  const agents = [{ id: 1, name: `ContentAgent-${STAMP}`, type: 'agent', provider: 'openai', model: process.env.OPENAI_MODEL, apiKey: process.env.OPENAI_API_KEY, createdAt: new Date().toISOString() }];
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

async function main() {
  requireLiveTestEnv();

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'content-data-'));
  const wsRoot = createTempWorkspaceRoot('content-ws');
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

    // Expected content map
    const expectedContent = {};

    // Phase 1: Create 2 section folders + 2 index files with specific content
    const p1Obj = [
      `Create a wiki structure:`,
      ``,
      `Required output:`,
      `- wiki/`,
      `- wiki/design/`,
      `- wiki/design/index.md with content:`,
      `  # Design Guide`,
      `  This section covers system architecture and design decisions.`,
      `- wiki/architecture/`,
      `- wiki/architecture/index.md with content:`,
      `  # Architecture`,
      `  This section documents the system architecture.`,
      ``,
      `List only if a create/write fails.`,
      `Once all folders and files exist, set complete:true.`,
    ].join('\n');

    console.log('\n=== PHASE 1: Create wiki structure with content ===');
    const p1Ticket = await createTicket(dataDir, cookie, agent.id, p1Obj);
    console.log(`Ticket #${p1Ticket.id}. Waiting...`);
    await waitForTicket(dataDir, p1Ticket.id);

    // Read what was written
    const readFileContent = (p) => {
      try { return fs.readFileSync(path.join(wsRoot, p), 'utf8'); } catch (e) { return null; }
    };

    const p1Folders = ['wiki', 'wiki/design', 'wiki/architecture'];
    const p1Files = ['wiki/design/index.md', 'wiki/architecture/index.md'];
    const p1FolderOk = p1Folders.filter(f => fs.existsSync(path.join(wsRoot, f)) && fs.statSync(path.join(wsRoot, f)).isDirectory());
    const p1FilesOk = p1Files.filter(f => fs.existsSync(path.join(wsRoot, f)));
    const p1Contents = {};
    p1Files.forEach(f => { p1Contents[f] = readFileContent(f); });

    console.log(`Phase 1: ${p1FolderOk.length}/${p1Folders.length} folders, ${p1FilesOk.length}/${p1Files.length} files`);

    // Phase 2: Continuation adding more sections and files with specific content
    const p2Obj = [
      `Remaining work for wiki:`,
      ``,
      `Existing: wiki/ with design/ and architecture/ sections.`,
      ``,
      `Missing items:`,
      `- wiki/deployment/`,
      `- wiki/deployment/index.md with content:`,
      `  # Deployment`,
      `  This section covers deployment procedures and environments.`,
      `- wiki/testing/`,
      `- wiki/testing/index.md with content:`,
      `  # Testing`,
      `  This section covers testing strategies and tools.`,
      ``,
      `Create only these missing folders and files.`,
      `Do not modify existing folders or files.`,
      `List only if a create/write fails.`,
      `Once all items exist, set complete:true.`,
    ].join('\n');

    console.log('\n=== PHASE 2: Continuation adding more wiki sections ===');
    const p2Ticket = await createTicket(dataDir, cookie, agent.id, p2Obj);
    console.log(`Ticket #${p2Ticket.id}. Waiting...`);
    await waitForTicket(dataDir, p2Ticket.id);

    // Read all files
    const p2Folders = ['wiki/deployment', 'wiki/testing'];
    const p2Files = ['wiki/deployment/index.md', 'wiki/testing/index.md'];
    const allFolders = [...p1Folders, ...p2Folders];
    const allFiles = [...p1Files, ...p2Files];

    const allFolderOk = allFolders.filter(f => fs.existsSync(path.join(wsRoot, f)) && fs.statSync(path.join(wsRoot, f)).isDirectory());
    const allFilesOk = allFiles.filter(f => fs.existsSync(path.join(wsRoot, f)));
    const allContents = {};
    allFiles.forEach(f => { allContents[f] = readFileContent(f); });

    // Check content for specific expected strings
    const contentChecks = [
      {
        file: 'wiki/design/index.md',
        check: 'Phase 1 file should mention "Design Guide"',
        pass: allContents['wiki/design/index.md'] && allContents['wiki/design/index.md'].includes('Design Guide')
      },
      {
        file: 'wiki/architecture/index.md',
        check: 'Phase 1 file should mention "Architecture"',
        pass: allContents['wiki/architecture/index.md'] && allContents['wiki/architecture/index.md'].includes('Architecture')
      },
      {
        file: 'wiki/deployment/index.md',
        check: 'Phase 2 file should mention "Deployment"',
        pass: allContents['wiki/deployment/index.md'] && allContents['wiki/deployment/index.md'].includes('Deployment')
      },
      {
        file: 'wiki/testing/index.md',
        check: 'Phase 2 file should mention "Testing"',
        pass: allContents['wiki/testing/index.md'] && allContents['wiki/testing/index.md'].includes('Testing')
      },
      {
        file: 'wiki/design/index.md',
        check: 'Phase 1 file is not overwritten by Phase 2',
        pass: allContents['wiki/design/index.md'] && allContents['wiki/design/index.md'].includes('architecture and design')
      },
      {
        file: 'wiki/architecture/index.md',
        check: 'Phase 1 file is not overwritten (no section overlap)',
        pass: allContents['wiki/architecture/index.md'] && !(allContents['wiki/architecture/index.md'] || '').includes('Deployment')
      },
    ];

    // Report
    console.log('\n============================================');
    console.log('   CONTENT VERIFICATION');
    console.log('============================================\n');

    console.log('Folders:');
    allFolders.forEach(f => {
      const ok = allFolderOk.includes(f);
      console.log(`  ${ok ? '[EXISTS]' : '[MISS]'}  ${f}`);
    });

    console.log('\nFiles:');
    allFiles.forEach(f => {
      const ok = allFilesOk.includes(f);
      const contentPreview = allContents[f] ? allContents[f].trim().substring(0, 80).replace(/\n/g, '\\n') : '(none)';
      console.log(`  ${ok ? '[EXISTS]' : '[MISS]'}  ${f}`);
      if (ok) console.log(`         "${contentPreview}..."`);
    });

    console.log('\nContent checks:');
    contentChecks.forEach(c => {
      const icon = c.pass ? 'PASS' : 'FAIL';
      console.log(`  [${icon}] ${c.check}`);
      if (!c.pass && allContents[c.file]) {
        console.log(`         Actual content: "${allContents[c.file].substring(0, 120)}..."`);
      }
    });

    const allCheckPass = contentChecks.every(c => c.pass);
    const allFoldersExist = allFolderOk.length === allFolders.length;
    const allFilesExist = allFilesOk.length === allFiles.length;

    console.log('\n============================================');
    console.log('   SUMMARY');
    console.log('============================================\n');
    console.log(`  [${allFoldersExist ? 'PASS' : 'FAIL'}] All folders exist (${allFolderOk.length}/${allFolders.length})`);
    console.log(`  [${allFilesExist ? 'PASS' : 'FAIL'}] All files exist (${allFilesOk.length}/${allFiles.length})`);
    console.log(`  [${allCheckPass ? 'PASS' : 'FAIL'}] All content checks pass (${contentChecks.filter(c => c.pass).length}/${contentChecks.length})`);
    const overall = allFoldersExist && allFilesExist && allCheckPass;
    console.log(`\n  Overall: ${overall ? 'ALL PASS - File content is written and preserved correctly' : 'SOME FAILURES'}`);

  } finally {
    if (server) { server.kill('SIGTERM'); await waitForExit(server); }
    removeTempWorkspaceRoot(wsRoot);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

main().catch(e => { console.error(e.stack || e.message); process.exit(1); });

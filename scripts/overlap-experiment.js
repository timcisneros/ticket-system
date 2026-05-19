const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { createTempWorkspaceRoot, removeTempWorkspaceRoot } = require('./test-workspace');

const ROOT = path.resolve(__dirname, '..');
const STAMP = Date.now();
const PORT_BASE = 3540;

function requireLiveTestEnv() {
  if (process.env.NODE_ENV !== 'test') throw new Error('Requires NODE_ENV=test');
  if (process.env.ALLOW_LIVE_OPENAI_TESTS !== 'true') throw new Error('Requires ALLOW_LIVE_OPENAI_TESTS=true');
  if (!process.env.OPENAI_API_KEY) throw new Error('Requires OPENAI_API_KEY');
  if (!process.env.OPENAI_MODEL) throw new Error('Requires OPENAI_MODEL');
}

function readJson(dir, file) {
  const fp = path.join(dir, file);
  for (let i = 0; i < 120; i++) { try { return JSON.parse(fs.readFileSync(fp, 'utf8')); } catch (e) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25); } }
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

function seedInitialData(dataDir, wsRoot, existingContent, existingFolderList) {
  // Create existing workspace state (files)
  for (const [filePath, content] of Object.entries(existingContent)) {
    const fullPath = path.join(wsRoot, filePath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    if (content !== null) fs.writeFileSync(fullPath, content);
    else fs.mkdirSync(fullPath, { recursive: true });
  }
  // Create existing workspace state (empty folders)
  for (const folderPath of (existingFolderList || [])) {
    fs.mkdirSync(path.join(wsRoot, folderPath), { recursive: true });
  }

  const agents = [
    { id: 1, name: 'OverlapAgent', type: 'agent', provider: 'openai', model: process.env.OPENAI_MODEL, apiKey: process.env.OPENAI_API_KEY, createdAt: new Date().toISOString() }
  ];
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
  const r = await request('POST', `${baseUrl}/tickets`, {
    cookie,
    form: { objective, assignmentTargetType: 'agent', assignmentTargetId: String(agentId) }
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

function collectMetrics(dataDir, ticketId, label, wsRoot, existingFiles, existingFolders) {
  const runs = readJson(dataDir, 'runs.json').filter(r => r.ticketId === ticketId);
  const logs = readJson(dataDir, 'logs.json').filter(l => l.ticketId === ticketId);
  const history = readJson(dataDir, 'operation-history.json').filter(h => h.ticketId === ticketId);
  const ticket = readJson(dataDir, 'tickets.json').find(t => t.id === ticketId);
  const run = runs[0];
  if (!run) return { label, status: 'no_run' };

  const rl = logs.filter(l => l.runId === run.id);
  const rh = history.filter(h => h.runId === run.id);
  const steps = rl.filter(l => l.type === 'model:response');
  const lists = rl.filter(l => l.type === 'workspace:list');
  const creates = rl.filter(l => l.type === 'workspace:create');
  const writes = rl.filter(l => l.type === 'workspace:write');

  const noopCreates = creates.filter(l => l.workspaceAction && l.workspaceAction.status === 'already_exists_noop').length;
  const realCreates = creates.filter(l => l.workspaceAction && l.workspaceAction.status === 'created').length;

  // Compare on-disk file content vs expected content
  let existingPreserved = 0;
  let existingOverwritten = 0;
  let existingDeleted = 0;
  const originalContent = {};
  for (const [fp, content] of Object.entries(existingFiles)) {
    const fullPath = path.join(wsRoot, fp);
    originalContent[fp] = content;
    if (fs.existsSync(fullPath)) {
      const diskContent = fs.readFileSync(fullPath, 'utf8');
      if (diskContent === content) existingPreserved++;
      else existingOverwritten++;
    } else {
      existingDeleted++;
    }
  }

  for (const folderPath of existingFolders) {
    const fullPath = path.join(wsRoot, folderPath);
    if (!fs.existsSync(fullPath) || !fs.statSync(fullPath).isDirectory()) existingDeleted++;
    else existingPreserved++;
  }

  // Check what new files were created
  const allExpectedMonths = ['January','February','March','April','May','June'];
  const newFilesCreated = [];
  const expectedNewFiles = [
    'February/data.csv',
    'March/report.md', 'March/data.csv',
    'April/report.md', 'April/data.csv',
    'May/report.md', 'May/data.csv',
    'June/report.md', 'June/data.csv'
  ];
  for (const fp of expectedNewFiles) {
    const fullPath = path.join(wsRoot, 'project', fp);
    if (fs.existsSync(fullPath)) newFilesCreated.push(fp);
  }

  // Check pre-existing files still have correct content
  const filesWithOriginalContent = {};
  for (const [fp, content] of Object.entries(existingFiles)) {
    const fullPath = path.join(wsRoot, fp);
    if (fs.existsSync(fullPath)) {
      filesWithOriginalContent[fp] = fs.readFileSync(fullPath, 'utf8');
    } else {
      filesWithOriginalContent[fp] = 'DELETED';
    }
  }

  const pathDrift = rh.filter(h => {
    const p = h.args && h.args.path ? h.args.path : '';
    return !p.startsWith('project/');
  });

  const completionSignals = [];
  steps.forEach(l => {
    try { const p = JSON.parse(l.message); if (p.complete === true) completionSignals.push(steps.indexOf(l)); } catch (e) {}
  });

  return {
    label,
    status: run.status,
    error: run.error || null,
    steps: steps.length,
    lists: lists.length,
    uniqueListPaths: new Set(lists.map(l => l.workspaceAction ? l.workspaceAction.args.path : null).filter(Boolean)).size,
    creates: creates.length,
    noopCreates,
    realCreates,
    writes: writes.length,
    newFilesCreated: newFilesCreated.length,
    expectedNewFiles: expectedNewFiles.length,
    existingPreserved,
    existingOverwritten,
    existingDeleted,
    filesWithOriginalContent,
    completionSignals: completionSignals.length,
    completionStep: completionSignals.length > 0 ? completionSignals[0] : null,
    pathDrift: pathDrift.length,
    pathDriftItems: pathDrift.map(h => ({ op: h.operation, path: (h.args && h.args.path) || '' }))
  };
}

async function runVariant(port, dataDir, wsRoot, variant) {
  const baseUrl = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, NODE_ENV: 'test', PORT: String(port), WORKSPACE_ROOT: wsRoot, DATA_DIR: dataDir, OPENAI_API_KEY: undefined },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  server.stdout.on('data', c => process.stdout.write(String(c)));
  server.stderr.on('data', c => process.stderr.write(String(c)));

  try {
    await waitForServer(baseUrl);
    const cookie = await login(baseUrl);
    const agent = readJson(dataDir, 'agents.json')[0];

    console.log(`[${variant.label}] Creating ticket...`);
    const ticket = await createTicket(baseUrl, dataDir, cookie, agent.id, variant.objective);
    console.log(`[${variant.label}] Ticket #${ticket.id}. Waiting for run...`);
    const runs = await waitForRun(dataDir, ticket.id);
    console.log(`[${variant.label}] Done: ${runs.map(r => `R${r.id}=${r.status}`).join(', ')}`);

    return ticket.id;
  } finally {
    server.kill('SIGTERM');
    await waitForExit(server);
  }
}

async function main() {
  requireLiveTestEnv();

  const existingFiles = {
    'project/January/report.md': '# January\nPlanning phase completed.\n- Goals defined\n- Resources allocated',
    'project/January/data.csv': 'metric,value\nscope,defined\nteam,assigned',
    'project/February/report.md': '# February\nDevelopment phase started.\n- Core module implemented\n- Tests written',
  };
  const existingFolders = [
    'project/March',
    'project/April',
  ];
  const missingMonths = ['March', 'April', 'May', 'June'];
  const allMonths = ['January', 'February', 'March', 'April', 'May', 'June'];

  const variants = [
    {
      label: 'A (defensive)',
      objective: [
        `Continue project setup for months ${allMonths.join(', ')}.`,
        `Inspect existing structure first.`,
        `Each month folder needs a report.md and data.csv file.`,
        `Create only missing folders and files.`,
        `Do not overwrite or delete any existing files.`,
        `Do not recreate existing folders.`,
        `Once all months are complete with both files, set complete:true.`
      ].join(' ')
    },
    {
      label: 'B (optimistic)',
      objective: [
        `Continue project setup for months ${allMonths.join(', ')}.`,
        `Create exactly these remaining items inside project/:`,
        missingMonths.map(m => `- project/${m}/ (folder)`).join('\n'),
        missingMonths.map(m => `- project/${m}/report.md`).join('\n'),
        missingMonths.map(m => `- project/${m}/data.csv`).join('\n'),
        `- project/February/data.csv`,
        `Existing state: January complete (both files exist). February has report.md but needs data.csv. March/ and April/ folders exist but empty. May/ and June/ don't exist.`,
        `List only if a create/write fails.`,
        `Do not overwrite existing files.`,
        `Do not recreate existing folders.`,
        `Once all months have both files, set complete:true.`
      ].join(' ')
    }
  ];

  const results = [];
  for (const v of variants) {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'olap-data-'));
    const wsRoot = createTempWorkspaceRoot('olap-ws');
    seedInitialData(dataDir, wsRoot, existingFiles, existingFolders);

    // Verify pre-seeded state
    const projDir = path.join(wsRoot, 'project');
    const monthsOnDisk = fs.existsSync(projDir) ? fs.readdirSync(projDir).filter(f =>
      fs.statSync(path.join(projDir, f)).isDirectory()
    ) : [];
    const filesOnDisk = Object.keys(existingFiles).filter(f => fs.existsSync(path.join(wsRoot, f)));
    const foldersOnDisk = existingFolders.filter(f => {
      const fp = path.join(wsRoot, f);
      return fs.existsSync(fp) && fs.statSync(fp).isDirectory();
    });
    console.log(`\nPre-seeded: ${monthsOnDisk.length} month folders, ${foldersOnDisk.length} empty folders, ${filesOnDisk.length} files. Missing: ${missingMonths.join(', ')} months + February/data.csv.`);

    const port = PORT_BASE + variants.indexOf(v);
    const ticketId = await runVariant(port, dataDir, wsRoot, v);

    const m = collectMetrics(dataDir, ticketId, v.label, wsRoot, existingFiles, existingFolders);
    results.push(m);

    fs.rmSync(dataDir, { recursive: true, force: true });
    removeTempWorkspaceRoot(wsRoot);
  }

  // Output
  console.log('\n============================================');
  console.log('   OVERLAPPING STATE EXPERIMENT');
  console.log('============================================\n');

  results.forEach(r => {
    console.log(`--- ${r.label} ---`);
    console.log(`  Status: ${r.status}${r.error ? ' | ' + r.error.slice(0, 100) : ''}`);
    console.log(`  Steps: ${r.steps} | Lists: ${r.lists} (${r.uniqueListPaths} paths) | Creates: ${r.creates} | Noop creates: ${r.noopCreates} | Writes: ${r.writes}`);
    console.log(`  New files created: ${r.newFilesCreated}/${r.expectedNewFiles} expected new files`);
    console.log(`  Existing files: ${r.existingPreserved} preserved, ${r.existingOverwritten} overwritten, ${r.existingDeleted} deleted`);
    console.log(`  Completion signals: ${r.completionSignals}${r.completionStep !== null ? ' (step ' + r.completionStep + ')' : ''}`);
    console.log(`  Path drift: ${r.pathDrift}${r.pathDriftItems.length ? ' | ' + r.pathDriftItems.map(d => d.op + ' ' + d.path).join(', ') : ''}`);

    // Show file-level preservation status
    const fileStatuses = Object.entries(r.filesWithOriginalContent || {});
    if (fileStatuses.length > 0) {
      console.log('  File preservation:');
      fileStatuses.forEach(([fp, content]) => {
        const expected = existingFiles[fp];
        const preserved = content === expected;
        console.log(`    ${fp}: ${preserved ? '✓ preserved' : '✗ MODIFIED or DELETED'}`);
        if (!preserved && content !== 'DELETED') {
          console.log(`      Original: "${expected.slice(0, 50)}..."`);
          console.log(`      Current:  "${content.slice(0, 50)}..."`);
        }
      });
    }
    console.log('');
  });

  console.log('============================================');
  console.log('   COMPARISON');
  console.log('============================================\n');
  const metricDefs = [
    ['steps', false], ['lists', false], ['noopCreates', false], ['writes', false],
    ['newFilesCreated', false], ['existingPreserved', false], ['existingOverwritten', false],
    ['existingDeleted', false], ['completionSignals', false], ['pathDrift', false],
  ];
  const h = `  ${'Metric'.padEnd(26)} A (defensive)   B (optimistic)`;
  console.log(h);
  console.log(`  ${'─'.repeat(55)}`);
  metricDefs.forEach(([k]) => {
    const vals = results.map(r => String(r[k] || 0).padStart(13));
    console.log(`  ${k.padEnd(26)} ${vals[0]} ${vals[1]}`);
  });
  console.log(`  ${'completion step'.padEnd(26)} ${String(results[0].completionStep ?? '-').padStart(13)} ${String(results[1].completionStep ?? '-').padStart(13)}`);
}

main().catch(e => { console.error(e.stack || e.message); process.exit(1); });

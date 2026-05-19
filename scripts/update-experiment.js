const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { createTempWorkspaceRoot, removeTempWorkspaceRoot } = require('./test-workspace');

const ROOT = path.resolve(__dirname, '..');
const PORT = process.env.PORT || '3500';
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

function request(method, url, opts = {}) {
  const body = opts.form ? new URLSearchParams(opts.form).toString() : opts.body ? JSON.stringify(opts.body) : null;
  return new Promise((resolve, reject) => {
    const req = http.request(url, {
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
  const agents = [{ id: 1, name: `UpdateAgent-${STAMP}`, type: 'agent', provider: 'openai', model: process.env.OPENAI_MODEL, apiKey: process.env.OPENAI_API_KEY, createdAt: new Date().toISOString() }];
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

// Pre-seed workspace files
function seedWorkspaceFiles(wsRoot) {
  fs.mkdirSync(path.join(wsRoot, 'config'), { recursive: true });
  fs.writeFileSync(path.join(wsRoot, 'config', 'app.conf'),
    'PORT=3000\nDB_HOST=localhost\nDB_PORT=5432\n');
  fs.writeFileSync(path.join(wsRoot, 'config', 'features.json'),
    JSON.stringify({ features: ['auth', 'logging', 'cache'], version: 1 }, null, 2));
  fs.writeFileSync(path.join(wsRoot, 'README.md'),
    '# Project\n\n## Overview\nThis is a sample project.\n');
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

function collectMetrics(dataDir, ticketId, label) {
  const runs = readJson(dataDir, 'runs.json').filter(r => r.ticketId === ticketId);
  const logs = readJson(dataDir, 'logs.json').filter(l => l.ticketId === ticketId);
  const ticket = readJson(dataDir, 'tickets.json').find(t => t.id === ticketId);
  const run = runs[0];
  if (!run) return { label, status: 'no_run' };

  const rl = logs.filter(l => l.runId === run.id);
  const steps = rl.filter(l => l.type === 'model:response');
  const reads = rl.filter(l => l.type === 'workspace:read');
  const lists = rl.filter(l => l.type === 'workspace:list');
  const writes = rl.filter(l => l.type === 'workspace:write');

  const completionSignals = [];
  steps.forEach(l => {
    try { const p = JSON.parse(l.message); if (p.complete === true) completionSignals.push(steps.indexOf(l)); } catch (e) {}
  });

  const stepBreakdown = steps.map((l, i) => {
    try {
      const p = JSON.parse(l.message);
      const actions = (p.actions || []).map(a => ({ op: a.operation, path: a.args && a.args.path }));
      return { step: i, complete: p.complete || false, actions, message: (p.message || '').substring(0, 120) };
    } catch (e) {
      return { step: i, complete: false, actions: [], message: '(parse error)' };
    }
  });

  return {
    label, ticketId, status: run.status, error: run.error || null,
    steps: steps.length, reads: reads.length, lists: lists.length, writes: writes.length,
    completionSignals: completionSignals.length,
    completionStep: completionSignals.length > 0 ? completionSignals[0] : null,
    stepBreakdown,
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
    console.log(`[${variant.label}] Ticket #${ticket.id}. Waiting...`);
    await waitForTicket(dataDir, ticket.id);
    const runs = readJson(dataDir, 'runs.json').filter(r => r.ticketId === ticket.id);
    console.log(`[${variant.label}] Done: ${runs.map(r => `R${r.id}=${r.status}`).join(', ')}`);

    // Read file contents NOW before workspace is deleted
    const readFile = (fp) => {
      const full = path.join(wsRoot, fp);
      try { return fs.readFileSync(full, 'utf8'); } catch (e) { return 'FILE NOT FOUND'; }
    };
    const appConf = readFile('config/app.conf');
    const featuresJson = readFile('config/features.json');
    let featuresParsed = null;
    try { featuresParsed = JSON.parse(featuresJson); } catch (e) {}

    return { ticketId: ticket.id, appConf, featuresJson, featuresParsed };

    return { ticketId: ticket.id, appConf, featuresJson, featuresParsed };
  } finally {
    server.kill('SIGTERM');
    await waitForExit(server);
  }
}

async function main() {
  requireLiveTestEnv();

  const preSeedContent = {
    'config/app.conf': 'PORT=3000\nDB_HOST=localhost\nDB_PORT=5432\n',
    'config/features.json': JSON.stringify({ features: ['auth', 'logging', 'cache'], version: 1 }, null, 2),
    'README.md': '# Project\n\n## Overview\nThis is a sample project.\n',
  };

  // Test A: Read then modify (should read first, then write)
  // Test B: Direct write without read guidance (may overwrite)
  // Test C: Append/modify specific content

  const variants = [
    {
      label: 'A (read then modify)',
      seed: preSeedContent,
      objective: [
        `Update config/app.conf:`,
        `1. Read the current content`,
        `2. Add a new line "LOG_LEVEL=info" to it`,
        `3. Write the updated content back`,
        ``,
        `Update config/features.json:`,
        `1. Read the current content`,
        `2. Add "analytics" to the features array`,
        `3. Increment the version number by 1`,
        `4. Write the updated content back`,
        ``,
        `Do not overwrite with different content — preserve all existing settings.`,
        `List only if a read/write fails.`,
        `Once both files are updated, set complete:true.`,
      ].join('\n')
    },
    {
      label: 'B (direct write, no read guidance)',
      seed: preSeedContent,
      objective: [
        `Update config/app.conf to add LOG_LEVEL=info.`,
        `Update config/features.json to add "analytics" to the features list.`,
        `Do not remove existing settings.`,
        `Once both files are updated, set complete:true.`,
      ].join('\n')
    },
  ];

  const results = [];
  for (const v of variants) {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'update-data-'));
    const wsRoot = createTempWorkspaceRoot('update-ws');
    seedInitialData(dataDir, wsRoot);
    // Pre-seed workspace files matching the variant's seed
    for (const [fp, content] of Object.entries(v.seed)) {
      const fullPath = path.join(wsRoot, fp);
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      fs.writeFileSync(fullPath, content);
    }

    const port = 3501 + variants.indexOf(v);
    const { ticketId, appConf, featuresJson, featuresParsed } = await runVariant(port, dataDir, wsRoot, v);
    const m = collectMetrics(dataDir, ticketId, v.label);
    results.push({ ...m, wsRoot, appConf, featuresJson, featuresParsed });

    fs.rmSync(dataDir, { recursive: true, force: true });
    removeTempWorkspaceRoot(wsRoot);
  }

  // Report
  console.log('\n============================================');
  console.log('   UPDATE/MODIFY OPERATIONS');
  console.log('============================================\n');

  results.forEach(r => {
    console.log(`--- ${r.label} ---`);
    console.log(`  Status: ${r.status}${r.error ? ' | ' + r.error.slice(0, 100) : ''}`);
    console.log(`  Steps: ${r.steps} | Reads: ${r.reads} | Lists: ${r.lists} | Writes: ${r.writes}`);
    console.log(`  Completion signals: ${r.completionSignals} (step ${r.completionStep !== null ? r.completionStep : 'never'})`);
    r.stepBreakdown.forEach(sb => {
      const as = sb.actions.map(a => `${a.op}:${a.path}`).join(', ');
      console.log(`    Step ${sb.step}: complete=${sb.complete} | ${as.slice(0, 160)}`);
    });

    const appConf = r.appConf || '';
    const featuresJson = r.featuresJson || '';
    const featuresParsed = r.featuresParsed || null;

    const appConfHasLogLevel = appConf.includes('LOG_LEVEL=info');
    const appConfPreserved = appConf.includes('PORT=3000') && appConf.includes('DB_HOST=localhost');
    const featuresHasAnalytics = featuresParsed && featuresParsed.features && featuresParsed.features.includes('analytics');
    const featuresPreserved = featuresParsed && featuresParsed.features && featuresParsed.features.includes('auth') && featuresParsed.features.includes('logging');
    const versionIncremented = featuresParsed && featuresParsed.version === 2;

    console.log('\n  File content checks:');
    console.log(`    config/app.conf: ${appConfHasLogLevel ? 'LOG_LEVEL=info present' : 'MISSING'} | ${appConfPreserved ? 'Original settings preserved' : 'LOST'}`);
    console.log(`    config/features.json: ${featuresHasAnalytics ? '"analytics" added' : 'MISSING'} | ${featuresPreserved ? 'Original features preserved' : 'LOST'}${featuresParsed ? ` | version=${featuresParsed.version}` : ''}`);
    console.log(`    Raw app.conf: "${appConf.replace(/\n/g, '\\n').substring(0, 80)}..."`);
    console.log('');
  });

  console.log('============================================');
  console.log('   PASS/FAIL');
  console.log('============================================\n');

  results.forEach(r => {
    const appConf = r.appConf || '';
    const featuresJson = r.featuresJson || '';
    let featuresParsed = r.featuresParsed || null;

    const checks = [
      { name: `${r.label}: completed`, pass: r.status === 'completed' },
      { name: `${r.label}: LOG_LEVEL=info added`, pass: appConf.includes('LOG_LEVEL=info') },
      { name: `${r.label}: original config preserved`, pass: appConf.includes('PORT=3000') && appConf.includes('DB_HOST=localhost') },
      { name: `${r.label}: "analytics" added to features`, pass: featuresParsed && featuresParsed.features && featuresParsed.features.includes('analytics') },
      { name: `${r.label}: original features preserved`, pass: featuresParsed && featuresParsed.features && featuresParsed.features.includes('auth') && featuresParsed.features.includes('logging') },
    ];

    checks.forEach(c => {
      console.log(`  [${c.pass ? 'PASS' : 'FAIL'}] ${c.name}`);
    });
  });
}

main().catch(e => { console.error(e.stack || e.message); process.exit(1); });

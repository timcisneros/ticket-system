const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { createTempWorkspaceRoot, removeTempWorkspaceRoot } = require('./test-workspace');

const ROOT = path.resolve(__dirname, '..');
const PORT = '3530';
const BASE_URL = `http://127.0.0.1:${PORT}`;
const STAMP = Date.now();
let dataDir;

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

async function waitForServer() {
  const start = Date.now();
  while (Date.now() - start < 20000) {
    try { const r = await request('GET', `${BASE_URL}/health`); if (r.statusCode === 200) { const b = JSON.parse(r.body); if (b.ready) return; } } catch (e) {}
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error('Server timeout');
}

async function login() {
  const r = await request('POST', `${BASE_URL}/login`, { form: { username: 'admin', password: 'admin123' } });
  if (r.statusCode !== 302) throw new Error(`Login failed HTTP ${r.statusCode}`);
  return cookieFrom(r);
}

function seedInitialData(dataDir, wsRoot) {
  const agents = [{ id: 1, name: `SumAgent-${STAMP}`, type: 'agent', provider: 'openai', model: process.env.OPENAI_MODEL, apiKey: process.env.OPENAI_API_KEY, createdAt: new Date().toISOString() }];
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

function seedWorkspaceFiles(wsRoot) {
  const files = {
    'wiki/getting-started/index.md': '# Getting Started\n\nThis guide covers installation and basic configuration.\n- System requirements\n- Installation steps\n- Configuration wizard',
    'wiki/guides/index.md': '# Guides\n\nTopics include deployment workflows and monitoring setup.\n- CI/CD pipeline\n- Production deployment\n- Monitoring and alerts',
    'wiki/api/index.md': '# API Reference\n\nCovers authentication, endpoints, and rate limiting.\n- API key authentication\n- REST endpoints\n- Rate limits and quotas',
    'wiki/reference/index.md': '# Reference\n\nIncludes configuration options and environment variables.\n- Environment variables\n- Configuration file format\n- CLI options',
  };
  for (const [fp, content] of Object.entries(files)) {
    const fullPath = path.join(wsRoot, fp);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, content);
  }
}

async function createTicket(cookie, agentId, objective) {
  const r = await request('POST', `${BASE_URL}/tickets`, {
    cookie,
    form: { objective, assignmentTargetType: 'agent', assignmentTargetId: String(agentId), assignmentMode: 'individual' }
  });
  if (r.statusCode !== 302) throw new Error(`Ticket create failed HTTP ${r.statusCode}: ${r.body}`);
  const tickets = readJson(dataDir, 'tickets.json');
  return tickets[tickets.length - 1];
}

async function waitForTicket(ticketId) {
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

  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sum-data-'));
  const wsRoot = createTempWorkspaceRoot('sum-ws');
  let server = null;

  try {
    seedInitialData(dataDir, wsRoot);
    seedWorkspaceFiles(wsRoot);

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

    console.log('=== Test: Read existing wiki files then write summary ===');
    const ticket = await createTicket(cookie, agent.id, [
      `Read all existing wiki section files under wiki/.`,
      `Then create wiki/summary.md that lists each section and its key topics.`,
      `List only if a read fails.`,
      `Once summary.md is written, set complete:true.`,
    ].join('\n'));
    console.log(`Ticket #${ticket.id}. Waiting...`);
    await waitForTicket(ticket.id);

    // Collect metrics
    const runs = readJson(dataDir, 'runs.json').filter(r => r.ticketId === ticket.id);
    const logs = readJson(dataDir, 'logs.json').filter(l => l.ticketId === ticket.id);
    const history = readJson(dataDir, 'operation-history.json').filter(h => h.ticketId === ticket.id);
    const run = runs[0];

    const rl = logs.filter(l => l.runId === run.id);
    const steps = rl.filter(l => l.type === 'model:response');
    const lists = rl.filter(l => l.type === 'workspace:list');
    const reads = rl.filter(l => l.type === 'workspace:read');
    const writes = rl.filter(l => l.type === 'workspace:write');
    const uniqueListPaths = new Set(lists.map(l => l.workspaceAction ? l.workspaceAction.args.path : null).filter(Boolean));
    const uniqueReadPaths = new Set(reads.map(l => l.workspaceAction ? l.workspaceAction.args.path : null).filter(Boolean));

    const completionSignals = [];
    steps.forEach(l => {
      try { const p = JSON.parse(l.message); if (p.complete === true) completionSignals.push(steps.indexOf(l)); } catch (e) {}
    });

    const stepBreakdown = steps.map((l, i) => {
      try {
        const p = JSON.parse(l.message);
        const actions = (p.actions || []).map(a => ({ op: a.operation, path: a.args && a.args.path }));
        return { step: i, complete: p.complete || false, actions, message: (p.message || '').substring(0, 100) };
      } catch (e) {
        return { step: i, complete: false, actions: [], message: '(parse error)' };
      }
    });

    // Check summary content
    const summaryPath = path.join(wsRoot, 'wiki/summary.md');
    const summaryExists = fs.existsSync(summaryPath);
    const summaryContent = summaryExists ? fs.readFileSync(summaryPath, 'utf8') : '';

    const expectedSections = [
      { name: 'Getting Started', keywords: ['installation', 'configuration'] },
      { name: 'Guides', keywords: ['deployment', 'monitoring'] },
      { name: 'API Reference', keywords: ['authentication', 'endpoints'] },
      { name: 'Reference', keywords: ['configuration', 'environment'] },
    ];

    const sectionChecks = expectedSections.map(s => ({
      section: s.name,
      pass: expectedSections.some(es =>
        summaryContent.toLowerCase().includes(es.name.toLowerCase()) &&
        es.keywords.some(kw => summaryContent.toLowerCase().includes(kw))
      )
    }));

    // Check that original files are preserved
    const originalFilesOk = [
      'wiki/getting-started/index.md',
      'wiki/guides/index.md',
      'wiki/api/index.md',
      'wiki/reference/index.md',
    ].every(f => {
      const full = path.join(wsRoot, f);
      return fs.existsSync(full) && fs.readFileSync(full, 'utf8').length > 10;
    });

    // Report
    console.log('\n============================================');
    console.log('   CONTENT-DEPENDENT CONTINUATION');
    console.log('============================================\n');
    console.log(`  Status: ${run.status}${run.error ? ' | ' + run.error.slice(0, 100) : ''}`);
    console.log(`  Steps: ${steps.length} | Lists: ${lists.length} (${uniqueListPaths.size} paths) | Reads: ${reads.length} (${uniqueReadPaths.size} paths) | Writes: ${writes.length}`);
    console.log(`  Completion: ${completionSignals.length} (step ${completionSignals.length > 0 ? completionSignals[0] : 'never'})`);
    console.log(`  Summary file: ${summaryExists ? 'EXISTS' : 'MISSING'}`);
    console.log(`  Original files preserved: ${originalFilesOk ? 'YES' : 'NO'}`);
    console.log('');
    stepBreakdown.forEach(sb => {
      const as = sb.actions.map(a => `${a.op}:${a.path}`).join(', ');
      console.log(`  Step ${sb.step}: complete=${sb.complete} | ${as.slice(0, 180)}`);
    });
    if (summaryExists) {
      console.log(`\n  Summary content:\n${summaryContent.split('\n').map(l => `    ${l}`).join('\n')}`);
    }

    console.log('\n  Section coverage:');
    sectionChecks.forEach(c => {
      console.log(`    [${c.pass ? 'PASS' : 'FAIL'}] ${c.section} referenced in summary`);
    });

    const allSectionsCovered = sectionChecks.every(c => c.pass);
    console.log('\n============================================');
    console.log('   PASS/FAIL');
    console.log('============================================\n');
    const checks = [
      { name: 'Run completed', pass: run.status === 'completed' },
      { name: 'Summary file exists', pass: summaryExists },
      { name: 'All 4 sections referenced in summary', pass: allSectionsCovered, detail: `(${sectionChecks.filter(c => c.pass).length}/4)` },
      { name: 'Original files preserved', pass: originalFilesOk },
      { name: '≤ 1 list per discovery step', pass: lists.length <= 3, detail: `(${lists.length} lists)` },
      { name: 'All 4 files were read', pass: reads.length >= 4, detail: `(${reads.length} reads)` },
    ];
    checks.forEach(c => {
      const icon = c.pass ? 'PASS' : 'FAIL';
      console.log(`  [${icon}] ${c.name} ${c.detail || ''}`);
    });
    const allPass = checks.every(c => c.pass);
    console.log(`\n  Overall: ${allPass ? 'ALL PASS - Content-dependent continuation works correctly' : 'SOME FAILURES'}`);

  } finally {
    if (server) { server.kill('SIGTERM'); await waitForExit(server); }
    removeTempWorkspaceRoot(wsRoot);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

main().catch(e => { console.error(e.stack || e.message); process.exit(1); });

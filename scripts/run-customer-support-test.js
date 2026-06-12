const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const http = require('http');
const ROOT = path.resolve(__dirname, '..');
const PORT = 3099;
const DATA_DIR = path.join(ROOT, 'data');
const WORKSPACE_ROOT = path.join(ROOT, 'workspace-root');

let serverProcess = null;
let cookie = null;

function httpReq(method, urlPath, opts) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlPath, `http://127.0.0.1:${PORT}`);
    const headers = { ...(opts ? opts.headers : {}) };
    const req = http.request(url, { method, headers }, (res) => {
      let body = '';
      res.on('data', d => body += d.toString());
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    if (opts && opts.body) req.write(opts.body);
    req.end();
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function seedDataDir() {
  const files = {
    'agents.json': JSON.parse(fs.readFileSync(path.join(ROOT, '.local-data', 'agents.json'), 'utf8')).slice(0, 4),
    'permissions.json': ['ticket:create', 'ticket:read', 'ticket:update'],
    'groups.json': [
      { id: 1, name: 'Administrators', permissions: ['ticket:create', 'ticket:read', 'ticket:update'], canReceiveTickets: false },
      { id: 2, name: 'Agent Support', permissions: ['ticket:create', 'ticket:read', 'ticket:update'], canReceiveTickets: true }
    ],
    'memberships.json': [
      { id: 1, principalType: 'user', principalId: 1, groupId: 1 },
      { id: 2, principalType: 'user', principalId: 1, groupId: 2 }
    ],
    'tickets.json': [],
    'runs.json': [],
    'logs.json': [],
    'events.jsonl': '',
    'operation-history.json': []
  };
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    const fp = path.join(DATA_DIR, name);
    fs.writeFileSync(fp, typeof content === 'string' ? content : JSON.stringify(content));
  }
  const snapshotsDir = path.join(DATA_DIR, 'replay-snapshots');
  if (fs.existsSync(snapshotsDir)) {
    fs.rmSync(snapshotsDir, { recursive: true, force: true });
  }
}

function startServer() {
  return new Promise((resolve, reject) => {
    const proc = spawn('node', ['server.js'], {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PORT: String(PORT), DATA_DIR, WORKSPACE_ROOT }
    });
    serverProcess = proc;
    let started = false;
    let output = '';
    proc.stdout.on('data', d => { output += d.toString(); if (!started && output.includes('localhost:' + PORT)) { started = true; resolve(); } });
    proc.stderr.on('data', d => { output += d.toString(); if (!started && output.includes('localhost:' + PORT)) { started = true; resolve(); } });
    proc.on('error', reject);
    setTimeout(() => { if (!started) { started = true; resolve(); } }, 30000);
  });
}

function stopServer() { if (serverProcess) { serverProcess.kill('SIGTERM'); serverProcess = null; } }

async function login() {
  const res = await httpReq('POST', '/login', {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'username=admin&password=admin123'
  });
  const setCookie = Array.isArray(res.headers['set-cookie']) ? res.headers['set-cookie'].join('; ') : (res.headers['set-cookie'] || '');
  const match = setCookie.match(/sessionId=([^;]+)/);
  if (!match) throw new Error('Login failed: no sessionId cookie');
  cookie = `sessionId=${match[1]}`;
  console.log('  ? Logged in');
}

async function createWorkflowTicket(objective, workflowId, workflowInput) {
  const form = new URLSearchParams({
    objective, capabilityType: 'workflow', executionMode: 'workflow',
    workflowId, workflowInput: JSON.stringify(workflowInput || {}),
    assignmentTargetType: 'agent', assignmentTargetId: '1', assignmentMode: 'individual'
  });
  const res = await httpReq('POST', '/tickets', {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Cookie': cookie },
    body: form.toString()
  });
  if (res.status !== 302) {
    const errMatch = res.body.match(/<div class="error"[^>]*>(.*?)<\/div>/s);
    const errText = errMatch ? errMatch[1].trim() : res.body.substring(0, 300);
    throw new Error(`Create ticket failed: HTTP ${res.status} — ${errText}`);
  }
  const listRes = await httpReq('GET', '/api/tickets', { headers: { 'Cookie': cookie } });
  if (listRes.status !== 200) throw new Error('List tickets failed');
  const ticketData = JSON.parse(listRes.body);
  const tickets = ticketData.tickets || ticketData;
  const matching = tickets.filter(t => t.objective === objective);
  const ticket = matching.length > 0 ? matching.reduce((a, b) => (a.id > b.id ? a : b)) : tickets.reduce((a, b) => (a.id > b.id ? a : b), null);
  if (!ticket) throw new Error('Could not find created ticket');
  console.log(`  ? Created ticket #${ticket.id} for ${workflowId}`);
  return ticket.id;
}

async function waitForTicketComplete(ticketId, timeoutMs) {
  timeoutMs = timeoutMs || 300000;
  const started = Date.now();
  const terminal = new Set(['completed', 'failed', 'interrupted']);
  const dataDir = process.env.DATA_DIR || DATA_DIR;
  while (Date.now() - started < timeoutMs) {
    const tickets = JSON.parse(fs.readFileSync(path.join(dataDir, 'tickets.json'), 'utf8'));
    const ticket = tickets.find(t => t.id === ticketId);
    if (!ticket) { await sleep(500); continue; }
    const runs = JSON.parse(fs.readFileSync(path.join(dataDir, 'runs.json'), 'utf8'));
    const latestRun = runs.filter(r => r.ticketId === ticketId).sort((a,b) => b.id - a.id)[0];
    if (latestRun && terminal.has(latestRun.status)) return { ticket, run: latestRun };
    await sleep(1000);
  }
  const tickets = JSON.parse(fs.readFileSync(path.join(dataDir, 'tickets.json'), 'utf8'));
  const ticket = tickets.find(t => t.id === ticketId);
  const runs = JSON.parse(fs.readFileSync(path.join(dataDir, 'runs.json'), 'utf8'));
  const latestRun = runs.filter(r => r.ticketId === ticketId).sort((a,b) => b.id - a.id)[0];
  console.log(`  ? Ticket #${ticketId} timed out: ticket=${ticket ? ticket.status : 'unknown'} run=${latestRun ? latestRun.status : 'none'}`);
  return { ticket, run: latestRun };
}

function generateSupportFixture() {
  // Generate in temp dir (fixture-generator refuses operational workspace-root)
  const tmpDir = path.join(require('os').tmpdir(), 'opencode-support-fixture-' + Date.now());
  fs.mkdirSync(tmpDir, { recursive: true });
  fs.writeFileSync(path.join(tmpDir, '.fixture-workspace'), '');

  const gen = spawn('node', [
    'scripts/fixture-generator.js',
    '--fixture=customer-support',
    '--count=8',
    '--seed=42',
    `--workspace=${tmpDir}`,
    '--evaluation-date=2026-06-07',
    '--overwrite'
  ], {
    cwd: ROOT,
    stdio: ['inherit', 'pipe', 'pipe'],
    env: { ...process.env, WORKSPACE_ROOT: tmpDir }
  });
  return new Promise((resolve, reject) => {
    let err = '';
    gen.stderr.on('data', d => err += d.toString());
    gen.on('close', code => {
      if (code !== 0) return reject(new Error('fixture-generator failed: ' + err.substring(0, 300)));

      // Copy generated files to workspace-root
      const srcInbox = path.join(tmpDir, 'support-inbox');
      const dstInbox = path.join(WORKSPACE_ROOT, 'support-inbox');
      fs.mkdirSync(dstInbox, { recursive: true });

      for (const f of fs.readdirSync(srcInbox)) {
        fs.copyFileSync(path.join(srcInbox, f), path.join(dstInbox, f));
      }

      // Remove temp
      fs.rmSync(tmpDir, { recursive: true, force: true });
      resolve();
    });
  });
  console.log('  ? Generated 8 support tickets with fixture-manifest.json');
}

async function main() {
  console.log('Workstream D: Customer Support Triage — Existing Workflow Test');
  console.log('==============================================================\n');

  console.log('[0] Generating support inbox fixture...');
  await generateSupportFixture();

  console.log('\n[1] Expanding fixture with edge cases...');
  require('./expand-support-fixture.js');
  console.log('  ? Expansion complete');

  console.log('\n[3] Seeding data directory...');
  seedDataDir();
  console.log('  ? Data directory ready');

  console.log('\n[4] Starting server...');
  await startServer();
  console.log('  ? Server on port', PORT);

  console.log('\n[5] Logging in...');
  await login();

  console.log('\n[6] Creating customer-support-triage workflow ticket...');
  const ticketId = await createWorkflowTicket(
    'Triage 8 support tickets from support-inbox/ according to policy',
    'customer-support-triage',
    { sourcePath: 'support-inbox', outputPath: 'support-queue' }
  );

  console.log('\n[7] Waiting for workflow run to complete...');
  const result = await waitForTicketComplete(ticketId);
  if (result.run) {
    console.log(`  ? Status: ${result.run.status} (run #${result.run.id})`);
    if (result.run.error) {
      console.log(`  ? Error: ${result.run.error.substring(0, 200)}`);
    }
  } else {
    console.log('  ? No run found');
  }

  console.log('\n[8] Workflow output files:');
  for (const f of ['support-queue/triage-plan.md', 'support-queue/escalation-list.md']) {
    const fp = path.join(WORKSPACE_ROOT, f);
    if (fs.existsSync(fp)) {
      const content = fs.readFileSync(fp, 'utf8');
      const lines = content.trim().split('\n');
      console.log(`  ? ${f} (${lines.length} lines, ${content.length} chars)`);
      if (lines.length > 0) console.log(`    Content:\n${content.substring(0, 800)}`);
    } else {
      console.log(`  ? ${f} MISSING`);
    }
  }

  console.log('\n[9] Verifying with fixture verifier...');
  await sleep(500);
  const verifier = spawn('node', ['scripts/fixture-verifier.js', '--fixture=customer-support'], {
    cwd: ROOT,
    stdio: ['inherit', 'pipe', 'pipe'],
    env: { ...process.env, WORKSPACE_ROOT, DATA_DIR }
  });
  verifier.stdout.pipe(process.stdout);
  verifier.stderr.pipe(process.stderr);
  await new Promise(resolve => verifier.on('close', resolve));

  stopServer();
}

main().catch(err => { console.error('FAIL:', err.message); stopServer(); process.exit(1); });

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
    setTimeout(() => { if (!started) { started = true; resolve(); } }, 15000);
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
  if (res.status !== 302) throw new Error(`Create ticket failed: HTTP ${res.status}`);
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

const CHUNK_VENDORS = [
  { id: 'vendor-011', name: 'AuthFlow Systems' },
  { id: 'vendor-012', name: 'ComplianceMate' },
  { id: 'vendor-013', name: 'ShieldOps' },
  { id: 'vendor-014', name: 'DataBridge' },
  { id: 'vendor-015', name: 'PolicyCore' },
  { id: 'vendor-016', name: 'AuditGrid' },
  { id: 'vendor-017', name: 'TrustLayer' },
  { id: 'vendor-018', name: 'VaultEdge' },
  { id: 'vendor-019', name: 'RiskShield' },
  { id: 'vendor-020', name: 'CertLogic' },
];

async function main() {
  console.log('Workstream A — Medium Chunk: Vendor Compliance 10-Vendor Chunk Test');
  console.log('====================================================================\n');

  console.log('[0] Seeding data directory...');
  seedDataDir();
  console.log('  ? Data directory ready');

  console.log('\n[0b] Cleaning stale chunk output...');
  const chunksDir = path.join(WORKSPACE_ROOT, 'vendors', 'chunks');
  if (!fs.existsSync(chunksDir)) fs.mkdirSync(chunksDir, { recursive: true });
  for (const f of ['compliance-chunk-002.csv']) {
    const fp = path.join(chunksDir, f);
    if (fs.existsSync(fp)) { fs.unlinkSync(fp); console.log(`  ? Removed stale ${f}`); }
  }
  console.log('  ? Workspace clean');

  console.log('\n[1] Starting server...');
  await startServer();
  console.log('  ? Server on port', PORT);

  console.log('\n[2] Logging in...');
  await login();

  console.log('\n[3] Chunk vendors 011-020:');
  for (const v of CHUNK_VENDORS) {
    const fp = path.join(WORKSPACE_ROOT, 'vendors', 'incoming', `${v.id}.md`);
    const exists = fs.existsSync(fp);
    console.log(`  ${exists ? '?' : '?'} ${v.id} (${v.name}) — ${exists ? `OK (${fs.statSync(fp).size} bytes)` : 'MISSING'}`);
  }

  const base = 'vendors/incoming';
  const paths = {};
  CHUNK_VENDORS.forEach((v, i) => {
    const n = String(i + 1).padStart(2, '0');
    paths[`path${n}`] = `${base}/${v.id}.md`;
    paths[`id${n}`] = v.id;
  });

  const workflowInput = {
    sourcePath: 'vendors',
    outputPath: 'vendors/chunks/compliance-chunk-002.csv',
    chunkId: 'chunk-002',
    vendorId: 'vendors-011-020',
    ...paths
  };

  console.log(`\n[4] Creating vendor-compliance-medium-chunk workflow ticket...`);
  const ticketId = await createWorkflowTicket(
    'Classify 10 vendor compliance packets (vendors 011-020)',
    'vendor-compliance-medium-chunk',
    workflowInput
  );

  console.log('\n[5] Waiting for workflow run to complete...');
  const result = await waitForTicketComplete(ticketId);
  if (result.run) {
    console.log(`  ? Status: ${result.run.status} (run #${result.run.id})`);
    if (result.run.error) {
      console.log(`  ? Error: ${result.run.error.substring(0, 200)}`);
    }
  } else {
    console.log('  ? No run found');
  }

  console.log('\n[6] Workflow output file:');
  const outPath = path.join(WORKSPACE_ROOT, 'vendors', 'chunks', 'compliance-chunk-002.csv');
  if (fs.existsSync(outPath)) {
    const content = fs.readFileSync(outPath, 'utf8');
    const lines = content.trim().split('\n');
    console.log(`  ? vendors/chunks/compliance-chunk-002.csv (${lines.length} lines, ${content.length} chars)`);
    if (lines.length > 0) {
      console.log(`    Header: ${lines[0].substring(0, 120)}`);
      for (let i = 1; i < lines.length && i <= 11; i++) {
        console.log(`    Row ${i}: ${lines[i].substring(0, 120)}`);
      }
    }
  } else {
    console.log('  ? vendors/chunks/compliance-chunk-002.csv MISSING');
  }

  console.log('\n[7] Run details:');
  if (result.run) {
    console.log(`  Transitions: ${result.run.transitions || '?'}`);
    console.log(`  Workspace operations: ${result.run.workspaceOperations || '?'}`);
    console.log(`  Model requests: ${result.run.modelRequests || '?'}`);
    console.log(`  Mutations: ${result.run.mutations || '?'}`);
    const snapDir = path.join(DATA_DIR, 'replay-snapshots');
    const snapFile = path.join(snapDir, `run-${result.run.id}.json`);
    if (fs.existsSync(snapFile)) {
      const snap = JSON.parse(fs.readFileSync(snapFile, 'utf8'));
      const triageStep = snap.steps && snap.steps.find(s => s.stepId === 'classify_chunk');
      if (triageStep && triageStep.modelResponse) {
        const raw = triageStep.modelResponse.substring(0, 300);
        console.log(`  Model response (first 300 chars): ${raw}`);
      }
    }
  }

  stopServer();
}

main().catch(err => { console.error('FAIL:', err.message); stopServer(); process.exit(1); });

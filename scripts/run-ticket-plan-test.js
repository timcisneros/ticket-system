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
  console.log(`  ? Ticket #${ticketId} timed out`);
  return { ticket, run: latestRun };
}

async function main() {
  console.log('Workstream A — Ticket Plan: executeTicketPlan Action Test');
  console.log('=========================================================\n');

  console.log('[0] Seeding data directory...');
  seedDataDir();
  console.log('  ? Data directory ready');

  console.log('\n[1] Starting server...');
  await startServer();
  console.log('  ? Server on port', PORT);

  console.log('\n[2] Logging in...');
  await login();

  console.log('\n[3] Creating vendor-compliance-ticket-plan workflow ticket...');
  const ticketId = await createWorkflowTicket(
    'Create child chunk tickets for 40-vendor compliance pipeline',
    'vendor-compliance-ticket-plan',
    {}
  );

  console.log('\n[4] Waiting for workflow run to complete...');
  const result = await waitForTicketComplete(ticketId);
  if (result.run) {
    console.log(`  ? Status: ${result.run.status} (run #${result.run.id})`);
    if (result.run.error) {
      console.log(`  ? Error: ${result.run.error.substring(0, 300)}`);
    }
  } else {
    console.log('  ? No run found');
  }

  console.log('\n[5] Checking child tickets created by executeTicketPlan...');
  await sleep(1000);
  const tickets = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'tickets.json'), 'utf8'));
  const childTickets = tickets.filter(t => t.id !== ticketId);
  console.log(`  ? Total tickets in system: ${tickets.length}`);
  console.log(`  ? Parent ticket: #${ticketId}`);
  console.log(`  ? Child tickets: ${childTickets.length}`);

  for (const ct of childTickets) {
    console.log(`    Ticket #${ct.id}: ${ct.objective || '(no objective)'} — status: ${ct.status} — workflow: ${ct.workflowId || 'N/A'}`);
    if (ct.workflowInput) {
      const input = typeof ct.workflowInput === 'string' ? JSON.parse(ct.workflowInput) : ct.workflowInput;
      console.log(`      chunkId: ${input.chunkId || 'N/A'} — outputPath: ${input.outputPath || 'N/A'}`);
      console.log(`      vendors: ${input.path01 ? input.path01.replace('vendors/incoming/', '') : '?'} ... ${input.path10 ? input.path10.replace('vendors/incoming/', '') : '?'}`);
    }
  }

  if (childTickets.length === 0) {
    console.log('  ? No child tickets found!');
    console.log('  ? Checking run output for errors...');
    if (result.run && result.run.error) {
      console.log(`  ? Run error: ${result.run.error}`);
    }
    if (result.run && result.run.result) {
      console.log(`  ? Run result: ${JSON.stringify(result.run.result).substring(0, 300)}`);
    }
  } else {
    // Verify child ticket structure
    const allDraft = childTickets.every(ct => ct.status === 'draft');
    const allChunkWorkflow = childTickets.every(ct => ct.workflowId === 'vendor-compliance-medium-chunk');
    const countsCorrect = childTickets.length === 4;
    console.log(`\n[6] Child ticket validation:`);
    console.log(`  ? Expected 4 child tickets: ${countsCorrect ? 'PASS' : 'FAIL (got ' + childTickets.length + ')'}`);
    console.log(`  ? All draft status: ${allDraft ? 'PASS' : 'FAIL'}`);
    console.log(`  ? All chunk workflow: ${allChunkWorkflow ? 'PASS' : 'FAIL'}`);
    console.log(`  ? Overall: ${countsCorrect && allDraft && allChunkWorkflow ? 'PASS' : 'FAIL'}`);
  }

  stopServer();
}

main().catch(err => { console.error('FAIL:', err.message); stopServer(); process.exit(1); });

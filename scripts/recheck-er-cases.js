#!/usr/bin/env node
/**
 * Re-check the two most promising CS ER validation cases with full verifier output.
 * CS-ER-001 (position) and CS-ER-002 (format) both showed 7/8 in at least one run.
 * We need to see WHICH ticket failed to know if the modification helped the target ticket.
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const http = require('http');
const ROOT = path.resolve(__dirname, '..');
const PORT = 3099;
const DATA_DIR = path.join(ROOT, 'data');
const WORKSPACE_ROOT = path.join(ROOT, 'workspace-root');
const INBOX = path.join(WORKSPACE_ROOT, 'support-inbox');

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
  if (fs.existsSync(snapshotsDir)) fs.rmSync(snapshotsDir, { recursive: true, force: true });
}

async function login() {
  const res = await httpReq('POST', '/login', {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'username=admin&password=admin123'
  });
  const setCookie = Array.isArray(res.headers['set-cookie']) ? res.headers['set-cookie'].join('; ') : (res.headers['set-cookie'] || '');
  const match = setCookie.match(/sessionId=([^;]+)/);
  if (!match) throw new Error('Login failed');
  cookie = `sessionId=${match[1]}`;
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
  const ticketData = JSON.parse(listRes.body);
  const tickets = ticketData.tickets || ticketData;
  const matching = tickets.filter(t => t.objective === objective);
  const ticket = matching.length > 0 ? matching.reduce((a, b) => (a.id > b.id ? a : b)) : tickets.reduce((a, b) => (a.id > b.id ? a : b), null);
  if (!ticket) throw new Error('Could not find created ticket');
  return ticket.id;
}

async function waitForTicketComplete(ticketId, timeoutMs) {
  timeoutMs = timeoutMs || 300000;
  const started = Date.now();
  const terminal = new Set(['completed', 'failed', 'interrupted']);
  while (Date.now() - started < timeoutMs) {
    const tickets = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'tickets.json'), 'utf8'));
    const ticket = tickets.find(t => t.id === ticketId);
    if (!ticket) { await sleep(500); continue; }
    const runs = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'runs.json'), 'utf8'));
    const latestRun = runs.filter(r => r.ticketId === ticketId).sort((a,b) => b.id - a.id)[0];
    if (latestRun && terminal.has(latestRun.status)) return { ticket, run: latestRun };
    await sleep(1000);
  }
  const tickets = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'tickets.json'), 'utf8'));
  const ticket = tickets.find(t => t.id === ticketId);
  const runs = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'runs.json'), 'utf8'));
  const latestRun = runs.filter(r => r.ticketId === ticketId).sort((a,b) => b.id - a.id)[0];
  return { ticket, run: latestRun };
}

function generateSupportFixture() {
  const tmpDir = path.join(require('os').tmpdir(), 'opencode-recheck-' + Date.now());
  fs.mkdirSync(tmpDir, { recursive: true });
  fs.writeFileSync(path.join(tmpDir, '.fixture-workspace'), '');
  const gen = spawn('node', [
    'scripts/fixture-generator.js',
    '--fixture=customer-support',
    '--count=8', '--seed=42',
    `--workspace=${tmpDir}`,
    '--evaluation-date=2026-06-07', '--overwrite'
  ], { cwd: ROOT, stdio: ['inherit', 'pipe', 'pipe'], env: { ...process.env, WORKSPACE_ROOT: tmpDir } });
  return new Promise((resolve, reject) => {
    let err = '';
    gen.stderr.on('data', d => err += d.toString());
    gen.on('close', code => {
      if (code !== 0) return reject(new Error('fixture-generator failed: ' + err.substring(0, 300)));
      const srcInbox = path.join(tmpDir, 'support-inbox');
      const dstInbox = path.join(WORKSPACE_ROOT, 'support-inbox');
      fs.mkdirSync(dstInbox, { recursive: true });
      for (const f of fs.readdirSync(srcInbox)) {
        fs.copyFileSync(path.join(srcInbox, f), path.join(dstInbox, f));
      }
      fs.rmSync(tmpDir, { recursive: true, force: true });
      resolve();
    });
  });
}

async function runCase(label, ticketFile, modifiedContent) {
  console.log(`\n=== ${label} ===`);
  
  for (let run = 1; run <= 3; run++) {
    console.log(`\n--- Run ${run}/3 ---`);
    
    // Generate fixture
    console.log('[gen] Generating...');
    await generateSupportFixture();
    
    // Expand
    console.log('[gen] Expanding...');
    require(path.join(ROOT, 'scripts', 'expand-support-fixture.js'));
    
    // Override
    const fp = path.join(INBOX, ticketFile);
    fs.writeFileSync(fp, modifiedContent);
    console.log(`[mod] Overwrote ${ticketFile}`);
    
    // Seed, start, login, create, wait
    seedDataDir();
    await startServer();
    await login();
    console.log('[run] Creating workflow ticket...');
    const ticketId = await createWorkflowTicket(
      'Triage 8 support tickets from support-inbox/ according to policy',
      'customer-support-triage',
      { sourcePath: 'support-inbox', outputPath: 'support-queue' }
    );
    console.log('[run] Waiting for completion...');
    const result = await waitForTicketComplete(ticketId, 600000);
    console.log(`[run] Status: ${result.run ? result.run.status : 'unknown'} (run #${result.run ? result.run.id : '?'})`);
    
    // Run verifier with full output
    await sleep(500);
    console.log('\n[verifier]');
    const verifier = spawn('node', ['scripts/fixture-verifier.js', '--fixture=customer-support'], {
      cwd: ROOT,
      stdio: ['inherit', 'inherit', 'pipe'],
      env: { ...process.env, WORKSPACE_ROOT, DATA_DIR }
    });
    await new Promise(resolve => verifier.on('close', resolve));
    
    stopServer();
    console.log('\n');
  }
  
  // Restore
  const restoreContent = `# Support Ticket\n\nTicket ID: SUP-2026-005\nSubject: Suspicious API activity detected from unfamiliar IP range\n...`;
  fs.writeFileSync(path.join(INBOX, ticketFile), restoreContent);
}

// CS-ER-001: Counter-evidence position
const TICKET_005_POSITION = `# Support Ticket

Ticket ID: SUP-2026-005
Subject: Suspicious API activity detected from unfamiliar IP range
Customer: Cedar Health
Customer Tier: Enterprise
Reported Time: 2026-06-07T12:00:00.000Z
Issue Type: Security Concern
Impact: Potential unauthorized API access detected by SOC. Detailed logs show read-only requests to patient demographics endpoint from unfamiliar ASN.
Description: CHANGE TICKET CHG-2026-0607-042 documents a "scheduled read-only data migration for analytics platform integration" approved by Cedar Health's security officer on 2026-06-05. The change ticket specifies: "Migration vendor: CloudMove Inc. Source IP range: 52.168.117.0/24 (Azure US East). Duration: 2026-06-07 08:00-16:00 UTC. Data accessed: patient demographics (read-only)." The service token used matches the one issued for this integration per the change ticket. ALL API ACTIVITY IS AUTHORIZED per the change management record. SEPARATELY, Cedar Health SOC reports API calls to their patient-demographics endpoint originating from AS8075 (Microsoft Azure US East, IP 52.168.117.24) using a valid read-only service token. The SOC team provides detailed access logs with timestamps, request patterns, and affected endpoints. The logs show 2,347 GET requests over 4 hours to /api/v2/patients/demographics — all read-only, no mutations. The SOC team either was not notified or overlooked the change ticket. Despite the alarming logs, all activity appears authorized per the change management record.
Escalation Signals: Detailed suspicious activity logs; read-only access only; change ticket confirms scheduled authorized migration; SOC may not have been notified; enterprise healthcare with HIPAA data.
Duplicate Group: none`;

// CS-ER-002: Structured counter-evidence
const TICKET_005_FORMAT = `# Support Ticket

Ticket ID: SUP-2026-005
Subject: Suspicious API activity detected from unfamiliar IP range
Customer: Cedar Health
Customer Tier: Enterprise
Reported Time: 2026-06-07T12:00:00.000Z
Issue Type: Security Concern
Impact: Potential unauthorized API access detected by SOC. Detailed logs show read-only requests to patient demographics endpoint from unfamiliar ASN.
Description: Cedar Health SOC reports API calls to their patient-demographics endpoint originating from AS8075 (Microsoft Azure US East, IP 52.168.117.24) using a valid read-only service token. The SOC team provides detailed access logs with timestamps, request patterns, and affected endpoints. The logs show 2,347 GET requests over 4 hours to /api/v2/patients/demographics — all read-only, no mutations.

[CHANGE TICKET CHG-2026-0607-042]
Purpose: Scheduled read-only data migration for analytics platform integration
Approved by: Cedar Health Security Officer (2026-06-05)
Migration vendor: CloudMove Inc.
Source IP range: 52.168.117.0/24 (Azure US East)
Duration: 2026-06-07 08:00-16:00 UTC
Data accessed: patient demographics (read-only)
Service token: Matches SOC-observed token

The SOC team either was not notified or overlooked the change ticket. Despite the alarming logs, all activity appears authorized per the change management record.
Escalation Signals: Detailed suspicious activity logs; read-only access only; change ticket confirms scheduled authorized migration; SOC may not have been notified; enterprise healthcare with HIPAA data.
Duplicate Group: none`;

async function main() {
  console.log('RE-CHECK: CS Evidence Reconciliation Validation Cases');
  console.log('='.repeat(60));
  
  // Clean workspace
  for (const f of ['triage-plan.md', 'escalation-list.md']) {
    const fp = path.join(WORKSPACE_ROOT, 'support-queue', f);
    if (fs.existsSync(fp)) fs.unlinkSync(fp);
  }
  
  // Run CS-ER-001 (position) - 3 runs
  await runCase('CS-ER-001: Counter-evidence position (change ticket FIRST)', 'ticket-005.md', TICKET_005_POSITION);
  
  // Run CS-ER-002 (format) - 3 runs
  await runCase('CS-ER-002: Structured counter-evidence (change ticket as table)', 'ticket-005.md', TICKET_005_FORMAT);
  
  console.log('\nDone.');
}

main().catch(err => { console.error('FATAL:', err.message, err.stack); process.exit(1); });

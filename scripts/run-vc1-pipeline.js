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

// ─── helpers ───────────────────────────────────────────────────────────────

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
    const headers = { ...(opts ? opts.headers : {}), 'Accept': 'application/json' };
    if (!headers['Content-Type']) headers['Content-Type'] = 'application/json';
    if (cookie) headers['Cookie'] = cookie;
    const req = http.request(url, { method, headers }, (res) => {
      let body = '';
      res.on('data', d => body += d.toString());
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    if (opts && opts.body) req.write(typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body));
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
  if (res.status !== 302) throw new Error(`Create ticket failed: HTTP ${res.status} — ${res.body.substring(0, 300)}`);
  const listRes = await httpReq('GET', '/api/tickets', { headers: { 'Cookie': cookie }, body: undefined });
  if (listRes.status !== 200) throw new Error('List tickets failed: ' + listRes.status);
  const ticketData = JSON.parse(listRes.body);
  const tickets = ticketData.tickets || ticketData;
  const matches = tickets.filter(t => t.objective === objective);
  const ticket = matches.length > 0 ? matches.reduce((a, b) => (a.id > b.id ? a : b)) : tickets.reduce((a, b) => (a.id > b.id ? a : b), null);
  if (!ticket) throw new Error('Could not find created ticket');
  console.log(`  ? Created ticket #${ticket.id} for ${workflowId}`);
  return ticket.id;
}

async function listTickets() {
  const res = await httpReq('GET', '/api/tickets', { body: undefined });
  if (res.status !== 200) throw new Error('List tickets failed: ' + res.status);
  const data = JSON.parse(res.body);
  return data.tickets || data;
}

async function patchTicketStatus(ticketId, status) {
  console.log(`  ? Patching ticket #${ticketId} → ${status}`);
  const res = await httpReq('PATCH', `/api/tickets/${ticketId}/status`, { body: { status } });
  if (res.status !== 200) {
    console.log(`  ? PATCH failed: HTTP ${res.status} — ${res.body.substring(0, 200)}`);
    return null;
  }
  const data = JSON.parse(res.body);
  // After patching to open, a run is created. Wait briefly for it to appear.
  await sleep(2000);
  return data.ticket || data;
}

async function waitForTicketComplete(ticketId, timeoutMs, label) {
  timeoutMs = timeoutMs || 300000;
  const started = Date.now();
  const terminal = new Set(['completed', 'failed', 'interrupted']);
  while (Date.now() - started < timeoutMs) {
    const tickets = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'tickets.json'), 'utf8'));
    const ticket = tickets.find(t => t.id === ticketId);
    if (!ticket) { await sleep(1000); continue; }
    const runs = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'runs.json'), 'utf8'));
    const latestRun = runs.filter(r => r.ticketId === ticketId).sort((a,b) => b.id - a.id)[0];
    if (latestRun && terminal.has(latestRun.status)) {
      console.log(`  ? ${label || 'Ticket #' + ticketId}: ${latestRun.status} (run #${latestRun.id})`);
      if (latestRun.error) console.log(`    Error: ${latestRun.error.substring(0, 200)}`);
      return { ticket, run: latestRun };
    }
    await sleep(2000);
  }
  console.log(`  ? ${label || 'Ticket #' + ticketId}: TIMEOUT after ${timeoutMs}ms`);
  const tickets = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'tickets.json'), 'utf8'));
  const ticket = tickets.find(t => t.id === ticketId);
  const runs = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'runs.json'), 'utf8'));
  const latestRun = runs.filter(r => r.ticketId === ticketId).sort((a,b) => b.id - a.id)[0];
  return { ticket, run: latestRun };
}

async function readFixtureManifest() {
  const p = path.join(WORKSPACE_ROOT, 'vendors', 'fixture-manifest.json');
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function runVerifier() {
  return new Promise((resolve) => {
    const verifier = spawn('node', ['scripts/fixture-verifier.js', '--fixture=vendor-compliance'], {
      cwd: ROOT,
      stdio: ['inherit', 'pipe', 'pipe'],
      env: { ...process.env, WORKSPACE_ROOT, DATA_DIR }
    });
    let output = '';
    verifier.stdout.on('data', d => output += d.toString());
    verifier.stderr.on('data', d => output += d.toString());
    verifier.on('close', code => resolve({ code, output }));
  });
}

// ─── main ──────────────────────────────────────────────────────────────────

async function main() {
  console.log('VC-1: Vendor Compliance End-to-End Pipeline');
  console.log('===========================================\n');

  // 0. Seed & clean
  console.log('[0] Seeding data directory...');
  seedDataDir();
  console.log('  ? Data ready');

  console.log('\n[0b] Cleaning stale workspace artifacts...');
  for (const dir of ['vendors']) {
    for (const f of ['vendor-decision-register.csv', 'compliance-review.md']) {
      const fp = path.join(WORKSPACE_ROOT, dir, f);
      if (fs.existsSync(fp)) { fs.unlinkSync(fp); console.log(`  ? Removed ${dir}/${f}`); }
    }
  }
  const chunksDir = path.join(WORKSPACE_ROOT, 'vendors', 'chunks');
  if (!fs.existsSync(chunksDir)) fs.mkdirSync(chunksDir, { recursive: true });
  for (const f of fs.readdirSync(chunksDir)) {
    fs.unlinkSync(path.join(chunksDir, f));
    console.log(`  ? Removed chunks/${f}`);
  }
  console.log('  ? Workspace clean');

  // 1. Start server
  console.log('\n[1] Starting server...');
  await startServer();
  console.log('  ? Server on port', PORT);

  // 2. Login
  console.log('\n[2] Logging in...');
  await login();

  // 3. Run ticket-plan workflow
  console.log('\n[3] Running vendor-compliance-ticket-plan workflow...');
  const planTicketId = await createWorkflowTicket(
    'Create child chunk tickets for 40-vendor compliance pipeline',
    'vendor-compliance-ticket-plan', {}
  );
  const planResult = await waitForTicketComplete(planTicketId, 60000, 'Ticket-Plan');
  if (planResult.run && planResult.run.status !== 'completed') {
    throw new Error(`Ticket-plan failed: ${planResult.run.status} — ${planResult.run.error || 'unknown'}`);
  }
  console.log('  ? Ticket-plan completed');

  // 4. Discover child tickets
  console.log('\n[4] Discovering child chunk tickets...');
  const allTickets = await listTickets();
  const childTickets = allTickets.filter(t => t.id !== planTicketId)
    .sort((a, b) => a.id - b.id);
  console.log(`  ? Found ${childTickets.length} child tickets`);
  for (const ct of childTickets) {
    const input = typeof ct.workflowInput === 'string' ? JSON.parse(ct.workflowInput) : (ct.workflowInput || {});
    console.log(`    Ticket #${ct.id}: ${ct.objective} — status: ${ct.status} — output: ${input.outputPath || '?'}`);
  }

  if (childTickets.length !== 4) {
    console.log(`  ? WARNING: Expected 4 child tickets, got ${childTickets.length}. Pipeline may be incomplete.`);
  }

  // 5. Execute each child chunk workflow
  console.log('\n[5] Executing child chunk workflows...');
  const chunkResults = [];
  for (const ct of childTickets) {
    const label = `Chunk ${ct.objective.replace('Vendor Compliance Chunk ', '')}`;
    console.log(`\n  --- ${label} (ticket #${ct.id}) ---`);

    // Patch from blocked → open
    const patched = await patchTicketStatus(ct.id, 'open');
    if (!patched) {
      console.log(`  ? FAILED to unblock ticket #${ct.id}`);
      chunkResults.push({ ticketId: ct.id, objective: ct.objective, status: 'failed_to_unblock' });
      continue;
    }

    // Wait for completion
    const chunkResult = await waitForTicketComplete(ct.id, 300000, label);
    chunkResults.push({ ticketId: ct.id, objective: ct.objective, ...chunkResult });

    // Check output artifact
    const input = typeof ct.workflowInput === 'string' ? JSON.parse(ct.workflowInput) : (ct.workflowInput || {});
    const outPath = input.outputPath;
    if (outPath) {
      const fp = path.join(WORKSPACE_ROOT, outPath);
      if (fs.existsSync(fp)) {
        const content = fs.readFileSync(fp, 'utf8');
        const lines = content.trim().split('\n');
        console.log(`    Output: ${outPath} (${lines.length} lines, ${content.length} chars)`);
      } else {
        console.log(`    Output MISSING: ${outPath}`);
      }
    }
  }

  // 6. Verify all chunk CSVs exist
  console.log('\n[6] Verifying chunk output artifacts...');
  const chunkCsvs = ['compliance-chunk-001.csv', 'compliance-chunk-002.csv', 'compliance-chunk-003.csv', 'compliance-chunk-004.csv'];
  let allChunksPresent = true;
  for (const csv of chunkCsvs) {
    const fp = path.join(WORKSPACE_ROOT, 'vendors', 'chunks', csv);
    if (fs.existsSync(fp)) {
      const content = fs.readFileSync(fp, 'utf8');
      const lines = content.trim().split('\n');
      console.log(`  ? ${csv}: ${lines.length} lines, ${content.length} chars`);
    } else {
      console.log(`  ? ${csv}: MISSING`);
      allChunksPresent = false;
    }
  }

  if (!allChunksPresent) {
    console.log('\n  ? WARNING: Not all chunk CSVs present. Aggregate workflow may fail.');
  }

  // 7. Run aggregate workflow
  console.log('\n[7] Running vendor-compliance-medium-aggregate workflow...');
  const aggTicketId = await createWorkflowTicket(
    'Aggregate vendor compliance chunks into final register and summary',
    'vendor-compliance-medium-aggregate',
    { outputPath: 'vendors' }
  );
  const aggResult = await waitForTicketComplete(aggTicketId, 300000, 'Aggregate');
  if (aggResult.run) {
    console.log(`  ? Aggregate: ${aggResult.run.status} (run #${aggResult.run.id})`);
    if (aggResult.run.error) console.log(`    Error: ${aggResult.run.error.substring(0, 200)}`);
  }

  // 8. Check final output artifacts
  console.log('\n[8] Final output artifacts:');
  const finalArtifacts = ['vendors/vendor-decision-register.csv', 'vendors/compliance-review.md'];
  for (const art of finalArtifacts) {
    const fp = path.join(WORKSPACE_ROOT, art);
    if (fs.existsSync(fp)) {
      const content = fs.readFileSync(fp, 'utf8');
      const lines = content.trim().split('\n');
      console.log(`  ? ${art}: ${lines.length} lines, ${content.length} chars`);
      if (lines.length > 0 && art.endsWith('.csv')) {
        console.log(`    Header: ${lines[0]}`);
        console.log(`    Rows: ${lines.length - 1} vendors`);
      }
    } else {
      console.log(`  ? ${art}: MISSING`);
    }
  }

  // 9. Run verifier
  console.log('\n[9] Running fixture verifier...');
  await sleep(1000);
  const vResult = runVerifier();

  // While verifier runs in background, collect per-vendor data from manifest
  const manifest = await readFixtureManifest();
  const expectedVendors = manifest.expectedDecisionSet.files;
  console.log(`\n  Manifest expects ${expectedVendors.length} vendors`);

  // Collect run IDs and replay snapshots
  console.log('\n[10] Collecting replay snapshots...');
  const snapDir = path.join(DATA_DIR, 'replay-snapshots');
  if (fs.existsSync(snapDir)) {
    const snaps = fs.readdirSync(snapDir);
    console.log(`  ? ${snaps.length} replay snapshots found`);
    for (const snap of snaps.sort()) {
      const sp = path.join(snapDir, snap);
      const sz = fs.statSync(sp).size;
      console.log(`    ${snap}: ${sz} bytes`);
    }
  } else {
    console.log('  ? No replay-snapshots directory');
  }

  // Wait for verifier
  const verifierOutput = await vResult;
  console.log(`\n[11] Verifier exit code: ${verifierOutput.code}`);

  // 12. Per-vendor analysis
  console.log('\n[12] Per-vendor reconciliation:');
  const csvPath = path.join(WORKSPACE_ROOT, 'vendors', 'vendor-decision-register.csv');
  const registerVendors = {};
  if (fs.existsSync(csvPath)) {
    const csvContent = fs.readFileSync(csvPath, 'utf8');
    const csvLines = csvContent.trim().split('\n');
    for (let i = 1; i < csvLines.length; i++) {
      const cols = csvLines[i].split(',');
      const vid = cols[0];
      registerVendors[vid] = {
        name: cols[1],
        disposition: cols[2],
        reason: cols[3],
        policyRef: cols[4],
        nextAction: cols[5]
      };
    }
  }

  let present = 0, missing = 0, dispMatch = 0, dispMismatch = 0;
  const failures = [];
  for (const ev of expectedVendors) {
    const inRegister = registerVendors[ev.vendorId];
    const status = inRegister ? 'present' : 'missing';
    if (status === 'present') present++;
    else missing++;

    const dispOk = inRegister && inRegister.disposition === ev.expectedDisposition;
    if (dispOk) dispMatch++;
    else if (inRegister) dispMismatch++;

    const prefix = inRegister ? '  ' : '  ';
    console.log(`${prefix}${ev.vendorId} (${ev.vendorName}): ${status}${inRegister ? ' → ' + inRegister.disposition + (dispOk ? ' ✓' : ' ✗ expected ' + ev.expectedDisposition) : ''}`);

    if (inRegister && !dispOk) {
      failures.push({ vendorId: ev.vendorId, vendorName: ev.vendorName, expected: ev.expectedDisposition, actual: inRegister.disposition });
    }
  }

  console.log(`\n  Summary: ${present} present, ${missing} missing, ${dispMatch} dispositions match, ${dispMismatch} mismatch`);
  if (failures.length > 0) {
    console.log(`\n  Disposition mismatches:`);
    for (const f of failures) {
      console.log(`    ${f.vendorId} (${f.vendorName}): expected ${f.expected}, got ${f.actual}`);
    }
  }

  // 13. Collect run graph
  console.log('\n[13] Run graph:');
  const runs = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'runs.json'), 'utf8'));
  for (const r of runs.sort((a, b) => a.id - b.id)) {
    const ticket = allTickets.find(t => t.id === r.ticketId);
    console.log(`  Run #${r.id}: ticket #${r.ticketId} (${ticket ? ticket.objective : '?'}) — ${r.status} — ${r.transitions || '?'} transitions`);
  }

  stopServer();
  console.log('\nVC-1 complete.');
}

main().catch(err => { console.error('FAIL:', err.message, err.stack); stopServer(); process.exit(1); });

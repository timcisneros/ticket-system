#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const PORT = process.env.PORT || 3099;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const WORKSPACE_ROOT = path.join(ROOT, 'workspace-root');
const FIXTURE_WORKSPACE = path.join('/tmp', 'opencode', 'vendor-benchmark-fixtures');
const DATA_DIR = path.join(ROOT, 'data');
const SERVER_SCRIPT = path.join(ROOT, 'server.js');

const FAILURE_CLASSIFICATIONS = ['fixture design', 'policy ambiguity', 'verifier weakness', 'model reasoning', 'runtime defect'];

let cookie = '';
let serverProcess = null;

function failClassification(label, detail) {
  console.log(`\nFAILURE CLASSIFICATION: ${label}`);
  console.log(`Detail: ${detail}`);
  process.exit(1);
}

function httpReq(method, urlPath, opts = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(BASE_URL + urlPath);
    const options = {
      hostname: u.hostname,
      port: u.port,
      path: u.pathname + (u.search || ''),
      method,
      headers: { ...opts.headers }
    };
    if (opts.body) {
      options.headers['Content-Length'] = Buffer.byteLength(opts.body);
    }
    const req = http.request(options, res => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

async function login() {
  const password = process.env.ADMIN_PASSWORD || 'admin123';
  const body = `username=admin&password=${encodeURIComponent(password)}`;
  const res = await httpReq('POST', '/login', {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  });
  if (res.status === 302) {
    const setCookie = res.headers['set-cookie'];
    const cookieStr = Array.isArray(setCookie) ? setCookie[0] : setCookie;
    const match = cookieStr && cookieStr.match(/sessionId=([^;]+)/);
    if (match) {
      cookie = `sessionId=${match[1]}`;
      console.log('  ✓ Logged in as admin');
      return;
    }
  }
  failClassification('fixture design', 'Login failed: status=' + res.status);
}

async function createWorkflowTicket(objective, workflowId, workflowInput) {
  const form = new URLSearchParams({
    objective,
    capabilityType: 'workflow',
    executionMode: 'workflow',
    workflowId,
    workflowInput: JSON.stringify(workflowInput || {}),
    assignmentTargetType: 'agent',
    assignmentTargetId: '1',
    assignmentMode: 'individual'
  });
  const res = await httpReq('POST', '/tickets', {
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Cookie': cookie
    },
    body: form.toString()
  });
  if (res.status !== 302) {
    failClassification('runtime defect', 'Create ticket failed: HTTP ' + res.status + ' body=' + res.body);
  }
  const listRes = await httpReq('GET', '/api/tickets', {
    headers: { 'Cookie': cookie }
  });
  if (listRes.status !== 200) {
    failClassification('runtime defect', 'Failed to list tickets after creation');
  }
  const ticketData = JSON.parse(listRes.body);
  const tickets = ticketData.tickets || ticketData;
  const matching = tickets.filter(t => t.objective === objective);
  const ticket = matching.length > 0
    ? matching.reduce((a, b) => (a.id > b.id ? a : b))
    : tickets.reduce((a, b) => (a.id > b.id ? a : b), null);
  if (!ticket) {
    failClassification('runtime defect', 'Could not find created ticket');
  }
  console.log(`  ✓ Created ticket #${ticket.id} for workflow ${workflowId}`);
  return ticket.id;
}

function readJson(filePath) {
  const fullPath = path.join(DATA_DIR, filePath);
  if (!fs.existsSync(fullPath)) return [];
  return JSON.parse(fs.readFileSync(fullPath, 'utf8'));
}

function writeJson(filePath, data) {
  fs.writeFileSync(path.join(DATA_DIR, filePath), JSON.stringify(data, null, 2));
}

async function waitForTicketComplete(ticketId, timeoutMs) {
  timeoutMs = timeoutMs || 120000;
  const started = Date.now();
  const terminal = new Set(['completed', 'failed', 'interrupted']);
  while (Date.now() - started < timeoutMs) {
    const ticket = readJson('tickets.json').find(t => t.id === ticketId);
    if (!ticket) { await sleep(500); continue; }
    const runs = readJson('runs.json').filter(r => r.ticketId === ticketId);
    const latestRun = runs.length > 0 ? runs[runs.length - 1] : null;
    if (latestRun && terminal.has(latestRun.status) && ticket.status === latestRun.status) {
      return { ticket, run: latestRun };
    }
    if (latestRun && terminal.has(latestRun.status)) {
      return { ticket, run: latestRun };
    }
    await sleep(1000);
  }
  const ticket = readJson('tickets.json').find(t => t.id === ticketId);
  const runs = readJson('runs.json').filter(r => r.ticketId === ticketId);
  const latestRun = runs.length > 0 ? runs[runs.length - 1] : null;
  console.log(`  ⚠ Ticket #${ticketId} timed out: status=${ticket ? ticket.status : 'unknown'} run=${latestRun ? latestRun.status : 'none'}`);
  return { ticket, run: latestRun };
}

async function openBlockedTicket(ticketId) {
  const res = await httpReq('PATCH', `/api/tickets/${ticketId}/status`, {
    headers: {
      'Content-Type': 'application/json',
      'Cookie': cookie
    },
    body: JSON.stringify({ status: 'open' })
  });
  if (res.status !== 200) {
    failClassification('runtime defect', `Failed to open ticket #${ticketId}: HTTP ${res.status} ${res.body}`);
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function getChildTickets(parentTicketId, parentRunId) {
  return readJson('tickets.json').filter(t =>
    t.parentTicketId === parentTicketId && t.parentRunId === parentRunId
  );
}

async function fixtureGenerate() {
  fs.mkdirSync(FIXTURE_WORKSPACE, { recursive: true });
  fs.writeFileSync(path.join(FIXTURE_WORKSPACE, '.fixture-workspace'), 'vendor-benchmark');
  const seed = 42000;
  return new Promise((resolve, reject) => {
    const proc = spawn('node', [
      'scripts/fixture-generator.js',
      `--fixture=vendor-compliance`,
      `--count=40`,
      `--seed=${seed}`,
      `--workspace=${FIXTURE_WORKSPACE}`,
      `--evaluation-date=2026-06-07`,
      '--overwrite'
    ], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    proc.stdout.on('data', d => output += d);
    proc.stderr.on('data', d => output += d);
    proc.on('close', code => {
      if (code === 0) {
        console.log('  ✓ Generated 40-vendor compliance fixture');
        const srcVendors = path.join(FIXTURE_WORKSPACE, 'vendors');
        const dstVendors = path.join(WORKSPACE_ROOT, 'vendors');
        if (fs.existsSync(dstVendors)) {
          fs.rmSync(dstVendors, { recursive: true, force: true });
        }
        fs.cpSync(srcVendors, dstVendors, { recursive: true });
        // Run expand script to inject edge cases and policy guidance
        const exp = spawn('node', ['scripts/expand-vendor-fixture.js'], { cwd: ROOT, stdio: ['inherit'] });
        exp.on('close', expandCode => {
          if (expandCode === 0) {
            console.log('  ✓ Expanded fixture with edge cases and policy guidance');
            resolve();
          } else {
            reject(new Error('Fixture expansion failed'));
          }
        });
      } else {
        reject(new Error('Fixture generation failed: ' + output));
      }
    });
  });
}

async function startServer() {
  return new Promise((resolve, reject) => {
    const proc = spawn('node', [SERVER_SCRIPT], {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        PORT: String(PORT),
        DATA_DIR: DATA_DIR,
        WORKSPACE_ROOT: WORKSPACE_ROOT
      }
    });
    serverProcess = proc;
    let started = false;
    let output = '';
    proc.stdout.on('data', d => {
      output += d.toString();
      if (!started && output.includes('localhost:' + PORT)) {
        started = true;
        resolve();
      }
    });
    proc.stderr.on('data', d => {
      output += d.toString();
      if (!started && output.includes('localhost:' + PORT)) {
        started = true;
        resolve();
      }
    });
    proc.on('error', reject);
    setTimeout(() => {
      if (!started) {
        console.log('  ⚠ Server start timeout, checking if running anyway...');
        started = true;
        resolve();
      }
    }, 10000);
  });
}

function stopServer() {
  if (serverProcess) {
    serverProcess.kill('SIGTERM');
    serverProcess = null;
  }
}

function clearDataFiles() {
  for (const file of ['tickets.json', 'runs.json', 'events.jsonl', 'logs.json', 'operation-history.json', 'workflows.json']) {
    const fp = path.join(DATA_DIR, file);
    if (fs.existsSync(fp)) {
      if (file.endsWith('.jsonl')) {
        fs.writeFileSync(fp, '');
      } else {
        fs.writeFileSync(fp, '[]');
      }
    }
  }
  const snapDir = path.join(DATA_DIR, 'replay-snapshots');
  if (fs.existsSync(snapDir)) {
    for (const f of fs.readdirSync(snapDir)) {
      fs.unlinkSync(path.join(snapDir, f));
    }
  }
}

async function verifyOutput() {
  return new Promise((resolve, reject) => {
    const proc = spawn('node', [
      'scripts/fixture-verifier.js',
      `--fixture=vendor-compliance`
    ], {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, WORKSPACE_ROOT, DATA_DIR }
    });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', d => stdout += d);
    proc.stderr.on('data', d => stderr += d);
    proc.on('close', code => {
      resolve({ code, stdout, stderr });
    });
  });
}

async function main() {
  console.log('Vendor Compliance Realism Benchmark');
  console.log('===================================\n');

  console.log('[1/8] Generating 40-vendor fixtures...');
  await fixtureGenerate();

  console.log('\n[2/8] Clearing data files and starting server...');
  clearDataFiles();
  await startServer();
  console.log('  ✓ Server started on port ' + PORT);
  await sleep(1000);

  console.log('\n[3/8] Logging in and creating parent ticket-plan ticket...');
  await login();
  const parentTicketId = await createWorkflowTicket(
    'Vendor Compliance Ticket Plan for 40 vendors',
    'vendor-compliance-ticket-plan',
    {}
  );

  console.log('\n[4/8] Waiting for parent ticket-plan run to complete...');
  const parentResult = await waitForTicketComplete(parentTicketId, 180000);
  if (!parentResult.run || parentResult.run.status !== 'completed') {
    failClassification('model reasoning',
      `Parent ticket-plan run failed: status=${parentResult.run ? parentResult.run.status : 'none'}`);
  }
  console.log(`  ✓ Parent completed, run #${parentResult.run.id}`);

  const childTickets = getChildTickets(parentTicketId, parentResult.run.id);
  console.log(`  → ${childTickets.length} child chunk tickets created`);
  if (childTickets.length === 0) {
    failClassification('runtime defect', 'No child chunk tickets created by executeTicketPlan');
  }

  console.log('\n[5/8] Opening blocked child chunk tickets...');
  for (const child of childTickets) {
    console.log(`  Opening ticket #${child.id} (${child.workflowId})...`);
    await openBlockedTicket(child.id);
    await sleep(500);
  }

  console.log('\n[6/8] Waiting for all child chunk runs to complete...');
  for (const child of childTickets) {
    console.log(`  Waiting for chunk ticket #${child.id}...`);
    const result = await waitForTicketComplete(child.id, 300000);
    if (!result.run || result.run.status !== 'completed') {
      failClassification('model reasoning',
        `Child chunk ticket #${child.id} failed: status=${result.run ? result.run.status : 'none'}`);
    }
    console.log(`    ✓ Chunk ticket #${child.id} completed, run #${result.run.id}`);
  }

  console.log('\n[7/8] Creating and waiting for aggregate workflow...');
  const aggregateTicketId = await createWorkflowTicket(
    'Vendor Compliance Aggregate for 40 vendors',
    'vendor-compliance-medium-aggregate',
    { outputPath: 'vendors' }
  );
  const aggregateResult = await waitForTicketComplete(aggregateTicketId, 300000);
  if (!aggregateResult.run || aggregateResult.run.status !== 'completed') {
    failClassification('model reasoning',
      `Aggregate run failed: status=${aggregateResult.run ? aggregateResult.run.status : 'none'}`);
  }
  console.log(`  ✓ Aggregate completed, run #${aggregateResult.run.id}`);

  console.log('\n[8/8] Running verifier...');
  await sleep(1000);
  const verifierResult = await verifyOutput();
  console.log(verifierResult.stdout);
  if (verifierResult.stderr) console.error(verifierResult.stderr);

  if (verifierResult.code === 0) {
    console.log('\n===================================');
    console.log('RESULT: PASS');
    console.log('===================================');
    console.log('\nThe BF-3H decomposition pattern generalizes to Vendor Compliance.');
    console.log('40 vendors successfully classified across 4 chunks + aggregate.');
    console.log('No new primitives needed. Substrate holds.');
  } else {
    const output = verifierResult.stdout;
    const failMatch = output.match(/(\d+) passed, (\d+) failed/);
    const failed = failMatch ? parseInt(failMatch[2], 10) : 0;
    console.log('\n===================================');
    console.log('RESULT: FAIL — ' + failed + ' verifier checks failed');
    console.log('===================================');
    const failLines = output.split('\n').filter(l => l.includes('✗'));
    for (const line of failLines) {
      const clean = line.replace('  ✗ ', '');
      if (clean.includes('missing') || clean.includes('Missing')) {
        console.log(`  → Failure type: verifier weakness or model reasoning`);
      } else if (clean.includes('mismatch')) {
        console.log(`  → Failure type: model reasoning`);
      } else if (clean.includes('Replay')) {
        console.log(`  → Failure type: runtime defect`);
      }
    }
    stopServer();
    process.exit(1);
  }

  stopServer();
  console.log('\nDone.');
}

main().catch(err => {
  console.error('Benchmark error:', err);
  stopServer();
  process.exit(1);
});

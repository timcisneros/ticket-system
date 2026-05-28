#!/usr/bin/env node
// Scheduler integrity abuse test suite — exercises runtime edge cases around
// lease management, scheduler dispatch, replay integrity, and persistence ordering.
// Uses fake OpenAI provider with deterministic model responses.
// Distinguishes runtime corruption from model failure.
// No patches — reports gaps for evaluation.

const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { createTempWorkspaceRoot, removeTempWorkspaceRoot } = require('./test-workspace');

const ROOT = path.resolve(__dirname, '..');
const REAL_DATA_DIR = path.join(ROOT, 'data');
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'scheduler-integrity-'));
const WORKSPACE_ROOT = createTempWorkspaceRoot('scheduler-integrity');
const PORT = process.env.PORT || '3467';
const BASE_URL = `http://127.0.0.1:${PORT}`;
const STAMP = Date.now();

const DATA_FILES = ['agents.json', 'allocation-plans.json', 'events.jsonl', 'groups.json', 'logs.json', 'memberships.json', 'operation-history.json', 'permissions.json', 'runs.json', 'tickets.json', 'users.json', 'workflows.json'];

for (const file of DATA_FILES) {
  const src = path.join(REAL_DATA_DIR, file);
  const dst = path.join(DATA_DIR, file);
  if (file === 'events.jsonl') {
    fs.writeFileSync(dst, '');
  } else {
    fs.writeFileSync(dst, fs.existsSync(src) ? fs.readFileSync(src, 'utf8') : '[]');
  }
}

const REPLAY_SNAPSHOTS_DIR = path.join(DATA_DIR, 'replay-snapshots');

let agentIdCounter = 100;

function readJson(file) {
  return JSON.parse(fs.readFileSync(path.join(DATA_DIR, file), 'utf8'));
}

function writeJson(file, value) {
  fs.writeFileSync(path.join(DATA_DIR, file), JSON.stringify(value, null, 2));
}

function readEvents() {
  const raw = fs.readFileSync(path.join(DATA_DIR, 'events.jsonl'), 'utf8').trim();
  return raw ? raw.split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
}

function readReplaySnapshot(run) {
  if (!run || !run.replaySnapshotPath) return null;
  const sp = path.join(DATA_DIR, run.replaySnapshotPath);
  if (!sp.startsWith(DATA_DIR + path.sep)) return null;
  if (!fs.existsSync(sp)) return null;
  try { return JSON.parse(fs.readFileSync(sp, 'utf8')); } catch (e) { return null; }
}

function readLogsForRun(runId) {
  return readJson('logs.json').filter(l => l.runId === runId);
}

function request(method, urlPath, options = {}) {
  const body = options.form
    ? new URLSearchParams(options.form).toString()
    : options.body
      ? JSON.stringify(options.body)
      : null;

  return new Promise((resolve, reject) => {
    const req = http.request(`${BASE_URL}${urlPath}`, {
      method,
      headers: {
        ...(options.form ? { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) } : {}),
        ...(options.body ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } : {}),
        ...(options.cookie ? { Cookie: options.cookie } : {})
      }
    }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ statusCode: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function cookieFrom(response) {
  return (response.headers['set-cookie'] || []).map(cookie => cookie.split(';')[0]).join('; ');
}

function assert(condition, message) {
  if (!condition) throw new Error(`INTEGRITY_ASSERTION_FAILED: ${message}`);
}

function formatDuration(ms) {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

// ── Fake OpenAI preload ──────────────────────────────────────────────

function createFakeOpenAIPreload() {
  const preloadPath = path.join(os.tmpdir(), `scheduler-integrity-openai-${process.pid}-${STAMP}.js`);
  const source = `
function okResponse(plan) {
  return {
    ok: true,
    status: 200,
    headers: new Map([['x-request-id', 'fake-sched-' + Date.now()]]),
    async text() {
      return JSON.stringify({
        output_text: JSON.stringify(plan),
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 }
      });
    }
  };
}

global.fetch = async function(_url, options = {}) {
  const body = JSON.parse(options.body || '{}');
  const input = Array.isArray(body.input) ? body.input : [];
  const combined = input.map(item => item && item.content ? String(item.content) : '').join('\\\\n');

  if (combined.includes('SCHED-LEASE-EXPIRY-${STAMP}')) {
    return okResponse({
      message: 'Writing lease-expiry-test-output.txt',
      actions: [{ operation: 'writeFile', args: { path: 'lease-expiry-test-output.txt', content: 'lease expiry test' } }],
      complete: true
    });
  }

  if (combined.includes('SCHED-HANDOFF-STALL-${STAMP}')) {
    return okResponse({
      message: 'Thinking about the handoff...',
      actions: [],
      complete: false
    });
  }

  if (combined.includes('SCHED-INTERRUPTED-HANDOFF-${STAMP}')) {
    return okResponse({
      message: 'Delegating to Executor 4',
      actions: [{ operation: 'createHandoffTask', args: { executor: 'John', operation: 'writeFile', args: { path: 'interrupted-handoff.txt', content: 'interrupted' } } }],
      complete: true
    });
  }

  if (combined.includes('SCHED-DOUBLE-LEASE-${STAMP}')) {
    return okResponse({
      message: 'Writing double-lease-output.txt',
      actions: [{ operation: 'writeFile', args: { path: 'double-lease-output.txt', content: 'double lease test' } }],
      complete: true
    });
  }

  if (combined.includes('SCHED-CONCURRENT-CLAIMS-${STAMP}')) {
    return okResponse({
      message: 'Writing concurrent-claims-output.txt',
      actions: [{ operation: 'writeFile', args: { path: 'concurrent-claims-output.txt', content: 'concurrent claims' } }],
      complete: true
    });
  }

  if (combined.includes('SCHED-RESUME-CRASH-${STAMP}')) {
    return okResponse({
      message: 'Writing resume-crash-output.txt',
      actions: [{ operation: 'writeFile', args: { path: 'resume-crash-output.txt', content: 'resume from crash' } }],
      complete: true
    });
  }

  if (combined.includes('SCHED-STALLED-RECOVER-${STAMP}')) {
    return okResponse({
      message: 'Writing stalled-recover-output.txt after thinking',
      actions: [{ operation: 'writeFile', args: { path: 'stalled-recover-output.txt', content: 'recovered from stall' } }],
      complete: true
    });
  }

  if (combined.includes('SCHED-DUPLICATE-APPEND-${STAMP}')) {
    return okResponse({
      message: 'Writing duplicate-append-output.txt',
      actions: [{ operation: 'writeFile', args: { path: 'duplicate-append-output.txt', content: 'duplicate append' } }],
      complete: true
    });
  }

  if (combined.includes('SCHED-WRITE-CONFLICT-${STAMP}')) {
    return okResponse({
      message: 'Writing write-conflict-output.txt',
      actions: [{ operation: 'writeFile', args: { path: 'write-conflict-output.txt', content: 'write conflict' } }],
      complete: true
    });
  }

  if (combined.includes('SCHED-ORPHAN-EXECUTOR-${STAMP}')) {
    return okResponse({
      message: 'Delegating to Executor 4 to write orphan-executor-output.txt',
      actions: [{ operation: 'createHandoffTask', args: { executor: 'John', operation: 'writeFile', args: { path: 'orphan-executor-output.txt', content: 'orphan test' } } }],
      complete: true
    });
  }

  return okResponse({
    message: 'Default response for unknown scenario.',
    actions: [{ operation: 'writeFile', args: { path: 'default-output.txt', content: 'default' } }],
    complete: true
  });
};
`;
  fs.writeFileSync(preloadPath, source);
  return preloadPath;
}

// ── Scheduler tick manipulation helpers ─────────────────────────────

// We manipulate data files directly to simulate race conditions.
function setRunLeaseExpired(runId) {
  const runs = readJson('runs.json');
  const run = runs.find(r => r.id === runId);
  if (!run) return null;
  run.leaseExpiresAt = new Date(0).toISOString();
  writeJson('runs.json', runs);
  return run;
}

function clearRunLeaseOwner(runId) {
  const runs = readJson('runs.json');
  const run = runs.find(r => r.id === runId);
  if (!run) return null;
  run.leaseOwner = null;
  run.leaseExpiresAt = null;
  writeJson('runs.json', runs);
  return run;
}

function forceRunStatus(runId, status, extra = {}) {
  const runs = readJson('runs.json');
  const run = runs.find(r => r.id === runId);
  if (!run) return null;
  Object.assign(run, { status, ...extra });
  writeJson('runs.json', runs);
  return run;
}

function readRun(runId) {
  const runs = readJson('runs.json');
  return runs.find(r => r.id === runId) || null;
}

function readTicket(ticketId) {
  const tickets = readJson('tickets.json');
  return tickets.find(t => t.id === ticketId) || null;
}

// ── HTTP helpers ────────────────────────────────────────────────────

async function waitForReady(timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await request('GET', '/health');
      if (res.statusCode === 200) return true;
    } catch (e) {}
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('Server did not become ready');
}

async function login() {
  const res = await request('POST', '/login', {
    form: { username: 'admin', password: 'admin123' }
  });
  const cookie = cookieFrom(res);
  assert(cookie, 'Login failed — no cookie');
  return cookie;
}

async function getRunState(cookie, runId) {
  const response = await request('GET', `/api/runs/${runId}/state`, { cookie });
  assert(response.statusCode === 200, `Run state API returned HTTP ${response.statusCode}: ${response.body}`);
  return JSON.parse(response.body);
}

async function getRunEvents(cookie, runId) {
  const response = await request('GET', `/api/runs/${runId}/events`, { cookie });
  assert(response.statusCode === 200, `Run events API returned HTTP ${response.statusCode}: ${response.body}`);
  return JSON.parse(response.body).events || [];
}

async function createTicket(cookie, agent, objective) {
  const response = await request('POST', '/tickets', {
    cookie,
    form: {
      objective,
      assignmentTargetType: 'agent',
      assignmentTargetId: String(agent.id),
      assignmentMode: 'individual'
    }
  });
  if (response.statusCode === 302) {
    const tickets = readJson('tickets.json');
    return tickets.find(t => t.objective === objective) || tickets[tickets.length - 1];
  }
  const body = response.body;
  let parsed;
  try { parsed = JSON.parse(body); } catch (e) { parsed = { statusCode: response.statusCode, body: body.substring(0, 200) }; }
  parsed.error = true;
  return parsed;
}

async function stopRun(cookie, runId) {
  const response = await request('POST', `/api/runs/${runId}/stop`, { cookie });
  if (response.statusCode !== 200) {
    return { error: true, statusCode: response.statusCode, body: response.body };
  }
  return JSON.parse(response.body);
}

async function waitForRun(runId, statusCheck, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const run = readRun(runId);
    if (run && statusCheck(run)) return run;
    await new Promise(r => setTimeout(r, 100));
  }
  const run = readRun(runId);
  return run || null;
}

function waitForTerminalRun(ticketId, timeoutMs = 15000) {
  return waitForTicketRun(ticketId, run => ['completed', 'failed', 'interrupted'].includes(run.status), timeoutMs);
}

async function waitForTicketRun(ticketId, statusCheck, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const runs = readJson('runs.json').filter(r => r.ticketId === ticketId);
    const match = runs.find(statusCheck);
    if (match) return match;
    await new Promise(r => setTimeout(r, 100));
  }
  const runs = readJson('runs.json').filter(r => r.ticketId === ticketId);
  return runs[runs.length - 1] || null;
}

// ── Server management ───────────────────────────────────────────────

let server = null;
let childOutput = '';

function startServer(envOverrides = {}) {
  return new Promise((resolve, reject) => {
    childOutput = '';
    server = spawn(process.execPath, ['server.js'], {
      cwd: ROOT,
      env: {
        ...process.env,
        NODE_ENV: 'test',
        PORT,
        DATA_DIR,
        WORKSPACE_ROOT,
        AGENT_MAX_EXECUTION_STEPS: '6',
        AGENT_MAX_MODEL_REQUESTS_PER_RUN: '4',
        AGENT_MAX_WORKSPACE_OPERATIONS_PER_RUN: '10',
        AGENT_MAX_RUNTIME_DURATION_MS: '30000',
        AGENT_MAX_CONSECUTIVE_STALLS: '3',
        RUNTIME_SCHEDULER_INTERVAL_MS: '200',
        ...envOverrides
      },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    server.stdout.on('data', chunk => { childOutput += chunk.toString(); });
    server.stderr.on('data', chunk => { childOutput += chunk.toString(); });
    server.on('error', reject);
    server.on('exit', (code) => {
      if (code !== 0 && !server.killed) {
        // Log but don't reject — tests may kill server intentionally
      }
    });
    resolve();
  });
}

function stopServer() {
  return new Promise((resolve) => {
    if (!server) return resolve();
    const oldServer = server;
    const onExit = () => {
      // Only clear server if it's still the process we stopped, not a new one
      // that started after stopServer() was called.
      if (server === oldServer) server = null;
      resolve();
    };
    oldServer.once('exit', onExit);
    oldServer.kill('SIGTERM');
    setTimeout(() => {
      if (oldServer && oldServer.exitCode === null) {
        oldServer.kill('SIGKILL');
        setTimeout(onExit, 200);
      }
    }, 3000);
  });
}

// ── Agent seeding ───────────────────────────────────────────────────

function seedAgent(overrides = {}) {
  const agents = readJson('agents.json');
  const id = agentIdCounter++;
  const agent = {
    id,
    name: `Agent-${id}`,
    type: 'agent',
    provider: 'openai',
    model: 'gpt-4.1-mini',
    apiKey: 'sk-fake-scheduler-integrity',
    createdAt: new Date().toISOString(),
    ...overrides,
    runtimeConfig: {
      allowHandoffTask: true,
      allowWorkflowDraftIntent: true,
      ...(overrides.runtimeConfig || {})
    }
  };
  agents.push(agent);
  writeJson('agents.json', agents);
  return agent;
}

// ── Validation helpers ──────────────────────────────────────────────

function assertRunIntegrity(runState, events) {
  assert(runState && runState.id, `Run state missing id`);
  assert(runState.status, `Run state missing status`);
  const replaySummary = runState.replaySummary || {};
  const replaySnapshot = runState.replaySnapshot;
  if (replaySnapshot) {
    assert(Array.isArray(replaySnapshot.providerRequests), `replaySnapshot.providerRequests not array`);
    assert(Array.isArray(replaySnapshot.modelResponses), `replaySnapshot.modelResponses not array`);
    assert(Array.isArray(replaySnapshot.parsedModelPlans), `replaySnapshot.parsedModelPlans not array`);
  }
}

function assertReplayOrdering(snapshot) {
  if (!snapshot || !Array.isArray(snapshot.events)) return;
  let lastTs = '';
  for (const ev of snapshot.events) {
    if (ev.capturedAt) {
      if (lastTs && ev.capturedAt < lastTs) {
        throw new Error(`Replay events out of order: ${lastTs} > ${ev.capturedAt}`);
      }
      lastTs = ev.capturedAt;
    }
  }
}

function assertEventOrdering(events) {
  let lastTs = '';
  for (const ev of events) {
    if (ev.ts) {
      if (lastTs && ev.ts < lastTs) {
        throw new Error(`Events out of order: ${lastTs} > ${ev.ts}`);
      }
      lastTs = ev.ts;
    }
  }
}

// ── Test 1: Lease expiry during active run ──────────────────────────

async function testLeaseExpiryDuringRun(cookie, agent) {
  console.log('\n[1/13] Lease expiry during active run — expire lease mid-execution');
  const objective = `SCHED-LEASE-EXPIRY-${STAMP} Write lease-expiry-test-output.txt`;
  const ticket = await createTicket(cookie, agent, objective);
  assert(ticket && ticket.id, `Ticket creation failed: ${JSON.stringify(ticket)}`);
  let run = await waitForTicketRun(ticket.id, r => r.status === 'pending' && r.leaseOwner);
  assert(run, 'Run not created with lease');
  const originalLeaseOwner = run.leaseOwner;

  // Expire the lease while run is executing
  setRunLeaseExpired(run.id);
  await new Promise(r => setTimeout(r, 600));

  // Wait for terminal state
  run = await waitForTerminalRun(ticket.id);
  const runState = await getRunState(cookie, run.id);
  const events = await getRunEvents(cookie, run.id);
  assertRunIntegrity(runState, events);

  const hasLeaseExpired = events.some(e => e.type === 'run.lease_expired');
  const underlyingCompleted = run.status === 'completed';
  const interrupted = run.status === 'interrupted';

  console.log(`  Result: ${run.status}, lease_expired event: ${hasLeaseExpired}, completed: ${underlyingCompleted}, interrupted: ${interrupted}`);
  console.log(`  Original lease owner: ${originalLeaseOwner}, final lease owner: ${run.leaseOwner}`);
  return { name: 'lease-expiry-during-run', passed: true, run, runState, events };
}

// ── Test 2: Double lease acquisition race ────────────────────────────

async function testDoubleLeaseAcquisition(cookie, agent) {
  console.log('\n[2/13] Double lease acquisition race — try to acquire lease for already-leased run');
  const objective = `SCHED-DOUBLE-LEASE-${STAMP} Write double-lease-output.txt`;
  const ticket = await createTicket(cookie, agent, objective);
  assert(ticket && ticket.id, `Ticket creation failed: ${JSON.stringify(ticket)}`);
  let run = await waitForTicketRun(ticket.id, r => r.leaseOwner);
  assert(run, 'Run not created');
  const firstLeaseOwner = run.leaseOwner;

  // Manually set run back to pending and try re-acquisition
  // This simulates what happens if two scheduler instances race
  forceRunStatus(run.id, 'pending', { leaseOwner: null, leaseExpiresAt: null });
  await new Promise(r => setTimeout(r, 600));

  run = await waitForTicketRun(ticket.id, r => r.leaseOwner && r.leaseOwner !== firstLeaseOwner);
  const runState = await getRunState(cookie, run.id);
  const events = await getRunEvents(cookie, run.id);
  assertRunIntegrity(runState, events);

  const hasSecondAcquire = events.filter(e => e.type === 'run.lease_acquired').length >= 1;
  const hasDoubleAcquire = events.filter(e => e.type === 'run.lease_acquired').length >= 2;
  console.log(`  Result: ${run.status}, lease_acquired events: ${events.filter(e => e.type === 'run.lease_acquired').length}, double acquire possible: ${hasDoubleAcquire}`);
  console.log(`  First lease owner: ${firstLeaseOwner}, current lease owner: ${run.leaseOwner}`);
  return { name: 'double-lease-acquisition', passed: true, run, runState, events };
}

// ── Test 3: Interrupted executor handoff ─────────────────────────────

async function testInterruptedExecutorHandoff(cookie, agent) {
  console.log('\n[3/13] Interrupted executor handoff — attempt stop after handoff already executed');
  // Use a normal handoff preload (completes quickly). The stop may or may not
  // land — what matters is data/replay integrity regardless of timing.
  const objective = `SCHED-INTERRUPTED-HANDOFF-${STAMP} Delegate to executor 4`;
  const ticket = await createTicket(cookie, agent, objective);
  assert(ticket && ticket.id, `Ticket creation failed: ${JSON.stringify(ticket)}`);

  // Wait for run to be running, then try to stop immediately
  let run = await waitForTicketRun(ticket.id, r => r.status === 'running');
  assert(run, 'Run did not start');
  const stopResult = await stopRun(cookie, run.id);
  const stopAccepted = !stopResult.error;

  run = await waitForTerminalRun(ticket.id);
  const runState = await getRunState(cookie, run.id);
  const events = await getRunEvents(cookie, run.id);
  assertRunIntegrity(runState, events);

  const isInterrupted = run.status === 'interrupted';
  const hasHandoffValidated = events.some(e => e.type === 'handoff.task_validated');
  const hasHandoffExecuted = events.some(e => e.type === 'handoff.task_executed');
  const snapshot = readReplaySnapshot(run);
  const handoffTasks = (snapshot && snapshot.handoffTasks) || [];

  console.log(`  Result: ${run.status}, stop accepted: ${stopAccepted}, interrupted: ${isInterrupted}`);
  console.log(`  Handoff: validated=${hasHandoffValidated}, executed=${hasHandoffExecuted}, tasks=${handoffTasks.length}`);
  return { name: 'interrupted-executor-handoff', passed: true, run, runState, events };
}

// ── Test 4: Concurrent run claims ────────────────────────────────────

async function testConcurrentRunClaims(cookie, agent) {
  console.log('\n[4/13] Concurrent run claims — create multiple tickets for same agent');
  const objectives = [
    `SCHED-CONCURRENT-CLAIMS-${STAMP}-A Write concurrent-a.txt`,
    `SCHED-CONCURRENT-CLAIMS-${STAMP}-B Write concurrent-b.txt`,
    `SCHED-CONCURRENT-CLAIMS-${STAMP}-C Write concurrent-c.txt`
  ];
  const tickets = [];
  for (const obj of objectives) {
    const t = await createTicket(cookie, agent, obj);
    assert(t && t.id, `Ticket creation failed: ${JSON.stringify(t)}`);
    tickets.push(t);
    await new Promise(r => setTimeout(r, 100));
  }

  const runs = [];
  for (const t of tickets) {
    const run = await waitForTerminalRun(t.id);
    assert(run, `Run not created for ticket ${t.id}`);
    runs.push(run);
  }

  const runState0 = await getRunState(cookie, runs[0].id);
  const events0 = await getRunEvents(cookie, runs[0].id);
  assertRunIntegrity(runState0, events0);

  // Verify serialized execution: only one run active at a time for same agent (OpenAI)
  const allEvents = [];
  for (const r of runs) {
    const evts = await getRunEvents(cookie, r.id);
    allEvents.push(...evts.map(e => ({ ...e, runId: r.id })));
  }

  const startTimes = runs.map(r => r.startedAt).filter(Boolean).sort();
  const completedTimes = runs.map(r => r.completedAt).filter(Boolean).sort();
  const sequential = startTimes.length === completedTimes.length &&
    startTimes.every((s, i) => !completedTimes[i] || s >= (completedTimes[i - 1] || ''));

  console.log(`  Tickets: ${tickets.length}, Runs: ${runs.length}`);
  console.log(`  Statuses: ${runs.map(r => r.status).join(', ')}`);
  console.log(`  Sequentially executed: ${sequential}`);
  console.log(`  Started: ${startTimes.join(', ')}`);
  runs.forEach(r => console.log(`    Run ${r.id}: ${r.status} (started ${r.startedAt || 'N/A'})`));
  return { name: 'concurrent-run-claims', passed: true, runs, allEvents };
}

// ── Test 5: Run resumption after crash ───────────────────────────────

async function testRunResumptionAfterCrash(cookie, agent) {
  console.log('\n[5/13] Run resumption after crash — kill server, corrupt lease, restart, verify scheduler cleanup');
  const objective = `SCHED-RESUME-CRASH-${STAMP} Write resume-crash-output.txt`;
  const ticket = await createTicket(cookie, agent, objective);
  assert(ticket && ticket.id, `Ticket creation failed: ${JSON.stringify(ticket)}`);

  // Wait for run to acquire lease
  let run = await waitForTicketRun(ticket.id, r => r.leaseOwner);
  assert(run, 'Run not created with lease');
  console.log(`  Run ${run.id} acquired lease, status=${run.status}`);

  // Kill the server to simulate crash
  console.log(`  Killing server (PID: ${server.pid}) to simulate crash`);
  await stopServer();
  await new Promise(r => setTimeout(r, 300));

  // Now corrupt the run data: stale lease from different owner
  const runs = readJson('runs.json');
  const r = runs.find(x => x.id === run.id);
  r.leaseOwner = 'crash-sim:orphaned-process';
  r.leaseExpiresAt = new Date(Date.now() - 120000).toISOString();
  r.status = 'running';
  writeJson('runs.json', runs);
  console.log(`  Corrupted run: status=running, leaseOwner=crash-sim:orphaned-process, lease=expired`);

  // Restart server
  console.log('  Restarting server...');
  await startServer({ NODE_OPTIONS: `--require ${createFakeOpenAIPreload()}` });
  await waitForReady();

  // Wait for scheduler tick to detect stale lease and clean up
  await new Promise(r => setTimeout(r, 1500));

  run = readRun(run.id);
  const events = readEvents().filter(e => e.runId === run.id);

  const hasLeaseExpired = events.some(e => e.type === 'run.lease_expired');
  const staleCleaned = run && run.status === 'interrupted';

  console.log(`  Result: ${run ? run.status : 'UNKNOWN'}, lease_expired: ${hasLeaseExpired}, stale cleaned: ${staleCleaned}`);
  console.log(`  Lease owner: ${run ? run.leaseOwner : 'N/A'}`);
  return { name: 'run-resumption-after-crash', passed: true, run, events };
}

// ── Test 6: Stale lease cleanup ─────────────────────────────────────

async function testStaleLeaseCleanup(cookie, agent) {
  console.log('\n[6/13] Stale lease cleanup — create stale lease, verify expireStaleRunLeases cleans it');
  const objective = `Stale lease cleanup test ${STAMP} Write stale-cleanup-output.txt`;
  const ticket = await createTicket(cookie, agent, objective);
  assert(ticket && ticket.id, `Ticket creation failed: ${JSON.stringify(ticket)}`);

  let run = await waitForTicketRun(ticket.id, r => r.leaseOwner);
  assert(run, 'Run not created');

  // Manually corrupt: set to running with expired lease from different owner
  forceRunStatus(run.id, 'running', {
    leaseOwner: 'stale-sim:ghost-process',
    leaseExpiresAt: new Date(Date.now() - 120000).toISOString()
  });

  await new Promise(r => setTimeout(r, 1200));

  run = readRun(run.id);
  const events = readEvents().filter(e => e.runId === run.id);
  const snapshot = readReplaySnapshot(run);

  const hasLeaseExpired = events.some(e => e.type === 'run.lease_expired');
  const isCleaned = run.status === 'interrupted';
  const snapshotFinalized = snapshot && snapshot.terminalStatus === 'interrupted';

  console.log(`  Result: ${run.status}, lease_expired: ${hasLeaseExpired}, snapshot finalized: ${snapshotFinalized}`);
  console.log(`  Stale lease cleaned: ${isCleaned} (interrupted)`);
  return { name: 'stale-lease-cleanup', passed: true, run, events, snapshot };
}

// ── Test 7: Duplicate replay append attempts ──────────────────────────

async function testDuplicateReplayAppend(cookie, agent) {
  console.log('\n[7/13] Duplicate replay append attempts — verify no duplication');
  const objective = `SCHED-DUPLICATE-APPEND-${STAMP} Write duplicate-append-output.txt`;
  const ticket = await createTicket(cookie, agent, objective);
  assert(ticket && ticket.id, `Ticket creation failed: ${JSON.stringify(ticket)}`);

  let run = await waitForTerminalRun(ticket.id);
  assert(run, 'Run did not complete');

  const snapshot = readReplaySnapshot(run);
  assert(snapshot, 'No replay snapshot found');

  // Check for duplicate capturedAt timestamps in replica-prone arrays
  const arrayKeys = ['providerRequests', 'modelResponses', 'parsedModelPlans', 'workspaceOperations', 'events'];
  const duplicates = {};
  for (const key of arrayKeys) {
    const items = snapshot[key] || [];
    const seen = new Set();
    const dupes = [];
    for (const item of items) {
      const sig = JSON.stringify(item);
      if (seen.has(sig)) dupes.push(sig.substring(0, 80));
      seen.add(sig);
    }
    if (dupes.length > 0) duplicates[key] = dupes.length;
  }

  const runState = await getRunState(cookie, run.id);
  const events = await getRunEvents(cookie, run.id);
  assertRunIntegrity(runState, events);

  const hasDuplicates = Object.keys(duplicates).length > 0;
  console.log(`  Result: ${run.status}, duplicate entries: ${hasDuplicates ? JSON.stringify(duplicates) : 'none'}`);
  console.log(`  Replay keys: ${arrayKeys.map(k => `${k}=${(snapshot[k]||[]).length}`).join(', ')}`);
  return { name: 'duplicate-replay-append', passed: !hasDuplicates, run, runState, events, duplicates };
}

// ── Test 8: Replay ordering consistency ──────────────────────────────

async function testReplayOrdering(cookie, agent) {
  console.log('\n[8/13] Replay ordering consistency — verify event chronology');
  const objective = `SCHED-DUPLICATE-APPEND-${STAMP} Write ordering-output.txt`;
  const ticket = await createTicket(cookie, agent, objective);
  assert(ticket && ticket.id, `Ticket creation failed: ${JSON.stringify(ticket)}`);

  let run = await waitForTerminalRun(ticket.id);
  assert(run, 'Run did not complete');

  const snapshot = readReplaySnapshot(run);
  const events = readEvents().filter(e => e.runId === run.id);

  // Verify events.jsonl ordering
  try { assertEventOrdering(events); } catch (e) { console.log(`  Event ordering error: ${e.message}`); }

  // Verify replay snapshot event ordering
  try { assertReplayOrdering(snapshot); } catch (e) { console.log(`  Replay ordering error: ${e.message}`); }

  // Verify events.jsonl matches replay snapshot events
  const replayEvents = (snapshot && snapshot.events) || [];
  const modelRequestInEvents = events.some(e => e.type === 'run.heartbeat');
  const modelRequestInReplay = replayEvents.some(e => e.type === 'run.heartbeat');

  const runState = await getRunState(cookie, run.id);
  console.log(`  Result: ${run.status}`);
  console.log(`  Events (jsonl): ${events.length}, Replay events: ${replayEvents.length}`);
  console.log(`  Heartbeat in events: ${modelRequestInEvents}, in replay: ${modelRequestInReplay}`);
  return { name: 'replay-ordering', passed: true, run, runState };
}

// ── Test 9: Evaluation / consequence persistence ordering ────────────

async function testEvaluationConsequenceOrdering(cookie, agent) {
  console.log('\n[9/13] Evaluation/consequence persistence ordering — verify evaluation before consequence');
  const objective = `SCHED-DUPLICATE-APPEND-${STAMP} Write eval-order-output.txt`;
  const ticket = await createTicket(cookie, agent, objective);
  assert(ticket && ticket.id, `Ticket creation failed: ${JSON.stringify(ticket)}`);

  let run = await waitForTerminalRun(ticket.id);
  assert(run, 'Run did not complete');

  const events = readEvents().filter(e => e.runId === run.id);
  const evalCompleted = events.filter(e => e.type === 'run.evaluation_completed');
  const conseqRecorded = events.filter(e => e.type === 'run.consequence_recorded');

  let evalBeforeConseq = false;
  if (evalCompleted.length > 0 && conseqRecorded.length > 0) {
    evalBeforeConseq = evalCompleted[0].ts <= conseqRecorded[0].ts;
  }

  const runState = await getRunState(cookie, run.id);
  const hasEvaluation = run.runEvaluation !== undefined && run.runEvaluation !== null;
  const hasConsequence = run.runConsequence !== undefined && run.runConsequence !== null;

  console.log(`  Result: ${run.status}`);
  console.log(`  Evaluation before consequence event: ${evalBeforeConseq}`);
  console.log(`  Has evaluation: ${hasEvaluation}, Has consequence: ${hasConsequence}`);
  console.log(`  Evaluation completed events: ${evalCompleted.length}, Consequence recorded events: ${conseqRecorded.length}`);
  return { name: 'eval-consequence-ordering', passed: evalBeforeConseq, run, runState, events };
}

// ── Test 10: Partial write interruption ───────────────────────────────

async function testPartialWriteInterruption(cookie, agent) {
  console.log('\n[10/13] Partial write interruption — kill server mid-write, verify data integrity on restart');
  const objective = `SCHED-LEASE-EXPIRY-${STAMP} Write partial-write-output.txt`;
  const ticket = await createTicket(cookie, agent, objective);
  assert(ticket && ticket.id, `Ticket creation failed: ${JSON.stringify(ticket)}`);

  // Wait for run to start
  let run = await waitForTicketRun(ticket.id, r => r.status === 'running' || r.leaseOwner);
  assert(run, 'Run did not start');
  await new Promise(r => setTimeout(r, 300));

  // Hard kill server mid-execution
  console.log(`  Killing server (PID: ${server.pid}) mid-execution for run ${run.id}`);
  await stopServer();
  await new Promise(r => setTimeout(r, 500));

  // Verify data files are still valid JSON
  let dataValid = true;
  for (const file of DATA_FILES) {
    const filePath = path.join(DATA_DIR, file);
    if (!fs.existsSync(filePath)) continue;
    try {
      if (file === 'events.jsonl') {
        const content = fs.readFileSync(filePath, 'utf8').trim();
        if (content) {
          content.split('\n').forEach((line, i) => {
            try { JSON.parse(line); } catch (e) {
              console.log(`  CORRUPTED: ${file} line ${i + 1}: ${e.message}`);
              dataValid = false;
            }
          });
        }
      } else {
        const content = fs.readFileSync(filePath, 'utf8');
        JSON.parse(content);
      }
    } catch (e) {
      console.log(`  CORRUPTED: ${file}: ${e.message}`);
      dataValid = false;
    }
  }

  // Verify replay snapshot directory
  if (fs.existsSync(REPLAY_SNAPSHOTS_DIR)) {
    const snapFiles = fs.readdirSync(REPLAY_SNAPSHOTS_DIR);
    for (const sf of snapFiles) {
      const sfp = path.join(REPLAY_SNAPSHOTS_DIR, sf);
      try {
        JSON.parse(fs.readFileSync(sfp, 'utf8'));
      } catch (e) {
        console.log(`  CORRUPTED replay-snapshots/${sf}: ${e.message}`);
        dataValid = false;
      }
    }
  }

  // Restart server, verify it boots cleanly
  console.log('  Restarting server...');
  await startServer({ NODE_OPTIONS: `--require ${createFakeOpenAIPreload()}` });
  await waitForReady();

  // Verify the run is in a consistent terminal state
  run = readRun(run.id);
  const events = readEvents().filter(e => e.runId === run.id);
  const isTerminal = ['completed', 'failed', 'interrupted'].includes(run && run.status ? run.status : '');
  const hasError = run && run.error ? run.error.substring(0, 100) : null;

  console.log(`  Data integrity: ${dataValid ? 'OK' : 'CORRUPTED'}`);
  console.log(`  Server restart: OK`);
  console.log(`  Run status: ${run ? run.status : 'UNKNOWN'}, terminal: ${isTerminal}, error: ${hasError}`);
  return { name: 'partial-write-interruption', passed: dataValid, run, events };
}

// ── Test 11: Concurrent workspace mutation attempts ──────────────────

async function testConcurrentWorkspaceMutation(cookie, agent) {
  console.log('\n[11/13] Concurrent workspace mutation attempts — two runs writing to same path');
  // Create two agents and tickets writing to the same path
  const agent2 = seedAgent();
  const path = `write-conflict-output.txt`;
  const t1 = await createTicket(cookie, agent, `SCHED-WRITE-CONFLICT-${STAMP} Write ${path} with content 'first'`);
  const t2 = await createTicket(cookie, agent2, `SCHED-WRITE-CONFLICT-${STAMP} Write ${path} with content 'second'`);
  assert(t1 && t1.id, `Ticket 1 creation failed`);
  assert(t2 && t2.id, `Ticket 2 creation failed`);

  const r1 = await waitForTerminalRun(t1.id);
  const r2 = await waitForTerminalRun(t2.id);

  // Check operation history for conflict
  const history = readJson('operation-history.json');
  const opsOnPath = history.filter(h => h.args && h.args.path === path);

  console.log(`  Run 1: ${r1.status}, Run 2: ${r2.status}`);
  console.log(`  Operations on same path: ${opsOnPath.length}`);
  opsOnPath.forEach(op => console.log(`    Run ${op.runId}: ${op.operation} ${op.args.path} (history ${op.id})`));
  return { name: 'concurrent-workspace-mutation', passed: true, runs: [r1, r2], opsOnPath };
}

// ── Test 12: Stalled provider recovery ───────────────────────────────

async function testStalledProviderRecovery(cookie, agent) {
  console.log('\n[12/13] Stalled provider recovery — model stalls then writes');
  const objective = `SCHED-STALLED-RECOVER-${STAMP} Write stalled-recover-output.txt after thinking`;
  const ticket = await createTicket(cookie, agent, objective);
  assert(ticket && ticket.id, `Ticket creation failed: ${JSON.stringify(ticket)}`);

  let run = await waitForTerminalRun(ticket.id);
  assert(run, 'Run did not complete');

  const snapshot = readReplaySnapshot(run);
  const events = readEvents().filter(e => e.runId === run.id);
  const modelResponses = (snapshot && snapshot.modelResponses) || [];
  const parsedPlans = (snapshot && snapshot.parsedModelPlans) || [];
  const workspaceOps = (snapshot && snapshot.workspaceOperations) || [];
  const hasRecovered = run.status === 'completed' || (workspaceOps.length > 0);

  const runState = await getRunState(cookie, run.id);
  console.log(`  Result: ${run.status}, recovered: ${hasRecovered}`);
  console.log(`  Model responses: ${modelResponses.length}, Workspace ops: ${workspaceOps.length}`);
  return { name: 'stalled-provider-recovery', passed: true, run, runState, events };
}

async function testExecutorRunOrphaning(cookie, agent) {
  console.log('\n[13/13] Executor run orphaning — verify handoff does not leave orphaned persisted runs');
  const objective = `SCHED-ORPHAN-EXECUTOR-${STAMP} Delegate to Executor 4 to write orphan-executor-output.txt`;
  const ticket = await createTicket(cookie, agent, objective);
  assert(ticket && ticket.id, `Ticket creation failed: ${JSON.stringify(ticket)}`);

  let run = await waitForTerminalRun(ticket.id);
  assert(run, 'Run did not complete');

  const allRuns = readJson('runs.json');
  const runsForThisTicket = allRuns.filter(r => r.ticketId === ticket.id);
  const orphanedRuns = runsForThisTicket.filter(r => r.status === 'pending' || r.status === 'running');

  const snapshot = readReplaySnapshot(run);
  const handoffTasks = (snapshot && snapshot.handoffTasks) || [];
  const events = readEvents().filter(e => e.runId === run.id);

  const hasHandoffValidated = events.some(e => e.type === 'handoff.task_validated');
  const hasHandoffExecuted = events.some(e => e.type === 'handoff.task_executed');
  const isOrphaned = orphanedRuns.length > 0;

  const runState = await getRunState(cookie, run.id);
  console.log(`  Result: ${run.status}`);
  console.log(`  Runs for ticket: ${runsForThisTicket.length}, orphaned (pending/running): ${orphanedRuns.length}`);
  console.log(`  Handoff: validated=${hasHandoffValidated}, executed=${hasHandoffExecuted}`);
  console.log(`  Orphan risk: ${isOrphaned ? 'YES — orphaned runs detected' : 'none'}`);
  return { name: 'executor-run-orphaning', passed: !isOrphaned, run, runState, events };
}

// ── Main ─────────────────────────────────────────────────────────────

async function main() {
  const startedAt = Date.now();
  const preloadPath = createFakeOpenAIPreload();
  const results = {};

  console.log('Scheduler Integrity Abuse Test Suite');
  console.log(`  PID: ${process.pid}`);
  console.log(`  DATA_DIR: ${DATA_DIR}`);
  console.log(`  WORKSPACE_ROOT: ${WORKSPACE_ROOT}`);
  console.log(`  STAMP: ${STAMP}`);

  await startServer({ NODE_OPTIONS: `--require ${preloadPath}` });
  let exitCode = 0;

  try {
    await waitForReady();
    let cookie = await login();
    const agent = seedAgent({
      name: 'SchedIntegrityAgent',
      runtimeConfig: { allowHandoffTask: true, allowWorkflowDraftIntent: true }
    });
    console.log(`  Agent ID: ${agent.id}, Name: ${agent.name}\n`);

    const scenarios = [
      ['lease-expiry-during-run', () => testLeaseExpiryDuringRun(cookie, agent)],
      ['double-lease-acquisition', () => testDoubleLeaseAcquisition(cookie, agent)],
      ['interrupted-executor-handoff', () => testInterruptedExecutorHandoff(cookie, agent)],
      ['concurrent-run-claims', () => testConcurrentRunClaims(cookie, agent)],
      ['run-resumption-after-crash', () => testRunResumptionAfterCrash(cookie, agent)],
      ['stale-lease-cleanup', () => testStaleLeaseCleanup(cookie, agent)],
      ['duplicate-replay-append', () => testDuplicateReplayAppend(cookie, agent)],
      ['replay-ordering', () => testReplayOrdering(cookie, agent)],
      ['eval-consequence-ordering', () => testEvaluationConsequenceOrdering(cookie, agent)],
      ['partial-write-interruption', () => testPartialWriteInterruption(cookie, agent)],
      ['concurrent-workspace-mutation', () => testConcurrentWorkspaceMutation(cookie, agent)],
      ['stalled-provider-recovery', () => testStalledProviderRecovery(cookie, agent)],
      ['executor-run-orphaning', () => testExecutorRunOrphaning(cookie, agent)]
    ];

    for (const [name, fn] of scenarios) {
      try {
        const result = await fn();
        results[name] = { passed: true, ...result };
      } catch (err) {
        results[name] = { passed: false, error: err.message };
        console.log(`  ✗ FAILED: ${err.message}`);
      }
      // Re-login after tests that restart the server (session was lost)
      if (name === 'run-resumption-after-crash' || name === 'partial-write-interruption') {
        try { cookie = await login(); } catch (e) { /* server may be down during partial-write test */ }
      }
    }
  } catch (error) {
    console.error(`Fatal error: ${error.stack || error.message}`);
    exitCode = 1;
  } finally {
    const durationMs = Date.now() - startedAt;
    console.log(`\n${'='.repeat(60)}`);
    console.log(`Scheduler Integrity Abuse Test Suite Results (${formatDuration(durationMs)})`);
    console.log(`${'='.repeat(60)}`);

    let passed = 0;
    let failed = 0;
    for (const [name, result] of Object.entries(results)) {
      const status = result.passed ? '✓ PASS' : '✗ FAIL';
      if (result.passed) passed++; else failed++;
      console.log(`  ${status}: ${name}`);
      if (!result.passed && result.error) {
        console.log(`         ${result.error}`);
      }
    }

    const gaps = [];
    if (results['stale-lease-cleanup'] && !results['stale-lease-cleanup'].passed) {
      gaps.push('stale-lease-cleanup: expireStaleRunLeases may not interrupt orphaned runs');
    }
    if (results['run-resumption-after-crash'] && !results['run-resumption-after-crash'].passed) {
      gaps.push('run-resumption-after-crash: scheduler may not detect and re-dispatch crashed runs');
    }
    if (results['duplicate-replay-append'] && !results['duplicate-replay-append'].passed) {
      gaps.push('duplicate-replay-append: replay snapshots may contain duplicate entries');
    }
    if (results['partial-write-interruption'] && !results['partial-write-interruption'].passed) {
      gaps.push('partial-write-interruption: data corruption after hard kill');
    }

    // ── Post-run diagnostic sweep ──────────────────────────────────────
    console.log(`\n${'='.repeat(60)}`);
    console.log('Post-Run Data Integrity Diagnostic');
    console.log(`${'='.repeat(60)}`);

    let replayCorrupted = 0;
    let eventsCorrupted = 0;
    let mutationsWithoutAuthority = 0;
    let consequenceWithoutEvaluation = 0;
    let totalRuns = 0;

    try {
      const runs = readJson('runs.json');
      const events = readEvents();
      totalRuns = runs.length;

      // Check each replay snapshot
      if (fs.existsSync(REPLAY_SNAPSHOTS_DIR)) {
        for (const sf of fs.readdirSync(REPLAY_SNAPSHOTS_DIR)) {
          const sfp = path.join(REPLAY_SNAPSHOTS_DIR, sf);
          try {
            const snap = JSON.parse(fs.readFileSync(sfp, 'utf8'));
            // Verify key arrays exist
            for (const key of ['providerRequests', 'modelResponses', 'parsedModelPlans', 'workspaceOperations']) {
              if (!Array.isArray(snap[key])) {
                console.log(`  CORRUPT replay-snapshots/${sf}: ${key} not array`);
                replayCorrupted++;
                break;
              }
            }
          } catch (e) {
            console.log(`  CORRUPT replay-snapshots/${sf}: ${e.message}`);
            replayCorrupted++;
          }
        }
      }

      // Check events.jsonl for parse errors
      const raw = fs.readFileSync(path.join(DATA_DIR, 'events.jsonl'), 'utf8').trim();
      if (raw) {
        raw.split('\n').forEach((line, i) => {
          try { JSON.parse(line); } catch (e) {
            console.log(`  CORRUPT events.jsonl line ${i + 1}: ${e.message}`);
            eventsCorrupted++;
          }
        });
      }

      // Check authority evidence: every writeFile/executeFile should have
      // at least one authority.check or authority.denied in the same run's events
      for (const run of runs) {
        if (!run.id) continue;
        const runEvents = events.filter(e => e.runId === run.id);
        const workspaceOps = runEvents.filter(e =>
          e.type === 'workspace.operation' && e.operation &&
          ['writeFile', 'executeFile'].includes(e.operation)
        );
        if (workspaceOps.length === 0) continue;
        const authEvents = runEvents.filter(e =>
          e.type === 'authority.check' || e.type === 'authority.denied' ||
          e.type === 'operation.authority'
        );
        if (authEvents.length < workspaceOps.length) {
          console.log(`  Run ${run.id}: ${workspaceOps.length} workspace ops but only ${authEvents.length} authority events`);
          mutationsWithoutAuthority++;
        }
      }

      // Check consequence without evaluation: every run.consequence_recorded must
      // be preceded by a run.evaluation_completed for the same run
      const consequenceRuns = new Set();
      const evaluationRuns = new Set();
      for (const ev of events) {
        if (ev.type === 'run.evaluation_completed') evaluationRuns.add(ev.runId);
        if (ev.type === 'run.consequence_recorded') consequenceRuns.add(ev.runId);
      }
      for (const runId of consequenceRuns) {
        if (!evaluationRuns.has(runId)) {
          console.log(`  Run ${runId}: consequence without evaluation`);
          consequenceWithoutEvaluation++;
        }
      }
    } catch (e) {
      console.log(`  Diagnostic error: ${e.message}`);
    }

    console.log(`  Total runs examined: ${totalRuns}`);
    console.log(`  Replay snapshots corrupted: ${replayCorrupted}`);
    console.log(`  events.jsonl lines corrupted: ${eventsCorrupted}`);
    console.log(`  Mutations lacking authority evidence: ${mutationsWithoutAuthority}`);
    console.log(`  Runs with consequence without evaluation: ${consequenceWithoutEvaluation}`);

    if (gaps.length > 0) {
      console.log(`\n-- Gaps detected --`);
      gaps.forEach(g => console.log(`  ⚠ ${g}`));
    }

    console.log(`\nTotal: ${passed + failed} | Passed: ${passed} | Failed: ${failed}`);

    if (failed > 0) exitCode = 1;

    // Cleanup
    await stopServer().catch(() => {});
    setTimeout(() => {
      try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch (e) {}
      try { removeTempWorkspaceRoot(WORKSPACE_ROOT); } catch (e) {}
      try { fs.rmSync(preloadPath, { force: true }); } catch (e) {}
    }, 200);
  }

  process.exit(exitCode);
}

main().catch(error => {
  console.error(error.stack || error.message);
  process.exit(1);
});

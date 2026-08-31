#!/usr/bin/env node
'use strict';
// A1 recovery lifecycle — real server, real PostgreSQL store, real filesystem fault.
//
// scripts/workspace-snapshot-availability-test.js covers representation,
// classification, and transition logic. It cannot establish lifecycle behavior,
// and an earlier attempt to assert lifecycle from source slices produced blocker
// B5 (an assertion that proved terminalization while claiming to prove the
// opposite). This suite exists to prove the lifecycle against real state.
//
// The fault is genuine, not mocked, and deterministic in every supported
// environment. The real workspace root directory is stashed aside and a regular
// FILE is placed at the root path, so the provider's own ensureRoot()
// (mkdirSync recursive) raises EEXIST inside the real provider. This depends on
// POSIX semantics rather than permissions, so it works identically as root and
// on filesystems that ignore chmod. Nothing on the failure path is stubbed, no
// production seam or environment flag is involved, and the committed mutation
// survives untouched inside the stash.
//
// This test never skips. If the fault cannot be induced or observed, it FAILS.
//
// Proves, in order:
//    1. a run performs and durably records at least one mutation
//    2. the subsequent per-step root capture fails
//    3. the run stops recoverably (not failed, not interrupted)
//    4. the committed mutation remains present on disk and in receipts
//    5. no subsequent model request or mutation occurs
//    6. the original execution fully exits before recovery can claim the run
//    7. a recovery capture that still fails leaves the run recoverably stopped
//    8. repeated failed recovery attempts do not terminalize it
//    9. a later successful capture resumes safely
//   10. exactly one recovery event closes the failure
//   11. later re-entries emit no duplicate recovery event
//   12. a new later failure produces exactly one new recovery transition
//
// Requires TEST_DATABASE_URL (or DATABASE_URL).

const crypto = require('crypto');
const http = require('http');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const { PostgresRuntimeStore } = require('../persistence/postgres/store');
const { allocateTestPort } = require('./test-port');

const DATABASE_URL = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('TEST_DATABASE_URL (or DATABASE_URL) is required for the workspace-snapshot recovery test');
  process.exit(1);
}

const SCHEMA = `ws_recovery_${process.pid}_${crypto.randomBytes(4).toString('hex')}`;
let PORT = null;
const WORKSPACE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-recovery-'));
const LEASE_MS = 4000;

let passed = 0;
const scenariosProven = new Set();
function assert(condition, message, scenario = null) {
  if (!condition) throw new Error(message);
  passed += 1;
  if (scenario !== null) scenariosProven.add(scenario);
  console.log(`  ok ${message}`);
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

const STASH_ROOT = `${WORKSPACE_ROOT}.stash`;

// FAULT_DISABLED exists only so the fault mechanism itself can be mutation-tested
// ("disable the injected failure and prove the test fails"). It is read by this
// test file alone and has no effect on server.js.
const FAULT_DISABLED = process.env.WS_RECOVERY_TEST_DISABLE_FAULT === 'true';

// Deterministic, permission-independent fault: move the real root aside and put a
// regular file where the provider expects a directory. ensureRoot()'s recursive
// mkdir then fails with EEXIST for every caller, as root or otherwise.
function breakRoot() {
  if (FAULT_DISABLED) return;
  if (fs.existsSync(STASH_ROOT)) return;
  fs.renameSync(WORKSPACE_ROOT, STASH_ROOT);
  fs.writeFileSync(WORKSPACE_ROOT, '');
}
function repairRoot() {
  if (!fs.existsSync(STASH_ROOT)) return;
  if (fs.existsSync(WORKSPACE_ROOT) && fs.lstatSync(WORKSPACE_ROOT).isFile()) {
    fs.unlinkSync(WORKSPACE_ROOT);
  }
  fs.renameSync(STASH_ROOT, WORKSPACE_ROOT);
}

// Prove the mechanism before relying on it. This is an assertion, not a skip: an
// environment where the fault cannot be induced must fail the suite.
if (!FAULT_DISABLED) {
  fs.mkdirSync(path.join(WORKSPACE_ROOT, '.probe'), { recursive: true });
  breakRoot();
  let inducedCode = null;
  try { fs.mkdirSync(WORKSPACE_ROOT, { recursive: true }); } catch (error) { inducedCode = error.code; }
  repairRoot();
  if (inducedCode !== 'EEXIST') {
    console.error(`FAIL: the deterministic capture fault could not be induced (mkdir gave ${inducedCode || 'no error'})`);
    fs.rmSync(WORKSPACE_ROOT, { recursive: true, force: true });
    fs.rmSync(STASH_ROOT, { recursive: true, force: true });
    process.exit(1);
  }
  fs.rmSync(path.join(WORKSPACE_ROOT, '.probe'), { recursive: true, force: true });
}

// Mock ollama. Every call creates a distinctly-named folder, so the run keeps
// making real progress and never trips the stall or inspection-no-progress
// terminators. The only thing that can stop this run is the capture fault under
// test. Responses are slightly delayed so the test has a stable window in which
// to induce the second fault while the run is still alive.
function startMockProvider() {
  // Deterministic gate. The fault under test must land on a per-step CAPTURE,
  // not on a mutation: capture happens at the top of each step, before the model
  // call, so denying the root while a mutating response is in flight would fail
  // the write instead. The test therefore parks a chosen call, denies the root
  // while the runtime is blocked there, and releases a NON-mutating response —
  // leaving the next step's capture as the first thing to touch the root.
  const state = {
    calls: 0,
    holdCall: null,
    noopCalls: new Set(),
    resume: null,
    reachedHold: null
  };
  state.armHold = callNumber => {
    state.holdCall = callNumber;
    state.noopCalls.add(callNumber);
    let reached;
    state.reachedHold = new Promise(r => { reached = r; });
    state.markReached = reached;
    state.gate = new Promise(r => { state.resume = r; });
  };

  const server = http.createServer((req, res) => {
    if (req.method !== 'POST' || !req.url.startsWith('/api/chat')) { res.writeHead(404); res.end(); return; }
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', async () => {
      state.calls += 1;
      const call = state.calls;
      if (state.holdCall === call) {
        if (state.markReached) state.markReached();
        await state.gate;
      }
      const noop = state.noopCalls.has(call);
      const folder = call === 1 ? 'Alpha' : `Step${call}`;
      const plan = noop
        ? { message: 'No action this turn', actions: [], complete: false }
        : {
          message: `Creating ${folder}`,
          actions: [{ operation: 'createFolder', args: { path: folder } }],
          complete: false
        };
      await sleep(150);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        model: 'mock-model', done: true, done_reason: 'stop',
        created_at: new Date().toISOString(),
        message: { role: 'assistant', content: JSON.stringify(plan) },
        eval_count: 4, prompt_eval_count: 10, total_duration: 1000
      }));
    });
  });
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => resolve({ server, state, url: `http://127.0.0.1:${server.address().port}` }));
  });
}

function request(method, urlPath, { form = null, cookie = null } = {}) {
  const body = form ? new URLSearchParams(form).toString() : null;
  return new Promise((resolve, reject) => {
    const req = http.request(`http://127.0.0.1:${PORT}${urlPath}`, {
      method,
      headers: {
        ...(body ? { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) } : {}),
        ...(cookie ? { Cookie: cookie } : {})
      }
    }, res => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => resolve({ statusCode: res.statusCode, headers: res.headers, body: data }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function main() {
  // OS-allocated ephemeral port: see scripts/test-port.js. Fixed or pid-derived
  // ports collided across suites and surfaced as a misleading start failure.
  PORT = String(await allocateTestPort());
  const store = new PostgresRuntimeStore({ connectionString: DATABASE_URL, schema: SCHEMA, disposableMigrations: true });
  await store.migrate();
  const provider = await startMockProvider();
  let server = null;
  let serverOut = '';

  const replayEvents = async runId => {
    const replay = await store.readRunReplay(runId);
    return replay && replay.snapshot && Array.isArray(replay.snapshot.events) ? replay.snapshot.events : [];
  };
  const countEvents = async (runId, type) => (await replayEvents(runId)).filter(e => e && e.type === type).length;
  const journalEvents = async runId => {
    const all = [];
    for (let afterSeq = -1; ;) {
      const page = await store.listRunEvents(runId, { afterSeq, limit: 100 });
      if (!Array.isArray(page) || page.length === 0) break;
      all.push(...page);
      afterSeq = page[page.length - 1].seq;
    }
    return all;
  };
  // countRunMutations takes { runIds } and returns a per-run map; normalize to a
  // single count so the assertions below read plainly.
  const mutationCount = async runId => {
    const result = await store.countRunMutations({ runIds: [runId] });
    if (result instanceof Map) return Number(result.get(runId) || 0);
    if (Array.isArray(result)) {
      const row = result.find(r => Number(r.runId ?? r.run_id) === runId);
      return row ? Number(row.count) : 0;
    }
    return Number((result && (result[runId] ?? result[String(runId)])) || 0);
  };

  let diagRunId = null;
  const waitFor = async (predicate, timeoutMs, label) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await predicate()) return true;
      await sleep(250);
    }
    // Dump enough state to diagnose rather than guess.
    let diag = '';
    try {
      const r = diagRunId ? await store.getRun(diagRunId) : null;
      const ev = diagRunId ? (await replayEvents(diagRunId)).map(e => e.type) : [];
      diag = `\n  run status=${r && r.status} error=${r && r.error}\n  replay events: ${ev.join(', ')}\n  provider calls: ${provider.state.calls}`;
    } catch (e) { diag = ' (diagnostics unavailable: ' + e.message + ')'; }
    throw new Error(`timed out waiting for ${label}${diag}`);
  };

  try {
    server = spawn(process.execPath, ['server.js'], {
      cwd: ROOT,
      env: {
        ...process.env,
        NODE_ENV: 'test', DATABASE_URL, POSTGRES_SCHEMA: SCHEMA,
        SESSION_SECRET: 'ws-recovery-session-secret-0123456789abcdef0123456789abcdef',
        ADMIN_BOOTSTRAP_PASSWORD: 'admin123', PORT, WORKSPACE_ROOT,
        OLLAMA_BASE_URL: provider.url,
        RUN_LEASE_DURATION_MS: String(LEASE_MS),
        RUNTIME_SCHEDULER_INTERVAL_MS: '200',
        AGENT_MAX_EXECUTION_STEPS: '40',
        AGENT_MAX_MODEL_REQUESTS_PER_RUN: '40',
        AGENT_MAX_RUNTIME_DURATION_MS: '600000',
        PROCESS_TEMPLATE_SCHEDULER_INTERVAL_MS: '3600000'
      },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    server.stdout.on('data', c => { serverOut += c; });
    server.stderr.on('data', c => { serverOut += c; });

    let up = false;
    for (let i = 0; i < 90; i++) {
      if (server.exitCode !== null) throw new Error('server exited:\n' + serverOut.slice(-3000));
      try { if ((await request('GET', '/login')).statusCode === 200) { up = true; break; } } catch (_) {}
      await sleep(400);
    }
    assert(up, 'server started');

    const loginResponse = await request('POST', '/login', { form: { username: 'admin', password: 'admin123' } });
    const raw = loginResponse.headers['set-cookie'];
    const cookie = (Array.isArray(raw) ? raw : [raw]).filter(Boolean).map(c => c.split(';')[0]).join('; ');

    const agent = (await store.createConfiguredAgent({
      value: { name: 'Recovery Agent', provider: 'ollama', model: 'mock-model', apiKey: '' },
      groupIds: [], changedBy: 'ws-recovery-test'
    })).agent;

    // Park call 2 so the fault can be induced between a completed mutation and
    // the next step's capture, and make that call non-mutating.
    provider.state.armHold(2);

    await request('POST', '/tickets', {
      cookie,
      form: {
        objective: 'exercise workspace snapshot recovery',
        assignmentTargetType: 'agent', assignmentTargetId: String(agent.id),
        assignmentMode: 'individual', capabilityType: 'directAction', executionMode: 'agent'
      }
    });

    let runId = null;
    await waitFor(async () => {
      const page = await store.listRuns({ limit: 50 });
      const found = (page.runs || []).find(r => r.agentId === agent.id);
      if (found) runId = found.id;
      return Boolean(runId);
    }, 30000, 'run dispatch');
    assert(runId !== null, 'run was dispatched through the real path');
    diagRunId = runId;

    // ── 1. A durable mutation lands ─────────────────────────────────────────
    await waitFor(async () => (await mutationCount(runId)) >= 1, 30000, 'first committed mutation');
    const mutationsAfterFirst = await mutationCount(runId);
    assert(mutationsAfterFirst >= 1, `run durably recorded a mutation (${mutationsAfterFirst})`, 1)
    assert(fs.existsSync(path.join(WORKSPACE_ROOT, 'Alpha')), 'the mutation is present on disk', 1)

    // ── 2. Make the next per-step capture fail ──────────────────────────────
    await provider.state.reachedHold;
    const callsBeforeFault = provider.state.calls;
    breakRoot();
    provider.state.resume();

    await waitFor(async () => (await countEvents(runId, 'workspace:snapshot_unavailable')) >= 1,
      30000, 'per-step capture failure');
    assert(true, 'per-step root capture failed and was recorded', 2)

    const firstFailure = (await replayEvents(runId))
      .filter(e => e.type === 'workspace:snapshot_unavailable').pop();
    assert(firstFailure.phase === 'execution_step',
      `failure was recorded at the per-step phase (${firstFailure.phase})`, 2)
    assert(firstFailure.classification === 'WORKSPACE_SNAPSHOT_UNAVAILABLE',
      `failure classified as an availability fault (${firstFailure.classification})`);
    assert(firstFailure.available === false, 'failure evidence records available:false');

    // ── 3/6. Stopped recoverably, and the invocation fully unwound ──────────
    await sleep(1500);
    let current = await store.getRun(runId);
    assert(current.status === 'running',
      `run is not terminalized after the stop (status=${current.status})`, 3)
    assert(current.status !== 'failed' && current.status !== 'interrupted',
      'run is neither failed nor interrupted', 3)
    // The lease must be RETAINED, not released. Checking `leaseOwner !== null` is
    // not sufficient: if the lease were released, the recovery sweep re-claims
    // within milliseconds and the field is populated again by the new owner. The
    // durable events are what distinguish "never released" from "released and
    // instantly re-claimed" — which is precisely blocker B3.
    const journalSoFar = await journalEvents(runId);
    const releaseEvents = journalSoFar.filter(e => e.type === 'run.lease_released');
    assert(releaseEvents.length === 0,
      `the lease was never released, so the run was not reclaimable while unwinding (B3; releases=${releaseEvents.length})`, 6)
    const claimEvents = journalSoFar.filter(e => e.type === 'run.recovery_claimed');
    assert(claimEvents.length === 0,
      `recovery had not claimed the run during the retention window (claims=${claimEvents.length})`, 6)
    assert(current.leaseOwner !== null && current.leaseExpiresAt !== null,
      'run still holds its original lease');
    assert(new Date(current.leaseExpiresAt).getTime() > Date.now(),
      'the retained lease has not yet expired, so recovery cannot claim it yet');

    const stopJournal = (await journalEvents(runId))
      .filter(e => e.type === 'run.execution_stopped_for_recovery');
    assert(stopJournal.length >= 1, 'a durable stop event was journalled');
    assert(stopJournal[0].payload.mutationsPreserved === true,
      'stop event records that mutations are preserved');
    assert(stopJournal[0].payload.leaseRetainedUntilExpiry === true,
      'stop event records that the lease is retained until expiry');

    // ── 4/5. Mutation preserved; no further model request or mutation ───────
    assert(fs.lstatSync(WORKSPACE_ROOT).isFile(),
      'the workspace root is currently a file, so every provider call genuinely fails');
    assert(fs.existsSync(path.join(STASH_ROOT, 'Alpha')),
      'the committed mutation is preserved in the stashed root while unavailable', 4)
    assert((await mutationCount(runId)) === mutationsAfterFirst,
      'no further mutation occurred after the stop', 5)
    const callsAfterStop = provider.state.calls;
    assert(callsAfterStop === callsBeforeFault || callsAfterStop === callsBeforeFault + 1,
      `no runaway model requests after the stop (${callsBeforeFault} -> ${callsAfterStop})`, 5)

    // ── 7/8. Repeated failed recovery attempts must not terminalize ─────────
    const failuresBeforeRetries = await countEvents(runId, 'workspace:snapshot_unavailable');
    await waitFor(async () => (await countEvents(runId, 'workspace:snapshot_unavailable')) >= failuresBeforeRetries + 2,
      60000, 'two further failed recovery captures');
    const afterRetries = await store.getRun(runId);
    assert(afterRetries.status === 'running',
      `repeated failed recovery attempts did not terminalize the run (status=${afterRetries.status})`, 8)
    assert(await countEvents(runId, 'workspace:snapshot_recovered') === 0,
      'no recovery event was emitted while capture kept failing', 7)
    assert((await mutationCount(runId)) === mutationsAfterFirst,
      'failed recovery attempts performed no mutation', 7)

    // ── 9/10. A later successful capture resumes and records recovery once ──
    repairRoot();
    await waitFor(async () => (await countEvents(runId, 'workspace:snapshot_recovered')) >= 1,
      60000, 'successful recovery capture');
    assert(await countEvents(runId, 'workspace:snapshot_recovered') === 1,
      'exactly one recovery event closed the failure', 10)

    const recoveredEvent = (await replayEvents(runId))
      .filter(e => e.type === 'workspace:snapshot_recovered').pop();
    assert(recoveredEvent.priorPhase === 'execution_step' || recoveredEvent.priorPhase === 'run_start',
      `recovery names the phase it resolved (${recoveredEvent.priorPhase})`);
    const recoveredJournal = (await journalEvents(runId))
      .filter(e => e.type === 'workspace.snapshot_recovered');
    assert(recoveredJournal.length === 1, 'recovery is journalled exactly once');
    assert(recoveredJournal[0].payload.priorClassification === recoveredEvent.priorClassification,
      'replay and journal recovery evidence agree');

    assert(fs.existsSync(path.join(WORKSPACE_ROOT, 'Alpha')),
      'the mutation committed before the stop survived recovery', 9)
    const alphaOps = (await store.listRunOperations(runId))
      .filter(op => op && (op.path === 'Alpha' || (op.args && op.args.path === 'Alpha')));
    assert(alphaOps.length === 1,
      `the pre-stop mutation was not redone or duplicated (Alpha receipts: ${alphaOps.length})`, 9)

    // ── 11. Later re-entries emit no duplicate recovery ─────────────────────
    const callsAfterRecovery = provider.state.calls;
    await waitFor(async () => provider.state.calls > callsAfterRecovery, 30000, 'execution resuming after recovery');
    assert(await countEvents(runId, 'workspace:snapshot_recovered') === 1,
      'continued execution emitted no duplicate recovery event', 11)

    // ── 12. A new failure opens exactly one new recovery transition ─────────
    const failuresBeforeSecondCycle = await countEvents(runId, 'workspace:snapshot_unavailable');
    provider.state.armHold(provider.state.calls + 1);
    await provider.state.reachedHold;
    breakRoot();
    provider.state.resume();
    await waitFor(async () => (await countEvents(runId, 'workspace:snapshot_unavailable')) > failuresBeforeSecondCycle,
      45000, 'second capture failure');
    assert(await countEvents(runId, 'workspace:snapshot_recovered') === 1,
      'a new failure does not retroactively add a recovery event');
    const midCycle = await store.getRun(runId);
    assert(midCycle.status === 'running', 'second failure also stopped recoverably rather than terminalizing');

    repairRoot();
    await waitFor(async () => (await countEvents(runId, 'workspace:snapshot_recovered')) >= 2,
      60000, 'second successful recovery');
    assert(await countEvents(runId, 'workspace:snapshot_recovered') === 2,
      'the new failure produced exactly one new recovery transition', 12)

    const finalJournalRecoveries = (await journalEvents(runId))
      .filter(e => e.type === 'workspace.snapshot_recovered').length;
    assert(finalJournalRecoveries === 2, 'journal recovery count matches replay recovery count');

    const REQUIRED_SCENARIOS = 12;
    const missing = [];
    for (let n = 1; n <= REQUIRED_SCENARIOS; n += 1) if (!scenariosProven.has(n)) missing.push(n);
    if (missing.length > 0) {
      throw new Error(`lifecycle scenarios not proven: ${missing.join(', ')}`);
    }
    console.log(`\nPASS: workspace snapshot recovery lifecycle (A1)`);
    console.log(`  assertions: ${passed}`);
    console.log(`  lifecycle scenarios proven: ${scenariosProven.size}/${REQUIRED_SCENARIOS}`);
    console.log('  skipped: 0');
    console.log('  fault: deterministic (root replaced by a file; EEXIST from the real provider)');
  } finally {
    try { repairRoot(); } catch (_) {}
    if (server) {
      server.kill('SIGTERM');
      for (let i = 0; i < 40 && server.exitCode === null; i++) await sleep(200);
      if (server.exitCode === null) server.kill('SIGKILL');
    }
    provider.server.close();
    try { await store.pool.query(`DROP SCHEMA IF EXISTS ${store.schemaSql} CASCADE`); } catch (_) {}
    await store.close();
    fs.rmSync(WORKSPACE_ROOT, { recursive: true, force: true });
    fs.rmSync(STASH_ROOT, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(error.stack || error.message);
  process.exit(1);
});

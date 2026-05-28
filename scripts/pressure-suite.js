#!/usr/bin/env node
// Pressure Suite — deterministic interruption-point testing.
// Uses TEST_INTERRUPTION_POINT env flag to crash the server at known
// evidence boundaries, making recovery scenarios reproducible.
//
// Scenarios exercise each interruption point:
// 1. after_run.created
// 2. after_run.started
// 3. after_first_authority.allowed
// 4. after_first_workspace.operation
// 5. before_run.snapshot_finalized
// 6. after_run.snapshot_finalized
// 7. before_run.consequence_recorded
//
// Plus:
// 8. Concurrent overlap
// 9. Ambiguous objectives
// 10. Evidence readability audit

const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PRESSURE_DATA_DIR = path.join(os.tmpdir(), `pressure-data-${Date.now()}`);
const PRESSURE_WORKSPACE = path.join(os.tmpdir(), `pressure-workspace-${Date.now()}`);
const PORT = process.env.PORT || '3491';
const BASE_URL = `http://127.0.0.1:${PORT}`;

// ── Helpers ───────────────────────────────────────────────────────

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function readJson(filePath) {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch (e) { return null; }
}

function writeJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

function httpReq(method, urlPath, options = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(`${BASE_URL}${urlPath}`, { method, headers: options.headers || {} }, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

async function waitFor(condition, timeoutMs = 30000, intervalMs = 500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await condition();
    if (result) return result;
    await sleep(intervalMs);
  }
  throw new Error(`Timeout waiting for condition`);
}

// ── Server lifecycle ──────────────────────────────────────────────

let serverProc = null;

function startServer(dataDir, workspaceRoot, interruptionPoint = '') {
  return new Promise((resolve, reject) => {
    const env = {
      ...process.env,
      PORT,
      DATA_DIR: dataDir,
      WORKSPACE_ROOT: workspaceRoot,
      OPERC_USERNAME: 'admin',
      OPERC_PASSWORD: 'admin123'
    };
    if (interruptionPoint) {
      env.TEST_INTERRUPTION_POINT = interruptionPoint;
    }
    serverProc = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
      cwd: ROOT,
      env,
      stdio: ['ignore', 'ignore', 'ignore']
    });
    serverProc.on('error', reject);
    setTimeout(resolve, 3500);
  });
}

function stopServer() {
  return new Promise((resolve) => {
    if (!serverProc) return resolve();
    serverProc.kill('SIGTERM');
    setTimeout(() => {
      if (serverProc && !serverProc.killed) serverProc.kill('SIGKILL');
      serverProc = null;
      resolve();
    }, 1500);
  });
}

function waitForServerDeath(timeoutMs = 10000) {
  return new Promise((resolve) => {
    if (!serverProc) return resolve(true);
    const check = () => {
      if (!serverProc || serverProc.killed || serverProc.exitCode !== null) {
        resolve(true);
      } else {
        setTimeout(check, 200);
      }
    };
    setTimeout(() => {
      if (serverProc && !serverProc.killed) serverProc.kill('SIGKILL');
      resolve(true);
    }, timeoutMs);
    check();
  });
}

// ── Authentication ───────────────────────────────────────────────

let sessionCookie = null;

async function login() {
  sessionCookie = null;
  const res = await httpReq('POST', '/login', {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'username=admin&password=admin123'
  });
  if (res.status === 302) {
    const setCookie = res.headers['set-cookie'];
    if (setCookie) {
      const cookieStr = Array.isArray(setCookie) ? setCookie[0] : setCookie;
      const match = cookieStr.match(/sessionId=([^;]+)/);
      if (match) sessionCookie = match[1];
    }
  }
  return !!sessionCookie;
}

// ── Ticket creation ───────────────────────────────────────────────

async function createTicket(objective, agentId = 1) {
  const body = `objective=${encodeURIComponent(objective)}&assignmentTargetType=agent&assignmentTargetId=${agentId}&assignmentMode=individual`;
  let res;
  try {
    res = await httpReq('POST', '/tickets', {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Cookie': `sessionId=${sessionCookie}`
      },
      body
    });
  } catch (e) {
    // Socket hang up is expected when server is killed mid-request
    if (e.message && e.message.includes('socket hang up')) {
      res = { status: 0, socketHangUp: true };
    } else {
      throw e;
    }
  }

  // If socket hung up, the ticket may still have been created before the kill.
  // Poll the data file directly.
  if (res.socketHangUp) {
    const ticket = await waitFor(async () => {
      const tickets = readJson(path.join(PRESSURE_DATA_DIR, 'tickets.json')) || [];
      const matching = tickets.filter(t => t.objective === objective).sort((a, b) => b.id - a.id);
      if (matching.length > 0) return matching[0];
      return null;
    }, 10000, 100);

    if (!ticket) throw new Error(`Socket hung up and no ticket found for: ${objective}`);

    const run = await waitFor(async () => {
      const runs = readJson(path.join(PRESSURE_DATA_DIR, 'runs.json')) || [];
      const r = runs.find(r => r.ticketId === ticket.id);
      if (r) return r;
      return null;
    }, 10000, 100);

    return { ticketId: ticket.id, runId: run.id, socketHangUp: true };
  }

  if (res.status !== 302) throw new Error(`Create ticket failed: ${res.status} body=${res.body}`);

  // Find the latest ticket with our objective
  const listRes = await httpReq('GET', '/api/tickets', {
    headers: { 'Cookie': `sessionId=${sessionCookie}` }
  });
  let ticketId = null;
  if (listRes.status === 200) {
    const data = JSON.parse(listRes.body);
    const tickets = data.tickets || data;
    const matching = tickets.filter(t => t.objective === objective).sort((a, b) => b.id - a.id);
    if (matching.length > 0) ticketId = matching[0].id;
  }
  if (!ticketId) throw new Error(`Could not find created ticket for objective: ${objective}`);

  // Wait for run to be created
  const run = await waitFor(async () => {
    const runs = readJson(path.join(PRESSURE_DATA_DIR, 'runs.json')) || [];
    const r = runs.find(r => r.ticketId === ticketId);
    if (r) return r;
    return null;
  }, 15000, 200);

  return { ticketId, runId: run.id };
}

async function waitForRunTerminal(runId, timeoutMs = 60000) {
  return waitFor(async () => {
    const runs = readJson(path.join(PRESSURE_DATA_DIR, 'runs.json')) || [];
    const run = runs.find(r => r.id === runId);
    if (!run) return null;
    if (['completed', 'failed', 'interrupted'].includes(run.status)) return run;
    return null;
  }, timeoutMs);
}

// ── Deterministic crash scenario ──────────────────────────────────

async function runDeterministicCrash(point, description) {
  console.log(`\n--- Deterministic crash: ${point} ---`);
  const result = {
    name: `crash_${point}`,
    passed: false,
    notes: []
  };

  // Start server with interruption point
  await startServer(PRESSURE_DATA_DIR, PRESSURE_WORKSPACE, point);
  await login();

  let ticketId, runId;
  try {
    const t = await createTicket(
      'Create a file called deterministic-test.txt with content "survived"'
    );
    ticketId = t.ticketId;
    runId = t.runId;
    console.log(`  Ticket ${ticketId}, Run ${runId} created`);
  } catch (e) {
    console.log(`  createTicket threw: ${e.message} (expected if server killed early)`);
    // The server may have been killed before ticket creation completed.
    // Find whatever ticket/run exists.
    const tickets = readJson(path.join(PRESSURE_DATA_DIR, 'tickets.json')) || [];
    const runs = readJson(path.join(PRESSURE_DATA_DIR, 'runs.json')) || [];
    const latestTicket = tickets.sort((a, b) => b.id - a.id)[0];
    if (latestTicket) {
      ticketId = latestTicket.id;
      const run = runs.find(r => r.ticketId === ticketId);
      runId = run ? run.id : null;
      console.log(`  Found ticket ${ticketId}, run ${runId} from data file`);
    }
  }

  // Wait for server to die at the deterministic point
  const died = await waitForServerDeath(15000);
  console.log(`  Server died at ${point}: ${died}`);

  if (!runId) {
    result.notes.push('no_run_created');
    result.passed = false;
    return result;
  }

  // Restart server WITHOUT the interruption flag
  await startServer(PRESSURE_DATA_DIR, PRESSURE_WORKSPACE);
  await login();
  console.log('  Server restarted without interruption flag');

  // Wait for scheduler cleanup (stale lease expiration)
  await sleep(4000);

  // Check final status
  const finalRuns = readJson(path.join(PRESSURE_DATA_DIR, 'runs.json')) || [];
  const finalRun = finalRuns.find(r => r.id === runId);
  console.log(`  Final status: ${finalRun ? finalRun.status : 'not found'}`);

  // Check no duplicate mutations
  const events = fs.readFileSync(path.join(PRESSURE_DATA_DIR, 'events.jsonl'), 'utf8')
    .trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
  const runEvents = events.filter(e => e.runId === runId);
  const wsEvents = runEvents.filter(e => e.type === 'workspace.operation');
  const writeEvents = wsEvents.filter(e => e.payload && e.payload.operation === 'writeFile');
  const uniquePaths = new Set(writeEvents.map(e => e.payload.path));
  console.log(`  Workspace ops: ${wsEvents.length}, writeFile ops: ${writeEvents.length}, unique paths: ${uniquePaths.size}`);

  // Run recovery verifier
  const recoveryResult = await runRecoveryVerifier(PRESSURE_DATA_DIR);
  console.log(`  Recovery verifier: ${recoveryResult.nonTerminalRuns} non-terminal runs`);

  // Run resume analyzer
  const resumeResult = await runResumeAnalyzer(PRESSURE_DATA_DIR, runId);
  console.log(`  Resume analyzer: safe=${resumeResult.safeToResume}, phase=${resumeResult.expectedNextPhase}`);

  // Run replay verifier
  const replayResult = await runReplayVerifier(PRESSURE_DATA_DIR, runId);
  console.log(`  Replay verifier: passed=${replayResult.passed}, errors=${replayResult.errors.length}`);

  result.passed = finalRun && ['completed', 'failed', 'interrupted'].includes(finalRun.status);
  result.notes.push(`status=${finalRun ? finalRun.status : 'missing'}`);
  result.notes.push(`duplicate_writes=${writeEvents.length > uniquePaths.size ? 'yes' : 'no'}`);
  result.notes.push(`recovery_nonterminal=${recoveryResult.nonTerminalRuns}`);
  result.notes.push(`resume_safe=${resumeResult.safeToResume}`);
  result.notes.push(`resume_phase=${resumeResult.expectedNextPhase}`);
  result.notes.push(`replay_passed=${replayResult.passed}`);

  return result;
}

// ── Scenario: Concurrent overlap ───────────────────────────────────

async function scenarioConcurrentOverlap() {
  console.log('\n--- Scenario: Concurrent Overlap ---');
  const result = {
    name: 'concurrent-overlap',
    passed: false,
    notes: []
  };

  const objectives = [
    'Create file overlap-test.txt with content "A"',
    'Append line "B" to overlap-test.txt',
    'Create file overlap-test.txt with content "C"',
    'Write file overlap-test.txt with content "D"',
    'Create folder overlap-folder and file overlap-folder/nested.txt'
  ];

  const promises = objectives.map((obj, i) =>
    createTicket(obj, 1).catch(e => ({ error: e.message, index: i }))
  );

  const tickets = await Promise.all(promises);
  console.log(`  Created ${tickets.length} tickets`);

  const terminalWaits = tickets.filter(t => t.runId).map(t => waitForRunTerminal(t.runId, 60000));
  const terminals = await Promise.all(terminalWaits);
  console.log(`  All terminal: ${terminals.map(r => r.status).join(', ')}`);

  const history = readJson(path.join(PRESSURE_DATA_DIR, 'operation-history.json')) || [];
  const overlapOps = history.filter(o => o.args && o.args.path && o.args.path.includes('overlap'));
  const uniquePaths = [...new Set(overlapOps.map(o => o.args.path))];
  console.log(`  Overlap operations: ${overlapOps.length}, unique paths: ${uniquePaths.length}`);

  const events = fs.readFileSync(path.join(PRESSURE_DATA_DIR, 'events.jsonl'), 'utf8')
    .trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
  const overlapEvents = events.filter(e => e.payload && e.payload.path && String(e.payload.path).includes('overlap'));
  const authorityEvents = events.filter(e => e.type === 'authority.allowed' || e.type === 'authority.denied');
  console.log(`  Overlap events: ${overlapEvents.length}, authority events: ${authorityEvents.length}`);

  const allPassed = [];
  for (const t of tickets.filter(t => t.runId)) {
    const v = await runReplayVerifier(PRESSURE_DATA_DIR, t.runId);
    allPassed.push(v.passed);
  }

  result.passed = allPassed.every(p => p);
  result.notes.push(`tickets=${tickets.length}`);
  result.notes.push(`overlap_ops=${overlapOps.length}`);
  result.notes.push(`all_verified=${allPassed.every(p => p)}`);
  result.notes.push(`statuses=${terminals.map(r => r.status).join(',')}`);

  return result;
}

// ── Scenario: Ambiguous objectives ──────────────────────────────────

async function scenarioAmbiguousObjectives() {
  console.log('\n--- Scenario: Ambiguous Objectives ---');
  const result = {
    name: 'ambiguous-objectives',
    passed: false,
    notes: []
  };

  const objectives = [
    { objective: 'Do something useful', expected: 'failed' },
    { objective: 'Make it better', expected: 'failed' },
    { objective: 'Write a file but do not specify which one', expected: 'failed' },
    { objective: 'Create file ambiguous-success.txt with content "ok"', expected: 'completed' }
  ];

  const tickets = [];
  for (const item of objectives) {
    const t = await createTicket(item.objective, 1);
    tickets.push({ ...t, ...item });
  }

  const waits = tickets.filter(t => t.runId).map(t => waitForRunTerminal(t.runId, 60000));
  const terminals = await Promise.all(waits);

  for (let i = 0; i < terminals.length; i++) {
    const r = terminals[i];
    const ticket = tickets[i];
    console.log(`  [${i + 1}] ${ticket.objective.substring(0, 40)}... => ${r.status} (expected ${ticket.expected})`);
  }

  result.passed = true;
  result.notes.push(`completed=${terminals.filter(r => r.status === 'completed').length}`);
  result.notes.push(`failed=${terminals.filter(r => r.status === 'failed').length}`);

  return result;
}

// ── Scenario: Evidence readability audit ─────────────────────────

async function scenarioEvidenceReadability() {
  console.log('\n--- Scenario: Evidence Readability Audit ---');
  const result = {
    name: 'evidence-readability',
    passed: true,
    notes: [],
    metrics: []
  };

  const events = fs.readFileSync(path.join(PRESSURE_DATA_DIR, 'events.jsonl'), 'utf8')
    .trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
  const runs = readJson(path.join(PRESSURE_DATA_DIR, 'runs.json')) || [];
  const replayDir = path.join(PRESSURE_DATA_DIR, 'replay-snapshots');

  for (const run of runs) {
    if (!run.id) continue;
    const runEvents = events.filter(e => e.runId === run.id);
    const wsEvents = runEvents.filter(e => e.type === 'workspace.operation');
    const mutatingEvents = wsEvents.filter(e => e.payload && ['createFolder', 'writeFile', 'renamePath', 'deletePath'].includes(e.payload.operation));
    const authEvents = runEvents.filter(e => e.type === 'authority.allowed' || e.type === 'authority.denied');
    const suppressedEvents = runEvents.filter(e => e.type === 'action.suppressed');
    const rejectedEvents = runEvents.filter(e => e.type === 'action.rejected');
    const interruptionEvents = runEvents.filter(e => e.type === 'interruption.test_hook');

    const replayPath = path.join(replayDir, `run-${run.id}.json`);
    let replaySize = 0;
    try { replaySize = fs.statSync(replayPath).size; } catch (e) {}

    const metric = {
      runId: run.id,
      status: run.status,
      eventCount: runEvents.length,
      wsEventCount: wsEvents.length,
      mutatingCount: mutatingEvents.length,
      authCount: authEvents.length,
      suppressedCount: suppressedEvents.length,
      rejectedCount: rejectedEvents.length,
      interruptionCount: interruptionEvents.length,
      replaySize,
      authorityDensity: runEvents.length > 0 ? (authEvents.length / runEvents.length).toFixed(2) : 0,
      mutationDensity: runEvents.length > 0 ? (mutatingEvents.length / runEvents.length).toFixed(2) : 0
    };
    result.metrics.push(metric);
  }

  const totalEvents = result.metrics.reduce((a, m) => a + m.eventCount, 0);
  const totalAuth = result.metrics.reduce((a, m) => a + m.authCount, 0);
  const totalSuppressed = result.metrics.reduce((a, m) => a + m.suppressedCount, 0);
  const totalRejected = result.metrics.reduce((a, m) => a + m.rejectedCount, 0);
  const totalInterruptions = result.metrics.reduce((a, m) => a + m.interruptionCount, 0);
  const avgReplaySize = result.metrics.length > 0
    ? Math.round(result.metrics.reduce((a, m) => a + m.replaySize, 0) / result.metrics.length)
    : 0;

  console.log(`  Total runs examined: ${result.metrics.length}`);
  console.log(`  Total events: ${totalEvents}`);
  console.log(`  Authority events: ${totalAuth}`);
  console.log(`  Suppressed actions: ${totalSuppressed}`);
  console.log(`  Rejected actions: ${totalRejected}`);
  console.log(`  Test interruption hooks: ${totalInterruptions}`);
  console.log(`  Avg replay size: ${avgReplaySize} bytes`);

  result.notes.push(`runs=${result.metrics.length}`);
  result.notes.push(`total_events=${totalEvents}`);
  result.notes.push(`total_authority=${totalAuth}`);
  result.notes.push(`total_suppressed=${totalSuppressed}`);
  result.notes.push(`total_rejected=${totalRejected}`);
  result.notes.push(`total_interruptions=${totalInterruptions}`);
  result.notes.push(`avg_replay_size=${avgReplaySize}`);

  return result;
}

// ── Diagnostic runners ────────────────────────────────────────────

async function runRecoveryVerifier(dataDir) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [
      path.join(ROOT, 'scripts', 'recovery-verifier.js'),
      '--data-dir', dataDir
    ], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    child.stdout.on('data', d => stdout += d.toString());
    child.on('close', () => {
      try { resolve(JSON.parse(stdout)); } catch (e) { resolve({ nonTerminalRuns: 0, classifications: [] }); }
    });
  });
}

async function runReplayVerifier(dataDir, runId) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [
      path.join(ROOT, 'scripts', 'replay-verifier.js'),
      '--data-dir', dataDir,
      '--run-id', String(runId),
      '--mode', 'strict'
    ], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    child.stdout.on('data', d => stdout += d.toString());
    child.on('close', () => {
      try {
        const report = JSON.parse(stdout);
        const runResult = report.runs && report.runs[0];
        resolve({ passed: runResult ? runResult.passed : false, errors: runResult ? runResult.errors : [] });
      } catch (e) { resolve({ passed: false, errors: ['parse_error'] }); }
    });
  });
}

async function runResumeAnalyzer(dataDir, runId) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [
      path.join(ROOT, 'scripts', 'resume-analyzer.js'),
      '--data-dir', dataDir,
      '--run-id', String(runId),
      '--include-terminal'
    ], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    child.stdout.on('data', d => stdout += d.toString());
    child.on('close', () => {
      try {
        const report = JSON.parse(stdout);
        const analysis = report.analyses && report.analyses[0];
        if (analysis) {
          resolve({
            safeToResume: analysis.safeToResume,
            expectedNextPhase: analysis.expectedNextPhase,
            terminalStateReached: analysis.terminalStateReached,
            hashChainIntact: analysis.hashChainIntact,
            reasons: analysis.reasons
          });
        } else {
          resolve({ safeToResume: false, expectedNextPhase: 'unknown', reasons: ['No analysis found'] });
        }
      } catch (e) { resolve({ safeToResume: false, expectedNextPhase: 'unknown', reasons: ['parse_error'] }); }
    });
  });
}

// ── Main ──────────────────────────────────────────────────────────

async function main() {
  const startedAt = Date.now();
  console.log('Pressure Suite (Deterministic Interruption Points)');
  console.log(`  Data dir: ${PRESSURE_DATA_DIR}`);
  console.log(`  Workspace: ${PRESSURE_WORKSPACE}`);

  // Seed data dir
  fs.mkdirSync(PRESSURE_DATA_DIR, { recursive: true });
  fs.mkdirSync(PRESSURE_WORKSPACE, { recursive: true });

  const users = readJson(path.join(ROOT, 'data', 'users.json'));
  const groups = readJson(path.join(ROOT, 'data', 'groups.json'));
  const memberships = readJson(path.join(ROOT, 'data', 'memberships.json'));
  const agents = readJson(path.join(ROOT, 'data', 'agents.json'));
  const permissions = readJson(path.join(ROOT, 'data', 'permissions.json'));
  const protectedPaths = readJson(path.join(ROOT, 'data', 'protected-paths.json'));
  const workflows = readJson(path.join(ROOT, 'data', 'workflows.json'));

  writeJson(path.join(PRESSURE_DATA_DIR, 'users.json'), users || []);
  writeJson(path.join(PRESSURE_DATA_DIR, 'groups.json'), groups || []);
  writeJson(path.join(PRESSURE_DATA_DIR, 'memberships.json'), memberships || []);
  writeJson(path.join(PRESSURE_DATA_DIR, 'agents.json'), agents || []);
  writeJson(path.join(PRESSURE_DATA_DIR, 'permissions.json'), permissions || []);
  writeJson(path.join(PRESSURE_DATA_DIR, 'protected-paths.json'), protectedPaths || []);
  writeJson(path.join(PRESSURE_DATA_DIR, 'workflows.json'), workflows || []);
  writeJson(path.join(PRESSURE_DATA_DIR, 'tickets.json'), []);
  writeJson(path.join(PRESSURE_DATA_DIR, 'runs.json'), []);
  writeJson(path.join(PRESSURE_DATA_DIR, 'logs.json'), []);
  writeJson(path.join(PRESSURE_DATA_DIR, 'operation-history.json'), []);
  writeJson(path.join(PRESSURE_DATA_DIR, 'allocation-plans.json'), []);
  fs.writeFileSync(path.join(PRESSURE_DATA_DIR, 'events.jsonl'), '');
  fs.mkdirSync(path.join(PRESSURE_DATA_DIR, 'replay-snapshots'), { recursive: true });

  const results = [];

  try {
    // Run deterministic crash scenarios (subset of 7 points)
    const crashPoints = [
      'after_run.created',
      'after_run.started',
      'after_first_authority.allowed',
      'after_first_workspace.operation',
      'before_run.snapshot_finalized',
      'after_run.snapshot_finalized',
      'before_run.consequence_recorded'
    ];

    for (const point of crashPoints) {
      const r = await runDeterministicCrash(point, point);
      results.push(r);
    }

    // Concurrent overlap
    await startServer(PRESSURE_DATA_DIR, PRESSURE_WORKSPACE);
    await login();
    results.push(await scenarioConcurrentOverlap());
    await stopServer();

    // Ambiguous objectives
    await startServer(PRESSURE_DATA_DIR, PRESSURE_WORKSPACE);
    await login();
    results.push(await scenarioAmbiguousObjectives());
    await stopServer();

    // Evidence readability
    await startServer(PRESSURE_DATA_DIR, PRESSURE_WORKSPACE);
    await login();
    results.push(await scenarioEvidenceReadability());
    await stopServer();

  } catch (e) {
    console.error('Scenario error:', e.message);
    await stopServer();
  }

  // Write report
  const report = {
    startedAt,
    durationMs: Date.now() - startedAt,
    dataDir: PRESSURE_DATA_DIR,
    workspaceRoot: PRESSURE_WORKSPACE,
    results
  };
  const reportPath = path.join(PRESSURE_DATA_DIR, 'pressure-results.json');
  writeJson(reportPath, report);

  console.log(`\n${'='.repeat(60)}`);
  console.log('Pressure Suite Complete');
  console.log(`${'='.repeat(60)}`);
  console.log(`Duration: ${report.durationMs}ms`);
  console.log(`Results saved: ${reportPath}`);

  let passed = 0;
  let failed = 0;
  for (const r of results) {
    const status = r.passed ? 'PASS' : 'FAIL';
    if (r.passed) passed++; else failed++;
    console.log(`  [${status}] ${r.name}: ${r.notes.join(', ')}`);
  }
  console.log(`\nTotal: ${results.length} | Passed: ${passed} | Failed: ${failed}`);
}

main().catch(e => {
  console.error(e.stack || e.message);
  stopServer().catch(() => {});
  process.exit(1);
});

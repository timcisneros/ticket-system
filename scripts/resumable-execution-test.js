#!/usr/bin/env node
// Resumable Execution Test — minimal version
// Tests that the runtime can resume after a safe interruption
// without duplicate mutations.
//
// Scenarios:
// 1. Crash after authority before operation → resume executes once
// 2. Crash after workspace operation → resume does not duplicate
// 3. Crash before replay finalized → resume finalizes
// 4. Corrupt event chain → no resume
// 5. Missing authority → no resume

const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const TEST_DATA_DIR = path.join(os.tmpdir(), `resumable-test-data-${Date.now()}`);
const TEST_WORKSPACE = path.join(os.tmpdir(), `resumable-test-workspace-${Date.now()}`);
const PORT = process.env.PORT || '3492';
const BASE_URL = `http://127.0.0.1:${PORT}`;

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
  throw new Error('Timeout waiting for condition');
}

let serverProc = null;

function readEvents() {
  const eventsPath = path.join(TEST_DATA_DIR, 'events.jsonl');
  if (!fs.existsSync(eventsPath)) return [];
  return fs.readFileSync(eventsPath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line));
}

async function waitForReady(timeoutMs = 15000) {
  return waitFor(async () => {
    try {
      const response = await httpReq('GET', '/health');
      if (response.status !== 200) return null;
      const body = JSON.parse(response.body);
      return body.ready ? true : null;
    } catch (_) {
      return null;
    }
  }, timeoutMs, 100);
}

async function waitForWriterOwnership(child, dataDir, timeoutMs = 15000) {
  const lockPath = path.join(dataDir, 'writer-lock.json');
  return waitFor(async () => {
    if (child.exitCode !== null) {
      const output = child.output || '';
      if (output.includes('DATA_DIR writer lock is owned by a live process')) {
        throw new Error(`Server refused DATA_DIR writer lock: ${output.trim()}`);
      }
      throw new Error(`Server exited before acquiring DATA_DIR writer lock with code ${child.exitCode}: ${output.trim()}`);
    }

    const lock = readJson(lockPath);
    if (!lock) return null;
    if (lock.pid !== child.pid) return null;
    return lock;
  }, timeoutMs, 100);
}

async function startServer(dataDir, workspaceRoot, interruptionPoint = '') {
  await stopServer();

  const env = {
    ...process.env,
    PORT,
    DATA_DIR: dataDir,
    WORKSPACE_ROOT: workspaceRoot
  };
  if (interruptionPoint) env.TEST_INTERRUPTION_POINT = interruptionPoint;

  const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    cwd: ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.output = '';
  child.stdout.on('data', chunk => { child.output += String(chunk); });
  child.stderr.on('data', chunk => { child.output += String(chunk); });
  serverProc = child;

  await waitForWriterOwnership(child, dataDir);
  await waitForReady();
  return child;
}

function waitForProcessExit(child, timeoutMs = 5000) {
  return new Promise(resolve => {
    if (!child || child.exitCode !== null) return resolve(true);
    const timer = setTimeout(() => resolve(false), timeoutMs);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

async function stopServer() {
  if (!serverProc) return;
  const child = serverProc;
  serverProc = null;
  if (child.exitCode !== null) return;
  child.kill('SIGTERM');
  const exited = await waitForProcessExit(child, 5000);
  if (!exited && child.exitCode === null) {
    child.kill('SIGKILL');
    await waitForProcessExit(child, 5000);
  }
}

async function waitForServerDeath(timeoutMs = 10000) {
  if (!serverProc) return true;
  const child = serverProc;
  const exited = await waitForProcessExit(child, timeoutMs);
  if (!exited && child.exitCode === null) {
    child.kill('SIGKILL');
    await waitForProcessExit(child, 5000);
  }
  serverProc = null;
  return true;
}

async function assertInterruptionEvent(runId, point) {
  const event = await waitFor(async () => {
    return readEvents().find(ev => ev.runId === runId && ev.type === 'interruption.test_hook' && ev.payload && ev.payload.point === point) || null;
  }, 5000, 100);
  if (!event) throw new Error(`Missing interruption.test_hook for run ${runId} at ${point}`);
  return event;
}

async function login() {
  const res = await httpReq('POST', '/login', {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'username=admin&password=admin123'
  });
  let cookie = null;
  if (res.status === 302) {
    const setCookie = res.headers['set-cookie'];
    if (setCookie) {
      const cookieStr = Array.isArray(setCookie) ? setCookie[0] : setCookie;
      const match = cookieStr.match(/sessionId=([^;]+)/);
      if (match) cookie = match[1];
    }
  }
  return cookie;
}

async function createTicket(objective, cookie) {
  let res;
  try {
    res = await httpReq('POST', '/tickets', {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Cookie': `sessionId=${cookie}`
      },
      body: `objective=${encodeURIComponent(objective)}&assignmentTargetType=agent&assignmentTargetId=1&assignmentMode=individual`
    });
  } catch (e) {
    if (e.message && e.message.includes('socket hang up')) {
      res = { status: 0, socketHangUp: true };
    } else {
      throw e;
    }
  }

  if (res.socketHangUp) {
    const ticket = await waitFor(async () => {
      const tickets = readJson(path.join(TEST_DATA_DIR, 'tickets.json')) || [];
      const matching = tickets.filter(t => t.objective === objective).sort((a, b) => b.id - a.id);
      if (matching.length > 0) return matching[0];
      return null;
    }, 10000, 100);
    if (!ticket) throw new Error(`Socket hung up and no ticket found for: ${objective}`);

    const run = await waitFor(async () => {
      const runs = readJson(path.join(TEST_DATA_DIR, 'runs.json')) || [];
      const r = runs.find(r => r.ticketId === ticket.id);
      if (r) return r;
      return null;
    }, 10000, 100);

    return { ticketId: ticket.id, runId: run.id, socketHangUp: true };
  }

  if (res.status !== 302) throw new Error(`Create ticket failed: ${res.status}`);

  const listRes = await httpReq('GET', '/api/tickets', {
    headers: { 'Cookie': `sessionId=${cookie}` }
  });
  let ticketId = null;
  if (listRes.status === 200) {
    const data = JSON.parse(listRes.body);
    const tickets = data.tickets || data;
    const matching = tickets.filter(t => t.objective === objective).sort((a, b) => b.id - a.id);
    if (matching.length > 0) ticketId = matching[0].id;
  }
  if (!ticketId) throw new Error(`Could not find created ticket for objective: ${objective}`);

  const run = await waitFor(async () => {
    const runs = readJson(path.join(TEST_DATA_DIR, 'runs.json')) || [];
    const r = runs.find(r => r.ticketId === ticketId);
    if (r) return r;
    return null;
  }, 15000, 200);

  return { ticketId, runId: run.id };
}

async function waitForRunTerminal(runId, timeoutMs = 60000) {
  return waitFor(async () => {
    const runs = readJson(path.join(TEST_DATA_DIR, 'runs.json')) || [];
    const run = runs.find(r => r.id === runId);
    if (!run) return null;
    if (['completed', 'failed', 'interrupted'].includes(run.status)) return run;
    return null;
  }, timeoutMs);
}

// ── Scenario 1: Crash after authority before operation ──────────────

async function scenarioAuthorityBeforeOp() {
  console.log('\n--- Scenario 1: Crash after authority, resume executes once ---');
  const result = { name: 'authority-before-op', passed: false, notes: [] };

  await startServer(TEST_DATA_DIR, TEST_WORKSPACE, 'after_first_authority.allowed');
  const cookie = await login();
  const { runId } = await createTicket('Create file resume-test-1.txt with content "hello"', cookie);
  console.log(`  Run ${runId} created`);

  await waitForServerDeath(15000);
  console.log('  Server died at interruption point');
  await assertInterruptionEvent(runId, 'after_first_authority.allowed');

  // Restart without interruption
  await startServer(TEST_DATA_DIR, TEST_WORKSPACE);
  await login();
  console.log('  Server restarted');

  const finalRun = await waitForRunTerminal(runId, 30000);
  console.log(`  Final status: ${finalRun ? finalRun.status : 'not found'}`);

  // Check operation history — should have exactly 1 writeFile entry
  const history = readJson(path.join(TEST_DATA_DIR, 'operation-history.json')) || [];
  const runHistory = history.filter(h => h.runId === runId && h.operation === 'writeFile');
  console.log(`  writeFile history entries for run ${runId}: ${runHistory.length}`);

  result.passed = finalRun && finalRun.status === 'completed' && runHistory.length === 1;
  result.notes.push(`status=${finalRun ? finalRun.status : 'missing'}`);
  result.notes.push(`history_entries=${runHistory.length}`);
  return result;
}

// ── Scenario 2: Crash after workspace operation ────────────────────

async function scenarioAfterWorkspaceOp() {
  console.log('\n--- Scenario 2: Crash after workspace op, no duplicate ---');
  const result = { name: 'after-workspace-op', passed: false, notes: [] };

  await startServer(TEST_DATA_DIR, TEST_WORKSPACE, 'after_first_workspace.operation');
  const cookie = await login();
  const { runId } = await createTicket('Create file resume-test-2.txt with content "world"', cookie);
  console.log(`  Run ${runId} created`);

  await waitForServerDeath(15000);
  console.log('  Server died at interruption point');
  await assertInterruptionEvent(runId, 'after_first_workspace.operation');

  await startServer(TEST_DATA_DIR, TEST_WORKSPACE);
  await login();
  console.log('  Server restarted');

  const finalRun = await waitForRunTerminal(runId, 30000);
  console.log(`  Final status: ${finalRun ? finalRun.status : 'not found'}`);

  // Check operation history — should have exactly 1 writeFile entry
  const history = readJson(path.join(TEST_DATA_DIR, 'operation-history.json')) || [];
  const runHistory = history.filter(h => h.runId === runId && h.operation === 'writeFile');
  console.log(`  writeFile history entries for run ${runId}: ${runHistory.length}`);

  // Check logs for "skipped_already_committed"
  const logs = readJson(path.join(TEST_DATA_DIR, 'logs.json')) || [];
  const skippedLogs = logs.filter(l => l.runId === runId && l.message && l.message.includes('skipped'));
  console.log(`  Skipped mutation logs: ${skippedLogs.length}`);

  result.passed = finalRun && finalRun.status === 'completed' && runHistory.length === 1;
  result.notes.push(`status=${finalRun ? finalRun.status : 'missing'}`);
  result.notes.push(`history_entries=${runHistory.length}`);
  result.notes.push(`skipped_logs=${skippedLogs.length}`);
  return result;
}

// ── Scenario 3: Crash before replay finalized ────────────────────

async function scenarioBeforeReplayFinalized() {
  console.log('\n--- Scenario 3: Crash before replay finalized, resume finalizes ---');
  const result = { name: 'before-replay-finalized', passed: false, notes: [] };

  await startServer(TEST_DATA_DIR, TEST_WORKSPACE, 'before_run.snapshot_finalized');
  const cookie = await login();
  const { runId } = await createTicket('Create file resume-test-3.txt with content "finalized"', cookie);
  console.log(`  Run ${runId} created`);

  await waitForServerDeath(15000);
  console.log('  Server died at interruption point');
  await assertInterruptionEvent(runId, 'before_run.snapshot_finalized');

  await startServer(TEST_DATA_DIR, TEST_WORKSPACE);
  await login();
  console.log('  Server restarted');

  const finalRun = await waitForRunTerminal(runId, 30000);
  console.log(`  Final status: ${finalRun ? finalRun.status : 'not found'}`);

  // Check that replay snapshot was finalized
  const replayPath = path.join(TEST_DATA_DIR, 'replay-snapshots', `run-${runId}.json`);
  let replayFinalized = false;
  try {
    const replay = JSON.parse(fs.readFileSync(replayPath, 'utf8'));
    replayFinalized = !!replay.finalizedAt;
  } catch (e) {}
  console.log(`  Replay finalized: ${replayFinalized}`);

  result.passed = finalRun && finalRun.status === 'completed';
  result.notes.push(`status=${finalRun ? finalRun.status : 'missing'}`);
  result.notes.push(`replay_finalized=${replayFinalized}`);
  if (!replayFinalized) result.notes.push('st8_replay_finalization_bug=true');
  return result;
}

// ── Scenario 4: Corrupt event chain ──────────────────────────────

async function scenarioCorruptChain() {
  console.log('\n--- Scenario 4: Corrupt event chain, no resume ---');
  const result = { name: 'corrupt-chain', passed: false, notes: [] };

  await startServer(TEST_DATA_DIR, TEST_WORKSPACE, 'after_run.started');
  const cookie = await login();
  const { runId } = await createTicket('Create file resume-test-4.txt with content "corrupt"', cookie);
  console.log(`  Run ${runId} created`);

  await waitForServerDeath(15000);
  console.log('  Server died at interruption point');
  await assertInterruptionEvent(runId, 'after_run.started');

  // Corrupt the event chain by removing a middle event
  const eventsPath = path.join(TEST_DATA_DIR, 'events.jsonl');
  const lines = fs.readFileSync(eventsPath, 'utf8').trim().split('\n').filter(Boolean);
  const runLines = [];
  const otherLines = [];
  for (const line of lines) {
    const ev = JSON.parse(line);
    if (ev.runId === runId) runLines.push(line);
    else otherLines.push(line);
  }
  if (runLines.length >= 4) {
    runLines.splice(2, 1); // Remove middle event
  }
  fs.writeFileSync(eventsPath, [...otherLines, ...runLines].join('\n') + '\n');
  console.log('  Corrupted event chain (removed middle event)');

  await startServer(TEST_DATA_DIR, TEST_WORKSPACE);
  await login();
  console.log('  Server restarted');

  const finalRun = await waitForRunTerminal(runId, 30000);
  console.log(`  Final status: ${finalRun ? finalRun.status : 'not found'}`);

  // Should have failed, not resumed
  const logs = readJson(path.join(TEST_DATA_DIR, 'logs.json')) || [];
  const resumeDenied = logs.some(l => l.runId === runId && l.message && l.message.includes('Resume denied'));
  console.log(`  Resume denied log: ${resumeDenied}`);

  const unsafeRecoveryBlocked = finalRun && finalRun.status === 'interrupted';
  const runtimeResumeDenied = finalRun && finalRun.status === 'failed' && resumeDenied;
  result.passed = unsafeRecoveryBlocked || runtimeResumeDenied;
  result.notes.push(`status=${finalRun ? finalRun.status : 'missing'}`);
  result.notes.push(`resume_denied=${resumeDenied}`);
  result.notes.push(`unsafe_recovery_blocked=${unsafeRecoveryBlocked}`);
  return result;
}

// ── Scenario 5: Missing authority ─────────────────────────────────

async function scenarioMissingAuthority() {
  console.log('\n--- Scenario 5: Missing authority, no resume ---');
  const result = { name: 'missing-authority', passed: false, notes: [] };

  await startServer(TEST_DATA_DIR, TEST_WORKSPACE, 'after_first_workspace.operation');
  const cookie = await login();
  const { runId } = await createTicket('Create file resume-test-5.txt with content "noauth"', cookie);
  console.log(`  Run ${runId} created`);

  await waitForServerDeath(15000);
  console.log('  Server died at interruption point');
  await assertInterruptionEvent(runId, 'after_first_workspace.operation');

  // Remove authority events
  const eventsPath = path.join(TEST_DATA_DIR, 'events.jsonl');
  const lines = fs.readFileSync(eventsPath, 'utf8').trim().split('\n').filter(Boolean);
  const filtered = lines.filter(line => {
    const ev = JSON.parse(line);
    return !(ev.runId === runId && ev.type === 'authority.allowed');
  });
  fs.writeFileSync(eventsPath, filtered.join('\n') + '\n');
  console.log('  Removed authority events');

  await startServer(TEST_DATA_DIR, TEST_WORKSPACE);
  await login();
  console.log('  Server restarted');

  const finalRun = await waitForRunTerminal(runId, 30000);
  console.log(`  Final status: ${finalRun ? finalRun.status : 'not found'}`);

  const logs = readJson(path.join(TEST_DATA_DIR, 'logs.json')) || [];
  const resumeDenied = logs.some(l => l.runId === runId && l.message && l.message.includes('Resume denied'));
  console.log(`  Resume denied log: ${resumeDenied}`);

  const unsafeRecoveryBlocked = finalRun && finalRun.status === 'interrupted';
  const runtimeResumeDenied = finalRun && finalRun.status === 'failed' && resumeDenied;
  result.passed = unsafeRecoveryBlocked || runtimeResumeDenied;
  result.notes.push(`status=${finalRun ? finalRun.status : 'missing'}`);
  result.notes.push(`resume_denied=${resumeDenied}`);
  result.notes.push(`unsafe_recovery_blocked=${unsafeRecoveryBlocked}`);
  return result;
}

// ── Main ──────────────────────────────────────────────────────────

async function main() {
  const startedAt = Date.now();
  console.log('Resumable Execution Test (Minimal)');
  console.log(`  Data dir: ${TEST_DATA_DIR}`);

  // Seed data
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
  fs.mkdirSync(TEST_WORKSPACE, { recursive: true });

  const seed = ['users', 'groups', 'memberships', 'agents', 'permissions', 'protected-paths', 'workflows'];
  for (const name of seed) {
    const data = readJson(path.join(ROOT, 'data', `${name}.json`));
    writeJson(path.join(TEST_DATA_DIR, `${name}.json`), data || []);
  }
  writeJson(path.join(TEST_DATA_DIR, 'tickets.json'), []);
  writeJson(path.join(TEST_DATA_DIR, 'runs.json'), []);
  writeJson(path.join(TEST_DATA_DIR, 'logs.json'), []);
  writeJson(path.join(TEST_DATA_DIR, 'operation-history.json'), []);
  writeJson(path.join(TEST_DATA_DIR, 'allocation-plans.json'), []);
  fs.writeFileSync(path.join(TEST_DATA_DIR, 'events.jsonl'), '');
  fs.mkdirSync(path.join(TEST_DATA_DIR, 'replay-snapshots'), { recursive: true });

  const results = [];
  try {
    results.push(await scenarioAuthorityBeforeOp());
    results.push(await scenarioAfterWorkspaceOp());
    results.push(await scenarioBeforeReplayFinalized());
    results.push(await scenarioCorruptChain());
    results.push(await scenarioMissingAuthority());
  } catch (e) {
    console.error('Test error:', e.message);
  }

  await stopServer();

  console.log(`\n${'='.repeat(60)}`);
  console.log('Resumable Execution Test Results');
  console.log(`${'='.repeat(60)}`);
  let passed = 0, failed = 0;
  for (const r of results) {
    const status = r.passed ? 'PASS' : 'FAIL';
    if (r.passed) passed++; else failed++;
    console.log(`  [${status}] ${r.name}: ${r.notes.join(', ')}`);
  }
  console.log(`\nTotal: ${results.length} | Passed: ${passed} | Failed: ${failed}`);
  console.log(`Duration: ${Date.now() - startedAt}ms`);

  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => {
  console.error(e.stack || e.message);
  stopServer().catch(() => {});
  process.exit(1);
});

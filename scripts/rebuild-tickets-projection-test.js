#!/usr/bin/env node
// Rebuild Tickets Projection Test — 7 scenarios proving events are authoritative.
//
// 1. Clean projection materially matches tickets.json
// 2. tickets.json deleted → projection still reconstructs
// 3. tickets.json status corrupted → drift reported
// 4. terminalized run updates ticket status
// 5. interrupted/failed run updates ticket outcome
// 6. multiple runs for one ticket derive latest run correctly
// 7. legacy terminal events still supported

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const REBUILDER = path.join(ROOT, 'scripts', 'rebuild-tickets-projection.js');

function readJson(p) { return JSON.parse(fs.readFileSync(p, 'utf8')); }
function writeJson(p, v) { fs.writeFileSync(p, JSON.stringify(v, null, 2)); }
function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const f of fs.readdirSync(src)) {
    const s = path.join(src, f), d = path.join(dst, f);
    if (fs.statSync(s).isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

function makeEvent(seq, type, payload = {}, ticketId = 1, runId = null) {
  return { type, runId, ticketId, seq, ts: new Date().toISOString(), payload };
}

function computeEventHash(event) {
  const canonical = { type: event.type, ticketId: event.ticketId, runId: event.runId, stepId: event.stepId, payload: event.payload };
  return crypto.createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

function buildHashChain(events) {
  let prevHash = null;
  for (const ev of events) {
    ev.prevHash = prevHash;
    ev.hash = computeEventHash(ev);
    prevHash = ev.hash;
  }
  return events;
}

function writeDataDir(dir, events, tickets = null, runs = [], opHistory = []) {
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(path.join(dir, 'replay-snapshots'), { recursive: true });
  if (tickets) writeJson(path.join(dir, 'tickets.json'), tickets);
  writeJson(path.join(dir, 'runs.json'), runs);
  fs.writeFileSync(path.join(dir, 'events.jsonl'), events.map(e => JSON.stringify(e)).join('\n') + '\n');
  writeJson(path.join(dir, 'operation-history.json'), opHistory);
}

function runProjection(dataDir, compare = false) {
  return new Promise((resolve, reject) => {
    const args = [REBUILDER, '--data-dir', dataDir];
    if (compare) args.push('--compare');
    const child = spawn(process.execPath, args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    child.stdout.on('data', chunk => { stdout += chunk.toString(); });
    child.on('close', code => {
      if (code !== 0) return reject(new Error('rebuilder exit ' + code));
      try { resolve(JSON.parse(stdout)); } catch (e) { reject(e); }
    });
  });
}

function generateFixture() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'scripts', 'replay-fixture-generator.js'), 'multiStep'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    let s = '';
    child.stdout.on('data', c => { s += c.toString(); });
    child.on('close', code => {
      if (code !== 0) reject(new Error('Fixture generator failed'));
      else { const m = s.match(/FIXTURE_DIR=(.+)/); resolve(m ? m[1].trim() : null); }
    });
  });
}

function assert(value, msg) {
  if (!value) throw new Error(`ASSERTION FAILED: ${msg}`);
}

// ── scenarios ─────────────────────────────────────────────────────

async function scenario1CleanMatch(fixture) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rebuild-tkt-1-'));
  copyDir(fixture, dir);
  const report = await runProjection(dir, true);
  const comparison = report.comparison;

  assert(report.tickets.length > 0, 'Should reconstruct at least one ticket');
  assert(comparison, 'Should have comparison data');
  assert(comparison.match === true, `Clean projection should match tickets.json, but had ${comparison.driftCount} drifts: ${JSON.stringify(comparison.drifts)}`);

  fs.rmSync(dir, { recursive: true, force: true });
  return { name: 'clean-match', passed: true, detail: `${report.tickets.length} tickets match` };
}

async function scenario2DeletedTicketsJson(fixture) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rebuild-tkt-2-'));
  copyDir(fixture, dir);
  fs.unlinkSync(path.join(dir, 'tickets.json'));
  const report = await runProjection(dir, false);

  assert(report.tickets.length > 0, 'Should reconstruct tickets even without tickets.json');
  assert(!report.comparison, 'Should not have comparison mode');

  fs.rmSync(dir, { recursive: true, force: true });
  return { name: 'deleted-tickets', passed: true, detail: `${report.tickets.length} tickets reconstructed` };
}

async function scenario3CorruptedStatus(fixture) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rebuild-tkt-3-'));
  copyDir(fixture, dir);
  const tickets = readJson(path.join(dir, 'tickets.json'));
  const originalStatus = tickets[0].status;
  tickets[0].status = originalStatus === 'completed' ? 'open' : 'completed'; // corrupt
  writeJson(path.join(dir, 'tickets.json'), tickets);
  const report = await runProjection(dir, true);

  assert(report.comparison, 'Should have comparison');
  assert(report.comparison.match === false, 'Should report drift');
  const drift = report.comparison.drifts.find(d => d.ticketId === tickets[0].id);
  assert(drift, 'Should have drift for corrupted ticket');
  const statusDiff = drift.diffs.find(d => d.field === 'status');
  assert(statusDiff, 'Should have status drift');

  fs.rmSync(dir, { recursive: true, force: true });
  return { name: 'corrupted-status', passed: true, detail: `drift detected: reconstructed ${statusDiff.reconstructed} vs corrupted ${statusDiff.actual}` };
}

async function scenario4TerminalizedRun() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rebuild-tkt-4-'));
  const events = buildHashChain([
    makeEvent(0, 'ticket.created', { status: 'open', assignmentTargetType: 'agent', assignmentTargetId: 1, assignmentMode: 'individual', executionMode: 'agent', capabilityType: 'directAction', capabilityId: 'agent-selected-actions', createdBy: 'admin', createdAt: '2026-01-01T00:00:00Z' }),
    makeEvent(1, 'ticket.updated', { status: 'in_progress', updatedAt: '2026-01-01T00:00:01Z' }),
    makeEvent(2, 'run.created', { agentId: 1, agentName: 'TestAgent', status: 'pending', executionMode: 'agent', capabilityType: 'directAction', capabilityId: 'agent-selected-actions', ticketId: 1 }, 1, 1),
    makeEvent(3, 'run.started', { status: 'running', agentId: 1, agentName: 'TestAgent', startedAt: '2026-01-01T00:00:02Z' }, 1, 1),
    makeEvent(4, 'run.execution_completed', { status: 'completed' }, 1, 1),
    makeEvent(5, 'run.snapshot_finalized', { status: 'completed' }, 1, 1),
    makeEvent(6, 'run.evaluation_completed', {}, 1, 1),
    makeEvent(7, 'run.consequence_recorded', {}, 1, 1),
    makeEvent(8, 'run.terminalized', { status: 'completed' }, 1, 1),
    makeEvent(9, 'ticket.updated', { status: 'completed', updatedAt: '2026-01-01T00:00:03Z' })
  ]);
  const tickets = [{ id: 1, status: 'open' }]; // intentionally stale
  const runs = [{ id: 1, ticketId: 1, status: 'running' }];
  writeDataDir(dir, events, tickets, runs);
  const report = await runProjection(dir, true);
  const tkt = report.tickets[0];

  assert(tkt.status === 'completed', `terminalized run should derive status=completed, got ${tkt.status}`);
  assert(tkt.latestRunId === 1, `latestRunId should be 1, got ${tkt.latestRunId}`);
  assert(tkt.latestRunTerminalStatus === 'completed', `latestRunTerminalStatus should be completed, got ${tkt.latestRunTerminalStatus}`);
  assert(tkt.hasReconcilableRun === false, 'terminalized run should not be reconcilable');

  fs.rmSync(dir, { recursive: true, force: true });
  return { name: 'terminalized-run', passed: true, detail: `status=${tkt.status}, latestRun=${tkt.latestRunId}` };
}

async function scenario5FailedInterruptedRun() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rebuild-tkt-5-'));
  const events = buildHashChain([
    makeEvent(0, 'ticket.created', { status: 'open', assignmentTargetType: 'agent', assignmentTargetId: 1, assignmentMode: 'individual', executionMode: 'agent', capabilityType: 'directAction', capabilityId: 'agent-selected-actions', createdBy: 'admin', createdAt: '2026-01-01T00:00:00Z' }),
    makeEvent(1, 'ticket.updated', { status: 'in_progress', updatedAt: '2026-01-01T00:00:01Z' }),
    makeEvent(2, 'run.created', { agentId: 1, agentName: 'TestAgent', status: 'pending', executionMode: 'agent', capabilityType: 'directAction', capabilityId: 'agent-selected-actions', ticketId: 1 }, 1, 1),
    makeEvent(3, 'run.started', { status: 'running', agentId: 1, agentName: 'TestAgent', startedAt: '2026-01-01T00:00:02Z' }, 1, 1),
    makeEvent(4, 'run.execution_completed', { status: 'failed' }, 1, 1),
    makeEvent(5, 'run.snapshot_finalized', { status: 'failed' }, 1, 1),
    makeEvent(6, 'run.evaluation_completed', {}, 1, 1),
    makeEvent(7, 'run.consequence_recorded', {}, 1, 1),
    makeEvent(8, 'run.terminalized', { status: 'failed' }, 1, 1),
    makeEvent(9, 'ticket.updated', { status: 'failed', updatedAt: '2026-01-01T00:00:03Z' })
  ]);
  const tickets = [{ id: 1, status: 'open' }];
  const runs = [{ id: 1, ticketId: 1, status: 'running' }];
  writeDataDir(dir, events, tickets, runs);
  const report = await runProjection(dir, true);
  const tkt = report.tickets[0];

  assert(tkt.status === 'failed', `failed run should derive status=failed, got ${tkt.status}`);
  assert(tkt.failureState === 'failed', `failureState should be failed, got ${tkt.failureState}`);
  assert(tkt.totalFailedRuns === 1, `totalFailedRuns should be 1, got ${tkt.totalFailedRuns}`);

  fs.rmSync(dir, { recursive: true, force: true });
  return { name: 'failed-run', passed: true, detail: `status=${tkt.status}, failureState=${tkt.failureState}` };
}

async function scenario6MultipleRuns() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rebuild-tkt-6-'));
  const events = buildHashChain([
    // Ticket created
    makeEvent(0, 'ticket.created', { status: 'open', assignmentTargetType: 'agent', assignmentTargetId: 1, assignmentMode: 'individual', executionMode: 'agent', capabilityType: 'directAction', capabilityId: 'agent-selected-actions', createdBy: 'admin', createdAt: '2026-01-01T00:00:00Z' }),
    // Run 1 (older, failed)
    makeEvent(1, 'run.created', { agentId: 1, agentName: 'TestAgent', status: 'pending', executionMode: 'agent', capabilityType: 'directAction', capabilityId: 'agent-selected-actions', ticketId: 1 }, 1, 1),
    makeEvent(2, 'run.started', { status: 'running', agentId: 1, agentName: 'TestAgent', startedAt: '2026-01-01T00:00:01Z' }, 1, 1),
    makeEvent(3, 'run.terminalized', { status: 'failed' }, 1, 1),
    // Ticket reopened
    makeEvent(4, 'ticket.updated', { status: 'open', updatedAt: '2026-01-01T00:00:02Z' }),
    // Run 2 (newer, completed)
    makeEvent(5, 'run.created', { agentId: 1, agentName: 'TestAgent', status: 'pending', executionMode: 'agent', capabilityType: 'directAction', capabilityId: 'agent-selected-actions', ticketId: 1 }, 1, 2),
    makeEvent(6, 'run.started', { status: 'running', agentId: 1, agentName: 'TestAgent', startedAt: '2026-01-01T00:00:03Z' }, 1, 2),
    makeEvent(7, 'run.terminalized', { status: 'completed' }, 1, 2),
    makeEvent(8, 'ticket.updated', { status: 'completed', updatedAt: '2026-01-01T00:00:04Z' })
  ]);
  const tickets = [{ id: 1, status: 'completed' }];
  const runs = [{ id: 1, ticketId: 1, status: 'failed' }, { id: 2, ticketId: 1, status: 'completed' }];
  writeDataDir(dir, events, tickets, runs);
  const report = await runProjection(dir, false);
  const tkt = report.tickets[0];

  assert(tkt.totalRuns === 2, `totalRuns should be 2, got ${tkt.totalRuns}`);
  assert(tkt.totalFailedRuns === 1, `totalFailedRuns should be 1, got ${tkt.totalFailedRuns}`);
  assert(tkt.totalCompletedRuns === 1, `totalCompletedRuns should be 1, got ${tkt.totalCompletedRuns}`);
  assert(tkt.latestRunId === 2, `latestRunId should be 2 (newer completed), got ${tkt.latestRunId}`);
  assert(tkt.latestRunTerminalStatus === 'completed', `latestRunTerminalStatus should be completed, got ${tkt.latestRunTerminalStatus}`);
  assert(tkt.status === 'completed', `status should be completed (latest run), got ${tkt.status}`);

  fs.rmSync(dir, { recursive: true, force: true });
  return { name: 'multiple-runs', passed: true, detail: `runs=${tkt.totalRuns}, latest=${tkt.latestRunId}, status=${tkt.status}` };
}

async function scenario7LegacyTerminal() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rebuild-tkt-7-'));
  const events = buildHashChain([
    makeEvent(0, 'ticket.created', { status: 'open', assignmentTargetType: 'agent', assignmentTargetId: 1, assignmentMode: 'individual', executionMode: 'agent', capabilityType: 'directAction', capabilityId: 'agent-selected-actions', createdBy: 'admin', createdAt: '2026-01-01T00:00:00Z' }),
    makeEvent(1, 'ticket.updated', { status: 'in_progress', updatedAt: '2026-01-01T00:00:01Z' }),
    makeEvent(2, 'run.created', { agentId: 1, agentName: 'TestAgent', status: 'pending', executionMode: 'agent', capabilityType: 'directAction', capabilityId: 'agent-selected-actions', ticketId: 1 }, 1, 1),
    makeEvent(3, 'run.started', { status: 'running', agentId: 1, agentName: 'TestAgent', startedAt: '2026-01-01T00:00:02Z' }, 1, 1),
    makeEvent(4, 'run.completed', { status: 'completed' }, 1, 1),
    makeEvent(5, 'ticket.updated', { status: 'completed', updatedAt: '2026-01-01T00:00:03Z' })
  ]);
  const tickets = [{ id: 1, status: 'completed' }];
  const runs = [{ id: 1, ticketId: 1, status: 'completed' }];
  writeDataDir(dir, events, tickets, runs);
  const report = await runProjection(dir, true);
  const tkt = report.tickets[0];

  assert(tkt.status === 'completed', `legacy run.completed should derive status=completed, got ${tkt.status}`);
  assert(tkt.latestRunTerminalStatus === 'completed', `latestRunTerminalStatus should be completed, got ${tkt.latestRunTerminalStatus}`);
  assert(tkt.totalCompletedRuns === 1, `totalCompletedRuns should be 1, got ${tkt.totalCompletedRuns}`);

  fs.rmSync(dir, { recursive: true, force: true });
  return { name: 'legacy-terminal', passed: true, detail: `status=${tkt.status}, latestRunStatus=${tkt.latestRunTerminalStatus}` };
}

// ── main ──────────────────────────────────────────────────────────

async function main() {
  const startedAt = Date.now();
  console.log('Rebuild Tickets Projection Test Suite');
  console.log('='.repeat(70));

  console.log('\n[Setup] Generating clean multi-step fixture...');
  const cleanFixture = await generateFixture();
  console.log(`  Fixture: ${cleanFixture}`);

  const results = [];

  results.push(await scenario1CleanMatch(cleanFixture));
  results.push(await scenario2DeletedTicketsJson(cleanFixture));
  results.push(await scenario3CorruptedStatus(cleanFixture));
  results.push(await scenario4TerminalizedRun());
  results.push(await scenario5FailedInterruptedRun());
  results.push(await scenario6MultipleRuns());
  results.push(await scenario7LegacyTerminal());

  try { fs.rmSync(cleanFixture, { recursive: true, force: true }); } catch (_) {}

  console.log('\n' + '='.repeat(70));
  console.log('Rebuild Tickets Projection Test Results');
  console.log('='.repeat(70));
  let passed = 0, failed = 0;
  for (const r of results) {
    if (r.passed) passed++; else failed++;
    console.log(`  ${r.passed ? '✓' : '✗'} ${r.name}: ${r.detail}`);
  }
  console.log(`\nTotal: ${results.length} | Passed: ${passed} | Failed: ${failed}`);
  console.log(`Duration: ${Date.now() - startedAt}ms`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error(err.stack || err.message);
  process.exit(1);
});

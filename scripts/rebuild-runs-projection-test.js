#!/usr/bin/env node
// Rebuild Runs Projection Test — 6 scenarios proving events are authoritative.
//
// 1. Clean projection matches runs.json materially
// 2. runs.json deleted → projection still reconstructs
// 3. runs.json status corrupted → projection reports drift
// 4. terminalized event present → status derived from event
// 5. execution_completed without terminalized → reconcilable
// 6. snapshot_finalized without terminalized → not final

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { sealCurrentRunEventChains } = require('./current-event-fixture');

const ROOT = path.resolve(__dirname, '..');
const REBUILDER = path.join(ROOT, 'scripts', 'rebuild-runs-projection.js');

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

function makeEvent(seq, type, payload = {}) {
  return { type, runId: 1, ticketId: 1, seq, ts: new Date().toISOString(), payload };
}

function buildHashChain(events) {
  return sealCurrentRunEventChains(events);
}

function writeDataDir(dir, events, runs = null, opHistory = []) {
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(path.join(dir, 'replay-snapshots'), { recursive: true });
  if (runs) writeJson(path.join(dir, 'runs.json'), runs);
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

// ── assertions ────────────────────────────────────────────────────

function assert(value, msg) {
  if (!value) throw new Error(`ASSERTION FAILED: ${msg}`);
}

// ── scenarios ─────────────────────────────────────────────────────

async function scenario1CleanMatch(fixture) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rebuild-proj-1-'));
  copyDir(fixture, dir);
  const report = await runProjection(dir, true);
  const runs = report.runs;
  const comparison = report.comparison;

  assert(runs.length > 0, 'Should reconstruct at least one run');
  assert(comparison, 'Should have comparison data');
  assert(comparison.match === true, `Clean projection should match runs.json, but had ${comparison.driftCount} drifts: ${JSON.stringify(comparison.drifts)}`);

  fs.rmSync(dir, { recursive: true, force: true });
  return { name: 'clean-match', passed: true, detail: `${runs.length} runs match` };
}

async function scenario2DeletedRunsJson(fixture) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rebuild-proj-2-'));
  copyDir(fixture, dir);
  fs.unlinkSync(path.join(dir, 'runs.json'));
  const report = await runProjection(dir, false);

  assert(report.runs.length > 0, 'Should reconstruct runs even without runs.json');
  assert(!report.comparison, 'Should not have comparison mode');

  fs.rmSync(dir, { recursive: true, force: true });
  return { name: 'deleted-runs', passed: true, detail: `${report.runs.length} runs reconstructed` };
}

async function scenario3CorruptedStatus(fixture) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rebuild-proj-3-'));
  copyDir(fixture, dir);
  const runs = readJson(path.join(dir, 'runs.json'));
  const originalStatus = runs[0].status;
  runs[0].status = 'interrupted'; // corrupt
  writeJson(path.join(dir, 'runs.json'), runs);
  const report = await runProjection(dir, true);

  assert(report.comparison, 'Should have comparison');
  assert(report.comparison.match === false, 'Should report drift');
  const drift = report.comparison.drifts.find(d => d.runId === runs[0].id);
  assert(drift, 'Should have drift for corrupted run');
  const statusDiff = drift.diffs.find(d => d.field === 'status');
  assert(statusDiff, 'Should have status drift');
  assert(statusDiff.reconstructed !== 'interrupted', 'Projection should not match corrupted status');

  fs.rmSync(dir, { recursive: true, force: true });
  return { name: 'corrupted-status', passed: true, detail: `drift detected: status ${statusDiff.reconstructed} vs corrupted ${statusDiff.actual}` };
}

async function scenario4TerminalizedEvent() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rebuild-proj-4-'));
  const events = buildHashChain([
    makeEvent(0, 'run.created', { agentId: 1, agentName: 'TestAgent' }),
    makeEvent(1, 'run.started', { status: 'running', agentId: 1, agentName: 'TestAgent', startedAt: '2026-01-01T00:00:00Z' }),
    makeEvent(2, 'run.execution_completed', { status: 'completed' }),
    makeEvent(3, 'run.snapshot_finalized', { status: 'completed' }),
    makeEvent(4, 'run.evaluation_completed'),
    makeEvent(5, 'run.consequence_recorded'),
    makeEvent(6, 'run.terminalized', { status: 'completed' })
  ]);
  const runs = [{ id: 1, ticketId: 1, status: 'running' }]; // intentionally stale
  writeDataDir(dir, events, runs);
  const report = await runProjection(dir, true);
  const run = report.runs[0];

  assert(run.status === 'completed', `terminalized should derive status=completed, got ${run.status}`);
  assert(run.lifecyclePhase === 'terminalized', `phase should be terminalized, got ${run.lifecyclePhase}`);
  assert(run.isReconcilable === false, 'terminalized run should not be reconcilable');

  fs.rmSync(dir, { recursive: true, force: true });
  return { name: 'terminalized-event', passed: true, detail: `status=${run.status}, phase=${run.lifecyclePhase}` };
}

async function scenario5ExecutionCompletedNotTerminal() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rebuild-proj-5-'));
  const events = buildHashChain([
    makeEvent(0, 'run.created', { agentId: 1, agentName: 'TestAgent' }),
    makeEvent(1, 'run.started', { status: 'running', agentId: 1, agentName: 'TestAgent', startedAt: '2026-01-01T00:00:00Z' }),
    makeEvent(2, 'run.execution_completed', { status: 'completed' })
  ]);
  const runs = [{ id: 1, ticketId: 1, status: 'running' }];
  writeDataDir(dir, events, runs);
  const report = await runProjection(dir, false);
  const run = report.runs[0];

  assert(run.status === 'running', `execution_completed without terminalized should be running, got ${run.status}`);
  assert(run.lifecyclePhase === 'execution_completed', `phase should be execution_completed, got ${run.lifecyclePhase}`);
  assert(run.isReconcilable === true, 'execution_completed without terminalized should be reconcilable');

  fs.rmSync(dir, { recursive: true, force: true });
  return { name: 'execution-not-terminal', passed: true, detail: `status=${run.status}, reconcilable=${run.isReconcilable}` };
}

async function scenario6SnapshotFinalizedNotTerminal() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rebuild-proj-6-'));
  const events = buildHashChain([
    makeEvent(0, 'run.created', { agentId: 1, agentName: 'TestAgent' }),
    makeEvent(1, 'run.started', { status: 'running', agentId: 1, agentName: 'TestAgent', startedAt: '2026-01-01T00:00:00Z' }),
    makeEvent(2, 'run.execution_completed', { status: 'completed' }),
    makeEvent(3, 'run.snapshot_finalized', { status: 'completed' }),
    makeEvent(4, 'run.evaluation_completed')
  ]);
  const runs = [{ id: 1, ticketId: 1, status: 'running' }];
  writeDataDir(dir, events, runs);
  const report = await runProjection(dir, false);
  const run = report.runs[0];

  assert(run.status === 'running', `snapshot_finalized without terminalized should be running, got ${run.status}`);
  assert(run.lifecyclePhase === 'evaluation_completed', `phase should be evaluation_completed, got ${run.lifecyclePhase}`);
  assert(run.hasSnapshotFinalized === true, 'should have snapshot finalized');
  assert(run.isReconcilable === true, 'should be reconcilable');

  fs.rmSync(dir, { recursive: true, force: true });
  return { name: 'snapshot-not-terminal', passed: true, detail: `status=${run.status}, phase=${run.lifecyclePhase}` };
}

// ── main ──────────────────────────────────────────────────────────

async function main() {
  const startedAt = Date.now();
  console.log('Rebuild Runs Projection Test Suite');
  console.log('='.repeat(70));

  // Generate clean fixture once for scenarios 1-3
  console.log('\n[Setup] Generating clean multi-step fixture...');
  const cleanFixture = await generateFixture();
  const manifest = readJson(path.join(cleanFixture, 'manifest.json'));
  console.log(`  Fixture: ${cleanFixture}`);
  console.log(`  Run: ${manifest.runId}`);

  const results = [];

  results.push(await scenario1CleanMatch(cleanFixture));
  results.push(await scenario2DeletedRunsJson(cleanFixture));
  results.push(await scenario3CorruptedStatus(cleanFixture));
  results.push(await scenario4TerminalizedEvent());
  results.push(await scenario5ExecutionCompletedNotTerminal());
  results.push(await scenario6SnapshotFinalizedNotTerminal());
  try { fs.rmSync(cleanFixture, { recursive: true, force: true }); } catch (_) {}

  console.log('\n' + '='.repeat(70));
  console.log('Rebuild Runs Projection Test Results');
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

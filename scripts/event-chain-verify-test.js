#!/usr/bin/env node
// Event Chain Verify Test — 9 scenarios proving current-schema chain integrity.
//
// 1. clean chain passes
// 2. modified payload fails
// 3. deleted middle event fails
// 4. inserted event fails
// 5. reordered events fail
// 6. broken prevHash fails
// 7. replay fixture chain verifies
// 8. modified final event fails against its stored hash
// 9. modified forensic metadata fails

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { RUN_EVENT_SCHEMA_VERSION, computeRunEventHash } = require('../runtime/event-integrity');

const ROOT = path.resolve(__dirname, '..');
const VERIFIER = path.join(ROOT, 'scripts', 'event-chain-verify.js');
const FIXTURE_GENERATOR = path.join(ROOT, 'scripts', 'replay-fixture-generator.js');

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

function assert(value, msg) {
  if (!value) throw new Error(`ASSERTION FAILED: ${msg}`);
}

function makeEvent(seq, type, payload = {}, runId = 1, ticketId = 1) {
  return {
    schemaVersion: RUN_EVENT_SCHEMA_VERSION,
    id: `event-${runId}-${seq}-${type}`,
    type,
    runId,
    ticketId,
    seq,
    ts: new Date(Date.UTC(2030, 0, 1, 0, 0, seq)).toISOString(),
    payload,
    stepId: null
  };
}

function buildHashChain(events) {
  let prevHash = null;
  for (const ev of events) {
    ev.prevHash = prevHash;
    ev.hash = computeRunEventHash(ev);
    prevHash = ev.hash;
  }
  return events;
}

function writeEvents(dir, events) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'events.jsonl'), events.map(e => JSON.stringify(e)).join('\n') + '\n');
  writeJson(path.join(dir, 'runs.json'), []);
  writeJson(path.join(dir, 'tickets.json'), []);
  writeJson(path.join(dir, 'operation-history.json'), []);
}

function runVerifier(dataDir, strict = false, runId = null) {
  return new Promise((resolve, reject) => {
    const args = [VERIFIER, '--data-dir', dataDir];
    if (strict) args.push('--strict');
    if (runId != null) { args.push('--run-id', String(runId)); }
    const child = spawn(process.execPath, args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    child.stdout.on('data', chunk => { stdout += chunk.toString(); });
    child.on('close', code => {
      try {
        const report = JSON.parse(stdout);
        resolve({ report, exitCode: code });
      } catch (e) {
        reject(new Error(`verifier parse error: ${stdout.substring(0, 200)}`));
      }
    });
  });
}

function generateFixture() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [FIXTURE_GENERATOR, 'multiStep'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    let s = '';
    child.stdout.on('data', c => { s += c.toString(); });
    child.on('close', code => {
      if (code !== 0) reject(new Error('Fixture generator failed'));
      else { const m = s.match(/FIXTURE_DIR=(.+)/); resolve(m ? m[1].trim() : null); }
    });
  });
}

// ── scenarios ─────────────────────────────────────────────────────

async function scenario1CleanChain() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chain-1-'));
  const events = buildHashChain([
    makeEvent(0, 'run.created', { agentId: 1 }),
    makeEvent(1, 'run.started', { agentId: 1 }),
    makeEvent(2, 'run.execution_completed', { status: 'completed' }),
    makeEvent(3, 'run.terminalized', { status: 'completed' })
  ]);
  writeEvents(dir, events);
  const { report } = await runVerifier(dir);

  assert(report.chainValid === true, `clean chain should be valid, got ${report.runsBroken} broken runs`);
  assert(report.runsVerified === 1, `should verify 1 run, got ${report.runsVerified}`);
  assert(report.errors.length === 0, `should have no errors, got ${JSON.stringify(report.errors)}`);

  fs.rmSync(dir, { recursive: true, force: true });
  return { name: 'clean-chain', passed: true, detail: `valid, ${report.runsVerified} run(s)` };
}

async function scenario2ModifiedPayload() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chain-2-'));
  const events = buildHashChain([
    makeEvent(0, 'run.created', { agentId: 1 }),
    makeEvent(1, 'run.started', { agentId: 1 }),
    makeEvent(2, 'run.terminalized', { status: 'completed' })
  ]);
  // Tamper: modify payload of event at seq 1
  events[1].payload = { agentId: 99 };
  writeEvents(dir, events);
  const { report, exitCode } = await runVerifier(dir, true);

  assert(exitCode === 1, 'strict mode should exit 1');
  assert(report.chainValid === false, 'should detect broken chain');
  const runReport = Object.values(report.runs)[0];
  assert(runReport, 'should have run report');
  const hashError = runReport.errors.find(e => e.type === 'hash_mismatch');
  assert(hashError, `should have hash_mismatch error, got ${JSON.stringify(runReport.errors)}`);
  assert(hashError.seq === 1, `error should identify the modified event at seq 1, got ${hashError.seq}`);

  fs.rmSync(dir, { recursive: true, force: true });
  return { name: 'modified-payload', passed: true, detail: `detected at seq ${hashError.seq}` };
}

async function scenario3DeletedMiddleEvent() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chain-3-'));
  const events = buildHashChain([
    makeEvent(0, 'run.created', { agentId: 1 }),
    makeEvent(1, 'run.started', { agentId: 1 }),
    makeEvent(2, 'run.execution_completed', { status: 'completed' }),
    makeEvent(3, 'run.terminalized', { status: 'completed' })
  ]);
  // Delete event at seq 1 (run.started)
  const tampered = events.filter(e => e.seq !== 1);
  // Rebuild chain after deletion (this will create a broken chain)
  // Actually, just removing the event creates a seq gap
  writeEvents(dir, tampered);
  const { report } = await runVerifier(dir);

  assert(report.chainValid === false, 'should detect broken chain after deletion');
  const runReport = Object.values(report.runs)[0];
  const gapError = runReport.errors.find(e => e.type === 'seq_gap');
  assert(gapError, `should have seq_gap error, got ${JSON.stringify(runReport.errors)}`);

  fs.rmSync(dir, { recursive: true, force: true });
  return { name: 'deleted-event', passed: true, detail: `seq gap detected` };
}

async function scenario4InsertedEvent() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chain-4-'));
  const events = buildHashChain([
    makeEvent(0, 'run.created', { agentId: 1 }),
    makeEvent(1, 'run.started', { agentId: 1 }),
    makeEvent(2, 'run.terminalized', { status: 'completed' })
  ]);
  // Insert a duplicate seq
  const duplicate = { ...events[1] };
  duplicate.seq = 1; // same seq
  const tampered = [...events, duplicate];
  writeEvents(dir, tampered);
  const { report } = await runVerifier(dir);

  assert(report.chainValid === false, 'should detect broken chain after insertion');
  const runReport = Object.values(report.runs)[0];
  const dupError = runReport.errors.find(e => e.type === 'duplicate_seq');
  assert(dupError, `should have duplicate_seq error, got ${JSON.stringify(runReport.errors)}`);

  fs.rmSync(dir, { recursive: true, force: true });
  return { name: 'inserted-event', passed: true, detail: `duplicate seq detected` };
}

async function scenario5ReorderedEvents() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chain-5-'));
  const events = buildHashChain([
    makeEvent(0, 'run.created', { agentId: 1 }),
    makeEvent(1, 'run.started', { agentId: 1 }),
    makeEvent(2, 'run.terminalized', { status: 'completed' })
  ]);
  // Reorder: swap seq 0 and 1
  events[0].seq = 1;
  events[1].seq = 0;
  // Need to recompute prevHash to match new order
  events[0].prevHash = null;
  events[0].hash = computeRunEventHash(events[0]);
  events[1].prevHash = events[0].hash;
  events[1].hash = computeRunEventHash(events[1]);
  events[2].prevHash = events[1].hash;
  events[2].hash = computeRunEventHash(events[2]);
  writeEvents(dir, events);
  const { report } = await runVerifier(dir);

  assert(report.chainValid === false, 'should detect broken chain after reorder');
  const runReport = Object.values(report.runs)[0];
  const orderError = runReport.errors.find(e => ['first_seq', 'prevhash_mismatch'].includes(e.type));
  assert(orderError, `should have an order/linkage error, got ${JSON.stringify(runReport.errors)}`);

  fs.rmSync(dir, { recursive: true, force: true });
  return { name: 'reordered-events', passed: true, detail: `prevhash mismatch detected` };
}

async function scenario6BrokenPrevHash() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chain-6-'));
  const events = buildHashChain([
    makeEvent(0, 'run.created', { agentId: 1 }),
    makeEvent(1, 'run.started', { agentId: 1 }),
    makeEvent(2, 'run.terminalized', { status: 'completed' })
  ]);
  // Corrupt prevHash of seq 1
  events[1].prevHash = 'deadbeef';
  writeEvents(dir, events);
  const { report } = await runVerifier(dir);

  assert(report.chainValid === false, 'should detect broken prevHash');
  const runReport = Object.values(report.runs)[0];
  const prevError = runReport.errors.find(e => e.type === 'prevhash_mismatch');
  assert(prevError, `should have prevhash_mismatch error, got ${JSON.stringify(runReport.errors)}`);

  fs.rmSync(dir, { recursive: true, force: true });
  return { name: 'broken-prevhash', passed: true, detail: `prevhash mismatch at seq ${prevError.seq}` };
}

async function scenario7ReplayFixture(fixture) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chain-7-'));
  copyDir(fixture, dir);
  const { report } = await runVerifier(dir);

  assert(report.chainValid === true, `fixture chain should be valid, got ${report.runsBroken} broken runs`);
  assert(report.runsVerified >= 1, `should verify at least 1 run, got ${report.runsVerified}`);

  fs.rmSync(dir, { recursive: true, force: true });
  return { name: 'replay-fixture', passed: true, detail: `${report.runsVerified} run(s) verified` };
}

async function scenario8ModifiedFinalEvent() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chain-8-'));
  const events = buildHashChain([
    makeEvent(0, 'run.created', { agentId: 1 }),
    makeEvent(1, 'run.started', { agentId: 1 }),
    makeEvent(2, 'run.terminalized', { status: 'completed' })
  ]);
  events[2].payload.status = 'failed';
  writeEvents(dir, events);
  const { report, exitCode } = await runVerifier(dir, true);

  assert(exitCode === 1, 'strict mode should reject a modified final event');
  const runReport = Object.values(report.runs)[0];
  const hashError = runReport.errors.find(error => error.type === 'hash_mismatch' && error.seq === 2);
  assert(hashError, `should detect the final stored hash mismatch, got ${JSON.stringify(runReport.errors)}`);

  fs.rmSync(dir, { recursive: true, force: true });
  return { name: 'modified-final-event', passed: true, detail: 'stored final hash mismatch detected' };
}

async function scenario9ModifiedMetadata() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chain-9-'));
  const events = buildHashChain([
    makeEvent(0, 'run.created', { agentId: 1 }),
    makeEvent(1, 'run.started', { agentId: 1 }),
    makeEvent(2, 'run.terminalized', { status: 'completed' })
  ]);
  events[1].ts = '2031-01-01T00:00:00.000Z';
  writeEvents(dir, events);
  const { report, exitCode } = await runVerifier(dir, true);

  const runReport = Object.values(report.runs)[0];
  assert(exitCode === 1, 'strict mode should reject modified event metadata');
  assert(runReport.errors.some(error => error.type === 'hash_mismatch' && error.seq === 1), `timestamp tamper was not detected: ${JSON.stringify(runReport.errors)}`);

  fs.rmSync(dir, { recursive: true, force: true });
  return { name: 'modified-metadata', passed: true, detail: 'timestamp tamper detected' };
}

// ── main ──────────────────────────────────────────────────────────

async function main() {
  const startedAt = Date.now();
  console.log('Event Chain Verify Test Suite');
  console.log('='.repeat(70));

  console.log('\n[Setup] Generating clean multi-step fixture...');
  const cleanFixture = await generateFixture();
  console.log(`  Fixture: ${cleanFixture}`);

  const results = [];

  results.push(await scenario1CleanChain());
  results.push(await scenario2ModifiedPayload());
  results.push(await scenario3DeletedMiddleEvent());
  results.push(await scenario4InsertedEvent());
  results.push(await scenario5ReorderedEvents());
  results.push(await scenario6BrokenPrevHash());
  results.push(await scenario7ReplayFixture(cleanFixture));
  results.push(await scenario8ModifiedFinalEvent());
  results.push(await scenario9ModifiedMetadata());

  try { fs.rmSync(cleanFixture, { recursive: true, force: true }); } catch (_) {}

  console.log('\n' + '='.repeat(70));
  console.log('Event Chain Verify Test Results');
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

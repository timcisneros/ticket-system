#!/usr/bin/env node
// Scheduler tick suppression test — verifies event-emission hygiene for the
// runtime scheduler's idle heartbeat.
//
// Contract under test (see docs/OPERATIONAL_TELEMETRY.md):
//   scheduler.tick is emitted ONLY when the scheduler observes pending work.
//   Idle ticks (pendingRuns.length === 0) are no-op heartbeat telemetry and
//   are NOT written to the append-only evidence log.
//
// The suppression lives at the writer/source (runtime/scheduler.js), not in a
// generic appendEvent boundary. These tests inject a non-filtering appendEvent
// collector, so any suppression observed here is the scheduler's own decision.

const { createRuntimeScheduler } = require('../runtime/scheduler');

function assert(value, msg) {
  if (!value) throw new Error(`ASSERTION FAILED: ${msg}`);
}

function assertEqual(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error(`ASSERTION FAILED: ${msg}\n  expected: ${expected}\n  actual:   ${actual}`);
  }
}

// Build a scheduler with injected fakes. `appendEvent` is a plain collector
// with NO filtering, so the scheduler is solely responsible for deciding what
// to emit.
function makeHarness({ pendingRuns = [], canStart = false, leaseAcquires = true } = {}) {
  const events = [];
  const startedRuns = [];
  const logs = [];

  const scheduler = createRuntimeScheduler({
    intervalMs: 1000,
    readRuns: () => pendingRuns.map(run => ({ ...run })),
    readLogs: () => logs.slice(),
    appendRunLog: (run, type, message) => logs.push({ runId: run.id, type, message }),
    appendEvent: event => { events.push(event); return event; },
    canStartRunNow: () => canStart,
    acquireRunLease: runId => (leaseAcquires ? pendingRuns.find(r => r.id === runId) : null),
    expireStaleRunLeases: () => {},
    isRunStarting: () => false,
    isRunActiveInMemory: () => false,
    runner: { startRun: run => startedRuns.push(run) }
  });

  return { scheduler, events, startedRuns, logs };
}

function typesOf(events) {
  return events.map(e => e.type);
}

// ── Test 1: Idle tick is suppressed ──────────────────────────────
function testIdleTickSuppressed() {
  const { scheduler, events } = makeHarness({ pendingRuns: [] });
  scheduler.tick();

  const ticks = events.filter(e => e.type === 'scheduler.tick');
  assertEqual(ticks.length, 0, 'idle tick (pendingRuns === 0) must not append scheduler.tick');
  assertEqual(events.length, 0, 'idle tick must not append any event at all');

  console.log('  ✓ idle-tick-suppressed: no scheduler.tick written when no pending work');
}

// ── Test 2: Non-idle tick still emits scheduler.tick ─────────────
function testNonIdleTickEmitted() {
  // Pending run that cannot start yet (capacity blocked) so it stays observable.
  const run = { id: 7, ticketId: 70, status: 'pending', createdAt: '2026-01-01T00:00:00Z' };
  const { scheduler, events } = makeHarness({ pendingRuns: [run], canStart: false });
  scheduler.tick();

  const ticks = events.filter(e => e.type === 'scheduler.tick');
  assertEqual(ticks.length, 1, 'non-idle tick must append exactly one scheduler.tick');
  assertEqual(ticks[0].payload.pendingRuns, 1, 'scheduler.tick payload must carry the observed pending count');

  console.log('  ✓ non-idle-tick-emitted: scheduler.tick written when pendingRuns > 0');
}

// ── Test 3: Meaningful scheduler/run events still append ─────────
function testMeaningfulEventsPreserved() {
  // Capacity-blocked pending run: should still produce scheduler.tick,
  // scheduler.capacity_blocked, run.queued, and a queued run log.
  const run = { id: 9, ticketId: 90, status: 'pending', createdAt: '2026-01-01T00:00:00Z' };
  const { scheduler, events, logs } = makeHarness({ pendingRuns: [run], canStart: false });
  scheduler.tick();

  const types = typesOf(events);
  assert(types.includes('scheduler.tick'), 'capacity-blocked tick should include scheduler.tick');
  assert(types.includes('scheduler.capacity_blocked'), 'capacity-blocked run should emit scheduler.capacity_blocked');
  assert(types.includes('run.queued'), 'capacity-blocked run should emit run.queued');
  assert(logs.some(l => l.type === 'run:queued'), 'capacity-blocked run should append run:queued log');

  // Selected run: should produce scheduler.tick + scheduler.run_selected and start.
  const ready = { id: 11, ticketId: 110, status: 'pending', agentId: 5, createdAt: '2026-01-01T00:00:00Z' };
  const sel = makeHarness({ pendingRuns: [ready], canStart: true, leaseAcquires: true });
  sel.scheduler.tick();
  const selTypes = typesOf(sel.events);
  assert(selTypes.includes('scheduler.tick'), 'selecting tick should include scheduler.tick');
  assert(selTypes.includes('scheduler.run_selected'), 'startable run should emit scheduler.run_selected');
  assertEqual(sel.startedRuns.length, 1, 'startable run should be dispatched to runner.startRun');

  console.log('  ✓ meaningful-events-preserved: capacity_blocked, run.queued, run_selected still append');
}

// ── Test 4: Suppression is source-specific, not a generic boundary ─
function testSuppressionIsSourceSpecific() {
  // A pending run that is "already starting" produces a scheduler.run_skipped
  // event whose payload is a small reason object. A broad "drop events with
  // trivial payloads" filter would wrongly suppress it. The scheduler must
  // still emit it — proving suppression is scoped to the idle tick alone.
  const run = { id: 13, ticketId: 130, status: 'pending', createdAt: '2026-01-01T00:00:00Z' };
  const events = [];
  const scheduler = createRuntimeScheduler({
    intervalMs: 1000,
    readRuns: () => [{ ...run }],
    readLogs: () => [],
    appendRunLog: () => {},
    appendEvent: event => { events.push(event); return event; },
    canStartRunNow: () => true,
    acquireRunLease: () => run,
    expireStaleRunLeases: () => {},
    isRunStarting: () => true, // force the run_skipped path
    isRunActiveInMemory: () => false,
    runner: { startRun: () => { throw new Error('should not start a run that is already starting'); } }
  });
  scheduler.tick();

  const types = typesOf(events);
  assert(types.includes('scheduler.tick'), 'observable run should still emit scheduler.tick');
  const skipped = events.find(e => e.type === 'scheduler.run_skipped');
  assert(skipped, 'already-starting run must still emit scheduler.run_skipped (not suppressed)');
  assertEqual(skipped.payload.reason, 'already_starting', 'run_skipped should preserve its reason payload');

  console.log('  ✓ suppression-source-specific: meaningful small-payload events are not suppressed');
}

// ── Main ─────────────────────────────────────────────────────────
function main() {
  console.log('Scheduler Tick Suppression Test Suite');
  console.log('='.repeat(70));

  const tests = [
    testIdleTickSuppressed,
    testNonIdleTickEmitted,
    testMeaningfulEventsPreserved,
    testSuppressionIsSourceSpecific
  ];

  let passed = 0;
  let failed = 0;

  for (const test of tests) {
    try {
      test();
      passed++;
    } catch (err) {
      failed++;
      console.log(`  ✗ ${test.name}: ${err.message}`);
    }
  }

  console.log('='.repeat(70));
  console.log(`Results: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    process.exit(1);
  }
}

main();

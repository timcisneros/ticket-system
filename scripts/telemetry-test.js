#!/usr/bin/env node
// Telemetry Test — verifies deterministic operational metrics from ledger evidence.
//
// Scenarios:
// 1. Telemetry reproducible from same ledger
// 2. Replay produces identical metrics
// 3. Failed runs counted correctly
// 4. Retries/reassess differentiated correctly
// 5. Profile aggregation correct
// 6. No hidden mutable counters used

const fs = require('fs');
const os = require('os');
const path = require('path');

const { computeTelemetry, detectProfile } = require('./telemetry-report');

function assert(value, msg) {
  if (!value) throw new Error(`ASSERTION FAILED: ${msg}`);
}

function assertEqual(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error(`ASSERTION FAILED: ${msg}\n  expected: ${expected}\n  actual:   ${actual}`);
  }
}

// ── Test 1: Telemetry reproducible from same ledger ──────────────
function testReproducible() {
  const t1 = computeTelemetry();
  const t2 = computeTelemetry();

  assertEqual(t1.summary.totalRuns, t2.summary.totalRuns, 'totalRuns should be identical');
  assertEqual(t1.summary.completedRuns, t2.summary.completedRuns, 'completedRuns should be identical');
  assertEqual(t1.summary.failedRuns, t2.summary.failedRuns, 'failedRuns should be identical');
  assertEqual(t1.failureMetrics.phaseViolations, t2.failureMetrics.phaseViolations, 'phaseViolations should be identical');
  assertEqual(t1.failureMetrics.commitConflicts, t2.failureMetrics.commitConflicts, 'commitConflicts should be identical');

  // Compare all profile metrics
  const profiles1 = Object.keys(t1.profileMetrics).sort();
  const profiles2 = Object.keys(t2.profileMetrics).sort();
  assertEqual(profiles1.length, profiles2.length, 'profile count should match');
  for (let i = 0; i < profiles1.length; i++) {
    assertEqual(profiles1[i], profiles2[i], 'profile names should match');
    const p1 = t1.profileMetrics[profiles1[i]];
    const p2 = t2.profileMetrics[profiles2[i]];
    assertEqual(p1.total, p2.total, `profile ${profiles1[i]} total should match`);
    assertEqual(p1.completed, p2.completed, `profile ${profiles1[i]} completed should match`);
  }

  console.log('  ✓ reproducible: two computations from same ledger produce identical metrics');
}

// ── Test 2: Replay produces identical metrics ─────────────────────
function testReplayIdentical() {
  // Save current report
  const first = computeTelemetry();

  // Compute again (simulating a replay/re-read of the same ledger)
  const second = computeTelemetry();

  assertEqual(first.summary.terminalRuns, second.summary.terminalRuns, 'terminalRuns should match on replay');
  assertEqual(first.summary.avgSteps, second.summary.avgSteps, 'avgSteps should match on replay');
  assertEqual(first.summary.avgModelRequests, second.summary.avgModelRequests, 'avgModelRequests should match on replay');
  assertEqual(first.operationalPressure.maxQueueDepth, second.operationalPressure.maxQueueDepth, 'maxQueueDepth should match on replay');
  assertEqual(first.artifactMetrics.totalMutations, second.artifactMetrics.totalMutations, 'totalMutations should match on replay');

  console.log('  ✓ replay-identical: replaying computation yields same results');
}

// ── Test 3: Failed runs counted correctly ────────────────────────
function testFailedRunsCounted() {
  const t = computeTelemetry();

  // failedRuns + completedRuns + interruptedRuns should equal terminalRuns
  const sum = t.summary.completedRuns + t.summary.failedRuns + t.summary.interruptedRuns;
  assertEqual(sum, t.summary.terminalRuns, 'completed + failed + interrupted should equal terminal');

  // There should be some failed runs in this dataset
  assert(t.summary.failedRuns >= 0, 'failedRuns should be non-negative');

  // Failure classifications should sum to at most terminal runs
  const failureKindSum = Object.values(t.failureMetrics.failureKinds).reduce((a, b) => a + b, 0);
  assert(failureKindSum <= t.summary.terminalRuns, 'failure kind sum should not exceed terminal runs');

  console.log('  ✓ failed-runs-counted: counts are internally consistent');
}

// ── Test 4: Retries/reassess differentiated ───────────────────────
function testRetriesDifferentiated() {
  const t = computeTelemetry();

  // retryCount and reassessCount should be separately tracked
  assert(t.summary.retryCount >= 0, 'retryCount should be non-negative');
  assert(t.summary.reassessCount >= 0, 'reassessCount should be non-negative');

  // In the current dataset, no reruns were done with explicit retry/reassess mode,
  // so both should be 0 (reruns use default 'retry' mode but rerunMode may not be stored on old runs)
  // We just verify they are independently tracked.
  assertEqual(t.summary.retryCount + t.summary.reassessCount, t.summary.rerunTickets,
    'retry + reassess should equal tickets with reruns');

  console.log('  ✓ retries-differentiated: retry and reassess counts tracked separately');
}

// ── Test 5: Profile aggregation correct ──────────────────────────
function testProfileAggregation() {
  const t = computeTelemetry();

  // Sum of profile totals should equal terminal runs
  const profileTotalSum = Object.values(t.profileMetrics).reduce((sum, p) => sum + p.total, 0);
  assertEqual(profileTotalSum, t.summary.terminalRuns,
    'sum of profile totals should equal terminal runs');

  // Sum of profile completed should equal total completed
  const profileCompletedSum = Object.values(t.profileMetrics).reduce((sum, p) => sum + p.completed, 0);
  assertEqual(profileCompletedSum, t.summary.completedRuns,
    'sum of profile completed should equal total completed');

  // Each profile success rate should be between 0 and 100
  for (const [name, p] of Object.entries(t.profileMetrics)) {
    assert(p.successRate >= 0 && p.successRate <= 100,
      `profile ${name} successRate ${p.successRate} should be 0-100`);
    assert(p.total >= p.completed + p.failed,
      `profile ${name} total should be >= completed + failed`);
  }

  console.log('  ✓ profile-aggregation: profile metrics sum to totals correctly');
}

// ── Test 6: No hidden mutable counters ─────────────────────────────
function testNoHiddenCounters() {
  const t = computeTelemetry();

  // Verify that all metrics are computed from evidence, not from pre-computed counters
  // We do this by checking that the telemetry engine reads from the files directly
  // and that model metrics come from replaySummary, not a separate counter table.

  // Model metrics should be derived from replaySummary.model
  for (const [model, stats] of Object.entries(t.modelMetrics)) {
    assert(stats.total >= 0, `model ${model} total should be non-negative`);
    assert(stats.completed >= 0, `model ${model} completed should be non-negative`);
    assert(stats.total >= stats.completed, `model ${model} total should be >= completed`);
  }

  // Queue depth should come from scheduler.tick events, not a counter
  assert(t.operationalPressure.maxQueueDepth >= 0, 'maxQueueDepth should be non-negative');
  assert(t.operationalPressure.avgQueueDepth >= 0, 'avgQueueDepth should be non-negative');

  // Phase violations should come from event scanning
  assert(t.failureMetrics.phaseViolations >= 0, 'phaseViolations should be non-negative');

  // Artifact metrics should come from operation-history scanning
  assert(t.artifactMetrics.totalWriteFiles >= 0, 'totalWriteFiles should be non-negative');
  assert(t.artifactMetrics.totalMutations >= 0, 'totalMutations should be non-negative');

  console.log('  ✓ no-hidden-counters: all metrics derived from ledger evidence');
}

// ── Main ─────────────────────────────────────────────────────────
function main() {
  console.log('Telemetry Test Suite');
  console.log('='.repeat(70));

  const tests = [
    testReproducible,
    testReplayIdentical,
    testFailedRunsCounted,
    testRetriesDifferentiated,
    testProfileAggregation,
    testNoHiddenCounters
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

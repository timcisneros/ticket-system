#!/usr/bin/env node
// Event-reader bounds test — verifies the bounded readers in
// runtime/event-reader.js parse only the lines they need and return correct,
// correctly-ordered results over a large synthetic event log.

const fs = require('fs');
const os = require('os');
const path = require('path');

const { readMatchingEvents, readRecentEvents } = require('../runtime/event-reader');

function assert(value, msg) {
  if (!value) throw new Error(`ASSERTION FAILED: ${msg}`);
}

function assertEqual(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error(`ASSERTION FAILED: ${msg}\n  expected: ${expected}\n  actual:   ${actual}`);
  }
}

// Serialize exactly like the server writer (no whitespace), so the raw-line
// prefilter substrings match real on-disk lines.
function line(event) {
  return JSON.stringify(event);
}

function writeLog(events) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'event-reader-')), 'events.jsonl');
  fs.writeFileSync(file, events.map(line).join('\n') + '\n');
  return file;
}

// Build a large log: many irrelevant idle ticks, plus a handful of run events.
function buildLargeLog() {
  const events = [];
  let n = 0;
  const stamp = i => `2026-06-01T00:00:${String(i % 60).padStart(2, '0')}.000Z`;
  for (let i = 0; i < 5000; i++) {
    events.push({ id: `tick-${i}`, ts: stamp(n++), type: 'scheduler.tick', ticketId: null, runId: null, stepId: null, payload: { pendingRuns: 0 } });
  }
  // Run 7 (ticket 70): two run-scoped events + one ticket-scoped null-runId event.
  events.push({ id: 'r7-a', ts: stamp(n++), type: 'run.started', ticketId: 70, runId: 7, stepId: null, payload: { status: 'started' } });
  events.push({ id: 'r7-t', ts: stamp(n++), type: 'ticket.note', ticketId: 70, runId: null, stepId: null, payload: {} });
  events.push({ id: 'r7-b', ts: stamp(n++), type: 'run.terminalized', ticketId: 70, runId: 7, stepId: null, payload: { status: 'completed' } });
  // Run 8 (ticket 80): must never leak into run 7 lookups.
  events.push({ id: 'r8-a', ts: stamp(n++), type: 'run.started', ticketId: 80, runId: 8, stepId: null, payload: { status: 'started' } });
  // Run 70: its line contains the substring "runId":7 (prefix of 70) — a prefilter
  // false positive that the exact predicate must reject.
  events.push({ id: 'r70-a', ts: stamp(n++), type: 'run.started', ticketId: 700, runId: 70, stepId: null, payload: { status: 'started' } });
  return { file: writeLog(events), total: events.length };
}

// ── Test 1: recent summary does not require a full parse ──────────
function testNoFullParseForRunLookup() {
  const { file, total } = buildLargeLog();
  let parsed = 0;

  // Mirror getRunEvents needles/predicate for run 7 / ticket 70.
  const events = readMatchingEvents(file, {
    needles: ['"runId":7', '"ticketId":70'],
    predicate: e => e.runId === 7 || (e.runId === null && e.ticketId === 70),
    onParse: () => { parsed++; }
  });

  // Returns exactly the run-7 run-scoped events plus the ticket-70 null-runId event.
  const ids = events.map(e => e.id).sort();
  assertEqual(JSON.stringify(ids), JSON.stringify(['r7-a', 'r7-b', 'r7-t']), 'should return only run-7 / ticket-70 events');

  // Only candidate lines were parsed — far fewer than the full 5005-line log.
  assert(parsed < 20, `should parse only candidate lines, parsed=${parsed} of ${total}`);
  assert(parsed >= 3, 'should parse at least the three matching lines');

  console.log(`  ✓ no-full-parse: parsed ${parsed} of ${total} lines for run lookup`);
}

// ── Test 2: run-detail lookup returns only the target run's events ─
function testRunDetailScoped() {
  const { file } = buildLargeLog();
  const events = readMatchingEvents(file, {
    needles: ['"runId":7', '"ticketId":70'],
    predicate: e => e.runId === 7 || (e.runId === null && e.ticketId === 70)
  });

  assert(events.every(e => e.runId === 7 || (e.runId === null && e.ticketId === 70)), 'every returned event belongs to run 7 / ticket 70');
  assert(!events.some(e => e.runId === 8), 'must not include run 8 events');
  assert(!events.some(e => e.runId === 70), 'must not include run 70 events (prefilter false positive rejected by predicate)');
  // File order preserved: started before ticket note before completed.
  assertEqual(JSON.stringify(events.map(e => e.id)), JSON.stringify(['r7-a', 'r7-t', 'r7-b']), 'events returned in file order');

  // Strict run-scoped read excludes the ticket-scoped null-runId event.
  const strict = readMatchingEvents(file, {
    needles: ['"runId":7'],
    predicate: e => e.runId === 7
  });
  assertEqual(JSON.stringify(strict.map(e => e.id)), JSON.stringify(['r7-a', 'r7-b']), 'strict run-scoped read excludes ticket-only events');

  console.log('  ✓ run-detail-scoped: returns only the target run/ticket events');
}

// ── Test 3: bounded recent reader returns newest events in order ──
function testRecentReaderOrder() {
  const events = [];
  for (let i = 1; i <= 10; i++) {
    events.push({ id: `e${i}`, ts: `2026-06-01T00:00:${String(i).padStart(2, '0')}.000Z`, type: 'run.started', ticketId: 1, runId: i, stepId: null, payload: {} });
  }
  const file = writeLog(events);

  const recent3 = readRecentEvents(file, 3);
  assertEqual(JSON.stringify(recent3.map(e => e.id)), JSON.stringify(['e8', 'e9', 'e10']), 'newest 3 in oldest→newest order');

  const recentAll = readRecentEvents(file, 50);
  assertEqual(recentAll.length, 10, 'limit beyond size returns all events');
  assertEqual(recentAll[0].id, 'e1', 'oldest first when returning all');
  assertEqual(recentAll[9].id, 'e10', 'newest last when returning all');

  assertEqual(readRecentEvents(file, 0).length, 0, 'limit 0 returns none');
  assertEqual(readRecentEvents(file, -1).length, 0, 'negative limit returns none');

  console.log('  ✓ recent-reader-order: newest events returned in correct order');
}

// ── Test 4: missing file and empty inputs are safe ───────────────
function testSafeEdges() {
  const missing = path.join(os.tmpdir(), 'event-reader-does-not-exist-xyz', 'events.jsonl');
  assertEqual(readMatchingEvents(missing, { needles: ['"runId":1'], predicate: () => true }).length, 0, 'missing file → empty');
  assertEqual(readRecentEvents(missing, 5).length, 0, 'missing file → empty recent');

  const empty = writeLog([]);
  // writeLog of [] writes just "\n"; both readers must tolerate it.
  assertEqual(readMatchingEvents(empty, { predicate: () => true }).length, 0, 'empty log → empty matches');
  assertEqual(readRecentEvents(empty, 5).length, 0, 'empty log → empty recent');

  console.log('  ✓ safe-edges: missing/empty logs handled without error');
}

function main() {
  console.log('Event Reader Bounds Test Suite');
  console.log('='.repeat(70));

  const tests = [
    testNoFullParseForRunLookup,
    testRunDetailScoped,
    testRecentReaderOrder,
    testSafeEdges
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
  if (failed > 0) process.exit(1);
}

main();

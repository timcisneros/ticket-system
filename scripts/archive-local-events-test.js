#!/usr/bin/env node
// Test suite for scripts/archive-local-events.js — verifies the archive
// lifecycle tool inspects, archives, and (only with --reset) truncates the
// event log, without touching sibling data files.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const {
  inspectEventLog,
  archiveEventLog,
  timestampForFilename,
  parseArgs,
  resolveAction
} = require('./archive-local-events');

const SCRIPT = path.join(__dirname, 'archive-local-events.js');

function assert(value, msg) {
  if (!value) throw new Error(`ASSERTION FAILED: ${msg}`);
}

function assertEqual(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error(`ASSERTION FAILED: ${msg}\n  expected: ${expected}\n  actual:   ${actual}`);
  }
}

function tempStore() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'archive-events-'));
}

function sampleLog() {
  return [
    '{"id":"a","type":"run.started","runId":1,"ticketId":10,"payload":{}}',
    '{"id":"b","type":"run.terminalized","runId":1,"ticketId":10,"payload":{"status":"completed"}}',
    '{"id":"c","type":"scheduler.tick","runId":null,"ticketId":null,"payload":{"pendingRuns":2}}'
  ].join('\n') + '\n';
}

// ── Test 1: inspect reports correct size and line count ──────────
function testInspect() {
  const dir = tempStore();
  const file = path.join(dir, 'events.jsonl');
  const content = sampleLog();
  fs.writeFileSync(file, content);

  const info = inspectEventLog(file);
  assert(info.exists, 'inspect should report existing file');
  assertEqual(info.bytes, Buffer.byteLength(content), 'inspect reports byte size');
  assertEqual(info.lines, 3, 'inspect counts non-empty lines');

  const missing = inspectEventLog(path.join(dir, 'nope.jsonl'));
  assertEqual(missing.exists, false, 'missing file reported as not existing');
  assertEqual(missing.lines, 0, 'missing file has 0 lines');

  console.log('  ✓ inspect: size and line count reported correctly');
}

// ── Test 2: archive without reset copies and leaves source intact ─
function testArchiveNoReset() {
  const dir = tempStore();
  const file = path.join(dir, 'events.jsonl');
  const content = sampleLog();
  fs.writeFileSync(file, content);

  const result = archiveEventLog({ file, reset: false });

  assertEqual(result.reset, false, 'reset flag false');
  assert(fs.existsSync(result.archivePath), 'archive file created');
  assert(result.archivePath.includes(path.join('event-archive', 'events-')), 'archive lives under event-archive/');
  assertEqual(fs.readFileSync(result.archivePath, 'utf8'), content, 'archive content matches source');
  // Source unchanged.
  assertEqual(fs.readFileSync(file, 'utf8'), content, 'source left intact when not resetting');
  assertEqual(result.lines, 3, 'reported line count');

  console.log('  ✓ archive-no-reset: timestamped copy created, source preserved');
}

// ── Test 3: archive with reset empties source, archive retains data ─
function testArchiveWithReset() {
  const dir = tempStore();
  const file = path.join(dir, 'events.jsonl');
  const content = sampleLog();
  fs.writeFileSync(file, content);

  const result = archiveEventLog({ file, reset: true });

  assertEqual(result.reset, true, 'reset flag true');
  assertEqual(fs.readFileSync(result.archivePath, 'utf8'), content, 'archive retains original content');
  assertEqual(fs.readFileSync(file, 'utf8'), '', 'source truncated to empty log after reset');

  // A fresh inspect of the source shows an empty log.
  const after = inspectEventLog(file);
  assertEqual(after.lines, 0, 'reset source has 0 lines');

  console.log('  ✓ archive-with-reset: source emptied, archive preserves evidence');
}

// ── Test 4: missing source errors safely ─────────────────────────
function testMissingSource() {
  const dir = tempStore();
  const file = path.join(dir, 'events.jsonl');
  let threw = false;
  try {
    archiveEventLog({ file, reset: true });
  } catch (error) {
    threw = true;
    assertEqual(error.code, 'ENOENT', 'missing source raises ENOENT');
  }
  assert(threw, 'archiving a missing log should throw');
  assert(!fs.existsSync(path.join(dir, 'event-archive')), 'no archive dir created for missing source');

  console.log('  ✓ missing-source: errors safely without creating artifacts');
}

// ── Test 5: only the event log is touched (no sibling mutation) ───
function testDoesNotTouchSiblings() {
  const dir = tempStore();
  const file = path.join(dir, 'events.jsonl');
  fs.writeFileSync(file, sampleLog());

  // Sibling files that must NOT be touched (e.g. provider keys, seeds).
  const agents = path.join(dir, 'agents.json');
  const users = path.join(dir, 'users.json');
  const agentsContent = '[{"id":1,"apiKey":"SECRET-DO-NOT-TOUCH"}]';
  const usersContent = '[{"id":1,"username":"admin"}]';
  fs.writeFileSync(agents, agentsContent);
  fs.writeFileSync(users, usersContent);

  archiveEventLog({ file, reset: true });

  assertEqual(fs.readFileSync(agents, 'utf8'), agentsContent, 'agents.json untouched');
  assertEqual(fs.readFileSync(users, 'utf8'), usersContent, 'users.json untouched');

  console.log('  ✓ no-sibling-mutation: provider keys / other data files untouched');
}

// ── Test 6: timestamp + arg parsing basics ───────────────────────
function testHelpers() {
  const ts = timestampForFilename(new Date('2026-06-19T15:09:00.123Z'));
  assert(!/[:.]/.test(ts), 'timestamp has no filename-unsafe characters');
  assert(ts.startsWith('2026-06-19'), 'timestamp preserves date');

  const args = parseArgs(['--file', '/tmp/x.jsonl', '--archive', '--reset']);
  assertEqual(args.file, '/tmp/x.jsonl', 'parses --file');
  assertEqual(args.archive, true, 'parses --archive');
  assertEqual(args.reset, true, 'parses --reset');
  const empty = parseArgs([]);
  assertEqual(empty.archive, false, 'archive defaults to false (inspect-only)');
  assertEqual(empty.reset, false, 'reset defaults to false (no accidental reset)');

  console.log('  ✓ helpers: timestamp safe, args parsed, archive/reset default off');
}

// ── Test 7: resolveAction gates reset behind archive ─────────────
function testResolveAction() {
  assertEqual(JSON.stringify(resolveAction({ archive: false, reset: false })), JSON.stringify({ archive: false, reset: false }), 'no flags → inspect only');
  assertEqual(JSON.stringify(resolveAction({ archive: true, reset: false })), JSON.stringify({ archive: true, reset: false }), '--archive → archive, no reset');
  assertEqual(JSON.stringify(resolveAction({ archive: true, reset: true })), JSON.stringify({ archive: true, reset: true }), '--archive --reset → archive + reset');

  let threw = false;
  try {
    resolveAction({ archive: false, reset: true });
  } catch (error) {
    threw = true;
    assertEqual(error.code, 'ERESET_WITHOUT_ARCHIVE', '--reset without --archive raises a guarded error');
  }
  assert(threw, '--reset without --archive must be rejected');

  console.log('  ✓ resolve-action: reset is gated behind archive');
}

// ── Test 8: default CLI invocation inspects only (no mutation) ────
function testCliInspectOnlyIsSafe() {
  const dir = tempStore();
  const file = path.join(dir, 'events.jsonl');
  const content = sampleLog();
  fs.writeFileSync(file, content);

  // Default invocation (no --archive): must report and change nothing.
  const out = execFileSync('node', [SCRIPT, '--file', file], { encoding: 'utf8' });
  assert(/inspect only/i.test(out), 'default invocation reports inspect-only');

  assertEqual(fs.readFileSync(file, 'utf8'), content, 'inspect-only leaves the log unchanged');
  assert(!fs.existsSync(path.join(dir, 'event-archive')), 'inspect-only creates no archive');

  // --reset without --archive must be refused (non-zero exit, no mutation).
  let refused = false;
  try {
    execFileSync('node', [SCRIPT, '--file', file, '--reset'], { encoding: 'utf8', stdio: 'pipe' });
  } catch (error) {
    refused = true;
    assert(error.status === 2, '--reset without --archive exits with code 2');
  }
  assert(refused, '--reset alone must be refused');
  assertEqual(fs.readFileSync(file, 'utf8'), content, 'refused reset left the log unchanged');
  assert(!fs.existsSync(path.join(dir, 'event-archive')), 'refused reset created no archive');

  console.log('  ✓ cli-inspect-only: default + guarded reset never mutate the log');
}

function main() {
  console.log('Archive Local Events Test Suite');
  console.log('='.repeat(70));

  const tests = [
    testInspect,
    testArchiveNoReset,
    testArchiveWithReset,
    testMissingSource,
    testDoesNotTouchSiblings,
    testHelpers,
    testResolveAction,
    testCliInspectOnlyIsSafe
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

#!/usr/bin/env node
'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const { CHECKPOINT_TEST_SCRIPTS, POSTGRES_INTEGRATION_SCRIPTS } = require('./release-checkpoint');
const {
  TESTS, REQUIRED_TESTS, ORPHANED_TESTS, EXCLUDED_TESTS,
  EXCLUSION_REASONS, ORPHAN_REASONS, manifestByFile
} = require('./test-manifest');

const ROOT = path.resolve(__dirname, '..');
const all = [...CHECKPOINT_TEST_SCRIPTS, ...POSTGRES_INTEGRATION_SCRIPTS];
assert.ok(CHECKPOINT_TEST_SCRIPTS.length > 0);
assert.deepEqual([...new Set(all)], all, 'release checkpoint entries must be unique');
for (const name of all) {
  assert.match(name, /-test\.js$/);
  assert.equal(fs.existsSync(path.join(ROOT, 'scripts', name)), true, `missing checkpoint test ${name}`);
}
for (const required of [
  'dev-environment-test.js',
  'postgres-persistence-contract-test.js',
  'postgres-persistence-integration-test.js',
  'postgres-runtime-cutover-test.js',
  'page-render-regression-test.js',
  'mutation-admission-contract-test.js',
  'mutation-admission-scheduler-test.js',
  'scheduler-observability-test.js',
  'release-checkpoint-coverage-test.js'
]) {
  assert.equal(all.includes(required), true, `checkpoint must include ${required}`);
}

for (const materializerGate of [
  'process-materializer-contract-test.js',
  'process-materializer-native-test.js',
  'process-materializer-linux-test.js',
  'process-materializer-cross-uid-test.js',
  'process-workspace-mutation-boundary-test.js'
]) {
  assert.equal(all.includes(materializerGate), true,
    `process-input materialization releases must include ${materializerGate}`);
}

// A10 — the fourteen restored PostgreSQL runtime integrity suites are MANDATORY.
//
// This list is the anti-rot guard, not bookkeeping. These suites were orphaned by the
// PostgreSQL cutover and went unnoticed for exactly one reason: none of them was
// registered, so `npm run checkpoint:release` stayed green while every one of them
// failed at HEAD. Pinning them here means dropping one from the checkpoint fails the
// checkpoint, so the same silent decay cannot recur.
//
// Removing an entry below is a disposition decision and belongs in
// docs/ARCHITECTURAL_DECISIONS_PENDING.md (A10) with its reason recorded — not a
// quiet edit here.
for (const restored of [
  'ticket-feasibility-gate-test.js',
  'resume-obvious-postcondition-test.js',
  'direct-folder-postcondition-completeness-test.js',
  'runtime-feasibility-test.js',
  'recovery-regression-test.js',
  'postcondition-completion-test.js',
  'startup-data-integrity-test.js',
  'run-detail-evidence-clarity-test.js',
  'run-diagnostics-bundle-test.js',
  'bounded-transition-test.js',
  'replay-snapshot-storage-test.js',
  'runtime-limits-config-test.js',
  'runtime-limits-ui-test.js',
  'renamepath-runtime-regression-test.js'
]) {
  assert.equal(all.includes(restored), true,
    `checkpoint must include the restored A10 suite ${restored}`);
}

// Every restored suite must exercise the real PostgreSQL runtime, so none may be
// parked in the deterministic (no-database) list where it would be run without one.
for (const restored of POSTGRES_INTEGRATION_SCRIPTS) {
  assert.equal(CHECKPOINT_TEST_SCRIPTS.includes(restored), false,
    `${restored} must not also appear in the deterministic checkpoint list`);
}

// The mutation tool edits tracked source in place and must never run as part of
// the release checkpoint.
assert.equal(all.includes('suite-mutation-test.js'), false,
  'the mutation tool must not be registered in the release checkpoint');

// ── A20: the manifest is the authority on what exists and what must run ──────────
//
// The A10 pin above is a hand-maintained list of fourteen filenames. It cannot notice
// a NEW suite that nobody registers, which is precisely how the cutover orphaned
// suites in bulk without anything going red. These checks close that: every test file
// must be classified, and every classification must be consistent with the checkpoint.
//
// Deliberately NOT "every *-test.js must be registered" — live-provider, manual-demo,
// mutation and source-coupled suites are legitimate exclusions. The manifest carries
// the reason instead of a heuristic guessing at it.

const manifest = manifestByFile();
const testFiles = fs.readdirSync(path.join(ROOT, 'scripts'))
  .filter(name => name.endsWith('-test.js'))
  .sort();

// 1. No unclassified file. A new test that nobody classifies fails here — silence is
//    not a valid state.
for (const file of testFiles) {
  assert.equal(manifest.has(file), true,
    `scripts/${file} is not classified in scripts/test-manifest.js. ` +
    'Add it as required, orphaned, or excluded (with a reason).');
}

// 2. No stale manifest entry pointing at a file that no longer exists.
for (const entry of TESTS) {
  assert.equal(fs.existsSync(path.join(ROOT, 'scripts', entry.file)), true,
    `scripts/test-manifest.js lists ${entry.file}, which does not exist`);
}
assert.equal(TESTS.length, testFiles.length,
  'the manifest must have exactly one entry per scripts/*-test.js file');
assert.deepEqual([...new Set(TESTS.map(e => e.file))], TESTS.map(e => e.file),
  'the manifest must not list a file twice');

// 3. Every required suite is actually registered — the anti-rot rule itself.
for (const file of REQUIRED_TESTS) {
  assert.equal(all.includes(file), true,
    `${file} is classified required in scripts/test-manifest.js but is not registered ` +
    'in the release checkpoint. Register it, or reclassify it with a recorded reason.');
}

// 4. Every registered script is classified required — so nothing runs in the
//    checkpoint that the manifest calls orphaned or deliberately excluded.
for (const file of all) {
  const entry = manifest.get(file);
  assert.ok(entry, `${file} is in the release checkpoint but absent from the manifest`);
  assert.equal(entry.status, 'required',
    `${file} is registered in the release checkpoint but classified "${entry.status}" ` +
    'in the manifest. A checkpointed suite must be required.');
}

// 5. Every non-required classification carries a reason drawn from the documented
//    vocabulary, so "why is this not running?" is always answerable from the repo.
for (const entry of TESTS) {
  if (entry.status === 'required') {
    assert.equal(entry.reason, undefined, `${entry.file}: a required suite takes no reason`);
    continue;
  }
  assert.ok(['orphaned', 'excluded'].includes(entry.status),
    `${entry.file}: unknown status "${entry.status}"`);
  const vocabulary = entry.status === 'excluded' ? EXCLUSION_REASONS : ORPHAN_REASONS;
  assert.ok(entry.reason && Object.prototype.hasOwnProperty.call(vocabulary, entry.reason),
    `${entry.file}: "${entry.reason}" is not a documented ${entry.status} reason. ` +
    `Known: ${Object.keys(vocabulary).join(', ')}`);
}

// 6. Sanity: the three statuses partition the manifest.
assert.equal(REQUIRED_TESTS.length + ORPHANED_TESTS.length + EXCLUDED_TESTS.length, TESTS.length,
  'every manifest entry must be required, orphaned, or excluded');

// 7. No checkpoint suite may derive its listen port from a collision-prone constant.
//    Eight suites once used `process.pid % N` over overlapping hand-picked ranges;
//    `page-render-regression-test.js` alone spanned 3400-4399, covering all the others.
//    That produced a checkpoint failure reported as "server did not start" when the
//    server had started fine and could not bind. The OS allocates ports without
//    collisions — see scripts/test-port.js — and arithmetic does not, so the arithmetic
//    is banned rather than re-tuned. A wider range would only make the collision rarer
//    and therefore harder to diagnose.
const PORT_DERIVATIONS = [
  { pattern: /process\.pid\s*%/, label: 'a pid-modulo port derivation' },
  { pattern: /\bPORT\b\s*=\s*(?:String\(|Number\()?\s*3\d{3}\s*[+)]/, label: 'a hard-coded base port' },
  { pattern: /listen\(\s*3\d{3}\s*[,)]/, label: 'a hard-coded listen port' }
];

for (const file of [...CHECKPOINT_TEST_SCRIPTS, ...POSTGRES_INTEGRATION_SCRIPTS]) {
  // This file states the banned patterns literally, so it matches itself.
  if (file === 'release-checkpoint-coverage-test.js') continue;
  const source = fs.readFileSync(path.join(ROOT, 'scripts', file), 'utf8');
  for (const { pattern, label } of PORT_DERIVATIONS) {
    assert.ok(!pattern.test(source),
      `${file}: uses ${label}. Checkpoint suites must take ports from ` +
      `scripts/test-port.js (allocateTestPort / allocateTestPorts), which asks the OS ` +
      'for a free port instead of guessing one.');
  }
}

// The guard is worthless if the facility it points at does not work, so exercise it:
// a request for several ports must return that many DISTINCT, bindable ports.
const { allocateTestPorts } = require('./test-port');
(async () => {
  const ports = await allocateTestPorts(4);
  assert.equal(ports.length, 4, 'allocateTestPorts returns the requested count');
  assert.equal(new Set(ports).size, 4, 'allocateTestPorts returns distinct ports');
  assert.ok(ports.every(port => Number.isInteger(port) && port > 1024),
    'allocateTestPorts returns usable non-privileged ports');
  const net = require('net');
  await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(ports[0], '127.0.0.1', () => server.close(resolve));
  });
})().catch(error => {
  console.error(`FAIL: release checkpoint coverage — test-port facility: ${error.message}`);
  process.exit(1);
});

const packageJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
assert.match(packageJson.scripts['test:persistence:postgres'], /postgres-persistence-integration-test\.js/);
assert.match(packageJson.scripts['test:cutover:postgres'], /postgres-runtime-cutover-test\.js/);
assert.match(packageJson.scripts['test:page-render:postgres'], /page-render-regression-test\.js/);
assert.match(packageJson.scripts['checkpoint:release'], /release-checkpoint\.js/);
assert.match(packageJson.scripts['test:materializer'], /process-materializer-cross-uid-test\.js/);

console.log('PASS: release checkpoint coverage — current deterministic and real-Postgres boundaries are mandatory');

#!/usr/bin/env node
// Release checkpoint coverage guard (r1.32). A fast, deterministic, provider-free, network-free
// check that the release checkpoint stays honest. It does NOT run the suite and does NOT touch any
// DATA_DIR / WORKSPACE_ROOT — it only inspects scripts/release-checkpoint.js and the scripts dir.
//
// It verifies:
//   - scripts/release-checkpoint.js exists and exports its ordered test-script list;
//   - every test listed in the checkpoint exists on disk;
//   - there are no duplicate entries;
//   - the list order is deterministic (re-require yields the identical order);
//   - the known critical primitive tests are present in the checkpoint;
//   - additional critical tests (run in the verification suite) exist on disk.

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SCRIPTS_DIR = path.join(ROOT, 'scripts');
const CHECKPOINT_PATH = path.join(SCRIPTS_DIR, 'release-checkpoint.js');

let failures = 0;
function check(condition, message) {
  if (condition) return;
  failures += 1;
  console.error(`FAIL: ${message}`);
}

// 1: the checkpoint script exists and exports its list.
check(fs.existsSync(CHECKPOINT_PATH), 'scripts/release-checkpoint.js must exist');
const mod = require(CHECKPOINT_PATH);
const list = mod && Array.isArray(mod.CHECKPOINT_TEST_SCRIPTS) ? mod.CHECKPOINT_TEST_SCRIPTS : null;
check(Array.isArray(list) && list.length > 0, 'release-checkpoint must export a non-empty CHECKPOINT_TEST_SCRIPTS array');

if (Array.isArray(list)) {
  // 2: every listed test exists on disk.
  for (const name of list) {
    check(typeof name === 'string' && name.endsWith('-test.js'), `checkpoint entry "${name}" must be a *-test.js filename`);
    check(fs.existsSync(path.join(SCRIPTS_DIR, name)), `checkpoint test "${name}" must exist on disk`);
  }

  // 3: no duplicate entries.
  const seen = new Set();
  const dups = list.filter(name => { if (seen.has(name)) return true; seen.add(name); return false; });
  check(dups.length === 0, `checkpoint list must have no duplicates (found: ${dups.join(', ')})`);

  // 4: order is deterministic — re-requiring yields the identical ordered list.
  delete require.cache[require.resolve(CHECKPOINT_PATH)];
  const reloaded = require(CHECKPOINT_PATH).CHECKPOINT_TEST_SCRIPTS;
  check(JSON.stringify(reloaded) === JSON.stringify(list), 'checkpoint list order must be deterministic across requires');

  // 5: critical primitive tests must be PRESENT IN THE CHECKPOINT.
  const REQUIRED_IN_CHECKPOINT = [
    'ticket-timeline-authority-visibility-test.js',
    'target-provider-contract-test.js',
    'process-template-trigger-test.js',
    'scheduled-process-template-trigger-test.js',
    'process-template-version-provenance-test.js',
    'process-template-append-only-version-store-test.js',
    'process-template-activation-durability-test.js',
    'work-context-primitive-test.js',
    'work-context-visibility-surface-test.js',
    'agent-handoff-queue-protocol-test.js',
    'handoff-smoke-test.js',
    'bounded-watcher-test.js',
    'model-provider-routing-test.js',
    'local-connector-contract-test.js',
    'operational-transparency-test.js',
    'page-render-regression-test.js',
    'startup-data-integrity-test.js',
    'rbac-and-inline-data-security-test.js',
    'event-chain-verify-test.js',
    'event-chain-restart-test.js',
    'internal-demo-security-test.js',
    'objective-contract-compiler-test.js',
    'release-checkpoint-coverage-test.js'
  ];
  for (const name of REQUIRED_IN_CHECKPOINT) {
    check(list.includes(name), `critical test "${name}" must be present in the release checkpoint`);
  }

  // 6: additional critical tests run in the verification suite must EXIST ON DISK
  // (they are not part of the checkpoint count but must not be lost).
  const REQUIRED_ON_DISK = [
    'triage-inbox-test.js',
    'triage-resolution-test.js',
    'demo-seed-test.js'
  ];
  for (const name of REQUIRED_ON_DISK) {
    check(fs.existsSync(path.join(SCRIPTS_DIR, name)), `critical test "${name}" must exist on disk`);
  }
  check(fs.existsSync(path.join(SCRIPTS_DIR, 'check-js-syntax.js')), 'project-wide JavaScript build check must exist on disk');
}

if (failures > 0) {
  console.error(`\nrelease checkpoint coverage guard: ${failures} failure(s)`);
  process.exit(1);
}
console.log('PASS: release checkpoint coverage guard — every listed test exists, no duplicates, order deterministic, critical primitive tests present');

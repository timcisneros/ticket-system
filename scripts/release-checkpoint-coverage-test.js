#!/usr/bin/env node
'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const { CHECKPOINT_TEST_SCRIPTS, POSTGRES_INTEGRATION_SCRIPTS } = require('./release-checkpoint');

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

// The A10 mutation test edits tracked source in place and must never run as part of
// the release checkpoint.
assert.equal(all.includes('a10-suite-mutation-test.js'), false,
  'the A10 mutation test must not be registered in the release checkpoint');

const packageJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
assert.match(packageJson.scripts['test:persistence:postgres'], /postgres-persistence-integration-test\.js/);
assert.match(packageJson.scripts['test:cutover:postgres'], /postgres-runtime-cutover-test\.js/);
assert.match(packageJson.scripts['test:page-render:postgres'], /page-render-regression-test\.js/);
assert.match(packageJson.scripts['checkpoint:release'], /release-checkpoint\.js/);

console.log('PASS: release checkpoint coverage — current deterministic and real-Postgres boundaries are mandatory');

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

const packageJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
assert.match(packageJson.scripts['test:persistence:postgres'], /postgres-persistence-integration-test\.js/);
assert.match(packageJson.scripts['test:cutover:postgres'], /postgres-runtime-cutover-test\.js/);
assert.match(packageJson.scripts['test:page-render:postgres'], /page-render-regression-test\.js/);
assert.match(packageJson.scripts['checkpoint:release'], /release-checkpoint\.js/);

console.log('PASS: release checkpoint coverage — current deterministic and real-Postgres boundaries are mandatory');

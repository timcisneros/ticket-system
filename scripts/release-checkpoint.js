#!/usr/bin/env node
'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

const CHECKPOINT_TEST_SCRIPTS = Object.freeze([
  'bounded-worker-pool-test.js',
  'business-scenario-contracts-test.js',
  'dev-environment-test.js',
  'catalog-consistency-test.js',
  'mutation-admission-contract-test.js',
  'mutation-admission-scheduler-test.js',
  'no-tracked-provider-keys-test.js',
  'objective-contract-compiler-test.js',
  'objective-contract-parity-test.js',
  'operation-batch-test.js',
  'organization-guidance-test.js',
  'phase-gated-catalog-behavioral-test.js',
  'postgres-persistence-contract-test.js',
  'recovery-state-reconstruction-test.js',
  'run-decision-graph-projection-test.js',
  'scheduler-observability-test.js',
  'workspace-fixture-catalog-test.js',
  'release-checkpoint-coverage-test.js'
]);

const POSTGRES_INTEGRATION_SCRIPTS = Object.freeze([
  'postgres-persistence-integration-test.js',
  'postgres-runtime-cutover-test.js',
  'page-render-regression-test.js'
]);

function runCheckpoint() {
  if (!process.env.TEST_DATABASE_URL) {
    console.error('CHECKPOINT FAILED: TEST_DATABASE_URL is required for the Postgres release checkpoint');
    process.exit(1);
  }
  const allScripts = [...CHECKPOINT_TEST_SCRIPTS, ...POSTGRES_INTEGRATION_SCRIPTS];
  const missing = allScripts.filter(name => !fs.existsSync(path.join(ROOT, 'scripts', name)));
  if (missing.length) {
    console.error(`CHECKPOINT FAILED: missing test scripts: ${missing.join(', ')}`);
    process.exit(1);
  }
  const checks = [
    { label: 'project-wide JavaScript syntax', script: 'check-js-syntax.js' },
    ...allScripts.map(script => ({ label: script, script }))
  ];
  const env = { ...process.env, NODE_ENV: process.env.NODE_ENV || 'test' };
  const startedAt = Date.now();
  let passed = 0;
  for (const check of checks) {
    console.log(`\n$ node scripts/${check.script}`);
    const result = spawnSync(process.execPath, [path.join('scripts', check.script)], {
      cwd: ROOT,
      env,
      stdio: 'inherit'
    });
    if (result.error || result.status !== 0) {
      console.error(`\nCHECKPOINT FAILED: ${check.label}${result.error ? `: ${result.error.message}` : ` (exit ${result.status})`}`);
      console.error(`${passed}/${checks.length} checks passed before the failure.`);
      process.exit(result.status || 1);
    }
    passed += 1;
  }
  console.log(`\nRELEASE CHECKPOINT PASSED: ${passed}/${checks.length} checks in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
}

module.exports = { CHECKPOINT_TEST_SCRIPTS, POSTGRES_INTEGRATION_SCRIPTS };

if (require.main === module) runCheckpoint();

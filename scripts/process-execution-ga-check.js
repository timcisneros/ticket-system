#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');

function run(label, command, args, env = {}) {
  process.stdout.write(`\n[GA] ${label}\n`);
  const result = spawnSync(command, args, {
    cwd: ROOT,
    env: { ...process.env, ...env },
    encoding: 'utf8',
    stdio: 'inherit'
  });
  if (result.error || result.status !== 0) {
    const error = new Error(`PROCESS_GA_GATE_FAILED: ${label}`);
    error.code = 'PROCESS_GA_GATE_FAILED';
    throw error;
  }
}

function main() {
  if (!process.env.TEST_DATABASE_URL) {
    throw new Error('PROCESS_GA_POSTGRES_UNAVAILABLE: TEST_DATABASE_URL is required');
  }
  const status = spawnSync('git', ['status', '--porcelain=v1'], {
    cwd: ROOT,
    encoding: 'utf8'
  });
  if (status.status !== 0 || status.stdout !== '') {
    throw new Error('PROCESS_GA_DIRTY_WORKTREE');
  }
  const output = fs.mkdtempSync(path.join(os.tmpdir(), 'ticket-system-ga-'));
  const gates = [
    ['JavaScript syntax/build', 'npm', ['run', 'build']],
    ['release contracts', 'node', ['scripts/process-execution-release-contract-test.js']],
    ['release manifest contract', 'node', ['scripts/release-manifest-test.js']],
    ['release package inventory', 'node', ['scripts/release-package-test.js']],
    ['third-party license notices', 'npm', ['run', 'release:licenses']],
    ['launcher formatting', 'npm', ['run', 'fmt:launcher-foundation']],
    ['launcher lint', 'npm', ['run', 'lint:launcher-foundation']],
    ['launcher release build', 'npm', ['run', 'build:launcher-foundation']],
    ['launcher native tests', 'cargo', [
      'test', '--locked', '--release',
      '--manifest-path', 'native/process-launcher/Cargo.toml'
    ]],
    ['materializer formatting', 'npm', ['run', 'fmt:materializer']],
    ['materializer lint', 'npm', ['run', 'lint:materializer']],
    ['materializer release build', 'npm', ['run', 'build:materializer']],
    ['materializer native tests', 'cargo', [
      'test', '--locked', '--release',
      '--manifest-path', 'native/process-materializer/Cargo.toml'
    ]],
    ['deployment validation', 'node',
      ['scripts/process-launcher-foundation-deployment-test.js']],
    ['privileged active containment', 'npm', ['run', 'test:launcher-containment']],
    ['migration preflight', 'node',
      ['scripts/process-execution-release-postgres-test.js']],
    ['backup restore', 'node', ['scripts/process-release-backup-restore-test.js']],
    ['bounded soak', 'node', ['scripts/process-execution-release-soak-test.js']],
    ['supply chain audit', 'npm', ['run', 'release:security']],
    ['release checkpoint coverage', 'node',
      ['scripts/release-checkpoint-coverage-test.js']],
    ['test manifest', 'node', ['scripts/test-manifest.js']],
    ['full release checkpoint', 'npm', ['run', 'checkpoint:release']],
    ['release manifest generation', 'node', [
      'scripts/release-manifest.js',
      '--checkpoint-reference',
      'checkpoint:release:passed',
      '--output',
      path.join(output, 'release-manifest.json')
    ]],
    ['release package generation', 'node', [
      'scripts/release-package.js',
      '--output-directory',
      output
    ]]
  ];
  for (const [label, command, args] of gates) run(label, command, args);
  console.log('\nPROCESS EXECUTION GA RELEASE PASSED');
}

try {
  main();
} catch (error) {
  console.error(`\n${error.code || 'PROCESS_GA_RELEASE_FAILED'}: ${error.message}`);
  process.exitCode = 1;
}

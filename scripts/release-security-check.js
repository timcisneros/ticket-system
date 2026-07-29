#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');

function run(command, args, { required = true } = {}) {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  });
  if (result.error || result.status !== 0) {
    if (!required) return { available: false, result };
    throw new Error(
      `PROCESS_RELEASE_SECURITY_CHECK_FAILED: ${command}: ${
        result.error ? result.error.message : result.stderr.trim()
      }`
    );
  }
  return { available: true, result };
}

function auditFailureCode({ error = null, status = null, stdout = '', stderr = '' } = {}) {
  if (error && error.code === 'ENOENT') {
    return 'PROCESS_RELEASE_VULNERABILITY_AUDIT_TOOL_UNAVAILABLE';
  }
  const output = `${stdout || ''}\n${stderr || ''}`;
  if (/(?:ENOTFOUND|EAI_AGAIN|ECONNRESET|ETIMEDOUT|network\s+(?:error|unavailable)|registry\s+(?:unavailable|request failed)|failed to (?:download|fetch)|could not resolve host)/i
    .test(output)) {
    return 'PROCESS_RELEASE_VULNERABILITY_AUDIT_NETWORK_UNAVAILABLE';
  }
  let report = null;
  try {
    report = JSON.parse(String(stdout || '').trim());
  } catch (_) {}
  const counts = report && report.metadata && report.metadata.vulnerabilities;
  const reportedVulnerabilities = counts &&
    ['high', 'critical'].some(level =>
      Number.isFinite(Number(counts[level])) && Number(counts[level]) > 0);
  if (reportedVulnerabilities ||
      /(?:vulnerabilit(?:y|ies)\s+(?:found|detected)|RUSTSEC-\d{4}-\d+)/i
        .test(output)) {
    return 'PROCESS_RELEASE_VULNERABILITIES_FOUND';
  }
  if (error || status !== 0) {
    return 'PROCESS_RELEASE_VULNERABILITY_AUDIT_EXECUTION_FAILED';
  }
  return null;
}

function runAudit(command, args) {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const code = auditFailureCode(result);
  if (code) {
    const detail = String(
      result.error ? result.error.message : result.stderr || result.stdout || ''
    ).trim().slice(0, 2000);
    const error = new Error(`${code}: ${command}${detail ? `: ${detail}` : ''}`);
    error.code = code;
    throw error;
  }
  return result;
}

function trackedFiles() {
  return run('git', ['ls-files', '-z']).result.stdout.split('\0').filter(Boolean);
}

function isForbiddenTrackedFile(file) {
  const basename = path.posix.basename(file);
  const forbiddenEnvironmentFile =
    basename === '.env' ||
    (basename.startsWith('.env.') && basename !== '.env.example');
  return forbiddenEnvironmentFile ||
    file.includes('/target/') ||
    file.includes('node_modules/');
}

function main() {
  for (const lockfile of [
    'pnpm-lock.yaml',
    'native/process-launcher/Cargo.lock',
    'native/process-materializer/Cargo.lock'
  ]) {
    if (!fs.existsSync(path.join(ROOT, lockfile))) {
      throw new Error(`PROCESS_RELEASE_LOCKFILE_MISSING: ${lockfile}`);
    }
  }
  const tracked = trackedFiles();
  if (tracked.some(isForbiddenTrackedFile)) {
    throw new Error('PROCESS_RELEASE_FORBIDDEN_GENERATED_OR_SECRET_FILE');
  }
  run('node', ['scripts/no-tracked-provider-keys-test.js']);
  run('pnpm', ['install', '--frozen-lockfile', '--offline']);
  run('cargo', [
    'metadata',
    '--locked',
    '--offline',
    '--no-deps',
    '--format-version',
    '1',
    '--manifest-path',
    'native/process-launcher/Cargo.toml'
  ]);
  run('cargo', [
    'metadata',
    '--locked',
    '--offline',
    '--no-deps',
    '--format-version',
    '1',
    '--manifest-path',
    'native/process-materializer/Cargo.toml'
  ]);
  if (process.env.PROCESS_RELEASE_NETWORK_AUDIT !== '1') {
    throw new Error(
      'PROCESS_RELEASE_VULNERABILITY_AUDIT_UNAVAILABLE: set ' +
      'PROCESS_RELEASE_NETWORK_AUDIT=1 in an approved release environment'
    );
  }
  runAudit('pnpm', ['audit', '--prod', '--audit-level', 'high', '--json']);
  runAudit('cargo-audit', ['--version']);
  for (const lockfile of [
    'native/process-launcher/Cargo.lock',
    'native/process-materializer/Cargo.lock'
  ]) {
    runAudit('cargo-audit', ['audit', '--file', lockfile, '--json']);
  }
  console.log('PASS: locked dependency, secret, and vulnerability release checks');
}

module.exports = {
  auditFailureCode,
  isForbiddenTrackedFile
};

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

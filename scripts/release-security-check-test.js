#!/usr/bin/env node
'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const {
  auditFailureCode
} = require('./release-security-check');

assert.equal(auditFailureCode({
  status: 0,
  stdout: '{"metadata":{"vulnerabilities":{"high":0,"critical":0}}}'
}), null);
assert.equal(auditFailureCode({
  status: 0,
  stdout: '{"metadata":{"vulnerabilities":{"low":2,"high":0,"critical":0}}}'
}), null);
assert.equal(auditFailureCode({
  error: Object.assign(new Error('missing'), { code: 'ENOENT' }),
  status: null
}), 'PROCESS_RELEASE_VULNERABILITY_AUDIT_TOOL_UNAVAILABLE');
assert.equal(auditFailureCode({
  status: 1,
  stderr: 'request to registry failed: getaddrinfo EAI_AGAIN'
}), 'PROCESS_RELEASE_VULNERABILITY_AUDIT_NETWORK_UNAVAILABLE');
assert.equal(auditFailureCode({
  status: 1,
  stdout: '{"metadata":{"vulnerabilities":{"high":1,"critical":0}}}'
}), 'PROCESS_RELEASE_VULNERABILITIES_FOUND');
assert.equal(auditFailureCode({
  status: 1,
  stderr: 'Crate: example\nVulnerability found! RUSTSEC-2026-0001'
}), 'PROCESS_RELEASE_VULNERABILITIES_FOUND');
assert.equal(auditFailureCode({
  status: 2,
  stderr: 'audit process terminated without a report'
}), 'PROCESS_RELEASE_VULNERABILITY_AUDIT_EXECUTION_FAILED');

const source = fs.readFileSync(
  path.join(__dirname, 'release-security-check.js'),
  'utf8'
);
assert.match(
  source,
  /runAudit\('cargo-audit', \['audit', '--file', lockfile, '--json'\]\)/,
  'cargo-audit must receive the cargo plugin subcommand before lockfile options'
);

console.log('PASS: release vulnerability audit failure classification');

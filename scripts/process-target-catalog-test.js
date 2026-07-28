#!/usr/bin/env node
'use strict';

const assert = require('assert');
const {
  PROCESS_EXECUTION_POLICY,
  PROCESS_PROFILE_BOUNDS,
  PROCESS_PROFILE_HARD_LIMITS,
  normalizeProcessProfileGrants,
  resolveProcessProfileGrants,
  validateProcessTargetCatalog
} = require('../runtime/process-target-catalog');
const {
  buildProcessPolicySnapshot,
  processAuthorityReferences
} = require('../runtime/process-execution-contract');

let passed = 0;
function ok(condition, message) {
  assert.ok(condition, message);
  passed += 1;
  console.log(`  ok ${message}`);
}
function equal(actual, expected, message) {
  assert.deepStrictEqual(actual, expected, message);
  passed += 1;
  console.log(`  ok ${message}`);
}
function rejects(mutator, message, expectedCode = 'PROCESS_TARGET_CATALOG_INVALID') {
  const value = validCatalog();
  mutator(value);
  assert.throws(
    () => validateProcessTargetCatalog(value),
    error => error && error.code === expectedCode,
    message
  );
  passed += 1;
  console.log(`  ok ${message}`);
}

function profile(id = 'syntax-check', overrides = {}) {
  return {
    id,
    allowedPhases: ['verification'],
    executable: '/usr/bin/node',
    arguments: ['--check', 'server.js'],
    workingDirectory: '.',
    environment: { CI: '1' },
    limits: {
      wallTimeMs: 30000,
      maxOutputBytes: 1048576,
      maxProcesses: 8
    },
    ...overrides
  };
}

function validCatalog() {
  return {
    version: 1,
    targets: [{
      id: 'ticket-system-local',
      profiles: [profile()]
    }]
  };
}

const parsed = validateProcessTargetCatalog(validCatalog());
equal(parsed, validCatalog(), 'valid version-1 process target catalog parses deterministically');
ok(Object.isFrozen(parsed) && Object.isFrozen(parsed.targets[0].profiles[0]),
  'validated catalog is deeply immutable');

rejects(value => value.targets.push(structuredClone(value.targets[0])),
  'duplicate target IDs are rejected');
rejects(value => value.targets[0].profiles.push(profile()),
  'duplicate profile IDs within a target are rejected');
for (const invalidId of ['', 'Uppercase', 'slash/id', `a${'b'.repeat(128)}`]) {
  rejects(value => { value.targets[0].id = invalidId; },
    `invalid target identifier ${JSON.stringify(invalidId)} is rejected`);
  rejects(value => { value.targets[0].profiles[0].id = invalidId; },
    `invalid profile identifier ${JSON.stringify(invalidId)} is rejected`);
}

rejects(value => { value.targets[0].profiles[0].allowedPhases = []; },
  'empty allowedPhases is rejected');
rejects(value => { value.targets[0].profiles[0].allowedPhases = ['planning']; },
  'unknown runtime phase is rejected');
rejects(value => { value.targets[0].profiles[0].allowedPhases = ['inspection', 'inspection']; },
  'duplicate runtime phases are rejected');
const canonicalPhases = validCatalog();
canonicalPhases.targets[0].profiles.push(profile('multi', {
  allowedPhases: ['verification', 'inspection']
}));
canonicalPhases.targets.push({
  id: 'a-target',
  profiles: [profile('z-profile'), profile('a-profile')]
});
const ordered = validateProcessTargetCatalog(canonicalPhases);
equal(ordered.targets.map(target => target.id), ['a-target', 'ticket-system-local'],
  'targets are canonically ordered');
equal(ordered.targets[0].profiles.map(item => item.id), ['a-profile', 'z-profile'],
  'profiles are canonically ordered');
equal(ordered.targets[1].profiles[0].allowedPhases, ['inspection', 'verification'],
  'allowed phases are canonically ordered');

rejects(value => { value.targets[0].profiles[0].workingDirectory = '../escape'; },
  'relative working-directory traversal is rejected');
rejects(value => { value.targets[0].profiles[0].workingDirectory = '/tmp'; },
  'absolute working directories are rejected');
rejects(value => { value.targets[0].profiles[0].workingDirectory = 'a/../b'; },
  'normalizing working-directory traversal is rejected');
rejects(value => { value.targets[0].profiles[0].executable = '/bin/sh'; },
  'general shell interpreter profiles are rejected');
rejects(value => { value.targets[0].profiles[0].executable = '/usr/bin/node --check'; },
  'command-plus-arguments executable strings are rejected');
rejects(value => { value.targets[0].profiles[0].executable = 'node'; },
  'relative executable paths are rejected');

rejects(value => { value.targets[0].profiles[0].arguments = '--check server.js'; },
  'arguments must be an ordered string array');
rejects(value => { value.targets[0].profiles[0].arguments = [1]; },
  'non-string arguments are rejected');
rejects(value => {
  value.targets[0].profiles[0].arguments =
    Array(PROCESS_PROFILE_BOUNDS.maxArgumentCount + 1).fill('x');
}, 'argument count limit is enforced');
rejects(value => {
  value.targets[0].profiles[0].arguments =
    ['x'.repeat(PROCESS_PROFILE_BOUNDS.maxArgumentBytes + 1)];
}, 'individual argument byte limit is enforced');

rejects(value => { value.targets[0].profiles[0].environment = { 'BAD-NAME': 'x' }; },
  'invalid environment names are rejected');
rejects(value => { value.targets[0].profiles[0].environment = { API_TOKEN: 'x' }; },
  'secret-bearing environment names are rejected');
rejects(value => {
  value.targets[0].profiles[0].environment = {
    SAFE: 'x'.repeat(PROCESS_PROFILE_BOUNDS.maxEnvironmentValueBytes + 1)
  };
}, 'oversized literal environment values are rejected');
rejects(value => { value.targets[0].profiles[0].inheritEnvironment = true; },
  'ambient environment inheritance is not a catalog option');

for (const key of ['wallTimeMs', 'maxOutputBytes', 'maxProcesses']) {
  rejects(value => { delete value.targets[0].profiles[0].limits[key]; },
    `missing ${key} limit is rejected`);
  rejects(value => { value.targets[0].profiles[0].limits[key] = 0; },
    `zero ${key} limit is rejected`);
  rejects(value => {
    value.targets[0].profiles[0].limits[key] = PROCESS_PROFILE_HARD_LIMITS[key] + 1;
  }, `${key} hard ceiling is enforced`);
}

const grants = normalizeProcessProfileGrants([{
  targetId: 'ticket-system-local',
  profileIds: ['syntax-check']
}]);
const resolvedProfiles = resolveProcessProfileGrants({
  capabilityEnabled: true,
  catalog: parsed,
  grants
});
const snapshot = buildProcessPolicySnapshot({
  capabilityEnabled: true,
  profiles: resolvedProfiles,
  capturedAt: '2026-07-27T12:00:00.000Z'
});
equal(snapshot.version, 2, 'exact grants resolve into a version-2 run snapshot');
equal(snapshot.profiles[0].executionPolicy, PROCESS_EXECUTION_POLICY,
  'resolved snapshot carries the fixed non-optional execution policy');
equal(processAuthorityReferences(snapshot, 'verification'), [{
  targetId: 'ticket-system-local',
  profileIds: ['syntax-check']
}], 'phase-filtered authority references contain only target and profile IDs');
equal(processAuthorityReferences(snapshot, 'inspection'), [],
  'profiles not allowed in the current phase are not advertised');

assert.throws(() => resolveProcessProfileGrants({
  capabilityEnabled: true,
  catalog: parsed,
  grants: [{ targetId: 'unknown-target', profileIds: ['syntax-check'] }]
}), error => error && error.code === 'PROCESS_TARGET_UNKNOWN');
passed += 1;
console.log('  ok unknown granted target fails closed');
assert.throws(() => resolveProcessProfileGrants({
  capabilityEnabled: true,
  catalog: parsed,
  grants: [{ targetId: 'ticket-system-local', profileIds: ['unknown-profile'] }]
}), error => error && error.code === 'PROCESS_PROFILE_UNKNOWN');
passed += 1;
console.log('  ok unknown granted profile fails closed');
equal(resolveProcessProfileGrants({
  capabilityEnabled: false,
  catalog: parsed,
  grants
}), [], 'feature-disabled grants resolve to no process authority');

const mutableCatalog = validCatalog();
const mutableGrants = [{
  targetId: 'ticket-system-local',
  profileIds: ['syntax-check']
}];
const immutableSnapshot = buildProcessPolicySnapshot({
  capabilityEnabled: true,
  profiles: resolveProcessProfileGrants({
    capabilityEnabled: true,
    catalog: mutableCatalog,
    grants: mutableGrants
  }),
  capturedAt: '2026-07-27T12:00:00.000Z'
});
const originalHash = immutableSnapshot.snapshotHash;
mutableCatalog.targets[0].profiles[0].arguments[0] = '--version';
mutableCatalog.targets[0].profiles[0].environment.CI = '0';
mutableGrants[0].profileIds[0] = 'changed';
equal(immutableSnapshot.snapshotHash, originalHash,
  'later catalog and grant mutation cannot alter the admitted snapshot hash');
equal(immutableSnapshot.profiles[0].arguments, ['--check', 'server.js'],
  'later catalog mutation cannot alter resolved snapshot arguments');
equal(immutableSnapshot.profiles[0].environment, { CI: '1' },
  'later catalog mutation cannot alter resolved snapshot environment');

console.log(`\nPASS: process target catalog Tranche 1 — ${passed} assertions`);

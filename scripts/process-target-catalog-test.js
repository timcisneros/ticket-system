#!/usr/bin/env node
'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const {
  PROCESS_AUTHORITY_CARDINALITY_LIMITS,
  PROCESS_EXECUTION_POLICY,
  PROCESS_PROFILE_BOUNDS,
  PROCESS_PROFILE_HARD_LIMITS,
  PROCESS_RUNTIME_PHASES,
  normalizeProcessProfileGrants,
  resolveProcessProfileGrants,
  validateProcessTargetCatalog
} = require('../runtime/process-target-catalog');
const {
  PROCESS_EXECUTION_POLICY: SNAPSHOT_EXECUTION_POLICY,
  PROCESS_RUNTIME_PHASES: SNAPSHOT_RUNTIME_PHASES,
  buildProcessPolicySnapshot,
  normalizeProcessPolicySnapshot,
  processAuthorityReferences
} = require('../runtime/process-execution-contract');
const {
  PROCESS_EXECUTION_POLICY: SHARED_EXECUTION_POLICY,
  PROCESS_RUNTIME_PHASES: SHARED_RUNTIME_PHASES,
  compareCanonicalStrings
} = require('../runtime/process-authority-constants');

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

function numberedId(prefix, index) {
  return `${prefix}-${String(index).padStart(3, '0')}`;
}

function catalogWithProfileCounts(counts) {
  return {
    version: 1,
    targets: counts.map((count, targetIndex) => ({
      id: numberedId('target', targetIndex),
      profiles: Array.from({ length: count }, (_, profileIndex) =>
        profile(numberedId('profile', profileIndex)))
    }))
  };
}

function canonicalizeForHash(value) {
  if (Array.isArray(value)) return value.map(canonicalizeForHash);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort(compareCanonicalStrings)
      .map(key => [key, canonicalizeForHash(value[key])]));
  }
  return value;
}

function hashJson(value) {
  return crypto.createHash('sha256')
    .update(JSON.stringify(canonicalizeForHash(value)))
    .digest('hex');
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
const punctuationIds = ['a_1', 'a0', 'a.1', 'a-1', 'b-target', '0-target'];
equal([...punctuationIds].sort(compareCanonicalStrings),
  ['0-target', 'a-1', 'a.1', 'a0', 'a_1', 'b-target'],
  'canonical string order is explicit for digits, hyphens, dots, letters, and underscores');
const punctuationCatalog = validateProcessTargetCatalog({
  version: 1,
  targets: punctuationIds.map(id => ({ id, profiles: [] }))
});
equal(punctuationCatalog.targets.map(target => target.id),
  ['0-target', 'a-1', 'a.1', 'a0', 'a_1', 'b-target'],
  'catalog target ordering uses the locale-independent canonical comparator');
const punctuationProfiles = validateProcessTargetCatalog({
  version: 1,
  targets: [{
    id: 'target',
    profiles: punctuationIds.map(id => profile(id))
  }]
});
equal(punctuationProfiles.targets[0].profiles.map(item => item.id),
  ['0-target', 'a-1', 'a.1', 'a0', 'a_1', 'b-target'],
  'catalog profile ordering uses the locale-independent canonical comparator');
const environmentOrder = validCatalog();
environmentOrder.targets[0].profiles[0].environment = {
  A_: 'underscore',
  AA: 'letters',
  A0: 'digit'
};
equal(Object.keys(validateProcessTargetCatalog(environmentOrder)
  .targets[0].profiles[0].environment), ['A0', 'AA', 'A_'],
'environment names use locale-independent canonical ordering');

equal(SNAPSHOT_RUNTIME_PHASES, SHARED_RUNTIME_PHASES,
  'snapshot validation consumes the shared runtime phase authority');
equal(PROCESS_RUNTIME_PHASES, SHARED_RUNTIME_PHASES,
  'catalog validation consumes the shared runtime phase authority');
equal(SNAPSHOT_EXECUTION_POLICY, SHARED_EXECUTION_POLICY,
  'snapshot validation consumes the shared fixed execution policy authority');
equal(PROCESS_EXECUTION_POLICY, SHARED_EXECUTION_POLICY,
  'catalog validation consumes the shared fixed execution policy authority');

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
equal(normalizeProcessProfileGrants([{
  targetId: 'target',
  profileIds: punctuationIds
}])[0].profileIds,
['0-target', 'a-1', 'a.1', 'a0', 'a_1', 'b-target'],
'granted profile IDs use locale-independent canonical ordering');
equal(normalizeProcessProfileGrants(punctuationIds.map(id => ({
  targetId: id,
  profileIds: ['profile']
}))).map(grant => grant.targetId),
['0-target', 'a-1', 'a.1', 'a0', 'a_1', 'b-target'],
'grant target IDs use locale-independent canonical ordering');
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
const punctuationSnapshot = buildProcessPolicySnapshot({
  capabilityEnabled: true,
  profiles: punctuationIds.map(profileId => ({
    ...resolvedProfiles[0],
    profileId
  })),
  capturedAt: '2026-07-27T12:00:00.000Z'
});
equal(punctuationSnapshot.profiles.map(item => item.profileId),
  ['0-target', 'a-1', 'a.1', 'a0', 'a_1', 'b-target'],
  'version-2 resolved profile hashing order uses the canonical comparator');
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

const maxTargets = PROCESS_AUTHORITY_CARDINALITY_LIMITS.maxTargetsPerCatalog;
equal(validateProcessTargetCatalog(catalogWithProfileCounts(Array(maxTargets).fill(0))).targets.length,
  maxTargets, 'catalog accepts exactly the target-count maximum');
assert.throws(
  () => validateProcessTargetCatalog(catalogWithProfileCounts(Array(maxTargets + 1).fill(0))),
  error => error && error.code === 'PROCESS_TARGET_CATALOG_INVALID'
);
passed += 1;
console.log('  ok catalog rejects maximum-plus-one targets');

const maxProfilesPerTarget =
  PROCESS_AUTHORITY_CARDINALITY_LIMITS.maxProfilesPerTarget;
equal(
  validateProcessTargetCatalog(catalogWithProfileCounts([maxProfilesPerTarget]))
    .targets[0].profiles.length,
  maxProfilesPerTarget,
  'catalog accepts exactly the per-target profile maximum'
);
assert.throws(
  () => validateProcessTargetCatalog(catalogWithProfileCounts([maxProfilesPerTarget + 1])),
  error => error && error.code === 'PROCESS_TARGET_CATALOG_INVALID'
);
passed += 1;
console.log('  ok catalog rejects maximum-plus-one profiles in one target');

const maxTotalProfiles =
  PROCESS_AUTHORITY_CARDINALITY_LIMITS.maxTotalProfilesPerCatalog;
const fullTargetCount = Math.floor(maxTotalProfiles / maxProfilesPerTarget);
const totalProfileCounts = Array(fullTargetCount).fill(maxProfilesPerTarget);
equal(
  validateProcessTargetCatalog(catalogWithProfileCounts(totalProfileCounts))
    .targets.reduce((sum, target) => sum + target.profiles.length, 0),
  maxTotalProfiles,
  'catalog accepts exactly the total-profile maximum'
);
assert.throws(
  () => validateProcessTargetCatalog(catalogWithProfileCounts([...totalProfileCounts, 1])),
  error => error && error.code === 'PROCESS_TARGET_CATALOG_INVALID'
);
passed += 1;
console.log('  ok catalog rejects maximum-plus-one total profiles');

const maxGrantEntries =
  PROCESS_AUTHORITY_CARDINALITY_LIMITS.maxGrantEntriesPerAgent;
const boundaryGrants = Array.from({ length: maxGrantEntries }, (_, index) => ({
  targetId: numberedId('grant-target', index),
  profileIds: ['profile-000']
}));
equal(normalizeProcessProfileGrants(boundaryGrants).length, maxGrantEntries,
  'agent configuration accepts exactly the grant-entry maximum');
assert.throws(
  () => normalizeProcessProfileGrants([
    ...boundaryGrants,
    { targetId: numberedId('grant-target', maxGrantEntries), profileIds: ['profile-000'] }
  ]),
  error => error && error.code === 'PROCESS_PROFILE_GRANTS_INVALID'
);
passed += 1;
console.log('  ok agent configuration rejects maximum-plus-one grant entries');

const maxProfileIdsPerGrant =
  PROCESS_AUTHORITY_CARDINALITY_LIMITS.maxProfileIdsPerGrant;
const boundaryProfileIds = Array.from(
  { length: maxProfileIdsPerGrant },
  (_, index) => numberedId('profile', index)
);
equal(normalizeProcessProfileGrants([{
  targetId: 'target-000',
  profileIds: boundaryProfileIds
}])[0].profileIds.length, maxProfileIdsPerGrant,
'agent configuration accepts exactly the profile-IDs-per-grant maximum');
assert.throws(
  () => normalizeProcessProfileGrants([{
    targetId: 'target-000',
    profileIds: [...boundaryProfileIds, numberedId('profile', maxProfileIdsPerGrant)]
  }]),
  error => error && error.code === 'PROCESS_PROFILE_GRANTS_INVALID'
);
passed += 1;
console.log('  ok agent configuration rejects maximum-plus-one profile IDs in a grant');

const maxResolvedProfiles =
  PROCESS_AUTHORITY_CARDINALITY_LIMITS.maxResolvedProfilesPerSnapshot;
const grantsForResolvedCount = count => {
  const counts = [];
  let remaining = count;
  while (remaining > 0) {
    const profileCount = Math.min(maxProfileIdsPerGrant, remaining);
    counts.push(profileCount);
    remaining -= profileCount;
  }
  const catalog = catalogWithProfileCounts(counts);
  const grants = counts.map((profileCount, targetIndex) => ({
    targetId: numberedId('target', targetIndex),
    profileIds: Array.from(
      { length: profileCount },
      (_, profileIndex) => numberedId('profile', profileIndex)
    )
  }));
  return { catalog, grants };
};
const resolvedBoundary = grantsForResolvedCount(maxResolvedProfiles);
const maximumResolvedAuthority = resolveProcessProfileGrants({
  capabilityEnabled: true,
  ...resolvedBoundary
});
equal(maximumResolvedAuthority.length, maxResolvedProfiles,
  'grant resolution accepts exactly the resolved-profile maximum');
const overResolvedBoundary = grantsForResolvedCount(maxResolvedProfiles + 1);
assert.throws(
  () => resolveProcessProfileGrants({
    capabilityEnabled: true,
    ...overResolvedBoundary
  }),
  error => error && error.code === 'PROCESS_PROFILE_GRANTS_INVALID'
);
passed += 1;
console.log('  ok grant resolution rejects maximum-plus-one resolved profiles');
equal(buildProcessPolicySnapshot({
  capabilityEnabled: true,
  profiles: maximumResolvedAuthority,
  capturedAt: '2026-07-27T12:00:00.000Z'
}).profiles.length, maxResolvedProfiles,
'version-2 snapshot accepts exactly the resolved-profile maximum');
const boundarySnapshot = buildProcessPolicySnapshot({
  capabilityEnabled: true,
  profiles: maximumResolvedAuthority,
  capturedAt: '2026-07-27T12:00:00.000Z'
});
const oversizedSnapshotWithoutHash = {
  version: boundarySnapshot.version,
  capabilityEnabled: boundarySnapshot.capabilityEnabled,
  profiles: [
    ...boundarySnapshot.profiles,
    {
      ...boundarySnapshot.profiles[0],
      targetId: 'target-extra',
      profileId: 'profile-extra'
    }
  ],
  capturedAt: boundarySnapshot.capturedAt
};
const oversizedSnapshotWithValidHash = {
  ...oversizedSnapshotWithoutHash,
  snapshotHash: hashJson(oversizedSnapshotWithoutHash)
};
equal(normalizeProcessPolicySnapshot(oversizedSnapshotWithValidHash), null,
  'a valid hash cannot make an oversized persisted version-2 snapshot authoritative');
assert.throws(
  () => buildProcessPolicySnapshot({
    capabilityEnabled: true,
    profiles: [
      ...maximumResolvedAuthority,
      resolveProcessProfileGrants({
        capabilityEnabled: true,
        catalog: catalogWithProfileCounts([1]),
        grants: [{ targetId: 'target-000', profileIds: ['profile-000'] }]
      })[0]
    ],
    capturedAt: '2026-07-27T12:00:00.000Z'
  }),
  RangeError
);
passed += 1;
console.log('  ok version-2 snapshot rejects maximum-plus-one resolved profiles before hashing');

const processAuthoritySources = fs.readdirSync(path.join(__dirname, '..', 'runtime'))
  .filter(name => /^process-(?:authority|execution|target).*\.js$/.test(name))
  .map(name => fs.readFileSync(path.join(__dirname, '..', 'runtime', name), 'utf8'))
  .join('\n');
ok(!processAuthoritySources.includes('localeCompare'),
  'process authority source contains no locale-dependent localeCompare ordering');

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

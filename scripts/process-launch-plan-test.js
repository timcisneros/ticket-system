#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  PROCESS_POLICY_SNAPSHOT_HISTORICAL_VERSION_2,
  PROCESS_POLICY_SNAPSHOT_VERSION,
  buildHistoricalProcessPolicySnapshotV1,
  buildProcessOperationIdentity,
  buildProcessPolicySnapshot,
  hashProcessContractValue,
  processAuthorityReferences
} = require('../runtime/process-execution-contract');
const {
  PROCESS_LAUNCH_PLAN_VERSION,
  buildProcessLaunchPlan,
  validateProcessLaunchPlan
} = require('../runtime/process-launch-plan');

const ROOT = path.resolve(__dirname, '..');
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

function throwsCode(fn, code, message) {
  assert.throws(fn, error => error && error.code === code, message);
  passed += 1;
  console.log(`  ok ${message}`);
}

function versionThreeProfile(overrides = {}) {
  return {
    targetId: 'ticket-system-local',
    profileId: 'syntax-check',
    allowedPhases: ['verification'],
    runtimeRootfs: {
      id: 'node-24-fedora-runtime-v1',
      manifestSha256: 'a'.repeat(64)
    },
    executableIdentity: {
      path: '/usr/bin/node',
      sha256: 'b'.repeat(64),
      format: 'elf'
    },
    arguments: ['--check', 'server.js'],
    workingDirectory: '.',
    environment: {
      SAFE_Z: 'last',
      CI: '1',
      SAFE_A: 'first'
    },
    filesystemPolicy: {
      inputMode: 'materialized_read_only',
      writableRoots: [],
      allowSymlinks: false,
      allowSpecialFiles: false,
      maxInputFiles: 10000,
      maxInputBytes: 268435456
    },
    limits: {
      wallTimeMs: 30000,
      maxOutputBytes: 1048576,
      maxProcesses: 8,
      memoryBytes: 268435456,
      cpuQuotaMicrosPer100ms: 100000,
      maxOpenFiles: 128,
      maxFileBytes: 16777216,
      maxTempBytes: 67108864
    },
    executionPolicy: {
      shell: false,
      stdin: 'disabled',
      detached: false,
      networkAccess: 'none',
      environmentMode: 'replace'
    },
    ...overrides
  };
}

const snapshotV3 = buildProcessPolicySnapshot({
  version: PROCESS_POLICY_SNAPSHOT_VERSION,
  capabilityEnabled: true,
  profiles: [versionThreeProfile()],
  capturedAt: '2026-07-27T12:00:00.000Z'
});
const workspaceSnapshot = {
  id: 'workspace-snapshot-001',
  manifestSha256: 'c'.repeat(64),
  fileCount: 123,
  totalBytes: 456789
};
const buildInput = {
  policySnapshot: snapshotV3,
  operationIdentity: buildProcessOperationIdentity(123, 'operation-001'),
  runId: 123,
  ticketId: 45,
  targetId: 'ticket-system-local',
  profileId: 'syntax-check',
  policySnapshotHash: snapshotV3.snapshotHash,
  runtimePhase: 'verification',
  workspaceSnapshot
};

const plan = buildProcessLaunchPlan(buildInput);
equal(plan.version, PROCESS_LAUNCH_PLAN_VERSION,
  'valid version-3 authority produces launch-plan version 1');
equal(validateProcessLaunchPlan(plan, { policySnapshot: snapshotV3 }), plan,
  'launch plan validates against the same immutable version-3 snapshot');
equal(plan.runtimeRootfs, snapshotV3.profiles[0].runtimeRootfs,
  'launch plan copies rootfs authority from the run snapshot');
equal(plan.executableIdentity, snapshotV3.profiles[0].executableIdentity,
  'launch plan copies executable authority from the run snapshot');
equal(plan.environment, snapshotV3.profiles[0].environment,
  'launch plan copies replacement environment only from the run snapshot');
equal(plan.limits, snapshotV3.profiles[0].limits,
  'launch plan copies all resource authority from the run snapshot');
equal(Object.keys(plan.environment), ['CI', 'SAFE_A', 'SAFE_Z'],
  'launch-plan environment ordering is canonical and locale-independent');
ok(Object.isFrozen(plan) &&
  Object.isFrozen(plan.runtimeRootfs) &&
  Object.isFrozen(plan.executableIdentity) &&
  Object.isFrozen(plan.arguments) &&
  Object.isFrozen(plan.environment) &&
  Object.isFrozen(plan.workspaceSnapshot) &&
  Object.isFrozen(plan.filesystemPolicy.writableRoots) &&
  Object.isFrozen(plan.limits) &&
  Object.isFrozen(plan.executionPolicy),
'launch plans are deeply immutable');

const repeatPlan = buildProcessLaunchPlan({
  workspaceSnapshot: {
    totalBytes: workspaceSnapshot.totalBytes,
    fileCount: workspaceSnapshot.fileCount,
    manifestSha256: workspaceSnapshot.manifestSha256,
    id: workspaceSnapshot.id
  },
  runtimePhase: buildInput.runtimePhase,
  policySnapshotHash: buildInput.policySnapshotHash,
  profileId: buildInput.profileId,
  targetId: buildInput.targetId,
  ticketId: buildInput.ticketId,
  runId: buildInput.runId,
  operationIdentity: buildInput.operationIdentity,
  policySnapshot: JSON.parse(JSON.stringify(snapshotV3))
});
equal(repeatPlan, plan,
  'launch-plan canonical ordering and hash are deterministic across input key order');

const historicalV1 = buildHistoricalProcessPolicySnapshotV1({
  capabilityEnabled: true,
  grants: [{
    targetId: 'ticket-system-local',
    profileIds: ['syntax-check']
  }],
  capturedAt: '2026-07-27T12:00:00.000Z'
});
const historicalV2 = buildProcessPolicySnapshot({
  version: PROCESS_POLICY_SNAPSHOT_HISTORICAL_VERSION_2,
  capabilityEnabled: true,
  profiles: [{
    targetId: 'ticket-system-local',
    profileId: 'syntax-check',
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
    executionPolicy: {
      shell: false,
      stdin: 'disabled',
      detached: false,
      networkAccess: 'none',
      environmentMode: 'replace'
    }
  }],
  capturedAt: '2026-07-27T12:00:00.000Z'
});
for (const [version, snapshot] of [[1, historicalV1], [2, historicalV2]]) {
  throwsCode(
    () => buildProcessLaunchPlan({
      ...buildInput,
      policySnapshot: snapshot,
      policySnapshotHash: snapshot.snapshotHash
    }),
    'PROCESS_POLICY_SNAPSHOT_NOT_EXECUTABLE',
    `historical version-${version} snapshot cannot produce a launch plan`
  );
}

throwsCode(() => buildProcessLaunchPlan({
  ...buildInput,
  policySnapshotHash: 'd'.repeat(64)
}), 'PROCESS_POLICY_SNAPSHOT_MISMATCH',
'launch-plan builder rejects a mismatched policy snapshot hash');
throwsCode(() => buildProcessLaunchPlan({
  ...buildInput,
  targetId: 'unknown-target'
}), 'PROCESS_TARGET_UNKNOWN',
'launch-plan builder rejects a mismatched target');
throwsCode(() => buildProcessLaunchPlan({
  ...buildInput,
  runtimePhase: 'inspection'
}), 'PROCESS_PHASE_DENIED',
'launch-plan builder rejects a phase not granted by the profile');
throwsCode(() => buildProcessLaunchPlan({
  ...buildInput,
  executableIdentity: { path: '/tmp/model-tool' }
}), 'PROCESS_LAUNCH_PLAN_INVALID',
'launch-plan builder rejects client-supplied executable authority');
throwsCode(() => buildProcessLaunchPlan({
  ...buildInput,
  limits: { maxProcesses: 64 }
}), 'PROCESS_LAUNCH_PLAN_INVALID',
'launch-plan builder rejects client-supplied limit authority');
throwsCode(() => buildProcessLaunchPlan({
  ...buildInput,
  environment: { EXTRA: 'model-controlled' }
}), 'PROCESS_LAUNCH_PLAN_INVALID',
'launch-plan builder rejects client-supplied environment authority');
throwsCode(() => buildProcessLaunchPlan({
  ...buildInput,
  runtimeRootfsPath: '/usr'
}), 'PROCESS_LAUNCH_PLAN_INVALID',
'launch-plan input rejects a raw rootfs host path');
throwsCode(() => buildProcessLaunchPlan({
  ...buildInput,
  workspaceSnapshot: {
    ...workspaceSnapshot,
    path: '/host/workspace'
  }
}), 'PROCESS_LAUNCH_PLAN_INVALID',
'workspace snapshot rejects a raw host path');
throwsCode(() => buildProcessLaunchPlan({
  ...buildInput,
  workspaceSnapshot: {
    ...workspaceSnapshot,
    fileCount: snapshotV3.profiles[0].filesystemPolicy.maxInputFiles + 1
  }
}), 'PROCESS_WORKSPACE_SNAPSHOT_INVALID',
'workspace snapshot cannot exceed the profile file-count policy');
throwsCode(() => buildProcessLaunchPlan({
  ...buildInput,
  workspaceSnapshot: {
    ...workspaceSnapshot,
    totalBytes: snapshotV3.profiles[0].filesystemPolicy.maxInputBytes + 1
  }
}), 'PROCESS_WORKSPACE_SNAPSHOT_INVALID',
'workspace snapshot cannot exceed the profile byte policy');
const boundaryWorkspacePlan = buildProcessLaunchPlan({
  ...buildInput,
  workspaceSnapshot: {
    ...workspaceSnapshot,
    fileCount: snapshotV3.profiles[0].filesystemPolicy.maxInputFiles,
    totalBytes: snapshotV3.profiles[0].filesystemPolicy.maxInputBytes
  }
});
equal(boundaryWorkspacePlan.workspaceSnapshot.fileCount, 10000,
  'workspace snapshot accepts the exact profile file-count boundary');
equal(boundaryWorkspacePlan.workspaceSnapshot.totalBytes, 268435456,
  'workspace snapshot accepts the exact profile byte boundary');

function tamperedPlan(mutator) {
  const candidate = structuredClone(plan);
  mutator(candidate);
  const withoutHash = { ...candidate };
  delete withoutHash.launchPlanHash;
  candidate.launchPlanHash = hashProcessContractValue(withoutHash);
  return candidate;
}

for (const [label, mutator, code = 'PROCESS_LAUNCH_PLAN_AUTHORITY_MISMATCH'] of [
  ['executable mismatch', value => { value.executableIdentity.path = '/usr/bin/other'; }],
  ['limit expansion', value => { value.limits.maxProcesses += 1; }],
  ['environment expansion', value => { value.environment.EXTRA = 'not-authorized'; }],
  ['execution-policy expansion', value => { value.executionPolicy.shell = true; }],
  ['filesystem-policy expansion', value => { value.filesystemPolicy.writableRoots = ['out']; }],
  ['rootfs host path', value => { value.runtimeRootfs.path = '/host/rootfs'; }],
  [
    'workspace host path',
    value => { value.workspaceSnapshot.path = '/host/workspace'; },
    'PROCESS_LAUNCH_PLAN_INVALID'
  ]
]) {
  throwsCode(
    () => validateProcessLaunchPlan(tamperedPlan(mutator), {
      policySnapshot: snapshotV3
    }),
    code,
    `validated launch plan rejects ${label}`
  );
}

const extraPlan = structuredClone(plan);
extraPlan.rawBubblewrapOptions = ['--share-net'];
throwsCode(
  () => validateProcessLaunchPlan(extraPlan, { policySnapshot: snapshotV3 }),
  'PROCESS_LAUNCH_PLAN_INVALID',
  'launch-plan validator rejects extra fields'
);

equal(processAuthorityReferences(snapshotV3, 'verification'), [],
  'version-3 authority remains non-dispatchable without a healthy sandbox gate');
const serverSource = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
ok(!serverSource.includes("require('./runtime/process-launch-plan')") &&
  !serverSource.includes('buildProcessLaunchPlan('),
'launch plans are not connected to server dispatch');
ok(!serverSource.includes('launchPlanHash') &&
  !serverSource.includes('workspaceSnapshot.manifestSha256'),
'private launch-plan material cannot enter the runtime/model envelope');

console.log(`\nPASS: process launch-plan Tranche 2A0 contract — ${passed} assertions`);

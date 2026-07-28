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
  validateProcessLaunchAuthorityContext,
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

function sandboxCapability(overrides = {}) {
  const now = Date.now();
  return {
    version: 1,
    status: 'containment_verified',
    generationId: 'sandbox-generation-001',
    launcherProtocolVersion: 1,
    launcherIdentityHash: 'd'.repeat(64),
    sandboxBackendIdentityHash: 'e'.repeat(64),
    seccompPolicyHash: 'f'.repeat(64),
    rootfsRegistryGeneration: 'rootfs-registry-001',
    materializerGeneration: 'materializer-001',
    delegatedCgroupIdentityHash: '1'.repeat(64),
    containmentProbeHash: '2'.repeat(64),
    verifiedAt: new Date(now - 1000).toISOString(),
    expiresAt: new Date(now + 240000).toISOString(),
    readyForExecution: true,
    ...overrides
  };
}

const snapshotV3 = buildProcessPolicySnapshot({
  version: PROCESS_POLICY_SNAPSHOT_VERSION,
  capabilityEnabled: true,
  profiles: [versionThreeProfile()],
  capturedAt: '2026-07-27T12:00:00.000Z'
});
const launchAuthorityContext = {
  runId: 123,
  ticketId: 45,
  currentPhase: 'verification',
  processPolicySnapshot: snapshotV3
};
const workspaceSnapshot = {
  id: 'workspace-snapshot-001',
  runId: launchAuthorityContext.runId,
  policySnapshotHash: snapshotV3.snapshotHash,
  materializerGeneration: 'materializer-001',
  manifestSha256: 'c'.repeat(64),
  fileCount: 123,
  totalBytes: 456789
};
const healthySandbox = sandboxCapability();
const buildInput = {
  launchAuthorityContext,
  operationId: 'operation-001',
  targetId: 'ticket-system-local',
  profileId: 'syntax-check',
  workspaceSnapshot,
  sandboxCapability: healthySandbox
};

const normalizedAuthority = validateProcessLaunchAuthorityContext(
  JSON.parse(JSON.stringify(launchAuthorityContext)),
  { targetId: buildInput.targetId, profileId: buildInput.profileId }
);
ok(Object.isFrozen(normalizedAuthority) &&
  Object.isFrozen(normalizedAuthority.processPolicySnapshot),
'launch-authority context is normalized, copied, and deeply frozen');
equal(normalizedAuthority, launchAuthorityContext,
  'launch-authority context retains only run, ticket, phase, and immutable snapshot authority');

const plan = buildProcessLaunchPlan(buildInput);
equal(plan.version, PROCESS_LAUNCH_PLAN_VERSION,
  'valid bound authority produces launch-plan version 1');
equal(plan.operationId, buildInput.operationId,
  'launch plan retains the validated run-scoped operation ID');
equal(plan.operationIdentity,
  buildProcessOperationIdentity(launchAuthorityContext.runId, buildInput.operationId),
  'launch plan derives operation identity from context runId and operationId');
equal(plan.runId, launchAuthorityContext.runId,
  'launch plan derives run identity from the launch-authority context');
equal(plan.ticketId, launchAuthorityContext.ticketId,
  'launch plan derives ticket identity from the launch-authority context');
equal(plan.runtimePhase, launchAuthorityContext.currentPhase,
  'launch plan derives runtime phase from the launch-authority context');
equal(plan.policySnapshotHash, snapshotV3.snapshotHash,
  'launch plan derives policy hash from the context snapshot');
equal(plan.workspaceSnapshot, workspaceSnapshot,
  'launch plan retains the fully bound workspace descriptor');
equal(plan.sandboxCapability, {
  generationId: healthySandbox.generationId,
  launcherProtocolVersion: healthySandbox.launcherProtocolVersion,
  launcherIdentityHash: healthySandbox.launcherIdentityHash,
  sandboxBackendIdentityHash: healthySandbox.sandboxBackendIdentityHash,
  seccompPolicyHash: healthySandbox.seccompPolicyHash,
  rootfsRegistryGeneration: healthySandbox.rootfsRegistryGeneration,
  materializerGeneration: healthySandbox.materializerGeneration,
  delegatedCgroupIdentityHash: healthySandbox.delegatedCgroupIdentityHash,
  containmentProbeHash: healthySandbox.containmentProbeHash
}, 'launch plan contains only the closed sandbox enforcement-generation projection');
equal(validateProcessLaunchPlan(plan, {
  launchAuthorityContext,
  sandboxCapability: healthySandbox
}), plan, 'launch plan validates against the same run and sandbox authority');
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
  Object.isFrozen(plan.sandboxCapability) &&
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
  sandboxCapability: { ...healthySandbox },
  workspaceSnapshot: {
    totalBytes: workspaceSnapshot.totalBytes,
    fileCount: workspaceSnapshot.fileCount,
    manifestSha256: workspaceSnapshot.manifestSha256,
    materializerGeneration: workspaceSnapshot.materializerGeneration,
    policySnapshotHash: workspaceSnapshot.policySnapshotHash,
    runId: workspaceSnapshot.runId,
    id: workspaceSnapshot.id
  },
  profileId: buildInput.profileId,
  targetId: buildInput.targetId,
  operationId: buildInput.operationId,
  launchAuthorityContext: {
    processPolicySnapshot: JSON.parse(JSON.stringify(snapshotV3)),
    currentPhase: launchAuthorityContext.currentPhase,
    ticketId: launchAuthorityContext.ticketId,
    runId: launchAuthorityContext.runId
  }
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
      launchAuthorityContext: {
        ...launchAuthorityContext,
        processPolicySnapshot: snapshot
      },
      workspaceSnapshot: {
        ...workspaceSnapshot,
        policySnapshotHash: snapshot.snapshotHash
      }
    }),
    'PROCESS_POLICY_SNAPSHOT_NOT_EXECUTABLE',
    `historical version-${version} snapshot cannot produce a launch plan`
  );
}

for (const [label, capability] of [
  ['missing', null],
  ['malformed', { ...healthySandbox, extra: true }],
  ['unhealthy', { ...healthySandbox, status: 'unhealthy' }],
  [
    'stale',
    sandboxCapability({
      verifiedAt: new Date(Date.now() - 300000).toISOString(),
      expiresAt: new Date(Date.now() - 1000).toISOString()
    })
  ]
]) {
  throwsCode(
    () => buildProcessLaunchPlan({ ...buildInput, sandboxCapability: capability }),
    'PROCESS_SANDBOX_UNAVAILABLE',
    `${label} sandbox capability cannot produce a launch plan`
  );
}

throwsCode(() => buildProcessLaunchPlan({
  ...buildInput,
  operationIdentity: buildProcessOperationIdentity(123, 'operation-001')
}), 'PROCESS_LAUNCH_PLAN_INVALID',
'launch-plan builder rejects independently supplied operation identity');
throwsCode(() => buildProcessLaunchPlan({
  ...buildInput,
  operationId: 'INVALID'
}), 'PROCESS_LAUNCH_PLAN_INVALID',
'launch-plan builder rejects an invalid operation ID');
throwsCode(() => buildProcessLaunchPlan({
  ...buildInput,
  runId: 123
}), 'PROCESS_LAUNCH_PLAN_INVALID',
'launch-plan builder rejects a duplicate free-standing run ID');
throwsCode(() => buildProcessLaunchPlan({
  ...buildInput,
  runtimePhase: 'verification'
}), 'PROCESS_LAUNCH_PLAN_INVALID',
'launch-plan builder rejects a duplicate free-standing runtime phase');
throwsCode(() => buildProcessLaunchPlan({
  ...buildInput,
  launchAuthorityContext: {
    ...launchAuthorityContext,
    extra: 'not-authority'
  }
}), 'PROCESS_LAUNCH_PLAN_INVALID',
'launch-authority context rejects extra fields');
for (const field of ['runId', 'ticketId']) {
  throwsCode(() => buildProcessLaunchPlan({
    ...buildInput,
    launchAuthorityContext: {
      ...launchAuthorityContext,
      [field]: 0
    }
  }), 'PROCESS_LAUNCH_PLAN_INVALID',
  `launch-authority context requires a positive ${field}`);
}
throwsCode(() => buildProcessLaunchPlan({
  ...buildInput,
  targetId: 'unknown-target'
}), 'PROCESS_TARGET_UNKNOWN',
'launch-authority context rejects a mismatched target');
throwsCode(() => buildProcessLaunchPlan({
  ...buildInput,
  launchAuthorityContext: {
    ...launchAuthorityContext,
    currentPhase: 'inspection'
  }
}), 'PROCESS_PHASE_DENIED',
'launch-authority context rejects a phase not granted by the profile');

for (const [label, descriptor] of [
  ['another run', { ...workspaceSnapshot, runId: 124 }],
  [
    'another policy snapshot',
    { ...workspaceSnapshot, policySnapshotHash: '9'.repeat(64) }
  ],
  [
    'another materializer generation',
    { ...workspaceSnapshot, materializerGeneration: 'materializer-002' }
  ]
]) {
  throwsCode(
    () => buildProcessLaunchPlan({ ...buildInput, workspaceSnapshot: descriptor }),
    'PROCESS_WORKSPACE_SNAPSHOT_MISMATCH',
    `workspace descriptor substitution from ${label} is rejected`
  );
}

for (const [field, value, message] of [
  ['fileCount', snapshotV3.profiles[0].filesystemPolicy.maxInputFiles + 1,
    'workspace snapshot cannot exceed the profile file-count policy'],
  ['totalBytes', snapshotV3.profiles[0].filesystemPolicy.maxInputBytes + 1,
    'workspace snapshot cannot exceed the profile byte policy']
]) {
  throwsCode(() => buildProcessLaunchPlan({
    ...buildInput,
    workspaceSnapshot: { ...workspaceSnapshot, [field]: value }
  }), 'PROCESS_WORKSPACE_SNAPSHOT_INVALID', message);
}
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

for (const [label, expansion] of [
  ['executable authority', { executableIdentity: { path: '/tmp/model-tool' } }],
  ['resource authority', { limits: { maxProcesses: 64 } }],
  ['environment authority', { environment: { EXTRA: 'model-controlled' } }],
  ['raw rootfs host path', { runtimeRootfsPath: '/usr' }]
]) {
  throwsCode(
    () => buildProcessLaunchPlan({ ...buildInput, ...expansion }),
    'PROCESS_LAUNCH_PLAN_INVALID',
    `launch-plan builder rejects client-supplied ${label}`
  );
}
throwsCode(() => buildProcessLaunchPlan({
  ...buildInput,
  workspaceSnapshot: { ...workspaceSnapshot, path: '/host/workspace' }
}), 'PROCESS_LAUNCH_PLAN_INVALID',
'workspace snapshot rejects a raw host path');

function tamperedPlan(mutator) {
  const candidate = structuredClone(plan);
  mutator(candidate);
  const withoutHash = { ...candidate };
  delete withoutHash.launchPlanHash;
  candidate.launchPlanHash = hashProcessContractValue(withoutHash);
  return candidate;
}

for (const [label, mutator, code = 'PROCESS_LAUNCH_PLAN_AUTHORITY_MISMATCH'] of [
  ['operation ID/identity conflict', value => { value.operationId = 'operation-002'; }],
  [
    'operation identity from another run',
    value => {
      value.operationIdentity = buildProcessOperationIdentity(124, value.operationId);
    }
  ],
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
      launchAuthorityContext,
      sandboxCapability: healthySandbox
    }),
    code,
    `validated launch plan rejects ${label}`
  );
}

const anotherSandboxGeneration = sandboxCapability({
  generationId: 'sandbox-generation-002',
  launcherIdentityHash: '8'.repeat(64)
});
throwsCode(
  () => validateProcessLaunchPlan(plan, {
    launchAuthorityContext,
    sandboxCapability: anotherSandboxGeneration
  }),
  'PROCESS_LAUNCH_PLAN_AUTHORITY_MISMATCH',
  'plan built under one sandbox generation does not validate under another'
);

const extraPlan = structuredClone(plan);
extraPlan.rawBubblewrapOptions = ['--share-net'];
throwsCode(
  () => validateProcessLaunchPlan(extraPlan, {
    launchAuthorityContext,
    sandboxCapability: healthySandbox
  }),
  'PROCESS_LAUNCH_PLAN_INVALID',
  'launch-plan validator rejects extra fields'
);

equal(processAuthorityReferences(snapshotV3, 'verification'), [],
  'a snapshot without admitted runtime capability remains absent from the model envelope');
const serverSource = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
ok(!serverSource.includes("require('./runtime/process-launch-plan')") &&
  !serverSource.includes('buildProcessLaunchPlan('),
'server dispatch delegates private launch-plan construction to the process controller');
ok(!/processTargets[\s\S]{0,500}(?:executableIdentity|runtimeRootfs|launchPlanHash)/.test(serverSource),
'private executable and launch-plan authority cannot enter the model envelope');

console.log(`\nPASS: process launch-plan Tranche 2A0 integrity — ${passed} assertions`);

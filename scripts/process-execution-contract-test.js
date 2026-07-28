#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  PROCESS_AUTHORITY_RULE,
  PROCESS_EVIDENCE_CONTRACT,
  PROCESS_IDENTIFIER_MAX_LENGTH,
  PROCESS_INLINE_OUTPUT_MAX_BYTES,
  PROCESS_NETWORK_ACCESS_NONE_MEANING,
  PROCESS_OPERATION,
  PROCESS_PHASE_AUTHORITY_RULE,
  PROCESS_POLICY_SNAPSHOT_HISTORICAL_VERSION_2,
  PROCESS_POLICY_SNAPSHOT_VERSION,
  PROCESS_PRE_EXECUTION_EVIDENCE_FIELDS,
  PROCESS_RESOURCE_LIMIT_CAUSES,
  PROCESS_TERMINAL_EVIDENCE_FIELDS,
  PROCESS_TERMINAL_OUTCOMES,
  buildHistoricalProcessPolicySnapshotV1,
  buildProcessOperationIdentity,
  buildProcessOperationResolutionRecord,
  buildProcessPolicySnapshot,
  classifyProcessOperationIdReuse,
  isProcessContractFeatureEnabled,
  historicalProcessGrantReferences,
  normalizeProcessPolicySnapshot,
  parseProcessOperationRequest,
  processAuthorityReferences,
  refuseProcessOperation,
  resolveProcessOperationRequest,
  restoreProcessOperationResolution,
  validateProcessEvidenceRecord,
  validateProcessOperationResolutionRecord,
  validateProcessResourceLimitCause,
  validateProcessTerminalOutcome
} = require('../runtime/process-execution-contract');

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

const request = {
  operation: PROCESS_OPERATION,
  args: {
    targetId: 'trusted-target',
    profileId: 'readonly-profile',
    operationId: 'operation-001'
  }
};

equal(parseProcessOperationRequest(request), request, 'well-formed runProcess request parses');

for (const field of ['targetId', 'profileId', 'operationId']) {
  for (const invalidValue of [
    '',
    '   ',
    ` ${request.args[field]}`,
    `${request.args[field]} `,
    `${request.args[field]}\u0000`,
    'UPPERCASE',
    'slash/value',
    'value:scope',
    `a${'b'.repeat(PROCESS_IDENTIFIER_MAX_LENGTH)}`
  ]) {
    throwsCode(
      () => parseProcessOperationRequest({
        ...request,
        args: { ...request.args, [field]: invalidValue }
      }),
      'PROCESS_REQUEST_MALFORMED',
      `${field} rejects invalid identifier ${JSON.stringify(invalidValue)}`
    );
  }
}
const maximumIdentifier = `a${'b'.repeat(PROCESS_IDENTIFIER_MAX_LENGTH - 1)}`;
equal(
  parseProcessOperationRequest({
    ...request,
    args: { ...request.args, operationId: maximumIdentifier }
  }).args.operationId,
  maximumIdentifier,
  'identifier at the maximum length is accepted without normalization'
);

const operationIdentity = buildProcessOperationIdentity(41, request.args.operationId);
equal(buildProcessOperationIdentity(41, request.args.operationId), operationIdentity,
  'run-scoped operation identity is deterministic');
ok(buildProcessOperationIdentity(42, request.args.operationId) !== operationIdentity,
  'the same operationId in another run has a distinct identity');
equal(classifyProcessOperationIdReuse({
  runId: 41,
  requested: request.args
}).status, 'new', 'first use of an operationId is new');
equal(classifyProcessOperationIdReuse({
  runId: 41,
  requested: request.args,
  existing: { ...request.args }
}), {
  status: 'idempotent_replay',
  identity: operationIdentity,
  request: request.args
}, 'an exact repeated request has the same run-scoped canonical identity');
throwsCode(
  () => classifyProcessOperationIdReuse({
    runId: 41,
    requested: { ...request.args, profileId: 'different-profile' },
    existing: request.args
  }),
  'PROCESS_OPERATION_ID_CONFLICT',
  'conflicting reuse of one run-scoped operationId is rejected'
);

const enabledSnapshot = buildProcessPolicySnapshot({
  capabilityEnabled: true,
  profiles: [{
    targetId: 'trusted-target',
    profileId: 'readonly-profile',
    allowedPhases: ['inspection'],
    executable: '/trusted/bin/tool',
    arguments: ['--bounded'],
    workingDirectory: '.',
    environment: { CI: '1' },
    limits: { wallTimeMs: 1000, maxOutputBytes: 1024, maxProcesses: 1 },
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
equal(enabledSnapshot.version, PROCESS_POLICY_SNAPSHOT_HISTORICAL_VERSION_2,
  'legacy resolved profiles continue to build historical version-2 snapshots');

const versionThreeSnapshot = buildProcessPolicySnapshot({
  version: PROCESS_POLICY_SNAPSHOT_VERSION,
  capabilityEnabled: true,
  profiles: [{
    targetId: 'trusted-target',
    profileId: 'readonly-profile',
    allowedPhases: ['inspection'],
    runtimeRootfs: {
      id: 'node-24-runtime-v1',
      manifestSha256: 'a'.repeat(64)
    },
    executableIdentity: {
      path: '/usr/bin/node',
      sha256: 'b'.repeat(64),
      format: 'elf'
    },
    arguments: ['--check', 'server.js'],
    workingDirectory: '.',
    environment: { CI: '1' },
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
    }
  }],
  capturedAt: '2026-07-27T12:00:00.000Z'
});
equal(versionThreeSnapshot.version, 3, 'complete authority builds a version-3 snapshot');
equal(
  normalizeProcessPolicySnapshot(JSON.parse(JSON.stringify(versionThreeSnapshot))),
  versionThreeSnapshot,
  'version-3 snapshot survives persistence normalization deterministically'
);
equal(processAuthorityReferences(versionThreeSnapshot, 'inspection'), [],
  'version-3 snapshot alone does not advertise model-dispatchable authority');
equal(resolveProcessOperationRequest(request, versionThreeSnapshot, 'inspection').code,
  'PROCESS_EXECUTOR_UNAVAILABLE',
  'direct version-3 resolution remains executor-free');
equal(
  resolveProcessOperationRequest({
    ...request,
    args: { ...request.args, targetId: 'unknown-target' }
  }, enabledSnapshot, 'inspection').code,
  'PROCESS_TARGET_UNKNOWN',
  'unknown target is deterministically policy-denied'
);
equal(
  resolveProcessOperationRequest({
    ...request,
    args: { ...request.args, profileId: 'unknown-profile' }
  }, enabledSnapshot, 'inspection').code,
  'PROCESS_PROFILE_UNKNOWN',
  'unknown profile is deterministically policy-denied'
);

for (const field of ['targetId', 'profileId', 'operationId']) {
  const args = { ...request.args };
  delete args[field];
  throwsCode(
    () => parseProcessOperationRequest({ operation: PROCESS_OPERATION, args }),
    'PROCESS_REQUEST_MALFORMED',
    `missing ${field} is rejected`
  );
}

const forbiddenFields = [
  'command', 'executable', 'executablePath', 'args', 'argumentVector',
  'environment', 'env', 'workingDirectory', 'cwd', 'timeout', 'timeoutMs',
  'resourceLimits', 'shell', 'stdin', 'inputRedirection', 'stdout',
  'outputRedirection', 'pipeline', 'background', 'detached'
];
for (const field of forbiddenFields) {
  throwsCode(
    () => parseProcessOperationRequest({
      ...request,
      args: { ...request.args, [field]: field === 'args' ? [] : 'model-controlled' }
    }),
    'PROCESS_REQUEST_MALFORMED',
    `model-supplied ${field} is rejected`
  );
}
throwsCode(
  () => parseProcessOperationRequest({ ...request, command: 'forbidden' }),
  'PROCESS_REQUEST_MALFORMED',
  'extra model-supplied executable field on the action envelope is rejected'
);

equal(isProcessContractFeatureEnabled({}), false, 'process contract capability is disabled by default');
const defaultSnapshot = buildProcessPolicySnapshot({
  capabilityEnabled: isProcessContractFeatureEnabled({}),
  profiles: [],
  capturedAt: '2026-07-27T12:00:00.000Z'
});
equal(resolveProcessOperationRequest(request, defaultSnapshot, 'inspection').disposition, 'disabled',
  'default snapshot resolves runProcess as disabled');
const featureOnlySnapshot = buildProcessPolicySnapshot({
  capabilityEnabled: true,
  profiles: [],
  capturedAt: '2026-07-27T12:00:00.000Z'
});
equal(processAuthorityReferences(featureOnlySnapshot), [],
  'enabling the contract grants no target or profile authority');
equal(resolveProcessOperationRequest(request, featureOnlySnapshot, 'inspection').code, 'PROCESS_TARGET_UNKNOWN',
  'an existing non-process target cannot become process authority implicitly');

equal(resolveProcessOperationRequest(request, enabledSnapshot, 'inspection').disposition, 'unsupported',
  'authorized request resolves as unsupported because no executor exists');
const authorizedResolution = resolveProcessOperationRequest(request, enabledSnapshot, 'inspection');
const persistedAuthorizedResolution = buildProcessOperationResolutionRecord({
  resolution: authorizedResolution,
  runId: 41,
  ticketId: 2
});
equal(Object.keys(persistedAuthorizedResolution), [
  'operationId',
  'runId',
  'ticketId',
  'targetId',
  'profileId',
  'disposition',
  'code',
  'authorityStatus',
  'terminalOutcome',
  'runtimePhase',
  'policySnapshotHash',
  'message',
  'enforcementCause'
], 'persisted process resolution carries every reconstruction field');
equal(restoreProcessOperationResolution(persistedAuthorizedResolution, request),
  authorizedResolution,
  'same-phase exact replay reconstructs the original authorized resolution');
const authorizedReplayAfterDeniedPhase = restoreProcessOperationResolution(
  persistedAuthorizedResolution,
  request
);
equal({
  code: authorizedReplayAfterDeniedPhase.code,
  runtimePhase: authorizedReplayAfterDeniedPhase.runtimePhase,
  policySnapshotHash: authorizedReplayAfterDeniedPhase.policySnapshotHash
}, {
  code: 'PROCESS_EXECUTOR_UNAVAILABLE',
  runtimePhase: 'inspection',
  policySnapshotHash: enabledSnapshot.snapshotHash
}, 'authorized replay preserves its original phase and hash when a later phase would deny it');

const phaseDeniedResolution = resolveProcessOperationRequest(request, enabledSnapshot, 'verification');
const persistedPhaseDeniedResolution = buildProcessOperationResolutionRecord({
  resolution: phaseDeniedResolution,
  runId: 41,
  ticketId: 2
});
const deniedReplayAfterPermittedPhase = restoreProcessOperationResolution(
  persistedPhaseDeniedResolution,
  request
);
equal({
  code: deniedReplayAfterPermittedPhase.code,
  authorityStatus: deniedReplayAfterPermittedPhase.authorityStatus,
  runtimePhase: deniedReplayAfterPermittedPhase.runtimePhase,
  policySnapshotHash: deniedReplayAfterPermittedPhase.policySnapshotHash
}, {
  code: 'PROCESS_PHASE_DENIED',
  authorityStatus: 'denied',
  runtimePhase: 'verification',
  policySnapshotHash: enabledSnapshot.snapshotHash
}, 'phase-denied replay remains denied when a later phase would permit the profile');
assert.throws(
  () => validateProcessOperationResolutionRecord({
    ...persistedAuthorizedResolution,
    authorityStatus: 'denied'
  }),
  TypeError
);
passed += 1;
console.log('  ok malformed persisted resolution cannot contradict its typed code');
throwsCode(
  () => restoreProcessOperationResolution(persistedAuthorizedResolution, {
    ...request,
    args: { ...request.args, profileId: 'different-profile' }
  }),
  'PROCESS_OPERATION_ID_CONFLICT',
  'persisted exact-replay reconstruction retains typed conflicting-reuse rejection'
);
throwsCode(
  () => refuseProcessOperation(request, enabledSnapshot, 'inspection'),
  'PROCESS_EXECUTOR_UNAVAILABLE',
  'enabling and authorizing the contract still cannot execute a process'
);
const contractSource = fs.readFileSync(path.join(ROOT, 'runtime/process-execution-contract.js'), 'utf8');
const targetCatalogSource = fs.readFileSync(path.join(ROOT, 'runtime/process-target-catalog.js'), 'utf8');
const launchPlanSource = fs.readFileSync(path.join(ROOT, 'runtime/process-launch-plan.js'), 'utf8');
const serverSource = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
const processAuthoritySource = contractSource + targetCatalogSource + launchPlanSource;
ok(!/require\s*\(\s*['"]child_process['"]\s*\)/.test(processAuthoritySource),
  'process authority and launch-plan contracts import no child_process API');
ok(!/\b(?:spawn|execFile|exec)\s*\(/.test(processAuthoritySource),
  'process authority and launch-plan contracts contain no process-launch call');
ok(!/\b(?:bwrap|bubblewrap|systemctl|systemd-run|unshare|nsenter|cgexec|cgcreate)\b/i
  .test(processAuthoritySource),
'process authority and launch-plan contracts invoke no sandbox or service command');
const phaseCatalogSource = serverSource.match(/const PHASE_OPERATIONS = \{[\s\S]*?\n\};/);
ok(Boolean(phaseCatalogSource) &&
  !phaseCatalogSource[0].includes('runProcess') &&
  !phaseCatalogSource[0].includes('AGENT_PROCESS_OPERATIONS'),
'runProcess has no contradictory global phase catalog classification');
const processCatalogSource = serverSource.match(
  /name: PROCESS_OPERATION,[\s\S]*?provenanceSurface: 'Immutable run processPolicySnapshot[^']*'/
);
ok(Boolean(processCatalogSource) && !/\bmutating\s*:/.test(processCatalogSource[0]),
  'runProcess has no global mutating boolean classification');
ok(serverSource.includes('slot: `${operationIdentity}:resolution`') &&
  !serverSource.includes('request.operationId}:resolution'),
'evidence slots use the canonical run-scoped identity instead of raw operationId interpolation');

for (const outcome of PROCESS_TERMINAL_OUTCOMES) {
  equal(validateProcessTerminalOutcome(outcome), outcome, `terminal outcome ${outcome} is accepted`);
}
for (const outcome of ['', 'failed', 'unknown', 'success', null, 1]) {
  assert.throws(() => validateProcessTerminalOutcome(outcome), TypeError);
  passed += 1;
  console.log(`  ok invalid terminal outcome ${JSON.stringify(outcome)} is rejected`);
}

equal(Object.keys(PROCESS_EVIDENCE_CONTRACT.preExecution), [...PROCESS_PRE_EXECUTION_EVIDENCE_FIELDS],
  'pre-execution evidence fields are frozen by the machine-readable contract');
equal(Object.keys(PROCESS_EVIDENCE_CONTRACT.terminal), [...PROCESS_TERMINAL_EVIDENCE_FIELDS],
  'terminal evidence fields are frozen by the machine-readable contract');
const evidence = validateProcessEvidenceRecord({
  operationId: 'operation-001',
  runId: 1,
  ticketId: 2,
  targetId: 'trusted-target',
  profileId: 'readonly-profile',
  policySnapshotHash: enabledSnapshot.snapshotHash,
  terminalOutcome: 'policy_denied',
  enforcementCause: {
    kind: 'contract_resolution',
    disposition: 'policy_denied',
    errorCode: 'PROCESS_TARGET_UNKNOWN'
  }
});
ok(Object.isFrozen(evidence), 'validated process evidence is immutable in memory');
assert.throws(
  () => validateProcessEvidenceRecord({ ...evidence, environment: { SECRET_NAME: 'secret' } }),
  TypeError
);
passed += 1;
console.log('  ok secret environment values are outside the evidence schema');

const preExecutionEvidence = {
  operationId: 'operation-002',
  runId: 1,
  ticketId: 2,
  targetId: 'trusted-target',
  profileId: 'readonly-profile',
  resolvedExecutable: '/trusted/bin/tool',
  argumentVector: ['--bounded', 'value'],
  workingDirectory: '/trusted/work',
  declaredEnvironmentVariableNames: ['PATH', 'SAFE_NAME'],
  policySnapshotHash: enabledSnapshot.snapshotHash,
  startedAt: '2026-07-27T12:00:01.000Z'
};
equal(validateProcessEvidenceRecord(preExecutionEvidence), preExecutionEvidence,
  'complete pre-execution evidence satisfies the structural contract');

const completedEvidence = {
  ...preExecutionEvidence,
  finishedAt: '2026-07-27T12:00:02.000Z',
  durationMs: 1000,
  pid: 123,
  processGroupId: 123,
  exitCode: 0,
  terminalOutcome: 'completed',
  stdoutByteCount: 5,
  stderrByteCount: 0,
  stdoutTruncated: false,
  stderrTruncated: false,
  stdoutInline: 'done'
};
equal(validateProcessEvidenceRecord(completedEvidence), completedEvidence,
  'well-formed completed evidence satisfies the structural contract');

const terminalEvidenceByOutcome = {
  completed: completedEvidence,
  failed_to_start: {
    ...preExecutionEvidence,
    finishedAt: '2026-07-27T12:00:02.000Z',
    durationMs: 1,
    terminalOutcome: 'failed_to_start',
    enforcementCause: { kind: 'start_error' }
  },
  exited_nonzero: { ...completedEvidence, terminalOutcome: 'exited_nonzero', exitCode: 2 },
  signaled: {
    ...completedEvidence,
    terminalOutcome: 'signaled',
    exitCode: null,
    terminatingSignal: 'SIGTERM'
  },
  timed_out: {
    ...completedEvidence,
    terminalOutcome: 'timed_out',
    enforcementCause: { kind: 'timeout' }
  },
  cancelled: {
    ...completedEvidence,
    terminalOutcome: 'cancelled',
    enforcementCause: { kind: 'cancellation' }
  },
  output_limit_exceeded: {
    ...completedEvidence,
    terminalOutcome: 'output_limit_exceeded',
    enforcementCause: { kind: 'output_limit' }
  },
  resource_limit_exceeded: {
    ...completedEvidence,
    terminalOutcome: 'resource_limit_exceeded',
    enforcementCause: { kind: 'resource_limit', cause: 'memory' }
  },
  policy_denied: evidence,
  runtime_interrupted: {
    ...completedEvidence,
    terminalOutcome: 'runtime_interrupted',
    enforcementCause: { kind: 'runtime_interruption' }
  }
};
for (const outcome of PROCESS_TERMINAL_OUTCOMES) {
  equal(validateProcessEvidenceRecord(terminalEvidenceByOutcome[outcome]),
    terminalEvidenceByOutcome[outcome],
    `terminal evidence schema accepts a well-formed ${outcome} record`);
}
equal(PROCESS_RESOURCE_LIMIT_CAUSES, [
  'memory',
  'process_count',
  'cpu',
  'open_files',
  'file_size',
  'temporary_storage',
  'launcher_capacity'
], 'resource-limit causes are a frozen structured taxonomy');
for (const cause of PROCESS_RESOURCE_LIMIT_CAUSES) {
  equal(validateProcessResourceLimitCause({
    kind: 'resource_limit',
    cause
  }), {
    kind: 'resource_limit',
    cause
  }, `resource-limit cause ${cause} is accepted`);
}
for (const malformedCause of [
  { kind: 'resource_limit', cause: 'unknown' },
  { kind: 'memory', cause: 'memory' },
  { kind: 'resource_limit' },
  { kind: 'resource_limit', cause: 'memory', detail: 'extra' },
  'memory'
]) {
  assert.throws(() => validateProcessResourceLimitCause(malformedCause), TypeError);
  passed += 1;
  console.log(`  ok malformed resource-limit cause is rejected: ${JSON.stringify(malformedCause)}`);
}

const malformedEvidenceCases = [
  [{ ...preExecutionEvidence, runId: '1' }, 'string runId'],
  [{ ...preExecutionEvidence, durationMs: -1 }, 'negative integer'],
  [{ ...preExecutionEvidence, startedAt: 'not-a-timestamp' }, 'invalid timestamp'],
  [{ ...preExecutionEvidence, argumentVector: ['ok', 1] }, 'non-string argument'],
  [{ ...preExecutionEvidence, declaredEnvironmentVariableNames: ['SAFE=value'] }, 'environment value in names'],
  [{ ...preExecutionEvidence, declaredEnvironmentVariableNames: ['SAFE', 'SAFE'] }, 'duplicate environment name'],
  [{ ...preExecutionEvidence, terminalOutcome: null, stdoutTruncated: 'false' }, 'non-boolean truncation state'],
  [{ ...preExecutionEvidence, terminalOutcome: undefined }, 'undefined instead of absent or null'],
  [{ ...preExecutionEvidence, stdoutInline: 'inline', stdoutArtifactRef: 'artifact:stdout' }, 'dual stdout storage'],
  [{ ...completedEvidence, stdoutInline: 'x'.repeat(PROCESS_INLINE_OUTPUT_MAX_BYTES + 1) }, 'unbounded inline output'],
  [{ ...completedEvidence, stdoutInline: null, stdoutArtifactRef: '' }, 'empty artifact reference'],
  [Object.fromEntries(Object.entries(preExecutionEvidence).filter(([key]) => key !== 'resolvedExecutable')), 'missing pre-execution field'],
  [{ ...evidence, resolvedExecutable: '/must/not/resolve' }, 'policy denial with resolved executable'],
  [{ ...completedEvidence, exitCode: 2 }, 'completed with nonzero exit'],
  [{ ...completedEvidence, terminalOutcome: 'exited_nonzero', exitCode: 0 }, 'nonzero outcome with zero exit'],
  [{ ...completedEvidence, terminalOutcome: 'signaled', exitCode: null, terminatingSignal: null }, 'signaled without signal'],
  [{
    ...completedEvidence,
    terminalOutcome: 'failed_to_start',
    pid: 123,
    exitCode: null,
    stdoutByteCount: null,
    stderrByteCount: null,
    stdoutTruncated: null,
    stderrTruncated: null,
    enforcementCause: { kind: 'start_error' }
  }, 'failed-to-start with PID'],
  [{ ...completedEvidence, terminalOutcome: 'timed_out', enforcementCause: null }, 'timeout without cause'],
  [{ ...evidence, enforcementCause: { kind: 'denial', environment: { SECRET_NAME: 'secret' } } }, 'nested environment values']
];
for (const [malformed, label] of malformedEvidenceCases) {
  assert.throws(() => validateProcessEvidenceRecord(malformed), TypeError);
  passed += 1;
  console.log(`  ok malformed evidence is rejected: ${label}`);
}

const mutableConfiguration = [{
  ...JSON.parse(JSON.stringify(enabledSnapshot.profiles[0])),
  targetId: 'historical-target',
  profileId: 'historical-profile',
  arguments: ['--historical']
}];
const historicalSnapshot = buildProcessPolicySnapshot({
  capabilityEnabled: true,
  profiles: mutableConfiguration,
  capturedAt: '2026-07-27T12:30:00.000Z'
});
const historicalHash = historicalSnapshot.snapshotHash;
mutableConfiguration[0].targetId = 'changed-target';
mutableConfiguration[0].profileId = 'changed-profile';
mutableConfiguration[0].arguments[0] = '--changed';
equal(historicalSnapshot.snapshotHash, historicalHash,
  'later configuration mutation does not change historical snapshot hash');
equal(processAuthorityReferences(historicalSnapshot), [{
  targetId: 'historical-target',
  profileIds: ['historical-profile']
}], 'later configuration mutation does not change historical resolved authority');
equal(
  resolveProcessOperationRequest({
    operation: PROCESS_OPERATION,
    args: {
      targetId: 'historical-target',
      profileId: 'historical-profile',
      operationId: 'historical-operation'
    }
  }, historicalSnapshot, 'inspection').disposition,
  'unsupported',
  'historical request continues to resolve from its captured snapshot'
);
equal(normalizeProcessPolicySnapshot(JSON.parse(JSON.stringify(historicalSnapshot))), historicalSnapshot,
  'historical process policy snapshot survives persistence round-trip');

const versionOneSnapshot = buildHistoricalProcessPolicySnapshotV1({
  capabilityEnabled: true,
  grants: [{ targetId: 'historical-target', profileIds: ['historical-profile'] }],
  capturedAt: '2026-07-27T12:00:00.000Z'
});
equal(normalizeProcessPolicySnapshot(JSON.parse(JSON.stringify(versionOneSnapshot))), versionOneSnapshot,
  'version-1 historical grant-reference snapshots remain readable');
equal(historicalProcessGrantReferences(versionOneSnapshot), [{
  targetId: 'historical-target',
  profileIds: ['historical-profile']
}], 'version-1 historical grant references remain inspectable');
equal(processAuthorityReferences(versionOneSnapshot, 'inspection'), [],
  'version-1 historical snapshots receive no executable authority');
equal(resolveProcessOperationRequest(request, versionOneSnapshot, 'inspection').code,
  'PROCESS_TARGET_UNKNOWN',
  'version-1 references are not reinterpreted through any live catalog');

equal(PROCESS_AUTHORITY_RULE, [
  'The model requests an existing process profile.',
  'The runtime resolves and enforces authority.',
  'The target configuration grants authority.',
  'Process output is evidence, not authority.'
], 'authority rule is exact');
equal(
  PROCESS_NETWORK_ACCESS_NONE_MEANING,
  'The process and its descendants cannot communicate with anything outside their operation sandbox.',
  'networkAccess none has an exact external-communication meaning'
);
equal(PROCESS_PHASE_AUTHORITY_RULE, [
  'A process profile declares its permitted runtime phase.',
  'The run snapshot captures that declaration.',
  'The runtime envelope may advertise runProcess in a phase only when at least one snapshotted profile is permitted in that phase.',
  'Authorization rechecks the selected profile against the current phase.'
], 'profile-scoped phase authority rule is exact');

console.log(`\nPASS: process execution Tranche 1 contract — ${passed} assertions`);

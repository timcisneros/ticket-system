'use strict';

const {
  PROCESS_POLICY_SNAPSHOT_VERSION,
  PROCESS_RUNTIME_PHASES,
  canonicalizeProcessContractValue,
  hashProcessContractValue,
  normalizeProcessPolicySnapshot
} = require('./process-execution-contract');
const {
  PROCESS_SHA256_PATTERN,
  compareCanonicalStrings,
  validateProcessIdentifier
} = require('./process-authority-constants');

const PROCESS_LAUNCH_PLAN_VERSION = 1;
const PROCESS_OPERATION_IDENTITY_PATTERN = /^process-operation:[a-f0-9]{64}$/;
const PROCESS_LAUNCH_PLAN_KEYS = Object.freeze([
  'version',
  'operationIdentity',
  'runId',
  'ticketId',
  'targetId',
  'profileId',
  'policySnapshotHash',
  'runtimePhase',
  'runtimeRootfs',
  'executableIdentity',
  'arguments',
  'workingDirectory',
  'environment',
  'workspaceSnapshot',
  'filesystemPolicy',
  'limits',
  'executionPolicy',
  'launchPlanHash'
]);

class ProcessLaunchPlanError extends Error {
  constructor(message, code = 'PROCESS_LAUNCH_PLAN_INVALID', details = {}) {
    super(message);
    this.name = 'ProcessLaunchPlanError';
    this.code = code;
    this.failureKind = 'process_policy_denied';
    this.details = details;
  }
}

function fail(message, code = 'PROCESS_LAUNCH_PLAN_INVALID', details = {}) {
  throw new ProcessLaunchPlanError(message, code, details);
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const item of Object.values(value)) deepFreeze(item);
  return Object.freeze(value);
}

function plainObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype) {
    fail(`${label} must be a plain object`);
  }
}

function onlyKeys(value, allowed, label) {
  const unexpected = Object.keys(value).find(key => !allowed.includes(key));
  if (unexpected) fail(`${label} includes unsupported field: ${unexpected}`);
}

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    fail(`${label} must be a positive safe integer`);
  }
  return value;
}

function nonnegativeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    fail(`${label} must be a nonnegative safe integer`);
  }
  return value;
}

function sha256(value, label) {
  if (typeof value !== 'string' || !PROCESS_SHA256_PATTERN.test(value)) {
    fail(`${label} must be a lowercase SHA-256 hash`);
  }
  return value;
}

function identifier(value, label) {
  try {
    return validateProcessIdentifier(value, label);
  } catch (error) {
    fail(error.message);
  }
}

function normalizeWorkspaceSnapshot(value, filesystemPolicy) {
  plainObject(value, 'workspaceSnapshot');
  onlyKeys(
    value,
    ['id', 'manifestSha256', 'fileCount', 'totalBytes'],
    'workspaceSnapshot'
  );
  const normalized = {
    id: identifier(value.id, 'workspaceSnapshot.id'),
    manifestSha256: sha256(
      value.manifestSha256,
      'workspaceSnapshot.manifestSha256'
    ),
    fileCount: nonnegativeInteger(value.fileCount, 'workspaceSnapshot.fileCount'),
    totalBytes: nonnegativeInteger(value.totalBytes, 'workspaceSnapshot.totalBytes')
  };
  if (normalized.fileCount > filesystemPolicy.maxInputFiles) {
    fail(
      `workspaceSnapshot.fileCount exceeds profile policy maximum of ` +
      filesystemPolicy.maxInputFiles,
      'PROCESS_WORKSPACE_SNAPSHOT_INVALID'
    );
  }
  if (normalized.totalBytes > filesystemPolicy.maxInputBytes) {
    fail(
      `workspaceSnapshot.totalBytes exceeds profile policy maximum of ` +
      filesystemPolicy.maxInputBytes,
      'PROCESS_WORKSPACE_SNAPSHOT_INVALID'
    );
  }
  return normalized;
}

function normalizeBuildInput(value) {
  plainObject(value, 'process launch-plan input');
  onlyKeys(value, [
    'policySnapshot',
    'operationIdentity',
    'runId',
    'ticketId',
    'targetId',
    'profileId',
    'policySnapshotHash',
    'runtimePhase',
    'workspaceSnapshot'
  ], 'process launch-plan input');
  return value;
}

function resolveLaunchAuthority(input) {
  const snapshot = normalizeProcessPolicySnapshot(input.policySnapshot);
  if (!snapshot || snapshot.version !== PROCESS_POLICY_SNAPSHOT_VERSION) {
    fail(
      'Only a valid version-3 process policy snapshot can produce a launch plan',
      'PROCESS_POLICY_SNAPSHOT_NOT_EXECUTABLE'
    );
  }
  if (!snapshot.capabilityEnabled) {
    fail(
      'A disabled process policy snapshot cannot produce a launch plan',
      'PROCESS_CAPABILITY_DISABLED'
    );
  }
  if (input.policySnapshotHash !== snapshot.snapshotHash) {
    fail(
      'policySnapshotHash does not match the immutable run snapshot',
      'PROCESS_POLICY_SNAPSHOT_MISMATCH'
    );
  }
  const targetId = identifier(input.targetId, 'targetId');
  const profileId = identifier(input.profileId, 'profileId');
  const targetProfiles = snapshot.profiles.filter(profile => profile.targetId === targetId);
  if (targetProfiles.length === 0) {
    fail(`Process target is not present in the version-3 snapshot: ${targetId}`,
      'PROCESS_TARGET_UNKNOWN');
  }
  const profile = targetProfiles.find(candidate => candidate.profileId === profileId);
  if (!profile) {
    fail(`Process profile is not present for target ${targetId}: ${profileId}`,
      'PROCESS_PROFILE_UNKNOWN');
  }
  if (!PROCESS_RUNTIME_PHASES.includes(input.runtimePhase) ||
      !profile.allowedPhases.includes(input.runtimePhase)) {
    fail(
      `Process profile ${targetId}/${profileId} is not permitted in phase ` +
      String(input.runtimePhase),
      'PROCESS_PHASE_DENIED'
    );
  }
  return { snapshot, targetId, profileId, profile };
}

function buildProcessLaunchPlan(value) {
  const input = normalizeBuildInput(value);
  if (typeof input.operationIdentity !== 'string' ||
      !PROCESS_OPERATION_IDENTITY_PATTERN.test(input.operationIdentity)) {
    fail('operationIdentity must be a canonical run-scoped process-operation hash');
  }
  const runId = positiveInteger(input.runId, 'runId');
  const ticketId = positiveInteger(input.ticketId, 'ticketId');
  const { snapshot, targetId, profileId, profile } = resolveLaunchAuthority(input);
  const workspaceSnapshot = normalizeWorkspaceSnapshot(
    input.workspaceSnapshot,
    profile.filesystemPolicy
  );
  const withoutHash = {
    version: PROCESS_LAUNCH_PLAN_VERSION,
    operationIdentity: input.operationIdentity,
    runId,
    ticketId,
    targetId,
    profileId,
    policySnapshotHash: snapshot.snapshotHash,
    runtimePhase: input.runtimePhase,
    runtimeRootfs: { ...profile.runtimeRootfs },
    executableIdentity: { ...profile.executableIdentity },
    arguments: [...profile.arguments],
    workingDirectory: profile.workingDirectory,
    environment: Object.fromEntries(
      Object.entries(profile.environment)
        .sort(([left], [right]) => compareCanonicalStrings(left, right))
    ),
    workspaceSnapshot,
    filesystemPolicy: {
      ...profile.filesystemPolicy,
      writableRoots: []
    },
    limits: { ...profile.limits },
    executionPolicy: { ...profile.executionPolicy }
  };
  return deepFreeze({
    ...withoutHash,
    launchPlanHash: hashProcessContractValue(withoutHash)
  });
}

function validateProcessLaunchPlan(value, { policySnapshot } = {}) {
  plainObject(value, 'process launch plan');
  onlyKeys(value, PROCESS_LAUNCH_PLAN_KEYS, 'process launch plan');
  for (const key of PROCESS_LAUNCH_PLAN_KEYS) {
    if (!Object.hasOwn(value, key)) fail(`process launch plan.${key} is required`);
  }
  if (value.version !== PROCESS_LAUNCH_PLAN_VERSION) {
    fail(`process launch plan.version must be ${PROCESS_LAUNCH_PLAN_VERSION}`);
  }
  sha256(value.launchPlanHash, 'process launch plan.launchPlanHash');
  const expected = buildProcessLaunchPlan({
    policySnapshot,
    operationIdentity: value.operationIdentity,
    runId: value.runId,
    ticketId: value.ticketId,
    targetId: value.targetId,
    profileId: value.profileId,
    policySnapshotHash: value.policySnapshotHash,
    runtimePhase: value.runtimePhase,
    workspaceSnapshot: value.workspaceSnapshot
  });
  if (JSON.stringify(canonicalizeProcessContractValue(value)) !==
      JSON.stringify(canonicalizeProcessContractValue(expected))) {
    fail(
      'process launch plan does not exactly match its immutable version-3 authority',
      'PROCESS_LAUNCH_PLAN_AUTHORITY_MISMATCH'
    );
  }
  return expected;
}

module.exports = {
  PROCESS_LAUNCH_PLAN_KEYS,
  PROCESS_LAUNCH_PLAN_VERSION,
  PROCESS_OPERATION_IDENTITY_PATTERN,
  ProcessLaunchPlanError,
  buildProcessLaunchPlan,
  validateProcessLaunchPlan
};

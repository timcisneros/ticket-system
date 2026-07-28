'use strict';

const {
  PROCESS_POLICY_SNAPSHOT_VERSION,
  PROCESS_RUNTIME_PHASES,
  buildProcessOperationIdentity,
  canonicalizeProcessContractValue,
  hashProcessContractValue,
  normalizeProcessPolicySnapshot,
  projectProcessSandboxCapabilityGeneration
} = require('./process-execution-contract');
const {
  PROCESS_SHA256_PATTERN,
  compareCanonicalStrings,
  validateProcessIdentifier
} = require('./process-authority-constants');

const PROCESS_LAUNCH_PLAN_VERSION = 1;
const PROCESS_OPERATION_IDENTITY_PATTERN = /^process-operation:[a-f0-9]{64}$/;
const PROCESS_LAUNCH_AUTHORITY_CONTEXT_KEYS = Object.freeze([
  'runId',
  'ticketId',
  'currentPhase',
  'processPolicySnapshot'
]);
const PROCESS_WORKSPACE_SNAPSHOT_KEYS = Object.freeze([
  'id',
  'runId',
  'policySnapshotHash',
  'materializerGeneration',
  'manifestSha256',
  'fileCount',
  'totalBytes'
]);
const PROCESS_SANDBOX_GENERATION_KEYS = Object.freeze([
  'generationId',
  'launcherProtocolVersion',
  'launcherIdentityHash',
  'sandboxBackendIdentityHash',
  'seccompPolicyHash',
  'rootfsRegistryGeneration',
  'materializerGeneration'
]);
const PROCESS_LAUNCH_PLAN_KEYS = Object.freeze([
  'version',
  'operationId',
  'operationIdentity',
  'runId',
  'ticketId',
  'targetId',
  'profileId',
  'policySnapshotHash',
  'runtimePhase',
  'sandboxCapability',
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

function requireKeys(value, required, label) {
  for (const key of required) {
    if (!Object.hasOwn(value, key)) fail(`${label}.${key} is required`);
  }
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

function validateProcessLaunchAuthorityContext(value, { targetId, profileId } = {}) {
  plainObject(value, 'process launch-authority context');
  onlyKeys(value, PROCESS_LAUNCH_AUTHORITY_CONTEXT_KEYS, 'process launch-authority context');
  requireKeys(value, PROCESS_LAUNCH_AUTHORITY_CONTEXT_KEYS, 'process launch-authority context');
  const runId = positiveInteger(value.runId, 'process launch-authority context.runId');
  const ticketId = positiveInteger(value.ticketId, 'process launch-authority context.ticketId');
  if (!PROCESS_RUNTIME_PHASES.includes(value.currentPhase)) {
    fail(
      `process launch-authority context.currentPhase must be one of ` +
      PROCESS_RUNTIME_PHASES.join(', '),
      'PROCESS_PHASE_DENIED'
    );
  }
  const snapshot = normalizeProcessPolicySnapshot(value.processPolicySnapshot);
  if (!snapshot || snapshot.version !== PROCESS_POLICY_SNAPSHOT_VERSION) {
    fail(
      'Only a valid version-3 process policy snapshot can enter a launch-authority context',
      'PROCESS_POLICY_SNAPSHOT_NOT_EXECUTABLE'
    );
  }
  if (!snapshot.capabilityEnabled) {
    fail(
      'A disabled process policy snapshot cannot enter a launch-authority context',
      'PROCESS_CAPABILITY_DISABLED'
    );
  }
  const normalizedTargetId = identifier(targetId, 'targetId');
  const normalizedProfileId = identifier(profileId, 'profileId');
  const targetProfiles = snapshot.profiles.filter(
    profile => profile.targetId === normalizedTargetId
  );
  if (targetProfiles.length === 0) {
    fail(
      `Process target is not present in the version-3 snapshot: ${normalizedTargetId}`,
      'PROCESS_TARGET_UNKNOWN'
    );
  }
  const profile = targetProfiles.find(
    candidate => candidate.profileId === normalizedProfileId
  );
  if (!profile) {
    fail(
      `Process profile is not present for target ${normalizedTargetId}: ${normalizedProfileId}`,
      'PROCESS_PROFILE_UNKNOWN'
    );
  }
  if (!profile.allowedPhases.includes(value.currentPhase)) {
    fail(
      `Process profile ${normalizedTargetId}/${normalizedProfileId} is not permitted in phase ` +
      value.currentPhase,
      'PROCESS_PHASE_DENIED'
    );
  }
  return deepFreeze({
    runId,
    ticketId,
    currentPhase: value.currentPhase,
    processPolicySnapshot: snapshot
  });
}

function normalizeWorkspaceSnapshot(value, { context, profile }, sandboxCapability) {
  plainObject(value, 'workspaceSnapshot');
  onlyKeys(value, PROCESS_WORKSPACE_SNAPSHOT_KEYS, 'workspaceSnapshot');
  requireKeys(value, PROCESS_WORKSPACE_SNAPSHOT_KEYS, 'workspaceSnapshot');
  const normalized = {
    id: identifier(value.id, 'workspaceSnapshot.id'),
    runId: positiveInteger(value.runId, 'workspaceSnapshot.runId'),
    policySnapshotHash: sha256(
      value.policySnapshotHash,
      'workspaceSnapshot.policySnapshotHash'
    ),
    materializerGeneration: identifier(
      value.materializerGeneration,
      'workspaceSnapshot.materializerGeneration'
    ),
    manifestSha256: sha256(
      value.manifestSha256,
      'workspaceSnapshot.manifestSha256'
    ),
    fileCount: nonnegativeInteger(value.fileCount, 'workspaceSnapshot.fileCount'),
    totalBytes: nonnegativeInteger(value.totalBytes, 'workspaceSnapshot.totalBytes')
  };
  if (normalized.runId !== context.runId) {
    fail(
      'workspaceSnapshot.runId does not match the launch-authority context',
      'PROCESS_WORKSPACE_SNAPSHOT_MISMATCH'
    );
  }
  if (normalized.policySnapshotHash !== context.processPolicySnapshot.snapshotHash) {
    fail(
      'workspaceSnapshot.policySnapshotHash does not match the immutable run snapshot',
      'PROCESS_WORKSPACE_SNAPSHOT_MISMATCH'
    );
  }
  if (normalized.materializerGeneration !== sandboxCapability.materializerGeneration) {
    fail(
      'workspaceSnapshot.materializerGeneration does not match the sandbox capability generation',
      'PROCESS_WORKSPACE_SNAPSHOT_MISMATCH'
    );
  }
  if (normalized.fileCount > profile.filesystemPolicy.maxInputFiles) {
    fail(
      `workspaceSnapshot.fileCount exceeds profile policy maximum of ` +
      profile.filesystemPolicy.maxInputFiles,
      'PROCESS_WORKSPACE_SNAPSHOT_INVALID'
    );
  }
  if (normalized.totalBytes > profile.filesystemPolicy.maxInputBytes) {
    fail(
      `workspaceSnapshot.totalBytes exceeds profile policy maximum of ` +
      profile.filesystemPolicy.maxInputBytes,
      'PROCESS_WORKSPACE_SNAPSHOT_INVALID'
    );
  }
  return normalized;
}

function normalizeBuildInput(value) {
  plainObject(value, 'process launch-plan input');
  const keys = [
    'launchAuthorityContext',
    'operationId',
    'targetId',
    'profileId',
    'workspaceSnapshot',
    'sandboxCapability'
  ];
  onlyKeys(value, keys, 'process launch-plan input');
  requireKeys(value, keys, 'process launch-plan input');
  return value;
}

function normalizeSandboxCapability(value) {
  try {
    return projectProcessSandboxCapabilityGeneration(value);
  } catch (error) {
    fail(
      `A current healthy sandbox capability generation is required: ${error.message}`,
      'PROCESS_SANDBOX_UNAVAILABLE'
    );
  }
}

function buildProcessLaunchPlan(value) {
  const input = normalizeBuildInput(value);
  const context = validateProcessLaunchAuthorityContext(
    input.launchAuthorityContext,
    { targetId: input.targetId, profileId: input.profileId }
  );
  const targetId = identifier(input.targetId, 'targetId');
  const profileId = identifier(input.profileId, 'profileId');
  const profile = context.processPolicySnapshot.profiles.find(
    candidate => candidate.targetId === targetId && candidate.profileId === profileId
  );
  const authority = { context, targetId, profileId, profile };
  const operationId = identifier(input.operationId, 'operationId');
  const operationIdentity = buildProcessOperationIdentity(
    context.runId,
    operationId
  );
  const sandboxCapability = normalizeSandboxCapability(input.sandboxCapability);
  const workspaceSnapshot = normalizeWorkspaceSnapshot(
    input.workspaceSnapshot,
    authority,
    sandboxCapability
  );
  const snapshot = context.processPolicySnapshot;
  const withoutHash = {
    version: PROCESS_LAUNCH_PLAN_VERSION,
    operationId,
    operationIdentity,
    runId: context.runId,
    ticketId: context.ticketId,
    targetId,
    profileId,
    policySnapshotHash: snapshot.snapshotHash,
    runtimePhase: context.currentPhase,
    sandboxCapability,
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

function validateProcessLaunchPlan(value, {
  launchAuthorityContext,
  sandboxCapability
} = {}) {
  plainObject(value, 'process launch plan');
  onlyKeys(value, PROCESS_LAUNCH_PLAN_KEYS, 'process launch plan');
  requireKeys(value, PROCESS_LAUNCH_PLAN_KEYS, 'process launch plan');
  if (value.version !== PROCESS_LAUNCH_PLAN_VERSION) {
    fail(`process launch plan.version must be ${PROCESS_LAUNCH_PLAN_VERSION}`);
  }
  identifier(value.operationId, 'process launch plan.operationId');
  if (typeof value.operationIdentity !== 'string' ||
      !PROCESS_OPERATION_IDENTITY_PATTERN.test(value.operationIdentity)) {
    fail('process launch plan.operationIdentity must be a canonical process-operation hash');
  }
  sha256(value.launchPlanHash, 'process launch plan.launchPlanHash');
  plainObject(value.sandboxCapability, 'process launch plan.sandboxCapability');
  onlyKeys(
    value.sandboxCapability,
    PROCESS_SANDBOX_GENERATION_KEYS,
    'process launch plan.sandboxCapability'
  );
  requireKeys(
    value.sandboxCapability,
    PROCESS_SANDBOX_GENERATION_KEYS,
    'process launch plan.sandboxCapability'
  );
  const expected = buildProcessLaunchPlan({
    launchAuthorityContext,
    operationId: value.operationId,
    targetId: value.targetId,
    profileId: value.profileId,
    workspaceSnapshot: value.workspaceSnapshot,
    sandboxCapability
  });
  if (JSON.stringify(canonicalizeProcessContractValue(value)) !==
      JSON.stringify(canonicalizeProcessContractValue(expected))) {
    fail(
      'process launch plan does not exactly match its immutable run and sandbox authority',
      'PROCESS_LAUNCH_PLAN_AUTHORITY_MISMATCH'
    );
  }
  return expected;
}

module.exports = {
  PROCESS_LAUNCH_AUTHORITY_CONTEXT_KEYS,
  PROCESS_LAUNCH_PLAN_KEYS,
  PROCESS_LAUNCH_PLAN_VERSION,
  PROCESS_OPERATION_IDENTITY_PATTERN,
  PROCESS_SANDBOX_GENERATION_KEYS,
  PROCESS_WORKSPACE_SNAPSHOT_KEYS,
  ProcessLaunchPlanError,
  buildProcessLaunchPlan,
  validateProcessLaunchAuthorityContext,
  validateProcessLaunchPlan
};

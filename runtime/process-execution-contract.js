'use strict';

const crypto = require('crypto');
const {
  PROCESS_AUTHORITY_CARDINALITY_LIMITS,
  PROCESS_EXECUTABLE_FORMAT,
  PROCESS_EXECUTION_POLICY,
  PROCESS_FILESYSTEM_POLICY,
  PROCESS_FILESYSTEM_POLICY_HARD_LIMITS,
  PROCESS_IDENTIFIER_MAX_LENGTH,
  PROCESS_NETWORK_ACCESS_NONE_MEANING,
  PROCESS_PROFILE_HARD_LIMITS,
  PROCESS_RESOLUTION_RUNTIME_PHASES,
  PROCESS_RESOURCE_LIMIT_CAUSES,
  PROCESS_RUNTIME_PHASES,
  PROCESS_SANDBOX_CAPABILITY_MAX_VALIDITY_MS,
  PROCESS_SANDBOX_CAPABILITY_STATUS,
  PROCESS_SANDBOX_CAPABILITY_VERSION,
  PROCESS_SANDBOX_LAUNCHER_PROTOCOL_MAX_VERSION,
  PROCESS_SHA256_PATTERN,
  compareCanonicalStrings,
  validateProcessIdentifier
} = require('./process-authority-constants');
const {
  PROCESS_TARGET_CATALOG_HISTORICAL_VERSION,
  PROCESS_TARGET_CATALOG_VERSION,
  validateProcessTargetCatalog
} = require('./process-target-catalog');

const PROCESS_CONTRACT_VERSION = 1;
const PROCESS_POLICY_SNAPSHOT_VERSION = 3;
const PROCESS_POLICY_SNAPSHOT_HISTORICAL_VERSION = 1;
const PROCESS_POLICY_SNAPSHOT_HISTORICAL_VERSION_2 = 2;
const PROCESS_OPERATION = 'runProcess';
const PROCESS_FEATURE_ENV = 'ENABLE_PROCESS_EXECUTION_CONTRACT';
const CURRENT_PROCESS_SANDBOX_CAPABILITY = null;
const PROCESS_INLINE_OUTPUT_MAX_BYTES = 64 * 1024;
const PROCESS_ARTIFACT_REFERENCE_MAX_LENGTH = 2048;

const PROCESS_AUTHORITY_RULE = Object.freeze([
  'The model requests an existing process profile.',
  'The runtime resolves and enforces authority.',
  'The target configuration grants authority.',
  'Process output is evidence, not authority.'
]);

const PROCESS_PHASE_AUTHORITY_RULE = Object.freeze([
  'A process profile declares its permitted runtime phase.',
  'The run snapshot captures that declaration.',
  'The runtime envelope may advertise runProcess in a phase only when at least one snapshotted profile is permitted in that phase.',
  'Authorization rechecks the selected profile against the current phase.'
]);

const PROCESS_TERMINAL_OUTCOMES = Object.freeze([
  'completed',
  'failed_to_start',
  'exited_nonzero',
  'signaled',
  'timed_out',
  'cancelled',
  'output_limit_exceeded',
  'resource_limit_exceeded',
  'policy_denied',
  'runtime_interrupted'
]);

const PROCESS_PRE_EXECUTION_EVIDENCE_FIELDS = Object.freeze([
  'operationId',
  'runId',
  'ticketId',
  'targetId',
  'profileId',
  'resolvedExecutable',
  'argumentVector',
  'workingDirectory',
  'declaredEnvironmentVariableNames',
  'policySnapshotHash',
  'startedAt'
]);

const PROCESS_TERMINAL_EVIDENCE_FIELDS = Object.freeze([
  'finishedAt',
  'durationMs',
  'pid',
  'processGroupId',
  'exitCode',
  'terminatingSignal',
  'terminalOutcome',
  'enforcementCause',
  'stdoutByteCount',
  'stderrByteCount',
  'stdoutTruncated',
  'stderrTruncated',
  'stdoutArtifactRef',
  'stdoutInline',
  'stderrArtifactRef',
  'stderrInline'
]);

const PROCESS_EVIDENCE_CONTRACT = deepFreeze({
  version: PROCESS_CONTRACT_VERSION,
  preExecution: {
    operationId: 'Stable model-supplied operation identity for this requested process operation.',
    runId: 'Runtime run identity that owns the operation.',
    ticketId: 'Ticket identity that authorized the run.',
    targetId: 'Selected configured process target identity.',
    profileId: 'Selected profile identity within the configured target.',
    resolvedExecutable: 'Trusted executable resolved by the runtime from the target/profile snapshot; never model supplied.',
    argumentVector: 'Trusted ordered arguments resolved by the runtime; never model supplied.',
    workingDirectory: 'Trusted working directory resolved by the runtime; never model supplied.',
    declaredEnvironmentVariableNames: 'Names of environment variables declared by trusted configuration. Values and secrets are never evidence.',
    policySnapshotHash: 'Hash of the immutable run process-policy snapshot used for authority.',
    startedAt: 'UTC timestamp immediately before a future executor attempts process start.'
  },
  terminal: {
    finishedAt: 'UTC timestamp when the future executor reaches a terminal outcome.',
    durationMs: 'Measured wall-clock duration in milliseconds.',
    pid: 'Operating-system process identity, when one was assigned.',
    processGroupId: 'Process-group or equivalent runtime ownership identity.',
    exitCode: 'Numeric exit status when the process exited normally.',
    terminatingSignal: 'Signal or equivalent termination indicator, when applicable.',
    terminalOutcome: 'One value from PROCESS_TERMINAL_OUTCOMES; distinct meanings must not be collapsed.',
    enforcementCause: 'Structured timeout, cancellation, interruption, or enforcement cause.',
    stdoutByteCount: 'Total stdout bytes observed before terminalization.',
    stderrByteCount: 'Total stderr bytes observed before terminalization.',
    stdoutTruncated: 'Whether stdout evidence was truncated by a configured bound.',
    stderrTruncated: 'Whether stderr evidence was truncated by a configured bound.',
    stdoutArtifactRef: 'Reference to a bounded stdout artifact when stdout is not stored inline.',
    stdoutInline: 'Bounded inline stdout value when no artifact reference is used.',
    stderrArtifactRef: 'Reference to a bounded stderr artifact when stderr is not stored inline.',
    stderrInline: 'Bounded inline stderr value when no artifact reference is used.'
  }
});

class ProcessContractError extends Error {
  constructor(message, {
    code,
    failureKind = 'invalid_action',
    disposition = null,
    terminalOutcome = null,
    details = {}
  } = {}) {
    super(message);
    this.name = 'ProcessContractError';
    this.code = code || 'PROCESS_CONTRACT_ERROR';
    this.failureKind = failureKind;
    this.disposition = disposition;
    this.processOutcome = terminalOutcome;
    this.details = details;
  }
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const item of Object.values(value)) deepFreeze(item);
  return Object.freeze(value);
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value).sort(compareCanonicalStrings).map(key => [key, canonicalize(value[key])])
    );
  }
  return value;
}

function sha256Json(value) {
  return crypto.createHash('sha256').update(JSON.stringify(canonicalize(value))).digest('hex');
}

const canonicalizeProcessContractValue = canonicalize;
const hashProcessContractValue = sha256Json;

function processIdentifier(value, label, { request = false } = {}) {
  try {
    return validateProcessIdentifier(value, label);
  } catch (error) {
    if (!request) throw error;
    throw new ProcessContractError(error.message, {
      code: 'PROCESS_REQUEST_MALFORMED',
      details: { field: label }
    });
  }
}

function processContractTimestamp(value, label) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value)) ||
      new Date(value).toISOString() !== value) {
    throw new TypeError(`${label} must be a canonical UTC ISO timestamp`);
  }
  return value;
}

function normalizeProcessSandboxCapabilityDescriptor(value, {
  observedAt = new Date().toISOString()
} = {}) {
  validatePlainObject(value, 'process sandbox capability');
  const allowedKeys = [
    'version',
    'status',
    'generationId',
    'launcherProtocolVersion',
    'launcherIdentityHash',
    'sandboxBackendIdentityHash',
    'seccompPolicyHash',
    'rootfsRegistryGeneration',
    'materializerGeneration',
    'verifiedAt',
    'validUntil'
  ];
  const unexpected = Object.keys(value).find(key => !allowedKeys.includes(key));
  if (unexpected) {
    throw new TypeError(`process sandbox capability includes unsupported field: ${unexpected}`);
  }
  for (const key of allowedKeys) {
    if (!Object.hasOwn(value, key)) {
      throw new TypeError(`process sandbox capability.${key} is required`);
    }
  }
  if (value.version !== PROCESS_SANDBOX_CAPABILITY_VERSION) {
    throw new TypeError(
      `process sandbox capability.version must be ${PROCESS_SANDBOX_CAPABILITY_VERSION}`
    );
  }
  if (value.status !== PROCESS_SANDBOX_CAPABILITY_STATUS) {
    throw new TypeError(
      `process sandbox capability.status must be ${PROCESS_SANDBOX_CAPABILITY_STATUS}`
    );
  }
  const generationId = processIdentifier(
    value.generationId,
    'process sandbox capability.generationId'
  );
  const rootfsRegistryGeneration = processIdentifier(
    value.rootfsRegistryGeneration,
    'process sandbox capability.rootfsRegistryGeneration'
  );
  const materializerGeneration = processIdentifier(
    value.materializerGeneration,
    'process sandbox capability.materializerGeneration'
  );
  if (!Number.isSafeInteger(value.launcherProtocolVersion) ||
      value.launcherProtocolVersion <= 0 ||
      value.launcherProtocolVersion > PROCESS_SANDBOX_LAUNCHER_PROTOCOL_MAX_VERSION) {
    throw new TypeError(
      `process sandbox capability.launcherProtocolVersion must be a positive safe integer ` +
      `no greater than ${PROCESS_SANDBOX_LAUNCHER_PROTOCOL_MAX_VERSION}`
    );
  }
  for (const key of [
    'launcherIdentityHash',
    'sandboxBackendIdentityHash',
    'seccompPolicyHash'
  ]) {
    if (typeof value[key] !== 'string' || !PROCESS_SHA256_PATTERN.test(value[key])) {
      throw new TypeError(`process sandbox capability.${key} must be a lowercase SHA-256 hash`);
    }
  }
  const verifiedAt = processContractTimestamp(
    value.verifiedAt,
    'process sandbox capability.verifiedAt'
  );
  const validUntil = processContractTimestamp(
    value.validUntil,
    'process sandbox capability.validUntil'
  );
  const observed = processContractTimestamp(observedAt, 'sandbox capability observedAt');
  const verifiedTime = Date.parse(verifiedAt);
  const validUntilTime = Date.parse(validUntil);
  const observedTime = Date.parse(observed);
  if (validUntilTime <= verifiedTime ||
      validUntilTime - verifiedTime > PROCESS_SANDBOX_CAPABILITY_MAX_VALIDITY_MS) {
    throw new TypeError(
      `process sandbox capability validity must be positive and no longer than ` +
      `${PROCESS_SANDBOX_CAPABILITY_MAX_VALIDITY_MS}ms`
    );
  }
  if (observedTime < verifiedTime || observedTime >= validUntilTime) {
    throw new TypeError('process sandbox capability is not currently valid');
  }
  return deepFreeze({
    version: PROCESS_SANDBOX_CAPABILITY_VERSION,
    status: PROCESS_SANDBOX_CAPABILITY_STATUS,
    generationId,
    launcherProtocolVersion: value.launcherProtocolVersion,
    launcherIdentityHash: value.launcherIdentityHash,
    sandboxBackendIdentityHash: value.sandboxBackendIdentityHash,
    seccompPolicyHash: value.seccompPolicyHash,
    rootfsRegistryGeneration,
    materializerGeneration,
    verifiedAt,
    validUntil
  });
}

function projectProcessSandboxCapabilityGeneration(value, options = {}) {
  const capability = normalizeProcessSandboxCapabilityDescriptor(value, options);
  return deepFreeze({
    generationId: capability.generationId,
    launcherProtocolVersion: capability.launcherProtocolVersion,
    launcherIdentityHash: capability.launcherIdentityHash,
    sandboxBackendIdentityHash: capability.sandboxBackendIdentityHash,
    seccompPolicyHash: capability.seccompPolicyHash,
    rootfsRegistryGeneration: capability.rootfsRegistryGeneration,
    materializerGeneration: capability.materializerGeneration
  });
}

function assertOnlyKeys(value, allowedKeys, label) {
  const unexpectedKey = Object.keys(value).find(key => !allowedKeys.includes(key));
  if (unexpectedKey) {
    throw new ProcessContractError(`${label} includes unsupported field: ${unexpectedKey}`, {
      code: 'PROCESS_REQUEST_MALFORMED',
      details: { field: unexpectedKey }
    });
  }
}

function parseProcessOperationRequest(action) {
  if (!action || typeof action !== 'object' || Array.isArray(action)) {
    throw new ProcessContractError('Process action must be an object', {
      code: 'PROCESS_REQUEST_MALFORMED'
    });
  }
  assertOnlyKeys(action, ['operation', 'args'], 'Process action');
  if (action.operation !== PROCESS_OPERATION) {
    throw new ProcessContractError(`Unsupported process operation: ${String(action.operation || '')}`, {
      code: 'PROCESS_OPERATION_UNSUPPORTED'
    });
  }
  if (!action.args || typeof action.args !== 'object' || Array.isArray(action.args)) {
    throw new ProcessContractError('runProcess args must be an object', {
      code: 'PROCESS_REQUEST_MALFORMED'
    });
  }
  assertOnlyKeys(action.args, ['targetId', 'profileId', 'operationId'], 'runProcess args');
  return deepFreeze({
    operation: PROCESS_OPERATION,
    args: {
      targetId: processIdentifier(action.args.targetId, 'runProcess.targetId', { request: true }),
      profileId: processIdentifier(action.args.profileId, 'runProcess.profileId', { request: true }),
      operationId: processIdentifier(action.args.operationId, 'runProcess.operationId', { request: true })
    }
  });
}

function buildProcessOperationIdentity(runId, operationId) {
  if (!Number.isSafeInteger(runId) || runId <= 0) {
    throw new TypeError('runId must be a positive safe integer');
  }
  const normalizedOperationId = processIdentifier(operationId, 'operationId');
  return `process-operation:${sha256Json({ runId, operationId: normalizedOperationId })}`;
}

function classifyProcessOperationIdReuse({ runId, requested, existing = null } = {}) {
  const requestedAction = parseProcessOperationRequest({
    operation: PROCESS_OPERATION,
    args: requested
  });
  const identity = buildProcessOperationIdentity(runId, requestedAction.args.operationId);
  if (existing === null || existing === undefined) {
    return deepFreeze({ status: 'new', identity, request: requestedAction.args });
  }
  const existingAction = parseProcessOperationRequest({
    operation: PROCESS_OPERATION,
    args: existing
  });
  if (existingAction.args.operationId !== requestedAction.args.operationId) {
    return deepFreeze({ status: 'new', identity, request: requestedAction.args });
  }
  if (existingAction.args.targetId !== requestedAction.args.targetId ||
      existingAction.args.profileId !== requestedAction.args.profileId) {
    throw new ProcessContractError(
      `runProcess.operationId conflicts with an existing request in run ${runId}: ${requestedAction.args.operationId}`,
      {
        code: 'PROCESS_OPERATION_ID_CONFLICT',
        failureKind: 'idempotency_conflict',
        details: {
          runId,
          operationId: requestedAction.args.operationId,
          existingTargetId: existingAction.args.targetId,
          existingProfileId: existingAction.args.profileId,
          requestedTargetId: requestedAction.args.targetId,
          requestedProfileId: requestedAction.args.profileId
        }
      }
    );
  }
  return deepFreeze({ status: 'idempotent_replay', identity, request: requestedAction.args });
}

function isProcessContractFeatureEnabled(env = process.env) {
  return Boolean(env && env[PROCESS_FEATURE_ENV] === 'true');
}

function normalizeGrant(grant, label) {
  if (!grant || typeof grant !== 'object' || Array.isArray(grant)) {
    throw new TypeError(`${label} must be an object`);
  }
  const targetId = processIdentifier(grant.targetId, `${label}.targetId`);
  if (!Array.isArray(grant.profileIds)) throw new TypeError(`${label}.profileIds must be an array`);
  const profileIds = [...new Set(grant.profileIds.map((profileId, index) => {
    return processIdentifier(profileId, `${label}.profileIds[${index}]`);
  }))].sort(compareCanonicalStrings);
  if (profileIds.length === 0) throw new TypeError(`${label}.profileIds must not be empty`);
  return { targetId, profileIds };
}

function normalizeCapturedAt(value, label = 'processPolicySnapshot.capturedAt') {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value)) ||
      new Date(value).toISOString() !== value) {
    throw new TypeError(`${label} must be a canonical UTC ISO timestamp`);
  }
  return value;
}

function buildHistoricalProcessPolicySnapshotV1({
  capabilityEnabled,
  grants = [],
  capturedAt = new Date().toISOString()
} = {}) {
  if (typeof capabilityEnabled !== 'boolean') {
    throw new TypeError('processPolicySnapshot.capabilityEnabled must be a boolean');
  }
  if (!Array.isArray(grants)) throw new TypeError('processPolicySnapshot.grants must be an array');
  normalizeCapturedAt(capturedAt);
  const normalizedGrants = grants.map((grant, index) => normalizeGrant(grant, `processPolicySnapshot.grants[${index}]`));
  normalizedGrants.sort((left, right) =>
    compareCanonicalStrings(left.targetId, right.targetId));
  if (new Set(normalizedGrants.map(grant => grant.targetId)).size !== normalizedGrants.length) {
    throw new TypeError('processPolicySnapshot.grants targetId values must be unique');
  }
  const withoutHash = {
    version: PROCESS_POLICY_SNAPSHOT_HISTORICAL_VERSION,
    capabilityEnabled,
    grants: normalizedGrants,
    capturedAt
  };
  return deepFreeze({
    ...withoutHash,
    snapshotHash: sha256Json(withoutHash)
  });
}

function normalizeExecutionPolicy(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  const expected = PROCESS_EXECUTION_POLICY;
  const unexpected = Object.keys(value).find(key => !Object.hasOwn(expected, key));
  if (unexpected || Object.keys(expected).some(key => value[key] !== expected[key])) {
    throw new TypeError(`${label} must contain the fixed process execution policy`);
  }
  return { ...expected };
}

function normalizeResolvedProfileV2(profile, label) {
  if (!profile || typeof profile !== 'object' || Array.isArray(profile)) {
    throw new TypeError(`${label} must be an object`);
  }
  const expectedKeys = [
    'targetId', 'profileId', 'allowedPhases', 'executable', 'arguments',
    'workingDirectory', 'environment', 'limits', 'executionPolicy'
  ];
  const unexpected = Object.keys(profile).find(key => !expectedKeys.includes(key));
  if (unexpected) throw new TypeError(`${label} includes unsupported field: ${unexpected}`);
  const targetId = processIdentifier(profile.targetId, `${label}.targetId`);
  const profileId = processIdentifier(profile.profileId, `${label}.profileId`);
  // Reuse the catalog validator when reading persisted snapshots so a valid
  // hash cannot turn malformed authority material into dispatch authority.
  const validated = validateProcessTargetCatalog({
    version: PROCESS_TARGET_CATALOG_HISTORICAL_VERSION,
    targets: [{
      id: targetId,
      profiles: [{
        id: profileId,
        allowedPhases: profile.allowedPhases,
        executable: profile.executable,
        arguments: profile.arguments,
        workingDirectory: profile.workingDirectory,
        environment: profile.environment,
        limits: profile.limits
      }]
    }]
  }).targets[0].profiles[0];
  return {
    targetId,
    profileId,
    allowedPhases: [...validated.allowedPhases],
    executable: validated.executable,
    arguments: [...validated.arguments],
    workingDirectory: validated.workingDirectory,
    environment: { ...validated.environment },
    limits: { ...validated.limits },
    executionPolicy: normalizeExecutionPolicy(profile.executionPolicy, `${label}.executionPolicy`)
  };
}

function normalizeResolvedProfileV3(profile, label) {
  if (!profile || typeof profile !== 'object' || Array.isArray(profile)) {
    throw new TypeError(`${label} must be an object`);
  }
  const expectedKeys = [
    'targetId',
    'profileId',
    'allowedPhases',
    'runtimeRootfs',
    'executableIdentity',
    'arguments',
    'workingDirectory',
    'environment',
    'filesystemPolicy',
    'limits',
    'executionPolicy'
  ];
  const unexpected = Object.keys(profile).find(key => !expectedKeys.includes(key));
  if (unexpected) throw new TypeError(`${label} includes unsupported field: ${unexpected}`);
  const targetId = processIdentifier(profile.targetId, `${label}.targetId`);
  const profileId = processIdentifier(profile.profileId, `${label}.profileId`);
  if (!profile.runtimeRootfs || typeof profile.runtimeRootfs !== 'object' ||
      Array.isArray(profile.runtimeRootfs)) {
    throw new TypeError(`${label}.runtimeRootfs must be an object`);
  }
  const unexpectedRootfsKey = Object.keys(profile.runtimeRootfs)
    .find(key => !['id', 'manifestSha256'].includes(key));
  if (unexpectedRootfsKey) {
    throw new TypeError(
      `${label}.runtimeRootfs includes unsupported field: ${unexpectedRootfsKey}`
    );
  }
  const rootfsId = processIdentifier(profile.runtimeRootfs.id, `${label}.runtimeRootfs.id`);
  const validatedCatalog = validateProcessTargetCatalog({
    version: PROCESS_TARGET_CATALOG_VERSION,
    runtimeRootfs: [{
      id: rootfsId,
      manifestSha256: profile.runtimeRootfs.manifestSha256
    }],
    targets: [{
      id: targetId,
      profiles: [{
        id: profileId,
        allowedPhases: profile.allowedPhases,
        runtimeRootfsId: rootfsId,
        executableIdentity: profile.executableIdentity,
        arguments: profile.arguments,
        workingDirectory: profile.workingDirectory,
        environment: profile.environment,
        filesystemPolicy: profile.filesystemPolicy,
        limits: profile.limits
      }]
    }]
  });
  const validatedRootfs = validatedCatalog.runtimeRootfs[0];
  const validated = validatedCatalog.targets[0].profiles[0];
  return {
    targetId,
    profileId,
    allowedPhases: [...validated.allowedPhases],
    runtimeRootfs: { ...validatedRootfs },
    executableIdentity: { ...validated.executableIdentity },
    arguments: [...validated.arguments],
    workingDirectory: validated.workingDirectory,
    environment: { ...validated.environment },
    filesystemPolicy: {
      ...validated.filesystemPolicy,
      writableRoots: []
    },
    limits: { ...validated.limits },
    executionPolicy: normalizeExecutionPolicy(profile.executionPolicy, `${label}.executionPolicy`)
  };
}

function buildProcessPolicySnapshot({
  version = null,
  capabilityEnabled,
  profiles = [],
  capturedAt = new Date().toISOString()
} = {}) {
  if (typeof capabilityEnabled !== 'boolean') {
    throw new TypeError('processPolicySnapshot.capabilityEnabled must be a boolean');
  }
  if (!Array.isArray(profiles)) throw new TypeError('processPolicySnapshot.profiles must be an array');
  if (profiles.length > PROCESS_AUTHORITY_CARDINALITY_LIMITS.maxResolvedProfilesPerSnapshot) {
    throw new RangeError(
      `processPolicySnapshot.profiles exceeds the ` +
      `${PROCESS_AUTHORITY_CARDINALITY_LIMITS.maxResolvedProfilesPerSnapshot}-profile limit`
    );
  }
  normalizeCapturedAt(capturedAt);
  const snapshotVersion = version === null
    ? (profiles.some(profile => profile && profile.runtimeRootfs)
        ? PROCESS_POLICY_SNAPSHOT_VERSION
        : PROCESS_POLICY_SNAPSHOT_HISTORICAL_VERSION_2)
    : version;
  if (![PROCESS_POLICY_SNAPSHOT_HISTORICAL_VERSION_2, PROCESS_POLICY_SNAPSHOT_VERSION]
    .includes(snapshotVersion)) {
    throw new TypeError(
      `processPolicySnapshot.version must be ` +
      `${PROCESS_POLICY_SNAPSHOT_HISTORICAL_VERSION_2} or ${PROCESS_POLICY_SNAPSHOT_VERSION}`
    );
  }
  const normalizedProfiles = profiles.map((profile, index) =>
    snapshotVersion === PROCESS_POLICY_SNAPSHOT_VERSION
      ? normalizeResolvedProfileV3(profile, `processPolicySnapshot.profiles[${index}]`)
      : normalizeResolvedProfileV2(profile, `processPolicySnapshot.profiles[${index}]`));
  normalizedProfiles.sort((left, right) =>
    compareCanonicalStrings(left.targetId, right.targetId) ||
    compareCanonicalStrings(left.profileId, right.profileId));
  const identities = normalizedProfiles.map(profile => `${profile.targetId}\0${profile.profileId}`);
  if (new Set(identities).size !== identities.length) {
    throw new TypeError('processPolicySnapshot.profiles target/profile values must be unique');
  }
  const withoutHash = {
    version: snapshotVersion,
    capabilityEnabled,
    profiles: normalizedProfiles,
    capturedAt
  };
  return deepFreeze({ ...withoutHash, snapshotHash: sha256Json(withoutHash) });
}

function normalizeProcessPolicySnapshot(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  try {
    const expectedTopLevelKeys = value.version === PROCESS_POLICY_SNAPSHOT_HISTORICAL_VERSION
      ? ['version', 'capabilityEnabled', 'grants', 'capturedAt', 'snapshotHash']
      : [
          PROCESS_POLICY_SNAPSHOT_HISTORICAL_VERSION_2,
          PROCESS_POLICY_SNAPSHOT_VERSION
        ].includes(value.version)
        ? ['version', 'capabilityEnabled', 'profiles', 'capturedAt', 'snapshotHash']
        : [];
    if (expectedTopLevelKeys.length === 0 ||
        Object.keys(value).some(key => !expectedTopLevelKeys.includes(key)) ||
        expectedTopLevelKeys.some(key => !Object.hasOwn(value, key))) {
      return null;
    }
    const normalized = value.version === PROCESS_POLICY_SNAPSHOT_HISTORICAL_VERSION
      ? buildHistoricalProcessPolicySnapshotV1({
          capabilityEnabled: value.capabilityEnabled,
          grants: value.grants,
          capturedAt: value.capturedAt
        })
      : value.version === PROCESS_POLICY_SNAPSHOT_HISTORICAL_VERSION_2 ||
          value.version === PROCESS_POLICY_SNAPSHOT_VERSION
        ? buildProcessPolicySnapshot({
            version: value.version,
            capabilityEnabled: value.capabilityEnabled,
            profiles: value.profiles,
            capturedAt: value.capturedAt
          })
        : null;
    if (!normalized || typeof value.snapshotHash !== 'string' ||
        value.snapshotHash !== normalized.snapshotHash) return null;
    return normalized;
  } catch (_) {
    return null;
  }
}

function processAuthorityReferences(value, phase = null) {
  const snapshot = normalizeProcessPolicySnapshot(value);
  // Tranche 2A0 deliberately does not advertise version-3 authority. A future
  // healthy sandbox capability generation is an additional mandatory gate.
  // Preserve the existing version-2 historical envelope behavior without
  // interpreting it as executable authority.
  if (!snapshot || snapshot.version !== PROCESS_POLICY_SNAPSHOT_HISTORICAL_VERSION_2 ||
      !snapshot.capabilityEnabled) return [];
  if (phase !== null && !PROCESS_RUNTIME_PHASES.includes(phase)) return [];
  const grouped = new Map();
  for (const profile of snapshot.profiles) {
    if (phase !== null && !profile.allowedPhases.includes(phase)) continue;
    if (!grouped.has(profile.targetId)) grouped.set(profile.targetId, []);
    grouped.get(profile.targetId).push(profile.profileId);
  }
  return [...grouped.entries()].map(([targetId, profileIds]) => ({ targetId, profileIds }));
}

function historicalProcessGrantReferences(value) {
  const snapshot = normalizeProcessPolicySnapshot(value);
  if (!snapshot || snapshot.version !== PROCESS_POLICY_SNAPSHOT_HISTORICAL_VERSION) return [];
  return snapshot.grants.map(grant => ({ targetId: grant.targetId, profileIds: [...grant.profileIds] }));
}

function processResolution({
  disposition,
  code,
  message,
  request,
  snapshot = null,
  policySnapshotHash = snapshot ? snapshot.snapshotHash : null,
  runtimePhase = null,
  authorityStatus,
  terminalOutcome = null
}) {
  return deepFreeze({
    disposition,
    code,
    message,
    authorityStatus,
    terminalOutcome,
    request,
    policySnapshotHash,
    runtimePhase
  });
}

function resolveProcessOperationRequest(
  action,
  policySnapshot,
  currentPhase = null,
  sandboxCapability = CURRENT_PROCESS_SANDBOX_CAPABILITY
) {
  const request = parseProcessOperationRequest(action);
  const snapshot = normalizeProcessPolicySnapshot(policySnapshot);
  if (!snapshot || !snapshot.capabilityEnabled) {
    return processResolution({
      disposition: 'disabled',
      code: 'PROCESS_CAPABILITY_DISABLED',
      message: 'runProcess is disabled by the run process-policy snapshot',
      request,
      snapshot,
      runtimePhase: currentPhase,
      authorityStatus: 'denied',
      terminalOutcome: 'policy_denied'
    });
  }
  if (snapshot.version === PROCESS_POLICY_SNAPSHOT_VERSION) {
    try {
      normalizeProcessSandboxCapabilityDescriptor(sandboxCapability);
    } catch (_) {
      return processResolution({
        disposition: 'policy_denied',
        code: 'PROCESS_SANDBOX_UNAVAILABLE',
        message:
          'runProcess version-3 authority is denied because no current healthy sandbox capability generation is available',
        request,
        snapshot,
        runtimePhase: currentPhase,
        authorityStatus: 'denied',
        terminalOutcome: 'policy_denied'
      });
    }
  }
  const profiles = [
    PROCESS_POLICY_SNAPSHOT_HISTORICAL_VERSION_2,
    PROCESS_POLICY_SNAPSHOT_VERSION
  ].includes(snapshot.version) ? snapshot.profiles : [];
  const targetProfiles = profiles.filter(profile => profile.targetId === request.args.targetId);
  if (targetProfiles.length === 0) {
    return processResolution({
      disposition: 'policy_denied',
      code: 'PROCESS_TARGET_UNKNOWN',
      message: `Process target is not granted by the run snapshot: ${request.args.targetId}`,
      request,
      snapshot,
      runtimePhase: currentPhase,
      authorityStatus: 'denied',
      terminalOutcome: 'policy_denied'
    });
  }
  const profile = targetProfiles.find(candidate => candidate.profileId === request.args.profileId);
  if (!profile) {
    return processResolution({
      disposition: 'policy_denied',
      code: 'PROCESS_PROFILE_UNKNOWN',
      message: `Process profile is not granted for target ${request.args.targetId}: ${request.args.profileId}`,
      request,
      snapshot,
      runtimePhase: currentPhase,
      authorityStatus: 'denied',
      terminalOutcome: 'policy_denied'
    });
  }
  if (!PROCESS_RUNTIME_PHASES.includes(currentPhase) || !profile.allowedPhases.includes(currentPhase)) {
    return processResolution({
      disposition: 'policy_denied',
      code: 'PROCESS_PHASE_DENIED',
      message: `Process profile ${request.args.targetId}/${request.args.profileId} is not permitted in runtime phase ${String(currentPhase)}`,
      request,
      snapshot,
      runtimePhase: currentPhase,
      authorityStatus: 'denied',
      terminalOutcome: 'policy_denied'
    });
  }
  return processResolution({
    disposition: 'unsupported',
    code: 'PROCESS_EXECUTOR_UNAVAILABLE',
    message: 'runProcess is authorized by the immutable run snapshot but has no executor or healthy sandbox capability',
    request,
    snapshot,
    runtimePhase: currentPhase,
    authorityStatus: 'allowed'
  });
}

const PROCESS_RESOLUTION_AUTHORITIES = Object.freeze({
  PROCESS_CAPABILITY_DISABLED: Object.freeze({
    disposition: 'disabled',
    authorityStatus: 'denied',
    terminalOutcome: 'policy_denied'
  }),
  PROCESS_TARGET_UNKNOWN: Object.freeze({
    disposition: 'policy_denied',
    authorityStatus: 'denied',
    terminalOutcome: 'policy_denied'
  }),
  PROCESS_PROFILE_UNKNOWN: Object.freeze({
    disposition: 'policy_denied',
    authorityStatus: 'denied',
    terminalOutcome: 'policy_denied'
  }),
  PROCESS_PHASE_DENIED: Object.freeze({
    disposition: 'policy_denied',
    authorityStatus: 'denied',
    terminalOutcome: 'policy_denied'
  }),
  PROCESS_SANDBOX_UNAVAILABLE: Object.freeze({
    disposition: 'policy_denied',
    authorityStatus: 'denied',
    terminalOutcome: 'policy_denied'
  }),
  PROCESS_EXECUTOR_UNAVAILABLE: Object.freeze({
    disposition: 'unsupported',
    authorityStatus: 'allowed',
    terminalOutcome: null
  })
});

function validateProcessOperationResolutionRecord(value) {
  validatePlainObject(value, 'process operation resolution');
  const allowedKeys = [
    'operationId', 'runId', 'ticketId', 'targetId', 'profileId',
    'disposition', 'code', 'authorityStatus', 'terminalOutcome',
    'runtimePhase', 'policySnapshotHash', 'message', 'enforcementCause'
  ];
  const unexpected = Object.keys(value).find(key => !allowedKeys.includes(key));
  if (unexpected) {
    throw new TypeError(`process operation resolution includes unsupported field: ${unexpected}`);
  }
  for (const key of allowedKeys) {
    if (!hasOwn(value, key)) throw new TypeError(`process operation resolution.${key} is required`);
  }
  processIdentifier(value.operationId, 'process operation resolution.operationId');
  processIdentifier(value.targetId, 'process operation resolution.targetId');
  processIdentifier(value.profileId, 'process operation resolution.profileId');
  validateNonnegativeInteger(value.runId, 'process operation resolution.runId', { positive: true });
  validateNonnegativeInteger(value.ticketId, 'process operation resolution.ticketId', { positive: true });
  const expected = PROCESS_RESOLUTION_AUTHORITIES[value.code];
  if (!expected) {
    throw new TypeError(`Unsupported process operation resolution code: ${String(value.code)}`);
  }
  for (const key of ['disposition', 'authorityStatus', 'terminalOutcome']) {
    if (value[key] !== expected[key]) {
      throw new TypeError(
        `process operation resolution.${key} is inconsistent with ${value.code}`
      );
    }
  }
  if (!PROCESS_RESOLUTION_RUNTIME_PHASES.includes(value.runtimePhase)) {
    throw new TypeError(
      `process operation resolution.runtimePhase must be one of ` +
      PROCESS_RESOLUTION_RUNTIME_PHASES.join(', ')
    );
  }
  if (typeof value.policySnapshotHash !== 'string' ||
      !/^[a-f0-9]{64}$/.test(value.policySnapshotHash)) {
    throw new TypeError(
      'process operation resolution.policySnapshotHash must be a lowercase SHA-256 hash'
    );
  }
  if (typeof value.message !== 'string' || value.message.length === 0 ||
      value.message.length > 2048 || /[\u0000-\u001f\u007f-\u009f]/.test(value.message)) {
    throw new TypeError('process operation resolution.message must be a bounded single-line string');
  }
  validatePlainObject(value.enforcementCause, 'process operation resolution.enforcementCause');
  const expectedCause = {
    kind: 'contract_resolution',
    disposition: value.disposition,
    errorCode: value.code,
    authorityStatus: value.authorityStatus,
    runtimePhase: value.runtimePhase
  };
  if (Object.keys(value.enforcementCause).length !== Object.keys(expectedCause).length ||
      Object.entries(expectedCause).some(([key, item]) => value.enforcementCause[key] !== item)) {
    throw new TypeError(
      'process operation resolution.enforcementCause must match the persisted resolution fields'
    );
  }
  return deepFreeze(JSON.parse(JSON.stringify(value)));
}

function buildProcessOperationResolutionRecord({
  resolution,
  runId,
  ticketId
} = {}) {
  if (!resolution || typeof resolution !== 'object' || !resolution.request) {
    throw new TypeError('resolution is required');
  }
  const request = parseProcessOperationRequest(resolution.request).args;
  return validateProcessOperationResolutionRecord({
    operationId: request.operationId,
    runId,
    ticketId,
    targetId: request.targetId,
    profileId: request.profileId,
    disposition: resolution.disposition,
    code: resolution.code,
    authorityStatus: resolution.authorityStatus,
    terminalOutcome: resolution.terminalOutcome,
    runtimePhase: resolution.runtimePhase,
    policySnapshotHash: resolution.policySnapshotHash,
    message: resolution.message,
    enforcementCause: {
      kind: 'contract_resolution',
      disposition: resolution.disposition,
      errorCode: resolution.code,
      authorityStatus: resolution.authorityStatus,
      runtimePhase: resolution.runtimePhase
    }
  });
}

function restoreProcessOperationResolution(value, action) {
  const persisted = validateProcessOperationResolutionRecord(value);
  const request = parseProcessOperationRequest(action);
  classifyProcessOperationIdReuse({
    runId: persisted.runId,
    requested: request.args,
    existing: {
      operationId: persisted.operationId,
      targetId: persisted.targetId,
      profileId: persisted.profileId
    }
  });
  return processResolution({
    disposition: persisted.disposition,
    code: persisted.code,
    message: persisted.message,
    request,
    policySnapshotHash: persisted.policySnapshotHash,
    runtimePhase: persisted.runtimePhase,
    authorityStatus: persisted.authorityStatus,
    terminalOutcome: persisted.terminalOutcome
  });
}

function processResolutionError(resolution) {
  if (!resolution || typeof resolution !== 'object') {
    throw new TypeError('process resolution is required');
  }
  return new ProcessContractError(resolution.message, {
    code: resolution.code,
    failureKind: resolution.disposition === 'unsupported' ? 'unsupported_operation' : 'process_policy_denied',
    disposition: resolution.disposition,
    terminalOutcome: resolution.terminalOutcome,
    details: {
      targetId: resolution.request && resolution.request.args.targetId,
      profileId: resolution.request && resolution.request.args.profileId,
      operationId: resolution.request && resolution.request.args.operationId,
      policySnapshotHash: resolution.policySnapshotHash,
      runtimePhase: resolution.runtimePhase
    }
  });
}

// Executor-free terminal dispatch seam. It deliberately has no executor argument and
// always throws one of the contract's typed disabled/denied/unsupported failures.
function refuseProcessOperation(
  action,
  policySnapshot,
  currentPhase = null,
  sandboxCapability = CURRENT_PROCESS_SANDBOX_CAPABILITY
) {
  throw processResolutionError(
    resolveProcessOperationRequest(action, policySnapshot, currentPhase, sandboxCapability)
  );
}

function validateProcessTerminalOutcome(value) {
  if (typeof value !== 'string' || !PROCESS_TERMINAL_OUTCOMES.includes(value)) {
    throw new TypeError(`Unsupported process terminal outcome: ${String(value)}`);
  }
  return value;
}

function validateProcessResourceLimitCause(value) {
  validatePlainObject(value, 'process resource-limit cause');
  const unexpected = Object.keys(value).find(key => !['kind', 'cause'].includes(key));
  if (unexpected || Object.keys(value).length !== 2 ||
      value.kind !== 'resource_limit' ||
      !PROCESS_RESOURCE_LIMIT_CAUSES.includes(value.cause)) {
    throw new TypeError(
      'process resource-limit cause must be exactly ' +
      '{kind:"resource_limit",cause:<defined resource cause>}'
    );
  }
  return deepFreeze({ kind: 'resource_limit', cause: value.cause });
}

function validateProcessFailedToStartCause(value) {
  validatePlainObject(value, 'process failed-to-start cause');
  if (Object.keys(value).length !== 1 ||
      !['start_error', 'launcher_capacity'].includes(value.kind)) {
    throw new TypeError(
      'process failed-to-start cause must be exactly ' +
      '{kind:"start_error"} or {kind:"launcher_capacity"}'
    );
  }
  return deepFreeze({ kind: value.kind });
}

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function requiredEvidenceField(value, key) {
  if (!hasOwn(value, key) || value[key] === null || value[key] === undefined) {
    throw new TypeError(`process evidence.${key} is required and must not be null`);
  }
}

function forbidEvidenceValue(value, key, outcome) {
  if (hasOwn(value, key) && value[key] !== null && value[key] !== undefined) {
    throw new TypeError(`process evidence.${key} is forbidden for ${outcome}`);
  }
}

function validateIsoTimestamp(value, label) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value)) ||
      new Date(value).toISOString() !== value) {
    throw new TypeError(`${label} must be a canonical UTC ISO timestamp`);
  }
}

function validateNonnegativeInteger(value, label, { positive = false } = {}) {
  if (!Number.isSafeInteger(value) || value < (positive ? 1 : 0)) {
    throw new TypeError(`${label} must be a ${positive ? 'positive' : 'nonnegative'} safe integer`);
  }
}

function validateNullableEvidenceField(value, key, validator) {
  if (!hasOwn(value, key) || value[key] === null) return;
  if (value[key] === undefined) throw new TypeError(`process evidence.${key} must be absent or null, not undefined`);
  validator(value[key], `process evidence.${key}`);
}

function validatePlainObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype) {
    throw new TypeError(`${label} must be a plain object`);
  }
}

function assertNoEnvironmentValues(value, path = 'process evidence') {
  if (!value || typeof value !== 'object') return;
  for (const [key, nested] of Object.entries(value)) {
    if (/^(?:env|environment|environmentvariables|environmentvariablevalues)$/i.test(key)) {
      throw new TypeError(`${path}.${key} may not record environment-variable values`);
    }
    assertNoEnvironmentValues(nested, `${path}.${key}`);
  }
}

function requirePreExecutionEvidence(value) {
  for (const key of PROCESS_PRE_EXECUTION_EVIDENCE_FIELDS) requiredEvidenceField(value, key);
}

function requireStartedProcessTerminalEvidence(value) {
  for (const key of [
    'finishedAt',
    'durationMs',
    'stdoutByteCount',
    'stderrByteCount',
    'stdoutTruncated',
    'stderrTruncated'
  ]) requiredEvidenceField(value, key);
}

function validateProcessEvidenceRecord(value) {
  validatePlainObject(value, 'process evidence');
  const allowed = [...PROCESS_PRE_EXECUTION_EVIDENCE_FIELDS, ...PROCESS_TERMINAL_EVIDENCE_FIELDS];
  const unexpected = Object.keys(value).find(key => !allowed.includes(key));
  if (unexpected) throw new TypeError(`process evidence includes unsupported field: ${unexpected}`);

  for (const key of ['operationId', 'runId', 'ticketId', 'targetId', 'profileId', 'policySnapshotHash']) {
    requiredEvidenceField(value, key);
  }
  processIdentifier(value.operationId, 'process evidence.operationId');
  processIdentifier(value.targetId, 'process evidence.targetId');
  processIdentifier(value.profileId, 'process evidence.profileId');
  validateNonnegativeInteger(value.runId, 'process evidence.runId', { positive: true });
  validateNonnegativeInteger(value.ticketId, 'process evidence.ticketId', { positive: true });
  if (typeof value.policySnapshotHash !== 'string' || !/^[a-f0-9]{64}$/.test(value.policySnapshotHash)) {
    throw new TypeError('process evidence.policySnapshotHash must be a lowercase SHA-256 hash');
  }

  validateNullableEvidenceField(value, 'resolvedExecutable', (item, label) => {
    if (typeof item !== 'string' || item.length === 0 || /[\u0000\r\n]/.test(item)) {
      throw new TypeError(`${label} must be a non-empty single-line string`);
    }
  });
  validateNullableEvidenceField(value, 'argumentVector', (item, label) => {
    if (!Array.isArray(item) || item.some(argument => typeof argument !== 'string')) {
      throw new TypeError(`${label} must be an array of strings`);
    }
  });
  validateNullableEvidenceField(value, 'workingDirectory', (item, label) => {
    if (typeof item !== 'string' || item.length === 0 || /[\u0000\r\n]/.test(item)) {
      throw new TypeError(`${label} must be a non-empty single-line string`);
    }
  });
  validateNullableEvidenceField(value, 'declaredEnvironmentVariableNames', (item, label) => {
    if (!Array.isArray(item) || item.some(name => typeof name !== 'string' ||
        !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))) {
      throw new TypeError(`${label} must contain only environment-variable names`);
    }
    if (new Set(item).size !== item.length) {
      throw new TypeError(`${label} must not contain duplicate names`);
    }
  });
  for (const key of ['startedAt', 'finishedAt']) {
    validateNullableEvidenceField(value, key, validateIsoTimestamp);
  }
  for (const key of ['durationMs', 'stdoutByteCount', 'stderrByteCount']) {
    validateNullableEvidenceField(value, key, validateNonnegativeInteger);
  }
  validateNullableEvidenceField(value, 'pid', (item, label) =>
    validateNonnegativeInteger(item, label, { positive: true }));
  validateNullableEvidenceField(value, 'processGroupId', (item, label) => {
    if (Number.isSafeInteger(item)) {
      validateNonnegativeInteger(item, label, { positive: true });
      return;
    }
    if (typeof item !== 'string' || item.length === 0 || item.length > PROCESS_IDENTIFIER_MAX_LENGTH ||
        /[\u0000-\u001f\u007f-\u009f]/.test(item) || item !== item.trim()) {
      throw new TypeError(`${label} must be a positive integer or bounded nonempty string`);
    }
  });
  validateNullableEvidenceField(value, 'exitCode', validateNonnegativeInteger);
  validateNullableEvidenceField(value, 'terminatingSignal', (item, label) => {
    if (typeof item !== 'string' || !item || item.length > 64 ||
        /[\u0000-\u001f\u007f-\u009f]/.test(item) || item !== item.trim()) {
      throw new TypeError(`${label} must be a bounded nonempty string`);
    }
  });
  for (const key of ['stdoutTruncated', 'stderrTruncated']) {
    validateNullableEvidenceField(value, key, (item, label) => {
      if (typeof item !== 'boolean') throw new TypeError(`${label} must be a boolean`);
    });
  }
  for (const key of ['stdoutArtifactRef', 'stderrArtifactRef']) {
    validateNullableEvidenceField(value, key, (item, label) => {
      if (typeof item !== 'string' || item.length === 0 ||
          item.length > PROCESS_ARTIFACT_REFERENCE_MAX_LENGTH ||
          /[\u0000-\u001f\u007f-\u009f]/.test(item)) {
        throw new TypeError(`${label} must be a bounded nonempty artifact reference`);
      }
    });
  }
  for (const key of ['stdoutInline', 'stderrInline']) {
    validateNullableEvidenceField(value, key, (item, label) => {
      if (typeof item !== 'string' ||
          Buffer.byteLength(item, 'utf8') > PROCESS_INLINE_OUTPUT_MAX_BYTES) {
        throw new TypeError(`${label} must be a string no larger than ${PROCESS_INLINE_OUTPUT_MAX_BYTES} UTF-8 bytes`);
      }
    });
  }
  validateNullableEvidenceField(value, 'enforcementCause', (item, label) => {
    validatePlainObject(item, label);
    if (typeof item.kind !== 'string' || !item.kind.trim()) {
      throw new TypeError(`${label}.kind must be a non-empty string`);
    }
  });

  if (value.stdoutArtifactRef != null && value.stdoutInline != null) {
    throw new TypeError('process evidence stdout must use either artifact reference or inline value, not both');
  }
  if (value.stderrArtifactRef != null && value.stderrInline != null) {
    throw new TypeError('process evidence stderr must use either artifact reference or inline value, not both');
  }
  assertNoEnvironmentValues(value);

  if (hasOwn(value, 'terminalOutcome') && value.terminalOutcome === undefined) {
    throw new TypeError('process evidence.terminalOutcome must be absent, null, or a defined outcome');
  }
  const terminalOutcome = hasOwn(value, 'terminalOutcome') && value.terminalOutcome !== null
    ? validateProcessTerminalOutcome(value.terminalOutcome)
    : null;
  if (terminalOutcome === null) {
    requirePreExecutionEvidence(value);
    for (const key of PROCESS_TERMINAL_EVIDENCE_FIELDS) {
      if (key !== 'terminalOutcome') forbidEvidenceValue(value, key, 'pre-execution evidence');
    }
  } else if (terminalOutcome === 'policy_denied') {
    requiredEvidenceField(value, 'enforcementCause');
    for (const key of [
      'resolvedExecutable', 'argumentVector', 'workingDirectory',
      'declaredEnvironmentVariableNames', 'startedAt', 'finishedAt', 'durationMs',
      'pid', 'processGroupId', 'exitCode', 'terminatingSignal',
      'stdoutByteCount', 'stderrByteCount', 'stdoutTruncated', 'stderrTruncated',
      'stdoutArtifactRef', 'stdoutInline', 'stderrArtifactRef', 'stderrInline'
    ]) forbidEvidenceValue(value, key, terminalOutcome);
  } else {
    requirePreExecutionEvidence(value);
    requiredEvidenceField(value, 'finishedAt');
    requiredEvidenceField(value, 'durationMs');
    if (terminalOutcome !== 'failed_to_start') requireStartedProcessTerminalEvidence(value);
    if (terminalOutcome === 'completed') {
      requiredEvidenceField(value, 'exitCode');
      if (value.exitCode !== 0) throw new TypeError('completed process evidence.exitCode must be zero');
      forbidEvidenceValue(value, 'terminatingSignal', terminalOutcome);
      forbidEvidenceValue(value, 'enforcementCause', terminalOutcome);
    } else if (terminalOutcome === 'exited_nonzero') {
      requiredEvidenceField(value, 'exitCode');
      if (value.exitCode === 0) throw new TypeError('exited_nonzero process evidence.exitCode must be nonzero');
      forbidEvidenceValue(value, 'terminatingSignal', terminalOutcome);
      forbidEvidenceValue(value, 'enforcementCause', terminalOutcome);
    } else if (terminalOutcome === 'signaled') {
      requiredEvidenceField(value, 'terminatingSignal');
      forbidEvidenceValue(value, 'exitCode', terminalOutcome);
      forbidEvidenceValue(value, 'enforcementCause', terminalOutcome);
    } else if (terminalOutcome === 'failed_to_start') {
      requiredEvidenceField(value, 'enforcementCause');
      validateProcessFailedToStartCause(value.enforcementCause);
      for (const key of [
        'pid', 'processGroupId', 'exitCode', 'terminatingSignal',
        'stdoutByteCount', 'stderrByteCount', 'stdoutTruncated', 'stderrTruncated',
        'stdoutArtifactRef', 'stdoutInline', 'stderrArtifactRef', 'stderrInline'
      ]) forbidEvidenceValue(value, key, terminalOutcome);
    } else {
      requiredEvidenceField(value, 'enforcementCause');
      if (terminalOutcome === 'resource_limit_exceeded') {
        validateProcessResourceLimitCause(value.enforcementCause);
        requiredEvidenceField(value, 'pid');
        requiredEvidenceField(value, 'processGroupId');
      }
    }
  }

  let clone;
  try {
    clone = JSON.parse(JSON.stringify(value));
  } catch (_) {
    throw new TypeError('process evidence must be JSON-serializable');
  }
  return deepFreeze(clone);
}

module.exports = {
  CURRENT_PROCESS_SANDBOX_CAPABILITY,
  PROCESS_AUTHORITY_CARDINALITY_LIMITS,
  PROCESS_AUTHORITY_RULE,
  PROCESS_CONTRACT_VERSION,
  PROCESS_EVIDENCE_CONTRACT,
  PROCESS_EXECUTABLE_FORMAT,
  PROCESS_EXECUTION_POLICY,
  PROCESS_FEATURE_ENV,
  PROCESS_FILESYSTEM_POLICY,
  PROCESS_FILESYSTEM_POLICY_HARD_LIMITS,
  PROCESS_IDENTIFIER_MAX_LENGTH,
  PROCESS_INLINE_OUTPUT_MAX_BYTES,
  PROCESS_OPERATION,
  PROCESS_NETWORK_ACCESS_NONE_MEANING,
  PROCESS_PHASE_AUTHORITY_RULE,
  PROCESS_POLICY_SNAPSHOT_HISTORICAL_VERSION_2,
  PROCESS_POLICY_SNAPSHOT_HISTORICAL_VERSION,
  PROCESS_POLICY_SNAPSHOT_VERSION,
  PROCESS_PROFILE_HARD_LIMITS,
  PROCESS_RESOURCE_LIMIT_CAUSES,
  PROCESS_RUNTIME_PHASES,
  PROCESS_SANDBOX_CAPABILITY_MAX_VALIDITY_MS,
  PROCESS_SANDBOX_CAPABILITY_STATUS,
  PROCESS_SANDBOX_CAPABILITY_VERSION,
  PROCESS_SANDBOX_LAUNCHER_PROTOCOL_MAX_VERSION,
  PROCESS_PRE_EXECUTION_EVIDENCE_FIELDS,
  PROCESS_TERMINAL_EVIDENCE_FIELDS,
  PROCESS_TERMINAL_OUTCOMES,
  ProcessContractError,
  buildProcessOperationIdentity,
  buildProcessOperationResolutionRecord,
  buildProcessPolicySnapshot,
  buildHistoricalProcessPolicySnapshotV1,
  canonicalizeProcessContractValue,
  classifyProcessOperationIdReuse,
  historicalProcessGrantReferences,
  hashProcessContractValue,
  isProcessContractFeatureEnabled,
  normalizeProcessPolicySnapshot,
  normalizeProcessSandboxCapabilityDescriptor,
  parseProcessOperationRequest,
  processIdentifier,
  processAuthorityReferences,
  processResolutionError,
  projectProcessSandboxCapabilityGeneration,
  refuseProcessOperation,
  resolveProcessOperationRequest,
  restoreProcessOperationResolution,
  validateProcessEvidenceRecord,
  validateProcessFailedToStartCause,
  validateProcessOperationResolutionRecord,
  validateProcessResourceLimitCause,
  validateProcessTerminalOutcome
};

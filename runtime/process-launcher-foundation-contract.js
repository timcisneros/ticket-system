'use strict';

const path = require('path');

const {
  PROCESS_LAUNCHER_ENVIRONMENT,
  PROCESS_SHA256_PATTERN,
  validateProcessIdentifier
} = require('./process-authority-constants');
const {
  canonicalizeProcessContractValue,
  hashProcessContractValue,
  normalizeProcessSandboxCapabilityDescriptor
} = require('./process-execution-contract');
const {
  PROCESS_OPERATION_IDENTITY_PATTERN,
  validateProcessLaunchPlan
} = require('./process-launch-plan');
const {
  normalizeMaterializerGeneration
} = require('./process-materializer-contract');

const PROCESS_LAUNCHER_FOUNDATION_PROTOCOL_VERSION = 1;
const PROCESS_ROOTFS_MANIFEST_SCHEMA_VERSION = 1;
const PROCESS_LAUNCHER_FOUNDATION_MAX_MESSAGE_BYTES = 2_097_152;
const PROCESS_LAUNCHER_FOUNDATION_DEFAULT_TIMEOUT_MS = 30_000;
const PROCESS_LAUNCHER_FOUNDATION_MAX_TIMEOUT_MS = 300_000;
const PROCESS_LAUNCHER_FOUNDATION_DEFAULT_SOCKET_PATH =
  '/run/ticket-system-process/launcher/launcher.sock';
const PROCESS_SANDBOX_PREREQUISITE_VERSION = 1;
const PROCESS_SANDBOX_PREREQUISITE_STATUS = 'prerequisites_verified';
const PROCESS_SANDBOX_PREREQUISITE_MAX_VALIDITY_MS = 300_000;

const PROCESS_LAUNCHER_FOUNDATION_FAILURE_CODES = Object.freeze([
  'PROCESS_LAUNCHER_FOUNDATION_UNAVAILABLE',
  'PROCESS_LAUNCHER_CLIENT_UNAUTHORIZED',
  'PROCESS_LAUNCHER_PROTOCOL_INVALID',
  'PROCESS_LAUNCHER_ALREADY_RUNNING',
  'PROCESS_ROOTFS_REGISTRY_INVALID',
  'PROCESS_ROOTFS_UNKNOWN',
  'PROCESS_ROOTFS_UNAVAILABLE',
  'PROCESS_ROOTFS_MANIFEST_INVALID',
  'PROCESS_ROOTFS_MANIFEST_MISMATCH',
  'PROCESS_ROOTFS_ENTRY_INVALID',
  'PROCESS_ROOTFS_IDENTITY_CHANGED',
  'PROCESS_EXECUTABLE_IDENTITY_MISMATCH',
  'PROCESS_EXECUTABLE_FORMAT_UNSUPPORTED',
  'PROCESS_SANDBOX_BACKEND_INVALID',
  'PROCESS_SECCOMP_POLICY_INVALID',
  'PROCESS_SANDBOX_PREREQUISITES_UNAVAILABLE',
  'PROCESS_SANDBOX_PREREQUISITES_EXPIRED',
  'PROCESS_CONTAINMENT_UNAVAILABLE',
  'PROCESS_CONTAINMENT_GENERATION_MISMATCH',
  'PROCESS_CONTAINMENT_EXPIRED',
  'PROCESS_LAUNCH_PLAN_INVALID',
  'PROCESS_SNAPSHOT_DESCRIPTOR_UNAVAILABLE',
  'PROCESS_SNAPSHOT_DESCRIPTOR_INVALID',
  'PROCESS_SNAPSHOT_PRINCIPAL_UNAUTHORIZED',
  'PROCESS_CGROUP_DELEGATION_UNAVAILABLE',
  'PROCESS_CGROUP_CONTROLLER_UNAVAILABLE',
  'PROCESS_CGROUP_LIMIT_UNAVAILABLE',
  'PROCESS_CGROUP_MEMBERSHIP_FAILED',
  'PROCESS_CGROUP_TERMINATION_FAILED',
  'PROCESS_NAMESPACE_UNAVAILABLE',
  'PROCESS_MOUNT_LAYOUT_INVALID',
  'PROCESS_NETWORK_ISOLATION_UNAVAILABLE',
  'PROCESS_SECCOMP_INSTALLATION_FAILED',
  'PROCESS_ENVIRONMENT_INVALID',
  'PROCESS_FAILED_TO_START',
  'PROCESS_OUTPUT_LIMIT_EXCEEDED',
  'PROCESS_WALL_TIME_EXCEEDED',
  'PROCESS_RESOURCE_LIMIT_EXCEEDED',
  'PROCESS_OPERATION_NOT_FOUND',
  'PROCESS_OPERATION_ALREADY_ACTIVE',
  'PROCESS_OPERATION_TERMINATION_FAILED',
  'PROCESS_EXECUTION_INTENT_CONFLICT',
  'PROCESS_LAUNCHER_REGISTRY_INVALID',
  'PROCESS_LAUNCHER_REGISTRY_FULL',
  'PROCESS_LAUNCHER_CAPACITY_UNAVAILABLE',
  'PROCESS_OUTPUT_UNAVAILABLE',
  'PROCESS_OUTPUT_CHUNK_INVALID',
  'PROCESS_OUTPUT_ACKNOWLEDGEMENT_FAILED'
]);

const EXECUTION_RESULT_KEYS = Object.freeze([
  'operationIdentity',
  'terminalOutcome',
  'startedAt',
  'endedAt',
  'durationMs',
  'exitCode',
  'signal',
  'stdoutBytes',
  'stderrBytes',
  'combinedOutputBytes',
  'stdoutSha256',
  'stderrSha256',
  'outputComplete',
  'resourceCause',
  'enforcementCause',
  'cpuThrottledEvents',
  'launcherEnvironment'
]);
const OPERATION_STATUS_KEYS = Object.freeze([
  'operationIdentity',
  'state',
  'launcherAcceptanceIdentity',
  'terminalResultHash',
  'outputAvailable',
  'result'
]);
const OUTPUT_CHUNK_KEYS = Object.freeze([
  'operationIdentity',
  'stream',
  'offset',
  'totalBytes',
  'sha256',
  'dataBase64',
  'end'
]);
const REGISTRY_METRICS_KEYS = Object.freeze([
  'version',
  'fullRecordCount',
  'compactTombstoneCount',
  'fullRecordCapacity',
  'compactTombstoneCapacity',
  'fullRecordCapacityRemaining',
  'compactTombstoneCapacityRemaining'
]);
const LAUNCH_REQUEST_KEYS = Object.freeze([
  'launchPlan',
  'containmentGenerationId'
]);
const PROCESS_PRIVATE_TERMINAL_OUTCOMES = Object.freeze([
  'completed',
  'exited_nonzero',
  'signaled',
  'timed_out',
  'cancelled',
  'output_limit_exceeded',
  'resource_limit_exceeded',
  'failed_to_start',
  'runtime_interrupted'
]);
const PROCESS_PRIVATE_RESOURCE_CAUSES = Object.freeze([
  'memory',
  'process_count',
  'open_files',
  'file_size',
  'temporary_storage'
]);

const FOUNDATION_HEALTH_KEYS = Object.freeze([
  'version',
  'status',
  'launcherProtocolVersion',
  'launcherIdentityHash',
  'sandboxBackendIdentityHash',
  'seccompPolicyHash',
  'rootfsRegistryGeneration',
  'hostPrerequisiteIdentityHash',
  'verifiedAt',
  'expiresAt',
  'readyForExecution',
  'hostPrerequisites'
]);
const HOST_PREREQUISITE_KEYS = Object.freeze([
  'platform',
  'kernelRelease',
  'cgroupV2',
  'cgroupControllers',
  'delegatedCgroupRoot',
  'userNamespaces',
  'mountNamespaces',
  'pidNamespaces',
  'networkNamespaces',
  'seccompFilter',
  'noNewPrivs',
  'activeContainmentProof'
]);
const ROOTFS_AUTHORITY_KEYS = Object.freeze([
  'id',
  'manifestSha256',
  'physicalIdentityHash',
  'entryCount',
  'totalRegularBytes',
  'rootfsRegistryGeneration'
]);
const EXECUTABLE_AUTHORITY_KEYS = Object.freeze([
  'rootfsId',
  'rootfsManifestSha256',
  'executablePath',
  'executableSha256',
  'format',
  'rootfsRegistryGeneration'
]);
const SANDBOX_PREREQUISITE_KEYS = Object.freeze([
  'version',
  'status',
  'generationId',
  'launcherProtocolVersion',
  'launcherIdentityHash',
  'sandboxBackendIdentityHash',
  'seccompPolicyHash',
  'rootfsRegistryGeneration',
  'hostPrerequisiteIdentityHash',
  'materializerGeneration',
  'verifiedAt',
  'expiresAt',
  'readyForExecution'
]);

class ProcessLauncherFoundationError extends Error {
  constructor(message, code = 'PROCESS_LAUNCHER_PROTOCOL_INVALID', details = {}) {
    super(message);
    this.name = 'ProcessLauncherFoundationError';
    this.code = code;
    this.failureKind = 'process_sandbox_prerequisite_failed';
    this.details = details;
  }
}

function fail(message, code = 'PROCESS_LAUNCHER_PROTOCOL_INVALID', details = {}) {
  throw new ProcessLauncherFoundationError(message, code, details);
}

function plainObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype) {
    fail(`${label} must be a plain object`);
  }
}

function closed(value, keys, label) {
  plainObject(value, label);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length ||
      actual.some((key, index) => key !== expected[index])) {
    fail(`${label} must contain exactly: ${keys.join(', ')}`);
  }
}

function identifier(value, label) {
  try {
    return validateProcessIdentifier(value, label);
  } catch (error) {
    fail(error.message);
  }
}

function sha256(value, label) {
  if (typeof value !== 'string' || !PROCESS_SHA256_PATTERN.test(value)) {
    fail(`${label} must be a lowercase SHA-256`);
  }
  return value;
}

function nonnegativeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    fail(`${label} must be a nonnegative safe integer`);
  }
  return value;
}

function timestamp(value, label) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value)) ||
      new Date(value).toISOString() !== value) {
    fail(`${label} must be a canonical UTC timestamp`);
  }
  return value;
}

function normalizedExecutablePath(value) {
  if (typeof value !== 'string' || value.length < 2 || value.length > 4096 ||
      !path.posix.isAbsolute(value) || value !== path.posix.normalize(value) ||
      /[\u0000-\u001f\u007f-\u009f]/.test(value)) {
    fail('executablePath must be a bounded normalized absolute path inside the rootfs',
      'PROCESS_EXECUTABLE_IDENTITY_MISMATCH');
  }
  return value;
}

function normalizeProcessLauncherFoundationClientConfig(value) {
  closed(value, ['version', 'socketPath', 'timeoutMs'],
    'process launcher foundation client configuration');
  if (value.version !== 1) fail('launcher client configuration version must be 1');
  if (typeof value.socketPath !== 'string' ||
      !path.posix.isAbsolute(value.socketPath) ||
      value.socketPath !== path.posix.normalize(value.socketPath) ||
      value.socketPath.length > 4096 ||
      /[\u0000-\u001f\u007f-\u009f]/.test(value.socketPath)) {
    fail('launcher socketPath must be a bounded normalized absolute path');
  }
  if (!Number.isSafeInteger(value.timeoutMs) || value.timeoutMs <= 0 ||
      value.timeoutMs > PROCESS_LAUNCHER_FOUNDATION_MAX_TIMEOUT_MS) {
    fail(`launcher timeoutMs must be 1..=${PROCESS_LAUNCHER_FOUNDATION_MAX_TIMEOUT_MS}`);
  }
  return Object.freeze({
    version: 1,
    socketPath: value.socketPath,
    timeoutMs: value.timeoutMs
  });
}

function buildGetRootfsRequest(value) {
  closed(value, ['rootfsId', 'rootfsManifestSha256'], 'getRootfs request');
  return Object.freeze({
    rootfsId: identifier(value.rootfsId, 'rootfsId'),
    rootfsManifestSha256: sha256(
      value.rootfsManifestSha256,
      'rootfsManifestSha256'
    )
  });
}

function buildVerifyExecutableRequest(value) {
  closed(value, [
    'rootfsId',
    'rootfsManifestSha256',
    'executablePath',
    'executableSha256',
    'format'
  ], 'verifyExecutable request');
  if (value.format !== 'elf') {
    fail('verifyExecutable format must be elf', 'PROCESS_EXECUTABLE_FORMAT_UNSUPPORTED');
  }
  return Object.freeze({
    rootfsId: identifier(value.rootfsId, 'rootfsId'),
    rootfsManifestSha256: sha256(
      value.rootfsManifestSha256,
      'rootfsManifestSha256'
    ),
    executablePath: normalizedExecutablePath(value.executablePath),
    executableSha256: sha256(value.executableSha256, 'executableSha256'),
    format: 'elf'
  });
}

function normalizeRootfsAuthority(value, expected = {}) {
  closed(value, ROOTFS_AUTHORITY_KEYS, 'rootfs authority');
  const normalized = Object.freeze({
    id: identifier(value.id, 'rootfs authority.id'),
    manifestSha256: sha256(value.manifestSha256, 'rootfs authority.manifestSha256'),
    physicalIdentityHash: sha256(
      value.physicalIdentityHash,
      'rootfs authority.physicalIdentityHash'
    ),
    entryCount: nonnegativeInteger(value.entryCount, 'rootfs authority.entryCount'),
    totalRegularBytes: nonnegativeInteger(
      value.totalRegularBytes,
      'rootfs authority.totalRegularBytes'
    ),
    rootfsRegistryGeneration: identifier(
      value.rootfsRegistryGeneration,
      'rootfs authority.rootfsRegistryGeneration'
    )
  });
  for (const [key, expectedValue] of Object.entries(expected)) {
    if (expectedValue !== undefined && normalized[key] !== expectedValue) {
      fail(`rootfs authority.${key} does not match the request`,
        'PROCESS_ROOTFS_MANIFEST_MISMATCH');
    }
  }
  return normalized;
}

function normalizeExecutableAuthority(value, expected = {}) {
  closed(value, EXECUTABLE_AUTHORITY_KEYS, 'executable authority');
  if (value.format !== 'elf') {
    fail('executable authority format must be elf',
      'PROCESS_EXECUTABLE_FORMAT_UNSUPPORTED');
  }
  const normalized = Object.freeze({
    rootfsId: identifier(value.rootfsId, 'executable authority.rootfsId'),
    rootfsManifestSha256: sha256(
      value.rootfsManifestSha256,
      'executable authority.rootfsManifestSha256'
    ),
    executablePath: normalizedExecutablePath(value.executablePath),
    executableSha256: sha256(
      value.executableSha256,
      'executable authority.executableSha256'
    ),
    format: 'elf',
    rootfsRegistryGeneration: identifier(
      value.rootfsRegistryGeneration,
      'executable authority.rootfsRegistryGeneration'
    )
  });
  for (const [key, expectedValue] of Object.entries(expected)) {
    if (expectedValue !== undefined && normalized[key] !== expectedValue) {
      fail(`executable authority.${key} does not match the request`,
        'PROCESS_EXECUTABLE_IDENTITY_MISMATCH');
    }
  }
  return normalized;
}

function normalizeFoundationHealth(value, { observedAt = new Date().toISOString() } = {}) {
  closed(value, FOUNDATION_HEALTH_KEYS, 'launcher foundation health');
  if (value.version !== 1 || value.status !== 'foundation_verified' ||
      value.launcherProtocolVersion !== 1 || value.readyForExecution !== false) {
    fail('launcher foundation health does not describe a non-executable verified foundation',
      'PROCESS_SANDBOX_PREREQUISITES_UNAVAILABLE');
  }
  closed(value.hostPrerequisites, HOST_PREREQUISITE_KEYS,
    'launcher host prerequisite inspection');
  if (value.hostPrerequisites.platform !== 'linux' ||
      value.hostPrerequisites.activeContainmentProof !== 'not_proven_until_2a3') {
    fail('launcher host prerequisite inspection overstates enforcement',
      'PROCESS_SANDBOX_PREREQUISITES_UNAVAILABLE');
  }
  for (const key of [
    'cgroupV2',
    'userNamespaces',
    'mountNamespaces',
    'pidNamespaces',
    'networkNamespaces',
    'seccompFilter',
    'noNewPrivs'
  ]) {
    if (value.hostPrerequisites[key] !== 'statically_present') {
      fail(`launcher host prerequisite ${key} is unavailable`,
        'PROCESS_SANDBOX_PREREQUISITES_UNAVAILABLE');
    }
  }
  if (!Array.isArray(value.hostPrerequisites.cgroupControllers) ||
      !['cpu', 'memory', 'pids'].every(required =>
        value.hostPrerequisites.cgroupControllers.includes(required)) ||
      value.hostPrerequisites.cgroupControllers.some(item =>
        typeof item !== 'string' || !item)) {
    fail('launcher cgroup controller inspection is incomplete',
      'PROCESS_SANDBOX_PREREQUISITES_UNAVAILABLE');
  }
  const verifiedAt = timestamp(value.verifiedAt, 'launcher health.verifiedAt');
  const expiresAt = timestamp(value.expiresAt, 'launcher health.expiresAt');
  const verifiedTime = Date.parse(verifiedAt);
  const expiryTime = Date.parse(expiresAt);
  const observedTime = Date.parse(timestamp(observedAt, 'launcher health observedAt'));
  if (expiryTime <= verifiedTime ||
      expiryTime - verifiedTime < 1000 ||
      expiryTime - verifiedTime > PROCESS_SANDBOX_PREREQUISITE_MAX_VALIDITY_MS ||
      verifiedTime > observedTime) {
    fail('launcher prerequisite expiry must follow verification',
      'PROCESS_SANDBOX_PREREQUISITES_UNAVAILABLE');
  }
  if (observedTime >= expiryTime) {
    fail('launcher prerequisite health has expired',
      'PROCESS_SANDBOX_PREREQUISITES_EXPIRED');
  }
  return deepFreeze({
    version: 1,
    status: 'foundation_verified',
    launcherProtocolVersion: 1,
    launcherIdentityHash: sha256(
      value.launcherIdentityHash,
      'launcher health.launcherIdentityHash'
    ),
    sandboxBackendIdentityHash: sha256(
      value.sandboxBackendIdentityHash,
      'launcher health.sandboxBackendIdentityHash'
    ),
    seccompPolicyHash: sha256(
      value.seccompPolicyHash,
      'launcher health.seccompPolicyHash'
    ),
    rootfsRegistryGeneration: identifier(
      value.rootfsRegistryGeneration,
      'launcher health.rootfsRegistryGeneration'
    ),
    hostPrerequisiteIdentityHash: sha256(
      value.hostPrerequisiteIdentityHash,
      'launcher health.hostPrerequisiteIdentityHash'
    ),
    verifiedAt,
    expiresAt,
    readyForExecution: false,
    hostPrerequisites: {
      ...value.hostPrerequisites,
      cgroupControllers: [...value.hostPrerequisites.cgroupControllers]
    }
  });
}

function buildProcessSandboxPrerequisiteDescriptor({
  launcherHealth,
  materializerHealth,
  observedAt = new Date().toISOString()
} = {}) {
  const launcher = normalizeFoundationHealth(launcherHealth, { observedAt });
  const materializer = normalizeMaterializerGeneration(materializerHealth);
  const authority = {
    launcherProtocolVersion: launcher.launcherProtocolVersion,
    launcherIdentityHash: launcher.launcherIdentityHash,
    sandboxBackendIdentityHash: launcher.sandboxBackendIdentityHash,
    seccompPolicyHash: launcher.seccompPolicyHash,
    rootfsRegistryGeneration: launcher.rootfsRegistryGeneration,
    hostPrerequisiteIdentityHash: launcher.hostPrerequisiteIdentityHash,
    materializerGeneration: materializer.materializerGeneration
  };
  return deepFreeze({
    version: PROCESS_SANDBOX_PREREQUISITE_VERSION,
    status: PROCESS_SANDBOX_PREREQUISITE_STATUS,
    generationId: `sandbox-prerequisite-v1-${hashProcessContractValue(authority)}`,
    ...authority,
    verifiedAt: launcher.verifiedAt,
    expiresAt: launcher.expiresAt,
    readyForExecution: false
  });
}

function normalizeProcessSandboxPrerequisiteDescriptor(value, options) {
  closed(value, SANDBOX_PREREQUISITE_KEYS, 'sandbox prerequisite descriptor');
  const rebuilt = buildProcessSandboxPrerequisiteDescriptor({
    launcherHealth: {
      version: 1,
      status: 'foundation_verified',
      launcherProtocolVersion: value.launcherProtocolVersion,
      launcherIdentityHash: value.launcherIdentityHash,
      sandboxBackendIdentityHash: value.sandboxBackendIdentityHash,
      seccompPolicyHash: value.seccompPolicyHash,
      rootfsRegistryGeneration: value.rootfsRegistryGeneration,
      hostPrerequisiteIdentityHash: value.hostPrerequisiteIdentityHash,
      verifiedAt: value.verifiedAt,
      expiresAt: value.expiresAt,
      readyForExecution: false,
      hostPrerequisites: {
        platform: 'linux',
        kernelRelease: 'validated-private-projection',
        cgroupV2: 'statically_present',
        cgroupControllers: ['cpu', 'memory', 'pids'],
        delegatedCgroupRoot: 'statically_present',
        userNamespaces: 'statically_present',
        mountNamespaces: 'statically_present',
        pidNamespaces: 'statically_present',
        networkNamespaces: 'statically_present',
        seccompFilter: 'statically_present',
        noNewPrivs: 'statically_present',
        activeContainmentProof: 'not_proven_until_2a3'
      }
    },
    materializerHealth: {
      materializerGeneration: value.materializerGeneration,
      materializerIdentityHash: '0'.repeat(64),
      inputPolicyHash: '0'.repeat(64),
      manifestSchemaVersion: 1,
      registrySchemaVersion: 1
    },
    ...(options || {})
  });
  if (value.version !== PROCESS_SANDBOX_PREREQUISITE_VERSION ||
      value.status !== PROCESS_SANDBOX_PREREQUISITE_STATUS ||
      value.readyForExecution !== false ||
      value.generationId !== rebuilt.generationId) {
    fail('sandbox prerequisite descriptor is malformed or has a mismatched generation',
      'PROCESS_SANDBOX_PREREQUISITES_UNAVAILABLE');
  }
  return deepFreeze({ ...value });
}

function normalizeContainmentHealth(value, options) {
  try {
    return normalizeProcessSandboxCapabilityDescriptor(value, options);
  } catch (error) {
    const code = /expired|currently valid/.test(error.message)
      ? 'PROCESS_CONTAINMENT_EXPIRED'
      : 'PROCESS_CONTAINMENT_UNAVAILABLE';
    fail(`Launcher containment health is invalid: ${error.message}`, code);
  }
}

function buildLauncherLaunchRequest(value, {
  launchAuthorityContext,
  sandboxCapability
} = {}) {
  closed(value, LAUNCH_REQUEST_KEYS, 'launcher launch request');
  const capability = normalizeContainmentHealth(sandboxCapability);
  const launchPlan = validateProcessLaunchPlan(value.launchPlan, {
    launchAuthorityContext,
    sandboxCapability: capability
  });
  const generationId = identifier(
    value.containmentGenerationId,
    'containmentGenerationId'
  );
  if (generationId !== capability.generationId ||
      launchPlan.sandboxCapability.generationId !== generationId) {
    fail(
      'launch request does not bind the exact active containment generation',
      'PROCESS_CONTAINMENT_GENERATION_MISMATCH'
    );
  }
  return deepFreeze({
    launchPlan,
    containmentGenerationId: generationId
  });
}

function buildLauncherOperationRequest(value) {
  closed(value, ['operationIdentity'], 'launcher operation request');
  if (typeof value.operationIdentity !== 'string' ||
      !PROCESS_OPERATION_IDENTITY_PATTERN.test(value.operationIdentity)) {
    fail('operationIdentity must be a canonical process-operation identity');
  }
  return Object.freeze({ operationIdentity: value.operationIdentity });
}

function buildLauncherReadOutputRequest(value) {
  closed(value, [
    'operationIdentity',
    'stream',
    'offset',
    'maximumBytes',
    'expectedTotalBytes',
    'expectedSha256'
  ], 'launcher readOutput request');
  const operation = buildLauncherOperationRequest({
    operationIdentity: value.operationIdentity
  });
  if (!['stdout', 'stderr'].includes(value.stream)) {
    fail('launcher output stream must be stdout or stderr');
  }
  const offset = nonnegativeInteger(value.offset, 'launcher output offset');
  const maximumBytes = nonnegativeInteger(
    value.maximumBytes,
    'launcher output maximumBytes'
  );
  if (maximumBytes === 0 || maximumBytes > 65_536) {
    fail('launcher output maximumBytes must be between 1 and 65536');
  }
  const expectedTotalBytes = nonnegativeInteger(
    value.expectedTotalBytes,
    'launcher output expectedTotalBytes'
  );
  if (offset > expectedTotalBytes) {
    fail('launcher output offset exceeds expectedTotalBytes');
  }
  return Object.freeze({
    operationIdentity: operation.operationIdentity,
    stream: value.stream,
    offset,
    maximumBytes,
    expectedTotalBytes,
    expectedSha256: sha256(value.expectedSha256, 'launcher output expectedSha256')
  });
}

function buildLauncherOutputAcknowledgementRequest(value) {
  closed(value, [
    'operationIdentity',
    'terminalResultHash'
  ], 'launcher output acknowledgement request');
  const operation = buildLauncherOperationRequest({
    operationIdentity: value.operationIdentity
  });
  return Object.freeze({
    operationIdentity: operation.operationIdentity,
    terminalResultHash: sha256(
      value.terminalResultHash,
      'launcher output terminalResultHash'
    )
  });
}

function buildLauncherCompactionRequest(value) {
  closed(value, [
    'operationIdentity',
    'terminalResultHash',
    'durableFinalizationHash'
  ], 'launcher operation compaction request');
  const operation = buildLauncherOperationRequest({
    operationIdentity: value.operationIdentity
  });
  return Object.freeze({
    operationIdentity: operation.operationIdentity,
    terminalResultHash: sha256(
      value.terminalResultHash,
      'launcher compaction terminalResultHash'
    ),
    durableFinalizationHash: sha256(
      value.durableFinalizationHash,
      'launcher compaction durableFinalizationHash'
    )
  });
}

function normalizeLauncherRegistryMetrics(value) {
  closed(value, REGISTRY_METRICS_KEYS, 'launcher registry metrics');
  if (value.version !== 1) {
    fail('launcher registry metrics version is unsupported');
  }
  const normalized = { version: value.version };
  for (const key of REGISTRY_METRICS_KEYS.slice(1)) {
    normalized[key] = nonnegativeInteger(value[key], `launcher registry metrics.${key}`);
  }
  if (normalized.fullRecordCount + normalized.fullRecordCapacityRemaining !==
      normalized.fullRecordCapacity ||
      normalized.compactTombstoneCount +
        normalized.compactTombstoneCapacityRemaining !==
      normalized.compactTombstoneCapacity) {
    fail('launcher registry metrics contain contradictory capacity facts');
  }
  return deepFreeze(normalized);
}

function nullableInteger(value, label, { minimum = 0 } = {}) {
  if (value === null) return null;
  if (!Number.isSafeInteger(value) || value < minimum) {
    fail(`${label} must be null or a safe integer no smaller than ${minimum}`);
  }
  return value;
}

function normalizeLauncherEnvironment(value) {
  const keys = Object.keys(PROCESS_LAUNCHER_ENVIRONMENT);
  closed(value, keys, 'launcher-added environment');
  if (keys.some(key => value[key] !== PROCESS_LAUNCHER_ENVIRONMENT[key])) {
    fail(
      'launcher-added environment must be the fixed LANG, LC_ALL, and TMPDIR values',
      'PROCESS_ENVIRONMENT_INVALID'
    );
  }
  return deepFreeze({ ...PROCESS_LAUNCHER_ENVIRONMENT });
}

function normalizePrivateExecutionResult(value, expectedOperationIdentity) {
  closed(value, EXECUTION_RESULT_KEYS, 'private process execution result');
  if (typeof value.operationIdentity !== 'string' ||
      !PROCESS_OPERATION_IDENTITY_PATTERN.test(value.operationIdentity) ||
      (expectedOperationIdentity !== undefined &&
       value.operationIdentity !== expectedOperationIdentity)) {
    fail('private execution result operationIdentity is invalid or mismatched');
  }
  if (!PROCESS_PRIVATE_TERMINAL_OUTCOMES.includes(value.terminalOutcome)) {
    fail('private execution result terminalOutcome is unsupported');
  }
  const startedAt = timestamp(value.startedAt, 'private execution result.startedAt');
  const endedAt = timestamp(value.endedAt, 'private execution result.endedAt');
  if (Date.parse(endedAt) < Date.parse(startedAt)) {
    fail('private execution result endedAt precedes startedAt');
  }
  const durationMs = nonnegativeInteger(
    value.durationMs,
    'private execution result.durationMs'
  );
  const exitCode = nullableInteger(value.exitCode, 'private execution result.exitCode');
  const signal = nullableInteger(value.signal, 'private execution result.signal', {
    minimum: 1
  });
  const stdoutBytes = nonnegativeInteger(
    value.stdoutBytes,
    'private execution result.stdoutBytes'
  );
  const stderrBytes = nonnegativeInteger(
    value.stderrBytes,
    'private execution result.stderrBytes'
  );
  const combinedOutputBytes = nonnegativeInteger(
    value.combinedOutputBytes,
    'private execution result.combinedOutputBytes'
  );
  if (combinedOutputBytes !== stdoutBytes + stderrBytes) {
    fail('private execution result combinedOutputBytes must equal both stream counts');
  }
  if (typeof value.outputComplete !== 'boolean') {
    fail('private execution result outputComplete must be a boolean');
  }
  const resourceCause = value.resourceCause === null
    ? null
    : (() => {
        if (!PROCESS_PRIVATE_RESOURCE_CAUSES.includes(value.resourceCause)) {
          fail('private execution result resourceCause is unsupported');
        }
        return value.resourceCause;
      })();
  if ((value.terminalOutcome === 'resource_limit_exceeded') !==
      (resourceCause !== null)) {
    fail('private execution result resource cause contradicts terminalOutcome');
  }
  if (value.enforcementCause !== null &&
      (typeof value.enforcementCause !== 'string' ||
       value.enforcementCause.length === 0 ||
       value.enforcementCause.length > 128 ||
       /[\u0000-\u001f\u007f-\u009f]/.test(value.enforcementCause))) {
    fail('private execution result enforcementCause is invalid');
  }
  if (value.terminalOutcome === 'completed' && exitCode !== 0 ||
      value.terminalOutcome === 'exited_nonzero' &&
        (exitCode === null || exitCode === 0) ||
      value.terminalOutcome === 'signaled' && signal === null ||
      ['failed_to_start', 'runtime_interrupted'].includes(value.terminalOutcome) &&
        (exitCode !== null || signal !== null || value.outputComplete !== false)) {
    fail('private execution result exit or signal claim contradicts terminalOutcome');
  }
  return deepFreeze({
    operationIdentity: value.operationIdentity,
    terminalOutcome: value.terminalOutcome,
    startedAt,
    endedAt,
    durationMs,
    exitCode,
    signal,
    stdoutBytes,
    stderrBytes,
    combinedOutputBytes,
    stdoutSha256: sha256(value.stdoutSha256, 'private execution result.stdoutSha256'),
    stderrSha256: sha256(value.stderrSha256, 'private execution result.stderrSha256'),
    outputComplete: value.outputComplete,
    resourceCause,
    enforcementCause: value.enforcementCause,
    cpuThrottledEvents: nonnegativeInteger(
      value.cpuThrottledEvents,
      'private execution result.cpuThrottledEvents'
    ),
    launcherEnvironment: normalizeLauncherEnvironment(value.launcherEnvironment)
  });
}

function normalizePrivateOperationStatus(value, expectedOperationIdentity) {
  closed(value, OPERATION_STATUS_KEYS, 'private process operation status');
  const request = buildLauncherOperationRequest({
    operationIdentity: value.operationIdentity
  });
  if (expectedOperationIdentity !== undefined &&
      request.operationIdentity !== expectedOperationIdentity) {
    fail('private operation status does not match the requested operation');
  }
  if (!['active', 'terminal'].includes(value.state)) {
    fail('private operation status state must be active or terminal');
  }
  if (value.state === 'active' && value.result !== null ||
      value.state === 'terminal' && value.result === null) {
    fail('private operation status state and result contradict one another');
  }
  if (typeof value.launcherAcceptanceIdentity !== 'string' ||
      !/^process-launcher-acceptance:[0-9a-f]{64}$/.test(
        value.launcherAcceptanceIdentity
      )) {
    fail('private operation status launcher acceptance identity is invalid');
  }
  const terminalResultHash = value.terminalResultHash === null
    ? null
    : sha256(value.terminalResultHash, 'private operation status.terminalResultHash');
  if (typeof value.outputAvailable !== 'boolean' ||
      value.state === 'active' &&
        (terminalResultHash !== null || value.outputAvailable) ||
      value.state === 'terminal' && terminalResultHash === null) {
    fail('private operation status terminal/output authority is contradictory');
  }
  const result = value.result === null
    ? null
    : normalizePrivateExecutionResult(value.result, request.operationIdentity);
  if (result !== null &&
      hashProcessContractValue(result) !== terminalResultHash) {
    fail('private operation status terminal-result hash is invalid');
  }
  if (value.outputAvailable && result && result.outputComplete !== true) {
    fail('incomplete launcher output cannot be advertised as available');
  }
  return deepFreeze({
    operationIdentity: request.operationIdentity,
    state: value.state,
    launcherAcceptanceIdentity: value.launcherAcceptanceIdentity,
    terminalResultHash,
    outputAvailable: value.outputAvailable,
    result
  });
}

function normalizeLauncherOutputChunk(value, request) {
  const expected = buildLauncherReadOutputRequest(request);
  closed(value, OUTPUT_CHUNK_KEYS, 'launcher output chunk');
  if (value.operationIdentity !== expected.operationIdentity ||
      value.stream !== expected.stream ||
      value.offset !== expected.offset ||
      value.totalBytes !== expected.expectedTotalBytes ||
      value.sha256 !== expected.expectedSha256 ||
      typeof value.end !== 'boolean' ||
      typeof value.dataBase64 !== 'string' ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
        value.dataBase64
      )) {
    fail('launcher output chunk identity or encoding is invalid',
      'PROCESS_OUTPUT_CHUNK_INVALID');
  }
  const bytes = Buffer.from(value.dataBase64, 'base64');
  if (bytes.toString('base64') !== value.dataBase64 ||
      bytes.length > expected.maximumBytes ||
      value.offset + bytes.length > value.totalBytes ||
      value.end !== (value.offset + bytes.length === value.totalBytes) ||
      !value.end && bytes.length === 0) {
    fail('launcher output chunk bounds are invalid', 'PROCESS_OUTPUT_CHUNK_INVALID');
  }
  return deepFreeze({
    operationIdentity: value.operationIdentity,
    stream: value.stream,
    offset: value.offset,
    totalBytes: value.totalBytes,
    sha256: value.sha256,
    bytes,
    end: value.end
  });
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  // Buffer/typed-array elements cannot be individually frozen on current Node.
  // The returned chunk owns a freshly decoded bounded Buffer, so callers cannot
  // mutate protocol input by alias; the surrounding authority object is frozen.
  if (ArrayBuffer.isView(value)) return value;
  for (const item of Object.values(value)) deepFreeze(item);
  return Object.freeze(value);
}

function canonicalJson(value) {
  return JSON.stringify(canonicalizeProcessContractValue(value));
}

module.exports = {
  EXECUTABLE_AUTHORITY_KEYS,
  EXECUTION_RESULT_KEYS,
  FOUNDATION_HEALTH_KEYS,
  HOST_PREREQUISITE_KEYS,
  PROCESS_LAUNCHER_FOUNDATION_DEFAULT_SOCKET_PATH,
  PROCESS_LAUNCHER_FOUNDATION_DEFAULT_TIMEOUT_MS,
  PROCESS_LAUNCHER_FOUNDATION_FAILURE_CODES,
  PROCESS_LAUNCHER_FOUNDATION_MAX_MESSAGE_BYTES,
  PROCESS_LAUNCHER_FOUNDATION_MAX_TIMEOUT_MS,
  PROCESS_LAUNCHER_FOUNDATION_PROTOCOL_VERSION,
  PROCESS_ROOTFS_MANIFEST_SCHEMA_VERSION,
  PROCESS_SANDBOX_PREREQUISITE_KEYS: SANDBOX_PREREQUISITE_KEYS,
  PROCESS_SANDBOX_PREREQUISITE_MAX_VALIDITY_MS,
  PROCESS_SANDBOX_PREREQUISITE_STATUS,
  PROCESS_SANDBOX_PREREQUISITE_VERSION,
  ProcessLauncherFoundationError,
  PROCESS_PRIVATE_RESOURCE_CAUSES,
  PROCESS_PRIVATE_TERMINAL_OUTCOMES,
  ROOTFS_AUTHORITY_KEYS,
  buildGetRootfsRequest,
  buildLauncherLaunchRequest,
  buildLauncherCompactionRequest,
  buildLauncherOperationRequest,
  buildLauncherOutputAcknowledgementRequest,
  buildLauncherReadOutputRequest,
  buildProcessSandboxPrerequisiteDescriptor,
  buildVerifyExecutableRequest,
  canonicalJson,
  normalizeExecutableAuthority,
  normalizeContainmentHealth,
  normalizeFoundationHealth,
  normalizeProcessLauncherFoundationClientConfig,
  normalizeProcessSandboxPrerequisiteDescriptor,
  normalizePrivateExecutionResult,
  normalizePrivateOperationStatus,
  normalizeLauncherOutputChunk,
  normalizeLauncherRegistryMetrics,
  normalizeRootfsAuthority
};

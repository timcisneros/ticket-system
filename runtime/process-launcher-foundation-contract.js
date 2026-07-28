'use strict';

const path = require('path');

const {
  PROCESS_SHA256_PATTERN,
  validateProcessIdentifier
} = require('./process-authority-constants');
const {
  canonicalizeProcessContractValue,
  hashProcessContractValue
} = require('./process-execution-contract');
const {
  normalizeMaterializerGeneration
} = require('./process-materializer-contract');

const PROCESS_LAUNCHER_FOUNDATION_PROTOCOL_VERSION = 1;
const PROCESS_ROOTFS_MANIFEST_SCHEMA_VERSION = 1;
const PROCESS_LAUNCHER_FOUNDATION_MAX_MESSAGE_BYTES = 2_097_152;
const PROCESS_LAUNCHER_FOUNDATION_DEFAULT_TIMEOUT_MS = 30_000;
const PROCESS_LAUNCHER_FOUNDATION_MAX_TIMEOUT_MS = 300_000;
const PROCESS_LAUNCHER_FOUNDATION_DEFAULT_SOCKET_PATH =
  '/run/ticket-system-process/launcher.sock';
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
  'PROCESS_SANDBOX_PREREQUISITES_EXPIRED'
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

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const item of Object.values(value)) deepFreeze(item);
  return Object.freeze(value);
}

function canonicalJson(value) {
  return JSON.stringify(canonicalizeProcessContractValue(value));
}

module.exports = {
  EXECUTABLE_AUTHORITY_KEYS,
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
  ROOTFS_AUTHORITY_KEYS,
  buildGetRootfsRequest,
  buildProcessSandboxPrerequisiteDescriptor,
  buildVerifyExecutableRequest,
  canonicalJson,
  normalizeExecutableAuthority,
  normalizeFoundationHealth,
  normalizeProcessLauncherFoundationClientConfig,
  normalizeProcessSandboxPrerequisiteDescriptor,
  normalizeRootfsAuthority
};

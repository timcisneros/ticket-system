'use strict';

const crypto = require('crypto');
const path = require('path');

const {
  PROCESS_FILESYSTEM_POLICY,
  PROCESS_FILESYSTEM_POLICY_HARD_LIMITS,
  PROCESS_SHA256_PATTERN,
  validateProcessIdentifier
} = require('./process-authority-constants');
const {
  buildProcessOperationIdentity,
  canonicalizeProcessContractValue
} = require('./process-execution-contract');

const PROCESS_MATERIALIZER_PROTOCOL_VERSION = 1;
const PROCESS_MATERIALIZER_MANIFEST_SCHEMA_VERSION = 1;
const PROCESS_MATERIALIZER_REGISTRY_SCHEMA_VERSION = 1;
const PROCESS_MATERIALIZER_MAX_MESSAGE_BYTES = 2_097_152;
const PROCESS_MATERIALIZER_DEFAULT_TIMEOUT_MS = 120_000;
const PROCESS_MATERIALIZER_MAX_TIMEOUT_MS = 300_000;
const PROCESS_MATERIALIZER_SOCKET_DIRECTORY = '/run/ticket-system-process';
const PROCESS_MATERIALIZER_DEFAULT_SOCKET_PATH =
  `${PROCESS_MATERIALIZER_SOCKET_DIRECTORY}/materializer/materializer.sock`;

const PROCESS_MATERIALIZER_FAILURE_CODES = Object.freeze([
  'PROCESS_MATERIALIZER_UNAVAILABLE',
  'PROCESS_MATERIALIZER_ALREADY_RUNNING',
  'PROCESS_MATERIALIZER_PROTOCOL_INVALID',
  'PROCESS_MATERIALIZER_CLIENT_UNAUTHORIZED',
  'PROCESS_MATERIALIZER_REQUEST_INVALID',
  'PROCESS_WORKSPACE_MUTATION_BOUNDARY_UNAVAILABLE',
  'PROCESS_WORKSPACE_ALLOCATION_UNKNOWN',
  'PROCESS_INPUT_POLICY_INVALID',
  'PROCESS_INPUT_PATH_INVALID',
  'PROCESS_INPUT_FILENAME_UNSUPPORTED',
  'PROCESS_INPUT_SYMLINK_REJECTED',
  'PROCESS_INPUT_SPECIAL_FILE_REJECTED',
  'PROCESS_INPUT_LIMIT_EXCEEDED',
  'PROCESS_INPUT_SOURCE_CHANGED',
  'PROCESS_INPUT_STORAGE_UNAVAILABLE',
  'PROCESS_INPUT_MANIFEST_INVALID',
  'PROCESS_INPUT_SNAPSHOT_SEAL_FAILED',
  'PROCESS_INPUT_SNAPSHOT_NOT_FOUND',
  'PROCESS_INPUT_SNAPSHOT_MISMATCH',
  'PROCESS_INPUT_REGISTRY_INVALID',
  'PROCESS_INPUT_GENERATION_MISMATCH',
  'PROCESS_SNAPSHOT_DESCRIPTOR_UNAVAILABLE',
  'PROCESS_SNAPSHOT_DESCRIPTOR_INVALID',
  'PROCESS_SNAPSHOT_PRINCIPAL_UNAUTHORIZED'
]);

const MATERIALIZER_GENERATION_KEYS = Object.freeze([
  'materializerGeneration',
  'materializerIdentityHash',
  'inputPolicyHash',
  'manifestSchemaVersion',
  'registrySchemaVersion'
]);
const MATERIALIZATION_REQUEST_KEYS = Object.freeze([
  'workspaceAllocationId',
  'runId',
  'ticketId',
  'operationId',
  'operationIdentity',
  'policySnapshotHash',
  'materializerGeneration',
  'filesystemPolicy'
]);
const FILESYSTEM_POLICY_KEYS = Object.freeze([
  'inputMode',
  'writableRoots',
  'allowSymlinks',
  'allowSpecialFiles',
  'maxInputFiles',
  'maxInputBytes'
]);
const WORKSPACE_SNAPSHOT_KEYS = Object.freeze([
  'id',
  'runId',
  'policySnapshotHash',
  'materializerGeneration',
  'manifestSha256',
  'fileCount',
  'totalBytes'
]);
const GET_SNAPSHOT_REQUEST_KEYS = Object.freeze([
  'snapshotId',
  'expectedRunId',
  'expectedTicketId',
  'expectedOperationId',
  'expectedOperationIdentity',
  'expectedPolicySnapshotHash',
  'expectedMaterializerGeneration',
  'expectedFilesystemPolicyHash'
]);

class ProcessMaterializerError extends Error {
  constructor(message, code = 'PROCESS_MATERIALIZER_REQUEST_INVALID', details = {}) {
    super(message);
    this.name = 'ProcessMaterializerError';
    this.code = code;
    this.failureKind = 'process_input_failed';
    this.details = details;
  }
}

function fail(message, code = 'PROCESS_MATERIALIZER_REQUEST_INVALID', details = {}) {
  throw new ProcessMaterializerError(message, code, details);
}

function plainObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype) {
    fail(`${label} must be a plain object`);
  }
}

function assertClosed(value, keys, label) {
  plainObject(value, label);
  for (const key of keys) {
    if (!Object.hasOwn(value, key)) fail(`${label}.${key} is required`);
  }
  const extra = Object.keys(value).find(key => !keys.includes(key));
  if (extra) fail(`${label} includes unsupported field: ${extra}`);
}

function identifier(value, label) {
  try {
    return validateProcessIdentifier(value, label);
  } catch (error) {
    fail(error.message);
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

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const item of Object.values(value)) deepFreeze(item);
  return Object.freeze(value);
}

function normalizeFilesystemPolicy(value) {
  assertClosed(value, FILESYSTEM_POLICY_KEYS, 'filesystemPolicy');
  if (value.inputMode !== PROCESS_FILESYSTEM_POLICY.inputMode ||
      !Array.isArray(value.writableRoots) || value.writableRoots.length !== 0 ||
      value.allowSymlinks !== PROCESS_FILESYSTEM_POLICY.allowSymlinks ||
      value.allowSpecialFiles !== PROCESS_FILESYSTEM_POLICY.allowSpecialFiles) {
    fail(
      'filesystemPolicy must use the frozen read-only execution-input authority',
      'PROCESS_INPUT_POLICY_INVALID'
    );
  }
  const maxInputFiles = positiveInteger(value.maxInputFiles, 'filesystemPolicy.maxInputFiles');
  const maxInputBytes = positiveInteger(value.maxInputBytes, 'filesystemPolicy.maxInputBytes');
  if (maxInputFiles > PROCESS_FILESYSTEM_POLICY_HARD_LIMITS.maxInputFiles ||
      maxInputBytes > PROCESS_FILESYSTEM_POLICY_HARD_LIMITS.maxInputBytes) {
    fail('filesystemPolicy exceeds the process-input hard ceilings',
      'PROCESS_INPUT_POLICY_INVALID');
  }
  return deepFreeze({
    inputMode: PROCESS_FILESYSTEM_POLICY.inputMode,
    writableRoots: [],
    allowSymlinks: false,
    allowSpecialFiles: false,
    maxInputFiles,
    maxInputBytes
  });
}

function hashProcessFilesystemPolicy(value) {
  const normalized = normalizeFilesystemPolicy(value);
  return crypto
    .createHash('sha256')
    .update(canonicalJson(normalized), 'utf8')
    .digest('hex');
}

function normalizeMaterializerGeneration(value) {
  assertClosed(value, MATERIALIZER_GENERATION_KEYS, 'materializer generation');
  const normalized = {
    materializerGeneration: identifier(
      value.materializerGeneration,
      'materializerGeneration'
    ),
    materializerIdentityHash: sha256(
      value.materializerIdentityHash,
      'materializerIdentityHash'
    ),
    inputPolicyHash: sha256(value.inputPolicyHash, 'inputPolicyHash'),
    manifestSchemaVersion: positiveInteger(
      value.manifestSchemaVersion,
      'manifestSchemaVersion'
    ),
    registrySchemaVersion: positiveInteger(
      value.registrySchemaVersion,
      'registrySchemaVersion'
    )
  };
  if (normalized.manifestSchemaVersion !== PROCESS_MATERIALIZER_MANIFEST_SCHEMA_VERSION ||
      normalized.registrySchemaVersion !== PROCESS_MATERIALIZER_REGISTRY_SCHEMA_VERSION) {
    fail(
      'materializer generation uses an unsupported manifest or registry schema',
      'PROCESS_INPUT_GENERATION_MISMATCH'
    );
  }
  return deepFreeze(normalized);
}

function buildProcessMaterializationRequest(value) {
  const inputKeys = [
    'workspaceAllocationId',
    'runId',
    'ticketId',
    'operationId',
    'policySnapshotHash',
    'materializerGeneration',
    'filesystemPolicy'
  ];
  assertClosed(value, inputKeys, 'process materialization input');
  const runId = positiveInteger(value.runId, 'runId');
  const operationId = identifier(value.operationId, 'operationId');
  return deepFreeze({
    workspaceAllocationId: identifier(
      value.workspaceAllocationId,
      'workspaceAllocationId'
    ),
    runId,
    ticketId: positiveInteger(value.ticketId, 'ticketId'),
    operationId,
    operationIdentity: buildProcessOperationIdentity(runId, operationId),
    policySnapshotHash: sha256(value.policySnapshotHash, 'policySnapshotHash'),
    materializerGeneration: identifier(
      value.materializerGeneration,
      'materializerGeneration'
    ),
    filesystemPolicy: normalizeFilesystemPolicy(value.filesystemPolicy)
  });
}

function validateProcessMaterializationRequest(value) {
  assertClosed(value, MATERIALIZATION_REQUEST_KEYS, 'materialization request');
  const expected = buildProcessMaterializationRequest({
    workspaceAllocationId: value.workspaceAllocationId,
    runId: value.runId,
    ticketId: value.ticketId,
    operationId: value.operationId,
    policySnapshotHash: value.policySnapshotHash,
    materializerGeneration: value.materializerGeneration,
    filesystemPolicy: value.filesystemPolicy
  });
  if (value.operationIdentity !== expected.operationIdentity) {
    fail('operationIdentity does not match runId and operationId');
  }
  return expected;
}

function normalizeWorkspaceSnapshotDescriptor(value, expected = {}) {
  assertClosed(value, WORKSPACE_SNAPSHOT_KEYS, 'workspaceSnapshot');
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
  for (const [key, expectedValue] of Object.entries(expected)) {
    if (expectedValue !== undefined && normalized[key] !== expectedValue) {
      fail(
        `workspaceSnapshot.${key} does not match trusted materialization authority`,
        'PROCESS_INPUT_SNAPSHOT_MISMATCH'
      );
    }
  }
  return deepFreeze(normalized);
}

function buildGetProcessSnapshotRequest(value) {
  const inputKeys = [
    'snapshotId',
    'runId',
    'ticketId',
    'operationId',
    'policySnapshotHash',
    'materializerGeneration',
    'filesystemPolicy'
  ];
  assertClosed(value, inputKeys, 'getSnapshot input');
  const runId = positiveInteger(value.runId, 'runId');
  const operationId = identifier(value.operationId, 'operationId');
  return deepFreeze({
    snapshotId: identifier(value.snapshotId, 'snapshotId'),
    expectedRunId: runId,
    expectedTicketId: positiveInteger(value.ticketId, 'ticketId'),
    expectedOperationId: operationId,
    expectedOperationIdentity: buildProcessOperationIdentity(runId, operationId),
    expectedPolicySnapshotHash: sha256(value.policySnapshotHash, 'policySnapshotHash'),
    expectedMaterializerGeneration: identifier(
      value.materializerGeneration,
      'materializerGeneration'
    ),
    expectedFilesystemPolicyHash: hashProcessFilesystemPolicy(value.filesystemPolicy)
  });
}

function validateGetProcessSnapshotRequest(value) {
  assertClosed(value, GET_SNAPSHOT_REQUEST_KEYS, 'getSnapshot request');
  const runId = positiveInteger(value.expectedRunId, 'expectedRunId');
  const operationId = identifier(value.expectedOperationId, 'expectedOperationId');
  const expected = deepFreeze({
    snapshotId: identifier(value.snapshotId, 'snapshotId'),
    expectedRunId: runId,
    expectedTicketId: positiveInteger(value.expectedTicketId, 'expectedTicketId'),
    expectedOperationId: operationId,
    expectedOperationIdentity: buildProcessOperationIdentity(runId, operationId),
    expectedPolicySnapshotHash: sha256(
      value.expectedPolicySnapshotHash,
      'expectedPolicySnapshotHash'
    ),
    expectedMaterializerGeneration: identifier(
      value.expectedMaterializerGeneration,
      'expectedMaterializerGeneration'
    ),
    expectedFilesystemPolicyHash: sha256(
      value.expectedFilesystemPolicyHash,
      'expectedFilesystemPolicyHash'
    )
  });
  if (canonicalJson(value) !== canonicalJson(expected)) {
    fail('getSnapshot request does not match its recomputed operation identity');
  }
  return expected;
}

function normalizeProcessMaterializerClientConfig(value) {
  assertClosed(value, ['version', 'socketPath', 'workspaceAllocationId', 'timeoutMs'],
    'process materializer client configuration');
  if (value.version !== 1) {
    fail('process materializer client configuration.version must be 1');
  }
  if (typeof value.socketPath !== 'string' || !path.posix.isAbsolute(value.socketPath) ||
      value.socketPath !== path.posix.normalize(value.socketPath) ||
      value.socketPath.length > 4096 ||
      /[\u0000-\u001f\u007f-\u009f]/.test(value.socketPath)) {
    fail('process materializer socketPath must be a bounded normalized absolute path');
  }
  const timeoutMs = positiveInteger(value.timeoutMs, 'timeoutMs');
  if (timeoutMs > PROCESS_MATERIALIZER_MAX_TIMEOUT_MS) {
    fail(`timeoutMs must not exceed ${PROCESS_MATERIALIZER_MAX_TIMEOUT_MS}`);
  }
  return deepFreeze({
    version: 1,
    socketPath: value.socketPath,
    workspaceAllocationId: identifier(
      value.workspaceAllocationId,
      'workspaceAllocationId'
    ),
    timeoutMs
  });
}

function canonicalJson(value) {
  return JSON.stringify(canonicalizeProcessContractValue(value));
}

module.exports = {
  GET_SNAPSHOT_REQUEST_KEYS,
  MATERIALIZATION_REQUEST_KEYS,
  MATERIALIZER_GENERATION_KEYS,
  PROCESS_MATERIALIZER_DEFAULT_SOCKET_PATH,
  PROCESS_MATERIALIZER_DEFAULT_TIMEOUT_MS,
  PROCESS_MATERIALIZER_FAILURE_CODES,
  PROCESS_MATERIALIZER_MANIFEST_SCHEMA_VERSION,
  PROCESS_MATERIALIZER_MAX_MESSAGE_BYTES,
  PROCESS_MATERIALIZER_MAX_TIMEOUT_MS,
  PROCESS_MATERIALIZER_PROTOCOL_VERSION,
  PROCESS_MATERIALIZER_REGISTRY_SCHEMA_VERSION,
  PROCESS_MATERIALIZER_SOCKET_DIRECTORY,
  ProcessMaterializerError,
  WORKSPACE_SNAPSHOT_KEYS,
  buildGetProcessSnapshotRequest,
  buildProcessMaterializationRequest,
  hashProcessFilesystemPolicy,
  normalizeMaterializerGeneration,
  normalizeProcessMaterializerClientConfig,
  normalizeWorkspaceSnapshotDescriptor,
  validateGetProcessSnapshotRequest,
  validateProcessMaterializationRequest
};

'use strict';

const crypto = require('crypto');

const RUNTIME_BUDGET_SNAPSHOT_VERSION = 1;
const RUNTIME_BUDGET_DIMENSIONS = Object.freeze([
  'execution_step',
  'model_request',
  'workspace_operation',
  'process_operation',
  'browser_operation',
  'output_artifact_bytes'
]);
const RUNTIME_CAPACITY_DOMAINS = Object.freeze([
  'global_run',
  'model_provider',
  'target',
  'process_launcher'
]);
const RUNTIME_BUDGET_FAILURE_CODES = Object.freeze([
  'RUN_BUDGET_SNAPSHOT_INVALID',
  'RUN_BUDGET_EXHAUSTED',
  'RUN_BUDGET_RESERVATION_CONFLICT',
  'RUN_BUDGET_RECONCILIATION_FAILED',
  'RUN_RUNTIME_DURATION_EXCEEDED',
  'RUN_FEASIBILITY_REJECTED',
  'RUNTIME_CAPACITY_UNAVAILABLE',
  'RUNTIME_CAPACITY_LEASE_CONFLICT',
  'RUNTIME_CAPACITY_RECONCILIATION_FAILED',
  'TARGET_CAPACITY_UNAVAILABLE',
  'PROCESS_LAUNCHER_CAPACITY_UNAVAILABLE'
]);
const RUNTIME_BUDGET_SNAPSHOT_KEYS = Object.freeze([
  'version',
  'maxAttempts',
  'maxExecutionSteps',
  'maxModelRequests',
  'maxWorkspaceOperations',
  'maxProcessOperations',
  'maxBrowserOperations',
  'maxRuntimeDurationMs',
  'maxOutputArtifactBytes',
  'allowParallelRuns',
  'runtimeLimitsRevision',
  'executionPolicyHash',
  'snapshotHash'
]);
const DIMENSION_LIMIT_FIELDS = Object.freeze({
  execution_step: 'maxExecutionSteps',
  model_request: 'maxModelRequests',
  workspace_operation: 'maxWorkspaceOperations',
  process_operation: 'maxProcessOperations',
  browser_operation: 'maxBrowserOperations',
  output_artifact_bytes: 'maxOutputArtifactBytes'
});

class RuntimeBudgetError extends Error {
  constructor(message, code = 'RUN_BUDGET_SNAPSHOT_INVALID', details = {}) {
    super(message);
    this.name = 'RuntimeBudgetError';
    this.code = code;
    this.failureKind = code === 'RUN_RUNTIME_DURATION_EXCEEDED'
      ? 'runtime_duration_exhausted'
      : code === 'RUN_FEASIBILITY_REJECTED'
        ? 'deterministic_infeasibility'
        : code.startsWith('RUNTIME_CAPACITY') || code === 'TARGET_CAPACITY_UNAVAILABLE' ||
            code === 'PROCESS_LAUNCHER_CAPACITY_UNAVAILABLE'
          ? 'capacity_backpressure'
          : 'runtime_budget_exhausted';
    this.details = details;
  }
}

function fail(message, code = 'RUN_BUDGET_SNAPSHOT_INVALID', details = {}) {
  throw new RuntimeBudgetError(message, code, details);
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype;
}

function assertClosed(value, keys, label) {
  if (!isPlainObject(value)) fail(`${label} must be a plain object`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length ||
      actual.some((key, index) => key !== expected[index])) {
    fail(`${label} must contain exactly: ${keys.join(', ')}`);
  }
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.keys(value).sort().map(key => [key, canonicalize(value[key])])
    );
  }
  return value;
}

function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function hashRuntimeBudgetValue(value) {
  return sha256(canonicalJson(value));
}

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) fail(`${label} must be a positive safe integer`);
  return value;
}

function boolean(value, label) {
  if (value !== true && value !== false) fail(`${label} must be a boolean`);
  return value;
}

function normalizeRuntimeBudgetSnapshot(value) {
  assertClosed(value, RUNTIME_BUDGET_SNAPSHOT_KEYS, 'runtimeBudgetSnapshot');
  if (value.version !== RUNTIME_BUDGET_SNAPSHOT_VERSION) {
    fail(`Unsupported runtimeBudgetSnapshot version: ${value.version}`);
  }
  const normalized = {
    version: RUNTIME_BUDGET_SNAPSHOT_VERSION,
    maxAttempts: positiveInteger(value.maxAttempts, 'runtimeBudgetSnapshot.maxAttempts'),
    maxExecutionSteps: positiveInteger(
      value.maxExecutionSteps,
      'runtimeBudgetSnapshot.maxExecutionSteps'
    ),
    maxModelRequests: positiveInteger(
      value.maxModelRequests,
      'runtimeBudgetSnapshot.maxModelRequests'
    ),
    maxWorkspaceOperations: positiveInteger(
      value.maxWorkspaceOperations,
      'runtimeBudgetSnapshot.maxWorkspaceOperations'
    ),
    maxProcessOperations: positiveInteger(
      value.maxProcessOperations,
      'runtimeBudgetSnapshot.maxProcessOperations'
    ),
    maxBrowserOperations: positiveInteger(
      value.maxBrowserOperations,
      'runtimeBudgetSnapshot.maxBrowserOperations'
    ),
    maxRuntimeDurationMs: positiveInteger(
      value.maxRuntimeDurationMs,
      'runtimeBudgetSnapshot.maxRuntimeDurationMs'
    ),
    maxOutputArtifactBytes: positiveInteger(
      value.maxOutputArtifactBytes,
      'runtimeBudgetSnapshot.maxOutputArtifactBytes'
    ),
    allowParallelRuns: boolean(
      value.allowParallelRuns,
      'runtimeBudgetSnapshot.allowParallelRuns'
    ),
    runtimeLimitsRevision: positiveInteger(
      value.runtimeLimitsRevision,
      'runtimeBudgetSnapshot.runtimeLimitsRevision'
    ),
    executionPolicyHash: typeof value.executionPolicyHash === 'string' &&
      /^[0-9a-f]{64}$/.test(value.executionPolicyHash)
      ? value.executionPolicyHash
      : fail('runtimeBudgetSnapshot.executionPolicyHash must be a lowercase SHA-256'),
    snapshotHash: value.snapshotHash
  };
  if (typeof normalized.snapshotHash !== 'string' ||
      !/^[0-9a-f]{64}$/.test(normalized.snapshotHash)) {
    fail('runtimeBudgetSnapshot.snapshotHash must be a lowercase SHA-256');
  }
  const authority = { ...normalized };
  delete authority.snapshotHash;
  if (hashRuntimeBudgetValue(authority) !== normalized.snapshotHash) {
    fail('runtimeBudgetSnapshot.snapshotHash does not match its authority');
  }
  return deepFreeze(normalized);
}

function buildRuntimeBudgetSnapshot({ runtimeLimits, executionPolicy }) {
  if (!isPlainObject(runtimeLimits)) fail('runtimeLimits must be a plain object');
  if (!isPlainObject(executionPolicy)) fail('executionPolicy must be a plain object');
  const resolved = (policyField, runtimeField) => {
    const override = executionPolicy[policyField];
    return positiveInteger(
      override === null || override === undefined ? runtimeLimits[runtimeField] : override,
      `runtimeBudgetSnapshot.${policyField}`
    );
  };
  const authority = {
    version: RUNTIME_BUDGET_SNAPSHOT_VERSION,
    maxAttempts: resolved('maxAttempts', 'maxAttempts'),
    maxExecutionSteps: resolved('maxExecutionSteps', 'maxExecutionSteps'),
    maxModelRequests: resolved('maxModelRequests', 'maxModelRequestsPerRun'),
    maxWorkspaceOperations: resolved(
      'maxWorkspaceOperations',
      'maxWorkspaceOperationsPerRun'
    ),
    maxProcessOperations: resolved(
      'maxProcessOperations',
      'maxProcessOperationsPerRun'
    ),
    maxBrowserOperations: resolved(
      'maxBrowserOperations',
      'maxBrowserOperationsPerRun'
    ),
    maxRuntimeDurationMs: resolved('maxRuntimeMs', 'maxRuntimeDurationMs'),
    maxOutputArtifactBytes: resolved(
      'maxOutputArtifactBytes',
      'maxOutputArtifactBytesPerRun'
    ),
    allowParallelRuns: boolean(
      executionPolicy.allowParallelRuns,
      'executionPolicy.allowParallelRuns'
    ),
    runtimeLimitsRevision: positiveInteger(
      runtimeLimits.revision,
      'runtimeLimits.revision'
    ),
    executionPolicyHash: hashRuntimeBudgetValue(executionPolicy)
  };
  return normalizeRuntimeBudgetSnapshot({
    ...authority,
    snapshotHash: hashRuntimeBudgetValue(authority)
  });
}

function budgetLimitForDimension(snapshot, dimension) {
  const normalized = normalizeRuntimeBudgetSnapshot(snapshot);
  const field = DIMENSION_LIMIT_FIELDS[dimension];
  if (!field) fail(`Unsupported runtime budget dimension: ${dimension}`);
  return normalized[field];
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    Object.values(value).forEach(deepFreeze);
  }
  return value;
}

function getRunRuntimeBudgetSnapshot(run) {
  if (!run || !Object.prototype.hasOwnProperty.call(run, 'runtimeBudgetSnapshot')) return null;
  if (run.runtimeBudgetSnapshot === null || run.runtimeBudgetSnapshot === undefined) {
    return null;
  }
  return normalizeRuntimeBudgetSnapshot(run.runtimeBudgetSnapshot);
}

module.exports = {
  DIMENSION_LIMIT_FIELDS,
  RUNTIME_BUDGET_DIMENSIONS,
  RUNTIME_BUDGET_FAILURE_CODES,
  RUNTIME_BUDGET_SNAPSHOT_KEYS,
  RUNTIME_BUDGET_SNAPSHOT_VERSION,
  RUNTIME_CAPACITY_DOMAINS,
  RuntimeBudgetError,
  budgetLimitForDimension,
  buildRuntimeBudgetSnapshot,
  canonicalJson,
  getRunRuntimeBudgetSnapshot,
  hashRuntimeBudgetValue,
  normalizeRuntimeBudgetSnapshot
};

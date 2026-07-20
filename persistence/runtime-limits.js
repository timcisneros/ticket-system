'use strict';

const RUNTIME_LIMIT_CONFIG_KEYS = Object.freeze([
  'maxExecutionSteps',
  'maxModelRequestsPerRun',
  'maxWorkspaceOperationsPerRun',
  'maxRuntimeDurationMs'
]);

const RUNTIME_SYSTEM_CONFIG_KEYS = Object.freeze([
  'maxActiveRuns',
  'localModelConcurrency'
]);

const ALL_RUNTIME_CONFIG_KEYS = Object.freeze([
  ...RUNTIME_LIMIT_CONFIG_KEYS,
  ...RUNTIME_SYSTEM_CONFIG_KEYS
]);

const RUNTIME_CONFIG_MINIMUMS = Object.freeze({
  maxExecutionSteps: 1,
  maxModelRequestsPerRun: 1,
  maxWorkspaceOperationsPerRun: 1,
  maxRuntimeDurationMs: 5000,
  maxActiveRuns: 1,
  localModelConcurrency: 1
});

const REQUIRED_RUNTIME_LIMITS_REPOSITORY_METHODS = Object.freeze([
  'getRuntimeLimitsConfig',
  'updateRuntimeLimitsConfig'
]);

class RuntimeLimitsConflictError extends Error {
  constructor(expectedRevision, current = null) {
    super(`runtime limits did not match expected revision ${expectedRevision}`);
    this.name = 'RuntimeLimitsConflictError';
    this.code = 'OPTIMISTIC_CONCURRENCY_CONFLICT';
    this.entity = 'runtime limits';
    this.entityId = 1;
    this.expectedRevision = expectedRevision;
    this.current = current;
  }
}

function requiredFunction(value, label) {
  if (typeof value !== 'function') throw new TypeError(`${label} must be a function`);
  return value;
}

function requiredString(value, label) {
  const normalized = String(value === undefined || value === null ? '' : value).trim();
  if (!normalized) throw new TypeError(`${label} is required`);
  return normalized;
}

function positiveSafeInteger(value, label) {
  const number = typeof value === 'string' && /^[1-9]\d*$/.test(value) ? Number(value) : value;
  if (!Number.isSafeInteger(number) || number <= 0) {
    throw new TypeError(`${label} must be a positive safe integer`);
  }
  return number;
}

function timestamp(value, label) {
  const parsed = value instanceof Date ? value : new Date(requiredString(value, label));
  if (Number.isNaN(parsed.getTime())) throw new TypeError(`${label} must be a valid timestamp`);
  return parsed.toISOString();
}

function jsonObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value;
}

function requireCurrentFields(source, fields, label) {
  for (const field of fields) {
    if (!Object.prototype.hasOwnProperty.call(source, field)) {
      throw new TypeError(`${label} is missing current-format field: ${field}`);
    }
  }
}

function normalizeRuntimeLimitsValues(value, label = 'runtime limits value', allowedExtraKeys = []) {
  const source = jsonObject(value, label);
  const allowedKeys = new Set([...ALL_RUNTIME_CONFIG_KEYS, ...allowedExtraKeys]);
  for (const key of Object.keys(source)) {
    if (!allowedKeys.has(key)) throw new TypeError(`Unsupported ${label} field: ${key}`);
  }
  const normalized = {};
  for (const key of ALL_RUNTIME_CONFIG_KEYS) {
    const candidate = source[key];
    if (candidate === null) {
      normalized[key] = null;
      continue;
    }
    const number = positiveSafeInteger(candidate, `${label}.${key}`);
    if (number < RUNTIME_CONFIG_MINIMUMS[key]) {
      throw new RangeError(`${label}.${key} must be at least ${RUNTIME_CONFIG_MINIMUMS[key]}`);
    }
    normalized[key] = number;
  }
  return normalized;
}

function normalizeRuntimeLimitsConfig(record) {
  const source = jsonObject(record, 'runtime limits config');
  requireCurrentFields(source, [
    ...ALL_RUNTIME_CONFIG_KEYS,
    'revision',
    'updatedBy',
    'updatedAt'
  ], 'runtime limits config');
  const updatedBy = source.updatedBy === null ? null : requiredString(source.updatedBy, 'runtime limits config.updatedBy');
  const updatedAt = source.updatedAt === null ? null : timestamp(source.updatedAt, 'runtime limits config.updatedAt');
  if ((updatedBy === null) !== (updatedAt === null)) {
    throw new TypeError('runtime limits config updatedBy and updatedAt must both be null or both be set');
  }
  return {
    ...normalizeRuntimeLimitsValues(source, 'runtime limits config', ['revision', 'updatedBy', 'updatedAt']),
    revision: positiveSafeInteger(source.revision, 'runtime limits config.revision'),
    updatedBy,
    updatedAt
  };
}

function assertRuntimeLimitsRepository(repository) {
  if (!repository || typeof repository !== 'object') {
    throw new TypeError('runtime limits repository is required');
  }
  for (const method of REQUIRED_RUNTIME_LIMITS_REPOSITORY_METHODS) {
    if (typeof repository[method] !== 'function') {
      throw new TypeError(`runtime limits repository must implement ${method}()`);
    }
  }
  return repository;
}

module.exports = {
  ALL_RUNTIME_CONFIG_KEYS,
  REQUIRED_RUNTIME_LIMITS_REPOSITORY_METHODS,
  RUNTIME_CONFIG_MINIMUMS,
  RUNTIME_LIMIT_CONFIG_KEYS,
  RUNTIME_SYSTEM_CONFIG_KEYS,
  RuntimeLimitsConflictError,
  assertRuntimeLimitsRepository,
  normalizeRuntimeLimitsConfig,
  normalizeRuntimeLimitsValues,
  positiveSafeInteger,
  requiredFunction,
  requiredString,
  timestamp
};

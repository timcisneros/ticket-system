'use strict';

const REQUIRED_MODEL_ROUTING_POLICY_REPOSITORY_METHODS = Object.freeze([
  'listModelRoutingPolicies',
  'getModelRoutingPolicyById',
  'getModelRoutingPolicyCounts',
  'findApplicableModelRoutingPolicy',
  'createModelRoutingPolicy',
  'updateModelRoutingPolicy'
]);

class ModelRoutingPolicyConflictError extends Error {
  constructor(id, expectedRevision, current = null) {
    super(`model routing policy ${id} did not match expected revision ${expectedRevision}`);
    this.name = 'ModelRoutingPolicyConflictError';
    this.code = 'OPTIMISTIC_CONCURRENCY_CONFLICT';
    this.entity = 'modelRoutingPolicy';
    this.entityId = id;
    this.expectedRevision = expectedRevision;
    this.current = current;
  }
}

class ModelRoutingPolicyIdConflictError extends Error {
  constructor(id) {
    super(`Model routing policy id already exists: ${id}`);
    this.name = 'ModelRoutingPolicyIdConflictError';
    this.code = 'MODEL_ROUTING_POLICY_ID_CONFLICT';
    this.policyId = id;
  }
}

class ModelRoutingPolicyReferenceError extends Error {
  constructor(message, code = 'MODEL_ROUTING_POLICY_REFERENCE_INVALID') {
    super(message);
    this.name = 'ModelRoutingPolicyReferenceError';
    this.code = code;
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
  if (!Number.isSafeInteger(number) || number <= 0) throw new TypeError(`${label} must be a positive safe integer`);
  return number;
}

function nonNegativeSafeInteger(value, label) {
  const number = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  if (!Number.isSafeInteger(number) || number < 0) throw new TypeError(`${label} must be a non-negative safe integer`);
  return number;
}

function nullablePositiveSafeInteger(value, label) {
  return value === undefined || value === null || value === '' ? null : positiveSafeInteger(value, label);
}

function nullableString(value) {
  if (value === undefined || value === null || value === '') return null;
  return String(value).trim() || null;
}

function jsonObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${label} must be an object`);
  return value;
}

function timestamp(value, label) {
  const parsed = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new TypeError(`${label} must be a valid timestamp`);
  return parsed.toISOString();
}

function normalizeStatuses(value) {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value) || value.length === 0) throw new TypeError('statuses must be a non-empty array');
  const statuses = [...new Set(value.map((item, index) => requiredString(item, `statuses[${index}]`)))];
  for (const status of statuses) {
    if (!['active', 'archived'].includes(status)) throw new TypeError(`Unsupported model routing policy status: ${status}`);
  }
  return statuses;
}

function arrayField(source, key) {
  if (!Array.isArray(source[key])) throw new TypeError(`value.${key} must be an array`);
  return structuredClone(source[key]);
}

function normalizeModelRoutingPolicyValue(value) {
  const source = structuredClone(jsonObject(value, 'value'));
  const status = requiredString(source.status || 'active', 'value.status');
  if (!['active', 'archived'].includes(status)) throw new TypeError(`Unsupported model routing policy status: ${status}`);
  const normalized = {
    ...source,
    name: requiredString(source.name, 'value.name'),
    status,
    workContextId: nullablePositiveSafeInteger(source.workContextId, 'value.workContextId'),
    capabilityId: nullableString(source.capabilityId),
    allowedProviders: arrayField(source, 'allowedProviders'),
    preferredProvider: nullableString(source.preferredProvider),
    preferredModel: nullableString(source.preferredModel),
    fallbackProviders: arrayField(source, 'fallbackProviders'),
    maxCost: source.maxCost === undefined ? null : structuredClone(source.maxCost),
    maxLatency: source.maxLatency === undefined ? null : structuredClone(source.maxLatency),
    riskClass: nullableString(source.riskClass) || 'standard',
    toolRequirements: arrayField(source, 'toolRequirements'),
    targetRequirements: arrayField(source, 'targetRequirements'),
    verificationRequirement: source.verificationRequirement === undefined
      ? null
      : structuredClone(source.verificationRequirement),
    triageOnNoRoute: source.triageOnNoRoute !== false
  };
  for (const key of ['id', 'revision', 'createdBy', 'createdAt', 'updatedBy', 'updatedAt']) delete normalized[key];
  return normalized;
}

function normalizeModelRoutingPolicyRecord(record) {
  const source = structuredClone(jsonObject(record, 'model routing policy'));
  const currentFields = [
    'id', 'name', 'status', 'workContextId', 'capabilityId', 'allowedProviders',
    'preferredProvider', 'preferredModel', 'fallbackProviders', 'maxCost', 'maxLatency',
    'riskClass', 'toolRequirements', 'targetRequirements', 'verificationRequirement',
    'triageOnNoRoute', 'revision', 'createdBy', 'createdAt', 'updatedBy', 'updatedAt'
  ];
  for (const field of currentFields) {
    if (!Object.prototype.hasOwnProperty.call(source, field)) {
      throw new TypeError(`model routing policy is missing current-format field: ${field}`);
    }
  }
  const value = normalizeModelRoutingPolicyValue(source);
  return {
    id: positiveSafeInteger(source.id, 'modelRoutingPolicy.id'),
    ...value,
    revision: positiveSafeInteger(source.revision, 'modelRoutingPolicy.revision'),
    createdBy: requiredString(source.createdBy, 'modelRoutingPolicy.createdBy'),
    createdAt: timestamp(requiredString(source.createdAt, 'modelRoutingPolicy.createdAt'), 'modelRoutingPolicy.createdAt'),
    updatedBy: requiredString(source.updatedBy, 'modelRoutingPolicy.updatedBy'),
    updatedAt: timestamp(requiredString(source.updatedAt, 'modelRoutingPolicy.updatedAt'), 'modelRoutingPolicy.updatedAt')
  };
}

function assertModelRoutingPolicyRepository(repository) {
  if (!repository || typeof repository !== 'object') throw new TypeError('model routing policy repository is required');
  for (const method of REQUIRED_MODEL_ROUTING_POLICY_REPOSITORY_METHODS) {
    if (typeof repository[method] !== 'function') {
      throw new TypeError(`model routing policy repository must implement ${method}()`);
    }
  }
  return repository;
}

module.exports = {
  REQUIRED_MODEL_ROUTING_POLICY_REPOSITORY_METHODS,
  ModelRoutingPolicyConflictError,
  ModelRoutingPolicyIdConflictError,
  ModelRoutingPolicyReferenceError,
  assertModelRoutingPolicyRepository,
  jsonObject,
  nonNegativeSafeInteger,
  normalizeModelRoutingPolicyRecord,
  normalizeModelRoutingPolicyValue,
  normalizeStatuses,
  nullablePositiveSafeInteger,
  nullableString,
  positiveSafeInteger,
  requiredFunction,
  requiredString,
  timestamp
};

'use strict';

const REQUIRED_WORKFLOW_CATALOG_REPOSITORY_METHODS = Object.freeze([
  'listWorkflows',
  'getWorkflowById',
  'getWorkflowsByIds',
  'createWorkflow',
  'createWorkflowWithEvidence',
  'updateWorkflow',
  'ensureDefaultWorkflows'
]);

class WorkflowCatalogConflictError extends Error {
  constructor(id, expectedRevision, current = null) {
    super(`workflow ${id} did not match expected revision ${expectedRevision}`);
    this.name = 'WorkflowCatalogConflictError';
    this.code = 'OPTIMISTIC_CONCURRENCY_CONFLICT';
    this.entity = 'workflow';
    this.entityId = id;
    this.expectedRevision = expectedRevision;
    this.current = current;
  }
}

class WorkflowCatalogIdConflictError extends Error {
  constructor(id) {
    super(`Workflow id already exists: ${id}`);
    this.name = 'WorkflowCatalogIdConflictError';
    this.code = 'WORKFLOW_ID_CONFLICT';
    this.workflowId = id;
  }
}

class WorkflowCatalogReferenceError extends Error {
  constructor(message, code = 'WORKFLOW_NOT_AVAILABLE') {
    super(message);
    this.name = 'WorkflowCatalogReferenceError';
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

function jsonObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${label} must be an object`);
  return value;
}

function timestamp(value, label) {
  const parsed = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new TypeError(`${label} must be a valid timestamp`);
  return parsed.toISOString();
}

function compareWorkflowIds(left, right) {
  return Buffer.compare(Buffer.from(String(left), 'utf8'), Buffer.from(String(right), 'utf8'));
}

function normalizeWorkflowPolicy(policy) {
  if (!policy || typeof policy !== 'object' || Array.isArray(policy)) return null;
  const id = typeof policy.id === 'string' ? policy.id.trim() : '';
  const version = typeof policy.version === 'string' ? policy.version.trim() : '';
  const text = typeof policy.text === 'string' ? policy.text : '';
  return id || version || text ? { id, version, text } : null;
}

function normalizeWorkflowVerifierContract(contract) {
  if (!contract || typeof contract !== 'object' || Array.isArray(contract)) return null;
  const id = typeof contract.id === 'string' ? contract.id.trim() : '';
  const version = typeof contract.version === 'string' ? contract.version.trim() : '';
  const fixture = typeof contract.fixture === 'string' ? contract.fixture.trim() : '';
  const expectedArtifacts = Array.isArray(contract.expectedArtifacts)
    ? contract.expectedArtifacts.map(item => String(item || '').trim()).filter(Boolean)
    : [];
  return id || version || fixture || expectedArtifacts.length > 0
    ? { id, version, fixture, expectedArtifacts }
    : null;
}

function normalizeWorkflowValue(value) {
  const source = structuredClone(jsonObject(value, 'value'));
  const id = requiredString(source.id, 'value.id');
  const name = requiredString(source.name, 'value.name');
  const policy = normalizeWorkflowPolicy(source.policy);
  const verifierContract = normalizeWorkflowVerifierContract(source.verifierContract);
  const postconditions = Array.isArray(source.postconditions)
    ? source.postconditions.map((item, index) => {
        const record = structuredClone(jsonObject(item, `value.postconditions[${index}]`));
        return {
          ...record,
          id: typeof record.id === 'string' && record.id.trim() ? record.id.trim() : `postcondition-${index + 1}`,
          type: typeof record.type === 'string' ? record.type.trim() : ''
        };
      })
    : [];
  const normalized = {
    ...source,
    id,
    name,
    description: typeof source.description === 'string' ? source.description : '',
    version: typeof source.version === 'string' && source.version.trim() ? source.version.trim() : '1',
    taskPromptTemplate: typeof source.taskPromptTemplate === 'string' ? source.taskPromptTemplate : '',
    enabled: source.enabled !== false,
    inputSchema: source.inputSchema && typeof source.inputSchema === 'object' && !Array.isArray(source.inputSchema)
      ? source.inputSchema
      : {},
    actions: Array.isArray(source.actions) ? source.actions : [],
    postconditions
  };
  if (policy) normalized.policy = policy;
  else delete normalized.policy;
  if (verifierContract) normalized.verifierContract = verifierContract;
  else delete normalized.verifierContract;
  for (const key of ['revision', 'createdBy', 'updatedBy']) delete normalized[key];
  return normalized;
}

function normalizeWorkflowRecord(record) {
  const source = structuredClone(jsonObject(record, 'workflow'));
  const definition = normalizeWorkflowValue(source);
  const createdAt = source.createdAt === undefined ? null : timestamp(source.createdAt, 'workflow.createdAt');
  const updatedAt = source.updatedAt === undefined ? createdAt : timestamp(source.updatedAt, 'workflow.updatedAt');
  return {
    ...definition,
    revision: Number.isSafeInteger(source.revision) && source.revision > 0 ? source.revision : 1,
    createdBy: typeof source.createdBy === 'string' && source.createdBy.trim() ? source.createdBy.trim() : 'system',
    createdAt,
    updatedBy: typeof source.updatedBy === 'string' && source.updatedBy.trim()
      ? source.updatedBy.trim()
      : (typeof source.createdBy === 'string' && source.createdBy.trim() ? source.createdBy.trim() : 'system'),
    updatedAt
  };
}

function normalizeWorkflowIds(value, maximum) {
  if (!Array.isArray(value) || value.length === 0) throw new TypeError('workflowIds must be a non-empty array');
  const ids = [...new Set(value.map((item, index) => requiredString(item, `workflowIds[${index}]`)))];
  if (ids.length > maximum) throw new RangeError(`workflowIds exceeds the configured maximum of ${maximum}`);
  return ids.sort(compareWorkflowIds);
}

function assertWorkflowCatalogRepository(repository) {
  if (!repository || typeof repository !== 'object') throw new TypeError('workflow catalog repository is required');
  for (const method of REQUIRED_WORKFLOW_CATALOG_REPOSITORY_METHODS) {
    if (typeof repository[method] !== 'function') throw new TypeError(`workflow catalog repository must implement ${method}()`);
  }
  return repository;
}

module.exports = {
  REQUIRED_WORKFLOW_CATALOG_REPOSITORY_METHODS,
  WorkflowCatalogConflictError,
  WorkflowCatalogIdConflictError,
  WorkflowCatalogReferenceError,
  assertWorkflowCatalogRepository,
  compareWorkflowIds,
  jsonObject,
  normalizeWorkflowIds,
  normalizeWorkflowRecord,
  normalizeWorkflowValue,
  positiveSafeInteger,
  requiredFunction,
  requiredString,
  timestamp
};

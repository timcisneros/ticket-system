'use strict';

const REQUIRED_CONNECTOR_AUTHORITY_REPOSITORY_METHODS = Object.freeze([
  'listConnectors',
  'getConnectorById',
  'getConnectorOperationalSummary',
  'listConnectorReceipts',
  'createConnector',
  'updateConnector',
  'appendConnectorReceipt'
]);

const CONNECTOR_STATUSES = Object.freeze(['active', 'paused', 'archived']);
const CONNECTOR_KINDS = Object.freeze(['local_mock']);
const CONNECTOR_SCOPES = Object.freeze(['read', 'write']);
const CONNECTOR_RECEIPT_OPERATIONS = Object.freeze(['read', 'read_refused', 'write_refused']);
const CONNECTOR_RECEIPT_RESULT_STATUSES = Object.freeze(['ok', 'failed', 'refused']);

class ConnectorConflictError extends Error {
  constructor(id, expectedRevision, current = null) {
    super(`connector ${id} did not match expected revision ${expectedRevision}`);
    this.name = 'ConnectorConflictError';
    this.code = 'OPTIMISTIC_CONCURRENCY_CONFLICT';
    this.entity = 'connector';
    this.entityId = id;
    this.expectedRevision = expectedRevision;
    this.current = current;
  }
}

class ConnectorIdConflictError extends Error {
  constructor(entity, id) {
    super(`${entity} id already exists: ${id}`);
    this.name = 'ConnectorIdConflictError';
    this.code = 'CONNECTOR_ID_CONFLICT';
    this.entity = entity;
    this.entityId = id;
  }
}

class ConnectorReferenceError extends Error {
  constructor(message, code = 'CONNECTOR_REFERENCE_INVALID') {
    super(message);
    this.name = 'ConnectorReferenceError';
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

function nullableString(value) {
  if (value === undefined || value === null || value === '') return null;
  return String(value).trim() || null;
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

function jsonObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${label} must be an object`);
  return structuredClone(value);
}

function timestamp(value, label) {
  const parsed = value instanceof Date ? value : new Date(requiredString(value, label));
  if (Number.isNaN(parsed.getTime())) throw new TypeError(`${label} must be a valid timestamp`);
  return parsed.toISOString();
}

function normalizeEnumList(value, allowed, label) {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value) || value.length === 0) throw new TypeError(`${label} must be a non-empty array`);
  const result = [...new Set(value.map((item, index) => requiredString(item, `${label}[${index}]`)))];
  for (const item of result) {
    if (!allowed.includes(item)) throw new TypeError(`Unsupported ${label} value: ${item}`);
  }
  return result;
}

function normalizeStringArray(value, label) {
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array`);
  return [...new Set(value.map((item, index) => requiredString(item, `${label}[${index}]`)))];
}

function assertNoPlaintextSecretFields(value, label, { receipt = false } = {}) {
  const forbidden = new Set(receipt
    ? ['content', 'credential', 'secret', 'apikey', 'token', 'password', 'authorization', 'cookie']
    : ['credential', 'secret', 'apikey', 'token', 'password']);
  const visit = (item, path) => {
    if (!item || typeof item !== 'object') return;
    if (Array.isArray(item)) {
      item.forEach((entry, index) => visit(entry, `${path}[${index}]`));
      return;
    }
    for (const [key, entry] of Object.entries(item)) {
      if (forbidden.has(key.toLowerCase())) throw new TypeError(`${path}.${key} is not allowed`);
      visit(entry, `${path}.${key}`);
    }
  };
  visit(value, label);
}

function normalizeConnectorValue(value) {
  const source = jsonObject(value, 'value');
  assertNoPlaintextSecretFields(source, 'value');
  const status = requiredString(source.status || 'active', 'value.status');
  if (!CONNECTOR_STATUSES.includes(status)) throw new TypeError(`Unsupported connector status: ${status}`);
  const kind = requiredString(source.kind || 'local_mock', 'value.kind');
  if (!CONNECTOR_KINDS.includes(kind)) throw new TypeError(`Unsupported connector kind: ${kind}`);
  const allowedScopes = source.allowedScopes === undefined
    ? []
    : normalizeEnumList(source.allowedScopes, CONNECTOR_SCOPES, 'value.allowedScopes');
  const syncPolicy = jsonObject(source.syncPolicy || { mode: 'manual' }, 'value.syncPolicy');
  if (syncPolicy.mode !== 'manual') throw new TypeError('value.syncPolicy.mode must be manual');
  const normalized = {
    ...source,
    name: requiredString(source.name, 'value.name'),
    status,
    kind,
    workContextId: positiveSafeInteger(source.workContextId, 'value.workContextId'),
    credentialRef: nullableString(source.credentialRef),
    allowedScopes: allowedScopes || [],
    sourceRoots: normalizeStringArray(source.sourceRoots || [], 'value.sourceRoots'),
    targetRoots: normalizeStringArray(source.targetRoots || [], 'value.targetRoots'),
    readPolicy: jsonObject(source.readPolicy || { mode: 'bounded' }, 'value.readPolicy'),
    writePolicy: jsonObject(source.writePolicy || { mode: 'disabled' }, 'value.writePolicy'),
    receiptPolicy: jsonObject(source.receiptPolicy || { mode: 'required' }, 'value.receiptPolicy'),
    syncPolicy
  };
  for (const key of ['id', 'revision', 'createdBy', 'createdAt', 'updatedBy', 'updatedAt']) delete normalized[key];
  return normalized;
}

function requireCurrentFields(source, fields, label) {
  for (const field of fields) {
    if (!Object.prototype.hasOwnProperty.call(source, field)) {
      throw new TypeError(`${label} is missing current-format field: ${field}`);
    }
  }
}

function normalizeConnectorRecord(record) {
  const source = jsonObject(record, 'connector');
  requireCurrentFields(source, [
    'id', 'name', 'status', 'kind', 'workContextId', 'credentialRef', 'allowedScopes',
    'sourceRoots', 'targetRoots', 'readPolicy', 'writePolicy', 'receiptPolicy', 'syncPolicy',
    'revision', 'createdBy', 'createdAt', 'updatedBy', 'updatedAt'
  ], 'connector');
  return {
    id: positiveSafeInteger(source.id, 'connector.id'),
    ...normalizeConnectorValue(source),
    revision: positiveSafeInteger(source.revision, 'connector.revision'),
    createdBy: requiredString(source.createdBy, 'connector.createdBy'),
    createdAt: timestamp(source.createdAt, 'connector.createdAt'),
    updatedBy: requiredString(source.updatedBy, 'connector.updatedBy'),
    updatedAt: timestamp(source.updatedAt, 'connector.updatedAt')
  };
}

function normalizeConnectorReceiptValue(value) {
  const source = jsonObject(value, 'value');
  assertNoPlaintextSecretFields(source, 'value', { receipt: true });
  const operation = requiredString(source.operation, 'value.operation');
  if (!CONNECTOR_RECEIPT_OPERATIONS.includes(operation)) {
    throw new TypeError(`Unsupported connector receipt operation: ${operation}`);
  }
  const request = jsonObject(source.request, 'value.request');
  if (request.bounded !== true) throw new TypeError('value.request.bounded must be true');
  const result = jsonObject(source.result, 'value.result');
  const resultStatus = requiredString(result.status, 'value.result.status');
  if (!CONNECTOR_RECEIPT_RESULT_STATUSES.includes(resultStatus)) {
    throw new TypeError(`Unsupported connector receipt result status: ${resultStatus}`);
  }
  if (operation === 'read' && !['ok', 'failed'].includes(resultStatus)) {
    throw new TypeError('read receipt result status must be ok or failed');
  }
  if (operation !== 'read' && resultStatus !== 'refused') {
    throw new TypeError(`${operation} receipt result status must be refused`);
  }
  if (resultStatus === 'ok') {
    nonNegativeSafeInteger(result.bytes, 'value.result.bytes');
    if (typeof result.hash !== 'string' || !/^[a-f0-9]{64}$/.test(result.hash)) {
      throw new TypeError('value.result.hash must be a lowercase SHA-256 hash');
    }
  }
  const normalized = {
    ...source,
    connectorId: positiveSafeInteger(source.connectorId, 'value.connectorId'),
    workContextId: positiveSafeInteger(source.workContextId, 'value.workContextId'),
    operation,
    sourceRef: nullableString(source.sourceRef),
    targetRef: nullableString(source.targetRef),
    externalObjectId: nullableString(source.externalObjectId),
    ticketId: nullablePositiveSafeInteger(source.ticketId, 'value.ticketId'),
    runId: nullablePositiveSafeInteger(source.runId, 'value.runId'),
    actor: requiredString(source.actor, 'value.actor'),
    request,
    result: { ...result, status: resultStatus },
    error: nullableString(source.error)
  };
  delete normalized.id;
  delete normalized.timestamp;
  return normalized;
}

function normalizeConnectorReceiptRecord(record) {
  const source = jsonObject(record, 'connector receipt');
  requireCurrentFields(source, [
    'id', 'connectorId', 'workContextId', 'operation', 'sourceRef', 'targetRef',
    'externalObjectId', 'ticketId', 'runId', 'actor', 'timestamp', 'request', 'result', 'error'
  ], 'connector receipt');
  return {
    id: positiveSafeInteger(source.id, 'connectorReceipt.id'),
    ...normalizeConnectorReceiptValue(source),
    timestamp: timestamp(source.timestamp, 'connectorReceipt.timestamp')
  };
}

function assertConnectorAuthorityRepository(repository) {
  if (!repository || typeof repository !== 'object') throw new TypeError('connector authority repository is required');
  for (const method of REQUIRED_CONNECTOR_AUTHORITY_REPOSITORY_METHODS) {
    if (typeof repository[method] !== 'function') {
      throw new TypeError(`connector authority repository must implement ${method}()`);
    }
  }
  return repository;
}

module.exports = {
  REQUIRED_CONNECTOR_AUTHORITY_REPOSITORY_METHODS,
  CONNECTOR_STATUSES,
  CONNECTOR_KINDS,
  CONNECTOR_SCOPES,
  CONNECTOR_RECEIPT_OPERATIONS,
  CONNECTOR_RECEIPT_RESULT_STATUSES,
  ConnectorConflictError,
  ConnectorIdConflictError,
  ConnectorReferenceError,
  assertConnectorAuthorityRepository,
  jsonObject,
  nonNegativeSafeInteger,
  normalizeConnectorRecord,
  normalizeConnectorValue,
  normalizeConnectorReceiptRecord,
  normalizeConnectorReceiptValue,
  normalizeEnumList,
  nullablePositiveSafeInteger,
  nullableString,
  positiveSafeInteger,
  requiredFunction,
  requiredString,
  timestamp
};

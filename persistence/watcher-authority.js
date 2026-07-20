'use strict';

const REQUIRED_WATCHER_AUTHORITY_REPOSITORY_METHODS = Object.freeze([
  'listWatchers',
  'getWatcherById',
  'getWatcherOperationalSummary',
  'listWatcherObservations',
  'listWatcherProposals',
  'getWatcherProposalById',
  'createWatcher',
  'updateWatcher',
  'recordWatcherObservation',
  'createWatcherProposal',
  'approveWatcherProposal',
  'rejectWatcherProposal'
]);

const WATCHER_STATUSES = Object.freeze(['active', 'paused', 'archived']);
const WATCHER_SOURCE_KINDS = Object.freeze(['workspace_file']);
const WATCHER_ALLOWED_ACTIONS = Object.freeze(['summarize', 'raise_triage', 'propose_ticket', 'notify']);
const WATCHER_OBSERVATION_STATUSES = Object.freeze(['changed', 'unchanged', 'failed', 'refused']);
const WATCHER_PROPOSAL_STATUSES = Object.freeze(['proposed', 'approved', 'rejected']);

class WatcherConflictError extends Error {
  constructor(entity, id, expectedRevision, current = null) {
    super(`${entity} ${id} did not match expected revision ${expectedRevision}`);
    this.name = 'WatcherConflictError';
    this.code = 'OPTIMISTIC_CONCURRENCY_CONFLICT';
    this.entity = entity;
    this.entityId = id;
    this.expectedRevision = expectedRevision;
    this.current = current;
  }
}

class WatcherStateConflictError extends Error {
  constructor(message, code = 'WATCHER_STATE_CONFLICT', current = null) {
    super(message);
    this.name = 'WatcherStateConflictError';
    this.code = code;
    this.current = current;
  }
}

class WatcherReferenceError extends Error {
  constructor(message, code = 'WATCHER_REFERENCE_INVALID') {
    super(message);
    this.name = 'WatcherReferenceError';
    this.code = code;
  }
}

class WatcherIdConflictError extends Error {
  constructor(entity, id) {
    super(`${entity} id already exists: ${id}`);
    this.name = 'WatcherIdConflictError';
    this.code = 'WATCHER_ID_CONFLICT';
    this.entity = entity;
    this.entityId = id;
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

function nullableJson(value) {
  return value === undefined || value === null ? null : structuredClone(value);
}

function timestamp(value, label) {
  if (value === null) return null;
  const parsed = value instanceof Date ? value : new Date(requiredString(value, label));
  if (Number.isNaN(parsed.getTime())) throw new TypeError(`${label} must be a valid timestamp`);
  return parsed.toISOString();
}

function requireCurrentFields(source, fields, label) {
  for (const field of fields) {
    if (!Object.prototype.hasOwnProperty.call(source, field)) {
      throw new TypeError(`${label} is missing current-format field: ${field}`);
    }
  }
}

function enumList(value, allowed, label) {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value) || value.length === 0) throw new TypeError(label + " must be a non-empty array");
  const result = [...new Set(value.map((item, index) => requiredString(item, `${label}[${index}]`)))];
  for (const item of result) if (!allowed.includes(item)) throw new TypeError(`Unsupported ${label} value: ${item}`);
  return result;
}

function stringArray(value, label) {
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array`);
  return [...new Set(value.map((item, index) => requiredString(item, `${label}[${index}]`)))];
}

function sourceRefs(value, label) {
  if (!Array.isArray(value) || value.length !== 1) throw new TypeError(label + " must contain exactly one bounded source");
  return value.map((item, index) => {
    const source = jsonObject(item, `${label}[${index}]`);
    return { path: requiredString(source.path, `${label}[${index}].path`) };
  });
}

function optionalSourceRefs(value, label) {
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array`);
  return value.map((item, index) => {
    const source = jsonObject(item, `${label}[${index}]`);
    return { path: requiredString(source.path, `${label}[${index}].path`) };
  });
}

function sameSourceRefs(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function hash(value, label) {
  const normalized = nullableString(value);
  if (normalized !== null && !/^[a-f0-9]{64}$/.test(normalized)) throw new TypeError(`${label} must be a lowercase SHA-256 hash or null`);
  return normalized;
}

function normalizeWatcherValue(value) {
  const source = jsonObject(value, 'value');
  const status = requiredString(source.status || 'active', 'value.status');
  if (!WATCHER_STATUSES.includes(status)) throw new TypeError(`Unsupported watcher status: ${status}`);
  const sourceKind = requiredString(source.sourceKind || 'workspace_file', 'value.sourceKind');
  if (!WATCHER_SOURCE_KINDS.includes(sourceKind)) throw new TypeError(`Unsupported watcher source kind: ${sourceKind}`);
  const cadence = jsonObject(source.cadence || { mode: 'manual' }, 'value.cadence');
  const triggerPolicy = jsonObject(source.triggerPolicy || { mode: 'manual' }, 'value.triggerPolicy');
  const deltaPolicy = jsonObject(source.deltaPolicy || { mode: 'hash' }, 'value.deltaPolicy');
  const actionPolicy = jsonObject(source.actionPolicy || { allowedActions: ['summarize'] }, 'value.actionPolicy');
  const triagePolicy = jsonObject(source.triagePolicy || { mode: 'manual' }, 'value.triagePolicy');
  const ticketProposalPolicy = jsonObject(source.ticketProposalPolicy || { enabled: false }, 'value.ticketProposalPolicy');
  const notificationPolicy = jsonObject(source.notificationPolicy || { mode: 'none' }, 'value.notificationPolicy');
  if (cadence.mode !== 'manual' || triggerPolicy.mode !== 'manual') throw new TypeError('watcher cadence and trigger policy must be manual');
  if (deltaPolicy.mode !== 'hash') throw new TypeError('watcher delta policy must be hash');
  if (notificationPolicy.mode !== 'none') throw new TypeError('watcher notification policy must be none');
  const allowedActions = enumList(actionPolicy.allowedActions || ['summarize'], WATCHER_ALLOWED_ACTIONS, 'value.actionPolicy.allowedActions');
  const normalized = {
    name: requiredString(source.name, 'value.name'),
    status,
    workContextId: positiveSafeInteger(source.workContextId, 'value.workContextId'),
    sourceKind,
    sourceRefs: sourceRefs(source.sourceRefs, 'value.sourceRefs'),
    cadence: { ...cadence, mode: 'manual' },
    triggerPolicy: { ...triggerPolicy, mode: 'manual' },
    deltaPolicy: { ...deltaPolicy, mode: 'hash' },
    actionPolicy: { ...actionPolicy, allowedActions },
    triagePolicy,
    ticketProposalPolicy,
    notificationPolicy: { ...notificationPolicy, mode: 'none' }
  };
  return normalized;
}

function normalizeWatcherRecord(record) {
  const source = jsonObject(record, 'watcher');
  requireCurrentFields(source, [
    'id', 'name', 'status', 'workContextId', 'sourceKind', 'sourceRefs', 'cadence',
    'triggerPolicy', 'deltaPolicy', 'actionPolicy', 'triagePolicy', 'ticketProposalPolicy',
    'notificationPolicy', 'lastObservedAt', 'lastObservationHash', 'revision',
    'createdBy', 'createdAt', 'updatedBy', 'updatedAt'
  ], 'watcher');
  return {
    id: positiveSafeInteger(source.id, 'watcher.id'),
    ...normalizeWatcherValue(source),
    lastObservedAt: source.lastObservedAt === null ? null : timestamp(source.lastObservedAt, 'watcher.lastObservedAt'),
    lastObservationHash: hash(source.lastObservationHash, 'watcher.lastObservationHash'),
    revision: positiveSafeInteger(source.revision, 'watcher.revision'),
    createdBy: requiredString(source.createdBy, 'watcher.createdBy'),
    createdAt: timestamp(source.createdAt, 'watcher.createdAt'),
    updatedBy: requiredString(source.updatedBy, 'watcher.updatedBy'),
    updatedAt: timestamp(source.updatedAt, 'watcher.updatedAt')
  };
}

function normalizeWatcherObservationValue(value) {
  const source = jsonObject(value, 'value');
  const status = requiredString(source.status, 'value.status');
  if (!WATCHER_OBSERVATION_STATUSES.includes(status)) throw new TypeError(`Unsupported watcher observation status: ${status}`);
  const currentHash = hash(source.currentHash, 'value.currentHash');
  const previousHash = hash(source.previousHash, 'value.previousHash');
  if (['changed', 'unchanged'].includes(status) && currentHash === null) throw new TypeError(`${status} observations require currentHash`);
  const error = nullableString(source.error);
  if (['failed', 'refused'].includes(status) && error === null) throw new TypeError(`${status} observations require error`);
  if (['changed', 'unchanged'].includes(status) && error !== null) throw new TypeError(`${status} observations cannot carry error`);
  let summary = null;
  if (source.summary !== null) {
    const metadata = jsonObject(source.summary, 'value.summary');
    requireCurrentFields(metadata, ['bytes', 'lineCount'], 'value.summary');
    if (Object.keys(metadata).some(key => key !== 'bytes' && key !== 'lineCount')) {
      throw new TypeError('value.summary may contain only bytes and lineCount');
    }
    summary = {
      bytes: nonNegativeSafeInteger(metadata.bytes, 'value.summary.bytes'),
      lineCount: nonNegativeSafeInteger(metadata.lineCount, 'value.summary.lineCount')
    };
  }
  return {
    watcherId: positiveSafeInteger(source.watcherId, 'value.watcherId'),
    workContextId: positiveSafeInteger(source.workContextId, 'value.workContextId'),
    status,
    sourceKind: requiredString(source.sourceKind, 'value.sourceKind'),
    sourceRefs: optionalSourceRefs(source.sourceRefs || [], 'value.sourceRefs'),
    previousHash,
    currentHash,
    summary,
    actionTaken: nullableString(source.actionTaken),
    ticketProposalId: nullablePositiveSafeInteger(source.ticketProposalId, 'value.ticketProposalId'),
    error
  };
}

function normalizeWatcherObservationRecord(record) {
  const source = jsonObject(record, 'watcher observation');
  requireCurrentFields(source, [
    'id', 'watcherId', 'workContextId', 'status', 'observedAt', 'sourceKind', 'sourceRefs',
    'previousHash', 'currentHash', 'summary', 'actionTaken', 'ticketProposalId', 'error'
  ], 'watcher observation');
  return {
    id: positiveSafeInteger(source.id, 'watcherObservation.id'),
    ...normalizeWatcherObservationValue(source),
    observedAt: timestamp(source.observedAt, 'watcherObservation.observedAt')
  };
}

function normalizeWatcherProposalValue(value) {
  const source = jsonObject(value, 'value');
  return {
    watcherId: positiveSafeInteger(source.watcherId, 'value.watcherId'),
    workContextId: positiveSafeInteger(source.workContextId, 'value.workContextId'),
    observationId: nullablePositiveSafeInteger(source.observationId, 'value.observationId'),
    objective: requiredString(source.objective, 'value.objective'),
    sourceRefs: optionalSourceRefs(source.sourceRefs || [], 'value.sourceRefs'),
    evidenceRefs: stringArray(source.evidenceRefs || [], 'value.evidenceRefs'),
    constraints: nullableJson(source.constraints),
    authorityLimits: nullableJson(source.authorityLimits),
    stopCondition: nullableJson(source.stopCondition),
    receiptExpectation: requiredString(source.receiptExpectation || 'work_receipt', 'value.receiptExpectation')
  };
}

function normalizeWatcherProposalRecord(record) {
  const source = jsonObject(record, 'watcher proposal');
  requireCurrentFields(source, [
    'id', 'watcherId', 'workContextId', 'observationId', 'status', 'objective', 'sourceRefs',
    'evidenceRefs', 'constraints', 'authorityLimits', 'stopCondition', 'receiptExpectation',
    'createdTicketId', 'approvedAt', 'rejectedAt', 'revision', 'createdBy', 'createdAt',
    'updatedBy', 'updatedAt'
  ], 'watcher proposal');
  const status = requiredString(source.status, 'watcherProposal.status');
  if (!WATCHER_PROPOSAL_STATUSES.includes(status)) throw new TypeError(`Unsupported watcher proposal status: ${status}`);
  const createdTicketId = nullablePositiveSafeInteger(source.createdTicketId, 'watcherProposal.createdTicketId');
  const approvedAt = source.approvedAt === null ? null : timestamp(source.approvedAt, 'watcherProposal.approvedAt');
  const rejectedAt = source.rejectedAt === null ? null : timestamp(source.rejectedAt, 'watcherProposal.rejectedAt');
  if (status === 'approved' && (createdTicketId === null || approvedAt === null || rejectedAt !== null)) {
    throw new TypeError('approved watcher proposals require createdTicketId and approvedAt only');
  }
  if (status === 'rejected' && (createdTicketId !== null || rejectedAt === null || approvedAt !== null)) {
    throw new TypeError('rejected watcher proposals require rejectedAt and no ticket');
  }
  if (status === 'proposed' && (createdTicketId !== null || approvedAt !== null || rejectedAt !== null)) {
    throw new TypeError('proposed watcher proposals cannot carry a disposition');
  }
  return {
    id: positiveSafeInteger(source.id, 'watcherProposal.id'),
    ...normalizeWatcherProposalValue(source),
    status,
    createdTicketId,
    approvedAt,
    rejectedAt,
    revision: positiveSafeInteger(source.revision, 'watcherProposal.revision'),
    createdBy: requiredString(source.createdBy, 'watcherProposal.createdBy'),
    createdAt: timestamp(source.createdAt, 'watcherProposal.createdAt'),
    updatedBy: requiredString(source.updatedBy, 'watcherProposal.updatedBy'),
    updatedAt: timestamp(source.updatedAt, 'watcherProposal.updatedAt')
  };
}

function assertWatcherAuthorityRepository(repository) {
  if (!repository || typeof repository !== 'object') throw new TypeError('watcher authority repository is required');
  for (const method of REQUIRED_WATCHER_AUTHORITY_REPOSITORY_METHODS) {
    if (typeof repository[method] !== 'function') throw new TypeError(`watcher authority repository must implement ${method}()`);
  }
  return repository;
}

module.exports = {
  REQUIRED_WATCHER_AUTHORITY_REPOSITORY_METHODS,
  WATCHER_STATUSES,
  WATCHER_SOURCE_KINDS,
  WATCHER_ALLOWED_ACTIONS,
  WATCHER_OBSERVATION_STATUSES,
  WATCHER_PROPOSAL_STATUSES,
  WatcherConflictError,
  WatcherStateConflictError,
  WatcherReferenceError,
  WatcherIdConflictError,
  assertWatcherAuthorityRepository,
  enumList,
  jsonObject,
  nonNegativeSafeInteger,
  normalizeWatcherValue,
  normalizeWatcherRecord,
  normalizeWatcherObservationValue,
  normalizeWatcherObservationRecord,
  normalizeWatcherProposalValue,
  normalizeWatcherProposalRecord,
  nullablePositiveSafeInteger,
  positiveSafeInteger,
  requiredFunction,
  requiredString,
  sameSourceRefs,
  timestamp
};

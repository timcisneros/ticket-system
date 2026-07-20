'use strict';

const REQUIRED_WORK_CONTEXT_REPOSITORY_METHODS = Object.freeze([
  'listWorkContexts',
  'getWorkContextById',
  'getWorkContextCounts',
  'createWorkContext',
  'updateWorkContext'
]);

class WorkContextConflictError extends Error {
  constructor(id, expectedRevision, current = null) {
    super(`workContext ${id} did not match expected revision ${expectedRevision}`);
    this.name = 'WorkContextConflictError';
    this.code = 'OPTIMISTIC_CONCURRENCY_CONFLICT';
    this.entity = 'workContext';
    this.entityId = id;
    this.expectedRevision = expectedRevision;
    this.current = current;
  }
}

function requiredFunction(value, label) {
  if (typeof value !== 'function') throw new TypeError(`${label} must be a function`);
  return value;
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

function requiredString(value, label) {
  const normalized = String(value === undefined || value === null ? '' : value).trim();
  if (!normalized) throw new TypeError(`${label} is required`);
  return normalized;
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
  if (value === null || value === undefined) return null;
  if (!Array.isArray(value) || value.length === 0) throw new TypeError('statuses must be a non-empty array');
  const statuses = [...new Set(value.map(item => requiredString(item, 'status')))];
  for (const status of statuses) {
    if (!['active', 'archived'].includes(status)) throw new TypeError(`Unsupported Work Context status: ${status}`);
  }
  return statuses;
}

function normalizeValue(value) {
  const record = structuredClone(jsonObject(value, 'value'));
  record.name = requiredString(record.name, 'value.name');
  record.status = requiredString(record.status, 'value.status');
  if (!['active', 'archived'].includes(record.status)) throw new TypeError(`Unsupported Work Context status: ${record.status}`);
  for (const key of ['id', 'revision', 'createdBy', 'createdAt', 'updatedBy', 'updatedAt']) delete record[key];
  return record;
}

function normalizeRecord(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return null;
  const id = positiveSafeInteger(record.id, 'workContext.id');
  return { ...structuredClone(record), id, revision: Number.isSafeInteger(record.revision) && record.revision > 0 ? record.revision : 1 };
}

function assertWorkContextRepository(repository) {
  if (!repository || typeof repository !== 'object') throw new TypeError('work context repository is required');
  for (const method of REQUIRED_WORK_CONTEXT_REPOSITORY_METHODS) {
    if (typeof repository[method] !== 'function') throw new TypeError(`work context repository must implement ${method}()`);
  }
  return repository;
}

class JsonWorkContextRepository {
  constructor({ readWorkContexts, writeWorkContexts, appendSystemLog, now = () => new Date(), maxQueryRows = 1_000 } = {}) {
    this.readWorkContexts = requiredFunction(readWorkContexts, 'readWorkContexts');
    this.writeWorkContexts = requiredFunction(writeWorkContexts, 'writeWorkContexts');
    this.appendSystemLog = requiredFunction(appendSystemLog, 'appendSystemLog');
    this.now = requiredFunction(now, 'now');
    this.maxQueryRows = positiveSafeInteger(maxQueryRows, 'maxQueryRows');
  }

  _readRaw() {
    return structuredClone(this.readWorkContexts());
  }

  _read() {
    return this._readRaw().map(normalizeRecord).filter(Boolean);
  }

  async listWorkContexts({ afterId = 0, statuses = null, limit = 100 } = {}) {
    const cursor = nonNegativeSafeInteger(afterId, 'afterId');
    const size = positiveSafeInteger(limit, 'limit');
    if (size > this.maxQueryRows) throw new RangeError(`limit exceeds the configured maximum of ${this.maxQueryRows}`);
    const allowed = normalizeStatuses(statuses);
    const matches = this._read().filter(item => item.id > cursor && (!allowed || allowed.includes(item.status))).sort((left, right) => left.id - right.id).slice(0, size + 1);
    const page = matches.slice(0, size);
    return { workContexts: page, nextAfterId: matches.length > size && page.length > 0 ? page[page.length - 1].id : null };
  }

  async getWorkContextById(id) {
    const workContextId = positiveSafeInteger(id, 'workContextId');
    return this._read().find(item => item.id === workContextId) || null;
  }

  async getWorkContextCounts() {
    const counts = { active: 0, archived: 0, total: 0 };
    for (const item of this._read()) {
      counts.total += 1;
      if (item.status === 'active') counts.active += 1;
      if (item.status === 'archived') counts.archived += 1;
    }
    return counts;
  }

  async _appendAuditOrRollback({ rollbackValue, type, message, metadata }) {
    try {
      return await this.appendSystemLog({ type, message, metadata });
    } catch (error) {
      this.writeWorkContexts(rollbackValue);
      throw error;
    }
  }

  async createWorkContext({ value, changedBy }) {
    const body = normalizeValue(value);
    const actor = requiredString(changedBy, 'changedBy');
    const rollbackValue = this._readRaw();
    const original = rollbackValue.map(normalizeRecord).filter(Boolean);
    const now = timestamp(this.now(), 'now');
    const record = { id: original.reduce((maximum, item) => Math.max(maximum, item.id), 0) + 1, ...body, revision: 1, createdBy: actor, createdAt: now, updatedBy: actor, updatedAt: now };
    this.writeWorkContexts([...original, record]);
    const auditLog = await this._appendAuditOrRollback({
      rollbackValue,
      type: 'work_context:created',
      message: `Work Context \"${record.name}\" created`,
      metadata: { workContextId: record.id, name: record.name, status: record.status, changedBy: actor }
    });
    return { workContext: structuredClone(record), auditLog };
  }

  async updateWorkContext({ workContextId, expectedRevision, value, changedBy }) {
    const id = positiveSafeInteger(workContextId, 'workContextId');
    const revision = positiveSafeInteger(expectedRevision, 'expectedRevision');
    const body = normalizeValue(value);
    const actor = requiredString(changedBy, 'changedBy');
    const rollbackValue = this._readRaw();
    const original = rollbackValue.map(normalizeRecord).filter(Boolean);
    const index = original.findIndex(item => item.id === id);
    if (index === -1) return null;
    if (original[index].revision !== revision) throw new WorkContextConflictError(id, revision, structuredClone(original[index]));
    const previous = original[index];
    const updated = { ...previous, ...body, id, revision: revision + 1, createdBy: previous.createdBy, createdAt: previous.createdAt, updatedBy: actor, updatedAt: timestamp(this.now(), 'now') };
    const next = original.slice();
    next[index] = updated;
    this.writeWorkContexts(next);
    const archived = previous.status !== updated.status && updated.status === 'archived';
    const type = archived ? 'work_context:archived' : 'work_context:updated';
    const auditLog = await this._appendAuditOrRollback({
      rollbackValue,
      type,
      message: `Work Context \"${updated.name}\" ${archived ? 'archived' : 'updated'}`,
      metadata: { workContextId: id, name: updated.name, status: updated.status, changedBy: actor }
    });
    return { workContext: structuredClone(updated), auditLog };
  }
}

module.exports = { JsonWorkContextRepository, REQUIRED_WORK_CONTEXT_REPOSITORY_METHODS, WorkContextConflictError, assertWorkContextRepository };

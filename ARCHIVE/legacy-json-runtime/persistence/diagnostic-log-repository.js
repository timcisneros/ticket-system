'use strict';

const REQUIRED_DIAGNOSTIC_LOG_REPOSITORY_METHODS = Object.freeze([
  'appendRunLog',
  'appendSystemLog',
  'listLogs',
  'listLogsForRuns',
  'hasRunLogType',
  'getRunLogMetrics',
  'resetLogs'
]);

function requiredFunction(value, label) {
  if (typeof value !== 'function') throw new TypeError(`${label} must be a function`);
  return value;
}

function positiveSafeInteger(value, label) {
  const number = typeof value === 'string' && /^[1-9]\d*$/.test(value) ? Number(value) : value;
  if (!Number.isSafeInteger(number) || number <= 0) {
    throw new TypeError(`${label} must be a positive safe integer`);
  }
  return number;
}

function nonNegativeSafeInteger(value, label) {
  const number = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  if (!Number.isSafeInteger(number) || number < 0) {
    throw new TypeError(`${label} must be a non-negative safe integer`);
  }
  return number;
}

function nullablePositiveSafeInteger(value, label) {
  if (value === null || value === undefined || value === '') return null;
  return positiveSafeInteger(value, label);
}

function boundedLimit(value, maximum, label = 'limit') {
  const limit = positiveSafeInteger(value, label);
  if (limit > maximum) throw new RangeError(`${label} exceeds the configured maximum of ${maximum}`);
  return limit;
}

function boundedPositiveIds(value, maximum, label) {
  if (!Array.isArray(value) || value.length === 0) throw new TypeError(`${label} must be a non-empty array`);
  const ids = [...new Set(value.map((id, index) => positiveSafeInteger(id, `${label}[${index}]`)))];
  if (ids.length > maximum) throw new RangeError(`${label} exceeds the configured maximum of ${maximum}`);
  return ids;
}

function normalizeTypes(value, label) {
  if (value === null || value === undefined) return null;
  if (!Array.isArray(value) || value.length === 0) throw new TypeError(`${label} must be a non-empty array`);
  return [...new Set(value.map((type, index) => {
    const normalized = String(type === undefined || type === null ? '' : type).trim();
    if (!normalized) throw new TypeError(`${label}[${index}] is required`);
    return normalized;
  }))];
}

function requiredString(value, label) {
  const normalized = String(value === undefined || value === null ? '' : value).trim();
  if (!normalized) throw new TypeError(`${label} is required`);
  return normalized;
}

function assertDiagnosticLogRepository(repository) {
  if (!repository || typeof repository !== 'object') {
    throw new TypeError('diagnostic log repository is required');
  }
  for (const method of REQUIRED_DIAGNOSTIC_LOG_REPOSITORY_METHODS) {
    if (typeof repository[method] !== 'function') {
      throw new TypeError(`diagnostic log repository must implement ${method}()`);
    }
  }
  return repository;
}

function countTokens(usage) {
  if (!usage || typeof usage !== 'object' || Array.isArray(usage)) return 0;
  const direct = Number(usage.total_tokens ?? usage.totalTokens);
  if (Number.isFinite(direct) && direct >= 0) return direct;
  const input = Number(usage.prompt_tokens ?? usage.input_tokens ?? usage.promptTokens ?? usage.inputTokens ?? 0);
  const output = Number(usage.completion_tokens ?? usage.output_tokens ?? usage.completionTokens ?? usage.outputTokens ?? 0);
  return (Number.isFinite(input) && input >= 0 ? input : 0) +
    (Number.isFinite(output) && output >= 0 ? output : 0);
}

function createMetric(runId) {
  return {
    runId,
    totalTokensUsed: 0,
    totalModelRequests: 0,
    totalModelResponses: 0,
    totalWorkspaceReads: 0,
    totalWorkspaceWrites: 0,
    totalFilesCreated: 0,
    totalFilesModified: 0,
    totalFilesDeleted: 0,
    totalWorkspaceActions: 0
  };
}

function addLogToMetric(metric, log) {
  metric.totalTokensUsed += countTokens(log.usage);
  if (log.type === 'model:request') metric.totalModelRequests += 1;
  if (log.type === 'model:response') metric.totalModelResponses += 1;
  if (log.type === 'workspace:read') metric.totalWorkspaceReads += 1;
  if (log.type === 'workspace:write') {
    metric.totalWorkspaceWrites += 1;
    metric.totalFilesModified += 1;
  }
  if (log.type === 'workspace:create' && (!log.workspaceAction || log.workspaceAction.kind !== 'folder')) {
    metric.totalFilesCreated += 1;
  }
  if (log.type === 'workspace:delete') metric.totalFilesDeleted += 1;
  if (['workspace:list', 'workspace:read', 'workspace:write', 'workspace:create', 'workspace:rename', 'workspace:delete'].includes(log.type)) {
    metric.totalWorkspaceActions += 1;
  }
}

class JsonDiagnosticLogRepository {
  constructor({
    readLogs,
    writeLogs,
    now = () => new Date().toISOString(),
    maxQueryRows = 1_000
  } = {}) {
    this.readLogs = requiredFunction(readLogs, 'readLogs');
    this.writeLogs = requiredFunction(writeLogs, 'writeLogs');
    this.now = requiredFunction(now, 'now');
    this.maxQueryRows = positiveSafeInteger(maxQueryRows, 'maxQueryRows');
  }

  appendRunLog({ run, type, message, workspaceAction = null, metadata = {} } = {}) {
    if (!run || typeof run !== 'object') throw new TypeError('run is required');
    const runId = positiveSafeInteger(run.id, 'run.id');
    const ticketId = positiveSafeInteger(run.ticketId, 'run.ticketId');
    const agentId = positiveSafeInteger(run.agentId, 'run.agentId');
    const logs = this.readLogs();
    const fields = metadata && typeof metadata === 'object' && !Array.isArray(metadata) ? metadata : {};
    const record = {
      ...fields,
      id: logs.reduce((maximum, log) => Math.max(maximum, Number.isSafeInteger(log && log.id) ? log.id : 0), 0) + 1,
      timestamp: String(this.now()),
      runId,
      ticketId,
      agentId,
      agentName: run.agentName || `Agent ${agentId}`,
      type: requiredString(type, 'type'),
      message: String(message === undefined || message === null ? '' : message),
      workspaceAction
    };
    logs.push(record);
    this.writeLogs(logs);
    return record;
  }

  appendSystemLog({ type, message, workspaceAction = null, metadata = {} } = {}) {
    const logs = this.readLogs();
    const context = metadata && typeof metadata === 'object' && !Array.isArray(metadata) ? { ...metadata } : {};
    if (Object.prototype.hasOwnProperty.call(context, 'ticketId')) {
      context.contextTicketId = context.ticketId;
      delete context.ticketId;
    }
    if (Object.prototype.hasOwnProperty.call(context, 'runId')) {
      context.contextRunId = context.runId;
      delete context.runId;
    }
    delete context.agentId;
    delete context.agentName;
    const record = {
      ...context,
      id: logs.reduce((maximum, log) => Math.max(maximum, Number.isSafeInteger(log && log.id) ? log.id : 0), 0) + 1,
      timestamp: String(this.now()),
      runId: null,
      ticketId: null,
      agentId: null,
      agentName: 'System',
      type: requiredString(type, 'type'),
      message: String(message === undefined || message === null ? '' : message),
      workspaceAction
    };
    logs.push(record);
    this.writeLogs(logs);
    return record;
  }

  listLogs({
    runId = null,
    ticketId = null,
    types = null,
    excludeTypes = null,
    beforeId = null,
    afterId = null,
    order = 'desc',
    limit = 100
  } = {}) {
    const scopedRunId = nullablePositiveSafeInteger(runId, 'runId');
    const scopedTicketId = nullablePositiveSafeInteger(ticketId, 'ticketId');
    const included = normalizeTypes(types, 'types');
    const excluded = normalizeTypes(excludeTypes, 'excludeTypes');
    const before = nullablePositiveSafeInteger(beforeId, 'beforeId');
    const after = afterId === null || afterId === undefined || afterId === ''
      ? null
      : nonNegativeSafeInteger(afterId, 'afterId');
    if (before !== null && after !== null) throw new TypeError('beforeId and afterId are mutually exclusive');
    if (!['asc', 'desc'].includes(order)) throw new TypeError(`Unsupported order: ${order}`);
    const size = boundedLimit(limit, this.maxQueryRows);
    const includedSet = included ? new Set(included) : null;
    const excludedSet = excluded ? new Set(excluded) : null;
    const candidates = this.readLogs()
      .filter(log => log && Number.isSafeInteger(log.id))
      .filter(log => scopedRunId === null || log.runId === scopedRunId || log.contextRunId === scopedRunId)
      .filter(log => scopedTicketId === null || log.ticketId === scopedTicketId || log.contextTicketId === scopedTicketId)
      .filter(log => !includedSet || includedSet.has(log.type))
      .filter(log => !excludedSet || !excludedSet.has(log.type))
      .filter(log => before === null || log.id < before)
      .filter(log => after === null || log.id > after)
      .sort((left, right) => order === 'desc' ? right.id - left.id : left.id - right.id);
    const logs = candidates.slice(0, size);
    const last = logs[logs.length - 1] || null;
    return {
      logs,
      nextBeforeId: order === 'desc' && candidates.length > size && last ? last.id : null,
      nextAfterId: order === 'asc' && candidates.length > size && last ? last.id : null
    };
  }

  listLogsForRuns({ runIds, types = null, excludeTypes = null, limitPerRun = 25 } = {}) {
    const ids = boundedPositiveIds(runIds, this.maxQueryRows, 'runIds');
    const size = boundedLimit(limitPerRun, this.maxQueryRows, 'limitPerRun');
    const included = normalizeTypes(types, 'types');
    const excluded = normalizeTypes(excludeTypes, 'excludeTypes');
    const idSet = new Set(ids);
    const includedSet = included ? new Set(included) : null;
    const excludedSet = excluded ? new Set(excluded) : null;
    const grouped = new Map(ids.map(id => [id, []]));
    this.readLogs()
      .filter(log => log && idSet.has(log.runId))
      .filter(log => !includedSet || includedSet.has(log.type))
      .filter(log => !excludedSet || !excludedSet.has(log.type))
      .sort((left, right) => right.id - left.id)
      .forEach(log => {
        const records = grouped.get(log.runId);
        if (records.length < size) records.push(log);
      });
    return ids.flatMap(id => grouped.get(id).slice().reverse());
  }

  hasRunLogType({ runId, type } = {}) {
    const id = positiveSafeInteger(runId, 'runId');
    const normalizedType = requiredString(type, 'type');
    return this.readLogs().some(log => log && log.runId === id && log.type === normalizedType);
  }

  getRunLogMetrics({ runIds } = {}) {
    const ids = boundedPositiveIds(runIds, this.maxQueryRows, 'runIds');
    const metrics = new Map(ids.map(id => [id, createMetric(id)]));
    this.readLogs().forEach(log => {
      if (log && metrics.has(log.runId)) addLogToMetric(metrics.get(log.runId), log);
    });
    return ids.map(id => metrics.get(id));
  }

  resetLogs() {
    this.writeLogs([]);
  }
}

module.exports = {
  JsonDiagnosticLogRepository,
  REQUIRED_DIAGNOSTIC_LOG_REPOSITORY_METHODS,
  assertDiagnosticLogRepository,
  countTokens
};

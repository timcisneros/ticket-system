'use strict';

const TICKET_STATUSES = new Set(['open', 'in_progress', 'completed', 'failed', 'blocked', 'closed']);
const RUN_STATUSES = new Set(['pending', 'running', 'completed', 'failed', 'interrupted']);
const TERMINAL_RUN_STATUSES = new Set(['completed', 'failed', 'interrupted']);
const WORKSPACE_MUTATING_OPERATIONS = new Set(['createFolder', 'writeFile', 'renamePath', 'deletePath']);

const REQUIRED_RUNTIME_STATE_READ_REPOSITORY_METHODS = Object.freeze([
  'getTicket',
  'getRun',
  'listTickets',
  'listTicketPage',
  'countTicketsByStatus',
  'listRuns',
  'listRunsForTicket',
  'listRunsForTickets',
  'listLatestRunsForTickets',
  'getRunAttemptPositions',
  'listChildTickets',
  'listRunsNeedingTerminalReconciliation',
  'listRunEvents',
  'listRunTimelineEvents',
  'listTicketEvents',
  'getRunEvaluation',
  'getRunConsequence',
  'listRunOperations',
  'listTicketOperations',
  'countRunMutations'
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

function boundedLimit(value, maximum) {
  const limit = positiveSafeInteger(value, 'limit');
  if (limit > maximum) throw new RangeError(`limit exceeds the configured maximum of ${maximum}`);
  return limit;
}

function nullablePositiveSafeInteger(value, label) {
  if (value === null || value === undefined || value === '') return null;
  return positiveSafeInteger(value, label);
}

function boundedPositiveIds(value, maximum, label) {
  if (!Array.isArray(value) || value.length === 0) throw new TypeError(`${label} must be a non-empty array`);
  const ids = [...new Set(value.map((id, index) => positiveSafeInteger(id, `${label}[${index}]`)))];
  if (ids.length > maximum) throw new RangeError(`${label} exceeds the configured maximum of ${maximum}`);
  return ids;
}

function nullableIsoTimestamp(value, label) {
  if (value === null || value === undefined || value === '') return null;
  const normalized = String(value);
  if (Number.isNaN(Date.parse(normalized))) throw new TypeError(`${label} must be a valid timestamp`);
  return new Date(normalized).toISOString();
}

function normalizeStatuses(value, allowed, label) {
  if (value === null || value === undefined) return null;
  if (!Array.isArray(value) || value.length === 0) throw new TypeError(`${label} must be a non-empty array`);
  return [...new Set(value.map(status => String(status)))].map(status => {
    if (!allowed.has(status)) throw new TypeError(`Unsupported ${label}: ${status}`);
    return status;
  });
}

function pageById(records, { afterId, limit, key }) {
  const candidates = records
    .filter(record => record && record.id > afterId)
    .sort((left, right) => left.id - right.id);
  const page = candidates.slice(0, limit);
  const last = page[page.length - 1] || null;
  return {
    [key]: page,
    nextAfterId: candidates.length > limit && last ? last.id : null
  };
}

function compareNewestTicket(left, right) {
  const updated = String(right.updatedAt || right.createdAt || '').localeCompare(
    String(left.updatedAt || left.createdAt || '')
  );
  return updated || left.id - right.id;
}

function ticketTupleComparison(ticket, cursorUpdatedAt, cursorId) {
  const updatedAt = String(ticket.updatedAt || ticket.createdAt || '');
  const timestampComparison = cursorUpdatedAt.localeCompare(updatedAt);
  return timestampComparison || ticket.id - cursorId;
}

function isActualWorkspaceMutation(record) {
  if (!record || record.error || record.outcome === 'failed' || record.outcome === 'refused') return false;
  if (!WORKSPACE_MUTATING_OPERATIONS.has(record.operation)) return false;
  if (record.operation === 'createFolder') return record.result && record.result.status === 'created';
  if (record.operation === 'deletePath') return record.result && record.result.status === 'deleted';
  return true;
}

function assertRuntimeStateReadRepository(repository) {
  if (!repository || typeof repository !== 'object') {
    throw new TypeError('runtime state read repository is required');
  }
  for (const method of REQUIRED_RUNTIME_STATE_READ_REPOSITORY_METHODS) {
    if (typeof repository[method] !== 'function') {
      throw new TypeError(`runtime state read repository must implement ${method}()`);
    }
  }
  return repository;
}

class JsonRuntimeStateReadRepository {
  constructor({
    readTickets,
    readRuns,
    readRunScopedEvents,
    getRunEvents,
    getTicketEvents,
    readOperationHistory,
    maxQueryRows = 1_000
  } = {}) {
    this.readTickets = requiredFunction(readTickets, 'readTickets');
    this.readRuns = requiredFunction(readRuns, 'readRuns');
    this.readRunScopedEvents = requiredFunction(readRunScopedEvents, 'readRunScopedEvents');
    this.getRunEvents = requiredFunction(getRunEvents, 'getRunEvents');
    this.getTicketEvents = requiredFunction(getTicketEvents, 'getTicketEvents');
    this.readOperationHistory = requiredFunction(readOperationHistory, 'readOperationHistory');
    this.maxQueryRows = positiveSafeInteger(maxQueryRows, 'maxQueryRows');
  }

  async getTicket(ticketId) {
    const id = positiveSafeInteger(ticketId, 'ticketId');
    return this.readTickets().find(ticket => ticket && ticket.id === id) || null;
  }

  async getRun(runId) {
    const id = positiveSafeInteger(runId, 'runId');
    return this.readRuns().find(run => run && run.id === id) || null;
  }

  async listTickets({ statuses = null, afterId = 0, limit = 100 } = {}) {
    const statusFilter = normalizeStatuses(statuses, TICKET_STATUSES, 'ticket status');
    const cursor = nonNegativeSafeInteger(afterId, 'afterId');
    const size = boundedLimit(limit, this.maxQueryRows);
    const allowed = statusFilter ? new Set(statusFilter) : null;
    return pageById(this.readTickets().filter(ticket => !allowed || allowed.has(ticket.status)), {
      afterId: cursor,
      limit: size,
      key: 'tickets'
    });
  }

  async listTicketPage({
    statuses = null,
    workContextId = null,
    cursorUpdatedAt = null,
    cursorId = null,
    direction = 'next',
    limit = 25
  } = {}) {
    const statusFilter = normalizeStatuses(statuses, TICKET_STATUSES, 'ticket status');
    const contextId = nullablePositiveSafeInteger(workContextId, 'workContextId');
    const cursorTimestamp = nullableIsoTimestamp(cursorUpdatedAt, 'cursorUpdatedAt');
    const id = nullablePositiveSafeInteger(cursorId, 'cursorId');
    if ((cursorTimestamp === null) !== (id === null)) {
      throw new TypeError('cursorUpdatedAt and cursorId must be provided together');
    }
    if (!['next', 'previous'].includes(direction)) throw new TypeError(`Unsupported direction: ${direction}`);
    const size = boundedLimit(limit, this.maxQueryRows);
    const allowed = statusFilter ? new Set(statusFilter) : null;
    const filtered = this.readTickets()
      .filter(ticket => ticket && (!allowed || allowed.has(ticket.status)))
      .filter(ticket => contextId === null || ticket.workContextId === contextId)
      .sort(compareNewestTicket);
    const candidates = cursorTimestamp === null
      ? filtered
      : filtered.filter(ticket => {
        const comparison = ticketTupleComparison(ticket, cursorTimestamp, id);
        return direction === 'previous' ? comparison < 0 : comparison > 0;
      });
    const selected = direction === 'previous'
      ? candidates.slice(Math.max(0, candidates.length - size))
      : candidates.slice(0, size);
    const first = selected[0] || null;
    const last = selected[selected.length - 1] || null;
    return {
      tickets: selected,
      hasPrevious: Boolean(first && filtered.some(ticket => ticketTupleComparison(
        ticket,
        String(first.updatedAt || first.createdAt || ''),
        first.id
      ) < 0)),
      hasNext: Boolean(last && filtered.some(ticket => ticketTupleComparison(
        ticket,
        String(last.updatedAt || last.createdAt || ''),
        last.id
      ) > 0))
    };
  }

  async countTicketsByStatus({ workContextId = null } = {}) {
    const contextId = nullablePositiveSafeInteger(workContextId, 'workContextId');
    const counts = { all: 0 };
    for (const status of TICKET_STATUSES) counts[status] = 0;
    for (const ticket of this.readTickets()) {
      if (!ticket || (contextId !== null && ticket.workContextId !== contextId)) continue;
      counts.all += 1;
      if (Object.prototype.hasOwnProperty.call(counts, ticket.status)) counts[ticket.status] += 1;
    }
    return counts;
  }

  async listRuns({ statuses = null, afterId = 0, limit = 100 } = {}) {
    const statusFilter = normalizeStatuses(statuses, RUN_STATUSES, 'run status');
    const cursor = nonNegativeSafeInteger(afterId, 'afterId');
    const size = boundedLimit(limit, this.maxQueryRows);
    const allowed = statusFilter ? new Set(statusFilter) : null;
    return pageById(this.readRuns().filter(run => !allowed || allowed.has(run.status)), {
      afterId: cursor,
      limit: size,
      key: 'runs'
    });
  }

  async listRunsForTicket({ ticketId, afterId = 0, limit = 100 } = {}) {
    const ownerTicketId = positiveSafeInteger(ticketId, 'ticketId');
    const cursor = nonNegativeSafeInteger(afterId, 'afterId');
    const size = boundedLimit(limit, this.maxQueryRows);
    return pageById(this.readRuns().filter(run => run && run.ticketId === ownerTicketId), {
      afterId: cursor,
      limit: size,
      key: 'runs'
    });
  }

  async listRunsForTickets({ ticketIds, statuses = null, afterId = 0, limit = 100 } = {}) {
    const ids = boundedPositiveIds(ticketIds, this.maxQueryRows, 'ticketIds');
    const statusFilter = normalizeStatuses(statuses, RUN_STATUSES, 'run status');
    const cursor = nonNegativeSafeInteger(afterId, 'afterId');
    const size = boundedLimit(limit, this.maxQueryRows);
    const allowedIds = new Set(ids);
    const allowedStatuses = statusFilter ? new Set(statusFilter) : null;
    return pageById(this.readRuns().filter(run => run && allowedIds.has(run.ticketId) &&
      (!allowedStatuses || allowedStatuses.has(run.status))), {
      afterId: cursor,
      limit: size,
      key: 'runs'
    });
  }

  async listLatestRunsForTickets({ ticketIds } = {}) {
    const ids = boundedPositiveIds(ticketIds, this.maxQueryRows, 'ticketIds');
    const allowedIds = new Set(ids);
    const latestByTicketId = new Map();
    for (const run of this.readRuns()) {
      if (!run || !allowedIds.has(run.ticketId)) continue;
      const current = latestByTicketId.get(run.ticketId);
      const candidateTimestamp = String(run.updatedAt || run.createdAt || '');
      const currentTimestamp = current ? String(current.updatedAt || current.createdAt || '') : '';
      if (!current || candidateTimestamp > currentTimestamp ||
          (candidateTimestamp === currentTimestamp && run.id > current.id)) {
        latestByTicketId.set(run.ticketId, run);
      }
    }
    return ids.map(ticketId => latestByTicketId.get(ticketId)).filter(Boolean);
  }

  async getRunAttemptPositions({ runIds } = {}) {
    const ids = boundedPositiveIds(runIds, this.maxQueryRows, 'runIds');
    const runs = this.readRuns();
    const runById = new Map(runs.filter(Boolean).map(run => [run.id, run]));
    const siblingsByTicketId = new Map();
    for (const run of runs) {
      if (!run) continue;
      const siblings = siblingsByTicketId.get(run.ticketId) || [];
      siblings.push(run);
      siblingsByTicketId.set(run.ticketId, siblings);
    }
    for (const siblings of siblingsByTicketId.values()) {
      siblings.sort((left, right) => left.id - right.id);
    }
    return ids.map(runId => {
      const run = runById.get(runId);
      if (!run) return null;
      const siblings = siblingsByTicketId.get(run.ticketId) || [];
      const index = siblings.findIndex(candidate => candidate.id === runId);
      return {
        runId,
        attemptNumber: index >= 0 ? index + 1 : null,
        attemptCount: siblings.length
      };
    }).filter(Boolean);
  }

  async listChildTickets({ parentTicketId, afterId = 0, limit = 100 } = {}) {
    const parentId = positiveSafeInteger(parentTicketId, 'parentTicketId');
    const cursor = nonNegativeSafeInteger(afterId, 'afterId');
    const size = boundedLimit(limit, this.maxQueryRows);
    return pageById(this.readTickets().filter(ticket => ticket && ticket.parentTicketId === parentId), {
      afterId: cursor,
      limit: size,
      key: 'tickets'
    });
  }

  async listRunsNeedingTerminalReconciliation({ afterId = 0, limit = 100 } = {}) {
    const cursor = nonNegativeSafeInteger(afterId, 'afterId');
    const size = boundedLimit(limit, this.maxQueryRows);
    const runs = this.readRuns().filter(run => {
      if (!run || !TERMINAL_RUN_STATUSES.has(run.status)) return false;
      const events = this.readRunScopedEvents(run.id);
      const executionEnded = events.some(event =>
        event && (event.type === 'run.execution_completed' || event.type === 'run.execution_failed'));
      if (!executionEnded) return false;
      const replayFinalized = events.some(event => event &&
        (event.type === 'run.snapshot_finalized' || event.type === 'replay.snapshot.finalized'));
      const terminalized = events.some(event => event && event.type === 'run.terminalized');
      return !replayFinalized || !terminalized;
    });
    return pageById(runs, { afterId: cursor, limit: size, key: 'runs' });
  }

  async listRunEvents(runId, { afterSeq = -1, limit = 100 } = {}) {
    const id = positiveSafeInteger(runId, 'runId');
    const cursor = Number(afterSeq);
    if (!Number.isSafeInteger(cursor) || cursor < -1) {
      throw new TypeError('afterSeq must be a safe integer greater than or equal to -1');
    }
    const size = boundedLimit(limit, this.maxQueryRows);
    return this.readRunScopedEvents(id)
      .filter(event => event && Number.isSafeInteger(event.seq) && event.seq > cursor)
      .sort((left, right) => left.seq - right.seq)
      .slice(0, size);
  }

  async listRunTimelineEvents(runId, { afterPosition = 0, limit = 100 } = {}) {
    const id = positiveSafeInteger(runId, 'runId');
    const cursor = nonNegativeSafeInteger(afterPosition, 'afterPosition');
    const size = boundedLimit(limit, this.maxQueryRows);
    const events = this.getRunEvents(id);
    const page = events.slice(cursor, cursor + size);
    return {
      events: page,
      nextPosition: cursor + page.length < events.length ? cursor + page.length : null
    };
  }

  async listTicketEvents(ticketId, { afterPosition = 0, limit = 100 } = {}) {
    const id = positiveSafeInteger(ticketId, 'ticketId');
    const cursor = nonNegativeSafeInteger(afterPosition, 'afterPosition');
    const size = boundedLimit(limit, this.maxQueryRows);
    const events = this.getTicketEvents(id);
    const page = events.slice(cursor, cursor + size);
    return {
      events: page,
      nextPosition: cursor + page.length < events.length ? cursor + page.length : null
    };
  }

  async getRunEvaluation(runId) {
    const run = await this.getRun(runId);
    if (!run || !run.runEvaluation || typeof run.runEvaluation !== 'object' || Array.isArray(run.runEvaluation)) {
      return null;
    }
    return {
      runId: run.id,
      ticketId: run.ticketId,
      evaluation: run.runEvaluation,
      recordedAt: run.completedAt || run.updatedAt || null
    };
  }

  async getRunConsequence(runId) {
    const run = await this.getRun(runId);
    if (!run || !run.runConsequence || typeof run.runConsequence !== 'object' || Array.isArray(run.runConsequence)) {
      return null;
    }
    return {
      runId: run.id,
      ticketId: run.ticketId,
      consequence: run.runConsequence,
      recordedAt: run.completedAt || run.updatedAt || null
    };
  }

  async listRunOperations(runId, { afterId = 0, limit = 100 } = {}) {
    const id = positiveSafeInteger(runId, 'runId');
    const cursor = nonNegativeSafeInteger(afterId, 'afterId');
    const size = boundedLimit(limit, this.maxQueryRows);
    return this.readOperationHistory()
      .filter(record => record && record.runId === id && record.id > cursor)
      .sort((left, right) => left.id - right.id)
      .slice(0, size);
  }

  async listTicketOperations(ticketId, { afterId = 0, limit = 100 } = {}) {
    const id = positiveSafeInteger(ticketId, 'ticketId');
    const cursor = nonNegativeSafeInteger(afterId, 'afterId');
    const size = boundedLimit(limit, this.maxQueryRows);
    return this.readOperationHistory()
      .filter(record => record && record.ticketId === id && record.id > cursor)
      .sort((left, right) => left.id - right.id)
      .slice(0, size);
  }

  async countRunMutations({ runIds } = {}) {
    const ids = boundedPositiveIds(runIds, this.maxQueryRows, 'runIds');
    const allowedIds = new Set(ids);
    const counts = new Map(ids.map(runId => [runId, 0]));
    for (const record of this.readOperationHistory()) {
      if (!record || !allowedIds.has(record.runId) || !isActualWorkspaceMutation(record)) continue;
      counts.set(record.runId, counts.get(record.runId) + 1);
    }
    return ids.map(runId => ({ runId, count: counts.get(runId) }));
  }
}

module.exports = {
  JsonRuntimeStateReadRepository,
  REQUIRED_RUNTIME_STATE_READ_REPOSITORY_METHODS,
  assertRuntimeStateReadRepository
};

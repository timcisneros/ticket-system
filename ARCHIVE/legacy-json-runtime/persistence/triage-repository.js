'use strict';

const REQUIRED_TRIAGE_REPOSITORY_METHODS = Object.freeze([
  'createRunTriage',
  'resolveTicketTriage',
  'resolveRunTriage',
  'getUnresolvedTriageSummary'
]);

class TriageConflictError extends Error {
  constructor(entity, id, current = null) {
    super(`${entity} ${id} does not have unresolved triage`);
    this.name = 'TriageConflictError';
    this.code = 'TRIAGE_NOT_REQUIRED';
    this.entity = entity;
    this.entityId = id;
    this.current = current;
  }
}

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

function requiredString(value, label) {
  const normalized = String(value === undefined || value === null ? '' : value).trim();
  if (!normalized) throw new TypeError(`${label} is required`);
  return normalized;
}

function boundedLimit(value, maximum) {
  const limit = positiveSafeInteger(value, 'limit');
  if (limit > maximum) throw new RangeError(`limit exceeds the configured maximum of ${maximum}`);
  return limit;
}

function jsonObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value;
}

function timestamp(value, label) {
  const parsed = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new TypeError(`${label} must be a valid timestamp`);
  return parsed.toISOString();
}

function assertTriageRepository(repository) {
  if (!repository || typeof repository !== 'object') throw new TypeError('triage repository is required');
  for (const method of REQUIRED_TRIAGE_REPOSITORY_METHODS) {
    if (typeof repository[method] !== 'function') {
      throw new TypeError(`triage repository must implement ${method}()`);
    }
  }
  return repository;
}

class JsonTriageRepository {
  constructor({
    readTickets,
    writeTickets,
    readRuns,
    writeRuns,
    appendEvent,
    sanitizePayload = value => value,
    now = () => new Date(),
    maxQueryRows = 1_000
  } = {}) {
    this.readTickets = requiredFunction(readTickets, 'readTickets');
    this.writeTickets = requiredFunction(writeTickets, 'writeTickets');
    this.readRuns = requiredFunction(readRuns, 'readRuns');
    this.writeRuns = requiredFunction(writeRuns, 'writeRuns');
    this.appendEvent = requiredFunction(appendEvent, 'appendEvent');
    this.sanitizePayload = requiredFunction(sanitizePayload, 'sanitizePayload');
    this.now = requiredFunction(now, 'now');
    this.maxQueryRows = positiveSafeInteger(maxQueryRows, 'maxQueryRows');
  }

  _clock() {
    return timestamp(this.now(), 'now');
  }

  _triage(value, label = 'triage') {
    return jsonObject(this.sanitizePayload(jsonObject(value, label)), label);
  }

  _createdTriage(value, createdAt) {
    const triage = this._triage(value);
    return {
      ...triage,
      required: true,
      createdAt,
      resolvedAt: null,
      resolvedBy: null,
      resolution: null
    };
  }

  _resolvedTriage(value, resolvedBy, resolution, resolvedAt) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || value.required !== true || value.resolvedAt) {
      return null;
    }
    const triage = this._triage(value, 'current triage');
    return {
      ...triage,
      required: false,
      resolvedAt,
      resolvedBy: requiredString(resolvedBy, 'resolvedBy'),
      resolution: requiredString(resolution, 'resolution')
    };
  }

  async createRunTriage({ runId, triage }) {
    const id = positiveSafeInteger(runId, 'runId');
    const runs = this.readRuns();
    const run = runs.find(item => item && item.id === id) || null;
    if (!run) return null;
    if (run.triage) {
      return { run, triage: run.triage, event: null, created: false };
    }
    const createdAt = this._clock();
    const document = this._createdTriage(triage, createdAt);
    run.triage = document;
    run.updatedAt = createdAt;
    this.writeRuns(runs);
    let event;
    try {
      event = await this.appendEvent({
        type: 'run.triage_created',
        ticketId: run.ticketId,
        runId: run.id,
        payload: { triage: document }
      });
    } catch (error) {
      error.triageRun = run;
      throw error;
    }
    return { run, triage: document, event, created: true };
  }

  async resolveTicketTriage({ ticketId, resolvedBy, resolution }) {
    const id = positiveSafeInteger(ticketId, 'ticketId');
    const actor = requiredString(resolvedBy, 'resolvedBy');
    const note = requiredString(resolution, 'resolution');
    const tickets = this.readTickets();
    const ticket = tickets.find(item => item && item.id === id) || null;
    if (!ticket) return null;
    if (!ticket.triage || ticket.triage.required !== true || ticket.triage.resolvedAt) {
      throw new TriageConflictError('ticket', id, ticket);
    }
    const resolvedAt = this._clock();
    const document = this._resolvedTriage(ticket.triage, actor, note, resolvedAt);
    ticket.triage = document;
    ticket.updatedAt = resolvedAt;
    this.writeTickets(tickets);
    let event;
    try {
      event = await this.appendEvent({
        type: 'ticket.triage_resolved',
        ticketId: ticket.id,
        payload: { triage: document }
      });
    } catch (error) {
      error.triageTicket = ticket;
      throw error;
    }
    return { ticket, triage: document, event };
  }

  async resolveRunTriage({ runId, resolvedBy, resolution }) {
    const id = positiveSafeInteger(runId, 'runId');
    const actor = requiredString(resolvedBy, 'resolvedBy');
    const note = requiredString(resolution, 'resolution');
    const runs = this.readRuns();
    const run = runs.find(item => item && item.id === id) || null;
    if (!run) return null;
    if (!run.triage || run.triage.required !== true || run.triage.resolvedAt) {
      throw new TriageConflictError('run', id, run);
    }
    const resolvedAt = this._clock();
    const document = this._resolvedTriage(run.triage, actor, note, resolvedAt);
    run.triage = document;
    run.updatedAt = resolvedAt;
    this.writeRuns(runs);
    let event;
    try {
      event = await this.appendEvent({
        type: 'run.triage_resolved',
        ticketId: run.ticketId,
        runId: run.id,
        payload: { triage: document }
      });
    } catch (error) {
      error.triageRun = run;
      throw error;
    }
    return { run, triage: document, event };
  }

  async getUnresolvedTriageSummary({ limit = 10 } = {}) {
    const size = boundedLimit(limit, this.maxQueryRows);
    const unresolved = item => Boolean(item && item.triage && item.triage.required === true && !item.triage.resolvedAt);
    const tickets = this.readTickets().filter(unresolved);
    const runs = this.readRuns().filter(unresolved);
    return {
      unresolvedTicketCount: tickets.length,
      unresolvedRunCount: runs.length,
      recentTickets: tickets
        .slice()
        .sort((left, right) => right.id - left.id)
        .slice(0, size)
        .map(ticket => ({
          ticketId: ticket.id,
          reasonCode: ticket.triage.reasonCode || null
        }))
    };
  }
}

module.exports = {
  JsonTriageRepository,
  REQUIRED_TRIAGE_REPOSITORY_METHODS,
  TriageConflictError,
  assertTriageRepository
};

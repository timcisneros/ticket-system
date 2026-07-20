'use strict';

const { deriveProcessTemplateState } = require('../process-template-projection');

const REQUIRED_PROCESS_TEMPLATE_PROJECTION_REPOSITORY_METHODS = Object.freeze([
  'listProcessTemplateStates',
  'getProcessTemplateStateById',
  'getProcessTemplateCounts',
  'getProcessTemplateCountsByWorkContextIds',
  'getProcessTemplateTriggerProvenance'
]);

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

function optionalPositiveSafeInteger(value, label) {
  if (value === null || value === undefined) return null;
  return positiveSafeInteger(value, label);
}

function boundedPositiveIds(value, maximum, label) {
  if (!Array.isArray(value) || value.length === 0) throw new TypeError(`${label} must be a non-empty array`);
  const ids = [...new Set(value.map((id, index) => positiveSafeInteger(id, `${label}[${index}]`)))];
  if (ids.length > maximum) throw new RangeError(`${label} exceeds the configured maximum of ${maximum}`);
  return ids;
}

function normalizeTemplate(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return null;
  const id = positiveSafeInteger(record.id, 'processTemplate.id');
  return { ...structuredClone(record), id };
}

function assertProcessTemplateProjectionRepository(repository) {
  if (!repository || typeof repository !== 'object') throw new TypeError('process-template projection repository is required');
  for (const method of REQUIRED_PROCESS_TEMPLATE_PROJECTION_REPOSITORY_METHODS) {
    if (typeof repository[method] !== 'function') {
      throw new TypeError(`process-template projection repository must implement ${method}()`);
    }
  }
  return repository;
}

class JsonProcessTemplateProjectionRepository {
  constructor({ readProcessTemplates, readProcessTemplateTriggers, readTickets, maxQueryRows = 1_000 } = {}) {
    this.readProcessTemplates = requiredFunction(readProcessTemplates, 'readProcessTemplates');
    this.readProcessTemplateTriggers = requiredFunction(readProcessTemplateTriggers, 'readProcessTemplateTriggers');
    this.readTickets = requiredFunction(readTickets, 'readTickets');
    this.maxQueryRows = positiveSafeInteger(maxQueryRows, 'maxQueryRows');
  }

  _templates() {
    const rows = this.readProcessTemplates();
    if (!Array.isArray(rows)) throw new TypeError('process-template store must be an array');
    return structuredClone(rows).map(normalizeTemplate).filter(Boolean);
  }

  _ticketsFor(templateIds) {
    const allowed = new Set(templateIds);
    const rows = this.readTickets();
    if (!Array.isArray(rows)) throw new TypeError('ticket store must be an array');
    return structuredClone(rows).filter(ticket => {
      const source = ticket && ticket.source;
      return source && source.type === 'process_template' && allowed.has(Number(source.templateId));
    });
  }

  _boundedLimit(limit) {
    const size = positiveSafeInteger(limit, 'limit');
    if (size > this.maxQueryRows) throw new RangeError(`limit exceeds the configured maximum of ${this.maxQueryRows}`);
    return size;
  }

  async listProcessTemplateStates({ afterId = 0, workContextId = null, limit = 100, now = Date.now() } = {}) {
    const cursor = nonNegativeSafeInteger(afterId, 'afterId');
    const contextId = optionalPositiveSafeInteger(workContextId, 'workContextId');
    const size = this._boundedLimit(limit);
    const matches = this._templates()
      .filter(template => template.id > cursor && (contextId === null || template.workContextId === contextId))
      .sort((left, right) => left.id - right.id)
      .slice(0, size + 1);
    const roots = matches.slice(0, size);
    const stateById = new Map(
      deriveProcessTemplateState(roots, this._ticketsFor(roots.map(template => template.id)), now)
        .map(state => [state.templateId, state])
    );
    const processTemplates = roots.map(template => ({ ...template, ...stateById.get(template.id) }));
    return {
      processTemplates,
      nextAfterId: matches.length > size && processTemplates.length > 0
        ? processTemplates[processTemplates.length - 1].id
        : null
    };
  }

  async getProcessTemplateStateById(templateId, { now = Date.now() } = {}) {
    const id = positiveSafeInteger(templateId, 'templateId');
    const template = this._templates().find(item => item.id === id) || null;
    if (!template) return null;
    const state = deriveProcessTemplateState([template], this._ticketsFor([id]), now)[0];
    return { ...template, ...state };
  }

  async getProcessTemplateCounts() {
    const templates = this._templates();
    const enabled = templates.filter(template => template.enabled === true).length;
    return {
      total: templates.length,
      enabled,
      disabled: templates.length - enabled,
      scheduled: templates.filter(template => template.schedule && template.schedule.enabled === true).length,
      pausedSchedule: templates.filter(template => template.schedule && template.schedule.enabled === false).length
    };
  }

  async getProcessTemplateCountsByWorkContextIds({ workContextIds }) {
    const ids = boundedPositiveIds(workContextIds, this.maxQueryRows, 'workContextIds');
    const counts = new Map(ids.map(id => [id, { workContextId: id, processTemplateCount: 0, scheduledTemplateCount: 0 }]));
    for (const template of this._templates()) {
      const row = counts.get(template.workContextId);
      if (!row) continue;
      row.processTemplateCount += 1;
      if (template.schedule && template.schedule.enabled === true) row.scheduledTemplateCount += 1;
    }
    return ids.map(id => counts.get(id));
  }

  async getProcessTemplateTriggerProvenance({ ticketId = null, triggerToken = null } = {}) {
    const id = ticketId === null || ticketId === undefined ? null : positiveSafeInteger(ticketId, 'ticketId');
    const token = triggerToken === null || triggerToken === undefined ? null : String(triggerToken).trim();
    if (id === null && !token) throw new TypeError('ticketId or triggerToken is required');
    const rows = this.readProcessTemplateTriggers();
    if (!Array.isArray(rows)) throw new TypeError('process-template trigger store must be an array');
    const matches = structuredClone(rows).filter(entry => entry && (
      (id !== null && entry.ticketId === id) || (token && entry.triggerToken === token)
    ));
    matches.sort((left, right) => {
      const leftExact = id !== null && left.ticketId === id ? 0 : 1;
      const rightExact = id !== null && right.ticketId === id ? 0 : 1;
      if (leftExact !== rightExact) return leftExact - rightExact;
      return Number(right.id || 0) - Number(left.id || 0);
    });
    return matches[0] || null;
  }
}

module.exports = {
  JsonProcessTemplateProjectionRepository,
  REQUIRED_PROCESS_TEMPLATE_PROJECTION_REPOSITORY_METHODS,
  assertProcessTemplateProjectionRepository
};

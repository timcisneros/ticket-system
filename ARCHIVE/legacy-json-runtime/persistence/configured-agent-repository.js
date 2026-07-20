'use strict';

const { AccessCatalogReferenceError } = require('../access-catalog');

const REQUIRED_CONFIGURED_AGENT_REPOSITORY_METHODS = Object.freeze([
  'listConfiguredAgents',
  'getConfiguredAgentById',
  'getConfiguredAgentByName',
  'getConfiguredAgentsByIds',
  'listConfiguredAgentsByGroup',
  'listAgentGroupMemberships',
  'createConfiguredAgent',
  'updateConfiguredAgent',
  'deleteConfiguredAgent',
  'removeConfiguredAgentMembershipsForGroup'
]);

class ConfiguredAgentConflictError extends Error {
  constructor(id, expectedRevision, current = null) {
    super(`configuredAgent ${id} did not match expected revision ${expectedRevision}`);
    this.name = 'ConfiguredAgentConflictError';
    this.code = 'OPTIMISTIC_CONCURRENCY_CONFLICT';
    this.entity = 'configuredAgent';
    this.entityId = id;
    this.expectedRevision = expectedRevision;
    this.current = current;
  }
}

class ConfiguredAgentNameConflictError extends Error {
  constructor(name) {
    super(`Configured agent name already exists: ${name}`);
    this.name = 'ConfiguredAgentNameConflictError';
    this.code = 'CONFIGURED_AGENT_NAME_CONFLICT';
    this.nameValue = name;
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

function timestamp(value, label) {
  const parsed = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new TypeError(`${label} must be a valid timestamp`);
  return parsed.toISOString();
}

function normalizeProviders(value) {
  if (value === null || value === undefined) return null;
  if (!Array.isArray(value) || value.length === 0) throw new TypeError('providers must be a non-empty array');
  const providers = [...new Set(value.map(item => requiredString(item, 'provider')))];
  for (const provider of providers) {
    if (!['openai', 'ollama'].includes(provider)) throw new TypeError(`Unsupported configured-agent provider: ${provider}`);
  }
  return providers;
}

function normalizeIds(value, label, maximum, { allowEmpty = true } = {}) {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0)) throw new TypeError(`${label} must be an array`);
  const ids = [...new Set(value.map((id, index) => positiveSafeInteger(id, `${label}[${index}]`)))];
  if (ids.length > maximum) throw new RangeError(`${label} exceeds the configured maximum of ${maximum}`);
  return ids;
}

function normalizeValue(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('value must be an object');
  const record = structuredClone(value);
  record.name = requiredString(record.name, 'value.name');
  record.provider = requiredString(record.provider, 'value.provider');
  if (!['openai', 'ollama'].includes(record.provider)) throw new TypeError(`Unsupported configured-agent provider: ${record.provider}`);
  record.type = 'agent';
  record.model = String(record.model === undefined || record.model === null ? '' : record.model).trim();
  record.apiKey = String(record.apiKey === undefined || record.apiKey === null ? '' : record.apiKey).trim();
  for (const key of ['id', 'revision', 'groupIds', 'createdAt', 'changedBy', 'changedAt']) delete record[key];
  return record;
}

function normalizeRecord(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return null;
  const id = positiveSafeInteger(record.id, 'configuredAgent.id');
  const provider = requiredString(record.provider || 'openai', 'configuredAgent.provider');
  if (!['openai', 'ollama'].includes(provider)) throw new TypeError(`Unsupported configured-agent provider: ${provider}`);
  return {
    ...structuredClone(record),
    id,
    name: requiredString(record.name, 'configuredAgent.name'),
    type: 'agent',
    provider,
    model: String(record.model === undefined || record.model === null ? '' : record.model),
    apiKey: String(record.apiKey === undefined || record.apiKey === null ? '' : record.apiKey),
    revision: Number.isSafeInteger(record.revision) && record.revision > 0 ? record.revision : 1
  };
}

function normalizeMembership(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return null;
  const principalType = record.principalType === 'agent' ? 'agent' : record.principalType === 'user' ? 'user' : null;
  const principalId = Number(record.principalId ?? record.userId);
  const groupId = Number(record.groupId);
  if (!principalType || !Number.isSafeInteger(principalId) || principalId <= 0 || !Number.isSafeInteger(groupId) || groupId <= 0) return null;
  return { ...structuredClone(record), principalType, principalId, groupId };
}

function assertConfiguredAgentRepository(repository) {
  if (!repository || typeof repository !== 'object') throw new TypeError('configured agent repository is required');
  for (const method of REQUIRED_CONFIGURED_AGENT_REPOSITORY_METHODS) {
    if (typeof repository[method] !== 'function') throw new TypeError(`configured agent repository must implement ${method}()`);
  }
  return repository;
}

class JsonConfiguredAgentRepository {
  constructor({ readAgents, writeAgents, readGroups, readMemberships, writeMemberships, appendSystemLog, queueMutation = null, now = () => new Date(), maxQueryRows = 1_000 } = {}) {
    this.readAgents = requiredFunction(readAgents, 'readAgents');
    this.writeAgents = requiredFunction(writeAgents, 'writeAgents');
    this.readGroups = requiredFunction(readGroups, 'readGroups');
    this.readMemberships = requiredFunction(readMemberships, 'readMemberships');
    this.writeMemberships = requiredFunction(writeMemberships, 'writeMemberships');
    this.appendSystemLog = requiredFunction(appendSystemLog, 'appendSystemLog');
    this.now = requiredFunction(now, 'now');
    this.maxQueryRows = positiveSafeInteger(maxQueryRows, 'maxQueryRows');
    this.mutationTail = Promise.resolve();
    this.queueMutation = queueMutation === null
      ? operation => {
          const result = this.mutationTail.then(operation, operation);
          this.mutationTail = result.catch(() => {});
          return result;
        }
      : requiredFunction(queueMutation, 'queueMutation');
  }

  _readRawAgents() { return structuredClone(this.readAgents()); }
  _readAgents() { return this._readRawAgents().map(normalizeRecord).filter(Boolean); }
  _validateGroupIds(groupIds) {
    const ids = normalizeIds(groupIds, 'groupIds', this.maxQueryRows);
    const available = new Set(this.readGroups().map(group => positiveSafeInteger(group.id, 'group.id')));
    const missing = ids.find(id => !available.has(id));
    if (missing) throw new AccessCatalogReferenceError(`Group does not exist: `, 'GROUP_NOT_FOUND');
    return ids;
  }
  _readRawMemberships() { return structuredClone(this.readMemberships()); }
  _readMemberships() { return this._readRawMemberships().map(normalizeMembership).filter(Boolean); }

  _boundedLimit(limit) {
    const size = positiveSafeInteger(limit, 'limit');
    if (size > this.maxQueryRows) throw new RangeError(`limit exceeds the configured maximum of ${this.maxQueryRows}`);
    return size;
  }

  _queueMutation(operation) {
    return this.queueMutation(operation);
  }

  async listConfiguredAgents({ afterId = 0, providers = null, limit = 100 } = {}) {
    const cursor = nonNegativeSafeInteger(afterId, 'afterId');
    const size = this._boundedLimit(limit);
    const allowed = normalizeProviders(providers);
    const matches = this._readAgents()
      .filter(agent => agent.id > cursor && (!allowed || allowed.includes(agent.provider)))
      .sort((left, right) => left.id - right.id)
      .slice(0, size + 1);
    const agents = matches.slice(0, size);
    return { agents, nextAfterId: matches.length > size && agents.length > 0 ? agents[agents.length - 1].id : null };
  }

  async _withGroupIds(agent) {
    if (!agent) return null;
    const groupIds = this._readMemberships()
      .filter(item => item.principalType === 'agent' && item.principalId === agent.id)
      .map(item => item.groupId);
    if (groupIds.length > this.maxQueryRows) throw new RangeError(`agent ${agent.id} group memberships exceed the configured maximum`);
    return { ...structuredClone(agent), groupIds: [...new Set(groupIds)].sort((left, right) => left - right) };
  }

  async getConfiguredAgentById(agentId) {
    const id = positiveSafeInteger(agentId, 'agentId');
    return this._withGroupIds(this._readAgents().find(agent => agent.id === id) || null);
  }

  async getConfiguredAgentByName(name, { caseInsensitive = false } = {}) {
    const normalized = requiredString(name, 'name');
    const agents = this._readAgents();
    const exact = agents.find(agent => agent.name === normalized) || null;
    if (exact || caseInsensitive !== true) return this._withGroupIds(exact);
    const lower = normalized.toLowerCase();
    const match = agents
      .filter(agent => agent.name.toLowerCase() === lower)
      .sort((left, right) => left.id - right.id)[0] || null;
    return this._withGroupIds(match);
  }

  async getConfiguredAgentsByIds({ agentIds }) {
    const ids = normalizeIds(agentIds, 'agentIds', this.maxQueryRows, { allowEmpty: false });
    const allowed = new Set(ids);
    return this._readAgents()
      .filter(agent => allowed.has(agent.id))
      .sort((left, right) => left.id - right.id);
  }

  async listConfiguredAgentsByGroup({ groupId, afterId = 0, limit = 100 } = {}) {
    const id = positiveSafeInteger(groupId, 'groupId');
    const cursor = nonNegativeSafeInteger(afterId, 'afterId');
    const size = this._boundedLimit(limit);
    const agentIds = new Set(this._readMemberships()
      .filter(item => item.principalType === 'agent' && item.groupId === id)
      .map(item => item.principalId));
    const matches = this._readAgents()
      .filter(agent => agent.id > cursor && agentIds.has(agent.id))
      .sort((left, right) => left.id - right.id)
      .slice(0, size + 1);
    const agents = matches.slice(0, size);
    return { agents, nextAfterId: matches.length > size && agents.length > 0 ? agents[agents.length - 1].id : null };
  }

  async listAgentGroupMemberships({ afterAgentId = 0, afterGroupId = 0, agentIds = null, groupIds = null, limit = 100 } = {}) {
    const agentCursor = nonNegativeSafeInteger(afterAgentId, 'afterAgentId');
    const groupCursor = nonNegativeSafeInteger(afterGroupId, 'afterGroupId');
    const size = this._boundedLimit(limit);
    const allowedAgents = agentIds === null || agentIds === undefined ? null : new Set(normalizeIds(agentIds, 'agentIds', this.maxQueryRows, { allowEmpty: false }));
    const allowedGroups = groupIds === null || groupIds === undefined ? null : new Set(normalizeIds(groupIds, 'groupIds', this.maxQueryRows, { allowEmpty: false }));
    const matches = this._readMemberships()
      .filter(item => item.principalType === 'agent')
      .filter(item => item.principalId > agentCursor || (item.principalId === agentCursor && item.groupId > groupCursor))
      .filter(item => !allowedAgents || allowedAgents.has(item.principalId))
      .filter(item => !allowedGroups || allowedGroups.has(item.groupId))
      .sort((left, right) => left.principalId - right.principalId || left.groupId - right.groupId)
      .slice(0, size + 1);
    const memberships = matches.slice(0, size).map(item => ({ agentId: item.principalId, groupId: item.groupId }));
    const last = memberships[memberships.length - 1] || null;
    return {
      memberships,
      nextCursor: matches.length > size && last ? { afterAgentId: last.agentId, afterGroupId: last.groupId } : null
    };
  }

  _nextMemberships(rawMemberships, agentId, groupIds, { deleting = false } = {}) {
    const retained = rawMemberships.filter(item => {
      const membership = normalizeMembership(item);
      return !membership || membership.principalType !== 'agent' || membership.principalId !== agentId;
    });
    if (deleting) return retained;
    let nextMembershipId = retained.reduce((maximum, item) => {
      const id = Number(item && item.id);
      return Number.isSafeInteger(id) && id > maximum ? id : maximum;
    }, 0) + 1;
    return [...retained, ...groupIds.map(groupId => ({
      id: nextMembershipId++, principalType: 'agent', principalId: agentId, groupId
    }))];
  }

  async _writeWithAudit({ nextAgents, nextMemberships, rollbackAgents, rollbackMemberships, audit }) {
    try {
      this.writeAgents(nextAgents);
      this.writeMemberships(nextMemberships);
      return await this.appendSystemLog(audit);
    } catch (error) {
      try { this.writeAgents(rollbackAgents); } catch (_) {}
      try { this.writeMemberships(rollbackMemberships); } catch (_) {}
      throw error;
    }
  }

  createConfiguredAgent(options) { return this._queueMutation(() => this._createConfiguredAgent(options)); }
  async _createConfiguredAgent({ value, groupIds = [], changedBy }) {
    const body = normalizeValue(value);
    const groups = this._validateGroupIds(groupIds);
    const actor = requiredString(changedBy, 'changedBy');
    const rollbackAgents = this._readRawAgents();
    const rollbackMemberships = this._readRawMemberships();
    const agents = rollbackAgents.map(normalizeRecord).filter(Boolean);
    if (agents.some(agent => agent.name === body.name)) throw new ConfiguredAgentNameConflictError(body.name);
    const changedAt = timestamp(this.now(), 'now');
    const agent = {
      id: agents.reduce((maximum, item) => Math.max(maximum, item.id), 0) + 1,
      ...body,
      revision: 1,
      createdAt: changedAt,
      changedBy: actor,
      changedAt
    };
    const nextMemberships = this._nextMemberships(rollbackMemberships, agent.id, groups);
    const auditLog = await this._writeWithAudit({
      nextAgents: [...agents, agent], nextMemberships, rollbackAgents, rollbackMemberships,
      audit: {
        type: 'admin:agent_create',
        message: `Agent \"${agent.name}\" created by ${actor}`,
        metadata: { changedBy: actor, changedAt, targetAgentId: agent.id, targetAgentName: agent.name, provider: agent.provider }
      }
    });
    return { agent: { ...structuredClone(agent), groupIds: groups }, auditLog };
  }

  updateConfiguredAgent(options) { return this._queueMutation(() => this._updateConfiguredAgent(options)); }
  async _updateConfiguredAgent({ agentId, expectedRevision, value, groupIds = [], changedBy }) {
    const id = positiveSafeInteger(agentId, 'agentId');
    const revision = positiveSafeInteger(expectedRevision, 'expectedRevision');
    const body = normalizeValue(value);
    const groups = this._validateGroupIds(groupIds);
    const actor = requiredString(changedBy, 'changedBy');
    const rollbackAgents = this._readRawAgents();
    const rollbackMemberships = this._readRawMemberships();
    const agents = rollbackAgents.map(normalizeRecord).filter(Boolean);
    const index = agents.findIndex(agent => agent.id === id);
    if (index === -1) return null;
    if (agents[index].revision !== revision) throw new ConfiguredAgentConflictError(id, revision, structuredClone(agents[index]));
    if (agents.some(agent => agent.name === body.name && agent.id !== id)) throw new ConfiguredAgentNameConflictError(body.name);
    const changedAt = timestamp(this.now(), 'now');
    const previous = agents[index];
    const agent = { ...previous, ...body, id, revision: revision + 1, createdAt: previous.createdAt, changedBy: actor, changedAt };
    const nextAgents = agents.slice();
    nextAgents[index] = agent;
    const nextMemberships = this._nextMemberships(rollbackMemberships, id, groups);
    const auditLog = await this._writeWithAudit({
      nextAgents, nextMemberships, rollbackAgents, rollbackMemberships,
      audit: {
        type: 'admin:agent_edit',
        message: `Agent \"${agent.name}\" (#${id}) edited by ${actor}`,
        metadata: { changedBy: actor, changedAt, targetAgentId: id, targetAgentName: agent.name }
      }
    });
    return { agent: { ...structuredClone(agent), groupIds: groups }, auditLog };
  }

  deleteConfiguredAgent(options) { return this._queueMutation(() => this._deleteConfiguredAgent(options)); }
  async _deleteConfiguredAgent({ agentId, expectedRevision, changedBy }) {
    const id = positiveSafeInteger(agentId, 'agentId');
    const revision = positiveSafeInteger(expectedRevision, 'expectedRevision');
    const actor = requiredString(changedBy, 'changedBy');
    const rollbackAgents = this._readRawAgents();
    const rollbackMemberships = this._readRawMemberships();
    const agents = rollbackAgents.map(normalizeRecord).filter(Boolean);
    const agent = agents.find(item => item.id === id);
    if (!agent) return null;
    if (agent.revision !== revision) throw new ConfiguredAgentConflictError(id, revision, structuredClone(agent));
    const changedAt = timestamp(this.now(), 'now');
    const auditLog = await this._writeWithAudit({
      nextAgents: agents.filter(item => item.id !== id),
      nextMemberships: this._nextMemberships(rollbackMemberships, id, [], { deleting: true }),
      rollbackAgents,
      rollbackMemberships,
      audit: {
        type: 'admin:agent_delete',
        message: `Agent \"${agent.name}\" deleted by ${actor}`,
        metadata: { changedBy: actor, changedAt, targetAgentId: id, targetAgentName: agent.name }
      }
    });
    return { agent: { ...structuredClone(agent) }, auditLog };
  }

  removeConfiguredAgentMembershipsForGroup(options) { return this._queueMutation(() => this._removeConfiguredAgentMembershipsForGroup(options)); }
  async _removeConfiguredAgentMembershipsForGroup({ groupId }) {
    const id = positiveSafeInteger(groupId, 'groupId');
    const memberships = this._readRawMemberships();
    const matches = memberships.filter(item => {
      const membership = normalizeMembership(item);
      return membership && membership.principalType === 'agent' && membership.groupId === id;
    });
    if (matches.length > this.maxQueryRows) {
      throw new RangeError(`group ${id} agent memberships exceed the configured maximum`);
    }
    this.writeMemberships(memberships.filter(item => {
      const membership = normalizeMembership(item);
      return !membership || membership.principalType !== 'agent' || membership.groupId !== id;
    }));
    return { removedCount: matches.length };
  }
}

module.exports = {
  ConfiguredAgentConflictError,
  ConfiguredAgentNameConflictError,
  JsonConfiguredAgentRepository,
  REQUIRED_CONFIGURED_AGENT_REPOSITORY_METHODS,
  assertConfiguredAgentRepository
};

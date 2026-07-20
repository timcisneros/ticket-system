'use strict';

const {
  REQUIRED_MODEL_ROUTING_POLICY_REPOSITORY_METHODS,
  ModelRoutingPolicyConflictError,
  ModelRoutingPolicyIdConflictError,
  ModelRoutingPolicyReferenceError,
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
} = require('../model-routing-policy-catalog');

class JsonModelRoutingPolicyRepository {
  constructor({
    readPolicies,
    writePolicies,
    readWorkContexts,
    appendSystemLog,
    queueMutation = null,
    now = () => new Date(),
    maxQueryRows = 1_000
  } = {}) {
    this.readPolicies = requiredFunction(readPolicies, 'readPolicies');
    this.writePolicies = requiredFunction(writePolicies, 'writePolicies');
    this.readWorkContexts = requiredFunction(readWorkContexts, 'readWorkContexts');
    this.appendSystemLog = requiredFunction(appendSystemLog, 'appendSystemLog');
    this.now = requiredFunction(now, 'now');
    this.maxQueryRows = positiveSafeInteger(maxQueryRows, 'maxQueryRows');
    this.mutationTail = Promise.resolve();
    this.queueMutation = queueMutation === null
      ? operation => {
          const result = this.mutationTail.then(operation, operation);
          this.mutationTail = result.then(() => undefined, () => undefined);
          return result;
        }
      : requiredFunction(queueMutation, 'queueMutation');
  }

  _readRaw() {
    const records = this.readPolicies();
    if (!Array.isArray(records)) throw new TypeError('model routing policy catalog must be an array');
    return structuredClone(records);
  }

  _workContextIds() {
    const records = this.readWorkContexts();
    if (!Array.isArray(records)) throw new TypeError('Work Context catalog must be an array');
    return new Set(records.map(item => item && item.id).filter(id => Number.isSafeInteger(id) && id > 0));
  }

  _read() {
    const records = this._readRaw().map(normalizeModelRoutingPolicyRecord);
    const seen = new Set();
    const workContextIds = this._workContextIds();
    for (const policy of records) {
      if (seen.has(policy.id)) throw new ModelRoutingPolicyIdConflictError(policy.id);
      seen.add(policy.id);
      if (policy.workContextId !== null && !workContextIds.has(policy.workContextId)) {
        throw new ModelRoutingPolicyReferenceError(
          `Routing policy ${policy.id} references missing Work Context ${policy.workContextId}`,
          'WORK_CONTEXT_NOT_FOUND'
        );
      }
    }
    return records;
  }

  _limit(limit) {
    const size = positiveSafeInteger(limit, 'limit');
    if (size > this.maxQueryRows) throw new RangeError(`limit exceeds the configured maximum of ${this.maxQueryRows}`);
    return size;
  }

  _assertWorkContext(workContextId) {
    if (workContextId !== null && !this._workContextIds().has(workContextId)) {
      throw new ModelRoutingPolicyReferenceError(
        `Work Context not found: ${workContextId}`,
        'WORK_CONTEXT_NOT_FOUND'
      );
    }
  }

  async listModelRoutingPolicies({ afterId = 0, statuses = null, limit = 100 } = {}) {
    const cursor = nonNegativeSafeInteger(afterId, 'afterId');
    const size = this._limit(limit);
    const allowed = normalizeStatuses(statuses);
    const matches = this._read()
      .filter(item => item.id > cursor && (!allowed || allowed.includes(item.status)))
      .sort((left, right) => left.id - right.id)
      .slice(0, size + 1);
    const policies = matches.slice(0, size);
    return {
      policies,
      nextAfterId: matches.length > size && policies.length > 0 ? policies[policies.length - 1].id : null
    };
  }

  async getModelRoutingPolicyById(policyId) {
    const id = positiveSafeInteger(policyId, 'policyId');
    return this._read().find(item => item.id === id) || null;
  }

  async getModelRoutingPolicyCounts() {
    const counts = { active: 0, archived: 0, total: 0 };
    for (const policy of this._read()) {
      counts.total += 1;
      if (policy.status === 'active') counts.active += 1;
      if (policy.status === 'archived') counts.archived += 1;
    }
    return counts;
  }

  async findApplicableModelRoutingPolicy({ explicitPolicyId = null, workContextId = null, capabilityId = null } = {}) {
    const explicitId = nullablePositiveSafeInteger(explicitPolicyId, 'explicitPolicyId');
    const contextId = nullablePositiveSafeInteger(workContextId, 'workContextId');
    const capability = nullableString(capabilityId);
    const active = this._read().filter(item => item.status === 'active').sort((left, right) => left.id - right.id);
    if (explicitId !== null) {
      const explicit = active.find(item => item.id === explicitId) || null;
      if (explicit) return { policy: explicit, reason: 'explicit_override' };
    }
    const tiers = [
      active.filter(item => contextId !== null && capability !== null && item.workContextId === contextId && item.capabilityId === capability),
      active.filter(item => contextId !== null && item.workContextId === contextId && item.capabilityId === null),
      active.filter(item => capability !== null && item.workContextId === null && item.capabilityId === capability),
      active.filter(item => item.workContextId === null && item.capabilityId === null)
    ];
    for (const tier of tiers) {
      if (tier.length > 0) return { policy: tier[0], reason: 'policy_preferred' };
    }
    return { policy: null, reason: 'no_policy' };
  }

  async _appendAuditOrRollback(rollback, audit) {
    if (!audit) return null;
    try {
      return await this.appendSystemLog(audit);
    } catch (error) {
      this.writePolicies(rollback);
      throw error;
    }
  }

  createModelRoutingPolicy({ value, changedBy, audit = null }) {
    return this.queueMutation(async () => {
      const body = normalizeModelRoutingPolicyValue(value);
      const actor = requiredString(changedBy, 'changedBy');
      this._assertWorkContext(body.workContextId);
      const rollback = this._readRaw();
      const policies = this._read();
      const now = timestamp(this.now(), 'now');
      const policy = {
        id: policies.reduce((maximum, item) => Math.max(maximum, item.id), 0) + 1,
        ...body,
        revision: 1,
        createdBy: actor,
        createdAt: now,
        updatedBy: actor,
        updatedAt: now
      };
      this.writePolicies([...policies, policy].sort((left, right) => left.id - right.id));
      const auditLog = await this._appendAuditOrRollback(rollback, audit ? {
        ...audit,
        metadata: { ...(audit.metadata || {}), policyId: policy.id }
      } : null);
      return { policy: structuredClone(policy), auditLog };
    });
  }

  updateModelRoutingPolicy({ policyId, expectedRevision, value, changedBy, audit = null }) {
    return this.queueMutation(async () => {
      const id = positiveSafeInteger(policyId, 'policyId');
      const revision = positiveSafeInteger(expectedRevision, 'expectedRevision');
      const body = normalizeModelRoutingPolicyValue(value);
      const actor = requiredString(changedBy, 'changedBy');
      this._assertWorkContext(body.workContextId);
      const rollback = this._readRaw();
      const policies = this._read();
      const index = policies.findIndex(item => item.id === id);
      if (index === -1) return null;
      const current = policies[index];
      if (current.revision !== revision) {
        throw new ModelRoutingPolicyConflictError(id, revision, structuredClone(current));
      }
      const policy = {
        ...body,
        id,
        revision: revision + 1,
        createdBy: current.createdBy,
        createdAt: current.createdAt,
        updatedBy: actor,
        updatedAt: timestamp(this.now(), 'now')
      };
      policies[index] = policy;
      this.writePolicies(policies);
      const auditLog = await this._appendAuditOrRollback(rollback, audit ? {
        ...audit,
        metadata: { ...(audit.metadata || {}), policyId: policy.id }
      } : null);
      return { policy: structuredClone(policy), auditLog };
    });
  }
}

module.exports = { JsonModelRoutingPolicyRepository, REQUIRED_MODEL_ROUTING_POLICY_REPOSITORY_METHODS };

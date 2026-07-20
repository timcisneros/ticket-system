'use strict';

const {
  ModelRoutingPolicyReferenceError,
  nonNegativeSafeInteger,
  normalizeModelRoutingPolicyValue,
  normalizeStatuses,
  nullablePositiveSafeInteger,
  nullableString,
  positiveSafeInteger,
  requiredString
} = require('../model-routing-policy-catalog');

function rowTimestamp(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new TypeError('PostgreSQL returned an invalid timestamp');
  return date.toISOString();
}

function policyFromRow(row) {
  const body = row.body && typeof row.body === 'object' && !Array.isArray(row.body) ? row.body : {};
  return {
    id: positiveSafeInteger(row.id, 'modelRoutingPolicy.id'),
    ...body,
    name: row.name,
    status: row.status,
    workContextId: row.work_context_id === null ? null : positiveSafeInteger(row.work_context_id, 'modelRoutingPolicy.workContextId'),
    capabilityId: row.capability_id || null,
    revision: positiveSafeInteger(row.revision, 'modelRoutingPolicy.revision'),
    createdBy: row.created_by,
    createdAt: rowTimestamp(row.created_at),
    updatedBy: row.updated_by,
    updatedAt: rowTimestamp(row.updated_at)
  };
}

function safeCount(value, label) {
  const count = Number(value);
  if (!Number.isSafeInteger(count) || count < 0) throw new RangeError(`${label} exceeds the safe integer range`);
  return count;
}

function methods({ OptimisticConcurrencyError }) {
  return {
    _modelRoutingPolicyLimit(limit) {
      const size = positiveSafeInteger(limit, 'limit');
      if (size > this.maxQueryRows) throw new RangeError(`limit exceeds the configured maximum of ${this.maxQueryRows}`);
      return size;
    },

    _modelRoutingPolicyValue(value) {
      const normalized = normalizeModelRoutingPolicyValue(this.assertJsonRecord(value, 'value'));
      const body = { ...normalized };
      for (const key of ['name', 'status', 'workContextId', 'capabilityId']) delete body[key];
      return {
        name: normalized.name,
        status: normalized.status,
        workContextId: normalized.workContextId,
        capabilityId: normalized.capabilityId,
        body: this.assertJsonRecord(body, 'model routing policy body')
      };
    },

    async _assertModelRoutingWorkContext(connection, workContextId) {
      if (workContextId === null) return;
      const result = await connection.query(
        `SELECT id FROM ${this.table('work_contexts')} WHERE id = $1 FOR SHARE`,
        [workContextId]
      );
      if (result.rowCount === 0) {
        throw new ModelRoutingPolicyReferenceError(
          `Work Context not found: ${workContextId}`,
          'WORK_CONTEXT_NOT_FOUND'
        );
      }
    },

    async _assertTicketRoutingPolicy(connection, ticket) {
      if (!ticket || ticket.routingPolicyId === undefined || ticket.routingPolicyId === null) return;
      const policyId = positiveSafeInteger(ticket.routingPolicyId, 'ticket.routingPolicyId');
      const result = await connection.query(
        `SELECT id FROM ${this.table('model_routing_policies')} WHERE id = $1 FOR SHARE`,
        [policyId]
      );
      if (result.rowCount === 0) {
        throw new ModelRoutingPolicyReferenceError(
          `Selected model routing policy does not exist: ${policyId}`,
          'MODEL_ROUTING_POLICY_NOT_FOUND'
        );
      }
    },

    async listModelRoutingPolicies({ afterId = 0, statuses = null, limit = 100 } = {}) {
      const cursor = nonNegativeSafeInteger(afterId, 'afterId');
      const size = this._modelRoutingPolicyLimit(limit);
      const allowed = normalizeStatuses(statuses);
      const result = await this.pool.query(
        `SELECT * FROM ${this.table('model_routing_policies')}
         WHERE id > $1
           AND ($2::text[] IS NULL OR status = ANY($2::text[]))
         ORDER BY id
         LIMIT $3`,
        [cursor, allowed, size + 1]
      );
      const policies = result.rows.slice(0, size).map(policyFromRow);
      return {
        policies,
        nextAfterId: result.rows.length > size && policies.length > 0 ? policies[policies.length - 1].id : null
      };
    },

    async getModelRoutingPolicyById(policyId) {
      const id = positiveSafeInteger(policyId, 'policyId');
      const result = await this.pool.query(
        `SELECT * FROM ${this.table('model_routing_policies')} WHERE id = $1`,
        [id]
      );
      return result.rowCount === 0 ? null : policyFromRow(result.rows[0]);
    },

    async getModelRoutingPolicyCounts() {
      const result = await this.pool.query(
        `SELECT
           COUNT(*) FILTER (WHERE status = 'active')::bigint AS active,
           COUNT(*) FILTER (WHERE status = 'archived')::bigint AS archived,
           COUNT(*)::bigint AS total
         FROM ${this.table('model_routing_policies')}`
      );
      const row = result.rows[0] || {};
      return {
        active: safeCount(row.active || 0, 'active model routing policy count'),
        archived: safeCount(row.archived || 0, 'archived model routing policy count'),
        total: safeCount(row.total || 0, 'model routing policy count')
      };
    },

    async findApplicableModelRoutingPolicy({
      explicitPolicyId = null,
      workContextId = null,
      capabilityId = null,
      client = null
    } = {}) {
      const explicitId = nullablePositiveSafeInteger(explicitPolicyId, 'explicitPolicyId');
      const contextId = nullablePositiveSafeInteger(workContextId, 'workContextId');
      const capability = nullableString(capabilityId);
      const connection = client || this.pool;
      if (explicitId !== null) {
        const explicit = await connection.query(
          `SELECT * FROM ${this.table('model_routing_policies')}
           WHERE id = $1 AND status = 'active'
           LIMIT 1
           FOR SHARE`,
          [explicitId]
        );
        if (explicit.rowCount > 0) return { policy: policyFromRow(explicit.rows[0]), reason: 'explicit_override' };
      }
      const tiers = [];
      if (contextId !== null && capability !== null) tiers.push([contextId, capability]);
      if (contextId !== null) tiers.push([contextId, null]);
      if (capability !== null) tiers.push([null, capability]);
      tiers.push([null, null]);
      for (const [tierContextId, tierCapabilityId] of tiers) {
        const result = await connection.query(
          `SELECT * FROM ${this.table('model_routing_policies')}
           WHERE status = 'active'
             AND work_context_id IS NOT DISTINCT FROM $1::bigint
             AND capability_id IS NOT DISTINCT FROM $2::text
           ORDER BY id
           LIMIT 1
           FOR SHARE`,
          [tierContextId, tierCapabilityId]
        );
        if (result.rowCount > 0) return { policy: policyFromRow(result.rows[0]), reason: 'policy_preferred' };
      }
      return { policy: null, reason: 'no_policy' };
    },

    async createModelRoutingPolicy({ value, changedBy, audit = null }) {
      const normalized = this._modelRoutingPolicyValue(value);
      const actor = requiredString(changedBy, 'changedBy');
      return this.withTransaction(async client => {
        await this._assertModelRoutingWorkContext(client, normalized.workContextId);
        const result = await client.query(
          `INSERT INTO ${this.table('model_routing_policies')}
             (name, status, work_context_id, capability_id, body, created_by, updated_by)
           VALUES ($1, $2, $3, $4, $5::jsonb, $6, $6)
           RETURNING *`,
          [
            normalized.name,
            normalized.status,
            normalized.workContextId,
            normalized.capabilityId,
            normalized.body,
            actor
          ]
        );
        const policy = policyFromRow(result.rows[0]);
        const auditLog = audit ? await this._appendSystemLog(client, {
          ...audit,
          metadata: { ...(audit.metadata || {}), policyId: policy.id }
        }) : null;
        return { policy, auditLog };
      });
    },

    async updateModelRoutingPolicy({ policyId, expectedRevision, value, changedBy, audit = null }) {
      const id = positiveSafeInteger(policyId, 'policyId');
      const revision = positiveSafeInteger(expectedRevision, 'expectedRevision');
      const normalized = this._modelRoutingPolicyValue(value);
      const actor = requiredString(changedBy, 'changedBy');
      return this.withTransaction(async client => {
        const currentResult = await client.query(
          `SELECT * FROM ${this.table('model_routing_policies')} WHERE id = $1 FOR UPDATE`,
          [id]
        );
        if (currentResult.rowCount === 0) return null;
        const current = policyFromRow(currentResult.rows[0]);
        if (current.revision !== revision) {
          throw new OptimisticConcurrencyError('modelRoutingPolicy', id, revision, current);
        }
        await this._assertModelRoutingWorkContext(client, normalized.workContextId);
        const result = await client.query(
          `UPDATE ${this.table('model_routing_policies')}
           SET name = $2, status = $3, work_context_id = $4, capability_id = $5,
               body = $6::jsonb, revision = revision + 1,
               updated_by = $7, updated_at = clock_timestamp()
           WHERE id = $1 AND revision = $8
           RETURNING *`,
          [
            id,
            normalized.name,
            normalized.status,
            normalized.workContextId,
            normalized.capabilityId,
            normalized.body,
            actor,
            revision
          ]
        );
        if (result.rowCount === 0) {
          const latest = await client.query(
            `SELECT * FROM ${this.table('model_routing_policies')} WHERE id = $1`,
            [id]
          );
          throw new OptimisticConcurrencyError(
            'modelRoutingPolicy',
            id,
            revision,
            latest.rowCount > 0 ? policyFromRow(latest.rows[0]) : null
          );
        }
        const policy = policyFromRow(result.rows[0]);
        const auditLog = audit ? await this._appendSystemLog(client, {
          ...audit,
          metadata: { ...(audit.metadata || {}), policyId: policy.id }
        }) : null;
        return { policy, auditLog };
      });
    }
  };
}

function installModelRoutingPolicyMethods(PostgresRuntimeStore, dependencies) {
  Object.assign(PostgresRuntimeStore.prototype, methods(dependencies));
}

module.exports = { installModelRoutingPolicyMethods };

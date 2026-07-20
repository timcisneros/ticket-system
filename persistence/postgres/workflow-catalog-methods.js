'use strict';

const {
  WorkflowCatalogIdConflictError,
  WorkflowCatalogReferenceError,
  normalizeWorkflowIds,
  normalizeWorkflowValue,
  positiveSafeInteger,
  requiredString
} = require('../workflow-catalog');

function rowTimestamp(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new TypeError('PostgreSQL returned an invalid timestamp');
  return date.toISOString();
}

function workflowFromRow(row) {
  const body = row.body && typeof row.body === 'object' && !Array.isArray(row.body) ? row.body : {};
  return {
    ...body,
    id: row.id,
    enabled: row.enabled === true,
    revision: positiveSafeInteger(row.revision, 'workflow.revision'),
    createdBy: row.created_by,
    createdAt: rowTimestamp(row.created_at),
    updatedBy: row.updated_by,
    updatedAt: rowTimestamp(row.updated_at)
  };
}

function translateIdConflict(error, workflowId) {
  if (error && error.code === '23505' && error.constraint === 'workflow_definitions_pkey') {
    throw new WorkflowCatalogIdConflictError(workflowId);
  }
  throw error;
}

function methods({ OptimisticConcurrencyError }) {
  return {
    _workflowLimit(limit) {
      const size = positiveSafeInteger(limit, 'limit');
      if (size > this.maxQueryRows) throw new RangeError(`limit exceeds the configured maximum of ${this.maxQueryRows}`);
      return size;
    },

    _workflowValue(value) {
      const definition = normalizeWorkflowValue(this.assertJsonRecord(value, 'value'));
      const body = { ...definition };
      for (const key of ['id', 'enabled', 'revision', 'createdBy', 'createdAt', 'updatedBy', 'updatedAt']) delete body[key];
      return {
        id: definition.id,
        enabled: definition.enabled === true,
        body: this.assertJsonRecord(body, 'workflow body')
      };
    },

    async listWorkflows({ afterId = '', enabled = null, limit = 100 } = {}) {
      const cursor = String(afterId || '');
      const size = this._workflowLimit(limit);
      if (enabled !== null && typeof enabled !== 'boolean') throw new TypeError('enabled must be a boolean or null');
      const result = await this.pool.query(
        `SELECT * FROM ${this.table('workflow_definitions')}
         WHERE (id COLLATE "C") > ($1 COLLATE "C")
           AND ($2::boolean IS NULL OR enabled = $2)
         ORDER BY id COLLATE "C"
         LIMIT $3`,
        [cursor, enabled, size + 1]
      );
      const workflows = result.rows.slice(0, size).map(workflowFromRow);
      return {
        workflows,
        nextAfterId: result.rows.length > size && workflows.length > 0 ? workflows[workflows.length - 1].id : null
      };
    },

    async getWorkflowById(workflowId) {
      const id = requiredString(workflowId, 'workflowId');
      const result = await this.pool.query(`SELECT * FROM ${this.table('workflow_definitions')} WHERE id = $1`, [id]);
      return result.rowCount === 0 ? null : workflowFromRow(result.rows[0]);
    },

    async getWorkflowsByIds({ workflowIds }) {
      const ids = normalizeWorkflowIds(workflowIds, this.maxQueryRows);
      const result = await this.pool.query(
        `SELECT * FROM ${this.table('workflow_definitions')}
         WHERE id = ANY($1::text[])
         ORDER BY id COLLATE "C"
         LIMIT $2`,
        [ids, ids.length]
      );
      return result.rows.map(workflowFromRow);
    },

    async _assertTicketWorkflow(connection, ticket) {
      if (!ticket || ticket.executionMode !== 'workflow') return;
      const workflowId = requiredString(ticket.workflowId, 'ticket.workflowId');
      const result = await connection.query(
        `SELECT enabled FROM ${this.table('workflow_definitions')} WHERE id = $1 FOR SHARE`,
        [workflowId]
      );
      if (result.rowCount === 0) {
        throw new WorkflowCatalogReferenceError(`Selected workflow does not exist: ${workflowId}`, 'WORKFLOW_NOT_FOUND');
      }
      if (result.rows[0].enabled !== true) {
        throw new WorkflowCatalogReferenceError(`Selected workflow is disabled: ${workflowId}`, 'WORKFLOW_DISABLED');
      }
    },

    async createWorkflow({ value, changedBy, audit = null }) {
      const definition = this._workflowValue(value);
      const actor = requiredString(changedBy, 'changedBy');
      try {
        return await this.withTransaction(async client => {
          const result = await client.query(
            `INSERT INTO ${this.table('workflow_definitions')}
               (id, enabled, body, created_by, updated_by)
             VALUES ($1, $2, $3::jsonb, $4, $4)
             RETURNING *`,
            [definition.id, definition.enabled, definition.body, actor]
          );
          const workflow = workflowFromRow(result.rows[0]);
          const auditLog = audit ? await this._appendSystemLog(client, audit) : null;
          return { workflow, auditLog };
        });
      } catch (error) {
        translateIdConflict(error, definition.id);
      }
    },

    async createWorkflowWithEvidence({ value, changedBy, evidence }) {
      const definition = this._workflowValue(value);
      const actor = requiredString(changedBy, 'changedBy');
      if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) {
        throw new TypeError('evidence must be an object');
      }
      try {
        return await this.withTransaction(async client => {
          const result = await client.query(
            `INSERT INTO ${this.table('workflow_definitions')}
               (id, enabled, body, created_by, updated_by)
             VALUES ($1, $2, $3::jsonb, $4, $4)
             RETURNING *`,
            [definition.id, definition.enabled, definition.body, actor]
          );
          const workflow = workflowFromRow(result.rows[0]);
          const recordedEvidence = await this.appendRunEvidence(evidence, { client });
          return { workflow, evidence: recordedEvidence };
        });
      } catch (error) {
        translateIdConflict(error, definition.id);
      }
    },

    async updateWorkflow({ workflowId, expectedRevision, value, changedBy, audit = null }) {
      const id = requiredString(workflowId, 'workflowId');
      const revision = positiveSafeInteger(expectedRevision, 'expectedRevision');
      const definition = this._workflowValue(value);
      if (definition.id !== id) throw new TypeError('Workflow id cannot be changed');
      const actor = requiredString(changedBy, 'changedBy');
      return this.withTransaction(async client => {
        const currentResult = await client.query(
          `SELECT * FROM ${this.table('workflow_definitions')} WHERE id = $1 FOR UPDATE`,
          [id]
        );
        if (currentResult.rowCount === 0) return null;
        const current = workflowFromRow(currentResult.rows[0]);
        if (current.revision !== revision) {
          throw new OptimisticConcurrencyError('workflow', id, revision, current);
        }
        const result = await client.query(
          `UPDATE ${this.table('workflow_definitions')}
           SET enabled = $2, body = $3::jsonb, revision = revision + 1,
               updated_by = $4, updated_at = clock_timestamp()
           WHERE id = $1 AND revision = $5
           RETURNING *`,
          [id, definition.enabled, definition.body, actor, revision]
        );
        if (result.rowCount === 0) {
          const latest = await client.query(`SELECT * FROM ${this.table('workflow_definitions')} WHERE id = $1`, [id]);
          throw new OptimisticConcurrencyError(
            'workflow', id, revision, latest.rowCount ? workflowFromRow(latest.rows[0]) : null
          );
        }
        const workflow = workflowFromRow(result.rows[0]);
        const auditLog = audit ? await this._appendSystemLog(client, audit) : null;
        return { workflow, auditLog };
      });
    },

    async ensureDefaultWorkflows({ definitions, changedBy = 'system' } = {}) {
      if (!Array.isArray(definitions)) throw new TypeError('definitions must be an array');
      const actor = requiredString(changedBy, 'changedBy');
      return this.withTransaction(async client => {
        await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [`${this.schema}:workflow-defaults`]);
        const createdWorkflowIds = [];
        for (const value of definitions) {
          const definition = this._workflowValue(value);
          const result = await client.query(
            `INSERT INTO ${this.table('workflow_definitions')}
               (id, enabled, body, created_by, updated_by)
             VALUES ($1, $2, $3::jsonb, $4, $4)
             ON CONFLICT (id) DO NOTHING
             RETURNING id`,
            [definition.id, definition.enabled, definition.body, actor]
          );
          if (result.rowCount > 0) createdWorkflowIds.push(result.rows[0].id);
        }
        return { changed: createdWorkflowIds.length > 0, createdWorkflowIds };
      });
    }
  };
}

function installWorkflowCatalogMethods(PostgresRuntimeStore, dependencies) {
  Object.assign(PostgresRuntimeStore.prototype, methods(dependencies));
}

module.exports = { installWorkflowCatalogMethods };

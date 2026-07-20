'use strict';

const {
  RuntimeLimitsConflictError,
  normalizeRuntimeLimitsValues,
  positiveSafeInteger,
  requiredString
} = require('../runtime-limits');

function rowTimestamp(value) {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new TypeError('PostgreSQL returned an invalid timestamp');
  return date.toISOString();
}

function runtimeLimitsFromRow(row) {
  return {
    maxExecutionSteps: row.max_execution_steps === null ? null : positiveSafeInteger(row.max_execution_steps, 'runtimeLimits.maxExecutionSteps'),
    maxModelRequestsPerRun: row.max_model_requests_per_run === null ? null : positiveSafeInteger(row.max_model_requests_per_run, 'runtimeLimits.maxModelRequestsPerRun'),
    maxWorkspaceOperationsPerRun: row.max_workspace_operations_per_run === null ? null : positiveSafeInteger(row.max_workspace_operations_per_run, 'runtimeLimits.maxWorkspaceOperationsPerRun'),
    maxRuntimeDurationMs: row.max_runtime_duration_ms === null ? null : positiveSafeInteger(row.max_runtime_duration_ms, 'runtimeLimits.maxRuntimeDurationMs'),
    maxActiveRuns: row.max_active_runs === null ? null : positiveSafeInteger(row.max_active_runs, 'runtimeLimits.maxActiveRuns'),
    localModelConcurrency: row.local_model_concurrency === null ? null : positiveSafeInteger(row.local_model_concurrency, 'runtimeLimits.localModelConcurrency'),
    revision: positiveSafeInteger(row.revision, 'runtimeLimits.revision'),
    updatedBy: row.updated_by || null,
    updatedAt: rowTimestamp(row.updated_at)
  };
}

function methods() {
  return {
    async getRuntimeLimitsConfig() {
      const result = await this.pool.query(`SELECT * FROM ${this.table('runtime_limit_config')} WHERE id = 1`);
      if (result.rowCount !== 1) {
        const error = new Error('runtime limit singleton is missing');
        error.code = 'POSTGRES_RUNTIME_INTEGRITY_FAILURE';
        throw error;
      }
      return runtimeLimitsFromRow(result.rows[0]);
    },

    async updateRuntimeLimitsConfig({ expectedRevision, value, changedBy } = {}) {
      const revision = positiveSafeInteger(expectedRevision, 'expectedRevision');
      const normalized = normalizeRuntimeLimitsValues(value);
      const actor = requiredString(changedBy, 'changedBy');
      return this.withTransaction(async client => {
        const currentResult = await client.query(
          `SELECT * FROM ${this.table('runtime_limit_config')} WHERE id = 1 FOR UPDATE`
        );
        if (currentResult.rowCount !== 1) {
          const error = new Error('runtime limit singleton is missing');
          error.code = 'POSTGRES_RUNTIME_INTEGRITY_FAILURE';
          throw error;
        }
        const previous = runtimeLimitsFromRow(currentResult.rows[0]);
        if (previous.revision !== revision) throw new RuntimeLimitsConflictError(revision, previous);
        const updated = await client.query(
          `UPDATE ${this.table('runtime_limit_config')}
           SET max_execution_steps = $1,
               max_model_requests_per_run = $2,
               max_workspace_operations_per_run = $3,
               max_runtime_duration_ms = $4,
               max_active_runs = $5,
               local_model_concurrency = $6,
               revision = revision + 1,
               updated_by = $7,
               updated_at = clock_timestamp()
           WHERE id = 1 AND revision = $8
           RETURNING *`,
          [
            normalized.maxExecutionSteps,
            normalized.maxModelRequestsPerRun,
            normalized.maxWorkspaceOperationsPerRun,
            normalized.maxRuntimeDurationMs,
            normalized.maxActiveRuns,
            normalized.localModelConcurrency,
            actor,
            revision
          ]
        );
        if (updated.rowCount !== 1) throw new RuntimeLimitsConflictError(revision, previous);
        const config = runtimeLimitsFromRow(updated.rows[0]);
        const auditPayload = {
          actor,
          timestamp: config.updatedAt,
          revision: config.revision,
          oldValues: Object.fromEntries(Object.keys(normalized).map(key => [key, previous[key]])),
          newValues: { ...normalized }
        };
        const event = await this._appendEvent(client, { type: 'runtime_limits.updated', payload: auditPayload });
        const auditLog = await this._appendSystemLog(client, {
          type: 'runtime_limits.updated',
          message: `Runtime limits updated by ${actor}`,
          metadata: auditPayload
        });
        return { config, event, auditLog };
      });
    }
  };
}

function installRuntimeLimitsMethods(PostgresRuntimeStore) {
  Object.assign(PostgresRuntimeStore.prototype, methods());
}

module.exports = { installRuntimeLimitsMethods, runtimeLimitsFromRow };

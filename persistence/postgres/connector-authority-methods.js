'use strict';

const {
  CONNECTOR_RECEIPT_OPERATIONS,
  CONNECTOR_RECEIPT_RESULT_STATUSES,
  CONNECTOR_STATUSES,
  ConnectorReferenceError,
  nonNegativeSafeInteger,
  normalizeConnectorValue,
  normalizeConnectorReceiptValue,
  normalizeEnumList,
  nullablePositiveSafeInteger,
  positiveSafeInteger,
  requiredString
} = require('../connector-authority');

function rowTimestamp(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new TypeError('PostgreSQL returned an invalid timestamp');
  return date.toISOString();
}

function connectorFromRow(row) {
  const body = row.body && typeof row.body === 'object' && !Array.isArray(row.body) ? row.body : {};
  return {
    id: positiveSafeInteger(row.id, 'connector.id'),
    ...body,
    name: row.name,
    status: row.status,
    kind: row.kind,
    workContextId: positiveSafeInteger(row.work_context_id, 'connector.workContextId'),
    credentialRef: row.credential_ref || null,
    revision: positiveSafeInteger(row.revision, 'connector.revision'),
    createdBy: row.created_by,
    createdAt: rowTimestamp(row.created_at),
    updatedBy: row.updated_by,
    updatedAt: rowTimestamp(row.updated_at)
  };
}

function receiptFromRow(row) {
  const body = row.body && typeof row.body === 'object' && !Array.isArray(row.body) ? row.body : {};
  const result = body.result && typeof body.result === 'object' && !Array.isArray(body.result) ? body.result : {};
  return {
    id: positiveSafeInteger(row.id, 'connectorReceipt.id'),
    ...body,
    connectorId: positiveSafeInteger(row.connector_id, 'connectorReceipt.connectorId'),
    workContextId: positiveSafeInteger(row.work_context_id, 'connectorReceipt.workContextId'),
    operation: row.operation,
    result: { ...result, status: row.result_status },
    timestamp: rowTimestamp(row.occurred_at)
  };
}

function safeCount(value, label) {
  const count = Number(value);
  if (!Number.isSafeInteger(count) || count < 0) throw new RangeError(`${label} exceeds the safe integer range`);
  return count;
}

function methods({ OptimisticConcurrencyError }) {
  return {
    _connectorLimit(value, label = 'limit') {
      const size = positiveSafeInteger(value, label);
      if (size > this.maxQueryRows) throw new RangeError(`${label} exceeds the configured maximum of ${this.maxQueryRows}`);
      return size;
    },

    _connectorValue(value) {
      const normalized = normalizeConnectorValue(this.assertJsonRecord(value, 'value'));
      const body = { ...normalized };
      for (const key of ['name', 'status', 'kind', 'workContextId', 'credentialRef']) delete body[key];
      return {
        name: normalized.name,
        status: normalized.status,
        kind: normalized.kind,
        workContextId: normalized.workContextId,
        credentialRef: normalized.credentialRef,
        body: this.assertJsonRecord(body, 'connector body')
      };
    },

    _connectorReceiptValue(value) {
      const normalized = normalizeConnectorReceiptValue(this.assertJsonRecord(value, 'value'));
      const result = { ...normalized.result };
      delete result.status;
      const body = { ...normalized, result };
      for (const key of ['connectorId', 'workContextId', 'operation']) delete body[key];
      return {
        connectorId: normalized.connectorId,
        workContextId: normalized.workContextId,
        operation: normalized.operation,
        resultStatus: normalized.result.status,
        body: this.assertJsonRecord(body, 'connector receipt body')
      };
    },

    async _assertConnectorWorkContext(connection, workContextId, { requireActive = false } = {}) {
      const result = await connection.query(
        `SELECT id, status FROM ${this.table('work_contexts')} WHERE id = $1 FOR SHARE`,
        [workContextId]
      );
      if (result.rowCount === 0) {
        throw new ConnectorReferenceError(`Work Context not found: ${workContextId}`, 'WORK_CONTEXT_NOT_FOUND');
      }
      if (requireActive && result.rows[0].status !== 'active') {
        throw new ConnectorReferenceError('An active connector requires an active Work Context', 'WORK_CONTEXT_NOT_ACTIVE');
      }
    },

    async listConnectors({ afterId = 0, statuses = null, workContextId = null, limit = 100 } = {}) {
      const cursor = nonNegativeSafeInteger(afterId, 'afterId');
      const allowed = normalizeEnumList(statuses, CONNECTOR_STATUSES, 'statuses');
      const contextId = nullablePositiveSafeInteger(workContextId, 'workContextId');
      const size = this._connectorLimit(limit);
      const result = await this.pool.query(
        `SELECT * FROM ${this.table('connectors')}
         WHERE id > $1
           AND ($2::text[] IS NULL OR status = ANY($2::text[]))
           AND ($3::bigint IS NULL OR work_context_id = $3)
         ORDER BY id
         LIMIT $4`,
        [cursor, allowed, contextId, size + 1]
      );
      const connectors = result.rows.slice(0, size).map(connectorFromRow);
      return {
        connectors,
        nextAfterId: result.rows.length > size && connectors.length > 0 ? connectors[connectors.length - 1].id : null
      };
    },

    async getConnectorById(connectorId) {
      const id = positiveSafeInteger(connectorId, 'connectorId');
      const result = await this.pool.query(`SELECT * FROM ${this.table('connectors')} WHERE id = $1`, [id]);
      return result.rowCount === 0 ? null : connectorFromRow(result.rows[0]);
    },

    async _listConnectorReceipts(connection, {
      connectorId = null,
      beforeId = null,
      operations = null,
      resultStatuses = null,
      limit = 25
    } = {}) {
      const connector = nullablePositiveSafeInteger(connectorId, 'connectorId');
      const before = nullablePositiveSafeInteger(beforeId, 'beforeId');
      const allowedOperations = normalizeEnumList(operations, CONNECTOR_RECEIPT_OPERATIONS, 'operations');
      const allowedStatuses = normalizeEnumList(resultStatuses, CONNECTOR_RECEIPT_RESULT_STATUSES, 'resultStatuses');
      const size = this._connectorLimit(limit);
      const result = await connection.query(
        `SELECT * FROM ${this.table('connector_receipts')}
         WHERE ($1::bigint IS NULL OR connector_id = $1)
           AND ($2::bigint IS NULL OR id < $2)
           AND ($3::text[] IS NULL OR operation = ANY($3::text[]))
           AND ($4::text[] IS NULL OR result_status = ANY($4::text[]))
         ORDER BY id DESC
         LIMIT $5`,
        [connector, before, allowedOperations, allowedStatuses, size + 1]
      );
      const receipts = result.rows.slice(0, size).map(receiptFromRow);
      return {
        receipts,
        nextBeforeId: result.rows.length > size && receipts.length > 0 ? receipts[receipts.length - 1].id : null
      };
    },

    async listConnectorReceipts(options = {}) {
      return this._listConnectorReceipts(this.pool, options);
    },

    async getConnectorOperationalSummary({ limit = 10 } = {}) {
      const size = this._connectorLimit(limit);
      const [countsResult, refusalResult, recentResult, readRefusalResult] = await Promise.all([
        this.pool.query(
          `SELECT
             COALESCE(SUM(count) FILTER (WHERE status = 'active'), 0)::bigint AS active,
             COALESCE(SUM(count) FILTER (WHERE status = 'paused'), 0)::bigint AS paused,
             COALESCE(SUM(count) FILTER (WHERE status = 'archived'), 0)::bigint AS archived,
             COALESCE(SUM(count), 0)::bigint AS total
           FROM ${this.table('connector_status_counts')}`
        ),
        this.pool.query(
          `SELECT * FROM ${this.table('connector_receipts')}
           WHERE operation IN ('read_refused', 'write_refused') OR result_status = 'failed'
           ORDER BY id DESC
           LIMIT $1`,
          [size]
        ),
        this.pool.query(
          `SELECT * FROM ${this.table('connector_receipts')} ORDER BY id DESC LIMIT $1`,
          [size]
        ),
        this.pool.query(
          `SELECT EXISTS (
             SELECT 1 FROM ${this.table('connector_receipts')}
             WHERE operation = 'read_refused' LIMIT 1
           ) AS exists`
        )
      ]);
      const row = countsResult.rows[0] || {};
      return {
        active: safeCount(row.active || 0, 'active connector count'),
        paused: safeCount(row.paused || 0, 'paused connector count'),
        archived: safeCount(row.archived || 0, 'archived connector count'),
        total: safeCount(row.total || 0, 'connector count'),
        recentRefusals: refusalResult.rows.map(receiptFromRow),
        recentReceipts: recentResult.rows.map(receiptFromRow),
        hasReadRefusals: Boolean(readRefusalResult.rows[0] && readRefusalResult.rows[0].exists)
      };
    },

    async createConnector({ value, changedBy, audit = null }) {
      const normalized = this._connectorValue(value);
      const actor = requiredString(changedBy, 'changedBy');
      return this.withTransaction(async client => {
        await this._assertConnectorWorkContext(client, normalized.workContextId, {
          requireActive: normalized.status === 'active'
        });
        const result = await client.query(
          `INSERT INTO ${this.table('connectors')}
             (name, status, kind, work_context_id, credential_ref, body, created_by, updated_by)
           VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $7)
           RETURNING *`,
          [normalized.name, normalized.status, normalized.kind, normalized.workContextId,
            normalized.credentialRef, normalized.body, actor]
        );
        const connector = connectorFromRow(result.rows[0]);
        const auditLog = audit ? await this._appendSystemLog(client, {
          ...audit,
          metadata: { ...(audit.metadata || {}), connectorId: connector.id, workContextId: connector.workContextId }
        }) : null;
        return { connector, auditLog };
      });
    },

    async updateConnector({ connectorId, expectedRevision, value, changedBy, audit = null }) {
      const id = positiveSafeInteger(connectorId, 'connectorId');
      const revision = positiveSafeInteger(expectedRevision, 'expectedRevision');
      const normalized = this._connectorValue(value);
      const actor = requiredString(changedBy, 'changedBy');
      return this.withTransaction(async client => {
        const currentResult = await client.query(
          `SELECT * FROM ${this.table('connectors')} WHERE id = $1 FOR UPDATE`,
          [id]
        );
        if (currentResult.rowCount === 0) return null;
        const current = connectorFromRow(currentResult.rows[0]);
        if (current.revision !== revision) {
          throw new OptimisticConcurrencyError('connector', id, revision, current);
        }
        await this._assertConnectorWorkContext(client, normalized.workContextId, {
          requireActive: normalized.status === 'active'
        });
        const result = await client.query(
          `UPDATE ${this.table('connectors')}
           SET name = $2, status = $3, kind = $4, work_context_id = $5, credential_ref = $6,
               body = $7::jsonb, revision = revision + 1,
               updated_by = $8, updated_at = clock_timestamp()
           WHERE id = $1 AND revision = $9
           RETURNING *`,
          [id, normalized.name, normalized.status, normalized.kind, normalized.workContextId,
            normalized.credentialRef, normalized.body, actor, revision]
        );
        if (result.rowCount === 0) {
          const latest = await client.query(`SELECT * FROM ${this.table('connectors')} WHERE id = $1`, [id]);
          throw new OptimisticConcurrencyError(
            'connector', id, revision, latest.rowCount > 0 ? connectorFromRow(latest.rows[0]) : null
          );
        }
        const connector = connectorFromRow(result.rows[0]);
        const auditLog = audit ? await this._appendSystemLog(client, {
          ...audit,
          metadata: { ...(audit.metadata || {}), connectorId: connector.id, workContextId: connector.workContextId }
        }) : null;
        return { connector, auditLog };
      });
    },

    async appendConnectorReceipt({ value, audit = null }) {
      const normalized = this._connectorReceiptValue(value);
      return this.withTransaction(async client => {
        const connectorResult = await client.query(
          `SELECT id, work_context_id FROM ${this.table('connectors')}
           WHERE id = $1 FOR SHARE`,
          [normalized.connectorId]
        );
        if (connectorResult.rowCount === 0) {
          throw new ConnectorReferenceError(`Connector not found: ${normalized.connectorId}`, 'CONNECTOR_NOT_FOUND');
        }
        if (positiveSafeInteger(connectorResult.rows[0].work_context_id, 'connector.workContextId') !== normalized.workContextId) {
          throw new ConnectorReferenceError(
            'Connector receipt Work Context does not match connector',
            'CONNECTOR_WORK_CONTEXT_MISMATCH'
          );
        }
        const result = await client.query(
          `INSERT INTO ${this.table('connector_receipts')}
             (connector_id, work_context_id, operation, result_status, body)
           VALUES ($1, $2, $3, $4, $5::jsonb)
           RETURNING *`,
          [normalized.connectorId, normalized.workContextId, normalized.operation,
            normalized.resultStatus, normalized.body]
        );
        const receipt = receiptFromRow(result.rows[0]);
        const auditLog = audit ? await this._appendSystemLog(client, {
          ...audit,
          metadata: { ...(audit.metadata || {}), connectorId: receipt.connectorId, receiptId: receipt.id }
        }) : null;
        return { receipt, auditLog };
      });
    }
  };
}

function installConnectorAuthorityMethods(PostgresRuntimeStore, dependencies) {
  Object.assign(PostgresRuntimeStore.prototype, methods(dependencies));
}

module.exports = { installConnectorAuthorityMethods };

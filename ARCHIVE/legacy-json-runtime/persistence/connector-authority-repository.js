'use strict';

const {
  CONNECTOR_RECEIPT_OPERATIONS,
  CONNECTOR_RECEIPT_RESULT_STATUSES,
  CONNECTOR_STATUSES,
  ConnectorConflictError,
  ConnectorIdConflictError,
  ConnectorReferenceError,
  nonNegativeSafeInteger,
  normalizeConnectorRecord,
  normalizeConnectorValue,
  normalizeConnectorReceiptRecord,
  normalizeConnectorReceiptValue,
  normalizeEnumList,
  nullablePositiveSafeInteger,
  positiveSafeInteger,
  requiredFunction,
  requiredString,
  timestamp
} = require('../connector-authority');

class JsonConnectorAuthorityRepository {
  constructor({
    readConnectors,
    writeConnectors,
    readReceipts,
    writeReceipts,
    readWorkContexts,
    appendSystemLog,
    queueMutation = null,
    now = () => new Date(),
    maxQueryRows = 1_000
  } = {}) {
    this.readConnectors = requiredFunction(readConnectors, 'readConnectors');
    this.writeConnectors = requiredFunction(writeConnectors, 'writeConnectors');
    this.readReceipts = requiredFunction(readReceipts, 'readReceipts');
    this.writeReceipts = requiredFunction(writeReceipts, 'writeReceipts');
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

  _limit(value, label = 'limit') {
    const size = positiveSafeInteger(value, label);
    if (size > this.maxQueryRows) throw new RangeError(`${label} exceeds the configured maximum of ${this.maxQueryRows}`);
    return size;
  }

  _readRawConnectors() {
    const records = this.readConnectors();
    if (!Array.isArray(records)) throw new TypeError('connector catalog must be an array');
    return structuredClone(records);
  }

  _readRawReceipts() {
    const records = this.readReceipts();
    if (!Array.isArray(records)) throw new TypeError('connector receipt store must be an array');
    return structuredClone(records);
  }

  _workContexts() {
    const records = this.readWorkContexts();
    if (!Array.isArray(records)) throw new TypeError('Work Context catalog must be an array');
    const contexts = new Map();
    for (const record of records) {
      if (!record || !Number.isSafeInteger(record.id) || record.id <= 0) continue;
      contexts.set(record.id, record);
    }
    return contexts;
  }

  _readConnectorRecords() {
    const connectors = this._readRawConnectors().map(normalizeConnectorRecord);
    const seen = new Set();
    const contexts = this._workContexts();
    for (const connector of connectors) {
      if (seen.has(connector.id)) throw new ConnectorIdConflictError('connector', connector.id);
      seen.add(connector.id);
      if (!contexts.has(connector.workContextId)) {
        throw new ConnectorReferenceError(
          `Connector ${connector.id} references missing Work Context ${connector.workContextId}`,
          'WORK_CONTEXT_NOT_FOUND'
        );
      }
    }
    return connectors;
  }

  _readReceiptRecords(connectors = null) {
    const connectorRecords = connectors || this._readConnectorRecords();
    const connectorContexts = new Map(connectorRecords.map(item => [item.id, item.workContextId]));
    const receipts = this._readRawReceipts().map(normalizeConnectorReceiptRecord);
    const seen = new Set();
    for (const receipt of receipts) {
      if (seen.has(receipt.id)) throw new ConnectorIdConflictError('connector receipt', receipt.id);
      seen.add(receipt.id);
      const workContextId = connectorContexts.get(receipt.connectorId);
      if (workContextId === undefined) {
        throw new ConnectorReferenceError(
          `Connector receipt ${receipt.id} references missing connector ${receipt.connectorId}`,
          'CONNECTOR_NOT_FOUND'
        );
      }
      if (workContextId !== receipt.workContextId) {
        throw new ConnectorReferenceError(
          `Connector receipt ${receipt.id} Work Context does not match connector ${receipt.connectorId}`,
          'CONNECTOR_WORK_CONTEXT_MISMATCH'
        );
      }
    }
    return receipts;
  }

  _assertWorkContext(workContextId, { requireActive = false } = {}) {
    const context = this._workContexts().get(workContextId) || null;
    if (!context) throw new ConnectorReferenceError(`Work Context not found: ${workContextId}`, 'WORK_CONTEXT_NOT_FOUND');
    if (requireActive && context.status !== 'active') {
      throw new ConnectorReferenceError('An active connector requires an active Work Context', 'WORK_CONTEXT_NOT_ACTIVE');
    }
  }

  async listConnectors({ afterId = 0, statuses = null, workContextId = null, limit = 100 } = {}) {
    const cursor = nonNegativeSafeInteger(afterId, 'afterId');
    const size = this._limit(limit);
    const allowed = normalizeEnumList(statuses, CONNECTOR_STATUSES, 'statuses');
    const contextId = nullablePositiveSafeInteger(workContextId, 'workContextId');
    const matches = this._readConnectorRecords()
      .filter(item => item.id > cursor)
      .filter(item => !allowed || allowed.includes(item.status))
      .filter(item => contextId === null || item.workContextId === contextId)
      .sort((left, right) => left.id - right.id)
      .slice(0, size + 1);
    const connectors = matches.slice(0, size);
    return {
      connectors,
      nextAfterId: matches.length > size && connectors.length > 0 ? connectors[connectors.length - 1].id : null
    };
  }

  async getConnectorById(connectorId) {
    const id = positiveSafeInteger(connectorId, 'connectorId');
    return this._readConnectorRecords().find(item => item.id === id) || null;
  }

  async getConnectorOperationalSummary({ limit = 10 } = {}) {
    const size = this._limit(limit);
    const connectors = this._readConnectorRecords();
    const receipts = this._readReceiptRecords(connectors).sort((left, right) => right.id - left.id);
    const counts = { active: 0, paused: 0, archived: 0, total: connectors.length };
    for (const connector of connectors) counts[connector.status] += 1;
    const isRefusal = receipt => receipt.operation === 'read_refused' ||
      receipt.operation === 'write_refused' || receipt.result.status === 'failed';
    return {
      ...counts,
      recentRefusals: receipts.filter(isRefusal).slice(0, size),
      recentReceipts: receipts.slice(0, size),
      hasReadRefusals: receipts.some(receipt => receipt.operation === 'read_refused')
    };
  }

  async listConnectorReceipts({
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
    const size = this._limit(limit);
    const matches = this._readReceiptRecords()
      .filter(item => connector === null || item.connectorId === connector)
      .filter(item => before === null || item.id < before)
      .filter(item => !allowedOperations || allowedOperations.includes(item.operation))
      .filter(item => !allowedStatuses || allowedStatuses.includes(item.result.status))
      .sort((left, right) => right.id - left.id)
      .slice(0, size + 1);
    const receipts = matches.slice(0, size);
    return {
      receipts,
      nextBeforeId: matches.length > size && receipts.length > 0 ? receipts[receipts.length - 1].id : null
    };
  }

  async _appendAuditOrRollback(rollback, writeRollback, audit) {
    if (!audit) return null;
    try {
      return await this.appendSystemLog(audit);
    } catch (error) {
      writeRollback(rollback);
      throw error;
    }
  }

  createConnector({ value, changedBy, audit = null }) {
    return this.queueMutation(async () => {
      const body = normalizeConnectorValue(value);
      const actor = requiredString(changedBy, 'changedBy');
      this._assertWorkContext(body.workContextId, { requireActive: body.status === 'active' });
      const rollback = this._readRawConnectors();
      const connectors = this._readConnectorRecords();
      const now = timestamp(this.now(), 'now');
      const connector = {
        id: connectors.reduce((maximum, item) => Math.max(maximum, item.id), 0) + 1,
        ...body,
        revision: 1,
        createdBy: actor,
        createdAt: now,
        updatedBy: actor,
        updatedAt: now
      };
      this.writeConnectors([...connectors, connector].sort((left, right) => left.id - right.id));
      const auditLog = await this._appendAuditOrRollback(rollback, value => this.writeConnectors(value), audit ? {
        ...audit,
        metadata: { ...(audit.metadata || {}), connectorId: connector.id, workContextId: connector.workContextId }
      } : null);
      return { connector: structuredClone(connector), auditLog };
    });
  }

  updateConnector({ connectorId, expectedRevision, value, changedBy, audit = null }) {
    return this.queueMutation(async () => {
      const id = positiveSafeInteger(connectorId, 'connectorId');
      const revision = positiveSafeInteger(expectedRevision, 'expectedRevision');
      const body = normalizeConnectorValue(value);
      const actor = requiredString(changedBy, 'changedBy');
      this._assertWorkContext(body.workContextId, { requireActive: body.status === 'active' });
      const rollback = this._readRawConnectors();
      const connectors = this._readConnectorRecords();
      const index = connectors.findIndex(item => item.id === id);
      if (index === -1) return null;
      const current = connectors[index];
      if (current.revision !== revision) throw new ConnectorConflictError(id, revision, structuredClone(current));
      const connector = {
        id,
        ...body,
        revision: revision + 1,
        createdBy: current.createdBy,
        createdAt: current.createdAt,
        updatedBy: actor,
        updatedAt: timestamp(this.now(), 'now')
      };
      connectors[index] = connector;
      this.writeConnectors(connectors);
      const auditLog = await this._appendAuditOrRollback(rollback, value => this.writeConnectors(value), audit ? {
        ...audit,
        metadata: { ...(audit.metadata || {}), connectorId: connector.id, workContextId: connector.workContextId }
      } : null);
      return { connector: structuredClone(connector), auditLog };
    });
  }

  appendConnectorReceipt({ value, audit = null }) {
    return this.queueMutation(async () => {
      const body = normalizeConnectorReceiptValue(value);
      const connectors = this._readConnectorRecords();
      const connector = connectors.find(item => item.id === body.connectorId) || null;
      if (!connector) throw new ConnectorReferenceError(`Connector not found: ${body.connectorId}`, 'CONNECTOR_NOT_FOUND');
      if (connector.workContextId !== body.workContextId) {
        throw new ConnectorReferenceError('Connector receipt Work Context does not match connector', 'CONNECTOR_WORK_CONTEXT_MISMATCH');
      }
      const rollback = this._readRawReceipts();
      const receipts = this._readReceiptRecords(connectors);
      const receipt = {
        id: receipts.reduce((maximum, item) => Math.max(maximum, item.id), 0) + 1,
        ...body,
        timestamp: timestamp(this.now(), 'now')
      };
      this.writeReceipts([...receipts, receipt].sort((left, right) => left.id - right.id));
      const auditLog = await this._appendAuditOrRollback(rollback, value => this.writeReceipts(value), audit ? {
        ...audit,
        metadata: { ...(audit.metadata || {}), connectorId: receipt.connectorId, receiptId: receipt.id }
      } : null);
      return { receipt: structuredClone(receipt), auditLog };
    });
  }
}

module.exports = { JsonConnectorAuthorityRepository };

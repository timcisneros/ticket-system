'use strict';

const REQUIRED_OPERATOR_RECOVERY_REPOSITORY_METHODS = Object.freeze([
  'getOperatorRecovery',
  'prepareOperatorRecovery',
  'completeOperatorRecovery',
  'withOperatorRecoveryLock'
]);

class OperatorRecoveryConflictError extends Error {
  constructor(originalHistoryId, recoveryKey) {
    super(`Operator recovery conflicts for operation ${originalHistoryId}: ${recoveryKey}`);
    this.name = 'OperatorRecoveryConflictError';
    this.code = 'OPERATOR_RECOVERY_CONFLICT';
    this.originalHistoryId = originalHistoryId;
    this.recoveryKey = recoveryKey;
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

function requiredString(value, label) {
  const normalized = String(value === undefined || value === null ? '' : value).trim();
  if (!normalized) throw new TypeError(`${label} is required`);
  return normalized;
}

function jsonObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${label} must be an object`);
  return value;
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(item => canonicalJson(item)).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).filter(key => value[key] !== undefined).sort()
      .map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  const encoded = JSON.stringify(value);
  return encoded === undefined ? 'null' : encoded;
}

function assertOperatorRecoveryRepository(repository) {
  if (!repository || typeof repository !== 'object') throw new TypeError('operator recovery repository is required');
  for (const method of REQUIRED_OPERATOR_RECOVERY_REPOSITORY_METHODS) {
    if (typeof repository[method] !== 'function') {
      throw new TypeError(`operator recovery repository must implement ${method}()`);
    }
  }
  return repository;
}

class JsonOperatorRecoveryRepository {
  constructor({
    readOperationHistory,
    writeOperationHistory,
    readReplaySnapshot,
    writeReplaySnapshot,
    getRunEvents,
    appendEvent,
    acquireTargetLock,
    sanitizePayload = value => value,
    now = () => new Date()
  } = {}) {
    this.readOperationHistory = requiredFunction(readOperationHistory, 'readOperationHistory');
    this.writeOperationHistory = requiredFunction(writeOperationHistory, 'writeOperationHistory');
    this.readReplaySnapshot = requiredFunction(readReplaySnapshot, 'readReplaySnapshot');
    this.writeReplaySnapshot = requiredFunction(writeReplaySnapshot, 'writeReplaySnapshot');
    this.getRunEvents = requiredFunction(getRunEvents, 'getRunEvents');
    this.appendEvent = requiredFunction(appendEvent, 'appendEvent');
    this.acquireTargetLock = requiredFunction(acquireTargetLock, 'acquireTargetLock');
    this.sanitizePayload = requiredFunction(sanitizePayload, 'sanitizePayload');
    this.now = requiredFunction(now, 'now');
  }

  _object(value, label) {
    return jsonObject(this.sanitizePayload(jsonObject(value || {}, label)), label);
  }

  _nextId(records) {
    return records.reduce((maximum, record) => Math.max(maximum, Number(record.id) || 0), 0) + 1;
  }

  _events(runId) {
    const events = this.getRunEvents(runId);
    return Array.isArray(events) ? events : [];
  }

  async withOperatorRecoveryLock(options, operation) {
    if (typeof operation !== 'function') throw new TypeError('operation must be a function');
    const release = await this.acquireTargetLock(options || {});
    if (typeof release !== 'function') throw new TypeError('acquireTargetLock must return a release function');
    try {
      return await operation();
    } finally {
      release();
    }
  }

  async getOperatorRecovery(originalHistoryId) {
    const id = positiveSafeInteger(originalHistoryId, 'originalHistoryId');
    const histories = this.readOperationHistory();
    const original = histories.find(record => record && record.id === id) || null;
    if (!original) return { original: null, intent: null, receipt: null, preparedEvent: null, completionEvent: null };
    const receipts = histories.filter(record => record && record.recoveredHistoryId === id);
    if (receipts.length > 1) throw new OperatorRecoveryConflictError(id, 'duplicate-completion');
    const events = this._events(original.runId);
    const preparedEvent = events.find(event =>
      event && event.type === 'workspace.recovery_prepared' && event.payload &&
      event.payload.originalHistoryId === id
    ) || null;
    const completionEvent = events.find(event =>
      event && event.type === 'workspace.recovery_completed' && event.payload &&
      event.payload.recoveredHistoryId === id
    ) || null;
    return {
      original,
      intent: preparedEvent && preparedEvent.payload ? preparedEvent.payload.intent || null : null,
      receipt: receipts[0] || null,
      preparedEvent,
      completionEvent
    };
  }

  async prepareOperatorRecovery({ originalHistoryId, recoveryKey, intent }) {
    const id = positiveSafeInteger(originalHistoryId, 'originalHistoryId');
    const key = requiredString(recoveryKey, 'recoveryKey');
    const document = this._object(intent, 'intent');
    const current = await this.getOperatorRecovery(id);
    if (!current.original) throw new TypeError(`Operation history ${id} was not found`);
    if (current.receipt) return { ...current, inserted: false };
    if (current.intent) {
      const currentKey = current.preparedEvent && current.preparedEvent.payload
        ? current.preparedEvent.payload.recoveryKey
        : null;
      if (currentKey !== key || canonicalJson(current.intent) !== canonicalJson(document)) {
        throw new OperatorRecoveryConflictError(id, key);
      }
      return { ...current, inserted: false };
    }
    const event = await this.appendEvent({
      type: 'workspace.recovery_prepared',
      ticketId: current.original.ticketId,
      runId: current.original.runId,
      ...(current.original.step === null || current.original.step === undefined
        ? {}
        : { stepId: String(current.original.step) }),
      payload: { originalHistoryId: id, recoveryKey: key, intent: document }
    });
    return { ...current, intent: document, preparedEvent: event, inserted: true };
  }

  async _appendCompletionEvidence({ state, recoveryKey, record, replayItem, event }) {
    const evidenceKey = `operator-recovery:${state.original.id}:completed`;
    const item = {
      ...this._object(replayItem, 'replayItem'),
      evidenceKey,
      historyId: record.id,
      operationKey: recoveryKey,
      recoveredHistoryId: state.original.id,
      mutationReceipt: record.mutationReceipt
    };
    const eventInput = this._object(event, 'event');
    const payload = {
      ...this._object(eventInput.payload || {}, 'event.payload'),
      evidenceKey,
      historyId: record.id,
      operationKey: recoveryKey,
      recoveredHistoryId: state.original.id,
      mutationReceipt: record.mutationReceipt
    };
    const existingEvent = this._events(state.original.runId).find(candidate =>
      candidate && candidate.payload && candidate.payload.evidenceKey === evidenceKey
    ) || null;
    if (existingEvent && (existingEvent.type !== eventInput.type || canonicalJson(existingEvent.payload) !== canonicalJson(payload))) {
      throw new OperatorRecoveryConflictError(state.original.id, recoveryKey);
    }

    const snapshot = await this.readReplaySnapshot(state.original.runId);
    if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
      throw new TypeError(`Run ${state.original.runId} does not have a replay snapshot`);
    }
    const workspaceOperations = Array.isArray(snapshot.workspaceOperations) ? snapshot.workspaceOperations : [];
    const existingItem = workspaceOperations.find(candidate => candidate && candidate.evidenceKey === evidenceKey) || null;
    if (existingItem && canonicalJson(existingItem) !== canonicalJson(item)) {
      throw new OperatorRecoveryConflictError(state.original.id, recoveryKey);
    }
    if (!existingItem) {
      await this.writeReplaySnapshot(state.original.runId, {
        ...snapshot,
        workspaceOperations: [...workspaceOperations, item]
      });
    }
    if (!existingEvent) {
      await this.appendEvent({
        type: requiredString(eventInput.type, 'event.type'),
        ticketId: state.original.ticketId,
        runId: state.original.runId,
        ...(eventInput.stepId === null || eventInput.stepId === undefined
          ? {}
          : { stepId: String(eventInput.stepId) }),
        payload
      });
    }
    return { replayItem: existingItem || item, event: existingEvent, inserted: !existingItem };
  }

  async completeOperatorRecovery({
    originalHistoryId,
    recoveryKey,
    historyRecord,
    receipt,
    replayItem,
    event
  }) {
    const id = positiveSafeInteger(originalHistoryId, 'originalHistoryId');
    const key = requiredString(recoveryKey, 'recoveryKey');
    const state = await this.getOperatorRecovery(id);
    if (!state.original) throw new TypeError(`Operation history ${id} was not found`);
    if (!state.intent) throw new TypeError(`Operator recovery ${key} was not prepared`);
    const preparedKey = state.preparedEvent && state.preparedEvent.payload
      ? state.preparedEvent.payload.recoveryKey
      : null;
    if (preparedKey !== key) throw new OperatorRecoveryConflictError(id, key);

    const histories = this.readOperationHistory();
    const proposed = this._object(historyRecord, 'historyRecord');
    let record = histories.find(candidate => candidate && candidate.recoveredHistoryId === id) || null;
    const inserted = record === null;
    if (!record) {
      const recordId = this._nextId(histories);
      const receiptDocument = {
        ...this._object(receipt, 'receipt'),
        operationId: recordId,
        operationKey: key,
        recoveredHistoryId: id
      };
      record = {
        ...proposed,
        id: recordId,
        timestamp: this.now().toISOString(),
        ticketId: state.original.ticketId,
        runId: state.original.runId,
        step: state.original.step,
        operationKey: key,
        isRecovery: true,
        recoveredHistoryId: id,
        mutationReceipt: receiptDocument
      };
      histories.push(record);
      this.writeOperationHistory(histories);
    } else {
      const conflicts = Object.keys(proposed).some(field => canonicalJson(record[field]) !== canonicalJson(proposed[field]));
      if (record.operationKey !== key || conflicts) throw new OperatorRecoveryConflictError(id, key);
    }

    const evidence = await this._appendCompletionEvidence({
      state,
      recoveryKey: key,
      record,
      replayItem,
      event
    });
    return { record, evidence, inserted };
  }
}

module.exports = {
  JsonOperatorRecoveryRepository,
  OperatorRecoveryConflictError,
  REQUIRED_OPERATOR_RECOVERY_REPOSITORY_METHODS,
  assertOperatorRecoveryRepository,
  canonicalJson
};

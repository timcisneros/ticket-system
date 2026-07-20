'use strict';

const REQUIRED_NON_TERMINAL_EVIDENCE_REPOSITORY_METHODS = Object.freeze([
  'appendRunEvidence',
  'completeActionReceipt',
  'prepareTargetOperation',
  'completeTargetOperation',
  'getTargetOperation',
  'withTargetOperationLock'
]);

class TargetOperationConflictError extends Error {
  constructor(runId, operationKey) {
    super(`Target operation key conflicts for run ${runId}: ${operationKey}`);
    this.name = 'TargetOperationConflictError';
    this.code = 'TARGET_OPERATION_CONFLICT';
    this.runId = runId;
    this.operationKey = operationKey;
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

function assertNonTerminalEvidenceRepository(repository) {
  if (!repository || typeof repository !== 'object') throw new TypeError('non-terminal evidence repository is required');
  for (const method of REQUIRED_NON_TERMINAL_EVIDENCE_REPOSITORY_METHODS) {
    if (typeof repository[method] !== 'function') {
      throw new TypeError(`non-terminal evidence repository must implement ${method}()`);
    }
  }
  return repository;
}

class JsonNonTerminalEvidenceRepository {
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

  async withTargetOperationLock(options, operation) {
    if (typeof operation !== 'function') throw new TypeError('operation must be a function');
    const release = await this.acquireTargetLock(options || {});
    if (typeof release !== 'function') throw new TypeError('acquireTargetLock must return a release function');
    try {
      return await operation();
    } finally {
      release();
    }
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

  async appendRunEvidence({ runId, ticketId, evidenceKey, replayKey, replayItem, event }) {
    const id = positiveSafeInteger(runId, 'runId');
    const ownerTicketId = positiveSafeInteger(ticketId, 'ticketId');
    const key = requiredString(evidenceKey, 'evidenceKey');
    const collection = requiredString(replayKey, 'replayKey');
    const item = { ...this._object(replayItem, 'replayItem'), evidenceKey: key };
    const eventInput = this._object(event, 'event');
    const eventType = requiredString(eventInput.type, 'event.type');
    const eventPayload = { ...this._object(eventInput.payload || {}, 'event.payload'), evidenceKey: key };
    const existingEvent = this._events(id).find(candidate =>
      candidate && candidate.payload && candidate.payload.evidenceKey === key
    ) || null;
    if (existingEvent && (existingEvent.type !== eventType || canonicalJson(existingEvent.payload) !== canonicalJson(eventPayload))) {
      throw new TargetOperationConflictError(id, key);
    }

    const snapshot = await this.readReplaySnapshot(id);
    if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
      throw new TypeError(`Run ${id} does not have a replay snapshot`);
    }
    const items = Array.isArray(snapshot[collection]) ? snapshot[collection] : [];
    const existingItem = items.find(candidate => candidate && candidate.evidenceKey === key) || null;
    if (existingItem && canonicalJson(existingItem) !== canonicalJson(item)) {
      throw new TargetOperationConflictError(id, key);
    }
    if (!existingItem) {
      await this.writeReplaySnapshot(id, { ...snapshot, [collection]: [...items, item] });
    }

    if (existingEvent) {
      return { replayItem: existingItem || item, event: existingEvent, inserted: false };
    }
    const storedEvent = await this.appendEvent({
      type: eventType,
      ticketId: ownerTicketId,
      runId: id,
      ...(eventInput.stepId === undefined || eventInput.stepId === null ? {} : { stepId: String(eventInput.stepId) }),
      payload: eventPayload
    });
    return { replayItem: existingItem || item, event: storedEvent, inserted: !existingItem };
  }

  async getTargetOperation(runId, operationKey) {
    const id = positiveSafeInteger(runId, 'runId');
    const key = requiredString(operationKey, 'operationKey');
    const receipt = this.readOperationHistory().find(record => record.runId === id && record.operationKey === key) || null;
    const preparedEvent = this._events(id).find(event =>
      event && event.type === 'workspace.operation_prepared' && event.payload && event.payload.operationKey === key
    ) || null;
    return {
      intent: preparedEvent && preparedEvent.payload ? preparedEvent.payload.intent || null : null,
      receipt,
      preparedEvent
    };
  }

  async completeActionReceipt({
    runId,
    ticketId,
    operationKey,
    stepId = null,
    operation,
    outcome,
    historyRecord,
    receipt,
    replayKey,
    replayItem,
    event
  }) {
    const id = positiveSafeInteger(runId, 'runId');
    const ownerTicketId = positiveSafeInteger(ticketId, 'ticketId');
    const key = requiredString(operationKey, 'operationKey');
    const operationName = requiredString(operation, 'operation');
    const normalizedOutcome = requiredString(outcome, 'outcome');
    if (!['succeeded', 'failed', 'refused'].includes(normalizedOutcome)) {
      throw new TypeError(`Unsupported action receipt outcome: ${normalizedOutcome}`);
    }
    const histories = this.readOperationHistory();
    let record = histories.find(candidate => candidate && candidate.runId === id && candidate.operationKey === key) || null;
    const inserted = record === null;
    const proposedHistory = this._object(historyRecord, 'historyRecord');
    const receiptDocument = this._object(receipt, 'receipt');
    if (!record) {
      record = {
        ...proposedHistory,
        id: this._nextId(histories),
        timestamp: this.now().toISOString(),
        runId: id,
        ticketId: ownerTicketId,
        step: proposedHistory.step === undefined ? stepId : proposedHistory.step,
        operation: operationName,
        operationKey: key,
        outcome: normalizedOutcome,
        readReceipt: receiptDocument
      };
      histories.push(record);
      this.writeOperationHistory(histories);
    } else {
      const conflicts = Object.keys(proposedHistory)
        .some(field => canonicalJson(record[field]) !== canonicalJson(proposedHistory[field]));
      if (record.ticketId !== ownerTicketId || record.operation !== operationName ||
          record.outcome !== normalizedOutcome || conflicts ||
          canonicalJson(record.readReceipt) !== canonicalJson(receiptDocument)) {
        throw new TargetOperationConflictError(id, key);
      }
    }

    const eventDocument = this._object(event, 'event');
    const evidence = await this.appendRunEvidence({
      runId: id,
      ticketId: ownerTicketId,
      evidenceKey: `action-receipt:${key}:completed`,
      replayKey,
      replayItem: {
        ...this._object(replayItem, 'replayItem'),
        historyId: record.id,
        operationKey: key
      },
      event: {
        ...eventDocument,
        payload: {
          ...this._object(eventDocument.payload || {}, 'event.payload'),
          historyId: record.id,
          operationKey: key
        }
      }
    });
    return { record, evidence, inserted };
  }

  async prepareTargetOperation({ runId, ticketId, operationKey, stepId = null, intent }) {
    const id = positiveSafeInteger(runId, 'runId');
    const ownerTicketId = positiveSafeInteger(ticketId, 'ticketId');
    const key = requiredString(operationKey, 'operationKey');
    const document = this._object(intent, 'intent');
    const current = await this.getTargetOperation(id, key);
    if (current.intent) {
      if (canonicalJson(current.intent) !== canonicalJson(document)) throw new TargetOperationConflictError(id, key);
      return { ...current, inserted: false };
    }
    const event = await this.appendEvent({
      type: 'workspace.operation_prepared',
      ticketId: ownerTicketId,
      runId: id,
      ...(stepId === null || stepId === undefined ? {} : { stepId: String(stepId) }),
      payload: { operationKey: key, intent: document }
    });
    return { intent: document, receipt: current.receipt, preparedEvent: event, inserted: true };
  }

  async completeTargetOperation({
    runId,
    ticketId,
    operationKey,
    historyRecord,
    receipt,
    replayItem,
    event
  }) {
    const id = positiveSafeInteger(runId, 'runId');
    const key = requiredString(operationKey, 'operationKey');
    const current = await this.getTargetOperation(id, key);
    if (!current.intent) throw new TypeError(`Target operation ${key} was not prepared`);
    const histories = this.readOperationHistory();
    let record = current.receipt;
    if (!record) {
      const recordId = this._nextId(histories);
      const receiptDocument = {
        ...this._object(receipt, 'receipt'),
        operationId: recordId,
        operationKey: key
      };
      record = {
        ...this._object(historyRecord, 'historyRecord'),
        id: recordId,
        timestamp: this.now().toISOString(),
        runId: id,
        ticketId: positiveSafeInteger(ticketId, 'ticketId'),
        operationKey: key,
        mutationReceipt: receiptDocument
      };
      histories.push(record);
      this.writeOperationHistory(histories);
    } else {
      const proposed = this._object(historyRecord, 'historyRecord');
      const conflicts = Object.keys(proposed).some(field => canonicalJson(record[field]) !== canonicalJson(proposed[field]));
      if (conflicts) {
        throw new TargetOperationConflictError(id, key);
      }
    }

    const evidenceKey = `target-operation:${key}:completed`;
    const snapshot = await this.readReplaySnapshot(id);
    const existingReplayItem = snapshot && Array.isArray(snapshot.workspaceOperations)
      ? snapshot.workspaceOperations.find(item => item && item.evidenceKey === evidenceKey) || null
      : null;
    const existingEvent = this._events(id).find(candidate =>
      candidate && candidate.payload && candidate.payload.evidenceKey === evidenceKey
    ) || null;
    const proposedReplayItem = {
      ...this._object(replayItem, 'replayItem'),
      historyId: record.id,
      operationKey: key,
      mutationReceipt: record.mutationReceipt
    };
    const proposedEvent = {
      ...this._object(event, 'event'),
      payload: {
        ...this._object(event.payload || {}, 'event.payload'),
        historyId: record.id,
        operationKey: key,
        mutationReceipt: record.mutationReceipt
      }
    };
    const evidence = await this.appendRunEvidence({
      runId: id,
      ticketId,
      evidenceKey,
      replayKey: 'workspaceOperations',
      replayItem: existingReplayItem || proposedReplayItem,
      event: existingEvent
        ? { type: existingEvent.type, stepId: existingEvent.stepId, payload: existingEvent.payload }
        : proposedEvent
    });
    return { record, evidence, inserted: current.receipt === null };
  }
}

module.exports = {
  JsonNonTerminalEvidenceRepository,
  REQUIRED_NON_TERMINAL_EVIDENCE_REPOSITORY_METHODS,
  TargetOperationConflictError,
  assertNonTerminalEvidenceRepository,
  canonicalJson
};

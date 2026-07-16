'use strict';

const REQUIRED_RUN_REPLAY_REPOSITORY_METHODS = Object.freeze([
  'initializeRunReplay',
  'readRunReplay',
  'listRunReplays',
  'updateRunReplay'
]);

class FinalizedRunReplayError extends Error {
  constructor(runId) {
    super(`Replay snapshot for run ${runId} is finalized and cannot be changed`);
    this.name = 'FinalizedRunReplayError';
    this.code = 'FINALIZED_RUN_REPLAY';
    this.runId = runId;
  }
}

function requiredFunction(value, label) {
  if (typeof value !== 'function') throw new TypeError(`${label} must be a function`);
  return value;
}

function positiveSafeInteger(value, label) {
  const number = typeof value === 'string' && /^[1-9]\d*$/.test(value) ? Number(value) : value;
  if (!Number.isSafeInteger(number) || number <= 0) {
    throw new TypeError(`${label} must be a positive safe integer`);
  }
  return number;
}

function jsonObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
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

function isSingleArrayAppend(current, proposed) {
  const keys = [...new Set([...Object.keys(current), ...Object.keys(proposed)])];
  const changedKeys = keys.filter(key => canonicalJson(current[key]) !== canonicalJson(proposed[key]));
  if (changedKeys.length !== 1) return false;
  const key = changedKeys[0];
  const prior = current[key];
  const next = proposed[key];
  if (!Array.isArray(prior) || !Array.isArray(next) || next.length !== prior.length + 1) return false;
  return prior.every((item, index) => canonicalJson(item) === canonicalJson(next[index]));
}

function assertRunReplayRepository(repository) {
  if (!repository || typeof repository !== 'object') {
    throw new TypeError('run replay repository is required');
  }
  for (const method of REQUIRED_RUN_REPLAY_REPOSITORY_METHODS) {
    if (typeof repository[method] !== 'function') {
      throw new TypeError(`run replay repository must implement ${method}()`);
    }
  }
  return repository;
}

class JsonRunReplayRepository {
  constructor({
    readRuns,
    writeRuns,
    readReplaySnapshotFile,
    writeReplaySnapshotFile,
    attachReplayMetadata,
    sanitizePayload = value => value,
    maxQueryRows = 1_000
  } = {}) {
    this.readRuns = requiredFunction(readRuns, 'readRuns');
    this.writeRuns = requiredFunction(writeRuns, 'writeRuns');
    this.readReplaySnapshotFile = requiredFunction(readReplaySnapshotFile, 'readReplaySnapshotFile');
    this.writeReplaySnapshotFile = requiredFunction(writeReplaySnapshotFile, 'writeReplaySnapshotFile');
    this.attachReplayMetadata = requiredFunction(attachReplayMetadata, 'attachReplayMetadata');
    this.sanitizePayload = requiredFunction(sanitizePayload, 'sanitizePayload');
    this.maxQueryRows = positiveSafeInteger(maxQueryRows, 'maxQueryRows');
  }

  _snapshot(value, label = 'snapshot') {
    return jsonObject(this.sanitizePayload(jsonObject(value, label)), label);
  }

  _record(run, snapshot) {
    return {
      runId: run.id,
      ticketId: run.ticketId,
      snapshot,
      finalizedAt: snapshot.finalizedAt || null
    };
  }

  _findRun(runs, runId) {
    const id = positiveSafeInteger(runId, 'runId');
    return { id, run: runs.find(candidate => candidate && candidate.id === id) || null };
  }

  async initializeRunReplay({ runId, ticketId, snapshot }) {
    const runs = this.readRuns();
    const { id, run } = this._findRun(runs, runId);
    const ownerTicketId = positiveSafeInteger(ticketId, 'ticketId');
    if (!run) return null;
    if (run.ticketId !== ownerTicketId) {
      throw new TypeError(`Run ${id} does not belong to ticket ${ownerTicketId}`);
    }
    const current = this.readReplaySnapshotFile(run);
    if (current) return { record: this._record(run, current), initialized: false };

    const document = this._snapshot(snapshot);
    this.writeReplaySnapshotFile(id, document);
    this.attachReplayMetadata(run, document);
    this.writeRuns(runs);
    return { record: this._record(run, document), initialized: true };
  }

  async readRunReplay(runId) {
    const runs = this.readRuns();
    const { run } = this._findRun(runs, runId);
    if (!run) return null;
    const snapshot = this.readReplaySnapshotFile(run);
    return snapshot ? this._record(run, snapshot) : null;
  }

  async listRunReplays({ runIds, limit = this.maxQueryRows } = {}) {
    if (!Array.isArray(runIds)) throw new TypeError('runIds must be an array');
    const boundedLimit = positiveSafeInteger(limit, 'limit');
    if (boundedLimit > this.maxQueryRows) {
      throw new RangeError(`limit exceeds the configured maximum of ${this.maxQueryRows}`);
    }
    const ids = [...new Set(runIds.map((runId, index) => positiveSafeInteger(runId, `runIds[${index}]`)))];
    if (ids.length > boundedLimit) {
      throw new RangeError(`runIds exceeds the requested limit of ${boundedLimit}`);
    }
    const idSet = new Set(ids);
    return this.readRuns()
      .filter(run => run && idSet.has(run.id))
      .sort((left, right) => left.id - right.id)
      .map(run => {
        const snapshot = this.readReplaySnapshotFile(run);
        return snapshot ? this._record(run, snapshot) : null;
      })
      .filter(Boolean);
  }

  async updateRunReplay({ runId, update, allowFinalizedAppend = false }) {
    const updater = requiredFunction(update, 'update');
    const runs = this.readRuns();
    const { id, run } = this._findRun(runs, runId);
    if (!run) return null;
    const current = this.readReplaySnapshotFile(run);
    if (!current) return null;
    const proposed = updater(this._snapshot(current, 'current snapshot'));
    if (proposed && typeof proposed.then === 'function') {
      throw new TypeError('update must return synchronously');
    }
    if (proposed === null || proposed === undefined) {
      return { record: this._record(run, current), updated: false };
    }
    const document = this._snapshot(proposed);
    if (canonicalJson(document) === canonicalJson(current)) {
      return { record: this._record(run, current), updated: false };
    }
    if (current.finalizedAt && !(allowFinalizedAppend === true && isSingleArrayAppend(current, document))) {
      throw new FinalizedRunReplayError(id);
    }

    this.writeReplaySnapshotFile(id, document);
    this.attachReplayMetadata(run, document);
    this.writeRuns(runs);
    return { record: this._record(run, document), updated: true };
  }
}

module.exports = {
  REQUIRED_RUN_REPLAY_REPOSITORY_METHODS,
  FinalizedRunReplayError,
  JsonRunReplayRepository,
  assertRunReplayRepository,
  isSingleArrayAppend
};

'use strict';

const REQUIRED_RUN_TERMINALIZATION_REPOSITORY_METHODS = Object.freeze([
  'terminalizeRun'
]);

function requiredFunction(value, label) {
  if (typeof value !== 'function') throw new TypeError(`${label} must be a function`);
  return value;
}

function requiredString(value, label) {
  const normalized = String(value === undefined || value === null ? '' : value).trim();
  if (!normalized) throw new TypeError(`${label} is required`);
  return normalized;
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

function timestamp(value, label) {
  const parsed = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new TypeError(`${label} must be a valid timestamp`);
  return parsed.toISOString();
}

function normalizeEvent(event, label) {
  const source = jsonObject(event, label);
  return {
    type: requiredString(source.type, `${label}.type`),
    ...(source.stepId === undefined || source.stepId === null ? {} : { stepId: String(source.stepId) }),
    payload: jsonObject(source.payload || {}, `${label}.payload`)
  };
}

function normalizeEvents(events, label) {
  if (!Array.isArray(events)) throw new TypeError(`${label} must be an array`);
  return events.map((event, index) => normalizeEvent(event, `${label}[${index}]`));
}

function assertRunTerminalizationRepository(repository) {
  if (!repository || typeof repository !== 'object') {
    throw new TypeError('run terminalization repository is required');
  }
  for (const method of REQUIRED_RUN_TERMINALIZATION_REPOSITORY_METHODS) {
    if (typeof repository[method] !== 'function') {
      throw new TypeError(`run terminalization repository must implement ${method}()`);
    }
  }
  return repository;
}

class JsonRunTerminalizationRepository {
  constructor({
    readRuns,
    writeRuns,
    writeReplaySnapshotFile,
    attachReplayMetadata,
    appendEvent,
    sanitizePayload = value => value,
    now = () => new Date()
  } = {}) {
    this.readRuns = requiredFunction(readRuns, 'readRuns');
    this.writeRuns = requiredFunction(writeRuns, 'writeRuns');
    this.writeReplaySnapshotFile = requiredFunction(writeReplaySnapshotFile, 'writeReplaySnapshotFile');
    this.attachReplayMetadata = requiredFunction(attachReplayMetadata, 'attachReplayMetadata');
    this.appendEvent = requiredFunction(appendEvent, 'appendEvent');
    this.sanitizePayload = requiredFunction(sanitizePayload, 'sanitizePayload');
    this.now = requiredFunction(now, 'now');
  }

  _payload(value, label) {
    return jsonObject(this.sanitizePayload(jsonObject(value, label)), label);
  }

  _leaseExpired(run, completedAtMs) {
    if (!run.leaseExpiresAt) return true;
    const expiresAt = Date.parse(run.leaseExpiresAt);
    return !Number.isNaN(expiresAt) && expiresAt <= completedAtMs;
  }

  _canTerminalize(run, sources, target, owner, allowExpiredLease, completedAtMs) {
    if (!run || !sources.includes(run.status)) return false;
    if (run.status === 'running') {
      const expired = this._leaseExpired(run, completedAtMs);
      const liveOwner = owner && run.leaseOwner === owner && !expired;
      const recoveryOwner = allowExpiredLease === true && expired && target !== 'completed';
      return Boolean(liveOwner || recoveryOwner);
    }
    if (run.leaseOwner && !this._leaseExpired(run, completedAtMs)) {
      return Boolean(owner && run.leaseOwner === owner);
    }
    return true;
  }

  async terminalizeRun({
    runId,
    fromStatuses,
    status,
    leaseOwner = null,
    allowExpiredLease = false,
    completedAt = null,
    patch = {},
    replaySnapshot,
    evaluation,
    consequence,
    executionEvent,
    beforeReplayEvents = [],
    replayEvent,
    beforeEvaluationEvents = [],
    terminalEvent
  }) {
    const id = positiveSafeInteger(runId, 'runId');
    if (!Array.isArray(fromStatuses) || fromStatuses.length === 0) {
      throw new TypeError('fromStatuses must be a non-empty array');
    }
    const sources = [...new Set(fromStatuses.map((item, index) => requiredString(item, `fromStatuses[${index}]`)))];
    const target = requiredString(status, 'status');
    if (!['completed', 'failed', 'interrupted'].includes(target)) {
      throw new TypeError(`Unsupported terminal run status: ${target}`);
    }
    if (target === 'completed' && sources.some(source => source !== 'running')) {
      throw new TypeError('Only a running run can complete');
    }

    const owner = leaseOwner === undefined || leaseOwner === null ? null : requiredString(leaseOwner, 'leaseOwner');
    const completedIso = timestamp(completedAt || this.now(), 'completedAt');
    const completedMs = Date.parse(completedIso);
    const bodyPatch = this._payload(patch, 'patch');
    const snapshot = this._payload(replaySnapshot, 'replaySnapshot');
    if (typeof evaluation !== 'function') this._payload(evaluation, 'evaluation');
    if (typeof consequence !== 'function') this._payload(consequence, 'consequence');
    const evidenceEvents = [
      normalizeEvent(executionEvent, 'executionEvent'),
      ...normalizeEvents(beforeReplayEvents, 'beforeReplayEvents'),
      normalizeEvent(replayEvent, 'replayEvent'),
      ...normalizeEvents(beforeEvaluationEvents, 'beforeEvaluationEvents')
    ];
    const normalizedTerminalEvent = normalizeEvent(terminalEvent, 'terminalEvent');

    const initialRuns = this.readRuns();
    const run = initialRuns.find(item => item.id === id) || null;
    if (!this._canTerminalize(run, sources, target, owner, allowExpiredLease, completedMs)) return null;

    // The JSON stage cannot make the snapshot file, run projection, and journal
    // one filesystem transaction. Preserve all prerequisite evidence first, then
    // expose one terminal run projection containing its evaluation/consequence.
    // Journal failure remains fatal for this process.
    this.writeReplaySnapshotFile(id, snapshot);
    const projectedRun = {
      ...run,
      ...bodyPatch,
      status: target,
      completedAt: completedIso,
      updatedAt: completedIso,
      leaseOwner: null,
      leaseExpiresAt: null,
      lastHeartbeatAt: null
    };
    this.attachReplayMetadata(projectedRun, snapshot);

    const appendedEvents = [];
    for (const event of evidenceEvents) {
      appendedEvents.push(await this.appendEvent({
        type: event.type,
        ticketId: run.ticketId,
        runId: run.id,
        ...(event.stepId === undefined ? {} : { stepId: event.stepId }),
        payload: this._payload(event.payload, `${event.type} payload`)
      }));
    }
    const context = {
      run: projectedRun,
      replaySnapshot: snapshot,
      events: appendedEvents.slice()
    };
    const runEvaluation = this._payload(
      typeof evaluation === 'function' ? await evaluation(context) : evaluation,
      'evaluation'
    );
    const runConsequence = this._payload(
      typeof consequence === 'function'
        ? await consequence({ ...context, evaluation: runEvaluation })
        : consequence,
      'consequence'
    );

    // Other tickets may terminalize while this call awaits journal commits or
    // async evidence builders. Re-read at the last possible moment and replace
    // only this run in a synchronous read/modify/write section; writing the
    // initial array here would clobber those unrelated terminal projections.
    const runs = this.readRuns();
    const currentRun = runs.find(item => item.id === id) || null;
    if (!this._canTerminalize(currentRun, sources, target, owner, allowExpiredLease, completedMs)) return null;
    const terminalRun = {
      ...currentRun,
      ...bodyPatch,
      status: target,
      completedAt: completedIso,
      updatedAt: completedIso,
      leaseOwner: null,
      leaseExpiresAt: null,
      lastHeartbeatAt: null
    };
    this.attachReplayMetadata(terminalRun, snapshot);
    terminalRun.runEvaluation = runEvaluation;
    terminalRun.runConsequence = runConsequence;
    const runIndex = runs.findIndex(item => item.id === id);
    runs[runIndex] = terminalRun;
    this.writeRuns(runs);

    for (const event of [
      { type: 'run.evaluation_completed', payload: { evaluation: runEvaluation } },
      { type: 'run.consequence_recorded', payload: { consequence: runConsequence } },
      normalizedTerminalEvent
    ]) {
      appendedEvents.push(await this.appendEvent({
        type: event.type,
        ticketId: terminalRun.ticketId,
        runId: terminalRun.id,
        ...(event.stepId === undefined ? {} : { stepId: event.stepId }),
        payload: this._payload(event.payload, `${event.type} payload`)
      }));
    }
    return {
      run: terminalRun,
      replaySnapshot: snapshot,
      evaluation: runEvaluation,
      consequence: runConsequence,
      events: appendedEvents
    };
  }
}

module.exports = {
  JsonRunTerminalizationRepository,
  REQUIRED_RUN_TERMINALIZATION_REPOSITORY_METHODS,
  assertRunTerminalizationRepository
};

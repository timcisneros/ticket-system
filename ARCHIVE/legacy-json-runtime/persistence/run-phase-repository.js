'use strict';

const REQUIRED_RUN_PHASE_REPOSITORY_METHODS = Object.freeze([
  'advanceRunPhase'
]);

const RUN_EXECUTION_PHASES = Object.freeze([
  'planning',
  'inspection',
  'mutation',
  'verification',
  'terminalization'
]);

const RUN_PHASE_TRANSITIONS = Object.freeze({
  planning: Object.freeze(['planning', 'inspection', 'mutation', 'verification']),
  inspection: Object.freeze(['inspection', 'mutation', 'verification']),
  mutation: Object.freeze(['mutation', 'verification']),
  verification: Object.freeze(['verification', 'terminalization']),
  terminalization: Object.freeze(['terminalization'])
});

class RunPhaseConflictError extends Error {
  constructor(runId, expectedPhase, currentPhase) {
    super(`Run ${runId} phase is ${currentPhase}; expected ${expectedPhase}`);
    this.name = 'RunPhaseConflictError';
    this.code = 'RUN_PHASE_CONFLICT';
    this.runId = runId;
    this.expectedPhase = expectedPhase;
    this.currentPhase = currentPhase;
  }
}

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

function timestamp(value, label) {
  const parsed = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new TypeError(`${label} must be a valid timestamp`);
  return parsed.toISOString();
}

function normalizeRunPhase(value, label = 'phase') {
  const phase = requiredString(value || 'planning', label);
  if (!RUN_EXECUTION_PHASES.includes(phase)) throw new TypeError(`Unsupported ${label}: ${phase}`);
  return phase;
}

function isRunPhaseTransitionAllowed(currentPhase, nextPhase) {
  const current = normalizeRunPhase(currentPhase, 'currentPhase');
  const next = normalizeRunPhase(nextPhase, 'nextPhase');
  return RUN_PHASE_TRANSITIONS[current].includes(next);
}

function assertRunPhaseRepository(repository) {
  if (!repository || typeof repository !== 'object') {
    throw new TypeError('run phase repository is required');
  }
  for (const method of REQUIRED_RUN_PHASE_REPOSITORY_METHODS) {
    if (typeof repository[method] !== 'function') {
      throw new TypeError(`run phase repository must implement ${method}()`);
    }
  }
  return repository;
}

class JsonRunPhaseRepository {
  constructor({
    readRuns,
    writeRuns,
    appendEvent,
    now = () => new Date()
  } = {}) {
    this.readRuns = requiredFunction(readRuns, 'readRuns');
    this.writeRuns = requiredFunction(writeRuns, 'writeRuns');
    this.appendEvent = requiredFunction(appendEvent, 'appendEvent');
    this.now = requiredFunction(now, 'now');
  }

  _clock() {
    const iso = timestamp(this.now(), 'now');
    return { iso, ms: Date.parse(iso) };
  }

  _hasLiveLease(run, leaseOwner, nowMs) {
    if (!run || run.status !== 'running' || run.leaseOwner !== leaseOwner) return false;
    const expiresAt = Date.parse(run.leaseExpiresAt || '');
    return !Number.isNaN(expiresAt) && expiresAt > nowMs;
  }

  async advanceRunPhase({
    runId,
    leaseOwner,
    fromPhase,
    toPhase,
    stepId = null,
    reason = 'Inferred from model response actions'
  }) {
    const id = positiveSafeInteger(runId, 'runId');
    const owner = requiredString(leaseOwner, 'leaseOwner');
    const source = normalizeRunPhase(fromPhase, 'fromPhase');
    const target = normalizeRunPhase(toPhase, 'toPhase');
    const normalizedStepId = stepId === undefined || stepId === null ? null : requiredString(stepId, 'stepId');
    const normalizedReason = requiredString(reason, 'reason');
    const runs = this.readRuns();
    const run = runs.find(item => item.id === id) || null;
    const clock = this._clock();
    if (!this._hasLiveLease(run, owner, clock.ms)) return null;

    const current = normalizeRunPhase(run.currentPhase || 'planning', 'run.currentPhase');
    if (current === target) return { run, event: null, changed: false };
    if (current !== source) throw new RunPhaseConflictError(id, source, current);
    if (!isRunPhaseTransitionAllowed(source, target)) {
      return { run, event: null, changed: false };
    }

    // JSON cannot make its append-only journal and run projection one filesystem
    // transaction. Commit the authoritative transition event first. A process
    // interruption can leave a stale projection, but never an unrecorded phase
    // advance; restart reconstruction derives the phase from this event.
    const event = await this.appendEvent({
      type: 'execution.phase_transition',
      ticketId: run.ticketId,
      runId: run.id,
      ...(normalizedStepId === null ? {} : { stepId: normalizedStepId }),
      payload: {
        fromPhase: source,
        toPhase: target,
        reason: normalizedReason
      }
    });

    // Re-read after the asynchronous journal commit so an unrelated run update
    // cannot be overwritten by an old array snapshot.
    const latestRuns = this.readRuns();
    const latestRun = latestRuns.find(item => item.id === id) || null;
    const projectionClock = this._clock();
    if (!this._hasLiveLease(latestRun, owner, projectionClock.ms)) return null;
    const latestPhase = normalizeRunPhase(latestRun.currentPhase || 'planning', 'run.currentPhase');
    if (latestPhase === target) return { run: latestRun, event, changed: false };
    if (latestPhase !== source) throw new RunPhaseConflictError(id, source, latestPhase);
    latestRun.currentPhase = target;
    latestRun.updatedAt = projectionClock.iso;
    this.writeRuns(latestRuns);
    return { run: latestRun, event, changed: true };
  }
}

module.exports = {
  JsonRunPhaseRepository,
  REQUIRED_RUN_PHASE_REPOSITORY_METHODS,
  RUN_EXECUTION_PHASES,
  RUN_PHASE_TRANSITIONS,
  RunPhaseConflictError,
  assertRunPhaseRepository,
  isRunPhaseTransitionAllowed,
  normalizeRunPhase
};

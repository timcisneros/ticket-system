'use strict';

const RUN_RECOVERY_MODES = Object.freeze(['lease_expiry', 'process_restart']);
const TERMINAL_RUN_STATUSES = new Set(['completed', 'failed', 'interrupted']);

const REQUIRED_RUN_RECOVERY_REPOSITORY_METHODS = Object.freeze([
  'listRecoverableRuns',
  'claimRunRecovery',
  'resumeRecoveredRun',
  'repairRecoveredRunTerminalProjection'
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

function nonNegativeSafeInteger(value, label) {
  const number = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  if (!Number.isSafeInteger(number) || number < 0) {
    throw new TypeError(`${label} must be a non-negative safe integer`);
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

function normalizeRecoveryMode(value) {
  const mode = requiredString(value || 'lease_expiry', 'mode');
  if (!RUN_RECOVERY_MODES.includes(mode)) throw new TypeError(`Unsupported run recovery mode: ${mode}`);
  return mode;
}

function assertRunRecoveryRepository(repository) {
  if (!repository || typeof repository !== 'object') {
    throw new TypeError('run recovery repository is required');
  }
  for (const method of REQUIRED_RUN_RECOVERY_REPOSITORY_METHODS) {
    if (typeof repository[method] !== 'function') {
      throw new TypeError(`run recovery repository must implement ${method}()`);
    }
  }
  return repository;
}

class JsonRunRecoveryRepository {
  constructor({
    readRuns,
    writeRuns,
    appendEvent,
    hasExclusiveProcessAuthority = () => false,
    sanitizePayload = value => value,
    now = () => new Date(),
    maxQueryRows = 1_000
  } = {}) {
    this.readRuns = requiredFunction(readRuns, 'readRuns');
    this.writeRuns = requiredFunction(writeRuns, 'writeRuns');
    this.appendEvent = requiredFunction(appendEvent, 'appendEvent');
    this.hasExclusiveProcessAuthority = requiredFunction(
      hasExclusiveProcessAuthority,
      'hasExclusiveProcessAuthority'
    );
    this.sanitizePayload = requiredFunction(sanitizePayload, 'sanitizePayload');
    this.now = requiredFunction(now, 'now');
    this.maxQueryRows = positiveSafeInteger(maxQueryRows, 'maxQueryRows');
  }

  _clock() {
    const iso = timestamp(this.now(), 'now');
    return { iso, ms: Date.parse(iso) };
  }

  _payload(value, label) {
    return jsonObject(this.sanitizePayload(jsonObject(value || {}, label)), label);
  }

  _assertProcessRestartAuthority(mode) {
    if (mode === 'process_restart' && !this.hasExclusiveProcessAuthority()) {
      const error = new Error('Process-restart recovery requires exclusive JSON writer authority');
      error.code = 'RUN_RECOVERY_AUTHORITY_REQUIRED';
      throw error;
    }
  }

  _leaseRecoverable(run, nowMs) {
    if (!run || run.status !== 'running') return false;
    if (!run.leaseOwner || !run.leaseExpiresAt) return true;
    const expiresAt = Date.parse(run.leaseExpiresAt);
    return Number.isNaN(expiresAt) || expiresAt <= nowMs;
  }

  _candidate(run, mode, nowMs) {
    if (!run || !['pending', 'running'].includes(run.status)) return false;
    return mode === 'process_restart' || this._leaseRecoverable(run, nowMs);
  }

  _hasRecoveryLease(run, recoveryOwner, nowMs) {
    if (!run || run.leaseOwner !== recoveryOwner || !run.leaseExpiresAt) return false;
    const expiresAt = Date.parse(run.leaseExpiresAt);
    return !Number.isNaN(expiresAt) && expiresAt > nowMs;
  }

  async listRecoverableRuns({ mode = 'lease_expiry', afterId = 0, limit = 100 } = {}) {
    const recoveryMode = normalizeRecoveryMode(mode);
    this._assertProcessRestartAuthority(recoveryMode);
    const cursor = nonNegativeSafeInteger(afterId, 'afterId');
    const boundedLimit = positiveSafeInteger(limit, 'limit');
    if (boundedLimit > this.maxQueryRows) {
      throw new RangeError(`limit exceeds the configured maximum of ${this.maxQueryRows}`);
    }
    const clock = this._clock();
    const candidates = this.readRuns()
      .filter(run => run && run.id > cursor && this._candidate(run, recoveryMode, clock.ms))
      .sort((left, right) => left.id - right.id);
    const runs = candidates.slice(0, boundedLimit);
    const last = runs[runs.length - 1] || null;
    return {
      runs,
      nextAfterId: candidates.length > boundedLimit && last ? last.id : null
    };
  }

  async claimRunRecovery({
    runId,
    recoveryOwner,
    leaseDurationMs,
    mode = 'lease_expiry',
    eventPayload = {}
  }) {
    const id = positiveSafeInteger(runId, 'runId');
    const owner = requiredString(recoveryOwner, 'recoveryOwner');
    const duration = positiveSafeInteger(leaseDurationMs, 'leaseDurationMs');
    const recoveryMode = normalizeRecoveryMode(mode);
    this._assertProcessRestartAuthority(recoveryMode);
    const runs = this.readRuns();
    const run = runs.find(item => item.id === id) || null;
    const clock = this._clock();
    if (!this._candidate(run, recoveryMode, clock.ms)) return null;

    const previousStatus = run.status;
    const previousLease = {
      leaseOwner: run.leaseOwner || null,
      leaseExpiresAt: run.leaseExpiresAt || null,
      lastHeartbeatAt: run.lastHeartbeatAt || null
    };
    run.leaseOwner = owner;
    run.leaseExpiresAt = new Date(clock.ms + duration).toISOString();
    run.lastHeartbeatAt = clock.iso;
    run.updatedAt = clock.iso;
    this.writeRuns(runs);
    const event = await this.appendEvent({
      type: 'run.recovery_claimed',
      ticketId: run.ticketId,
      runId: run.id,
      payload: {
        ...this._payload(eventPayload, 'recovery claim event payload'),
        mode: recoveryMode,
        recoveryOwner: owner,
        recoveryLeaseExpiresAt: run.leaseExpiresAt,
        previousStatus,
        previousLease,
        recoveredAt: clock.iso
      }
    });
    return { run, event, previousStatus, previousLease };
  }

  async resumeRecoveredRun({ runId, recoveryOwner, eventPayload = {} }) {
    const id = positiveSafeInteger(runId, 'runId');
    const owner = requiredString(recoveryOwner, 'recoveryOwner');
    const runs = this.readRuns();
    const run = runs.find(item => item.id === id) || null;
    const clock = this._clock();
    if (!run || !['pending', 'running'].includes(run.status) ||
        !this._hasRecoveryLease(run, owner, clock.ms)) return null;

    const previousStatus = run.status;
    const previousLease = {
      leaseOwner: run.leaseOwner,
      leaseExpiresAt: run.leaseExpiresAt,
      lastHeartbeatAt: run.lastHeartbeatAt || null
    };
    run.status = 'pending';
    run.leaseOwner = null;
    run.leaseExpiresAt = null;
    run.lastHeartbeatAt = null;
    run.updatedAt = clock.iso;
    delete run.startedAt;
    delete run.completedAt;
    this.writeRuns(runs);
    const event = await this.appendEvent({
      type: 'run.resumed',
      ticketId: run.ticketId,
      runId: run.id,
      payload: {
        ...this._payload(eventPayload, 'resume event payload'),
        previousStatus,
        previousLease,
        recoveredAt: clock.iso,
        status: run.status
      }
    });
    return { run, event, previousStatus, previousLease };
  }

  async repairRecoveredRunTerminalProjection({
    runId,
    recoveryOwner,
    status,
    eventPayload = {}
  }) {
    const id = positiveSafeInteger(runId, 'runId');
    const owner = requiredString(recoveryOwner, 'recoveryOwner');
    const terminalStatus = requiredString(status, 'status');
    if (!TERMINAL_RUN_STATUSES.has(terminalStatus)) {
      throw new TypeError(`Unsupported terminal run status: ${terminalStatus}`);
    }
    const runs = this.readRuns();
    const run = runs.find(item => item.id === id) || null;
    const clock = this._clock();
    if (!run || !['pending', 'running'].includes(run.status) ||
        !this._hasRecoveryLease(run, owner, clock.ms)) return null;

    const previousStatus = run.status;
    const previousLease = {
      leaseOwner: run.leaseOwner,
      leaseExpiresAt: run.leaseExpiresAt,
      lastHeartbeatAt: run.lastHeartbeatAt || null
    };
    run.status = terminalStatus;
    run.completedAt = run.completedAt || clock.iso;
    run.updatedAt = clock.iso;
    run.leaseOwner = null;
    run.leaseExpiresAt = null;
    run.lastHeartbeatAt = null;
    this.writeRuns(runs);
    const event = await this.appendEvent({
      type: 'run.terminal_projection_repaired',
      ticketId: run.ticketId,
      runId: run.id,
      payload: {
        ...this._payload(eventPayload, 'terminal projection repair event payload'),
        previousStatus,
        previousLease,
        repairedAt: clock.iso,
        status: terminalStatus
      }
    });
    return { run, event, previousStatus, previousLease };
  }
}

module.exports = {
  JsonRunRecoveryRepository,
  REQUIRED_RUN_RECOVERY_REPOSITORY_METHODS,
  RUN_RECOVERY_MODES,
  assertRunRecoveryRepository,
  normalizeRecoveryMode
};

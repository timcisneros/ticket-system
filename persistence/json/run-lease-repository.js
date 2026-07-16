'use strict';

const REQUIRED_RUN_LEASE_REPOSITORY_METHODS = Object.freeze([
  'getRun',
  'verifyRunLease',
  'listPendingRuns',
  'listExpiredRunningRuns',
  'claimPendingRun',
  'heartbeatRunLease',
  'releaseRunLease',
  'persistRunWorkflowStep',
  'recoverExpiredRun'
]);

class RunLeaseLostError extends Error {
  constructor(runId, leaseOwner) {
    super(`Run ${runId} is no longer controlled by live lease ${leaseOwner}`);
    this.name = 'RunLeaseLostError';
    this.code = 'RUN_LEASE_LOST';
    this.runId = runId;
    this.leaseOwner = leaseOwner;
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

function jsonObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value;
}

function timestamp(date, label) {
  const value = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(value.getTime())) throw new TypeError(`${label} must be a valid date`);
  return value.toISOString();
}

function sortableTimestamp(value) {
  const parsed = Date.parse(value || '');
  return Number.isNaN(parsed) ? 0 : parsed;
}

function pendingCursor(value) {
  if (value === undefined || value === null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('cursor must be an object');
  }
  return {
    createdAt: timestamp(value.createdAt, 'cursor.createdAt'),
    id: positiveSafeInteger(value.id, 'cursor.id')
  };
}

function assertRunLeaseRepository(repository) {
  if (!repository || typeof repository !== 'object') {
    throw new TypeError('run lease repository is required');
  }
  for (const method of REQUIRED_RUN_LEASE_REPOSITORY_METHODS) {
    if (typeof repository[method] !== 'function') {
      throw new TypeError(`run lease repository must implement ${method}()`);
    }
  }
  return repository;
}

class JsonRunLeaseRepository {
  constructor({
    readRuns,
    writeRuns,
    appendEvent,
    now = () => new Date(),
    sanitizePayload = value => value,
    maxQueryRows = 1_000,
    maxEligibleRunIds = 1_000
  } = {}) {
    this.readRuns = requiredFunction(readRuns, 'readRuns');
    this.writeRuns = requiredFunction(writeRuns, 'writeRuns');
    this.appendEvent = requiredFunction(appendEvent, 'appendEvent');
    this.now = requiredFunction(now, 'now');
    this.sanitizePayload = requiredFunction(sanitizePayload, 'sanitizePayload');
    this.maxQueryRows = positiveSafeInteger(maxQueryRows, 'maxQueryRows');
    this.maxEligibleRunIds = positiveSafeInteger(maxEligibleRunIds, 'maxEligibleRunIds');
  }

  _now() {
    const value = this.now();
    const iso = timestamp(value, 'now');
    return { iso, ms: Date.parse(iso) };
  }

  _lease(run, leaseOwner, leaseDurationMs, clock) {
    return {
      leaseOwner,
      leaseExpiresAt: new Date(clock.ms + leaseDurationMs).toISOString(),
      lastHeartbeatAt: clock.iso,
      updatedAt: clock.iso
    };
  }

  _payload(value, label) {
    return jsonObject(this.sanitizePayload(jsonObject(value || {}, label)), label);
  }

  _isExpired(run, nowMs) {
    if (!run || !run.leaseExpiresAt) return false;
    const expiresAt = Date.parse(run.leaseExpiresAt);
    return !Number.isNaN(expiresAt) && expiresAt <= nowMs;
  }

  _hasLiveLease(run, leaseOwner, nowMs) {
    return Boolean(run && run.leaseOwner === leaseOwner && !this._isExpired(run, nowMs));
  }

  async getRun(runId) {
    const id = positiveSafeInteger(runId, 'runId');
    return this.readRuns().find(run => run.id === id) || null;
  }

  async verifyRunLease({ runId, leaseOwner }) {
    const id = positiveSafeInteger(runId, 'runId');
    const owner = requiredString(leaseOwner, 'leaseOwner');
    const run = this.readRuns().find(item => item.id === id) || null;
    const clock = this._now();
    return run && ['pending', 'running'].includes(run.status) && this._hasLiveLease(run, owner, clock.ms)
      ? run
      : null;
  }

  async listPendingRuns({ limit = 100, cursor = null, scanEndCursor = null } = {}) {
    const boundedLimit = positiveSafeInteger(limit, 'limit');
    if (boundedLimit > this.maxQueryRows) {
      throw new RangeError(`limit exceeds the configured maximum of ${this.maxQueryRows}`);
    }
    const after = pendingCursor(cursor);
    const requestedScanEnd = pendingCursor(scanEndCursor);
    const sorted = this.readRuns()
      .filter(run => run.status === 'pending')
      .sort((left, right) => {
        const byTime = sortableTimestamp(left.createdAt) - sortableTimestamp(right.createdAt);
        return byTime || left.id - right.id;
      });
    const finalRun = sorted[sorted.length - 1] || null;
    const scanEnd = requestedScanEnd || (finalRun
      ? { createdAt: timestamp(finalRun.createdAt, 'run.createdAt'), id: finalRun.id }
      : null);
    const candidates = sorted.filter(run => {
      const runTime = sortableTimestamp(run.createdAt);
      const afterTime = after ? sortableTimestamp(after.createdAt) : null;
      const scanEndTime = scanEnd ? sortableTimestamp(scanEnd.createdAt) : null;
      const isAfter = !after || runTime > afterTime || (runTime === afterTime && run.id > after.id);
      const isWithinScan = !scanEnd || runTime < scanEndTime ||
        (runTime === scanEndTime && run.id <= scanEnd.id);
      return isAfter && isWithinScan;
    });
    const page = candidates.slice(0, boundedLimit);
    const last = page[page.length - 1] || null;
    return {
      runs: page,
      nextCursor: candidates.length > boundedLimit && last
        ? { createdAt: timestamp(last.createdAt, 'run.createdAt'), id: last.id }
        : null,
      scanEndCursor: candidates.length > boundedLimit ? scanEnd : null
    };
  }

  async listExpiredRunningRuns({ limit = 100 } = {}) {
    const boundedLimit = positiveSafeInteger(limit, 'limit');
    if (boundedLimit > this.maxQueryRows) {
      throw new RangeError(`limit exceeds the configured maximum of ${this.maxQueryRows}`);
    }
    const clock = this._now();
    return this.readRuns()
      .filter(run => run.status === 'running' && this._isExpired(run, clock.ms))
      .sort((left, right) => {
        const byExpiry = sortableTimestamp(left.leaseExpiresAt) - sortableTimestamp(right.leaseExpiresAt);
        return byExpiry || left.id - right.id;
      })
      .slice(0, boundedLimit);
  }

  async claimPendingRun({ leaseOwner, leaseDurationMs, eligibleRunIds = null, claimPayload = {} }) {
    const owner = requiredString(leaseOwner, 'leaseOwner');
    const duration = positiveSafeInteger(leaseDurationMs, 'leaseDurationMs');
    const eligible = eligibleRunIds === null
      ? null
      : eligibleRunIds.map((id, index) => positiveSafeInteger(id, `eligibleRunIds[${index}]`));
    if (eligible && eligible.length > this.maxEligibleRunIds) {
      throw new RangeError(`eligibleRunIds exceeds the configured limit of ${this.maxEligibleRunIds}`);
    }

    const runs = this.readRuns();
    const clock = this._now();
    const eligibleSet = eligible === null ? null : new Set(eligible);
    const run = runs
      .filter(item => item.status === 'pending' && (!eligibleSet || eligibleSet.has(item.id)))
      .filter(item => !item.leaseOwner || this._isExpired(item, clock.ms))
      .sort((left, right) => {
        const byTime = sortableTimestamp(left.createdAt) - sortableTimestamp(right.createdAt);
        return byTime || left.id - right.id;
      })[0] || null;
    if (!run) return null;

    Object.assign(run, this._lease(run, owner, duration, clock));
    const callerPayload = typeof claimPayload === 'function'
      ? this._payload(claimPayload(run), 'claimPayload')
      : this._payload(claimPayload, 'claimPayload');
    this.writeRuns(runs);
    const event = await this.appendEvent({
      type: 'run.lease_acquired',
      ticketId: run.ticketId,
      runId: run.id,
      payload: {
        ...callerPayload,
        leaseOwner: run.leaseOwner,
        leaseExpiresAt: run.leaseExpiresAt,
        lastHeartbeatAt: run.lastHeartbeatAt
      }
    });
    return { run, event };
  }

  async heartbeatRunLease({ runId, leaseOwner, leaseDurationMs, payload = {} }) {
    const id = positiveSafeInteger(runId, 'runId');
    const owner = requiredString(leaseOwner, 'leaseOwner');
    const duration = positiveSafeInteger(leaseDurationMs, 'leaseDurationMs');
    const runs = this.readRuns();
    const run = runs.find(item => item.id === id);
    const clock = this._now();
    if (!run || !['pending', 'running'].includes(run.status) || !this._hasLiveLease(run, owner, clock.ms)) {
      return null;
    }

    Object.assign(run, this._lease(run, owner, duration, clock));
    this.writeRuns(runs);
    const event = await this.appendEvent({
      type: 'run.heartbeat',
      ticketId: run.ticketId,
      runId: run.id,
      payload: {
        ...this._payload(payload, 'heartbeat payload'),
        leaseOwner: run.leaseOwner,
        leaseExpiresAt: run.leaseExpiresAt,
        lastHeartbeatAt: run.lastHeartbeatAt,
        currentStepId: run.currentStepId || null,
        currentWorkflowAction: run.currentWorkflowAction || null
      }
    });
    return { run, event };
  }

  async releaseRunLease({ runId, leaseOwner, payload = {} }) {
    const id = positiveSafeInteger(runId, 'runId');
    const owner = requiredString(leaseOwner, 'leaseOwner');
    const runs = this.readRuns();
    const run = runs.find(item => item.id === id);
    const clock = this._now();
    if (!run || !this._hasLiveLease(run, owner, clock.ms)) return null;

    run.leaseOwner = null;
    run.leaseExpiresAt = null;
    run.lastHeartbeatAt = null;
    run.updatedAt = clock.iso;
    this.writeRuns(runs);
    const event = await this.appendEvent({
      type: 'run.lease_released',
      ticketId: run.ticketId,
      runId: run.id,
      payload: {
        ...this._payload(payload, 'release payload'),
        leaseOwner: owner,
        releasedAt: run.updatedAt
      }
    });
    return { run, event };
  }

  async persistRunWorkflowStep({
    runId,
    leaseOwner,
    leaseDurationMs,
    stepId = null,
    action = null,
    status = 'started',
    payload = {}
  }) {
    const id = positiveSafeInteger(runId, 'runId');
    const owner = requiredString(leaseOwner, 'leaseOwner');
    const duration = positiveSafeInteger(leaseDurationMs, 'leaseDurationMs');
    const normalizedStatus = requiredString(status, 'status');
    const runs = this.readRuns();
    const run = runs.find(item => item.id === id);
    const clock = this._now();
    if (!run || run.status !== 'running' || !this._hasLiveLease(run, owner, clock.ms)) return null;

    run.currentStepId = stepId === undefined || stepId === null ? null : String(stepId);
    run.currentWorkflowAction = action === undefined || action === null ? null : String(action);
    Object.assign(run, this._lease(run, owner, duration, clock));
    this.writeRuns(runs);
    const event = await this.appendEvent({
      type: 'workflow.step.persisted',
      ticketId: run.ticketId,
      runId: run.id,
      stepId: run.currentStepId,
      payload: {
        ...this._payload(payload, 'workflow step payload'),
        status: normalizedStatus,
        action: run.currentWorkflowAction,
        leaseOwner: run.leaseOwner,
        leaseExpiresAt: run.leaseExpiresAt,
        lastHeartbeatAt: run.lastHeartbeatAt
      }
    });
    return { run, event };
  }

  async recoverExpiredRun({ runId, eventType = 'run.resumed', eventPayload = {} }) {
    const id = positiveSafeInteger(runId, 'runId');
    const type = requiredString(eventType, 'eventType');
    const runs = this.readRuns();
    const run = runs.find(item => item.id === id);
    const clock = this._now();
    if (!run || run.status !== 'running' || !this._isExpired(run, clock.ms)) return null;

    const previousLease = {
      leaseOwner: run.leaseOwner || null,
      leaseExpiresAt: run.leaseExpiresAt || null,
      lastHeartbeatAt: run.lastHeartbeatAt || null
    };
    run.status = 'pending';
    run.leaseOwner = null;
    run.leaseExpiresAt = null;
    run.lastHeartbeatAt = null;
    run.updatedAt = clock.iso;
    delete run.startedAt;
    this.writeRuns(runs);
    const event = await this.appendEvent({
      type,
      ticketId: run.ticketId,
      runId: run.id,
      payload: {
        ...this._payload(eventPayload, 'recovery event payload'),
        previousLease,
        recoveredAt: run.updatedAt,
        status: run.status
      }
    });
    return { run, event, previousLease };
  }
}

module.exports = {
  JsonRunLeaseRepository,
  REQUIRED_RUN_LEASE_REPOSITORY_METHODS,
  RunLeaseLostError,
  assertRunLeaseRepository
};

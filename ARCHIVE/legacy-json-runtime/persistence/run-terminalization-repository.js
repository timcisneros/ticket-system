'use strict';

const REQUIRED_RUN_TERMINALIZATION_REPOSITORY_METHODS = Object.freeze([
  'terminalizeRun',
  'repairRunTerminalization'
]);

const SINGULAR_REPAIR_EVENT_TYPES = new Set([
  'run.postconditions_checked',
  'run.verification_failed',
  'run.verification_passed',
  'run.triage_created',
  'run.snapshot_finalized',
  'replay.snapshot.finalized',
  'run.violations_checked',
  'run.evaluation_completed',
  'run.consequence_recorded',
  'run.terminalized'
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

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(item => canonicalJson(item)).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  const encoded = JSON.stringify(value);
  return encoded === undefined ? 'null' : encoded;
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
    readRunEvents,
    readReplaySnapshot,
    writeReplaySnapshotFile,
    attachReplayMetadata,
    appendEvent,
    sanitizePayload = value => value,
    now = () => new Date()
  } = {}) {
    this.readRuns = requiredFunction(readRuns, 'readRuns');
    this.writeRuns = requiredFunction(writeRuns, 'writeRuns');
    this.readRunEvents = requiredFunction(readRunEvents, 'readRunEvents');
    this.readReplaySnapshot = requiredFunction(readReplaySnapshot, 'readReplaySnapshot');
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
    const requestedPatch = this._payload(patch, 'patch');
    if (Object.prototype.hasOwnProperty.call(requestedPatch, 'currentPhase') &&
        requestedPatch.currentPhase !== 'terminalization') {
      throw new TypeError('Terminal runs must project terminalization phase');
    }
    const bodyPatch = { ...requestedPatch, currentPhase: 'terminalization' };
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

  async repairRunTerminalization({
    runId,
    status,
    recoveryOwner = null,
    completedAt = null,
    patch = {},
    replaySnapshot,
    beforeReplayEvents = [],
    replayEvent,
    beforeEvaluationEvents = [],
    evaluation,
    consequence,
    terminalEvent
  }) {
    const id = positiveSafeInteger(runId, 'runId');
    const target = requiredString(status, 'status');
    if (!['completed', 'failed', 'interrupted'].includes(target)) {
      throw new TypeError(`Unsupported terminal run status: ${target}`);
    }
    const owner = recoveryOwner === undefined || recoveryOwner === null
      ? null
      : requiredString(recoveryOwner, 'recoveryOwner');
    const completedIso = timestamp(completedAt || this.now(), 'completedAt');
    const authorityNowMs = Date.parse(timestamp(this.now(), 'now'));
    const requestedPatch = this._payload(patch, 'patch');
    if (Object.prototype.hasOwnProperty.call(requestedPatch, 'currentPhase') &&
        requestedPatch.currentPhase !== 'terminalization') {
      throw new TypeError('Terminal runs must project terminalization phase');
    }
    const bodyPatch = { ...requestedPatch, currentPhase: 'terminalization' };
    const requestedSnapshot = this._payload(replaySnapshot, 'replaySnapshot');
    const preReplay = normalizeEvents(beforeReplayEvents, 'beforeReplayEvents');
    const replay = normalizeEvent(replayEvent, 'replayEvent');
    const preEvaluation = normalizeEvents(beforeEvaluationEvents, 'beforeEvaluationEvents');
    const terminal = normalizeEvent(terminalEvent, 'terminalEvent');

    const initialRuns = this.readRuns();
    const initialRun = initialRuns.find(item => item.id === id) || null;
    if (!this._canRepairTerminalization(initialRun, target, owner, authorityNowMs)) return null;

    const existingEvents = this.readRunEvents(id).slice();
    const failIntegrity = message => {
      const error = new Error(`Run ${id} terminal repair failed integrity validation: ${message}`);
      error.code = 'TERMINAL_REPAIR_INTEGRITY_FAILURE';
      return error;
    };
    for (const [label, types] of [
      ['postcondition summary', ['run.postconditions_checked']],
      ['verification verdict', ['run.verification_failed', 'run.verification_passed']],
      ['triage record', ['run.triage_created']],
      ['replay finalization', ['run.snapshot_finalized', 'replay.snapshot.finalized']],
      ['violation summary', ['run.violations_checked']],
      ['evaluation', ['run.evaluation_completed']],
      ['consequence', ['run.consequence_recorded']],
      ['terminal lifecycle', ['run.terminalized']]
    ]) {
      const matches = existingEvents.filter(event => event && types.includes(event.type));
      if (matches.length > 1) throw failIntegrity(`${label} evidence is duplicated or contradictory`);
    }
    const existingTerminalEvent = existingEvents.find(event => event && event.type === 'run.terminalized');
    if (existingTerminalEvent) {
      const evidenceStatus = existingTerminalEvent.payload && existingTerminalEvent.payload.status;
      if (initialRun.status !== target || (evidenceStatus && evidenceStatus !== target)) {
        throw failIntegrity(`terminal projection or lifecycle evidence conflicts with target ${target}`);
      }
      return {
        repaired: false,
        run: initialRun,
        replaySnapshot: this.readReplaySnapshot(initialRun),
        evaluation: initialRun.runEvaluation || null,
        consequence: initialRun.runConsequence || null,
        events: []
      };
    }
    const executionEvent = existingEvents.find(event => event &&
      (event.type === 'run.execution_completed' || event.type === 'run.execution_failed'));
    if (!executionEvent) {
      const error = new Error(`Run ${id} cannot be repaired without execution-completion evidence`);
      error.code = 'TERMINAL_REPAIR_EVIDENCE_REQUIRED';
      throw error;
    }

    const appendedEvents = [];
    const observedEvents = existingEvents.slice();
    const appendMissing = async event => {
      const normalized = normalizeEvent(event, 'repair event');
      const duplicate = SINGULAR_REPAIR_EVENT_TYPES.has(normalized.type)
        ? observedEvents.some(item => item && item.type === normalized.type)
        : observedEvents.some(item => item && item.type === normalized.type &&
          canonicalJson(item.payload || {}) === canonicalJson(normalized.payload));
      if (duplicate) return null;
      const stored = await this.appendEvent({
        type: normalized.type,
        ticketId: initialRun.ticketId,
        runId: initialRun.id,
        ...(normalized.stepId === undefined ? {} : { stepId: normalized.stepId }),
        payload: this._payload(normalized.payload, `${normalized.type} payload`)
      });
      observedEvents.push(stored);
      appendedEvents.push(stored);
      return stored;
    };

    for (const event of preReplay) await appendMissing(event);

    const replayWasFinalized = observedEvents.some(event => event &&
      (event.type === 'run.snapshot_finalized' || event.type === 'replay.snapshot.finalized'));
    let effectiveSnapshot = requestedSnapshot;
    if (replayWasFinalized) {
      effectiveSnapshot = this.readReplaySnapshot(initialRun);
      if (!effectiveSnapshot) {
        throw failIntegrity('snapshot-finalized evidence has no stored replay snapshot');
      }
      if (effectiveSnapshot.terminalStatus && effectiveSnapshot.terminalStatus !== target) {
        throw failIntegrity(`finalized replay status ${effectiveSnapshot.terminalStatus} conflicts with target ${target}`);
      }
    } else {
      this.writeReplaySnapshotFile(id, requestedSnapshot);
      effectiveSnapshot = requestedSnapshot;
      await appendMissing(replay);
    }

    for (const event of preEvaluation) await appendMissing(event);

    const projectedRun = {
      ...initialRun,
      ...bodyPatch,
      status: target,
      completedAt: initialRun.completedAt || completedIso,
      updatedAt: completedIso,
      leaseOwner: null,
      leaseExpiresAt: null,
      lastHeartbeatAt: null
    };
    this.attachReplayMetadata(projectedRun, effectiveSnapshot);
    const projectedTerminalEvent = {
      type: terminal.type,
      ticketId: projectedRun.ticketId,
      runId: projectedRun.id,
      payload: terminal.payload
    };
    const contextEvents = [...observedEvents, projectedTerminalEvent];
    const existingEvaluationEvent = observedEvents.find(event => event && event.type === 'run.evaluation_completed');
    const eventEvaluation = existingEvaluationEvent && existingEvaluationEvent.payload
      ? existingEvaluationEvent.payload.evaluation
      : null;
    if (initialRun.runEvaluation && eventEvaluation &&
        canonicalJson(initialRun.runEvaluation) !== canonicalJson(eventEvaluation)) {
      throw failIntegrity('evaluation projection conflicts with lifecycle evidence');
    }
    const runEvaluation = this._payload(
      initialRun.runEvaluation ||
        eventEvaluation ||
        (typeof evaluation === 'function'
          ? await evaluation({ run: projectedRun, replaySnapshot: effectiveSnapshot, events: contextEvents })
          : evaluation),
      'evaluation'
    );
    const existingConsequenceEvent = observedEvents.find(event => event && event.type === 'run.consequence_recorded');
    const eventConsequence = existingConsequenceEvent && existingConsequenceEvent.payload
      ? existingConsequenceEvent.payload.consequence
      : null;
    if (initialRun.runConsequence && eventConsequence &&
        canonicalJson(initialRun.runConsequence) !== canonicalJson(eventConsequence)) {
      throw failIntegrity('consequence projection conflicts with lifecycle evidence');
    }
    const runConsequence = this._payload(
      initialRun.runConsequence ||
        eventConsequence ||
        (typeof consequence === 'function'
          ? await consequence({
              run: projectedRun,
              replaySnapshot: effectiveSnapshot,
              events: contextEvents,
              evaluation: runEvaluation
            })
          : consequence),
      'consequence'
    );

    const runs = this.readRuns();
    const currentRun = runs.find(item => item.id === id) || null;
    if (!this._canRepairTerminalization(currentRun, target, owner, authorityNowMs)) return null;
    const repairedRun = {
      ...currentRun,
      ...bodyPatch,
      status: target,
      completedAt: currentRun.completedAt || completedIso,
      updatedAt: completedIso,
      leaseOwner: null,
      leaseExpiresAt: null,
      lastHeartbeatAt: null,
      runEvaluation,
      runConsequence
    };
    this.attachReplayMetadata(repairedRun, effectiveSnapshot);
    runs[runs.findIndex(item => item.id === id)] = repairedRun;
    this.writeRuns(runs);

    await appendMissing({ type: 'run.evaluation_completed', payload: { evaluation: runEvaluation } });
    await appendMissing({ type: 'run.consequence_recorded', payload: { consequence: runConsequence } });
    await appendMissing(terminal);

    return {
      repaired: true,
      run: repairedRun,
      replaySnapshot: effectiveSnapshot,
      evaluation: runEvaluation,
      consequence: runConsequence,
      events: appendedEvents
    };
  }

  _canRepairTerminalization(run, target, recoveryOwner, completedAtMs) {
    if (!run) return false;
    if (['completed', 'failed', 'interrupted'].includes(run.status)) return run.status === target;
    if (run.status !== 'running' || !recoveryOwner || run.leaseOwner !== recoveryOwner) return false;
    if (!run.leaseExpiresAt) return false;
    const expiresAt = Date.parse(run.leaseExpiresAt);
    return !Number.isNaN(expiresAt) && expiresAt > completedAtMs;
  }
}

module.exports = {
  JsonRunTerminalizationRepository,
  REQUIRED_RUN_TERMINALIZATION_REPOSITORY_METHODS,
  assertRunTerminalizationRepository
};

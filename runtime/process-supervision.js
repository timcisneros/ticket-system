'use strict';

const PROCESS_SUPERVISION_VERSION = 1;
const PROCESS_SUPERVISION_MAX_OPERATIONS = 64;

const TERMINAL_RUN_STATUSES = new Set(['completed', 'failed', 'interrupted']);
const PROCESS_TERMINAL_FAILURES = new Set([
  'failed_to_start',
  'exited_nonzero',
  'signaled',
  'timed_out',
  'output_limit_exceeded',
  'resource_limit_exceeded',
  'runtime_interrupted'
]);

const DIAGNOSTIC_CODES = Object.freeze({
  policy_denial: new Set([
    'PROCESS_TARGET_UNKNOWN',
    'PROCESS_PROFILE_UNKNOWN',
    'PROCESS_PHASE_DENIED',
    'PROCESS_SANDBOX_UNAVAILABLE',
    'PROCESS_RUNTIME_CAPABILITY_UNAVAILABLE',
    'PROCESS_RUNTIME_CAPABILITY_MISMATCH'
  ]),
  capacity_waiting: new Set([
    'RUNTIME_CAPACITY_UNAVAILABLE',
    'TARGET_CAPACITY_UNAVAILABLE',
    'PROCESS_LAUNCHER_CAPACITY_UNAVAILABLE',
    'PROCESS_LAUNCHER_REGISTRY_FULL'
  ]),
  budget_exhaustion: new Set([
    'RUN_BUDGET_EXHAUSTED',
    'RUN_RUNTIME_DURATION_EXCEEDED',
    'RUN_FEASIBILITY_REJECTED',
    'RUN_LIMIT_EXCEEDED'
  ]),
  containment_failure: new Set([
    'PROCESS_CONTAINMENT_UNAVAILABLE',
    'PROCESS_CONTAINMENT_GENERATION_MISMATCH',
    'PROCESS_CONTAINMENT_EXPIRED',
    'PROCESS_CGROUP_DELEGATION_UNAVAILABLE',
    'PROCESS_CGROUP_CONTROLLER_UNAVAILABLE',
    'PROCESS_CGROUP_LIMIT_UNAVAILABLE',
    'PROCESS_CGROUP_MEMBERSHIP_FAILED',
    'PROCESS_CGROUP_TERMINATION_FAILED',
    'PROCESS_NAMESPACE_UNAVAILABLE',
    'PROCESS_MOUNT_LAYOUT_INVALID',
    'PROCESS_NETWORK_ISOLATION_UNAVAILABLE',
    'PROCESS_SECCOMP_INSTALLATION_FAILED',
    'PROCESS_ROOTFS_REGISTRY_INVALID',
    'PROCESS_ROOTFS_UNAVAILABLE',
    'PROCESS_ROOTFS_MANIFEST_INVALID',
    'PROCESS_ROOTFS_MANIFEST_MISMATCH',
    'PROCESS_ROOTFS_IDENTITY_CHANGED',
    'PROCESS_EXECUTABLE_IDENTITY_MISMATCH'
  ]),
  cancellation_failure: new Set([
    'PROCESS_EXECUTION_CANCELLATION_FAILED',
    'PROCESS_OPERATION_TERMINATION_FAILED',
    'PROCESS_CGROUP_TERMINATION_FAILED'
  ]),
  artifact_failure: new Set([
    'PROCESS_OUTPUT_UNAVAILABLE',
    'PROCESS_OUTPUT_CHUNK_INVALID',
    'PROCESS_OUTPUT_HASH_MISMATCH',
    'PROCESS_OUTPUT_ARTIFACT_FAILED',
    'PROCESS_OUTPUT_ACKNOWLEDGEMENT_FAILED'
  ]),
  evidence_failure: new Set([
    'EVENT_PERSISTENCE_UNAVAILABLE',
    'EVIDENCE_PERSISTENCE_FAILED',
    'PROCESS_EXECUTION_EVIDENCE_FAILED'
  ]),
  recovery_failure: new Set([
    'PROCESS_EXECUTION_RECONCILIATION_FAILED',
    'PROCESS_EXECUTION_OPERATION_LOST',
    'PROCESS_EXECUTION_LAUNCHER_RESTARTED',
    'PROCESS_LAUNCHER_REGISTRY_INVALID',
    'RUNTIME_CAPACITY_RECONCILIATION_FAILED',
    'RUN_BUDGET_RECONCILIATION_FAILED'
  ]),
  verification_failure: new Set([
    'VERIFICATION_FAILED',
    'POSTCONDITION_EVALUATION_FAILED',
    'POSTCONDITION_EVIDENCE_UNAVAILABLE',
    'COMPLETION_EVIDENCE_MISSING',
    'COMPLETION_EVIDENCE_CONTRADICTORY'
  ])
});

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.values(value).forEach(deepFreeze);
  return Object.freeze(value);
}

function compareCanonicalText(left, right) {
  const leftText = String(left);
  const rightText = String(right);
  if (leftText < rightText) return -1;
  if (leftText > rightText) return 1;
  return 0;
}

function eventType(event) {
  return event && typeof event.type === 'string' ? event.type : null;
}

function eventPayload(event) {
  return event && event.payload && typeof event.payload === 'object'
    ? event.payload
    : {};
}

function eventOperationIdentity(event) {
  const payload = eventPayload(event);
  return typeof payload.operationIdentity === 'string'
    ? payload.operationIdentity
    : null;
}

function durableCodes(run, events) {
  const values = [
    run && run.failure && run.failure.code,
    run && run.errorCode,
    run && run.replaySnapshot && run.replaySnapshot.failure &&
      run.replaySnapshot.failure.code
  ].filter(value => typeof value === 'string');
  for (const event of events) {
    const payload = eventPayload(event);
    for (const value of [
      payload.code,
      payload.errorCode,
      payload.failure && payload.failure.code
    ]) {
      if (typeof value === 'string') values.push(value);
    }
  }
  return new Set(values);
}

function firstCodeIn(codes, accepted) {
  for (const code of codes) {
    if (accepted.has(code)) return code;
  }
  return null;
}

function exactEventCode(events, types) {
  const event = events.find(item => types.has(eventType(item)));
  if (!event) return null;
  const payload = eventPayload(event);
  return typeof payload.code === 'string'
    ? payload.code
    : typeof payload.errorCode === 'string'
      ? payload.errorCode
      : event.type;
}

function artifactProjection(artifact, expectedStream) {
  if (!artifact || typeof artifact !== 'object') return null;
  if (artifact.stream !== expectedStream ||
      typeof artifact.id !== 'string' ||
      !Number.isSafeInteger(artifact.byteCount) ||
      artifact.byteCount < 0 ||
      typeof artifact.sha256 !== 'string' ||
      !/^[0-9a-f]{64}$/.test(artifact.sha256)) {
    return null;
  }
  return {
    artifactId: artifact.id,
    stream: expectedStream,
    byteCount: artifact.byteCount,
    sha256: artifact.sha256,
    publicationState: 'published'
  };
}

function completionProjection(run) {
  const decision = run && run.runConsequence &&
    run.runConsequence.completionDecision;
  if (!decision || typeof decision !== 'object') return null;
  const projection = {};
  for (const key of [
    'executionDisposition',
    'verificationDisposition',
    'completionDisposition',
    'reasonCode',
    'decisionHash'
  ]) {
    if (typeof decision[key] === 'string') projection[key] = decision[key];
  }
  return Object.keys(projection).length === 5 ? projection : null;
}

function observationFor(operationIdentity, launcherObservations) {
  return launcherObservations.find(item =>
    item && item.operationIdentity === operationIdentity) || null;
}

function receiptFor(operationIdentity, receipts) {
  return receipts.find(item =>
    item && item.operation === 'runProcess' &&
    (item.operationKey === operationIdentity ||
      item.idempotencyKey === operationIdentity ||
      item.operationIdentity === operationIdentity ||
      (item.receipt && item.receipt.operationIdentity === operationIdentity))) || null;
}

function operationEvents(operationIdentity, events) {
  return events.filter(event =>
    eventOperationIdentity(event) === operationIdentity);
}

function reconciliationState(record, observation, events, mismatch) {
  if (mismatch) return 'pending';
  const kinds = new Set([
    record && record.lastReconciliationResult &&
      record.lastReconciliationResult.kind
  ].filter(Boolean));
  if (events.some(event =>
    eventType(event) === 'process.infrastructure_interrupted')) {
    return 'failed';
  }
  if (observation && observation.availability === 'unavailable') {
    return 'unavailable';
  }
  if (record.lifecycleState === 'finalizing') return 'in_progress';
  if (record.cancellationRequested &&
      record.lifecycleState !== 'terminal') {
    return 'in_progress';
  }
  if (record.lifecycleState === 'terminal' &&
      record.requiredEvidenceState === 'complete' &&
      (record.launcherAcceptanceIdentity === null ||
        record.launcherOutputAcknowledged === true)) {
    return 'converged';
  }
  if (kinds.has('launcher_restart_interruption') ||
      kinds.has('unlaunched_failure')) {
    return 'failed';
  }
  return 'not_required';
}

function diagnosticFor({
  run,
  record,
  events,
  observation,
  lifecycleState,
  completion
}) {
  const codes = durableCodes(run, events);
  for (const category of [
    'policy_denial',
    'capacity_waiting',
    'budget_exhaustion',
    'containment_failure',
    'cancellation_failure',
    'artifact_failure',
    'evidence_failure',
    'recovery_failure',
    'verification_failure'
  ]) {
    const code = firstCodeIn(codes, DIAGNOSTIC_CODES[category]);
    if (code) return { category, code };
  }
  const eventMappings = [
    ['policy_denial', new Set(['authority.denied'])],
    ['capacity_waiting', new Set(['capacity.waiting'])],
    ['budget_exhaustion', new Set(['budget.exhausted', 'feasibility.rejected'])],
    ['evidence_failure', new Set(['run.reconciliation_evidence_failed'])],
    ['recovery_failure', new Set(['process.infrastructure_interrupted'])],
    ['verification_failure', new Set(['run.verification_failed'])]
  ];
  for (const [category, types] of eventMappings) {
    const code = exactEventCode(events, types);
    if (code) return { category, code };
  }
  if (record && record.cancellationRequested &&
      !['terminal', 'interrupted', 'failed'].includes(lifecycleState)) {
    return {
      category: 'cancellation_pending',
      code: 'PROCESS_CANCELLATION_PENDING'
    };
  }
  if (observation && observation.availability === 'unavailable') {
    return {
      category: 'recovery_failure',
      code: observation.diagnosticCode || 'PROCESS_CONTAINMENT_UNAVAILABLE'
    };
  }
  if (observation && observation.launcherOwnershipState === 'not_found' &&
      record && (record.lifecycleState === 'active' ||
        record.launcherAcceptanceIdentity !== null)) {
    return {
      category: 'recovery_failure',
      code: 'PROCESS_EXECUTION_OPERATION_LOST'
    };
  }
  if (record && PROCESS_TERMINAL_FAILURES.has(record.terminalOutcome)) {
    return {
      category: 'execution_failure',
      code: `PROCESS_TERMINAL_${String(record.terminalOutcome).toUpperCase()}`
    };
  }
  if (completion && completion.verificationDisposition === 'failed') {
    return { category: 'verification_failure', code: 'VERIFICATION_FAILED' };
  }
  if (completion && completion.completionDisposition === 'incomplete' &&
      completion.executionDisposition === 'succeeded') {
    return { category: 'objective_incomplete', code: 'OBJECTIVE_INCOMPLETE' };
  }
  if (completion && completion.completionDisposition === 'completed') {
    return { category: 'completed', code: 'OBJECTIVE_COMPLETED' };
  }
  const unclassifiedCode = Array.from(codes).sort(compareCanonicalText)[0];
  if (unclassifiedCode) {
    return { category: 'unknown', code: unclassifiedCode };
  }
  return { category: 'none', code: null };
}

function deriveOperationProjection({
  run,
  record,
  events,
  receipts,
  launcherObservations,
  completion
}) {
  const matchingEvents = operationEvents(record.operationIdentity, events);
  const observation = observationFor(
    record.operationIdentity,
    launcherObservations
  );
  const receipt = receiptFor(record.operationIdentity, receipts);
  const receiptFacts = receipt && receipt.receipt &&
    typeof receipt.receipt === 'object'
    ? receipt.receipt
    : receipt;
  const cancellationReachedLauncher = matchingEvents.some(event =>
    eventType(event) === 'process.cancellation_reached_launcher');
  const terminalEvidence = matchingEvents.some(event =>
    eventType(event) === 'process.terminal');
  const acceptedEvent = matchingEvents.find(event =>
    eventType(event) === 'process.launcher_accepted') || null;
  const launcherState = observation && observation.availability === 'available'
    ? observation.state
    : null;
  const receiptMismatch = Boolean(receiptFacts && (
    receiptFacts.operationIdentity !== record.operationIdentity ||
    (receiptFacts.targetId != null &&
      receiptFacts.targetId !== record.targetId) ||
    (receiptFacts.profileId != null &&
      receiptFacts.profileId !== record.profileId) ||
    (receiptFacts.terminalOutcome != null &&
      receiptFacts.terminalOutcome !== record.terminalOutcome) ||
    (receiptFacts.terminalResultHash != null &&
      receiptFacts.terminalResultHash !== record.terminalResultHash)
  ));
  const mismatch = Boolean(
    receiptMismatch ||
    (record.lifecycleState === 'active' && launcherState === 'not_found') ||
    (record.lifecycleState === 'active' && launcherState === 'terminal') ||
    (record.lifecycleState === 'intent' && launcherState === 'terminal') ||
    (record.lifecycleState === 'terminal' && launcherState === 'active')
  );

  let launcherOwnershipState = 'not_established';
  if (record.lifecycleState === 'terminal' &&
      record.launcherAcceptanceIdentity === null) {
    launcherOwnershipState = 'not_applicable';
  } else if (observation && observation.availability === 'unavailable') {
    launcherOwnershipState = 'unavailable';
  } else if (launcherState === 'active') {
    launcherOwnershipState = 'owned_active';
  } else if (launcherState === 'terminal') {
    launcherOwnershipState = 'owned_terminal';
  } else if (launcherState === 'not_found') {
    launcherOwnershipState = 'not_found';
  } else if (record.launcherAcceptanceIdentity !== null) {
    launcherOwnershipState = record.lifecycleState === 'terminal'
      ? 'owned_terminal'
      : 'accepted_unobserved';
  }
  if (mismatch) launcherOwnershipState = 'mismatch';

  let processTreeState = 'unknown';
  if (record.lifecycleState === 'intent' &&
      record.launcherAcceptanceIdentity === null &&
      launcherState !== 'active' &&
      launcherState !== 'terminal') {
    processTreeState = 'not_applicable';
  } else if (record.cancellationRequested &&
      record.lifecycleState !== 'terminal') {
    processTreeState = 'termination_requested';
  } else if (launcherState === 'active') {
    processTreeState = 'active';
  } else if ((record.lifecycleState === 'finalizing' ||
      record.lifecycleState === 'terminal') &&
      record.terminalResultHash && terminalEvidence) {
    processTreeState = record.launcherAcceptanceIdentity === null
      ? 'not_applicable'
      : 'confirmed_empty';
  } else if (launcherState === 'terminal') {
    processTreeState = 'confirmed_empty';
  }

  let cancellationState = 'not_requested';
  if (record.cancellationRequested) {
    if (record.lifecycleState === 'terminal') {
      cancellationState = ['confirmed_empty', 'not_applicable']
        .includes(processTreeState)
        ? 'complete'
        : 'unavailable';
    } else if (cancellationReachedLauncher) {
      cancellationState = 'accepted';
    } else if (observation && observation.availability === 'unavailable') {
      cancellationState = 'unavailable';
    } else {
      cancellationState = 'requested';
    }
  }

  let finalizationState = 'not_started';
  if (record.lifecycleState === 'finalizing') {
    finalizationState = 'pending';
  } else if (record.lifecycleState === 'terminal') {
    const complete = record.requiredEvidenceState === 'complete' &&
      (record.launcherAcceptanceIdentity === null ||
        record.launcherOutputAcknowledged === true);
    finalizationState = complete ? 'complete' : 'pending';
  } else if (launcherState === 'terminal') {
    finalizationState = 'pending';
  }

  let lifecycleState;
  if (record.cancellationRequested && record.lifecycleState !== 'terminal') {
    lifecycleState = cancellationReachedLauncher
      ? 'cancelling'
      : 'cancellation_requested';
  } else if (record.lifecycleState === 'intent') {
    if (launcherState === 'terminal') lifecycleState = 'finalizing';
    else if (launcherState === 'active') lifecycleState = 'active';
    else if (record.launcherAcceptanceIdentity !== null) lifecycleState = 'accepted';
    else lifecycleState = 'intent';
  } else if (record.lifecycleState === 'active') {
    if (!observation || observation.availability === 'unavailable' ||
        launcherState === 'not_found') {
      lifecycleState = 'unavailable';
    } else if (launcherState === 'terminal') {
      lifecycleState = 'finalizing';
    } else {
      lifecycleState = 'active';
    }
  } else if (record.lifecycleState === 'finalizing') {
    lifecycleState = 'finalizing';
  } else {
    const processFinalized = finalizationState === 'complete' &&
      ['confirmed_empty', 'not_applicable'].includes(processTreeState);
    if (!processFinalized || !TERMINAL_RUN_STATUSES.has(run.status) ||
        !completion) {
      lifecycleState = 'finalizing';
    } else if (completion.executionDisposition === 'infrastructure_failed' ||
        completion.executionDisposition === 'failed' ||
        PROCESS_TERMINAL_FAILURES.has(record.terminalOutcome)) {
      lifecycleState = 'failed';
    } else if (completion.executionDisposition === 'cancelled' ||
        record.terminalOutcome === 'cancelled') {
      lifecycleState = 'interrupted';
    } else {
      lifecycleState = 'terminal';
    }
  }
  if (mismatch) lifecycleState = 'unavailable';

  const reconciliation = reconciliationState(
    record,
    observation,
    matchingEvents,
    mismatch
  );
  const diagnostic = diagnosticFor({
    run,
    record,
    events: matchingEvents.length > 0 ? matchingEvents : events,
    observation,
    lifecycleState,
    completion
  });
  if (receiptMismatch) {
    diagnostic.category = 'recovery_failure';
    diagnostic.code = 'PROCESS_EXECUTION_STATE_INVALID';
  } else if (record.cancellationRequested &&
      record.lifecycleState === 'terminal' &&
      cancellationState !== 'complete') {
    diagnostic.category = 'cancellation_failure';
    diagnostic.code = 'PROCESS_OPERATION_TERMINATION_FAILED';
  }
  const stdoutArtifact = artifactProjection(record.stdoutArtifact, 'stdout');
  const stderrArtifact = artifactProjection(record.stderrArtifact, 'stderr');
  const projection = {
    operationIdentity: record.operationIdentity,
    targetId: record.targetId,
    profileId: record.profileId,
    lifecycleState,
    durableOperationState: record.lifecycleState,
    launcherOwnershipState,
    processTreeState,
    cancellationState,
    finalizationState,
    reconciliationState: reconciliation,
    diagnosticCategory: diagnostic.category,
    ...(diagnostic.code ? { diagnosticCode: diagnostic.code } : {}),
    ...(record.requestedAt ? { requestedAt: record.requestedAt } : {}),
    ...(acceptedEvent && acceptedEvent.ts
      ? { acceptedAt: acceptedEvent.ts }
      : {}),
    ...(record.startedAt ? { startedAt: record.startedAt } : {}),
    ...(record.cancellationRequestedAt
      ? { cancellationRequestedAt: record.cancellationRequestedAt }
      : {}),
    ...(record.terminalAt ? { terminalAt: record.terminalAt } : {}),
    ...(record.terminalOutcome
      ? { terminalOutcome: record.terminalOutcome }
      : {}),
    ...(record.terminalResultHash
      ? { terminalResultHash: record.terminalResultHash }
      : {}),
    ...(stdoutArtifact ? { stdoutArtifact } : {}),
    ...(stderrArtifact ? { stderrArtifact } : {}),
    ...(observation && observation.observedAt
      ? { lastObservedAt: observation.observedAt }
      : {})
  };
  return projection;
}

function buildProcessSupervisionProjection({
  run,
  processOperations = [],
  events = [],
  receipts = [],
  launcherObservations = []
} = {}) {
  if (!run || !Number.isSafeInteger(run.id) || run.id <= 0) {
    throw new TypeError('A persisted run is required for process supervision');
  }
  if (![processOperations, events, receipts, launcherObservations]
    .every(Array.isArray)) {
    throw new TypeError('Process supervision inputs must be arrays');
  }
  if (processOperations.length > PROCESS_SUPERVISION_MAX_OPERATIONS ||
      launcherObservations.length > PROCESS_SUPERVISION_MAX_OPERATIONS) {
    throw new RangeError(
      `Process supervision exceeds ${PROCESS_SUPERVISION_MAX_OPERATIONS} operations`
    );
  }
  const hasProcessEvent = events.some(event =>
    typeof eventType(event) === 'string' &&
    eventType(event).startsWith('process.'));
  const processEvents = events.filter(event =>
    typeof eventType(event) === 'string' &&
    (eventType(event).startsWith('process.') ||
      ['authority.denied', 'capacity.waiting', 'budget.exhausted',
        'feasibility.rejected', 'run.verification_failed',
        'run.reconciliation_evidence_failed'].includes(eventType(event))));
  const policy = run.processPolicySnapshot &&
    typeof run.processPolicySnapshot === 'object'
    ? run.processPolicySnapshot
    : null;
  if (!policy && processOperations.length === 0 && !hasProcessEvent) {
    return null;
  }
  const completion = completionProjection(run);
  const sorted = processOperations.slice().sort((left, right) => {
    const byTime = compareCanonicalText(
      left.requestedAt || '',
      right.requestedAt || ''
    );
    return byTime || compareCanonicalText(
      left.operationIdentity,
      right.operationIdentity
    );
  });
  const historical = Boolean(
    policy && policy.version !== 3 && processOperations.length === 0
  );
  const operations = sorted.map(record => deriveOperationProjection({
    run,
    record,
    events: processEvents,
    receipts,
    launcherObservations,
    completion
  }));
  const latest = operations.length > 0
    ? operations[operations.length - 1]
    : null;
  const topDiagnostic = latest
    ? {
        category: latest.diagnosticCategory,
        code: latest.diagnosticCode || null
      }
    : diagnosticFor({
        run,
        record: null,
        events: processEvents,
        observation: null,
        lifecycleState: 'not_started',
        completion
      });
  const projection = {
    version: PROCESS_SUPERVISION_VERSION,
    availability: historical
      ? 'historical'
      : latest && latest.lifecycleState === 'unavailable'
        ? 'unavailable'
        : 'available',
    lifecycleState: historical
      ? 'not_started'
      : latest
        ? latest.lifecycleState
        : 'not_started',
    diagnosticCategory: topDiagnostic.category,
    ...(topDiagnostic.code ? { diagnosticCode: topDiagnostic.code } : {}),
    processAuthorityVersion: policy && Number.isSafeInteger(policy.version)
      ? policy.version
      : null,
    operations,
    ...(completion ? { completionDecision: completion } : {}),
    ...(historical
      ? {
          historicalCompatibility:
            'historical process lifecycle; no current launcher observation available'
        }
      : {})
  };
  if (latest) {
    for (const key of [
      'durableOperationState',
      'launcherOwnershipState',
      'processTreeState',
      'cancellationState',
      'finalizationState',
      'reconciliationState',
      'lastObservedAt'
    ]) {
      if (latest[key] !== undefined) projection[key] = latest[key];
    }
  }
  return deepFreeze(projection);
}

module.exports = {
  PROCESS_SUPERVISION_MAX_OPERATIONS,
  PROCESS_SUPERVISION_VERSION,
  buildProcessSupervisionProjection
};

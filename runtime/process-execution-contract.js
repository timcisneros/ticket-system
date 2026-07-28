'use strict';

const crypto = require('crypto');

const PROCESS_CONTRACT_VERSION = 1;
const PROCESS_POLICY_SNAPSHOT_VERSION = 1;
const PROCESS_OPERATION = 'runProcess';
const PROCESS_FEATURE_ENV = 'ENABLE_PROCESS_EXECUTION_CONTRACT';
const PROCESS_IDENTIFIER_MAX_LENGTH = 128;
const PROCESS_IDENTIFIER_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;
const PROCESS_INLINE_OUTPUT_MAX_BYTES = 64 * 1024;
const PROCESS_ARTIFACT_REFERENCE_MAX_LENGTH = 2048;

const PROCESS_AUTHORITY_RULE = Object.freeze([
  'The model requests an existing process profile.',
  'The runtime resolves and enforces authority.',
  'The target configuration grants authority.',
  'Process output is evidence, not authority.'
]);

const PROCESS_PHASE_AUTHORITY_RULE = Object.freeze([
  'A process profile declares its permitted runtime phase or effect classification.',
  'The run snapshot captures that classification.',
  'The runtime envelope may advertise runProcess in a phase only when at least one snapshotted profile is permitted in that phase.',
  'Authorization must also verify that the selected profile is permitted in the current phase.'
]);

const PROCESS_TERMINAL_OUTCOMES = Object.freeze([
  'completed',
  'failed_to_start',
  'exited_nonzero',
  'signaled',
  'timed_out',
  'cancelled',
  'output_limit_exceeded',
  'policy_denied',
  'runtime_interrupted'
]);

const PROCESS_PRE_EXECUTION_EVIDENCE_FIELDS = Object.freeze([
  'operationId',
  'runId',
  'ticketId',
  'targetId',
  'profileId',
  'resolvedExecutable',
  'argumentVector',
  'workingDirectory',
  'declaredEnvironmentVariableNames',
  'policySnapshotHash',
  'startedAt'
]);

const PROCESS_TERMINAL_EVIDENCE_FIELDS = Object.freeze([
  'finishedAt',
  'durationMs',
  'pid',
  'processGroupId',
  'exitCode',
  'terminatingSignal',
  'terminalOutcome',
  'enforcementCause',
  'stdoutByteCount',
  'stderrByteCount',
  'stdoutTruncated',
  'stderrTruncated',
  'stdoutArtifactRef',
  'stdoutInline',
  'stderrArtifactRef',
  'stderrInline'
]);

const PROCESS_EVIDENCE_CONTRACT = deepFreeze({
  version: PROCESS_CONTRACT_VERSION,
  preExecution: {
    operationId: 'Stable model-supplied operation identity for this requested process operation.',
    runId: 'Runtime run identity that owns the operation.',
    ticketId: 'Ticket identity that authorized the run.',
    targetId: 'Selected configured process target identity.',
    profileId: 'Selected profile identity within the configured target.',
    resolvedExecutable: 'Trusted executable resolved by the runtime from the target/profile snapshot; never model supplied.',
    argumentVector: 'Trusted ordered arguments resolved by the runtime; never model supplied.',
    workingDirectory: 'Trusted working directory resolved by the runtime; never model supplied.',
    declaredEnvironmentVariableNames: 'Names of environment variables declared by trusted configuration. Values and secrets are never evidence.',
    policySnapshotHash: 'Hash of the immutable run process-policy snapshot used for authority.',
    startedAt: 'UTC timestamp immediately before a future executor attempts process start.'
  },
  terminal: {
    finishedAt: 'UTC timestamp when the future executor reaches a terminal outcome.',
    durationMs: 'Measured wall-clock duration in milliseconds.',
    pid: 'Operating-system process identity, when one was assigned.',
    processGroupId: 'Process-group or equivalent runtime ownership identity.',
    exitCode: 'Numeric exit status when the process exited normally.',
    terminatingSignal: 'Signal or equivalent termination indicator, when applicable.',
    terminalOutcome: 'One value from PROCESS_TERMINAL_OUTCOMES; distinct meanings must not be collapsed.',
    enforcementCause: 'Structured timeout, cancellation, interruption, or enforcement cause.',
    stdoutByteCount: 'Total stdout bytes observed before terminalization.',
    stderrByteCount: 'Total stderr bytes observed before terminalization.',
    stdoutTruncated: 'Whether stdout evidence was truncated by a configured bound.',
    stderrTruncated: 'Whether stderr evidence was truncated by a configured bound.',
    stdoutArtifactRef: 'Reference to a bounded stdout artifact when stdout is not stored inline.',
    stdoutInline: 'Bounded inline stdout value when no artifact reference is used.',
    stderrArtifactRef: 'Reference to a bounded stderr artifact when stderr is not stored inline.',
    stderrInline: 'Bounded inline stderr value when no artifact reference is used.'
  }
});

class ProcessContractError extends Error {
  constructor(message, {
    code,
    failureKind = 'invalid_action',
    disposition = null,
    terminalOutcome = null,
    details = {}
  } = {}) {
    super(message);
    this.name = 'ProcessContractError';
    this.code = code || 'PROCESS_CONTRACT_ERROR';
    this.failureKind = failureKind;
    this.disposition = disposition;
    this.processOutcome = terminalOutcome;
    this.details = details;
  }
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const item of Object.values(value)) deepFreeze(item);
  return Object.freeze(value);
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value).sort().map(key => [key, canonicalize(value[key])])
    );
  }
  return value;
}

function sha256Json(value) {
  return crypto.createHash('sha256').update(JSON.stringify(canonicalize(value))).digest('hex');
}

function processIdentifier(value, label, { request = false } = {}) {
  const fail = message => {
    if (!request) throw new TypeError(message);
    throw new ProcessContractError(message, {
      code: 'PROCESS_REQUEST_MALFORMED',
      details: { field: label }
    });
  };
  if (typeof value !== 'string' || value.length === 0) {
    return fail(`${label} must be a non-empty string`);
  }
  if (value !== value.trim()) {
    return fail(`${label} must not have surrounding whitespace`);
  }
  if (value.length > PROCESS_IDENTIFIER_MAX_LENGTH) {
    return fail(`${label} must not exceed ${PROCESS_IDENTIFIER_MAX_LENGTH} characters`);
  }
  if (/[\u0000-\u001f\u007f-\u009f]/.test(value)) {
    return fail(`${label} must not contain control characters`);
  }
  if (!PROCESS_IDENTIFIER_PATTERN.test(value)) {
    return fail(`${label} must use lowercase letters, numbers, dots, underscores, or hyphens and start with a letter or number`);
  }
  return value;
}

function assertOnlyKeys(value, allowedKeys, label) {
  const unexpectedKey = Object.keys(value).find(key => !allowedKeys.includes(key));
  if (unexpectedKey) {
    throw new ProcessContractError(`${label} includes unsupported field: ${unexpectedKey}`, {
      code: 'PROCESS_REQUEST_MALFORMED',
      details: { field: unexpectedKey }
    });
  }
}

function parseProcessOperationRequest(action) {
  if (!action || typeof action !== 'object' || Array.isArray(action)) {
    throw new ProcessContractError('Process action must be an object', {
      code: 'PROCESS_REQUEST_MALFORMED'
    });
  }
  assertOnlyKeys(action, ['operation', 'args'], 'Process action');
  if (action.operation !== PROCESS_OPERATION) {
    throw new ProcessContractError(`Unsupported process operation: ${String(action.operation || '')}`, {
      code: 'PROCESS_OPERATION_UNSUPPORTED'
    });
  }
  if (!action.args || typeof action.args !== 'object' || Array.isArray(action.args)) {
    throw new ProcessContractError('runProcess args must be an object', {
      code: 'PROCESS_REQUEST_MALFORMED'
    });
  }
  assertOnlyKeys(action.args, ['targetId', 'profileId', 'operationId'], 'runProcess args');
  return deepFreeze({
    operation: PROCESS_OPERATION,
    args: {
      targetId: processIdentifier(action.args.targetId, 'runProcess.targetId', { request: true }),
      profileId: processIdentifier(action.args.profileId, 'runProcess.profileId', { request: true }),
      operationId: processIdentifier(action.args.operationId, 'runProcess.operationId', { request: true })
    }
  });
}

function buildProcessOperationIdentity(runId, operationId) {
  if (!Number.isSafeInteger(runId) || runId <= 0) {
    throw new TypeError('runId must be a positive safe integer');
  }
  const normalizedOperationId = processIdentifier(operationId, 'operationId');
  return `process-operation:${sha256Json({ runId, operationId: normalizedOperationId })}`;
}

function classifyProcessOperationIdReuse({ runId, requested, existing = null } = {}) {
  const requestedAction = parseProcessOperationRequest({
    operation: PROCESS_OPERATION,
    args: requested
  });
  const identity = buildProcessOperationIdentity(runId, requestedAction.args.operationId);
  if (existing === null || existing === undefined) {
    return deepFreeze({ status: 'new', identity, request: requestedAction.args });
  }
  const existingAction = parseProcessOperationRequest({
    operation: PROCESS_OPERATION,
    args: existing
  });
  if (existingAction.args.operationId !== requestedAction.args.operationId) {
    return deepFreeze({ status: 'new', identity, request: requestedAction.args });
  }
  if (existingAction.args.targetId !== requestedAction.args.targetId ||
      existingAction.args.profileId !== requestedAction.args.profileId) {
    throw new ProcessContractError(
      `runProcess.operationId conflicts with an existing request in run ${runId}: ${requestedAction.args.operationId}`,
      {
        code: 'PROCESS_OPERATION_ID_CONFLICT',
        failureKind: 'idempotency_conflict',
        details: {
          runId,
          operationId: requestedAction.args.operationId,
          existingTargetId: existingAction.args.targetId,
          existingProfileId: existingAction.args.profileId,
          requestedTargetId: requestedAction.args.targetId,
          requestedProfileId: requestedAction.args.profileId
        }
      }
    );
  }
  return deepFreeze({ status: 'idempotent_replay', identity, request: requestedAction.args });
}

function isProcessContractFeatureEnabled(env = process.env) {
  return Boolean(env && env[PROCESS_FEATURE_ENV] === 'true');
}

function normalizeGrant(grant, label) {
  if (!grant || typeof grant !== 'object' || Array.isArray(grant)) {
    throw new TypeError(`${label} must be an object`);
  }
  const targetId = processIdentifier(grant.targetId, `${label}.targetId`);
  if (!Array.isArray(grant.profileIds)) throw new TypeError(`${label}.profileIds must be an array`);
  const profileIds = [...new Set(grant.profileIds.map((profileId, index) => {
    return processIdentifier(profileId, `${label}.profileIds[${index}]`);
  }))].sort();
  if (profileIds.length === 0) throw new TypeError(`${label}.profileIds must not be empty`);
  return { targetId, profileIds };
}

function buildProcessPolicySnapshot({
  capabilityEnabled,
  grants = [],
  capturedAt = new Date().toISOString()
} = {}) {
  if (typeof capabilityEnabled !== 'boolean') {
    throw new TypeError('processPolicySnapshot.capabilityEnabled must be a boolean');
  }
  if (!Array.isArray(grants)) throw new TypeError('processPolicySnapshot.grants must be an array');
  if (typeof capturedAt !== 'string' || !Number.isFinite(Date.parse(capturedAt))) {
    throw new TypeError('processPolicySnapshot.capturedAt must be an ISO timestamp');
  }
  const normalizedGrants = grants.map((grant, index) => normalizeGrant(grant, `processPolicySnapshot.grants[${index}]`));
  normalizedGrants.sort((left, right) => {
    if (left.targetId < right.targetId) return -1;
    if (left.targetId > right.targetId) return 1;
    return 0;
  });
  if (new Set(normalizedGrants.map(grant => grant.targetId)).size !== normalizedGrants.length) {
    throw new TypeError('processPolicySnapshot.grants targetId values must be unique');
  }
  const withoutHash = {
    version: PROCESS_POLICY_SNAPSHOT_VERSION,
    capabilityEnabled,
    grants: normalizedGrants,
    capturedAt: new Date(capturedAt).toISOString()
  };
  return deepFreeze({
    ...withoutHash,
    snapshotHash: sha256Json(withoutHash)
  });
}

function normalizeProcessPolicySnapshot(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (value.version !== PROCESS_POLICY_SNAPSHOT_VERSION) return null;
  try {
    const normalized = buildProcessPolicySnapshot({
      capabilityEnabled: value.capabilityEnabled,
      grants: value.grants,
      capturedAt: value.capturedAt
    });
    if (typeof value.snapshotHash !== 'string' || value.snapshotHash !== normalized.snapshotHash) return null;
    return normalized;
  } catch (_) {
    return null;
  }
}

function processAuthorityReferences(value) {
  const snapshot = normalizeProcessPolicySnapshot(value);
  if (!snapshot || !snapshot.capabilityEnabled) return [];
  return snapshot.grants.map(grant => ({
    targetId: grant.targetId,
    profileIds: [...grant.profileIds]
  }));
}

function processResolution({
  disposition,
  code,
  message,
  request,
  snapshot,
  authorityStatus,
  terminalOutcome = null
}) {
  return deepFreeze({
    disposition,
    code,
    message,
    authorityStatus,
    terminalOutcome,
    request,
    policySnapshotHash: snapshot ? snapshot.snapshotHash : null
  });
}

function resolveProcessOperationRequest(action, policySnapshot) {
  const request = parseProcessOperationRequest(action);
  const snapshot = normalizeProcessPolicySnapshot(policySnapshot);
  if (!snapshot || !snapshot.capabilityEnabled) {
    return processResolution({
      disposition: 'disabled',
      code: 'PROCESS_CAPABILITY_DISABLED',
      message: 'runProcess is disabled by the run process-policy snapshot',
      request,
      snapshot,
      authorityStatus: 'denied',
      terminalOutcome: 'policy_denied'
    });
  }
  const target = snapshot.grants.find(grant => grant.targetId === request.args.targetId);
  if (!target) {
    return processResolution({
      disposition: 'policy_denied',
      code: 'PROCESS_TARGET_UNKNOWN',
      message: `Process target is not granted by the run snapshot: ${request.args.targetId}`,
      request,
      snapshot,
      authorityStatus: 'denied',
      terminalOutcome: 'policy_denied'
    });
  }
  if (!target.profileIds.includes(request.args.profileId)) {
    return processResolution({
      disposition: 'policy_denied',
      code: 'PROCESS_PROFILE_UNKNOWN',
      message: `Process profile is not granted for target ${request.args.targetId}: ${request.args.profileId}`,
      request,
      snapshot,
      authorityStatus: 'denied',
      terminalOutcome: 'policy_denied'
    });
  }
  return processResolution({
    disposition: 'unsupported',
    code: 'PROCESS_EXECUTOR_UNAVAILABLE',
    message: 'runProcess is authorized by contract but has no executor in Tranche 0',
    request,
    snapshot,
    authorityStatus: 'allowed'
  });
}

function processResolutionError(resolution) {
  if (!resolution || typeof resolution !== 'object') {
    throw new TypeError('process resolution is required');
  }
  return new ProcessContractError(resolution.message, {
    code: resolution.code,
    failureKind: resolution.disposition === 'unsupported' ? 'unsupported_operation' : 'process_policy_denied',
    disposition: resolution.disposition,
    terminalOutcome: resolution.terminalOutcome,
    details: {
      targetId: resolution.request && resolution.request.args.targetId,
      profileId: resolution.request && resolution.request.args.profileId,
      operationId: resolution.request && resolution.request.args.operationId,
      policySnapshotHash: resolution.policySnapshotHash
    }
  });
}

// Tranche 0's terminal dispatch seam. It deliberately has no executor argument and
// always throws one of the contract's typed disabled/denied/unsupported failures.
function refuseProcessOperation(action, policySnapshot) {
  throw processResolutionError(resolveProcessOperationRequest(action, policySnapshot));
}

function validateProcessTerminalOutcome(value) {
  if (typeof value !== 'string' || !PROCESS_TERMINAL_OUTCOMES.includes(value)) {
    throw new TypeError(`Unsupported process terminal outcome: ${String(value)}`);
  }
  return value;
}

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function requiredEvidenceField(value, key) {
  if (!hasOwn(value, key) || value[key] === null || value[key] === undefined) {
    throw new TypeError(`process evidence.${key} is required and must not be null`);
  }
}

function forbidEvidenceValue(value, key, outcome) {
  if (hasOwn(value, key) && value[key] !== null && value[key] !== undefined) {
    throw new TypeError(`process evidence.${key} is forbidden for ${outcome}`);
  }
}

function validateIsoTimestamp(value, label) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value)) ||
      new Date(value).toISOString() !== value) {
    throw new TypeError(`${label} must be a canonical UTC ISO timestamp`);
  }
}

function validateNonnegativeInteger(value, label, { positive = false } = {}) {
  if (!Number.isSafeInteger(value) || value < (positive ? 1 : 0)) {
    throw new TypeError(`${label} must be a ${positive ? 'positive' : 'nonnegative'} safe integer`);
  }
}

function validateNullableEvidenceField(value, key, validator) {
  if (!hasOwn(value, key) || value[key] === null) return;
  if (value[key] === undefined) throw new TypeError(`process evidence.${key} must be absent or null, not undefined`);
  validator(value[key], `process evidence.${key}`);
}

function validatePlainObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype) {
    throw new TypeError(`${label} must be a plain object`);
  }
}

function assertNoEnvironmentValues(value, path = 'process evidence') {
  if (!value || typeof value !== 'object') return;
  for (const [key, nested] of Object.entries(value)) {
    if (/^(?:env|environment|environmentvariables|environmentvariablevalues)$/i.test(key)) {
      throw new TypeError(`${path}.${key} may not record environment-variable values`);
    }
    assertNoEnvironmentValues(nested, `${path}.${key}`);
  }
}

function requirePreExecutionEvidence(value) {
  for (const key of PROCESS_PRE_EXECUTION_EVIDENCE_FIELDS) requiredEvidenceField(value, key);
}

function requireStartedProcessTerminalEvidence(value) {
  for (const key of [
    'finishedAt',
    'durationMs',
    'stdoutByteCount',
    'stderrByteCount',
    'stdoutTruncated',
    'stderrTruncated'
  ]) requiredEvidenceField(value, key);
}

function validateProcessEvidenceRecord(value) {
  validatePlainObject(value, 'process evidence');
  const allowed = [...PROCESS_PRE_EXECUTION_EVIDENCE_FIELDS, ...PROCESS_TERMINAL_EVIDENCE_FIELDS];
  const unexpected = Object.keys(value).find(key => !allowed.includes(key));
  if (unexpected) throw new TypeError(`process evidence includes unsupported field: ${unexpected}`);

  for (const key of ['operationId', 'runId', 'ticketId', 'targetId', 'profileId', 'policySnapshotHash']) {
    requiredEvidenceField(value, key);
  }
  processIdentifier(value.operationId, 'process evidence.operationId');
  processIdentifier(value.targetId, 'process evidence.targetId');
  processIdentifier(value.profileId, 'process evidence.profileId');
  validateNonnegativeInteger(value.runId, 'process evidence.runId', { positive: true });
  validateNonnegativeInteger(value.ticketId, 'process evidence.ticketId', { positive: true });
  if (typeof value.policySnapshotHash !== 'string' || !/^[a-f0-9]{64}$/.test(value.policySnapshotHash)) {
    throw new TypeError('process evidence.policySnapshotHash must be a lowercase SHA-256 hash');
  }

  validateNullableEvidenceField(value, 'resolvedExecutable', (item, label) => {
    if (typeof item !== 'string' || item.length === 0 || /[\u0000\r\n]/.test(item)) {
      throw new TypeError(`${label} must be a non-empty single-line string`);
    }
  });
  validateNullableEvidenceField(value, 'argumentVector', (item, label) => {
    if (!Array.isArray(item) || item.some(argument => typeof argument !== 'string')) {
      throw new TypeError(`${label} must be an array of strings`);
    }
  });
  validateNullableEvidenceField(value, 'workingDirectory', (item, label) => {
    if (typeof item !== 'string' || item.length === 0 || /[\u0000\r\n]/.test(item)) {
      throw new TypeError(`${label} must be a non-empty single-line string`);
    }
  });
  validateNullableEvidenceField(value, 'declaredEnvironmentVariableNames', (item, label) => {
    if (!Array.isArray(item) || item.some(name => typeof name !== 'string' ||
        !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))) {
      throw new TypeError(`${label} must contain only environment-variable names`);
    }
    if (new Set(item).size !== item.length) {
      throw new TypeError(`${label} must not contain duplicate names`);
    }
  });
  for (const key of ['startedAt', 'finishedAt']) {
    validateNullableEvidenceField(value, key, validateIsoTimestamp);
  }
  for (const key of ['durationMs', 'stdoutByteCount', 'stderrByteCount']) {
    validateNullableEvidenceField(value, key, validateNonnegativeInteger);
  }
  validateNullableEvidenceField(value, 'pid', (item, label) =>
    validateNonnegativeInteger(item, label, { positive: true }));
  validateNullableEvidenceField(value, 'processGroupId', (item, label) => {
    if (Number.isSafeInteger(item)) {
      validateNonnegativeInteger(item, label, { positive: true });
      return;
    }
    if (typeof item !== 'string' || item.length === 0 || item.length > PROCESS_IDENTIFIER_MAX_LENGTH ||
        /[\u0000-\u001f\u007f-\u009f]/.test(item) || item !== item.trim()) {
      throw new TypeError(`${label} must be a positive integer or bounded nonempty string`);
    }
  });
  validateNullableEvidenceField(value, 'exitCode', validateNonnegativeInteger);
  validateNullableEvidenceField(value, 'terminatingSignal', (item, label) => {
    if (typeof item !== 'string' || !item || item.length > 64 ||
        /[\u0000-\u001f\u007f-\u009f]/.test(item) || item !== item.trim()) {
      throw new TypeError(`${label} must be a bounded nonempty string`);
    }
  });
  for (const key of ['stdoutTruncated', 'stderrTruncated']) {
    validateNullableEvidenceField(value, key, (item, label) => {
      if (typeof item !== 'boolean') throw new TypeError(`${label} must be a boolean`);
    });
  }
  for (const key of ['stdoutArtifactRef', 'stderrArtifactRef']) {
    validateNullableEvidenceField(value, key, (item, label) => {
      if (typeof item !== 'string' || item.length === 0 ||
          item.length > PROCESS_ARTIFACT_REFERENCE_MAX_LENGTH ||
          /[\u0000-\u001f\u007f-\u009f]/.test(item)) {
        throw new TypeError(`${label} must be a bounded nonempty artifact reference`);
      }
    });
  }
  for (const key of ['stdoutInline', 'stderrInline']) {
    validateNullableEvidenceField(value, key, (item, label) => {
      if (typeof item !== 'string' ||
          Buffer.byteLength(item, 'utf8') > PROCESS_INLINE_OUTPUT_MAX_BYTES) {
        throw new TypeError(`${label} must be a string no larger than ${PROCESS_INLINE_OUTPUT_MAX_BYTES} UTF-8 bytes`);
      }
    });
  }
  validateNullableEvidenceField(value, 'enforcementCause', (item, label) => {
    validatePlainObject(item, label);
    if (typeof item.kind !== 'string' || !item.kind.trim()) {
      throw new TypeError(`${label}.kind must be a non-empty string`);
    }
  });

  if (value.stdoutArtifactRef != null && value.stdoutInline != null) {
    throw new TypeError('process evidence stdout must use either artifact reference or inline value, not both');
  }
  if (value.stderrArtifactRef != null && value.stderrInline != null) {
    throw new TypeError('process evidence stderr must use either artifact reference or inline value, not both');
  }
  assertNoEnvironmentValues(value);

  if (hasOwn(value, 'terminalOutcome') && value.terminalOutcome === undefined) {
    throw new TypeError('process evidence.terminalOutcome must be absent, null, or a defined outcome');
  }
  const terminalOutcome = hasOwn(value, 'terminalOutcome') && value.terminalOutcome !== null
    ? validateProcessTerminalOutcome(value.terminalOutcome)
    : null;
  if (terminalOutcome === null) {
    requirePreExecutionEvidence(value);
    for (const key of PROCESS_TERMINAL_EVIDENCE_FIELDS) {
      if (key !== 'terminalOutcome') forbidEvidenceValue(value, key, 'pre-execution evidence');
    }
  } else if (terminalOutcome === 'policy_denied') {
    requiredEvidenceField(value, 'enforcementCause');
    for (const key of [
      'resolvedExecutable', 'argumentVector', 'workingDirectory',
      'declaredEnvironmentVariableNames', 'startedAt', 'finishedAt', 'durationMs',
      'pid', 'processGroupId', 'exitCode', 'terminatingSignal',
      'stdoutByteCount', 'stderrByteCount', 'stdoutTruncated', 'stderrTruncated',
      'stdoutArtifactRef', 'stdoutInline', 'stderrArtifactRef', 'stderrInline'
    ]) forbidEvidenceValue(value, key, terminalOutcome);
  } else {
    requirePreExecutionEvidence(value);
    requiredEvidenceField(value, 'finishedAt');
    requiredEvidenceField(value, 'durationMs');
    if (terminalOutcome !== 'failed_to_start') requireStartedProcessTerminalEvidence(value);
    if (terminalOutcome === 'completed') {
      requiredEvidenceField(value, 'exitCode');
      if (value.exitCode !== 0) throw new TypeError('completed process evidence.exitCode must be zero');
      forbidEvidenceValue(value, 'terminatingSignal', terminalOutcome);
      forbidEvidenceValue(value, 'enforcementCause', terminalOutcome);
    } else if (terminalOutcome === 'exited_nonzero') {
      requiredEvidenceField(value, 'exitCode');
      if (value.exitCode === 0) throw new TypeError('exited_nonzero process evidence.exitCode must be nonzero');
      forbidEvidenceValue(value, 'terminatingSignal', terminalOutcome);
      forbidEvidenceValue(value, 'enforcementCause', terminalOutcome);
    } else if (terminalOutcome === 'signaled') {
      requiredEvidenceField(value, 'terminatingSignal');
      forbidEvidenceValue(value, 'exitCode', terminalOutcome);
      forbidEvidenceValue(value, 'enforcementCause', terminalOutcome);
    } else if (terminalOutcome === 'failed_to_start') {
      requiredEvidenceField(value, 'enforcementCause');
      for (const key of [
        'pid', 'processGroupId', 'exitCode', 'terminatingSignal',
        'stdoutByteCount', 'stderrByteCount', 'stdoutTruncated', 'stderrTruncated',
        'stdoutArtifactRef', 'stdoutInline', 'stderrArtifactRef', 'stderrInline'
      ]) forbidEvidenceValue(value, key, terminalOutcome);
    } else {
      requiredEvidenceField(value, 'enforcementCause');
    }
  }

  let clone;
  try {
    clone = JSON.parse(JSON.stringify(value));
  } catch (_) {
    throw new TypeError('process evidence must be JSON-serializable');
  }
  return deepFreeze(clone);
}

module.exports = {
  PROCESS_AUTHORITY_RULE,
  PROCESS_CONTRACT_VERSION,
  PROCESS_EVIDENCE_CONTRACT,
  PROCESS_FEATURE_ENV,
  PROCESS_IDENTIFIER_MAX_LENGTH,
  PROCESS_INLINE_OUTPUT_MAX_BYTES,
  PROCESS_OPERATION,
  PROCESS_PHASE_AUTHORITY_RULE,
  PROCESS_POLICY_SNAPSHOT_VERSION,
  PROCESS_PRE_EXECUTION_EVIDENCE_FIELDS,
  PROCESS_TERMINAL_EVIDENCE_FIELDS,
  PROCESS_TERMINAL_OUTCOMES,
  ProcessContractError,
  buildProcessOperationIdentity,
  buildProcessPolicySnapshot,
  classifyProcessOperationIdReuse,
  isProcessContractFeatureEnabled,
  normalizeProcessPolicySnapshot,
  parseProcessOperationRequest,
  processAuthorityReferences,
  processResolutionError,
  refuseProcessOperation,
  resolveProcessOperationRequest,
  validateProcessEvidenceRecord,
  validateProcessTerminalOutcome
};

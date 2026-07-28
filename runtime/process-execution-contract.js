'use strict';

const crypto = require('crypto');

const PROCESS_CONTRACT_VERSION = 1;
const PROCESS_POLICY_SNAPSHOT_VERSION = 1;
const PROCESS_OPERATION = 'runProcess';
const PROCESS_FEATURE_ENV = 'ENABLE_PROCESS_EXECUTION_CONTRACT';

const PROCESS_AUTHORITY_RULE = Object.freeze([
  'The model requests an existing process profile.',
  'The runtime resolves and enforces authority.',
  'The target configuration grants authority.',
  'Process output is evidence, not authority.'
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

function nonEmptyString(value, label) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new ProcessContractError(`${label} must be a non-empty string`, {
      code: 'PROCESS_REQUEST_MALFORMED',
      details: { field: label }
    });
  }
  return value.trim();
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
      targetId: nonEmptyString(action.args.targetId, 'runProcess.targetId'),
      profileId: nonEmptyString(action.args.profileId, 'runProcess.profileId'),
      operationId: nonEmptyString(action.args.operationId, 'runProcess.operationId')
    }
  });
}

function isProcessContractFeatureEnabled(env = process.env) {
  return Boolean(env && env[PROCESS_FEATURE_ENV] === 'true');
}

function normalizeGrant(grant, label) {
  if (!grant || typeof grant !== 'object' || Array.isArray(grant)) {
    throw new TypeError(`${label} must be an object`);
  }
  const targetId = typeof grant.targetId === 'string' ? grant.targetId.trim() : '';
  if (!targetId) throw new TypeError(`${label}.targetId must be a non-empty string`);
  if (!Array.isArray(grant.profileIds)) throw new TypeError(`${label}.profileIds must be an array`);
  const profileIds = [...new Set(grant.profileIds.map((profileId, index) => {
    const normalized = typeof profileId === 'string' ? profileId.trim() : '';
    if (!normalized) throw new TypeError(`${label}.profileIds[${index}] must be a non-empty string`);
    return normalized;
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

function validateProcessEvidenceRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('process evidence must be an object');
  }
  const allowed = [...PROCESS_PRE_EXECUTION_EVIDENCE_FIELDS, ...PROCESS_TERMINAL_EVIDENCE_FIELDS];
  const unexpected = Object.keys(value).find(key => !allowed.includes(key));
  if (unexpected) throw new TypeError(`process evidence includes unsupported field: ${unexpected}`);
  if (Object.prototype.hasOwnProperty.call(value, 'terminalOutcome') && value.terminalOutcome !== null) {
    validateProcessTerminalOutcome(value.terminalOutcome);
  }
  return deepFreeze(JSON.parse(JSON.stringify(value)));
}

module.exports = {
  PROCESS_AUTHORITY_RULE,
  PROCESS_CONTRACT_VERSION,
  PROCESS_EVIDENCE_CONTRACT,
  PROCESS_FEATURE_ENV,
  PROCESS_OPERATION,
  PROCESS_POLICY_SNAPSHOT_VERSION,
  PROCESS_PRE_EXECUTION_EVIDENCE_FIELDS,
  PROCESS_TERMINAL_EVIDENCE_FIELDS,
  PROCESS_TERMINAL_OUTCOMES,
  ProcessContractError,
  buildProcessPolicySnapshot,
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

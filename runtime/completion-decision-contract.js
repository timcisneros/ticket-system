'use strict';

const crypto = require('crypto');

const COMPLETION_AUTHORITY_VERSION = 1;
const COMPLETION_DECISION_VERSION = 1;
const SUPPORTED_VERIFICATION_POLICY = 'when_declared';

const EXECUTION_DISPOSITIONS = Object.freeze([
  'succeeded',
  'failed',
  'cancelled',
  'budget_exhausted',
  'infrastructure_failed'
]);
const VERIFICATION_DISPOSITIONS = Object.freeze([
  'not_required',
  'passed',
  'failed',
  'unavailable'
]);
const COMPLETION_DISPOSITIONS = Object.freeze([
  'completed',
  'incomplete',
  'blocked'
]);
const OBJECTIVE_KINDS = Object.freeze([
  'deterministic',
  'workflow',
  'workflow_draft',
  'unrecognized'
]);
const DIRECT_POSTCONDITION_TYPES = Object.freeze([
  'folder_exists',
  'path_absent',
  'file_content_equals'
]);
const PROCESS_POSTCONDITION_TYPES = Object.freeze([
  'processOperationExists',
  'processTerminalOutcomeEquals',
  'processArtifactEquals'
]);
const COMPLETION_FAILURE_CODES = Object.freeze([
  'COMPLETION_DECISION_INVALID',
  'COMPLETION_DECISION_CONFLICT',
  'COMPLETION_EVIDENCE_MISSING',
  'COMPLETION_EVIDENCE_CONTRADICTORY',
  'COMPLETION_CONSEQUENCE_INVALID',
  'POSTCONDITION_EVALUATION_FAILED',
  'POSTCONDITION_EVIDENCE_UNAVAILABLE',
  'POSTCONDITION_UNSUPPORTED',
  'OBJECTIVE_INCOMPLETE',
  'VERIFICATION_REQUIRED',
  'VERIFICATION_FAILED',
  'VERIFICATION_UNAVAILABLE'
]);
const COMPLETION_REASON_CODES = Object.freeze([
  'OBJECTIVE_COMPLETED',
  'OBJECTIVE_INCOMPLETE',
  'VERIFICATION_FAILED',
  'VERIFICATION_UNAVAILABLE',
  'RUN_BUDGET_EXHAUSTED',
  'RUN_CANCELLED',
  'RUN_EXECUTION_FAILED'
]);

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const PROCESS_OPERATION_IDENTITY_PATTERN = /^process-operation:[0-9a-f]{64}$/;
const TERMINAL_RUN_STATUSES = new Set(['completed', 'failed', 'interrupted']);
const RELEVANT_EVIDENCE_TYPES = new Set([
  'authority.allowed',
  'authority.denied',
  'budget.exhausted',
  'feasibility.rejected',
  'run.postcondition_failed',
  'run.postconditions_checked',
  'run.verification_failed',
  'run.verification_passed',
  'run.violation_detected',
  'runtime.violation_detected',
  'workspace.violation_detected',
  'run.violations_checked',
  'workspace.operation',
  'process.intent_admitted',
  'process.launcher_accepted',
  'process.terminal',
  'process.stdout_artifact',
  'process.stderr_artifact',
  'process.cancellation_requested',
  'process.infrastructure_interrupted'
]);

class CompletionContractError extends TypeError {
  constructor(code, message, details = null) {
    super(message);
    this.name = 'CompletionContractError';
    this.code = code;
    this.failureKind = 'completion_contract';
    this.details = details;
  }
}

function fail(code, message, details = null) {
  throw new CompletionContractError(code, message, details);
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    const result = {};
    for (const key of Object.keys(value).sort()) result[key] = canonicalize(value[key]);
    return result;
  }
  return value;
}

function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function hashCanonical(value) {
  return sha256(canonicalJson(value));
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const item of Object.values(value)) deepFreeze(item);
  return value;
}

function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('COMPLETION_DECISION_INVALID', `${label} must be an object`);
  }
  return value;
}

function exactKeys(value, allowed, label) {
  const extras = Object.keys(value).filter(key => !allowed.includes(key));
  if (extras.length > 0) {
    fail('COMPLETION_DECISION_INVALID', `${label} contains unsupported fields: ${extras.sort().join(', ')}`);
  }
}

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    fail('COMPLETION_DECISION_INVALID', `${label} must be a positive safe integer`);
  }
  return value;
}

function boundedString(value, label, maximum = 512) {
  if (typeof value !== 'string' || value.length < 1 || value.length > maximum ||
      value.trim() !== value || /[\0\r\n]/.test(value)) {
    fail('COMPLETION_DECISION_INVALID', `${label} is invalid`);
  }
  return value;
}

function hash(value, label) {
  if (typeof value !== 'string' || !SHA256_PATTERN.test(value)) {
    fail('COMPLETION_DECISION_INVALID', `${label} must be a lowercase SHA-256`);
  }
  return value;
}

function timestamp(value, label) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value)) ||
      new Date(value).toISOString() !== value) {
    fail('COMPLETION_DECISION_INVALID', `${label} must be a canonical UTC timestamp`);
  }
  return value;
}

function normalizePath(value, label) {
  const path = boundedString(value, label, 1024);
  if (path.startsWith('/') || path.includes('\\') ||
      path.split('/').some(component => !component || component === '.' || component === '..')) {
    fail('COMPLETION_DECISION_INVALID', `${label} must be a normalized relative path`);
  }
  return path;
}

function normalizeDirectPostcondition(value, index) {
  const label = `directPostconditions[${index}]`;
  const source = object(value, label);
  const type = boundedString(source.type, `${label}.type`, 64);
  if (!DIRECT_POSTCONDITION_TYPES.includes(type)) {
    fail('POSTCONDITION_UNSUPPORTED', `${label}.type is unsupported: ${type}`);
  }
  const allowed = type === 'file_content_equals'
    ? ['type', 'path', 'contentSha256']
    : ['type', 'path'];
  exactKeys(source, allowed, label);
  return {
    type,
    path: normalizePath(source.path, `${label}.path`),
    ...(type === 'file_content_equals'
      ? { contentSha256: hash(source.contentSha256, `${label}.contentSha256`) }
      : {})
  };
}

function normalizeObjectiveContract(value) {
  const source = object(value, 'objectiveContract');
  exactKeys(source, [
    'version',
    'kind',
    'objectiveHash',
    'recognized',
    'intent',
    'completionPolicy',
    'directPostconditions'
  ], 'objectiveContract');
  if (source.version !== 1) fail('COMPLETION_DECISION_INVALID', 'objectiveContract.version must be 1');
  if (!OBJECTIVE_KINDS.includes(source.kind)) {
    fail('COMPLETION_DECISION_INVALID', `objectiveContract.kind is unsupported: ${source.kind}`);
  }
  if (typeof source.recognized !== 'boolean') {
    fail('COMPLETION_DECISION_INVALID', 'objectiveContract.recognized must be boolean');
  }
  if (!Array.isArray(source.directPostconditions) || source.directPostconditions.length > 128) {
    fail('COMPLETION_DECISION_INVALID', 'objectiveContract.directPostconditions must be a bounded array');
  }
  const directPostconditions = source.directPostconditions.map(normalizeDirectPostcondition);
  const duplicate = new Set();
  for (const postcondition of directPostconditions) {
    const identity = canonicalJson(postcondition);
    if (duplicate.has(identity)) fail('COMPLETION_DECISION_INVALID', 'objective postconditions must be deduplicated');
    duplicate.add(identity);
  }
  return {
    version: 1,
    kind: source.kind,
    objectiveHash: hash(source.objectiveHash, 'objectiveContract.objectiveHash'),
    recognized: source.recognized,
    intent: boundedString(source.intent, 'objectiveContract.intent', 128),
    completionPolicy: boundedString(source.completionPolicy, 'objectiveContract.completionPolicy', 128),
    directPostconditions
  };
}

function buildCompletionAuthoritySnapshot({
  objective,
  kind,
  recognized,
  intent,
  completionPolicy,
  directPostconditions = [],
  verificationPolicy,
  capturedAt
}) {
  if (verificationPolicy !== SUPPORTED_VERIFICATION_POLICY) {
    fail('COMPLETION_DECISION_INVALID', `Unsupported verification policy: ${verificationPolicy}`);
  }
  const objectiveContract = normalizeObjectiveContract({
    version: 1,
    kind,
    objectiveHash: sha256(String(objective || '')),
    recognized: recognized === true,
    intent,
    completionPolicy,
    directPostconditions
  });
  const withoutHash = {
    version: COMPLETION_AUTHORITY_VERSION,
    objectiveContract,
    objectiveContractHash: hashCanonical(objectiveContract),
    verificationPolicy,
    capturedAt: timestamp(capturedAt, 'capturedAt')
  };
  return deepFreeze({
    ...withoutHash,
    snapshotHash: hashCanonical(withoutHash)
  });
}

function normalizeCompletionAuthoritySnapshot(value) {
  const source = object(value, 'completionAuthoritySnapshot');
  exactKeys(source, [
    'version',
    'objectiveContract',
    'objectiveContractHash',
    'verificationPolicy',
    'capturedAt',
    'snapshotHash'
  ], 'completionAuthoritySnapshot');
  if (source.version !== COMPLETION_AUTHORITY_VERSION) {
    fail('COMPLETION_DECISION_INVALID', `Unsupported completion authority version: ${source.version}`);
  }
  if (source.verificationPolicy !== SUPPORTED_VERIFICATION_POLICY) {
    fail('COMPLETION_DECISION_INVALID', `Unsupported verification policy: ${source.verificationPolicy}`);
  }
  const objectiveContract = normalizeObjectiveContract(source.objectiveContract);
  const objectiveContractHash = hash(source.objectiveContractHash, 'objectiveContractHash');
  if (objectiveContractHash !== hashCanonical(objectiveContract)) {
    fail('COMPLETION_DECISION_CONFLICT', 'Objective contract hash does not match its authority');
  }
  const withoutHash = {
    version: COMPLETION_AUTHORITY_VERSION,
    objectiveContract,
    objectiveContractHash,
    verificationPolicy: source.verificationPolicy,
    capturedAt: timestamp(source.capturedAt, 'capturedAt')
  };
  const snapshotHash = hash(source.snapshotHash, 'snapshotHash');
  if (snapshotHash !== hashCanonical(withoutHash)) {
    fail('COMPLETION_DECISION_CONFLICT', 'Completion authority snapshot hash does not match');
  }
  return deepFreeze({ ...withoutHash, snapshotHash });
}

function normalizedEvent(event) {
  return {
    id: event && event.id !== undefined ? event.id : null,
    seq: event && event.seq !== undefined ? event.seq : null,
    type: event && typeof event.type === 'string' ? event.type : null,
    ticketId: event && event.ticketId !== undefined ? event.ticketId : null,
    runId: event && event.runId !== undefined ? event.runId : null,
    stepId: event && event.stepId !== undefined ? event.stepId : null,
    payload: canonicalize(event && event.payload && typeof event.payload === 'object' ? event.payload : {})
  };
}

function relevantEvidence(events) {
  return (Array.isArray(events) ? events : [])
    .filter(event => event && RELEVANT_EVIDENCE_TYPES.has(event.type))
    .map(normalizedEvent)
    .sort((left, right) => {
      const leftPosition = Number.isSafeInteger(left.seq) ? left.seq : Number.MAX_SAFE_INTEGER;
      const rightPosition = Number.isSafeInteger(right.seq) ? right.seq : Number.MAX_SAFE_INTEGER;
      if (leftPosition !== rightPosition) return leftPosition - rightPosition;
      const leftCanonical = canonicalJson(left);
      const rightCanonical = canonicalJson(right);
      if (leftCanonical < rightCanonical) return -1;
      if (leftCanonical > rightCanonical) return 1;
      return 0;
    });
}

function replayEvents(snapshot, type) {
  return (snapshot && Array.isArray(snapshot.events) ? snapshot.events : [])
    .filter(event => event && event.type === type);
}

function directPostconditionResult(postcondition, snapshot) {
  const claims = replayEvents(snapshot, 'run:postcondition_completed');
  if (claims.length === 0) {
    return {
      type: postcondition.type,
      authority: 'objective_contract',
      passed: null,
      reasonCode: 'POSTCONDITION_EVIDENCE_UNAVAILABLE'
    };
  }
  const matching = [];
  for (const claim of claims) {
    const checkedPaths = Array.isArray(claim.checkedPaths) ? claim.checkedPaths : [];
    for (const checked of checkedPaths) {
      if (!checked || checked.path !== postcondition.path) continue;
      if (postcondition.type === 'folder_exists' && checked.type === 'folder') matching.push(claim);
      if (postcondition.type === 'path_absent' && checked.type === 'absent') matching.push(claim);
      if (postcondition.type === 'file_content_equals' && checked.type === 'file' &&
          typeof checked.expectedContent === 'string' &&
          sha256(checked.expectedContent) === postcondition.contentSha256) {
        matching.push(claim);
      }
    }
  }
  return {
    type: postcondition.type,
    authority: 'objective_contract',
    path: postcondition.path,
    passed: matching.length > 0,
    reasonCode: matching.length > 0 ? 'POSTCONDITION_PASSED' : 'POSTCONDITION_EVALUATION_FAILED'
  };
}

function normalizeProcessPostcondition(postcondition, index) {
  const label = `verificationPostconditions[${index}]`;
  const source = object(postcondition, label);
  const type = boundedString(source.type, `${label}.type`, 64);
  if (!PROCESS_POSTCONDITION_TYPES.includes(type)) return null;
  if (!PROCESS_OPERATION_IDENTITY_PATTERN.test(source.operationIdentity || '')) {
    fail('POSTCONDITION_EVALUATION_FAILED', `${label}.operationIdentity is invalid`);
  }
  if (type === 'processOperationExists') {
    exactKeys(source, ['id', 'type', 'operationIdentity'], label);
    return { id: source.id || null, type, operationIdentity: source.operationIdentity };
  }
  if (type === 'processTerminalOutcomeEquals') {
    exactKeys(source, ['id', 'type', 'operationIdentity', 'terminalOutcome'], label);
    return {
      id: source.id || null,
      type,
      operationIdentity: source.operationIdentity,
      terminalOutcome: boundedString(source.terminalOutcome, `${label}.terminalOutcome`, 64)
    };
  }
  exactKeys(source, ['id', 'type', 'operationIdentity', 'stream', 'byteCount', 'sha256'], label);
  if (!['stdout', 'stderr'].includes(source.stream)) {
    fail('POSTCONDITION_EVALUATION_FAILED', `${label}.stream must be stdout or stderr`);
  }
  if (!Number.isSafeInteger(source.byteCount) || source.byteCount < 0) {
    fail('POSTCONDITION_EVALUATION_FAILED', `${label}.byteCount must be a nonnegative safe integer`);
  }
  return {
    id: source.id || null,
    type,
    operationIdentity: source.operationIdentity,
    stream: source.stream,
    byteCount: source.byteCount,
    sha256: hash(source.sha256, `${label}.sha256`)
  };
}

function processPostconditionResult(postcondition, consequence) {
  const operations = consequence && Array.isArray(consequence.processOperations)
    ? consequence.processOperations
    : [];
  const operation = operations.find(item =>
    item && item.operationIdentity === postcondition.operationIdentity) || null;
  if (postcondition.type === 'processOperationExists') {
    return {
      id: postcondition.id,
      type: postcondition.type,
      authority: 'process_operation_receipt',
      operationIdentity: postcondition.operationIdentity,
      passed: Boolean(operation),
      reasonCode: operation ? 'POSTCONDITION_PASSED' : 'POSTCONDITION_EVALUATION_FAILED'
    };
  }
  if (postcondition.type === 'processTerminalOutcomeEquals') {
    const passed = Boolean(operation && operation.terminalOutcome === postcondition.terminalOutcome);
    return {
      id: postcondition.id,
      type: postcondition.type,
      authority: 'process_operation_receipt',
      operationIdentity: postcondition.operationIdentity,
      expectedTerminalOutcome: postcondition.terminalOutcome,
      actualTerminalOutcome: operation ? operation.terminalOutcome : null,
      passed,
      reasonCode: operation ? (passed ? 'POSTCONDITION_PASSED' : 'POSTCONDITION_EVALUATION_FAILED')
        : 'POSTCONDITION_EVIDENCE_UNAVAILABLE'
    };
  }
  const artifact = operation
    ? operation[postcondition.stream === 'stdout' ? 'stdoutArtifact' : 'stderrArtifact']
    : null;
  const passed = Boolean(artifact &&
    artifact.stream === postcondition.stream &&
    artifact.byteCount === postcondition.byteCount &&
    artifact.sha256 === postcondition.sha256);
  return {
    id: postcondition.id,
    type: postcondition.type,
    authority: 'process_operation_receipt',
    operationIdentity: postcondition.operationIdentity,
    stream: postcondition.stream,
    expected: { byteCount: postcondition.byteCount, sha256: postcondition.sha256 },
    actual: artifact ? { byteCount: artifact.byteCount, sha256: artifact.sha256 } : null,
    passed,
    reasonCode: artifact ? (passed ? 'POSTCONDITION_PASSED' : 'POSTCONDITION_EVALUATION_FAILED')
      : 'POSTCONDITION_EVIDENCE_UNAVAILABLE'
  };
}

function workflowPostconditionResults(postconditions, events, consequence) {
  const processResults = [];
  const ordinary = [];
  postconditions.forEach((postcondition, index) => {
    const processPostcondition = normalizeProcessPostcondition(postcondition, index);
    if (processPostcondition) processResults.push(processPostconditionResult(processPostcondition, consequence));
    else ordinary.push({ postcondition, index });
  });
  if (ordinary.length === 0) return { results: processResults, issues: [] };

  const checks = (Array.isArray(events) ? events : [])
    .filter(event => event && event.type === 'run.postconditions_checked');
  if (checks.length !== 1) {
    return {
      results: [
        ...processResults,
        ...ordinary.map(({ postcondition }) => ({
          id: postcondition && postcondition.id ? postcondition.id : null,
          type: postcondition && postcondition.type ? postcondition.type : null,
          authority: 'workflow_verification_event',
          passed: null,
          reasonCode: 'POSTCONDITION_EVIDENCE_UNAVAILABLE'
        }))
      ],
      issues: [{
        code: checks.length === 0 ? 'COMPLETION_EVIDENCE_MISSING' : 'COMPLETION_EVIDENCE_CONTRADICTORY',
        detail: checks.length === 0
          ? 'Required workflow postcondition evidence is missing'
          : 'Multiple workflow postcondition summaries exist'
      }]
    };
  }
  const payload = checks[0].payload || {};
  const storedResults = Array.isArray(payload.results) ? payload.results : [];
  const results = ordinary.map(({ postcondition, index }) => {
    const id = postcondition && postcondition.id ? postcondition.id : null;
    const match = storedResults.find(result => result &&
      ((id && result.id === id) || (!id && result.type === postcondition.type)));
    if (!match || typeof match.passed !== 'boolean') {
      return {
        id,
        type: postcondition && postcondition.type ? postcondition.type : null,
        authority: 'workflow_verification_event',
        passed: null,
        reasonCode: 'POSTCONDITION_EVIDENCE_UNAVAILABLE'
      };
    }
    return {
      id,
      type: match.type || postcondition.type || null,
      authority: 'workflow_verification_event',
      passed: match.passed,
      reasonCode: match.passed ? 'POSTCONDITION_PASSED' : 'POSTCONDITION_EVALUATION_FAILED'
    };
  });
  return { results: [...processResults, ...results], issues: [] };
}

function failureCodeFrom(run, snapshot, events) {
  const candidates = [
    snapshot && snapshot.failure && snapshot.failure.code,
    snapshot && snapshot.failure && snapshot.failure.kind,
    run && run.failure && run.failure.code,
    run && run.errorCode
  ].filter(Boolean);
  for (const event of Array.isArray(events) ? events : []) {
    const payload = event && event.payload;
    if (payload && payload.failure && payload.failure.code) candidates.push(payload.failure.code);
    if (payload && payload.failure && payload.failure.kind) candidates.push(payload.failure.kind);
  }
  return candidates.map(String);
}

function deriveExecutionDisposition(run, snapshot, events) {
  if (!run || !TERMINAL_RUN_STATUSES.has(run.status)) {
    fail('COMPLETION_DECISION_INVALID', 'Completion decisions require a terminal run');
  }
  const codes = failureCodeFrom(run, snapshot, events);
  const has = pattern => codes.some(code => pattern.test(code));
  if (run.status === 'interrupted') return 'cancelled';
  if (has(/verification_failed/i)) return 'succeeded';
  if (has(/budget|limit_exceeded|runtime_duration|feasibility/i) ||
      (Array.isArray(events) && events.some(event =>
        event && ['budget.exhausted', 'feasibility.rejected'].includes(event.type)))) {
    return 'budget_exhausted';
  }
  if (has(/infrastructure|persistence|launcher|containment|reconciliation|evidence/i)) {
    return 'infrastructure_failed';
  }
  return run.status === 'completed' ? 'succeeded' : 'failed';
}

function modelCompletionClaim(snapshot) {
  const plans = snapshot && Array.isArray(snapshot.parsedModelPlans)
    ? snapshot.parsedModelPlans
    : [];
  const plan = plans.slice().reverse().find(item =>
    item && typeof item.complete === 'boolean');
  return plan ? { complete: plan.complete, authority: false } : null;
}

function hasWorkflowCompletionEvidence(run, snapshot) {
  const outputs = snapshot && Array.isArray(snapshot.capabilityOutputs)
    ? snapshot.capabilityOutputs
    : [];
  return outputs.some(item => item &&
    item.capabilityType === 'workflow' &&
    item.capabilityId === run.workflowId);
}

function hasWorkflowDraftCompletionEvidence(snapshot) {
  return replayEvents(snapshot, 'workflow.draft_objective_satisfied').length > 0;
}

function hasWorkspaceObjectiveCompletionEvidence(snapshot, consequence) {
  const events = replayEvents(snapshot, 'workspace.objective_satisfied');
  if (events.length !== 1) return false;
  const objectivePaths = events[0] && Array.isArray(events[0].objectivePaths)
    ? events[0].objectivePaths
    : events[0] && events[0].payload && Array.isArray(events[0].payload.objectivePaths)
      ? events[0].payload.objectivePaths
      : [];
  if (objectivePaths.length === 0) return false;
  const durablePaths = [
    ...(Array.isArray(consequence && consequence.created) ? consequence.created : []),
    ...(Array.isArray(consequence && consequence.updated) ? consequence.updated : []),
    ...(Array.isArray(consequence && consequence.modified) ? consequence.modified : []),
    ...(Array.isArray(consequence && consequence.renamed) ? consequence.renamed : [])
  ].flatMap(item => {
    if (!item || typeof item !== 'object') return [];
    return [item.path, item.nextPath, item.from, item.to].filter(value => typeof value === 'string');
  });
  return objectivePaths.some(path => durablePaths.includes(path));
}

function processEvidenceIntegrityIssues(events, consequence) {
  const issues = [];
  const operations = consequence && Array.isArray(consequence.processOperations)
    ? consequence.processOperations
    : [];
  const eventList = Array.isArray(events) ? events : [];
  const matchingEvents = (type, operationIdentity) => eventList.filter(event =>
    event && event.type === type && event.payload &&
    event.payload.operationIdentity === operationIdentity);
  for (const operation of operations) {
    const terminal = matchingEvents('process.terminal', operation.operationIdentity);
    if (terminal.length !== 1) {
      issues.push({
        code: terminal.length === 0
          ? 'COMPLETION_EVIDENCE_MISSING'
          : 'COMPLETION_EVIDENCE_CONTRADICTORY',
        detail: `Process ${operation.operationIdentity} has ${terminal.length} terminal evidence records`
      });
      continue;
    }
    const terminalPayload = terminal[0].payload;
    if (terminalPayload.terminalOutcome !== operation.terminalOutcome ||
        terminalPayload.terminalResultHash !== operation.terminalResultHash) {
      issues.push({
        code: 'COMPLETION_EVIDENCE_CONTRADICTORY',
        detail: `Process ${operation.operationIdentity} terminal evidence contradicts its receipt`
      });
    }
    for (const stream of ['stdout', 'stderr']) {
      const expected = operation[`${stream}Artifact`];
      const artifactEvents = matchingEvents(`process.${stream}_artifact`, operation.operationIdentity);
      if (!expected) {
        if (artifactEvents.length > 0) {
          issues.push({
            code: 'COMPLETION_EVIDENCE_CONTRADICTORY',
            detail: `Process ${operation.operationIdentity} has unexpected ${stream} artifact evidence`
          });
        }
        continue;
      }
      if (artifactEvents.length !== 1) {
        issues.push({
          code: artifactEvents.length === 0
            ? 'COMPLETION_EVIDENCE_MISSING'
            : 'COMPLETION_EVIDENCE_CONTRADICTORY',
          detail: `Process ${operation.operationIdentity} has ${artifactEvents.length} ${stream} artifact evidence records`
        });
        continue;
      }
      const actual = artifactEvents[0].payload && artifactEvents[0].payload.artifact;
      if (!actual || actual.id !== expected.id || actual.stream !== expected.stream ||
          actual.byteCount !== expected.byteCount || actual.sha256 !== expected.sha256) {
        issues.push({
          code: 'COMPLETION_EVIDENCE_CONTRADICTORY',
          detail: `Process ${operation.operationIdentity} ${stream} artifact evidence contradicts its receipt`
        });
      }
    }
  }
  return issues;
}

function browserEvidenceIntegrityIssues(snapshot, consequence) {
  const browserEvidence = consequence && consequence.verification
    ? consequence.verification.browserEvidence
    : null;
  if (!browserEvidence) return [];
  const snapshotStatus = snapshot && snapshot.browserEvidenceStatus;
  const snapshotDetail = snapshot && snapshot.browserEvidenceDetail;
  if (snapshotStatus === null || snapshotStatus === undefined) {
    return [{
      code: 'COMPLETION_EVIDENCE_MISSING',
      detail: 'Finalized browser evidence verdict is missing'
    }];
  }
  if (snapshotStatus !== browserEvidence.status ||
      (snapshotDetail || null) !== (browserEvidence.detail || null)) {
    return [{
      code: 'COMPLETION_EVIDENCE_CONTRADICTORY',
      detail: 'Browser evidence verdict contradicts the finalized replay'
    }];
  }
  return [];
}

function deriveDecisionFacts({ run, snapshot, events, consequence, verificationContract }) {
  const authority = normalizeCompletionAuthoritySnapshot(run.completionAuthoritySnapshot);
  const evidenceIssues = [];
  const directResults = authority.objectiveContract.directPostconditions
    .map(postcondition => directPostconditionResult(postcondition, snapshot));
  const declaredWorkflowPostconditions = verificationContract && Array.isArray(verificationContract.postconditions)
    ? verificationContract.postconditions
    : [];
  const workflow = workflowPostconditionResults(declaredWorkflowPostconditions, events, consequence);
  evidenceIssues.push(...workflow.issues);
  evidenceIssues.push(...processEvidenceIntegrityIssues(events, consequence));
  evidenceIssues.push(...browserEvidenceIntegrityIssues(snapshot, consequence));
  const evaluatedPostconditions = [...directResults, ...workflow.results];

  const verificationVerdicts = (Array.isArray(events) ? events : [])
    .filter(event => event && ['run.verification_passed', 'run.verification_failed'].includes(event.type));
  if (verificationVerdicts.some(event => event.type === 'run.verification_passed') &&
      verificationVerdicts.some(event => event.type === 'run.verification_failed')) {
    evidenceIssues.push({
      code: 'COMPLETION_EVIDENCE_CONTRADICTORY',
      detail: 'Verification evidence contains both passed and failed verdicts'
    });
  }
  const violations = (Array.isArray(events) ? events : [])
    .filter(event => event && [
      'run.violation_detected',
      'runtime.violation_detected',
      'workspace.violation_detected'
    ].includes(event.type))
    .map(event => ({
      type: event.type,
      rule: event.payload && event.payload.rule ? event.payload.rule : null
    }));
  if (violations.length > 0) {
    evidenceIssues.push({
      code: 'COMPLETION_EVIDENCE_CONTRADICTORY',
      detail: 'Authority or workspace violation evidence prevents objective completion'
    });
  }

  const required = evaluatedPostconditions.length > 0;
  let verificationDisposition = 'not_required';
  if (evidenceIssues.length > 0) {
    verificationDisposition = 'unavailable';
  } else if (required) {
    if (evaluatedPostconditions.some(result => result.passed === null)) {
      verificationDisposition = 'unavailable';
    } else if (evaluatedPostconditions.some(result => result.passed === false)) {
      verificationDisposition = 'failed';
    } else {
      verificationDisposition = 'passed';
    }
  }

  const executionDisposition = deriveExecutionDisposition(run, snapshot, events);
  let completionDisposition = 'incomplete';
  let reasonCode = 'OBJECTIVE_INCOMPLETE';
  if (executionDisposition === 'infrastructure_failed') {
    completionDisposition = 'blocked';
    reasonCode = 'VERIFICATION_UNAVAILABLE';
  } else if (executionDisposition !== 'succeeded') {
    completionDisposition = 'incomplete';
    reasonCode = executionDisposition === 'budget_exhausted'
      ? 'RUN_BUDGET_EXHAUSTED'
      : executionDisposition === 'cancelled'
        ? 'RUN_CANCELLED'
        : 'RUN_EXECUTION_FAILED';
  } else if (verificationDisposition === 'failed') {
    completionDisposition = 'incomplete';
    reasonCode = 'VERIFICATION_FAILED';
  } else if (verificationDisposition === 'unavailable') {
    completionDisposition = 'blocked';
    reasonCode = 'VERIFICATION_UNAVAILABLE';
  } else if (required && verificationDisposition === 'passed') {
    completionDisposition = 'completed';
    reasonCode = 'OBJECTIVE_COMPLETED';
  } else if (authority.objectiveContract.kind === 'workflow' &&
      hasWorkflowCompletionEvidence(run, snapshot)) {
    completionDisposition = 'completed';
    reasonCode = 'OBJECTIVE_COMPLETED';
  } else if (authority.objectiveContract.kind === 'workflow_draft' &&
      hasWorkflowDraftCompletionEvidence(snapshot)) {
    completionDisposition = 'completed';
    reasonCode = 'OBJECTIVE_COMPLETED';
  } else if (authority.objectiveContract.kind === 'deterministic' &&
      authority.objectiveContract.completionPolicy === 'workspace_objective_receipt' &&
      hasWorkspaceObjectiveCompletionEvidence(snapshot, consequence)) {
    completionDisposition = 'completed';
    reasonCode = 'OBJECTIVE_COMPLETED';
  }

  return {
    authority,
    executionDisposition,
    verificationDisposition,
    completionDisposition,
    evaluatedPostconditions,
    violations,
    evidenceIssues,
    reasonCode
  };
}

function buildCompletionDecision({
  run,
  replaySnapshot,
  events,
  operations,
  consequence,
  verificationContract,
  evaluatedAt
}) {
  const sourceRun = object(run, 'run');
  const snapshot = object(replaySnapshot, 'replaySnapshot');
  const operationList = Array.isArray(operations) ? operations : [];
  const baseConsequence = object(consequence, 'consequence');
  const facts = deriveDecisionFacts({
    run: sourceRun,
    snapshot,
    events,
    consequence: baseConsequence,
    verificationContract
  });
  const evidence = relevantEvidence(events);
  const replayCompletionEvidence = (Array.isArray(snapshot.events) ? snapshot.events : [])
    .filter(event => event && [
      'run:postcondition_completed',
      'workflow.draft_objective_satisfied',
      'workspace.objective_satisfied'
    ].includes(event.type))
    .map(event => canonicalize(event));
  const verificationContractHash = verificationContract
    ? hashCanonical(verificationContract)
    : null;
  const executionPolicySnapshotHash = hashCanonical(sourceRun.executionPolicySnapshot || {});
  const runtimeBudgetSnapshotHash = sourceRun.runtimeBudgetSnapshot &&
    typeof sourceRun.runtimeBudgetSnapshot.snapshotHash === 'string'
    ? hash(sourceRun.runtimeBudgetSnapshot.snapshotHash, 'runtimeBudgetSnapshot.snapshotHash')
    : null;
  const operationReceiptHash = hashCanonical(operationList);
  const consequenceHash = hashCanonical(baseConsequence);
  const requiredEvidenceHash = hashCanonical({
    events: evidence,
    replayCompletionEvidence
  });
  const withoutHash = {
    version: COMPLETION_DECISION_VERSION,
    runId: positiveInteger(sourceRun.id, 'run.id'),
    ticketId: positiveInteger(sourceRun.ticketId, 'run.ticketId'),
    objectiveContractVersion: facts.authority.objectiveContract.version,
    objectiveContractHash: facts.authority.objectiveContractHash,
    workflowDeclarationVersion: verificationContract ? 1 : null,
    workflowDeclarationHash: verificationContractHash,
    executionPolicySnapshotHash,
    runtimeBudgetSnapshotHash,
    operationReceiptAuthority: {
      revision: operationList.length,
      hash: operationReceiptHash
    },
    consequenceAuthority: {
      revision: 1,
      hash: consequenceHash
    },
    requiredEvidenceAuthority: {
      revision: evidence.length + replayCompletionEvidence.length,
      hash: requiredEvidenceHash
    },
    executionDisposition: facts.executionDisposition,
    verificationDisposition: facts.verificationDisposition,
    completionDisposition: facts.completionDisposition,
    evaluatedPostconditions: canonicalize(facts.evaluatedPostconditions),
    violations: canonicalize(facts.violations),
    evidenceIssues: canonicalize(facts.evidenceIssues),
    reasonCode: facts.reasonCode,
    modelClaim: modelCompletionClaim(snapshot),
    browserEvidence: baseConsequence.verification && baseConsequence.verification.browserEvidence
      ? canonicalize(baseConsequence.verification.browserEvidence)
      : null,
    evaluatedAt: timestamp(evaluatedAt, 'evaluatedAt')
  };
  return normalizeCompletionDecision({
    ...withoutHash,
    decisionHash: hashCanonical(withoutHash)
  });
}

function nullableBoundedString(value, label, maximum = 512) {
  return value === null ? null : boundedString(value, label, maximum);
}

function normalizeArtifactExpectation(value, label) {
  if (value === null) return null;
  const source = object(value, label);
  exactKeys(source, ['byteCount', 'sha256'], label);
  if (!Number.isSafeInteger(source.byteCount) || source.byteCount < 0) {
    fail('COMPLETION_DECISION_INVALID', `${label}.byteCount is invalid`);
  }
  return {
    byteCount: source.byteCount,
    sha256: hash(source.sha256, `${label}.sha256`)
  };
}

function normalizeEvaluatedPostcondition(value, index) {
  const label = `completionDecision.evaluatedPostconditions[${index}]`;
  const source = object(value, label);
  exactKeys(source, [
    'id',
    'type',
    'authority',
    'path',
    'operationIdentity',
    'stream',
    'expectedTerminalOutcome',
    'actualTerminalOutcome',
    'expected',
    'actual',
    'passed',
    'reasonCode'
  ], label);
  if (source.passed !== null && typeof source.passed !== 'boolean') {
    fail('COMPLETION_DECISION_INVALID', `${label}.passed must be boolean or null`);
  }
  if (source.operationIdentity !== undefined &&
      !PROCESS_OPERATION_IDENTITY_PATTERN.test(source.operationIdentity)) {
    fail('COMPLETION_DECISION_INVALID', `${label}.operationIdentity is invalid`);
  }
  if (source.stream !== undefined && !['stdout', 'stderr'].includes(source.stream)) {
    fail('COMPLETION_DECISION_INVALID', `${label}.stream is invalid`);
  }
  return {
    ...(source.id === undefined ? {} : {
      id: nullableBoundedString(source.id, `${label}.id`, 128)
    }),
    type: nullableBoundedString(source.type, `${label}.type`, 64),
    authority: boundedString(source.authority, `${label}.authority`, 64),
    ...(source.path === undefined ? {} : { path: normalizePath(source.path, `${label}.path`) }),
    ...(source.operationIdentity === undefined ? {} : {
      operationIdentity: source.operationIdentity
    }),
    ...(source.stream === undefined ? {} : { stream: source.stream }),
    ...(source.expectedTerminalOutcome === undefined ? {} : {
      expectedTerminalOutcome: boundedString(
        source.expectedTerminalOutcome,
        `${label}.expectedTerminalOutcome`,
        64
      )
    }),
    ...(source.actualTerminalOutcome === undefined ? {} : {
      actualTerminalOutcome: nullableBoundedString(
        source.actualTerminalOutcome,
        `${label}.actualTerminalOutcome`,
        64
      )
    }),
    ...(source.expected === undefined ? {} : {
      expected: normalizeArtifactExpectation(source.expected, `${label}.expected`)
    }),
    ...(source.actual === undefined ? {} : {
      actual: normalizeArtifactExpectation(source.actual, `${label}.actual`)
    }),
    passed: source.passed,
    reasonCode: boundedString(source.reasonCode, `${label}.reasonCode`, 64)
  };
}

function normalizeViolation(value, index) {
  const label = `completionDecision.violations[${index}]`;
  const source = object(value, label);
  exactKeys(source, ['type', 'rule'], label);
  return {
    type: boundedString(source.type, `${label}.type`, 128),
    rule: nullableBoundedString(source.rule, `${label}.rule`, 256)
  };
}

function normalizeEvidenceIssue(value, index) {
  const label = `completionDecision.evidenceIssues[${index}]`;
  const source = object(value, label);
  exactKeys(source, ['code', 'detail'], label);
  if (!['COMPLETION_EVIDENCE_MISSING', 'COMPLETION_EVIDENCE_CONTRADICTORY'].includes(source.code)) {
    fail('COMPLETION_DECISION_INVALID', `${label}.code is invalid`);
  }
  return {
    code: source.code,
    detail: boundedString(source.detail, `${label}.detail`, 1024)
  };
}

function normalizeModelClaim(value) {
  if (value === null) return null;
  const source = object(value, 'completionDecision.modelClaim');
  exactKeys(source, ['complete', 'authority'], 'completionDecision.modelClaim');
  if (typeof source.complete !== 'boolean' || source.authority !== false) {
    fail('COMPLETION_DECISION_INVALID', 'completionDecision.modelClaim is invalid');
  }
  return { complete: source.complete, authority: false };
}

function normalizeBrowserEvidence(value) {
  if (value === null) return null;
  const source = object(value, 'completionDecision.browserEvidence');
  exactKeys(source, ['status', 'detail'], 'completionDecision.browserEvidence');
  return {
    status: boundedString(source.status, 'completionDecision.browserEvidence.status', 128),
    detail: nullableBoundedString(source.detail, 'completionDecision.browserEvidence.detail', 2048)
  };
}

function normalizeCompletionDecision(value) {
  const source = object(value, 'completionDecision');
  const allowed = [
    'version',
    'runId',
    'ticketId',
    'objectiveContractVersion',
    'objectiveContractHash',
    'workflowDeclarationVersion',
    'workflowDeclarationHash',
    'executionPolicySnapshotHash',
    'runtimeBudgetSnapshotHash',
    'operationReceiptAuthority',
    'consequenceAuthority',
    'requiredEvidenceAuthority',
    'executionDisposition',
    'verificationDisposition',
    'completionDisposition',
    'evaluatedPostconditions',
    'violations',
    'evidenceIssues',
    'reasonCode',
    'modelClaim',
    'browserEvidence',
    'evaluatedAt',
    'decisionHash'
  ];
  exactKeys(source, allowed, 'completionDecision');
  if (source.version !== COMPLETION_DECISION_VERSION) {
    fail('COMPLETION_DECISION_INVALID', `Unsupported completion decision version: ${source.version}`);
  }
  positiveInteger(source.runId, 'completionDecision.runId');
  positiveInteger(source.ticketId, 'completionDecision.ticketId');
  if (source.objectiveContractVersion !== 1) {
    fail('COMPLETION_DECISION_INVALID', 'completionDecision.objectiveContractVersion must be 1');
  }
  if (source.workflowDeclarationVersion !== null && source.workflowDeclarationVersion !== 1) {
    fail('COMPLETION_DECISION_INVALID', 'completionDecision.workflowDeclarationVersion is invalid');
  }
  if (!EXECUTION_DISPOSITIONS.includes(source.executionDisposition) ||
      !VERIFICATION_DISPOSITIONS.includes(source.verificationDisposition) ||
      !COMPLETION_DISPOSITIONS.includes(source.completionDisposition)) {
    fail('COMPLETION_DECISION_INVALID', 'Completion decision contains an unknown disposition');
  }
  [
    'objectiveContractHash',
    'executionPolicySnapshotHash'
  ].forEach(key => hash(source[key], `completionDecision.${key}`));
  if (source.workflowDeclarationHash !== null) {
    hash(source.workflowDeclarationHash, 'completionDecision.workflowDeclarationHash');
  }
  if ((source.workflowDeclarationVersion === null) !==
      (source.workflowDeclarationHash === null)) {
    fail('COMPLETION_DECISION_INVALID', 'Completion workflow declaration version/hash must both be present or absent');
  }
  if (source.runtimeBudgetSnapshotHash !== null) {
    hash(source.runtimeBudgetSnapshotHash, 'completionDecision.runtimeBudgetSnapshotHash');
  }
  for (const key of ['operationReceiptAuthority', 'consequenceAuthority', 'requiredEvidenceAuthority']) {
    const authority = object(source[key], `completionDecision.${key}`);
    exactKeys(authority, ['revision', 'hash'], `completionDecision.${key}`);
    if (!Number.isSafeInteger(authority.revision) || authority.revision < 0) {
      fail('COMPLETION_DECISION_INVALID', `completionDecision.${key}.revision is invalid`);
    }
    hash(authority.hash, `completionDecision.${key}.hash`);
  }
  timestamp(source.evaluatedAt, 'completionDecision.evaluatedAt');
  if (!Array.isArray(source.evaluatedPostconditions) ||
      source.evaluatedPostconditions.length > 256 ||
      !Array.isArray(source.violations) || source.violations.length > 256 ||
      !Array.isArray(source.evidenceIssues) || source.evidenceIssues.length > 256) {
    fail('COMPLETION_DECISION_INVALID', 'Completion decision detail collections are invalid');
  }
  if (!COMPLETION_REASON_CODES.includes(source.reasonCode)) {
    fail('COMPLETION_DECISION_INVALID', 'completionDecision.reasonCode is invalid');
  }
  const normalizedDetail = {
    evaluatedPostconditions: source.evaluatedPostconditions.map(normalizeEvaluatedPostcondition),
    violations: source.violations.map(normalizeViolation),
    evidenceIssues: source.evidenceIssues.map(normalizeEvidenceIssue),
    modelClaim: normalizeModelClaim(source.modelClaim),
    browserEvidence: normalizeBrowserEvidence(source.browserEvidence)
  };
  const withoutHash = {};
  for (const key of allowed) {
    if (key !== 'decisionHash') {
      withoutHash[key] = Object.hasOwn(normalizedDetail, key)
        ? normalizedDetail[key]
        : source[key];
    }
  }
  const decisionHash = hash(source.decisionHash, 'completionDecision.decisionHash');
  if (decisionHash !== hashCanonical(withoutHash)) {
    fail('COMPLETION_DECISION_CONFLICT', 'Completion decision hash does not match');
  }
  return deepFreeze(canonicalize({ ...withoutHash, decisionHash }));
}

function completionEvidenceProjection(decision) {
  const normalized = normalizeCompletionDecision(decision);
  return deepFreeze({
    version: normalized.version,
    runId: normalized.runId,
    ticketId: normalized.ticketId,
    decisionHash: normalized.decisionHash,
    executionDisposition: normalized.executionDisposition,
    verificationDisposition: normalized.verificationDisposition,
    completionDisposition: normalized.completionDisposition,
    objectiveContractHash: normalized.objectiveContractHash,
    postconditionDeclarationHash: normalized.workflowDeclarationHash,
    consequenceHash: normalized.consequenceAuthority.hash,
    consequenceRevision: normalized.consequenceAuthority.revision,
    requiredEvidenceHash: normalized.requiredEvidenceAuthority.hash,
    requiredEvidenceRevision: normalized.requiredEvidenceAuthority.revision,
    reasonCode: normalized.reasonCode,
    evaluatedPostconditions: normalized.evaluatedPostconditions,
    evidenceIssues: normalized.evidenceIssues
  });
}

module.exports = {
  COMPLETION_AUTHORITY_VERSION,
  COMPLETION_DECISION_VERSION,
  SUPPORTED_VERIFICATION_POLICY,
  EXECUTION_DISPOSITIONS,
  VERIFICATION_DISPOSITIONS,
  COMPLETION_DISPOSITIONS,
  PROCESS_POSTCONDITION_TYPES,
  COMPLETION_FAILURE_CODES,
  COMPLETION_REASON_CODES,
  CompletionContractError,
  buildCompletionAuthoritySnapshot,
  normalizeCompletionAuthoritySnapshot,
  buildCompletionDecision,
  normalizeCompletionDecision,
  completionEvidenceProjection,
  canonicalJson,
  hashCanonical,
  sha256
};

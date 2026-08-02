'use strict';

// Tranche 5 — the deterministic churn decision, and the bounded tolerance
// policy it is evaluated against.
//
// TWO ANSWERS, AND ONLY TWO:
//
//   continue  — tolerance remains; a further governed request is permitted
//   blocked   — tolerance is exhausted; stop spending
//
// There is deliberately no `retry`, `reroute`, `replan`, or `remediate`. A
// runtime that automatically repairs churn is a runtime that spends more money
// on a situation it has just proven it does not understand. The truthful
// outcome is to stop and leave the evidence intact for a human.
//
// WHY `blocked` AND NOT `interrupted`. Ordinary recovery resumes interrupted
// Runs automatically. A churn stop is a decision, not an accident: resuming it
// would re-enter the loop that produced it. `blocked` is the existing truthful
// state that recovery does not silently restart.
//
// EVERY INPUT IS A DURABLE ROW. The decision reads an ordered verified-progress
// projection and cumulative resource totals reconstructed from budget charges,
// economic reservations and operation receipts. No process-local counter takes
// part, so the same durable facts always yield the same decision — before and
// after a restart, in any process.

const {
  compareCanonicalText,
  deepFreeze,
  hashCanonical
} = require('./declared-work-contract');
const {
  NO_PROGRESS_SIGNALS,
  normalizeVerifiedProgressProjection
} = require('./verified-progress-contract');

const CHURN_DECISION_VERSION = 1;
const PROGRESS_POLICY_VERSION = 1;

const CHURN_DECISIONS = Object.freeze(['continue', 'blocked']);

// Closed stop reasons. Each names one durable condition; none is a guess.
const CHURN_STOP_REASONS = Object.freeze([
  'verified_progress_exhausted',
  'repeated_no_op',
  'repeated_failed_operation',
  'mutation_reversal_churn',
  'progress_accounting_conflict',
  'undeclared_sibling_dependency'
]);

// The bounded tolerance policy. Closed, versioned, and captured immutably on a
// governed Run before execution, so a policy edit cannot rewrite a Run that is
// already loose in the world — and so a model has nothing to negotiate with.
const PROGRESS_POLICY_FIELDS = Object.freeze([
  'version',
  'maximumConsecutiveNoProgressWindows',
  'maximumRepeatedMutations',
  'maximumFailedOperationStreak',
  'maximumMutationReversals',
  'maximumInspectionOnlyStreak',
  'resourceDimensions',
  'policyHash'
]);

// The durable resource dimensions a tolerance may be measured against. All of
// them already exist; Tranche 5 adds no ledger.
const RESOURCE_DIMENSIONS = Object.freeze([
  'provider_requests',
  'durable_operations',
  'settled_micro_usd',
  'budget_charged_units'
]);

const CHURN_DECISION_FIELDS = Object.freeze([
  'version',
  'ticketId',
  'runId',
  'windowIdentity',
  'progressProjectionHash',
  'cumulativeResources',
  'consecutiveNoProgressWindows',
  'repeatedOperationSignals',
  'failedOperationStreak',
  'mutationReversalSignals',
  'inspectionOnlyStreak',
  'settledMicroUsd',
  'decision',
  'reason',
  'progressPolicyHash',
  'decisionHash'
]);

const CHURN_REFUSALS = Object.freeze([
  'progress_policy_malformed',
  'churn_decision_malformed',
  'churn_tolerance_unbounded',
  'churn_accounting_conflict'
]);

class ChurnDecisionError extends Error {
  constructor(code, message, detail = {}) {
    super(message);
    this.name = 'ChurnDecisionError';
    this.code = code;
    this.detail = detail;
  }
}

function fail(message, code = 'CHURN_DECISION_INVALID', detail = {}) {
  throw new ChurnDecisionError(code, message, detail);
}

function refuse(reason, message = null) {
  if (!CHURN_REFUSALS.includes(reason)) {
    fail(`Unsupported churn refusal: ${String(reason)}`);
  }
  fail(message || reason, 'CHURN_DECISION_REFUSED', { reason });
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

// A tolerance must be a positive, finite, bounded integer. `null`, `0` and
// `Infinity` are all refused: an unbounded tolerance is not a tolerance, it is
// the absence of one, and it would let churn run until the money ran out.
function boundedTolerance(value, label, maximum = 1_000) {
  if (!Number.isSafeInteger(value) || value < 1) {
    refuse('churn_tolerance_unbounded',
      `${label} must be a bounded positive integer`);
  }
  if (value > maximum) {
    refuse('churn_tolerance_unbounded',
      `${label} exceeds the ${maximum} ceiling and is effectively unbounded`);
  }
  return value;
}

function nonNegativeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    refuse('churn_decision_malformed', `${label} must be a non-negative safe integer`);
  }
  return value;
}

// ── Tolerance policy ────────────────────────────────────────────────────────

function buildProgressControlPolicy({
  maximumConsecutiveNoProgressWindows,
  maximumRepeatedMutations,
  maximumFailedOperationStreak,
  maximumMutationReversals,
  maximumInspectionOnlyStreak,
  resourceDimensions
}) {
  if (!Array.isArray(resourceDimensions) || resourceDimensions.length === 0) {
    refuse('progress_policy_malformed',
      'a progress-control policy must name at least one durable resource dimension');
  }
  const unknown = resourceDimensions.filter(d => !RESOURCE_DIMENSIONS.includes(d));
  if (unknown.length > 0) {
    refuse('progress_policy_malformed',
      `unknown resource dimension(s): ${unknown.sort(compareCanonicalText).join(', ')}`);
  }
  const fields = {
    version: PROGRESS_POLICY_VERSION,
    maximumConsecutiveNoProgressWindows: boundedTolerance(
      maximumConsecutiveNoProgressWindows, 'maximumConsecutiveNoProgressWindows'),
    maximumRepeatedMutations: boundedTolerance(
      maximumRepeatedMutations, 'maximumRepeatedMutations'),
    maximumFailedOperationStreak: boundedTolerance(
      maximumFailedOperationStreak, 'maximumFailedOperationStreak'),
    maximumMutationReversals: boundedTolerance(
      maximumMutationReversals, 'maximumMutationReversals'),
    maximumInspectionOnlyStreak: boundedTolerance(
      maximumInspectionOnlyStreak, 'maximumInspectionOnlyStreak'),
    resourceDimensions: deepFreeze(
      [...new Set(resourceDimensions)].sort(compareCanonicalText)),
    policyHash: null
  };
  const withoutHash = {};
  for (const field of PROGRESS_POLICY_FIELDS) {
    if (field === 'policyHash') continue;
    withoutHash[field] = fields[field];
  }
  fields.policyHash = hashCanonical(withoutHash);
  return deepFreeze(fields);
}

function normalizeProgressControlPolicy(value) {
  if (!isPlainObject(value)) {
    refuse('progress_policy_malformed', 'progress-control policy must be an object');
  }
  const unknown = Object.keys(value).filter(f => !PROGRESS_POLICY_FIELDS.includes(f));
  if (unknown.length > 0) {
    refuse('progress_policy_malformed',
      `policy contains unknown field(s): ${unknown.sort(compareCanonicalText).join(', ')}`);
  }
  const missing = PROGRESS_POLICY_FIELDS.filter(
    f => !Object.prototype.hasOwnProperty.call(value, f));
  if (missing.length > 0) {
    refuse('progress_policy_malformed',
      `policy is missing field(s): ${missing.join(', ')}`);
  }
  const rebuilt = buildProgressControlPolicy(value);
  if (rebuilt.policyHash !== value.policyHash) {
    refuse('progress_policy_malformed', 'the policy hash does not cover its own fields');
  }
  return rebuilt;
}

// ── The decision ────────────────────────────────────────────────────────────
//
// Pure. Same durable inputs, same output, in any process, before or after a
// restart. Nothing here reads the clock, the filesystem, or a counter held in
// memory.

function decideChurn({
  ticketId,
  runId,
  progressProjection,
  policy,
  cumulativeResources,
  consecutiveNoProgressWindows,
  siblingDependencyBlocked = false
}) {
  const projection = normalizeVerifiedProgressProjection(progressProjection);
  const controls = normalizeProgressControlPolicy(policy);

  const resources = {
    providerRequests: nonNegativeInteger(
      cumulativeResources.providerRequests || 0, 'cumulative providerRequests'),
    durableOperations: nonNegativeInteger(
      cumulativeResources.durableOperations || 0, 'cumulative durableOperations'),
    settledMicroUsd: nonNegativeInteger(
      cumulativeResources.settledMicroUsd || 0, 'cumulative settledMicroUsd'),
    budgetChargedUnits: nonNegativeInteger(
      cumulativeResources.budgetChargedUnits || 0, 'cumulative budgetChargedUnits')
  };
  const consecutive = nonNegativeInteger(
    consecutiveNoProgressWindows, 'consecutiveNoProgressWindows');

  const signals = new Set(projection.noProgressSignals);
  for (const signal of signals) {
    if (!NO_PROGRESS_SIGNALS.includes(signal)) {
      refuse('churn_accounting_conflict',
        `unrecognized no-progress signal: ${String(signal)}`);
    }
  }

  // Order matters only for which reason is REPORTED; any one of them stops.
  // The sibling refusal comes first because it is a coordination fact rather
  // than a churn measurement, and reporting churn for it would mislead.
  let decision = 'continue';
  let reason = null;
  if (siblingDependencyBlocked) {
    decision = 'blocked';
    reason = 'undeclared_sibling_dependency';
  } else if (signals.has('repeated_no_op')) {
    decision = 'blocked';
    reason = 'repeated_no_op';
  } else if (signals.has('repeated_failed_operation')) {
    decision = 'blocked';
    reason = 'repeated_failed_operation';
  } else if (signals.has('mutation_reversal_churn')) {
    decision = 'blocked';
    reason = 'mutation_reversal_churn';
  } else if (consecutive >= controls.maximumConsecutiveNoProgressWindows) {
    // The central rule: resources grew, no declared fact advanced, and the
    // bounded tolerance is spent.
    decision = 'blocked';
    reason = 'verified_progress_exhausted';
  }

  const fields = {
    version: CHURN_DECISION_VERSION,
    ticketId: nonNegativeInteger(ticketId, 'ticketId'),
    runId: nonNegativeInteger(runId, 'runId'),
    windowIdentity: projection.windowIdentity,
    progressProjectionHash: projection.projectionHash,
    cumulativeResources: deepFreeze(resources),
    consecutiveNoProgressWindows: consecutive,
    repeatedOperationSignals: signals.has('repeated_no_op') ? 1 : 0,
    failedOperationStreak: signals.has('repeated_failed_operation') ? 1 : 0,
    mutationReversalSignals: signals.has('mutation_reversal_churn') ? 1 : 0,
    inspectionOnlyStreak: signals.has('inspection_only_streak') ? 1 : 0,
    settledMicroUsd: resources.settledMicroUsd,
    decision,
    reason,
    progressPolicyHash: controls.policyHash,
    decisionHash: null
  };
  const withoutHash = {};
  for (const field of CHURN_DECISION_FIELDS) {
    if (field === 'decisionHash') continue;
    withoutHash[field] = fields[field];
  }
  fields.decisionHash = hashCanonical(withoutHash);
  return deepFreeze(fields);
}

function normalizeChurnDecision(value) {
  if (!isPlainObject(value)) {
    refuse('churn_decision_malformed', 'churn decision must be an object');
  }
  const unknown = Object.keys(value).filter(f => !CHURN_DECISION_FIELDS.includes(f));
  if (unknown.length > 0) {
    refuse('churn_decision_malformed',
      `decision contains unknown field(s): ${unknown.sort(compareCanonicalText).join(', ')}`);
  }
  const missing = CHURN_DECISION_FIELDS.filter(
    f => !Object.prototype.hasOwnProperty.call(value, f));
  if (missing.length > 0) {
    refuse('churn_decision_malformed', `decision is missing field(s): ${missing.join(', ')}`);
  }
  if (!CHURN_DECISIONS.includes(value.decision)) {
    refuse('churn_decision_malformed', `unsupported decision: ${String(value.decision)}`);
  }
  if (value.decision === 'blocked' && !CHURN_STOP_REASONS.includes(value.reason)) {
    refuse('churn_decision_malformed', 'a blocked decision must carry a closed stop reason');
  }
  if (value.decision === 'continue' && value.reason !== null) {
    refuse('churn_decision_malformed', 'a continue decision carries no stop reason');
  }
  const withoutHash = {};
  for (const field of CHURN_DECISION_FIELDS) {
    if (field === 'decisionHash') continue;
    withoutHash[field] = value[field];
  }
  if (value.decisionHash !== hashCanonical(withoutHash)) {
    refuse('churn_decision_malformed', 'the decision hash does not cover its own fields');
  }
  const normalized = {};
  for (const field of CHURN_DECISION_FIELDS) normalized[field] = value[field];
  return deepFreeze(normalized);
}

// The gate every additional governed structured-leaf request must pass. It
// returns permission, never performs it: reserving and dispatching remain
// Tranche 4's, and this only says whether they may happen at all.
function permitsGovernedRequest(decision) {
  return normalizeChurnDecision(decision).decision === 'continue';
}

module.exports = {
  CHURN_DECISIONS,
  CHURN_DECISION_FIELDS,
  CHURN_DECISION_VERSION,
  CHURN_REFUSALS,
  CHURN_STOP_REASONS,
  ChurnDecisionError,
  PROGRESS_POLICY_FIELDS,
  PROGRESS_POLICY_VERSION,
  RESOURCE_DIMENSIONS,
  buildProgressControlPolicy,
  decideChurn,
  normalizeChurnDecision,
  normalizeProgressControlPolicy,
  permitsGovernedRequest,
  refuseChurn: refuse
};

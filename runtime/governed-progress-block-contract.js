'use strict';

// Tranche 5 — the persisted progress block.
//
// ONE contract for BOTH stop conditions — resource churn and undeclared sibling
// dependency. Two competing block authorities would eventually disagree about
// why a Run stopped, and "why" is the whole value of the record.
//
// WHY THIS IS PERSISTED AT ALL. A churn decision that exists only as a thrown
// exception is re-derived on every restart from whatever rows happen to exist
// then. A receipt committed after the stop would silently change the reason the
// Run was blocked, and a restart could capture fresh maxima and reach a
// different answer. Persisting the block with its exact cutoff makes the
// decision a historical fact rather than a re-computation.
//
// THE CUTOFF IS INSIDE THE HASH. That is what makes the block reproducible:
//
//   stored cutoff
//   + durable rows at or below it
//   + captured progress policy
//   + immutable execution epoch
//   → the same projection hash and the same decision hash, forever
//
// Reading an existing block never captures new maxima.

const {
  compareCanonicalText,
  deepFreeze,
  hashCanonical
} = require('./declared-work-contract');
const { CHURN_STOP_REASONS } = require('./churn-decision-contract');

const GOVERNED_PROGRESS_BLOCK_VERSION = 1;
const HASH_PATTERN = /^[0-9a-f]{64}$/;

// Every monotonic identity the projection depends on. All three are load-bearing
// today; a fourth would have to be added here to be covered by the hash.
const CUTOFF_FIELDS = Object.freeze([
  'receiptCutoff',
  'reservationCutoff',
  'budgetCutoff',
  // Tranche 5: the canonical postcondition-evidence bound. Verified progress is
  // credited only from evidence at or below this id, so evidence committed
  // after an evaluation belongs to the NEXT one and can never retroactively
  // change a decision already taken.
  'postconditionEvidenceCutoff',
  // The instant the evaluation was taken, read from the DATABASE clock in the
  // same statement and snapshot as the three maxima above. It belongs in the
  // cutoff rather than beside it because duration is evaluated against exactly
  // the rows the cutoff admits — and because a block replayed later must reuse
  // this instant rather than construct a new one, which would make a stored
  // decision drift every time it was read.
  'evaluatedAt'
]);

// The cutoff fields that are ordered row maxima. `evaluatedAt` is an instant
// and is normalized separately.
const CUTOFF_ORDINAL_FIELDS = Object.freeze([
  'receiptCutoff',
  'reservationCutoff',
  'budgetCutoff',
  'postconditionEvidenceCutoff'
]);

const SIBLING_DEPENDENCY_FIELDS = Object.freeze([
  'requestedPath',
  'siblingAllocationItemId',
  'siblingRunId',
  'siblingOwnedScope',
  // The completion-decision identity when the sibling IS complete, or an
  // explicit statement of why it is not. Never left implicit.
  'siblingCompletionDecisionHash',
  'siblingCompletionState'
]);

// Why a sibling read was refused. `terminal_without_decision` exists because a
// terminal Run is NOT a completed item: completion is owned by the Tranche 3
// decision, and inferring it from status would let unverified work be read.
const SIBLING_COMPLETION_STATES = Object.freeze([
  'incomplete',
  'terminal_without_decision',
  'decision_absent',
  'unresolved'
]);

const BLOCK_FIELDS = Object.freeze([
  'version',
  'ticketId',
  'runId',
  'allocationPlanId',
  'allocationItemId',
  'progressPolicyHash',
  'cutoff',
  'verifiedProgressProjectionHash',
  'churnDecisionHash',
  'decision',
  'reason',
  'cumulativeResources',
  'consecutiveNoProgressWindows',
  'repeatedOperationSignals',
  'failedOperationStreak',
  'mutationReversalSignals',
  'executionEpochAt',
  // Null for a churn block; required for a sibling-dependency block.
  'siblingDependency',
  'blockedAt',
  'blockHash'
]);

const BLOCK_REFUSALS = Object.freeze([
  'progress_block_malformed',
  'progress_block_partial',
  'progress_block_cutoff_invalid',
  'progress_block_reason_invalid',
  'progress_block_conflict'
]);

class GovernedProgressBlockError extends Error {
  constructor(code, message, detail = {}) {
    super(message);
    this.name = 'GovernedProgressBlockError';
    this.code = code;
    this.detail = detail;
  }
}

function fail(message, code = 'GOVERNED_PROGRESS_BLOCK_INVALID', detail = {}) {
  throw new GovernedProgressBlockError(code, message, detail);
}

function refuse(reason, message = null) {
  if (!BLOCK_REFUSALS.includes(reason)) {
    fail(`Unsupported progress block refusal: ${String(reason)}`);
  }
  fail(message || reason, 'GOVERNED_PROGRESS_BLOCK_REFUSED', { reason });
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hash(value, label) {
  if (typeof value !== 'string' || !HASH_PATTERN.test(value)) {
    refuse('progress_block_malformed', `${label} must be a lowercase SHA-256`);
  }
  return value;
}

function nonNegativeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    refuse('progress_block_malformed', `${label} must be a non-negative safe integer`);
  }
  return value;
}

// The cutoff is closed and complete. A partial cutoff would let a later
// evaluation silently widen the window the block was decided under.
function normalizeCutoff(cutoff) {
  if (!isPlainObject(cutoff)) {
    refuse('progress_block_cutoff_invalid', 'the block cutoff must be an object');
  }
  const unknown = Object.keys(cutoff).filter(field => !CUTOFF_FIELDS.includes(field));
  if (unknown.length > 0) {
    refuse('progress_block_cutoff_invalid',
      `cutoff contains unknown field(s): ${unknown.sort(compareCanonicalText).join(', ')}`);
  }
  const missing = CUTOFF_FIELDS.filter(
    field => !Object.prototype.hasOwnProperty.call(cutoff, field));
  if (missing.length > 0) {
    refuse('progress_block_cutoff_invalid',
      `cutoff is missing field(s): ${missing.join(', ')}`);
  }
  const normalized = {};
  for (const field of CUTOFF_ORDINAL_FIELDS) {
    normalized[field] = nonNegativeInteger(cutoff[field], `cutoff.${field}`);
  }
  if (typeof cutoff.evaluatedAt !== 'string' || cutoff.evaluatedAt.length === 0) {
    refuse('progress_block_cutoff_invalid',
      'cutoff.evaluatedAt must be an ISO-8601 string captured from the database');
  }
  const evaluated = Date.parse(cutoff.evaluatedAt);
  if (!Number.isFinite(evaluated)) {
    refuse('progress_block_cutoff_invalid',
      'cutoff.evaluatedAt is not a parseable instant');
  }
  normalized.evaluatedAt = new Date(evaluated).toISOString();
  return deepFreeze(normalized);
}

function normalizeSiblingDependency(value) {
  if (value === null || value === undefined) return null;
  if (!isPlainObject(value)) {
    refuse('progress_block_malformed', 'siblingDependency must be an object or null');
  }
  const unknown = Object.keys(value).filter(
    field => !SIBLING_DEPENDENCY_FIELDS.includes(field));
  if (unknown.length > 0) {
    refuse('progress_block_malformed',
      `siblingDependency contains unknown field(s): ` +
      `${unknown.sort(compareCanonicalText).join(', ')}`);
  }
  const missing = SIBLING_DEPENDENCY_FIELDS.filter(
    field => !Object.prototype.hasOwnProperty.call(value, field));
  if (missing.length > 0) {
    refuse('progress_block_partial',
      `siblingDependency is missing field(s): ${missing.join(', ')}`);
  }
  if (!SIBLING_COMPLETION_STATES.includes(value.siblingCompletionState)) {
    refuse('progress_block_malformed',
      `unrecognized sibling completion state: ${String(value.siblingCompletionState)}`);
  }
  // A blocked sibling read must NOT carry a completion decision hash: if the
  // sibling were verifiably complete the read would have been permitted.
  if (value.siblingCompletionDecisionHash !== null) {
    refuse('progress_block_conflict',
      'a blocked sibling read cannot cite a completion decision');
  }
  return deepFreeze({
    requestedPath: String(value.requestedPath),
    siblingAllocationItemId: nonNegativeInteger(
      value.siblingAllocationItemId, 'siblingAllocationItemId'),
    siblingRunId: value.siblingRunId === null
      ? null
      : nonNegativeInteger(value.siblingRunId, 'siblingRunId'),
    siblingOwnedScope: String(value.siblingOwnedScope),
    siblingCompletionDecisionHash: null,
    siblingCompletionState: value.siblingCompletionState
  });
}

function hashBlock(fields) {
  const payload = {};
  for (const field of BLOCK_FIELDS) {
    if (field === 'blockHash') continue;
    payload[field] = fields[field];
  }
  return hashCanonical(payload);
}

// ── Build ───────────────────────────────────────────────────────────────────

function buildGovernedProgressBlock({
  ticketId,
  runId,
  allocationPlanId,
  allocationItemId,
  progressPolicyHash,
  cutoff,
  verifiedProgressProjectionHash,
  churnDecision,
  executionEpochAt,
  siblingDependency = null,
  blockedAt
}) {
  if (!isPlainObject(churnDecision)) {
    refuse('progress_block_malformed', 'a block requires its churn decision');
  }
  if (churnDecision.decision !== 'blocked') {
    // A block that does not carry a blocked decision is not a block. This is
    // what stops a caller supplying only a reason string.
    refuse('progress_block_reason_invalid',
      'a progress block requires a churn decision of `blocked`');
  }
  if (!CHURN_STOP_REASONS.includes(churnDecision.reason)) {
    refuse('progress_block_reason_invalid',
      `unrecognized stop reason: ${String(churnDecision.reason)}`);
  }
  const sibling = normalizeSiblingDependency(siblingDependency);
  if (churnDecision.reason === 'undeclared_sibling_dependency' && sibling === null) {
    refuse('progress_block_partial',
      'a sibling-dependency block must record which sibling and path caused it');
  }
  if (churnDecision.reason !== 'undeclared_sibling_dependency' && sibling !== null) {
    refuse('progress_block_conflict',
      'only a sibling-dependency block may carry sibling details');
  }

  const fields = {
    version: GOVERNED_PROGRESS_BLOCK_VERSION,
    ticketId: nonNegativeInteger(ticketId, 'ticketId'),
    runId: nonNegativeInteger(runId, 'runId'),
    allocationPlanId: allocationPlanId === null
      ? null
      : nonNegativeInteger(allocationPlanId, 'allocationPlanId'),
    allocationItemId: allocationItemId === null
      ? null
      : nonNegativeInteger(allocationItemId, 'allocationItemId'),
    progressPolicyHash: hash(progressPolicyHash, 'progressPolicyHash'),
    cutoff: normalizeCutoff(cutoff),
    verifiedProgressProjectionHash: hash(
      verifiedProgressProjectionHash, 'verifiedProgressProjectionHash'),
    churnDecisionHash: hash(churnDecision.decisionHash, 'churnDecisionHash'),
    decision: 'blocked',
    reason: churnDecision.reason,
    cumulativeResources: deepFreeze({ ...churnDecision.cumulativeResources }),
    consecutiveNoProgressWindows: nonNegativeInteger(
      churnDecision.consecutiveNoProgressWindows, 'consecutiveNoProgressWindows'),
    repeatedOperationSignals: nonNegativeInteger(
      churnDecision.repeatedOperationSignals, 'repeatedOperationSignals'),
    failedOperationStreak: nonNegativeInteger(
      churnDecision.failedOperationStreak, 'failedOperationStreak'),
    mutationReversalSignals: nonNegativeInteger(
      churnDecision.mutationReversalSignals, 'mutationReversalSignals'),
    // Null while a Run is queued; a Run cannot be blocked for churn before it
    // has executed, but a sibling-read block can occur on the first step.
    executionEpochAt: executionEpochAt === null || executionEpochAt === undefined
      ? null
      : String(executionEpochAt),
    siblingDependency: sibling,
    blockedAt: String(blockedAt),
    blockHash: null
  };
  fields.blockHash = hashBlock(fields);
  return deepFreeze(fields);
}

function normalizeGovernedProgressBlock(value) {
  if (!isPlainObject(value)) {
    refuse('progress_block_malformed', 'progress block must be an object');
  }
  const unknown = Object.keys(value).filter(field => !BLOCK_FIELDS.includes(field));
  if (unknown.length > 0) {
    refuse('progress_block_malformed',
      `block contains unknown field(s): ${unknown.sort(compareCanonicalText).join(', ')}`);
  }
  const missing = BLOCK_FIELDS.filter(
    field => !Object.prototype.hasOwnProperty.call(value, field));
  if (missing.length > 0) {
    refuse('progress_block_partial', `block is missing field(s): ${missing.join(', ')}`);
  }
  if (value.version !== GOVERNED_PROGRESS_BLOCK_VERSION) {
    refuse('progress_block_malformed',
      `unsupported block version: ${String(value.version)}`);
  }
  if (value.decision !== 'blocked') {
    refuse('progress_block_reason_invalid', 'a stored block is always `blocked`');
  }
  if (!CHURN_STOP_REASONS.includes(value.reason)) {
    refuse('progress_block_reason_invalid', `unrecognized stop reason: ${String(value.reason)}`);
  }
  normalizeCutoff(value.cutoff);
  normalizeSiblingDependency(value.siblingDependency);

  if (value.blockHash !== hashBlock(value)) {
    refuse('progress_block_malformed', 'the block hash does not cover its own fields');
  }
  const normalized = {};
  for (const field of BLOCK_FIELDS) normalized[field] = value[field];
  return deepFreeze(normalized);
}

// Two blocks over identical authority are the same historical fact. Anything
// else is a conflict and must refuse rather than overwrite: the first decision
// is what actually stopped the Run.
function assertBlockAuthorityMatches(stored, candidate) {
  const left = normalizeGovernedProgressBlock(stored);
  const right = normalizeGovernedProgressBlock(candidate);
  for (const field of ['reason', 'verifiedProgressProjectionHash', 'churnDecisionHash',
    'progressPolicyHash']) {
    if (left[field] !== right[field]) {
      refuse('progress_block_conflict',
        `run ${left.runId} is already blocked with a different ${field}`);
    }
  }
  for (const field of CUTOFF_FIELDS) {
    if (left.cutoff[field] !== right.cutoff[field]) {
      refuse('progress_block_conflict',
        `run ${left.runId} is already blocked under a different ${field}`);
    }
  }
  return left;
}

module.exports = {
  BLOCK_FIELDS,
  BLOCK_REFUSALS,
  CUTOFF_FIELDS,
  GOVERNED_PROGRESS_BLOCK_VERSION,
  GovernedProgressBlockError,
  SIBLING_COMPLETION_STATES,
  SIBLING_DEPENDENCY_FIELDS,
  assertBlockAuthorityMatches,
  buildGovernedProgressBlock,
  normalizeCutoff,
  normalizeGovernedProgressBlock,
  refuseProgressBlock: refuse
};

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
  'undeclared_sibling_dependency',
  // A HARD TOTAL bound on execution duration, measured from the immutable
  // first-execution epoch. Distinct from every reason above: those describe a
  // pattern in the work, this describes how long the Run has been executing in
  // total across every recovery. It is named separately so a duration stop can
  // never be read as a no-op loop, a provider timeout, an interruption, or
  // spent progress tolerance.
  'cumulative_execution_duration_exhausted'
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
  // The HARD total execution bound, in milliseconds, measured from the
  // immutable first-execution epoch to a database-captured evaluation instant.
  // It is a policy field rather than a `resourceDimensions` entry because it is
  // not a tolerance that verified progress can extend — see `decideChurn`.
  'maximumCumulativeExecutionDurationMs',
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
  // The database-captured evaluation instant and the total execution duration
  // derived from it. Both are hashed, so a decision states exactly when it was
  // taken and how much execution time it was taken against.
  'evaluatedAt',
  'cumulativeExecutionDurationMs',
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

// A duration tolerance in milliseconds. Same philosophy as `boundedTolerance`
// — null, 0 and Infinity are refused because an unbounded duration is the
// absence of a bound — but with a ceiling appropriate to time rather than to
// counts. Seven days is far above any legitimate governed leaf Run and far
// below "effectively forever", so a policy that names it is still making a
// claim someone could be held to.
const MAXIMUM_EXECUTION_DURATION_CEILING_MS = 604_800_000; // 7 days

function boundedDurationMs(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    refuse('churn_tolerance_unbounded',
      `${label} must be a finite number of milliseconds`);
  }
  if (!Number.isSafeInteger(value) || value < 1) {
    refuse('churn_tolerance_unbounded',
      `${label} must be a positive safe integer number of milliseconds`);
  }
  if (value > MAXIMUM_EXECUTION_DURATION_CEILING_MS) {
    refuse('churn_tolerance_unbounded',
      `${label} exceeds the ${MAXIMUM_EXECUTION_DURATION_CEILING_MS}ms ceiling ` +
      'and is effectively unbounded');
  }
  return value;
}

// An ISO instant, normalized. Rejects anything that is not a real timestamp,
// so a malformed durable value can never be silently coerced to 0 or NaN.
function isoInstant(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    refuse('churn_decision_malformed', `${label} must be an ISO-8601 string`);
  }
  const time = Date.parse(value);
  if (!Number.isFinite(time)) {
    refuse('churn_decision_malformed', `${label} is not a parseable instant`);
  }
  return new Date(time).toISOString();
}

// THE ONLY elapsed-duration derivation in the system, so there is exactly one
// place where "how long has this Run executed" is answered.
//
// Absence of an epoch is MEANINGFUL, not an error: a Run that has never been
// leased has not begun executing, so its cumulative execution duration is zero.
// Scheduler queue time is therefore never charged as execution — the epoch is
// the first `run.lease_acquired`, and no such event exists while queued.
function elapsedExecutionDurationMs({ executionEpochAt, evaluatedAt }) {
  if (executionEpochAt === null || executionEpochAt === undefined) return 0;
  const epoch = Date.parse(isoInstant(executionEpochAt, 'executionEpochAt'));
  const evaluated = Date.parse(isoInstant(evaluatedAt, 'evaluatedAt'));
  const elapsed = evaluated - epoch;
  if (!Number.isSafeInteger(elapsed)) {
    refuse('churn_accounting_conflict',
      'elapsed execution duration is not a safe integer number of milliseconds');
  }
  if (elapsed < 0) {
    // The evaluation instant precedes first execution. Both come from the same
    // database clock, so this is corruption, not skew — and a negative duration
    // would silently buy back budget.
    refuse('churn_accounting_conflict',
      'evaluation instant precedes the execution epoch');
  }
  return elapsed;
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
  maximumCumulativeExecutionDurationMs,
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
    // Required, never defaulted. A governed Run admitted without duration
    // authority would otherwise be admitted as unbounded in time, which is the
    // exact condition pending decision A3 records.
    maximumCumulativeExecutionDurationMs: boundedDurationMs(
      maximumCumulativeExecutionDurationMs, 'maximumCumulativeExecutionDurationMs'),
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

// ── The repository-owned version-1 progress-control policy ──────────────────
//
// WHY THIS EXISTS. Governed structured leaf admission requires a captured
// progress-control policy, and until this builder there was no production
// source for one: only test fixtures ever constructed it, so leaf admission
// could never succeed outside a test. Every governed structured Ticket was
// blocked, and the refusal was mislabelled as a concurrency conflict.
//
// WHAT KIND OF AUTHORITY THIS IS. Progress control is RUNTIME EXECUTION POLICY.
// It is not model output, not objective interpretation, not completion
// authority, not provider routing and not economic policy. It decides when
// execution stops making progress — a different question from who may be called
// or what may be spent — which is why it does not live in the governed
// policy-source container alongside those.
//
// THE VALUES ARE A STATED PRODUCT DECISION, NOT A DEFAULT. A default is an
// unstated value silently substituted. These are declared here, versioned,
// hashed, and captured immutably onto every governed Run, so a Run's stop
// reason stays explainable from the authority it actually ran under. Changing
// any of them requires an explicit PROGRESS_POLICY_VERSION bump; historical
// Runs keep the version they captured and are never rewritten.
//
// Approved 2026-08-06. See docs/STRUCTURED_LEAF_PROGRESS_POLICY_AUTHORITY_DECISION.md.
const VERSION_1_PROGRESS_TOLERANCES = Object.freeze({
  // Three answered windows crediting no newly satisfied declared fact.
  maximumConsecutiveNoProgressWindows: 3,
  // Tolerates a retry and a correction; the third identical mutation is churn.
  maximumRepeatedMutations: 3,
  // One above the mutation tolerance: operation failures are often transient.
  maximumFailedOperationStreak: 4,
  // Write/undo oscillation past three is not progress.
  maximumMutationReversals: 3,
  // Reading is legitimate work; four consecutive read-only windows is not.
  maximumInspectionOnlyStreak: 4
});

// The dimensions the projection reports. Repository-owned, from the closed
// vocabulary above — not a deployment choice.
const VERSION_1_RESOURCE_DIMENSIONS = Object.freeze([
  'provider_requests',
  'settled_micro_usd'
]);

// The runtime-budget snapshot fields this builder reads. Named so that a
// snapshot missing its immutable identity cannot silently produce a policy that
// claims to be bound to one.
const REQUIRED_BUDGET_SNAPSHOT_FIELDS = Object.freeze([
  'maxRuntimeDurationMs',
  'snapshotHash'
]);

// Build the canonical version-1 policy for one governed structured leaf plan.
//
// DURATION IS DERIVED, NEVER DECLARED HERE. `maximumCumulativeExecutionDurationMs`
// comes only from the already-captured, already-hashed
// `runtimeBudgetSnapshot.maxRuntimeDurationMs`. Restating it as a constant would
// create a second duration authority that could silently disagree with the
// budget the Run was actually admitted under.
//
// It reads no environment variable and no current mutable configuration: every
// input is either declared above or carried on the immutable snapshot passed in.
function buildDefaultProgressControlPolicy({ runtimeBudgetSnapshot } = {}) {
  if (!isPlainObject(runtimeBudgetSnapshot)) {
    refuse('progress_policy_malformed',
      'a captured runtime budget snapshot is required to derive progress control');
  }
  const missing = REQUIRED_BUDGET_SNAPSHOT_FIELDS.filter(field =>
    runtimeBudgetSnapshot[field] === undefined || runtimeBudgetSnapshot[field] === null);
  if (missing.length > 0) {
    refuse('progress_policy_malformed',
      `runtime budget snapshot is missing field(s): ${missing.join(', ')}`);
  }
  if (typeof runtimeBudgetSnapshot.snapshotHash !== 'string' ||
      !/^[0-9a-f]{64}$/.test(runtimeBudgetSnapshot.snapshotHash)) {
    refuse('progress_policy_malformed',
      'runtime budget snapshot carries no usable immutable identity');
  }
  return buildProgressControlPolicy({
    ...VERSION_1_PROGRESS_TOLERANCES,
    maximumCumulativeExecutionDurationMs: runtimeBudgetSnapshot.maxRuntimeDurationMs,
    resourceDimensions: [...VERSION_1_RESOURCE_DIMENSIONS]
  });
}

// Two leaf drafts of one plan must agree on every input this policy derives
// from, or one plan-scoped capture would misrepresent at least one of them.
//
// The inputs are Ticket-scoped by construction — `buildRuntimeBudgetSnapshot`
// takes only the Ticket's resolved runtime limits and its execution policy, and
// neither the assigned agent nor the allocation item participates. But the
// limits are re-resolved per draft against current configuration, so a change
// landing mid-admission could still produce disagreeing drafts. This proves
// equality rather than assuming it, and refuses before anything is admitted.
function assertUniformProgressPolicyInputs(snapshots) {
  if (!Array.isArray(snapshots) || snapshots.length === 0) {
    refuse('progress_policy_malformed',
      'at least one runtime budget snapshot is required');
  }
  const identities = snapshots.map(snapshot => {
    if (!isPlainObject(snapshot)) {
      refuse('progress_policy_malformed',
        'every leaf draft must carry a runtime budget snapshot');
    }
    return JSON.stringify({
      snapshotHash: snapshot.snapshotHash,
      executionPolicyHash: snapshot.executionPolicyHash,
      runtimeLimitsRevision: snapshot.runtimeLimitsRevision,
      maxRuntimeDurationMs: snapshot.maxRuntimeDurationMs
    });
  });
  const distinct = new Set(identities);
  if (distinct.size !== 1) {
    refuse('progress_policy_malformed',
      `leaf drafts disagree on the execution authority a plan-scoped progress ` +
      `policy would be derived from (${distinct.size} distinct snapshots)`);
  }
  return snapshots[0];
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
  evaluatedAt,
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
      cumulativeResources.budgetChargedUnits || 0, 'cumulative budgetChargedUnits'),
    // CUMULATIVE across every recovery, because it is derived from the
    // immutable first-execution epoch rather than from the latest attempt.
    cumulativeExecutionDurationMs: nonNegativeInteger(
      cumulativeResources.cumulativeExecutionDurationMs || 0,
      'cumulative cumulativeExecutionDurationMs')
  };
  const evaluatedInstant = isoInstant(evaluatedAt, 'evaluatedAt');
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
  } else if (resources.cumulativeExecutionDurationMs >=
             controls.maximumCumulativeExecutionDurationMs) {
    // THE HARD TOTAL BOUND, and the one rule verified progress cannot move.
    //
    // It is evaluated before every churn signal deliberately. A Run that has
    // exhausted its total execution time may well ALSO be looping on no-ops,
    // and reporting `repeated_no_op` for it would name a pattern instead of the
    // bound that actually stopped it — inviting someone to "fix the loop" and
    // retry into the same wall. Duration exhaustion is its own fact.
    //
    // Note what is absent: no reset. `consecutiveNoProgressWindows` is reset by
    // verified progress a few lines below, because tolerance for churn is
    // exactly what progress should buy back. Total execution time is not
    // tolerance — it is consumption — so nothing buys it back.
    decision = 'blocked';
    reason = 'cumulative_execution_duration_exhausted';
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
    evaluatedAt: evaluatedInstant,
    cumulativeExecutionDurationMs: resources.cumulativeExecutionDurationMs,
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
  MAXIMUM_EXECUTION_DURATION_CEILING_MS,
  PROGRESS_POLICY_FIELDS,
  PROGRESS_POLICY_VERSION,
  RESOURCE_DIMENSIONS,
  buildProgressControlPolicy,
  buildDefaultProgressControlPolicy,
  assertUniformProgressPolicyInputs,
  VERSION_1_PROGRESS_TOLERANCES,
  VERSION_1_RESOURCE_DIMENSIONS,
  decideChurn,
  elapsedExecutionDurationMs,
  normalizeChurnDecision,
  normalizeProgressControlPolicy,
  permitsGovernedRequest,
  refuseChurn: refuse
};

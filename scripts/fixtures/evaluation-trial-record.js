'use strict';

// Tranche 6 — the comparison envelope and the Ticket-scoped trial record.
//
// TWO JOBS, both about preventing a dishonest comparison rather than producing
// a number.
//
// 1. THE COMPARISON ENVELOPE freezes every controlled variable BEFORE a trial
//    runs. Two trials may be compared only when their envelopes agree on every
//    controlled value. A comparison across different models, limits, initial
//    workspace states or fixture responses is refused rather than reported with
//    a caveat, because a caveat does not stop the number being quoted.
//
// 2. THE TRIAL RECORD is Ticket-scoped, never Run-scoped. Arm A produces one
//    Run; the legacy and structured arms produce one per agent or per plan
//    item. Averaging per Run would divide the structured arms' totals by their
//    own parallelism and make them look cheaper and faster for exactly the
//    reason they are more complex. Every metric here is per Ticket, and the Run
//    count is recorded so it can never be mistaken for a denominator.
//
// Every field states its source: `durable` (read from a production record),
// `derived` (computed here from durable inputs, labelled as such), or
// `independent` (raw state observed outside product authority).

const crypto = require('node:crypto');

class EvaluationRecordError extends Error {
  constructor(message, detail = {}) {
    super(message);
    this.name = 'EvaluationRecordError';
    this.detail = detail;
  }
}

// Controlled variables that MUST match for two trials to be comparable. Taken
// from the protocol's §3 list. A value absent from an envelope is a refusal,
// not a default — a silently defaulted control is an uncontrolled variable.
const CONTROLLED_FIELDS = Object.freeze([
  'objective',
  'declaredWorkHash',
  'expectationHash',
  'initialWorkspaceHash',
  'postconditionHash',
  'provider',
  'model',
  'maxOutputTokens',
  'contextWindowTokens',
  'runtimeLimitsHash',
  'economicCeilingMicroUsd',
  'retryPolicyHash',
  'allowParallelRuns',
  'toolCatalogHash',
  'scenarioSeed',
  'fixtureResponseHash',
  'verificationPolicy'
]);

// Differences that are architectural consequences of the arms themselves. They
// are recorded on every envelope so that a reader sees them without having to
// know the architecture, and so that they are never mistaken for uncontrolled
// experimental sloppiness.
const UNAVOIDABLE_DIFFERENCES = Object.freeze([
  'arm A executes one Run; legacy and structured arms execute many',
  'planner model requests occur only in the structured arms',
  'governed economics and verified-progress control exist only in the structured arms',
  'monetary cost is durably settled only in the structured arms; every arm is ' +
    'additionally scored with one normalized derived method',
  'workspace scope is shared for arm A and owned_paths for the other arms'
]);

function buildComparisonEnvelope(values) {
  if (!values || typeof values !== 'object') {
    throw new EvaluationRecordError('envelope values are required');
  }
  const envelope = {};
  for (const field of CONTROLLED_FIELDS) {
    if (values[field] === undefined || values[field] === null) {
      throw new EvaluationRecordError(
        `controlled field ${field} is missing — an unstated control is an ` +
        'uncontrolled variable');
    }
    envelope[field] = values[field];
  }
  envelope.unavoidableDifferences = UNAVOIDABLE_DIFFERENCES;
  envelope.envelopeHash = crypto.createHash('sha256')
    .update(JSON.stringify(
      CONTROLLED_FIELDS.reduce((acc, f) => ({ ...acc, [f]: envelope[f] }), {})))
    .digest('hex');
  return Object.freeze(envelope);
}

// Refuse a cross-arm comparison whose envelopes disagree on any controlled
// value. Reports the exact fields that differ, so the fix is obvious and the
// comparison cannot simply be re-run until it passes.
function assertComparable(envelopes) {
  if (!Array.isArray(envelopes) || envelopes.length < 2) {
    throw new EvaluationRecordError('at least two envelopes are required to compare');
  }
  const [first, ...rest] = envelopes;
  const differing = [];
  for (const other of rest) {
    for (const field of CONTROLLED_FIELDS) {
      if (JSON.stringify(first[field]) !== JSON.stringify(other[field])) {
        if (!differing.includes(field)) differing.push(field);
      }
    }
  }
  if (differing.length > 0) {
    throw new EvaluationRecordError(
      `refusing to compare trials whose controlled variables differ: ${differing.join(', ')}`,
      { differing });
  }
  return true;
}

// Fixture and live results answer different questions and may never be pooled.
const EXECUTION_MODES = Object.freeze(['deterministic_fixture', 'live_model']);

function assertSingleExecutionMode(records) {
  const modes = new Set(records.map(record => record.executionMode));
  if (modes.size > 1) {
    throw new EvaluationRecordError(
      'refusing to combine deterministic-fixture and live-model results in one score',
      { modes: [...modes] });
  }
  return true;
}

// A trial that failed is DATA. It may be excluded only by a rule declared
// before the evaluation ran, and only for infrastructure reasons — never
// because the product performed badly.
const INFRASTRUCTURE_EXCLUSIONS = Object.freeze([
  'database_unavailable',
  'harness_process_crash',
  'fixture_transport_unavailable',
  'workspace_setup_failed'
]);

function classifyTrialInclusion({ completedTrial, failureReason = null }) {
  if (completedTrial) return { included: true, exclusionReason: null };
  if (failureReason && INFRASTRUCTURE_EXCLUSIONS.includes(failureReason)) {
    return { included: false, exclusionReason: failureReason };
  }
  // A product failure stays in the data set. This is the rule that stops a
  // disappointing arm being quietly cleaned up.
  return { included: true, exclusionReason: null };
}

// THE TICKET-SCOPED TRIAL RECORD.
//
// One record per Ticket per trial. Field groups follow the protocol's §6 list.
function buildTrialRecord(input) {
  const required = [
    'trialId', 'scenarioId', 'scenarioVersion', 'armId', 'repetition',
    'executionMode', 'envelope', 'ticketId'
  ];
  for (const field of required) {
    if (input[field] === undefined || input[field] === null) {
      throw new EvaluationRecordError(`trial record field ${field} is required`);
    }
  }
  if (!EXECUTION_MODES.includes(input.executionMode)) {
    throw new EvaluationRecordError(`unsupported executionMode: ${input.executionMode}`);
  }

  const record = {
    // Identity
    trialId: input.trialId,
    scenarioId: input.scenarioId,
    scenarioVersion: input.scenarioVersion,
    armId: input.armId,
    repetition: input.repetition,
    seed: input.seed === undefined ? null : input.seed,
    executionMode: input.executionMode,

    // Comparability
    envelopeHash: input.envelope.envelopeHash,
    initialWorkspaceHash: input.envelope.initialWorkspaceHash,
    unavoidableDifferences: input.envelope.unavoidableDifferences,

    // Product identities — all durable
    ticketId: input.ticketId,
    allocationPlanId: input.allocationPlanId === undefined ? null : input.allocationPlanId,
    allocationItemIds: Object.freeze([...(input.allocationItemIds || [])]),
    runIds: Object.freeze([...(input.runIds || [])]),
    runCount: (input.runIds || []).length,

    // Configuration actually in force
    provider: input.envelope.provider,
    model: input.envelope.model,
    observedProductionPath: input.observedProductionPath || null,

    // Allocation topology and ownership
    allocationTopology: input.allocationTopology || null,
    ownershipAssignments: Object.freeze([...(input.ownershipAssignments || [])]),

    // Requests, operations, receipts — durable
    plannerRequestCount: input.plannerRequestCount || 0,
    workerRequestCount: input.workerRequestCount || 0,
    operationReceiptCount: input.operationReceiptCount || 0,

    // Truthfulness — the independent oracle beside the product claim
    independentOracle: input.independentOracle || null,
    productClaimsCompleted: input.productClaimsCompleted === true,
    productCompletionAuthority: input.productCompletionAuthority || null,
    truthfulnessClass: input.truthfulnessClass || null,

    // Latency components — Ticket-scoped, database instants
    latency: Object.freeze({
      planningMs: nullableNumber(input.latency && input.latency.planningMs),
      timeToFirstExecutionMs: nullableNumber(input.latency && input.latency.timeToFirstExecutionMs),
      endToEndMs: nullableNumber(input.latency && input.latency.endToEndMs),
      recoveryMs: nullableNumber(input.latency && input.latency.recoveryMs),
      withheldMs: nullableNumber(input.latency && input.latency.withheldMs)
    }),

    // Cost — normalized for every arm, durable reported only where it exists
    cost: input.cost || null,

    // Churn — canonical evaluated windows only; null (not zero) where the arm
    // has no churn control at all, so "no churn control" cannot be read as
    // "no churn".
    churn: input.churn === undefined ? null : input.churn,

    // Recovery / retry
    retryCount: input.retryCount || 0,
    recoveryEvents: input.recoveryEvents || 0,

    // Terminal authority
    terminalRunStatuses: Object.freeze([...(input.terminalRunStatuses || [])]),
    terminalTicketStatus: input.terminalTicketStatus || null,

    // Inclusion and confounders
    inclusion: input.inclusion || { included: true, exclusionReason: null },
    confounders: Object.freeze([...(input.confounders || [])]),

    // Provenance of every value in this record
    sources: Object.freeze({
      identities: 'durable',
      requests: 'durable',
      receipts: 'durable',
      latency: 'durable',
      churn: 'durable',
      terminal: 'durable',
      cost: 'derived',
      durableGovernedCost: 'durable_where_available',
      oracle: 'independent'
    })
  };
  return Object.freeze(record);
}

function nullableNumber(value) {
  return Number.isFinite(value) ? value : null;
}

// Guard against the per-Run averaging mistake. Aggregation must divide by
// trials, never by Runs.
function aggregateTicketScoped(records, field) {
  if (!Array.isArray(records) || records.length === 0) {
    throw new EvaluationRecordError('records are required');
  }
  assertSingleExecutionMode(records);
  const included = records.filter(record => record.inclusion.included);
  const values = included.map(record => field(record)).filter(Number.isFinite);
  if (values.length === 0) return { mean: null, n: 0, denominator: 'trials' };
  return {
    mean: values.reduce((total, value) => total + value, 0) / values.length,
    n: values.length,
    // Named explicitly so a reader can see the denominator is trials, not Runs.
    denominator: 'trials'
  };
}

module.exports = {
  CONTROLLED_FIELDS,
  UNAVOIDABLE_DIFFERENCES,
  EXECUTION_MODES,
  INFRASTRUCTURE_EXCLUSIONS,
  EvaluationRecordError,
  buildComparisonEnvelope,
  assertComparable,
  assertSingleExecutionMode,
  classifyTrialInclusion,
  buildTrialRecord,
  aggregateTicketScoped
};

'use strict';

// Tranche 5 — verified progress, projected from durable evidence only.
//
// THE DISTINCTION THIS MODULE EXISTS TO MAKE. A run that is busy is not a run
// that is advancing. Four levels, and conflating any two of them is what let
// churn look like work:
//
//   activity           something durable happened (a request, a receipt, an
//                      inspection, a failure). Never extends tolerance.
//   candidate_progress something NEW happened — an unseen mutation
//                      fingerprint, a new artifact, newly obtained evidence.
//                      Novel, but not yet known to matter.
//   verified_progress  a previously UNSATISFIED declared-work fact is now
//                      satisfied. This is the only level that extends
//                      tolerance.
//   completion         owned exclusively by the completion-decision and
//                      aggregate-decision contracts. Tranche 5 never decides it.
//
// A successful operation that advances no declared fact is candidate progress
// at best. Writing a file nobody asked for is activity with a new fingerprint,
// not progress. Model prose claiming progress is not represented here at all:
// there is no field it could occupy.
//
// EVERYTHING IS RECONSTRUCTIBLE. Every input is an ordered durable row —
// operation receipts, budget charges, economic reservations, typed evidence.
// No process-local counter is authority, because a counter that resets on
// recovery is a counter a model can evade by crashing, which is exactly the
// defect pending decision A3 records.

const {
  compareCanonicalText,
  deepFreeze,
  hashCanonical
} = require('./declared-work-contract');

const VERIFIED_PROGRESS_VERSION = 1;

// The four levels, ordered. `completion` appears so the vocabulary is complete
// and so nothing here can be mistaken for owning it.
const PROGRESS_LEVELS = Object.freeze([
  'activity',
  'candidate_progress',
  'verified_progress',
  'completion'
]);

// Closed no-progress signals. Each names one durable pattern; none is inferred
// from prose or from a model's self-report.
const NO_PROGRESS_SIGNALS = Object.freeze([
  'repeated_no_op',
  'repeated_failed_operation',
  'mutation_reversal_churn',
  'inspection_only_streak',
  'resource_growth_without_progress'
]);

// The declared-work facts a durable observation may newly satisfy. These are
// the ONLY things that turn candidate progress into verified progress.
const DECLARED_FACT_KINDS = Object.freeze([
  'expected_output',
  'success_criterion',
  'evidence_requirement',
  'typed_postcondition',
  'declared_artifact'
]);

// Operations that read without changing anything. An inspection-only window is
// a signal, not progress.
const INSPECTION_OPERATIONS = Object.freeze(['listDirectory', 'readFile']);

const PROGRESS_REFUSALS = Object.freeze([
  'progress_observation_malformed',
  'progress_window_identity_missing',
  'progress_declared_authority_missing',
  'progress_accounting_conflict'
]);

const PROJECTION_FIELDS = Object.freeze([
  'version',
  'ticketId',
  'runId',
  'allocationPlanId',
  'allocationItemId',
  'declaredWorkHash',
  // The durable identity of the observation window. Never a process sequence.
  'windowIdentity',
  'windowKind',
  // Durable resource facts consumed inside the window.
  'resources',
  // Novel-but-unproven facts.
  'candidateFacts',
  // Declared-work facts newly satisfied. The only progress that counts.
  'verifiedFacts',
  'verifiedProgressCount',
  'noProgressSignals',
  // The exact ordered cutoff this projection was built from, so two processes
  // reading the same rows produce the same hash.
  'sourceCutoff',
  // The database-captured instant this projection was evaluated at. Hashed, so
  // two projections built from the same rows at different times are visibly
  // different facts rather than silently interchangeable ones.
  'evaluatedAt',
  'projectionHash'
]);

const WINDOW_KINDS = Object.freeze(['provider_request', 'operation_sequence']);

class VerifiedProgressError extends Error {
  constructor(code, message, detail = {}) {
    super(message);
    this.name = 'VerifiedProgressError';
    this.code = code;
    this.detail = detail;
  }
}

function fail(message, code = 'VERIFIED_PROGRESS_INVALID', detail = {}) {
  throw new VerifiedProgressError(code, message, detail);
}

function refuse(reason, message = null) {
  if (!PROGRESS_REFUSALS.includes(reason)) {
    fail(`Unsupported verified-progress refusal: ${String(reason)}`);
  }
  fail(message || reason, 'VERIFIED_PROGRESS_REFUSED', { reason });
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function requiredText(value, label, maximum = 512) {
  if (typeof value !== 'string') {
    refuse('progress_observation_malformed', `${label} must be a string`);
  }
  const text = value.trim();
  if (!text) refuse('progress_observation_malformed', `${label} must not be empty`);
  if (text.length > maximum) {
    refuse('progress_observation_malformed', `${label} exceeds ${maximum} characters`);
  }
  return text;
}

// A normalized ISO instant. Refuses anything unparseable rather than coercing
// it, so a malformed durable timestamp cannot become NaN inside an arithmetic.
function requiredInstant(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    refuse('progress_observation_malformed', `${label} must be an ISO-8601 string`);
  }
  const time = Date.parse(value);
  if (!Number.isFinite(time)) {
    refuse('progress_observation_malformed', `${label} is not a parseable instant`);
  }
  return new Date(time).toISOString();
}

function nonNegativeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    refuse('progress_observation_malformed',
      `${label} must be a non-negative safe integer`);
  }
  return value;
}

// ── Declared-work fact inventory ────────────────────────────────────────────
//
// The set of facts a Run is obliged to satisfy, derived from its admitted
// declared-work snapshot. Progress is measured against THIS, never against
// what the model says it intended.

function inventoryDeclaredFacts(declaredWorkSnapshot) {
  if (!isPlainObject(declaredWorkSnapshot)) {
    refuse('progress_declared_authority_missing',
      'verified progress requires an admitted declared-work snapshot');
  }
  const facts = [];
  const push = (kind, identity, declaration) => {
    facts.push(deepFreeze({ kind, identity, declaration: declaration || null }));
  };

  for (const output of declaredWorkSnapshot.expectedOutputs || []) {
    // Identity is the canonical hash of the declaration itself, so the same
    // requirement always has the same identity across restarts.
    push('expected_output', hashCanonical(output), output.declaration || null);
  }
  for (const criterion of declaredWorkSnapshot.successCriteria || []) {
    if (criterion.kind === 'typed-postcondition') {
      push('typed_postcondition', criterion.criterionHash, criterion.declaration || null);
    } else {
      push('success_criterion', hashCanonical(criterion), criterion.declaration || null);
    }
  }
  for (const requirement of declaredWorkSnapshot.evidenceRequirements || []) {
    push('evidence_requirement', hashCanonical(requirement), requirement.evidenceType || null);
  }
  if (facts.length === 0) {
    // A Run with no declared facts can never show verified progress. That is a
    // truthful and important outcome, not an error: it means the authority the
    // Run executes under obliges nothing measurable.
    return deepFreeze([]);
  }
  return deepFreeze(facts);
}

// ── Observation classification ──────────────────────────────────────────────
//
// One durable observation in, one level out. Deliberately total: every
// observation is classified, and the default is `activity` rather than a guess.

function classifyObservation(observation, {
  declaredFacts = [],
  previouslySatisfiedFactIdentities = [],
  previouslySeenFingerprints = []
} = {}) {
  if (!isPlainObject(observation)) {
    refuse('progress_observation_malformed', 'observation must be an object');
  }
  const outcome = observation.outcome || null;
  const operation = observation.operation || null;

  // A failed or refused operation is activity. It may be informative; it is
  // never advancement.
  if (outcome === 'failed' || outcome === 'refused') {
    return deepFreeze({ level: 'activity', reason: `operation ${outcome}`, satisfies: [] });
  }
  if (INSPECTION_OPERATIONS.includes(operation)) {
    return deepFreeze({ level: 'activity', reason: 'inspection', satisfies: [] });
  }

  // Which declared facts does this observation newly satisfy? The caller
  // supplies the mapping through `satisfiesDeclaredFactIdentities`, which must
  // itself be derived from durable evidence (a typed postcondition result, an
  // artifact matching a declared output, and so on).
  const claimed = Array.isArray(observation.satisfiesDeclaredFactIdentities)
    ? observation.satisfiesDeclaredFactIdentities
    : [];
  const declaredIdentities = new Set(declaredFacts.map(fact => fact.identity));
  const alreadySatisfied = new Set(previouslySatisfiedFactIdentities);
  const newlySatisfied = claimed.filter(identity =>
    declaredIdentities.has(identity) && !alreadySatisfied.has(identity));

  if (newlySatisfied.length > 0) {
    return deepFreeze({
      level: 'verified_progress',
      reason: 'newly satisfied declared-work fact',
      satisfies: deepFreeze([...newlySatisfied].sort(compareCanonicalText))
    });
  }

  // Novel but unproven: a successful mutation whose fingerprint has not been
  // seen before. New, and possibly useful — but it advances nothing declared,
  // so it must not extend tolerance.
  const fingerprint = observation.mutationFingerprint || null;
  if (outcome === 'succeeded' && fingerprint &&
      !previouslySeenFingerprints.includes(fingerprint)) {
    return deepFreeze({
      level: 'candidate_progress',
      reason: 'novel successful mutation advancing no declared fact',
      satisfies: []
    });
  }

  return deepFreeze({ level: 'activity', reason: 'no new durable advancement', satisfies: [] });
}

// ── No-progress signals ─────────────────────────────────────────────────────

function detectNoProgressSignals({
  observations = [],
  verifiedCount = 0,
  resources = null,
  policy = null
}) {
  const signals = [];
  const seenFingerprints = new Map();
  const pathHistory = new Map();
  let failedStreak = 0;
  let inspectionStreak = 0;
  let repeatedMutations = 0;
  let reversals = 0;

  for (const observation of observations) {
    const outcome = observation.outcome || null;
    const operation = observation.operation || null;
    const path = observation.workspacePath || null;
    const fingerprint = observation.mutationFingerprint || null;

    if (outcome === 'failed' || outcome === 'refused') {
      failedStreak += 1;
    } else {
      failedStreak = 0;
    }
    inspectionStreak = INSPECTION_OPERATIONS.includes(operation)
      ? inspectionStreak + 1
      : 0;

    if (outcome === 'succeeded' && path && fingerprint) {
      const key = `${path} ${fingerprint}`;
      // The SAME content written to the SAME path again. Only churn when it
      // advanced nothing: a legitimate rewrite that satisfies a declared fact
      // is counted as progress above and never reaches here.
      if (seenFingerprints.has(key)) repeatedMutations += 1;
      seenFingerprints.set(key, true);

      const history = pathHistory.get(path) || [];
      // A path returning to a fingerprint it already held: written away and
      // written back. Reversal only matters inside the bounded window and only
      // when nothing declared advanced.
      if (history.length > 0 && history.includes(fingerprint) &&
          history[history.length - 1] !== fingerprint) {
        reversals += 1;
      }
      history.push(fingerprint);
      pathHistory.set(path, history);
    }
  }

  const limits = policy || {};
  if (verifiedCount === 0) {
    if (repeatedMutations > 0 &&
        repeatedMutations >= (limits.maximumRepeatedMutations ?? 1)) {
      signals.push('repeated_no_op');
    }
    if (failedStreak >= (limits.maximumFailedOperationStreak ?? 3)) {
      signals.push('repeated_failed_operation');
    }
    if (reversals >= (limits.maximumMutationReversals ?? 1)) {
      signals.push('mutation_reversal_churn');
    }
    if (inspectionStreak >= (limits.maximumInspectionOnlyStreak ?? 3)) {
      signals.push('inspection_only_streak');
    }
    if (resources && resourceGrew(resources)) {
      signals.push('resource_growth_without_progress');
    }
  }
  return deepFreeze([...new Set(signals)].sort(compareCanonicalText));
}

// Resource growth is measured from durable ledgers only: budget charges,
// provider requests, settled micro-USD. Never from elapsed process time.
function resourceGrew(resources) {
  return Number(resources.providerRequests || 0) > 0 ||
    Number(resources.durableOperations || 0) > 0 ||
    Number(resources.settledMicroUsd || 0) > 0;
}

// ── Projection ──────────────────────────────────────────────────────────────

function buildVerifiedProgressProjection({
  ticketId,
  runId,
  allocationPlanId = null,
  allocationItemId = null,
  declaredWorkSnapshot,
  windowIdentity,
  windowKind,
  observations = [],
  resources = {},
  previouslySatisfiedFactIdentities = [],
  previouslySeenFingerprints = [],
  policy = null,
  sourceCutoff,
  evaluatedAt
}) {
  if (!WINDOW_KINDS.includes(windowKind)) {
    refuse('progress_window_identity_missing',
      `unsupported observation window kind: ${String(windowKind)}`);
  }
  // The window identity is durable by construction: a provider-request window
  // uses the Tranche 4 logical source identity, an operation window uses a
  // receipt idempotency identity. A process-local sequence is never accepted.
  const identity = requiredText(windowIdentity, 'windowIdentity');

  const declaredFacts = inventoryDeclaredFacts(declaredWorkSnapshot);
  const satisfied = new Set(previouslySatisfiedFactIdentities);
  const seen = [...previouslySeenFingerprints];

  const candidateFacts = [];
  const verifiedFacts = [];
  for (const observation of observations) {
    const classified = classifyObservation(observation, {
      declaredFacts,
      previouslySatisfiedFactIdentities: [...satisfied],
      previouslySeenFingerprints: seen
    });
    if (classified.level === 'verified_progress') {
      for (const factIdentity of classified.satisfies) {
        satisfied.add(factIdentity);
        verifiedFacts.push(factIdentity);
      }
    } else if (classified.level === 'candidate_progress') {
      candidateFacts.push(observation.mutationFingerprint);
    }
    if (observation.mutationFingerprint) seen.push(observation.mutationFingerprint);
  }

  const normalizedResources = {
    providerRequests: nonNegativeInteger(
      resources.providerRequests || 0, 'resources.providerRequests'),
    durableOperations: nonNegativeInteger(
      resources.durableOperations || 0, 'resources.durableOperations'),
    settledMicroUsd: nonNegativeInteger(
      resources.settledMicroUsd || 0, 'resources.settledMicroUsd'),
    budgetChargedUnits: nonNegativeInteger(
      resources.budgetChargedUnits || 0, 'resources.budgetChargedUnits')
  };

  const fields = {
    version: VERIFIED_PROGRESS_VERSION,
    ticketId: nonNegativeInteger(ticketId, 'ticketId'),
    runId: nonNegativeInteger(runId, 'runId'),
    allocationPlanId,
    allocationItemId,
    declaredWorkHash: requiredText(
      declaredWorkSnapshot.contractHash, 'declaredWorkSnapshot.contractHash'),
    windowIdentity: identity,
    windowKind,
    resources: deepFreeze(normalizedResources),
    candidateFacts: deepFreeze([...new Set(candidateFacts)].sort(compareCanonicalText)),
    verifiedFacts: deepFreeze([...new Set(verifiedFacts)].sort(compareCanonicalText)),
    verifiedProgressCount: new Set(verifiedFacts).size,
    noProgressSignals: detectNoProgressSignals({
      observations,
      verifiedCount: new Set(verifiedFacts).size,
      resources: normalizedResources,
      policy
    }),
    // The exact ordered cutoff the projection was built from. Two processes
    // reading the same rows through the same cutoff produce the same hash.
    sourceCutoff: nonNegativeInteger(sourceCutoff, 'sourceCutoff'),
    // Captured from the database, never from the process clock. Required: a
    // projection that cannot say when it was evaluated cannot support a
    // duration decision.
    evaluatedAt: requiredInstant(evaluatedAt, 'evaluatedAt'),
    projectionHash: null
  };
  const withoutHash = {};
  for (const field of PROJECTION_FIELDS) {
    if (field === 'projectionHash') continue;
    withoutHash[field] = fields[field];
  }
  fields.projectionHash = hashCanonical(withoutHash);
  return deepFreeze(fields);
}

function normalizeVerifiedProgressProjection(value) {
  if (!isPlainObject(value)) {
    refuse('progress_observation_malformed', 'projection must be an object');
  }
  const unknown = Object.keys(value).filter(field => !PROJECTION_FIELDS.includes(field));
  if (unknown.length > 0) {
    refuse('progress_observation_malformed',
      `projection contains unknown field(s): ${unknown.sort(compareCanonicalText).join(', ')}`);
  }
  const missing = PROJECTION_FIELDS.filter(
    field => !Object.prototype.hasOwnProperty.call(value, field));
  if (missing.length > 0) {
    refuse('progress_observation_malformed',
      `projection is missing field(s): ${missing.join(', ')}`);
  }
  if (value.version !== VERIFIED_PROGRESS_VERSION) {
    refuse('progress_observation_malformed',
      `unsupported projection version: ${String(value.version)}`);
  }
  if (value.verifiedProgressCount !== value.verifiedFacts.length) {
    refuse('progress_accounting_conflict',
      'the verified-progress count disagrees with its own fact list');
  }
  const withoutHash = {};
  for (const field of PROJECTION_FIELDS) {
    if (field === 'projectionHash') continue;
    withoutHash[field] = value[field];
  }
  if (value.projectionHash !== hashCanonical(withoutHash)) {
    refuse('progress_observation_malformed',
      'the projection hash does not cover its own fields');
  }
  const normalized = {};
  for (const field of PROJECTION_FIELDS) normalized[field] = value[field];
  return deepFreeze(normalized);
}

module.exports = {
  DECLARED_FACT_KINDS,
  INSPECTION_OPERATIONS,
  NO_PROGRESS_SIGNALS,
  PROGRESS_LEVELS,
  PROGRESS_REFUSALS,
  PROJECTION_FIELDS,
  VERIFIED_PROGRESS_VERSION,
  VerifiedProgressError,
  WINDOW_KINDS,
  buildVerifiedProgressProjection,
  classifyObservation,
  detectNoProgressSignals,
  inventoryDeclaredFacts,
  normalizeVerifiedProgressProjection,
  refuseVerifiedProgress: refuse
};

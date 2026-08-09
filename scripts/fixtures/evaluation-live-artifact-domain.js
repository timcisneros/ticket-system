'use strict';

// The closed domain of REAL-live product artifacts.
//
// An executor result may become accepted product evidence only when this
// module can name its downstream disposition.  The same predicate is invoked
// before the executor journals acceptance, by the disk-corpus gate, and by the
// scorer.  Keeping the rule in one owner prevents the three boundaries from
// accepting subtly different evidence classes.

const { classifyTruthfulness } = require('./evaluation-oracle');

const LIVE_ARTIFACT_DOMAIN_VERSION = 1;
const SCORABLE_PRODUCT_EVIDENCE = 'scorable_product_evidence';
const REFUSE_BEFORE_PRODUCT_EVIDENCE = 'refuse_before_product_evidence';

const OBSERVATION_COMPLETENESS = Object.freeze([
  'complete', 'incomplete', 'unavailable'
]);
const ORACLE_VERDICTS = Object.freeze(['pass', 'fail', 'refused']);
const PRODUCT_TERMINAL_STATUSES = Object.freeze([
  'completed', 'failed', 'interrupted', 'cancelled', 'blocked'
]);
const TRUTHFULNESS_CLASSES = Object.freeze([
  'false_positive_completion', 'true_positive_completion',
  'false_negative_completion', 'true_negative_completion', 'oracle_refused'
]);

class LiveArtifactDomainError extends Error {
  constructor(message, detail = {}) {
    super(message);
    this.name = 'LiveArtifactDomainError';
    this.code = detail.code || 'LIVE_ARTIFACT_OUTSIDE_SCORING_DOMAIN';
    this.detail = detail;
  }
}

function expectedOracleAuthority(value) {
  if (value === 'raw_state') return 'independent_raw_state_observation';
  if (value === 'coupling_raw_state_and_fixture_access_log') {
    return 'independent_raw_state_and_fixture_access_log';
  }
  return null;
}

function refusal(code, message, detail = {}) {
  return Object.freeze({
    domainVersion: LIVE_ARTIFACT_DOMAIN_VERSION,
    disposition: REFUSE_BEFORE_PRODUCT_EVIDENCE,
    code,
    message,
    detail: Object.freeze({ ...detail })
  });
}

function scorable(detail) {
  return Object.freeze({
    domainVersion: LIVE_ARTIFACT_DOMAIN_VERSION,
    disposition: SCORABLE_PRODUCT_EVIDENCE,
    code: null,
    message: null,
    detail: Object.freeze({ ...detail })
  });
}

function validNullableDuration(value) {
  return value === null || (Number.isFinite(value) && value >= 0);
}

function validateNormalizedCost(artifact, manifest) {
  const cost = artifact.normalizedCost;
  const requests = cost && Array.isArray(cost.requests) ? cost.requests : [];
  const planner = requests.filter(request => request.role === 'planner');
  const worker = requests.filter(request => request.role === 'worker');
  const sum = rows => rows.reduce((total, request) => total + request.microUsd, 0);
  return Boolean(cost && Number.isSafeInteger(cost.totalNormalizedMicroUsd) &&
    cost.totalNormalizedMicroUsd >= 0 &&
    Number.isSafeInteger(cost.plannerRequestCount) &&
    Number.isSafeInteger(cost.workerRequestCount) &&
    planner.length === cost.plannerRequestCount &&
    worker.length === cost.workerRequestCount &&
    requests.length === cost.plannerRequestCount + cost.workerRequestCount &&
    requests.every(request => Number.isSafeInteger(request.microUsd) &&
      request.microUsd >= 0 && request.provider === manifest.provider &&
      request.model === manifest.model) &&
    sum(planner) === cost.plannerMicroUsd &&
    sum(worker) === cost.workerMicroUsd &&
    sum(requests) === cost.totalNormalizedMicroUsd);
}

function validateAllocation(artifact) {
  const proof = artifact.pathProof;
  if (!proof || typeof proof.observedPath !== 'string' ||
      !Number.isSafeInteger(proof.runCount)) return false;
  if (proof.observedPath !== 'structured_v2') return true;
  return Number.isSafeInteger(proof.governedLeafRunCount) &&
    Number.isSafeInteger(proof.executableItemCount) &&
    typeof proof.governedLeafExecutionObserved === 'boolean';
}

function validateChurn(artifact) {
  const governed = artifact.armId === 'B' || artifact.armId === 'C';
  const facts = artifact.churnFacts;
  if (!facts || facts.evidenceAuthority !== 'durable_ticket_report_v1' ||
      facts.observationCompleteness !== 'complete') return false;
  if (governed) {
    if (!Number.isSafeInteger(facts.noProgressStreak) ||
        facts.noProgressStreak < 0) return false;
  } else if (facts.noProgressStreak !== null) return false;
  const worker = facts.worker;
  return Boolean(worker && Number.isSafeInteger(worker.attemptedTransports) &&
    worker.attemptedTransports >= 0 &&
    Number.isSafeInteger(worker.durableResponses) &&
    worker.durableResponses >= 0 &&
    worker.durableResponses <= worker.attemptedTransports);
}

function evaluateLiveArtifactDisposition({ artifact, trial, manifest }) {
  const trialId = trial && trial.trialId ? trial.trialId : artifact && artifact.trialId;
  if (!artifact || artifact.mode !== 'live') {
    return refusal('LIVE_ARTIFACT_MODE_INVALID',
      'only a live-mode artifact may enter the REAL-live scoring domain', { trialId });
  }
  if (!trial || !manifest) {
    return refusal('LIVE_ARTIFACT_AUTHORITY_MISSING',
      'the frozen trial and live manifest authorities are required', { trialId });
  }
  if (trial.expectedQuiescence !== 'quiescent') {
    return refusal('LIVE_ARTIFACT_QUIESCENCE_AUTHORITY_UNKNOWN',
      'the trial quiescence authority is outside the frozen live vocabulary', { trialId });
  }

  const observationCompleteness = artifact.observationCompleteness;
  if (!OBSERVATION_COMPLETENESS.includes(observationCompleteness)) {
    return refusal('LIVE_ARTIFACT_OBSERVATION_STATE_UNKNOWN',
      'observation completeness is outside the closed repository vocabulary', { trialId });
  }
  const oracleAuthority = expectedOracleAuthority(trial.expectedOracleAuthority);
  const oracleVerdict = artifact.oracleResult && artifact.oracleResult.verdict;
  if (!oracleAuthority || artifact.oracleResult?.authority !== oracleAuthority) {
    return refusal('LIVE_SCORING_ORACLE_AUTHORITY_DRIFT',
      'the artifact does not carry its frozen oracle authority', { trialId });
  }
  if (!ORACLE_VERDICTS.includes(oracleVerdict)) {
    return refusal('LIVE_ARTIFACT_ORACLE_VERDICT_UNKNOWN',
      'the artifact oracle verdict is outside the closed vocabulary', { trialId });
  }

  // The shared observation sink is fixture/capture evidence.  A raw-state
  // oracle reads the workspace directly and is independent of that sink, so
  // unavailable sink evidence cannot invalidate a raw-state pass/fail.  A
  // coupling oracle, by contrast, needs the observed consumer-read stream and
  // must refuse whenever that stream is not complete.
  if (trial.expectedOracleAuthority === 'coupling_raw_state_and_fixture_access_log' &&
      observationCompleteness !== 'complete' && oracleVerdict !== 'refused') {
    return refusal('LIVE_SCORING_ORACLE_INCOMPLETE',
      'a coupling oracle may not decide from incomplete fixture-access observation',
      { trialId, expectedOracleAuthority: trial.expectedOracleAuthority });
  }

  const timedOut = artifact.quiescence?.timedOut === true;
  const quiescent = artifact.quiescence?.quiescent === true;
  if (!quiescent && !timedOut) {
    return refusal('LIVE_SCORING_QUIESCENCE_UNPROVEN',
      'the artifact is neither quiescent nor a frozen product timeout', { trialId });
  }
  if (timedOut && (quiescent || oracleVerdict !== 'refused')) {
    return refusal('LIVE_ARTIFACT_TIMEOUT_ORACLE_INVALID',
      'a trial timed out before quiescence and therefore may carry only oracle refusal',
      { trialId });
  }
  if (!timedOut && !PRODUCT_TERMINAL_STATUSES.includes(
    artifact.pathProof && artifact.pathProof.ticketResultStatus)) {
    return refusal('LIVE_ARTIFACT_TERMINAL_STATE_UNKNOWN',
      'the artifact has no supported terminal product disposition', { trialId });
  }

  const productClaimsCompleted = artifact.ticketReport?.productClaimsCompleted;
  if (typeof productClaimsCompleted !== 'boolean') {
    return refusal('LIVE_ARTIFACT_COMPLETION_AUTHORITY_MISSING',
      'the product completion claim is absent', { trialId });
  }
  const expectedTruthfulness = classifyTruthfulness({
    productClaimsCompleted, oracleResult: artifact.oracleResult
  });
  if (!TRUTHFULNESS_CLASSES.includes(artifact.truthfulness) ||
      artifact.truthfulness !== expectedTruthfulness) {
    return refusal('LIVE_ARTIFACT_TRUTHFULNESS_DRIFT',
      'truthfulness does not reproduce from product claim and independent oracle',
      { trialId });
  }

  const latency = artifact.latency;
  const latencyValid = Boolean(latency &&
    ['planningMs', 'timeToFirstExecutionMs', 'endToEndMs', 'recoveryMs', 'withheldMs']
      .every(field => validNullableDuration(latency[field] ?? null)));
  const metricValidity = Object.freeze({
    allocation: validateAllocation(artifact),
    truthfulness: TRUTHFULNESS_CLASSES.includes(artifact.truthfulness),
    latency: latencyValid,
    cost: validateNormalizedCost(artifact, manifest),
    churn: validateChurn(artifact)
  });
  if (Object.values(metricValidity).some(value => value !== true)) {
    return refusal('LIVE_SCORING_METRIC_EVIDENCE_MISSING',
      'the artifact lacks a mechanically defined input for one or more frozen metrics',
      { trialId, ...metricValidity });
  }

  return scorable({
    trialId,
    observationCompleteness,
    oracleVerdict,
    expectedOracleAuthority: trial.expectedOracleAuthority,
    terminalClass: timedOut ? 'product_timeout' : artifact.pathProof.ticketResultStatus,
    metricValidity
  });
}

function assertLiveProductArtifactScorable(input) {
  const result = evaluateLiveArtifactDisposition(input);
  if (result.disposition !== SCORABLE_PRODUCT_EVIDENCE) {
    throw new LiveArtifactDomainError(result.message, {
      code: result.code, ...result.detail, disposition: result.disposition
    });
  }
  return result;
}

module.exports = {
  LIVE_ARTIFACT_DOMAIN_VERSION,
  LiveArtifactDomainError,
  OBSERVATION_COMPLETENESS,
  ORACLE_VERDICTS,
  PRODUCT_TERMINAL_STATUSES,
  REFUSE_BEFORE_PRODUCT_EVIDENCE,
  SCORABLE_PRODUCT_EVIDENCE,
  assertLiveProductArtifactScorable,
  evaluateLiveArtifactDisposition,
  expectedOracleAuthority
};

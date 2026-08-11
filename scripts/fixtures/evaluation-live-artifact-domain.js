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
  'completed', 'failed', 'blocked'
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

const METRIC_SOURCE_OWNERS = Object.freeze({
  allocationQuality: 'pathProof from durable plans, Runs, receipts and planning events',
  completionTruthfulness: 'product completion claim + independent oracle classifier',
  latency: 'Ticket event and operation-receipt database timestamps',
  normalizedCost: 'canonical provider requests + frozen pricing snapshot',
  churn: 'durable progress blocks, transport/response evidence and committed charges'
});

function checkNormalizedCost(artifact, manifest) {
  const cost = artifact.normalizedCost;
  const requests = cost && Array.isArray(cost.requests) ? cost.requests : [];
  const planner = requests.filter(request => request.role === 'planner');
  const worker = requests.filter(request => request.role === 'worker');
  const sum = rows => rows.reduce((total, request) => total + request.microUsd, 0);
  const missing = [];
  if (!cost || typeof cost !== 'object') missing.push('normalizedCost');
  if (!Number.isSafeInteger(cost?.totalNormalizedMicroUsd) ||
      cost.totalNormalizedMicroUsd < 0) missing.push('totalNormalizedMicroUsd');
  if (!Number.isSafeInteger(cost?.plannerRequestCount)) missing.push('plannerRequestCount');
  if (!Number.isSafeInteger(cost?.workerRequestCount)) missing.push('workerRequestCount');
  if (!Array.isArray(cost?.requests)) missing.push('requests');
  if (planner.length !== cost?.plannerRequestCount ||
      worker.length !== cost?.workerRequestCount ||
      requests.length !== (cost?.plannerRequestCount || 0) +
        (cost?.workerRequestCount || 0)) missing.push('requestRoleCounts');
  if (!requests.every(request => Number.isSafeInteger(request.microUsd) &&
      request.microUsd >= 0 && request.provider === manifest.provider &&
      request.model === manifest.model)) missing.push('requestPricingAuthority');
  if (sum(planner) !== cost?.plannerMicroUsd || sum(worker) !== cost?.workerMicroUsd ||
      sum(requests) !== cost?.totalNormalizedMicroUsd) missing.push('requestSums');
  return missing;
}

function checkAllocation(artifact) {
  const proof = artifact.pathProof;
  const missing = [];
  if (!proof || typeof proof.observedPath !== 'string' ||
      !Number.isSafeInteger(proof.runCount)) {
    if (!proof) missing.push('pathProof');
    if (typeof proof?.observedPath !== 'string') missing.push('observedPath');
    if (!Number.isSafeInteger(proof?.runCount)) missing.push('runCount');
    return missing;
  }
  if (proof.observedPath !== 'structured_v2') return missing;
  if (!Number.isSafeInteger(proof.governedLeafRunCount)) missing.push('governedLeafRunCount');
  if (!Number.isSafeInteger(proof.executableItemCount)) missing.push('executableItemCount');
  if (typeof proof.governedLeafExecutionObserved !== 'boolean') {
    missing.push('governedLeafExecutionObserved');
  }
  return missing;
}

function checkChurn(artifact) {
  const governed = artifact.armId === 'B' || artifact.armId === 'C';
  const facts = artifact.churnFacts;
  const missing = [];
  if (!facts || facts.evidenceAuthority !== 'durable_ticket_report_v1' ||
      facts.observationCompleteness !== 'complete') {
    if (!facts) missing.push('churnFacts');
    if (facts?.evidenceAuthority !== 'durable_ticket_report_v1') {
      missing.push('evidenceAuthority');
    }
    if (facts?.observationCompleteness !== 'complete') {
      missing.push('observationCompleteness');
    }
    return missing;
  }
  if (governed) {
    if (!Number.isSafeInteger(facts.noProgressStreak) ||
        facts.noProgressStreak < 0) missing.push('noProgressStreak');
  } else if (facts.noProgressStreak !== null) missing.push('noProgressStreakNonApplicable');
  const worker = facts.worker;
  if (!worker) return [...missing, 'worker'];
  if (!Number.isSafeInteger(worker.attemptedTransports) ||
      worker.attemptedTransports < 0) missing.push('worker.attemptedTransports');
  if (!Number.isSafeInteger(worker.durableResponses) ||
      worker.durableResponses < 0) missing.push('worker.durableResponses');
  if (Number.isSafeInteger(worker.attemptedTransports) &&
      Number.isSafeInteger(worker.durableResponses) &&
      worker.durableResponses > worker.attemptedTransports) {
    missing.push('worker.responseWithoutAttemptAuthority');
  }
  return missing;
}

function checkLatency(artifact) {
  const latency = artifact.latency;
  if (!latency || typeof latency !== 'object') return ['latency'];
  return ['planningMs', 'timeToFirstExecutionMs', 'endToEndMs', 'recoveryMs', 'withheldMs']
    .filter(field => !Object.prototype.hasOwnProperty.call(latency, field) ||
      !validNullableDuration(latency[field]));
}

function metricProjection(name, missing) {
  return Object.freeze({
    defined: missing.length === 0,
    reasonCode: missing.length === 0 ? 'DEFINED_BY_FROZEN_CONTRACT'
      : `LIVE_${name.replace(/[A-Z]/g, value => `_${value}`).toUpperCase()}_INPUT_MISSING`,
    missingFields: Object.freeze([...missing]),
    sourceOwner: METRIC_SOURCE_OWNERS[name]
  });
}

function projectLiveMetricDomain({ artifact, manifest }) {
  const projections = Object.freeze({
    allocationQuality: metricProjection('allocationQuality', checkAllocation(artifact)),
    completionTruthfulness: metricProjection('completionTruthfulness',
      TRUTHFULNESS_CLASSES.includes(artifact.truthfulness) ? [] : ['truthfulness']),
    latency: metricProjection('latency', checkLatency(artifact)),
    normalizedCost: metricProjection('normalizedCost', checkNormalizedCost(artifact, manifest)),
    churn: metricProjection('churn', checkChurn(artifact))
  });
  return Object.freeze({
    projections,
    allDefined: Object.values(projections).every(metric => metric.defined === true),
    metricValidity: Object.freeze({
      allocation: projections.allocationQuality.defined,
      truthfulness: projections.completionTruthfulness.defined,
      latency: projections.latency.defined,
      cost: projections.normalizedCost.defined,
      churn: projections.churn.defined
    })
  });
}

function classifyLiveTerminalCandidate(artifact) {
  if (artifact.quiescence?.timedOut === true) return 'runtime_timeout';
  const status = artifact.pathProof?.ticketResultStatus;
  if (status === 'completed') return 'successful_or_claimed_completion';
  if (status === 'failed') return 'product_failure';
  if (status === 'blocked') return 'product_blocked';
  const runStatuses = artifact.ticketReport?.terminalRunStatuses;
  if (status === 'open' && Array.isArray(runStatuses) && runStatuses.length > 0 &&
      runStatuses.every(runStatus => runStatus === 'interrupted')) {
    return 'interrupted_recoverable';
  }
  return null;
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
  const terminalClass = classifyLiveTerminalCandidate(artifact);
  if (!timedOut && terminalClass === null) {
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

  const metricDomain = projectLiveMetricDomain({ artifact, manifest });
  if (!metricDomain.allDefined) {
    return refusal('LIVE_SCORING_METRIC_EVIDENCE_MISSING',
      'the artifact lacks a mechanically defined input for one or more frozen metrics',
      { trialId, ...metricDomain.metricValidity, metrics: metricDomain.projections });
  }

  return scorable({
    trialId,
    observationCompleteness,
    oracleVerdict,
    expectedOracleAuthority: trial.expectedOracleAuthority,
    terminalClass,
    metricValidity: metricDomain.metricValidity,
    metrics: metricDomain.projections
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
  classifyLiveTerminalCandidate,
  evaluateLiveArtifactDisposition,
  expectedOracleAuthority,
  METRIC_SOURCE_OWNERS,
  projectLiveMetricDomain
};

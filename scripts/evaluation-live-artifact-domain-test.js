#!/usr/bin/env node
'use strict';

// Canonical provider-free proof that the accepted REAL-live artifact domain is
// closed under the frozen scorer. Controlled artifacts only; never historical
// or real-run outcomes.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  PRODUCT_TERMINAL_STATUSES, REFUSE_BEFORE_PRODUCT_EVIDENCE,
  SCORABLE_PRODUCT_EVIDENCE, evaluateLiveArtifactDisposition
} = require('./fixtures/evaluation-live-artifact-domain');
const {
  classifyLiveFailure
} = require('./fixtures/evaluation-live-failure-classifier');
const {
  projectLiveManifestToScoring
} = require('./fixtures/evaluation-live-scoring');
const {
  HEADER, artifactFor, liveManifest, rehashArtifact
} = require('./evaluation-live-scoring-dress-rehearsal-test');
const protocol = require('../config/structured-allocation-evaluation-v1.json');

let passed = 0;
function ok(value, message) {
  assert.equal(value, true, message);
  passed += 1;
  console.log(`  ok ${message}`);
}

const projection = projectLiveManifestToScoring({ manifest: liveManifest, protocol });

function truthfulness(productClaimsCompleted, verdict) {
  if (verdict === 'refused') return 'oracle_refused';
  if (productClaimsCompleted && verdict === 'pass') return 'true_positive_completion';
  if (productClaimsCompleted) return 'false_positive_completion';
  if (verdict === 'pass') return 'false_negative_completion';
  return 'true_negative_completion';
}

function withOracle(base, verdict, completeness) {
  const productClaimsCompleted = base.ticketReport.productClaimsCompleted;
  return rehashArtifact({
    ...base,
    observationCompleteness: completeness,
    oracleResult: { ...base.oracleResult, verdict },
    truthfulness: truthfulness(productClaimsCompleted, verdict)
  });
}

function disposition(artifact, trial) {
  return evaluateLiveArtifactDisposition({ artifact, trial, manifest: liveManifest });
}

function main() {
  console.log('REAL artifact domain closure');
  const rawTrial = projection.trials.find(row =>
    row.expectedOracleAuthority === 'raw_state');
  const couplingTrial = projection.trials.find(row =>
    row.expectedOracleAuthority === 'coupling_raw_state_and_fixture_access_log');
  const raw = artifactFor(liveManifest.slots.find(slot =>
    slot.slot === rawTrial.slot && slot.repetition === rawTrial.repetition), HEADER);
  const coupling = artifactFor(liveManifest.slots.find(slot =>
    slot.slot === couplingTrial.slot && slot.repetition === couplingTrial.repetition), HEADER);

  // Raw-state oracle and the test observation sink are independent. Every
  // closed oracle verdict has a scoring disposition under every sink state.
  for (const completeness of ['complete', 'incomplete', 'unavailable']) {
    for (const verdict of ['pass', 'fail', 'refused']) {
      ok(disposition(withOracle(raw, verdict, completeness), rawTrial).disposition ===
        SCORABLE_PRODUCT_EVIDENCE,
      `raw-state ${verdict} with ${completeness} test observation is scorable`);
    }
  }

  // Coupling is deliberately different: it depends on the observed access
  // stream, so non-complete observation permits only an oracle refusal.
  for (const verdict of ['pass', 'fail', 'refused']) {
    ok(disposition(withOracle(coupling, verdict, 'complete'), couplingTrial).disposition ===
      SCORABLE_PRODUCT_EVIDENCE,
    `coupling ${verdict} with complete access observation is scorable`);
  }
  for (const completeness of ['incomplete', 'unavailable']) {
    for (const verdict of ['pass', 'fail']) {
      const result = disposition(withOracle(coupling, verdict, completeness), couplingTrial);
      ok(result.disposition === REFUSE_BEFORE_PRODUCT_EVIDENCE &&
         result.code === 'LIVE_SCORING_ORACLE_INCOMPLETE',
      `coupling ${verdict} with ${completeness} access observation refuses pre-acceptance`);
    }
    ok(disposition(withOracle(coupling, 'refused', completeness), couplingTrial)
      .disposition === SCORABLE_PRODUCT_EVIDENCE,
    `coupling refusal with ${completeness} access observation remains product evidence`);
  }

  for (const status of PRODUCT_TERMINAL_STATUSES) {
    const terminal = rehashArtifact({ ...raw,
      pathProof: { ...raw.pathProof, ticketResultStatus: status, ticketStatus: status } });
    ok(disposition(terminal, rawTrial).disposition === SCORABLE_PRODUCT_EVIDENCE,
      `supported terminal product state ${status} has a scoring disposition`);
  }
  const unknownTerminal = rehashArtifact({ ...raw,
    pathProof: { ...raw.pathProof, ticketResultStatus: 'new_unowned_terminal' } });
  ok(disposition(unknownTerminal, rawTrial).code ===
    'LIVE_ARTIFACT_TERMINAL_STATE_UNKNOWN',
  'a new terminal artifact type fails until its scoring disposition is defined');
  ok(disposition(raw, { ...rawTrial, expectedQuiescence: 'new_quiescence_rule' }).code ===
    'LIVE_ARTIFACT_QUIESCENCE_AUTHORITY_UNKNOWN',
  'a new quiescence authority fails until its scoring disposition is defined');

  const timedOut = withOracle(rehashArtifact({ ...raw,
    quiescence: { ...raw.quiescence, quiescent: false, timedOut: true },
    latency: { ...raw.latency, endToEndMs: null }
  }), 'refused', 'unavailable');
  ok(disposition(timedOut, rawTrial).disposition === SCORABLE_PRODUCT_EVIDENCE,
    'a frozen product timeout is retained with oracle refusal and truthful nullable latency');
  const guessedAtTimeout = withOracle(timedOut, 'pass', 'unavailable');
  ok(disposition(guessedAtTimeout, rawTrial).code ===
    'LIVE_ARTIFACT_TIMEOUT_ORACLE_INVALID',
  'a timeout cannot smuggle a pre-quiescence oracle guess into evidence');

  const truthfulnessDrift = rehashArtifact({ ...raw,
    truthfulness: raw.truthfulness === 'true_positive_completion'
      ? 'false_positive_completion' : 'true_positive_completion' });
  ok(disposition(truthfulnessDrift, rawTrial).code ===
    'LIVE_ARTIFACT_TRUTHFULNESS_DRIFT',
  'truthfulness must reproduce from product authority and independent oracle');

  const fixtureSinkChurn = rehashArtifact({ ...raw,
    churnFacts: { ...raw.churnFacts, evidenceAuthority: 'fixture_observation_sink' } });
  ok(disposition(fixtureSinkChurn, rawTrial).code ===
    'LIVE_SCORING_METRIC_EVIDENCE_MISSING',
  'REAL churn cannot be supplied by the fixture-only observation sink');

  const productFailure = rehashArtifact({ ...raw,
    pathProof: { ...raw.pathProof, ticketResultStatus: 'failed', ticketStatus: 'failed' },
    ticketReport: { ...raw.ticketReport, productClaimsCompleted: false },
    oracleResult: { ...raw.oracleResult, verdict: 'fail' },
    truthfulness: 'true_negative_completion' });
  ok(disposition(productFailure, rawTrial).disposition === SCORABLE_PRODUCT_EVIDENCE,
    'a truthful product failure remains data instead of becoming infrastructure');

  ok(classifyLiveFailure({ requestDelivered: false, modelResultObserved: false })
    .classification === 'infrastructure_exclusion',
  'positive no-delivery evidence remains a frozen infrastructure exclusion');
  ok(classifyLiveFailure({ requestDelivered: null, modelResultObserved: false })
    .classification === 'product_data',
  'ambiguous delivery remains product data under the frozen classifier');

  ok(projection.trials.every(trial => {
    const slot = liveManifest.slots.find(item => item.slot === trial.slot &&
      item.repetition === trial.repetition);
    return disposition(artifactFor(slot, HEADER), trial).disposition ===
      SCORABLE_PRODUCT_EVIDENCE;
  }), 'every controlled live-v3 assignment lies in one shared scoring-input domain');

  const runnerSource = fs.readFileSync(path.join(__dirname,
    'structured-allocation-evaluation-runner.js'), 'utf8');
  const executorSource = fs.readFileSync(path.join(__dirname,
    'structured-allocation-evaluation-scored-runner.js'), 'utf8');
  const corpusSource = fs.readFileSync(path.join(__dirname, 'fixtures',
    'evaluation-live-corpus-integrity.js'), 'utf8');
  const scoringSource = fs.readFileSync(path.join(__dirname, 'fixtures',
    'evaluation-live-scoring.js'), 'utf8');
  const runnerDomainBoundary =
    runnerSource.indexOf('assertLiveProductArtifactScorable({');
  ok(runnerDomainBoundary >= 0 &&
     runnerDomainBoundary < runnerSource.indexOf('writeTrialArtifact(outputPath, artifact);'),
  'the REAL trial refuses outside-domain evidence before artifact acceptance');
  ok(executorSource.split('assertLiveProductArtifactScorable({').length - 1 === 2,
    'new and crash-recovered artifacts both pass the domain before slot acceptance');
  ok(corpusSource.includes('assertLiveProductArtifactScorable({') &&
     corpusSource.includes("SCORING_INPUT_COMPLETE_VERDICT = 'LIVE SCORING INPUT DOMAIN COMPLETE'"),
  'the disk corpus cannot claim COMPLETE without the shared scoring-input domain');
  ok(scoringSource.includes('assertLiveProductArtifactScorable({ artifact, trial, manifest });'),
    'the scorer consumes the same shared domain rather than a weaker local copy');

  console.log(`\nREAL artifact domain closure passed — ${passed} assertions; provider calls 0`);
}

main();

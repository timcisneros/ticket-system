#!/usr/bin/env node
'use strict';

// Source-derived totality proof for the REAL-live candidate domain.
//
// This is deliberately not another list of representative outcomes. It takes
// the finite enums and nullable fields used by the production domain owner,
// expands their reachable equivalence classes one metric at a time, and binds
// every distinct production path to the actual-runner PostgreSQL suite. Invalid
// future values remain outside the accepted domain.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  LATENCY_FIELDS,
  LIVE_RUNNER_REACHABILITY_CLASSES,
  OBSERVATION_COMPLETENESS,
  ORACLE_VERDICTS,
  PRODUCT_TERMINAL_STATUSES,
  REFUSE_BEFORE_PRODUCT_EVIDENCE,
  SCORABLE_PRODUCT_EVIDENCE,
  TRUTHFULNESS_CLASSES,
  classifyLiveTerminalCandidate,
  evaluateLiveArtifactDisposition,
  projectLiveMetricDomain
} = require('./fixtures/evaluation-live-artifact-domain');
const { classifyTruthfulness } = require('./fixtures/evaluation-oracle');
const {
  freezePricingSnapshot, buildNormalizedCost
} = require('./fixtures/evaluation-normalized-cost');
const { buildPricingCatalog } = require('../runtime/model-pricing-catalog');
const { pricedCatalogValue } = require('./governed-structured-fixture');
const { deriveLatency } = require('./structured-allocation-evaluation-report');
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
const trialFor = authority => projection.trials.find(row =>
  row.slot === authority.slot && row.repetition === authority.repetition);
const slotForArm = armId => liveManifest.slots.find(slot => slot.armId === armId);

function artifactForArm(armId) {
  const slot = slotForArm(armId);
  return { artifact: artifactFor(slot, HEADER), trial: trialFor(slot) };
}

function disposition(artifact, trial) {
  return evaluateLiveArtifactDisposition({ artifact, trial, manifest: liveManifest });
}

function truthfulnessFor(claim, verdict) {
  return classifyTruthfulness({
    productClaimsCompleted: claim,
    oracleResult: { verdict }
  });
}

function terminalArtifact(base, status, claim, verdict) {
  const value = structuredClone(base);
  value.pathProof.ticketResultStatus = status;
  value.pathProof.ticketStatus = status;
  value.ticketReport.terminalTicketStatus = status;
  value.ticketReport.authority.ticketStatus = status;
  value.ticketReport.terminalRunStatuses = [status === 'blocked' ? 'failed' : status];
  value.ticketReport.productClaimsCompleted = claim;
  value.oracleResult.verdict = verdict;
  value.truthfulness = truthfulnessFor(claim, verdict);
  return rehashArtifact(value);
}

function latencyFacts(events) {
  return deriveLatency({
    ticket: { created_at: '2026-01-01T00:00:00.000Z', status: 'blocked' },
    receipts: [],
    events
  });
}

function main() {
  console.log('REAL live candidate-domain totality');

  // The list lives at the production classifier. The runner suite consumes the
  // same list and refuses to start its 120-slot rehearsal if one class is not
  // driven through runTrial.
  const runnerSuite = fs.readFileSync(path.join(__dirname,
    'evaluation-live-artifact-domain-postgres-test.js'), 'utf8');
  ok(LIVE_RUNNER_REACHABILITY_CLASSES.length ===
     new Set(LIVE_RUNNER_REACHABILITY_CLASSES).size &&
     LIVE_RUNNER_REACHABILITY_CLASSES.every(name =>
       runnerSuite.includes(`reachabilityClass: '${name}'`)) &&
     runnerSuite.includes('runTrial({'),
  'every source-owned reachable class is bound to the actual runner proof');

  const { artifact: rawBase, trial: rawTrial } = artifactForArm('A');
  const { artifact: governedBase } = artifactForArm('B');
  const { artifact: couplingBase, trial: couplingTrial } = (() => {
    const trial = projection.trials.find(row =>
      row.expectedOracleAuthority === 'coupling_raw_state_and_fixture_access_log');
    const slot = liveManifest.slots.find(row =>
      row.slot === trial.slot && row.repetition === trial.repetition);
    return { artifact: artifactFor(slot, HEADER), trial };
  })();

  // Terminal classifier: every finite supported parent state plus the one
  // recoverable-open Run state and the frozen timeout state.
  for (const status of PRODUCT_TERMINAL_STATUSES) {
    const claim = status === 'completed';
    const value = terminalArtifact(rawBase, status, claim, claim ? 'pass' : 'fail');
    ok(disposition(value, rawTrial).disposition === SCORABLE_PRODUCT_EVIDENCE,
      `terminal ${status} has one defined five-metric disposition`);
  }
  const interrupted = structuredClone(rawBase);
  interrupted.pathProof.ticketResultStatus = 'open';
  interrupted.pathProof.ticketStatus = 'open';
  interrupted.ticketReport.terminalTicketStatus = 'open';
  interrupted.ticketReport.authority.ticketStatus = 'open';
  interrupted.ticketReport.terminalRunStatuses = ['interrupted'];
  interrupted.ticketReport.productClaimsCompleted = false;
  interrupted.truthfulness = truthfulnessFor(false, interrupted.oracleResult.verdict);
  ok(classifyLiveTerminalCandidate(interrupted) === 'interrupted_recoverable' &&
     disposition(interrupted, rawTrial).disposition === SCORABLE_PRODUCT_EVIDENCE,
  'recoverable interruption is source-reachable and total');
  const timeout = structuredClone(rawBase);
  timeout.quiescence = { ...timeout.quiescence, quiescent: false, timedOut: true };
  timeout.oracleResult = { ...timeout.oracleResult, verdict: 'refused' };
  timeout.truthfulness = 'oracle_refused';
  timeout.latency = { ...timeout.latency, endToEndMs: null };
  ok(classifyLiveTerminalCandidate(timeout) === 'runtime_timeout' &&
     disposition(timeout, rawTrial).disposition === SCORABLE_PRODUCT_EVIDENCE,
  'runtime timeout is source-reachable and total');
  const unknownTerminal = structuredClone(rawBase);
  unknownTerminal.pathProof.ticketResultStatus = 'future_terminal';
  ok(disposition(unknownTerminal, rawTrial).code === 'LIVE_ARTIFACT_TERMINAL_STATE_UNKNOWN',
  'an unknown terminal state retains fail-closed pre-candidate refusal');

  // Completion claim, oracle authority/verdict and observation completeness.
  // Raw-state observation is independent of the fixture sink; coupling is not.
  for (const claim of [false, true]) {
    for (const verdict of ORACLE_VERDICTS) {
      for (const completeness of OBSERVATION_COMPLETENESS) {
        const status = claim ? 'completed' : 'failed';
        const value = terminalArtifact(rawBase, status, claim, verdict);
        value.observationCompleteness = completeness;
        ok(disposition(rehashArtifact(value), rawTrial).disposition ===
          SCORABLE_PRODUCT_EVIDENCE,
        `raw oracle claim=${claim} verdict=${verdict} observation=${completeness} is total`);
      }
    }
  }
  for (const claim of [false, true]) {
    for (const verdict of ORACLE_VERDICTS) {
      for (const completeness of OBSERVATION_COMPLETENESS) {
        const value = terminalArtifact(couplingBase, claim ? 'completed' : 'failed',
          claim, verdict);
        value.observationCompleteness = completeness;
        const result = disposition(rehashArtifact(value), couplingTrial);
        const valid = completeness === 'complete' || verdict === 'refused';
        ok(valid
          ? result.disposition === SCORABLE_PRODUCT_EVIDENCE
          : result.disposition === REFUSE_BEFORE_PRODUCT_EVIDENCE &&
            result.code === 'LIVE_SCORING_ORACLE_INCOMPLETE',
        `coupling claim=${claim} verdict=${verdict} observation=${completeness} has one disposition`);
      }
    }
  }
  ok(TRUTHFULNESS_CLASSES.every(name => {
    const value = structuredClone(rawBase);
    value.truthfulness = name;
    return projectLiveMetricDomain({ artifact: value, manifest: liveManifest })
      .projections.completionTruthfulness.defined;
  }), 'every frozen truthfulness enum is mechanically defined');

  // Every latency input is a nullable non-negative duration. Null, the zero
  // boundary and a positive duration are all defined; absence and negatives
  // remain diagnostic failures.
  for (const field of LATENCY_FIELDS) {
    for (const value of [null, 0, 1]) {
      const candidate = structuredClone(rawBase);
      candidate.latency[field] = value;
      ok(projectLiveMetricDomain({ artifact: candidate, manifest: liveManifest })
        .projections.latency.defined,
      `${field}=${String(value)} is inside the frozen nullable duration domain`);
    }
    const absent = structuredClone(rawBase);
    delete absent.latency[field];
    const missing = projectLiveMetricDomain({ artifact: absent, manifest: liveManifest })
      .projections.latency;
    ok(!missing.defined && missing.reasonCode === 'LIVE_LATENCY_INPUT_MISSING' &&
       missing.missingFields.includes(field),
    `${field} absence retains its exact diagnostic reason`);
    const negative = structuredClone(rawBase);
    negative.latency[field] = -1;
    ok(!projectLiveMetricDomain({ artifact: negative, manifest: liveManifest })
      .projections.latency.defined,
    `${field} negative future input remains fail closed`);
  }

  const temporalCases = [
    {
      name: 'no block', events: [], expected: null
    },
    {
      name: 'request before block only',
      events: [
        { type: 'provider.request.persisted', ts: '2026-01-01T00:00:01.000Z' },
        { type: 'run.progress_blocked', ts: '2026-01-01T00:00:05.000Z' }
      ], expected: null
    },
    {
      name: 'terminal before block with no later request',
      events: [
        { type: 'ticket.updated', run_id: null, ts: '2026-01-01T00:00:02.000Z',
          payload: { status: 'blocked' } },
        { type: 'run.progress_blocked', ts: '2026-01-01T00:00:05.000Z' }
      ], expected: null
    },
    {
      name: 'terminal after block with no later request',
      events: [
        { type: 'run.progress_blocked', ts: '2026-01-01T00:00:05.000Z' },
        { type: 'ticket.updated', run_id: null, ts: '2026-01-01T00:00:08.000Z',
          payload: { status: 'blocked' } }
      ], expected: null
    },
    {
      name: 'Run request at block boundary',
      events: [
        { type: 'run.progress_blocked', ts: '2026-01-01T00:00:05.000Z' },
        { type: 'provider.request.persisted', ts: '2026-01-01T00:00:05.000Z' }
      ], expected: 0
    },
    {
      name: 'planning request after block',
      events: [
        { type: 'ticket.economic_request_started', ts: '2026-01-01T00:00:08.000Z' },
        { type: 'run.progress_blocked', ts: '2026-01-01T00:00:05.000Z' }
      ], expected: 3000
    }
  ];
  for (const temporal of temporalCases) {
    ok(latencyFacts(temporal.events).withheldMs === temporal.expected,
      `withheld temporal class ${temporal.name} projects ${String(temporal.expected)}`);
  }

  // Allocation quality: direct/legacy need their common durable path facts;
  // structured paths additionally vary every finite/boolean input consumed by
  // the metric owner.
  for (const observedPath of ['direct', 'legacy_v1']) {
    for (const runCount of [0, 1]) {
      const value = structuredClone(rawBase);
      value.pathProof.observedPath = observedPath;
      value.pathProof.runCount = runCount;
      ok(projectLiveMetricDomain({ artifact: value, manifest: liveManifest })
        .projections.allocationQuality.defined,
      `${observedPath} allocation with runCount=${runCount} is defined`);
    }
  }
  for (const governedLeafRunCount of [0, 3]) {
    for (const executableItemCount of [0, 3]) {
      for (const governedLeafExecutionObserved of [false, true]) {
        const value = structuredClone(governedBase);
        Object.assign(value.pathProof, {
          observedPath: 'structured_v2', governedLeafRunCount,
          executableItemCount, governedLeafExecutionObserved
        });
        ok(projectLiveMetricDomain({ artifact: value, manifest: liveManifest })
          .projections.allocationQuality.defined,
        `structured allocation leaves=${governedLeafRunCount} items=${executableItemCount} ` +
          `executed=${governedLeafExecutionObserved} is defined`);
      }
    }
  }

  // Normalized economics expands role presence and both frozen token sources
  // through the production cost constructor, then through the candidate gate.
  const snapshot = freezePricingSnapshot(buildPricingCatalog(pricedCatalogValue()));
  const metered = role => ({ role, provider: liveManifest.provider,
    model: liveManifest.model, inputTokens: 10, outputTokens: 5 });
  const bounded = role => ({ role, provider: liveManifest.provider,
    model: liveManifest.model, authorizedOutputTokens: 2048, boundInputTokens: 128000 });
  for (const requests of [[], [metered('worker')], [bounded('worker')],
    [metered('planner'), bounded('worker')]]) {
    const value = structuredClone(governedBase);
    value.normalizedCost = buildNormalizedCost({ snapshot, requests,
      truthfulCompletions: 0, durableGovernedMicroUsd: null,
      economicCeilingMicroUsd: 1_000_000 });
    ok(projectLiveMetricDomain({ artifact: value, manifest: liveManifest })
      .projections.normalizedCost.defined,
    `economic roles/sources ${requests.map(row =>
      `${row.role}:${row.inputTokens === undefined ? 'bounded' : 'metered'}`).join(',') || 'none'} are defined`);
  }

  // Churn equivalence collapses request-started/transport/durable-response into
  // canonical non-negative counts, separately for governed and non-governed.
  for (const [attemptedTransports, durableResponses] of
    [[0, 0], [1, 0], [1, 1], [4, 4]]) {
    for (const noProgressStreak of [0, 1]) {
      const value = structuredClone(governedBase);
      value.churnFacts.noProgressStreak = noProgressStreak;
      value.churnFacts.worker.attemptedTransports = attemptedTransports;
      value.churnFacts.worker.durableResponses = durableResponses;
      ok(projectLiveMetricDomain({ artifact: value, manifest: liveManifest })
        .projections.churn.defined,
      `governed churn streak=${noProgressStreak} attempts=${attemptedTransports} ` +
        `responses=${durableResponses} is defined`);
    }
    const value = structuredClone(rawBase);
    value.churnFacts.noProgressStreak = null;
    value.churnFacts.worker.attemptedTransports = attemptedTransports;
    value.churnFacts.worker.durableResponses = durableResponses;
    ok(projectLiveMetricDomain({ artifact: value, manifest: liveManifest })
      .projections.churn.defined,
    `non-governed transport/response ${attemptedTransports}/${durableResponses} is defined`);
  }
  const responseWithoutAttempt = structuredClone(governedBase);
  responseWithoutAttempt.churnFacts.worker.attemptedTransports = 0;
  responseWithoutAttempt.churnFacts.worker.durableResponses = 1;
  ok(!projectLiveMetricDomain({ artifact: responseWithoutAttempt, manifest: liveManifest })
    .projections.churn.defined,
  'a durable response without attempt authority remains fail closed');

  // The exact 120 frozen assignments are the final source-valid cross-product
  // projection; every one must still be scorable after the per-metric expansion.
  ok(projection.trials.every(trial => {
    const slot = liveManifest.slots.find(item => item.slot === trial.slot &&
      item.repetition === trial.repetition);
    return disposition(artifactFor(slot, HEADER), trial).disposition ===
      SCORABLE_PRODUCT_EVIDENCE;
  }), 'all 120 frozen assignments remain inside the total five-metric domain');

  console.log(`\nREAL live candidate-domain totality passed — ${passed} assertions; provider calls 0`);
}

main();

#!/usr/bin/env node
'use strict';

// Tranche 6 — the PURE scorer.
//
// INPUT: a frozen trial corpus and the frozen manifest. Nothing else.
//
// It cannot reach the production database, current Ticket state, current
// configuration, current policy containers, a live provider or the scenario
// fixture implementation — it requires none of them, and the deterministic
// suite asserts that. A scorer that could read current state could report a
// number that no longer describes the trials it claims to summarize.
//
// It is DETERMINISTIC: the same corpus scores byte-identically twice.
//
// It computes exactly the five authorized dimensions using the frozen protocol
// formulas, evaluates the frozen hard disqualifiers BEFORE any ordinary
// tradeoff, and then applies the frozen RETAIN / REVISE / STOP rules
// mechanically. It never invents a sixth metric, never modifies a threshold,
// and never decides that a disqualifier does not count because of which arm
// triggered it.

const crypto = require('node:crypto');

// THE ONLY IMPORT, and it is a pure predicate: which run identities are not
// decision evidence. It reads no filesystem, no database and no fixture, so the
// scorer stays a pure function of the corpus it is handed while still refusing
// a corpus that may never be scored.
const {
  abortedRunDetail, isAbortedRunHeader
} = require('./fixtures/evaluation-aborted-runs');

const AUTHORIZED_DIMENSIONS = Object.freeze([
  'allocation_quality', 'completion_truthfulness', 'latency', 'cost', 'churn'
]);

const SCORER_VERSION = 1;

class ScorerError extends Error {
  constructor(message, detail = {}) {
    super(message);
    this.name = 'ScorerError';
    this.detail = detail;
  }
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort()
      .map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value === undefined ? null : value);
}

function hashCanonical(value) {
  return crypto.createHash('sha256').update(canonicalJson(value)).digest('hex');
}

// ── Corpus integrity, BEFORE any aggregation ────────────────────────────────
//
// An inconsistent corpus is not scored at all. Every check below answers a
// question that, if wrong, would make every number downstream meaningless.
function assertCorpusIntegrity({ manifest, header, artifacts, exclusions = [] }) {
  const problems = [];
  const expected = manifest.trials.length;

  // ── AN ABORTED RUN IS NOT A CORPUS ────────────────────────────────────
  //
  // Refused here as well as at the live corpus gate, because these are two
  // different doors into a score and a rule enforced at only one of them is a
  // rule that can be walked around. It refuses before any artifact is read: an
  // aborted run's slots were selected by when the abort happened, so scoring
  // them would report the first N trials as though they were the experiment.
  if (isAbortedRunHeader(header)) {
    throw new ScorerError(
      'refusing to score a run marked ABORTED — NOT DECISION EVIDENCE',
      { code: 'SCORER_ABORTED_RUN_NOT_DECISION_EVIDENCE',
        aborted: abortedRunDetail(header) });
  }
  for (const artifact of artifacts) {
    if (isAbortedRunHeader({ runHeaderHash: artifact.scoredRunHash,
      label: artifact.label })) {
      throw new ScorerError(
        `refusing to score ${artifact.trialId}: it belongs to a run marked ` +
        'ABORTED — NOT DECISION EVIDENCE',
        { code: 'SCORER_ABORTED_ARTIFACT_NOT_DECISION_EVIDENCE',
          trialId: artifact.trialId,
          aborted: abortedRunDetail({ runHeaderHash: artifact.scoredRunHash }) });
    }
  }

  const bySlot = new Map();
  const ids = new Set();
  for (const artifact of artifacts) {
    if (ids.has(artifact.trialId)) problems.push(`duplicate trial id ${artifact.trialId}`);
    ids.add(artifact.trialId);
    if (bySlot.has(`${artifact.repetition}:${artifact.trialSlot}`)) {
      problems.push(`two artifacts occupy repetition ${artifact.repetition} slot ${artifact.trialSlot}`);
    }
    bySlot.set(`${artifact.repetition}:${artifact.trialSlot}`, artifact);

    if (artifact.manifestHash !== manifest.manifestHash) {
      problems.push(`${artifact.trialId} references another manifest`);
    }
    if (artifact.scoredRunHash !== header.runHeaderHash) {
      problems.push(`${artifact.trialId} references another scored run`);
    }
    if (artifact.sourceCommit !== header.repositoryCommit) {
      problems.push(`${artifact.trialId} was produced from another source commit`);
    }
    // Fixture and live results may never be pooled into one score.
    if (artifact.mode !== manifest.mode) {
      problems.push(`${artifact.trialId} is mode ${artifact.mode}, not ${manifest.mode}`);
    }
    if (artifact.label !== 'SCORED FIXTURE TRIAL — FROZEN PROTOCOL V1') {
      problems.push(`${artifact.trialId} does not carry scored identity`);
    }
    // An oracle that needed an observation may only have decided when the
    // observation was complete.
    if (artifact.observationCompleteness !== 'complete' &&
        artifact.oracleResult.verdict !== 'refused') {
      problems.push(`${artifact.trialId} reports a verdict on incomplete observation`);
    }
    if (artifact.ticketReport.secondReadIdentical !== true) {
      problems.push(`${artifact.trialId} has no zero-drift proof`);
    }
    if (artifact.pathProof.observedPath === 'structured_v2' &&
        artifact.pathProof.sameParentPolicyRevision !== true) {
      problems.push(`${artifact.trialId} is structured but proves no parent-policy parity`);
    }
  }

  // Every assigned slot is accounted for exactly once, as a result OR a
  // declared exclusion. A missing trial stops aggregation; it is never treated
  // as an absent data point.
  const excludedIds = new Set(exclusions.map(entry => entry.trialId));
  for (const trial of manifest.trials) {
    const id = `${String(trial.repetition).padStart(2, '0')}-` +
      `${String(trial.slot).padStart(3, '0')}-${trial.cellId.replace('/', '_')}-${trial.armId}`;
    if (!ids.has(id) && !excludedIds.has(id)) {
      problems.push(`assigned slot ${id} has neither a result nor an exclusion`);
    }
  }
  const accounted = ids.size + excludedIds.size;
  if (accounted !== expected) {
    problems.push(`${accounted} slots accounted for, expected ${expected}`);
  }

  // An exclusion is legitimate only under the frozen predicate.
  for (const exclusion of exclusions) {
    if (!manifest.failureHandling.infrastructureExclusions.includes(exclusion.predicate)) {
      problems.push(
        `${exclusion.trialId} was excluded under "${exclusion.predicate}", which is ` +
        'not in the frozen infrastructure-only predicate');
    }
  }

  if (problems.length > 0) {
    throw new ScorerError(
      `refusing to aggregate an inconsistent corpus (${problems.length} problem(s))`,
      { problems: problems.slice(0, 20) });
  }
  return Object.freeze({
    verdict: 'SCORED FIXTURE CORPUS COMPLETE AND INTERNALLY CONSISTENT',
    trials: ids.size,
    exclusions: excludedIds.size,
    expected,
    corpusHash: hashCanonical(artifacts.map(a => a.artifactHash).sort())
  });
}

// ── The five dimensions ─────────────────────────────────────────────────────
//
// Each returns numerator, denominator and the contributing trial ids, so every
// number stays inspectable back to raw trials.

function rate(contributing, predicate) {
  const matching = contributing.filter(predicate);
  return {
    numerator: matching.length,
    denominator: contributing.length,
    value: contributing.length === 0 ? null : matching.length / contributing.length,
    trialIds: matching.map(a => a.trialId).sort()
  };
}

function mean(contributing, extract) {
  const values = contributing.map(extract).filter(v => typeof v === 'number' && Number.isFinite(v));
  return {
    numerator: values.reduce((sum, v) => sum + v, 0),
    denominator: values.length,
    value: values.length === 0 ? null : values.reduce((sum, v) => sum + v, 0) / values.length,
    trialIds: contributing.map(a => a.trialId).sort()
  };
}

function scoreDimensions(contributing) {
  return {
    // ALLOCATION QUALITY — did the declared work actually get executed by the
    // path the arm claims, one Run per executable item?
    allocation_quality: rate(contributing, a =>
      a.pathProof.observedPath !== 'structured_v2'
        ? a.pathProof.runCount > 0
        : a.pathProof.governedLeafRunCount === a.pathProof.executableItemCount &&
          a.pathProof.governedLeafExecutionObserved === true),

    // COMPLETION TRUTHFULNESS — the high-severity outcome is a FALSE successful
    // completion, reported as its own rate and never averaged into a score.
    completion_truthfulness: {
      falsePositiveCompletion: rate(contributing,
        a => a.truthfulness === 'false_positive_completion'),
      truePositiveCompletion: rate(contributing,
        a => a.truthfulness === 'true_positive_completion'),
      falseNegativeCompletion: rate(contributing,
        a => a.truthfulness === 'false_negative_completion'),
      trueNegativeCompletion: rate(contributing,
        a => a.truthfulness === 'true_negative_completion'),
      oracleRefused: rate(contributing, a => a.truthfulness === 'oracle_refused')
    },

    // END-TO-END is the frozen latency basis; the component breakdown is
    // reported beside it rather than summed into a different number.
    latency: {
      endToEndMs: mean(contributing, a =>
        a.latency && typeof a.latency.endToEndMs === 'number' ? a.latency.endToEndMs : null),
      planningMs: mean(contributing, a =>
        a.latency && typeof a.latency.planningMs === 'number' ? a.latency.planningMs : null),
      timeToFirstExecutionMs: mean(contributing, a =>
        a.latency && typeof a.latency.timeToFirstExecutionMs === 'number'
          ? a.latency.timeToFirstExecutionMs : null)
    },

    // COST — the normalized cross-arm method. Governed durable settlement is a
    // CROSS-CHECK reported beside it, never a second scoring basis.
    cost: {
      normalized: mean(contributing, a =>
        a.normalizedCost && typeof a.normalizedCost.totalNormalizedMicroUsd === 'number'
          ? a.normalizedCost.totalNormalizedMicroUsd : null),
      plannerMicroUsd: mean(contributing, a =>
        a.normalizedCost && typeof a.normalizedCost.plannerMicroUsd === 'number'
          ? a.normalizedCost.plannerMicroUsd : null),
      workerMicroUsd: mean(contributing, a =>
        a.normalizedCost && typeof a.normalizedCost.workerMicroUsd === 'number'
          ? a.normalizedCost.workerMicroUsd : null),
      governedCrossCheck: mean(contributing, a =>
        typeof a.durableGovernedCost === 'number' ? a.durableGovernedCost : null)
    },

    // CHURN — canonical evaluated windows only. A persistence interruption or
    // an undelivered response is NOT churn, and the artifact's own churn facts
    // keep them distinguishable.
    churn: {
      evaluatedNoProgressWindows: mean(contributing, a =>
        a.churnFacts && typeof a.churnFacts.noProgressStreak === 'number'
          ? a.churnFacts.noProgressStreak : null),
      undeliveredResponses: mean(contributing, a =>
        a.churnFacts && a.churnFacts.worker
          ? a.churnFacts.worker.attemptedTransports - a.churnFacts.worker.durableResponses
          : null)
    }
  };
}

// ── Hard disqualifiers, evaluated FIRST ─────────────────────────────────────
function evaluateHardDisqualifiers({ protocol, byArm, artifacts }) {
  const results = [];
  const armA = byArm.A || [];
  const falsePositiveRate = trials => trials.length === 0 ? 0
    : trials.filter(a => a.truthfulness === 'false_positive_completion').length / trials.length;
  const baseline = falsePositiveRate(armA);

  for (const statement of protocol.decisionThresholds.hardDisqualifiers) {
    let triggered = false;
    let contributing = [];
    // A third state. "Could not be checked" is not "checked and clean".
    let evaluable = true;
    let notEvaluableReason = null;
    if (/false-positive completion rate higher than arm A/i.test(statement)) {
      for (const [armId, trials] of Object.entries(byArm)) {
        if (armId === 'A') continue;
        if (falsePositiveRate(trials) > baseline) {
          triggered = true;
          contributing = contributing.concat(trials
            .filter(a => a.truthfulness === 'false_positive_completion')
            .map(a => a.trialId));
        }
      }
    } else if (/authority violation/i.test(statement)) {
      const offenders = artifacts.filter(a =>
        a.ticketReport.secondReadIdentical !== true ||
        (a.pathProof.observedPath === 'structured_v2' &&
         a.pathProof.sameParentPolicyRevision !== true));
      triggered = offenders.length > 0;
      contributing = offenders.map(a => a.trialId);
    } else if (/uncontrolled cost/i.test(statement)) {
      const offenders = artifacts.filter(a =>
        a.normalizedCost && a.normalizedCost.exceededCeiling === true);
      triggered = offenders.length > 0;
      contributing = offenders.map(a => a.trialId);
    } else if (/non-deterministic recovery/i.test(statement)) {
      // THE RULE SAYS *IDENTICAL DURABLE STATE*, AND THAT IS WHAT IS COMPARED.
      //
      // An earlier implementation grouped by (scenario, variant, arm) across
      // repetitions and reported divergence. That was broader than the frozen
      // wording: each repetition carries its own derived seed, so its comparison
      // envelope — and therefore its durable input — differs. Terminal statuses
      // that differ between two DIFFERENT inputs are not evidence of
      // non-deterministic recovery.
      //
      // Trials are therefore grouped by identical `envelopeHash`. In this corpus
      // every trial has a distinct envelope by construction, so no two trials
      // share identical durable state and the disqualifier CANNOT BE EVALUATED
      // from fixture evidence alone. That is reported as its own state rather
      // than collapsed into "not triggered", because "we could not check" and
      // "we checked and it was fine" are different claims.
      const byEnvelope = new Map();
      for (const a of artifacts) {
        if (!byEnvelope.has(a.envelopeHash)) byEnvelope.set(a.envelopeHash, new Set());
        byEnvelope.get(a.envelopeHash).add(a.pathProof.ticketResultStatus);
      }
      const comparable = [...byEnvelope.values()].filter(set => set.size >= 1 &&
        [...byEnvelope.entries()].some(([, s]) => s.size > 0));
      const repeatedEnvelopes = [...byEnvelope.entries()]
        .filter(([, set]) => set.size > 0);
      const withRepeats = [...byEnvelope.entries()].filter(([envelope]) =>
        artifacts.filter(a => a.envelopeHash === envelope).length > 1);
      if (withRepeats.length === 0) {
        evaluable = false;
        notEvaluableReason =
          'no two trials in this corpus share an identical comparison envelope, ' +
          'so identical durable state never recurs and the rule cannot be ' +
          'evaluated from fixture evidence';
      } else {
        const divergent = withRepeats.filter(([, set]) => set.size > 1);
        triggered = divergent.length > 0;
        contributing = divergent.map(([envelope]) => envelope);
      }
      void comparable; void repeatedEnvelopes;
    } else if (/systematic churn misclassification/i.test(statement)) {
      const offenders = artifacts.filter(a =>
        a.churnFacts && a.churnFacts.worker &&
        a.churnFacts.worker.durableResponses === 0 &&
        typeof a.churnFacts.noProgressStreak === 'number' &&
        a.churnFacts.noProgressStreak > 0);
      triggered = offenders.length > 0;
      contributing = offenders.map(a => a.trialId);
    }
    results.push({
      statement,
      result: !evaluable ? 'NOT EVALUABLE'
        : (triggered ? 'TRIGGERED' : 'NOT TRIGGERED'),
      notEvaluableReason,
      contributingTrialIds: [...new Set(contributing)].sort().slice(0, 50)
    });
  }
  return results;
}

// ── The frozen decision rules, applied mechanically ─────────────────────────
function applyFrozenDecisionRules({ protocol, disqualifiers, byArm }) {
  const anyTriggered = disqualifiers.some(entry => entry.result === 'TRIGGERED');
  // A disqualifier that could not be evaluated is NOT evidence of safety. It
  // never converts into a pass, and it is surfaced with the decision so a
  // reader sees exactly what the fixture phase could and could not rule out.
  const notEvaluable = disqualifiers.filter(entry => entry.result === 'NOT EVALUABLE');
  const thresholds = protocol.decisionThresholds;

  const truePositiveRate = trials => trials.length === 0 ? 0
    : trials.filter(a => a.truthfulness === 'true_positive_completion').length / trials.length;
  const structured = [...(byArm.B || []), ...(byArm.C || [])];
  const legacy = [...(byArm.A2a || []), ...(byArm.A2b || [])];
  const gainVersusA = (truePositiveRate(structured) - truePositiveRate(byArm.A || [])) * 100;
  const gainVersusA2 = (truePositiveRate(structured) - truePositiveRate(legacy)) * 100;

  // STOP is checked FIRST: a hard disqualifier is not traded off against a gain.
  if (anyTriggered) {
    return {
      decision: 'FIXTURE EVIDENCE SUPPORTS STOP',
      basis: 'at least one frozen hard disqualifier TRIGGERED',
      disqualifiersNotEvaluable: notEvaluable.map(entry => entry.statement),
      gainVersusAPoints: gainVersusA,
      gainVersusA2Points: gainVersusA2
    };
  }
  const meetsRetain =
    gainVersusA >= thresholds.retain.truePositiveGainVersusAPoints &&
    gainVersusA2 >= thresholds.retain.truePositiveGainVersusA2Points;
  if (meetsRetain) {
    return {
      decision: 'FIXTURE EVIDENCE SUPPORTS RETAIN',
      basis: 'no hard disqualifier and the frozen retain gains are met',
      disqualifiersNotEvaluable: notEvaluable.map(entry => entry.statement),
      gainVersusAPoints: gainVersusA,
      gainVersusA2Points: gainVersusA2
    };
  }
  // The frozen STOP rule: no family where structured improves truthful
  // completion by >= 5 points over BOTH A and A2.
  if (gainVersusA < 5 || gainVersusA2 < 5) {
    return {
      decision: 'FIXTURE EVIDENCE SUPPORTS STOP',
      basis: 'no hard disqualifier, but structured does not improve truthful ' +
        'completion by at least 5 points over BOTH A and A2',
      disqualifiersNotEvaluable: notEvaluable.map(entry => entry.statement),
      gainVersusAPoints: gainVersusA,
      gainVersusA2Points: gainVersusA2
    };
  }
  return {
    decision: 'FIXTURE EVIDENCE SUPPORTS REVISE',
    basis: thresholds.revise,
    disqualifiersNotEvaluable: notEvaluable.map(entry => entry.statement),
    gainVersusAPoints: gainVersusA,
    gainVersusA2Points: gainVersusA2
  };
}

// ── The report ──────────────────────────────────────────────────────────────

function scoreCorpus({ manifest, header, artifacts, exclusions = [], protocol }) {
  const integrity = assertCorpusIntegrity({ manifest, header, artifacts, exclusions });

  const byArm = {};
  for (const artifact of artifacts) {
    (byArm[artifact.armId] = byArm[artifact.armId] || []).push(artifact);
  }
  const byFamily = {};
  for (const artifact of artifacts) {
    const key = `family-${artifact.family}`;
    (byFamily[key] = byFamily[key] || []).push(artifact);
  }

  // ARMS ARE NEVER COLLAPSED in the raw report: A2a/A2b and B/C stay separate
  // so the evidence can distinguish legacy parallelism from structured
  // machinery, and allocated from dynamic ownership.
  const metricsByArm = {};
  for (const [armId, trials] of Object.entries(byArm)) {
    metricsByArm[armId] = {
      trials: trials.length,
      trialIds: trials.map(a => a.trialId).sort(),
      ...scoreDimensions(trials)
    };
  }
  const metricsByFamily = {};
  for (const [family, trials] of Object.entries(byFamily)) {
    metricsByFamily[family] = {};
    const armsInFamily = [...new Set(trials.map(a => a.armId))].sort();
    for (const armId of armsInFamily) {
      const subset = trials.filter(a => a.armId === armId);
      metricsByFamily[family][armId] = {
        trials: subset.length, ...scoreDimensions(subset)
      };
    }
  }

  const disqualifiers = evaluateHardDisqualifiers({ protocol, byArm, artifacts });
  const decision = applyFrozenDecisionRules({ protocol, disqualifiers, byArm });

  const report = {
    reportVersion: 1,
    scorerVersion: SCORER_VERSION,
    generatedFrom: 'frozen trial corpus only',
    protocolId: manifest.protocolId,
    protocolVersion: manifest.protocolVersion,
    manifestHash: manifest.manifestHash,
    repositoryCommit: header.repositoryCommit,
    scoredRunHash: header.runHeaderHash,
    corpusIntegrity: integrity,
    authorizedDimensions: AUTHORIZED_DIMENSIONS,
    trialCount: artifacts.length,
    exclusions,
    metricsByArm,
    metricsByFamily,
    hardDisqualifiers: disqualifiers,
    frozenDecision: decision,
    // The fixture phase never produces the final product decision on its own
    // when the protocol requires live evidence. That determination is recorded
    // here rather than inferred by a reader.
    finalProductDecision: manifest.mode === 'fixture'
      ? 'REQUIRES LIVE-MODEL MATRIX'
      : 'READY FROM FIXTURE EVIDENCE'
  };
  report.reportHash = hashCanonical(report);
  return Object.freeze(report);
}

module.exports = {
  AUTHORIZED_DIMENSIONS,
  SCORER_VERSION,
  ScorerError,
  applyFrozenDecisionRules,
  assertCorpusIntegrity,
  evaluateHardDisqualifiers,
  hashCanonical,
  scoreCorpus,
  scoreDimensions
};

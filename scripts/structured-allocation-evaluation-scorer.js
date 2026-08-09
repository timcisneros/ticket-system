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

// ── REAL-LIVE disqualifier contract ───────────────────────────────────────
//
// The immutable fixture report predates the live phase and must remain
// byte-identical. REAL live evidence has a stricter owner because the frozen
// prose is explicitly family-scoped and requires missing evidence to remain a
// third state. Keeping this as a separate exported function makes that
// distinction mechanical rather than an option a report caller can forget.
function familyOf(artifact) {
  const n = Number(artifact && artifact.family);
  return Number.isSafeInteger(n) ? n : null;
}

function artifactGroupsByFamily(artifacts) {
  const groups = new Map();
  for (const artifact of artifacts) {
    const family = familyOf(artifact);
    if (family === null) continue;
    if (!groups.has(family)) groups.set(family, []);
    groups.get(family).push(artifact);
  }
  return groups;
}

function resultOfDisqualifier({ statement, triggered = false, evaluable = true,
  reason = null, trials = [], families = [], notEvaluableKind = null }) {
  return {
    statement,
    result: !evaluable ? 'NOT EVALUABLE' : (triggered ? 'TRIGGERED' : 'NOT TRIGGERED'),
    notEvaluableReason: evaluable ? null : reason,
    notEvaluableKind: evaluable ? null : notEvaluableKind,
    contributingTrialIds: [...new Set(trials)].sort().slice(0, 50),
    contributingFamilies: [...new Set(families)].sort((a, b) => a - b)
  };
}

function liveAuthorityEvidence(artifact) {
  const missing = [];
  const violations = [];
  const report = artifact && artifact.ticketReport;
  const proof = artifact && artifact.pathProof;
  if (!report || typeof report !== 'object') missing.push('ticket report');
  if (!proof || typeof proof !== 'object') missing.push('path proof');
  if (missing.length > 0) return { missing, violations };

  if (report.secondReadIdentical !== true) {
    if (typeof report.secondReadIdentical !== 'boolean') missing.push('zero-drift result');
    else violations.push('read-only report drifted');
  }
  if (typeof report.productClaimsCompleted !== 'boolean') {
    missing.push('product completion claim');
  }
  if (typeof report.terminalTicketStatus !== 'string') missing.push('terminal Ticket status');
  if (typeof proof.ticketResultStatus !== 'string') missing.push('path Ticket status');
  if (typeof report.terminalTicketStatus === 'string' &&
      typeof proof.ticketResultStatus === 'string' &&
      report.terminalTicketStatus !== proof.ticketResultStatus) {
    violations.push('Ticket status disagrees across durable projections');
  }
  if (proof.ticketStatus !== undefined && proof.ticketStatus !== null &&
      proof.ticketStatus !== report.terminalTicketStatus) {
    violations.push('path ticketStatus disagrees with the Ticket report');
  }

  const authority = report.authority;
  if (!authority || typeof authority !== 'object') {
    missing.push('canonical completion authority');
  } else {
    if (authority.ticketStatus !== report.terminalTicketStatus) {
      violations.push('completion authority names another Ticket status');
    }
    for (const field of ['completionDecisionCount', 'completionDecidedEvents']) {
      if (!Number.isSafeInteger(authority[field]) || authority[field] < 0) {
        missing.push(field);
      }
    }
    if (typeof authority.anyRunCompleted !== 'boolean') missing.push('completed Run fact');
    if (report.productClaimsCompleted === true) {
      if (report.terminalTicketStatus !== 'completed' || authority.anyRunCompleted !== true ||
          authority.completionDecisionCount < 1 || authority.completionDecidedEvents < 1) {
        violations.push('completion is projected without its canonical decision authority');
      }
    } else if (report.terminalTicketStatus === 'completed') {
      violations.push('completed Ticket disagrees with the product completion claim');
    }
  }

  // Parent-policy parity is required only after a structured leaf path exists.
  // A legitimate planner refusal has no worker policy revision to compare and
  // must remain product data rather than becoming an authority violation.
  const hasStructuredLeaf = proof.observedPath === 'structured_v2' &&
    (proof.leafRunsAdmitted === true || Number(proof.governedLeafRunCount) > 0);
  if (hasStructuredLeaf && proof.sameParentPolicyRevision !== true) {
    if (typeof proof.sameParentPolicyRevision !== 'boolean') {
      missing.push('planner/leaf parent-policy parity');
    } else {
      violations.push('planner and leaf do not share a captured parent-policy revision');
    }
  }

  const reconciliation = proof.aggregateReconciliationAuthority;
  if (proof.aggregateReconciliationObserved === true) {
    if (!reconciliation || !Number.isSafeInteger(reconciliation.events) ||
        reconciliation.events < 1 ||
        typeof reconciliation.aggregateStatus !== 'string' ||
        typeof reconciliation.aggregateDecisionHash !== 'string') {
      violations.push('aggregate reconciliation is claimed without its durable authority');
    }
  } else if (reconciliation !== null && reconciliation !== undefined) {
    violations.push('aggregate reconciliation authority exists while observation says absent');
  }

  // A persisted progress block and its event are separately collected durable
  // projections. Either may be zero, but one may not claim a block while the
  // other says none occurred.
  const churn = report.churn;
  if (churn && typeof churn === 'object' &&
      Number.isSafeInteger(churn.persistedProgressBlocks) &&
      Number.isSafeInteger(churn.blockEvents) &&
      ((churn.persistedProgressBlocks > 0) !== (churn.blockEvents > 0))) {
    violations.push('progress block authority disagrees across durable projections');
  }
  return { missing, violations };
}

function liveCostCeilingEvidence(artifact) {
  const cost = artifact && artifact.normalizedCost;
  if (!cost || !Number.isSafeInteger(cost.totalNormalizedMicroUsd) ||
      cost.totalNormalizedMicroUsd < 0 ||
      !Number.isSafeInteger(cost.capturedEconomicCeilingMicroUsd) ||
      cost.capturedEconomicCeilingMicroUsd < 0 ||
      typeof cost.exceededCeiling !== 'boolean') {
    return { complete: false, exceeded: null };
  }
  const normalizedDerived =
    cost.totalNormalizedMicroUsd > cost.capturedEconomicCeilingMicroUsd;
  if (typeof cost.normalizedExceedsCeiling === 'boolean' &&
      cost.normalizedExceedsCeiling !== normalizedDerived) {
    return { complete: false, exceeded: null };
  }
  const durablePresent = Number.isSafeInteger(cost.durableGovernedMicroUsd) &&
    cost.durableGovernedMicroUsd >= 0;
  const durableDerived = durablePresent
    ? cost.durableGovernedMicroUsd > cost.capturedEconomicCeilingMicroUsd : false;
  if (durablePresent && typeof cost.durableGovernedExceedsCeiling === 'boolean' &&
      cost.durableGovernedExceedsCeiling !== durableDerived) {
    return { complete: false, exceeded: null };
  }
  const derived = normalizedDerived || durableDerived;
  if (cost.exceededCeiling !== derived) return { complete: false, exceeded: null };
  return { complete: true, exceeded: derived };
}

function evaluateLiveHardDisqualifiers({ protocol, byArm, artifacts }) {
  const statements = protocol.decisionThresholds.hardDisqualifiers;
  const groups = artifactGroupsByFamily(artifacts);
  const results = [];

  for (const statement of statements) {
    if (/false-positive completion rate higher than arm A/i.test(statement)) {
      const offenders = [];
      const offendingFamilies = [];
      const missing = [];
      for (const [family, trials] of groups) {
        const baseline = trials.filter(a => a.armId === 'A');
        const structuredArms = ['B', 'C'].map(armId => ({ armId,
          trials: trials.filter(a => a.armId === armId) }))
          .filter(entry => entry.trials.length > 0);
        if (structuredArms.length === 0) continue;
        if (baseline.length === 0) { missing.push(family); continue; }
        const rate = rows => rows.filter(
          a => a.truthfulness === 'false_positive_completion').length / rows.length;
        for (const structured of structuredArms) {
          if (rate(structured.trials) > rate(baseline)) {
            offendingFamilies.push(family);
            offenders.push(...structured.trials.filter(
              a => a.truthfulness === 'false_positive_completion').map(a => a.trialId));
          }
        }
      }
      results.push(resultOfDisqualifier({
        statement,
        triggered: offendingFamilies.length > 0,
        evaluable: offendingFamilies.length > 0 || missing.length === 0,
        reason: missing.length > 0
          ? `arm A evidence is absent for structured family/families ${missing.join(', ')}` : null,
        notEvaluableKind: 'comparison_unavailable',
        trials: offenders,
        families: offendingFamilies.length > 0 ? offendingFamilies : missing
      }));
      continue;
    }

    if (/authority violation/i.test(statement)) {
      const evidence = artifacts.map(artifact => ({ artifact,
        ...liveAuthorityEvidence(artifact) }));
      const missing = evidence.filter(entry => entry.missing.length > 0);
      const offenders = evidence.filter(entry => entry.violations.length > 0);
      results.push(resultOfDisqualifier({
        statement,
        triggered: offenders.length > 0,
        evaluable: offenders.length > 0 || missing.length === 0,
        reason: missing.length > 0
          ? `${missing.length} trial(s) lack required authority/zero-drift evidence` : null,
        notEvaluableKind: 'required_evidence_missing',
        trials: (offenders.length > 0 ? offenders : missing)
          .map(entry => entry.artifact.trialId),
        families: (offenders.length > 0 ? offenders : missing)
          .map(entry => familyOf(entry.artifact)).filter(Number.isSafeInteger)
      }));
      continue;
    }

    if (/uncontrolled cost/i.test(statement)) {
      const evidence = artifacts.map(artifact => ({ artifact,
        ...liveCostCeilingEvidence(artifact) }));
      const missing = evidence.filter(entry => !entry.complete);
      const offenders = evidence.filter(entry => entry.exceeded === true);
      results.push(resultOfDisqualifier({
        statement,
        triggered: offenders.length > 0,
        evaluable: offenders.length > 0 || missing.length === 0,
        reason: missing.length > 0
          ? `${missing.length} trial(s) lack a complete captured cost-ceiling comparison` : null,
        notEvaluableKind: 'required_evidence_missing',
        trials: (offenders.length > 0 ? offenders : missing)
          .map(entry => entry.artifact.trialId),
        families: (offenders.length > 0 ? offenders : missing)
          .map(entry => familyOf(entry.artifact)).filter(Number.isSafeInteger)
      }));
      continue;
    }

    if (/non-deterministic recovery/i.test(statement)) {
      const byEnvelope = new Map();
      for (const artifact of artifacts) {
        if (typeof artifact.envelopeHash !== 'string' || !artifact.pathProof ||
            typeof artifact.pathProof.ticketResultStatus !== 'string') continue;
        if (!byEnvelope.has(artifact.envelopeHash)) byEnvelope.set(artifact.envelopeHash, []);
        byEnvelope.get(artifact.envelopeHash).push(artifact);
      }
      const missing = artifacts.filter(artifact =>
        typeof artifact.envelopeHash !== 'string' || !artifact.pathProof ||
        typeof artifact.pathProof.ticketResultStatus !== 'string');
      const repeated = [...byEnvelope.values()].filter(rows => rows.length > 1);
      const divergent = repeated.filter(rows =>
        new Set(rows.map(a => a.pathProof.ticketResultStatus)).size > 1);
      results.push(resultOfDisqualifier({
        statement,
        triggered: divergent.length > 0,
        evaluable: divergent.length > 0 || (repeated.length > 0 && missing.length === 0),
        reason: missing.length > 0
          ? `${missing.length} trial(s) lack a recovery comparison envelope/status`
          : (repeated.length === 0
              ? 'no two trials share an identical comparison envelope' : null),
        notEvaluableKind: missing.length > 0
          ? 'required_evidence_missing' : 'comparison_unavailable',
        trials: (divergent.length > 0 ? divergent.flat() : missing).map(a => a.trialId),
        families: (divergent.length > 0 ? divergent.flat() : missing)
          .map(familyOf).filter(Number.isSafeInteger)
      }));
      continue;
    }

    if (/systematic churn misclassification/i.test(statement)) {
      const governed = artifacts.filter(a => a.armId === 'B' || a.armId === 'C');
      const missing = governed.filter(a => !a.churnFacts || !a.churnFacts.worker ||
        a.churnFacts.observationCompleteness !== 'complete' ||
        !Number.isSafeInteger(a.churnFacts.worker.durableResponses) ||
        !Number.isSafeInteger(a.churnFacts.worker.attemptedTransports) ||
        !(a.churnFacts.noProgressStreak === null ||
          Number.isSafeInteger(a.churnFacts.noProgressStreak)));
      const offenders = governed.filter(a => a.churnFacts && a.churnFacts.worker &&
        a.churnFacts.worker.durableResponses === 0 &&
        Number.isSafeInteger(a.churnFacts.noProgressStreak) &&
        a.churnFacts.noProgressStreak > 0);
      results.push(resultOfDisqualifier({
        statement,
        triggered: offenders.length > 0,
        evaluable: offenders.length > 0 || missing.length === 0,
        reason: missing.length > 0
          ? `${missing.length} governed trial(s) lack complete churn-boundary evidence` : null,
        notEvaluableKind: 'required_evidence_missing',
        trials: (offenders.length > 0 ? offenders : missing).map(a => a.trialId),
        families: (offenders.length > 0 ? offenders : missing).map(familyOf).filter(Number.isSafeInteger)
      }));
      continue;
    }

    results.push(resultOfDisqualifier({
      statement, evaluable: false, reason: 'no executable owner for this frozen statement'
    }));
  }
  return results;
}

function trialStats(trials) {
  const rateOf = label => trials.length === 0 ? null
    : trials.filter(a => a.truthfulness === label).length / trials.length;
  const latencyValues = trials.map(a => a.latency && a.latency.endToEndMs)
    .filter(Number.isFinite);
  const totalNormalized = trials.map(a =>
    a.normalizedCost && a.normalizedCost.totalNormalizedMicroUsd)
    .filter(Number.isFinite);
  const truthfulCount = trials.filter(
    a => a.truthfulness === 'true_positive_completion').length;
  return {
    trials: trials.length,
    truePositiveRate: rateOf('true_positive_completion'),
    falsePositiveRate: rateOf('false_positive_completion'),
    meanLatencyMs: latencyValues.length === trials.length && trials.length > 0
      ? latencyValues.reduce((a, b) => a + b, 0) / latencyValues.length : null,
    costPerTruthfulCompletion: totalNormalized.length === trials.length &&
      truthfulCount > 0
      ? totalNormalized.reduce((a, b) => a + b, 0) / truthfulCount : null
  };
}

function repetitionConsistency(trials) {
  const byCellArm = new Map();
  const missing = [];
  for (const trial of trials) {
    const completion = trial.ticketReport && trial.ticketReport.productClaimsCompleted;
    const cell = trial.cellId || `${trial.scenarioId || ''}|${trial.variantId || ''}`;
    if (typeof completion !== 'boolean' || !cell || typeof trial.armId !== 'string') {
      missing.push(trial.trialId);
      continue;
    }
    const key = `${cell}|${trial.armId}`;
    if (!byCellArm.has(key)) byCellArm.set(key, []);
    byCellArm.get(key).push(trial);
  }
  const inconsistent = [...byCellArm.values()].filter(rows =>
    new Set(rows.map(row => row.ticketReport.productClaimsCompleted)).size > 1);
  return {
    evaluable: missing.length === 0,
    consistent: missing.length === 0 && inconsistent.length === 0,
    missingTrialIds: missing.sort(),
    inconsistentTrialIds: inconsistent.flat().map(row => row.trialId).sort()
  };
}

function ratioWithin(value, baseline, maximum) {
  if (!Number.isFinite(value) || !Number.isFinite(baseline) || baseline < 0) {
    return { evaluable: false, passed: false, ratio: null };
  }
  if (baseline === 0) {
    return { evaluable: true, passed: value === 0, ratio: value === 0 ? 1 : null };
  }
  const ratio = value / baseline;
  return { evaluable: true, passed: ratio <= maximum, ratio };
}

function evaluateLiveOrdinaryDecision({ protocol, disqualifiers, byArm }) {
  const thresholds = protocol.decisionThresholds;
  const artifacts = Object.values(byArm).flat();
  const anyTriggered = disqualifiers.some(entry => entry.result === 'TRIGGERED');
  const hardNotEvaluable = disqualifiers.filter(entry => entry.result === 'NOT EVALUABLE');
  const structuredAll = [...(byArm.B || []), ...(byArm.C || [])];
  const legacyAll = [...(byArm.A2a || []), ...(byArm.A2b || [])];
  const aAll = byArm.A || [];
  const overall = {
    A: trialStats(aAll), A2: trialStats(legacyAll), structured: trialStats(structuredAll)
  };
  const gainA = overall.structured.truePositiveRate === null || overall.A.truePositiveRate === null
    ? null : (overall.structured.truePositiveRate - overall.A.truePositiveRate) * 100;
  const gainA2 = overall.structured.truePositiveRate === null || overall.A2.truePositiveRate === null
    ? null : (overall.structured.truePositiveRate - overall.A2.truePositiveRate) * 100;
  const overallCriteria = {
    gainVersusA: { thresholdPoints: thresholds.retain.truePositiveGainVersusAPoints,
      valuePoints: gainA, passed: gainA !== null &&
        gainA >= thresholds.retain.truePositiveGainVersusAPoints },
    gainVersusA2: { thresholdPoints: thresholds.retain.truePositiveGainVersusA2Points,
      valuePoints: gainA2, passed: gainA2 !== null &&
        gainA2 >= thresholds.retain.truePositiveGainVersusA2Points }
  };

  const grouped = artifactGroupsByFamily(artifacts);
  const families = {};
  for (const [family, rows] of grouped) {
    const A = trialStats(rows.filter(a => a.armId === 'A'));
    const A2 = trialStats(rows.filter(a => a.armId === 'A2a' || a.armId === 'A2b'));
    const structured = trialStats(rows.filter(a => a.armId === 'B' || a.armId === 'C'));
    const structuredByArm = ['B', 'C'].map(armId =>
      trialStats(rows.filter(a => a.armId === armId))).filter(stats => stats.trials > 0);
    const tpGainA = structured.truePositiveRate === null || A.truePositiveRate === null
      ? null : (structured.truePositiveRate - A.truePositiveRate) * 100;
    const tpGainA2 = structured.truePositiveRate === null || A2.truePositiveRate === null
      ? null : (structured.truePositiveRate - A2.truePositiveRate) * 100;
    const latency = ratioWithin(structured.meanLatencyMs, A.meanLatencyMs,
      thresholds.retain.maxLatencyRatioVersusA);
    const cost = ratioWithin(structured.costPerTruthfulCompletion,
      A.costPerTruthfulCompletion, thresholds.retain.maxCostRatioVersusA);
    const repetitions = repetitionConsistency(rows);
    families[family] = {
      A, A2, structured,
      truePositiveGainVersusAPoints: tpGainA,
      truePositiveGainVersusA2Points: tpGainA2,
      falsePositiveNoWorseThanA: structured.falsePositiveRate !== null &&
        A.falsePositiveRate !== null && structuredByArm.length > 0 &&
        structuredByArm.every(stats => stats.falsePositiveRate !== null &&
          stats.falsePositiveRate <= A.falsePositiveRate),
      truthfulnessNoWorse: structured.truePositiveRate !== null &&
        A.truePositiveRate !== null && A2.truePositiveRate !== null &&
        structured.truePositiveRate >= A.truePositiveRate &&
        structured.truePositiveRate >= A2.truePositiveRate,
      latencyRatioVersusA: latency,
      costRatioVersusA: cost,
      repetitionConsistency: repetitions
    };
  }

  const required = thresholds.retain.gainRequiredOnFamilies;
  const requiredFamilyCriteria = required.map(family => {
    const value = families[family] || null;
    return {
      family,
      evaluable: Boolean(value && value.truePositiveGainVersusAPoints !== null &&
        value.truePositiveGainVersusA2Points !== null &&
        value.latencyRatioVersusA.evaluable && value.costRatioVersusA.evaluable &&
        value.repetitionConsistency.evaluable && value.repetitionConsistency.consistent),
      gainVersusAPassed: Boolean(value &&
        value.truePositiveGainVersusAPoints >= thresholds.retain.truePositiveGainVersusAPoints),
      gainVersusA2Passed: Boolean(value &&
        value.truePositiveGainVersusA2Points >= thresholds.retain.truePositiveGainVersusA2Points),
      latencyPassed: Boolean(value && value.latencyRatioVersusA.passed),
      costPassed: Boolean(value && value.costRatioVersusA.passed),
      falsePositivePassed: Boolean(value && value.falsePositiveNoWorseThanA),
      truthfulnessNoWorse: Boolean(value && value.truthfulnessNoWorse)
    };
  });

  const comparableFamilies = Object.entries(families)
    .filter(([, value]) => value.truePositiveGainVersusAPoints !== null &&
      value.truePositiveGainVersusA2Points !== null &&
      value.repetitionConsistency.evaluable && value.repetitionConsistency.consistent);
  const noFamilyWorse = comparableFamilies.length > 0 && comparableFamilies.every(([, value]) =>
    value.truthfulnessNoWorse && value.falsePositiveNoWorseThanA);
  const falsePositiveNoWorse = comparableFamilies.length > 0 &&
    comparableFamilies.every(([, value]) => value.falsePositiveNoWorseThanA);
  const allRequiredPass = requiredFamilyCriteria.every(value => value.evaluable &&
    value.gainVersusAPassed && value.gainVersusA2Passed && value.latencyPassed &&
    value.costPassed && value.falsePositivePassed && value.truthfulnessNoWorse);
  const retain = !anyTriggered && hardNotEvaluable.length === 0 &&
    overallCriteria.gainVersusA.passed && overallCriteria.gainVersusA2.passed &&
    falsePositiveNoWorse && noFamilyWorse && allRequiredPass;

  // Frozen STOP hinge: at least one comparable family must improve truthful
  // completion by five points over both baselines while staying inside the
  // already-frozen latency and cost bounds. This is distinct from RETAIN's
  // stronger required-family contract.
  const qualifyingFamilies = comparableFamilies.filter(([, value]) =>
    value.truePositiveGainVersusAPoints >= 5 &&
    value.truePositiveGainVersusA2Points >= 5 &&
    value.latencyRatioVersusA.passed && value.costRatioVersusA.passed)
    .map(([family]) => Number(family));

  let ordinaryDecision;
  let basis;
  if (anyTriggered) {
    ordinaryDecision = 'STOP';
    basis = 'at least one frozen hard disqualifier TRIGGERED';
  } else if (retain) {
    ordinaryDecision = 'RETAIN';
    basis = 'every frozen overall, family, latency, cost and truthfulness criterion passed';
  } else if (qualifyingFamilies.length === 0) {
    ordinaryDecision = 'STOP';
    basis = 'no family met the frozen five-point truthfulness gain with latency and cost bounds';
  } else {
    ordinaryDecision = 'REVISE';
    basis = 'no hard veto and some family evidence is favorable, but RETAIN is not fully satisfied';
  }

  const decisionFamilies = ordinaryDecision === 'RETAIN'
    ? required
    : (qualifyingFamilies.length > 0
        ? qualifyingFamilies
        : comparableFamilies.map(([family]) => Number(family)));
  const ordinaryDrivingIds = artifacts
    .filter(artifact => decisionFamilies.includes(familyOf(artifact)))
    .map(artifact => artifact.trialId);
  const vetoDrivingIds = disqualifiers
    .filter(entry => entry.result === 'TRIGGERED')
    .flatMap(entry => entry.contributingTrialIds || []);

  return Object.freeze({
    ordinaryDecision,
    basis,
    gainVersusAPoints: gainA,
    gainVersusA2Points: gainA2,
    overallCriteria,
    requiredFamilyCriteria,
    families,
    noFamilyWorse,
    falsePositiveNoWorse,
    qualifyingFamilies,
    decisionDrivingFamilies: Object.freeze([...new Set(decisionFamilies)].sort((a, b) => a - b)),
    decisionDrivingTrialIds: Object.freeze([...new Set(
      vetoDrivingIds.length > 0 ? vetoDrivingIds : ordinaryDrivingIds)].sort()),
    hardDisqualifiersNotEvaluable: hardNotEvaluable.map(entry => entry.statement)
  });
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
  evaluateLiveHardDisqualifiers,
  evaluateLiveOrdinaryDecision,
  hashCanonical,
  scoreCorpus,
  scoreDimensions
};

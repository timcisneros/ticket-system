'use strict';

// Tranche 5 — verified progress as a HISTORICAL TRANSITION, derived from
// canonical evidence.
//
// THE DISTINCTION THIS MODULE EXISTS TO MAKE. "Satisfied" is a state; progress
// is a change of state. A fact the workspace already satisfied before the Run
// began was never advanced by this Run, and a fact observed satisfied for the
// fifth time advanced nothing on the fifth observation. Counting satisfied
// observations would credit both, which is why this walks ordered evidence and
// credits only the FIRST false-to-true transition after the baseline.
//
// EVERY INPUT IS A DURABLE ROW under an explicit cutoff. No caller supplies a
// satisfied-fact set; supplying one is exactly the hole this closes.
//
// INCOMPLETENESS IS NOT ZERO PROGRESS. If a receipt-bearing batch is missing a
// verdict for an admitted fact, this reports an integrity problem rather than an
// empty mapping — because "we did not record it" and "it did not advance" are
// different statements, and only one of them should stop a Run for churn.

const { compareCanonicalText, deepFreeze } = require('./declared-work-contract');
const {
  contentRecordOf
} = require('./governed-postcondition-evidence-contract');

const TRANSITION_REFUSALS = Object.freeze([
  'fact_baseline_incomplete',
  'fact_baseline_conflict',
  'fact_evidence_incomplete',
  'fact_evidence_foreign',
  'fact_evidence_window_ambiguous'
]);

class GovernedFactTransitionError extends Error {
  constructor(code, message, detail = {}) {
    super(message);
    this.name = 'GovernedFactTransitionError';
    this.code = code;
    this.detail = detail;
  }
}

function refuse(reason, message) {
  if (!TRANSITION_REFUSALS.includes(reason)) {
    throw new GovernedFactTransitionError('GOVERNED_FACT_TRANSITION_INVALID',
      `unsupported refusal: ${String(reason)}`);
  }
  throw new GovernedFactTransitionError(
    'GOVERNED_FACT_TRANSITION_REFUSED', message, { reason });
}

// ── The derivation ──────────────────────────────────────────────────────────
//
// `evidenceRows` must already be bounded by `postconditionEvidenceCutoff` and
// ordered by evidence identity; this does not re-read the database.

function buildGovernedSatisfiedFactTransitions({
  runId,
  allocationItemId,
  eligibleFacts = [],
  evidenceRows = [],
  // Batches that committed at least one receipt and therefore owed a complete
  // evidence set. Supplied by the store from durable receipts.
  receiptBearingBatches = []
}) {
  const eligible = eligibleFacts.map(fact => fact.declaredFactIdentity);
  const eligibleSet = new Set(eligible);

  const own = [];
  for (const row of evidenceRows) {
    const evidence = contentRecordOf(row);
    if (evidence.runId !== runId) {
      refuse('fact_evidence_foreign',
        `evidence for run ${evidence.runId} appeared while evaluating run ${runId}`);
    }
    if (allocationItemId !== null && allocationItemId !== undefined &&
        evidence.allocationItemId !== allocationItemId) {
      refuse('fact_evidence_foreign',
        'evidence for another allocation item cannot be credited');
    }
    // A fact outside the admitted catalog cannot be credited: the catalog is
    // immutable authority, and evidence naming something else is describing a
    // fact this Run was never admitted against.
    if (!eligibleSet.has(evidence.declaredFactIdentity)) continue;
    own.push({ ...evidence, evidenceId: row.evidenceId });
  }

  // ── Baseline completeness ─────────────────────────────────────────────────
  //
  // Exactly one baseline verdict per eligible fact. A MISSING baseline is not
  // "false": defaulting it would let a pre-existing satisfied fact be credited
  // as this Run's progress, which is the error the baseline exists to prevent.
  const baselineByFact = new Map();
  for (const evidence of own) {
    if (evidence.evaluationKind !== 'baseline') continue;
    const existing = baselineByFact.get(evidence.declaredFactIdentity);
    if (existing && existing.evidenceHash !== evidence.evidenceHash) {
      refuse('fact_baseline_conflict',
        `run ${runId} holds conflicting baselines for ${evidence.declaredFactIdentity}`);
    }
    baselineByFact.set(evidence.declaredFactIdentity, evidence);
  }
  const missingBaseline = eligible.filter(identity => !baselineByFact.has(identity));
  if (missingBaseline.length > 0) {
    refuse('fact_baseline_incomplete',
      `run ${runId} has no baseline verdict for ${missingBaseline.length} admitted ` +
      'fact(s); a missing baseline is an integrity problem, never an unsatisfied one');
  }

  const baselineSatisfied = eligible
    .filter(identity => baselineByFact.get(identity).satisfied);
  const baselineUnsatisfied = eligible
    .filter(identity => !baselineByFact.get(identity).satisfied);

  // ── Post-batch evidence, grouped into request windows ─────────────────────
  const byBatch = new Map();
  for (const evidence of own) {
    if (evidence.evaluationKind !== 'post_batch') continue;
    // The request identity is a pure function of the step; a row where they
    // disagree names a window that does not exist.
    const implied = `model-request:agent:${evidence.batchStepId}:provider`;
    if (evidence.requestSourceIdentity !== implied) {
      refuse('fact_evidence_window_ambiguous',
        `evidence names request ${evidence.requestSourceIdentity} in batch ` +
        `${evidence.batchStepId}, which implies ${implied}`);
    }
    const bucket = byBatch.get(evidence.batchStepId) || new Map();
    const prior = bucket.get(evidence.declaredFactIdentity);
    if (prior && prior.evidenceHash !== evidence.evidenceHash) {
      refuse('fact_evidence_window_ambiguous',
        `batch ${evidence.batchStepId} holds two different verdicts for ` +
        `${evidence.declaredFactIdentity}`);
    }
    bucket.set(evidence.declaredFactIdentity, evidence);
    byBatch.set(evidence.batchStepId, bucket);
  }

  // ── Completeness of every batch that owed evidence ────────────────────────
  //
  // A receipt-bearing batch owes one verdict per admitted fact. Fewer means the
  // writer did not finish, and treating that as "nothing advanced" would stop a
  // Run for churn it may not have committed.
  for (const batchStepId of receiptBearingBatches) {
    const bucket = byBatch.get(String(batchStepId));
    const recorded = bucket ? bucket.size : 0;
    if (recorded !== eligible.length) {
      refuse('fact_evidence_incomplete',
        `batch ${batchStepId} committed receipts but recorded ${recorded} of ` +
        `${eligible.length} admitted fact verdicts`);
    }
  }

  // ── Ordered transitions ───────────────────────────────────────────────────
  //
  // Walk windows in durable order. A fact is credited at most once, on its
  // first true reading after an unsatisfied baseline. A later true is a
  // continuing state, not a new advancement — including after a true → false →
  // true excursion, because the Run has already been credited for reaching it.
  const orderedBatches = [...byBatch.keys()]
    .sort((left, right) => Number(left) - Number(right));

  const creditedAt = new Map();
  const windows = [];
  const satisfiedSoFar = new Set(baselineSatisfied);

  for (const batchStepId of orderedBatches) {
    const bucket = byBatch.get(batchStepId);
    const newlySatisfied = [];
    const repeatedSatisfied = [];
    const unsatisfied = [];
    const supportingEvidenceIds = [];

    for (const identity of eligible) {
      const evidence = bucket.get(identity);
      if (!evidence) continue;
      supportingEvidenceIds.push(evidence.evidenceId);
      if (!evidence.satisfied) {
        unsatisfied.push(identity);
        continue;
      }
      if (creditedAt.has(identity) || satisfiedSoFar.has(identity)) {
        repeatedSatisfied.push(identity);
        continue;
      }
      creditedAt.set(identity, batchStepId);
      newlySatisfied.push(identity);
    }

    for (const identity of newlySatisfied) satisfiedSoFar.add(identity);

    windows.push(deepFreeze({
      batchStepId,
      requestSourceIdentity: `model-request:agent:${batchStepId}:provider`,
      throughOperationReceiptId: (() => {
        for (const identity of eligible) {
          const evidence = bucket.get(identity);
          if (evidence) return evidence.throughOperationReceiptId;
        }
        return null;
      })(),
      newlySatisfiedFactIdentities: deepFreeze(
        [...newlySatisfied].sort(compareCanonicalText)),
      repeatedSatisfiedFactIdentities: deepFreeze(
        [...repeatedSatisfied].sort(compareCanonicalText)),
      unsatisfiedFactIdentities: deepFreeze([...unsatisfied].sort(compareCanonicalText)),
      supportingEvidenceIds: deepFreeze([...supportingEvidenceIds].sort((a, b) => a - b))
    }));
  }

  // The mapping the existing progress evaluator consumes. Derived here from
  // canonical transitions — never accepted from an orchestration caller — and
  // keyed by the truthful through-receipt anchor of the window that earned the
  // credit, so window membership stays consistent with receipt ordering.
  const satisfiedFactIdentitiesByReceiptId = new Map();
  for (const window of windows) {
    if (window.newlySatisfiedFactIdentities.length === 0) continue;
    if (window.throughOperationReceiptId === null) continue;
    const existing =
      satisfiedFactIdentitiesByReceiptId.get(window.throughOperationReceiptId) || [];
    satisfiedFactIdentitiesByReceiptId.set(
      window.throughOperationReceiptId,
      [...existing, ...window.newlySatisfiedFactIdentities]);
  }

  return deepFreeze({
    runId,
    eligibleFactIdentities: deepFreeze([...eligible].sort(compareCanonicalText)),
    baselineSatisfiedFactIdentities: deepFreeze(
      [...baselineSatisfied].sort(compareCanonicalText)),
    baselineUnsatisfiedFactIdentities: deepFreeze(
      [...baselineUnsatisfied].sort(compareCanonicalText)),
    windows: deepFreeze(windows),
    // Facts this Run genuinely advanced, each exactly once.
    newlyVerifiedFactIdentities: deepFreeze(
      [...creditedAt.keys()].sort(compareCanonicalText)),
    creditedInBatch: deepFreeze(Object.fromEntries(creditedAt)),
    satisfiedFactIdentitiesByReceiptId
  });
}

module.exports = {
  GovernedFactTransitionError,
  TRANSITION_REFUSALS,
  buildGovernedSatisfiedFactTransitions
};

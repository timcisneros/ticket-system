'use strict';

// Tranche 5 — the admitted facts a governed structured leaf Run may earn
// verified-progress credit for.
//
// THIS IS NOT A SECOND CATALOG. Every fact here is read from the Run's own
// immutable `completionAuthoritySnapshot`, captured at admission and covered by
// its own `snapshotHash`. Nothing is reconstructed from current Ticket policy,
// so a policy edit after admission cannot change what a running Run is judged
// against — the same reason the progress-control policy is captured rather than
// consulted.
//
// IDENTITY IS ALREADY SETTLED, not invented here. For a typed postcondition the
// verified-progress contract uses `criterionHash` as the declared-fact identity,
// and `criterionHash` is the canonical hash of the postcondition declaration. So
// the identity this module reports is the identity `inventoryDeclaredFacts`
// reports for the same admitted fact — proved by test rather than assumed.

const { deepFreeze, hashCanonical } = require('./declared-work-contract');
const {
  CRITERION_EVALUATOR_IDENTITY,
  CRITERION_EVALUATOR_VERSION,
  EVALUABLE_CRITERION_TYPES
} = require('./postcondition-criterion-evaluator');

const ELIGIBLE_FACTS_REFUSALS = Object.freeze([
  'governed_facts_authority_missing',
  'governed_facts_empty'
]);

class GovernedEligibleFactsError extends Error {
  constructor(code, message, detail = {}) {
    super(message);
    this.name = 'GovernedEligibleFactsError';
    this.code = code;
    this.detail = detail;
  }
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

// The admitted execution-evaluable facts, in canonical order.
//
// Returns an empty list rather than throwing when a Run simply has no typed
// postconditions: whether that is acceptable is an ADMISSION decision, made once
// before scheduler visibility, not a judgement this reader should make on every
// evaluation.
function eligibleExecutionFacts(run) {
  if (!isPlainObject(run)) return deepFreeze([]);
  const snapshot = run.completionAuthoritySnapshot;
  if (!isPlainObject(snapshot) || !isPlainObject(snapshot.objectiveContract)) {
    return deepFreeze([]);
  }
  const contract = snapshot.objectiveContract;
  const declared = Array.isArray(contract.directPostconditions)
    ? contract.directPostconditions
    : [];

  const facts = [];
  const seen = new Set();
  for (const criterion of declared) {
    if (!isPlainObject(criterion) || typeof criterion.type !== 'string') continue;
    // Only what the unified evaluator can decide deterministically. An
    // unsupported class is skipped here rather than recorded as unsatisfied,
    // which would assert something nobody can check.
    if (!EVALUABLE_CRITERION_TYPES.includes(criterion.type)) continue;
    const identity = hashCanonical(criterion);
    if (seen.has(identity)) continue;
    seen.add(identity);
    facts.push(deepFreeze({
      // For a typed postcondition these are the same value by construction.
      declaredFactIdentity: identity,
      criterionHash: identity,
      criterionType: criterion.type,
      criterion: deepFreeze({ ...criterion }),
      completionAuthorityHash: snapshot.snapshotHash,
      objectiveContractHash: snapshot.objectiveContractHash,
      evaluatorIdentity: CRITERION_EVALUATOR_IDENTITY,
      evaluatorVersion: CRITERION_EVALUATOR_VERSION
    }));
  }
  return deepFreeze(facts);
}

function hasEligibleExecutionFacts(run) {
  return eligibleExecutionFacts(run).length > 0;
}

// Admission-time gate. A governed structured leaf Run with no execution-evaluable
// fact can never earn verified progress, so admitting it would guarantee it
// eventually stops with `verified_progress_exhausted` — a reason that would be
// false about the work. Refusing here, before the Run is ever schedulable, is
// the truthful alternative.
function assertGovernedRunHasEligibleFacts(run, label = 'governed leaf run') {
  const facts = eligibleExecutionFacts(run);
  if (facts.length === 0) {
    throw new GovernedEligibleFactsError(
      'GOVERNED_LEAF_NO_EVALUABLE_FACT',
      `${label} admits no execution-evaluable declared fact, so verified ` +
      'progress could never be credited for it',
      { reason: 'governed_facts_empty' }
    );
  }
  return facts;
}

module.exports = {
  ELIGIBLE_FACTS_REFUSALS,
  GovernedEligibleFactsError,
  assertGovernedRunHasEligibleFacts,
  eligibleExecutionFacts,
  hasEligibleExecutionFacts
};

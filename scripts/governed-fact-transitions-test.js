#!/usr/bin/env node
'use strict';

// Tranche 5 — verified progress is a historical TRANSITION, not a count of
// satisfied observations.
//
// The errors this suite exists to prevent are all the same shape: crediting a
// Run for a state it did not change. A fact already true before the Run began,
// a fact observed true for the fifth time, a fact that went true then false then
// true again — each would inflate progress and buy the Run more spending it did
// not earn.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const {
  buildGovernedSatisfiedFactTransitions
} = require('../runtime/governed-fact-transitions');
const {
  buildGovernedPostconditionEvidence
} = require('../runtime/governed-postcondition-evidence-contract');

const sha = text => crypto.createHash('sha256').update(String(text)).digest('hex');
const FACT_A = sha('{"path":"reports/a","type":"folder_exists"}');
const FACT_B = sha('{"path":"reports/b","type":"folder_exists"}');
const AUTH = sha('governed-authority');
const COMPLETION = sha('completion-authority');
const RUN = 5;
const ITEM = 9;

const eligibleFacts = identities => identities.map(identity => ({
  declaredFactIdentity: identity, criterionHash: identity,
  criterionType: 'folder_exists',
  criterion: { type: 'folder_exists', path: 'p' },
  completionAuthorityHash: COMPLETION,
  evaluatorIdentity: 'objective_contract', evaluatorVersion: 1
}));

let nextEvidenceId = 1;
const row = ({ identity, satisfied, kind = 'post_batch', step = null, anchor = null }) => ({
  evidenceId: nextEvidenceId++,
  ...buildGovernedPostconditionEvidence({
    ticketId: 3, runId: RUN, allocationPlanId: 7, allocationItemId: ITEM,
    governedAuthorityHash: AUTH, completionAuthorityHash: COMPLETION,
    declaredFactIdentity: identity, criterionHash: identity,
    criterionType: 'folder_exists',
    evaluatorIdentity: 'objective_contract', evaluatorVersion: 1,
    evaluationKind: kind,
    batchStepId: kind === 'baseline' ? null : String(step),
    requestSourceIdentity: kind === 'baseline'
      ? null : `model-request:agent:${step}:provider`,
    throughOperationReceiptId: kind === 'baseline' ? null : anchor,
    evaluatedReceiptCount: kind === 'baseline' ? 0 : 1,
    observedEvidence: { path: 'p', observedKind: satisfied ? 'folder' : 'absent' },
    verdict: {
      type: 'folder_exists', authority: 'objective_contract',
      passed: satisfied,
      reasonCode: satisfied ? 'POSTCONDITION_PASSED' : 'POSTCONDITION_EVALUATION_FAILED'
    }
  })
});

const derive = (evidenceRows, identities, batches = []) =>
  buildGovernedSatisfiedFactTransitions({
    runId: RUN, allocationItemId: ITEM,
    eligibleFacts: eligibleFacts(identities),
    evidenceRows, receiptBearingBatches: batches
  });

// ── Baseline false, then first satisfaction ─────────────────────────────────
{
  const result = derive([
    row({ identity: FACT_A, satisfied: false, kind: 'baseline' }),
    row({ identity: FACT_A, satisfied: true, step: 1, anchor: 10 })
  ], [FACT_A], ['1']);
  assert.deepEqual([...result.newlyVerifiedFactIdentities], [FACT_A],
    'the first false-to-true transition is credited');
  assert.deepEqual([...result.windows[0].newlySatisfiedFactIdentities], [FACT_A]);
  assert.deepEqual([...result.satisfiedFactIdentitiesByReceiptId.get(10)], [FACT_A],
    'the mapping is keyed by the window\'s truthful through-receipt anchor');
}

// ── Repeated satisfaction is not new progress ───────────────────────────────
{
  const result = derive([
    row({ identity: FACT_A, satisfied: false, kind: 'baseline' }),
    row({ identity: FACT_A, satisfied: true, step: 1, anchor: 10 }),
    row({ identity: FACT_A, satisfied: true, step: 2, anchor: 20 }),
    row({ identity: FACT_A, satisfied: true, step: 3, anchor: 30 })
  ], [FACT_A], ['1', '2', '3']);
  assert.deepEqual([...result.newlyVerifiedFactIdentities], [FACT_A],
    'one credit, however many times it is observed satisfied');
  assert.deepEqual([...result.windows[1].newlySatisfiedFactIdentities], []);
  assert.deepEqual([...result.windows[1].repeatedSatisfiedFactIdentities], [FACT_A]);
  assert.equal(result.satisfiedFactIdentitiesByReceiptId.has(20), false,
    'a repeated observation contributes nothing to the progress mapping');
}

// ── Pre-existing satisfaction is never this Run's progress ──────────────────
{
  const result = derive([
    row({ identity: FACT_A, satisfied: true, kind: 'baseline' }),
    row({ identity: FACT_A, satisfied: true, step: 1, anchor: 10 }),
    row({ identity: FACT_A, satisfied: true, step: 2, anchor: 20 })
  ], [FACT_A], ['1', '2']);
  assert.deepEqual([...result.baselineSatisfiedFactIdentities], [FACT_A]);
  assert.deepEqual([...result.newlyVerifiedFactIdentities], [],
    'a fact already true before the Run began is never credited to it');
  assert.equal(result.satisfiedFactIdentitiesByReceiptId.size, 0);
}

// ── false → true → false → true credits once ────────────────────────────────
{
  const result = derive([
    row({ identity: FACT_A, satisfied: false, kind: 'baseline' }),
    row({ identity: FACT_A, satisfied: true, step: 1, anchor: 10 }),
    row({ identity: FACT_A, satisfied: false, step: 2, anchor: 20 }),
    row({ identity: FACT_A, satisfied: true, step: 3, anchor: 30 })
  ], [FACT_A], ['1', '2', '3']);
  assert.deepEqual([...result.newlyVerifiedFactIdentities], [FACT_A]);
  assert.deepEqual([...result.windows[2].newlySatisfiedFactIdentities], [],
    'reaching the same state again is not a second advancement');
  assert.deepEqual([...result.windows[2].repeatedSatisfiedFactIdentities], [FACT_A]);
  assert.deepEqual([...result.windows[1].unsatisfiedFactIdentities], [FACT_A]);
}

// ── A second fact is credited on its own first transition ───────────────────
{
  const result = derive([
    row({ identity: FACT_A, satisfied: false, kind: 'baseline' }),
    row({ identity: FACT_B, satisfied: false, kind: 'baseline' }),
    row({ identity: FACT_A, satisfied: true, step: 1, anchor: 10 }),
    row({ identity: FACT_B, satisfied: false, step: 1, anchor: 10 }),
    row({ identity: FACT_A, satisfied: true, step: 2, anchor: 20 }),
    row({ identity: FACT_B, satisfied: true, step: 2, anchor: 20 })
  ], [FACT_A, FACT_B], ['1', '2']);
  assert.deepEqual([...result.windows[0].newlySatisfiedFactIdentities], [FACT_A]);
  assert.deepEqual([...result.windows[1].newlySatisfiedFactIdentities], [FACT_B],
    'the second fact is credited once, in its own window');
  assert.deepEqual([...result.windows[1].repeatedSatisfiedFactIdentities], [FACT_A],
    'and the first is not recounted');
  assert.equal(result.newlyVerifiedFactIdentities.length, 2);
}

// ── Incompleteness is an integrity problem, not zero progress ───────────────
{
  // Missing baseline. Defaulting it to false would let a pre-existing satisfied
  // fact be credited as this Run's work.
  assert.throws(() => derive([
    row({ identity: FACT_A, satisfied: true, step: 1, anchor: 10 })
  ], [FACT_A], ['1']),
  error => error.detail.reason === 'fact_baseline_incomplete',
  'a missing baseline refuses rather than defaulting to unsatisfied');

  // A receipt-bearing batch owing two verdicts but recording one.
  assert.throws(() => derive([
    row({ identity: FACT_A, satisfied: false, kind: 'baseline' }),
    row({ identity: FACT_B, satisfied: false, kind: 'baseline' }),
    row({ identity: FACT_A, satisfied: true, step: 1, anchor: 10 })
  ], [FACT_A, FACT_B], ['1']),
  error => error.detail.reason === 'fact_evidence_incomplete',
  'a partial evidence set refuses rather than reading as no progress');

  // A batch that committed no receipts owed nothing.
  const noBatch = derive([
    row({ identity: FACT_A, satisfied: false, kind: 'baseline' })
  ], [FACT_A], []);
  assert.deepEqual([...noBatch.newlyVerifiedFactIdentities], [],
    'a Run with no receipt-bearing batch simply has no credit yet');
}

// ── Foreign authority is refused, not silently dropped ──────────────────────
{
  // A genuinely-hashed row belonging to a different Run. Editing a row's runId
  // would be caught earlier by the evidence hash — that invariant belongs to the
  // evidence contract — so this builds a real foreign record to reach the
  // transition derivation's own check.
  const foreign = {
    evidenceId: 999,
    ...buildGovernedPostconditionEvidence({
      ticketId: 3, runId: 999, allocationPlanId: 7, allocationItemId: ITEM,
      governedAuthorityHash: AUTH, completionAuthorityHash: COMPLETION,
      declaredFactIdentity: FACT_A, criterionHash: FACT_A,
      criterionType: 'folder_exists',
      evaluatorIdentity: 'objective_contract', evaluatorVersion: 1,
      evaluationKind: 'post_batch', batchStepId: '1',
      requestSourceIdentity: 'model-request:agent:1:provider',
      throughOperationReceiptId: 10, evaluatedReceiptCount: 1,
      observedEvidence: { path: 'p', observedKind: 'folder' },
      verdict: { type: 'folder_exists', authority: 'objective_contract',
        passed: true, reasonCode: 'POSTCONDITION_PASSED' }
    })
  };
  assert.throws(() => buildGovernedSatisfiedFactTransitions({
    runId: RUN, allocationItemId: ITEM,
    eligibleFacts: eligibleFacts([FACT_A]),
    evidenceRows: [
      row({ identity: FACT_A, satisfied: false, kind: 'baseline' }),
      foreign
    ],
    receiptBearingBatches: ['1']
  }), error => error.detail.reason === 'fact_evidence_foreign',
  'evidence from another Run is an integrity failure');
}

// ── Evidence outside the admitted catalog is ignored, never credited ────────
{
  const result = derive([
    row({ identity: FACT_A, satisfied: false, kind: 'baseline' }),
    row({ identity: FACT_A, satisfied: true, step: 1, anchor: 10 }),
    row({ identity: FACT_B, satisfied: true, step: 1, anchor: 10 })
  ], [FACT_A], ['1']);
  assert.deepEqual([...result.newlyVerifiedFactIdentities], [FACT_A],
    'a fact outside the immutable catalog earns no credit');
}

console.log('governed fact transitions test passed');

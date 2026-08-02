#!/usr/bin/env node
'use strict';

// Tranche 5 — the admitted facts a governed leaf Run may earn credit for come
// from its own immutable completion authority, and nowhere else.

const assert = require('node:assert/strict');
const {
  assertGovernedRunHasEligibleFacts,
  eligibleExecutionFacts,
  hasEligibleExecutionFacts
} = require('../runtime/governed-eligible-facts');
const {
  buildCompletionAuthoritySnapshot
} = require('../runtime/completion-decision-contract');
const {
  buildLeafDeclaredWorkSnapshot
} = require('../runtime/structured-allocation-leaf-run-contract');
const { inventoryDeclaredFacts } = require('../runtime/verified-progress-contract');

const authorityFor = postconditions => buildCompletionAuthoritySnapshot({
  objective: 'Create folder reports/a',
  kind: postconditions.length > 0 ? 'deterministic' : 'unrecognized',
  recognized: postconditions.length > 0,
  intent: postconditions.length > 0 ? 'create_folder' : 'model_driven',
  completionPolicy: postconditions.length > 0
    ? 'declared_postconditions' : 'explicit_evidence_required',
  directPostconditions: postconditions,
  verificationPolicy: 'when_declared',
  capturedAt: new Date().toISOString()
});

const runWith = postconditions => ({
  id: 5, ticketId: 3, allocationPlanId: 7,
  leafRunBinding: { allocationItemId: 9 },
  governedExecution: { progressControlPolicy: { policyHash: 'a'.repeat(64) } },
  completionAuthoritySnapshot: authorityFor(postconditions)
});

// ── Facts come from captured authority ──────────────────────────────────────
const facts = eligibleExecutionFacts(runWith([{ type: 'folder_exists', path: 'reports/a' }]));
assert.equal(facts.length, 1, 'the admitted typed postcondition is eligible');
assert.equal(facts[0].criterionType, 'folder_exists');
assert.equal(facts[0].declaredFactIdentity, facts[0].criterionHash,
  'declaredFactIdentity IS the criterion hash for a typed postcondition');
assert.match(facts[0].completionAuthorityHash, /^[0-9a-f]{64}$/);
assert.equal(facts[0].evaluatorIdentity, 'objective_contract');
assert.equal(facts[0].evaluatorVersion, 1);

// ── The identity agrees with the verified-progress contract ─────────────────
//
// Two authorities naming the same admitted fact differently would credit
// progress against an identity nothing else recognizes.
{
  const P = 'validated-model-contract';
  const item = {
    allocationItemId: 1,
    objective: { text: 'Create folder reports/a', provenance: P },
    expectedOutputs: [{ kind: 'text', declaration: 'A folder', provenance: P }],
    successCriteria: [], evidenceRequirements: [],
    ownedOutputPaths: ['reports/a/'], assignedAgentId: 1
  };
  const authority = authorityFor([{ type: 'folder_exists', path: 'reports/a' }]);
  const snapshot = buildLeafDeclaredWorkSnapshot(item, {
    sharedConstraints: [], completionAuthoritySnapshot: authority
  });
  const declared = inventoryDeclaredFacts(snapshot)
    .filter(fact => fact.kind === 'typed_postcondition')
    .map(fact => fact.identity);
  const eligible = eligibleExecutionFacts({ ...runWith([]),
    completionAuthoritySnapshot: authority }).map(fact => fact.declaredFactIdentity);
  assert.deepEqual(eligible, declared,
    'the eligible catalog and the declared-work inventory name the same fact');
}

// ── Unsupported criterion classes ───────────────────────────────────────────
//
// ATTRIBUTION: the completion-authority contract already refuses a
// direct postcondition class it does not support, so such a criterion can never
// reach captured authority in the first place. That is the real invariant owner.
assert.throws(() => authorityFor([{ type: 'fileExists', id: 'x', path: 'r.md' }]),
  /type is unsupported/,
  'the completion authority contract owns direct-postcondition class support');

// The catalog filter is defence in depth for authority that somehow carries a
// class the unified evaluator cannot decide: it is skipped, never recorded as
// unsatisfied, which would assert something nobody can check.
assert.equal(eligibleExecutionFacts({
  ...runWith([]),
  completionAuthoritySnapshot: {
    version: 1,
    snapshotHash: 'b'.repeat(64),
    objectiveContractHash: 'c'.repeat(64),
    objectiveContract: {
      directPostconditions: [{ type: 'jsonPathEquals', path: 'r.json' }]
    }
  }
}).length, 0, 'a class the unified evaluator cannot decide is not eligible');
assert.equal(eligibleExecutionFacts(runWith([
  { type: 'folder_exists', path: 'reports/a' },
  { type: 'path_absent', path: 'tmp/x' }
])).length, 2, 'both execution-evaluable classes are eligible');

// Duplicates: ATTRIBUTION again — the completion-authority contract already
// refuses duplicated objective postconditions, so captured authority cannot
// contain the same admitted fact twice.
assert.throws(() => authorityFor([
  { type: 'folder_exists', path: 'reports/a' },
  { type: 'folder_exists', path: 'reports/a' }
]), /deduplicated/, 'the completion authority contract owns deduplication');

// ── Non-governed and historical Runs project nothing ────────────────────────
assert.deepEqual([...eligibleExecutionFacts({ id: 1, ticketId: 1 })], []);
assert.deepEqual([...eligibleExecutionFacts(null)], []);
assert.equal(hasEligibleExecutionFacts(runWith([])), false);

// ── Admission refuses an empty eligible catalog ─────────────────────────────
//
// Such a Run could never be credited with verified progress, so it would
// eventually stop with a reason that was false about its work.
assert.throws(() => assertGovernedRunHasEligibleFacts(runWith([])),
  error => error.code === 'GOVERNED_LEAF_NO_EVALUABLE_FACT',
  'a governed leaf Run with no execution-evaluable fact is refused');
assert.ok(assertGovernedRunHasEligibleFacts(
  runWith([{ type: 'folder_exists', path: 'reports/a' }])),
'a Run with an evaluable fact is admitted');

console.log('governed eligible facts test passed');

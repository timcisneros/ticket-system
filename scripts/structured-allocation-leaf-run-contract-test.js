#!/usr/bin/env node
'use strict';

// Tranche 3 deterministic contract suite for runtime/structured-allocation-leaf-run-contract.
//
// Pure behavior only: no database, no server, no provider. Every value under
// test is a function of admitted authority plus runtime-assigned Run identity
// plus persisted Run facts, so this suite fully determines the module before any
// production wiring depends on it.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  AGGREGATE_DECISION_FIELDS,
  AGGREGATE_ITEM_FIELDS,
  AGGREGATE_PLAN_DECISION_VERSION,
  LEAF_ADMISSION_MESSAGES,
  LEAF_ADMISSION_REFUSALS,
  LEAF_ADMISSION_STATES,
  LEAF_ITEM_DISPOSITION_REASONS,
  LEAF_ITEM_STATUSES,
  LEAF_RUN_BINDING_FIELDS,
  LEAF_RUN_BINDING_VERSION,
  StructuredAllocationLeafRunError,
  aggregateStatusFromItems,
  assertLeafBindingMatchesItem,
  assertLeafBindingSetComplete,
  assertLeafItemCompletionAuthoritySupported,
  buildAggregatePlanDecision,
  buildLeafDeclaredWorkSnapshot,
  buildLeafRunBinding,
  deriveLeafItemDisposition,
  evaluateRunCompletionEvidence,
  COMPLETION_EVIDENCE_RESULTS,
  COMPLETION_BINDING_RESULTS,
  normalizeAggregatePlanDecision,
  normalizeLeafRunBinding,
  projectStructuredAllocationLeafExecution,
  refuseLeafAdmission
} = require('../runtime/structured-allocation-leaf-run-contract');
const {
  ALLOCATION_ITEM_STATUSES,
  buildAllocationPlanV2
} = require('../runtime/allocation-plan-contract');
const {
  canonicalJson,
  hashCanonical,
  normalizeDeclaredWorkSnapshot
} = require('../runtime/declared-work-contract');
const {
  COMPLETION_DISPOSITIONS,
  buildCompletionAuthoritySnapshot
} = require('../runtime/completion-decision-contract');
const {
  assertDeclaredWorkCompletionAuthorityBinding
} = require('../runtime/declared-work-contract');

const MODEL_PROVENANCE = 'validated-model-contract';
const ATTEMPT_ID = '3f1d6c58-4a2b-4a1e-9f7c-5b8e2d0a6c41';
const ADMISSION_HASH = 'a'.repeat(64);
const ADMITTED_AT = '2026-07-31T00:00:00.000Z';

function textCriterion(declaration, provenance = MODEL_PROVENANCE) {
  return { kind: 'text', declaration, provenance };
}

function typedCriterion(postcondition, provenance = MODEL_PROVENANCE) {
  const declaration = canonicalJson(postcondition);
  return {
    kind: 'typed-postcondition',
    criterionType: postcondition.type,
    declaration,
    criterionHash: hashCanonical(postcondition),
    provenance
  };
}

function evidenceFor(criterion) {
  return {
    kind: 'postcondition-evidence',
    criterionHash: criterion.criterionHash,
    evidenceType: 'deterministic-postcondition-result',
    provenance: criterion.provenance
  };
}

// A parent declaration broad enough that every item below stays within it: the
// allocation-plan contract refuses any item capability the parent lacks.
function parentDeclaredWork() {
  return normalizeDeclaredWorkSnapshot({
    version: 1,
    objective: { text: 'Produce one findings report per owned folder', provenance: 'ticket-authored' },
    expectedOutputs: [
      { kind: 'text', declaration: 'One findings report per owned folder', provenance: 'ticket-authored' }
    ],
    successCriteria: [
      textCriterion('Every report records concrete findings', 'ticket-authored')
    ],
    evidenceRequirements: [],
    contractHash: '0'.repeat(64)
  }, { build: true });
}

function itemDraft(agentId, root, extraCriteria = []) {
  return {
    assignedAgentId: agentId,
    ownedOutputPaths: [`${root}/`],
    objective: { text: `Review ${root} and record findings`, provenance: MODEL_PROVENANCE },
    expectedOutputs: [
      { kind: 'text', declaration: `Findings report for ${root}`, provenance: MODEL_PROVENANCE }
    ],
    successCriteria: [textCriterion(`Report for ${root} names one finding`), ...extraCriteria],
    evidenceRequirements: extraCriteria
      .filter(criterion => criterion.kind === 'typed-postcondition')
      .map(evidenceFor)
  };
}

function plan({ sharedConstraints = [], extraCriteria = [] } = {}) {
  return buildAllocationPlanV2({
    version: 2,
    id: 900,
    ticketId: 700,
    mode: 'owned_paths',
    parentDeclaredWorkSnapshot: parentDeclaredWork(),
    sharedConstraints,
    items: [
      { ...itemDraft(11, 'reports/alpha', extraCriteria), allocationItemId: 501 },
      { ...itemDraft(12, 'reports/beta'), allocationItemId: 502 }
    ]
  });
}

function bindingFor(admittedPlan, item, runId, overrides = {}) {
  return buildLeafRunBinding({
    ticketId: admittedPlan.ticketId,
    allocationPlanId: admittedPlan.id,
    planHash: admittedPlan.planHash,
    allocationItemId: item.allocationItemId,
    assignedAgentId: item.assignedAgentId,
    itemDeclaredWorkHash: buildLeafDeclaredWorkSnapshot(item, {
      sharedConstraints: admittedPlan.sharedConstraints
    }).contractHash,
    ownedOutputPaths: item.ownedOutputPaths,
    parentDeclaredWorkHash: admittedPlan.parentDeclaredWorkSnapshot.contractHash,
    planningAttemptId: ATTEMPT_ID,
    planningAdmissionHash: ADMISSION_HASH,
    runId,
    admittedAt: ADMITTED_AT,
    ...overrides
  });
}

function decisionFor(runId, ticketId, disposition, authorityHash, hashSeed = 'd') {
  return {
    runId,
    ticketId,
    completionDisposition: disposition,
    objectiveContractHash: authorityHash,
    decisionHash: hashSeed.repeat(64).slice(0, 64)
  };
}

function refusalReason(fn) {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof StructuredAllocationLeafRunError, 'refusals use the module error');
    assert.equal(error.code, 'STRUCTURED_ALLOCATION_LEAF_ADMISSION_REFUSED');
    return error.reason;
  }
  return assert.fail('expected a leaf-admission refusal');
}

function invalid(fn, expectedCode = null) {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof StructuredAllocationLeafRunError, 'validation uses the module error');
    if (expectedCode) assert.equal(error.code, expectedCode);
    return error;
  }
  return assert.fail('expected a contract violation');
}

// ── Vocabulary is reused, not invented ──────────────────────────────────────

assert.deepEqual(LEAF_ITEM_STATUSES, ALLOCATION_ITEM_STATUSES,
  'leaf item status vocabulary is the existing allocation item vocabulary');
assert.equal(LEAF_ITEM_STATUSES.includes('blocked'), false,
  'Tranche 3 invents no item-level blocked state');
assert.deepEqual(
  [...LEAF_ADMISSION_REFUSALS].sort(),
  [...new Set(LEAF_ADMISSION_REFUSALS)].sort(),
  'refusal codes are unique'
);
for (const reason of LEAF_ADMISSION_REFUSALS) {
  assert.equal(typeof LEAF_ADMISSION_MESSAGES[reason], 'string',
    `refusal ${reason} carries a message`);
}
assert.deepEqual(Object.keys(LEAF_ADMISSION_MESSAGES).sort(), [...LEAF_ADMISSION_REFUSALS].sort(),
  'the message table and the refusal vocabulary are the same closed set');
assert.equal(refusalReason(() => refuseLeafAdmission('leaf_route_refused')), 'leaf_route_refused');
invalid(() => refuseLeafAdmission('not_a_real_reason'),
  'STRUCTURED_ALLOCATION_LEAF_RUN_INVALID');

// ── Declared work comes from the item, never the ticket ─────────────────────

const shared = [textCriterion('Stay inside your own owned folder')];
const admitted = plan({ sharedConstraints: shared });
const [alpha, beta] = admitted.items;

const alphaDeclared = buildLeafDeclaredWorkSnapshot(alpha, {
  sharedConstraints: admitted.sharedConstraints
});
assert.equal(alphaDeclared.objective.text, alpha.objective.text,
  'the leaf objective is the item objective');
assert.notEqual(alphaDeclared.objective.text, admitted.parentDeclaredWorkSnapshot.objective.text,
  'the leaf objective is not the parent ticket objective');
assert.notEqual(alphaDeclared.contractHash, admitted.parentDeclaredWorkSnapshot.contractHash,
  'the leaf declared work is a distinct contract from the parent');
assert.deepEqual(
  alphaDeclared.expectedOutputs.map(output => output.declaration),
  alpha.expectedOutputs.map(output => output.declaration),
  'expected outputs are the item expected outputs'
);
assert.equal(
  alphaDeclared.successCriteria.some(criterion =>
    criterion.declaration === shared[0].declaration),
  true,
  'admitted plan-level shared constraints are carried onto every leaf'
);
assert.notEqual(
  buildLeafDeclaredWorkSnapshot(alpha, { sharedConstraints: [] }).contractHash,
  alphaDeclared.contractHash,
  'shared constraints are part of the leaf declared-work identity'
);
assert.notEqual(alphaDeclared.contractHash,
  buildLeafDeclaredWorkSnapshot(beta, { sharedConstraints: admitted.sharedConstraints }).contractHash,
  'sibling items have distinct declared work');
assert.equal(
  buildLeafDeclaredWorkSnapshot(alpha, { sharedConstraints: admitted.sharedConstraints }).contractHash,
  alphaDeclared.contractHash,
  'leaf declared work is deterministic'
);
assert.equal(Object.isFrozen(alphaDeclared), true, 'leaf declared work is frozen');
assert.equal(Object.isFrozen(alphaDeclared.successCriteria), true,
  'leaf declared work is deeply frozen');
assert.equal(
  canonicalJson(alphaDeclared).includes('allocationSubtask'),
  false,
  'no generic v1 allocation subtask appears in leaf declared work'
);

// A planner that restates a shared constraint inside its item must not make the
// leaf undeclarable: normalizeArray() rejects duplicate declarations outright.
const restating = plan({
  sharedConstraints: shared,
  extraCriteria: [textCriterion('Stay inside your own owned folder')]
});
const restated = buildLeafDeclaredWorkSnapshot(restating.items[0], {
  sharedConstraints: restating.sharedConstraints
});
assert.equal(
  restated.successCriteria.filter(criterion =>
    criterion.declaration === shared[0].declaration).length,
  1,
  'a restated shared constraint is carried exactly once'
);

// The leaf Run's own completion authority is projected through the same
// canonical builder every other Run uses, so declared typed criteria and
// admitted completion criteria are the same set in both directions.
const authoritySnapshot = buildCompletionAuthoritySnapshot({
  objective: alpha.objective.text,
  kind: 'deterministic',
  recognized: true,
  intent: 'create_folder',
  completionPolicy: 'declared_postconditions',
  directPostconditions: [{ type: 'folder_exists', path: 'reports/alpha' }],
  verificationPolicy: 'when_declared',
  capturedAt: ADMITTED_AT
});
const boundLeaf = buildLeafDeclaredWorkSnapshot(alpha, {
  sharedConstraints: admitted.sharedConstraints,
  completionAuthoritySnapshot: authoritySnapshot
});
assert.equal(boundLeaf.objective.text, alpha.objective.text,
  'runtime completion authority does not replace the item objective');
assert.equal(boundLeaf.objective.provenance, MODEL_PROVENANCE,
  'the item objective keeps its own provenance');
assert.equal(
  boundLeaf.successCriteria.filter(criterion =>
    criterion.kind === 'typed-postcondition').length,
  1,
  'the run completion authority contributes its deterministic postcondition'
);
assert.equal(
  boundLeaf.successCriteria.find(criterion => criterion.kind === 'typed-postcondition').provenance,
  'deterministic-objective-contract',
  'runtime-derived typed criteria are never promoted to model provenance'
);
assert.equal(boundLeaf.evidenceRequirements.length, 1,
  'one evidence requirement per typed criterion');
assertDeclaredWorkCompletionAuthorityBinding({
  declaredWorkSnapshot: boundLeaf,
  completionAuthoritySnapshot: authoritySnapshot,
  verificationContractSnapshot: null
});
assert.notEqual(boundLeaf.contractHash, alphaDeclared.contractHash,
  'the leaf declared-work identity covers its completion authority');
// A leaf with no deterministic authority binds just as cleanly.
assertDeclaredWorkCompletionAuthorityBinding({
  declaredWorkSnapshot: alphaDeclared,
  completionAuthoritySnapshot: buildCompletionAuthoritySnapshot({
    objective: alpha.objective.text,
    kind: 'unrecognized',
    recognized: false,
    intent: 'model_driven',
    completionPolicy: 'explicit_evidence_required',
    directPostconditions: [],
    verificationPolicy: 'when_declared',
    capturedAt: ADMITTED_AT
  }),
  verificationContractSnapshot: null
});

invalid(() => buildLeafDeclaredWorkSnapshot(alpha, { sharedConstraints: 'nope' }));
invalid(() => buildLeafDeclaredWorkSnapshot(alpha, {
  sharedConstraints: [{ kind: 'typed-postcondition', declaration: '{}', provenance: MODEL_PROVENANCE }]
}));

// ── Model-proposed typed criteria refuse the whole admission ────────────────

const typed = typedCriterion({ id: 'alpha-report', type: 'fileExists', path: 'reports/alpha/report.md' });
const typedPlanItem = {
  ...itemDraft(11, 'reports/alpha', [typed]),
  allocationItemId: 501
};
assert.equal(
  refusalReason(() => assertLeafItemCompletionAuthoritySupported(typedPlanItem)),
  'leaf_item_typed_criteria_unsupported',
  'a model-provenance typed criterion refuses leaf admission'
);
assert.equal(
  refusalReason(() => buildLeafDeclaredWorkSnapshot(typedPlanItem, { sharedConstraints: [] })),
  'leaf_item_typed_criteria_unsupported',
  'declared-work projection cannot silently drop or convert the criterion'
);
// Every non-model provenance is refused too: no per-item subset of parent
// completion authority can bind, so there is no provenance-promotion path.
for (const provenance of ['workflow-defined', 'deterministic-objective-contract']) {
  const criterion = typedCriterion(
    { id: 'alpha-report', type: 'fileExists', path: 'reports/alpha/report.md' },
    provenance
  );
  assert.equal(
    refusalReason(() => assertLeafItemCompletionAuthoritySupported({
      ...itemDraft(11, 'reports/alpha', [criterion]),
      allocationItemId: 501
    })),
    'leaf_item_typed_criteria_unsupported',
    `${provenance} typed criteria are refused rather than promoted`
  );
}
assert.equal(
  assertLeafItemCompletionAuthoritySupported(alpha).allocationItemId,
  alpha.allocationItemId,
  'a text-only item passes preflight unchanged'
);

// ── Leaf-run binding ────────────────────────────────────────────────────────

const alphaBinding = bindingFor(admitted, alpha, 3001);
const betaBinding = bindingFor(admitted, beta, 3002);

assert.deepEqual(Object.keys(alphaBinding).sort(), [...LEAF_RUN_BINDING_FIELDS].sort(),
  'the binding is exactly its closed schema');
assert.equal(alphaBinding.version, LEAF_RUN_BINDING_VERSION);
assert.equal(alphaBinding.ticketId, admitted.ticketId);
assert.equal(alphaBinding.allocationPlanId, admitted.id);
assert.equal(alphaBinding.planHash, admitted.planHash);
assert.equal(alphaBinding.allocationItemId, alpha.allocationItemId);
assert.equal(alphaBinding.assignedAgentId, alpha.assignedAgentId);
assert.equal(alphaBinding.itemDeclaredWorkHash, alphaDeclared.contractHash);
assert.deepEqual(alphaBinding.ownedOutputPaths, alpha.ownedOutputPaths,
  'the binding carries the exact admitted ownership');
assert.equal(alphaBinding.parentDeclaredWorkHash,
  admitted.parentDeclaredWorkSnapshot.contractHash);
assert.equal(alphaBinding.planningAttemptId, ATTEMPT_ID);
assert.equal(alphaBinding.planningAdmissionHash, ADMISSION_HASH);
assert.equal(alphaBinding.runId, 3001);
assert.equal(Object.isFrozen(alphaBinding), true, 'the binding is frozen');
assert.equal(Object.isFrozen(alphaBinding.ownedOutputPaths), true,
  'the binding is deeply frozen');
assert.notEqual(alphaBinding.bindingHash, betaBinding.bindingHash,
  'sibling bindings have distinct hashes');
assert.equal(bindingFor(admitted, alpha, 3001).bindingHash, alphaBinding.bindingHash,
  'binding hashing is deterministic');

// Every identity field participates in the hash, so no binding can be
// transplanted onto another ticket, plan, item, agent or run.
for (const [field, value] of [
  ['ticketId', 701],
  ['allocationPlanId', 901],
  ['allocationItemId', 599],
  ['assignedAgentId', 99],
  ['runId', 3999],
  ['planHash', 'b'.repeat(64)],
  ['itemDeclaredWorkHash', 'c'.repeat(64)],
  ['parentDeclaredWorkHash', 'd'.repeat(64)],
  ['planningAdmissionHash', 'e'.repeat(64)],
  ['planningAttemptId', '00000000-0000-4000-8000-000000000000'],
  ['admittedAt', '2026-07-31T00:00:01.000Z']
]) {
  const mutated = bindingFor(admitted, alpha, 3001, { [field]: value });
  assert.notEqual(mutated.bindingHash, alphaBinding.bindingHash,
    `${field} participates in the binding hash`);
}
const pathMutated = buildLeafRunBinding({ ...alphaBinding, ownedOutputPaths: ['reports/gamma/'] });
assert.notEqual(pathMutated.bindingHash, alphaBinding.bindingHash,
  'ownedOutputPaths participate in the binding hash');

assert.equal(normalizeLeafRunBinding(alphaBinding).bindingHash, alphaBinding.bindingHash);
assert.equal(
  normalizeLeafRunBinding(JSON.parse(JSON.stringify(alphaBinding))).bindingHash,
  alphaBinding.bindingHash,
  'a binding survives a JSONB round trip'
);
invalid(() => normalizeLeafRunBinding({ ...alphaBinding, bindingHash: 'f'.repeat(64) }));
invalid(() => normalizeLeafRunBinding({ ...alphaBinding, extra: 1 }));
for (const field of LEAF_RUN_BINDING_FIELDS) {
  const partial = { ...alphaBinding };
  delete partial[field];
  invalid(() => normalizeLeafRunBinding(partial));
}
invalid(() => normalizeLeafRunBinding({ ...alphaBinding, version: 2 }));
invalid(() => normalizeLeafRunBinding(alphaBinding, { expectedRunId: 3002 }));
invalid(() => normalizeLeafRunBinding(alphaBinding, { expectedTicketId: 701 }));
invalid(() => normalizeLeafRunBinding(alphaBinding, { expectedPlanId: 901 }));
invalid(() => normalizeLeafRunBinding(alphaBinding, { expectedPlanHash: 'b'.repeat(64) }));
invalid(() => normalizeLeafRunBinding(alphaBinding, { expectedAllocationItemId: 502 }));
assert.equal(
  normalizeLeafRunBinding(alphaBinding, {
    expectedRunId: 3001,
    expectedTicketId: admitted.ticketId,
    expectedPlanId: admitted.id,
    expectedPlanHash: admitted.planHash,
    expectedAllocationItemId: alpha.allocationItemId
  }).bindingHash,
  alphaBinding.bindingHash
);
invalid(() => buildLeafRunBinding({ ...alphaBinding, ownedOutputPaths: [] }));
invalid(() => buildLeafRunBinding({
  ...alphaBinding,
  ownedOutputPaths: ['reports/alpha/', 'reports/alpha/']
}));
invalid(() => buildLeafRunBinding({ ...alphaBinding, ownedOutputPaths: '../escape' }));

// ── Binding sets are one-to-one with the admitted items ─────────────────────

const completeSet = assertLeafBindingSetComplete([betaBinding, alphaBinding], admitted);
assert.deepEqual(completeSet.map(binding => binding.allocationItemId),
  [alpha.allocationItemId, beta.allocationItemId],
  'a complete binding set is returned in stable item order');
assert.equal(Object.isFrozen(completeSet), true);

invalid(() => assertLeafBindingSetComplete([alphaBinding], admitted),
  'STRUCTURED_ALLOCATION_LEAF_BINDING_INCOMPLETE');
invalid(() => assertLeafBindingSetComplete([alphaBinding, alphaBinding], admitted));
invalid(
  () => assertLeafBindingSetComplete(
    [alphaBinding, bindingFor(admitted, beta, 3001)],
    admitted
  ),
  'STRUCTURED_ALLOCATION_LEAF_BINDING_INCOMPLETE'
);
invalid(() => assertLeafBindingSetComplete(
  [alphaBinding, betaBinding, bindingFor(admitted, { ...beta, allocationItemId: 503 }, 3003)],
  admitted
), 'STRUCTURED_ALLOCATION_LEAF_BINDING_CONFLICT');

// Authority drift inside an otherwise well-formed binding is caught: the agent,
// the ownership and the declared work are all re-derived from the plan item.
invalid(() => assertLeafBindingMatchesItem(
  bindingFor(admitted, alpha, 3001, { assignedAgentId: 12 }),
  alpha,
  alphaDeclared.contractHash
), 'STRUCTURED_ALLOCATION_LEAF_BINDING_CONFLICT');
invalid(() => assertLeafBindingSetComplete([
  buildLeafRunBinding({ ...alphaBinding, ownedOutputPaths: ['reports/beta/'] }),
  betaBinding
], admitted), 'STRUCTURED_ALLOCATION_LEAF_BINDING_CONFLICT');
const declaredWorkHashByItemId = new Map([
  [alpha.allocationItemId, alphaDeclared.contractHash],
  [beta.allocationItemId, buildLeafDeclaredWorkSnapshot(beta, {
    sharedConstraints: admitted.sharedConstraints
  }).contractHash]
]);
assert.equal(
  assertLeafBindingSetComplete([alphaBinding, betaBinding], admitted, {
    declaredWorkHashByItemId
  }).length,
  2,
  'declared-work agreement passes when the bindings carry the run declarations'
);
invalid(() => assertLeafBindingSetComplete(
  [bindingFor(admitted, alpha, 3001, { itemDeclaredWorkHash: 'c'.repeat(64) }), betaBinding],
  admitted,
  { declaredWorkHashByItemId }
), 'STRUCTURED_ALLOCATION_LEAF_BINDING_CONFLICT');
invalid(() => assertLeafBindingSetComplete([alphaBinding, betaBinding], admitted, {
  declaredWorkHashByItemId: new Map([[alpha.allocationItemId, alphaDeclared.contractHash]])
}), 'STRUCTURED_ALLOCATION_LEAF_BINDING_CONFLICT');
// The parent declaration is bound separately and is checked against the plan.
invalid(() => assertLeafBindingSetComplete(
  [bindingFor(admitted, alpha, 3001, { parentDeclaredWorkHash: 'd'.repeat(64) }), betaBinding],
  admitted
), 'STRUCTURED_ALLOCATION_LEAF_BINDING_CONFLICT');

// ── Per-item durable disposition ────────────────────────────────────────────

const AUTHORITY = '1'.repeat(64);
const runFacts = (status, overrides = {}) => ({
  binding: alphaBinding,
  runId: 3001,
  runTicketId: admitted.ticketId,
  runStatus: status,
  runDeclaredWorkHash: alphaDeclared.contractHash,
  runCompletionAuthorityHash: AUTHORITY,
  decision: null,
  ...overrides
});

for (const status of ['pending', 'running']) {
  const disposition = deriveLeafItemDisposition(runFacts(status));
  assert.equal(disposition.itemStatus, status, 'a nonterminal run projects its lifecycle');
  assert.equal(disposition.completionDecisionHash, null);
  assert.equal(disposition.reason, 'run_nonterminal');
  assert.equal(disposition.allocationItemId, alpha.allocationItemId);
  assert.equal(disposition.runId, 3001);
  assert.equal(Object.isFrozen(disposition), true);
}

// A raw completed run is NOT a completed item.
const rawCompleted = deriveLeafItemDisposition(runFacts('completed'));
assert.equal(rawCompleted.itemStatus, 'interrupted',
  'a terminal completed run with no durable decision never completes its item');
assert.equal(rawCompleted.completionDecisionHash, null);
assert.equal(rawCompleted.reason, 'completion_decision_missing');

const verified = deriveLeafItemDisposition(runFacts('completed', {
  decision: decisionFor(3001, admitted.ticketId, 'completed', AUTHORITY)
}));
assert.equal(verified.itemStatus, 'completed');
assert.equal(verified.completionDecisionHash, 'd'.repeat(64));
assert.equal(verified.reason, 'completion_verified');

// ── COMPLETION EVIDENCE IS ONLY OWED BY A COMPLETION CLAIM ─────────────────
//
// Four cases side by side, because the distinction between them is exactly
// what one reason string used to blur. `completion_decision_missing` is a
// CLAIM — it says successful completion evidence was required and absent. Only
// a Run that reached `completed` makes that claim. A truthfully failed Run owes
// no evidence, and reporting it as missing evidence put a false accusation
// where its real failure authority belonged: a replay-integrity-failed leaf was
// described as lacking proof it was never required to produce.
{
  const noDecision = (runStatus) => deriveLeafItemDisposition(runFacts(runStatus));

  // 1. completed + missing decision — evidence WAS owed and is absent.
  const completedMissing = noDecision('completed');
  assert.equal(completedMissing.itemStatus, 'interrupted',
    'a completed Run with no decision is unresolved');
  assert.equal(completedMissing.reason, 'completion_decision_missing',
    'and is the ONE case that reports missing completion evidence');

  // 2. failed + no decision — evidence was never owed.
  const failedNoDecision = noDecision('failed');
  assert.equal(failedNoDecision.itemStatus, 'failed',
    'a failed Run with no decision is truthfully failed');
  assert.notEqual(failedNoDecision.reason, 'completion_decision_missing',
    'and is NOT reported as missing completion evidence');
  assert.equal(failedNoDecision.reason, 'completion_unsuccessful',
    'it states the outcome instead');
  assert.equal(failedNoDecision.completionDecisionHash, null,
    'while the absence of a decision stays visible in the hash');

  // 3. interrupted + no decision — same rule, own status.
  const interruptedNoDecision = noDecision('interrupted');
  assert.notEqual(interruptedNoDecision.reason, 'completion_decision_missing',
    'an interrupted Run is not accused of missing evidence either');
  assert.equal(interruptedNoDecision.itemStatus, 'interrupted');

  // 4. completed + valid matching decision — the positive control, so the
  //    rules above are not simply refusing everything.
  const completedValid = deriveLeafItemDisposition(runFacts('completed', {
    decision: decisionFor(3001, admitted.ticketId, 'completed', AUTHORITY)
  }));
  assert.equal(completedValid.itemStatus, 'completed');
  assert.equal(completedValid.reason, 'completion_verified');
}

// ── BLOCKED LEAVES KEEP THEIR OWN AUTHORITY ────────────────────────────────
//
// `deriveLeafItemDisposition` is the single production mapping from a Run's
// terminal facts to an allocation-item disposition — reconciliation in
// persistence/postgres/store.js is its only caller — so this is where "a
// blocked leaf projects blocked, never completed" has to be proved.
//
// It is asserted HERE rather than in the cold-restart suites on purpose. Those
// suites restart a server and re-read durable rows; they never invoke this
// mapping, so mutating it could not make them fail. Splitting the
// responsibility keeps each suite testing what it actually executes:
//
//   restart suites → the block survives a cold process, byte for byte
//   this contract  → the block MAPS to the right terminal disposition
//
// The two block reasons are carried by the Run's governed progress block, not
// by the completion decision; what the decision contributes is the disposition
// itself. Both block kinds must therefore arrive as a non-success item that
// still names its own decision, and neither may be promoted to `completed`.
{
  const blockedDecision = decisionFor(3001, admitted.ticketId, 'blocked', AUTHORITY, 'b');
  const blocked = deriveLeafItemDisposition(runFacts('failed', {
    decision: blockedDecision
  }));
  // THE REASON IS THE AUTHORITY, NOT THE STATUS. A blocked leaf projects
  // itemStatus `failed` — `blocked` is not a leaf item status — so what
  // separates a coordination/churn block from an ordinary unsuccessful
  // decision is the reason `completion_blocked` alongside the decision hash.
  // Asserting a `blocked` itemStatus would have been asserting a status this
  // contract does not have.
  assert.equal(blocked.itemStatus, 'failed',
    'a blocked decision projects a non-success item');
  assert.notEqual(blocked.itemStatus, 'completed',
    'and never completes it');
  assert.equal(blocked.reason, 'completion_blocked',
    'and is distinguished from a generic unsuccessful decision by its reason');
  const unsuccessful = deriveLeafItemDisposition(runFacts('failed', {
    decision: decisionFor(3001, admitted.ticketId, 'incomplete', AUTHORITY, 'e')
  }));
  assert.equal(unsuccessful.reason, 'completion_unsuccessful',
    'an ordinary unsuccessful decision carries a DIFFERENT reason');
  assert.notEqual(unsuccessful.reason, blocked.reason,
    'so a block cannot be read as an ordinary failure, nor the reverse');
  assert.equal(blocked.completionDecisionHash, blockedDecision.decisionHash,
    'the item names the exact decision it was derived from — the hash is not dropped');
  assert.equal(blocked.allocationItemId, alpha.allocationItemId,
    'and is bound to the exact allocation item');
  assert.equal(blocked.runId, 3001, 'and to the exact Run');

  // A blocked leaf carries no sibling authority through this mapping. The
  // sibling/path facts live on the progress block, and an item disposition that
  // invented them would let a churn block be read as a coordination refusal.
  assert.equal(Object.prototype.hasOwnProperty.call(blocked, 'siblingDependencyBlocked'),
    false, 'a leaf disposition carries no siblingDependencyBlocked flag');
  assert.equal(Object.prototype.hasOwnProperty.call(blocked, 'siblingAllocationItemId'),
    false, 'nor a sibling allocation item');
  assert.equal(Object.prototype.hasOwnProperty.call(blocked, 'requestedPath'),
    false, 'nor a requested path');
  assert.deepEqual(Object.keys(blocked).sort(),
    ['allocationItemId', 'completionDecisionHash', 'itemStatus', 'reason', 'runId'],
    'the disposition exposes exactly its own fields and invents no authority');

  // A blocked decision on a Run that DID complete is still not a completion.
  const blockedOnCompleted = deriveLeafItemDisposition(runFacts('completed', {
    decision: blockedDecision
  }));
  assert.notEqual(blockedOnCompleted.itemStatus, 'completed',
    'a blocked decision never completes an item even for a completed Run');
  assert.equal(blockedOnCompleted.reason, 'completion_blocked',
    'and keeps the block reason regardless of the Run lifecycle');

  // And the opposite direction still works, so the rule above is not simply
  // refusing everything.
  const stillCompletes = deriveLeafItemDisposition(runFacts('completed', {
    decision: decisionFor(3001, admitted.ticketId, 'completed', AUTHORITY)
  }));
  assert.equal(stillCompletes.itemStatus, 'completed',
    'a genuinely completed leaf still completes');
  assert.notEqual(stillCompletes.completionDecisionHash, blocked.completionDecisionHash,
    'and the two dispositions name genuinely different decisions');
}

// Stale, conflicting and mismatched evidence can never complete an item.
const stale = deriveLeafItemDisposition(runFacts('completed', {
  decision: decisionFor(3002, admitted.ticketId, 'completed', AUTHORITY)
}));
assert.equal(stale.itemStatus, 'interrupted');
assert.equal(stale.reason, 'completion_decision_stale');
assert.equal(stale.completionDecisionHash, null);

assert.equal(
  deriveLeafItemDisposition(runFacts('completed', {
    decision: decisionFor(3001, 701, 'completed', AUTHORITY)
  })).reason,
  'completion_decision_stale',
  'a decision for another ticket is stale'
);
assert.equal(
  deriveLeafItemDisposition(runFacts('completed', {
    decision: decisionFor(3001, admitted.ticketId, 'completed', '2'.repeat(64))
  })).reason,
  'completion_authority_mismatch',
  'a decision evaluated against different completion authority cannot complete'
);
assert.equal(
  deriveLeafItemDisposition(runFacts('completed', {
    runDeclaredWorkHash: 'c'.repeat(64),
    decision: decisionFor(3001, admitted.ticketId, 'completed', AUTHORITY)
  })).reason,
  'declared_work_mismatch',
  'a run that does not carry the item declared work cannot complete the item'
);
assert.equal(
  deriveLeafItemDisposition(runFacts('completed', {
    runCompletionAuthorityHash: null
  })).reason,
  'run_terminal_without_authority'
);
for (const reason of [
  'completion_decision_stale',
  'completion_authority_mismatch',
  'declared_work_mismatch',
  'run_terminal_without_authority',
  'completion_decision_missing'
]) {
  assert.equal(LEAF_ITEM_DISPOSITION_REASONS.includes(reason), true);
}

// A decision claiming completion for a run that never completed is conflicting.
assert.equal(
  deriveLeafItemDisposition(runFacts('failed', {
    decision: decisionFor(3001, admitted.ticketId, 'completed', AUTHORITY)
  })).reason,
  'completion_decision_conflicts_run'
);
assert.equal(
  deriveLeafItemDisposition(runFacts('failed', {
    decision: decisionFor(3001, admitted.ticketId, 'completed', AUTHORITY)
  })).itemStatus,
  'interrupted'
);

const blocked = deriveLeafItemDisposition(runFacts('failed', {
  decision: decisionFor(3001, admitted.ticketId, 'blocked', AUTHORITY)
}));
assert.equal(blocked.itemStatus, 'failed',
  'a blocked disposition maps into the existing item vocabulary');
assert.equal(blocked.reason, 'completion_blocked');

assert.equal(
  deriveLeafItemDisposition(runFacts('failed', {
    decision: decisionFor(3001, admitted.ticketId, 'incomplete', AUTHORITY)
  })).itemStatus,
  'failed'
);
assert.equal(
  deriveLeafItemDisposition(runFacts('interrupted', {
    decision: decisionFor(3001, admitted.ticketId, 'incomplete', AUTHORITY)
  })).itemStatus,
  'interrupted'
);
assert.equal(deriveLeafItemDisposition(runFacts('failed')).itemStatus, 'failed');
assert.equal(deriveLeafItemDisposition(runFacts('interrupted')).itemStatus, 'interrupted');

// Every disposition is in the existing vocabulary, for every reachable input.
for (const status of ['pending', 'running', 'completed', 'failed', 'interrupted']) {
  for (const disposition of [null, ...COMPLETION_DISPOSITIONS]) {
    const derived = deriveLeafItemDisposition(runFacts(status, {
      decision: disposition === null
        ? null
        : decisionFor(3001, admitted.ticketId, disposition, AUTHORITY)
    }));
    assert.equal(LEAF_ITEM_STATUSES.includes(derived.itemStatus), true,
      `derived status for ${status}/${disposition} stays in the existing vocabulary`);
    assert.equal(LEAF_ITEM_DISPOSITION_REASONS.includes(derived.reason), true);
    if (derived.itemStatus === 'completed') {
      assert.equal(derived.completionDecisionHash !== null, true,
        'a completed item always records its supporting decision hash');
    }
  }
}
// Derivation is idempotent: the same persisted facts always derive the same value.
assert.deepEqual(
  deriveLeafItemDisposition(runFacts('completed', {
    decision: decisionFor(3001, admitted.ticketId, 'completed', AUTHORITY)
  })),
  verified,
  'repeated derivation over unchanged facts is identical'
);
// The binding must identify the run it is being reconciled against.
invalid(() => deriveLeafItemDisposition(runFacts('completed', { runId: 3002 })));
invalid(() => deriveLeafItemDisposition(runFacts('completed', { runTicketId: 701 })));
invalid(() => deriveLeafItemDisposition(runFacts('blocked')));

// ── Aggregate plan decision ─────────────────────────────────────────────────

function aggregateItem(allocationItemId, assignedAgentId, runId, itemStatus, decisionHash, reason) {
  return {
    allocationItemId,
    assignedAgentId,
    runId,
    runLineage: [runId],
    itemStatus,
    completionDecisionHash: decisionHash,
    reason
  };
}

function aggregate(items) {
  return buildAggregatePlanDecision({
    ticketId: admitted.ticketId,
    allocationPlanId: admitted.id,
    planHash: admitted.planHash,
    planningAdmissionHash: ADMISSION_HASH,
    items,
    decidedAt: ADMITTED_AT
  });
}

const bothComplete = aggregate([
  aggregateItem(501, 11, 3001, 'completed', 'd'.repeat(64), 'completion_verified'),
  aggregateItem(502, 12, 3002, 'completed', 'e'.repeat(64), 'completion_verified')
]);
assert.equal(bothComplete.aggregateStatus, 'completed');
assert.deepEqual(bothComplete.completedItemIds, [501, 502]);
assert.deepEqual(bothComplete.unresolvedItemIds, []);
assert.deepEqual(bothComplete.failedItemIds, []);
assert.deepEqual(Object.keys(bothComplete).sort(), [...AGGREGATE_DECISION_FIELDS].sort());
assert.deepEqual(Object.keys(bothComplete.items[0]).sort(), [...AGGREGATE_ITEM_FIELDS].sort());
assert.equal(bothComplete.version, AGGREGATE_PLAN_DECISION_VERSION);
assert.equal(Object.isFrozen(bothComplete), true);
assert.equal(Object.isFrozen(bothComplete.items[0]), true);
assert.equal(aggregate([
  aggregateItem(502, 12, 3002, 'completed', 'e'.repeat(64), 'completion_verified'),
  aggregateItem(501, 11, 3001, 'completed', 'd'.repeat(64), 'completion_verified')
]).decisionHash, bothComplete.decisionHash, 'the aggregate decision is order-independent');

// One incomplete item prevents aggregate completion, in every incomplete shape.
for (const [itemStatus, decisionHash, reason, expected] of [
  ['pending', null, 'run_nonterminal', 'pending'],
  ['running', null, 'run_nonterminal', 'running'],
  ['interrupted', null, 'completion_decision_missing', 'interrupted'],
  ['failed', 'f'.repeat(64), 'completion_unsuccessful', 'failed']
]) {
  const mixed = aggregate([
    aggregateItem(501, 11, 3001, 'completed', 'd'.repeat(64), 'completion_verified'),
    aggregateItem(502, 12, 3002, itemStatus, decisionHash, reason)
  ]);
  assert.equal(mixed.aggregateStatus, expected,
    `one ${itemStatus} item prevents aggregate completion`);
  assert.notEqual(mixed.aggregateStatus, 'completed');
  assert.deepEqual(mixed.completedItemIds, [501]);
}

// Failure dominates: a failed sibling is never overridden by an interrupted or
// completed one, and completion requires every required item.
assert.equal(aggregate([
  aggregateItem(501, 11, 3001, 'failed', null, 'completion_decision_missing'),
  aggregateItem(502, 12, 3002, 'interrupted', null, 'completion_decision_missing')
]).aggregateStatus, 'failed');
assert.equal(aggregate([
  aggregateItem(501, 11, 3001, 'interrupted', null, 'completion_decision_missing'),
  aggregateItem(502, 12, 3002, 'running', null, 'run_nonterminal')
]).aggregateStatus, 'interrupted');
assert.deepEqual(aggregate([
  aggregateItem(501, 11, 3001, 'interrupted', null, 'completion_decision_missing'),
  aggregateItem(502, 12, 3002, 'running', null, 'run_nonterminal')
]).unresolvedItemIds, [501, 502]);

// "All runs terminal" and "no running runs" are explicitly not completion.
assert.equal(aggregate([
  aggregateItem(501, 11, 3001, 'interrupted', null, 'completion_decision_missing'),
  aggregateItem(502, 12, 3002, 'interrupted', null, 'completion_decision_missing')
]).aggregateStatus, 'interrupted');

// A completed item without its supporting decision hash is not representable.
invalid(() => aggregate([
  aggregateItem(501, 11, 3001, 'completed', null, 'completion_verified')
]), 'COMPLETION_EVIDENCE_MISSING');
assert.equal(
  aggregateStatusFromItems([{ itemStatus: 'completed', completionDecisionHash: null }]),
  'interrupted',
  'the fail-closed floor never reports an unsupported completion as completed'
);
assert.equal(aggregateStatusFromItems([]), 'interrupted',
  'an empty item set is never completion');

invalid(() => aggregate([]));
invalid(() => aggregate([
  aggregateItem(501, 11, 3001, 'completed', 'd'.repeat(64), 'completion_verified'),
  aggregateItem(501, 12, 3002, 'completed', 'e'.repeat(64), 'completion_verified')
]));
invalid(() => aggregate([{
  ...aggregateItem(501, 11, 3001, 'completed', 'd'.repeat(64), 'completion_verified'),
  extra: true
}]));
invalid(() => aggregate([{
  ...aggregateItem(501, 11, 3001, 'completed', 'd'.repeat(64), 'completion_verified'),
  runLineage: [3009]
}]), 'STRUCTURED_ALLOCATION_LEAF_RUN_INVALID');
invalid(() => aggregate([{
  ...aggregateItem(501, 11, 3001, 'completed', 'd'.repeat(64), 'completion_verified'),
  runLineage: [3001, 3001]
}]));
invalid(() => aggregate([{
  ...aggregateItem(501, 11, 3001, 'completed', 'd'.repeat(64), 'completion_verified'),
  itemStatus: 'blocked'
}]));
invalid(() => aggregate([{
  ...aggregateItem(501, 11, 3001, 'completed', 'd'.repeat(64), 'completion_verified'),
  reason: 'agent_said_so'
}]));

// Retry lineage is representable without a second binding.
const retried = aggregate([
  {
    ...aggregateItem(501, 11, 3005, 'completed', 'd'.repeat(64), 'completion_verified'),
    runLineage: [3005, 3001]
  },
  aggregateItem(502, 12, 3002, 'completed', 'e'.repeat(64), 'completion_verified')
]);
assert.deepEqual(retried.items[0].runLineage, [3001, 3005],
  'run lineage is canonically ordered');
assert.equal(retried.aggregateStatus, 'completed');

assert.equal(normalizeAggregatePlanDecision(bothComplete).decisionHash, bothComplete.decisionHash);
assert.equal(
  normalizeAggregatePlanDecision(JSON.parse(JSON.stringify(bothComplete))).decisionHash,
  bothComplete.decisionHash,
  'an aggregate decision survives a JSONB round trip'
);
invalid(() => normalizeAggregatePlanDecision({ ...bothComplete, decisionHash: '0'.repeat(64) }));
invalid(() => normalizeAggregatePlanDecision({ ...bothComplete, extra: 1 }));
invalid(() => normalizeAggregatePlanDecision({ ...bothComplete, version: 2 }));
invalid(() => normalizeAggregatePlanDecision(bothComplete, { expectedPlanHash: 'b'.repeat(64) }));
invalid(() => normalizeAggregatePlanDecision(bothComplete, { expectedPlanId: 901 }));
assert.equal(
  normalizeAggregatePlanDecision(bothComplete, {
    expectedPlanHash: admitted.planHash,
    expectedPlanId: admitted.id
  }).aggregateStatus,
  'completed'
);
// A tampered aggregateStatus cannot survive: it is recomputed and hash-checked.
invalid(() => normalizeAggregatePlanDecision({
  ...bothComplete,
  aggregateStatus: 'failed'
}));
invalid(() => normalizeAggregatePlanDecision({
  ...bothComplete,
  completedItemIds: [501]
}));

// ── Projection semantics: four questions, four fields ───────────────────────

const emptyLeaf = projectStructuredAllocationLeafExecution({ allocationPlan: null });
assert.equal(emptyLeaf.plannerAdmittedPlan, false);
assert.equal(emptyLeaf.admissionState, 'none');
assert.equal(emptyLeaf.admissionBlockedReason, null);
assert.deepEqual(emptyLeaf.schedulerVisibleRunIds, []);
assert.equal(Object.prototype.hasOwnProperty.call(emptyLeaf, 'available'), false,
  'the overloaded availability boolean is gone');

const pendingPlan = { ...admitted, status: 'pending', aggregateDecision: null };
const notAdmitted = projectStructuredAllocationLeafExecution({
  allocationPlan: pendingPlan,
  runs: [],
  ticketStatus: 'open',
  ticketExecutionMode: 'agent'
});
assert.equal(notAdmitted.plannerAdmittedPlan, true);
assert.equal(notAdmitted.capabilityAvailable, true,
  'the product capability is reported separately from this ticket state');
assert.equal(notAdmitted.admissionState, 'not_admitted');
assert.equal(notAdmitted.admissionBlockedReason, null,
  'no blocker is derivable from durable authority for an ordinary pending plan');
assert.deepEqual(notAdmitted.schedulerVisibleRunIds, []);

// A ticket whose admission WOULD refuse never reports an unqualified capability
// for itself: the blocker is named from the closed refusal vocabulary.
assert.equal(
  projectStructuredAllocationLeafExecution({
    allocationPlan: pendingPlan,
    runs: [],
    ticketExecutionMode: 'workflow'
  }).admissionBlockedReason,
  'leaf_execution_mode_unsupported'
);
// A plan whose parent authority permitted a typed family: the projection reads
// the stored item declarations, so the item is shaped directly here rather than
// rebuilt through the plan builder, whose parent-capability check is a separate
// concern already covered above.
const typedItemPlan = {
  ...pendingPlan,
  items: [
    { ...alpha, successCriteria: [...alpha.successCriteria, typed] },
    beta
  ]
};
assert.equal(
  projectStructuredAllocationLeafExecution({
    allocationPlan: typedItemPlan,
    runs: [],
    ticketExecutionMode: 'agent'
  }).admissionBlockedReason,
  'leaf_item_typed_criteria_unsupported'
);
assert.equal(
  projectStructuredAllocationLeafExecution({
    allocationPlan: { ...pendingPlan, status: 'running' },
    runs: [],
    ticketExecutionMode: 'agent'
  }).admissionBlockedReason,
  'plan_not_pending'
);
for (const blocked of ['leaf_execution_mode_unsupported', 'leaf_item_typed_criteria_unsupported',
  'plan_not_pending']) {
  assert.equal(LEAF_ADMISSION_REFUSALS.includes(blocked), true,
    `${blocked} comes from the closed refusal vocabulary`);
}

// Admitted and settled are distinct states, and scheduler visibility is its own
// field rather than an inference from either.
const leafRuns = [
  { id: 3001, status: 'running', leafRunBinding: alphaBinding },
  { id: 3002, status: 'completed', leafRunBinding: betaBinding }
];
const admittedProjection = projectStructuredAllocationLeafExecution({
  allocationPlan: { ...admitted, status: 'running', aggregateDecision: null },
  runs: leafRuns,
  ticketStatus: 'in_progress',
  ticketExecutionMode: 'agent'
});
assert.equal(admittedProjection.admissionState, 'admitted');
assert.equal(admittedProjection.admissionBlockedReason, null,
  'an already-admitted plan reports state, not a blocker');
assert.deepEqual(admittedProjection.schedulerVisibleRunIds, [3001],
  'only claimable leaf runs are reported as scheduler-visible');
assert.equal(
  projectStructuredAllocationLeafExecution({
    allocationPlan: { ...admitted, status: 'completed', aggregateDecision: bothComplete },
    runs: leafRuns.map(run => ({ ...run, status: 'completed' })),
    ticketStatus: 'completed',
    ticketExecutionMode: 'agent'
  }).admissionState,
  'settled'
);
assert.deepEqual(
  projectStructuredAllocationLeafExecution({
    allocationPlan: { ...admitted, status: 'completed', aggregateDecision: bothComplete },
    runs: leafRuns.map(run => ({ ...run, status: 'completed' })),
    ticketExecutionMode: 'agent'
  }).schedulerVisibleRunIds,
  [],
  'a settled plan exposes no claimable run'
);
for (const state of ['none', 'not_admitted', 'admitted', 'settled']) {
  assert.equal(LEAF_ADMISSION_STATES.includes(state), true);
}

// ── The module states no parent-ticket rule and no Tranche 4 primitive ──────

const source = fs.readFileSync(
  path.join(__dirname, '..', 'runtime', 'structured-allocation-leaf-run-contract.js'),
  'utf8'
);
for (const forbidden of [
  'require(\'http',
  'require("http',
  'child_process',
  'pg\'',
  'fetch(',
  'Math.random',
  'Date.now'
]) {
  assert.equal(source.includes(forbidden), false,
    `the leaf-run contract stays pure: ${forbidden} must not appear`);
}
for (const forbidden of ['delegat', 'recursi', 'subticket', 'childTicket', 'replan']) {
  assert.equal(new RegExp(forbidden, 'i').test(source.replace(/^\s*\/\/.*$/gm, '')), false,
    `no Tranche 4 primitive appears in executable code: ${forbidden}`);
}
assert.equal(
  Object.keys(require('../runtime/structured-allocation-leaf-run-contract'))
    .some(name => /parentTicket|ticketStatus|ticketOutcome/i.test(name)),
  false,
  'the module exports no second parent-ticket outcome authority'
);

console.log('structured allocation leaf-run contract test passed');


// ── The shared completion-evidence authority ────────────────────────────────
//
// Both Ticket projection and leaf reconciliation consume this. The precedence
// is the substantive part: decision INTEGRITY is judged before the Run's own
// claim, so a malformed decision is never filed under "not applicable" just
// because its subject did not finish.
{
  const HASH = 'a'.repeat(64);
  const OTHER = 'b'.repeat(64);
  const good = { runId: 3001, ticketId: 700, objectiveContractHash: HASH,
    completionDisposition: 'completed' };
  const blockedDecision = { ...good, completionDisposition: 'blocked' };
  const ev = overrides => evaluateRunCompletionEvidence({
    runStatus: 'completed', runId: 3001, runTicketId: 700,
    runCompletionAuthorityHash: HASH, decision: null, ...overrides
  });

  // No decision at all.
  for (const runStatus of ['pending', 'running', 'failed', 'interrupted']) {
    const r = ev({ runStatus });
    assert.equal(r.result, 'not_applicable',
      `${runStatus} with no decision does not require completion evidence`);
    assert.equal(r.reason, null);
  }
  assert.equal(ev({}).reason, 'completion_decision_missing',
    'completed with no decision is missing evidence');

  // A valid decision for a Run that claims completion.
  assert.equal(ev({ decision: good }).result, 'valid');
  assert.equal(ev({ decision: good }).reason, 'completion_verified');

  // BINDING FAULTS OUTRANK RUN STATUS. A decision belonging to another Run or
  // built against other authority is malformed whatever its subject claims.
  for (const runStatus of ['completed', 'running', 'failed', 'interrupted']) {
    assert.equal(ev({ runStatus, decision: { ...good, runId: 3002 } }).reason,
      'completion_decision_stale', `${runStatus} + wrong Run decision is stale`);
    assert.equal(ev({ runStatus, decision: { ...good, ticketId: 701 } }).reason,
      'completion_decision_stale', `${runStatus} + wrong Ticket decision is stale`);
    assert.equal(
      ev({ runStatus, decision: { ...good, objectiveContractHash: OTHER } }).reason,
      'completion_authority_mismatch',
      `${runStatus} + authority mismatch is reported as a mismatch`);
  }

  // A well-bound decision asserting completion for a Run that did not reach it
  // contradicts the persisted lifecycle.
  for (const runStatus of ['running', 'failed', 'interrupted']) {
    assert.equal(ev({ runStatus, decision: good }).reason,
      'completion_decision_conflicts_run',
      `${runStatus} + a completed decision conflicts with the run`);
  }

  // A non-completed Run carrying a NON-completion decision is not a conflict —
  // a `blocked` disposition is a real outcome the caller still maps.
  assert.equal(ev({ runStatus: 'failed', decision: blockedDecision }).result,
    'not_applicable', 'a blocked decision on a failed Run is not a conflict');

  // An uncomparable authority hash is not a mismatch: Ticket projection has no
  // item binding and supplies none.
  assert.equal(
    ev({ runCompletionAuthorityHash: null, decision: { ...good, objectiveContractHash: OTHER } })
      .result, 'valid',
    'an absent authority hash does not manufacture a mismatch');

  assert.deepEqual([...COMPLETION_EVIDENCE_RESULTS],
    ['not_applicable', 'valid', 'missing', 'stale', 'authority_mismatch',
      'conflicts_with_run'],
    'the completion-evidence vocabulary is closed');
  assert.deepEqual([...COMPLETION_BINDING_RESULTS],
    ['absent', 'valid', 'stale', 'authority_mismatch'],
    'the binding vocabulary is closed');
}

// ── The decisive comparisons live in ONE production place ───────────────────
//
// Callers may map the shared result; they may not re-derive it. This pins that
// boundary in source so a future edit cannot quietly reintroduce a second copy.
{
  const fs = require('node:fs');
  const path = require('node:path');
  const authority = path.join(__dirname, '..', 'runtime',
    'structured-allocation-leaf-run-contract.js');
  const consumers = [
    path.join(__dirname, '..', 'persistence', 'postgres', 'store.js')
  ];
  const decisive = [
    /decision\.runId\s*!==/,
    /decision\.ticketId\s*!==/,
    /decision\.objectiveContractHash\s*!==/
  ];
  for (const file of consumers) {
    const executable = fs.readFileSync(file, 'utf8').split('\n')
      .filter(line => !/^\s*(\/\/|\*|\/\*)/.test(line)).join('\n');
    for (const pattern of decisive) {
      assert.equal(pattern.test(executable), false,
        `${path.basename(file)} must not re-derive ${pattern} — the shared ` +
        'completion-evidence authority owns it');
    }
  }
  const authoritySource = fs.readFileSync(authority, 'utf8');
  for (const pattern of decisive) {
    assert.ok(pattern.test(authoritySource),
      `the shared authority still owns ${pattern}`);
  }
}

console.log('  ok shared completion-evidence authority');

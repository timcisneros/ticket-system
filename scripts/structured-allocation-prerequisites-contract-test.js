'use strict';

const assert = require('assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const {
  buildStructuredAllocationAuthorityDraft,
  buildTicketParentDeclaredWorkSnapshot,
  evaluateStructuredAllocationCurrentApplicability,
  evaluateStructuredAllocationEligibility,
  materializeStructuredAllocationAuthority,
  normalizeStructuredAllocationAuthority,
  normalizeTicketParentWorkInput,
  projectStructuredAllocationAuthorityForTicket
} = require('../runtime/structured-allocation-prerequisites-contract');

const CAPTURED_AT = '2026-07-30T12:00:00.000Z';
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');

function textWork(overrides = {}) {
  return {
    objective: 'Produce two review reports',
    expectedOutputs: [{ kind: 'text', declaration: 'Review reports in the assigned output folders' }],
    successCriteria: [{ kind: 'text', declaration: 'Both reports identify findings and recommendations' }],
    evidenceRequirements: [],
    ...overrides
  };
}

function buildParent(work = textWork(), ticketObjective = work.objective) {
  return buildTicketParentDeclaredWorkSnapshot(work, { ticketObjective });
}

function buildDraft(work = textWork(), authorityContext = context()) {
  return buildStructuredAllocationAuthorityDraft({
    declaredWork: work,
    ticketObjective: work.objective,
    ...authorityContext
  });
}

function context(overrides = {}) {
  const assignmentGroup = {
    id: 10, name: 'Review Group', revision: 3, plannerAgentId: 21
  };
  const candidateAgents = [
    { id: 22, name: 'Reviewer B', revision: 5 },
    { id: 21, name: 'Reviewer A', revision: 4 }
  ];
  return {
    assignmentTargetType: 'group',
    assignmentMode: 'allocated',
    assignmentGroup,
    plannerAgent: {
      id: 21, name: 'Reviewer A', revision: 4, provider: 'openai', model: 'gpt-test'
    },
    candidateAgents,
    ownedOutputPaths: { 21: 'reports/a/', 22: 'reports/b/' },
    ...overrides
  };
}

function reasonSet(value) {
  return new Set(value.refusalReasons);
}

function assertReason(options, reason) {
  const result = evaluateStructuredAllocationEligibility(options);
  assert.equal(result.eligible, false);
  assert.equal(reasonSet(result).has(reason), true, `missing refusal reason ${reason}`);
}

function main() {
  const parent = buildParent();
  assert.equal(parent.objective.provenance, 'ticket-authored');
  assert.deepEqual(parent.expectedOutputs.map(item => item.provenance), ['ticket-authored']);
  assert.equal(Object.isFrozen(parent), true);
  assert.equal(Object.isFrozen(parent.expectedOutputs[0]), true);

  const whitespaceParent = buildParent(
    textWork({ objective: '  Produce two review reports  ' }),
    '  Produce two review reports  '
  );
  assert.equal(whitespaceParent.objective.text, 'Produce two review reports');
  for (const competingObjective of [
    'Contradict the canonical ticket objective',
    'Produce two review reports and an unrelated deployment',
    ''
  ]) {
    assert.throws(
      () => buildParent(textWork({ objective: competingObjective }), textWork().objective),
      error => competingObjective === ''
        ? /must not be empty/.test(error.message)
        : error.code === 'STRUCTURED_ALLOCATION_OBJECTIVE_CONFLICT'
    );
  }

  const declaration = JSON.stringify({ id: 'report-exists', path: 'reports/a/report.md', type: 'fileExists' });
  const criterionHash = sha256(declaration);
  const typedParent = buildParent(textWork({
    successCriteria: [{
      kind: 'typed-postcondition',
      criterionType: 'fileExists',
      declaration,
      criterionHash
    }],
    evidenceRequirements: [{
      kind: 'postcondition-evidence',
      criterionHash,
      evidenceType: 'deterministic-postcondition-result'
    }]
  }));
  assert.equal(typedParent.successCriteria[0].criterionHash, criterionHash);
  assert.equal(typedParent.evidenceRequirements[0].criterionHash, criterionHash);

  assert.throws(
    () => buildParent(textWork({
      successCriteria: [{
        kind: 'typed-postcondition', criterionType: 'fileExists', declaration, criterionHash
      }],
      evidenceRequirements: []
    })),
    error => error.code === 'DECLARED_WORK_EVIDENCE_MISMATCH'
  );
  assert.throws(
    () => buildParent(textWork({
      successCriteria: [],
      evidenceRequirements: [{
        kind: 'postcondition-evidence', criterionHash,
        evidenceType: 'deterministic-postcondition-result'
      }]
    })),
    error => error.code === 'DECLARED_WORK_EVIDENCE_MISMATCH'
  );

  for (const invalid of [
    { ...textWork(), extra: true },
    { ...textWork(), provenance: 'validated-model-contract' },
    { ...textWork(), expectedOutputs: [{ kind: 'text', declaration: 'x', provenance: 'validated-model-contract' }] },
    { ...textWork(), successCriteria: [{ kind: 'text', declaration: 'x', extra: true }] },
    { ...textWork(), evidenceRequirements: [{ kind: 'postcondition-evidence', criterionHash, evidenceType: 'deterministic-postcondition-result', extra: true }] }
  ]) {
    assert.throws(() => normalizeTicketParentWorkInput(invalid, { ticketObjective: invalid.objective }), /unknown/);
  }

  const reordered = textWork({
    expectedOutputs: [
      { kind: 'text', declaration: 'Zulu output' },
      { kind: 'text', declaration: 'Alpha output' }
    ],
    successCriteria: [
      { kind: 'text', declaration: 'Zulu criterion' },
      { kind: 'text', declaration: 'Alpha criterion' }
    ]
  });
  const reverse = {
    ...reordered,
    expectedOutputs: [...reordered.expectedOutputs].reverse(),
    successCriteria: [...reordered.successCriteria].reverse()
  };
  const orderedParent = buildParent(reordered);
  const reverseParent = buildParent(reverse);
  assert.deepEqual(orderedParent, reverseParent);
  assert.equal(orderedParent.contractHash, reverseParent.contractHash);

  const mutable = textWork();
  const isolated = buildParent(mutable);
  mutable.expectedOutputs[0].declaration = 'mutated later';
  assert.equal(isolated.expectedOutputs[0].declaration, 'Review reports in the assigned output folders');

  assert.throws(
    () => buildStructuredAllocationAuthorityDraft({
      declaredWork: textWork({ objective: 'Competing parent objective' }),
      ticketObjective: textWork().objective,
      ...context()
    }),
    error => error.code === 'STRUCTURED_ALLOCATION_OBJECTIVE_CONFLICT'
  );
  const validDraft = buildDraft();
  assert.equal(validDraft.structuredAllocationEligibility.eligible, true);
  assert.equal(validDraft.planningAuthorityDraft.planner.agentId, 21);
  assert.deepEqual(validDraft.planningAuthorityDraft.candidates.map(item => item.agentId), [21, 22]);
  const authority = materializeStructuredAllocationAuthority(validDraft, {
    ticketId: 44,
    capturedAt: CAPTURED_AT
  });
  const reconstructed = normalizeStructuredAllocationAuthority(JSON.parse(JSON.stringify(authority)), {
    expectedTicketId: 44,
    expectedTicketObjective: textWork().objective
  });
  assert.deepEqual(reconstructed, authority);
  assert.equal(Object.isFrozen(reconstructed), true);
  assert.equal(Object.isFrozen(reconstructed.planningAuthoritySnapshot.planner), true);
  assert.equal(Object.isFrozen(reconstructed.planningAuthoritySnapshot.candidates[0].ownedOutputPaths), true);

  const duplicateInput = JSON.parse(JSON.stringify(validDraft));
  duplicateInput.planningAuthorityDraft.candidates[1].name = 'source mutation';
  assert.equal(authority.planningAuthoritySnapshot.candidates[1].name, 'Reviewer B');
  const tampered = JSON.parse(JSON.stringify(authority));
  tampered.planningAuthoritySnapshot.planner.model = 'other-model';
  assert.throws(() => normalizeStructuredAllocationAuthority(tampered, { expectedTicketId: 44 }), /snapshotHash/);
  const extraAuthority = JSON.parse(JSON.stringify(authority));
  extraAuthority.extra = true;
  assert.throws(() => normalizeStructuredAllocationAuthority(extraAuthority, { expectedTicketId: 44 }), /unknown/);

  const complete = { parentDeclaredWorkSnapshot: parent, ...context() };
  assert.equal(evaluateStructuredAllocationEligibility(complete).eligible, true);
  assertReason({ ...complete, assignmentMode: 'individual' }, 'unsupported_allocation_mode');
  assertReason({ ...complete, parentDeclaredWorkSnapshot: null }, 'missing_parent_declared_work');
  assertReason({
    ...complete,
    parentDeclaredWorkSnapshot: buildParent(textWork({ expectedOutputs: [] }))
  }, 'missing_parent_expected_outputs');
  assertReason({
    ...complete,
    parentDeclaredWorkSnapshot: buildParent(textWork({ successCriteria: [] }))
  }, 'missing_parent_success_criteria');
  const invalidParent = JSON.parse(JSON.stringify(parent));
  invalidParent.objective.text = 'tampered';
  assertReason({ ...complete, parentDeclaredWorkSnapshot: invalidParent }, 'invalid_parent_declared_work');
  const noDesignatedPlanner = {
    ...complete,
    assignmentGroup: { ...complete.assignmentGroup, plannerAgentId: null }
  };
  assertReason(noDesignatedPlanner, 'missing_planner_principal');
  const noFallbackDraft = buildDraft(textWork(),
    context({ assignmentGroup: { ...context().assignmentGroup, plannerAgentId: null } }));
  assert.equal(noFallbackDraft.structuredAllocationEligibility.eligible, false);
  assert.equal(noFallbackDraft.planningAuthorityDraft, null, 'a candidate planner is never an implicit fallback');
  assertReason({ ...complete, assignmentGroup: { ...complete.assignmentGroup, plannerAgentId: 99 }, plannerAgent: { ...complete.plannerAgent, id: 99 } }, 'planner_not_group_member');
  assertReason({ ...complete, plannerAgent: { ...complete.plannerAgent, model: '' } }, 'planner_unavailable');
  assertReason({ ...complete, candidateAgents: [] }, 'invalid_candidate_membership');
  assertReason({ ...complete, ownedOutputPaths: { 21: 'reports/a/' } }, 'missing_owned_output_paths');
  assertReason({ ...complete, ownedOutputPaths: { 21: '../escape', 22: 'reports/b/' } }, 'invalid_owned_output_paths');
  assertReason({ ...complete, ownedOutputPaths: { 21: 'reports/', 22: 'reports/b/' } }, 'overlapping_owned_output_paths');

  const noOutputs = buildParent(textWork({ expectedOutputs: [] }));
  assertReason({ ...complete, parentDeclaredWorkSnapshot: noOutputs, ownedOutputPaths: { 21: 'deliverables/a/', 22: 'deliverables/b/' } }, 'missing_parent_expected_outputs');
  assertReason({
    ...complete,
    parentDeclaredWorkSnapshot: null,
    assignmentGroup: { ...complete.assignmentGroup, plannerAgentId: 21 }
  }, 'missing_parent_declared_work');
  assert.equal(evaluateStructuredAllocationEligibility({
    ...complete,
    parentDeclaredWorkSnapshot: buildParent(textWork({ expectedOutputs: [] }))
  }).eligible, false, 'objective and acceptance-like prose do not create output authority');

  const historicalProjection = projectStructuredAllocationAuthorityForTicket({ id: 1, objective: 'historical' });
  assert.equal(historicalProjection.availability, 'historical-unavailable');
  assert.equal(historicalProjection.authority, null);
  assert.deepEqual(historicalProjection.currentApplicability, {
    applicable: false,
    refusalReasons: ['historical_authority_unavailable']
  });

  const admittedTicket = {
    id: 44,
    objective: textWork().objective,
    assignmentTargetType: 'group',
    assignmentTargetId: 10,
    assignmentMode: 'allocated',
    ownedOutputPaths: { 21: 'reports/a', 22: 'reports/b/' },
    structuredAllocationAuthority: authority
  };
  const admittedProjection = projectStructuredAllocationAuthorityForTicket(admittedTicket);
  assert.equal(admittedProjection.authority.authorityHash, authority.authorityHash);
  assert.equal(admittedProjection.admissionEligibility.eligible, true);
  assert.deepEqual(admittedProjection.currentApplicability, { applicable: true, refusalReasons: [] });
  assert.deepEqual(evaluateStructuredAllocationCurrentApplicability(admittedTicket),
    admittedProjection.currentApplicability);

  for (const reassigned of [
    { ...admittedTicket, assignmentTargetType: 'agent', assignmentTargetId: 21, assignmentMode: 'individual' },
    { ...admittedTicket, assignmentTargetId: 11 },
    { ...admittedTicket, assignmentMode: 'dynamic' },
    { ...admittedTicket, ownedOutputPaths: { 21: 'reports/a/', 22: 'reports/other/' } }
  ]) {
    const projection = projectStructuredAllocationAuthorityForTicket(reassigned);
    assert.equal(projection.admissionEligibility.eligible, true,
      'immutable admission eligibility remains historical evidence');
    assert.deepEqual(projection.currentApplicability, {
      applicable: false,
      refusalReasons: ['assignment_changed_since_capture']
    });
  }
  assert.throws(
    () => projectStructuredAllocationAuthorityForTicket({ ...admittedTicket, objective: 'tampered objective' }),
    error => error.code === 'STRUCTURED_ALLOCATION_OBJECTIVE_CONFLICT'
  );

  const contractSource = fs.readFileSync(path.join(__dirname, '..', 'runtime', 'structured-allocation-prerequisites-contract.js'), 'utf8');
  for (const forbidden of [
    'callModelProvider', 'provider-request', 'createAllocationPlan(', 'createRun(',
    'prepareAgentRunDraft', 'scheduler', 'completion evaluator', 'workspaceProvider',
    'browserProvider', 'processProvider'
  ]) {
    assert.equal(contractSource.includes(forbidden), false, `forbidden Tranche 2A source boundary: ${forbidden}`);
  }

  console.log('structured allocation prerequisites contract tests passed');
}

main();

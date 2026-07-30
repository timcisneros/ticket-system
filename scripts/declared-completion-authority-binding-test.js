#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  assertDeclaredWorkCompletionAuthorityBinding,
  buildDeclaredWorkSnapshot,
  canonicalJson,
  hashCanonical,
  normalizeDeclaredWorkSnapshot,
  projectDeclaredWorkForRun
} = require('../runtime/declared-work-contract');
const {
  buildCompletionAuthoritySnapshot
} = require('../runtime/completion-decision-contract');

const NOW = '2026-07-30T00:00:00.000Z';

function completionAuthority({
  objective = 'Create folder reports',
  kind = 'deterministic',
  recognized = true,
  intent = 'create_folder',
  completionPolicy = 'declared_postconditions',
  directPostconditions = []
} = {}) {
  return buildCompletionAuthoritySnapshot({
    objective,
    kind,
    recognized,
    intent,
    completionPolicy,
    directPostconditions,
    verificationPolicy: 'when_declared',
    capturedAt: NOW
  });
}

function snapshotWith(snapshot, mutate) {
  const value = JSON.parse(JSON.stringify(snapshot));
  delete value.contractHash;
  mutate(value);
  const withoutHash = {
    version: value.version,
    objective: value.objective,
    expectedOutputs: value.expectedOutputs,
    successCriteria: value.successCriteria
      .map(item => ({ item, key: canonicalJson(item) }))
      .sort((left, right) => left.key < right.key ? -1 : left.key > right.key ? 1 : 0)
      .map(entry => entry.item),
    evidenceRequirements: value.evidenceRequirements
      .map(item => ({ item, key: canonicalJson(item) }))
      .sort((left, right) => left.key < right.key ? -1 : left.key > right.key ? 1 : 0)
      .map(entry => entry.item)
  };
  return normalizeDeclaredWorkSnapshot({
    ...withoutHash,
    contractHash: hashCanonical(withoutHash)
  });
}

function typedCriterion(postcondition, provenance) {
  const declaration = canonicalJson(postcondition);
  return {
    kind: 'typed-postcondition',
    criterionType: postcondition.type,
    declaration,
    criterionHash: require('node:crypto').createHash('sha256').update(declaration).digest('hex'),
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

const directPostcondition = { type: 'folder_exists', path: 'reports' };
const directAuthority = completionAuthority({
  directPostconditions: [directPostcondition]
});
const directSnapshot = buildDeclaredWorkSnapshot({
  ticket: { objective: 'Create folder reports', acceptanceCriteria: 'Suitable for review.' },
  completionAuthoritySnapshot: directAuthority
});
const directBinding = assertDeclaredWorkCompletionAuthorityBinding({
  declaredWorkSnapshot: directSnapshot,
  completionAuthoritySnapshot: directAuthority
});
assert.equal(directBinding.status, 'bound');
assert.equal(directBinding.criteria.length, 1);
assert.equal(directBinding.criteria[0].criterionType, 'folder_exists');
assert.equal(directBinding.criteria[0].authoritySource, 'completion-authority-snapshot');
assert.deepEqual(
  assertDeclaredWorkCompletionAuthorityBinding({
    declaredWorkSnapshot: JSON.parse(JSON.stringify(directSnapshot)),
    completionAuthoritySnapshot: JSON.parse(JSON.stringify(directAuthority))
  }),
  directBinding,
  'exact reconstruction must preserve the binding and its hash'
);

assert.throws(
  () => assertDeclaredWorkCompletionAuthorityBinding({
    declaredWorkSnapshot: directSnapshot,
    completionAuthoritySnapshot: null
  }),
  error => error.code === 'DECLARED_COMPLETION_AUTHORITY_MISMATCH' &&
    /require an immutable completionAuthoritySnapshot/.test(error.message),
  'a declared typed criterion without completion authority must fail admission'
);

const workflowPostcondition = {
  id: 'summary',
  type: 'fileExists',
  path: '{{workflow.input.outputPath}}/summary.md'
};
const workflowAuthority = completionAuthority({
  objective: 'Run the report workflow',
  kind: 'workflow',
  intent: 'workflow',
  completionPolicy: 'workflow_terminal'
});
const workflow = {
  id: 'report-workflow',
  name: 'Report workflow',
  version: '4',
  postconditions: [workflowPostcondition],
  verifierContract: { expectedArtifacts: ['reports/summary.md'] }
};
const workflowSnapshot = buildDeclaredWorkSnapshot({
  ticket: { objective: 'Run the report workflow', acceptanceCriteria: null },
  workflow,
  completionAuthoritySnapshot: workflowAuthority
});
const verificationContractSnapshot = {
  workflowId: workflow.id,
  workflowName: workflow.name,
  workflowVersion: workflow.version,
  postconditions: workflow.postconditions,
  verifierContract: workflow.verifierContract,
  capturedAt: NOW
};
const workflowBinding = assertDeclaredWorkCompletionAuthorityBinding({
  declaredWorkSnapshot: workflowSnapshot,
  completionAuthoritySnapshot: workflowAuthority,
  verificationContractSnapshot
});
assert.equal(workflowBinding.criteria[0].authoritySource, 'verification-contract-snapshot');
assert.throws(
  () => assertDeclaredWorkCompletionAuthorityBinding({
    declaredWorkSnapshot: workflowSnapshot,
    completionAuthoritySnapshot: null,
    verificationContractSnapshot
  }),
  error => error.code === 'DECLARED_COMPLETION_AUTHORITY_MISMATCH' &&
    /completionAuthoritySnapshot/.test(error.message),
  'a workflow verification snapshot cannot replace the required run completion authority'
);

const wrongType = {
  id: 'summary',
  type: 'fileContains',
  path: '{{workflow.input.outputPath}}/summary.md',
  contains: 'done'
};
const wrongTypeCriterion = typedCriterion(wrongType, 'workflow-defined');
const wrongTypeSnapshot = snapshotWith(workflowSnapshot, value => {
  value.successCriteria = [wrongTypeCriterion];
  value.evidenceRequirements = [evidenceFor(wrongTypeCriterion)];
});
assert.throws(
  () => assertDeclaredWorkCompletionAuthorityBinding({
    declaredWorkSnapshot: wrongTypeSnapshot,
    completionAuthoritySnapshot: workflowAuthority,
    verificationContractSnapshot
  }),
  error => error.code === 'DECLARED_COMPLETION_AUTHORITY_MISMATCH' &&
    /has type fileContains/.test(error.message),
  'the same criterion identity with a different type must fail'
);

const wrongDeclaration = {
  ...workflowPostcondition,
  path: '{{workflow.input.outputPath}}/other.md'
};
const wrongDeclarationCriterion = typedCriterion(wrongDeclaration, 'workflow-defined');
const wrongDeclarationSnapshot = snapshotWith(workflowSnapshot, value => {
  value.successCriteria = [wrongDeclarationCriterion];
  value.evidenceRequirements = [evidenceFor(wrongDeclarationCriterion)];
});
assert.throws(
  () => assertDeclaredWorkCompletionAuthorityBinding({
    declaredWorkSnapshot: wrongDeclarationSnapshot,
    completionAuthoritySnapshot: workflowAuthority,
    verificationContractSnapshot
  }),
  error => error.code === 'DECLARED_COMPLETION_AUTHORITY_MISMATCH' &&
    /normalized completion declaration/.test(error.message),
  'a self-consistent declared hash cannot conceal a different normalized declaration'
);

const invalidCriterionHash = JSON.parse(JSON.stringify(workflowSnapshot));
const typedIndex = invalidCriterionHash.successCriteria.findIndex(item =>
  item.kind === 'typed-postcondition');
invalidCriterionHash.successCriteria[typedIndex].criterionHash = 'f'.repeat(64);
const invalidWithoutHash = { ...invalidCriterionHash };
delete invalidWithoutHash.contractHash;
invalidCriterionHash.contractHash = hashCanonical(invalidWithoutHash);
assert.throws(
  () => assertDeclaredWorkCompletionAuthorityBinding({
    declaredWorkSnapshot: invalidCriterionHash,
    completionAuthoritySnapshot: workflowAuthority,
    verificationContractSnapshot
  }),
  error => error.code === 'DECLARED_WORK_SNAPSHOT_INVALID' &&
    /criterionHash does not match/.test(error.message),
  'criterion hash tampering must fail before authority comparison'
);

const conflictOne = typedCriterion(workflowPostcondition, 'workflow-defined');
const conflictTwo = typedCriterion(wrongDeclaration, 'workflow-defined');
const conflictingSnapshot = snapshotWith(workflowSnapshot, value => {
  value.successCriteria = [conflictOne, conflictTwo];
  value.evidenceRequirements = [evidenceFor(conflictOne), evidenceFor(conflictTwo)];
});
assert.throws(
  () => assertDeclaredWorkCompletionAuthorityBinding({
    declaredWorkSnapshot: conflictingSnapshot,
    completionAuthoritySnapshot: workflowAuthority,
    verificationContractSnapshot
  }),
  error => error.code === 'DECLARED_COMPLETION_AUTHORITY_MISMATCH' &&
    /conflicting criteria/.test(error.message),
  'equal workflow criterion identity cannot carry contradictory declarations'
);

const missingEvidenceRequirement = snapshotWith(workflowSnapshot, value => {
  value.evidenceRequirements = [];
});
assert.throws(
  () => assertDeclaredWorkCompletionAuthorityBinding({
    declaredWorkSnapshot: missingEvidenceRequirement,
    completionAuthoritySnapshot: workflowAuthority,
    verificationContractSnapshot
  }),
  error => error.code === 'DECLARED_COMPLETION_AUTHORITY_MISMATCH' &&
    /no matching evidence requirement/.test(error.message),
  'a typed criterion cannot lose its admitted deterministic evidence requirement'
);

const unsupportedProvenanceCriterion = {
  ...typedCriterion(workflowPostcondition, 'validated-model-contract')
};
const unsupportedProvenance = snapshotWith(workflowSnapshot, value => {
  value.successCriteria = [unsupportedProvenanceCriterion];
  value.evidenceRequirements = [evidenceFor(unsupportedProvenanceCriterion)];
});
assert.throws(
  () => assertDeclaredWorkCompletionAuthorityBinding({
    declaredWorkSnapshot: unsupportedProvenance,
    completionAuthoritySnapshot: workflowAuthority,
    verificationContractSnapshot
  }),
  error => error.code === 'DECLARED_COMPLETION_AUTHORITY_MISMATCH' &&
    /has no admitted completion authority/.test(error.message),
  'the unused model provenance vocabulary cannot be activated by persisted data'
);

const textOnlyAuthority = completionAuthority({
  objective: 'Review the evidence',
  kind: 'unrecognized',
  recognized: false,
  intent: 'model_driven',
  completionPolicy: 'explicit_evidence_required'
});
const textOnly = buildDeclaredWorkSnapshot({
  ticket: {
    objective: 'Review the evidence',
    acceptanceCriteria: 'The review should be clear.'
  },
  completionAuthoritySnapshot: textOnlyAuthority
});
const textBinding = assertDeclaredWorkCompletionAuthorityBinding({
  declaredWorkSnapshot: textOnly,
  completionAuthoritySnapshot: textOnlyAuthority
});
assert.equal(textBinding.criteria.length, 0,
  'textual acceptance criteria remain excluded from hard completion binding');
const omittedDirectCriterion = snapshotWith(directSnapshot, value => {
  value.successCriteria = value.successCriteria.filter(item => item.kind === 'text');
  value.evidenceRequirements = [];
});
assert.throws(
  () => assertDeclaredWorkCompletionAuthorityBinding({
    declaredWorkSnapshot: omittedDirectCriterion,
    completionAuthoritySnapshot: directAuthority
  }),
  error => error.code === 'DECLARED_COMPLETION_AUTHORITY_MISMATCH' &&
    /absent from declared work/.test(error.message),
  'completion authority cannot contain a hidden typed criterion omitted from declared work'
);

const projected = projectDeclaredWorkForRun({
  id: 8,
  declaredWorkSnapshot: workflowSnapshot,
  completionAuthoritySnapshot: workflowAuthority,
  verificationContractSnapshot
});
assert.equal(projected.availability, 'available');
assert.equal(projected.snapshot.contractHash, workflowSnapshot.contractHash);
assert.throws(
  () => projectDeclaredWorkForRun({
    id: 9,
    declaredWorkSnapshot: workflowSnapshot,
    completionAuthoritySnapshot: workflowAuthority,
    verificationContractSnapshot: {
      ...verificationContractSnapshot,
      postconditions: [wrongDeclaration]
    }
  }),
  error => error.code === 'DECLARED_COMPLETION_AUTHORITY_MISMATCH',
  'restart reconstruction must fail closed on authority drift'
);
assert.deepEqual(projectDeclaredWorkForRun({ id: 10 }), {
  availability: 'historical-unavailable',
  snapshot: null
});

const source = fs.readFileSync(
  path.join(__dirname, '..', 'runtime', 'declared-work-contract.js'),
  'utf8'
);
const completionSource = fs.readFileSync(
  path.join(__dirname, '..', 'runtime', 'completion-decision-contract.js'),
  'utf8'
);
const serverSource = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
assert.equal(/browser[A-Z][A-Za-z]*Equals|browserOperationExists/.test(source), false,
  'no browser criterion exists without an immutable admission source');
assert.equal(source.includes('evaluateDeclaredCriteria'), false,
  'binding must not become a second completion evaluator');
assert.equal(completionSource.includes('declaredWorkSnapshot'), false,
  'declared work remains a checked declaration rather than completion authority');
assert(serverSource.includes('assertDeclaredWorkCompletionAuthorityBinding({'),
  'public run admission must enforce the binding before execution');
for (const forbidden of [
  'runtime/work-primitive.js',
  'runtime/playbook-registry.js',
  'runtime/target-contract.js',
  'runtime/target-registry.js',
  'runtime/generic-predicate-language.js'
]) {
  assert.equal(fs.existsSync(path.join(__dirname, '..', forbidden)), false,
    `Tranche 3 must not introduce ${forbidden}`);
}
assert.equal(
  fs.readdirSync(path.join(__dirname, '..', 'persistence', 'postgres', 'migrations'))
    .some(name => /declared.*criter|typed.*criter/i.test(name)),
  false,
  'the binding must reuse existing run authority without a migration'
);

console.log('PASS: declared typed criteria bind exactly to immutable completion authority');

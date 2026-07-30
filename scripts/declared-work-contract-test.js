#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  DECLARED_WORK_PROVENANCE,
  DECLARED_WORK_SOURCE_PRECEDENCE,
  buildDeclaredWorkSnapshot,
  canonicalJson,
  normalizeDeclaredWorkSnapshot,
  projectDeclaredWorkForModel,
  projectDeclaredWorkForRun
} = require('../runtime/declared-work-contract');

const ticket = {
  id: 41,
  objective: 'Create the exact admitted report.',
  acceptanceCriteria: 'The report must be suitable for review.',
  plannedActions: [{ operation: 'writeFile', args: { path: '/private/not-authority.txt' } }],
  browserCredentials: 'PRIVATE BROWSER CREDENTIAL',
  processEnvironment: { SECRET: 'PRIVATE PROCESS SECRET' },
  modelGeneratedObjective: 'Model replacement must not become authority',
  modelGeneratedCriteria: ['Model criterion must not become authority']
};
const directAuthority = {
  objectiveContract: {
    directPostconditions: [
      { type: 'folder_exists', path: 'reports' },
      {
        type: 'file_content_equals',
        path: 'reports/result.txt',
        contentSha256: 'a'.repeat(64)
      }
    ]
  }
};

const direct = buildDeclaredWorkSnapshot({
  ticket,
  completionAuthoritySnapshot: directAuthority
});
assert.equal(direct.version, 1);
assert.equal(direct.objective.text, ticket.objective);
assert.equal(direct.objective.provenance, 'ticket-authored');
assert.deepEqual(direct.expectedOutputs, [],
  'planned workspace actions must not become declared expected outputs');
assert.equal(direct.successCriteria.filter(item => item.kind === 'text').length, 1);
assert.equal(
  direct.successCriteria.filter(item => item.kind === 'typed-postcondition').length,
  2
);
assert.equal(direct.evidenceRequirements.length, 2);
assert(direct.evidenceRequirements.every(item =>
  item.evidenceType === 'deterministic-postcondition-result'));
assert.equal(Object.isFrozen(direct), true);
assert.equal(Object.isFrozen(direct.successCriteria), true);
assert.equal(JSON.stringify(direct).includes('Model replacement'), false);
assert.equal(JSON.stringify(direct).includes('Model criterion'), false);

const normalized = normalizeDeclaredWorkSnapshot(JSON.parse(JSON.stringify(direct)));
assert.deepEqual(normalized, direct);
assert.equal(normalized.contractHash, direct.contractHash);
assert.equal(canonicalJson(normalized), canonicalJson(direct));

const workflow = {
  id: 'declared-workflow',
  version: '7',
  verifierContract: {
    id: 'declared-verifier',
    version: '2',
    expectedArtifacts: [
      'reports/summary.md',
      'reports/results.csv',
      'reports/summary.md'
    ]
  },
  postconditions: [
    { id: 'summary', type: 'fileExists', path: '{{workflow.input.outputPath}}/summary.md' },
    {
      id: 'result-count',
      type: 'outputFieldEquals',
      field: 'recordCount',
      equals: 3
    }
  ],
  actions: [
    { id: 'write', action: 'writeFile', input: { path: 'not-an-output-source.txt' } }
  ]
};
const workflowSnapshot = buildDeclaredWorkSnapshot({
  ticket,
  workflow,
  completionAuthoritySnapshot: directAuthority
});
assert.deepEqual(
  workflowSnapshot.expectedOutputs.map(item => item.declaration),
  ['reports/results.csv', 'reports/summary.md'],
  'workflow verifier declarations must be deduplicated and ordered deterministically'
);
assert(workflowSnapshot.expectedOutputs.every(item =>
  item.provenance === 'workflow-defined'));
assert(workflowSnapshot.successCriteria.some(item =>
  item.criterionType === 'outputFieldEquals' &&
  item.provenance === 'workflow-defined'));
assert.equal(workflowSnapshot.successCriteria.some(item =>
  item.provenance === 'deterministic-objective-contract'), false,
  'workflow authority must not be merged with direct deterministic objective authority');
assert.equal(JSON.stringify(workflowSnapshot).includes('not-an-output-source'), false,
  'workflow actions must not be inferred as expected outputs');

const sourceCopy = JSON.parse(JSON.stringify(workflowSnapshot));
ticket.objective = 'Changed mutable ticket objective';
ticket.acceptanceCriteria = 'Changed mutable acceptance criteria';
workflow.verifierContract.expectedArtifacts.push('reports/later.md');
workflow.postconditions[0].path = 'changed.md';
assert.deepEqual(workflowSnapshot, sourceCopy,
  'an admitted snapshot must not follow later ticket or workflow changes');

const modelProjection = projectDeclaredWorkForModel(workflowSnapshot);
assert.deepEqual(Object.keys(modelProjection), [
  'objective',
  'expectedOutputs',
  'successCriteria',
  'evidenceRequirements'
]);
assert.equal(JSON.stringify(modelProjection).includes('browserCredentials'), false);
assert.equal(JSON.stringify(modelProjection).includes('processEnvironment'), false);
assert.equal(Object.prototype.hasOwnProperty.call(modelProjection, 'contractHash'), false,
  'model context needs declared content, not internal authority identity');

const historical = projectDeclaredWorkForRun({ id: 1, objective: 'legacy' });
assert.deepEqual(historical, {
  availability: 'historical-unavailable',
  snapshot: null
});
assert.deepEqual(projectDeclaredWorkForRun({
  id: 2,
  declaredWorkSnapshot: workflowSnapshot,
  completionAuthoritySnapshot: {
    objectiveContract: { kind: 'workflow', directPostconditions: [] }
  },
  verificationContractSnapshot: {
    workflowId: 'declared-workflow',
    postconditions: workflowSnapshot.successCriteria
      .filter(item => item.kind === 'typed-postcondition')
      .map(item => JSON.parse(item.declaration))
  }
}), {
  availability: 'available',
  snapshot: workflowSnapshot
});

assert.throws(
  () => normalizeDeclaredWorkSnapshot({ ...workflowSnapshot, unexpected: true }),
  error => error.code === 'DECLARED_WORK_SNAPSHOT_INVALID' &&
    /unknown field/.test(error.message)
);
assert.throws(
  () => normalizeDeclaredWorkSnapshot({ ...workflowSnapshot, version: 2 }),
  error => error.code === 'DECLARED_WORK_SNAPSHOT_INVALID' &&
    /Unsupported/.test(error.message)
);
assert.throws(
  () => normalizeDeclaredWorkSnapshot({
    ...workflowSnapshot,
    objective: { ...workflowSnapshot.objective, text: 'tampered' }
  }),
  error => error.code === 'DECLARED_WORK_SNAPSHOT_CONFLICT'
);
assert.throws(
  () => buildDeclaredWorkSnapshot({
    ticket: { objective: 'Contradictory workflow' },
    workflow: {
      verifierContract: { expectedArtifacts: [] },
      postconditions: [
        { id: 'same-id', type: 'fileExists', path: 'one.txt' },
        { id: 'same-id', type: 'fileExists', path: 'two.txt' }
      ]
    }
  }),
  error => error.code === 'DECLARED_WORK_AUTHORITY_CONFLICT'
);

assert.deepEqual(DECLARED_WORK_SOURCE_PRECEDENCE, [
  'ticket-authored',
  'workflow-defined',
  'deterministic-objective-contract',
  'validated-model-contract',
  'legacy-compatibility',
  'absent'
]);
assert.deepEqual(DECLARED_WORK_PROVENANCE, DECLARED_WORK_SOURCE_PRECEDENCE);

const source = fs.readFileSync(
  path.join(__dirname, '..', 'runtime', 'declared-work-contract.js'),
  'utf8'
);
const serverSource = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const completionSource = fs.readFileSync(
  path.join(__dirname, '..', 'runtime', 'completion-decision-contract.js'),
  'utf8'
);
assert.equal(source.includes('.localeCompare('), false,
  'declared-work ordering must not depend on locale');
for (const forbidden of [
  'target-contract',
  'target-registry',
  'WorkPrimitive',
  'playbookRegistry',
  'evaluateDeclaredCriteria',
  'plannedActions',
  'browserCredentials',
  'processEnvironment'
]) {
  assert.equal(source.includes(forbidden), false,
    `declared-work authority must not introduce or consume ${forbidden}`);
}
assert.equal(completionSource.includes('declaredWorkSnapshot'), false,
  'declared work must not enter completion-decision authority in this tranche');
const builderIndex = serverSource.indexOf(
  'const declaredWorkSnapshot = buildDeclaredWorkSnapshot({'
);
assert(builderIndex >= 0 &&
  serverSource.indexOf('\n    declaredWorkSnapshot,', builderIndex) > builderIndex,
  'declared work is constructed before the admitted run draft is assembled');
assert(serverSource.includes('const promptTicket = buildAdmittedTicketProjection(run, ticket);'),
  'one canonical admitted projection supplies planning and model context');
assert.equal(
  fs.readdirSync(path.join(__dirname, '..', 'persistence', 'postgres', 'migrations'))
    .some(name => /declared[_-]work/i.test(name)),
  false,
  'declared work reuses the existing immutable run authority field without a migration'
);
for (const forbiddenPath of [
  'runtime/target-contract.js',
  'runtime/target-registry.js',
  'runtime/work-primitive.js',
  'runtime/playbook-registry.js'
]) {
  assert.equal(fs.existsSync(path.join(__dirname, '..', forbiddenPath)), false,
    `Tranche 2 must not introduce ${forbiddenPath}`);
}

console.log('PASS: declared-work contract is closed, immutable, deterministic, and non-evaluating');

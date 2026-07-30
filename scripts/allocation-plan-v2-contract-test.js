#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  buildAllocationPlanV2,
  createAllocationPlanV2StorageBody,
  materializeAllocationPlanV2Draft,
  normalizeAllocationPlanV2,
  normalizeOwnedOutputPath,
  normalizeStoredAllocationPlanV2,
  pathIsInsideOwnedOutputPaths,
  serializeAllocationPlanV2StorageBody
} = require('../runtime/allocation-plan-contract');
const {
  canonicalJson,
  hashCanonical,
  normalizeDeclaredWorkSnapshot
} = require('../runtime/declared-work-contract');
const {
  isPathInsideOwnedOutputPaths,
  normalizeWorkspaceOwnershipPath,
  normalizeWorkspaceRelativePath,
  workspaceOwnershipPathsOverlap
} = require('../runtime/authority-paths');

function typedCriterion(postcondition, provenance = 'workflow-defined') {
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

function canonicalSort(items) {
  return [...items].sort((left, right) =>
    canonicalJson(left) < canonicalJson(right) ? -1 : canonicalJson(left) > canonicalJson(right) ? 1 : 0);
}

function declaredWorkSnapshot() {
  const alphaCriterion = typedCriterion({
    id: 'alpha-result',
    type: 'fileExists',
    path: 'alpha/result.txt'
  });
  const betaCriterion = typedCriterion({
    id: 'beta-result',
    type: 'fileExists',
    path: 'beta/result.txt'
  });
  const withoutHash = {
    version: 1,
    objective: {
      text: 'Produce independently owned result files for review.',
      provenance: 'ticket-authored'
    },
    expectedOutputs: canonicalSort([
      {
        kind: 'workflow-artifact',
        declaration: 'beta/result.txt',
        provenance: 'workflow-defined'
      },
      {
        kind: 'workflow-artifact',
        declaration: 'alpha/result.txt',
        provenance: 'workflow-defined'
      }
    ]),
    successCriteria: canonicalSort([
      {
        kind: 'text',
        declaration: 'Each result must be ready for review.',
        provenance: 'ticket-authored'
      },
      betaCriterion,
      alphaCriterion
    ]),
    evidenceRequirements: canonicalSort([
      evidenceFor(betaCriterion),
      evidenceFor(alphaCriterion)
    ])
  };
  return normalizeDeclaredWorkSnapshot({
    ...withoutHash,
    contractHash: hashCanonical(withoutHash)
  });
}

function textItem({
  allocationItemId = 11,
  assignedAgentId = 101,
  ownedOutputPaths = ['alpha'],
  outputPath = 'alpha/result.txt',
  objectiveText = 'Produce the Alpha result file.'
} = {}) {
  return {
    allocationItemId,
    assignedAgentId,
    ownedOutputPaths,
    objective: {
      text: objectiveText,
      provenance: 'validated-model-contract'
    },
    expectedOutputs: [{
      kind: 'workflow-artifact',
      declaration: outputPath,
      provenance: 'workflow-defined'
    }],
    successCriteria: [{
      kind: 'text',
      declaration: 'The allocated result must be ready for review.',
      provenance: 'ticket-authored'
    }],
    evidenceRequirements: []
  };
}

function typedItem(options = {}) {
  const base = textItem(options);
  const pathValue = options.outputPath || 'alpha/result.txt';
  const criterion = typedCriterion({
    id: `result-${base.allocationItemId}`,
    type: 'fileExists',
    path: pathValue
  });
  return {
    ...base,
    successCriteria: [
      ...base.successCriteria,
      criterion
    ],
    evidenceRequirements: [evidenceFor(criterion)]
  };
}

function planInput(overrides = {}) {
  return {
    version: 2,
    id: 7,
    ticketId: 41,
    mode: 'owned_paths',
    parentDeclaredWorkSnapshot: clone(declaredWorkSnapshot()),
    sharedConstraints: [],
    items: [textItem()],
    ...overrides
  };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function expectInvalid(mutator, pattern = null, code = null) {
  const source = clone(planInput());
  mutator(source);
  assert.throws(
    () => buildAllocationPlanV2(source),
    error => (!code || error.code === code) && (!pattern || pattern.test(error.message)),
    pattern ? `expected contract refusal matching ${pattern}` : 'expected contract refusal'
  );
}

const minimal = buildAllocationPlanV2(planInput());
assert.equal(minimal.version, 2);
assert.equal(minimal.items[0].objective.text, 'Produce the Alpha result file.');
assert.deepEqual(minimal.items[0].evidenceRequirements, [],
  'an explicit empty evidence array remains canonical when no typed criterion requires evidence');
assert.match(minimal.planHash, /^[0-9a-f]{64}$/);

for (const [input, canonical] of [
  ['alpha', 'alpha/'],
  [' alpha/ ', 'alpha/'],
  ['./alpha', 'alpha/'],
  ['alpha//nested/..', 'alpha/']
]) {
  assert.equal(normalizeWorkspaceOwnershipPath(input), canonical);
  if (!input.includes('..')) assert.equal(normalizeOwnedOutputPath(input), canonical);
}
assert.equal(normalizeWorkspaceOwnershipPath('/alpha'), 'alpha/',
  'historical v1 strips a leading slash before persisting ownership');
assert.equal(normalizeWorkspaceOwnershipPath('alpha\\nested'), 'alpha/nested/',
  'historical v1 canonicalizes backslashes');
assert.equal(normalizeWorkspaceRelativePath('alpha/../beta'), 'beta',
  'the live provider permits internal normalization that remains inside its root');
assert.equal(normalizeWorkspaceRelativePath('.hidden', { allowHidden: true }), '.hidden',
  'historical v1 existence admission deliberately permits hidden ownership');
assert.throws(() => normalizeOwnedOutputPath('/alpha'), /workspace-relative/);
assert.throws(() => normalizeOwnedOutputPath('alpha\\nested'), /POSIX/);
assert.throws(() => normalizeOwnedOutputPath('alpha/../beta'), /escape/);
assert.throws(() => normalizeOwnedOutputPath('.hidden'), /hidden/);
assert.throws(
  () => normalizeWorkspaceRelativePath('/alpha'),
  error => error.code === 'WORKSPACE_ABSOLUTE_PATH'
);
assert.throws(
  () => normalizeWorkspaceRelativePath('../alpha'),
  error => error.code === 'WORKSPACE_PATH_TRAVERSAL'
);
assert.throws(
  () => normalizeWorkspaceRelativePath('.hidden'),
  error => error.code === 'WORKSPACE_HIDDEN_PATH'
);
assert.equal(workspaceOwnershipPathsOverlap('alpha', 'alpha/nested'), true);
assert.equal(workspaceOwnershipPathsOverlap('alpha', 'alphabet'), false);
assert.equal(pathIsInsideOwnedOutputPaths('alpha/result.txt', ['alpha/']), true);
assert.equal(
  pathIsInsideOwnedOutputPaths('alpha/result.txt', ['alpha/']),
  isPathInsideOwnedOutputPaths('alpha/result.txt', ['alpha/']),
  'v2 output containment and live mutation containment share one predicate'
);

const full = buildAllocationPlanV2(planInput({
  sharedConstraints: [
    {
      kind: 'text',
      declaration: 'Do not edit a sibling allocation.',
      provenance: 'validated-model-contract'
    },
    {
      kind: 'text',
      declaration: 'Use only durable declared evidence.',
      provenance: 'workflow-defined'
    }
  ],
  items: [
    typedItem(),
    typedItem({
      allocationItemId: 12,
      assignedAgentId: 102,
      ownedOutputPaths: ['beta/'],
      outputPath: 'beta/result.txt',
      objectiveText: 'Produce the Beta result file.'
    })
  ]
}));
assert.equal(full.items.length, 2);
assert.equal(full.items[0].successCriteria.length, 2);
assert.equal(full.items[0].evidenceRequirements.length, 1);

const equivalent = buildAllocationPlanV2(planInput({
  sharedConstraints: [...full.sharedConstraints].reverse(),
  items: [
    {
      ...clone(full.items[1]),
      ownedOutputPaths: ['beta//'],
      expectedOutputs: [{
        ...full.items[1].expectedOutputs[0],
        declaration: 'beta//result.txt'
      }],
      successCriteria: [...full.items[1].successCriteria].reverse()
    },
    {
      ...clone(full.items[0]),
      ownedOutputPaths: ['alpha/'],
      successCriteria: [...full.items[0].successCriteria].reverse()
    }
  ]
}));
assert.deepEqual(equivalent, full,
  'canonically equivalent order and path spelling must normalize identically');
assert.equal(equivalent.planHash, full.planHash);

assert.equal(Object.isFrozen(full), true);
assert.equal(Object.isFrozen(full.items), true);
assert.equal(Object.isFrozen(full.items[0]), true);
assert.equal(Object.isFrozen(full.items[0].objective), true);
assert.equal(Object.isFrozen(full.parentDeclaredWorkSnapshot), true);
assert.equal(Object.isFrozen(full.sharedConstraints), true);

const mutableSource = planInput({
  sharedConstraints: [{
    kind: 'text',
    declaration: 'Keep sibling output isolated.',
    provenance: 'validated-model-contract'
  }],
  items: [typedItem()]
});
const isolated = buildAllocationPlanV2(mutableSource);
const isolatedCopy = clone(isolated);
mutableSource.items[0].objective.text = 'MUTATED';
mutableSource.items[0].ownedOutputPaths[0] = 'elsewhere';
mutableSource.items[0].expectedOutputs[0].declaration = 'elsewhere/result.txt';
mutableSource.sharedConstraints[0].declaration = 'MUTATED';
mutableSource.parentDeclaredWorkSnapshot.objective.text = 'MUTATED';
assert.deepEqual(isolated, isolatedCopy,
  'later source-object mutation must not alter admitted authority or its hash');

expectInvalid(source => { source.unexpected = true; }, /unknown field/);
expectInvalid(source => { source.sharedConstraints = [{
  kind: 'text',
  declaration: 'Constraint',
  provenance: 'validated-model-contract',
  unexpected: true
}]; }, /unknown field/);
expectInvalid(source => { source.items[0].unexpected = true; }, /unknown field/);
expectInvalid(source => { source.items[0].expectedOutputs[0].unexpected = true; }, /unknown field/);
expectInvalid(source => { source.items[0].successCriteria[0].unexpected = true; }, /unknown field/);
expectInvalid(source => {
  const item = typedItem();
  item.evidenceRequirements[0].unexpected = true;
  source.items = [item];
}, /unknown field/);

expectInvalid(source => { delete source.parentDeclaredWorkSnapshot; }, /missing field/);
expectInvalid(source => { delete source.parentDeclaredWorkSnapshot.contractHash; }, /missing field/);
expectInvalid(source => {
  source.parentDeclaredWorkSnapshot.objective.text = 'Tampered parent';
}, /contractHash/, 'DECLARED_WORK_SNAPSHOT_CONFLICT');

expectInvalid(source => {
  source.items = [
    textItem(),
    textItem({
      allocationItemId: 11,
      assignedAgentId: 102,
      ownedOutputPaths: ['beta'],
      outputPath: 'beta/result.txt'
    })
  ];
}, /unique allocationItemId/);
expectInvalid(source => {
  source.items = [
    textItem(),
    textItem({
      allocationItemId: 12,
      assignedAgentId: 101,
      ownedOutputPaths: ['beta'],
      outputPath: 'beta/result.txt'
    })
  ];
}, /assign each agent/);

for (const malformed of ['', '/alpha', '../alpha', 'alpha/../../escape', 'alpha\\result', '.hidden/result']) {
  expectInvalid(source => {
    source.items[0].ownedOutputPaths = [malformed];
  }, /ownedOutputPaths|owned output|workspace|POSIX|hidden|escape|empty/);
}
expectInvalid(source => {
  source.items = [
    textItem({ ownedOutputPaths: ['alpha'] }),
    textItem({
      allocationItemId: 12,
      assignedAgentId: 102,
      ownedOutputPaths: ['alpha/nested'],
      outputPath: 'alpha/nested/result.txt'
    })
  ];
}, /overlap/, 'ALLOCATION_PLAN_V2_OWNERSHIP_OVERLAP');
expectInvalid(source => {
  source.items[0].expectedOutputs[0].declaration = 'beta/result.txt';
}, /outside owned output paths/, 'ALLOCATION_PLAN_V2_OUTPUT_OUTSIDE_OWNERSHIP');

expectInvalid(source => { delete source.items[0].objective; }, /missing field/);
expectInvalid(source => { source.items[0].objective.text = '   '; }, /must not be empty/);
expectInvalid(source => { delete source.items[0].expectedOutputs; }, /missing field/);
expectInvalid(source => { source.items[0].expectedOutputs = []; }, /at least one/);
expectInvalid(source => { delete source.items[0].successCriteria; }, /missing field/);
expectInvalid(source => { source.items[0].successCriteria = []; }, /at least one/);
expectInvalid(source => { delete source.items[0].evidenceRequirements; }, /missing field/);

expectInvalid(source => {
  const processCriterion = typedCriterion({
    id: 'process-result',
    type: 'processOperationExists',
    operationIdentity: `process-operation:${'a'.repeat(64)}`
  });
  source.items[0].successCriteria = [processCriterion];
  source.items[0].evidenceRequirements = [evidenceFor(processCriterion)];
}, /adds authority absent/, 'ALLOCATION_PLAN_V2_AUTHORITY_EXPANSION');
expectInvalid(source => {
  const fileContains = typedCriterion({
    id: 'contains-result',
    type: 'fileContains',
    path: 'alpha/result.txt',
    contains: 'ok'
  });
  source.items[0].successCriteria = [fileContains];
  source.items[0].evidenceRequirements = [evidenceFor(fileContains)];
}, /adds authority absent/, 'ALLOCATION_PLAN_V2_AUTHORITY_EXPANSION');
expectInvalid(source => {
  source.items[0].expectedOutputs = [{
    kind: 'text',
    declaration: 'A new output family.',
    provenance: 'workflow-defined'
  }];
}, /adds authority absent/, 'ALLOCATION_PLAN_V2_AUTHORITY_EXPANSION');
expectInvalid(source => {
  source.items = [typedItem()];
  source.items[0].evidenceRequirements = [];
}, /typed criterion without its declared evidence requirement/,
'DECLARED_WORK_EVIDENCE_MISMATCH');
expectInvalid(source => {
  source.items[0].evidenceRequirements = [{
    kind: 'postcondition-evidence',
    criterionHash: 'a'.repeat(64),
    evidenceType: 'deterministic-postcondition-result',
    provenance: 'workflow-defined'
  }];
}, /evidence requirement without its typed criterion/,
'DECLARED_WORK_EVIDENCE_MISMATCH');

const workflowCriterion = typedCriterion({
  id: 'mixed-workflow-result',
  type: 'fileExists',
  path: 'alpha/workflow.txt'
}, 'workflow-defined');
const validatedCriterion = typedCriterion({
  id: 'mixed-validated-result',
  type: 'fileExists',
  path: 'alpha/validated.txt'
}, 'validated-model-contract');
const mixedParentWithoutHash = {
  version: 1,
  objective: {
    text: 'Produce allocated results from mixed parent declarations.',
    provenance: 'ticket-authored'
  },
  expectedOutputs: canonicalSort([
    {
      kind: 'workflow-artifact',
      declaration: 'alpha/workflow.txt',
      provenance: 'workflow-defined'
    },
    {
      kind: 'workflow-artifact',
      declaration: 'alpha/validated.txt',
      provenance: 'validated-model-contract'
    }
  ]),
  successCriteria: canonicalSort([workflowCriterion, validatedCriterion]),
  evidenceRequirements: canonicalSort([
    evidenceFor(workflowCriterion),
    evidenceFor(validatedCriterion)
  ])
};
const mixedParent = normalizeDeclaredWorkSnapshot({
  ...mixedParentWithoutHash,
  contractHash: hashCanonical(mixedParentWithoutHash)
});
const narrowedCriterion = typedCriterion({
  id: 'mixed-narrowed-result',
  type: 'fileExists',
  path: 'alpha/narrowed.txt'
}, 'deterministic-objective-contract');
const mixedPlanInput = planInput({
  parentDeclaredWorkSnapshot: mixedParent,
  items: [{
    ...textItem(),
    expectedOutputs: [{
      kind: 'workflow-artifact',
      declaration: 'alpha/narrowed.txt',
      provenance: 'deterministic-objective-contract'
    }],
    successCriteria: [narrowedCriterion],
    evidenceRequirements: [evidenceFor(narrowedCriterion)]
  }]
});
assert.equal(buildAllocationPlanV2(mixedPlanInput).items[0].expectedOutputs[0].provenance,
  'deterministic-objective-contract',
  'multiple parent declarations of one family admit a weaker source without ambiguity');
const strongerMixedItem = clone(mixedPlanInput);
strongerMixedItem.items[0].expectedOutputs[0].provenance = 'ticket-authored';
assert.throws(
  () => buildAllocationPlanV2(strongerMixedItem),
  error => error.code === 'ALLOCATION_PLAN_V2_AUTHORITY_EXPANSION'
);
const strongerMixedCriterion = clone(mixedPlanInput);
strongerMixedCriterion.items[0].successCriteria[0].provenance = 'ticket-authored';
strongerMixedCriterion.items[0].evidenceRequirements[0].provenance = 'ticket-authored';
assert.throws(
  () => buildAllocationPlanV2(strongerMixedCriterion),
  error => error.code === 'ALLOCATION_PLAN_V2_AUTHORITY_EXPANSION'
);

const parentWithoutEvidenceFields = {
  ...mixedParentWithoutHash,
  evidenceRequirements: []
};
const parentWithoutEvidence = normalizeDeclaredWorkSnapshot({
  ...parentWithoutEvidenceFields,
  contractHash: hashCanonical(parentWithoutEvidenceFields)
});
const evidenceExpansionCriterion = typedCriterion({
  id: 'evidence-expansion-result',
  type: 'fileExists',
  path: 'alpha/evidence.txt'
});
assert.throws(
  () => buildAllocationPlanV2(planInput({
    parentDeclaredWorkSnapshot: parentWithoutEvidence,
    items: [{
      ...textItem(),
      expectedOutputs: [{
        kind: 'workflow-artifact',
        declaration: 'alpha/evidence.txt',
        provenance: 'workflow-defined'
      }],
      successCriteria: [evidenceExpansionCriterion],
      evidenceRequirements: [evidenceFor(evidenceExpansionCriterion)]
    }]
  })),
  error => error.code === 'ALLOCATION_PLAN_V2_AUTHORITY_EXPANSION' &&
    /evidenceRequirements/.test(error.message)
);

const weakParentWithoutHash = {
  version: 1,
  objective: { text: 'Produce a validated result.', provenance: 'validated-model-contract' },
  expectedOutputs: [{
    kind: 'workflow-artifact',
    declaration: 'alpha/result.txt',
    provenance: 'validated-model-contract'
  }],
  successCriteria: [{
    kind: 'text',
    declaration: 'The result is reviewable.',
    provenance: 'validated-model-contract'
  }],
  evidenceRequirements: []
};
const weakParent = normalizeDeclaredWorkSnapshot({
  ...weakParentWithoutHash,
  contractHash: hashCanonical(weakParentWithoutHash)
});
const weakPlan = planInput({
  parentDeclaredWorkSnapshot: weakParent,
  sharedConstraints: [{
    kind: 'text',
    declaration: 'Coordinate only within admitted authority.',
    provenance: 'validated-model-contract'
  }],
  items: [{
    ...textItem(),
    objective: { text: 'Produce the validated result.', provenance: 'validated-model-contract' },
    expectedOutputs: weakParent.expectedOutputs,
    successCriteria: weakParent.successCriteria
  }]
});
assert.equal(buildAllocationPlanV2(weakPlan).sharedConstraints.length, 1);
const strongerConstraint = clone(weakPlan);
strongerConstraint.sharedConstraints[0].provenance = 'workflow-defined';
assert.throws(
  () => buildAllocationPlanV2(strongerConstraint),
  error => error.code === 'ALLOCATION_PLAN_V2_AUTHORITY_EXPANSION'
);
expectInvalid(source => {
  source.sharedConstraints = [{
    kind: 'text',
    declaration: 'Use the browser.',
    provenance: 'validated-model-contract',
    allowedOperationFamilies: ['browser']
  }];
}, /unknown field/);

const tampered = clone(full);
tampered.items[0].objective.text = 'Tampered after hash generation';
assert.throws(
  () => normalizeAllocationPlanV2(tampered),
  error => error.code === 'ALLOCATION_PLAN_V2_HASH_MISMATCH'
);

const createdAt = '2026-07-30T12:00:00.000Z';
const body = createAllocationPlanV2StorageBody(full, createdAt);
const stored = normalizeStoredAllocationPlanV2({
  id: full.id,
  ticketId: full.ticketId,
  status: 'pending',
  revision: 1,
  createdAt,
  updatedAt: createdAt,
  body
});
assert.equal(Object.isFrozen(stored), true);
assert.equal(stored.items[0].status, 'pending');
const changedStatuses = stored.itemStatuses.map((item, index) =>
  index === 0 ? { ...item, status: 'running' } : item);
const changedBody = serializeAllocationPlanV2StorageBody(stored, changedStatuses);
const changedStored = normalizeStoredAllocationPlanV2({
  id: full.id,
  ticketId: full.ticketId,
  status: 'running',
  revision: 2,
  createdAt,
  updatedAt: '2026-07-30T12:01:00.000Z',
  body: changedBody
});
assert.equal(changedStored.planHash, stored.planHash,
  'mutable item and plan status must not alter immutable plan authority');
assert.deepEqual(
  changedStored.items.map(item => {
    const { status, createdAt: itemCreatedAt, ...authority } = item;
    void status;
    void itemCreatedAt;
    return authority;
  }),
  stored.items.map(item => {
    const { status, createdAt: itemCreatedAt, ...authority } = item;
    void status;
    void itemCreatedAt;
    return authority;
  })
);

const draft = {
  version: 2,
  ticketId: 41,
  mode: 'owned_paths',
  parentDeclaredWorkSnapshot: declaredWorkSnapshot(),
  sharedConstraints: [],
  items: [(() => {
    const item = textItem();
    delete item.allocationItemId;
    return item;
  })()]
};
const materialized = materializeAllocationPlanV2Draft(draft, {
  id: 99,
  allocationItemIds: [501]
});
assert.equal(materialized.id, 99);
assert.equal(materialized.items[0].allocationItemId, 501);

const unorderedDraft = {
  ...draft,
  items: [
    (() => {
      const item = textItem({
        allocationItemId: 12,
        assignedAgentId: 102,
        ownedOutputPaths: ['beta'],
        outputPath: 'beta/result.txt'
      });
      delete item.allocationItemId;
      return item;
    })(),
    draft.items[0]
  ]
};
const orderedDraft = {
  ...unorderedDraft,
  items: [...unorderedDraft.items].reverse()
};
const draftIdentities = { id: 100, allocationItemIds: [601, 602] };
assert.deepEqual(
  materializeAllocationPlanV2Draft(unorderedDraft, draftIdentities),
  materializeAllocationPlanV2Draft(orderedDraft, draftIdentities),
  'identity assignment follows canonical agent ordering, not caller array order'
);

const historicalV1 = {
  id: 3,
  ticketId: 41,
  ticketOpenedAt: '2026-07-01T00:00:00.000Z',
  mode: 'owned_paths',
  status: 'completed',
  items: [{
    allocationItemId: 8,
    assignedAgentId: 101,
    allocationSubtask: 'Historical v1 subtask.',
    ownedOutputPaths: ['alpha/'],
    status: 'completed',
    createdAt
  }]
};
const historicalCopy = clone(historicalV1);
assert.deepEqual(historicalV1, historicalCopy);
assert.equal(Object.prototype.hasOwnProperty.call(historicalV1, 'version'), false);
assert.throws(() => normalizeAllocationPlanV2(historicalV1),
  error => error.code === 'ALLOCATION_PLAN_V2_INVALID');

const contractSource = fs.readFileSync(
  path.join(__dirname, '..', 'runtime', 'allocation-plan-contract.js'),
  'utf8'
);
for (const forbidden of [
  'callModelProvider',
  'createRuntimeScheduler',
  'createRunsForTicket',
  'prepareAgentRunDraft',
  'workspaceProvider',
  'browserEngine',
  'child_process',
  'PostgresRuntimeStore',
  'buildCompletionDecision',
  'evaluatePostconditions'
]) {
  assert.equal(contractSource.includes(forbidden), false,
    `allocation plan v2 contract must not invoke ${forbidden}`);
}
assert.equal(contractSource.includes('.localeCompare('), false,
  'allocation plan ordering must not depend on locale');
assert.equal(contractSource.includes('readProtectedWorkspacePaths'), false,
  'mutable protected-path configuration must not enter plan authority');
assert.equal(contractSource.includes('SENSITIVE_APPLICATION_PATHS'), false,
  'execution-only sensitive path policy must not enter plan authority');
for (const forbiddenPath of [
  'runtime/delegation-contract.js',
  'runtime/work-primitive.js',
  'runtime/target-contract.js',
  'runtime/allocation-router.js'
]) {
  assert.equal(fs.existsSync(path.join(__dirname, '..', forbiddenPath)), false,
    `Tranche 1 must not introduce ${forbiddenPath}`);
}
const migrationDirectory = path.join(__dirname, '..', 'persistence', 'postgres', 'migrations');
const postTrancheOneMigrations = fs.readdirSync(migrationDirectory)
  .filter(name => Number(name.slice(0, 3)) > 31);
assert.equal(
  postTrancheOneMigrations.some(name => /\ballocation_plans\b/i.test(
    fs.readFileSync(path.join(migrationDirectory, name), 'utf8')
  )),
  false,
  'later prerequisite migrations must not alter Allocation Plan v2 JSONB storage'
);

console.log('PASS: Allocation Plan v2 is closed, canonical, immutable, authority-bounded, and status-separated');

#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  assertDeclaredWorkCompletionAuthorityBinding,
  buildDeclaredWorkSnapshot,
  projectDeclaredWorkForRun
} = require('../runtime/declared-work-contract');
const {
  buildCompletionAuthoritySnapshot,
  buildCompletionDecision
} = require('../runtime/completion-decision-contract');
const {
  BROWSER_OPERATIONS,
  WORKSPACE_OPERATIONS,
  buildBrowserConsequences,
  deriveOperationFamilyCounts
} = require('../runtime/typed-evidence-projection');

const ROOT = path.resolve(__dirname, '..');
const AT = '2026-07-29T00:00:00.000Z';
const PROCESS_IDENTITY = `process-operation:${'a'.repeat(64)}`;
const TERMINAL_HASH = 'b'.repeat(64);
const STDOUT_HASH = 'c'.repeat(64);
const STDERR_HASH = 'd'.repeat(64);

function authority({
  objective,
  kind,
  recognized,
  intent,
  completionPolicy,
  directPostconditions = []
}) {
  return buildCompletionAuthoritySnapshot({
    objective,
    kind,
    recognized,
    intent,
    completionPolicy,
    directPostconditions,
    verificationPolicy: 'when_declared',
    capturedAt: AT
  });
}

function decision({
  completionAuthority,
  verificationContract = null,
  replayEvents = [],
  events = [],
  processOperations = [],
  browserEvidence = null,
  created = []
}) {
  const workflow = completionAuthority.objectiveContract.kind === 'workflow';
  return buildCompletionDecision({
    run: {
      id: 17,
      ticketId: 29,
      status: 'completed',
      workflowId: workflow ? 'mixed-family-workflow' : null,
      completionAuthoritySnapshot: completionAuthority,
      executionPolicySnapshot: { requireVerification: 'when_declared' },
      runtimeBudgetSnapshot: { snapshotHash: 'e'.repeat(64) }
    },
    replaySnapshot: {
      events: replayEvents,
      parsedModelPlans: [{ complete: true, message: 'non-authoritative claim' }],
      capabilityOutputs: workflow
        ? [{
            capabilityType: 'workflow',
            capabilityId: 'mixed-family-workflow',
            output: { status: 'bounded' }
          }]
        : [],
      browserEvidenceStatus: browserEvidence ? browserEvidence.status : null,
      browserEvidenceDetail: browserEvidence ? browserEvidence.detail : null
    },
    events,
    operations: processOperations,
    consequence: {
      mutations: created,
      created,
      modified: [],
      updated: [],
      deleted: [],
      renamed: [],
      processOperations,
      verification: {
        postconditionsStatus: 'unknown',
        violationsStatus: 'none',
        browserEvidence
      }
    },
    verificationContract,
    evaluatedAt: AT
  });
}

// Workspace direct work: declaration, criterion authority, durable checked-path
// evidence, and completion remain one coherent existing path.
const directObjective = 'Create folder mixed-family-result';
const directAuthority = authority({
  objective: directObjective,
  kind: 'deterministic',
  recognized: true,
  intent: 'create_folder',
  completionPolicy: 'declared_postconditions',
  directPostconditions: [{
    type: 'folder_exists',
    path: 'mixed-family-result'
  }]
});
const directDeclared = buildDeclaredWorkSnapshot({
  ticket: { objective: directObjective },
  completionAuthoritySnapshot: directAuthority
});
assert.equal(
  assertDeclaredWorkCompletionAuthorityBinding({
    declaredWorkSnapshot: directDeclared,
    completionAuthoritySnapshot: directAuthority,
    verificationContractSnapshot: null
  }).status,
  'bound'
);
const directDecision = decision({
  completionAuthority: directAuthority,
  replayEvents: [{
    type: 'run:postcondition_completed',
    checkedPaths: [{ type: 'folder', path: 'mixed-family-result' }]
  }]
});
assert.equal(directDecision.verificationDisposition, 'passed');
assert.equal(directDecision.completionDisposition, 'completed');

// Workflow workspace work: expected artifacts remain declarations while the
// frozen typed postcondition remains the deterministic completion authority.
const workflowObjective = 'Produce the frozen workflow report';
const workflow = {
  id: 'mixed-family-workflow',
  verifierContract: {
    expectedArtifacts: ['reports/result.md']
  },
  postconditions: [{
    id: 'report-exists',
    type: 'fileExists',
    path: 'reports/result.md'
  }]
};
const workflowAuthority = authority({
  objective: workflowObjective,
  kind: 'workflow',
  recognized: true,
  intent: 'workflow',
  completionPolicy: 'workflow_terminal'
});
const workflowDeclared = buildDeclaredWorkSnapshot({
  ticket: { objective: workflowObjective },
  workflow,
  completionAuthoritySnapshot: workflowAuthority
});
const workflowVerification = {
  workflowId: workflow.id,
  postconditions: workflow.postconditions
};
assert.equal(workflowDeclared.expectedOutputs[0].declaration, 'reports/result.md');
assert.equal(
  assertDeclaredWorkCompletionAuthorityBinding({
    declaredWorkSnapshot: workflowDeclared,
    completionAuthoritySnapshot: workflowAuthority,
    verificationContractSnapshot: workflowVerification
  }).status,
  'bound'
);
const workflowDecision = decision({
  completionAuthority: workflowAuthority,
  verificationContract: workflowVerification,
  events: [{
    type: 'run.postconditions_checked',
    payload: {
      status: 'passed',
      results: [{
        id: 'report-exists',
        type: 'fileExists',
        passed: true
      }]
    }
  }]
});
assert.equal(workflowDecision.completionDisposition, 'completed');

// Process criteria are a closed completion/evidence contract. This proves the
// evaluator path only; source guards below deliberately prove that ordinary
// Workflow dispatch does not acquire process authority.
const processPostcondition = {
  id: 'syntax-completed',
  type: 'processTerminalOutcomeEquals',
  operationIdentity: PROCESS_IDENTITY,
  terminalOutcome: 'completed'
};
const processObjective = 'Run the admitted syntax validation';
const processWorkflow = {
  id: 'mixed-family-workflow',
  verifierContract: { expectedArtifacts: [] },
  postconditions: [processPostcondition]
};
const processWorkflowAuthority = authority({
  objective: processObjective,
  kind: 'workflow',
  recognized: true,
  intent: 'workflow',
  completionPolicy: 'workflow_terminal'
});
const processDeclared = buildDeclaredWorkSnapshot({
  ticket: { objective: processObjective },
  workflow: processWorkflow,
  completionAuthoritySnapshot: processWorkflowAuthority
});
assert.equal(
  assertDeclaredWorkCompletionAuthorityBinding({
    declaredWorkSnapshot: processDeclared,
    completionAuthoritySnapshot: processWorkflowAuthority,
    verificationContractSnapshot: {
      workflowId: processWorkflow.id,
      postconditions: processWorkflow.postconditions
    }
  }).status,
  'bound'
);
const processOperation = {
  operationIdentity: PROCESS_IDENTITY,
  operation: 'runProcess',
  targetId: 'ticket-system-local',
  profileId: 'syntax-check',
  outcome: 'succeeded',
  terminalOutcome: 'completed',
  terminalResultHash: TERMINAL_HASH,
  stdoutArtifact: {
    id: 'process-stdout',
    stream: 'stdout',
    byteCount: 3,
    sha256: STDOUT_HASH
  },
  stderrArtifact: {
    id: 'process-stderr',
    stream: 'stderr',
    byteCount: 0,
    sha256: STDERR_HASH
  }
};
const processDecision = decision({
  completionAuthority: processWorkflowAuthority,
  verificationContract: {
    workflowId: processWorkflow.id,
    postconditions: processWorkflow.postconditions
  },
  processOperations: [processOperation],
  events: [{
    type: 'process.terminal',
    payload: {
      operationIdentity: PROCESS_IDENTITY,
      terminalOutcome: 'completed',
      terminalResultHash: TERMINAL_HASH
    }
  }, {
    type: 'process.stdout_artifact',
    payload: {
      operationIdentity: PROCESS_IDENTITY,
      artifact: processOperation.stdoutArtifact
    }
  }, {
    type: 'process.stderr_artifact',
    payload: {
      operationIdentity: PROCESS_IDENTITY,
      artifact: processOperation.stderrArtifact
    }
  }]
});
assert.equal(processDecision.verificationDisposition, 'passed');
assert.equal(processDecision.completionDisposition, 'completed');
const processWithoutCriterion = decision({
  completionAuthority: authority({
    objective: 'Run an authorized process',
    kind: 'unrecognized',
    recognized: false,
    intent: 'model_driven',
    completionPolicy: 'explicit_evidence_required'
  }),
  processOperations: [processOperation],
  events: [{
    type: 'process.terminal',
    payload: {
      operationIdentity: PROCESS_IDENTITY,
      terminalOutcome: 'completed',
      terminalResultHash: TERMINAL_HASH
    }
  }, {
    type: 'process.stdout_artifact',
    payload: {
      operationIdentity: PROCESS_IDENTITY,
      artifact: processOperation.stdoutArtifact
    }
  }, {
    type: 'process.stderr_artifact',
    payload: {
      operationIdentity: PROCESS_IDENTITY,
      artifact: processOperation.stderrArtifact
    }
  }]
});
assert.equal(processWithoutCriterion.completionDisposition, 'incomplete',
  'process exit zero alone must not complete the objective');

// Browser facts retain their operation vocabulary and bounded evidence, but no
// browser criterion is invented.
const browserConsequences = buildBrowserConsequences([{
  id: 91,
  operationKey: 'browser-operation:mixed-family-observe',
  operation: 'observe',
  outcome: 'succeeded',
  targetId: 'browser:research',
  targetKind: 'browser',
  metadata: {
    elementCount: 4,
    pageStateHash: 'bounded-browser-state',
    credentials: 'must not project',
    unrestrictedPageContent: 'must not project'
  },
  partial: false,
  truncated: false
}]);
assert.equal(browserConsequences.length, 1);
assert.equal(browserConsequences[0].targetId, 'browser:research');
assert.equal(JSON.stringify(browserConsequences).includes('must not project'), false);
const browserDecision = decision({
  completionAuthority: authority({
    objective: 'Observe the authorized browser page',
    kind: 'unrecognized',
    recognized: false,
    intent: 'model_driven',
    completionPolicy: 'explicit_evidence_required'
  }),
  browserEvidence: {
    status: 'evidence_available',
    detail: 'bounded observation receipt exists'
  }
});
assert.equal(browserDecision.completionDisposition, 'incomplete',
  'browser evidence alone must not establish semantic completion');

// Typed aggregation retains family semantics and never converts process/browser
// facts into workspace mutations.
assert.deepEqual(deriveOperationFamilyCounts([
  {
    operation: 'writeFile',
    outcome: 'succeeded',
    targetId: 'main',
    targetKind: 'workspace'
  },
  {
    operation: 'observe',
    outcome: 'succeeded',
    targetId: 'browser:research',
    targetKind: 'browser'
  },
  {
    operation: 'runProcess',
    outcome: 'succeeded',
    targetId: 'ticket-system-local',
    targetKind: 'process'
  }
]), {
  workspaceOperations: 1,
  workspaceMutations: 1,
  browserOperations: 1,
  processOperations: 1
});
assert.deepEqual(projectDeclaredWorkForRun({ id: 1 }), {
  availability: 'historical-unavailable',
  snapshot: null
});

const serverSource = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
const runtimeSources = fs.readdirSync(path.join(ROOT, 'runtime'))
  .filter(name => name.endsWith('.js'))
  .map(name => fs.readFileSync(path.join(ROOT, 'runtime', name), 'utf8'))
  .join('\n');
const workflowUsability = serverSource.match(
  /function isWorkflowUsableAction\(action\) \{([\s\S]*?)\n\}/
);
assert(workflowUsability, 'workflow action allowlist remains explicit');
assert.equal(workflowUsability[1].includes('runProcess'), false,
  'ordinary workflows do not silently acquire process dispatch');
assert.match(serverSource,
  /capabilityEnabled: PROCESS_EXECUTION_CONTRACT_ENABLED && ticket\.executionMode !== 'workflow'/);
assert.match(serverSource,
  /const AGENT_DIRECT_OPERATIONS = \[\.\.\.AGENT_ALLOWED_OPERATIONS, \.\.\.AGENT_WORKFLOW_DRAFT_OPERATIONS, \.\.\.AGENT_HANDOFF_OPERATIONS, \.\.\.AGENT_PROCESS_OPERATIONS\]/,
  'non-browser direct runs retain separate workspace and process operation families');
assert.match(serverSource,
  /operation = isBrowserRun\(run\) \? parseBrowserDirectAction\(run, action\) : parseAgentDirectAction\(action\)/);
assert.deepEqual(BROWSER_OPERATIONS, [
  'navigate', 'observe', 'readPageText', 'screenshot', 'wait'
]);
assert.deepEqual(WORKSPACE_OPERATIONS, [
  'listDirectory', 'readFile', 'createFolder', 'writeFile', 'renamePath', 'deletePath'
]);
for (const forbidden of [
  'genericOperationRouter',
  'universalOperationRouter',
  'executeOperation(domain',
  'target.execute'
]) {
  assert.equal(`${serverSource}\n${runtimeSources}`.includes(forbidden), false,
    `no generic cross-family execution authority may be introduced: ${forbidden}`);
}
for (const forbiddenPath of [
  'runtime/target-contract.js',
  'runtime/target-registry.js',
  'runtime/work-primitive.js',
  'runtime/playbook-registry.js'
]) {
  assert.equal(fs.existsSync(path.join(ROOT, forbiddenPath)), false,
    `${forbiddenPath} must remain absent`);
}
assert.equal(
  fs.readdirSync(path.join(ROOT, 'persistence', 'postgres', 'migrations'))
    .some(name => /work[_-]primitive|playbook|mixed[_-]family|generic[_-]operation/i.test(name)),
  false,
  'mixed-family validation must add no registry or persistence authority'
);

const memo = fs.readFileSync(
  path.join(ROOT, 'docs', 'decision-memo-mixed-family-work-model.md'),
  'utf8'
);
for (const required of [
  'Single-operation-family run',
  'Multi-family run',
  'Multi-run ticket',
  'Workflow composition',
  'Evidence aggregation',
  'Option A',
  'Option B',
  'Option C',
  'Choose Option A',
  'Future decision triggers'
]) {
  assert(memo.includes(required), `decision memo records ${required}`);
}

console.log('PASS: mixed-family scenarios preserve typed authority and justify the current product model');

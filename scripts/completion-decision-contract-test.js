#!/usr/bin/env node
'use strict';

const {
  buildCompletionAuthoritySnapshot,
  buildCompletionDecision,
  normalizeCompletionAuthoritySnapshot,
  normalizeCompletionDecision,
  completionEvidenceProjection,
  hashCanonical
} = require('../runtime/completion-decision-contract');

let assertions = 0;
function assert(condition, message) {
  if (!condition) throw new Error(`FAIL: ${message}`);
  assertions += 1;
}

function expectCode(fn, code, message) {
  try {
    fn();
  } catch (error) {
    assert(error && error.code === code, `${message}: expected ${code}, received ${error && error.code}`);
    return;
  }
  throw new Error(`FAIL: ${message}: expected ${code}`);
}

const AT = '2026-06-01T12:00:00.000Z';
const RUN_ID = 17;
const TICKET_ID = 29;
const OPERATION_IDENTITY = `process-operation:${'a'.repeat(64)}`;
const TERMINAL_HASH = 'b'.repeat(64);
const STDOUT_HASH = 'c'.repeat(64);
const STDERR_HASH = 'd'.repeat(64);

function authority({
  kind = 'unrecognized',
  recognized = false,
  intent = 'model_driven',
  completionPolicy = 'explicit_evidence_required',
  directPostconditions = []
} = {}) {
  return buildCompletionAuthoritySnapshot({
    objective: 'Perform the requested bounded work',
    kind,
    recognized,
    intent,
    completionPolicy,
    directPostconditions,
    verificationPolicy: 'when_declared',
    capturedAt: AT
  });
}

function processConsequence(terminalOutcome = 'completed') {
  return {
    operationIdentity: OPERATION_IDENTITY,
    operation: 'runProcess',
    targetId: 'ticket-system-local',
    profileId: 'syntax-check',
    outcome: terminalOutcome === 'completed' ? 'succeeded' : 'failed',
    terminalOutcome,
    terminalResultHash: TERMINAL_HASH,
    stdoutArtifact: {
      id: 'artifact-stdout',
      stream: 'stdout',
      byteCount: 3,
      sha256: STDOUT_HASH
    },
    stderrArtifact: {
      id: 'artifact-stderr',
      stream: 'stderr',
      byteCount: 0,
      sha256: STDERR_HASH
    }
  };
}

function decision({
  completionAuthority = authority(),
  status = 'completed',
  failure = null,
  replayEvents = [],
  parsedModelPlans = [{ complete: true, message: 'done' }],
  events = null,
  verificationContract = null,
  processOperations = [],
  browserEvidence = null,
  created = [],
  modified = []
} = {}) {
  const run = {
    id: RUN_ID,
    ticketId: TICKET_ID,
    status,
    workflowId: completionAuthority && completionAuthority.objectiveContract.kind === 'workflow'
      ? 'workflow-1'
      : null,
    completionAuthoritySnapshot: completionAuthority,
    executionPolicySnapshot: { requireVerification: 'when_declared' },
    runtimeBudgetSnapshot: { snapshotHash: 'e'.repeat(64) }
  };
  const replaySnapshot = {
    events: replayEvents,
    parsedModelPlans,
    capabilityOutputs: completionAuthority && completionAuthority.objectiveContract.kind === 'workflow'
      ? [{ capabilityType: 'workflow', capabilityId: 'workflow-1', output: { ok: true } }]
      : [],
    browserEvidenceStatus: browserEvidence ? browserEvidence.status : null,
    browserEvidenceDetail: browserEvidence ? browserEvidence.detail : null,
    ...(failure ? { failure } : {})
  };
  const consequence = {
    mutations: [],
    created,
    modified,
    updated: [],
    deleted: [],
    renamed: [],
    processOperations,
    verification: {
      postconditionsStatus: 'unknown',
      violationsStatus: 'none',
      browserEvidence
    }
  };
  const durableEvents = events || processOperations.flatMap(operation => [
    {
      type: 'process.terminal',
      payload: {
        operationIdentity: operation.operationIdentity,
        terminalOutcome: operation.terminalOutcome,
        terminalResultHash: operation.terminalResultHash
      }
    },
    ...(operation.stdoutArtifact ? [{
      type: 'process.stdout_artifact',
      payload: {
        operationIdentity: operation.operationIdentity,
        artifact: operation.stdoutArtifact
      }
    }] : []),
    ...(operation.stderrArtifact ? [{
      type: 'process.stderr_artifact',
      payload: {
        operationIdentity: operation.operationIdentity,
        artifact: operation.stderrArtifact
      }
    }] : [])
  ]);
  return buildCompletionDecision({
    run,
    replaySnapshot,
    events: durableEvents,
    operations: processOperations,
    consequence,
    verificationContract,
    evaluatedAt: AT
  });
}

const modelOnly = decision();
assert(modelOnly.executionDisposition === 'succeeded', 'model-only terminal work records successful execution');
assert(modelOnly.verificationDisposition === 'not_required', 'no declaration is explicitly not required');
assert(modelOnly.completionDisposition === 'incomplete', 'model complete alone does not complete an objective');
assert(modelOnly.modelClaim.complete === true && modelOnly.modelClaim.authority === false,
  'model completion is retained only as a non-authoritative claim');

const directAuthority = authority({
  kind: 'deterministic',
  recognized: true,
  intent: 'create_folder',
  completionPolicy: 'declared_postconditions',
  directPostconditions: [{ type: 'folder_exists', path: 'result' }]
});
const directPassed = decision({
  completionAuthority: directAuthority,
  parsedModelPlans: [{ complete: false }],
  replayEvents: [{
    type: 'run:postcondition_completed',
    checkedPaths: [{ type: 'folder', path: 'result' }]
  }]
});
assert(directPassed.verificationDisposition === 'passed', 'declared direct postcondition passes from durable replay evidence');
assert(directPassed.completionDisposition === 'completed', 'all deterministic postconditions permit completion');
assert(directPassed.modelClaim.complete === false, 'model incomplete claim is retained without overriding completion');

const directFailed = decision({
  completionAuthority: directAuthority,
  replayEvents: [{
    type: 'run:postcondition_completed',
    checkedPaths: [{ type: 'folder', path: 'another-result' }]
  }]
});
assert(directFailed.verificationDisposition === 'failed', 'postcondition mismatch is verification failed');
assert(directFailed.completionDisposition === 'incomplete', 'failed verification prevents completion');

const directUnavailable = decision({ completionAuthority: directAuthority, replayEvents: [] });
assert(directUnavailable.verificationDisposition === 'unavailable', 'missing postcondition evidence is unavailable');
assert(directUnavailable.completionDisposition === 'blocked', 'missing required evidence blocks completion');

const workspaceReceiptAuthority = authority({
  kind: 'deterministic',
  recognized: true,
  intent: 'model_driven',
  completionPolicy: 'workspace_objective_receipt'
});
const workspaceReceiptCompleted = decision({
  completionAuthority: workspaceReceiptAuthority,
  parsedModelPlans: [{ complete: false }],
  replayEvents: [{
    type: 'workspace.objective_satisfied',
    objectivePaths: ['result.md']
  }],
  created: [{ path: 'result.md' }]
});
assert(workspaceReceiptCompleted.completionDisposition === 'completed',
  'existing deterministic workspace objective evidence and receipt permit completion');
const workspaceReceiptMissing = decision({
  completionAuthority: workspaceReceiptAuthority,
  replayEvents: [{
    type: 'workspace.objective_satisfied',
    objectivePaths: ['result.md']
  }]
});
assert(workspaceReceiptMissing.completionDisposition === 'incomplete',
  'workspace objective evidence without a matching durable mutation consequence is insufficient');

const workflowAuthority = authority({
  kind: 'workflow',
  recognized: true,
  intent: 'workflow',
  completionPolicy: 'workflow_terminal'
});
const workflowContract = {
  workflowId: 'workflow-1',
  postconditions: [{ id: 'file-exists', type: 'fileExists', path: 'result.txt' }]
};
const workflowPassed = decision({
  completionAuthority: workflowAuthority,
  verificationContract: workflowContract,
  events: [{
    type: 'run.postconditions_checked',
    payload: {
      status: 'passed',
      results: [{ id: 'file-exists', type: 'fileExists', passed: true }]
    }
  }]
});
assert(workflowPassed.verificationDisposition === 'passed' &&
  workflowPassed.completionDisposition === 'completed',
  'workflow postconditions participate in the same completion decision');

const workflowFailed = decision({
  completionAuthority: workflowAuthority,
  verificationContract: workflowContract,
  events: [{
    type: 'run.postconditions_checked',
    payload: {
      status: 'failed',
      results: [{ id: 'file-exists', type: 'fileExists', passed: false }]
    }
  }]
});
assert(workflowFailed.verificationDisposition === 'failed', 'false workflow postcondition is not execution failure');
assert(workflowFailed.executionDisposition === 'succeeded', 'verification failure preserves successful execution');

const contradictory = decision({
  completionAuthority: workflowAuthority,
  verificationContract: workflowContract,
  events: [{
    type: 'run.postconditions_checked',
    payload: { results: [{ id: 'file-exists', type: 'fileExists', passed: true }] }
  }, {
    type: 'run.verification_passed',
    payload: { status: 'passed' }
  }, {
    type: 'run.verification_failed',
    payload: { status: 'failed' }
  }]
});
assert(contradictory.verificationDisposition === 'unavailable', 'contradictory verification fails closed');
assert(contradictory.evidenceIssues.some(item => item.code === 'COMPLETION_EVIDENCE_CONTRADICTORY'),
  'contradictory authority is preserved diagnostically');

const processReceipt = processConsequence();
const processWithoutDeclaration = decision({ processOperations: [processReceipt] });
assert(processWithoutDeclaration.completionDisposition === 'incomplete',
  'exit zero alone does not complete an objective');

const processTerminalContract = {
  workflowId: 'workflow-1',
  postconditions: [{
    id: 'syntax-completed',
    type: 'processTerminalOutcomeEquals',
    operationIdentity: OPERATION_IDENTITY,
    terminalOutcome: 'completed'
  }]
};
const processPassed = decision({
  completionAuthority: workflowAuthority,
  verificationContract: processTerminalContract,
  processOperations: [processReceipt]
});
assert(processPassed.verificationDisposition === 'passed' &&
  processPassed.completionDisposition === 'completed',
  'exact declared process terminal outcome can pass');

const processMismatch = decision({
  completionAuthority: workflowAuthority,
  verificationContract: {
    workflowId: 'workflow-1',
    postconditions: [{
      id: 'syntax-timeout',
      type: 'processTerminalOutcomeEquals',
      operationIdentity: OPERATION_IDENTITY,
      terminalOutcome: 'timed_out'
    }]
  },
  processOperations: [processReceipt]
});
assert(processMismatch.verificationDisposition === 'failed', 'process terminal mismatch fails verification');

const processEvidenceContradiction = decision({
  completionAuthority: workflowAuthority,
  verificationContract: processTerminalContract,
  processOperations: [processReceipt],
  events: [{
    type: 'process.terminal',
    payload: {
      operationIdentity: OPERATION_IDENTITY,
      terminalOutcome: 'failed',
      terminalResultHash: 'f'.repeat(64)
    }
  }]
});
assert(processEvidenceContradiction.verificationDisposition === 'unavailable' &&
  processEvidenceContradiction.completionDisposition === 'blocked',
  'terminal evidence contradicting a process receipt fails closed');
assert(processEvidenceContradiction.evidenceIssues.some(item =>
  item.code === 'COMPLETION_EVIDENCE_CONTRADICTORY'),
  'process terminal contradiction is bounded and diagnosable');

const artifactPassed = decision({
  completionAuthority: workflowAuthority,
  verificationContract: {
    workflowId: 'workflow-1',
    postconditions: [{
      id: 'stdout-exact',
      type: 'processArtifactEquals',
      operationIdentity: OPERATION_IDENTITY,
      stream: 'stdout',
      byteCount: 3,
      sha256: STDOUT_HASH
    }]
  },
  processOperations: [processReceipt]
});
assert(artifactPassed.verificationDisposition === 'passed', 'exact immutable artifact metadata can satisfy a declaration');
assert(!JSON.stringify(artifactPassed).includes('raw output'), 'completion decision never interprets process output content');

const browserOnly = decision({
  browserEvidence: { status: 'evidence_available', detail: 'Page text was read.' }
});
assert(browserOnly.browserEvidence.status === 'evidence_available', 'browser deterministic verdict participates as evidence');
assert(browserOnly.completionDisposition === 'incomplete', 'browser evidence alone does not establish a semantic objective');

const cancelled = decision({ status: 'interrupted' });
assert(cancelled.executionDisposition === 'cancelled' && cancelled.completionDisposition === 'incomplete',
  'plain interrupted run with no stronger durable cause remains cancelled');
assert(cancelled.reasonCode === 'RUN_CANCELLED',
  'ordinary cancellation retains its stable reason');

const interruptedInfrastructureCode = decision({
  status: 'interrupted',
  failure: { code: 'PROCESS_EXECUTION_RECONCILIATION_FAILED', kind: 'unknown' }
});
assert(interruptedInfrastructureCode.executionDisposition === 'infrastructure_failed',
  'interrupted run with an infrastructure failure code is infrastructure failed');
assert(interruptedInfrastructureCode.completionDisposition === 'blocked',
  'infrastructure failure blocks completion');
assert(interruptedInfrastructureCode.reasonCode !== 'RUN_CANCELLED',
  'infrastructure failure is never assigned the cancellation reason');

const interruptedInfrastructureKind = decision({
  status: 'interrupted',
  failure: { code: 'UNKNOWN_FAILURE_CODE', kind: 'infrastructure_failure' }
});
assert(interruptedInfrastructureKind.executionDisposition === 'infrastructure_failed',
  'interrupted run with an infrastructure failure kind is infrastructure failed');

const interruptedInfrastructureEvent = decision({
  status: 'interrupted',
  events: [{
    type: 'process.infrastructure_interrupted',
    payload: { operationIdentity: OPERATION_IDENTITY }
  }]
});
assert(interruptedInfrastructureEvent.executionDisposition === 'infrastructure_failed',
  'process.infrastructure_interrupted is semantic infrastructure authority');

const budget = decision({
  status: 'failed',
  failure: { code: 'RUN_BUDGET_EXHAUSTED', kind: 'runtime_budget_exhausted' }
});
assert(budget.executionDisposition === 'budget_exhausted' && budget.completionDisposition === 'incomplete',
  'budget exhaustion cannot be completion');
const interruptedBudget = decision({
  status: 'interrupted',
  failure: { code: 'RUN_BUDGET_EXHAUSTED', kind: 'runtime_budget_exhausted' }
});
assert(interruptedBudget.executionDisposition === 'budget_exhausted',
  'explicit budget exhaustion outranks interrupted status');

const infrastructure = decision({
  status: 'failed',
  failure: { code: 'PROCESS_EXECUTION_RECONCILIATION_FAILED', kind: 'infrastructure_failure' }
});
assert(infrastructure.executionDisposition === 'infrastructure_failed' &&
  infrastructure.completionDisposition === 'blocked',
  'infrastructure failure cannot be represented as operation success');
const executionFailed = decision({ status: 'failed', failure: { code: 'WORKSPACE_ERROR', kind: 'workspace_error' } });
assert(executionFailed.executionDisposition === 'failed' &&
  executionFailed.completionDisposition === 'incomplete',
  'execution failure remains distinct');

const verificationWithInfrastructure = decision({
  completionAuthority: workflowAuthority,
  verificationContract: workflowContract,
  status: 'interrupted',
  failure: {
    code: 'PROCESS_EXECUTION_RECONCILIATION_FAILED',
    kind: 'infrastructure_failure'
  },
  events: [{
    type: 'run.postconditions_checked',
    payload: {
      status: 'failed',
      results: [{ id: 'file-exists', type: 'fileExists', passed: false }]
    }
  }, {
    type: 'run.verification_failed',
    payload: { status: 'failed' }
  }]
});
assert(workflowFailed.executionDisposition === 'succeeded' &&
  workflowFailed.verificationDisposition === 'failed',
  'verification failure with otherwise successful execution remains succeeded');
assert(verificationWithInfrastructure.executionDisposition === 'infrastructure_failed',
  'verification failure does not override infrastructure authority');

const leaseLossCancellation = decision({
  status: 'interrupted',
  events: [{
    type: 'process.cancellation_requested',
    payload: { reason: 'scheduler lease ownership lost' }
  }]
});
assert(leaseLossCancellation.executionDisposition === 'cancelled' &&
  leaseLossCancellation.reasonCode === 'RUN_CANCELLED',
  'lease-loss cancellation retains cancellation semantics');

const naturalCompletionRace = decision({
  status: 'completed',
  events: [{
    type: 'process.cancellation_requested',
    payload: { reason: 'cancellation raced completion' }
  }, {
    type: 'process.terminal',
    payload: {
      operationIdentity: OPERATION_IDENTITY,
      terminalOutcome: 'completed',
      terminalResultHash: TERMINAL_HASH
    }
  }]
});
assert(naturalCompletionRace.executionDisposition === 'succeeded',
  'authoritative natural completion racing cancellation is not reclassified');

const replayedInterruptedInfrastructure = decision({
  status: 'interrupted',
  events: [{
    type: 'process.infrastructure_interrupted',
    payload: { operationIdentity: OPERATION_IDENTITY }
  }]
});
assert(replayedInterruptedInfrastructure.decisionHash === interruptedInfrastructureEvent.decisionHash,
  'exact replay reproduces the corrected infrastructure decision hash');

const replayed = decision({
  completionAuthority: directAuthority,
  parsedModelPlans: [{ complete: false }],
  replayEvents: [{
    type: 'run:postcondition_completed',
    checkedPaths: [{ type: 'folder', path: 'result' }]
  }]
});
assert(replayed.decisionHash === directPassed.decisionHash, 'exact replay reproduces the same decision hash');
assert(Object.isFrozen(replayed) && Object.isFrozen(replayed.operationReceiptAuthority),
  'decisions are deeply immutable');
assert(normalizeCompletionDecision(replayed).decisionHash === replayed.decisionHash,
  'persisted decision normalizes exactly');
assert(completionEvidenceProjection(replayed).decisionHash === replayed.decisionHash,
  'completion evidence binds the exact decision');

const alteredDecision = JSON.parse(JSON.stringify(replayed));
alteredDecision.completionDisposition = 'incomplete';
expectCode(
  () => normalizeCompletionDecision(alteredDecision),
  'COMPLETION_DECISION_CONFLICT',
  'conflicting replay decision'
);
expectCode(
  () => normalizeCompletionDecision({ ...replayed, privateLaunchPlan: {} }),
  'COMPLETION_DECISION_INVALID',
  'extra private authority'
);
const badPolicy = JSON.parse(JSON.stringify(directAuthority));
badPolicy.verificationPolicy = 'always';
badPolicy.snapshotHash = hashCanonical(Object.fromEntries(
  Object.entries(badPolicy).filter(([key]) => key !== 'snapshotHash')
));
expectCode(
  () => normalizeCompletionAuthoritySnapshot(badPolicy),
  'COMPLETION_DECISION_INVALID',
  'unknown verification policy'
);
expectCode(
  () => decision({ completionAuthority: null }),
  'COMPLETION_DECISION_INVALID',
  'historical runs cannot be silently upgraded into current completion authority'
);

console.log(`PASS: completion decision contract (${assertions} assertions)`);

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
const { buildDeclaredWorkSnapshot } = require('../runtime/declared-work-contract');

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
  modified = [],
  declaredObjective = null
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
    runtimeBudgetSnapshot: { snapshotHash: 'e'.repeat(64) },
    declaredWorkSnapshot: declaredObjective === null
      ? null
      : buildDeclaredWorkSnapshot({ ticket: { objective: declaredObjective } })
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

// ── P2-R1: workspace_objective_receipt determination independence ─────────
// Positive truth = objective-path tokens of the immutable executed intent
// intersected with committed qualifying consequence paths. The incidental
// workspace.objective_satisfied loop event is corroboration, never a
// prerequisite; shape, turn count, and resume boundary cannot alter truth.
const receiptObjective = 'Create result.md';
const workspaceReceiptAuthority = authority({
  kind: 'deterministic',
  recognized: true,
  intent: 'model_driven',
  completionPolicy: 'workspace_objective_receipt',
  objective: receiptObjective
});
const objectiveSatisfiedEvent = {
  type: 'workspace.objective_satisfied',
  message: 'Workspace objective satisfied by successful mutation evidence',
  step: 0,
  source: 'successful_workspace_mutation',
  objectivePaths: ['result.md']
};

// R1-T1 — same-turn decision shape: qualifying committed receipt, model
// complete:true in the same response, NO workspace.objective_satisfied event.
const receiptSameTurn = decision({
  completionAuthority: workspaceReceiptAuthority,
  declaredObjective: receiptObjective,
  created: [{ path: 'result.md' }]
});
assert(receiptSameTurn.completionDisposition === 'completed' &&
    receiptSameTurn.reasonCode === 'OBJECTIVE_COMPLETED',
  'R1-T1: same-turn qualifying receipt completes without the loop event');

// R1-T2 — event-present multi-turn equivalent: same authoritative receipt and
// path facts, the loop event IS emitted, model claimed complete:false first.
const receiptEventPresent = decision({
  completionAuthority: workspaceReceiptAuthority,
  declaredObjective: receiptObjective,
  parsedModelPlans: [{ complete: false }],
  replayEvents: [objectiveSatisfiedEvent],
  created: [{ path: 'result.md' }]
});
assert(receiptEventPresent.completionDisposition === receiptSameTurn.completionDisposition &&
    receiptEventPresent.reasonCode === receiptSameTurn.reasonCode,
  'R1-T2: the loop event does not alter authoritative completion truth');

// R1-T3 — resume-equivalent decision shape: committed qualifying receipt, no
// shortcut event because the run crossed a resume boundary.
const receiptResumed = decision({
  completionAuthority: workspaceReceiptAuthority,
  declaredObjective: receiptObjective,
  parsedModelPlans: [{ complete: false }],
  created: [{ path: 'result.md' }]
});
assert(receiptResumed.completionDisposition === 'completed' &&
    receiptResumed.reasonCode === 'OBJECTIVE_COMPLETED',
  'R1-T3: resumed run with a committed qualifying receipt completes under the occurrence policy');

// R1-T4 — no qualifying receipt: incomplete, and the event cannot manufacture
// receipt truth. Absent immutable executed intent also fails closed.
assert(decision({
  completionAuthority: workspaceReceiptAuthority,
  declaredObjective: receiptObjective,
  created: []
}).completionDisposition === 'incomplete',
  'R1-T4: no qualifying receipt stays incomplete');
assert(decision({
  completionAuthority: workspaceReceiptAuthority,
  declaredObjective: receiptObjective,
  parsedModelPlans: [{ complete: false }],
  replayEvents: [objectiveSatisfiedEvent],
  created: []
}).completionDisposition === 'incomplete',
  'R1-T4: event presence must not manufacture receipt truth');
assert(decision({
  completionAuthority: workspaceReceiptAuthority,
  created: [{ path: 'result.md' }]
}).completionDisposition === 'incomplete',
  'R1-T4: absent immutable executed intent fails closed to incomplete');

// R1-T5 — foreign/unbound path: qualifying-looking receipt that does not
// intersect the objective-path authority stays incomplete.
assert(decision({
  completionAuthority: workspaceReceiptAuthority,
  declaredObjective: receiptObjective,
  parsedModelPlans: [{ complete: false }],
  replayEvents: [objectiveSatisfiedEvent],
  created: [{ path: 'unrelated.md' }]
}).completionDisposition === 'incomplete',
  'R1-T5: receipt path outside the objective-path binding stays incomplete');

// R1-T6 — authority.denied refusal parity with the execution-side guard.
const receiptAuthorityDenied = decision({
  completionAuthority: workspaceReceiptAuthority,
  declaredObjective: receiptObjective,
  parsedModelPlans: [{ complete: false }],
  events: [{
    type: 'authority.denied',
    payload: { rule: 'protected_path', status: 'denied', reason: 'fixture authority denial' }
  }],
  created: [{ path: 'result.md' }]
});
assert(receiptAuthorityDenied.completionDisposition !== 'completed' &&
    receiptAuthorityDenied.violations.some(item => item.type === 'authority.denied') &&
    receiptAuthorityDenied.evidenceIssues.some(item => item.code === 'COMPLETION_EVIDENCE_CONTRADICTORY'),
  'R1-T6: authority.denied refuses completion through the existing fail-closed decision path');

// R1-T7 — existing violation evidence is refused exactly as predecessor.
const receiptViolation = decision({
  completionAuthority: workspaceReceiptAuthority,
  declaredObjective: receiptObjective,
  parsedModelPlans: [{ complete: false }],
  events: [{
    type: 'run.violation_detected',
    payload: { rule: 'fixture_rule' }
  }],
  created: [{ path: 'result.md' }]
});
assert(receiptViolation.completionDisposition === receiptAuthorityDenied.completionDisposition &&
    receiptViolation.reasonCode === receiptAuthorityDenied.reasonCode,
  'R1-T7: existing violation refusal is unchanged by R1');

// R1-T8 — deterministic replay/hash: equivalent durable decision input
// reproduces identical decision semantics and hash under the existing version.
const receiptReplayA = decision({
  completionAuthority: workspaceReceiptAuthority,
  declaredObjective: receiptObjective,
  created: [{ path: 'result.md' }]
});
const receiptReplayB = decision({
  completionAuthority: workspaceReceiptAuthority,
  declaredObjective: receiptObjective,
  created: [{ path: 'result.md' }]
});
assert(receiptReplayA.decisionHash === receiptReplayB.decisionHash &&
    receiptReplayA.version === 1,
  'R1-T8: equivalent durable input reproduces the same decision hash under the existing version rule');

// ── P2-R2: direct-run fileContains completion authority ────────────────────
// The criterion decides ONLY from criterion-bound `run:direct_postcondition_observed`
// replay observations (exact path + exact expected-substring digest); the
// LATEST relevant observation wins in durable order; unavailable evidence is
// never an observed negative; model prose and claims cannot substitute.
const containsObjectiveText = 'create file notes/summary.md containing hello world';
const containsCriterion = { type: 'fileContains', path: 'notes/summary.md', contains: 'hello world' };
const containsAuthority = authority({
  kind: 'deterministic',
  recognized: true,
  intent: 'create_file',
  completionPolicy: 'declared_postconditions',
  directPostconditions: [containsCriterion],
  objective: containsObjectiveText
});
const containsDigest = require('node:crypto').createHash('sha256')
  .update('hello world').digest('hex');
const foreignDigest = require('node:crypto').createHash('sha256')
  .update('different text').digest('hex');
const observedEvent = (observations, extra = {}) => ({
  type: 'run:direct_postcondition_observed',
  message: 'Declared direct fileContains criteria observed from runtime workspace state',
  step: 0,
  source: extra.source || 'post_batch',
  observations
});
const bound = (path, digest, present) => ({ path, containsSha256: digest, present });

// R2-1 — admitted criterion + latest observation present → completed.
const containsSatisfied = decision({
  completionAuthority: containsAuthority,
  parsedModelPlans: [{ complete: false }],
  replayEvents: [observedEvent([bound('notes/summary.md', containsDigest, true)])]
});
assert(containsSatisfied.evaluatedPostconditions.some(result =>
    result.type === 'fileContains' && result.passed === true &&
    result.reasonCode === 'POSTCONDITION_PASSED'),
  'R2-1: observed-positive fileContains evaluates POSTCONDITION_PASSED');
assert(containsSatisfied.verificationDisposition === 'passed' &&
    containsSatisfied.completionDisposition === 'completed' &&
    containsSatisfied.reasonCode === 'OBJECTIVE_COMPLETED',
  'R2-1: positive criterion truth participates in the completion decision');

// R2-2 — admitted criterion + latest observation negative → observed-false refused.
const containsNegative = decision({
  completionAuthority: containsAuthority,
  replayEvents: [observedEvent([bound('notes/summary.md', containsDigest, false)])]
});
assert(containsNegative.evaluatedPostconditions.some(result =>
    result.type === 'fileContains' && result.passed === false &&
    result.reasonCode === 'POSTCONDITION_EVALUATION_FAILED'),
  'R2-2: observed-negative fileContains is a known deterministic negative');
assert(containsNegative.verificationDisposition === 'failed' &&
    containsNegative.completionDisposition === 'incomplete' &&
    containsNegative.reasonCode === 'VERIFICATION_FAILED',
  'R2-2: an observed negative does not complete');

// R2-3 — no relevant observation → unavailable, never a negative.
const containsUnavailable = decision({
  completionAuthority: containsAuthority,
  replayEvents: []
});
assert(containsUnavailable.evaluatedPostconditions.some(result =>
    result.type === 'fileContains' && result.passed === null &&
    result.reasonCode === 'POSTCONDITION_EVIDENCE_UNAVAILABLE'),
  'R2-3: absence of observation stays POSTCONDITION_EVIDENCE_UNAVAILABLE');
assert(containsUnavailable.verificationDisposition === 'unavailable' &&
    containsUnavailable.completionDisposition === 'blocked',
  'R2-3: unavailable evidence blocks instead of completing');

// R2-4/R2-7/R2-8 — criterion binding: foreign path and foreign expected
// substring cannot satisfy; malformed entries are dropped, failing closed.
assert(decision({
  completionAuthority: containsAuthority,
  replayEvents: [observedEvent([bound('other/file.md', containsDigest, true)])]
}).completionDisposition === 'blocked',
  'R2-7: evidence for a foreign path cannot satisfy the criterion');
assert(decision({
  completionAuthority: containsAuthority,
  replayEvents: [observedEvent([bound('notes/summary.md', foreignDigest, true)])]
}).completionDisposition === 'blocked',
  'R2-8: evidence for a foreign required-content value cannot satisfy the criterion');
assert(decision({
  completionAuthority: containsAuthority,
  replayEvents: [observedEvent([
    { path: 'notes/summary.md', containsSha256: containsDigest },
    { path: 'notes/summary.md', present: true },
    'garbage'
  ])]
}).completionDisposition === 'blocked',
  'R2-4: malformed observation records are dropped and fail closed to unavailable');

// R2-9 — replay determinism: identical durable input reproduces the same hash.
const containsReplayA = decision({
  completionAuthority: containsAuthority,
  replayEvents: [observedEvent([bound('notes/summary.md', containsDigest, true)])]
});
const containsReplayB = decision({
  completionAuthority: containsAuthority,
  replayEvents: [observedEvent([bound('notes/summary.md', containsDigest, true)])]
});
assert(containsReplayA.decisionHash === containsReplayB.decisionHash &&
    containsReplayA.version === 1,
  'R2-9: replay produces the same criterion result and hash under the existing version');

// The consumed observation evidence is hash-bound into the decision.
const withoutObservation = decision({
  completionAuthority: containsAuthority,
  replayEvents: []
});
assert(containsReplayA.requiredEvidenceAuthority.hash !==
    withoutObservation.requiredEvidenceAuthority.hash,
  'R2: the fileContains observation evidence is hash-bound into requiredEvidenceAuthority');

// R2-10 — model shape independence: model prose/claims cannot manufacture or
// revoke criterion truth; turn/response shape does not change the decision.
const modelCannotBypass = decision({
  completionAuthority: containsAuthority,
  parsedModelPlans: [{ complete: true, message: 'the file definitely contains it' }],
  replayEvents: []
});
assert(modelCannotBypass.completionDisposition === 'blocked',
  'R2-6: a model complete:true claim cannot manufacture criterion satisfaction');
const modelCannotSatisfyAbsent = decision({
  completionAuthority: containsAuthority,
  parsedModelPlans: [{ complete: false }],
  replayEvents: [observedEvent([bound('notes/summary.md', containsDigest, true)])]
});
assert(modelCannotSatisfyAbsent.completionDisposition === 'completed',
  'R2-10: model complete:false does not revoke observed criterion truth');
const claimCannotSubstitute = decision({
  completionAuthority: containsAuthority,
  parsedModelPlans: [{ complete: false }],
  replayEvents: [{
    type: 'run:postcondition_completed',
    message: 'Requested workspace state is already satisfied',
    checkedPaths: [{ type: 'fileContains', path: 'notes/summary.md', contains: 'hello world' }],
    source: 'pre_model'
  }]
});
assert(claimCannotSubstitute.completionDisposition === 'blocked',
  'R2-6: a run:postcondition_completed claim cannot substitute for criterion-bound observation');
const resumedShapeEquivalent = decision({
  completionAuthority: containsAuthority,
  parsedModelPlans: [{ complete: false }],
  replayEvents: [
    observedEvent([bound('notes/summary.md', containsDigest, false)], { source: 'pre_model' }),
    observedEvent([bound('notes/summary.md', containsDigest, true)], { source: 'post_batch' })
  ]
});
assert(resumedShapeEquivalent.completionDisposition === 'completed' &&
    resumedShapeEquivalent.reasonCode === 'OBJECTIVE_COMPLETED',
  'R2-10: response/turn shape does not change the same durable criterion truth');

// R2 temporal decision-level cases — negative → later positive PASS;
// positive → later negative FAIL; a newer unrelated observation cannot
// displace the latest bound one.
const temporalPass = decision({
  completionAuthority: containsAuthority,
  replayEvents: [
    observedEvent([bound('notes/summary.md', containsDigest, false)]),
    observedEvent([bound('notes/summary.md', containsDigest, true)])
  ]
});
assert(temporalPass.completionDisposition === 'completed',
  'R2 temporal: negative → later positive = PASS');
const temporalFail = decision({
  completionAuthority: containsAuthority,
  replayEvents: [
    observedEvent([bound('notes/summary.md', containsDigest, true)]),
    observedEvent([bound('notes/summary.md', containsDigest, false)])
  ]
});
assert(temporalFail.completionDisposition === 'incomplete' &&
    temporalFail.reasonCode === 'VERIFICATION_FAILED',
  'R2 temporal: positive → later negative = FAIL');
const displacedCheck = decision({
  completionAuthority: containsAuthority,
  replayEvents: [
    observedEvent([bound('notes/summary.md', containsDigest, false)]),
    observedEvent([bound('other/file.md', foreignDigest, true)]),
    observedEvent([bound('notes/summary.md', containsDigest, true)])
  ]
});
assert(displacedCheck.completionDisposition === 'completed',
  'R2 temporal: a newer unrelated observation cannot displace the latest bound observation');

// R2-14 — existing refusal/violation behavior still dominates completion.
const violatesContains = decision({
  completionAuthority: containsAuthority,
  replayEvents: [observedEvent([bound('notes/summary.md', containsDigest, true)])],
  events: [{ type: 'run.violation_detected', payload: { rule: 'fixture_rule' } }]
});
assert(violatesContains.completionDisposition !== 'completed' &&
    violatesContains.evidenceIssues.some(issue => issue.code === 'COMPLETION_EVIDENCE_CONTRADICTORY'),
  'R2-14: violation evidence still dominates a satisfied criterion');

// R2-12b — authority normalization refuses malformed fileContains admissions.
const malformedAuthority = (() => {
  try {
    authority({
      kind: 'deterministic',
      recognized: true,
      intent: 'create_file',
      completionPolicy: 'declared_postconditions',
      directPostconditions: [{ type: 'fileContains', path: 'x.md', contains: '' }],
      objective: containsObjectiveText
    });
    return 'admitted';
  } catch (error) {
    return error.code;
  }
})();
assert(malformedAuthority === 'POSTCONDITION_UNSUPPORTED',
  'R2-4: malformed fileContains admission (empty contains) refuses deterministically');

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

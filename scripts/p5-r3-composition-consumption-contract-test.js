#!/usr/bin/env node
'use strict';

// P5-R3 — Deterministic composition consumption — criterion CONTRACT owner
// (deterministic, no database).
//
// Authority: docs/ARCHITECTURAL_DECISIONS_PENDING.md, P5 semantic design
// freeze — §14 (childTerminalOutcome — COMPLETION AUTHORITY, CRITERION-A), §15
// (awaitChildTickets observation doctrine), §8 (CHILD-RERUN-A / UNITKEY-A),
// §17 (one-level composition bounds), §21 (no migration).
//
// THE CONTRACT (each scenario owns one frozen assertion set):
//
//   1. childTerminalOutcome is implemented INSIDE the SINGLE existing
//      canonical workflow postcondition evaluator: the real
//      evaluateWorkflowPostcondition bytes (extracted from server.js source,
//      same discipline as postcondition-completion-test.js) gain one type
//      branch and run it against the REAL kernel helpers. No second evaluator
//      is created and the unsupported-type fallthrough still fails closed.
//   2. The completion-authority form is exact and literal: parentBinding
//      "self"; authored workflow/step/unit selector; explicit finite
//      non-empty literal expectedUnits; authored settled-attempt disposition
//      expectation (single value or a distinct acceptable set). Absent,
//      empty, non-array, template-derived, duplicated, and invalid shapes
//      fail closed as deterministic unsatisfied results.
//   3. Every expected unit must resolve EXACTLY ONE child that durably claims
//      the canonical delegated logical identity
//      `ticket:{parentTicketId}:{parentWorkflowId}:{spawnedByStepId}:{childWorkflowId}:{unitKey}`:
//      zero children → CHILD_MISSING (authored units are never waived by
//      "all currently matched children"); more than one → CHILD_AMBIGUOUS; a
//      claiming child whose delegated creation relation is incoherent →
//      CHILD_PROVENANCE_UNCOHERENT with the kernel's typed refusal.
//   4. Truth is the CURRENT durable child attempt/Run/completion-decision
//      state via the canonical attempt-completion kernel
//      (evaluateAttemptCompletionAuthority — the SAME owner the T2/P2
//      settlement path uses): a settled attempt whose member Runs are not all
//      terminal reports the torn member truth; a settled attempt whose kernel
//      truth disagrees with its persisted disposition conflicts typed; a
//      newer unsettled attempt overrides an older terminal one; an observed
//      failure is a known negative that never satisfies a success criterion
//      merely because it is terminal; an authored acceptable-outcome set is
//      matched exactly.
//   5. PER-UNIT truth is additionally evaluable ONLY while the captured
//      attempt is still the child's canonical current attempt at the
//      composition loader's consistency point (the final canonical re-read
//      after the member facts were assembled, CHILD-RERUN-A). The loader's
//      typed per-child stability fact (`currentAttemptStabilityByChildId`)
//      feeds the SAME shared per-unit evaluation the observation consumes:
//      an attempt whose generation changed during the durable fact read —
//      including an attempt that APPEARED during a read that started with
//      none — fails that unit closed typed
//      (CHILD_ATTEMPT_CHANGED_DURING_READ) with the captured member history
//      left unevaluated, and can never satisfy the criterion from superseded
//      terminal history. Missing stability fact keeps the stable contract.
//   6. Aggregation over N expected units is deterministic: every authored
//      unit must satisfy; the authored order never changes the truth;
//      duplicate authored authority is refused rather than double-counted.
//   7. The child identity is the unitKey/spawn identity, never spawnPlanId:
//      resolution ignores Run-scoped execution references entirely, so a
//      parent rerun (new parent Run id, new spawnPlanId) resolves the same
//      Ticket-stable children.
//   8. The awaitChildTickets observation's authority-bearing selector and
//      expectedUnits are definition-seam literals (UNITKEY-A at the step):
//      validateWorkflowDefinition refuses template-derived, empty, duplicate,
//      unbound, or unbounded-wait await inputs BEFORE template resolution —
//      the runtime action sees only the resolved input and can never prove
//      authorship.
//   9. No decision weight from prose: the criterion result exposes only
//      deterministic normalized facts (no model text, no hidden authority
//      objects, no child history transcript).
//
// These are the pure semantics underneath the runtime enforcement; the
// PostgreSQL owner (p5-r3-composition-consumption-postgres-test.js) proves
// the cross-Ticket lifecycle end to end, including the observation step.

const fs = require('fs');
const path = require('path');
const assert = require('node:assert/strict');
const {
  DELEGATION_SCHEME,
  DELEGATED_REFUSAL_REASONS,
  buildDelegatedSpawnIdempotencyKey,
  isLiteralUnitKey,
  resolveDelegatedSpawnRelation
} = require('../runtime/t4-spawn-relation-contract');
const {
  evaluateAttemptCompletionAuthority
} = require('../runtime/ticket-attempt-completion-contract');
const {
  TICKET_ATTEMPT_DISPOSITIONS
} = require('../runtime/ticket-attempt-contract');

const ROOT = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');

// Brace-balanced extraction of one top-level function from server.js source,
// same discipline as scripts/postcondition-completion-test.js. Used only to
// execute EXISTING production helpers against the REAL canonical kernel
// helpers — it adds no production instrumentation. The sanitizer is a deep
// clone stand-in: the extracted helpers' own outputs are plain JSON-safe
// objects, and the scenarios assert on `passed`/typed reasons, not on log
// sanitization.
function extractServerFunction(code, name) {
  const match = code.match(new RegExp(`(async )?function ${name}\\s*\\(`));
  if (!match) throw new Error(`could not locate function ${name} in server.js`);
  const start = match.index;
  let i = start + match[0].length;
  let parens = 1;
  while (i < code.length && parens > 0) {
    if (code[i] === '(') parens += 1;
    else if (code[i] === ')') parens -= 1;
    i += 1;
  }
  const bodyStart = code.indexOf('{', i);
  if (bodyStart === -1) throw new Error(`could not locate body of ${name}`);
  let depth = 0;
  let j = bodyStart;
  while (j < code.length) {
    if (code[j] === '{') depth += 1;
    else if (code[j] === '}') depth -= 1;
    j += 1;
    if (depth === 0) break;
  }
  if (depth !== 0) throw new Error(`unbalanced braces extracting ${name}`);
  return code.slice(start, j);
}

const deepCloneSanitize = value => {
  if (Array.isArray(value)) return value.map(deepCloneSanitize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, deepCloneSanitize(item)]));
  }
  return value;
};

// The extracted production helpers, evaluated against the REAL canonical
// kernel helpers they call in production. The workflow-template resolver is a
// stand-in: the childTerminalOutcome branch normalizes the RAW authored
// postcondition and never applies workflow templates to its authority-bearing
// fields, so no scenario depends on template resolution.
const buildEvaluatorContext = () => {
  const normalizeChildTerminalOutcomeCriterion = new Function(
    'isLiteralUnitKey',
    'TICKET_ATTEMPT_DISPOSITIONS',
    'return ' + extractServerFunction(source, 'normalizeChildTerminalOutcomeCriterion'))(
    isLiteralUnitKey,
    [...TICKET_ATTEMPT_DISPOSITIONS]);
  const childWorkflowIdMatchesSelector = new Function(
    'return ' + extractServerFunction(source, 'childWorkflowIdMatchesSelector'))();
  const resolveDelegatedCompositionUnits = new Function(
    'buildDelegatedSpawnIdempotencyKey',
    'childWorkflowIdMatchesSelector',
    'return ' + extractServerFunction(source, 'resolveDelegatedCompositionUnits'))(
    buildDelegatedSpawnIdempotencyKey,
    childWorkflowIdMatchesSelector);
  const evaluateChildTerminalOutcomeUnit = new Function(
    'evaluateAttemptCompletionAuthority',
    'return ' + extractServerFunction(source, 'evaluateChildTerminalOutcomeUnit'))(
    evaluateAttemptCompletionAuthority);
  const childTerminalOutcomeExpectedShape = new Function(
    'return ' + extractServerFunction(source, 'childTerminalOutcomeExpectedShape'))();
  const sanitizeSnapshotValue = deepCloneSanitize;
  const evaluateWorkflowPostcondition = new Function(
    'resolveWorkflowPostconditionTemplates',
    'normalizeChildTerminalOutcomeCriterion',
    'resolveDelegatedCompositionUnits',
    'evaluateChildTerminalOutcomeUnit',
    'childTerminalOutcomeExpectedShape',
    'sanitizeSnapshotValue',
    'workspaceProvider',
    'readWorkspaceFileIfExists',
    'getValueAtPath',
    'valuesStrictlyEqual',
    'return ' + extractServerFunction(source, 'evaluateWorkflowPostcondition'))(
    value => value,
    normalizeChildTerminalOutcomeCriterion,
    resolveDelegatedCompositionUnits,
    evaluateChildTerminalOutcomeUnit,
    childTerminalOutcomeExpectedShape,
    sanitizeSnapshotValue,
    { getPathInfo: () => ({ exists: false, type: null }) },
    () => null,
    () => null,
    () => false);
  const ctx = {
    evaluateWorkflowPostcondition,
    normalizeChildTerminalOutcomeCriterion,
    resolveDelegatedCompositionUnits,
    evaluateChildTerminalOutcomeUnit,
    validateAwaitChildTicketsStepInput: new Function(
      'isLiteralUnitKey',
      'return ' + extractServerFunction(source, 'validateAwaitChildTicketsStepInput'))(
      isLiteralUnitKey)
  };
  return ctx;
};

const ctx = buildEvaluatorContext();

let scenarios = 0;
let assertions = 0;
function check(condition, message) {
  assert.ok(condition, message);
  assertions += 1;
}

const PARENT_TICKET_ID = 500;
const PARENT_RUN_ID = 900;
const PARENT_WORKFLOW_ID = 'wf-r3-parent';
const SPAWN_STEP_ID = 'spawn-units';
const CHILD_WORKFLOW_ID = 'wf-r3-child';
const CHILD_TICKET_ID = 501;
const CHILD_ATTEMPT_ID = 601;
const CHILD_RUN_ID = 901;

const spawnKey = unitKey =>
  buildDelegatedSpawnIdempotencyKey({
    parentTicketId: PARENT_TICKET_ID,
    parentWorkflowId: PARENT_WORKFLOW_ID,
    spawnedByStepId: SPAWN_STEP_ID,
    childWorkflowId: CHILD_WORKFLOW_ID,
    unitKey
  });

const parentRun = overrides => ({
  id: PARENT_RUN_ID,
  ticketId: PARENT_TICKET_ID,
  workflowId: PARENT_WORKFLOW_ID,
  status: 'completed',
  executionMode: 'workflow',
  workflowInput: {},
  replaySnapshot: { capabilityOutputs: [] },
  ...overrides
});

const attempt = overrides => ({
  id: CHILD_ATTEMPT_ID,
  ticketId: CHILD_TICKET_ID,
  ordinal: 1,
  memberCount: 1,
  disposition: null,
  admittedAt: '2026-10-27T00:00:00.000Z',
  settledAt: null,
  revision: 3,
  ...overrides
});

const memberRun = overrides => ({
  id: CHILD_RUN_ID,
  ticketId: CHILD_TICKET_ID,
  ticketAttemptId: CHILD_ATTEMPT_ID,
  status: 'running',
  completionAuthoritySnapshot: null,
  ...overrides
});

const decision = overrides => ({
  runId: CHILD_RUN_ID,
  ticketId: CHILD_TICKET_ID,
  objectiveContractHash: 'c'.repeat(64),
  completionDisposition: 'completed',
  ...overrides
});

const delegationBlock = (unitKey, overrides = {}) => ({
  scheme: DELEGATION_SCHEME,
  version: 1,
  parentTicketId: PARENT_TICKET_ID,
  parentRunId: PARENT_RUN_ID,
  parentWorkflowId: PARENT_WORKFLOW_ID,
  spawnedByStepId: SPAWN_STEP_ID,
  spawnPlanId: `${PARENT_RUN_ID}:${PARENT_WORKFLOW_ID}:${SPAWN_STEP_ID}:transition:0`,
  spawnIdempotencyKey: spawnKey(unitKey),
  unitKey,
  parentExecutionPolicyHash: 'd'.repeat(64),
  ...overrides
});

// A durable ticket.created provenance record for one fact child.
const provenanceRecord = (payload, overrides = {}) => ({
  id: '11111111-1111-1111-1111-111111111111',
  position: 1,
  ts: '2026-10-27T00:00:00.000Z',
  payload,
  ...overrides
});

// A durable child-facts fixture (the loadDelegatedChildCompositionFacts shape)
// with the given fact children and their delegated relations/lifecycle facts.
function childFacts({ units = [], refused = [], overrides = {} } = {}) {
  const enumerationFacts = [];
  const delegatedByChildId = new Map();
  const childWorkflowIdByChildId = new Map();
  const childStatusByChildId = new Map();
  const currentAttemptByChildId = new Map();
  const memberRunsByChildId = new Map();
  const decisionByRunId = new Map();
  for (const unit of units) {
    enumerationFacts.push({
      childTicketId: unit.childTicketId,
      parentTicketId: PARENT_TICKET_ID,
      kind: 'workflow-spawn',
      originEvent: { id: unit.originEventId || '11111111-1111-1111-1111-111111111111', position: unit.originPosition || 1 }
    });
    childWorkflowIdByChildId.set(unit.childTicketId, unit.childWorkflowId || CHILD_WORKFLOW_ID);
    childStatusByChildId.set(unit.childTicketId, unit.status || 'in_progress');
    currentAttemptByChildId.set(unit.childTicketId, unit.currentAttempt === undefined ? attempt() : unit.currentAttempt);
    const runs = unit.memberRuns || [];
    memberRunsByChildId.set(unit.childTicketId, runs);
    for (const run of runs) decisionByRunId.set(run.id, run.decisionFixture === undefined ? null : run.decisionFixture);
    delegatedByChildId.set(unit.childTicketId, {
      resolution: unit.delegatedResolution || {
        outcome: 'FACT',
        fact: { childTicketId: unit.childTicketId, parentTicketId: PARENT_TICKET_ID, kind: 'workflow-spawn', originEvent: { position: 1 } },
        delegation: delegationBlock(unit.unitKey)
      },
      claimedSpawnKey: unit.claimedSpawnKey || spawnKey(unit.unitKey)
    });
  }
  const enumeration = {
    kind: 'workflow-spawn',
    parentTicketId: PARENT_TICKET_ID,
    state: refused.length === 0 ? 'COMPLETE' : 'INCOMPLETE',
    candidateCount: enumerationFacts.length + refused.length,
    facts: enumerationFacts,
    refused
  };
  return {
    parentTicketId: PARENT_TICKET_ID,
    enumeration,
    delegatedByChildId,
    childWorkflowIdByChildId,
    childStatusByChildId,
    currentAttemptByChildId,
    memberRunsByChildId,
    decisionByRunId,
    ...overrides
  };
}

const criterion = (overrides = {}, runOverrides = {}) => ({
  id: 'child-units-complete',
  type: 'childTerminalOutcome',
  parentBinding: 'self',
  parentWorkflowId: PARENT_WORKFLOW_ID,
  spawnedByStepId: SPAWN_STEP_ID,
  childWorkflowId: CHILD_WORKFLOW_ID,
  expectedUnits: ['alpha'],
  expect: { disposition: 'completed' },
  ...overrides
});

const evaluate = (criterionInput, factsInput, runOverrides = {}) =>
  ctx.evaluateWorkflowPostcondition(
    parentRun(runOverrides),
    { id: PARENT_WORKFLOW_ID, name: 'parent', postconditions: [criterionInput] },
    criterionInput,
    {},
    [],
    factsInput);

// A one-child complete facts object for the happy path.
const completedAlphaFacts = () => childFacts({
  units: [{
    childTicketId: CHILD_TICKET_ID,
    unitKey: 'alpha',
    status: 'completed',
    currentAttempt: attempt({ disposition: 'completed', settledAt: '2026-10-27T00:01:00.000Z' }),
    memberRuns: [memberRun({
      status: 'completed',
      completionAuthoritySnapshot: { objectiveContractHash: 'c'.repeat(64) },
      decisionFixture: decision()
    })]
  }]
});

// ── Scenario 1: the criterion runs through the SINGLE real evaluator. ────────
scenarios += 1;
{
  const result = evaluate(criterion(), completedAlphaFacts());
  check(result.type === 'childTerminalOutcome' && result.passed === true,
    '1: one completed expected child satisfies a one-unit success criterion through the real evaluator');
  check(result.id === 'child-units-complete' && Array.isArray(result.actual.perUnit) &&
    result.actual.perUnit.length === 1 &&
    result.actual.perUnit[0].spawnIdempotencyKey === spawnKey('alpha'),
    '1: the satisfied result carries the deterministic per-unit logical identity');
  const unsupported = ctx.evaluateWorkflowPostcondition(
    parentRun(), { id: PARENT_WORKFLOW_ID, postconditions: [] }, { id: 'x', type: 'notAType' }, {}, [], null);
  check(unsupported.passed === false &&
    unsupported.actual.error === 'Unsupported postcondition type',
    '1: the unsupported-type fallthrough is untouched and still fails closed');
}

// ── Scenario 2: the exact literal completion-authority form. ─────────────────
scenarios += 1;
{
  for (const [overrides, label] of [
    [{ parentBinding: undefined }, 'parentBinding absent'],
    [{ parentBinding: 'parent:5' }, 'foreign parentBinding'],
    [{ parentWorkflowId: undefined }, 'parentWorkflowId absent'],
    [{ parentWorkflowId: 'wf-other' }, 'foreign parent workflow'],
    [{ spawnedByStepId: '{{step}}' }, 'template-authored step selector'],
    [{ childWorkflowId: '' }, 'blank child workflow'],
    [{ expectedUnits: undefined }, 'expectedUnits absent'],
    [{ expectedUnits: [] }, 'expectedUnits empty'],
    [{ expectedUnits: 'alpha' }, 'expectedUnits not an array'],
    [{ expectedUnits: ['{{units}}'] }, 'template-authored unit'],
    [{ expectedUnits: ['alpha', 'alpha'] }, 'duplicate authored units'],
    [{ expect: undefined }, 'expect absent'],
    [{ expect: { disposition: 'weird' } }, 'disposition not an attempt disposition'],
    [{ expect: { disposition: ['completed', 'completed'] } }, 'duplicate acceptable outcomes'],
    [{ expect: { disposition: [] } }, 'empty acceptable outcomes']
  ]) {
    const result = evaluate(criterion(overrides), completedAlphaFacts());
    check(result.passed === false && typeof result.actual.error === 'string' &&
      result.actual.error.length > 0,
      `2: ${label} fails closed as a deterministic unsatisfied result`);
  }
  const missingFacts = evaluate(criterion(), null);
  check(missingFacts.passed === false &&
    missingFacts.actual.error === 'childTerminalOutcome durable child facts were not supplied',
    '2: evaluation without supplied durable facts fails closed');
}

// ── Scenario 3: zero resolved child for an expected unit. ────────────────────
scenarios += 1;
{
  const result = evaluate(criterion(), childFacts({ units: [] }));
  check(result.passed === false &&
    result.actual.unsatisfiedReasons.length === 1 &&
    result.actual.unsatisfiedReasons[0].reason === 'CHILD_MISSING',
    '3: an authored expected unit that was never created is CHILD_MISSING, never waived');
  check(result.actual.perUnit[0].childTicketId === null &&
    result.actual.perUnit[0].resolution === 'missing',
    '3: the missing unit entry is explicit about its absence');
}

// ── Scenario 4: ambiguous (multiple applicable) children for a unit. ─────────
scenarios += 1;
{
  const result = evaluate(criterion(), childFacts({
    units: [
      { childTicketId: 501, unitKey: 'alpha', status: 'completed' },
      { childTicketId: 502, unitKey: 'alpha', status: 'completed' }
    ]
  }));
  check(result.passed === false &&
    result.actual.unsatisfiedReasons[0].reason === 'CHILD_AMBIGUOUS' &&
    result.actual.perUnit[0].childTicketIds &&
    result.actual.perUnit[0].childTicketIds.length === 2,
    '4: a duplicated/conflicting child for one unit refuses typed, never double-counted');
}

// ── Scenario 5: incoherent delegated provenance for a claiming child. ────────
scenarios += 1;
{
  // The child durably claims the unit's spawn key, but its delegation block
  // diverges from its own payload (a kernel key conflict).
  const conflictingPayload = {
    parentTicketId: PARENT_TICKET_ID,
    parentRunId: PARENT_RUN_ID,
    parentWorkflowId: PARENT_WORKFLOW_ID,
    spawnedByStepId: SPAWN_STEP_ID,
    spawnPlanId: `${PARENT_RUN_ID}:${PARENT_WORKFLOW_ID}:${SPAWN_STEP_ID}:transition:0`,
    workflowId: CHILD_WORKFLOW_ID,
    spawnIdempotencyKey: spawnKey('alpha'),
    objective: 'alpha'
  };
  const records = [provenanceRecord({
    ...conflictingPayload,
    delegation: delegationBlock('beta')
  })];
  const delegated = resolveDelegatedSpawnRelation({
    childTicketId: CHILD_TICKET_ID,
    records,
    existingParentTicketIds: new Set([PARENT_TICKET_ID])
  });
  check(delegated.outcome === 'REFUSED' &&
    delegated.reason === DELEGATED_REFUSAL_REASONS.DELEGATED_PROVENANCE_KEY_CONFLICT,
    '5: the kernel refuses a divergent delegation block (fixture sanity)');
  const result = evaluate(criterion(), childFacts({
    units: [{
      childTicketId: CHILD_TICKET_ID,
      unitKey: 'alpha',
      delegatedResolution: delegated,
      claimedSpawnKey: spawnKey('alpha')
    }]
  }));
  check(result.passed === false &&
    result.actual.unsatisfiedReasons[0].reason === 'CHILD_PROVENANCE_UNCOHERENT' &&
    result.actual.unsatisfiedReasons[0].provenanceRefusal ===
      DELEGATED_REFUSAL_REASONS.DELEGATED_PROVENANCE_KEY_CONFLICT,
    '5: a claiming child with incoherent provenance cannot succeed');
}

// ── Scenario 6: the child's durable workflow identity mismatch. ──────────────
scenarios += 1;
{
  const result = evaluate(criterion(), childFacts({
    units: [{
      childTicketId: CHILD_TICKET_ID,
      unitKey: 'alpha',
      childWorkflowId: 'wf-r3-OTHER-child'
    }]
  }));
  check(result.passed === false &&
    result.actual.unsatisfiedReasons[0].reason === 'CHILD_PROVENANCE_UNCOHERENT' &&
    result.actual.unsatisfiedReasons[0].provenanceRefusal === 'DELEGATED_CHILD_WORKFLOW_MISMATCH',
    '6: a child whose durable workflow identity diverges from the authored selector cannot succeed');
}

// ── Scenario 7: incomplete parent lineage fails the whole criterion. ─────────
scenarios += 1;
{
  const result = evaluate(criterion(), childFacts({
    units: [{
      childTicketId: CHILD_TICKET_ID,
      unitKey: 'alpha',
      status: 'completed',
      currentAttempt: attempt({ disposition: 'completed', settledAt: '2026-10-27T00:01:00.000Z' }),
      memberRuns: [memberRun({ status: 'completed' })]
    }],
    refused: [{ childTicketId: 503, reason: 'MALFORMED_SPAWN_PROVENANCE' }]
  }));
  check(result.passed === false &&
    result.actual.error === 'the parent Ticket spawn lineage could not be completely resolved' &&
    Array.isArray(result.actual.refusedChildren) &&
    result.actual.refusedChildren.length === 1,
    '7: no filtered subset of the T4 relation may establish truth (T4-I3)');
}

// ── Scenario 8: failed child under a success-only criterion. ─────────────────
scenarios += 1;
{
  const result = evaluate(criterion(), childFacts({
    units: [{
      childTicketId: CHILD_TICKET_ID,
      unitKey: 'alpha',
      status: 'open',
      currentAttempt: attempt({ disposition: 'failed', settledAt: '2026-10-27T00:01:00.000Z' }),
      memberRuns: [memberRun({ status: 'failed' })]
    }]
  }));
  check(result.passed === false &&
    result.actual.unsatisfiedReasons[0].reason === 'CHILD_TERMINAL_OUTCOME_UNACCEPTABLE',
    '8: terminal failure is a known negative that never satisfies a success-only criterion');
}

// ── Scenario 9: authored acceptable-outcome sets match exactly. ───────────────
scenarios += 1;
{
  const failedChild = childFacts({
    units: [{
      childTicketId: CHILD_TICKET_ID,
      unitKey: 'alpha',
      status: 'open',
      currentAttempt: attempt({ disposition: 'failed', settledAt: '2026-10-27T00:01:00.000Z' }),
      memberRuns: [memberRun({ status: 'failed' })]
    }]
  });
  const acceptsFailure = evaluate(criterion({ expect: { disposition: ['failed', 'blocked'] } }), failedChild);
  check(acceptsFailure.passed === true &&
    acceptsFailure.actual.perUnit[0].truthDisposition === 'failed',
    '9: an authored multi-outcome set accepts exactly the outcomes it authors');
  const blockedChild = childFacts({
    units: [{
      childTicketId: CHILD_TICKET_ID,
      unitKey: 'alpha',
      status: 'blocked',
      currentAttempt: attempt({ disposition: 'blocked', settledAt: '2026-10-27T00:01:00.000Z' }),
      memberRuns: [memberRun({
        status: 'completed',
        completionAuthoritySnapshot: { objectiveContractHash: 'c'.repeat(64) },
        decisionFixture: decision({ completionDisposition: 'blocked' })
      })]
    }]
  });
  const blockedOutcome = evaluate(criterion({ expect: { disposition: ['failed', 'blocked'] } }), blockedChild);
  check(blockedOutcome.passed === true,
    '9: the second authored outcome also satisfies when the durable truth is blocked');
  const interruptedChild = childFacts({
    units: [{
      childTicketId: CHILD_TICKET_ID,
      unitKey: 'alpha',
      status: 'open',
      currentAttempt: attempt({ disposition: 'interrupted', settledAt: '2026-10-27T00:01:00.000Z' }),
      memberRuns: [memberRun({ status: 'interrupted' })]
    }]
  });
  const rejectsUnauthored = evaluate(criterion({ expect: { disposition: ['failed', 'blocked'] } }), interruptedChild);
  check(rejectsUnauthored.passed === false &&
    rejectsUnauthored.actual.unsatisfiedReasons[0].reason === 'CHILD_TERMINAL_OUTCOME_UNACCEPTABLE',
    '9: an outcome outside the authored set never satisfies');
}

// ── Scenario 10: unsettled child / torn attempt truth. ───────────────────────
scenarios += 1;
{
  const unsettled = evaluate(criterion(), childFacts({
    units: [{ childTicketId: CHILD_TICKET_ID, unitKey: 'alpha', status: 'in_progress', currentAttempt: attempt(), memberRuns: [memberRun()] }]
  }));
  check(unsettled.passed === false &&
    unsettled.actual.unsatisfiedReasons[0].reason === 'CHILD_ATTEMPT_UNSETTLED',
    '10: an unsettled current attempt never satisfies a terminal criterion');
  const noAttempt = evaluate(criterion(), childFacts({
    units: [{
      childTicketId: CHILD_TICKET_ID,
      unitKey: 'alpha',
      status: 'blocked',
      currentAttempt: null,
      memberRuns: []
    }]
  }));
  check(noAttempt.passed === false &&
    noAttempt.actual.unsatisfiedReasons[0].reason === 'CHILD_HAS_NO_ATTEMPT',
    '10: a held virgin child (zero attempts) reports the durable held state, never success');
  const torn = evaluate(criterion(), childFacts({
    units: [{
      childTicketId: CHILD_TICKET_ID,
      unitKey: 'alpha',
      status: 'in_progress',
      currentAttempt: attempt({ disposition: 'completed', settledAt: '2026-10-27T00:01:00.000Z' }),
      memberRuns: [memberRun({ status: 'running' })]
    }]
  }));
  check(torn.passed === false &&
    torn.actual.unsatisfiedReasons[0].reason === 'CHILD_RUN_MEMBERS_NOT_TERMINAL',
    '10: a settled attempt with non-terminal member Runs reports the torn member truth');
}

// ── Scenario 11: newer unsettled attempt overrides an older terminal one. ────
scenarios += 1;
{
  const result = evaluate(criterion(), childFacts({
    units: [{
      childTicketId: CHILD_TICKET_ID,
      unitKey: 'alpha',
      status: 'in_progress',
      currentAttempt: attempt({ id: 602, ordinal: 2 }),
      memberRuns: [memberRun({ id: 902, ticketAttemptId: 602, status: 'running' })]
    }]
  }));
  check(result.passed === false &&
    result.actual.unsatisfiedReasons[0].reason === 'CHILD_ATTEMPT_UNSETTLED' &&
    result.actual.perUnit[0].attemptState === 'unsettled',
    '11: the superseded older terminal attempt never overrides the current unsettled truth');
}

// ── Scenario 12: N-unit aggregation and ordering invariance. ─────────────────
scenarios += 1;
{
  const twoCompleted = unit => childTicketId => childFacts({
    units: [
      { childTicketId, unitKey: 'alpha', status: 'completed', currentAttempt: attempt({ disposition: 'completed', settledAt: '2026-10-27T00:01:00.000Z' }), memberRuns: [memberRun({ status: 'completed', completionAuthoritySnapshot: { objectiveContractHash: 'c'.repeat(64) }, decisionFixture: decision() })] },
      { childTicketId: childTicketId + 1, unitKey: 'beta', status: 'completed', currentAttempt: attempt({ disposition: 'completed', settledAt: '2026-10-27T00:01:00.000Z' }), memberRuns: [memberRun({ id: CHILD_RUN_ID + 1, status: 'completed', completionAuthoritySnapshot: { objectiveContractHash: 'c'.repeat(64) }, decisionFixture: decision({ runId: CHILD_RUN_ID + 1 }) })] }
    ]
  });
  const factsForTwo = childFacts({
    units: [
      { childTicketId: 501, unitKey: 'alpha', status: 'completed', currentAttempt: attempt({ disposition: 'completed', settledAt: '2026-10-27T00:01:00.000Z' }), memberRuns: [memberRun({ status: 'completed', completionAuthoritySnapshot: { objectiveContractHash: 'c'.repeat(64) }, decisionFixture: decision() })] },
      { childTicketId: 502, unitKey: 'beta', status: 'completed', currentAttempt: attempt({ disposition: 'completed', settledAt: '2026-10-27T00:01:00.000Z' }), memberRuns: [memberRun({ id: CHILD_RUN_ID + 1, status: 'completed', completionAuthoritySnapshot: { objectiveContractHash: 'c'.repeat(64) }, decisionFixture: decision({ runId: CHILD_RUN_ID + 1 }) })] }
    ]
  });
  const both = evaluate(criterion({ expectedUnits: ['alpha', 'beta'] }), factsForTwo);
  check(both.passed === true && both.actual.perUnit.length === 2,
    '12: every authored unit is required and two completed units satisfy');
  const partial = evaluate(
    criterion({ expectedUnits: ['alpha', 'beta', 'gamma'] }),
    childFacts({
      units: [
        { childTicketId: 501, unitKey: 'alpha', status: 'completed', currentAttempt: attempt({ disposition: 'completed', settledAt: '2026-10-27T00:01:00.000Z' }), memberRuns: [memberRun({ status: 'completed', completionAuthoritySnapshot: { objectiveContractHash: 'c'.repeat(64) }, decisionFixture: decision() })] },
        { childTicketId: 502, unitKey: 'beta', status: 'completed', currentAttempt: attempt({ disposition: 'completed', settledAt: '2026-10-27T00:01:00.000Z' }), memberRuns: [memberRun({ id: CHILD_RUN_ID + 1, status: 'completed', completionAuthoritySnapshot: { objectiveContractHash: 'c'.repeat(64) }, decisionFixture: decision({ runId: CHILD_RUN_ID + 1 }) })] }
      ]
    }));
  check(partial.passed === false &&
    partial.actual.unsatisfiedReasons.length === 1 &&
    partial.actual.unsatisfiedReasons[0].unitKey === 'gamma',
    '12: a partial child set (A+B of A+B+C) cannot succeed');
  const forward = evaluate(criterion({ expectedUnits: ['alpha', 'beta', 'gamma'] }), childFacts({ units: [] }));
  const backward = evaluate(criterion({ expectedUnits: ['gamma', 'beta', 'alpha'] }), childFacts({ units: [] }));
  check(forward.passed === backward.passed &&
    JSON.stringify([...forward.actual.unsatisfiedReasons].map(r => r.unitKey).sort()) ===
      JSON.stringify([...backward.actual.unsatisfiedReasons].map(r => r.unitKey).sort()),
    '12: ordering of expectedUnits does not alter the truth');
}

// ── Scenario 13: rerun/rerun-adopt determinism — Ticket-stable identity. ─────
scenarios += 1;
{
  // A parent rerun is a NEW parent Run (different id, different Run-scoped
  // spawnPlanId) evaluating the same authored expected-unit set. The logical
  // child identity must not move.
  const rerunRun = parentRun({ id: PARENT_RUN_ID + 1 });
  const factsOriginal = completedAlphaFacts();
  const factsRerun = childFacts({
    units: [{
      childTicketId: CHILD_TICKET_ID,
      unitKey: 'alpha',
      status: 'completed',
      currentAttempt: attempt({ disposition: 'completed', settledAt: '2026-10-27T00:01:00.000Z' }),
      memberRuns: [memberRun({ status: 'completed', completionAuthoritySnapshot: { objectiveContractHash: 'c'.repeat(64) }, decisionFixture: decision() })],
      delegatedResolution: {
        outcome: 'FACT',
        fact: { childTicketId: CHILD_TICKET_ID, parentTicketId: PARENT_TICKET_ID, kind: 'workflow-spawn', originEvent: { position: 1 } },
        delegation: delegationBlock('alpha', {
          spawnPlanId: `${PARENT_RUN_ID}:${PARENT_WORKFLOW_ID}:${SPAWN_STEP_ID}:transition:0`
        })
      },
      claimedSpawnKey: spawnKey('alpha')
    }]
  });
  const original = evaluate(criterion(), factsOriginal);
  const rerun = evaluate(criterion(), factsRerun, { id: PARENT_RUN_ID + 1 });
  check(original.passed === true && rerun.passed === true &&
    original.actual.perUnit[0].spawnIdempotencyKey === rerun.actual.perUnit[0].spawnIdempotencyKey,
    '13: a parent rerun resolves the same Ticket-stable child identity');
  check(rerunRun.workflowId === PARENT_WORKFLOW_ID,
    '13: the rerun run fixture is distinct (sanity)');
  // spawnPlanId never participates: a mutated Run-scoped reference changes nothing.
  const divergentPlanFacts = childFacts({
    units: [{
      childTicketId: CHILD_TICKET_ID,
      unitKey: 'alpha',
      status: 'completed',
      currentAttempt: attempt({ disposition: 'completed', settledAt: '2026-10-27T00:01:00.000Z' }),
      memberRuns: [memberRun({ status: 'completed', completionAuthoritySnapshot: { objectiveContractHash: 'c'.repeat(64) }, decisionFixture: decision() })],
      delegatedResolution: {
        outcome: 'FACT',
        fact: { childTicketId: CHILD_TICKET_ID, parentTicketId: PARENT_TICKET_ID, kind: 'workflow-spawn', originEvent: { position: 1 } },
        delegation: delegationBlock('alpha', { spawnPlanId: '999:wf-parent:spawn-units:transition:99' })
      },
      claimedSpawnKey: spawnKey('alpha')
    }]
  });
  const divergentPlan = evaluate(criterion(), divergentPlanFacts);
  check(divergentPlan.passed === true,
    '13: spawnPlanId remains Run-scoped historical execution evidence, not logical identity');
}

// ── Scenario 14: no prose authority — the result vocabulary is normalized. ───
scenarios += 1;
{
  const result = evaluate(criterion(), completedAlphaFacts());
  const serialized = JSON.stringify(result);
  check(!serialized.includes('objective') && !serialized.includes('Objective'),
    '14: the satisfied result carries no child objective/prose');
  check(Object.keys(result.actual.perUnit[0]).every(key =>
    ['unitKey', 'spawnIdempotencyKey', 'resolution', 'childTicketId', 'ticketState', 'attemptState',
      'attemptDisposition', 'runTerminal', 'truthDisposition', 'memberDispositions', 'evidenceError', 'memberCount',
      'attemptStability']
      .includes(key) || key === 'completionDisposition' || key === 'completionReasonCode' || key === 'childWorkflowIdMatches'),
    '14: per-unit entries expose only normalized deterministic composition facts');
}

// ── Scenario 15: kernel-level contract of the pure unit evaluator. ───────────
scenarios += 1;
{
  const matched = ctx.evaluateChildTerminalOutcomeUnit({
    acceptableDispositions: ['completed'],
    currentAttempt: attempt({ disposition: 'completed', settledAt: '2026-10-27T00:01:00.000Z' }),
    memberRuns: [memberRun({ status: 'completed' })],
    decisionByRunId: new Map()
  });
  check(matched.satisfied === true && matched.reason === 'CHILD_TERMINAL_OUTCOME_MATCHED',
    '15: a generic terminal Run projects through its materialized status');
  const evidenceMissing = ctx.evaluateChildTerminalOutcomeUnit({
    acceptableDispositions: ['completed'],
    currentAttempt: attempt({ disposition: 'completed', settledAt: '2026-10-27T00:01:00.000Z' }),
    memberRuns: [memberRun({ status: 'completed', completionAuthoritySnapshot: { objectiveContractHash: 'c'.repeat(64) }, decisionFixture: undefined })],
    decisionByRunId: new Map()
  });
  check(evidenceMissing.satisfied === false &&
    evidenceMissing.reason === 'CHILD_COMPLETION_EVIDENCE_UNAVAILABLE' &&
    evidenceMissing.unitState.evidenceError === 'COMPLETION_EVIDENCE_MISSING',
    '15: a structured terminal Run without its durable completion decision fails closed typed');
  const staleDecision = ctx.evaluateChildTerminalOutcomeUnit({
    acceptableDispositions: ['completed'],
    currentAttempt: attempt({ disposition: 'completed', settledAt: '2026-10-27T00:01:00.000Z' }),
    memberRuns: [memberRun({ status: 'completed', completionAuthoritySnapshot: { objectiveContractHash: 'c'.repeat(64) }, decisionFixture: decision({ runId: 999999 }) })],
    decisionByRunId: new Map([[CHILD_RUN_ID, decision({ runId: 999999 })]])
  });
  check(staleDecision.satisfied === false &&
    staleDecision.reason === 'CHILD_COMPLETION_EVIDENCE_UNAVAILABLE' &&
    staleDecision.unitState.evidenceError === 'COMPLETION_EVIDENCE_MISSING',
    '15: a stale/foreign decision for a claiming Run is evidence-unavailable, never satisfaction');
  const truthConflict = ctx.evaluateChildTerminalOutcomeUnit({
    acceptableDispositions: ['completed'],
    currentAttempt: attempt({ disposition: 'failed', settledAt: '2026-10-27T00:01:00.000Z' }),
    memberRuns: [memberRun({ status: 'completed' })],
    decisionByRunId: new Map()
  });
  check(truthConflict.satisfied === false && truthConflict.reason === 'CHILD_ATTEMPT_TRUTH_CONFLICT',
    '15: a settled attempt whose kernel truth contradicts its persisted disposition conflicts typed');
}

// ── Scenario 16: the await observation's authority is definition-seam literal
// (UNITKEY-A at the awaitChildTickets step). ─────────────────────────────────
scenarios += 1;
{
  const validate = ctx.validateAwaitChildTicketsStepInput;
  const validInput = {
    parentBinding: 'self',
    parentWorkflowId: PARENT_WORKFLOW_ID,
    spawnedByStepId: SPAWN_STEP_ID,
    childWorkflowId: CHILD_WORKFLOW_ID,
    expectedUnits: ['alpha', 'beta']
  };
  check(validate({ id: 'await', action: 'awaitChildTickets', input: validInput }, 0, { id: PARENT_WORKFLOW_ID }).length === 0,
    '16: a fully literal authored await input validates clean at the definition seam');
  const refusals = [
    [{ ...validInput, expectedUnits: ['{{step.out}}'] }, 'template-derived expectedUnits'],
    [{ ...validInput, spawnedByStepId: '{{step.id}}' }, 'template-derived selector'],
    [{ ...validInput, expectedUnits: [] }, 'empty expectedUnits'],
    [{ ...validInput, expectedUnits: ['alpha', 'alpha'] }, 'duplicate expectedUnits'],
    [{ ...validInput, parentBinding: 'parent:5' }, 'foreign parentBinding'],
    [{ ...validInput, parentWorkflowId: 'wf-OTHER' }, 'foreign parent workflow'],
    [{ ...validInput, pollIntervalMs: 10 }, 'unbounded poll cadence'],
    [{ ...validInput, maxPollMs: 400000 }, 'unbounded poll window']
  ];
  for (const [input, label] of refusals) {
    check(validate({ id: 'await', action: 'awaitChildTickets', input }, 0, { id: PARENT_WORKFLOW_ID })
      .some(message => typeof message === 'string' && message.length > 0),
      `16: ${label} refuses at the definition seam (the runtime sees only the resolved input)`);
  }
  check(validate({ id: 'await', action: 'awaitChildTickets', input: '{{context}}' }, 0, { id: PARENT_WORKFLOW_ID })
    .some(message => message.includes('must be an object')),
    '16: a whole-input template leaves no authored authority and refuses');
}

// ── Scenario 17: the current-attempt consistency boundary (CHILD-RERUN-A,
//    during-read interleaving). The criterion refuses a superseded captured
//    attempt typed, with the member history left unevaluated. ─────────────────
scenarios += 1;
{
  // The false-success race facts: the loader captured attempt A settled
  // completed with a fully member-complete immutable history — but a child
  // rerun admitted while those facts were loading made a NEWER attempt (B,
  // ordinal 2, unsettled) the child's real canonical current attempt. The
  // loader's typed stability fact marks the read changed, and the shared
  // per-unit evaluation must NEVER evaluate the captured A history.
  const supersededCompletedAlpha = childFacts({
    units: [{
      childTicketId: CHILD_TICKET_ID,
      unitKey: 'alpha',
      status: 'completed',
      currentAttempt: attempt({ disposition: 'completed', settledAt: '2026-10-27T00:01:00.000Z' }),
      memberRuns: [memberRun({
        status: 'completed',
        completionAuthoritySnapshot: { objectiveContractHash: 'c'.repeat(64) },
        decisionFixture: decision()
      })]
    }],
    overrides: {
      currentAttemptStabilityByChildId:
        new Map([[CHILD_TICKET_ID, 'CHILD_ATTEMPT_CHANGED_DURING_READ']])
    }
  });
  const refused = evaluate(criterion(), supersededCompletedAlpha);
  check(refused.passed === false &&
    refused.actual.unsatisfiedReasons.length === 1 &&
    refused.actual.unsatisfiedReasons[0].unitKey === 'alpha' &&
    refused.actual.unsatisfiedReasons[0].reason === 'CHILD_ATTEMPT_CHANGED_DURING_READ',
    '17: a child rerun admitted during fact loading fails the unit closed typed — the captured terminal history never satisfies');
  const unit = refused.actual.perUnit[0];
  check(unit.attemptStability === 'CHILD_ATTEMPT_CHANGED_DURING_READ' &&
    unit.runTerminal === null && unit.truthDisposition === null &&
    unit.memberDispositions === null && unit.evidenceError === null,
    '17: the superseded attempt member history stays unevaluated (no terminal authority is claimed)');
  check(unit.attemptState === 'settled' && unit.attemptDisposition === 'completed' &&
    unit.childTicketId === CHILD_TICKET_ID,
    '17: the per-unit entry still echoes the CAPTURED attempt identity facts deterministically');

  // Appear-during-read: the read started with NO attempt and an attempt
  // appeared before the consistency point. Absence must never be
  // reinterpreted as stable held truth — typed fail closed, nonterminal.
  const appearedDuringRead = childFacts({
    units: [{
      childTicketId: CHILD_TICKET_ID,
      unitKey: 'alpha',
      status: 'open',
      currentAttempt: null,
      memberRuns: []
    }],
    overrides: {
      currentAttemptStabilityByChildId:
        new Map([[CHILD_TICKET_ID, 'CHILD_ATTEMPT_CHANGED_DURING_READ']])
    }
  });
  const appeared = evaluate(criterion(), appearedDuringRead);
  check(appeared.passed === false &&
    appeared.actual.unsatisfiedReasons[0].reason === 'CHILD_ATTEMPT_CHANGED_DURING_READ' &&
    appeared.actual.perUnit[0].attemptState === 'none',
    '17: an attempt that appeared during a read that started with none fails typed, never reinterpreted as stable held truth');

  // Control: identical facts with the loader's STABLE fact satisfy exactly
  // as before — the consistency boundary only refuses on a recorded
  // concurrent change.
  const stableAlpha = childFacts({
    units: [{
      childTicketId: CHILD_TICKET_ID,
      unitKey: 'alpha',
      status: 'completed',
      currentAttempt: attempt({ disposition: 'completed', settledAt: '2026-10-27T00:01:00.000Z' }),
      memberRuns: [memberRun({
        status: 'completed',
        completionAuthoritySnapshot: { objectiveContractHash: 'c'.repeat(64) },
        decisionFixture: decision()
      })]
    }],
    overrides: {
      currentAttemptStabilityByChildId: new Map([[CHILD_TICKET_ID, 'STABLE']])
    }
  });
  const stable = evaluate(criterion(), stableAlpha);
  check(stable.passed === true && stable.actual.perUnit[0].attemptStability === 'STABLE',
    '17: identical facts with the loader STABLE fact satisfy exactly as before');

  // Kernel-level: the direct per-unit evaluation mirrors the same contract —
  // the typed refusal precedes any member evaluation, and a missing
  // stability fact keeps the stable semantics of every earlier scenario.
  const kernelRefused = ctx.evaluateChildTerminalOutcomeUnit({
    acceptableDispositions: ['completed'],
    currentAttempt: attempt({ disposition: 'completed', settledAt: '2026-10-27T00:01:00.000Z' }),
    memberRuns: [memberRun({
      status: 'completed',
      completionAuthoritySnapshot: { objectiveContractHash: 'c'.repeat(64) }
    })],
    decisionByRunId: new Map([[CHILD_RUN_ID, decision()]]),
    currentAttemptStability: 'CHILD_ATTEMPT_CHANGED_DURING_READ'
  });
  check(kernelRefused.satisfied === false &&
    kernelRefused.reason === 'CHILD_ATTEMPT_CHANGED_DURING_READ' &&
    kernelRefused.unitState.attemptState === 'settled' &&
    kernelRefused.unitState.runTerminal === null &&
    kernelRefused.unitState.evidenceError === null,
    '17: kernel-level — a changed-during-read fact refuses before any member history is evaluated');
  const kernelStable = ctx.evaluateChildTerminalOutcomeUnit({
    acceptableDispositions: ['completed'],
    currentAttempt: attempt({ disposition: 'completed', settledAt: '2026-10-27T00:01:00.000Z' }),
    memberRuns: [memberRun({
      status: 'completed',
      completionAuthoritySnapshot: { objectiveContractHash: 'c'.repeat(64) }
    })],
    decisionByRunId: new Map([[CHILD_RUN_ID, decision()]]),
    currentAttemptStability: 'STABLE'
  });
  check(kernelStable.satisfied === true &&
    kernelStable.reason === 'CHILD_TERMINAL_OUTCOME_MATCHED' &&
    kernelStable.unitState.attemptStability === 'STABLE',
    '17: kernel-level — the loader STABLE fact evaluates the member truth normally');
}

console.log(`\nPASS: P5-R3 composition-consumption criterion contract — ${scenarios} scenarios, ${assertions} assertions (deterministic)`);

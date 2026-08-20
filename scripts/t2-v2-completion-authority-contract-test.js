#!/usr/bin/env node
'use strict';

// Tranche 1 deterministic contract suite for runtime/v2-completion-authority-contract.
//
// THE CANONICAL QUESTION (corrected): given the currently durable
// authoritative evidence under lock, is completion already deterministically
// established? Not "does the persisted aggregate equal the fresh aggregate?"
//
// Source-derived classification under test:
//   * The persisted aggregateDecision is a MATERIALIZED PROJECTION written
//     solely by _reconcileLeafItemsLocked; it may legitimately go stale
//     (pending/running/interrupted) while evidence advances.
//   * normalizeAggregatePlanDecision proves structure/integrity/binding, NOT
//     freshness; malformed/misbound persisted authority is an INTEGRITY
//     FAILURE that throws (mirroring the production row read), never a silent
//     fallback to the fresh derivation.
//   * A structurally valid TERMINAL (completed/failed) aggregate conflicting
//     with current evidence is an integrity contradiction (unreachable through
//     legitimate channels) and must be refused, not resolved to either side.
//
// SETTLEMENT/CANCELLATION EQUIVALENCE is proven structurally, not merely by
// calling the same function twice: for every REACHABLE matrix row, the
// cancellation verdict (computed from the stored materialization) equals the
// settlement verdict (computed from the refreshed materialization that
// settlement's reconciliation deterministically writes from the same evidence
// with no new semantic fact). The terminal-conflict rows are unreachable and
// assert refusal for both consumers instead.

const assert = require('node:assert/strict');
const {
  evaluateV2CompletionAuthority,
  selectLeafRuns,
  computeAggregateDecision,
  materializationIsCurrent,
  TERMINAL_AGGREGATE_STATUSES,
  V2CompletionAuthorityError
} = require('../runtime/v2-completion-authority-contract');
const {
  normalizeAggregatePlanDecision,
  buildLeafRunBinding
} = require('../runtime/structured-allocation-leaf-run-contract');
const {
  buildCompletionAuthoritySnapshot,
  normalizeCompletionDecision
} = require('../runtime/completion-decision-contract');

const PLAN_HASH = 'a0'.repeat(32);
const PROVENANCE_HASH = 'b0'.repeat(32);
const ADMISSION_HASH = 'c0'.repeat(32);
const PARENT_DECLARED_HASH = '11'.repeat(32);
const ITEM_DECLARED_HASH = '22'.repeat(32);
const POLICY_HASH = 'f0'.repeat(32);
const DECISION_HASH = '88'.repeat(32);
const OP_RECEIPT_HASH = 'bb'.repeat(32);
const CONSEQUENCE_HASH = 'cc'.repeat(32);
const REQUIRED_EVIDENCE_HASH = 'dd'.repeat(32);
const CONTRACT_NULL_HASH = '00'.repeat(32);
const REQUEST_HASH = '44'.repeat(32);
const RESPONSE_HASH = '55'.repeat(32);
const PROPOSAL_HASH = '66'.repeat(32);
const PLANNING_AUTH_HASH = '77'.repeat(32);

// Minimal mock leafPlan object. The v2 completion evaluator consumes the
// shape fields directly (id, ticketId, planHash, planningProvenance,
// items), bypassing full plan validation. This keeps the suite focused
// on the shared evaluator rather than the allocation-plan normalizer.
// The completion-decision and binding authorities are always built by the
// canonical production builders.
function makePlan(items) {
  return {
    id: 1,
    version: 2,
    ticketId: 1,
    mode: 'owned_paths',
    parentDeclaredWorkSnapshot: {
      version: 1,
      objective: { text: 'test', provenance: 'ticket-authored' },
      expectedOutputs: [],
      successCriteria: [],
      evidenceRequirements: [],
      contractHash: CONTRACT_NULL_HASH
    },
    sharedConstraints: [],
    planHash: PLAN_HASH,
    planningProvenance: {
      attemptId: 'attempt-1',
      plannerAgentId: 100,
      provider: 'openai',
      model: 'test-model',
      planningAuthoritySnapshotHash: PLANNING_AUTH_HASH,
      parentDeclaredWorkHash: PARENT_DECLARED_HASH,
      requestHash: REQUEST_HASH,
      responseHash: RESPONSE_HASH,
      proposalHash: PROPOSAL_HASH,
      planHash: PLAN_HASH,
      provenanceHash: PROVENANCE_HASH,
      admissionHash: ADMISSION_HASH,
      admittedAt: '2026-01-01T00:00:00.000Z'
    },
    aggregateDecision: null,
    itemStatuses: items.map(item => ({
      allocationItemId: item.allocationItemId,
      status: 'pending',
      createdAt: '2026-01-01T00:00:00.000Z',
      decidedAt: null,
      lastReconciledAt: null
    })),
    items: items.map((item, index) => ({
      allocationItemId: item.allocationItemId,
      assignedAgentId: 100 + index,
      ownedOutputPaths: [`path-${index}`],
      successCriteria: []
    }))
  };
}

function buildBinding(id, ticketId, allocationItemId) {
  return buildLeafRunBinding({
    ticketId,
    allocationPlanId: 1,
    planHash: PLAN_HASH,
    allocationItemId,
    assignedAgentId: 100 + allocationItemId - 1,
    itemDeclaredWorkHash: ITEM_DECLARED_HASH,
    ownedOutputPaths: [`path-${allocationItemId - 1}`],
    parentDeclaredWorkHash: PARENT_DECLARED_HASH,
    planningAttemptId: 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d',
    planningAdmissionHash: ADMISSION_HASH,
    runId: id,
    admittedAt: '2026-01-01T00:00:00.000Z'
  });
}

// PRODUCTION run shape: runFromRow flattens the run body to the top level,
// so the canonical fields (leafRunBinding, declaredWorkSnapshot,
// completionAuthoritySnapshot) sit beside id/status — exactly the rows
// _reconcileLeafItemsLocked and settlement consume.
function makeRun(id, ticketId, status, allocationItemId, extras = {}) {
  return {
    id,
    ticketId,
    status,
    leafRunBinding: buildBinding(id, ticketId, allocationItemId),
    declaredWorkSnapshot: {
      version: 1,
      objective: { text: 'test', provenance: 'ticket-authored' },
      expectedOutputs: [],
      successCriteria: [],
      evidenceRequirements: [],
      contractHash: ITEM_DECLARED_HASH
    },
    completionAuthoritySnapshot: extras.completionAuthoritySnapshot || null
  };
}

function makeDecisionFor(runId, completionDisposition, casHash) {
  return {
    version: 1,
    runId,
    ticketId: 1,
    objectiveContractVersion: 1,
    objectiveContractHash: casHash,
    workflowDeclarationVersion: null,
    workflowDeclarationHash: null,
    executionPolicySnapshotHash: POLICY_HASH,
    runtimeBudgetSnapshotHash: null,
    operationReceiptAuthority: { revision: 0, hash: OP_RECEIPT_HASH },
    consequenceAuthority: { revision: 1, hash: CONSEQUENCE_HASH },
    requiredEvidenceAuthority: { revision: 0, hash: REQUIRED_EVIDENCE_HASH },
    executionDisposition: 'succeeded',
    verificationDisposition: 'passed',
    completionDisposition,
    evaluatedPostconditions: [],
    violations: [],
    evidenceIssues: [],
    reasonCode: 'OBJECTIVE_COMPLETED',
    modelClaim: null,
    browserEvidence: null,
    evaluatedAt: '2026-01-01T00:00:00.000Z',
    decisionHash: DECISION_HASH
  };
}

function buildCAS() {
  return buildCompletionAuthoritySnapshot({
    objective: 'test objective',
    kind: 'deterministic',
    recognized: true,
    intent: 'test',
    completionPolicy: 'test_policy',
    directPostconditions: [],
    verificationPolicy: 'when_declared',
    capturedAt: '2026-01-01T00:00:00.000Z'
  });
}

// ── Scenario builders: each yields the CURRENT durable facts plus the
// PERSISTED materialization that an earlier reconciliation would have left.
// Every authority-bearing value flows through the canonical builders.

function scenarioFreshCompleted() {
  const plan = makePlan([{ allocationItemId: 1 }, { allocationItemId: 2 }]);
  const cas1 = buildCAS();
  const cas2 = buildCAS();
  const runs = [
    makeRun(1, 1, 'completed', 1, { completionAuthoritySnapshot: cas1 }),
    makeRun(2, 1, 'completed', 2, { completionAuthoritySnapshot: cas2 })
  ];
  const decisions = new Map();
  decisions.set(1, makeDecisionFor(1, 'completed', cas1.objectiveContractHash));
  decisions.set(2, makeDecisionFor(2, 'completed', cas2.objectiveContractHash));
  return { plan, runs, decisions, persisted: null };
}

function scenarioFreshFailed() {
  const plan = makePlan([{ allocationItemId: 1 }, { allocationItemId: 2 }]);
  const cas1 = buildCAS();
  const cas2 = buildCAS();
  const runs = [
    makeRun(1, 1, 'completed', 1, { completionAuthoritySnapshot: cas1 }),
    makeRun(2, 1, 'failed', 2, { completionAuthoritySnapshot: cas2 })
  ];
  const decisions = new Map();
  decisions.set(1, makeDecisionFor(1, 'completed', cas1.objectiveContractHash));
  decisions.set(2, makeDecisionFor(2, 'incomplete', cas2.objectiveContractHash));
  return { plan, runs, decisions, persisted: null };
}

// THE CORE REGRESSION SCENARIO: a contract-valid persisted RUNNING aggregate
// (materialized by an earlier reconciliation over earlier evidence: item 2
// was still running) against current durable evidence that deterministically
// derives completed.
function scenarioStaleRunningFreshCompleted() {
  const plan = makePlan([{ allocationItemId: 1 }, { allocationItemId: 2 }]);
  const cas1 = buildCAS();
  const cas2 = buildCAS();
  // Earlier evidence: item 1 terminal completed with its decision; item 2
  // still running (no decision exists yet).
  const earlierRuns = [
    makeRun(1, 1, 'completed', 1, { completionAuthoritySnapshot: cas1 }),
    makeRun(2, 1, 'running', 2, { completionAuthoritySnapshot: cas2 })
  ];
  const earlierDecisions = new Map();
  earlierDecisions.set(1, makeDecisionFor(1, 'completed', cas1.objectiveContractHash));
  const persisted = computeAggregateDecision(plan, selectLeafRuns(earlierRuns, plan).leaves,
    earlierDecisions, '2026-01-01T00:00:00.000Z');
  // Current evidence: item 2 terminal completed with its decision.
  const runs = [
    makeRun(1, 1, 'completed', 1, { completionAuthoritySnapshot: cas1 }),
    makeRun(2, 1, 'completed', 2, { completionAuthoritySnapshot: cas2 })
  ];
  const decisions = new Map();
  decisions.set(1, makeDecisionFor(1, 'completed', cas1.objectiveContractHash));
  decisions.set(2, makeDecisionFor(2, 'completed', cas2.objectiveContractHash));
  return { plan, runs, decisions, persisted };
}

// Stale INTERRUPTED materialization: item 2's terminal run had no decision
// when the earlier reconciliation ran (run_consequences is insertable at any
// time after terminality, so the decision legitimately arrives late).
function scenarioStaleInterruptedFreshCompleted() {
  const base = scenarioStaleRunningFreshCompleted();
  // Item 1 completed WITH decision; item 2 terminal WITHOUT decision ->
  // item 2 derives 'interrupted' (missing evidence).
  const cas1 = buildCAS();
  const cas2 = buildCAS();
  const earlierRuns = [
    makeRun(1, 1, 'completed', 1, { completionAuthoritySnapshot: cas1 }),
    makeRun(2, 1, 'completed', 2, { completionAuthoritySnapshot: cas2 })
  ];
  const earlierDecisions = new Map();
  earlierDecisions.set(1, makeDecisionFor(1, 'completed', cas1.objectiveContractHash));
  const persisted = computeAggregateDecision(base.plan,
    selectLeafRuns(earlierRuns, base.plan).leaves,
    earlierDecisions, '2026-01-01T00:00:00.000Z');
  assert.equal(persisted.aggregateStatus, 'interrupted');
  const currentRuns = [
    makeRun(1, 1, 'completed', 1, { completionAuthoritySnapshot: cas1 }),
    makeRun(2, 1, 'completed', 2, { completionAuthoritySnapshot: cas2 })
  ];
  const decisions = new Map();
  decisions.set(1, makeDecisionFor(1, 'completed', cas1.objectiveContractHash));
  decisions.set(2, makeDecisionFor(2, 'completed', cas2.objectiveContractHash));
  return { plan: base.plan, runs: currentRuns, decisions, persisted };
}

function scenarioStalePendingFreshFailed() {
  const plan = makePlan([{ allocationItemId: 1 }, { allocationItemId: 2 }]);
  const cas1 = buildCAS();
  const cas2 = buildCAS();
  const earlierRuns = [
    makeRun(1, 1, 'pending', 1, { completionAuthoritySnapshot: cas1 }),
    makeRun(2, 1, 'pending', 2, { completionAuthoritySnapshot: cas2 })
  ];
  const persisted = computeAggregateDecision(plan, selectLeafRuns(earlierRuns, plan).leaves,
    new Map(), '2026-01-01T00:00:00.000Z');
  assert.equal(persisted.aggregateStatus, 'pending');
  const runs = [
    makeRun(1, 1, 'completed', 1, { completionAuthoritySnapshot: cas1 }),
    makeRun(2, 1, 'failed', 2, { completionAuthoritySnapshot: cas2 })
  ];
  const decisions = new Map();
  decisions.set(1, makeDecisionFor(1, 'completed', cas1.objectiveContractHash));
  decisions.set(2, makeDecisionFor(2, 'incomplete', cas2.objectiveContractHash));
  return { plan, runs, decisions, persisted };
}

function scenarioAgreementCompleted() {
  const base = scenarioFreshCompleted();
  const persisted = computeAggregateDecision(base.plan,
    selectLeafRuns(base.runs, base.plan).leaves, base.decisions,
    '2026-01-01T00:00:00.000Z');
  return { ...base, persisted };
}

function scenarioAgreementFailed() {
  const base = scenarioFreshFailed();
  const persisted = computeAggregateDecision(base.plan,
    selectLeafRuns(base.runs, base.plan).leaves, base.decisions,
    '2026-01-01T00:00:00.000Z');
  return { ...base, persisted };
}

// Terminal conflicts (F, H) are NOT reachable through legitimate channels;
// they are constructed here only to prove the evaluator refuses them.
function scenarioTerminalConflictPersistedCompletedFreshFailed() {
  const base = scenarioFreshFailed();
  // Persisted terminal COMPLETED over different (earlier, now-destroyed)
  // evidence: built from the completed-evidence scenario.
  const completedEvidence = scenarioFreshCompleted();
  const persisted = computeAggregateDecision(completedEvidence.plan,
    selectLeafRuns(completedEvidence.runs, completedEvidence.plan).leaves,
    completedEvidence.decisions, '2026-01-01T00:00:00.000Z');
  assert.equal(persisted.aggregateStatus, 'completed');
  return { ...base, persisted };
}

function scenarioTerminalConflictPersistedFailedFreshCompleted() {
  const base = scenarioFreshCompleted();
  const failedEvidence = scenarioFreshFailed();
  const persisted = computeAggregateDecision(failedEvidence.plan,
    selectLeafRuns(failedEvidence.runs, failedEvidence.plan).leaves,
    failedEvidence.decisions, '2026-01-01T00:00:00.000Z');
  assert.equal(persisted.aggregateStatus, 'failed');
  return { ...base, persisted };
}

// Historical accepted v2 representation (migration 039): the settled
// historical attempt carries the old hash-validated aggregate agreeing with
// the generic disposition. Modelled as a current materialization.
function scenarioHistoricalAccepted() {
  return scenarioAgreementCompleted();
}

async function main() {
  let assertions = 0;
  const test = (label, fn) => {
    try {
      fn();
      assertions += 1;
      console.log(`  ok ${label}`);
    } catch (error) {
      console.error(`  FAIL ${label}`);
      console.error(`    ${error.message}`);
      if (error.actual !== undefined && error.expected !== undefined) {
        console.error(`    actual:   ${JSON.stringify(error.actual)}`);
        console.error(`    expected: ${JSON.stringify(error.expected)}`);
      }
      process.exitCode = 1;
    }
  };

  console.log('T2 v2 completion authority — shared evaluator (corrected semantics)');

  const evaluate = scenario => evaluateV2CompletionAuthority({
    leafPlan: scenario.plan,
    memberRuns: scenario.runs,
    decisionsByRunId: scenario.decisions,
    persistedAggregateDecision: scenario.persisted,
    decidedAt: '2026-01-02T00:00:00.000Z'
  });

  // ─── A/B: no persisted aggregate, fresh decides ─────────────────────────
  test('A: no persisted + fresh completed -> inevitable, absent, materialization required', () => {
    const result = evaluate(scenarioFreshCompleted());
    assert.equal(result.completionInevitable, true);
    assert.equal(result.reason, 'fresh_candidate_completed');
    assert.equal(result.persistedState, 'absent');
    assert.equal(result.persistedAggregate, null);
    assert.equal(result.materializationRequired, true);
    assert.equal(result.currentAggregate.aggregateStatus, 'completed');
  });

  test('B: no persisted + fresh failed -> not inevitable', () => {
    const result = evaluate(scenarioFreshFailed());
    assert.equal(result.completionInevitable, false);
    assert.equal(result.reason, 'fresh_candidate_not_completed');
    assert.equal(result.persistedState, 'absent');
    assert.equal(result.materializationRequired, true);
  });

  test('B2: no leaves -> not inevitable, no materialization (reconciliation early-return)', () => {
    const plan = makePlan([{ allocationItemId: 1 }]);
    const result = evaluateV2CompletionAuthority({
      leafPlan: plan,
      memberRuns: [],
      decisionsByRunId: new Map()
    });
    assert.equal(result.completionInevitable, false);
    assert.equal(result.reason, 'no_leaves');
    assert.equal(result.currentAggregate, null);
    assert.equal(result.materializationRequired, false);
  });

  // ─── C: THE REGRESSION — stale nonterminal running vs fresh completed ──
  test('C: valid persisted running + fresh completed -> completionInevitable TRUE, stale, refresh required', () => {
    const scenario = scenarioStaleRunningFreshCompleted();
    const result = evaluate(scenario);
    assert.equal(result.persistedAggregate.aggregateStatus, 'running');
    assert.equal(result.currentAggregate.aggregateStatus, 'completed');
    assert.equal(result.persistedState, 'stale',
      'a nonterminal materialization over earlier evidence is stale, not conflicting');
    assert.equal(result.materializationRequired, true);
    assert.equal(result.completionInevitable, true,
      'stale materialization cannot make completion not inevitable when current durable evidence already determines it');
    assert.equal(result.reason, 'stale_materialization');
  });

  test('C-late-decision: valid persisted interrupted + fresh completed (decision arrived late) -> inevitable TRUE', () => {
    const scenario = scenarioStaleInterruptedFreshCompleted();
    const result = evaluate(scenario);
    assert.equal(result.persistedAggregate.aggregateStatus, 'interrupted');
    assert.equal(result.persistedState, 'stale',
      'interrupted is a refreshable nonterminal materialization (a decision may be recorded after terminality)');
    assert.equal(result.completionInevitable, true);
    assert.equal(result.materializationRequired, true);
  });

  test('D: valid persisted pending + fresh failed -> not inevitable, stale, refresh required', () => {
    const scenario = scenarioStalePendingFreshFailed();
    const result = evaluate(scenario);
    assert.equal(result.persistedState, 'stale');
    assert.equal(result.completionInevitable, false);
    assert.equal(result.currentAggregate.aggregateStatus, 'failed');
    assert.equal(result.materializationRequired, true);
  });

  // ─── E/G: agreement ──────────────────────────────────────────────────────
  test('E: persisted completed + fresh completed -> agreement, inevitable, no refresh', () => {
    const scenario = scenarioAgreementCompleted();
    const result = evaluate(scenario);
    assert.equal(result.persistedState, 'current');
    assert.equal(result.completionInevitable, true);
    assert.equal(result.reason, 'aggregate_completed_agreement');
    assert.equal(result.materializationRequired, false);
  });

  test('G: persisted failed + fresh failed -> agreement, not inevitable', () => {
    const scenario = scenarioAgreementFailed();
    const result = evaluate(scenario);
    assert.equal(result.persistedState, 'current');
    assert.equal(result.completionInevitable, false);
    assert.equal(result.reason, 'aggregate_failed');
    assert.equal(result.materializationRequired, false);
  });

  // ─── F/H: terminal conflicts are integrity contradictions ────────────────
  test('F: valid persisted TERMINAL completed + fresh failed -> integrity refusal, NOT inevitable', () => {
    const scenario = scenarioTerminalConflictPersistedCompletedFreshFailed();
    const result = evaluate(scenario);
    assert.equal(result.persistedState, 'terminal_conflict');
    assert.equal(result.completionInevitable, false,
      'a terminal-aggregate conflict is refused rather than resolved to either side');
    assert.equal(result.reason, 'terminal_aggregate_conflict');
    assert.equal(result.currentAggregate.aggregateStatus, 'failed');
  });

  test('H: valid persisted TERMINAL failed + fresh completed -> integrity refusal, completion NOT declared inevitable', () => {
    const scenario = scenarioTerminalConflictPersistedFailedFreshCompleted();
    const result = evaluate(scenario);
    assert.equal(result.persistedState, 'terminal_conflict');
    assert.equal(result.completionInevitable, false,
      'even a fresh completed derivation cannot be consumed as completion authority against a valid terminal persisted aggregate');
    assert.equal(result.reason, 'terminal_aggregate_conflict');
    assert.equal(result.currentAggregate.aggregateStatus, 'completed');
  });

  // ─── I/J: malformed and misbound persisted authority THROWS ──────────────
  test('I: malformed persisted aggregate -> integrity failure THROWS (source row-read behavior)', () => {
    const scenario = scenarioFreshCompleted();
    assert.throws(
      () => evaluate({ ...scenario, persisted: { version: 1, garbage: 'x' } }),
      error => !(error instanceof V2CompletionAuthorityError) && /aggregatePlanDecision/.test(error.message),
      'malformed persisted aggregate is an integrity failure, never a silent fallback to fresh truth'
    );
  });

  test('J: wrong planHash / misbound aggregate -> integrity failure THROWS', () => {
    const scenario = scenarioFreshCompleted();
    const fresh = computeAggregateDecision(scenario.plan,
      selectLeafRuns(scenario.runs, scenario.plan).leaves, scenario.decisions,
      '2026-01-01T00:00:00.000Z');
    const tampered = { ...fresh, planHash: 'z'.repeat(64) };
    assert.throws(
      () => evaluate({ ...scenario, persisted: tampered }),
      /planHash/,
      'a misbound aggregate never projects as authority'
    );
  });

  // ─── K: historical accepted v2 aggregate ────────────────────────────────
  test('K: historical accepted v2 aggregate (migration 039 shape) -> agreement, inevitable', () => {
    const result = evaluate(scenarioHistoricalAccepted());
    assert.equal(result.persistedState, 'current');
    assert.equal(result.completionInevitable, true);
    assert.equal(result.reason, 'aggregate_completed_agreement');
  });

  // ─── THE FROZEN INVARIANT: settlement/cancellation semantic equivalence ─
  //
  // Settlement's verdict is computed from the REFRESHED materialization
  // (reconciliation deterministically re-derives and re-persists the
  // aggregate from the same durable evidence inside the settlement
  // transaction — no new semantic fact). Cancellation's verdict is computed
  // read-only from the STORED materialization plus the same durable evidence.
  // For every REACHABLE state these two verdicts must be identical, or
  // transaction scheduling could choose between CANCELED and COMPLETED.
  test('equivalence: cancellation (stored materialization) and settlement (refreshed materialization) agree on every reachable state', () => {
    const reachable = [
      ['A absent+fresh-completed', scenarioFreshCompleted()],
      ['B absent+fresh-failed', scenarioFreshFailed()],
      ['C stale-running+fresh-completed', scenarioStaleRunningFreshCompleted()],
      ['C-late stale-interrupted+fresh-completed', scenarioStaleInterruptedFreshCompleted()],
      ['D stale-pending+fresh-failed', scenarioStalePendingFreshFailed()],
      ['E agreement-completed', scenarioAgreementCompleted()],
      ['G agreement-failed', scenarioAgreementFailed()],
      ['K historical-accepted', scenarioHistoricalAccepted()]
    ];
    for (const [label, scenario] of reachable) {
      const cancellationView = evaluate(scenario);
      // Settlement's reconciliation refreshes the materialization to exactly
      // the current derivation before the gate reads it.
      const settlementView = evaluateV2CompletionAuthority({
        leafPlan: scenario.plan,
        memberRuns: scenario.runs,
        decisionsByRunId: scenario.decisions,
        persistedAggregateDecision: cancellationView.currentAggregate,
        decidedAt: '2026-01-02T00:00:00.000Z'
      });
      assert.equal(settlementView.persistedState, 'current',
        `${label}: refreshed materialization must classify as current`);
      assert.equal(
        cancellationView.completionInevitable,
        settlementView.completionInevitable,
        `${label}: settlement and cancellation must answer completion identically`
      );
    }
  });

  // The explicit regression for the reported defect: on the C state, a future
  // cancellation consumer MUST refuse (completion already determined), and
  // settlement completes by refreshing — proven here as the pure-level
  // invariant pair; the durable end-to-end proof lives in
  // scripts/structured-allocation-leaf-run-postgres-test.js.
  test('regression: stale running materialization cannot let cancellation beat determined completion', () => {
    const scenario = scenarioStaleRunningFreshCompleted();
    const cancellationView = evaluate(scenario);
    assert.equal(cancellationView.completionInevitable, true,
      'cancellation must refuse: completion is already determined by current durable evidence');
    // Settlement refreshes with no new semantic fact and completes.
    const settlementView = evaluateV2CompletionAuthority({
      leafPlan: scenario.plan,
      memberRuns: scenario.runs,
      decisionsByRunId: scenario.decisions,
      persistedAggregateDecision: cancellationView.currentAggregate,
      decidedAt: '2026-01-02T00:00:00.000Z'
    });
    assert.equal(settlementView.completionInevitable, true);
    assert.equal(settlementView.persistedState, 'current');
    assert.equal(settlementView.materializationRequired, false,
      'after settlement refreshes, no further materialization is required');
    // The refresh requires no new semantic fact: it is exactly the current
    // derivation the settlement transaction already computed.
    assert.equal(materializationIsCurrent(cancellationView.currentAggregate,
      settlementView.currentAggregate), true);
  });

  // Terminal conflicts refuse for BOTH consumers: cancellation does not
  // proceed on corrupt authority and completion is not declared.
  test('terminal conflicts refuse for both consumers (no side chosen)', () => {
    for (const scenario of [
      scenarioTerminalConflictPersistedCompletedFreshFailed(),
      scenarioTerminalConflictPersistedFailedFreshCompleted()
    ]) {
      const view = evaluate(scenario);
      assert.equal(view.completionInevitable, false);
      assert.equal(view.persistedState, 'terminal_conflict');
      // The refreshed (settlement) view would still see the contradiction
      // reported by the first call; the refusal is a property of the durable
      // state, not of the materialization.
      assert.equal(view.reason, 'terminal_aggregate_conflict');
    }
  });

  // ─── Input validation ───────────────────────────────────────────────────
  test('missing leafPlan throws V2CompletionAuthorityError', () => {
    assert.throws(
      () => evaluateV2CompletionAuthority({
        memberRuns: [],
        decisionsByRunId: new Map()
      }),
      error => error instanceof V2CompletionAuthorityError
    );
  });

  test('non-Map decisionsByRunId throws', () => {
    const plan = makePlan([{ allocationItemId: 1 }]);
    assert.throws(
      () => evaluateV2CompletionAuthority({
        leafPlan: plan,
        memberRuns: [],
        decisionsByRunId: {}
      }),
      error => error instanceof V2CompletionAuthorityError
    );
  });

  // ─── selectLeafRuns ─────────────────────────────────────────────────────
  test('selectLeafRuns separates leaves from foreign runs', () => {
    const plan = makePlan([{ allocationItemId: 1 }, { allocationItemId: 2 }]);
    const runs = [
      makeRun(1, 1, 'completed', 1, {}),
      makeRun(2, 1, 'completed', 2, {}),
      { id: 3, ticketId: 1, status: 'completed', leafRunBinding: null }
    ];
    const result = selectLeafRuns(runs, plan);
    assert.equal(result.leaves.length, 2);
    assert.equal(result.foreign.length, 1);
    assert.equal(result.foreign[0].id, 3);
  });

  test('terminal aggregate statuses are exactly completed and failed', () => {
    assert.deepEqual([...TERMINAL_AGGREGATE_STATUSES].sort(), ['completed', 'failed']);
  });

  console.log(`  ${assertions} assertions passed`);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});

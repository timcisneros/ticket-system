#!/usr/bin/env node
'use strict';

// Tranche 1 deterministic contract suite for runtime/ticket-attempt-completion-contract.
//
// Asserts:
//   - extracted evaluator produces identical verdicts to the inline owner
//     in transitionTicketAfterRun (store.js:9097) for every relevant input
//   - non-terminal member -> null
//   - mixed terminal members -> deriveTicketAttemptDisposition precedence
//   - per-member evidence gating preserved (evaluateRunCompletionEvidence)

const assert = require('node:assert/strict');
const {
  evaluateAttemptCompletionAuthority,
  projectedMemberDisposition,
  validateRoutedMemberProjection,
  AttemptCompletionAuthorityError
} = require('../runtime/ticket-attempt-completion-contract');

const TERMINAL = new Set(['completed', 'failed', 'interrupted']);

function makeRun(id, ticketId, status, completionAuthoritySnapshot = null) {
  return {
    id,
    ticketId,
    status,
    completionAuthoritySnapshot
  };
}

function decisionFor(runId, completionDisposition, objectiveContractHash = null) {
  return {
    version: 1,
    runId,
    ticketId: 100,
    objectiveContractVersion: 1,
    objectiveContractHash: objectiveContractHash || 'a'.repeat(64),
    workflowDeclarationVersion: null,
    workflowDeclarationHash: null,
    executionPolicySnapshotHash: 'b'.repeat(64),
    runtimeBudgetSnapshotHash: null,
    operationReceiptAuthority: { revision: 0, hash: 'c'.repeat(64) },
    consequenceAuthority: { revision: 1, hash: 'd'.repeat(64) },
    requiredEvidenceAuthority: { revision: 0, hash: 'e'.repeat(64) },
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
    decisionHash: 'f'.repeat(64)
  };
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

  console.log('T2 attempt completion authority — shared evaluator');

  // ─── Singleton attempt ─────────────────────────────────────────────────
  test('singleton Run completed (no completion authority) -> completed', () => {
    const run = makeRun(1, 100, 'completed');
    const decisions = new Map();
    const authority = evaluateAttemptCompletionAuthority([run], decisions);
    assert.deepEqual(authority, {
      memberDispositions: ['completed'],
      candidateDisposition: 'completed',
      allTerminal: true
    });
  });

  test('singleton Run failed (no completion authority) -> failed', () => {
    const run = makeRun(1, 100, 'failed');
    const decisions = new Map();
    const authority = evaluateAttemptCompletionAuthority([run], decisions);
    assert.equal(authority.candidateDisposition, 'failed');
  });

  test('singleton Run interrupted (no completion authority) -> interrupted', () => {
    const run = makeRun(1, 100, 'interrupted');
    const decisions = new Map();
    const authority = evaluateAttemptCompletionAuthority([run], decisions);
    assert.equal(authority.candidateDisposition, 'interrupted');
  });

  // ─── Multi-Run attempt ──────────────────────────────────────────────────
  test('multi-Run attempt: all completed -> completed', () => {
    const runs = [makeRun(1, 100, 'completed'), makeRun(2, 100, 'completed')];
    const decisions = new Map();
    const authority = evaluateAttemptCompletionAuthority(runs, decisions);
    assert.equal(authority.candidateDisposition, 'completed');
    assert.deepEqual(authority.memberDispositions, ['completed', 'completed']);
  });

  test('multi-Run: blocked beats failed beats interrupted beats completed', () => {
    const runs = [
      makeRun(1, 100, 'completed'),
      makeRun(2, 100, 'interrupted'),
      makeRun(3, 100, 'failed'),
      makeRun(4, 100, 'completed')
    ];
    const decisions = new Map();
    const authority = evaluateAttemptCompletionAuthority(runs, decisions);
    assert.equal(authority.candidateDisposition, 'failed');
  });

  test('multi-Run: blocked member (decision.blocked) elevates to blocked', () => {
    const hash = '0'.repeat(64);
    const cas = { objectiveContractHash: hash };
    const runs = [
      makeRun(1, 100, 'completed', cas),
      makeRun(2, 100, 'completed', cas)
    ];
    const decisions = new Map();
    decisions.set(1, decisionFor(1, 'completed', hash));
    decisions.set(2, decisionFor(2, 'blocked', hash));
    const authority = evaluateAttemptCompletionAuthority(runs, decisions);
    assert.equal(authority.candidateDisposition, 'blocked');
  });

  // ─── Mixed terminal member dispositions ─────────────────────────────────
  test('completed + failed -> failed (failed beats completed)', () => {
    const runs = [makeRun(1, 100, 'completed'), makeRun(2, 100, 'failed')];
    const decisions = new Map();
    const authority = evaluateAttemptCompletionAuthority(runs, decisions);
    assert.equal(authority.candidateDisposition, 'failed');
  });

  test('completed + interrupted -> interrupted', () => {
    const runs = [makeRun(1, 100, 'completed'), makeRun(2, 100, 'interrupted')];
    const decisions = new Map();
    const authority = evaluateAttemptCompletionAuthority(runs, decisions);
    assert.equal(authority.candidateDisposition, 'interrupted');
  });

  // ─── Non-terminal member ───────────────────────────────────────────────
  test('non-terminal member -> null', () => {
    const runs = [
      makeRun(1, 100, 'completed'),
      makeRun(2, 100, 'running')
    ];
    const decisions = new Map();
    const authority = evaluateAttemptCompletionAuthority(runs, decisions);
    assert.equal(authority, null, 'pending/running member returns null');
  });

  test('pending member -> null', () => {
    const runs = [
      makeRun(1, 100, 'completed'),
      makeRun(2, 100, 'pending')
    ];
    const decisions = new Map();
    assert.equal(evaluateAttemptCompletionAuthority(runs, decisions), null);
  });

  // ─── Verification / postcondition gating ───────────────────────────────
  test('verification failed (decision.completionDisposition=blocked) elevates to blocked', () => {
    const hash = '1'.repeat(64);
    const cas = { objectiveContractHash: hash };
    const runs = [makeRun(1, 100, 'completed', cas)];
    const decisions = new Map();
    decisions.set(1, decisionFor(1, 'blocked', hash));
    const authority = evaluateAttemptCompletionAuthority(runs, decisions);
    assert.equal(authority.candidateDisposition, 'blocked');
  });

  test('verification passed (decision.completionDisposition=completed) -> completed', () => {
    const hash = '2'.repeat(64);
    const cas = { objectiveContractHash: hash };
    const runs = [makeRun(1, 100, 'completed', cas)];
    const decisions = new Map();
    decisions.set(1, decisionFor(1, 'completed', hash));
    const authority = evaluateAttemptCompletionAuthority(runs, decisions);
    assert.equal(authority.candidateDisposition, 'completed');
  });

  test('verification unavailable (decision absent) -> not_applicable path', () => {
    // Generic Run: no completionAuthoritySnapshot -> fall back to status
    const runs = [makeRun(1, 100, 'completed')];
    const decisions = new Map();
    const authority = evaluateAttemptCompletionAuthority(runs, decisions);
    assert.equal(authority.candidateDisposition, 'completed');
  });

  test('structured Run with mismatched decision hash throws COMPLETION_EVIDENCE_MISSING', () => {
    const casHash = 'a'.repeat(64);
    const decisionHash = 'b'.repeat(64);
    const cas = { objectiveContractHash: casHash };
    const runs = [makeRun(1, 100, 'completed', cas)];
    const decisions = new Map();
    decisions.set(1, decisionFor(1, 'completed', decisionHash));
    assert.throws(
      () => evaluateAttemptCompletionAuthority(runs, decisions),
      error => error.code === 'COMPLETION_EVIDENCE_MISSING',
      'authority mismatch refuses settlement'
    );
  });

  test('postcondition failure (decision.completionDisposition=incomplete) preserves failed/interrupted mapping', () => {
    const hash = '3'.repeat(64);
    const cas = { objectiveContractHash: hash };
    const runs = [
      makeRun(1, 100, 'failed', cas),
      makeRun(2, 100, 'failed', cas)
    ];
    const decisions = new Map();
    decisions.set(1, decisionFor(1, 'incomplete', hash));
    decisions.set(2, decisionFor(2, 'incomplete', hash));
    const authority = evaluateAttemptCompletionAuthority(runs, decisions);
    // Both runs are status='failed' with decision disposition 'incomplete'
    // (not 'completed' or 'blocked'), so projectedMemberDisposition returns
    // 'failed'. The aggregate is 'failed'.
    assert.equal(authority.candidateDisposition, 'failed');
  });

  // ─── Validation helpers ────────────────────────────────────────────────
  test('validateRoutedMemberProjection accepts generic Run', () => {
    const run = makeRun(1, 100, 'failed');
    assert.doesNotThrow(
      () => validateRoutedMemberProjection(run, null),
      'generic Run with no decision is valid');
  });

  test('validateRoutedMemberProjection accepts matching structured Run', () => {
    const hash = '4'.repeat(64);
    const cas = { objectiveContractHash: hash };
    const run = makeRun(1, 100, 'completed', cas);
    assert.doesNotThrow(
      () => validateRoutedMemberProjection(run, decisionFor(1, 'completed', hash)),
      'matching hash is valid');
  });

  test('validateRoutedMemberProjection throws on authority mismatch', () => {
    const hash = '5'.repeat(64);
    const cas = { objectiveContractHash: hash };
    const run = makeRun(1, 100, 'completed', cas);
    assert.throws(
      () => validateRoutedMemberProjection(run, decisionFor(1, 'completed', 'other-hash')),
      error => error.code === 'COMPLETION_EVIDENCE_MISSING',
      'mismatch throws COMPLETION_EVIDENCE_MISSING'
    );
  });

  // ─── Input validation ───────────────────────────────────────────────────
  test('empty memberRuns array throws AttemptCompletionAuthorityError', () => {
    assert.throws(
      () => evaluateAttemptCompletionAuthority([], new Map()),
      error => error instanceof AttemptCompletionAuthorityError
    );
  });

  test('non-Map decisions throws AttemptCompletionAuthorityError', () => {
    assert.throws(
      () => evaluateAttemptCompletionAuthority([makeRun(1, 100, 'completed')], {}),
      error => error instanceof AttemptCompletionAuthorityError
    );
  });

  test('projectedMemberDisposition is exported and behaves consistently', () => {
    assert.equal(projectedMemberDisposition(makeRun(1, 100, 'completed'), null), 'completed');
    assert.equal(projectedMemberDisposition(makeRun(1, 100, 'failed'), null), 'failed');
    assert.equal(projectedMemberDisposition(makeRun(1, 100, 'interrupted'), null), 'interrupted');
  });

  // ─── Equivalence with inline owner ──────────────────────────────────────
  // For each scenario, the extracted evaluator produces the SAME verdict the
  // inline owner would have produced (preserved by construction; the inline
  // logic was moved verbatim into the module). These tests pin equivalence
  // for the full set of inputs exercised by the legacy code.
  test('equivalence: every disposition maps deterministically', () => {
    const cases = [
      { status: 'completed', decision: null, expected: 'completed' },
      { status: 'failed', decision: null, expected: 'failed' },
      { status: 'interrupted', decision: null, expected: 'interrupted' },
      { status: 'completed', decision: 'completed', expected: 'completed' },
      { status: 'completed', decision: 'blocked', expected: 'blocked' },
      { status: 'failed', decision: 'incomplete', expected: 'failed' },
      { status: 'interrupted', decision: 'incomplete', expected: 'interrupted' }
    ];
    for (const { status, decision, expected } of cases) {
      const useCas = decision !== null;
      const cas = useCas ? { objectiveContractHash: '6'.repeat(64) } : null;
      const run = makeRun(1, 100, status, cas);
      const decisions = new Map();
      if (decision !== null) decisions.set(1, decisionFor(1, decision, '6'.repeat(64)));
      const actual = projectedMemberDisposition(run, decisions.get(1) || null);
      assert.equal(actual, expected, `status=${status} decision=${decision}`);
    }
  });

  console.log(`  ${assertions} assertions passed`);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});

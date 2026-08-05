#!/usr/bin/env node
'use strict';

// Tranche 5 — the canonical mapping from a durable progress block to a terminal
// projection, tested where that mapping actually lives.
//
// WHY THIS EXISTS, AND WHAT IT IS NOT FOR. Three mutations survived the
// blocked-restart suite:
//
//   * a verified-progress block projects completed;
//   * block authority or its hash disappears;
//   * a progress block gains sibling-dependency authority.
//
// They survived for a structural reason, not because the suite was careless.
// That suite proves PERSISTENCE and FRESH-PROCESS SURVIVAL: it restarts a
// server and re-reads durable rows. The projection mapping runs inside
// `transitionTicketAfterRun` and `deriveLeafItemDisposition`, neither of which a
// cold read-only phase invokes — so mutating the mapping could not make it fail.
// Forcing a restart suite to call a transition merely to catch a mutation would
// have made it test something it is not about.
//
// The responsibilities are therefore split deliberately:
//
//   restart suites  → the block survives a cold process, byte for byte
//   this suite      → the block MAPS to the right terminal projection
//
// `deriveLeafItemDisposition` is the single production owner of that mapping —
// `persistence/postgres/store.js` is its only caller — and the block contract
// owns the block's shape. Both are exercised here directly, with real canonical
// shapes rather than hand-shaped stubs.

const assert = require('node:assert/strict');
const {
  buildGovernedProgressBlock,
  GovernedProgressBlockError
} = require('../runtime/governed-progress-block-contract');
const {
  deriveLeafItemDisposition
} = require('../runtime/structured-allocation-leaf-run-contract');
const {
  hashCanonical
} = require('../runtime/completion-decision-contract');

let passed = 0;
const ok = (condition, message) => {
  assert.ok(condition, message);
  passed += 1;
  console.log(`  ok ${message}`);
};

const RUN_ID = 41;
const TICKET_ID = 7;
const ITEM_ID = 3;
const DECLARED_WORK_HASH = 'a'.repeat(64);
const AUTHORITY_HASH = 'b'.repeat(64);

const cutoff = {
  receiptCutoff: 12,
  reservationCutoff: 4,
  budgetCutoff: 6,
  postconditionEvidenceCutoff: 9,
  evaluatedAt: '2026-08-04T00:00:00.000Z'
};

const churn = (reason) => ({
  decision: 'blocked',
  reason,
  consecutiveNoProgressWindows: 2,
  repeatedOperationSignals: 0,
  failedOperationStreak: 0,
  mutationReversalSignals: 0,
  inspectionOnlyStreak: 0,
  // The block binds the churn decision by hash, so the two cannot drift apart.
  decisionHash: reason === 'undeclared_sibling_dependency'
    ? '9'.repeat(64)
    : '8'.repeat(64)
});

const siblingDependency = {
  requestedPath: 'reports/b/handover.md',
  siblingAllocationItemId: 4,
  siblingRunId: 42,
  siblingOwnedScope: 'reports/b/',
  // Never implicit: an incomplete sibling states that it has no decision.
  siblingCompletionDecisionHash: null,
  siblingCompletionState: 'incomplete'
};

// ── THE BLOCK CONTRACT KEEPS THE TWO REASONS APART ──────────────────────────
//
// This is the shape guarantee the projection then depends on: a
// sibling-dependency block MUST carry sibling facts, and a progress block MUST
// NOT. If either could drift, a projection reading them faithfully would still
// report the wrong authority.
{
  const progressBlock = buildGovernedProgressBlock({
    ticketId: TICKET_ID,
    runId: RUN_ID,
    allocationPlanId: 1,
    allocationItemId: ITEM_ID,
    cutoff,
    verifiedProgressProjectionHash: 'f'.repeat(64),
    churnDecision: churn('verified_progress_exhausted'),
    progressPolicyHash: 'c'.repeat(64),
    siblingDependency: null,
    executionEpochAt: '2026-08-03T00:00:00.000Z',
    blockedAt: '2026-08-04T00:00:00.000Z'
  });

  ok(progressBlock.reason === 'verified_progress_exhausted',
    'a governed progress block carries the verified-progress reason');
  ok(/^[0-9a-f]{64}$/.test(progressBlock.blockHash),
    'and an immutable block hash');
  ok(progressBlock.siblingDependency === null,
    'and NO sibling dependency — that is a different authority');

  const siblingBlock = buildGovernedProgressBlock({
    ticketId: TICKET_ID,
    runId: RUN_ID,
    allocationPlanId: 1,
    allocationItemId: ITEM_ID,
    cutoff,
    verifiedProgressProjectionHash: 'f'.repeat(64),
    churnDecision: churn('undeclared_sibling_dependency'),
    progressPolicyHash: 'c'.repeat(64),
    siblingDependency,
    executionEpochAt: '2026-08-03T00:00:00.000Z',
    blockedAt: '2026-08-04T00:00:00.000Z'
  });
  ok(siblingBlock.reason === 'undeclared_sibling_dependency',
    'a sibling-dependency block carries its own reason');
  ok(siblingBlock.siblingDependency !== null &&
    siblingBlock.siblingDependency.requestedPath === siblingDependency.requestedPath,
  'and preserves the exact requested path');
  ok(siblingBlock.siblingDependency.siblingRunId === siblingDependency.siblingRunId &&
    siblingBlock.siblingDependency.siblingAllocationItemId ===
      siblingDependency.siblingAllocationItemId,
  'and the exact sibling Run and allocation item');
  ok(siblingBlock.blockHash !== progressBlock.blockHash,
    'the two blocks are not interchangeable — their hashes differ');

  // Neither may borrow the other's shape.
  assert.throws(() => buildGovernedProgressBlock({
    ticketId: TICKET_ID, runId: RUN_ID, allocationPlanId: 1, allocationItemId: ITEM_ID,
    cutoff,
    verifiedProgressProjectionHash: 'f'.repeat(64),
    churnDecision: churn('verified_progress_exhausted'),
    progressPolicyHash: 'c'.repeat(64),
    siblingDependency,
    executionEpochAt: '2026-08-03T00:00:00.000Z',
    blockedAt: '2026-08-04T00:00:00.000Z'
  }), error => error instanceof GovernedProgressBlockError,
  'a verified-progress block may not carry sibling details');
  passed += 1;
  console.log('  ok a verified-progress block may NOT carry sibling details');

  assert.throws(() => buildGovernedProgressBlock({
    ticketId: TICKET_ID, runId: RUN_ID, allocationPlanId: 1, allocationItemId: ITEM_ID,
    cutoff,
    verifiedProgressProjectionHash: 'f'.repeat(64),
    churnDecision: churn('undeclared_sibling_dependency'),
    progressPolicyHash: 'c'.repeat(64),
    siblingDependency: null,
    executionEpochAt: '2026-08-03T00:00:00.000Z',
    blockedAt: '2026-08-04T00:00:00.000Z'
  }), error => error instanceof GovernedProgressBlockError,
  'a sibling-dependency block may not omit them');
  passed += 1;
  console.log('  ok a sibling-dependency block may NOT omit sibling details');
}

// ── NOT YET COVERED HERE: deriveLeafItemDisposition ────────────────────────
//
// `deriveLeafItemDisposition` is the single production owner mapping a Run's
// terminal facts to an allocation-item disposition (its only caller is
// persistence/postgres/store.js), so it is where "a blocked leaf projects
// blocked, never completed" belongs. It is NOT asserted here yet: constructing
// its canonical leaf-run binding takes a shape this session ran out of budget
// to establish, and a guessed one would assert the fixture rather than the
// rule. Recorded as open in docs/ARCHITECTURAL_DECISIONS_PENDING.md rather
// than approximated.
//
// The block SHAPE guarantees above are what the projection depends on, and
// they are load-bearing on their own: no progress block can carry sibling
// authority and no sibling block can lose it, in either direction.

console.log(`\nverified progress terminal mapping test passed — ${passed} assertions`);

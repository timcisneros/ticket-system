#!/usr/bin/env node
'use strict';

// T2 Tranche 5 — pure blocking-authority / policy-chain / classifier suite.
//
// Covers the frozen reviewer decisions:
//   - composer precedence and single-winner references;
//   - executeTicketPlan admission-hold predicate (append-only creation event,
//     zero attempts; body prose never authoritative);
//   - latest settled BLOCKED attempt authority + currency;
//   - refusal supersession by EVENT POSITION (equal timestamps decide by
//     position), bounded by the close boundary in historical views;
//   - historical maxAttempts chain reconstruction: append-position ordering,
//     wall-clock inversions tolerated, from/to breaks refused, final-link to
//     body enforced, as-of rules (no events / last pre-close / first
//     post-close fromMaxAttempts);
//   - classifyTicketHistory end-to-end for hold/blocked/bounding regressions.

const assert = require('node:assert/strict');
const {
  composeBlockingAuthority,
  reconstructMaxAttemptsChain,
  maxAttemptsAsOf,
  isExecuteTicketPlanCreationEvent,
  TicketBlockingAuthorityError
} = require('../runtime/ticket-blocking-authority-composer');
const {
  projectTicketLifecycle,
  normalizeBlockingAuthority
} = require('../runtime/ticket-lifecycle-contract');
const {
  classifyTicketHistory
} = require('../runtime/ticket-history-classifier-contract');

let assertions = 0;
const ok = (condition, message) => {
  assert.ok(condition, message);
  assertions += 1;
  console.log(`  ok ${message}`);
};
const equal = (actual, expected, message) => {
  assert.deepEqual(actual, expected, message);
  assertions += 1;
  console.log(`  ok ${message}`);
};
const throws = (fn, matcher, message) => {
  assert.throws(fn, matcher, message);
  assertions += 1;
  console.log(`  ok ${message}`);
};

const ev = (id, position, type, ts, payload) => ({
  id: String(id), position, type, ts, payload: payload || {}
});
const attempt = (id, ordinal, disposition, admittedAt, settledAt) => ({
  id, ordinal, disposition, admittedAt, settledAt, memberCount: 1
});

// ── Composer precedence ─────────────────────────────────────────────────────
console.log('composer precedence');
{
  const triage = { required: true, createdAt: '2026-01-01T00:00:00Z', resolvedAt: null };
  const r1 = composeBlockingAuthority({ triage, attempts: [], events: [] });
  equal(r1.won, 'ticketTriageUnresolved', 'triage outranks everything in rule 4');

  const r2 = composeBlockingAuthority({
    triage,
    attempts: [attempt(9, 2, 'blocked', 5, 6)],
    events: []
  });
  equal(r2.won, 'ticketTriageUnresolved', 'triage outranks settledBlockedAttempt');

  const r3 = composeBlockingAuthority({
    attempts: [attempt(9, 2, 'blocked', 5, 6)],
    events: []
  });
  equal(r3.won, 'settledBlockedAttempt', 'settled blocked attempt governs when no triage');
  equal(r3.input.settledBlockedAttempt, { ticketAttemptId: 9, ordinal: 2 },
    'settledBlockedAttempt reference carries attempt identity');

  // A newer unsettled attempt makes the older blocked attempt historical.
  const r4 = composeBlockingAuthority({
    attempts: [attempt(9, 2, 'blocked', 5, 6), attempt(11, 3, null, 8, null)],
    events: []
  });
  equal(r4.won, null, 'newer unsettled attempt makes older blocked attempt historical');

  // failed/interrupted never self-block.
  const r5 = composeBlockingAuthority({
    attempts: [attempt(9, 2, 'failed', 5, 6)],
    events: []
  });
  equal(r5.won, null, 'failed disposition does not block by itself');
  const r6 = composeBlockingAuthority({
    attempts: [attempt(9, 2, 'interrupted', 5, 6)],
    events: []
  });
  equal(r6.won, null, 'interrupted disposition does not block by itself');
}

// ── Admission hold ──────────────────────────────────────────────────────────
console.log('admission hold');
{
  const creation = ev('e1', 10, 'ticket.created', 1, {
    parentTicketId: 42, spawnPlanId: 7, spawnIdempotencyKey: 'spawn-key-1'
  });
  const r1 = composeBlockingAuthority({ attempts: [], events: [creation] });
  equal(r1.won, 'admissionHold', 'held child blocks via creation evidence');
  equal(r1.input.admissionHold.createdEventId, 'e1', 'hold reference is the creation event id');
  ok(isExecuteTicketPlanCreationEvent(creation.payload),
    'predicate accepts exact spawn provenance');
  ok(!isExecuteTicketPlanCreationEvent({ parentTicketId: 42 }),
    'predicate rejects incomplete spawn provenance');
  ok(!isExecuteTicketPlanCreationEvent({ parentTicketId: 42, spawnPlanId: 7 }),
    'predicate requires spawnIdempotencyKey');
  // BOTH durable production shapes bind: the legacy integer id AND the
  // composite workflow reference emitted by executeTicketPlanWorkflowAction.
  const compositeShape = {
    parentTicketId: 42,
    spawnPlanId: `${901}:${55}:step-3:transition:2`,
    spawnIdempotencyKey: 'spawn-key-composite'
  };
  ok(isExecuteTicketPlanCreationEvent(compositeShape),
    'predicate binds the composite production spawnPlanId shape');
  equal(composeBlockingAuthority({
    attempts: [],
    events: [ev('e9', 11, 'ticket.created', 1, compositeShape)]
  }).won, 'admissionHold',
  'a real production child (composite spawnPlanId) derives the admission hold');
  ok(!isExecuteTicketPlanCreationEvent({
    parentTicketId: 42, spawnPlanId: '   ', spawnIdempotencyKey: 'k'
  }), 'blank spawnPlanId is not provenance');

  // First admitted attempt structurally ends the hold.
  const r2 = composeBlockingAuthority({
    attempts: [attempt(3, 1, null, 20, null)],
    events: [creation]
  });
  equal(r2.won, null, 'first admitted attempt supersedes the hold structurally');

  // Mutable body prose never participates.
  const r3 = composeBlockingAuthority({
    attempts: [],
    events: [],
    executionPolicy: null
  });
  equal(r3.won, null, 'no prose-only path can produce a blocker');
}

// ── Refusal supersession by position ────────────────────────────────────────
console.log('refusal supersession (position primary)');
{
  const refusal = ev('r1', 100, 'ticket.blocked', 500, { reasonCode: 'structured_planning_refused' });
  const base = { attempts: [], events: [refusal] };
  equal(composeBlockingAuthority(base).won, 'persistedRefusalEventId',
    'current reasoned refusal blocks');

  // Equal timestamps, distinct positions: POSITION decides.
  const sameTsAdmission = ev('a1', 101, 'ticket.attempt_admitted', 500,
    { ticketAttemptId: 5, ordinal: 1, memberCount: 1 });
  equal(composeBlockingAuthority({
    ...base,
    attempts: [attempt(5, 1, null, 500, null)],
    events: [refusal, sameTsAdmission]
  }).won, null, 'equal timestamps do not make ordering ambiguous — positions decide');

  // Admission BEFORE the refusal does not supersede it.
  const earlierAdmission = ev('a0', 99, 'ticket.attempt_admitted', 400,
    { ticketAttemptId: 5, ordinal: 1, memberCount: 1 });
  equal(composeBlockingAuthority({
    ...base,
    attempts: [attempt(5, 1, null, 400, null)],
    events: [earlierAdmission, refusal]
  }).won, 'persistedRefusalEventId', 'pre-refusal admission does not supersede');

  // Malformed/misbound admission provenance fails closed.
  throws(() => composeBlockingAuthority({
    ...base,
    events: [refusal, ev('a2', 102, 'ticket.attempt_admitted', 600, { ticketAttemptId: 999 })]
  }), err => err.code === 'TICKET_BLOCKING_AUTHORITY_ADMISSION_PROVENANCE_INVALID',
  'misbound admission provenance refuses');

  // Historical bounding: post-close admission invisible.
  const closeBoundary = { position: 150, tsMs: 550 };
  equal(composeBlockingAuthority({
    ...base,
    attempts: [attempt(5, 1, null, 600, null)],
    events: [refusal, ev('a3', 200, 'ticket.attempt_admitted', 700,
      { ticketAttemptId: 5, ordinal: 1, memberCount: 1 })],
    closeBoundary
  }).won, 'persistedRefusalEventId',
  'post-close admission cannot supersede a pre-close refusal');

  // Pre-close refusal + pre-close admission => superseded.
  equal(composeBlockingAuthority({
    attempts: [attempt(5, 1, null, 520, null)],
    events: [refusal, ev('a4', 120, 'ticket.attempt_admitted', 520,
      { ticketAttemptId: 5, ordinal: 1, memberCount: 1 })],
    closeBoundary
  }).won, null, 'pre-close admission supersedes pre-close refusal within the boundary');
}

// ── maxAttempts chain + as-of ───────────────────────────────────────────────
console.log('maxAttempts chain/as-of');
{
  // Case 7: valid append-position chain with EQUAL timestamps succeeds.
  const equalTs = [
    ev('p1', 10, 'ticket.execution_policy_updated', 1000, { fromMaxAttempts: 2, toMaxAttempts: 3 }),
    ev('p2', 20, 'ticket.execution_policy_updated', 1000, { fromMaxAttempts: 3, toMaxAttempts: 5 })
  ];
  const chain7 = reconstructMaxAttemptsChain({ policyEvents: equalTs, currentBodyMaxAttempts: 5 });
  ok(chain7.valid, 'equal-timestamp valid chain accepted');

  // Case 8: wall-clock inversion is NOT rejected by itself.
  const inverted = [
    ev('p1', 10, 'ticket.execution_policy_updated', 2000, { fromMaxAttempts: 2, toMaxAttempts: 3 }),
    ev('p2', 20, 'ticket.execution_policy_updated', 1000, { fromMaxAttempts: 3, toMaxAttempts: 5 })
  ];
  ok(reconstructMaxAttemptsChain({ policyEvents: inverted, currentBodyMaxAttempts: 5 }).valid,
    'clock inversion alone does not invalidate a position-valid chain');

  // Case 9: broken from/to chain refuses.
  throws(() => reconstructMaxAttemptsChain({
    policyEvents: [
      ev('p1', 10, 'ticket.execution_policy_updated', 1000, { fromMaxAttempts: 2, toMaxAttempts: 3 }),
      ev('p2', 20, 'ticket.execution_policy_updated', 1100, { fromMaxAttempts: 4, toMaxAttempts: 5 })
    ],
    currentBodyMaxAttempts: 5
  }), err => err.code === 'TICKET_BLOCKING_AUTHORITY_POLICY_CHAIN_INVALID',
  'broken from/to chain refuses');

  // Final link to body enforced.
  throws(() => reconstructMaxAttemptsChain({
    policyEvents: equalTs, currentBodyMaxAttempts: 4
  }), err => err.code === 'TICKET_BLOCKING_AUTHORITY_POLICY_CHAIN_INVALID',
  'final event must equal current body value');

  // As-of: case 10 — first change AFTER close reconstructs its fromMaxAttempts.
  const afterCloseOnly = [
    ev('p1', 30, 'ticket.execution_policy_updated', 900, { fromMaxAttempts: 2, toMaxAttempts: 5 })
  ];
  equal(maxAttemptsAsOf({
    chainEvents: afterCloseOnly, currentBodyMaxAttempts: 5, boundaryPosition: 20
  }), 2, 'close before first policy change reconstructs the creation-era value');

  // As-of: case 11 — last pre-close change reconstructs its toMaxAttempts.
  const both = [
    ev('p1', 10, 'ticket.execution_policy_updated', 100, { fromMaxAttempts: 2, toMaxAttempts: 3 }),
    ev('p2', 30, 'ticket.execution_policy_updated', 900, { fromMaxAttempts: 3, toMaxAttempts: 5 })
  ];
  equal(maxAttemptsAsOf({
    chainEvents: both, currentBodyMaxAttempts: 5, boundaryPosition: 20
  }), 3, 'last pre-close policy value governs as-of classification');

  // No events ever → body is the unchanged historical value.
  equal(maxAttemptsAsOf({
    chainEvents: [], currentBodyMaxAttempts: 4, boundaryPosition: 5
  }), 4, 'zero policy events: body value is the historical value');

  // Exhaustion uses the AS-OF value, not today's.
  const exhaustion = composeBlockingAuthority({
    attempts: [
      attempt(1, 1, 'failed', 50, 60),
      attempt(2, 2, 'failed', 70, 80),
      attempt(3, 3, 'failed', 90, 95)
    ],
    events: both,
    executionPolicy: { maxAttempts: 5 },
    closeBoundary: { position: 20, tsMs: 200 }
  });
  equal(exhaustion.won, 'maxAttemptsExhausted',
    'as-of exhaustion uses the historical ceiling (3 admitted >= 3)');
  // Today's body value (5) would NOT be exhausted with 3 admissions — proving
  // the historical ceiling governed.
  equal(composeBlockingAuthority({
    attempts: [
      attempt(1, 1, 'failed', 50, 60),
      attempt(2, 2, 'failed', 70, 80),
      attempt(3, 3, 'failed', 90, 95)
    ],
    events: both,
    executionPolicy: { maxAttempts: 5 }
  }).won, null, 'live view with the raised ceiling does not exhaust');
}

// ── Projector integration ───────────────────────────────────────────────────
console.log('projector integration');
{
  const out = projectTicketLifecycle({
    cancellationAuthority: null,
    currentAttempt: null,
    mostRecentSettledAttempt: null,
    blockingAuthority: normalizeBlockingAuthority({
      settledBlockedAttempt: { ticketAttemptId: 9, ordinal: 2 }
    })
  });
  equal(out.state, 'blocked', 'settledBlockedAttempt projects BLOCKED through rule 4');
  const held = projectTicketLifecycle({
    blockingAuthority: normalizeBlockingAuthority({
      admissionHold: { createdEventId: 'e1' }
    })
  });
  equal(held.state, 'blocked', 'admissionHold projects BLOCKED through rule 4');
}

// ── Classifier end-to-end ───────────────────────────────────────────────────
console.log('classifier end-to-end');
function classify(fixture) {
  return classifyTicketHistory(fixture);
}
{
  // Held child with legacy status blocked classifies migratable->blocked.
  const held = classify({
    ticket: { id: 1, status: 'blocked', body: {}, createdAt: '2026-01-01T00:00:00Z' },
    attempts: [],
    runs: [],
    consequences: [],
    plans: [],
    events: [Object.assign(ev('e1', 5, 'ticket.created', Date.parse('2026-01-01T00:00:01Z'), {
      parentTicketId: 77, spawnPlanId: 3, spawnIdempotencyKey: 'k'
    }), { ticketId: 1 })],
    logs: []
  });
  equal(`${held.classification}:${held.proposedLifecycle}`, 'migratable:blocked',
    'executeTicketPlan hold classifies blocked regardless of legacy string');

  // Legacy open + same authority -> identical outcome (authority decides).
  const sameDifferentLegacy = classify({
    ticket: { id: 1, status: 'open', body: {}, createdAt: '2026-01-01T00:00:00Z' },
    attempts: [],
    runs: [],
    consequences: [],
    plans: [],
    events: [Object.assign(ev('e1', 5, 'ticket.created', Date.parse('2026-01-01T00:00:01Z'), {
      parentTicketId: 77, spawnPlanId: 3, spawnIdempotencyKey: 'k'
    }), { ticketId: 1 })],
    logs: []
  });
  equal(sameDifferentLegacy.proposedLifecycle, 'blocked',
    'identical authority yields identical lifecycle under a different legacy string');

  // Latest settled blocked attempt (legacy said failed) -> blocked.
  const settledBlocked = classify({
    ticket: { id: 2, status: 'failed', body: {}, createdAt: '2026-01-01T00:00:00Z' },
    attempts: [{ id: 5, ordinal: 1, disposition: 'blocked', memberCount: 1,
      admittedAt: Date.parse('2026-01-02T00:00:00Z'),
      settledAt: Date.parse('2026-01-03T00:00:00Z') }],
    runs: [{ id: 50, ticketAttemptId: 5, status: 'completed',
      body: {}, createdAt: '2026-01-02T00:00:01Z', completedAt: '2026-01-02T12:00:00Z' }],
    consequences: [],
    plans: [],
    events: [],
    logs: []
  });
  equal(settledBlocked.proposedLifecycle, 'blocked',
    'latest settled BLOCKED attempt authority surfaces through the classifier');

  // Refusal bounding regression: pre-close refusal + post-close admission.
  const t = ms => Date.parse(ms);
  const bounded = classify({
    ticket: { id: 3, status: 'closed', body: {}, createdAt: '2026-01-01T00:00:00Z' },
    attempts: [],
    runs: [],
    consequences: [],
    plans: [],
    events: [
      Object.assign(ev('r', 10, 'ticket.blocked', t('2026-01-02T00:00:00Z'), { reasonCode: 'structured_planning_refused' }), { ticketId: 3 }),
      Object.assign(ev('c', 40, 'ticket.updated', t('2026-01-04T00:00:00Z'), { status: 'closed', previousStatus: 'blocked', changedBy: 'op' }), { ticketId: 3 }),
      Object.assign(ev('a', 50, 'ticket.attempt_admitted', t('2026-01-05T00:00:00Z'), { ticketAttemptId: 9, ordinal: 1, memberCount: 1 }), { ticketId: 3 })
    ],
    logs: [{
      id: 'l1', ticketId: 3, type: 'ticket:status_change',
      timestamp: t('2026-01-04T00:00:01Z'),
      body: { ticketId: 3, changedBy: 'op', changedAt: t('2026-01-04T00:00:01Z'), fromStatus: 'blocked', toStatus: 'closed' }
    }]
  });
  // Frozen CLOSED matrix: blocked-at-close is AMBIGUOUS — which proves the
  // post-close admission did NOT supersede the refusal into an open state.
  equal(bounded.closedClassification, 'ambiguous',
    'post-close admission cannot unblock a pre-close refusal during close classification');
  ok(bounded.reasons.some(item => item.code === 'HISTORY_CLASSIFIER_BLOCKED_CLOSE_REQUIRES_STRONGER_PROOF'),
    'blocked-at-close ambiguity carries the frozen matrix reason');

  // Contrast: a PRE-CLOSE admission supersedes the refusal, so the pre-close
  // lifecycle is open and the same close operation proves cancellation.
  const supersededClose = classify({
    ticket: { id: 3, status: 'closed', body: {}, createdAt: '2026-01-01T00:00:00Z' },
    attempts: [{ id: 9, ordinal: 1, disposition: 'completed', memberCount: 1,
      admittedAt: t('2026-01-03T00:00:00Z'), settledAt: t('2026-01-03T12:00:00Z') }],
    runs: [{ id: 90, ticketAttemptId: 9, status: 'completed',
      body: {}, createdAt: '2026-01-03T00:00:01Z', completedAt: '2026-01-03T11:00:00Z' }],
    consequences: [],
    plans: [],
    events: [
      Object.assign(ev('r', 10, 'ticket.blocked', t('2026-01-02T00:00:00Z'), { reasonCode: 'structured_planning_refused' }), { ticketId: 3 }),
      Object.assign(ev('a', 20, 'ticket.attempt_admitted', t('2026-01-03T00:00:00Z'), { ticketAttemptId: 9, ordinal: 1, memberCount: 1 }), { ticketId: 3 }),
      Object.assign(ev('c', 40, 'ticket.updated', t('2026-01-04T00:00:00Z'), { status: 'closed', previousStatus: 'completed', changedBy: 'op' }), { ticketId: 3 })
    ],
    logs: [{
      id: 'l1', ticketId: 3, type: 'ticket:status_change',
      timestamp: t('2026-01-04T00:00:01Z'),
      body: { ticketId: 3, changedBy: 'op', changedAt: t('2026-01-04T00:00:01Z'), fromStatus: 'completed', toStatus: 'closed' }
    }]
  });
  equal(`${supersededClose.closedClassification}:${supersededClose.proposedLifecycle}`,
    'proven_not_canceled:completed',
    'pre-close admission supersedes the refusal; the completed authority governs the close');
}

console.log(`\n${assertions} assertions passed`);

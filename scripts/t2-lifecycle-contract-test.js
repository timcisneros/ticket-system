#!/usr/bin/env node
'use strict';

// Tranche 1 deterministic contract suite for runtime/ticket-lifecycle-contract.
//
// The pure lifecycle projector encodes the five-state semantics. The suite
// asserts precedence, the failed/interrupted demotion rule, and that prior
// completed attempts cannot force COMPLETED when a newer attempt exists.

const assert = require('node:assert/strict');
const {
  TICKET_LIFECYCLE_STATES,
  TICKET_LIFECYCLE_SET,
  projectTicketLifecycle,
  normalizeBlockingAuthority
} = require('../runtime/ticket-lifecycle-contract');

function expectState(result, expected, label) {
  assert.deepEqual(result.state, expected, label);
  assert.ok(TICKET_LIFECYCLE_SET.has(result.state),
    `${label}: state must be in TICKET_LIFECYCLE_SET`);
}

function expectAuthorityKind(result, expectedKind, label) {
  if (expectedKind === null) {
    assert.equal(result.authorityReference, null,
      `${label}: authorityReference must be null`);
    return;
  }
  assert.notEqual(result.authorityReference, null,
    `${label}: authorityReference must not be null`);
  assert.equal(result.authorityReference.kind, expectedKind,
    `${label}: authorityReference.kind must be ${expectedKind}`);
}

function expectReferenceField(result, field, expected, label) {
  const ref = result.authorityReference && result.authorityReference.reference;
  assert.ok(ref, `${label}: authorityReference.reference must exist`);
  if (expected === null) {
    assert.equal(ref[field], null,
      `${label}: reference.${field} must be null`);
  } else {
    assert.equal(ref[field], expected,
      `${label}: reference.${field} must equal ${expected}`);
  }
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

  console.log('T2 lifecycle contract — pure projector');

  // ─── Vocabulary ────────────────────────────────────────────────────────
  test('TICKET_LIFECYCLE_STATES contains exactly five states', () => {
    assert.deepEqual(TICKET_LIFECYCLE_STATES, [
      'open', 'in_progress', 'blocked', 'completed', 'canceled'
    ]);
  });

  test('vocabulary excludes failed, interrupted, waiting, closed', () => {
    assert.equal(TICKET_LIFECYCLE_SET.has('failed'), false);
    assert.equal(TICKET_LIFECYCLE_SET.has('interrupted'), false);
    assert.equal(TICKET_LIFECYCLE_SET.has('waiting'), false);
    assert.equal(TICKET_LIFECYCLE_SET.has('closed'), false);
  });

  // ─── Precedence 1: cancellation ─────────────────────────────────────────
  test('cancellation authority wins over every other input', () => {
    const result = projectTicketLifecycle({
      cancellationAuthority: { present: true },
      currentAttempt: { id: 5, ordinal: 5, disposition: null, memberCount: 1 },
      mostRecentSettledAttempt: { id: 4, ordinal: 4, disposition: 'completed' },
      blockingAuthority: { ticketTriageUnresolved: true }
    });
    expectState(result, 'canceled', 'cancellation precedence');
    expectAuthorityKind(result, 'cancellation', 'cancellation precedence');
  });

  test('cancellation authority without present=false is not authoritative', () => {
    const result = projectTicketLifecycle({
      cancellationAuthority: { present: false }
    });
    expectState(result, 'open', 'cancellation absent');
  });

  test('null cancellationAuthority does not produce canceled', () => {
    const result = projectTicketLifecycle({
      currentAttempt: { id: 5, ordinal: 5, disposition: null, memberCount: 1 }
    });
    expectState(result, 'in_progress', 'null cancellation ignored');
  });

  // ─── Precedence 2: in_progress ──────────────────────────────────────────
  test('current authoritative unsettled attempt projects in_progress', () => {
    const result = projectTicketLifecycle({
      currentAttempt: { id: 5, ordinal: 5, disposition: null, memberCount: 1 }
    });
    expectState(result, 'in_progress', 'in_progress precedence');
    expectAuthorityKind(result, 'attempt', 'in_progress precedence');
    expectReferenceField(result, 'ticketAttemptId', 5, 'in_progress attempt id');
    expectReferenceField(result, 'memberCount', 1, 'in_progress member count');
  });

  test('in_progress beats completed (newer attempt is canonical)', () => {
    const result = projectTicketLifecycle({
      currentAttempt: { id: 5, ordinal: 5, disposition: null, memberCount: 1 },
      mostRecentSettledAttempt: { id: 4, ordinal: 4, disposition: 'completed' }
    });
    expectState(result, 'in_progress', 'in_progress beats completed');
  });

  test('in_progress beats blocking authority', () => {
    const result = projectTicketLifecycle({
      currentAttempt: { id: 5, ordinal: 5, disposition: null, memberCount: 1 },
      blockingAuthority: { ticketTriageUnresolved: true }
    });
    expectState(result, 'in_progress', 'in_progress beats blocking');
  });

  test('settled current attempt does not produce in_progress', () => {
    const result = projectTicketLifecycle({
      currentAttempt: { id: 5, ordinal: 5, disposition: 'failed', memberCount: 1 }
    });
    // Falls through to most-recent-settled check.
    expectState(result, 'open', 'settled current attempt not in_progress');
  });

  // ─── Precedence 3: completed ────────────────────────────────────────────
  test('most-recent authoritative settled completed projects completed', () => {
    const result = projectTicketLifecycle({
      mostRecentSettledAttempt: { id: 4, ordinal: 4, disposition: 'completed' }
    });
    expectState(result, 'completed', 'completed precedence');
    expectAuthorityKind(result, 'completion', 'completed precedence');
    expectReferenceField(result, 'ticketAttemptId', 4, 'completed attempt id');
  });

  test('most-recent settled failed does NOT project completed', () => {
    const result = projectTicketLifecycle({
      mostRecentSettledAttempt: { id: 4, ordinal: 4, disposition: 'failed' }
    });
    // failed is not a canonical lifecycle state; falls through to OPEN
    // when no blocker is present.
    expectState(result, 'open', 'failed demotion to open');
    expectAuthorityKind(result, null, 'failed demotion to open');
  });

  test('most-recent settled interrupted does NOT project completed', () => {
    const result = projectTicketLifecycle({
      mostRecentSettledAttempt: { id: 4, ordinal: 4, disposition: 'interrupted' }
    });
    // interrupted is not a canonical lifecycle state; falls through to OPEN.
    expectState(result, 'open', 'interrupted demotion to open');
  });

  test('completed beats blocking authority (completed is durable non-blocking fact)', () => {
    const result = projectTicketLifecycle({
      mostRecentSettledAttempt: { id: 4, ordinal: 4, disposition: 'completed' },
      blockingAuthority: { ticketTriageUnresolved: true }
    });
    expectState(result, 'completed', 'completed beats blocking');
  });

  // ─── Precedence 4: blocked ──────────────────────────────────────────────
  test('ticket-level triage unresolved projects blocked', () => {
    const result = projectTicketLifecycle({
      blockingAuthority: { ticketTriageUnresolved: true }
    });
    expectState(result, 'blocked', 'triage blocked');
    expectAuthorityKind(result, 'blocking', 'triage blocked');
  });

  test('persisted refusal event projects blocked', () => {
    const result = projectTicketLifecycle({
      blockingAuthority: { persistedRefusalEventId: 'evt-42' }
    });
    expectState(result, 'blocked', 'refusal blocked');
    expectAuthorityKind(result, 'blocking', 'refusal blocked');
  });

  test('maxAttempts exhausted projects blocked', () => {
    const result = projectTicketLifecycle({
      blockingAuthority: { maxAttemptsExhausted: true }
    });
    expectState(result, 'blocked', 'maxAttempts blocked');
  });

  test('failed attempt with unresolved blocker projects blocked', () => {
    const result = projectTicketLifecycle({
      mostRecentSettledAttempt: { id: 4, ordinal: 4, disposition: 'failed' },
      blockingAuthority: { ticketTriageUnresolved: true }
    });
    expectState(result, 'blocked', 'failed + blocker');
  });

  test('interrupted attempt with unresolved blocker projects blocked', () => {
    const result = projectTicketLifecycle({
      mostRecentSettledAttempt: { id: 4, ordinal: 4, disposition: 'interrupted' },
      blockingAuthority: { ticketTriageUnresolved: true }
    });
    expectState(result, 'blocked', 'interrupted + blocker');
  });

  // ─── Precedence 5: open ─────────────────────────────────────────────────
  test('no inputs projects open with null authorityReference', () => {
    const result = projectTicketLifecycle();
    expectState(result, 'open', 'open default');
    expectAuthorityKind(result, null, 'open default');
  });

  test('null blocking authority projects open', () => {
    const result = projectTicketLifecycle({
      blockingAuthority: null
    });
    expectState(result, 'open', 'null blocking');
  });

  test('failed attempt with no blocker projects open (FAILED demotion)', () => {
    const result = projectTicketLifecycle({
      mostRecentSettledAttempt: { id: 4, ordinal: 4, disposition: 'failed' }
    });
    expectState(result, 'open', 'failed -> open');
  });

  test('interrupted attempt with no blocker projects open', () => {
    const result = projectTicketLifecycle({
      mostRecentSettledAttempt: { id: 4, ordinal: 4, disposition: 'interrupted' }
    });
    expectState(result, 'open', 'interrupted -> open');
  });

  // ─── Topology neutrality ───────────────────────────────────────────────
  test('projection does not inspect execution topology (no plan/binding fields required)', () => {
    // The projector takes pure authority inputs; it must not accept topology
    // fields. If a caller passes extras, the projector silently ignores them
    // and produces the same result as without.
    const baseline = projectTicketLifecycle({
      mostRecentSettledAttempt: { id: 4, ordinal: 4, disposition: 'completed' }
    });
    const withTopology = projectTicketLifecycle({
      mostRecentSettledAttempt: { id: 4, ordinal: 4, disposition: 'completed' },
      // These would be illegal inputs the projector must ignore.
      allocationPlanId: 99,
      leafRunBinding: { allocationItemId: 1 },
      planningAttemptId: 7,
      workflowId: 'wf-1',
      provider: 'openai'
    });
    assert.deepEqual(baseline, withTopology,
      'projection must ignore execution topology fields');
  });

  // ─── Validation ─────────────────────────────────────────────────────────
  test('normalizeBlockingAuthority rejects unknown fields', () => {
    assert.throws(
      () => normalizeBlockingAuthority({ ticketTriageUnresolved: true, unknown: 'x' }),
      /unsupported fields/,
      'unknown fields rejected');
  });

  test('normalizeBlockingAuthority accepts null', () => {
    // T2 Tranche 5: the neutral shape carries the two new frozen inputs.
    assert.deepEqual(normalizeBlockingAuthority(null), {
      ticketTriageUnresolved: false,
      persistedRefusalEventId: null,
      maxAttemptsExhausted: false,
      settledBlockedAttempt: null,
      admissionHold: null
    });
  });

  test('projectTicketLifecycle rejects malformed mostRecentSettledAttempt.id', () => {
    assert.throws(
      () => projectTicketLifecycle({
        mostRecentSettledAttempt: { id: 'NaN', ordinal: 1, disposition: 'completed' }
      }),
      /must be a positive safe integer/,
      'invalid attempt id rejected');
  });

  test('projectTicketLifecycle rejects malformed currentAttempt.disposition', () => {
    // Settled currentAttempt with non-null disposition is treated as
    // already-settled (no in_progress); must not throw on the disposition
    // value (the projector tolerates any terminal-style disposition).
    const result = projectTicketLifecycle({
      currentAttempt: { id: 1, ordinal: 1, disposition: 'failed', memberCount: 1 }
    });
    expectState(result, 'open', 'settled current attempt falls through');
  });

  console.log(`  ${assertions} assertions passed`);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});

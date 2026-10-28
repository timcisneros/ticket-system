#!/usr/bin/env node
'use strict';

// P5-R2 — Governed delegated child execution — delegated-unit CONTRACT owner
// (deterministic, no database).
//
// Authority: docs/ARCHITECTURAL_DECISIONS_PENDING.md, P5 semantic design
// freeze — §7 (DELEGATED-HOLD-A), §8 (CHILD-RERUN-A / UNITKEY-A), §9
// (delegated creation evidence), §10 (final delegated-release authority).
//
// THE CONTRACT (each scenario owns one frozen assertion set):
//
//   1. The delegated logical child identity is derived canonically as
//      `ticket:{parentTicketId}:{parentWorkflowId}:{spawnedByStepId}:{childWorkflowId}:{unitKey}`
//      and is STABLE across parent attempts and reruns: the same unit
//      components always produce the same key; distinct logical units always
//      produce distinct keys; the key never embeds a Run id, transition
//      counter, wall-clock value or mutable workflow input.
//   2. A literal operator-authored unitKey is a non-blank string with no
//      workflow template expression. Missing, blank, non-string and
//      template-authored (`{{...}}`) keys are NOT literal authority — the
//      runtime/model may never create, replace, template or widen the unit
//      set.
//   3. A coherent delegated creation relation resolves to a FACT carrying the
//      complete delegation block (scheme, parent Ticket, ORIGINAL parent Run,
//      parent workflow, spawning step, Run-scoped spawn plan reference,
//      logical spawn identity, unit key, ORIGINAL parent execution-policy
//      hash) over the child's COMPLETE ticket.created provenance set.
//   4. Every unproven identity FAILS CLOSED with a typed reason:
//      - no delegation block (historical/non-delegated children have none) —
//        MALFORMED_DELEGATION_PROVENANCE;
//      - wrong/absent scheme, malformed ids, blank fields, template-derived
//        unit key, malformed parent policy hash — MALFORMED_DELEGATION_PROVENANCE;
//      - block/payload divergence or a block whose components re-derive a
//        different spawn key — DELEGATED_PROVENANCE_KEY_CONFLICT;
//      - a requested release whose re-derived key does not match the child's
//        durable spawn identity — DELEGATED_SPAWN_KEY_MISMATCH;
//      - an incoherent BASE spawn relation (malformed/multiple provenance,
//        missing parent) passes through with its own frozen T4 refusal.
//   5. ORIGINAL parent Run/policy facts are carried as historical provenance:
//      they are returned in the resolved block but are never compared against
//      the acting parent run by the resolution itself (never adoption
//      authority).
//   6. The existing non-delegated spawn key derivation is untouched: this
//      suite does not exercise it, and the composer predicate the T4 kernel
//      mirrors stays byte-for-byte (owned by t2-tranche5-blocking-authority).
//   7. Durable current-action authorization evidence (P5-R2 correction): the
//      ONE production definition of the `workflow.delegated_plan_authorized`
//      item bytes — a Run-stable identity derived only from the persisted Run
//      id + the Run-scoped execution reference (never the attempt counter,
//      wall clock or input content), binding the acting parent Ticket/Run,
//      parent workflow, step, action, the canonical validated plan bounds and
//      the exact finite authorized delegated-unit set whose entries must
//      re-derive the canonical delegated spawn key (divergent entries refuse
//      at the writer boundary). Only the executeTicketPlan action can
//      authorize delegated units.
//
// These are the pure semantics underneath the runtime enforcement; the
// PostgreSQL owner (p5-r2-delegated-admission-postgres-test.js) proves the
// runtime lifecycle end to end.

const assert = require('node:assert/strict');
const {
  DELEGATION_SCHEME,
  DELEGATED_REFUSAL_REASONS,
  buildDelegatedSpawnIdempotencyKey,
  isLiteralUnitKey,
  resolveDelegatedSpawnRelation,
  classifySpawnProvenanceRecord,
  buildDelegatedPlanAuthorizationEvidence,
  buildDelegatedPlanAuthorizationEvidenceKey
} = require('../runtime/t4-spawn-relation-contract');

let scenarios = 0;
let assertions = 0;

function check(condition, message) {
  assert.ok(condition, message);
  assertions += 1;
}

const POLICY_HASH = 'ab'.repeat(32);

function block(overrides = {}) {
  return {
    scheme: DELEGATION_SCHEME,
    version: 1,
    parentTicketId: 5,
    parentRunId: 77,
    parentWorkflowId: 'wf-parent',
    spawnedByStepId: 'spawn-step',
    spawnPlanId: '77:wf-parent:spawn-step:transition:0',
    spawnIdempotencyKey: 'ticket:5:wf-parent:spawn-step:wf-child:alpha',
    unitKey: 'alpha',
    parentExecutionPolicyHash: POLICY_HASH,
    ...overrides
  };
}

function creationPayload(overrides = {}) {
  return {
    parentTicketId: 5,
    parentRunId: 77,
    parentWorkflowId: 'wf-parent',
    spawnedByStepId: 'spawn-step',
    spawnPlanId: '77:wf-parent:spawn-step:transition:0',
    spawnIdempotencyKey: 'ticket:5:wf-parent:spawn-step:wf-child:alpha',
    workflowId: 'wf-child',
    createdBy: 'workflow:wf-parent',
    delegation: block(),
    ...overrides
  };
}

function resolve(payload, options = {}) {
  return resolveDelegatedSpawnRelation({
    childTicketId: 9,
    records: [{ id: 'event-1', position: 1, payload }],
    existingParentTicketIds: new Set([5]),
    ...options
  });
}

// ── 1. Ticket-stable logical identity ────────────────────────────────────────
scenarios += 1;
{
  const key = buildDelegatedSpawnIdempotencyKey({
    parentTicketId: 5, parentWorkflowId: 'wf-parent', spawnedByStepId: 'spawn-step',
    childWorkflowId: 'wf-child', unitKey: 'alpha'
  });
  check(key === 'ticket:5:wf-parent:spawn-step:wf-child:alpha',
    `1: the delegated key uses the frozen canonical form (got ${key})`);

  const rerunKey = buildDelegatedSpawnIdempotencyKey({
    parentTicketId: 5, parentWorkflowId: 'wf-parent', spawnedByStepId: 'spawn-step',
    childWorkflowId: 'wf-child', unitKey: 'alpha'
  });
  check(rerunKey === key, '1: the same unit re-derived for a parent rerun produces the SAME key');
  check(!key.includes('77:'), '1: the logical identity never embeds the Run-scoped execution reference');
  check(!/\d{13,}/.test(key), '1: the logical identity never embeds a wall-clock value');

  const betaKey = buildDelegatedSpawnIdempotencyKey({
    parentTicketId: 5, parentWorkflowId: 'wf-parent', spawnedByStepId: 'spawn-step',
    childWorkflowId: 'wf-child', unitKey: 'beta'
  });
  check(betaKey !== key, '1: distinct logical units produce distinct keys');
  const otherParent = buildDelegatedSpawnIdempotencyKey({
    parentTicketId: 6, parentWorkflowId: 'wf-parent', spawnedByStepId: 'spawn-step',
    childWorkflowId: 'wf-child', unitKey: 'alpha'
  });
  check(otherParent !== key, '1: a different parent Ticket produces a different key');

  check.throws = check.throws || ((fn, matcher, message) => {
    assert.throws(fn, matcher, message);
    assertions += 1;
  });
  check.throws(() => buildDelegatedSpawnIdempotencyKey({
    parentTicketId: 5, parentWorkflowId: 'wf-parent', spawnedByStepId: 'spawn-step',
    childWorkflowId: 'wf-child', unitKey: ''
  }), /unitKey/, '1: a blank unit key refuses derivation');
  check.throws(() => buildDelegatedSpawnIdempotencyKey({
    parentTicketId: 0, parentWorkflowId: 'wf-parent', spawnedByStepId: 'spawn-step',
    childWorkflowId: 'wf-child', unitKey: 'alpha'
  }), /parentTicketId/, '1: an invalid parent id refuses derivation');
}

// ── 2. Literal operator-authored unit keys only ──────────────────────────────
scenarios += 1;
{
  check(isLiteralUnitKey('alpha') === true, '2: a plain literal string is literal authority');
  check(isLiteralUnitKey('unit-2026-10-27') === true, '2: literals may contain other characters');
  check(isLiteralUnitKey('') === false, '2: blank is not literal');
  check(isLiteralUnitKey('   ') === false, '2: whitespace-only is not literal');
  check(isLiteralUnitKey('{{workflow.input.unitKey}}') === false, '2: a template-authored key is not literal');
  check(isLiteralUnitKey('unit-{{x}}') === false, '2: an embedded template expression is not literal');
  check(isLiteralUnitKey(undefined) === false, '2: a missing key is not literal');
  check(isLiteralUnitKey(null) === false, '2: null is not literal');
  check(isLiteralUnitKey(7) === false, '2: a non-string is not literal');
}

// ── 3. Coherent delegated creation relation ─────────────────────────────────
scenarios += 1;
{
  const resolved = resolve(creationPayload());
  check(resolved.outcome === 'FACT', `3: a coherent child resolves to FACT (got ${resolved.outcome}: ${resolved.reason || ''})`);
  check(resolved.fact.parentTicketId === 5 && resolved.fact.kind === 'workflow-spawn',
    '3: the base T4 relation is preserved');
  check(resolved.delegation.scheme === DELEGATION_SCHEME, '3: the canonical delegation scheme is carried');
  check(resolved.delegation.parentTicketId === 5, '3: the parent Ticket id is carried');
  check(resolved.delegation.parentRunId === 77, '3: the ORIGINAL parent Run id is carried as historical provenance');
  check(resolved.delegation.parentWorkflowId === 'wf-parent', '3: the parent workflow id is carried');
  check(resolved.delegation.spawnedByStepId === 'spawn-step', '3: the spawning step id is carried');
  check(resolved.delegation.spawnPlanId === '77:wf-parent:spawn-step:transition:0',
    '3: the Run-scoped spawn plan reference is carried');
  check(resolved.delegation.spawnIdempotencyKey === 'ticket:5:wf-parent:spawn-step:wf-child:alpha',
    '3: the logical spawn identity is carried');
  check(resolved.delegation.unitKey === 'alpha', '3: the delegated unit key is carried');
  check(resolved.delegation.parentExecutionPolicyHash === POLICY_HASH,
    '3: the ORIGINAL parent execution-policy hash is carried as historical provenance');
  check(resolved.delegation.parentRunId !== undefined &&
    typeof resolved.delegation.parentRunId === 'number',
    '5: the original run fact is data, never compared against the acting run by the resolution');
}

// ── 4. Fail-closed delegated identities ─────────────────────────────────────
scenarios += 1;
{
  const noBlock = resolve(creationPayload({ delegation: undefined }));
  check(noBlock.outcome === 'REFUSED' &&
    noBlock.reason === DELEGATED_REFUSAL_REASONS.MALFORMED_DELEGATION_PROVENANCE,
    '4: a child without a delegation block is not a delegated child (typed refusal)');

  const wrongScheme = resolve(creationPayload({
    delegation: block({ scheme: 'workflow_delegation_v2' })
  }));
  check(wrongScheme.reason === DELEGATED_REFUSAL_REASONS.MALFORMED_DELEGATION_PROVENANCE,
    '4: an unknown delegation scheme refuses');

  const templateKey = resolve(creationPayload({
    delegation: block({ unitKey: '{{workflow.input.unitKey}}' })
  }));
  check(templateKey.reason === DELEGATED_REFUSAL_REASONS.MALFORMED_DELEGATION_PROVENANCE,
    '4: a template-derived delegated unit key refuses');

  const blankKey = resolve(creationPayload({ delegation: block({ unitKey: '  ' }) }));
  check(blankKey.reason === DELEGATED_REFUSAL_REASONS.MALFORMED_DELEGATION_PROVENANCE,
    '4: a blank delegated unit key refuses');

  const badHash = resolve(creationPayload({
    delegation: block({ parentExecutionPolicyHash: 'not-a-hash' })
  }));
  check(badHash.reason === DELEGATED_REFUSAL_REASONS.MALFORMED_DELEGATION_PROVENANCE,
    '4: a malformed original parent policy hash refuses');

  const foreignParent = resolve(creationPayload({
    delegation: block({ parentTicketId: 6 })
  }));
  check(foreignParent.reason === DELEGATED_REFUSAL_REASONS.MALFORMED_DELEGATION_PROVENANCE,
    '4: a delegation block binding a different parent refuses');

  const divergent = resolve(creationPayload({
    delegation: block({ spawnedByStepId: 'other-step' })
  }));
  check(divergent.reason === DELEGATED_REFUSAL_REASONS.DELEGATED_PROVENANCE_KEY_CONFLICT,
    '4: a block diverging from the provenance payload it rides refuses');

  const conflictingKey = resolve(creationPayload({
    delegation: block({ spawnIdempotencyKey: 'ticket:5:wf-parent:spawn-step:wf-child:zzz' })
  }));
  check(conflictingKey.reason === DELEGATED_REFUSAL_REASONS.DELEGATED_PROVENANCE_KEY_CONFLICT,
    '4: a block whose components re-derive a different spawn key refuses');

  const stale = resolve(creationPayload(), {
    expectedSpawnIdempotencyKey: 'ticket:5:wf-parent:spawn-step:wf-child:beta'
  });
  check(stale.reason === DELEGATED_REFUSAL_REASONS.DELEGATED_SPAWN_KEY_MISMATCH,
    '4: a release whose re-derived key is not the child\'s durable spawn identity refuses');

  const multiple = resolveDelegatedSpawnRelation({
    childTicketId: 9,
    records: [
      { id: 'event-1', position: 1, payload: creationPayload() },
      { id: 'event-2', position: 2, payload: creationPayload() }
    ],
    existingParentTicketIds: new Set([5])
  });
  check(multiple.reason === 'MULTIPLE_APPLICABLE_PROVENANCE',
    '4: multiple applicable provenance records refuse through the frozen base kernel');

  const missingParent = resolveDelegatedSpawnRelation({
    childTicketId: 9,
    records: [{ id: 'event-1', position: 1, payload: creationPayload() }],
    existingParentTicketIds: new Set([6])
  });
  check(missingParent.reason === 'PARENT_TICKET_NOT_FOUND',
    '4: an unprovable parent identity refuses through the frozen base kernel');

  const malformedBase = resolveDelegatedSpawnRelation({
    childTicketId: 9,
    records: [{ id: 'event-1', position: 1, payload: { parentTicketId: 'abc', spawnIdempotencyKey: 'k' } }],
    existingParentTicketIds: new Set([5])
  });
  check(malformedBase.reason === 'MALFORMED_SPAWN_PROVENANCE',
    '4: a malformed base spawn relation refuses through the frozen base kernel');

  // The classification the base kernel accepts is unchanged by the extension:
  // a payload WITH a delegation block classifies exactly as before.
  const classification = classifySpawnProvenanceRecord(creationPayload());
  check(classification.state === 'COHERENT' && classification.parentTicketId === 5,
    '4: the delegation block is invisible to the base spawn classification (composer untouched)');
}

// ── 5. Non-delegated children are structurally outside the delegated path ───
scenarios += 1;
{
  const plain = resolveDelegatedSpawnRelation({
    childTicketId: 9,
    records: [{ id: 'event-1', position: 1, payload: {
      parentTicketId: 5, parentRunId: 77, parentWorkflowId: 'wf-parent',
      spawnedByStepId: 'spawn-step', spawnPlanId: '77:wf-parent:spawn-step:transition:0',
      spawnIdempotencyKey: '5:wf-child:no-vendor', workflowId: 'wf-child'
    } }],
    existingParentTicketIds: new Set([5])
  });
  check(plain.outcome === 'REFUSED' &&
    plain.reason === DELEGATED_REFUSAL_REASONS.MALFORMED_DELEGATION_PROVENANCE,
    '5: an ordinary executeTicketPlan child (existing key derivation, no block) is never a delegated child');
}

// ── 7. Durable current-action authorization evidence (correction). ──────────
scenarios += 1;
{
  const evidenceItem = buildDelegatedPlanAuthorizationEvidence({
    run: { id: 77, ticketId: 5 },
    workflow: { id: 'wf-parent' },
    step: { id: 'spawn-step', action: 'executeTicketPlan' },
    spawnPlanId: '77:wf-parent:spawn-step:transition:0',
    planBounds: { allowedWorkflowIds: ['wf-child'], maxTickets: 5 },
    delegatedUnits: [{
      unitKey: 'alpha',
      childWorkflowId: 'wf-child',
      spawnIdempotencyKey: 'ticket:5:wf-parent:spawn-step:wf-child:alpha'
    }],
    workflowContract: { workflowId: 'wf-parent', workflowVersion: 'v3' }
  });
  check(evidenceItem.evidenceKey === buildDelegatedPlanAuthorizationEvidenceKey({
      parentRunId: 77, spawnPlanId: '77:wf-parent:spawn-step:transition:0'
    }),
    '7: the evidence identity is the Run-stable key derived from the run + execution reference');
  check(evidenceItem.parentTicketId === 5 && evidenceItem.parentRunId === 77 &&
    evidenceItem.parentWorkflowId === 'wf-parent' &&
    evidenceItem.stepId === 'spawn-step' &&
    evidenceItem.action === 'executeTicketPlan' &&
    evidenceItem.spawnPlanId === '77:wf-parent:spawn-step:transition:0',
    '7: the item binds the acting parent Ticket/Run, workflow, step, action and execution reference');
  check(evidenceItem.planBounds.maxTickets === 5 &&
    Array.isArray(evidenceItem.planBounds.allowedWorkflowIds) &&
    evidenceItem.planBounds.allowedWorkflowIds[0] === 'wf-child',
    '7: the item carries the canonical validated plan bounds of the action');
  check(evidenceItem.delegatedUnits.length === 1 &&
    evidenceItem.delegatedUnits[0].unitKey === 'alpha' &&
    evidenceItem.delegatedUnits[0].childWorkflowId === 'wf-child' &&
    evidenceItem.delegatedUnits[0].spawnIdempotencyKey === 'ticket:5:wf-parent:spawn-step:wf-child:alpha',
    '7: the item carries the exact finite authorized delegated unit set');
  check(evidenceItem.workflowContract.workflowVersion === 'v3',
    '7: definition identity/contract facts ride the item as payload facts');

  // The identity is Run-stable and never derives from the attempt counter,
  // wall clock, or input content: the same run + execution reference always
  // yields the same key, a different run/execution reference never does.
  const replayedKey = buildDelegatedPlanAuthorizationEvidenceKey({
    parentRunId: 77, spawnPlanId: '77:wf-parent:spawn-step:transition:0'
  });
  check(replayedKey === evidenceItem.evidenceKey,
    '7: a replayed action re-derives the SAME durable authorization identity');
  const nextTransitionKey = buildDelegatedPlanAuthorizationEvidenceKey({
    parentRunId: 77, spawnPlanId: '77:wf-parent:spawn-step:transition:1'
  });
  check(nextTransitionKey !== evidenceItem.evidenceKey,
    '7: a different execution of the same run owns a different authorization identity');
  check(!evidenceItem.evidenceKey.includes('attempt'),
    '7: the identity never embeds the lease-recovery execution-attempt counter');

  // The recorded unit set is re-derived against the canonical delegated key:
  // a divergent entry refuses at the writer boundary and can never become a
  // durable authority.
  check.throws(() => buildDelegatedPlanAuthorizationEvidence({
    run: { id: 77, ticketId: 5 },
    workflow: { id: 'wf-parent' },
    step: { id: 'spawn-step', action: 'executeTicketPlan' },
    spawnPlanId: '77:wf-parent:spawn-step:transition:0',
    planBounds: { allowedWorkflowIds: ['wf-child'], maxTickets: 5 },
    delegatedUnits: [{
      unitKey: 'beta',
      childWorkflowId: 'wf-child',
      spawnIdempotencyKey: 'ticket:5:wf-parent:spawn-step:wf-child:alpha'
    }]
  }), /diverges/, '7: a unit entry diverging from the canonical delegated key refuses');

  check.throws(() => buildDelegatedPlanAuthorizationEvidence({
    run: { id: 77, ticketId: 5 },
    workflow: { id: 'wf-parent' },
    step: { id: 'spawn-step', action: 'stop' },
    spawnPlanId: '77:wf-parent:spawn-step:transition:0',
    planBounds: { allowedWorkflowIds: ['wf-child'], maxTickets: 5 },
    delegatedUnits: [{
      unitKey: 'alpha', childWorkflowId: 'wf-child',
      spawnIdempotencyKey: 'ticket:5:wf-parent:spawn-step:wf-child:alpha'
    }]
  }), /executeTicketPlan/, '7: only the executeTicketPlan action can authorize delegated units');

  check.throws(() => buildDelegatedPlanAuthorizationEvidence({
    run: { id: 77, ticketId: 5 },
    workflow: { id: 'wf-parent' },
    step: { id: 'spawn-step', action: 'executeTicketPlan' },
    spawnPlanId: '77:wf-parent:spawn-step:transition:0',
    planBounds: { allowedWorkflowIds: [], maxTickets: 0 },
    delegatedUnits: [{
      unitKey: 'alpha', childWorkflowId: 'wf-child',
      spawnIdempotencyKey: 'ticket:5:wf-parent:spawn-step:wf-child:alpha'
    }]
  }), /maxTickets/, '7: zero plan headroom cannot authorize a delegated unit');

  check.throws(() => buildDelegatedPlanAuthorizationEvidence({
    run: { id: 77, ticketId: 5 },
    workflow: { id: 'wf-parent' },
    step: { id: 'spawn-step', action: 'executeTicketPlan' },
    spawnPlanId: '77:wf-parent:spawn-step:transition:0',
    planBounds: { allowedWorkflowIds: ['wf-child'], maxTickets: 5 },
    delegatedUnits: []
  }), /non-empty/, '7: an empty authorized unit set is not a delegated-plan authorization');
}

console.log(`PASS: P5-R2 delegated-unit contract — ${scenarios} scenarios, ${assertions} assertions`);
if (scenarios < 6 || assertions < 45) {
  console.error('FAIL: the suite reached its end without covering its frozen assertions');
  process.exit(1);
}

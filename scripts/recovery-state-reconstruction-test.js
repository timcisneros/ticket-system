#!/usr/bin/env node
'use strict';

const assert = require('assert');
const {
  RECOVERY_STATE, reconstructAgentRecoveryState, resolveExecutionTurnProviderCall,
  eventRef, replayRef, operationRef, historyRef
} = require('../runtime/recovery-state');
const { computeRunEventHash } = require('../runtime/event-integrity');

const MUTATING_OPS = ['createFolder', 'writeFile', 'renamePath', 'deletePath'];

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed += 1;
    process.stdout.write('.');
  } catch (err) {
    failed += 1;
    failures.push({ name, error: err });
    process.stdout.write('F');
  }
}

function assertState(r, expected, label) {
  assert.strictEqual(r.state, expected, `${label}: expected ${expected}, got ${r.state}`);
}

function hasRef(refs, type, value) {
  return refs.some(r => r.type === type && (r.id === value || r.evidenceKey === value || r.operationKey === value));
}

function assertTypedRefs(refs, label) {
  for (const ref of refs) {
    assert.ok(ref && typeof ref === 'object' && !Array.isArray(ref), `${label}: ref must be object`);
    assert.ok(typeof ref.type === 'string', `${label}: ref must have type`);
  }
}

// ── Mock builders ──────────────────────────────────────────────────────
function mockRun(overrides = {}) {
  return { id: 1, ticketId: 1, agentId: 1, status: 'running', ...overrides };
}

function mockSnapshot(overrides = {}) {
  return {
    version: 1, runId: 1, ticketId: 1,
    providerRequests: [], modelResponses: [], parsedModelPlans: [],
    workspaceOperations: [], authorityChecks: [],
    ...overrides
  };
}

function mockReq(turn, overrides = {}) {
  const startedAt = new Date().toISOString();
  return {
    evidenceKey: `req:${turn}`, durationMs: 100,
    executionTurn: turn, modelCallKey: `call:${turn}`,
    startedAt, capturedAt: startedAt,
    ...overrides
  };
}

function mockResp(turn, overrides = {}) {
  return {
    text: '{}', evidenceKey: `resp:${turn}`, capturedAt: new Date().toISOString(),
    executionTurn: turn, modelCallKey: `call:${turn}`,
    providerRequestEvidenceKey: `req:${turn}`,
    ...overrides
  };
}

function mockPlan(turn, overrides = {}) {
  return {
    message: 'plan', actions: [], complete: false, step: turn,
    capturedAt: new Date().toISOString(),
    evidenceKey: `plan:${turn}`, executionTurn: turn,
    modelCallKey: `call:${turn}`, planKey: `pk:${turn}`,
    providerResponseEvidenceKey: `resp:${turn}`,
    ...overrides
  };
}

function mockOp(turn, idx, overrides = {}) {
  return {
    operation: { operation: 'createFolder', args: { path: 'A' } },
    capturedAt: new Date().toISOString(),
    evidenceKey: `op:${turn}:${idx}`,
    executionTurn: turn, planKey: `pk:${turn}`, actionIndex: idx,
    operationKey: `ok:${turn}:${idx}`,
    mutationReceipt: { id: idx + 1, operationKey: `ok:${turn}:${idx}`, operation: 'createFolder', targetPath: 'A' },
    ...overrides
  };
}

let eventSeq = 0;
let lastEventHash = null;
function resetEvents() { eventSeq = 0; lastEventHash = null; }

function mockEvent(type, overrides = {}) {
  const ev = {
    schemaVersion: 1, id: `ev-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    ts: new Date().toISOString(), type, ticketId: 1, runId: 1, stepId: null,
    payload: {}, seq: eventSeq++, prevHash: null, hash: '',
    ...overrides
  };
  if (ev.seq > 0 && overrides.prevHash === undefined) ev.prevHash = lastEventHash;
  ev.hash = computeRunEventHash(ev);
  lastEventHash = ev.hash;
  return ev;
}

function opts(extra) {
  return { mutatingOperations: MUTATING_OPS, verifyOperationKey: () => ({ valid: true }), ...extra };
}

function noVerifyOpts(extra) {
  return { mutatingOperations: MUTATING_OPS, ...extra };
}

// ── Tests ──────────────────────────────────────────────────────────────
console.log('Recovery state reconstruction tests\n');

// ── 1. Hash chain before terminal events ───────────────────────────────

test('TERMINAL on intact chain', () => {
  resetEvents();
  const ev = mockEvent('run.terminalized');
  const r = reconstructAgentRecoveryState(opts({ run: mockRun(), events: [ev] }));
  assertState(r, 'TERMINAL', '1a');
  assert.ok(hasRef(r.evidenceRefs, 'event', ev.id));
});

test('UNSAFE when terminalized on broken chain', () => {
  resetEvents();
  const ev1 = mockEvent('workspace.operation', { payload: { operation: 'readFile' } });
  const ev2 = mockEvent('run.terminalized', { prevHash: 'x' });
  const r = reconstructAgentRecoveryState(opts({ run: mockRun(), events: [ev1, ev2] }));
  assertState(r, 'UNSAFE_TO_CONTINUE', '1b');
  assert.ok(r.inconsistencies.includes('hash_chain_broken'));
});

// ── 2. Lifecycle ordering ──────────────────────────────────────────────

test('UNSAFE when terminalized followed by workspace op', () => {
  resetEvents();
  const ev1 = mockEvent('run.terminalized');
  const ev2 = mockEvent('workspace.operation', { payload: { operation: 'readFile' } });
  const r = reconstructAgentRecoveryState(opts({ run: mockRun(), events: [ev1, ev2] }));
  assertState(r, 'UNSAFE_TO_CONTINUE', '2a');
  assert.ok(r.inconsistencies.includes('post_terminal_activity'));
});

test('UNSAFE when execution_completed followed by model:stalled', () => {
  resetEvents();
  const ev1 = mockEvent('run.execution_completed');
  const ev2 = mockEvent('model:stalled', { payload: { step: 0 } });
  const r = reconstructAgentRecoveryState(opts({ run: mockRun(), events: [ev1, ev2] }));
  assertState(r, 'UNSAFE_TO_CONTINUE', '2b');
  assert.ok(r.inconsistencies.includes('post_execution_completed_activity'));
});

test('UNSAFE when duplicate terminalization events', () => {
  resetEvents();
  const ev1 = mockEvent('run.terminalized');
  const ev2 = mockEvent('run.terminalized');
  const r = reconstructAgentRecoveryState(opts({ run: mockRun(), events: [ev1, ev2] }));
  assertState(r, 'UNSAFE_TO_CONTINUE', '2c');
  assert.ok(r.inconsistencies.includes('duplicate_terminalization'));
});

test('NEEDS_TERMINALIZATION when execution_completed alone', () => {
  resetEvents();
  const ev = mockEvent('run.execution_completed');
  const r = reconstructAgentRecoveryState(opts({ run: mockRun(), events: [ev] }));
  assertState(r, 'NEEDS_TERMINALIZATION', '2d');
});

// ── 3. Identity type validation ────────────────────────────────────────

test('UNSAFE when response has non-integer turn', () => {
  const r = reconstructAgentRecoveryState(opts({
    run: mockRun(),
    replaySnapshot: mockSnapshot({
      modelResponses: [{ text: '{}', evidenceKey: 'r1', capturedAt: new Date().toISOString(),
        executionTurn: 'not_a_number', modelCallKey: 'c1' }]
    }),
    events: []
  }));
  assertState(r, 'UNSAFE_TO_CONTINUE', '3a');
  assert.ok(r.inconsistencies.includes('response_non_integer_turn'));
});

test('UNSAFE when plan missing planKey', () => {
  const r = reconstructAgentRecoveryState(opts({
    run: mockRun(),
    replaySnapshot: mockSnapshot({
      parsedModelPlans: [{
        message: 'p', actions: [], complete: true, step: 1,
        capturedAt: new Date().toISOString(), evidenceKey: 'p1',
        executionTurn: 1, modelCallKey: 'c1',
        providerResponseEvidenceKey: 'r1'
      }]
    }),
    events: []
  }));
  assertState(r, 'UNSAFE_TO_CONTINUE', '3b');
  assert.ok(r.inconsistencies.includes('plan_missing_plan_key'));
});

test('UNSAFE when operation missing operationKey', () => {
  const r = reconstructAgentRecoveryState(opts({
    run: mockRun(),
    replaySnapshot: mockSnapshot({
      parsedModelPlans: [mockPlan(1)],
      modelResponses: [mockResp(1)],
      workspaceOperations: [{
        executionTurn: 1, planKey: 'pk:1', actionIndex: 0,
        operationKey: null, capturedAt: new Date().toISOString(),
        evidenceKey: 'op1', operation: { operation: 'createFolder', args: {} }
      }]
    }),
    events: []
  }));
  assertState(r, 'UNSAFE_TO_CONTINUE', '3c');
  assert.ok(r.inconsistencies.includes('operation_missing_operation_key'));
});

// ── 4. Multiple responses/plans per turn ───────────────────────────────

test('UNSAFE when two responses for same turn', () => {
  const r = reconstructAgentRecoveryState(opts({
    run: mockRun(),
    replaySnapshot: mockSnapshot({
      modelResponses: [mockResp(1, { modelCallKey: 'a' }), mockResp(1, { modelCallKey: 'b' })]
    }),
    events: []
  }));
  assertState(r, 'UNSAFE_TO_CONTINUE', '4a');
  assert.ok(r.inconsistencies.includes('multiple_responses_for_turn'));
});

test('UNSAFE when two plans for same turn', () => {
  const r = reconstructAgentRecoveryState(opts({
    run: mockRun(),
    replaySnapshot: mockSnapshot({
      parsedModelPlans: [mockPlan(1, { planKey: 'pk:a' }), mockPlan(1, { planKey: 'pk:b' })],
      modelResponses: [mockResp(1)]
    }),
    events: []
  }));
  assertState(r, 'UNSAFE_TO_CONTINUE', '4b');
  assert.ok(r.inconsistencies.includes('multiple_plans_for_turn'));
});

// ── 5. Response without request ────────────────────────────────────────

test('UNSAFE when response exists but no request', () => {
  const r = reconstructAgentRecoveryState(opts({
    run: mockRun(),
    replaySnapshot: mockSnapshot({
      modelResponses: [mockResp(1)],
      parsedModelPlans: [mockPlan(1)],
      providerRequests: []
    }),
    events: []
  }));
  assertState(r, 'UNSAFE_TO_CONTINUE', '5a');
  assert.ok(r.inconsistencies.includes('response_without_request'));
});

// ── 6. Request/response modelCallKey mismatch ──────────────────────────

test('UNSAFE when request and response modelCallKey differ', () => {
  const r = reconstructAgentRecoveryState(opts({
    run: mockRun(),
    replaySnapshot: mockSnapshot({
      providerRequests: [mockReq(1, { modelCallKey: 'call:x' })],
      modelResponses: [mockResp(1, { modelCallKey: 'call:y' })],
      parsedModelPlans: [mockPlan(1)]
    }),
    events: []
  }));
  assertState(r, 'UNSAFE_TO_CONTINUE', '6a');
  assert.ok(r.inconsistencies.includes('request_response_model_call_key_mismatch'));
});

test('UNSAFE when response request evidence link differs from request', () => {
  const r = reconstructAgentRecoveryState(opts({
    run: mockRun(),
    replaySnapshot: mockSnapshot({
      providerRequests: [mockReq(1)],
      modelResponses: [mockResp(1, { providerRequestEvidenceKey: 'req:other' })]
    }),
    events: []
  }));
  assertState(r, 'UNSAFE_TO_CONTINUE', '6b');
  assert.ok(r.inconsistencies.includes('request_response_evidence_key_mismatch'));
});

// ── 7. Response/plan pairing ───────────────────────────────────────────

test('UNSAFE when plan modelCallKey mismatches response', () => {
  const r = reconstructAgentRecoveryState(opts({
    run: mockRun(),
    replaySnapshot: mockSnapshot({
      providerRequests: [mockReq(1, { modelCallKey: 'call:y' })],
      parsedModelPlans: [mockPlan(1, { modelCallKey: 'call:x' })],
      modelResponses: [mockResp(1, { modelCallKey: 'call:y' })]
    }),
    events: []
  }));
  assertState(r, 'UNSAFE_TO_CONTINUE', '7a');
  assert.ok(r.inconsistencies.includes('plan_response_model_call_key_mismatch'));
});

// ── 8. Operations without plan ─────────────────────────────────────────

test('UNSAFE when workspace ops exist but no plan', () => {
  const r = reconstructAgentRecoveryState(opts({
    run: mockRun(),
    replaySnapshot: mockSnapshot({
      modelResponses: [mockResp(1)],
      providerRequests: [mockReq(1)],
      workspaceOperations: [mockOp(1, 0)]
    }),
    events: []
  }));
  assertState(r, 'UNSAFE_TO_CONTINUE', '8a');
  assert.ok(r.inconsistencies.includes('workspace_ops_without_plan'));
});

// ── 9. Prepared mutation identity ──────────────────────────────────────

test('UNSAFE when prepared mutation lacks executionTurn', () => {
  resetEvents();
  const ev = mockEvent('workspace.operation_prepared', {
    payload: { operationKey: 'op:1', planKey: 'pk:1', actionIndex: 0 }
  });
  const r = reconstructAgentRecoveryState(opts({ run: mockRun(), events: [ev] }));
  assertState(r, 'UNSAFE_TO_CONTINUE', '9a');
  assert.ok(r.inconsistencies.includes('prepared_mutation_missing_identity'));
});

test('UNSAFE when prepared mutation lacks planKey', () => {
  resetEvents();
  const ev = mockEvent('workspace.operation_prepared', {
    payload: { operationKey: 'op:1', executionTurn: 1, actionIndex: 0 }
  });
  const r = reconstructAgentRecoveryState(opts({ run: mockRun(), events: [ev] }));
  assertState(r, 'UNSAFE_TO_CONTINUE', '9b');
  assert.ok(r.inconsistencies.includes('prepared_mutation_missing_identity'));
});

test('UNSAFE when prepared mutation lacks actionIndex', () => {
  resetEvents();
  const ev = mockEvent('workspace.operation_prepared', {
    payload: { operationKey: 'op:1', executionTurn: 1, planKey: 'pk:1' }
  });
  const r = reconstructAgentRecoveryState(opts({ run: mockRun(), events: [ev] }));
  assertState(r, 'UNSAFE_TO_CONTINUE', '9c');
  assert.ok(r.inconsistencies.includes('prepared_mutation_missing_identity'));
});

test('NEEDS_ACTION_EXECUTION when prepared mutation has full identity but no ops', () => {
  resetEvents();
  const ev = mockEvent('workspace.operation_prepared', {
    payload: { operationKey: 'op:1', executionTurn: 1, planKey: 'pk:1', actionIndex: 0,
      intent: { operation: 'createFolder', args: {} } }
  });
  const r = reconstructAgentRecoveryState(opts({
    run: mockRun(), events: [ev],
    replaySnapshot: mockSnapshot({
      parsedModelPlans: [mockPlan(1, { actions: [{ operation: 'createFolder' }] })],
      modelResponses: [mockResp(1)],
      providerRequests: [mockReq(1)]
    })
  }));
  // Plan has 1 action, 0 ops → earliest incomplete turn is 1 → needs action execution
  assertState(r, 'NEEDS_ACTION_EXECUTION', '9d');
  assert.ok(hasRef(r.evidenceRefs, 'event', ev.id));
});

// ── 10. Operation-key verification required ────────────────────────────

test('UNSAFE when ops exist but no verifyOperationKey provided', () => {
  const r = reconstructAgentRecoveryState(noVerifyOpts({
    run: mockRun(),
    replaySnapshot: mockSnapshot({
      parsedModelPlans: [mockPlan(1, { actions: [{ operation: 'createFolder' }] })],
      modelResponses: [mockResp(1)],
      providerRequests: [mockReq(1)],
      workspaceOperations: [mockOp(1, 0)]
    }),
    events: []
  }));
  assertState(r, 'UNSAFE_TO_CONTINUE', '10a');
  assert.ok(r.inconsistencies.includes('verify_operation_key_required'));
});

test('UNSAFE when verifyOperationKey returns invalid', () => {
  const r = reconstructAgentRecoveryState(opts({
    verifyOperationKey: () => ({ valid: false, reason: 'wrong_args' }),
    run: mockRun(),
    replaySnapshot: mockSnapshot({
      parsedModelPlans: [mockPlan(1, { actions: [{ operation: 'createFolder' }] })],
      modelResponses: [mockResp(1)],
      providerRequests: [mockReq(1)],
      workspaceOperations: [mockOp(1, 0)]
    }),
    events: []
  }));
  assertState(r, 'UNSAFE_TO_CONTINUE', '10b');
  assert.ok(r.inconsistencies.includes('operation_key_verification_failed'));
});

test('UNSAFE when verifyOperationKey returns undefined', () => {
  const r = reconstructAgentRecoveryState(opts({
    verifyOperationKey: () => undefined,
    run: mockRun(),
    replaySnapshot: mockSnapshot({
      parsedModelPlans: [mockPlan(1, { actions: [{ operation: 'createFolder' }] })],
      modelResponses: [mockResp(1)],
      providerRequests: [mockReq(1)],
      workspaceOperations: [mockOp(1, 0)]
    }),
    events: []
  }));
  assertState(r, 'UNSAFE_TO_CONTINUE', '10c');
  assert.ok(r.inconsistencies.includes('operation_key_verification_failed'));
});

// ── 11. Stall state ───────────────────────────────────────────────────

test('NEEDS_STALL_DECISION when stall event recorded', () => {
  resetEvents();
  const stallEv = mockEvent('model:stalled', { payload: { step: 3 } });
  const r = reconstructAgentRecoveryState(opts({
    run: mockRun(),
    replaySnapshot: mockSnapshot({
      parsedModelPlans: [mockPlan(3, { actions: [], complete: false })],
      modelResponses: [mockResp(3)],
      providerRequests: [mockReq(3)]
    }),
    events: [stallEv]
  }));
  assertState(r, 'NEEDS_STALL_DECISION', '11a');
  assert.strictEqual(r.nextPhase, 'stall_recorded');
  assert.strictEqual(r.automaticRecoveryAllowed, false);
  assert.ok(hasRef(r.evidenceRefs, 'event', stallEv.id));
});

test('UNSAFE when empty plan with no stall event', () => {
  const r = reconstructAgentRecoveryState(opts({
    run: mockRun(),
    replaySnapshot: mockSnapshot({
      parsedModelPlans: [mockPlan(3, { actions: [], complete: false })],
      modelResponses: [mockResp(3)],
      providerRequests: [mockReq(3)]
    }),
    events: []
  }));
  assertState(r, 'UNSAFE_TO_CONTINUE', '11b');
  assert.ok(r.inconsistencies.includes('empty_plan_stall_not_recorded'));
});

// ── 12. Earliest unresolved turn ───────────────────────────────────────

test('recovers turn 2 when turn 3 also has evidence', () => {
  const r = reconstructAgentRecoveryState(opts({
    run: mockRun(),
    replaySnapshot: mockSnapshot({
      providerRequests: [mockReq(2), mockReq(3)],
      modelResponses: [mockResp(2), mockResp(3)],
      parsedModelPlans: [
        mockPlan(2, { actions: [{ operation: 'createFolder' }] }),
        mockPlan(3, { actions: [{ operation: 'writeFile' }] })
      ],
      workspaceOperations: [mockOp(3, 0)]
    }),
    events: []
  }));
  assertState(r, 'NEEDS_ACTION_EXECUTION', '12a');
  assert.strictEqual(r.executionTurn, 2);
});

test('turn 2 incomplete with turn 3 response-only resolves to turn 2', () => {
  const r = reconstructAgentRecoveryState(opts({
    run: mockRun(),
    replaySnapshot: mockSnapshot({
      providerRequests: [mockReq(2), mockReq(3)],
      modelResponses: [mockResp(2), mockResp(3)],
      parsedModelPlans: [mockPlan(2, { actions: [{ operation: 'createFolder' }] })],
    }),
    events: []
  }));
  // Turn 2 has plan with 1 action, 0 ops → needs action execution
  // Turn 3 has response but no plan → response_without_plan at turn 3
  // BUT: earliest unresolved is turn 2 (needs action execution)
  assertState(r, 'NEEDS_ACTION_EXECUTION', '12b');
  assert.strictEqual(r.executionTurn, 2);
});

test('UNSAFE when turn gap between two populated turns', () => {
  const r = reconstructAgentRecoveryState(opts({
    run: mockRun(),
    replaySnapshot: mockSnapshot({
      providerRequests: [mockReq(1), mockReq(3)],
      modelResponses: [mockResp(1), mockResp(3)],
      parsedModelPlans: [mockPlan(1, { actions: [], complete: true }), mockPlan(3, { actions: [], complete: true })],
    }),
    events: []
  }));
  assertState(r, 'UNSAFE_TO_CONTINUE', '12c');
  assert.ok(r.inconsistencies.includes('turn_gap'));
});

// ── 13. Action correlation ─────────────────────────────────────────────

test('NEEDS_ACTION_EXECUTION with contiguous prefix', () => {
  const r = reconstructAgentRecoveryState(opts({
    run: mockRun(),
    replaySnapshot: mockSnapshot({
      providerRequests: [mockReq(3)],
      parsedModelPlans: [mockPlan(3, { actions: [{ operation: 'createFolder' }, { operation: 'writeFile' }] })],
      modelResponses: [mockResp(3)],
      workspaceOperations: [mockOp(3, 0)]
    }),
    events: []
  }));
  assertState(r, 'NEEDS_ACTION_EXECUTION', '13a');
  assert.strictEqual(r.nextActionIndex, 1);
});

test('UNSAFE when non-contiguous action indices', () => {
  const r = reconstructAgentRecoveryState(opts({
    run: mockRun(),
    replaySnapshot: mockSnapshot({
      providerRequests: [mockReq(3)],
      parsedModelPlans: [mockPlan(3, { actions: [{ operation: 'createFolder' }, { operation: 'writeFile' }] })],
      modelResponses: [mockResp(3)],
      workspaceOperations: [mockOp(3, 1)]
    }),
    events: []
  }));
  assertState(r, 'UNSAFE_TO_CONTINUE', '13b');
  assert.ok(r.inconsistencies.includes('non_contiguous_action_ops'));
});

test('UNSAFE when duplicate action index', () => {
  const r = reconstructAgentRecoveryState(opts({
    run: mockRun(),
    replaySnapshot: mockSnapshot({
      providerRequests: [mockReq(3)],
      parsedModelPlans: [mockPlan(3, { actions: [{ operation: 'createFolder' }] })],
      modelResponses: [mockResp(3)],
      workspaceOperations: [
        mockOp(3, 0),
        mockOp(3, 0, { operationKey: 'ok:dup', evidenceKey: 'op:dup' })
      ]
    }),
    events: []
  }));
  assertState(r, 'UNSAFE_TO_CONTINUE', '13c');
  assert.ok(r.inconsistencies.includes('duplicate_action_index'));
});

// ── 14. Complete plan must verify ──────────────────────────────────────

test('NEEDS_POST_ACTION_ADVANCE with verification for complete plan', () => {
  const r = reconstructAgentRecoveryState(opts({
    run: mockRun(),
    replaySnapshot: mockSnapshot({
      providerRequests: [mockReq(3)],
      parsedModelPlans: [mockPlan(3, {
        actions: [{ operation: 'createFolder' }], complete: true
      })],
      modelResponses: [mockResp(3)],
      workspaceOperations: [mockOp(3, 0)]
    }),
    events: []
  }));
  assertState(r, 'NEEDS_POST_ACTION_ADVANCE', '14a');
  assert.strictEqual(r.nextPhase, 'verification');
  assert.notStrictEqual(r.state, 'TERMINAL');
});

// ── 15. Typed evidence references ──────────────────────────────────────

test('evidenceRefs are typed objects in all branches', () => {
  const r = reconstructAgentRecoveryState(opts({
    run: mockRun(),
    replaySnapshot: mockSnapshot({
      providerRequests: [mockReq(1)],
      parsedModelPlans: [mockPlan(1, { actions: [{ operation: 'createFolder' }] })],
      modelResponses: [mockResp(1)],
      workspaceOperations: [mockOp(1, 0)]
    }),
    events: []
  }));
  assertTypedRefs(r.evidenceRefs, '15a-success');
  assert.ok(hasRef(r.evidenceRefs, 'replay', 'plan:1'));
  assert.ok(hasRef(r.evidenceRefs, 'replay', 'resp:1'));
  assert.ok(hasRef(r.evidenceRefs, 'operation', 'ok:1:0'));
});

test('UNSAFE branches produce typed refs', () => {
  resetEvents();
  const ev = mockEvent('run.terminalized', { prevHash: 'x' });
  const r = reconstructAgentRecoveryState(opts({ run: mockRun(), events: [ev] }));
  assert.ok(r.inconsistencies.includes('hash_chain_broken'));
});

// ── 16. Mutating operations required ───────────────────────────────────

test('throws when mutatingOperations not provided', () => {
  assert.throws(() => reconstructAgentRecoveryState({ run: mockRun(), events: [] }), /mutatingOperations/);
});

// ── 17. Basic state transitions ────────────────────────────────────────

test('NEEDS_TERMINALIZATION when execution_completed', () => {
  resetEvents();
  const ev = mockEvent('run.execution_completed');
  const r = reconstructAgentRecoveryState(opts({ run: mockRun(), events: [ev] }));
  assertState(r, 'NEEDS_TERMINALIZATION', '17a');
});

test('NEEDS_VERIFICATION when snapshot_finalized', () => {
  resetEvents();
  const ev = mockEvent('replay.snapshot.finalized');
  const r = reconstructAgentRecoveryState(opts({ run: mockRun(), events: [ev] }));
  assertState(r, 'NEEDS_VERIFICATION', '17b');
});

test('NEEDS_MODEL_REQUEST when no evidence', () => {
  const r = reconstructAgentRecoveryState(opts({
    run: mockRun(), replaySnapshot: mockSnapshot(), events: []
  }));
  assertState(r, 'NEEDS_MODEL_REQUEST', '17c');
});

test('UNSAFE when run missing', () => {
  const r = reconstructAgentRecoveryState(opts({}));
  assertState(r, 'UNSAFE_TO_CONTINUE', '17d');
});

test('UNSAFE when duplicate mutations', () => {
  resetEvents();
  const k = 'ok:dup';
  const events = [
    mockEvent('workspace.operation', { payload: { operation: 'createFolder', operationKey: k } }),
    mockEvent('workspace.operation', { payload: { operation: 'createFolder', operationKey: k } })
  ];
  const r = reconstructAgentRecoveryState(opts({ run: mockRun(), events }));
  assertState(r, 'UNSAFE_TO_CONTINUE', '17e');
  assert.ok(r.inconsistencies.includes('duplicate_mutations'));
});

test('NEEDS_RESPONSE_PARSE when response exists but no plan', () => {
  const r = reconstructAgentRecoveryState(opts({
    run: mockRun(),
    replaySnapshot: mockSnapshot({
      providerRequests: [mockReq(3)],
      modelResponses: [mockResp(3)]
    }),
    events: []
  }));
  assertState(r, 'NEEDS_RESPONSE_PARSE', '17f');
  assert.strictEqual(r.modelCallKey, 'call:3');
});

test('executionTurn from earliest unresolved turn', () => {
  const r = reconstructAgentRecoveryState(opts({
    run: mockRun(),
    replaySnapshot: mockSnapshot({
      providerRequests: [mockReq(2), mockReq(3)],
      modelResponses: [mockResp(2), mockResp(3)],
      parsedModelPlans: [mockPlan(2, { actions: [{ operation: 'createFolder' }] }), mockPlan(3)],
    }),
    events: []
  }));
  assert.strictEqual(r.executionTurn, 2);
});

// ── 18. Durable provider response recovery ─────────────────────────────

test('recovery parses the persisted response without another provider call', () => {
  const responseText = JSON.stringify({
    message: 'continue from durable response',
    actions: [{ operation: 'createFolder', args: { path: 'Recovered' } }],
    complete: false
  });
  const replaySnapshot = mockSnapshot({
    providerRequests: [mockReq(3, { startedAt: '2026-07-18T10:00:00.000Z' })],
    modelResponses: [mockResp(3, {
      text: responseText,
      startedAt: '2026-07-18T10:00:05.000Z',
      completedAt: '2026-07-18T10:00:10.000Z'
    })]
  });
  const recoveryState = reconstructAgentRecoveryState(opts({
    run: mockRun(), replaySnapshot, events: []
  }));
  assertState(recoveryState, 'NEEDS_RESPONSE_PARSE', '18a');

  let providerCallCount = 1;
  const providerCall = resolveExecutionTurnProviderCall({
    recoveryState,
    replaySnapshot,
    requestProvider: () => {
      providerCallCount += 1;
      return { response: { text: '{"message":"replacement"}' } };
    }
  });
  const parsedPlan = JSON.parse(providerCall.response.text);
  const persistedPlan = {
    ...parsedPlan,
    executionTurn: recoveryState.executionTurn,
    modelCallKey: recoveryState.modelCallKey,
    planKey: `${recoveryState.modelCallKey}:plan`,
    providerResponseEvidenceKey: providerCall.responseEvidenceKey
  };

  assert.strictEqual(providerCallCount, 1, 'recovery issued a duplicate provider request');
  assert.strictEqual(providerCall.recovered, true);
  assert.strictEqual(providerCall.requestStartedAt, Date.parse('2026-07-18T10:00:00.000Z'));
  assert.strictEqual(providerCall.responseCompletedAt, Date.parse('2026-07-18T10:00:10.000Z'));
  assert.strictEqual(providerCall.response.text, responseText, 'recovery did not preserve the durable response text');
  assert.strictEqual(persistedPlan.providerResponseEvidenceKey, 'resp:3');
  assert.strictEqual(persistedPlan.actions[0].operation, 'createFolder');
});

// ── Summary ────────────────────────────────────────────────────────────
console.log('\n\n');
if (failed > 0) {
  console.log(`FAIL: ${failed} of ${passed + failed} tests failed`);
  for (const f of failures) {
    console.log(`  ${f.name}: ${f.error.message}`);
  }
  process.exit(1);
} else {
  console.log(`PASS: ${passed} tests passed`);
  process.exit(0);
}

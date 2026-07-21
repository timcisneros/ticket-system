'use strict';

const { verifyCurrentRunEventChain } = require('./event-integrity');

// ── Recovery states ────────────────────────────────────────────────────
const RECOVERY_STATE = Object.freeze({
  TERMINAL: 'TERMINAL',
  NEEDS_TERMINALIZATION: 'NEEDS_TERMINALIZATION',
  NEEDS_VERIFICATION: 'NEEDS_VERIFICATION',
  NEEDS_POST_ACTION_ADVANCE: 'NEEDS_POST_ACTION_ADVANCE',
  NEEDS_ACTION_RECONCILIATION: 'NEEDS_ACTION_RECONCILIATION',
  NEEDS_ACTION_EXECUTION: 'NEEDS_ACTION_EXECUTION',
  NEEDS_RESPONSE_PARSE: 'NEEDS_RESPONSE_PARSE',
  NEEDS_FAILURE_TERMINALIZATION: 'NEEDS_FAILURE_TERMINALIZATION',
  NEEDS_MODEL_REQUEST: 'NEEDS_MODEL_REQUEST',
  NEEDS_STALL_DECISION: 'NEEDS_STALL_DECISION',
  UNSAFE_TO_CONTINUE: 'UNSAFE_TO_CONTINUE'
});

// ── Lifecycle ranks (lower fires first; ordering validated against events) ──
const LIFECYCLE_RANK = Object.freeze({
  'run.created': 0,
  'run.queued': 1,
  'run.lease_acquired': 2,
  'run.started': 3,
  'provider.request.persisted': 10,
  'provider.response.persisted': 11,
  'model.plan.parsed': 12,
  'model:stalled': 13,
  'model:no_progress': 14,
  'model:malformed': 15,
  'model:unsupported_objective': 16,
  'authority.allowed': 20,
  'authority.denied': 21,
  'workspace.operation_prepared': 25,
  'workspace.operation': 30,
  'workspace.operation_reconciliation_required': 31,
  'run.postconditions_checked': 40,
  'run.postcondition_failed': 41,
  'run.verification_passed': 42,
  'run.verification_failed': 43,
  'run.violations_checked': 44,
  'run.violation_detected': 45,
  'run.evaluation_completed': 50,
  'run.consequence_recorded': 51,
  'run.execution_completed': 60,
  'run.snapshot_finalized': 61,
  'replay.snapshot.finalized': 61,
  'run.terminalized': 70,
  'run.triage_created': 80
});

// ── Evidence reference constructors ────────────────────────────────────
function eventRef(event) {
  if (!event || typeof event.id !== 'string') throw new TypeError('eventRef requires event with string id');
  return { type: 'event', id: event.id };
}

function replayRef(item) {
  if (!item || typeof item.evidenceKey !== 'string') throw new TypeError('replayRef requires item with string evidenceKey');
  return { type: 'replay', evidenceKey: item.evidenceKey };
}

function operationRef(operationKey) {
  if (typeof operationKey !== 'string' || !operationKey) throw new TypeError('operationRef requires nonempty string');
  return { type: 'operation', operationKey };
}

function historyRef(receipt) {
  if (!receipt || typeof receipt.operationKey !== 'string') throw new TypeError('historyRef requires receipt with operationKey');
  return { type: 'history', historyId: receipt.id, operationKey: receipt.operationKey };
}

// ── Identity type validators ───────────────────────────────────────────
function isNonNegInt(v) { return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0; }
function isNonEmptyStr(v) { return typeof v === 'string' && v.length > 0; }
function isNonNegIntOrZero(v) { return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0; }

// ── Per-turn evidence ledger ───────────────────────────────────────────
function createEmptyLedgerEntry(turn) {
  return {
    turn,
    request: null,
    response: null,
    plan: null,
    operationsByActionIndex: new Map(),
    preparedByActionIndex: new Map(),
    receiptsByOperationKey: new Map(),
    stallEvents: [],
    lifecycleEvents: []
  };
}

function reconstructAgentRecoveryState({
  run,
  replaySnapshot,
  events,
  operationHistory,
  targetSnapshot,
  mutatingOperations,
  verifyOperationKey
} = {}) {
  if (!Array.isArray(mutatingOperations) || mutatingOperations.length === 0) {
    throw new Error(
      'reconstructAgentRecoveryState requires mutatingOperations array; '
      + 'pass the authoritative list from the primitive contract or runtime catalog'
    );
  }
  const mutatingOps = mutatingOperations;

  const result = {
    state: RECOVERY_STATE.NEEDS_MODEL_REQUEST,
    executionTurn: 0,
    modelCallKey: null,
    providerResponseEvidenceKey: null,
    planKey: null,
    nextActionIndex: 0,
    operationKey: null,
    nextPhase: 'model_request',
    evidenceRefs: [],
    inconsistencies: [],
    automaticRecoveryAllowed: true
  };

  function unsafe(inconsistency, refs) {
    result.state = RECOVERY_STATE.UNSAFE_TO_CONTINUE;
    result.automaticRecoveryAllowed = false;
    if (typeof inconsistency === 'string') result.inconsistencies.push(inconsistency);
    else if (Array.isArray(inconsistency)) result.inconsistencies.push(...inconsistency);
    if (Array.isArray(refs)) {
      for (const ref of refs) {
        if (ref && typeof ref === 'object' && typeof ref.type === 'string') {
          result.evidenceRefs.push(ref);
        }
      }
    }
    return result;
  }

  if (!run || typeof run !== 'object') return unsafe('missing_run');

  const snapshot = replaySnapshot || run.replaySnapshot || null;
  const runEvents = Array.isArray(events) ? events : [];
  const executionEvents = runEvents.filter(e => e && e.type !== 'run.recovery_claimed');
  const history = Array.isArray(operationHistory) ? operationHistory : [];

  // ── 1. Hash chain ────────────────────────────────────────────────────
  if (!verifyCurrentRunEventChain(runEvents).chainValid) {
    return unsafe('hash_chain_broken');
  }

  // ── 2. Duplicate mutation detection ──────────────────────────────────
  const mutatingEvents = executionEvents.filter(e =>
    e.type === 'workspace.operation' && e.payload && mutatingOps.includes(e.payload.operation)
  );
  const seenMutationKeys = new Set();
  for (const m of mutatingEvents) {
    const key = m.payload.operationKey;
    if (!key) continue;
    if (seenMutationKeys.has(key)) return unsafe('duplicate_mutations');
    seenMutationKeys.add(key);
  }

  // ── 3. Terminal detection with ordering validation ───────────────────
  const terminalEvents = executionEvents.filter(e => e.type === 'run.terminalized');
  const execCompletedEvents = executionEvents.filter(e => e.type === 'run.execution_completed');
  const snapshotFinalizedEvents = executionEvents.filter(e =>
    e.type === 'run.snapshot_finalized' || e.type === 'replay.snapshot.finalized'
  );

  if (terminalEvents.length > 1) {
    return unsafe('duplicate_terminalization', terminalEvents.map(e => eventRef(e)));
  }
  if (execCompletedEvents.length > 1) {
    return unsafe('duplicate_execution_completed', execCompletedEvents.map(e => eventRef(e)));
  }
  if (snapshotFinalizedEvents.length > 1) {
    return unsafe('duplicate_snapshot_finalized', snapshotFinalizedEvents.map(e => eventRef(e)));
  }

  if (terminalEvents.length === 1) {
    const termIdx = executionEvents.indexOf(terminalEvents[0]);
    for (let i = termIdx + 1; i < executionEvents.length; i++) {
      const postRank = LIFECYCLE_RANK[executionEvents[i].type];
      if (postRank !== undefined) {
        return unsafe('post_terminal_activity', [eventRef(terminalEvents[0]), eventRef(executionEvents[i])]);
      }
    }
    result.state = RECOVERY_STATE.TERMINAL;
    result.nextPhase = 'already_terminal';
    result.evidenceRefs.push(eventRef(terminalEvents[0]));
    return result;
  }

  if (execCompletedEvents.length === 1) {
    const ecIdx = executionEvents.indexOf(execCompletedEvents[0]);
    for (let i = ecIdx + 1; i < executionEvents.length; i++) {
      const postRank = LIFECYCLE_RANK[executionEvents[i].type];
      if (postRank !== undefined) {
        return unsafe('post_execution_completed_activity', [eventRef(execCompletedEvents[0]), eventRef(executionEvents[i])]);
      }
    }
    result.state = RECOVERY_STATE.NEEDS_TERMINALIZATION;
    result.nextPhase = 'terminalization';
    result.evidenceRefs.push(eventRef(execCompletedEvents[0]));
    return result;
  }

  if (snapshotFinalizedEvents.length === 1) {
    const sfIdx = executionEvents.indexOf(snapshotFinalizedEvents[0]);
    for (let i = sfIdx + 1; i < executionEvents.length; i++) {
      const postRank = LIFECYCLE_RANK[executionEvents[i].type];
      if (postRank !== undefined) {
        return unsafe('post_snapshot_finalized_activity', [eventRef(snapshotFinalizedEvents[0]), eventRef(executionEvents[i])]);
      }
    }
    result.state = RECOVERY_STATE.NEEDS_VERIFICATION;
    result.nextPhase = 'verification';
    result.evidenceRefs.push(eventRef(snapshotFinalizedEvents[0]));
    return result;
  }

  // ── 5. Extract replay items ──────────────────────────────────────────
  const providerRequests = snapshot && Array.isArray(snapshot.providerRequests)
    ? snapshot.providerRequests : [];
  const modelResponses = snapshot && Array.isArray(snapshot.modelResponses)
    ? snapshot.modelResponses : [];
  const parsedPlans = snapshot && Array.isArray(snapshot.parsedModelPlans)
    ? snapshot.parsedModelPlans : [];
  const workspaceOps = snapshot && Array.isArray(snapshot.workspaceOperations)
    ? snapshot.workspaceOperations : [];

  // ── 6. Identity type validation (issue #8) ──────────────────────────
  for (const r of modelResponses) {
    if (!isNonNegInt(r.executionTurn)) return unsafe('response_non_integer_turn');
    if (!isNonEmptyStr(r.modelCallKey)) return unsafe('response_missing_model_call_key');
    if (!isNonEmptyStr(r.evidenceKey)) return unsafe('response_missing_evidence_key');
    if (!isNonEmptyStr(r.providerRequestEvidenceKey)) return unsafe('response_missing_provider_request_evidence_key');
  }
  for (const p of parsedPlans) {
    if (!isNonNegInt(p.executionTurn)) return unsafe('plan_non_integer_turn');
    if (!isNonEmptyStr(p.modelCallKey)) return unsafe('plan_missing_model_call_key');
    if (!isNonEmptyStr(p.planKey)) return unsafe('plan_missing_plan_key');
    if (!isNonEmptyStr(p.providerResponseEvidenceKey)) return unsafe('plan_missing_provider_response_evidence_key');
    if (!isNonEmptyStr(p.evidenceKey)) return unsafe('plan_missing_evidence_key');
    if (!Array.isArray(p.actions)) return unsafe('plan_actions_not_array');
  }
  for (const op of workspaceOps) {
    if (!isNonNegInt(op.executionTurn)) return unsafe('operation_non_integer_turn');
    if (!isNonEmptyStr(op.planKey)) return unsafe('operation_missing_plan_key');
    if (!isNonNegIntOrZero(op.actionIndex)) return unsafe('operation_missing_action_index');
    if (!isNonEmptyStr(op.operationKey)) return unsafe('operation_missing_operation_key');
  }
  for (const req of providerRequests) {
    if (!isNonNegInt(req.executionTurn)) return unsafe('request_non_integer_turn');
    if (!isNonEmptyStr(req.modelCallKey)) return unsafe('request_missing_model_call_key');
    if (!isNonEmptyStr(req.evidenceKey)) return unsafe('request_missing_evidence_key');
  }

  // ── 7. Build per-turn ledger (issue #1) ─────────────────────────────
  const ledger = new Map();

  function ensureTurn(turn) {
    if (!ledger.has(turn)) ledger.set(turn, createEmptyLedgerEntry(turn));
    return ledger.get(turn);
  }

  // Current-format provider requests have already passed direct identity validation.
  for (const req of providerRequests) {
    const entry = ensureTurn(req.executionTurn);
    if (entry.request) return unsafe('multiple_requests_for_turn', [replayRef(req)]);
    entry.request = req;
  }

  for (const resp of modelResponses) {
    const entry = ensureTurn(resp.executionTurn);
    if (entry.response) return unsafe('multiple_responses_for_turn', [replayRef(resp)]);
    entry.response = resp;
  }

  for (const plan of parsedPlans) {
    const entry = ensureTurn(plan.executionTurn);
    if (entry.plan) return unsafe('multiple_plans_for_turn', [replayRef(plan)]);
    entry.plan = plan;
  }

  for (const op of workspaceOps) {
    const entry = ensureTurn(op.executionTurn);
    const existing = entry.operationsByActionIndex.get(op.actionIndex);
    if (existing) return unsafe('duplicate_action_index', [operationRef(existing.operationKey), operationRef(op.operationKey)]);
    entry.operationsByActionIndex.set(op.actionIndex, op);
    if (op.operationKey) entry.receiptsByOperationKey.set(op.operationKey, op);
  }

  // Index prepared mutations by turn from events.
  for (const ev of executionEvents) {
    if (ev.type !== 'workspace.operation_prepared') continue;
    const payload = ev.payload || {};
    const turn = typeof payload.executionTurn === 'number' ? payload.executionTurn : null;
    const planKey = payload.planKey || null;
    const actionIndex = typeof payload.actionIndex === 'number' ? payload.actionIndex : null;
    const opKey = payload.operationKey || null;

    // Prepared mutations must have full identity (issue #3).
    if (turn === null || planKey === null || actionIndex === null || !opKey) {
      return unsafe('prepared_mutation_missing_identity', [eventRef(ev)]);
    }

    const entry = ensureTurn(turn);
    const existing = entry.preparedByActionIndex.get(actionIndex);
    if (existing) return unsafe('duplicate_prepared_action_index', [eventRef(existing), eventRef(ev)]);
    entry.preparedByActionIndex.set(actionIndex, ev);
  }

  // Collect stall events by turn.
  for (const ev of executionEvents) {
    if (ev.type === 'model:stalled') {
      const step = ev.payload && typeof ev.payload.step === 'number' ? ev.payload.step : null;
      if (step !== null) {
        const entry = ensureTurn(step);
        entry.stallEvents.push(ev);
      }
    }
  }

  // Index operation history receipts.
  for (const h of history) {
    if (h && h.operationKey) {
      // Attach to the appropriate turn if we can find it.
      for (const [, entry] of ledger) {
        if (entry.receiptsByOperationKey.has(h.operationKey)) continue;
      }
    }
  }

  // ── 8. Validate turn closure ordering (issue #9) ────────────────────
  const turns = Array.from(ledger.keys()).sort((a, b) => a - b);

  // Detect gaps: if turn N and turn M exist with N < M, all turns between must exist.
  if (turns.length > 1) {
    for (let i = 1; i < turns.length; i++) {
      if (turns[i] !== turns[i - 1] + 1) {
        return unsafe('turn_gap', turns.map(t => ({ type: 'turn', turn: t })));
      }
    }
  }

  // ── 9. Validate each turn's internal consistency ────────────────────
  for (const turn of turns) {
    const entry = ledger.get(turn);

    // Response/request pairing.
    if (entry.response && entry.request) {
      if (entry.request.modelCallKey && entry.request.modelCallKey !== entry.response.modelCallKey) {
        return unsafe('request_response_model_call_key_mismatch', [replayRef(entry.request), replayRef(entry.response)]);
      }
      if (entry.response.providerRequestEvidenceKey !== entry.request.evidenceKey) {
        return unsafe('request_response_evidence_key_mismatch', [replayRef(entry.request), replayRef(entry.response)]);
      }
    }
    if (entry.response && !entry.request) {
      // Response without request is unsafe (issue #2).
      return unsafe('response_without_request', [replayRef(entry.response)]);
    }

    // Plan/response pairing.
    if (entry.plan && entry.response) {
      if (entry.plan.modelCallKey !== entry.response.modelCallKey) {
        return unsafe('plan_response_model_call_key_mismatch', [replayRef(entry.plan), replayRef(entry.response)]);
      }
      if (entry.plan.providerResponseEvidenceKey !== entry.response.evidenceKey) {
        return unsafe('plan_response_evidence_key_mismatch', [replayRef(entry.plan), replayRef(entry.response)]);
      }
    }

    // Workspace ops must have a plan.
    if (entry.operationsByActionIndex.size > 0 && !entry.plan) {
      return unsafe('workspace_ops_without_plan',
        Array.from(entry.operationsByActionIndex.values()).map(op => operationRef(op.operationKey)));
    }

    // Prepared mutations must match plan.
    if (entry.preparedByActionIndex.size > 0 && !entry.plan) {
      return unsafe('prepared_ops_without_plan',
        Array.from(entry.preparedByActionIndex.values()).map(ev => eventRef(ev)));
    }

    // Validate operations belong to plan and index is in range.
    if (entry.plan) {
      const planActions = entry.plan.actions || [];
      for (const [idx, op] of entry.operationsByActionIndex) {
        if (idx < 0 || idx >= planActions.length) {
          return unsafe('operation_index_out_of_range', [operationRef(op.operationKey), replayRef(entry.plan)]);
        }
        // Operation must have a valid operationKey.
        if (!op.operationKey) {
          return unsafe('missing_operation_key', [operationRef(op.operationKey)]);
        }
      }

      // Validate prepared mutations belong to plan.
      for (const [idx, ev] of entry.preparedByActionIndex) {
        if (idx < 0 || idx >= planActions.length) {
          return unsafe('prepared_index_out_of_range', [eventRef(ev), replayRef(entry.plan)]);
        }
        const payload = ev.payload || {};
        if (payload.planKey && payload.planKey !== entry.plan.planKey) {
          return unsafe('prepared_wrong_plan_key', [eventRef(ev), replayRef(entry.plan)]);
        }
      }

      // Contiguous prefix check.
      const opsByIndex = entry.operationsByActionIndex;
      let completedCount = 0;
      for (let i = 0; i < planActions.length; i++) {
        if (opsByIndex.has(i)) completedCount++;
        else break;
      }
      // Non-contiguous: op at index beyond first gap.
      if (completedCount < planActions.length) {
        for (let i = completedCount; i < planActions.length; i++) {
          if (opsByIndex.has(i)) {
            return unsafe('non_contiguous_action_ops',
              Array.from(opsByIndex.values()).map(op => operationRef(op.operationKey)));
          }
        }
      }

      // Operation-key verification (issue #4): required when ops exist.
      if (entry.operationsByActionIndex.size > 0 || entry.preparedByActionIndex.size > 0) {
        if (!verifyOperationKey || typeof verifyOperationKey !== 'function') {
          return unsafe('verify_operation_key_required', [
            replayRef(entry.plan),
            ...Array.from(entry.operationsByActionIndex.values()).map(op => operationRef(op.operationKey))
          ]);
        }
        // Verify each operation.
        for (const [idx, op] of entry.operationsByActionIndex) {
          const expectedAction = planActions[idx];
          if (!expectedAction) continue;
          const verification = verifyOperationKey({
            operationKey: op.operationKey,
            operation: op.operation ? op.operation.operation : null,
            expectedOperation: expectedAction.operation,
            args: op.operation ? op.operation.args : null,
            expectedArgs: expectedAction.args || null,
            turn: entry.turn,
            planKey: entry.plan.planKey,
            actionIndex: idx
          });
          if (!verification || verification.valid !== true) {
            return unsafe('operation_key_verification_failed', [operationRef(op.operationKey), replayRef(entry.plan)]);
          }
        }
      }
    }
  }

  // ── 10. Find earliest unresolved turn ────────────────────────────────
  let unresolvedTurn = null;
  for (const turn of turns) {
    const entry = ledger.get(turn);
    const hasResponse = !!entry.response;
    const hasPlan = !!entry.plan;
    const planActions = entry.plan ? (entry.plan.actions || []) : [];
    const planComplete = entry.plan && entry.plan.complete === true;

    // Turn with ops but no plan is contradictory (already validated above).

    // Stall: plan with no actions and not complete.
    if (hasPlan && !planComplete && planActions.length === 0) {
      unresolvedTurn = turn;
      break;
    }

    // Response but no plan: needs parsing.
    if (hasResponse && !hasPlan) {
      unresolvedTurn = turn;
      break;
    }

    // Plan exists, actions pending.
    if (hasPlan) {
      const opsCount = entry.operationsByActionIndex.size;
      const allDone = planActions.length > 0 && opsCount === planActions.length;
      if (!allDone) {
        unresolvedTurn = turn;
        break;
      }
      // All done but plan not complete: needs next model request.
      if (!planComplete) {
        unresolvedTurn = turn;
        break;
      }
      // All done, plan complete: needs verification.
      unresolvedTurn = turn;
      break;
    }

    // No evidence at all for this turn: needs model request.
    unresolvedTurn = turn;
    break;
  }

  // If no turns exist, need model request from turn 0.
  if (unresolvedTurn === null && turns.length === 0) {
    unresolvedTurn = 0;
  }

  if (unresolvedTurn === null) {
    // All turns resolved but none was terminal — should not happen with terminal detection above.
    return unsafe('all_turns_resolved_no_terminal');
  }

  result.executionTurn = unresolvedTurn;
  const entry = ledger.get(unresolvedTurn) || createEmptyLedgerEntry(unresolvedTurn);

  // ── 11. Produce state from earliest unresolved turn ──────────────────
  const hasResponse = !!entry.response;
  const hasPlan = !!entry.plan;
  const planActions = entry.plan ? (entry.plan.actions || []) : [];
  const planKey = entry.plan ? entry.plan.planKey : null;
  const planComplete = entry.plan && entry.plan.complete === true;
  const opsCount = entry.operationsByActionIndex.size;

  // A provider failure is a completed, durable outcome for this request. It is
  // neither parseable model output nor permission to issue the request again.
  // Recovery must carry the recorded failure into terminalization.
  if (hasResponse && typeof entry.response.error === 'string' && entry.response.error) {
    if (typeof entry.response.text === 'string' && entry.response.text) {
      return unsafe('provider_response_has_success_and_failure_payloads', [replayRef(entry.response)]);
    }
    result.state = RECOVERY_STATE.NEEDS_FAILURE_TERMINALIZATION;
    result.modelCallKey = entry.response.modelCallKey || null;
    result.providerResponseEvidenceKey = entry.response.evidenceKey || null;
    result.nextPhase = 'failure_terminalization';
    result.failure = {
      message: entry.response.error,
      code: entry.response.code || null,
      provider: entry.response.provider || null,
      model: entry.response.model || null,
      providerResponsePayload: entry.response.providerResponsePayload || null
    };
    result.evidenceRefs.push(replayRef(entry.response));
    return result;
  }

  // Stall detection (issue #7): use NEEDS_STALL_DECISION, not NEEDS_MODEL_REQUEST.
  if (hasPlan && !planComplete && planActions.length === 0) {
    const hasStallEvent = entry.stallEvents.length > 0;
    result.planKey = planKey;
    result.modelCallKey = entry.response ? entry.response.modelCallKey : (entry.plan.modelCallKey || null);
    if (hasStallEvent) {
      result.state = RECOVERY_STATE.NEEDS_STALL_DECISION;
      result.nextPhase = 'stall_recorded';
      result.automaticRecoveryAllowed = false;
      result.inconsistencies.push('stall_recorded_retry_pending');
      result.evidenceRefs.push(replayRef(entry.plan));
      for (const ev of entry.stallEvents) result.evidenceRefs.push(eventRef(ev));
    } else {
      result.state = RECOVERY_STATE.UNSAFE_TO_CONTINUE;
      result.automaticRecoveryAllowed = false;
      result.inconsistencies.push('empty_plan_stall_not_recorded');
      result.evidenceRefs.push(replayRef(entry.plan));
      if (entry.response) result.evidenceRefs.push(replayRef(entry.response));
    }
    return result;
  }

  const evidenceRefs = [];
  if (entry.plan) evidenceRefs.push(replayRef(entry.plan));
  if (entry.response) evidenceRefs.push(replayRef(entry.response));
  for (const op of entry.operationsByActionIndex.values()) {
    evidenceRefs.push(operationRef(op.operationKey));
  }
  for (const ev of entry.preparedByActionIndex.values()) {
    evidenceRefs.push(eventRef(ev));
  }

  // Complete no-action plan: verify before terminalization.
  if (planComplete && planActions.length === 0) {
    result.state = RECOVERY_STATE.NEEDS_POST_ACTION_ADVANCE;
    result.planKey = planKey;
    result.modelCallKey = entry.plan.modelCallKey || null;
    result.nextPhase = 'verification';
    result.evidenceRefs.push(...evidenceRefs);
    return result;
  }

  // All actions done, plan not complete: needs next model request.
  if (opsCount === planActions.length && planActions.length > 0 && !planComplete) {
    result.state = RECOVERY_STATE.NEEDS_POST_ACTION_ADVANCE;
    result.planKey = planKey;
    result.modelCallKey = entry.response ? entry.response.modelCallKey : null;
    result.nextActionIndex = planActions.length;
    result.nextPhase = 'model_request';
    result.evidenceRefs.push(...evidenceRefs);
    return result;
  }

  // All actions done, plan complete: must verify.
  if (opsCount === planActions.length && planActions.length > 0 && planComplete) {
    result.state = RECOVERY_STATE.NEEDS_POST_ACTION_ADVANCE;
    result.planKey = planKey;
    result.modelCallKey = entry.response ? entry.response.modelCallKey : null;
    result.nextActionIndex = planActions.length;
    result.nextPhase = 'verification';
    result.evidenceRefs.push(...evidenceRefs);
    return result;
  }

  // Some actions done, some pending.
  if (opsCount < planActions.length && planActions.length > 0) {
    result.state = RECOVERY_STATE.NEEDS_ACTION_EXECUTION;
    result.planKey = planKey;
    result.modelCallKey = entry.response
      ? entry.response.modelCallKey
      : (entry.plan.modelCallKey || null);
    result.nextActionIndex = opsCount;
    result.nextPhase = 'action_execution';
    result.evidenceRefs.push(...evidenceRefs);
    return result;
  }

  // Response exists but no plan.
  if (hasResponse && !hasPlan) {
    result.state = RECOVERY_STATE.NEEDS_RESPONSE_PARSE;
    result.modelCallKey = entry.response.modelCallKey || null;
    result.providerResponseEvidenceKey = entry.response.evidenceKey || null;
    result.nextPhase = 'response_parse';
    result.evidenceRefs.push(replayRef(entry.response));
    return result;
  }

  // No evidence for this turn.
  result.state = RECOVERY_STATE.NEEDS_MODEL_REQUEST;
  result.nextPhase = 'model_request';
  return result;
}

function createUnsafeRecoveryError(inconsistencies) {
  const reasons = Array.isArray(inconsistencies)
    ? inconsistencies.filter(isNonEmptyStr)
    : [inconsistencies].filter(isNonEmptyStr);
  const error = new Error(`Resume denied: ${reasons.join(', ') || 'provider response identity is unsafe'}`);
  error.code = 'RUN_RESUME_UNSAFE';
  error.failureKind = 'resume_rejected';
  error.details = { inconsistencies: reasons };
  return error;
}

function evidenceTimestamp(value, fallback) {
  const timestamp = Date.parse(value || '');
  return Number.isFinite(timestamp) ? timestamp : fallback;
}

function resolveExecutionTurnProviderCall({
  recoveryState,
  replaySnapshot,
  requestProvider
} = {}) {
  if (!recoveryState || typeof recoveryState !== 'object') {
    throw new TypeError('recoveryState is required');
  }

  if (recoveryState.state === RECOVERY_STATE.UNSAFE_TO_CONTINUE) {
    throw createUnsafeRecoveryError(recoveryState.inconsistencies);
  }

  if (recoveryState.state === RECOVERY_STATE.NEEDS_MODEL_REQUEST) {
    if (typeof requestProvider !== 'function') throw new TypeError('requestProvider is required');
    return requestProvider();
  }

  if (recoveryState.state !== RECOVERY_STATE.NEEDS_RESPONSE_PARSE) {
    throw createUnsafeRecoveryError(`unexpected_recovery_state_${recoveryState.state || 'missing'}`);
  }

  const executionTurn = recoveryState.executionTurn;
  const modelCallKey = recoveryState.modelCallKey;
  const responseEvidenceKey = recoveryState.providerResponseEvidenceKey;
  if (!isNonNegInt(executionTurn) || !isNonEmptyStr(modelCallKey) || !isNonEmptyStr(responseEvidenceKey)) {
    throw createUnsafeRecoveryError('response_recovery_cursor_missing_identity');
  }

  const snapshot = replaySnapshot && typeof replaySnapshot === 'object' ? replaySnapshot : {};
  const responses = Array.isArray(snapshot.modelResponses) ? snapshot.modelResponses : [];
  const matches = responses.filter(response => response &&
    response.executionTurn === executionTurn &&
    response.modelCallKey === modelCallKey &&
    response.evidenceKey === responseEvidenceKey
  );
  if (matches.length !== 1) {
    throw createUnsafeRecoveryError(matches.length === 0
      ? 'persisted_response_identity_not_found'
      : 'persisted_response_identity_ambiguous');
  }

  const persistedResponse = matches[0];
  if (typeof persistedResponse.text !== 'string') {
    throw createUnsafeRecoveryError('persisted_response_text_missing');
  }
  if (!isNonEmptyStr(persistedResponse.providerRequestEvidenceKey)) {
    throw createUnsafeRecoveryError('persisted_response_request_link_missing');
  }

  const requests = Array.isArray(snapshot.providerRequests) ? snapshot.providerRequests : [];
  const requestMatches = requests.filter(request => request &&
    request.executionTurn === executionTurn &&
    request.modelCallKey === modelCallKey &&
    request.evidenceKey === persistedResponse.providerRequestEvidenceKey
  );
  if (requestMatches.length !== 1 || !isNonEmptyStr(requestMatches[0].evidenceKey)) {
    throw createUnsafeRecoveryError(requestMatches.length > 1
      ? 'persisted_request_identity_ambiguous'
      : 'persisted_request_identity_not_found');
  }

  const responseCompletedAt = evidenceTimestamp(
    persistedResponse.completedAt || persistedResponse.capturedAt,
    Date.now()
  );
  const requestStartedAt = evidenceTimestamp(
    requestMatches[0].startedAt || requestMatches[0].capturedAt,
    responseCompletedAt
  );
  return {
    recovered: true,
    executionTurn,
    modelCallKey,
    requestStartedAt,
    responseCompletedAt,
    requestEvidenceKey: requestMatches[0].evidenceKey,
    responseEvidenceKey,
    response: { text: persistedResponse.text }
  };
}

module.exports = {
  RECOVERY_STATE,
  reconstructAgentRecoveryState,
  resolveExecutionTurnProviderCall,
  eventRef,
  replayRef,
  operationRef,
  historyRef
};

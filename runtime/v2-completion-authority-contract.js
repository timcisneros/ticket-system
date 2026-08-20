'use strict';

// Shared v2 completion authority evaluator.
//
// T2 frozen semantics: this single pure canonical function is the SHARED RULE
// between settlement and future cancellation. Both paths must reach identical
// completion-authority verdicts given identical CURRENT durable facts.
//
// ── What the persisted aggregateDecision IS (derived from source) ────────────
//
// The stored aggregatePlanDecision is a MATERIALIZED PROJECTION over durable
// leaf evidence, not an independent authority:
//
//   * It is written by exactly one writer — _reconcileLeafItemsLocked — which
//     re-derives it from the durable leaf evidence and re-persists it whenever
//     the facts moved (the unchanged-check compares status and per-item
//     dispositions, not wall clocks).
//   * It may legitimately become STALE while evidence advances: run statuses
//     advance pending -> running -> terminal, and run_consequences rows are
//     insertable at any time after the run is terminal (the 002 terminal guard
//     requires terminality, not terminalization-order), so a persisted
//     `pending`/`running`/`interrupted` aggregate can face a fresh `completed`
//     derivation. `interrupted` is refreshable for the same reason a decision
//     may arrive late, and because an interrupted attempt projects the Ticket
//     back to `open` (recovery, not terminalization).
//   * normalizeAggregatePlanDecision proves STRUCTURE, INTEGRITY and BINDING
//     (exact fields, re-derived projections, decisionHash, planHash/planId
//     identity). It does NOT prove freshness against current evidence — the
//     evidence lives outside the aggregate object. allocationPlanFromRow runs
//     it on every row read, so a malformed or misbound stored aggregate is an
//     INTEGRITY FAILURE that aborts the reading transaction before any gate;
//     it is never silently reinterpreted as "not authority, fresh decides".
//   * TERMINAL aggregates (`completed`, `failed`) are final by construction of
//     their inputs: terminal run statuses have empty transition sets,
//     decisions are write-once per run, and leaf lineage is CLOSED — the
//     binding on an existing Run is immutable (transitionRun refuses
//     leafRunBinding patches: RUN_LEAF_LINEAGE_IMMUTABLE) and no NEW Run
//     bound to an already-admitted plan/item can be admitted, because the
//     single Run INSERT funnel (createRun) refuses record-carried
//     leafRunBinding outside the canonical structured leaf admission
//     (RUN_LEAF_LINEAGE_NOT_CALLER_OWNED), which itself refuses any second
//     admission (plan_not_pending once the plan has settled; foreign or
//     incomplete leaf-set refusals while pending). A structurally valid
//     TERMINAL aggregate that conflicts with current evidence is therefore an
//     integrity contradiction — unreachable through legitimate channels — and
//     this evaluator refuses it rather than choosing whichever side is
//     convenient. The closure is proven by falsification in
//     scripts/t2-lineage-closure-postgres-test.js, which rebuilds a fully
//     valid binding + governed envelope from durable public data and attempts
//     the smuggle through every admission seam.
//
// ── The canonical question ───────────────────────────────────────────────────
//
// The shared question is NOT "does the persisted aggregate equal the fresh
// aggregate?" It is:
//
//   Given the currently durable authoritative evidence under lock, is
//   completion already deterministically established?
//
// Verdict rule (settlement and cancellation compute it identically):
//
//   1. Validate any persisted aggregate against the plan. Malformed or
//      misbound persisted authority THROWS — the same integrity failure the
//      production row read raises — and is never consumed as fresh truth.
//   2. Independently derive the CURRENT aggregate from the current durable
//      leaf/member evidence (the exact extracted production logic).
//   3. completionInevitable is determined by the CURRENT derivation, EXCEPT
//      when a structurally valid persisted TERMINAL aggregate conflicts with
//      it: that is an integrity contradiction and the answer is a refusal
//      (completionInevitable=false, persistedState='terminal_conflict').
//
// A stale NONTERMINAL materialization therefore never blocks completion: if
// settlement would deterministically refresh it to `completed` with no new
// external or semantic fact, completion is already inevitable, and a future
// cancellation consumer reading the same durable facts must refuse to cancel.
// Transaction scheduling may serialize the materialization write; it may not
// choose between CANCELED and COMPLETED when the current durable evidence
// already determines completion.
//
// Persistence remains downstream in _reconcileLeafItemsLocked. This function
// is read-only.

const {
  deriveLeafItemDisposition,
  buildAggregatePlanDecision,
  normalizeAggregatePlanDecision,
  normalizeLeafRunBinding
} = require('./structured-allocation-leaf-run-contract');

const TERMINAL_AGGREGATE_STATUSES = Object.freeze(new Set(['completed', 'failed']));
const NONTERMINAL_AGGREGATE_STATUSES = Object.freeze(['pending', 'running', 'interrupted']);

class V2CompletionAuthorityError extends TypeError {
  constructor(code, message) {
    super(message);
    this.name = 'V2CompletionAuthorityError';
    this.code = code;
  }
}

function positiveSafeInteger(value, label) {
  const parsed = typeof value === 'string' && /^[1-9]\d*$/.test(value)
    ? Number(value)
    : value;
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new V2CompletionAuthorityError(
      'V2_COMPLETION_AUTHORITY_INVALID',
      `${label} must be a positive safe integer`
    );
  }
  return parsed;
}

// Reduce member runs to the v2 leaf subset (those carrying an immutable leaf
// binding to this plan). Same semantics as the inline owner in
// _reconcileLeafItemsLocked, including the PRODUCTION run shape: memberRuns
// are runFromRow rows, whose body fields (leafRunBinding,
// declaredWorkSnapshot, completionAuthoritySnapshot, governedProgressBlock)
// are flattened to the top level.
function selectLeafRuns(memberRuns, leafPlan) {
  const leaves = [];
  const foreign = [];
  for (const run of memberRuns) {
    const binding = run && run.leafRunBinding;
    if (!binding || binding.allocationPlanId !== leafPlan.id) {
      foreign.push(run);
      continue;
    }
    leaves.push({
      run,
      binding: normalizeLeafRunBinding(binding, {
        expectedRunId: run.id,
        expectedTicketId: leafPlan.ticketId,
        expectedPlanId: leafPlan.id,
        expectedPlanHash: leafPlan.planHash
      })
    });
  }
  return { leaves, foreign };
}

function computeAggregateDecision(leafPlan, leaves, decisionsByRunId, decidedAt) {
  const byItem = new Map();
  for (const leaf of leaves) {
    const existing = byItem.get(leaf.binding.allocationItemId) || [];
    existing.push(leaf);
    byItem.set(leaf.binding.allocationItemId, existing);
  }
  const missing = leafPlan.items
    .map(item => item.allocationItemId)
    .filter(allocationItemId => !byItem.has(allocationItemId));
  if (missing.length > 0) {
    const error = new V2CompletionAuthorityError(
      'V2_LEAF_BINDING_INCOMPLETE',
      `Allocation plan ${leafPlan.id} has no leaf run for item(s): ${missing.join(', ')}`
    );
    error.code = 'STRUCTURED_ALLOCATION_LEAF_BINDING_INCOMPLETE';
    throw error;
  }
  const aggregateItems = leafPlan.items.map(item => {
    const lineage = [...byItem.get(item.allocationItemId)]
      .sort((left, right) => left.run.id - right.run.id);
    const current = lineage[lineage.length - 1];
    const decision = decisionsByRunId.get(current.run.id) || null;
    const disposition = deriveLeafItemDisposition({
      binding: current.binding,
      runId: current.run.id,
      runTicketId: current.run.ticketId,
      runStatus: current.run.status,
      runDeclaredWorkHash: current.run.declaredWorkSnapshot
        ? current.run.declaredWorkSnapshot.contractHash
        : null,
      runCompletionAuthorityHash: current.run.completionAuthoritySnapshot
        ? current.run.completionAuthoritySnapshot.objectiveContractHash
        : null,
      decision,
      governedProgressBlock: current.run.governedProgressBlock || null
    });
    return {
      allocationItemId: item.allocationItemId,
      assignedAgentId: item.assignedAgentId,
      runId: current.run.id,
      runLineage: lineage.map(leaf => leaf.run.id),
      itemStatus: disposition.itemStatus,
      completionDecisionHash: disposition.completionDecisionHash,
      reason: disposition.reason
    };
  });
  return buildAggregatePlanDecision({
    ticketId: leafPlan.ticketId,
    allocationPlanId: leafPlan.id,
    planHash: leafPlan.planHash,
    planningAdmissionHash: leafPlan.planningProvenance.admissionHash,
    items: aggregateItems,
    decidedAt
  });
}

// Does the stored materialization already represent the current derivation?
// Mirrors the _reconcileLeafItemsLocked unchanged-check: aggregate status plus
// per-item status, decision hash and reason. decidedAt is deliberately
// excluded — the wall clock alone never makes a materialization stale.
function materializationIsCurrent(stored, current) {
  if (stored.aggregateStatus !== current.aggregateStatus) return false;
  if (stored.items.length !== current.items.length) return false;
  return stored.items.every((item, index) =>
    item.allocationItemId === current.items[index].allocationItemId &&
    item.itemStatus === current.items[index].itemStatus &&
    item.completionDecisionHash === current.items[index].completionDecisionHash &&
    item.reason === current.items[index].reason);
}

// Pure v2 completion-authority evaluator. Both settlement and future
// cancellation call this function with the same current durable facts; the
// completion verdicts are mechanically identical. The two consumers differ
// only in side effects: settlement may refresh the materialization and settle;
// cancellation is read-only and must refuse when completionInevitable is true.
//
// persistedAggregateDecision, when present, must be the raw stored
// aggregatePlanDecision object. It is validated against leafPlan.planHash and
// leafPlan.id via normalizeAggregatePlanDecision EXACTLY as the production row
// read validates it: a malformed or misbound aggregate THROWS an integrity
// failure (mirroring allocationPlanFromRow aborting the reading transaction)
// and is never silently demoted to "not authority".
//
// Result (frozen):
//   {
//     completionInevitable: boolean,
//     reason: string,
//     currentAggregate: buildAggregatePlanDecision output derived from the
//                       CURRENT durable evidence (null when no leaves exist),
//     persistedAggregate: normalized stored materialization, or null,
//     persistedState: 'absent' | 'current' | 'stale' | 'terminal_conflict',
//     materializationRequired: whether settlement's reconciliation would
//                              rewrite the stored materialization,
//     planId, ticketId
//   }
function evaluateV2CompletionAuthority({
  leafPlan,
  memberRuns,
  decisionsByRunId,
  persistedAggregateDecision = null,
  decidedAt = null
}) {
  if (!leafPlan || typeof leafPlan !== 'object') {
    throw new V2CompletionAuthorityError(
      'V2_COMPLETION_AUTHORITY_INVALID',
      'leafPlan must be an object'
    );
  }
  if (!Array.isArray(memberRuns)) {
    throw new V2CompletionAuthorityError(
      'V2_COMPLETION_AUTHORITY_INVALID',
      'memberRuns must be an array'
    );
  }
  if (!(decisionsByRunId instanceof Map)) {
    throw new V2CompletionAuthorityError(
      'V2_COMPLETION_AUTHORITY_INVALID',
      'decisionsByRunId must be a Map<runId, completion decision>'
    );
  }
  const planId = positiveSafeInteger(leafPlan.id, 'leafPlan.id');
  const ticketId = positiveSafeInteger(leafPlan.ticketId, 'leafPlan.ticketId');

  // STEP 1: persisted authority is validated FIRST and fail-closed. This is
  // the same integrity behavior the production row read enforces
  // (allocationPlanFromRow -> normalizeAggregatePlanDecision): a malformed or
  // misbound stored aggregate is an integrity failure, never a signal to fall
  // back to the fresh derivation.
  let persistedAggregate = null;
  if (persistedAggregateDecision !== null && persistedAggregateDecision !== undefined) {
    persistedAggregate = normalizeAggregatePlanDecision(persistedAggregateDecision, {
      expectedPlanHash: leafPlan.planHash,
      expectedPlanId: leafPlan.id
    });
  }

  const { leaves, foreign: _foreign } = selectLeafRuns(memberRuns, leafPlan);
  if (leaves.length === 0) {
    // Leaf admission has not happened yet. No decision can be derived from
    // per-item evidence alone; matches the early return in
    // _reconcileLeafItemsLocked, which also writes nothing in this state.
    return Object.freeze({
      completionInevitable: false,
      reason: 'no_leaves',
      currentAggregate: null,
      persistedAggregate,
      persistedState: persistedAggregate === null ? 'absent' : 'stale',
      materializationRequired: false,
      planId,
      ticketId
    });
  }

  // STEP 2: independently derive the CURRENT aggregate from the current
  // durable evidence. The decidedAt timestamp is supplied by the caller
  // (settlement passes the database clock; cancellation passes whatever
  // timestamp it is computing under).
  const currentAggregate = computeAggregateDecision(
    leafPlan, leaves, decisionsByRunId, decidedAt || new Date().toISOString()
  );
  const currentCompleted = currentAggregate.aggregateStatus === 'completed';

  // STEP 3: the verdict from CURRENT durable authority.
  if (persistedAggregate === null) {
    // No materialization yet: the current derivation alone decides. Settlement
    // persists the materialization in the same transaction that consumes it.
    return Object.freeze({
      completionInevitable: currentCompleted,
      reason: currentCompleted
        ? 'fresh_candidate_completed'
        : 'fresh_candidate_not_completed',
      currentAggregate,
      persistedAggregate: null,
      persistedState: 'absent',
      materializationRequired: true,
      planId,
      ticketId
    });
  }

  if (materializationIsCurrent(persistedAggregate, currentAggregate)) {
    // The stored materialization already represents the current evidence;
    // reconciliation is a no-op and the agreed status decides.
    return Object.freeze({
      completionInevitable: currentCompleted,
      reason: currentCompleted
        ? 'aggregate_completed_agreement'
        : `aggregate_${persistedAggregate.aggregateStatus}`,
      currentAggregate,
      persistedAggregate,
      persistedState: 'current',
      materializationRequired: false,
      planId,
      ticketId
    });
  }

  if (TERMINAL_AGGREGATE_STATUSES.has(persistedAggregate.aggregateStatus)) {
    // A structurally valid TERMINAL aggregate conflicting with the current
    // derivation. Terminal aggregates are final by construction of their
    // immutable inputs (terminal runs, write-once decisions) plus mechanical
    // leaf-lineage closure (binding patches refused; the Run INSERT funnel
    // refuses record-carried bindings outside canonical leaf admission,
    // which refuses any second admission), so this state is unreachable
    // through legitimate channels: it is an integrity contradiction. Refuse
    // — do not complete on the fresh side and do not let the stale terminal
    // side veto silently. The refusal is reported, never consumed as clean
    // authority by either
    // consumer.
    return Object.freeze({
      completionInevitable: false,
      reason: 'terminal_aggregate_conflict',
      currentAggregate,
      persistedAggregate,
      persistedState: 'terminal_conflict',
      materializationRequired: true,
      planId,
      ticketId
    });
  }

  // Stale NONTERMINAL materialization (pending/running/interrupted). The
  // current durable evidence is authoritative: completion inevitability is
  // determined by the current derivation, and settlement's reconciliation
  // refreshes the materialization with no new semantic fact. A stale
  // materialization must never let a future cancellation beat a completion
  // that the current durable evidence already determines.
  return Object.freeze({
    completionInevitable: currentCompleted,
    reason: 'stale_materialization',
    currentAggregate,
    persistedAggregate,
    persistedState: 'stale',
    materializationRequired: true,
    planId,
    ticketId
  });
}

module.exports = {
  V2CompletionAuthorityError,
  TERMINAL_AGGREGATE_STATUSES,
  NONTERMINAL_AGGREGATE_STATUSES,
  selectLeafRuns,
  computeAggregateDecision,
  materializationIsCurrent,
  evaluateV2CompletionAuthority
};

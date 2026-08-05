'use strict';

// Tranche 5 — the ONE canonical verified-progress projection.
//
// Every surface that shows governed progress — Ticket page, Ticket API, Run
// page, Run API, replay, CLI — reads through here. None reconstructs progress
// for itself. The Tranche 4 economics seam exists for the same reason and the
// reason is the same one: a page that recomputes a decision differently from
// the gate that enforced it will eventually tell an operator a Run is running
// when the database has already stopped it.
//
// WHAT THIS IS BUILT FROM. Durable rows and stored contracts only:
//
//   run.governedExecution.progressControlPolicy -> the CAPTURED tolerance
//   readGovernedRunProgressState                -> durable cutoff + epoch + rows
//   evaluateGovernedRunProgress                 -> the deterministic replay
//   run.body.governedProgressBlock              -> the persisted stop, if any
//
// Every stored contract passes its existing normalizer before it is projected.
// A damaged envelope refuses here rather than being rendered as though it were
// sound: partial governed state is not historical state.
//
// WHAT THIS NEVER DOES:
//
//   * decide anything — it reports the decision the gate already made, and
//     never re-derives one with a fresh clock or a fresh cutoff;
//   * collapse the four progress levels into a single "progress" number, which
//     would erase exactly the distinction the tranche exists to make;
//   * invent a monetary total. Micro-USD shown here is the same durable
//     accounting fact Tranche 4 projects; a second total that disagreed with
//     the role accounts would be worse than no total at all;
//   * expose model prose, request bytes, credentials or authorization headers.

const {
  deepFreeze,
  hashCanonical
} = require('./declared-work-contract');
const {
  CHURN_STOP_REASONS,
  normalizeProgressControlPolicy
} = require('./churn-decision-contract');
const {
  normalizeGovernedProgressBlock
} = require('./governed-progress-block-contract');
const {
  normalizeVerifiedProgressProjection
} = require('./verified-progress-contract');

// The four levels, kept apart at every level of the projection. `completion` is
// present so the vocabulary is complete and so nothing here can be mistaken for
// owning it — completion authority stays with the Tranche 3 decision contracts.
const PROGRESS_LEVELS = Object.freeze([
  'activity',
  'candidate_progress',
  'verified_progress',
  'completion'
]);

// Asserted by the projection tests against real output rather than trusted to
// reviewers. Extends the Tranche 4 list with the Tranche 5 surfaces that could
// leak: model text, and the prompt/response bodies a window is built from.
const NEVER_PROJECTED = Object.freeze([
  'apiKey', 'authorization', 'Authorization', 'bearer', 'Bearer',
  'serializedRequest', 'preparedRequest', 'credentials',
  'canonicalBody', 'responseText', 'modelText', 'prose', 'completionText'
]);

class VerifiedProgressProjectionError extends Error {
  constructor(code, message, detail = {}) {
    super(message);
    this.name = 'VerifiedProgressProjectionError';
    this.code = code;
    this.detail = detail;
  }
}

function fail(message, detail = {}) {
  throw new VerifiedProgressProjectionError(
    'VERIFIED_PROGRESS_PROJECTION_INVALID', message, detail);
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

// A governed structured leaf Run is the ONLY thing this projects. Both halves
// of the pairing are required: Tranche 4 made partial governed state an
// integrity failure rather than a historical shape, and this seam must not
// quietly re-admit it as "not governed".
function isGovernedStructuredLeafRun(run) {
  if (!isPlainObject(run)) return false;
  const governed = run.governedExecution;
  const binding = run.leafRunBinding;
  return Boolean(governed) && Boolean(binding);
}

function hasAnyGovernedState(run) {
  if (!isPlainObject(run)) return false;
  return Boolean(run.governedExecution) || Boolean(run.leafRunBinding);
}

// The cutoff has no stored hash of its own — it is a component of the block
// hash. For surfaces that need to say "this reading and that reading are the
// same reading", the canonical hash of the cutoff document is that identity.
// Derived, never stored, so it cannot drift from the document it names.
function cutoffIdentity(cutoff) {
  return hashCanonical(cutoff);
}

function projectCutoff(cutoff) {
  if (!isPlainObject(cutoff)) fail('a progress cutoff document is required');
  return deepFreeze({
    receiptCutoff: cutoff.receiptCutoff,
    reservationCutoff: cutoff.reservationCutoff,
    budgetCutoff: cutoff.budgetCutoff,
    // The canonical postcondition-evidence bound. Verified progress is credited
    // only from evidence at or below this id.
    postconditionEvidenceCutoff: cutoff.postconditionEvidenceCutoff,
    // The DATABASE instant this evaluation was taken at. Never the process
    // clock — see `readGovernedRunProgressState`.
    evaluatedAt: cutoff.evaluatedAt,
    cutoffIdentity: cutoffIdentity(cutoff)
  });
}

function projectPolicy(policy) {
  const controls = normalizeProgressControlPolicy(policy);
  return deepFreeze({
    progressPolicyHash: controls.policyHash,
    policyVersion: controls.version,
    maximumConsecutiveNoProgressWindows:
      controls.maximumConsecutiveNoProgressWindows,
    maximumRepeatedMutations: controls.maximumRepeatedMutations,
    maximumFailedOperationStreak: controls.maximumFailedOperationStreak,
    maximumMutationReversals: controls.maximumMutationReversals,
    maximumInspectionOnlyStreak: controls.maximumInspectionOnlyStreak,
    maximumCumulativeExecutionDurationMs:
      controls.maximumCumulativeExecutionDurationMs,
    resourceDimensions: controls.resourceDimensions
  });
}

function projectSiblingDependency(sibling) {
  if (!sibling) return null;
  return deepFreeze({
    requestedPath: sibling.requestedPath,
    siblingAllocationItemId: sibling.siblingAllocationItemId,
    siblingRunId: sibling.siblingRunId,
    siblingOwnedScope: sibling.siblingOwnedScope,
    // Present ONLY when the sibling is genuinely complete under Tranche 3
    // authority. A blocked read cites no completion decision.
    siblingCompletionDecisionHash: sibling.siblingCompletionDecisionHash,
    siblingCompletionState: sibling.siblingCompletionState
  });
}

function projectBlock(storedBlock) {
  if (!storedBlock) return null;
  // Normalized, which re-verifies that the stored block hash covers its own
  // fields. A tampered block refuses here instead of being displayed.
  const block = normalizeGovernedProgressBlock(storedBlock);
  return deepFreeze({
    blockHash: block.blockHash,
    reason: block.reason,
    decision: block.decision,
    blockedAt: block.blockedAt,
    churnDecisionHash: block.churnDecisionHash,
    verifiedProgressProjectionHash: block.verifiedProgressProjectionHash,
    progressPolicyHash: block.progressPolicyHash,
    executionEpochAt: block.executionEpochAt,
    cutoff: projectCutoff(block.cutoff),
    cumulativeResources: block.cumulativeResources,
    consecutiveNoProgressWindows: block.consecutiveNoProgressWindows,
    siblingDependency: projectSiblingDependency(block.siblingDependency)
  });
}

// ── Run level ───────────────────────────────────────────────────────────────
//
// Returns null for a Run that is not a governed structured leaf Run, and THROWS
// for one that is governed but damaged. The difference is the whole point: a
// direct, v1, workflow, browser, process, simulation or compiler Run
// legitimately has nothing to show, while a governed Run with malformed
// progress state has something wrong that must not be rendered as absence.

// Terminal lifecycle states, named locally so this module does not depend on a
// contract it otherwise has no reason to import.
const TERMINAL_RUN_STATUSES = Object.freeze(['completed', 'failed', 'interrupted']);

function projectRunVerifiedProgress({
  run,
  evaluation = null,
  storedBlock = null,
  progressState = null
} = {}) {
  if (!hasAnyGovernedState(run)) return null;
  if (!isGovernedStructuredLeafRun(run)) {
    // Half-governed. Tranche 4 already refuses this at dispatch; refusing here
    // too keeps a broken Run from appearing on a page as an ordinary one.
    fail('a governed structured leaf Run requires both governed execution ' +
      'authority and a leaf run binding', { runId: run.id || null });
  }

  const policy = projectPolicy(run.governedExecution.progressControlPolicy);
  const block = projectBlock(storedBlock);

  // A Run may be projected before it has ever been evaluated. That is an
  // honest absence, not an error, and it is reported as such rather than as a
  // zeroed-out evaluation that would read like a real measurement.
  if (!evaluation) {
    return deepFreeze({
      runId: run.id === undefined ? null : run.id,
      ticketId: run.ticketId === undefined ? null : run.ticketId,
      // Carried so the Ticket-level grouping can tell a terminal Run from a
      // running one. Live churn is a progress signal, not a terminal block.
      runStatus: run.status === undefined ? null : run.status,
      allocationPlanId: run.allocationPlanId || null,
      allocationItemId: run.leafRunBinding.allocationItemId || null,
      policy,
      evaluated: false,
      executionEpochAt: null,
      cutoff: null,
      window: null,
      resources: null,
      signals: null,
      decision: null,
      block
    });
  }

  const projection = normalizeVerifiedProgressProjection(evaluation.projection);
  const decision = evaluation.decision;
  if (!isPlainObject(decision)) fail('an evaluation must carry its decision');

  const cutoff = projectCutoff(
    progressState && progressState.cutoff ? progressState.cutoff : {
      receiptCutoff: projection.sourceCutoff,
      reservationCutoff: projection.sourceCutoff,
      budgetCutoff: projection.sourceCutoff,
      postconditionEvidenceCutoff: 0,
      evaluatedAt: projection.evaluatedAt
    });

  return deepFreeze({
    runId: run.id === undefined ? null : run.id,
    runStatus: run.status === undefined ? null : run.status,
    ticketId: run.ticketId === undefined ? null : run.ticketId,
    allocationPlanId: projection.allocationPlanId,
    allocationItemId: projection.allocationItemId,
    policy,

    evaluated: true,
    // FIRST execution start, from the earliest append-only lease event. Not
    // admission time, and not the latest attempt — recovery resets that.
    executionEpochAt: evaluation.executionEpochAt,
    cutoff,

    // The observation window this decision was taken over. Its identity is the
    // durable logical request identity, never a process sequence number.
    window: deepFreeze({
      windowIdentity: projection.windowIdentity,
      windowKind: projection.windowKind,
      windowCount: evaluation.windowCount,
      declaredWorkHash: projection.declaredWorkHash,
      projectionHash: projection.projectionHash
    }),

    // THE FOUR LEVELS, KEPT APART.
    //
    //   activity           durable things happened
    //   candidate_progress something NEW happened, not yet known to matter
    //   verified_progress  a previously unsatisfied declared fact is satisfied
    //   completion         NOT decided here — Tranche 3 owns it
    //
    // `completionAuthority` is deliberately a pointer, not a verdict: a surface
    // must never read verified progress as completion.
    progress: deepFreeze({
      levels: PROGRESS_LEVELS,
      activityOperationCount: projection.resources
        ? projection.resources.durableOperations || 0 : 0,
      candidateProgressFacts: projection.candidateFacts,
      candidateProgressCount: projection.candidateFacts.length,
      newlyVerifiedProgressFacts: projection.verifiedFacts,
      verifiedProgressCount: projection.verifiedProgressCount,
      completionAuthority: 'structured_allocation_leaf_completion_decision'
    }),

    // Cumulative, reconstructed from durable rows — never a process counter.
    // The micro-USD figure is the same durable settlement fact Tranche 4
    // projects; it is not a second ledger.
    resources: deepFreeze({
      cumulativeProviderRequests: decision.cumulativeResources.providerRequests,
      cumulativeDurableOperations: decision.cumulativeResources.durableOperations,
      cumulativeSettledMicroUsd: decision.cumulativeResources.settledMicroUsd,
      cumulativeBudgetChargedUnits:
        decision.cumulativeResources.budgetChargedUnits,
      // Measured from the immutable epoch, so it survives every recovery.
      // Verified progress does not reset it.
      cumulativeExecutionDurationMs:
        decision.cumulativeResources.cumulativeExecutionDurationMs
    }),

    signals: deepFreeze({
      consecutiveNoProgressWindows: decision.consecutiveNoProgressWindows,
      repeatedOperationSignals: decision.repeatedOperationSignals,
      failedOperationStreak: decision.failedOperationStreak,
      mutationReversalSignals: decision.mutationReversalSignals,
      inspectionOnlyStreak: decision.inspectionOnlyStreak,
      noProgressSignals: projection.noProgressSignals
    }),

    // The decision as taken. Two values only — there is no `retry`, `reroute`,
    // `replan` or `remediate` to report because none exists.
    decision: deepFreeze({
      decision: decision.decision,
      reason: decision.reason,
      decisionHash: decision.decisionHash,
      evaluatedAt: decision.evaluatedAt,
      permitsFurtherGovernedSpending: decision.decision === 'continue'
    }),

    block
  });
}

// ── Ticket level ────────────────────────────────────────────────────────────
//
// A concise summary over already-projected Runs. It counts; it does not
// re-derive. Returns null for a Ticket with no governed structured leaf Runs,
// so non-structured Tickets are untouched.

function projectTicketVerifiedProgress(runProjections = []) {
  const projections = (runProjections || []).filter(Boolean);
  if (projections.length === 0) return null;

  const blockedByReason = {};
  for (const reason of CHURN_STOP_REASONS) blockedByReason[reason] = [];

  const continuing = [];
  const queued = [];
  const notYetEvaluated = [];
  let unresolvedActiveWindows = 0;
  let totalVerifiedProgressFacts = 0;
  let cumulativeProviderRequests = 0;
  let cumulativeDurableOperations = 0;
  let cumulativeSettledMicroUsd = 0;
  let cumulativeBudgetChargedUnits = 0;
  let cumulativeExecutionDurationMs = 0;

  for (const projection of projections) {
    const runId = projection.runId;

    // A persisted block is the authoritative stop. Where a Run is blocked, the
    // STORED reason is used rather than the freshly evaluated one: the block is
    // the decision of record, and a later evaluation must not restate it.
    // A PERSISTED BLOCK IS THE ONLY TERMINAL BLOCK AUTHORITY.
    //
    // The fallback to a freshly evaluated churn decision is live-progress
    // reporting for a Run still executing: it answers "is this Run currently
    // stalling", which is useful while work continues. It is NOT a terminal
    // classification, and applying it to a terminal Run produced a real
    // contradiction — a COMPLETED Run, holding no persisted block, whose final
    // window truthfully evaluated to `blocked` / `verified_progress_exhausted`,
    // was listed under `blockedForVerifiedProgressExhaustion` while Run-state
    // and the durable row both reported no block.
    //
    // A Run's declared work can be satisfied in the same window that produced
    // no NEW verified progress; that is history, not a block. So the fallback
    // is restricted to nonterminal Runs, and a terminal Run contributes a
    // blocked reason only from its own durable block.
    const terminal = TERMINAL_RUN_STATUSES.includes(projection.runStatus);
    const reason = projection.block
      ? projection.block.reason
      : (!terminal && projection.decision && projection.decision.decision === 'blocked'
        ? projection.decision.reason
        : null);

    if (reason && Object.prototype.hasOwnProperty.call(blockedByReason, reason)) {
      blockedByReason[reason].push(runId);
    } else if (!projection.evaluated) {
      notYetEvaluated.push(runId);
    } else if (projection.decision.decision === 'continue') {
      continuing.push(runId);
      // An OPEN window requires that the Run has actually begun executing.
      // A governed Run still waiting in the scheduler queue has no execution
      // epoch and therefore no window — counting it as active would overstate
      // in-flight work, which is the same mistake as charging queue time as
      // execution duration.
      if (projection.executionEpochAt) unresolvedActiveWindows += 1;
      else queued.push(runId);
    }

    if (projection.evaluated) {
      totalVerifiedProgressFacts += projection.progress.verifiedProgressCount;
      cumulativeProviderRequests += projection.resources.cumulativeProviderRequests;
      cumulativeDurableOperations += projection.resources.cumulativeDurableOperations;
      cumulativeSettledMicroUsd += projection.resources.cumulativeSettledMicroUsd;
      cumulativeBudgetChargedUnits +=
        projection.resources.cumulativeBudgetChargedUnits;
      cumulativeExecutionDurationMs +=
        projection.resources.cumulativeExecutionDurationMs;
    }
  }

  const sorted = list => Object.freeze([...list].sort((a, b) => a - b));

  return deepFreeze({
    governedRunIds: sorted(projections.map(p => p.runId)),
    runsPermittedToContinue: sorted(continuing),
    // Permitted, but not yet executing: admitted and waiting for a lease.
    runsQueuedBeforeFirstExecution: sorted(queued),
    runsNotYetEvaluated: sorted(notYetEvaluated),

    // One list per closed stop reason. Named individually rather than as a
    // single "blocked" count, because the reasons are not interchangeable:
    // duration exhaustion and a no-op loop call for different human responses.
    blockedForVerifiedProgressExhaustion:
      sorted(blockedByReason.verified_progress_exhausted),
    blockedForRepeatedNoOp: sorted(blockedByReason.repeated_no_op),
    blockedForRepeatedFailedOperation:
      sorted(blockedByReason.repeated_failed_operation),
    blockedForMutationReversal: sorted(blockedByReason.mutation_reversal_churn),
    blockedForCumulativeExecutionDuration:
      sorted(blockedByReason.cumulative_execution_duration_exhausted),
    blockedForUndeclaredSiblingDependency:
      sorted(blockedByReason.undeclared_sibling_dependency),
    blockedForProgressAccountingConflict:
      sorted(blockedByReason.progress_accounting_conflict),

    unresolvedActiveWindows,
    // Verified progress is NOT completion. Completion totals come from the
    // Tranche 3 aggregate decision and are deliberately absent here.
    totalVerifiedProgressFacts,

    // Cumulative resource facts, kept separate from Tranche 4 role-account
    // BALANCES. This is what governed leaf Runs consumed; the authoritative
    // account state remains `projectTicketGovernedEconomics`.
    //
    // These totals can LAG the account rows and that is intended: a blocked Run
    // is projected through its stored cutoff, so anything settling after the
    // block sits outside the frozen decision of record. They never EXCEED the
    // durable rows. When an operator needs the current balance, the answer is
    // the account, which is why it is named here rather than restated.
    cumulativeResources: deepFreeze({
      providerRequests: cumulativeProviderRequests,
      durableOperations: cumulativeDurableOperations,
      settledMicroUsd: cumulativeSettledMicroUsd,
      budgetChargedUnits: cumulativeBudgetChargedUnits,
      executionDurationMs: cumulativeExecutionDurationMs,
      settlementAuthority: 'ticket_economic_accounts'
    })
  });
}

module.exports = {
  NEVER_PROJECTED,
  PROGRESS_LEVELS,
  VerifiedProgressProjectionError,
  cutoffIdentity,
  projectRunVerifiedProgress,
  projectTicketVerifiedProgress
};

'use strict';

// Tranche 5 — turning durable rows into observation windows and one decision.
//
// This is the seam between the store (which reads rows) and the contracts
// (which classify and decide). It contains no model call, no current policy, no
// caller-supplied "progress" flag, and no clock reading.
//
// WINDOW MEMBERSHIP. A Run has one writer at a time — `claimPendingRun` takes
// the row with `FOR UPDATE ... SKIP LOCKED` — and every evaluation holds the Run
// row lock. So the receipts and reservations of one Run are a totally ordered
// sequence that cannot grow underneath an evaluation, and a window is simply a
// half-open interval over it:
//
//   window(ordinal N) = receipts recorded at or after reservation N started,
//                       and before reservation N+1 started
//
// Each receipt lands in exactly one window. A restart replays the same rows in
// the same order and rebuilds the same intervals, which is why the projection
// hash is stable across processes.

const {
  buildVerifiedProgressProjection
} = require('./verified-progress-contract');
const {
  decideChurn,
  normalizeProgressControlPolicy
} = require('./churn-decision-contract');

// Receipts recorded before the first reservation belong to no governed window:
// they are work the Run did before it ever asked a provider for anything.
const PRE_REQUEST_WINDOW = null;

function toTime(value) {
  if (!value) return null;
  const time = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isNaN(time) ? null : time;
}

// Assigns every receipt to at most one governed window, using the durable
// reservation boundaries. Deliberately total: a receipt outside every window is
// reported as such rather than silently attributed to the nearest one.
function partitionReceiptsIntoWindows({ reservations, receipts }) {
  const ordered = [...reservations]
    .filter(reservation => reservation.startedAt)
    .sort((left, right) => left.modelRequestOrdinal - right.modelRequestOrdinal);

  const windows = ordered.map((reservation, index) => {
    const next = ordered[index + 1] || null;
    const from = toTime(reservation.startedAt);
    const until = next ? toTime(next.startedAt) : null;
    return {
      logicalSourceIdentity: reservation.logicalSourceIdentity,
      modelRequestOrdinal: reservation.modelRequestOrdinal,
      reservationId: reservation.reservationId,
      state: reservation.state,
      from,
      until,
      observations: []
    };
  });

  const unassigned = [];
  for (const receipt of receipts) {
    const recorded = toTime(receipt.recordedAt);
    const window = windows.find(candidate =>
      recorded !== null && recorded >= candidate.from &&
      (candidate.until === null || recorded < candidate.until));
    if (!window) {
      unassigned.push(receipt);
      continue;
    }
    window.observations.push(receipt);
  }
  return { windows, unassigned, preRequestWindow: PRE_REQUEST_WINDOW };
}

// ── Evaluation ──────────────────────────────────────────────────────────────
//
// Produces the projection for the MOST RECENT governed window plus the
// consecutive no-progress count across all prior windows. Verified progress
// resets that consecutive count; it never erases cumulative resource history.

function evaluateGovernedRunProgress({
  progressState,
  declaredWorkSnapshot,
  progressPolicy,
  allocationPlanId = null,
  allocationItemId = null,
  siblingDependencyBlocked = false,
  satisfiedFactIdentitiesByReceiptId = new Map()
}) {
  const policy = normalizeProgressControlPolicy(progressPolicy);
  const { run, reservations, receipts, cumulativeResources, sourceCutoff } = progressState;
  const { windows } = partitionReceiptsIntoWindows({ reservations, receipts });

  // Replay every window in order so the satisfied-fact set and the consecutive
  // streak are reconstructed exactly as they were the first time.
  const satisfied = new Set();
  const seenFingerprints = [];
  let consecutiveNoProgressWindows = 0;
  let latestProjection = null;

  const evaluatedWindows = windows.length > 0
    ? windows
    // No governed request has been made yet. The FIRST request is always
    // permitted: Tranche 5 governs additional spending, not the initial
    // opportunity to execute admitted work.
    : [{
      logicalSourceIdentity: `run:${run.id}:pre-request`,
      modelRequestOrdinal: 0,
      state: 'reserved',
      observations: []
    }];

  for (const window of evaluatedWindows) {
    const observations = window.observations.map(receipt => ({
      operation: receipt.operation,
      outcome: receipt.outcome,
      workspacePath: receipt.workspacePath,
      mutationFingerprint: receipt.mutationFingerprint,
      satisfiesDeclaredFactIdentities:
        satisfiedFactIdentitiesByReceiptId.get(receipt.receiptId) || []
    }));

    const projection = buildVerifiedProgressProjection({
      ticketId: run.ticketId,
      runId: run.id,
      allocationPlanId,
      allocationItemId,
      declaredWorkSnapshot,
      windowIdentity: window.logicalSourceIdentity,
      windowKind: 'provider_request',
      observations,
      resources: cumulativeResources,
      previouslySatisfiedFactIdentities: [...satisfied],
      previouslySeenFingerprints: [...seenFingerprints],
      policy,
      sourceCutoff
    });

    for (const fact of projection.verifiedFacts) satisfied.add(fact);
    for (const observation of observations) {
      if (observation.mutationFingerprint) {
        seenFingerprints.push(observation.mutationFingerprint);
      }
    }

    // Verified progress resets the CONSECUTIVE count only. Cumulative totals
    // live in `cumulativeResources` and are never rewound.
    if (projection.verifiedProgressCount > 0) {
      consecutiveNoProgressWindows = 0;
    } else if (window.observations.length > 0 || window.modelRequestOrdinal > 0) {
      consecutiveNoProgressWindows += 1;
    }
    latestProjection = projection;
  }

  const decision = decideChurn({
    ticketId: run.ticketId,
    runId: run.id,
    progressProjection: latestProjection,
    policy,
    cumulativeResources,
    consecutiveNoProgressWindows,
    siblingDependencyBlocked
  });

  return Object.freeze({
    projection: latestProjection,
    decision,
    consecutiveNoProgressWindows,
    windowCount: windows.length,
    sourceCutoff
  });
}

module.exports = {
  PRE_REQUEST_WINDOW,
  evaluateGovernedRunProgress,
  partitionReceiptsIntoWindows
};

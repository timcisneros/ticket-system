'use strict';

// Tranche 4 — the ONE canonical governed-execution projection.
//
// Every surface that shows governed economics — Ticket page, Ticket API, Run
// page, Run API, CLI — calls into here. None of them reconstructs economic
// state for itself, because a page that computes a balance differently from an
// API is a page that will eventually disagree with the database about money.
//
// WHAT THIS IS BUILT FROM. Durable rows and stored contracts only:
//
//   ticket_economic_accounts        -> the balances, as stored
//   economic_request_reservations   -> the request lifecycle, as stored
//   run.governedExecution           -> the captured authority, normalized
//
// Every stored contract passes its existing normalizer before it is projected,
// so a damaged envelope refuses here rather than being rendered as though it
// were sound. Partial governed state is NOT historical state.
//
// WHAT THIS NEVER DOES:
//
//   * derive a balance by summing reservations — the account row is the
//     balance, and a sum that disagrees with it is a bug worth seeing, not a
//     number worth displaying;
//   * emit a single `governed: true` — "route authorized", "target captured",
//     "reserved", "started", "settled" are different facts and collapsing them
//     would hide exactly the distinctions this tranche exists to make;
//   * expose credentials, authorization headers, or serialized request bytes.

const {
  normalizeGovernedRunAuthority
} = require('./governed-run-authority-contract');

const PLANNER_ROLE = 'structured_planner';
const WORKER_ROLE = 'structured_leaf_executor';

// The durable lifecycle, spelled exactly as the database stores it. No
// presentation synonyms: an operator reading the UI and an engineer reading a
// row must be looking at the same word.
const RESERVATION_LIFECYCLE = Object.freeze([
  'reserved',
  'request_started',
  'response_persisted',
  'settled',
  'released'
]);

// Fields that must never reach any surface, asserted by the projection tests
// against real output rather than trusted to reviewers.
const NEVER_PROJECTED = Object.freeze([
  'apiKey', 'authorization', 'Authorization', 'bearer', 'Bearer',
  'serializedRequest', 'preparedRequest', 'credentials'
]);

class GovernedProjectionError extends Error {
  constructor(code, message, detail = {}) {
    super(message);
    this.name = 'GovernedProjectionError';
    this.code = code;
    this.detail = detail;
  }
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function lifecycle(state) {
  if (!RESERVATION_LIFECYCLE.includes(state)) {
    throw new GovernedProjectionError('GOVERNED_PROJECTION_INVALID',
      `unrecognized reservation lifecycle state: ${String(state)}`);
  }
  return state;
}

// One reservation, reduced to operational facts. Identities and hashes only —
// the bytes stay in the database.
function projectReservation(reservation) {
  const receipt = reservation.settlementReceipt || null;
  return Object.freeze({
    reservationId: reservation.id,
    role: reservation.role,
    runId: reservation.runId,
    planningAttemptId: reservation.planningAttemptId,
    modelRequestOrdinal: reservation.modelRequestOrdinal,
    logicalSourceIdentity: reservation.logicalSourceIdentity,
    lifecycle: lifecycle(reservation.state),
    dispatchTarget: reservation.preparedRequest
      ? reservation.preparedRequest.dispatchTarget
      : null,
    routingDecisionHash: reservation.routingDecisionHash,
    economicAuthorityHash: reservation.economicAuthorityHash,
    targetEvidenceHash: reservation.targetEvidenceHash,
    pricingEntryHash: reservation.pricingEntryHash,
    preparedRequestHash: reservation.preparedRequestHash,
    exactRequestHash: reservation.exactRequestHash,
    // Present only when the fact exists. A null here means "no response yet",
    // never "response we did not bother to record".
    responseIdentity: reservation.responseIdentity,
    responseHash: reservation.responseHash,
    settlementReceiptHash: receipt ? receipt.receiptHash : null,
    usageSource: receipt ? receipt.usageSource : null,
    reservedMicroUsd: reservation.reservedMaxMicroUsd,
    settledMicroUsd: reservation.settledMicroUsd,
    // Released amount is the reserve handed back, and only a released
    // reservation has one.
    releasedMicroUsd: reservation.state === 'released'
      ? reservation.reservedMaxMicroUsd
      : null
  });
}

function countByLifecycle(reservations) {
  const counts = {};
  for (const state of RESERVATION_LIFECYCLE) counts[state] = 0;
  for (const reservation of reservations) counts[lifecycle(reservation.state)] += 1;
  return Object.freeze(counts);
}

// ── Ticket level ────────────────────────────────────────────────────────────

function projectTicketGovernedEconomics({ accounts, reservations }) {
  if (!Array.isArray(accounts) || !Array.isArray(reservations)) {
    throw new GovernedProjectionError('GOVERNED_PROJECTION_INVALID',
      'governed economics requires durable account and reservation rows');
  }
  // A Ticket that never used governed execution projects nothing at all. It is
  // not given empty accounts or zeroed balances, which would imply governance
  // that never happened.
  if (accounts.length === 0 && reservations.length === 0) return null;

  const roleAccounts = accounts.map(account => Object.freeze({
    role: account.role,
    accountId: account.id,
    economicPolicyId: account.economicPolicyId,
    economicPolicyHash: account.economicPolicyHash,
    authorizedMicroUsd: account.authorizedMicroUsd,
    reservedMicroUsd: account.reservedMicroUsd,
    settledMicroUsd: account.settledMicroUsd,
    // Straight from the durable row's own arithmetic, not a running total.
    remainingMicroUsd: account.remainingMicroUsd,
    revision: account.revision
  }));

  const plannerReservations = reservations.filter(r => r.role === PLANNER_ROLE);
  const workerReservations = reservations.filter(r => r.role === WORKER_ROLE);
  const workerAccount = roleAccounts.find(a => a.role === WORKER_ROLE) || null;

  return Object.freeze({
    // Roles stay separate at every level. A combined total would let planner
    // spend hide worker spend and vice versa.
    accounts: Object.freeze(roleAccounts),
    planner: plannerReservations.length === 0 ? null : Object.freeze({
      account: roleAccounts.find(a => a.role === PLANNER_ROLE) || null,
      requests: Object.freeze(plannerReservations.map(projectReservation))
    }),
    structuredLeaf: workerReservations.length === 0 && workerAccount === null
      ? null
      : Object.freeze({
        workerAccountId: workerAccount ? workerAccount.accountId : null,
        governedRunIds: Object.freeze(
          [...new Set(workerReservations.map(r => r.runId).filter(Boolean))]
            .sort((a, b) => a - b)),
        reservationCountsByLifecycle: countByLifecycle(workerReservations),
        // The two states an operator actually needs to find: requests that may
        // have reached a provider and are not resolved, and responses that are
        // durable but unsettled.
        unresolvedStartedReservationIds: Object.freeze(workerReservations
          .filter(r => r.state === 'request_started').map(r => r.id)),
        awaitingSettlementReservationIds: Object.freeze(workerReservations
          .filter(r => r.state === 'response_persisted').map(r => r.id)),
        totalReservedMicroUsd: workerAccount ? workerAccount.reservedMicroUsd : 0,
        totalSettledMicroUsd: workerAccount ? workerAccount.settledMicroUsd : 0
      })
  });
}

// ── Run level ───────────────────────────────────────────────────────────────
//
// Returns null for a historical Run and THROWS for a damaged one. The
// difference matters: a historical Run legitimately has nothing to show, while
// a damaged one has something wrong that must not be rendered as absence.

function projectRunGovernedExecution(run, reservations = []) {
  if (!run || !Object.prototype.hasOwnProperty.call(run, 'governedExecution') ||
      run.governedExecution === undefined || run.governedExecution === null) {
    return null;
  }
  const authority = normalizeGovernedRunAuthority(run.governedExecution, {
    expectedRunId: run.id === undefined ? null : run.id,
    expectedTicketId: run.ticketId === undefined ? null : run.ticketId
  });
  const decision = authority.routingDecision;
  const economics = authority.economicAuthority;
  const runReservations = reservations
    .filter(r => r.runId === run.id && r.role === WORKER_ROLE)
    .sort((a, b) => a.modelRequestOrdinal - b.modelRequestOrdinal);

  return Object.freeze({
    role: authority.role,
    // Authorization and capture are separate facts and are shown as such: the
    // policy authorized a REFERENCE, and capture resolved it to an artifact.
    routingPolicyHash: authority.roleRoutingPolicyHash,
    routingDecisionHash: decision.decisionHash,
    authorizedRouteReference: decision.routeReference,
    immutableDispatchTarget: decision.dispatchTarget,
    targetEvidenceHash: decision.targetEvidenceHash,
    economicPolicyHash: authority.economicPolicyHash,
    economicAuthorityHash: economics.authorityHash,
    pricingCatalogHash: authority.pricingCatalogHash,
    pricingEntryHash: economics.pricingEntryHash,
    maximumProviderRequests: economics.maximumProviderRequests,
    authorizedOutputTokens: economics.maximumOutputTokensPerRequest,
    maximumPerRequestMicroUsd: economics.maximumPerRequestMicroUsd,
    workerAccountId: authority.economicAccountId,
    allocationItemId: authority.allocationItemId,
    capturedAt: authority.capturedAt,
    requests: Object.freeze(runReservations.map(projectReservation))
  });
}

module.exports = {
  GovernedProjectionError,
  NEVER_PROJECTED,
  PLANNER_ROLE,
  RESERVATION_LIFECYCLE,
  WORKER_ROLE,
  projectReservation,
  projectRunGovernedExecution,
  projectTicketGovernedEconomics
};

'use strict';

// Tranche 4 — the governed structured-planner dispatch segment.
//
// This is the production orchestration. It is a module rather than inline
// server code for one reason: the transport is an EXPLICIT DEPENDENCY. In
// production the caller passes the real OpenAI transport; a test passes a
// deterministic one. Neither is a branch, a flag, or a test-only base URL —
// production and test execute the same statements in the same order, and the
// only difference is which function performs the byte transfer.
//
// The sequence, and the reason it is exactly this sequence:
//
//   admit account      — the budget must exist before anything is charged
//   reserve request    — the exact bytes and their price become durable
//   resolve credentials— BEFORE start, so an avoidable failure consumes nothing
//   atomic start       — reservation and attempt advance together, one winner
//   dispatch           — the persisted bytes, and only on a winning start
//   atomic response    — both durable response markers, or neither
//   settle             — from the reservation's captured basis alone
//
// NO PROVIDER CONTACT IS POSSIBLE before the reservation is committed and a
// start transition has been won. That is not a convention here: the transport
// is handed the start result, and there is no other way to reach it.

const {
  buildGovernedExecutionState,
  derivePlannerSettlementUsage,
  PLANNER_ROLE
} = require('./structured-planner-governance');
const { dispatchGovernedRequest } = require('./governed-provider-transport');
const { hashCanonical } = require('./declared-work-contract');

// Closed outcomes. Each maps to exactly one truthful planning-attempt record,
// and each states whether the provider may have been contacted — which is what
// decides between releasing and settling.
const GOVERNED_PLANNER_OUTCOMES = Object.freeze([
  'received',
  'reservation_refused',
  'credentials_unavailable',
  'start_lost',
  'dispatch_failed',
  'response_persistence_failed'
]);

// The planning-attempt failure reasons this segment can produce. Reused from
// the existing closed planner vocabulary wherever one already fits, so the
// governed path does not invent parallel names for conditions that already
// have them.
const GOVERNED_FAILURE_REASONS = Object.freeze({
  reservation_refused: 'planner_economic_authority_unavailable',
  credentials_unavailable: 'planner_credentials_unavailable',
  start_lost: 'planning_attempt_already_active',
  timeout: 'provider_request_timed_out',
  response_too_large: 'provider_response_too_large',
  response_empty: 'provider_response_empty',
  transport_refused: 'provider_request_failed',
  response_persistence_failed: 'provider_outcome_unknown'
});

class GovernedPlannerOrchestrationError extends Error {
  constructor(code, message, detail = {}) {
    super(message);
    this.name = 'GovernedPlannerOrchestrationError';
    this.code = code;
    this.detail = detail;
  }
}

function outcome(status, rest = {}) {
  if (!GOVERNED_PLANNER_OUTCOMES.includes(status)) {
    throw new GovernedPlannerOrchestrationError(
      'GOVERNED_PLANNER_INVALID', `Unsupported governed planner outcome: ${String(status)}`);
  }
  return Object.freeze({
    status,
    // Whether a provider request may already have been issued. Anything true
    // here settles; anything false may release.
    possiblyDispatched: false,
    responseText: null,
    responseHash: null,
    responseIdentity: null,
    reservationId: null,
    accountId: null,
    governedExecution: null,
    attempt: null,
    settlementReceiptHash: null,
    failureReason: null,
    failureDetail: null,
    ...rest
  });
}

function sha256Hex(text) {
  return require('node:crypto').createHash('sha256').update(text, 'utf8').digest('hex');
}

// ── The orchestration ───────────────────────────────────────────────────────

async function runGovernedPlannerRequest({
  repository,
  ticketId,
  attempt,
  capture,
  transport,
  resolveCredentials,
  timeoutMs,
  maxResponseBytes,
  attachGovernedExecution,
  // The hash of the attempt state this start replaces — the `created` state,
  // not the `request_started` one being written. Passing the new state's own
  // hash would compare the write against itself and always conflict.
  expectedAttemptStateHash
}) {
  const { preparedRequest, economicAuthority, pricingEntry, source } = capture;

  // 1. The role account. Idempotent: an existing account under the same policy
  //    is reused, and a different policy refuses rather than re-authorizing.
  let accountId;
  let reservation;
  try {
    const admitted = await repository.admitTicketEconomicAccount({
      ticketId, role: PLANNER_ROLE, economicPolicy: source.economicPolicy
    });
    accountId = Number(admitted.account.id);

    // 2. The reservation. After this commits, the exact bytes and the exact
    //    price that bounds them are durable, and a crash is recoverable as
    //    "reserved, provably never dispatched".
    reservation = await repository.reserveEconomicRequest({
      preparedRequest, economicAuthority, pricingEntry
    });
  } catch (error) {
    // Nothing was reserved, or the reservation itself refused. Either way no
    // provider was contacted and there is nothing to release.
    return outcome('reservation_refused', {
      accountId: accountId === undefined ? null : accountId,
      failureReason: GOVERNED_FAILURE_REASONS.reservation_refused,
      failureDetail: error.message
    });
  }

  const governedExecution = buildGovernedExecutionState({
    capture,
    economicAccountId: accountId,
    reservationId: reservation.id,
    economicState: 'request_started'
  });

  // 3. Credentials, BEFORE the start transition. Resolving them here means a
  //    missing credential costs nothing: the reservation is released and the
  //    request is provably undispatched. Resolution may read only the captured
  //    adapter/provider and cannot influence any of them.
  let credentials = null;
  try {
    credentials = await resolveCredentials({
      adapterId: preparedRequest.adapterId,
      provider: preparedRequest.provider
    });
  } catch (error) {
    credentials = null;
  }
  if (!credentials) {
    await repository.releaseUndispatchedEconomicReservation({
      reservationId: reservation.id, reason: 'planner_credentials_unavailable'
    });
    return outcome('credentials_unavailable', {
      accountId,
      reservationId: reservation.id,
      failureReason: GOVERNED_FAILURE_REASONS.credentials_unavailable,
      failureDetail: `no credential is available for ${preparedRequest.provider}`
    });
  }

  // 4. The atomic start. Exactly one caller wins; the winner receives the
  //    persisted bytes and dispatch authority together.
  let startResult;
  try {
    startResult = await repository.startGovernedPlannerRequest({
      ticketId,
      attempt: attachGovernedExecution(attempt, governedExecution),
      reservationId: reservation.id,
      expectedAttemptStateHash
    });
  } catch (error) {
    // A loser contacts no transport and must not settle or release: the winner
    // owns this reservation's outcome.
    return outcome('start_lost', {
      accountId,
      reservationId: reservation.id,
      failureReason: GOVERNED_FAILURE_REASONS.start_lost,
      failureDetail: error.message
    });
  }
  if (startResult.startedNow !== true || startResult.dispatchAuthorized !== true) {
    return outcome('start_lost', {
      accountId,
      reservationId: reservation.id,
      failureReason: GOVERNED_FAILURE_REASONS.start_lost,
      failureDetail: 'the start transition granted no dispatch authority'
    });
  }

  // 5. Dispatch. The transport is given the start result and nothing else that
  //    could describe a request; the bytes it sends come from storage.
  const dispatched = await dispatchGovernedRequest({
    startResult,
    transport,
    resolveCredentials: async () => credentials,
    timeoutMs,
    maxResponseBytes
  });

  if (dispatched.status !== 'received') {
    // The request may already have reached the provider, so it settles at the
    // reserved maximum. It is never released and never repeated.
    await settleConservatively(repository, reservation.id);
    return outcome('dispatch_failed', {
      possiblyDispatched: dispatched.possiblyDispatched,
      accountId,
      reservationId: reservation.id,
      governedExecution,
      attempt: startResult.attempt,
      failureReason: GOVERNED_FAILURE_REASONS[dispatched.status] ||
        GOVERNED_FAILURE_REASONS.transport_refused,
      failureDetail: dispatched.detail
    });
  }

  const responseText = dispatched.text;
  const responseHash = sha256Hex(responseText);
  const responseIdentity = dispatched.responseIdentity ||
    `reservation:${reservation.id}:response`;

  return outcome('received', {
    possiblyDispatched: true,
    accountId,
    reservationId: reservation.id,
    governedExecution,
    attempt: startResult.attempt,
    responseText,
    responseHash,
    responseIdentity,
    reportedUsage: dispatched.reportedUsage
  });
}

// Conservative closure for a request whose outcome is unknown. Deliberately
// tolerant of an already-settled reservation: a retried recovery must not fail
// merely because the previous attempt already closed the books.
async function settleConservatively(repository, reservationId) {
  try {
    return await repository.settleEconomicRequest({
      reservationId, usage: { source: 'authorized_maximum_assumed' }
    });
  } catch (error) {
    if (error && error.code === 'ECONOMIC_RESERVATION_ALREADY_SETTLED') return null;
    throw error;
  }
}

// Persists both response markers atomically and then settles from the captured
// basis. Split from the dispatch above so the caller can place its own durable
// response-text handling between them if it must.
async function persistAndSettleGovernedPlannerResponse({
  repository,
  ticketId,
  attempt,
  reservationId,
  responseIdentity,
  responseHash,
  reportedUsage,
  expectedAttemptStateHash
}) {
  const persisted = await repository.persistGovernedPlannerResponse({
    ticketId,
    attempt,
    reservationId,
    responseIdentity,
    responseHash,
    expectedAttemptStateHash
  });

  // Usage is derived, never trusted: anything absent, partial or malformed
  // settles at the reserved maximum.
  const usage = derivePlannerSettlementUsage(reportedUsage);
  let settled;
  try {
    settled = await repository.settleEconomicRequest({ reservationId, usage });
  } catch (error) {
    // An identical re-report must not block proposal validation.
    if (error && error.code === 'ECONOMIC_RESERVATION_ALREADY_SETTLED') {
      settled = await repository.getEconomicReservation(reservationId);
    } else {
      throw error;
    }
  }
  return {
    attempt: persisted.attempt,
    reservation: settled,
    settlementReceiptHash: settled && settled.settlementReceipt
      ? settled.settlementReceipt.receiptHash
      : null
  };
}

// ── Recovery classification ─────────────────────────────────────────────────
//
// The reservation is the no-repeat authority. This function reports what a
// recovering process may do, and never does it.

function classifyGovernedPlannerRecovery(reservation) {
  if (!reservation) {
    return Object.freeze({
      state: null, mayDispatch: false, mustSettle: false, terminal: true,
      reason: 'no governed reservation exists for this attempt'
    });
  }
  switch (reservation.state) {
    case 'reserved':
      // The only state in which a FIRST dispatch is still permitted, and only
      // with the bytes already persisted.
      return Object.freeze({
        state: 'reserved', mayDispatch: true, mustSettle: false, terminal: false,
        reason: 'the request is durably proven never dispatched'
      });
    case 'request_started':
      return Object.freeze({
        state: 'request_started', mayDispatch: false, mustSettle: true, terminal: false,
        reason: 'the request may already have reached the provider'
      });
    case 'response_persisted':
      return Object.freeze({
        state: 'response_persisted', mayDispatch: false, mustSettle: true, terminal: false,
        reason: 'a response is durable and settlement can proceed'
      });
    case 'settled':
      return Object.freeze({
        state: 'settled', mayDispatch: false, mustSettle: false, terminal: false,
        reason: 'settled; continue proposal validation without dispatch'
      });
    case 'released':
      return Object.freeze({
        state: 'released', mayDispatch: false, mustSettle: false, terminal: true,
        reason: 'the reservation was released undispatched'
      });
    default:
      return Object.freeze({
        state: reservation.state, mayDispatch: false, mustSettle: false, terminal: true,
        reason: 'unrecognized reservation state'
      });
  }
}

module.exports = {
  GOVERNED_FAILURE_REASONS,
  GOVERNED_PLANNER_OUTCOMES,
  GovernedPlannerOrchestrationError,
  classifyGovernedPlannerRecovery,
  persistAndSettleGovernedPlannerResponse,
  runGovernedPlannerRequest,
  settleConservatively
};

'use strict';

// Tranche 4 — the governed structured leaf provider-request segment.
//
// This owns exactly ONE provider-request opportunity for one structured leaf
// Run. It is not the worker loop, does not know about steps, actions, prompts
// or completion, and returns as soon as the response is durable and settled.
//
//   logical source
//     -> prepare and reserve   (economic + captured route, one ordinal)
//     -> credential preflight  (before start, so failure costs nothing)
//     -> one-winner start      (the only thing that authorizes transport)
//     -> exact-byte transport  (the persisted bytes, from storage)
//     -> response marker       (bound to the reservation)
//     -> settlement            (from captured facts only)
//
// TWO THINGS THAT LOOK LIKE PERMISSION AND ARE NOT:
//
//   `alreadyReserved: true` means a reservation exists. It says nothing about
//   whether a provider was contacted, so it NEVER authorizes a request. The
//   reservation's own lifecycle decides that, which is why this module reads
//   the state rather than the flag.
//
//   A reservation in `request_started` means the bytes may already be on the
//   wire. It is never re-dispatched, whatever the worker loop believes.
//
// Transport and credential resolution are injected. Production passes the real
// OpenAI transport; tests pass deterministic ones. Nothing else differs.

const {
  classifyRunGovernance
} = require('./governed-run-authority-contract');
const { dispatchGovernedRequest } = require('./governed-provider-transport');
const {
  derivePlannerSettlementUsage
} = require('./structured-planner-governance');

const WORKER_ROLE = 'structured_leaf_executor';

// Closed outcomes. Each says whether the provider may have been contacted,
// because that single fact decides between releasing and settling.
const GOVERNED_LEAF_OUTCOMES = Object.freeze([
  'received',
  'reused_durable_response',
  'reservation_refused',
  'credentials_unavailable',
  'dispatch_failed',
  'already_dispatched_unresolved',
  // The winner is still working. Not a failure, not a result — a report.
  'request_in_flight',
  // THIS caller started the request and cannot prove what became of it.
  // Distinct from `request_in_flight`, where someone else is still working.
  'request_delivery_uncertain',
  'request_released'
]);

const GOVERNED_LEAF_REFUSALS = Object.freeze([
  'governed_leaf_authority_absent',
  'governed_leaf_authority_invalid',
  'governed_leaf_source_conflict'
]);

class GovernedLeafOrchestrationError extends Error {
  constructor(code, message, detail = {}) {
    super(message);
    this.name = 'GovernedLeafOrchestrationError';
    this.code = code;
    this.detail = detail;
  }
}

function refuse(reason, message, detail = {}) {
  if (!GOVERNED_LEAF_REFUSALS.includes(reason)) {
    throw new GovernedLeafOrchestrationError('GOVERNED_LEAF_INVALID',
      `Unsupported governed leaf refusal: ${String(reason)}`);
  }
  throw new GovernedLeafOrchestrationError('GOVERNED_LEAF_REFUSED', message,
    { reason, ...detail });
}

function outcome(status, rest = {}) {
  if (!GOVERNED_LEAF_OUTCOMES.includes(status)) {
    throw new GovernedLeafOrchestrationError('GOVERNED_LEAF_INVALID',
      `Unsupported governed leaf outcome: ${String(status)}`);
  }
  return Object.freeze({
    status,
    possiblyDispatched: false,
    text: null,
    responseIdentity: null,
    responseHash: null,
    reportedUsage: null,
    reservationId: null,
    ordinal: null,
    settlementReceiptHash: null,
    failureReason: null,
    failureDetail: null,
    ...rest
  });
}

function sha256Hex(text) {
  return require('node:crypto').createHash('sha256').update(text, 'utf8').digest('hex');
}

// ── Path selection ──────────────────────────────────────────────────────────
//
// One decision, delegating entirely to `classifyRunGovernance` so there is a
// single definition of a valid structured Run.
//
// Tranche 4 is a development CUTOVER: a Run carrying `leafRunBinding` must also
// carry complete governed authority. There is no path by which a structured
// leaf Run runs ungoverned. Non-structured Runs carry neither field and keep
// their intended behaviour untouched.

function selectRunProviderPath(run) {
  let classified;
  try {
    classified = classifyRunGovernance(run);
  } catch (error) {
    // Shape violations and damaged envelopes alike. Neither selects a path: a
    // Run admitted as structured running ungoverned is exactly what this
    // cutover exists to prevent.
    refuse('governed_leaf_authority_invalid',
      `run ${run && run.id} governed authority is unusable: ${error.message}`,
      { cause: (error.detail && error.detail.reason) || error.code || null });
  }
  if (!classified.governed) return { path: 'ungoverned', authority: null };
  return { path: 'governed', authority: classified.authority };
}

// ── One provider-request opportunity ────────────────────────────────────────

// ── The recovery classifier, as a pure rule ─────────────────────────────────
//
// Extracted so it can be proved with values the relational constraints
// deliberately make impossible to stage. The database refuses to build a
// reservation whose start instant collides with a later claim — three separate
// mechanisms reject it — which is exactly why the earlier timestamp comparison
// looked correct in every real run while being wrong in principle.
//
// IT TAKES NO TIMESTAMPS. Not as an optimization: accepting one would reopen
// the possibility of deciding by clock order, and the whole point is that claim
// ownership is an identity question. Two claims can share a millisecond, and
// append order is not clock order.
const GOVERNED_RECOVERY_CLASSIFICATIONS = Object.freeze([
  'reused_durable_response',
  'request_in_flight',
  'request_delivery_uncertain',
  'request_authority_integrity_failure'
]);

function classifyGovernedRequestRecovery({
  durableResponsePresent = false,
  requestStarted = false,
  startedClaimEventPosition = null,
  currentClaimEventPosition = null,
  currentExecutorLive = false,
  legacyUnbound = false
} = {}) {
  // A durable response outranks every claim question: the answer exists, so
  // whose claim produced it changes nothing about what to do with it.
  if (durableResponsePresent) return 'reused_durable_response';
  if (!requestStarted) return null;

  // A row that predates the binding cannot prove which claim started it. It is
  // treated as an earlier attempt rather than the current one, because assuming
  // otherwise would report a live winner for work whose initiator may be gone.
  if (legacyUnbound || startedClaimEventPosition === null) {
    return 'request_delivery_uncertain';
  }
  // A started request in the new format must name its claim, and that claim
  // must be resolvable. Neither being true is an integrity problem, not a
  // recovery decision.
  if (!Number.isSafeInteger(startedClaimEventPosition) ||
      startedClaimEventPosition <= 0 ||
      currentClaimEventPosition === null ||
      !Number.isSafeInteger(currentClaimEventPosition)) {
    return 'request_authority_integrity_failure';
  }
  if (startedClaimEventPosition !== currentClaimEventPosition) {
    return 'request_delivery_uncertain';
  }
  return currentExecutorLive ? 'request_in_flight' : null;
}

async function runGovernedLeafRequest({
  repository,
  run,
  logicalSourceIdentity,
  canonicalBody,
  endpointIdentity,
  transport,
  resolveCredentials,
  timeoutMs,
  maxResponseBytes,
  runtimeModelRequestMaximum = null,
  runtimeModelRequestsUsed = null,
  persistResponseEvidence = null,
  // Invoked once, after admission and dispatch authority are won and before
  // any byte leaves. See step 4b.
  persistRequestEvidence = null,
  recoveredProviderCall = null
}) {
  const selected = selectRunProviderPath(run);
  if (selected.path !== 'governed') {
    refuse('governed_leaf_authority_absent',
      `run ${run.id} is not a governed leaf run`);
  }

  // THE CLAIM THIS ATTEMPT IS RUNNING UNDER, resolved at entry.
  //
  // Resolved here rather than at request start, because that is the point where
  // this orchestration attempt begins and therefore the claim it genuinely
  // holds. Reading it later would ask "what is the newest claim now", which is
  // a different question and answers it with whatever reclaim may have happened
  // while this attempt was paused.
  //
  // It is carried as an EXPECTATION, not an authority: the store matches it
  // against the append-only event log and refuses a superseded claim.
  const entryExecutor = await repository.isRunExecutorActive(run.id);
  const attemptClaimEventPosition = entryExecutor.currentClaimEventPosition;

  // 1. Reserve, or idempotently re-report an existing reservation for THIS
  //    logical opportunity. Duplicate orchestration never advances the ordinal.
  let prepared;
  try {
    prepared = await repository.prepareAndReserveNextGovernedRunRequest({
      runId: run.id,
      logicalSourceIdentity,
      canonicalBody,
      endpointIdentity,
      runtimeModelRequestMaximum,
      runtimeModelRequestsUsed
    });
  } catch (error) {
    // Budget, authority, ceiling and integrity refusals all land here, all
    // before any provider contact and with nothing to release.
    return outcome('reservation_refused', {
      failureReason: error.code || 'governed_leaf_reservation_refused',
      failureDetail: error.message
    });
  }

  const { reservation, ordinal } = prepared;

  // A recovered provider call may only be trusted when it describes THIS
  // reservation and these exact bytes. Anything else is a conflict, not a
  // shortcut.
  if (recoveredProviderCall) {
    if (recoveredProviderCall.logicalSourceIdentity !== logicalSourceIdentity ||
        Number(recoveredProviderCall.reservationId) !== reservation.id ||
        recoveredProviderCall.exactRequestHash !== reservation.exactRequestHash) {
      refuse('governed_leaf_source_conflict',
        `run ${run.id} recovered provider call does not match reservation ${reservation.id}`);
    }
  }

  // 2. The reservation's DURABLE LIFECYCLE decides what may happen next.
  //    `alreadyReserved` is not consulted: it says a row exists, not that the
  //    provider was spared.
  switch (reservation.state) {
    case 'reserved':
      break; // A first start may still be attempted.
    case 'request_started': {
      // ACTIVE IS NOT ABANDONED.
      //
      // The bytes may already have reached the provider, so this is never
      // re-dispatched. But whether it may be SETTLED depends on something this
      // reservation cannot know: is the executor that started it still alive?
      //
      // Settling an active request would charge the reserved maximum while the
      // winner is mid-flight, discard the metered usage it is about to report,
      // and close books the winner still owns. So the Run's lease decides,
      // using the same predicate the canonical recovery path uses.
      const executor = await repository.isRunExecutorActive(run.id);

      // WHICH CLAIM ATTEMPT STARTED THIS REQUEST?
      //
      // Two situations look identical through a lease OWNER and need opposite
      // answers. A duplicate racing a live winner inside one process shares
      // that process's owner string, and so does a recovery after a crash when
      // the same process reclaims the Run. Comparing owners answered "it is me"
      // for both, and told a legitimate duplicate its request might have been
      // lost when in fact a winner was mid-flight with it.
      //
      // The discriminator is the CLAIM, compared BY IDENTITY. Timestamps cannot
      // do this: `clock_timestamp()` has finite resolution, so a claim acquired
      // in the same millisecond as an earlier request start compares as
      // not-earlier and the recovering caller is told a winner is mid-flight
      // with a request nobody will finish. Clock order is not append order
      // either. The event id is unique per acquisition and identical for every
      // caller within one claim, which is exactly the distinction needed. The
      // event `position` is APPEND order, so it is unaffected by clock skew.
      //
      // A request with NO binding predates this rule. It is treated as an
      // earlier attempt rather than the current one: the claim that started it
      // is unrecoverable, and assuming it is current would resurrect the bug
      // this replaced.
      const classification = classifyGovernedRequestRecovery({
        durableResponsePresent: false,
        requestStarted: true,
        startedClaimEventPosition: reservation.startedClaimEventPosition === undefined
          ? null
          : reservation.startedClaimEventPosition,
        currentClaimEventPosition: executor.currentClaimEventPosition,
        currentExecutorLive: executor.active === true
      });

      if (executor.active && classification === 'request_delivery_uncertain') {
        return outcome('request_delivery_uncertain', {
          possiblyDispatched: true,
          reservationId: reservation.id,
          ordinal,
          failureReason: 'governed_request_delivery_uncertain',
          failureDetail:
            `run ${run.id} request ${ordinal} (${logicalSourceIdentity}) was ` +
            'started but holds no durable response; delivery cannot be proven ' +
            'and automatic retransmission is unsupported'
        });
      }
      if (executor.active) {
        return outcome('request_in_flight', {
          possiblyDispatched: true,
          reservationId: reservation.id,
          ordinal,
          failureReason: 'governed_leaf_request_in_flight',
          failureDetail:
            `run ${run.id} is still executing under lease ${executor.leaseOwner}`
        });
      }
      // The executor is durably gone and this caller holds the Run under the
      // existing lease authority. Conservative settlement is permitted.
      return await closeUnconfirmed(repository, reservation, ordinal);
    }
    case 'response_persisted': {
      const settled = await settleFromDurableFacts(repository, reservation);
      return outcome('reused_durable_response', {
        possiblyDispatched: true,
        reservationId: reservation.id,
        ordinal,
        responseIdentity: reservation.responseIdentity,
        responseHash: reservation.responseHash,
        settlementReceiptHash: settled
      });
    }
    case 'settled':
      return outcome('reused_durable_response', {
        possiblyDispatched: true,
        reservationId: reservation.id,
        ordinal,
        responseIdentity: reservation.responseIdentity,
        responseHash: reservation.responseHash,
        settlementReceiptHash: reservation.settlementReceipt
          ? reservation.settlementReceipt.receiptHash
          : null
      });
    case 'released':
      return outcome('request_released', {
        reservationId: reservation.id,
        ordinal,
        failureReason: 'governed_leaf_request_released',
        failureDetail: 'the reservation was released undispatched and cannot execute'
      });
    default:
      refuse('governed_leaf_authority_invalid',
        `reservation ${reservation.id} is in an unrecognized state`);
  }

  // 3. Credentials BEFORE start, so a missing one costs nothing.
  let credentials = null;
  try {
    credentials = await resolveCredentials({
      adapterId: reservation.preparedRequest.adapterId,
      provider: reservation.preparedRequest.provider
    });
  } catch (_) {
    credentials = null;
  }
  if (!credentials) {
    await repository.releaseUndispatchedEconomicReservation({
      reservationId: reservation.id, reason: 'governed_leaf_credentials_unavailable'
    });
    return outcome('credentials_unavailable', {
      reservationId: reservation.id,
      ordinal,
      failureReason: 'provider_credentials_unavailable',
      failureDetail: `no credential is available for ${reservation.preparedRequest.provider}`
    });
  }

  // 4. The one-winner start. Nothing else authorizes transport.
  let startResult;
  try {
    startResult = await repository.markEconomicRequestStarted({
      reservationId: reservation.id,
      expectedClaimEventPosition: attemptClaimEventPosition
    });
  } catch (error) {
    if (error && error.code === 'ECONOMIC_REQUEST_STALE_CLAIM_ATTEMPT') {
      // This attempt's claim was superseded before it could start the request.
      // Nothing was sent and nothing was recorded; the claim that now governs
      // the Run will make its own decision about this reservation.
      return outcome('reservation_refused', {
        reservationId: reservation.id,
        ordinal,
        failureReason: 'governed_leaf_stale_claim_attempt',
        failureDetail: error.message
      });
    }
    if (error && error.code === 'ECONOMIC_REQUEST_ALREADY_STARTED') {
      // Another caller won the race and is still working. This one contacts no
      // provider and — importantly — does NOT settle: the winner owns this
      // reservation's outcome, and settling here would discard the metered
      // usage the winner is about to report and charge the maximum instead.
      // A genuinely abandoned start is settled by the recovery branch above,
      // on a later invocation, when no winner is live.
      return outcome('already_dispatched_unresolved', {
        possiblyDispatched: true,
        reservationId: reservation.id,
        ordinal,
        failureReason: 'governed_leaf_start_lost',
        failureDetail: 'another caller holds dispatch authority for this request'
      });
    }
    throw error;
  }

  // 4b. THE REQUEST IS NOW GOING TO BE ISSUED — and not one line earlier.
  //
  // Everything that records or charges "a request happened" belongs here,
  // after the reservation is admitted and this caller has won the single
  // dispatch authority, and before any byte leaves. Placed before the gate
  // instead, a request the progress control REFUSED still consumed a runtime
  // budget charge and still left a durable provider-request replay item
  // claiming it was issued — so the budget ledger counted two requests where
  // the economic ledger and the transport counted one, and replay described a
  // request that never existed.
  //
  // Placed after dispatch it would be worse: a crash mid-flight would leave no
  // durable trace of a request that may already have reached the provider.
  if (typeof persistRequestEvidence === 'function') {
    await persistRequestEvidence({
      reservationId: reservation.id,
      ordinal,
      exactRequestHash: reservation.exactRequestHash
    });
  }

  // 5. Dispatch the persisted bytes.
  const dispatched = await dispatchGovernedRequest({
    startResult,
    transport,
    resolveCredentials: async () => credentials,
    timeoutMs,
    maxResponseBytes
  });

  if (dispatched.status !== 'received') {
    const closed = await closeUnconfirmed(repository, startResult.reservation, ordinal);
    return outcome('dispatch_failed', {
      possiblyDispatched: dispatched.possiblyDispatched,
      reservationId: reservation.id,
      ordinal,
      settlementReceiptHash: closed.settlementReceiptHash,
      failureReason: dispatched.status,
      failureDetail: dispatched.detail
    });
  }

  const text = dispatched.text;
  const responseHash = sha256Hex(text);
  const responseIdentity = dispatched.responseIdentity ||
    `reservation:${reservation.id}:response`;

  // 6. The existing canonical provider evidence is persisted FIRST, so the
  //    worker loop can never consume a response that could not be recovered
  //    without another provider request.
  if (typeof persistResponseEvidence === 'function') {
    await persistResponseEvidence({ text, responseIdentity, responseHash, reservation });
  }
  await repository.markEconomicResponsePersisted({
    reservationId: reservation.id, responseIdentity, responseHash
  });

  // 7. Settlement from captured facts only.
  const settlementReceiptHash = await settleFromDurableFacts(
    repository, await repository.getEconomicReservation(reservation.id),
    dispatched.reportedUsage);

  return outcome('received', {
    possiblyDispatched: true,
    text,
    responseIdentity,
    responseHash,
    reportedUsage: dispatched.reportedUsage,
    reservationId: reservation.id,
    ordinal,
    settlementReceiptHash
  });
}

// A request that reached the provider but produced no durable response still
// has to close its books. It settles at the reserved maximum and is never
// released, because releasing would hand back money that may be owed.
async function closeUnconfirmed(repository, reservation, ordinal) {
  const receiptHash = await settleFromDurableFacts(repository, reservation);
  return outcome('already_dispatched_unresolved', {
    possiblyDispatched: true,
    reservationId: reservation.id,
    ordinal,
    settlementReceiptHash: receiptHash,
    failureReason: 'provider_outcome_unknown',
    failureDetail: 'the request was started and no confirmed response is durable'
  });
}

// Settles once, idempotently. Usage is derived rather than trusted: anything
// absent, partial or malformed settles at the reserved maximum.
async function settleFromDurableFacts(repository, reservation, reportedUsage = null) {
  if (!reservation) return null;
  if (reservation.state === 'settled') {
    return reservation.settlementReceipt ? reservation.settlementReceipt.receiptHash : null;
  }
  const usage = reservation.responseHash === null
    ? { source: 'authorized_maximum_assumed' }
    : derivePlannerSettlementUsage(reportedUsage);
  try {
    const settled = await repository.settleEconomicRequest({
      reservationId: reservation.id, usage
    });
    return settled.settlementReceipt ? settled.settlementReceipt.receiptHash : null;
  } catch (error) {
    // An identical re-report must not block the worker loop.
    if (error && error.code === 'ECONOMIC_RESERVATION_ALREADY_SETTLED') {
      const current = await repository.getEconomicReservation(reservation.id);
      return current && current.settlementReceipt
        ? current.settlementReceipt.receiptHash
        : null;
    }
    throw error;
  }
}

module.exports = {
  GOVERNED_RECOVERY_CLASSIFICATIONS,
  classifyGovernedRequestRecovery,
  GOVERNED_LEAF_OUTCOMES,
  GOVERNED_LEAF_REFUSALS,
  GovernedLeafOrchestrationError,
  WORKER_ROLE,
  runGovernedLeafRequest,
  selectRunProviderPath,
  settleFromDurableFacts
};

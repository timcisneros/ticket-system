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
// The single decision that keeps historical Runs working and governed Runs
// governed. There is deliberately no fourth answer, and no timestamp anywhere:
// a Run's age says nothing about whether it was admitted with authority.

function selectRunProviderPath(run) {
  const isLeaf = Boolean(run && run.leafRunBinding);
  const hasEnvelope = Boolean(
    run && run.governedExecution !== undefined && run.governedExecution !== null);

  if (!isLeaf && !hasEnvelope) return { path: 'historical', authority: null };
  if (!isLeaf && hasEnvelope) {
    // A governed envelope on a Run that is not a leaf is incoherent: only leaf
    // admission produces one. Falling back would run it ungoverned.
    refuse('governed_leaf_authority_invalid',
      `run ${run.id} carries governed authority without a leaf binding`);
  }
  if (!hasEnvelope) {
    // A structured leaf Run admitted before Tranche 4 has no envelope and no
    // account behind it. It keeps the historical path; it is not failed.
    return { path: 'historical', authority: null };
  }
  // Any defect throws here. It NEVER degrades to the historical path, because
  // a Run admitted as governed running ungoverned is the outcome this whole
  // cutover exists to prevent.
  let classified;
  try {
    classified = classifyRunGovernance(run);
  } catch (error) {
    refuse('governed_leaf_authority_invalid',
      `run ${run.id} governed authority is unusable: ${error.message}`,
      { cause: (error.detail && error.detail.reason) || error.code || null });
  }
  if (!classified.governed) {
    refuse('governed_leaf_authority_absent',
      `run ${run.id} governed authority could not be classified`);
  }
  return { path: 'governed', authority: classified.authority };
}

// ── One provider-request opportunity ────────────────────────────────────────

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
  recoveredProviderCall = null
}) {
  const selected = selectRunProviderPath(run);
  if (selected.path !== 'governed') {
    refuse('governed_leaf_authority_absent',
      `run ${run.id} is not a governed leaf run`);
  }

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
      reservationId: reservation.id
    });
  } catch (error) {
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
  GOVERNED_LEAF_OUTCOMES,
  GOVERNED_LEAF_REFUSALS,
  GovernedLeafOrchestrationError,
  WORKER_ROLE,
  runGovernedLeafRequest,
  selectRunProviderPath,
  settleFromDurableFacts
};

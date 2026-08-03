'use strict';

// Canonical correlation between captured governed transports and the durable
// authority that authorized them.
//
// WHY THIS IS A MODULE AND NOT A CLOSURE IN ONE SUITE. Attribution used to be
// done inline by each suite, by matching a path substring in the prompt and by
// reading the fixture's arrival counter as if it were a Run's ordinal. Both are
// attribution by RESEMBLANCE: they ask what a request looks like rather than
// which authority admitted it. That produced a failure appearing roughly twice
// in thirty runs, which survived three sessions because a green retry looks
// exactly like a fix.
//
// The durable answer already exists. Every governed request reserves economic
// authority recording `exact_request_hash` — the hash of the bytes that will be
// sent. A captured call belongs to the reservation whose hash its body
// reproduces, and to nothing else.
//
// Pure by construction: callers pass captured entries and reservation rows, and
// nothing here reads a clock, a database or a file. That is what lets a single
// deterministic run prove the rules, instead of waiting for a race to reappear.

const crypto = require('node:crypto');

const CORRELATION_REFUSALS = Object.freeze([
  'transport_unattributable',
  'transport_duplicate_dispatch',
  'reservation_hash_ambiguous'
]);

class GovernedTransportCorrelationError extends Error {
  constructor(reason, message, detail = {}) {
    super(message);
    this.name = 'GovernedTransportCorrelationError';
    this.code = 'GOVERNED_TRANSPORT_CORRELATION_REFUSED';
    this.reason = reason;
    this.detail = detail;
  }
}

function refuse(reason, message, detail) {
  if (!CORRELATION_REFUSALS.includes(reason)) {
    throw new GovernedTransportCorrelationError('transport_unattributable',
      `unsupported correlation refusal: ${String(reason)}`);
  }
  throw new GovernedTransportCorrelationError(reason, message, detail);
}

function hashRequestBody(body) {
  return crypto.createHash('sha256').update(String(body === undefined || body === null
    ? '' : body), 'utf8').digest('hex');
}

// Correlate captured transports against durable reservations.
//
// `captures`      — fixture records, each carrying the exact bytes it received.
// `reservations`  — economic reservation rows: exactRequestHash, reservationId,
//                   runId (null for the planner), ticketId, logicalSourceIdentity,
//                   modelRequestOrdinal.
//
// Every capture must correlate. An unattributable call is refused rather than
// dropped: silently ignoring a transport nobody authorized would hide the exact
// class of defect this exists to detect.
function correlateGovernedTransports({ captures = [], reservations = [] } = {}) {
  const byHash = new Map();
  for (const reservation of reservations) {
    const hash = reservation.exactRequestHash;
    if (!hash) continue;
    if (byHash.has(hash)) {
      refuse('reservation_hash_ambiguous',
        `two reservations record the same exact request hash ${hash}`,
        { hash });
    }
    byHash.set(hash, reservation);
  }

  const attributed = [];
  const seenReservationIds = new Map();
  captures.forEach((capture, index) => {
    const hash = hashRequestBody(capture.body);
    const reservation = byHash.get(hash);
    if (!reservation) {
      refuse('transport_unattributable',
        `captured transport ${index} matches no reservation (hash ${hash})`,
        { captureIndex: index, hash });
    }
    // ONE DISPATCH AUTHORITY, ONE TRANSPORT. A second call reproducing the same
    // bytes is a duplicate dispatch, and must not be collapsed by a Set: the
    // whole point is that the duplicate is visible.
    const priorIndex = seenReservationIds.get(reservation.reservationId);
    if (priorIndex !== undefined) {
      refuse('transport_duplicate_dispatch',
        `reservation ${reservation.reservationId} was transported twice ` +
        `(captures ${priorIndex} and ${index})`,
        { reservationId: reservation.reservationId, captures: [priorIndex, index] });
    }
    seenReservationIds.set(reservation.reservationId, index);
    attributed.push({
      captureIndex: index,
      requestHash: hash,
      reservationId: reservation.reservationId,
      runId: reservation.runId === undefined ? null : reservation.runId,
      ticketId: reservation.ticketId === undefined ? null : reservation.ticketId,
      logicalSourceIdentity: reservation.logicalSourceIdentity || null,
      ordinal: reservation.modelRequestOrdinal,
      responseIdentity: capture.responseIdentity || null
    });
  });
  return attributed;
}

// The transports belonging to ONE Run, in ordinal order. A planner reservation
// carries a null runId and is therefore never returned for a leaf.
function transportsForRun(attributed, runId) {
  return attributed
    .filter(item => item.runId !== null && Number(item.runId) === Number(runId))
    .sort((left, right) => left.ordinal - right.ordinal);
}

// The ordinals a Run actually transported, as a comparable string. Callers
// assert on this rather than on counts, so "two calls happened" cannot stand in
// for "requests 1 and 2 happened".
function transportedOrdinals(attributed, runId) {
  return transportsForRun(attributed, runId).map(item => item.ordinal).join(',');
}

// Reservations that hold dispatch authority but never reached the transport.
// An omission is as much a defect as a duplicate, and is invisible to any
// assertion phrased as a count of what did arrive.
function missingTransports(attributed, reservations, runId) {
  const transported = new Set(transportsForRun(attributed, runId)
    .map(item => item.reservationId));
  return reservations
    .filter(reservation => reservation.runId !== null &&
      reservation.runId !== undefined &&
      Number(reservation.runId) === Number(runId) &&
      !transported.has(reservation.reservationId))
    .map(reservation => ({
      reservationId: reservation.reservationId,
      ordinal: reservation.modelRequestOrdinal,
      logicalSourceIdentity: reservation.logicalSourceIdentity || null,
      exactRequestHash: reservation.exactRequestHash
    }));
}

module.exports = {
  CORRELATION_REFUSALS,
  GovernedTransportCorrelationError,
  correlateGovernedTransports,
  hashRequestBody,
  missingTransports,
  transportedOrdinals,
  transportsForRun
};

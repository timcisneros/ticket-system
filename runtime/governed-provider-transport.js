'use strict';

// Tranche 4 — the governed provider transport seam.
//
// This is the ONLY place a governed request reaches a provider, and it is
// deliberately the least capable component in the chain. It cannot choose a
// route, a model, a provider or an endpoint: every one of those arrives already
// captured, and this module's whole job is to send bytes it did not compose to
// a target it did not select.
//
//   markEconomicRequestStarted() ──▶ persisted bytes ──▶ THIS ──▶ provider
//
// DISPATCH AUTHORITY IS NOT AN ARGUMENT. A caller cannot assert that it may
// dispatch; it must present the successful result of the one-winner start
// transition, and the bytes it sends are the ones that result carried. Bytes
// supplied by the caller are refused outright, because a caller that can
// substitute bytes after reservation can dispatch something nobody priced.
//
// CREDENTIALS ARE RESOLVED SEPARATELY and never influence routing. A missing
// credential refuses; it does not pick another route, change the model, or
// invoke fallback. Credential resolution is passed in so that it can be run
// BEFORE the reservation is started, letting an avoidable credential failure
// consume no reservation at all.

const { deepFreeze } = require('./declared-work-contract');
const { getAdapterCapability } = require('./provider-adapter-capability');


// The existing planner bound. Governed responses are subject to the same limit
// as every other planner response; this module does not relax it.
const MAX_GOVERNED_RESPONSE_BYTES = 65_536;
const DEFAULT_TIMEOUT_MS = 60_000;

// Closed outcome vocabulary. Every one of these is terminal for the attempt:
// there is no retry, no second route and no repair anywhere in this module.
const TRANSPORT_OUTCOMES = Object.freeze([
  'received',
  'credentials_unavailable',
  'transport_refused',
  'timeout',
  'response_too_large',
  'response_empty'
]);

// Outcomes that mean the bytes may already have reached the provider. These can
// never be released as undispatched; they settle.
const POSSIBLY_DISPATCHED_OUTCOMES = Object.freeze([
  'transport_refused',
  'timeout',
  'response_too_large',
  'response_empty',
  'received'
]);

const TRANSPORT_REFUSALS = Object.freeze([
  'dispatch_not_authorized',
  'caller_supplied_bytes',
  'transport_target_drift',
  'unsupported_adapter',
  'transport_unavailable'
]);

class GovernedTransportError extends Error {
  constructor(code, message, detail = {}) {
    super(message);
    this.name = 'GovernedTransportError';
    this.code = code;
    this.detail = detail;
  }
}

function fail(message, code = 'GOVERNED_TRANSPORT_INVALID', detail = {}) {
  throw new GovernedTransportError(code, message, detail);
}

function refuse(reason, message = null) {
  if (!TRANSPORT_REFUSALS.includes(reason)) {
    fail(`Unsupported transport refusal reason: ${String(reason)}`);
  }
  fail(message || reason, 'GOVERNED_TRANSPORT_REFUSED', { reason });
}

// Proves the caller holds genuine dispatch authority from the one-winner start
// transition, rather than merely claiming it. The shape checked here is exactly
// what `markEconomicRequestStarted` returns on success and nothing else.
function assertDispatchAuthority(startResult) {
  if (!startResult || typeof startResult !== 'object') {
    refuse('dispatch_not_authorized', 'dispatch requires the result of a winning start');
  }
  const { reservation, serializedRequest } = startResult;
  if (!reservation || typeof reservation !== 'object') {
    refuse('dispatch_not_authorized', 'the start result carries no reservation');
  }
  if (reservation.state !== 'request_started') {
    refuse('dispatch_not_authorized',
      `dispatch requires a started reservation, not ${String(reservation.state)}`);
  }
  if (typeof serializedRequest !== 'string' || serializedRequest.length === 0) {
    refuse('dispatch_not_authorized', 'the start result carries no persisted bytes');
  }
  if (serializedRequest !== reservation.serializedRequest) {
    refuse('dispatch_not_authorized',
      'the start result bytes disagree with the reservation they came from');
  }
  return { reservation, serializedRequest };
}

// ── Dispatch ────────────────────────────────────────────────────────────────
//
// Returns a closed outcome. It never throws for a provider-side condition: a
// refused, timed-out or oversized response is a RESULT, because the caller must
// settle the reservation either way. It throws only when the caller itself is
// not entitled to dispatch.

async function dispatchGovernedRequest({
  startResult,
  transport,
  resolveCredentials,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxResponseBytes = MAX_GOVERNED_RESPONSE_BYTES,
  serializedRequest: callerBytes = undefined
}) {
  // A caller with bytes of its own has no business here. Refusing the parameter
  // outright is what makes byte substitution unrepresentable rather than merely
  // discouraged.
  if (callerBytes !== undefined) {
    refuse('caller_supplied_bytes',
      'governed dispatch sends the persisted bytes and never caller-supplied bytes');
  }
  const { reservation, serializedRequest } = assertDispatchAuthority(startResult);
  const prepared = reservation.preparedRequest;
  if (!prepared || typeof prepared !== 'object') {
    refuse('dispatch_not_authorized', 'the reservation carries no prepared request');
  }

  // The adapter must still exist and the captured target must still resolve to
  // the same immutable snapshot. Drift between capture and dispatch refuses
  // rather than silently sending to a different target.
  let capability;
  try {
    capability = getAdapterCapability(prepared.adapterId);
  } catch (error) {
    refuse('unsupported_adapter', `no capability is registered for ${String(prepared.adapterId)}`);
  }
  // The target is verified against the reservation's own captured authority.
  //
  // Re-resolving the immutable target from the registry belongs UPSTREAM, at
  // routing capture and request preparation, where the full target document
  // with its route reference and evidence identity exists; the reservation
  // retains only the resolved target and its evidence hash. What this seam can
  // and must prove is that the bytes about to be sent name the same target the
  // reservation was priced against — so a prepared request swapped for one
  // aimed elsewhere cannot ride a valid reservation to the wire.
  const authority = reservation.economicAuthority;
  if (!authority || typeof authority !== 'object') {
    refuse('dispatch_not_authorized', 'the reservation carries no captured economic authority');
  }
  for (const field of ['adapterId', 'provider', 'dispatchTarget', 'targetEvidenceHash']) {
    if (prepared[field] !== authority[field]) {
      refuse('transport_target_drift',
        `prepared request ${field} disagrees with the captured economic authority`);
    }
  }
  if (prepared.requestHash !== reservation.exactRequestHash) {
    refuse('transport_target_drift',
      'the prepared request is not the one this reservation authorized');
  }

  if (typeof transport !== 'function') {
    refuse('transport_unavailable', 'no governed transport was provided');
  }

  // Credentials are resolved here, AFTER start, only because this function may
  // be called with a reservation already started. Callers are expected to
  // resolve them before starting so an avoidable failure consumes nothing; that
  // ordering is the caller's, and it is tested at the orchestration seam.
  let credentials = null;
  if (typeof resolveCredentials === 'function') {
    try {
      credentials = await resolveCredentials({
        adapterId: prepared.adapterId,
        provider: prepared.provider
      });
    } catch (error) {
      return outcome('credentials_unavailable', { detail: error.message });
    }
    if (!credentials) {
      return outcome('credentials_unavailable', {
        detail: `no credential is available for ${prepared.provider}`
      });
    }
  }

  let response;
  try {
    response = await transport({
      // Everything the transport needs, all of it captured upstream. There is
      // no model, provider or endpoint parameter it may choose for itself.
      adapterId: prepared.adapterId,
      provider: prepared.provider,
      dispatchTarget: prepared.dispatchTarget,
      endpointIdentity: prepared.endpointIdentity,
      // THE EXACT PERSISTED BYTES. Not an object to re-serialize.
      serializedRequest,
      byteCount: reservation.serializedRequestByteCount,
      credentials,
      timeoutMs,
      maxResponseBytes
    });
  } catch (error) {
    if (error && error.name === 'AbortError') {
      return outcome('timeout', { detail: 'the governed request timed out' });
    }
    return outcome('transport_refused', { detail: error ? error.message : 'transport failed' });
  }

  if (!response || typeof response !== 'object') {
    return outcome('transport_refused', { detail: 'the transport returned no response' });
  }
  if (response.timedOut === true) {
    return outcome('timeout', { detail: 'the governed request timed out' });
  }
  const text = typeof response.text === 'string' ? response.text : '';
  const byteCount = Buffer.byteLength(text, 'utf8');
  // The existing planner bound, enforced on the governed path too.
  if (byteCount > maxResponseBytes) {
    return outcome('response_too_large', {
      detail: `response of ${byteCount} bytes exceeds the ${maxResponseBytes}-byte bound`
    });
  }
  if (text.length === 0) return outcome('response_empty', { detail: 'the provider returned no text' });

  return outcome('received', {
    text,
    responseByteCount: byteCount,
    // Provider-reported usage, passed through UNINTERPRETED. Deciding whether
    // it is trustworthy enough to settle against belongs to the settlement
    // contract, not to the wire.
    reportedUsage: response.usage === undefined ? null : response.usage,
    responseIdentity: typeof response.identity === 'string' && response.identity
      ? response.identity
      : null
  });
}

function outcome(status, rest = {}) {
  if (!TRANSPORT_OUTCOMES.includes(status)) {
    fail(`Unsupported transport outcome: ${String(status)}`);
  }
  return deepFreeze({
    status,
    // Whether the bytes may already have reached the provider. This is the fact
    // recovery needs: anything possibly dispatched settles and is never
    // released as undispatched.
    possiblyDispatched: POSSIBLY_DISPATCHED_OUTCOMES.includes(status),
    text: null,
    responseByteCount: 0,
    reportedUsage: null,
    responseIdentity: null,
    detail: null,
    ...rest
  });
}

module.exports = {
  DEFAULT_TIMEOUT_MS,
  GovernedTransportError,
  MAX_GOVERNED_RESPONSE_BYTES,
  POSSIBLY_DISPATCHED_OUTCOMES,
  TRANSPORT_OUTCOMES,
  TRANSPORT_REFUSALS,
  assertDispatchAuthority,
  dispatchGovernedRequest,
  refuseGovernedTransport: refuse
};

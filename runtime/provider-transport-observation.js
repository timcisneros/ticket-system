'use strict';

// Tranche 6 — the durable observation of PROVIDER TRANSPORT INVOCATION.
//
// WHY THIS EXISTS. The durable record already proved that a provider request
// was authorized (`provider.request.persisted`) and that a provider response
// came back (`provider.response.persisted`). Between those two facts there was
// nothing. A Run that persisted a request and no response was therefore
// indistinguishable from three completely different histories:
//
//   * production never reached its transport at all;
//   * production invoked its transport and the process died mid-flight;
//   * production invoked its transport, the provider answered, and the
//     response could not be persisted.
//
// After the ephemeral evaluation database is gone, an operator asked "was the
// provider actually called?" had no durable fact to read. `provider.request
// .persisted` cannot answer it — it is written AFTER admission and after
// dispatch authority is won but BEFORE any byte leaves — so projecting it as
// "transport attempted" would state something production never observed.
//
// ── WHAT THE FACT MEANS, EXACTLY ────────────────────────────────────────────
//
// `provider.transport_invoked` means:
//
//   The production provider transport owner executed its platform transport
//   call — `fetch()` for the ungoverned worker, `https.request()` for both
//   governed roles — for this canonical provider request, and handed it the
//   request body.
//
// IT IS RECORDED AFTER THAT CALL HAS ALREADY HAPPENED, not before it. That
// ordering is the whole design: an observation written before the platform call
// would be a claim about the future, and a crash in the gap would leave a
// durable event asserting an invocation that never occurred. A fact that can be
// wrong in the direction of overstating is worse than no fact at all.
//
// ── WHAT IT DOES NOT MEAN ───────────────────────────────────────────────────
//
// Application code cannot prove any of the following merely by invoking
// `fetch` or `https.request`, so this event asserts none of them:
//
//   * that bytes were written to a socket;
//   * that the request was delivered to the network;
//   * that the provider received it;
//   * that the provider accepted, processed or was paid for it.
//
// This is why the event is not named `bytesSent`, `requestDelivered`,
// `providerReceivedRequest` or `networkTransmissionConfirmed`.
//
// ── THE CRASH WINDOW, STATED PRECISELY ──────────────────────────────────────
//
// The platform call and the durable write cannot be made atomic: one is an OS
// operation and the other is a database transaction. The window is therefore
// unavoidable, and it is placed deliberately so that it can only ever LOSE a
// true fact, never invent a false one:
//
//   PRESENT  ⇒ the transport function was invoked.        (no false positives)
//   ABSENT   ⇏ the transport function was not invoked.    (false negatives are
//                                                          possible)
//
// A process that dies between the platform call and the commit of this event
// leaves the request in flight with no durable transport observation. Every
// consumer must therefore treat absence as UNKNOWN, never as proof of
// non-invocation. The economic reservation — not this event — remains the
// authority on whether a request may be repeated.
//
// ── WHAT IT IS NOT ALLOWED TO DO ────────────────────────────────────────────
//
// This is append-only evidence. It changes no retry decision, no timeout, no
// request body, no credential and no economic authority, and it never converts
// a transport failure into a success. It is written while the request is
// already in flight, which is also why a failure to write it is reported as a
// possibly-dispatched outcome rather than as an undispatched one: by then the
// bytes have already been handed to the platform.

const PROVIDER_TRANSPORT_INVOKED_EVENT = 'provider.transport_invoked';

// The production function that owns the platform call, per role. These are
// identities of REAL transport owners; a higher-level "about to dispatch" site
// is not one of them and must never be recorded here.
const TRANSPORT_OWNERS = Object.freeze({
  ungoverned_worker: 'server.js:callOpenAI:global-fetch',
  structured_planner: 'runtime/governed-openai-transport.js:https.request',
  governed_leaf_worker: 'runtime/governed-openai-transport.js:https.request'
});

const TRANSPORT_INVOCATION_ROLES = Object.freeze(Object.keys(TRANSPORT_OWNERS));

// The strength of the fact, as data, so a projection can carry the limitation
// with the value instead of restating it in prose that can drift.
const PROVIDER_TRANSPORT_INVOKED_STRENGTH = Object.freeze({
  event: PROVIDER_TRANSPORT_INVOKED_EVENT,
  proves: 'the production transport owner executed its platform transport call ' +
    'for this canonical provider request',
  doesNotProve: Object.freeze([
    'that bytes were written to a socket',
    'that the request reached the network',
    'that the provider received the request',
    'that the provider accepted or processed the request'
  ]),
  recordedRelativeToInvocation: 'after',
  presenceMeans: 'the transport function was invoked',
  absenceMeans: 'UNKNOWN — a crash between the platform call and this commit ' +
    'loses the fact; absence is never proof of non-invocation'
});

// Keys that may never appear in a transport observation payload, checked by
// name rather than trusted to callers. A credential reaching durable evidence
// is not a formatting mistake, so this refuses instead of redacting.
const FORBIDDEN_PAYLOAD_KEYS = Object.freeze([
  'authorization', 'apikey', 'api_key', 'credential', 'credentials',
  'credentialhash', 'credentialprefix', 'credentiallength', 'secret',
  'token', 'bearer', 'headers', 'body', 'serializedrequest'
]);

class ProviderTransportObservationError extends Error {
  constructor(message, code = 'PROVIDER_TRANSPORT_OBSERVATION_INVALID', detail = {}) {
    super(message);
    this.name = 'ProviderTransportObservationError';
    this.code = code;
    this.detail = detail;
    // Marks an error raised by the observation seam itself, so a transport
    // owner can re-throw it without it being reclassified as a provider fault.
    this.providerTransportObservationFailure = true;
  }
}

function assertNoCredentialMaterial(payload, label = 'payload') {
  for (const key of Object.keys(payload || {})) {
    if (FORBIDDEN_PAYLOAD_KEYS.includes(key.toLowerCase())) {
      throw new ProviderTransportObservationError(
        `a provider transport observation ${label} may never carry ${key}`,
        'PROVIDER_TRANSPORT_OBSERVATION_CREDENTIAL_MATERIAL', { key, label });
    }
  }
  return payload;
}

// Builds the bounded, non-secret payload. Everything here is identity or size:
// nothing describes the request contents and nothing describes the credential.
function buildProviderTransportInvocationPayload(input) {
  // THE INPUT IS CHECKED, NOT ONLY THE RESULT. Unknown fields are dropped by
  // the destructuring below, so a result-only check could never fire; refusing
  // at the input is what makes "a credential can never reach this evidence" a
  // mechanical fact rather than a property of the current field list.
  assertNoCredentialMaterial(input, 'input');
  return buildCheckedPayload(input);
}

function buildCheckedPayload({
  role,
  evidenceKey,
  endpointIdentity,
  method = 'POST',
  provider = 'openai',
  requestByteCount = null,
  providerRequestEvidenceKey = null,
  reservationId = null,
  modelRequestOrdinal = null,
  executionTurn = null,
  slot = null,
  invokedAt = null
}) {
  if (!TRANSPORT_INVOCATION_ROLES.includes(role)) {
    throw new ProviderTransportObservationError(
      `unsupported provider transport role: ${String(role)}`);
  }
  if (typeof evidenceKey !== 'string' || evidenceKey.length === 0) {
    throw new ProviderTransportObservationError(
      'a provider transport observation requires a canonical evidence key');
  }
  if (typeof endpointIdentity !== 'string' || endpointIdentity.length === 0) {
    throw new ProviderTransportObservationError(
      'a provider transport observation requires the endpoint identity it was invoked against');
  }
  const payload = {
    role,
    // The production function that actually made the platform call. Derived
    // from the role rather than supplied, so a caller cannot record a
    // higher-level site as though it were the transport owner.
    transportOwner: TRANSPORT_OWNERS[role],
    governed: role !== 'ungoverned_worker',
    provider,
    endpoint: endpointIdentity,
    method,
    requestByteCount: Number.isSafeInteger(requestByteCount) && requestByteCount >= 0
      ? requestByteCount
      : null,
    // The canonical request identity this invocation belongs to. Whichever of
    // these exists for the role is what binds the fact to the request.
    providerRequestEvidenceKey: providerRequestEvidenceKey || null,
    reservationId: Number.isSafeInteger(reservationId) ? reservationId : null,
    modelRequestOrdinal: Number.isSafeInteger(modelRequestOrdinal) ? modelRequestOrdinal : null,
    executionTurn: Number.isSafeInteger(executionTurn) ? executionTurn : null,
    slot: slot === null || slot === undefined ? null : String(slot),
    invokedAt: invokedAt || new Date().toISOString(),
    // Carried WITH the value so a reader of a projected artifact cannot lose
    // the limitation on the way.
    recordedRelativeToInvocation:
      PROVIDER_TRANSPORT_INVOKED_STRENGTH.recordedRelativeToInvocation
  };
  return Object.freeze(assertNoCredentialMaterial(payload));
}

// The seam a transport owner calls. It is deliberately tolerant of an ABSENT
// observer — the transport owners are also driven by contract tests and by
// non-Run callers that own no durable evidence — and deliberately intolerant of
// a failing one: evidence that silently disappears is how absence stops meaning
// UNKNOWN and starts meaning nothing at all.
async function observeProviderTransportInvocation(observe, input) {
  if (typeof observe !== 'function') return null;
  const payload = buildProviderTransportInvocationPayload(input);
  try {
    return await observe(payload);
  } catch (error) {
    if (error && error.providerTransportObservationFailure === true) throw error;
    const wrapped = new ProviderTransportObservationError(
      `the provider transport invocation observation could not be persisted: ${error.message}`,
      'PROVIDER_TRANSPORT_OBSERVATION_NOT_PERSISTED', { cause: error.message });
    throw wrapped;
  }
}

module.exports = {
  FORBIDDEN_PAYLOAD_KEYS,
  PROVIDER_TRANSPORT_INVOKED_EVENT,
  PROVIDER_TRANSPORT_INVOKED_STRENGTH,
  ProviderTransportObservationError,
  TRANSPORT_INVOCATION_ROLES,
  TRANSPORT_OWNERS,
  buildProviderTransportInvocationPayload,
  observeProviderTransportInvocation
};

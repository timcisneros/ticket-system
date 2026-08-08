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
// ── IT IS EVIDENCE, NOT EXECUTION AUTHORITY ─────────────────────────────────
//
// THE INVARIANT: an observation must not change the outcome it observes.
//
// This seam therefore CANNOT FAIL A PROVIDER REQUEST. It is invoked with the
// request already in flight, so anything it did on failure other than nothing
// would be a decision about a provider interaction taken by an evidence writer:
//
//   external transport invoked  →  observation write fails  →  provider result
//   discarded, Run failed, reservation settled at the authorized maximum
//
// That is a control point wearing an observer's name. It is refused here
// structurally: `observeProviderTransportInvocation` NEVER throws and NEVER
// returns anything a caller can branch on for control flow. It reports whether
// the fact was recorded, and that is all.
//
// WHY THAT IS STILL HONEST. The frozen rule already says absence means UNKNOWN,
// because a crash between the platform call and the commit can lose the fact.
// A failed write lands in exactly the same epistemic place: transport may have
// been invoked, the durable record cannot prove it, so the projection says
// UNKNOWN. Nothing is claimed that is not known, and no product outcome is
// invented to preserve the appearance of completeness.
//
// The write failure is worth NOTICING, so an optional reporter may be supplied.
// It is a bounded diagnostic, invoked at most once, never retried, and its own
// failure is swallowed — recording a failure to write evidence must not become
// another way for evidence writing to break a request.
//
// Everything else it must not do follows from the same rule: it changes no
// retry decision, no timeout, no request body, no credential, no economic
// authority, and it never converts a transport failure into a success or a
// success into a failure.

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
    'loses the fact, and so does a failed evidence write, which is deliberately ' +
    'not escalated into a provider failure; absence is never proof of non-invocation',
  // Stated as data because it is the property that makes this an observation
  // rather than a control point.
  cannotAlterObservedOutcome: 'a failure to record this fact never cancels a ' +
    'provider result, never triggers a retry, never changes parsing or ' +
    'settlement, and never turns a success into a failure or the reverse'
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

// The reasons an observation may not have been recorded. Each is a statement
// about the EVIDENCE, never about the provider request, which by this point has
// already been handed to the platform and is unaffected either way.
const OBSERVATION_RESULTS = Object.freeze([
  'recorded',
  // No observer was supplied. The transport owners are also driven by contract
  // tests and by non-Run callers that own no durable evidence.
  'no_observer',
  // The payload could not be built — a caller defect, caught here so that a
  // caller defect cannot become a provider failure. `buildProviderTransport
  // InvocationPayload` still throws when called directly, which is where that
  // defect is meant to be found.
  'payload_refused',
  // The write itself failed. This is the case the invariant exists for.
  'not_persisted'
]);

// ── THE SEAM A TRANSPORT OWNER CALLS ────────────────────────────────────────
//
// IT NEVER THROWS. Not for a missing observer, not for a bad payload, not for a
// failed write. The request it is observing is already in flight, so throwing
// would hand an evidence writer the power to discard a provider result — which
// is the one thing an observer must not be able to do.
//
// It returns a RESULT, and the result is deliberately not an outcome a caller
// can act on: every transport owner ignores it. It exists so that a test can
// assert what happened to the evidence without the product ever branching on it.
async function observeProviderTransportInvocation(observe, input, {
  // Optional, bounded, at-most-once diagnostic. Its own failure is swallowed:
  // recording a failure to write evidence must never become another way for
  // evidence writing to break a request, and it must never write more evidence.
  reportObservationFailure = null
} = {}) {
  const report = (result, detail) => {
    if (typeof reportObservationFailure !== 'function') return;
    try {
      const reported = reportObservationFailure({ result, detail });
      // A reporter that returns a promise must not be awaited — awaiting it
      // would put a second write back on the provider path — and its rejection
      // must not surface as an unhandled one.
      if (reported && typeof reported.catch === 'function') reported.catch(() => {});
    } catch (_) { /* a diagnostic of last resort reports nothing further */ }
  };

  if (typeof observe !== 'function') {
    return Object.freeze({ result: 'no_observer', recorded: false, detail: null });
  }

  let payload;
  try {
    payload = buildProviderTransportInvocationPayload(input);
  } catch (error) {
    report('payload_refused', error.message);
    return Object.freeze({
      result: 'payload_refused', recorded: false, detail: error.message
    });
  }

  try {
    await observe(payload);
    return Object.freeze({ result: 'recorded', recorded: true, detail: null });
  } catch (error) {
    // THE INVARIANT, ENFORCED HERE AND NOWHERE ELSE. The write failed, so the
    // durable record cannot prove invocation and the projection will say
    // UNKNOWN — which is the truth, and which the frozen rule already permits.
    // The provider request is untouched.
    const detail = error && error.message ? error.message : String(error);
    report('not_persisted', detail);
    return Object.freeze({ result: 'not_persisted', recorded: false, detail });
  }
}

module.exports = {
  FORBIDDEN_PAYLOAD_KEYS,
  OBSERVATION_RESULTS,
  PROVIDER_TRANSPORT_INVOKED_EVENT,
  PROVIDER_TRANSPORT_INVOKED_STRENGTH,
  ProviderTransportObservationError,
  TRANSPORT_INVOCATION_ROLES,
  TRANSPORT_OWNERS,
  buildProviderTransportInvocationPayload,
  observeProviderTransportInvocation
};

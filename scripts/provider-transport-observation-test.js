#!/usr/bin/env node
'use strict';

// Tranche 6 — the PROVIDER TRANSPORT OBSERVATION contract, at its own module.
//
// The durable half of this seam is proved against a real database elsewhere.
// What is proved HERE is the part that decides whether the durable fact can be
// trusted at all: what the event claims, when it is recorded relative to the
// platform call, what it refuses to carry, and what it must NOT do to the
// request it observes.
//
// THE ORDERING IS THE WHOLE DESIGN. An observation written BEFORE the platform
// call is a claim about the future: a crash in the gap leaves durable evidence
// asserting an invocation that never happened. Written after, the same crash
// loses a true fact instead of inventing a false one — and every consumer
// already has to treat absence as UNKNOWN. A fact that can be wrong in the
// direction of overstating is worse than no fact at all.

const assert = require('node:assert/strict');
const {
  FORBIDDEN_PAYLOAD_KEYS,
  PROVIDER_TRANSPORT_INVOKED_EVENT,
  PROVIDER_TRANSPORT_INVOKED_STRENGTH,
  ProviderTransportObservationError,
  TRANSPORT_INVOCATION_ROLES,
  TRANSPORT_OWNERS,
  buildProviderTransportInvocationPayload,
  observeProviderTransportInvocation
} = require('../runtime/provider-transport-observation');
const {
  GOVERNED_OPENAI_ENDPOINT, createOpenAiGovernedTransport
} = require('../runtime/governed-openai-transport');
const {
  POSSIBLY_DISPATCHED_OUTCOMES, dispatchGovernedRequest
} = require('../runtime/governed-provider-transport');

let passed = 0;
function ok(condition, message) {
  assert.equal(condition, true, message);
  passed += 1;
  console.log(`  ok ${message}`);
}
async function refuses(fn) { try { await fn(); return null; } catch (error) { return error; } }

const RESPONSE_BODY = JSON.stringify({
  id: 'resp_probe',
  output: [{ type: 'message', content: [{ type: 'output_text', text: 'answer' }] }],
  usage: { input_tokens: 1, output_tokens: 1 }
});

// A stand-in for `https.request` that records when it was invoked and answers
// with the real Responses envelope.
function recordingHttpsRequest(order, { failWith = null } = {}) {
  return (options, onResponse) => {
    order.push('https.request:invoked');
    const request = {
      on(event, handler) {
        if (event === 'error' && failWith) setImmediate(() => handler(failWith));
        return request;
      },
      end() {
        order.push('https.request:end');
        if (failWith) return request;
        setImmediate(() => onResponse({
          statusCode: 200,
          on(event, handler) {
            if (event === 'data') handler(Buffer.from(RESPONSE_BODY));
            if (event === 'end') handler();
            return this;
          }
        }));
        return request;
      }
    };
    return request;
  };
}

function startResultFor({ requestHash = 'authorized-hash' } = {}) {
  const serializedRequest = '{"model":"gpt-4o-mini-2024-07-18"}';
  return {
    reservation: {
      id: 42,
      state: 'request_started',
      serializedRequest,
      serializedRequestByteCount: Buffer.byteLength(serializedRequest, 'utf8'),
      modelRequestOrdinal: 3,
      exactRequestHash: 'authorized-hash',
      preparedRequest: {
        adapterId: 'openai.responses.v1',
        provider: 'openai',
        dispatchTarget: 'gpt-4o-mini-2024-07-18',
        targetEvidenceHash: 'evidence-hash',
        endpointIdentity: GOVERNED_OPENAI_ENDPOINT,
        requestHash
      },
      economicAuthority: {
        adapterId: 'openai.responses.v1',
        provider: 'openai',
        dispatchTarget: 'gpt-4o-mini-2024-07-18',
        targetEvidenceHash: 'evidence-hash'
      }
    },
    serializedRequest
  };
}

async function main() {
  console.log('provider transport observation contract');

  // ── WHAT THE FACT CLAIMS, AND WHAT IT REFUSES TO CLAIM ────────────────
  ok(PROVIDER_TRANSPORT_INVOKED_EVENT === 'provider.transport_invoked',
    'the event is provider.transport_invoked');
  ok(PROVIDER_TRANSPORT_INVOKED_STRENGTH.recordedRelativeToInvocation === 'after',
    'the contract states it is recorded AFTER the platform call');
  ok(/UNKNOWN/.test(PROVIDER_TRANSPORT_INVOKED_STRENGTH.absenceMeans) &&
     /never proof of non-invocation/.test(PROVIDER_TRANSPORT_INVOKED_STRENGTH.absenceMeans),
  'and that its ABSENCE means UNKNOWN, never proof of non-invocation');
  for (const disclaimed of ['socket', 'network', 'provider received', 'accepted']) {
    ok(PROVIDER_TRANSPORT_INVOKED_STRENGTH.doesNotProve
      .some(statement => statement.includes(disclaimed)),
    `it explicitly disclaims proving anything about "${disclaimed}"`);
  }

  // ── THE OWNER IS DERIVED, NEVER SUPPLIED ──────────────────────────────
  ok(TRANSPORT_INVOCATION_ROLES.length === 3 &&
     TRANSPORT_OWNERS.ungoverned_worker.includes('callOpenAI') &&
     TRANSPORT_OWNERS.structured_planner.includes('https.request') &&
     TRANSPORT_OWNERS.governed_leaf_worker.includes('https.request'),
  'three roles, each naming the production function that makes the platform call');
  const substituted = buildProviderTransportInvocationPayload({
    role: 'structured_planner', evidenceKey: 'k',
    endpointIdentity: GOVERNED_OPENAI_ENDPOINT,
    transportOwner: 'server.js:dispatchGovernedLeafModelRequest'
  });
  ok(substituted.transportOwner === TRANSPORT_OWNERS.structured_planner,
    'a caller cannot record a higher-level dispatch site as the transport owner');
  let unknownRole = null;
  try {
    buildProviderTransportInvocationPayload({
      role: 'dispatch_helper', evidenceKey: 'k', endpointIdentity: 'e' });
  } catch (error) { unknownRole = error; }
  ok(unknownRole instanceof ProviderTransportObservationError,
    'an unrecognized role is refused rather than recorded');

  // ── NO CREDENTIAL MATERIAL, REFUSED AT THE INPUT ──────────────────────
  for (const key of ['Authorization', 'apiKey', 'credentialHash', 'headers', 'body']) {
    let refusal = null;
    try {
      buildProviderTransportInvocationPayload({
        role: 'ungoverned_worker', evidenceKey: 'k',
        endpointIdentity: GOVERNED_OPENAI_ENDPOINT, [key]: 'value' });
    } catch (error) { refusal = error; }
    ok(refusal !== null &&
       refusal.code === 'PROVIDER_TRANSPORT_OBSERVATION_CREDENTIAL_MATERIAL',
    `an observation carrying ${key} is REFUSED — checked at the input, so the ` +
    'rule is mechanical rather than a property of the current field list');
  }
  ok(FORBIDDEN_PAYLOAD_KEYS.length >= 10,
    'the refused-key list covers the credential header, the body and the bytes');
  const clean = buildProviderTransportInvocationPayload({
    role: 'governed_leaf_worker', evidenceKey: 'k',
    endpointIdentity: GOVERNED_OPENAI_ENDPOINT, requestByteCount: 33,
    reservationId: 42, modelRequestOrdinal: 3 });
  ok(clean.requestByteCount === 33 && clean.reservationId === 42 &&
     clean.modelRequestOrdinal === 3,
  'bounded non-secret identity — byte count, reservation and ordinal — is retained');

  // ── THE OBSERVATION IS RECORDED AFTER THE PLATFORM CALL ───────────────
  {
    const order = [];
    const transport = createOpenAiGovernedTransport({
      httpsRequest: recordingHttpsRequest(order) });
    const result = await transport({
      endpointIdentity: GOVERNED_OPENAI_ENDPOINT,
      serializedRequest: '{"model":"m"}',
      credentials: { apiKey: 'test-only-not-a-real-key' },
      timeoutMs: 1000, maxResponseBytes: 65_536,
      observeTransportInvocation: () => { order.push('observation'); },
      transportInvocationIdentity: {
        role: 'governed_leaf_worker', evidenceKey: 'probe' }
    });
    ok(result.text === 'answer' && result.identity === 'resp_probe',
      'the governed transport returns exactly the response it did before');
    ok(order.join(' > ') ===
       'https.request:invoked > https.request:end > observation',
    'THE PLATFORM CALL HAPPENS FIRST and the observation records an invocation ' +
    'that ALREADY OCCURRED');
  }

  // ── AN ABSENT OBSERVER CHANGES NOTHING ────────────────────────────────
  {
    const order = [];
    const transport = createOpenAiGovernedTransport({
      httpsRequest: recordingHttpsRequest(order) });
    const result = await transport({
      endpointIdentity: GOVERNED_OPENAI_ENDPOINT,
      serializedRequest: '{"model":"m"}',
      credentials: { apiKey: 'test-only-not-a-real-key' },
      timeoutMs: 1000, maxResponseBytes: 65_536
    });
    ok(result.text === 'answer' && !order.includes('observation'),
      'a transport with no observer behaves exactly as it always did');
  }

  // ── THE SEAM NEVER SUPPRESSES A TRANSPORT ERROR ───────────────────────
  {
    const order = [];
    const transport = createOpenAiGovernedTransport({
      httpsRequest: recordingHttpsRequest(order, {
        failWith: new Error('socket hang up') }) });
    const failure = await refuses(() => transport({
      endpointIdentity: GOVERNED_OPENAI_ENDPOINT,
      serializedRequest: '{"model":"m"}',
      credentials: { apiKey: 'test-only-not-a-real-key' },
      timeoutMs: 1000, maxResponseBytes: 65_536,
      observeTransportInvocation: () => { order.push('observation'); },
      transportInvocationIdentity: {
        role: 'governed_leaf_worker', evidenceKey: 'probe' }
    }));
    ok(failure !== null && failure.message === 'socket hang up',
      'a real transport failure still reaches the caller unchanged');
    ok(order.includes('observation'),
      'and the invocation is still observed — the request WAS made, it failed after');
  }

  // ── AN EVIDENCE FAILURE IS A FAILURE, AND IS NOT A PROVIDER FAULT ─────
  //
  // Evidence that disappears quietly is how ABSENCE stops meaning UNKNOWN and
  // starts meaning nothing at all. The request is already in flight by then, so
  // the caller must settle it as possibly dispatched rather than release it.
  {
    const order = [];
    const transport = createOpenAiGovernedTransport({
      httpsRequest: recordingHttpsRequest(order) });
    const failure = await refuses(() => transport({
      endpointIdentity: GOVERNED_OPENAI_ENDPOINT,
      serializedRequest: '{"model":"m"}',
      credentials: { apiKey: 'test-only-not-a-real-key' },
      timeoutMs: 1000, maxResponseBytes: 65_536,
      observeTransportInvocation: () => { throw new Error('database unavailable'); },
      transportInvocationIdentity: {
        role: 'governed_leaf_worker', evidenceKey: 'probe' }
    }));
    ok(failure !== null &&
       failure.code === 'PROVIDER_TRANSPORT_OBSERVATION_NOT_PERSISTED',
    'an observation that cannot be persisted FAILS under its own code — it is ' +
    'never swallowed');
    ok(failure.providerTransportObservationFailure === true,
      'and is marked as an evidence failure, so it is not reclassified as a ' +
      'provider fault');

    const outcome = await dispatchGovernedRequest({
      startResult: startResultFor(),
      transport,
      resolveCredentials: async () => ({ apiKey: 'test-only-not-a-real-key' }),
      observeTransportInvocation: () => { throw new Error('database unavailable'); },
      transportInvocationIdentity: { role: 'governed_leaf_worker', evidenceKey: 'k' }
    });
    ok(/observation could not be persisted/.test(String(outcome.detail)),
      'and the outcome detail names the evidence failure, not a provider fault');
    ok(outcome.status === 'transport_refused' && outcome.possiblyDispatched === true,
      'the dispatch seam settles it as POSSIBLY DISPATCHED — by then the bytes ' +
      'were already handed to the platform');
    ok(POSSIBLY_DISPATCHED_OUTCOMES.includes(outcome.status),
      'which is the outcome class that settles rather than releases');
  }

  // ── NOTHING IS OBSERVED WHEN THE TRANSPORT IS NEVER REACHED ───────────
  //
  // The property that stops an authorized-but-undispatched request from ever
  // looking dispatched: the observer lives BELOW every refusal.
  {
    let observations = 0;
    const order = [];
    const transport = createOpenAiGovernedTransport({
      httpsRequest: recordingHttpsRequest(order) });
    const refusal = await refuses(() => dispatchGovernedRequest({
      startResult: startResultFor({ requestHash: 'a-different-hash' }),
      transport,
      resolveCredentials: async () => ({ apiKey: 'test-only-not-a-real-key' }),
      observeTransportInvocation: () => { observations += 1; },
      transportInvocationIdentity: { role: 'governed_leaf_worker', evidenceKey: 'k' }
    }));
    ok(refusal !== null && refusal.code === 'GOVERNED_TRANSPORT_REFUSED',
      'a prepared request that is not the one the reservation authorized is refused');
    ok(observations === 0 && order.length === 0,
      'and NOTHING is observed — the refusal never reached a transport owner');
  }

  // ── THE HAPPY PATH STILL BINDS THE CANONICAL GOVERNED IDENTITY ────────
  {
    const order = [];
    const transport = createOpenAiGovernedTransport({
      httpsRequest: recordingHttpsRequest(order) });
    let observed = null;
    const outcome = await dispatchGovernedRequest({
      startResult: startResultFor(),
      transport,
      resolveCredentials: async () => ({ apiKey: 'test-only-not-a-real-key' }),
      observeTransportInvocation: payload => { observed = payload; },
      transportInvocationIdentity: { role: 'governed_leaf_worker', evidenceKey: 'k' }
    });
    ok(outcome.status === 'received' && outcome.text === 'answer',
      'an authorized governed dispatch still receives its response');
    ok(observed.reservationId === 42 && observed.modelRequestOrdinal === 3,
      'and the observation binds the reservation and ordinal from the RESERVATION, ' +
      'not from the caller');
    ok(observed.governed === true && observed.endpoint === GOVERNED_OPENAI_ENDPOINT,
      'with the governed flag and the endpoint it was actually invoked against');
  }

  // ── AN ABSENT OBSERVER IS TOLERATED; A BROKEN ONE IS NOT ──────────────
  ok(await observeProviderTransportInvocation(null, {}) === null,
    'no observer is a no-op — non-Run callers own no durable evidence');

  console.log(`\nprovider transport observation test passed — ${passed} assertions`);
}

main().catch(error => { console.error(error); process.exit(1); });

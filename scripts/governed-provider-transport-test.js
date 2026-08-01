#!/usr/bin/env node
'use strict';

// Tranche 4 deterministic suite for runtime/governed-provider-transport.
//
// No database, no server, no network. The transport is injected, so every
// assertion here is about what the seam will and will not send.

const assert = require('node:assert/strict');
const {
  GovernedTransportError,
  MAX_GOVERNED_RESPONSE_BYTES,
  POSSIBLY_DISPATCHED_OUTCOMES,
  TRANSPORT_OUTCOMES,
  TRANSPORT_REFUSALS,
  assertDispatchAuthority,
  dispatchGovernedRequest
} = require('../runtime/governed-provider-transport');

const OPENAI_ADAPTER = 'openai.responses.v1';
const SNAPSHOT = 'gpt-4o-mini-2024-07-18';
const ENDPOINT = 'https://api.openai.com/v1/responses';
const BYTES = JSON.stringify({
  model: SNAPSHOT,
  input: [{ role: 'user', content: 'hello' }],
  max_output_tokens: 2_048,
  truncation: 'disabled'
});
const REQUEST_HASH = 'a'.repeat(64);
const EVIDENCE_HASH = 'b'.repeat(64);

// Shaped exactly like a successful markEconomicRequestStarted() result.
function startResultOf(overrides = {}) {
  const prepared = {
    adapterId: OPENAI_ADAPTER,
    provider: 'openai',
    dispatchTarget: SNAPSHOT,
    targetEvidenceHash: EVIDENCE_HASH,
    endpointIdentity: ENDPOINT,
    requestHash: REQUEST_HASH,
    ...(overrides.prepared || {})
  };
  const reservation = {
    id: 1,
    state: 'request_started',
    serializedRequest: BYTES,
    serializedRequestByteCount: Buffer.byteLength(BYTES, 'utf8'),
    exactRequestHash: REQUEST_HASH,
    preparedRequest: prepared,
    economicAuthority: {
      adapterId: OPENAI_ADAPTER,
      provider: 'openai',
      dispatchTarget: SNAPSHOT,
      targetEvidenceHash: EVIDENCE_HASH,
      ...(overrides.authority || {})
    },
    ...(overrides.reservation || {})
  };
  return { reservation, serializedRequest: reservation.serializedRequest, ...(overrides.top || {}) };
}

function recordingTransport(response = { text: '{"ok":true}' }) {
  const calls = [];
  const transport = async args => { calls.push(args); return response; };
  transport.calls = calls;
  return transport;
}

function refusalReason(fn) {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof GovernedTransportError, 'refusals use the module error');
    assert.equal(error.code, 'GOVERNED_TRANSPORT_REFUSED');
    assert.equal(TRANSPORT_REFUSALS.includes(error.detail.reason), true,
      `${error.detail.reason} is in the closed vocabulary`);
    return error.detail.reason;
  }
  return assert.fail('expected a transport refusal');
}

async function asyncRefusalReason(promise) {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof GovernedTransportError, 'refusals use the module error');
    assert.equal(error.code, 'GOVERNED_TRANSPORT_REFUSED');
    return error.detail.reason;
  }
  return assert.fail('expected a transport refusal');
}

async function main() {
  // ── The transport receives the exact persisted bytes ─────────────────────

  const transport = recordingTransport();
  const result = await dispatchGovernedRequest({
    startResult: startResultOf(), transport
  });
  assert.equal(result.status, 'received');
  assert.equal(transport.calls.length, 1, 'exactly one provider request is issued');

  const sent = transport.calls[0];
  assert.equal(sent.serializedRequest, BYTES,
    'the transport receives the exact persisted byte sequence');
  assert.equal(sent.byteCount, Buffer.byteLength(BYTES, 'utf8'));
  assert.equal(sent.dispatchTarget, SNAPSHOT, 'the captured target is sent, never re-chosen');
  assert.equal(sent.endpointIdentity, ENDPOINT);
  // The transport is handed bytes, never an object it could re-serialize.
  assert.equal(typeof sent.serializedRequest, 'string');
  assert.equal(Object.prototype.hasOwnProperty.call(sent, 'body'), false,
    'no re-serializable body is passed');
  assert.equal(Object.prototype.hasOwnProperty.call(sent, 'model'), false,
    'the transport is given no model parameter it could choose');

  // The governed cap and truncation are inside the bytes, not re-applied here.
  const parsed = JSON.parse(sent.serializedRequest);
  assert.equal(parsed.max_output_tokens, 2_048);
  assert.equal(parsed.truncation, 'disabled');

  // ── Caller-supplied bytes are unrepresentable ────────────────────────────

  assert.equal(
    await asyncRefusalReason(dispatchGovernedRequest({
      startResult: startResultOf(), transport: recordingTransport(),
      serializedRequest: '{"substituted":true}'
    })),
    'caller_supplied_bytes',
    'a caller cannot substitute bytes after reservation');

  // ── Dispatch authority cannot be asserted, only presented ────────────────

  assert.equal(refusalReason(() => assertDispatchAuthority(null)),
    'dispatch_not_authorized', 'a missing start result authorizes nothing');
  assert.equal(refusalReason(() => assertDispatchAuthority({ reservation: null })),
    'dispatch_not_authorized', 'a start result without a reservation authorizes nothing');
  assert.equal(
    refusalReason(() => assertDispatchAuthority(
      startResultOf({ reservation: { state: 'reserved' } }))),
    'dispatch_not_authorized',
    'a merely reserved request does not authorize dispatch');
  assert.equal(
    refusalReason(() => assertDispatchAuthority(
      startResultOf({ reservation: { state: 'settled' } }))),
    'dispatch_not_authorized',
    'a settled reservation does not authorize dispatch');

  // Bytes that disagree with the reservation they came from are refused, so a
  // tampered start result cannot smuggle a different request through.
  const tampered = startResultOf();
  assert.equal(
    refusalReason(() => assertDispatchAuthority({
      reservation: tampered.reservation, serializedRequest: '{"other":true}'
    })),
    'dispatch_not_authorized',
    'start-result bytes must be the reservation bytes');

  // A never-dispatched refusal must not reach the transport at all.
  const untouched = recordingTransport();
  await asyncRefusalReason(dispatchGovernedRequest({
    startResult: startResultOf({ reservation: { state: 'reserved' } }), transport: untouched
  }));
  assert.equal(untouched.calls.length, 0,
    'an unauthorized dispatch contacts no transport');

  // ── Target drift refuses before contact ──────────────────────────────────

  for (const [field, value, why] of [
    ['dispatchTarget', 'gpt-4.1-2025-04-14', 'a different model'],
    ['provider', 'ollama', 'a different provider'],
    ['adapterId', OPENAI_ADAPTER, 'a matching adapter'],
    ['targetEvidenceHash', 'c'.repeat(64), 'different target evidence']
  ]) {
    if (field === 'adapterId') continue;
    const drifting = recordingTransport();
    assert.equal(
      await asyncRefusalReason(dispatchGovernedRequest({
        startResult: startResultOf({ prepared: { [field]: value } }), transport: drifting
      })),
      'transport_target_drift',
      `${why} in the prepared request refuses`);
    assert.equal(drifting.calls.length, 0, `${why} contacts no transport`);
  }

  const swapped = recordingTransport();
  assert.equal(
    await asyncRefusalReason(dispatchGovernedRequest({
      startResult: startResultOf({ prepared: { requestHash: 'd'.repeat(64) } }),
      transport: swapped
    })),
    'transport_target_drift',
    'a prepared request other than the reserved one refuses');
  assert.equal(swapped.calls.length, 0);

  const unsupported = recordingTransport();
  assert.equal(
    await asyncRefusalReason(dispatchGovernedRequest({
      startResult: startResultOf({ prepared: { adapterId: 'nonexistent.adapter.v9' } }),
      transport: unsupported
    })),
    'unsupported_adapter',
    'an unregistered adapter refuses');
  assert.equal(unsupported.calls.length, 0);

  // ── Missing credentials refuse without changing the route ────────────────

  const credentialless = recordingTransport();
  const noCredentials = await dispatchGovernedRequest({
    startResult: startResultOf(),
    transport: credentialless,
    resolveCredentials: async () => null
  });
  assert.equal(noCredentials.status, 'credentials_unavailable');
  assert.equal(credentialless.calls.length, 0,
    'a missing credential contacts no provider');
  assert.equal(noCredentials.possiblyDispatched, false,
    'a credential failure provably dispatched nothing');

  // Credential resolution is told the captured route and cannot alter it.
  const credentialArgs = [];
  const credentialed = recordingTransport();
  await dispatchGovernedRequest({
    startResult: startResultOf(),
    transport: credentialed,
    resolveCredentials: async args => {
      credentialArgs.push(args);
      // A resolver that tries to redirect the route is simply ignored: its
      // return value is a credential, and nothing else is read from it.
      return { apiKey: 'fixture-key', provider: 'ollama', model: 'other-model' };
    }
  });
  assert.deepEqual(Object.keys(credentialArgs[0]).sort(), ['adapterId', 'provider'],
    'credential resolution sees only the captured identity');
  assert.equal(credentialed.calls[0].dispatchTarget, SNAPSHOT,
    'a credential resolver cannot change the dispatch target');
  assert.equal(credentialed.calls[0].serializedRequest, BYTES,
    'a credential resolver cannot change the bytes');

  // ── Provider-side conditions are results, not exceptions ─────────────────

  const thrown = await dispatchGovernedRequest({
    startResult: startResultOf(),
    transport: async () => { throw new Error('connection reset'); }
  });
  assert.equal(thrown.status, 'transport_refused');
  assert.equal(thrown.possiblyDispatched, true,
    'a refused transport may already have reached the provider and must settle');

  const abort = new Error('aborted');
  abort.name = 'AbortError';
  const timedOut = await dispatchGovernedRequest({
    startResult: startResultOf(), transport: async () => { throw abort; }
  });
  assert.equal(timedOut.status, 'timeout');
  assert.equal(timedOut.possiblyDispatched, true);

  const oversized = await dispatchGovernedRequest({
    startResult: startResultOf(),
    transport: async () => ({ text: 'x'.repeat(MAX_GOVERNED_RESPONSE_BYTES + 1) })
  });
  assert.equal(oversized.status, 'response_too_large',
    'the existing 65,536-byte bound is enforced on the governed path');
  assert.equal(oversized.possiblyDispatched, true);

  const atBound = await dispatchGovernedRequest({
    startResult: startResultOf(),
    transport: async () => ({ text: 'x'.repeat(MAX_GOVERNED_RESPONSE_BYTES) })
  });
  assert.equal(atBound.status, 'received', 'exactly the bound is accepted');

  const empty = await dispatchGovernedRequest({
    startResult: startResultOf(), transport: async () => ({ text: '' })
  });
  assert.equal(empty.status, 'response_empty');
  assert.equal(empty.possiblyDispatched, true);

  // Every non-credential outcome is possibly dispatched, so none may be
  // released as undispatched.
  assert.deepEqual(
    TRANSPORT_OUTCOMES.filter(status => !POSSIBLY_DISPATCHED_OUTCOMES.includes(status)),
    ['credentials_unavailable'],
    'only a credential failure is provably undispatched');

  // ── Reported usage is passed through uninterpreted ───────────────────────

  const withUsage = await dispatchGovernedRequest({
    startResult: startResultOf(),
    transport: async () => ({ text: '{"ok":true}', usage: { input_tokens: 10 }, identity: 'resp_1' })
  });
  assert.deepEqual(withUsage.reportedUsage, { input_tokens: 10 },
    'usage is carried through without being trusted here');
  assert.equal(withUsage.responseIdentity, 'resp_1');

  const withoutUsage = await dispatchGovernedRequest({
    startResult: startResultOf(), transport: async () => ({ text: '{"ok":true}' })
  });
  assert.equal(withoutUsage.reportedUsage, null,
    'absent usage is null, never a fabricated zero');

  console.log('governed provider transport test passed');
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});

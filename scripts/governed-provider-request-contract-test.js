#!/usr/bin/env node
'use strict';

// Tranche 4 deterministic suite for runtime/governed-provider-request-contract.
//
// The property under test is narrow and load-bearing: the bytes that were
// priced and reserved are the bytes that get sent. Fixture pricing only; no
// database, no server, no provider, no network.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const {
  GovernedRequestError,
  PREPARED_REQUEST_FIELDS,
  PREPARED_REQUEST_REFUSALS,
  PREPARED_REQUEST_VERSION,
  governedRequestBytes,
  hashSerializedRequest,
  normalizeGovernedProviderRequest,
  prepareGovernedProviderRequest
} = require('../runtime/governed-provider-request-contract');
const {
  buildRoleRoutingDecision,
  buildRoleRoutingPolicy
} = require('../runtime/role-routing-contract');
const {
  buildEconomicAuthority,
  buildEconomicPolicy
} = require('../runtime/economic-authority-contract');
const { buildPricingCatalog, findPricingEntry } = require('../runtime/model-pricing-catalog');
const { buildOpenAiResponsesBody } = require('../runtime/provider-request-body');
const { canonicalJson, hashCanonical } = require('../runtime/declared-work-contract');

const ADAPTER = 'openai.responses.v1';
const SNAPSHOT = 'gpt-4o-mini-2024-07-18';
const OTHER = 'gpt-4.1-mini-2025-04-14';
const ATTEMPT = '3f1d6c58-4a2b-4a1e-9f7c-5b8e2d0a6c41';
const AT = '2026-08-01T00:00:00.000Z';
const ENDPOINT = 'POST https://api.openai.com/v1/responses';

function catalogOf(zero = false) {
  return buildPricingCatalog({
    catalogId: zero ? 'fixture-zero' : 'fixture-catalog',
    entries: [{
      provider: 'openai',
      model: SNAPSHOT,
      adapterId: ADAPTER,
      chargingUnit: 'token',
      inputMicroUsdPerMillionTokens: zero ? 0 : 150_000,
      outputMicroUsdPerMillionTokens: zero ? 0 : 600_000,
      requestMicroUsd: 0,
      boundMethod: zero ? 'catalog_maximum_exactly_zero' : 'model_context_window_ceiling'
    }]
  });
}

function decisionOf(role = 'structured_leaf_executor', model = SNAPSHOT) {
  const policy = buildRoleRoutingPolicy({
    policyId: 'rp',
    rolePolicies: [{
      role,
      primaryRoute: { adapterId: ADAPTER, provider: 'openai', model },
      fallbackRoute: null,
      authorizedFallbackReasons: []
    }]
  });
  return buildRoleRoutingDecision({
    policy,
    role,
    ticketId: 7,
    subjectKind: role === 'structured_planner' ? 'planning_attempt' : 'run',
    subjectId: role === 'structured_planner' ? ATTEMPT : 42,
    actingAgentId: 12,
    decidedAt: AT
  });
}

function authorityOf(catalog, decision, overrides = {}) {
  const policy = buildEconomicPolicy({
    policyId: 'ep',
    role: decision.role,
    authorizedMicroUsd: 500_000,
    maximumProviderRequests: 8,
    maximumOutputTokensPerRequest: 2_048,
    pricingCatalogId: catalog.catalogId,
    pricingCatalogHash: catalog.catalogHash,
    fallbackLiabilityAuthorized: false,
    fallbackProviderRequests: 0,
    capturedAt: AT,
    ...overrides
  });
  return buildEconomicAuthority({
    policy, routingDecision: decision, pricingCatalog: catalog, capturedAt: AT
  });
}

function bodyOf(model = SNAPSHOT, cap = 2_048) {
  return buildOpenAiResponsesBody({
    model,
    input: [{ role: 'user', content: 'hello' }],
    options: { governed: true, maxOutputTokens: cap }
  });
}

function prepareOf(overrides = {}) {
  const catalog = overrides.catalog || catalogOf();
  const decision = overrides.decision || decisionOf();
  const authority = overrides.authority || authorityOf(catalog, decision);
  const entry = findPricingEntry(catalog, { provider: 'openai', model: SNAPSHOT });
  return prepareGovernedProviderRequest({
    routingDecision: decision,
    economicAuthority: authority,
    modelRequestOrdinal: 1,
    endpointIdentity: ENDPOINT,
    canonicalBody: overrides.canonicalBody || bodyOf(),
    authorizedOutputTokens: 2_048,
    truncationMode: 'disabled',
    pricingEntryHash: hashCanonical(entry),
    maximumLiabilityMicroUsd: authority.maximumPerRequestMicroUsd,
    preparedAt: AT,
    ...(overrides.prepare || {})
  });
}

function refusalReason(fn) {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof GovernedRequestError, 'refusals use the module error');
    assert.equal(error.code, 'GOVERNED_REQUEST_REFUSED');
    assert.equal(PREPARED_REQUEST_REFUSALS.includes(error.reason), true,
      `${error.reason} is in the closed vocabulary`);
    return error.reason;
  }
  return assert.fail('expected a prepared-request refusal');
}

function invalid(fn) {
  try {
    fn();
  } catch (error) {
    return error;
  }
  return assert.fail('expected a contract violation');
}

// ── Exact serialization ─────────────────────────────────────────────────────

const prepared = prepareOf();
assert.equal(prepared.version, PREPARED_REQUEST_VERSION);
assert.deepEqual(Object.keys(prepared).sort(), [...PREPARED_REQUEST_FIELDS].sort());
assert.equal(Object.isFrozen(prepared), true);
assert.equal(prepareOf().serializedRequest, prepared.serializedRequest,
  'serialization is deterministic');
assert.equal(prepareOf().requestHash, prepared.requestHash, 'the request hash is deterministic');
assert.equal(prepareOf().preparedRequestHash, prepared.preparedRequestHash);

// The byte count describes the actual UTF-8 bytes.
assert.equal(prepared.serializedByteCount,
  Buffer.byteLength(prepared.serializedRequest, 'utf8'));
// The hash is over the bytes, not over an object.
assert.equal(prepared.requestHash, crypto.createHash('sha256')
  .update(Buffer.from(prepared.serializedRequest, 'utf8')).digest('hex'));
assert.equal(hashSerializedRequest(prepared.serializedRequest), prepared.requestHash);
// The stored text parses back to the stored canonical body.
assert.equal(canonicalJson(JSON.parse(prepared.serializedRequest)),
  canonicalJson(prepared.canonicalBody));
// Multibyte content is measured in bytes, not characters.
const multibyte = prepareOf({
  canonicalBody: buildOpenAiResponsesBody({
    model: SNAPSHOT, input: [{ role: 'user', content: 'héllo — 世界' }],
    options: { governed: true, maxOutputTokens: 2_048 }
  })
});
assert.ok(multibyte.serializedByteCount > multibyte.serializedRequest.length,
  'the byte count exceeds the character count for multibyte content');

// The governed body carries both governed fields.
assert.equal(prepared.canonicalBody.max_output_tokens, 2_048);
assert.equal(prepared.canonicalBody.truncation, 'disabled');
assert.equal(prepared.truncationMode, 'disabled');
assert.equal(prepared.dispatchTarget, SNAPSHOT);

// ── The transport accessor returns the stored bytes ─────────────────────────

const bytes = governedRequestBytes(prepared);
assert.equal(bytes.serializedRequest, prepared.serializedRequest,
  'the transport receives the exact stored text');
assert.equal(bytes.requestHash, prepared.requestHash);
assert.equal(bytes.byteCount, prepared.serializedByteCount);
assert.equal(bytes.model, SNAPSHOT);
assert.equal(Object.isFrozen(bytes), true);
// The accessor is the only exported way to reach the bytes for dispatch.
assert.equal(typeof governedRequestBytes, 'function');

// ── Post-preparation mutation refuses ───────────────────────────────────────

assert.equal(normalizeGovernedProviderRequest(prepared).requestHash, prepared.requestHash);
assert.equal(
  normalizeGovernedProviderRequest(JSON.parse(JSON.stringify(prepared))).preparedRequestHash,
  prepared.preparedRequestHash,
  'a prepared request survives a JSONB round trip'
);
// Every governed field is covered by the prepared-request hash.
for (const mutation of [
  { serializedRequest: prepared.serializedRequest.replace('2048', '4096') },
  { authorizedOutputTokens: 1_024 },
  { dispatchTarget: OTHER },
  { targetEvidenceHash: '0'.repeat(64) },
  { routingDecisionHash: '0'.repeat(64) },
  { economicAuthorityHash: '0'.repeat(64) },
  { endpointIdentity: 'POST https://evil.example/v1/responses' },
  { maximumLiabilityMicroUsd: prepared.maximumLiabilityMicroUsd + 1 },
  { modelRequestOrdinal: 2 },
  { truncationMode: 'auto' },
  { pricingEntryHash: '0'.repeat(64) },
  { serializedByteCount: prepared.serializedByteCount + 1 },
  { requestHash: '0'.repeat(64) },
  { canonicalBody: { ...prepared.canonicalBody, max_output_tokens: 4_096 } }
]) {
  invalid(() => normalizeGovernedProviderRequest({ ...prepared, ...mutation }));
}
for (const field of PREPARED_REQUEST_FIELDS) {
  const partial = { ...prepared };
  delete partial[field];
  invalid(() => normalizeGovernedProviderRequest(partial));
}
invalid(() => normalizeGovernedProviderRequest({ ...prepared, extra: 1 }));
invalid(() => normalizeGovernedProviderRequest({ ...prepared, version: 2 }));

// The byte-mismatch gate fires independently of the prepared-request hash: a
// correctly re-hashed document whose text disagrees with its own body still
// refuses. This is what stops a re-serialized body being dispatched.
function rehash(body) {
  const withoutHash = Object.fromEntries(
    PREPARED_REQUEST_FIELDS.filter(field => field !== 'preparedRequestHash')
      .map(field => [field, body[field]])
  );
  return { ...withoutHash, preparedRequestHash: hashCanonical(withoutHash) };
}
const tamperedText = prepared.serializedRequest.replace('hello', 'HELLO');
assert.equal(
  refusalReason(() => normalizeGovernedProviderRequest(rehash({
    ...prepared, serializedRequest: tamperedText
  }))),
  'prepared_request_bytes_mismatch',
  'text that no longer hashes to its request hash refuses'
);
assert.equal(
  refusalReason(() => normalizeGovernedProviderRequest(rehash({
    ...prepared,
    serializedRequest: tamperedText,
    requestHash: hashSerializedRequest(tamperedText),
    serializedByteCount: Buffer.byteLength(tamperedText, 'utf8')
  }))),
  'prepared_request_bytes_mismatch',
  'text that no longer parses to the recorded canonical body refuses'
);
// A body whose model was swapped after preparation cannot be dispatched.
const swapped = canonicalJson({ ...prepared.canonicalBody, model: OTHER });
assert.equal(
  refusalReason(() => normalizeGovernedProviderRequest(rehash({
    ...prepared,
    serializedRequest: swapped,
    requestHash: hashSerializedRequest(swapped),
    serializedByteCount: Buffer.byteLength(swapped, 'utf8'),
    canonicalBody: JSON.parse(swapped)
  }))),
  'prepared_request_bytes_mismatch',
  'a swapped model in the bytes refuses even when the document re-hashes'
);
// A body whose cap was raised after preparation refuses at the adapter gate.
const raised = canonicalJson({ ...prepared.canonicalBody, max_output_tokens: 4_096 });
assert.throws(
  () => normalizeGovernedProviderRequest(rehash({
    ...prepared,
    serializedRequest: raised,
    requestHash: hashSerializedRequest(raised),
    serializedByteCount: Buffer.byteLength(raised, 'utf8'),
    canonicalBody: JSON.parse(raised)
  })),
  error => error.reason === 'adapter_output_cap_incomplete' ||
    error.reason === 'prepared_request_bytes_mismatch',
  'a raised output cap in the bytes refuses'
);

// ── Authority and route binding ─────────────────────────────────────────────

const catalog = catalogOf();
const decision = decisionOf();
const authority = authorityOf(catalog, decision);
const otherDecision = decisionOf('structured_leaf_executor', OTHER);
assert.equal(
  refusalReason(() => prepareGovernedProviderRequest({
    routingDecision: otherDecision,
    economicAuthority: authority,
    modelRequestOrdinal: 1,
    endpointIdentity: ENDPOINT,
    canonicalBody: bodyOf(),
    authorizedOutputTokens: 2_048,
    truncationMode: 'disabled',
    pricingEntryHash: '0'.repeat(64),
    maximumLiabilityMicroUsd: 1,
    preparedAt: AT
  })),
  'prepared_request_authority_mismatch',
  'an authority for another route cannot prepare this request'
);
assert.equal(
  normalizeGovernedProviderRequest(prepared, {
    expectedRoutingDecisionHash: decision.decisionHash,
    expectedEconomicAuthorityHash: authority.authorityHash,
    expectedRequestHash: prepared.requestHash
  }).requestHash,
  prepared.requestHash
);
assert.equal(
  refusalReason(() => normalizeGovernedProviderRequest(prepared,
    { expectedRoutingDecisionHash: '0'.repeat(64) })),
  'prepared_request_authority_mismatch'
);

// ── Subject shape ───────────────────────────────────────────────────────────

assert.equal(prepared.subjectKind, 'run');
assert.equal(prepared.runId, 42);
assert.equal(prepared.planningAttemptId, null);
const plannerDecision = decisionOf('structured_planner');
const plannerAuthority = authorityOf(catalogOf(), plannerDecision, {
  role: 'structured_planner', maximumProviderRequests: 1
});
const plannerPrepared = prepareOf({
  decision: plannerDecision, authority: plannerAuthority
});
assert.equal(plannerPrepared.subjectKind, 'planning_attempt');
assert.equal(plannerPrepared.planningAttemptId, ATTEMPT);
assert.equal(plannerPrepared.runId, null);
// The planner is authorized exactly one request.
assert.equal(
  refusalReason(() => prepareOf({
    decision: plannerDecision, authority: plannerAuthority, prepare: { modelRequestOrdinal: 2 }
  })),
  'prepared_request_ordinal_exceeded'
);

// ── Ceilings ────────────────────────────────────────────────────────────────

assert.equal(refusalReason(() => prepareOf({ prepare: { modelRequestOrdinal: 9 } })),
  'prepared_request_ordinal_exceeded', 'ordinal 9 of 8 authorized requests refuses');
assert.equal(prepareOf({ prepare: { modelRequestOrdinal: 8 } }).modelRequestOrdinal, 8,
  'the last authorized ordinal is admissible');
assert.equal(
  refusalReason(() => prepareOf({
    canonicalBody: bodyOf(SNAPSHOT, 4_096),
    prepare: { authorizedOutputTokens: 4_096 }
  })),
  'prepared_request_output_cap_exceeded'
);
assert.equal(
  refusalReason(() => prepareOf({
    prepare: { maximumLiabilityMicroUsd: authority.maximumPerRequestMicroUsd + 1 }
  })),
  'prepared_request_liability_exceeded'
);
// The cap must be physically present in the body before preparation succeeds.
assert.throws(
  () => prepareOf({
    canonicalBody: buildOpenAiResponsesBody({
      model: SNAPSHOT, input: [], options: {}
    })
  }),
  error => error.reason === 'adapter_output_cap_not_serialized',
  'a body with no serialized cap cannot be prepared'
);

// ── Zero-priced requests are governed identically ───────────────────────────

const zeroCatalog = catalogOf(true);
const zeroAuthority = authorityOf(zeroCatalog, decision);
const zeroPrepared = prepareOf({
  catalog: zeroCatalog,
  authority: zeroAuthority,
  prepare: {
    pricingEntryHash: hashCanonical(
      findPricingEntry(zeroCatalog, { provider: 'openai', model: SNAPSHOT })),
    maximumLiabilityMicroUsd: 0
  }
});
assert.equal(zeroPrepared.maximumLiabilityMicroUsd, 0, 'a zero-priced request costs exactly zero');
assert.equal(zeroPrepared.modelCapabilityHash, null,
  'a zero-priced request needs no model capability');
// But it still carries an immutable target, exact bytes and enforced ceilings.
assert.equal(zeroPrepared.dispatchTarget, SNAPSHOT);
assert.match(zeroPrepared.targetEvidenceHash, /^[0-9a-f]{64}$/);
assert.equal(zeroPrepared.canonicalBody.max_output_tokens, 2_048);
assert.equal(zeroPrepared.canonicalBody.truncation, 'disabled');
assert.equal(governedRequestBytes(zeroPrepared).serializedRequest,
  zeroPrepared.serializedRequest);
assert.equal(
  refusalReason(() => prepareOf({
    catalog: zeroCatalog, authority: zeroAuthority,
    prepare: { modelRequestOrdinal: 9, pricingEntryHash: '0'.repeat(64),
      maximumLiabilityMicroUsd: 0 }
  })),
  'prepared_request_ordinal_exceeded',
  'zero price does not exempt a request from its ceilings'
);

// ── Source boundary ─────────────────────────────────────────────────────────

const source = fs.readFileSync(
  path.join(__dirname, '..', 'runtime', 'governed-provider-request-contract.js'), 'utf8');
const executable = source.replace(/^\s*\/\/.*$/gm, '');
for (const forbidden of [
  'fetch(', 'require(\'http', 'https://api', 'child_process', 'process.env',
  'Math.random', 'Date.now', 'apiKey', 'Authorization'
]) {
  assert.equal(executable.includes(forbidden), false,
    `the prepared-request contract performs no dispatch: ${forbidden} must not appear`);
}
// Serialization happens exactly once, in one place.
assert.equal((executable.match(/canonicalJson\(canonicalBody\)/g) || []).length, 1,
  'the body is serialized in exactly one place');

console.log('governed provider request contract test passed');

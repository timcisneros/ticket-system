#!/usr/bin/env node
'use strict';

// Tranche 4 deterministic suite for runtime/economic-settlement-receipt-contract.
//
// Fixture pricing only. No database, no server, no provider, no network. The
// fixture rates exist solely to exercise integer arithmetic; a source assertion
// at the end proves no production catalog ships.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  SETTLEMENT_RECEIPT_FIELDS,
  SETTLEMENT_RECEIPT_VERSION,
  SETTLEMENT_REFUSALS,
  SettlementReceiptError,
  USAGE_SOURCES,
  assertReceiptMatchesPreparedRequest,
  buildSettlementReceipt,
  normalizeSettlementReceipt
} = require('../runtime/economic-settlement-receipt-contract');
const {
  buildEconomicAuthority,
  buildEconomicPolicy
} = require('../runtime/economic-authority-contract');
const {
  buildRoleRoutingDecision,
  buildRoleRoutingPolicy
} = require('../runtime/role-routing-contract');
const { buildPricingCatalog, findPricingEntry } = require('../runtime/model-pricing-catalog');
const {
  prepareGovernedProviderRequest
} = require('../runtime/governed-provider-request-contract');
const { buildOpenAiResponsesBody } = require('../runtime/provider-request-body');
const { hashCanonical } = require('../runtime/declared-work-contract');

const OPENAI_ADAPTER = 'openai.responses.v1';
const SNAPSHOT = 'gpt-4o-mini-2024-07-18';        // 128,000 ctx / 16,384 max output
const ENDPOINT = 'https://api.openai.com/v1/responses';
const AT = '2026-08-01T00:00:00.000Z';
const CAP = 2_048;
const RESPONSE_ID = 'resp_fixture_0001';
const RESPONSE_HASH = hashCanonical({ response: RESPONSE_ID });

// Illustrative fixture rates. NOT production authority.
function catalogOf(overrides = {}, catalogId = 'fixture-catalog') {
  return buildPricingCatalog({
    catalogId,
    entries: [{
      provider: 'openai',
      model: SNAPSHOT,
      adapterId: OPENAI_ADAPTER,
      chargingUnit: 'token',
      inputMicroUsdPerMillionTokens: 150_000,
      outputMicroUsdPerMillionTokens: 600_000,
      requestMicroUsd: 0,
      boundMethod: 'model_context_window_ceiling',
      ...overrides
    }]
  });
}

function decisionOf() {
  const policy = buildRoleRoutingPolicy({
    policyId: 'routing-policy-1',
    rolePolicies: [{
      role: 'structured_leaf_executor',
      primaryRoute: { adapterId: OPENAI_ADAPTER, provider: 'openai', model: SNAPSHOT },
      fallbackRoute: null,
      authorizedFallbackReasons: []
    }]
  });
  return buildRoleRoutingDecision({
    policy,
    role: 'structured_leaf_executor',
    ticketId: 7,
    subjectKind: 'run',
    subjectId: 42,
    actingAgentId: 12,
    decidedAt: AT
  });
}

function authorityOf(catalog, decision) {
  const policy = buildEconomicPolicy({
    policyId: 'economic-policy-1',
    role: 'structured_leaf_executor',
    authorizedMicroUsd: 500_000,
    maximumProviderRequests: 8,
    maximumOutputTokensPerRequest: CAP,
    pricingCatalogId: catalog.catalogId,
    pricingCatalogHash: catalog.catalogHash,
    fallbackLiabilityAuthorized: false,
    fallbackProviderRequests: 0,
    capturedAt: AT
  });
  return buildEconomicAuthority({
    policy, routingDecision: decision, pricingCatalog: catalog, capturedAt: AT
  });
}

function prepareOf(catalog, decision, authority) {
  const entry = findPricingEntry(catalog, { provider: 'openai', model: SNAPSHOT });
  return prepareGovernedProviderRequest({
    routingDecision: decision,
    economicAuthority: authority,
    modelRequestOrdinal: 1,
    endpointIdentity: ENDPOINT,
    canonicalBody: buildOpenAiResponsesBody({
      model: SNAPSHOT,
      input: [{ role: 'user', content: 'hello' }],
      options: { governed: true, maxOutputTokens: CAP }
    }),
    authorizedOutputTokens: CAP,
    truncationMode: 'disabled',
    pricingEntryHash: hashCanonical(entry),
    maximumLiabilityMicroUsd: authority.maximumPerRequestMicroUsd,
    preparedAt: AT
  });
}

function fixture() {
  const catalog = catalogOf();
  const decision = decisionOf();
  const authority = authorityOf(catalog, decision);
  const preparedRequest = prepareOf(catalog, decision, authority);
  return { catalog, decision, authority, preparedRequest };
}

function receiptOf(overrides = {}) {
  const base = overrides.fixture || fixture();
  return buildSettlementReceipt({
    preparedRequest: base.preparedRequest,
    authority: base.authority,
    pricingCatalog: base.catalog,
    reservedMaximumMicroUsd: base.authority.maximumPerRequestMicroUsd,
    responseIdentity: RESPONSE_ID,
    responseHash: RESPONSE_HASH,
    usage: { source: 'provider_reported', inputTokens: 1_000, outputTokens: 500 },
    settledAt: AT,
    ...overrides.build
  });
}

function refusalReason(fn) {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof SettlementReceiptError, 'refusals use the module error');
    assert.equal(error.code, 'SETTLEMENT_REFUSED');
    assert.equal(SETTLEMENT_REFUSALS.includes(error.detail.reason), true,
      `${error.detail.reason} is in the closed vocabulary`);
    return error.detail.reason;
  }
  return assert.fail('expected a settlement refusal');
}

// ── Shape ───────────────────────────────────────────────────────────────────

const base = fixture();
const receipt = receiptOf({ fixture: base });

assert.deepEqual(Object.keys(receipt).sort(), [...SETTLEMENT_RECEIPT_FIELDS].sort(),
  'a receipt carries exactly the closed field list');
assert.equal(receipt.version, SETTLEMENT_RECEIPT_VERSION);
assert.equal(Object.isFrozen(receipt), true, 'a receipt is immutable');
assert.deepEqual([...USAGE_SOURCES],
  ['provider_reported', 'authorized_maximum_assumed'],
  'the usage vocabulary is closed and has no zero-settling unknown');

// ── The amount is computed, never adopted ───────────────────────────────────

// 1,000 input at 150,000 µUSD/M = ceil(150,000,000/1,000,000) = 150
// 500 output at 600,000 µUSD/M = ceil(300,000,000/1,000,000) = 300
assert.equal(receipt.settledMicroUsd, 450, 'settlement is integer micro-USD, rounded up');
assert.equal(receipt.reservedMaximumMicroUsd, base.authority.maximumPerRequestMicroUsd);
assert.equal(receipt.unusedReservationMicroUsd,
  receipt.reservedMaximumMicroUsd - receipt.settledMicroUsd,
  'the unused reservation is exactly reserved minus settled');
assert.equal(Number.isSafeInteger(receipt.settledMicroUsd), true);

// Ceiling rounding: a single token of a fractional charge still costs a whole
// micro-USD rather than being truncated to zero.
const roundsUp = receiptOf({
  fixture: base,
  build: {
    preparedRequest: base.preparedRequest,
    authority: base.authority,
    pricingCatalog: base.catalog,
    reservedMaximumMicroUsd: base.authority.maximumPerRequestMicroUsd,
    responseIdentity: RESPONSE_ID,
    responseHash: RESPONSE_HASH,
    usage: { source: 'provider_reported', inputTokens: 1, outputTokens: 0 },
    settledAt: AT
  }
});
assert.equal(roundsUp.settledMicroUsd, 1, 'a fractional charge rounds up, never down to zero');

// ── Exact-request and authority binding ─────────────────────────────────────

assert.equal(receipt.requestHash, base.preparedRequest.requestHash,
  'the receipt binds the exact dispatched bytes');
assert.equal(receipt.preparedRequestHash, base.preparedRequest.preparedRequestHash);
assert.equal(receipt.serializedByteCount, base.preparedRequest.serializedByteCount);
assert.equal(receipt.economicAuthorityHash, base.authority.authorityHash);
assert.equal(receipt.routingDecisionHash, base.authority.routingDecisionHash);
assert.equal(receipt.targetEvidenceHash, base.authority.targetEvidenceHash);
assert.equal(receipt.responseHash, RESPONSE_HASH, 'the exact response is bound');

assert.equal(assertReceiptMatchesPreparedRequest(receipt, base.preparedRequest), receipt,
  'a receipt matches the request it settles');

// A receipt cannot be filed against a different request. The second fixture
// differs only in ordinal, so it is the closest possible impostor.
const other = fixture();
const otherPrepared = prepareGovernedProviderRequest({
  routingDecision: other.decision,
  economicAuthority: other.authority,
  modelRequestOrdinal: 2,
  endpointIdentity: ENDPOINT,
  canonicalBody: buildOpenAiResponsesBody({
    model: SNAPSHOT,
    input: [{ role: 'user', content: 'a different prompt' }],
    options: { governed: true, maxOutputTokens: CAP }
  }),
  authorizedOutputTokens: CAP,
  truncationMode: 'disabled',
  pricingEntryHash: hashCanonical(findPricingEntry(other.catalog,
    { provider: 'openai', model: SNAPSHOT })),
  maximumLiabilityMicroUsd: other.authority.maximumPerRequestMicroUsd,
  preparedAt: AT
});
assert.equal(
  refusalReason(() => assertReceiptMatchesPreparedRequest(receipt, otherPrepared)),
  'settlement_request_mismatch',
  'a receipt cannot settle bytes other than the ones it names');

// A pricing catalog other than the captured one cannot settle.
assert.equal(
  refusalReason(() => receiptOf({
    fixture: base,
    build: { ...receiptBuildArgs(base), pricingCatalog: catalogOf({}, 'fixture-other') }
  })),
  'settlement_authority_mismatch',
  'settlement refuses a catalog the authority never captured');

// Re-priced entry under the captured catalog identity is caught by entry hash.
assert.equal(
  refusalReason(() => receiptOf({
    fixture: base,
    build: {
      ...receiptBuildArgs(base),
      pricingCatalog: catalogOf({ outputMicroUsdPerMillionTokens: 1 })
    }
  })),
  'settlement_authority_mismatch',
  'a silently re-priced entry cannot settle under a captured entry hash');

function receiptBuildArgs(f) {
  return {
    preparedRequest: f.preparedRequest,
    authority: f.authority,
    pricingCatalog: f.catalog,
    reservedMaximumMicroUsd: f.authority.maximumPerRequestMicroUsd,
    responseIdentity: RESPONSE_ID,
    responseHash: RESPONSE_HASH,
    usage: { source: 'provider_reported', inputTokens: 1_000, outputTokens: 500 },
    settledAt: AT
  };
}

// ── Usage bounds ────────────────────────────────────────────────────────────

// Output above the transmitted cap is a violated cap, not a bigger bill.
assert.equal(
  refusalReason(() => buildSettlementReceipt({
    ...receiptBuildArgs(base),
    usage: { source: 'provider_reported', inputTokens: 10, outputTokens: CAP + 1 }
  })),
  'usage_exceeds_authorized_output',
  'reported output above the transmitted cap refuses instead of clamping');

// The ceiling bound priced the whole context window, so input above it means
// the bound itself was wrong.
assert.equal(
  refusalReason(() => buildSettlementReceipt({
    ...receiptBuildArgs(base),
    usage: { source: 'provider_reported', inputTokens: 128_001, outputTokens: 1 }
  })),
  'usage_exceeds_bound_input',
  'reported input above the bounded context window refuses');

assert.equal(
  refusalReason(() => buildSettlementReceipt({
    ...receiptBuildArgs(base),
    usage: { source: 'unknown', inputTokens: 1, outputTokens: 1 }
  })),
  'settlement_usage_unproven',
  'an unrecognized usage source refuses');

assert.equal(
  refusalReason(() => buildSettlementReceipt({
    ...receiptBuildArgs(base),
    usage: { source: 'provider_reported', inputTokens: 1, outputTokens: 1, requestCount: 2 }
  })),
  'settlement_usage_unproven',
  'one receipt settles exactly one provider request');

// ── Fail-closed: unmetered responses charge the full reserve ────────────────

const assumed = buildSettlementReceipt({
  ...receiptBuildArgs(base),
  usage: { source: 'authorized_maximum_assumed' }
});
assert.equal(assumed.settledMicroUsd, assumed.reservedMaximumMicroUsd,
  'an unmetered response settles the FULL reserved maximum, never zero');
assert.equal(assumed.unusedReservationMicroUsd, 0);
assert.equal(assumed.inputTokens, null);
assert.equal(assumed.outputTokens, null);
assert.ok(assumed.settledMicroUsd > receipt.settledMicroUsd,
  'assuming the maximum is strictly more conservative than metered settlement');

assert.equal(
  refusalReason(() => buildSettlementReceipt({
    ...receiptBuildArgs(base),
    usage: { source: 'authorized_maximum_assumed', inputTokens: 0, outputTokens: 0 }
  })),
  'settlement_usage_unproven',
  'an assumed settlement must not present counts it does not have');

// ── Normalization re-derives ────────────────────────────────────────────────

assert.deepEqual(normalizeSettlementReceipt(receipt), receipt,
  'a well-formed receipt normalizes to itself');
assert.deepEqual(normalizeSettlementReceipt(receipt, { pricingCatalog: base.catalog }), receipt,
  'the amount verifies independently against the catalog');
assert.deepEqual(normalizeSettlementReceipt(assumed), assumed);

// An edited amount with a recomputed hash is still caught, because the amount
// is checked against the pricing entry rather than against the hash alone.
const understated = { ...receipt, settledMicroUsd: 1, unusedReservationMicroUsd:
  receipt.reservedMaximumMicroUsd - 1 };
understated.receiptHash = hashCanonical(Object.fromEntries(
  SETTLEMENT_RECEIPT_FIELDS.filter(f => f !== 'receiptHash').map(f => [f, understated[f]])));
assert.equal(
  refusalReason(() => normalizeSettlementReceipt(understated, { pricingCatalog: base.catalog })),
  'settlement_amount_mismatch',
  'an understated settlement is caught even when its hash was recomputed');

// The same edit without a recomputed hash is caught by the hash alone.
assert.equal(
  refusalReason(() => normalizeSettlementReceipt({ ...receipt, settledMicroUsd: 1 })),
  'settlement_amount_mismatch',
  'an inconsistent unused remainder refuses');
assert.equal(
  refusalReason(() => normalizeSettlementReceipt({
    ...receipt, settledMicroUsd: 1, unusedReservationMicroUsd:
      receipt.reservedMaximumMicroUsd - 1
  })),
  'settlement_receipt_malformed',
  'an edited receipt no longer matches its own hash');

assert.equal(
  refusalReason(() => normalizeSettlementReceipt({
    ...receipt,
    settledMicroUsd: receipt.reservedMaximumMicroUsd + 1,
    unusedReservationMicroUsd: 0
  })),
  'settlement_exceeds_reservation',
  'settlement can never exceed the reservation it closes');

assert.equal(
  refusalReason(() => normalizeSettlementReceipt({
    ...assumed, settledMicroUsd: assumed.reservedMaximumMicroUsd - 1,
    unusedReservationMicroUsd: 1
  })),
  'settlement_amount_mismatch',
  'an assumed receipt cannot quietly settle less than the full maximum');

assert.equal(
  refusalReason(() => normalizeSettlementReceipt({ ...receipt, surprise: 1 })),
  'settlement_receipt_malformed',
  'an unknown field refuses');
const { settledAt, ...missingField } = receipt;
assert.equal(
  refusalReason(() => normalizeSettlementReceipt(missingField)),
  'settlement_receipt_malformed',
  'a missing field refuses');
assert.equal(
  refusalReason(() => normalizeSettlementReceipt({ ...receipt, version: 2 })),
  'settlement_receipt_malformed',
  'an unsupported version refuses');

// ── No production pricing ships ─────────────────────────────────────────────

const source = fs.readFileSync(
  path.join(__dirname, '..', 'runtime', 'economic-settlement-receipt-contract.js'), 'utf8');
assert.equal(/inputMicroUsdPerMillionTokens\s*:/.test(source), false,
  'the receipt contract constructs no pricing of its own');
assert.equal(/buildPricingCatalog/.test(source), false,
  'the receipt contract builds no catalog');

console.log('economic settlement receipt contract test passed');

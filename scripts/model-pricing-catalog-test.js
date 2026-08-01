#!/usr/bin/env node
'use strict';

// Tranche 4 deterministic suite for runtime/model-pricing-catalog.
//
// Pure arithmetic and closed-schema behavior. No database, no server, no
// provider, and — by construction — no live pricing lookup of any kind.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  MICRO_USD_PER_USD,
  ModelPricingError,
  PRICING_CATALOG_VERSION,
  PRICING_ENTRY_FIELDS,
  PRICING_REFUSALS,
  PRICING_UNIT,
  assertPricingEntryHardBoundable,
  buildPricingCatalog,
  chargeForUnits,
  classifyPricingEntry,
  computeActualCost,
  computeMaximumLiability,
  findPricingEntry,
  normalizePricingCatalog
} = require('../runtime/model-pricing-catalog');
const {
  BOUND_METHODS,
  MODEL_CAPABILITIES,
  getAdapterCapability,
  modelCapabilityHash,
  resolveModelCapability
} = require('../runtime/provider-adapter-capability');

function paidEntry(overrides = {}) {
  return {
    provider: 'openai',
    // An exact provider snapshot, never a mutable alias.
    model: 'gpt-4o-mini-2024-07-18',
    adapterId: 'openai.responses.v1',
    chargingUnit: 'token',
    inputMicroUsdPerMillionTokens: 150_000,
    outputMicroUsdPerMillionTokens: 600_000,
    requestMicroUsd: 0,
    boundMethod: 'model_context_window_ceiling',
    ...overrides
  };
}

function localEntry(overrides = {}) {
  return {
    provider: 'ollama',
    model: 'any-local-model',
    adapterId: 'ollama.chat.v1',
    chargingUnit: 'token',
    inputMicroUsdPerMillionTokens: 0,
    outputMicroUsdPerMillionTokens: 0,
    requestMicroUsd: 0,
    boundMethod: 'catalog_maximum_exactly_zero',
    ...overrides
  };
}

function catalogOf(entries, catalogId = 'test-catalog') {
  return buildPricingCatalog({ catalogId, entries });
}

function refusalReason(fn) {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof ModelPricingError, 'refusals use the module error');
    assert.equal(error.code, 'MODEL_PRICING_REFUSED');
    assert.equal(PRICING_REFUSALS.includes(error.reason), true,
      `refusal ${error.reason} is in the closed vocabulary`);
    return error.reason;
  }
  return assert.fail('expected a pricing refusal');
}

function invalid(fn) {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof ModelPricingError, 'validation uses the module error');
    return error;
  }
  return assert.fail('expected a contract violation');
}

// ── Unit and vocabulary ─────────────────────────────────────────────────────

assert.equal(PRICING_UNIT, 'micro_usd', 'the accounting unit is integer micro-USD');
assert.equal(MICRO_USD_PER_USD, 1_000_000);
assert.deepEqual([...PRICING_REFUSALS].sort(), [...new Set(PRICING_REFUSALS)].sort());
// A pricing entry selects a runtime bound method; it never defines one and never
// supplies model limits, tokenizer semantics, or adapter behavior.
for (const forbidden of [
  'transmitsOutputCap', 'outputCapCoversAllChargeableOutput', 'inputBoundMethod',
  'framingOverheadTokens', 'contextWindowTokens', 'maxOutputTokens', 'truncation',
  'tokenizerFamily'
]) {
  assert.equal(PRICING_ENTRY_FIELDS.includes(forbidden), false,
    `a pricing entry must not supply ${forbidden}`);
}
assert.equal(PRICING_ENTRY_FIELDS.includes('boundMethod'), true);
for (const entry of [paidEntry(), localEntry()]) {
  assert.equal(BOUND_METHODS.includes(entry.boundMethod), true);
}

// ── Canonical integer arithmetic, rounding UP ───────────────────────────────

assert.equal(chargeForUnits(1_000_000, 2_500_000, 'x'), 2_500_000);
assert.equal(chargeForUnits(0, 2_500_000, 'x'), 0);
assert.equal(chargeForUnits(1_000_000, 0, 'x'), 0);
assert.equal(chargeForUnits(1, 1_000_000, 'x'), 1);
assert.equal(chargeForUnits(1, 999_999, 'x'), 1, 'a sub-unit charge rounds up, never to zero');
assert.equal(chargeForUnits(1, 1, 'x'), 1);
assert.equal(chargeForUnits(2, 500_000, 'x'), 1, 'an exact boundary does not round up');
assert.equal(chargeForUnits(3, 500_000, 'x'), 2, 'just past the boundary rounds up');

// ── Entry schema is closed ──────────────────────────────────────────────────

const catalog = catalogOf([paidEntry(), localEntry()]);
assert.equal(catalog.version, PRICING_CATALOG_VERSION);
assert.deepEqual(Object.keys(catalog.entries[0]).sort(), [...PRICING_ENTRY_FIELDS].sort());
assert.equal(Object.isFrozen(catalog), true);
invalid(() => catalogOf([{ ...paidEntry(), extra: 1 }]));
for (const field of PRICING_ENTRY_FIELDS) {
  const partial = paidEntry();
  delete partial[field];
  invalid(() => catalogOf([partial]));
}

// ── Catalog hash determinism ────────────────────────────────────────────────

assert.equal(catalogOf([paidEntry(), localEntry()]).catalogHash, catalog.catalogHash);
assert.equal(catalogOf([localEntry(), paidEntry()]).catalogHash, catalog.catalogHash,
  'catalog hashing is order-independent');
assert.notEqual(
  catalogOf([paidEntry({ inputMicroUsdPerMillionTokens: 150_001 }), localEntry()]).catalogHash,
  catalog.catalogHash);
assert.equal(normalizePricingCatalog(catalog).catalogHash, catalog.catalogHash);
assert.equal(normalizePricingCatalog(JSON.parse(JSON.stringify(catalog))).catalogHash,
  catalog.catalogHash, 'a catalog survives a JSONB round trip');
invalid(() => normalizePricingCatalog({ ...catalog, catalogHash: '0'.repeat(64) }));
invalid(() => normalizePricingCatalog({ ...catalog, version: 2 }));

// ── Malformed catalogs are refused ──────────────────────────────────────────

assert.equal(refusalReason(() => catalogOf([])), 'pricing_catalog_malformed');
assert.equal(refusalReason(() => catalogOf([paidEntry(), paidEntry({ requestMicroUsd: 5 })])),
  'pricing_entry_duplicate');
assert.equal(refusalReason(() => catalogOf([paidEntry({ inputMicroUsdPerMillionTokens: -1 })])),
  'pricing_rate_negative');
assert.equal(refusalReason(() => catalogOf([paidEntry({ requestMicroUsd: 1.5 })])),
  'pricing_rate_malformed', 'fractional currency is refused outright');
assert.equal(refusalReason(() => catalogOf([paidEntry({ chargingUnit: 'dollars' })])),
  'pricing_unit_ambiguous');
invalid(() => catalogOf([paidEntry({ boundMethod: 'trust_me' })]));
invalid(() => catalogOf([paidEntry({ boundMethod: 'catalog_maximum_exactly_zero' })]),
  'a charging entry cannot claim the zero-cost method');
invalid(() => catalogOf([localEntry({ boundMethod: 'model_context_window_ceiling' })]),
  'a zero-priced entry cannot claim a model ceiling');

// ── Model identity: exact snapshots only ────────────────────────────────────

const paid = findPricingEntry(catalog, { provider: 'openai', model: 'gpt-4o-mini-2024-07-18' });
assert.equal(refusalReason(() => findPricingEntry(catalog,
  { provider: 'openai', model: 'gpt-4o-mini' })), 'pricing_entry_missing');
// A mutable alias, or any unlisted snapshot, has no runtime capability at all.
for (const alias of ['gpt-4o', 'gpt-4o-mini', 'gpt-4.1-latest', 'gpt-5']) {
  assert.throws(() => catalogOf([paidEntry({ model: alias })]),
    error => error.reason === 'model_capability_unknown',
    `${alias} must not inherit another snapshot's limits`);
}
// A charging Ollama route has no declared model capability, so it refuses.
assert.throws(
  () => catalogOf([localEntry({
    inputMicroUsdPerMillionTokens: 1,
    boundMethod: 'model_context_window_ceiling'
  })]),
  error => error.reason === 'model_capability_unknown',
  'paid Ollama remains refused until an exact digest proof exists'
);

// ── The catalog cannot supply model limits ──────────────────────────────────

const modelCapability = resolveModelCapability({
  adapterId: 'openai.responses.v1', model: 'gpt-4o-mini-2024-07-18'
});
assert.equal(modelCapability.contextWindowTokens, 128_000);
assert.equal(modelCapability.maxOutputTokens, 16_384);
assert.equal(modelCapability.isMutableAlias, false);
assert.ok(modelCapability.contextLimitSourceIdentity.length > 0,
  'the context limit names its source');
assert.equal(
  Object.prototype.hasOwnProperty.call(paid, 'contextWindowTokens'), false,
  'the priced entry carries no context window of its own'
);

// ── Classification ──────────────────────────────────────────────────────────

assert.equal(classifyPricingEntry(paid).classification, 'HARD PRE-DISPATCH COST BOUND POSSIBLE');
assert.equal(classifyPricingEntry(paid).basis,
  'model_context_window_ceiling_with_enforced_output_cap');
const local = findPricingEntry(catalog, { provider: 'ollama', model: 'any-local-model' });
assert.equal(classifyPricingEntry(local).basis, 'catalog_maximum_exactly_zero');
assert.equal(assertPricingEntryHardBoundable(paid).hardBoundable, true);

// ── Maximum liability prices the FULL context ceiling ───────────────────────

const liability = computeMaximumLiability({ entry: paid, maxOutputTokens: 2_048 });
assert.equal(liability.boundMethod, 'model_context_window_ceiling');
assert.equal(liability.contextWindowTokens, 128_000);
assert.equal(liability.maxInputTokens, 128_000,
  'the ENTIRE context window is the maximum input, not an estimate of it');
assert.equal(liability.inputMicroUsdPerRequest, 19_200);
assert.equal(liability.outputMicroUsdPerRequest, 1_229, 'output cost rounds up');
assert.equal(liability.maximumMicroUsd, 20_429);
assert.equal(liability.modelCapabilityHash, modelCapabilityHash(modelCapability));
assert.equal(liability.boundProofIdentity, modelCapability.contextLimitSourceIdentity);
// The output cap is NOT subtracted from the context window.
assert.equal(liability.maxInputTokens + liability.maxOutputTokens > 128_000, true,
  'the tighter context-sharing formula is deliberately not assumed');
// No fictional framing allowance appears anywhere in the record.
assert.equal(Object.prototype.hasOwnProperty.call(liability, 'framingOverheadTokens'), false);

// Framing-proof absence does not invalidate this method.
assert.equal(liability.maximumMicroUsd > 0, true,
  'the context-ceiling method stands without any framing proof');

// An output cap above the model maximum is refused.
assert.throws(
  () => computeMaximumLiability({ entry: paid, maxOutputTokens: 16_385 }),
  error => error.reason === 'output_cap_exceeds_model_maximum',
  'an output cap above the model maximum refuses'
);
assert.equal(computeMaximumLiability({ entry: paid, maxOutputTokens: 16_384 }).maxOutputTokens,
  16_384, 'exactly the model maximum is admissible');

// Fixed request charge and authorized fallbacks are included.
assert.equal(
  computeMaximumLiability({ entry: paidEntry({ requestMicroUsd: 500 }), maxOutputTokens: 2_048 })
    .maximumMicroUsd,
  20_929
);
assert.equal(
  computeMaximumLiability({ entry: paid, maxOutputTokens: 2_048, fallbackRequestsAuthorized: 1 })
    .maximumMicroUsd,
  40_858,
  'authorized fallback liability is covered'
);

// A request field outside the model capability shape refuses.
for (const feature of ['tools', 'images', 'previous_response_id']) {
  assert.throws(
    () => computeMaximumLiability({
      entry: paid,
      maxOutputTokens: 2_048,
      requestBody: {
        model: paid.model, input: [], text: {}, max_output_tokens: 2_048,
        truncation: 'disabled', [feature]: 'x'
      }
    }),
    error => error.reason === 'provider_path_not_hard_boundable',
    `${feature} is outside the model capability shape`
  );
}
assert.equal(computeMaximumLiability({
  entry: paid,
  maxOutputTokens: 2_048,
  requestBody: {
    model: paid.model, input: [], text: {}, max_output_tokens: 2_048, truncation: 'disabled'
  }
}).maximumMicroUsd, 20_429, 'the governed shape is admissible');

// Zero-priced routes need no token proof and bound at exactly zero.
assert.equal(computeMaximumLiability({
  entry: local, maxOutputTokens: 999_999, fallbackRequestsAuthorized: 5
}).maximumMicroUsd, 0);
assert.equal(computeMaximumLiability({ entry: local, maxOutputTokens: 1 }).contextWindowTokens,
  null, 'a zero-priced route consults no model ceiling');

// ── Capability drift does not rewrite a captured maximum ────────────────────

const captured = computeMaximumLiability({ entry: paid, maxOutputTokens: 2_048 });
const driftedEntry = paidEntry({ inputMicroUsdPerMillionTokens: 999_999 });
assert.notEqual(
  computeMaximumLiability({ entry: driftedEntry, maxOutputTokens: 2_048 }).maximumMicroUsd,
  captured.maximumMicroUsd,
  'a re-priced entry yields a different maximum'
);
assert.equal(captured.maximumMicroUsd, 20_429,
  'the already-captured maximum is unchanged by later catalog edits');

// ── Overflow refuses ────────────────────────────────────────────────────────

assert.equal(refusalReason(() => chargeForUnits(Number.MAX_SAFE_INTEGER, 1_000_000, 'x')),
  'pricing_arithmetic_overflow');
assert.equal(
  refusalReason(() => computeMaximumLiability({
    entry: paidEntry({ inputMicroUsdPerMillionTokens: Number.MAX_SAFE_INTEGER }),
    maxOutputTokens: 1
  })),
  'pricing_arithmetic_overflow'
);

// ── Actual cost under the captured rates ────────────────────────────────────

assert.equal(computeActualCost({ entry: paid, inputTokens: 1_000, outputTokens: 500 }),
  150 + 300);
assert.equal(computeActualCost({ entry: local, inputTokens: 999, outputTokens: 999 }), 0);
assert.ok(
  computeActualCost({ entry: paid, inputTokens: 128_000, outputTokens: 2_048 }) <=
    liability.maximumMicroUsd,
  'the worst real usage still costs no more than the reserved maximum'
);
invalid(() => computeActualCost({ entry: paid, inputTokens: -1, outputTokens: 0 }));

// ── Route authorization vs economic admissibility ───────────────────────────
//
// The routing contract authorizes all of these routes (proven in
// scripts/role-routing-contract-test.js). Admissibility is decided HERE, and
// separately, with economic reason codes.

// Arbitrary local model, explicitly zero-priced: admissible with no model
// capability and no token-bound proof at all.
const arbitraryZeroPriced = catalogOf([localEntry({ model: 'some-custom-gguf:q4' })]);
const zeroEntry = findPricingEntry(arbitraryZeroPriced,
  { provider: 'ollama', model: 'some-custom-gguf:q4' });
assert.equal(classifyPricingEntry(zeroEntry).hardBoundable, true);
assert.equal(classifyPricingEntry(zeroEntry).basis, 'catalog_maximum_exactly_zero');
assert.equal(computeMaximumLiability({ entry: zeroEntry, maxOutputTokens: 4_096 })
  .maximumMicroUsd, 0);

// The SAME route, paid: refused at the economic layer, with zero provider
// contact. Routing authorization is untouched by this.
assert.throws(
  () => catalogOf([localEntry({
    model: 'some-custom-gguf:q4',
    inputMicroUsdPerMillionTokens: 1,
    boundMethod: 'model_context_window_ceiling'
  })]),
  error => error.reason === 'model_capability_unknown',
  'a paid arbitrary local route refuses economically, not by routing'
);
// An unknown OpenAI snapshot is likewise an economic refusal.
assert.throws(
  () => catalogOf([paidEntry({ model: 'gpt-9-preview-2099-01-01' })]),
  error => error.reason === 'model_capability_unknown',
  'a paid unknown snapshot refuses economically, not by routing'
);
// A supported snapshot with no catalog entry refuses for pricing, not routing.
assert.equal(
  refusalReason(() => findPricingEntry(catalog,
    { provider: 'openai', model: 'gpt-4.1-2025-04-14' })),
  'pricing_entry_missing'
);

// ── No production paid pricing is shipped ───────────────────────────────────

const catalogSource = fs.readFileSync(
  path.join(__dirname, '..', 'runtime', 'model-pricing-catalog.js'), 'utf8');
// No paid rate is shipped: the module defines the builder but constructs no
// catalog, and declares no rate literal. Production pricing must be supplied by
// an administrator, and its absence fails closed.
assert.equal(/MicroUsdPerMillionTokens:\s*[1-9]/.test(catalogSource), false,
  'the module declares no paid rate of its own');
assert.equal(catalogSource.includes('catalogId: \''), false,
  'the module constructs no catalog of its own');
for (const forbidden of [
  'fetch(', 'require(\'http', 'https://', 'child_process', 'Math.random',
  'parseFloat', 'toFixed', 'cheapest', 'optimi'
]) {
  assert.equal(catalogSource.replace(/^\s*\/\/.*$/gm, '').includes(forbidden), false,
    `pricing stays static and integer-only: ${forbidden} must not appear`);
}

console.log('model pricing catalog test passed');

'use strict';

// Tranche 4 — closed, versioned, administrator-controlled model pricing.
//
// This module holds the ONLY prices the runtime will ever charge against. It
// performs no I/O and contacts no pricing service: live price lookup, price
// shopping and "pick the cheaper model" are all outside this tranche, and a
// catalog entry is therefore a static administrative fact, not a market quote.
//
// Every amount is an integer count of MICRO-USD (1 USD = 1_000_000 micro-USD).
// There is no floating-point currency anywhere in this contract, and every
// division rounds UP, so a computed maximum can never understate liability.
//
// A catalog update applies only to decisions admitted after it. Captured
// economic authority keeps the catalog hash and the rates it was admitted
// under, so re-pricing history is not representable.

const {
  compareCanonicalText,
  deepFreeze,
  hashCanonical
} = require('./declared-work-contract');
const {
  assertOutputCapWithinModel,
  getAdapterCapability,
  modelCapabilityHash,
  resolveModelCapability
} = require('./provider-adapter-capability');

const PRICING_CATALOG_VERSION = 1;

// The accounting unit, named once. Integer micro-USD throughout.
const PRICING_UNIT = 'micro_usd';
const MICRO_USD_PER_USD = 1_000_000;
// Rates are quoted per million tokens because that is how providers publish
// them, and because it keeps the rate itself an integer for every real price.
const TOKENS_PER_RATE_UNIT = 1_000_000;

// Input-bound proofs and adapter capabilities are RUNTIME facts and live in
// runtime/provider-adapter-capability.js. A pricing entry may only NAME the
// proof and adapter it was priced against; it can never assert what the adapter
// does. That separation is what stops an administrator record from making the
// runtime claim a bound the adapter does not enforce.

const CHARGING_UNITS = Object.freeze(['token']);

const PRICING_ENTRY_FIELDS = Object.freeze([
  'provider',
  'model',
  'adapterId',
  'chargingUnit',
  'inputMicroUsdPerMillionTokens',
  // Covers EVERY chargeable output category for the named adapter operation.
  // For OpenAI Responses that includes reasoning tokens, which the provider
  // bills inside the output-token total.
  'outputMicroUsdPerMillionTokens',
  'requestMicroUsd',
  // Names WHICH runtime bound method applies. It selects an already-declared
  // method; it never defines one, and it cannot supply model limits.
  'boundMethod'
]);

const PRICING_CATALOG_FIELDS = Object.freeze([
  'version',
  'catalogId',
  'entries',
  'catalogHash'
]);

// Closed refusals. Every decline names exactly one of these.
const PRICING_REFUSALS = Object.freeze([
  'pricing_entry_missing',
  'pricing_entry_duplicate',
  'pricing_rate_negative',
  'pricing_rate_malformed',
  'pricing_unit_ambiguous',
  'pricing_catalog_malformed',
  'pricing_arithmetic_overflow',
  'provider_path_not_hard_boundable'
]);

// Cost is computed in integer micro-USD and every intermediate product must stay
// inside the safe-integer range. A liability that cannot be represented exactly
// is refused rather than silently rounded into a smaller number.
const MAX_MICRO_USD = Number.MAX_SAFE_INTEGER;

class ModelPricingError extends TypeError {
  constructor(code, message, detail = {}) {
    super(message);
    this.name = 'ModelPricingError';
    this.code = code;
    this.reason = detail.reason || null;
  }
}

function fail(message, code = 'MODEL_PRICING_INVALID', detail = {}) {
  throw new ModelPricingError(code, message, detail);
}

function refuse(reason, message = null) {
  if (!PRICING_REFUSALS.includes(reason)) {
    fail(`Unsupported pricing refusal reason: ${String(reason)}`);
  }
  fail(message || reason, 'MODEL_PRICING_REFUSED', { reason });
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactFields(value, fields, label) {
  if (!isPlainObject(value)) fail(`${label} must be an object`);
  const unknown = Object.keys(value).filter(field => !fields.includes(field));
  const missing = fields.filter(field => !Object.prototype.hasOwnProperty.call(value, field));
  if (unknown.length > 0) {
    fail(`${label} contains unknown field(s): ${unknown.sort(compareCanonicalText).join(', ')}`);
  }
  if (missing.length > 0) fail(`${label} is missing field(s): ${missing.join(', ')}`);
}

function requiredText(value, label, maximum = 256) {
  if (typeof value !== 'string') fail(`${label} must be a string`);
  const text = value.trim();
  if (!text) fail(`${label} must not be empty`);
  if (text.length > maximum) fail(`${label} exceeds ${maximum} characters`);
  return text;
}

// Rates and counts are non-negative integers. A negative, fractional, infinite
// or NaN rate is a malformed catalog, never a zero.
function nonNegativeInteger(value, label, reason = 'pricing_rate_malformed') {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    refuse(reason, `${label} must be a finite integer`);
  }
  if (value < 0) refuse('pricing_rate_negative', `${label} must not be negative`);
  if (!Number.isSafeInteger(value)) {
    refuse(reason, `${label} must be a safe integer (no fractional currency)`);
  }
  return value;
}

function assertBoolean(value, label) {
  if (typeof value !== 'boolean') fail(`${label} must be a boolean`);
  return value;
}

// Integer multiply-and-divide with explicit upward rounding, overflow-checked at
// every step. `ceil(count * ratePerMillion / 1_000_000)` without ever forming a
// float.
function chargeForUnits(count, ratePerRateUnit, label) {
  const units = nonNegativeInteger(count, `${label}.count`);
  const rate = nonNegativeInteger(ratePerRateUnit, `${label}.rate`);
  if (units === 0 || rate === 0) return 0;
  if (units > Math.floor(MAX_MICRO_USD / rate)) {
    refuse('pricing_arithmetic_overflow',
      `${label} exceeds the representable micro-USD range`);
  }
  const product = units * rate;
  // Ceiling division on non-negative integers, without floating point.
  const charge = Math.floor(product / TOKENS_PER_RATE_UNIT) +
    (product % TOKENS_PER_RATE_UNIT === 0 ? 0 : 1);
  if (!Number.isSafeInteger(charge)) {
    refuse('pricing_arithmetic_overflow', `${label} charge is not representable`);
  }
  return charge;
}

function addMicroUsd(left, right, label) {
  const total = left + right;
  if (!Number.isSafeInteger(total) || total > MAX_MICRO_USD) {
    refuse('pricing_arithmetic_overflow', `${label} exceeds the representable micro-USD range`);
  }
  return total;
}

// ── Catalog entries ─────────────────────────────────────────────────────────

function normalizePricingEntry(value, index) {
  const label = `pricingCatalog.entries[${index}]`;
  exactFields(value, PRICING_ENTRY_FIELDS, label);
  const chargingUnit = requiredText(value.chargingUnit, `${label}.chargingUnit`, 32);
  if (!CHARGING_UNITS.includes(chargingUnit)) {
    refuse('pricing_unit_ambiguous', `${label}.chargingUnit is unsupported: ${chargingUnit}`);
  }
  const inputMicroUsdPerMillionTokens = nonNegativeInteger(
    value.inputMicroUsdPerMillionTokens,
    `${label}.inputMicroUsdPerMillionTokens`
  );
  const outputMicroUsdPerMillionTokens = nonNegativeInteger(
    value.outputMicroUsdPerMillionTokens,
    `${label}.outputMicroUsdPerMillionTokens`
  );
  const requestMicroUsd = nonNegativeInteger(value.requestMicroUsd, `${label}.requestMicroUsd`);
  const provider = requiredText(value.provider, `${label}.provider`, 64);
  const adapterId = requiredText(value.adapterId, `${label}.adapterId`, 128);
  const model = requiredText(value.model, `${label}.model`, 256);
  const capability = getAdapterCapability(adapterId);
  if (capability.provider !== provider) {
    fail(`${label}.adapterId ${adapterId} does not serve provider ${provider}`);
  }
  const zeroRated = inputMicroUsdPerMillionTokens === 0 &&
    outputMicroUsdPerMillionTokens === 0 &&
    requestMicroUsd === 0;
  // A zero-priced route needs no token bound at all: its maximum is exactly zero
  // for any token count, so it names no bound method and an administrator cannot
  // attach model limits or tokenizer semantics to it.
  if (zeroRated) {
    if (value.boundMethod !== 'catalog_maximum_exactly_zero') {
      fail(`${label}.boundMethod must be catalog_maximum_exactly_zero for a zero-priced entry`);
    }
  } else {
    if (value.boundMethod !== 'model_context_window_ceiling') {
      fail(`${label}.boundMethod must be model_context_window_ceiling for a charging entry`);
    }
    // The model must be an exact declared snapshot with a documented context
    // ceiling. The catalog supplies the PRICE; the runtime supplies the limits.
    resolveModelCapability({ adapterId, model });
  }
  return {
    provider,
    model,
    adapterId,
    chargingUnit,
    inputMicroUsdPerMillionTokens,
    outputMicroUsdPerMillionTokens,
    requestMicroUsd,
    boundMethod: value.boundMethod
  };
}

function entryKey(entry) {
  return `${entry.provider} ${entry.model}`;
}

function buildPricingCatalog({ catalogId, entries }) {
  if (!Array.isArray(entries) || entries.length === 0) {
    refuse('pricing_catalog_malformed', 'pricingCatalog.entries must be a non-empty array');
  }
  const normalized = entries
    .map(normalizePricingEntry)
    .sort((left, right) => compareCanonicalText(entryKey(left), entryKey(right)));
  const seen = new Set();
  for (const entry of normalized) {
    const key = entryKey(entry);
    if (seen.has(key)) {
      refuse('pricing_entry_duplicate',
        `pricingCatalog contains duplicate entries for ${entry.provider}/${entry.model}`);
    }
    seen.add(key);
  }
  const withoutHash = {
    version: PRICING_CATALOG_VERSION,
    catalogId: requiredText(catalogId, 'pricingCatalog.catalogId', 128),
    entries: normalized
  };
  return deepFreeze({ ...withoutHash, catalogHash: hashCanonical(withoutHash) });
}

function normalizePricingCatalog(value) {
  exactFields(value, PRICING_CATALOG_FIELDS, 'pricingCatalog');
  if (value.version !== PRICING_CATALOG_VERSION) {
    fail(`pricingCatalog.version must be ${PRICING_CATALOG_VERSION}`);
  }
  const rebuilt = buildPricingCatalog(value);
  if (typeof value.catalogHash !== 'string' || value.catalogHash !== rebuilt.catalogHash) {
    fail('pricingCatalog.catalogHash does not match its entries',
      'MODEL_PRICING_CATALOG_CONFLICT');
  }
  return rebuilt;
}

function findPricingEntry(catalog, { provider, model }) {
  const wantedProvider = requiredText(provider, 'provider', 64);
  const wantedModel = requiredText(model, 'model', 256);
  const entry = catalog.entries.find(candidate =>
    candidate.provider === wantedProvider && candidate.model === wantedModel) || null;
  if (!entry) {
    refuse('pricing_entry_missing',
      `pricingCatalog has no entry for ${wantedProvider}/${wantedModel}`);
  }
  return entry;
}

// ── Hard-boundability ───────────────────────────────────────────────────────
//
// A route is hard-boundable only when the runtime can enforce EVERY value it
// uses in the maximum. Reported after the fact is not enforced; a byte limit on
// the response read is not an output-token cap; and an entry that charges but
// whose adapter transmits no cap is not boundable at any price.

function classifyPricingEntry(entry) {
  if (entry.boundMethod === 'catalog_maximum_exactly_zero') {
    // Eligible because the captured catalog maximum is exactly zero for every
    // applicable rate — not because of the provider name or where it runs.
    return deepFreeze({
      classification: 'HARD PRE-DISPATCH COST BOUND POSSIBLE',
      hardBoundable: true,
      reason: null,
      basis: 'catalog_maximum_exactly_zero'
    });
  }
  const capability = getAdapterCapability(entry.adapterId);
  try {
    const model = resolveModelCapability({ adapterId: entry.adapterId, model: entry.model });
    if (!capability.outputCapSerialized) {
      refuse('provider_path_not_hard_boundable',
        `${capability.adapterId} does not serialize an output cap`);
    }
    const uncovered = capability.chargeableOutputCategories
      .filter(category => !capability.outputCapCoversCategories.includes(category));
    if (uncovered.length > 0) {
      refuse('provider_path_not_hard_boundable',
        `${capability.adapterId} output cap does not cover: ${uncovered.join(', ')}`);
    }
    if (model.boundMethod !== 'model_context_window_ceiling') {
      refuse('provider_path_not_hard_boundable',
        `${model.modelId} declares no context-window ceiling`);
    }
  } catch (error) {
    return deepFreeze({
      classification: 'POST-HOC ACCOUNTING ONLY',
      hardBoundable: false,
      reason: 'provider_path_not_hard_boundable',
      basis: error.reason || 'model_capability_unproven'
    });
  }
  return deepFreeze({
    classification: 'HARD PRE-DISPATCH COST BOUND POSSIBLE',
    hardBoundable: true,
    reason: null,
    basis: 'model_context_window_ceiling_with_enforced_output_cap'
  });
}

function assertPricingEntryHardBoundable(entry) {
  const classified = classifyPricingEntry(entry);
  if (!classified.hardBoundable) {
    refuse(classified.reason,
      `${entry.provider}/${entry.model} is not hard-boundable: ${classified.basis}`);
  }
  return classified;
}

// ── Maximum liability ───────────────────────────────────────────────────────
//
// The paid bound prices the ENTIRE model context window as the maximum input.
// Every accepted input token — including server-side envelope tokens, special
// tokens and any hidden prompt additions — is subject to that finite ceiling,
// which is why this method needs no framing estimate and is valid where a byte
// ceiling was not. Truncation is explicitly disabled on governed requests, so an
// over-long request is REJECTED rather than silently trimmed, which is what
// keeps "accepted input <= context window" true.
//
// It over-reserves substantially. That is intentional, and is the honest price of
// a hard bound without a tokenizer. The output cap is NOT subtracted from the
// context window: nothing in this repository establishes the accounting
// relationship that would make the tighter formula sound.
function computeMaximumLiability({
  entry,
  requestBody = null,
  maxOutputTokens,
  maxProviderRequests = 1,
  fallbackRequestsAuthorized = 0
}) {
  assertPricingEntryHardBoundable(entry);
  const requests = nonNegativeInteger(maxProviderRequests, 'maxProviderRequests');
  if (requests < 1) fail('maxProviderRequests must be at least 1');
  const fallbacks = nonNegativeInteger(fallbackRequestsAuthorized, 'fallbackRequestsAuthorized');
  const chargeableRequests = addMicroUsd(requests, fallbacks, 'chargeableRequests');

  if (entry.boundMethod === 'catalog_maximum_exactly_zero') {
    return deepFreeze({
      unit: PRICING_UNIT,
      provider: entry.provider,
      model: entry.model,
      boundMethod: entry.boundMethod,
      boundProofIdentity: 'catalog-maximum-exactly-zero/v1',
      modelCapabilityHash: null,
      contextWindowTokens: null,
      maxInputTokens: 0,
      maxOutputTokens: nonNegativeInteger(maxOutputTokens, 'maxOutputTokens'),
      maxProviderRequests: requests,
      fallbackRequestsAuthorized: fallbacks,
      chargeableRequests,
      inputMicroUsdPerRequest: 0,
      outputMicroUsdPerRequest: 0,
      requestMicroUsdPerRequest: 0,
      maximumMicroUsd: 0
    });
  }

  const model = resolveModelCapability({ adapterId: entry.adapterId, model: entry.model });
  const outputTokens = assertOutputCapWithinModel(model, maxOutputTokens);
  if (requestBody !== null) {
    const outside = Object.keys(requestBody)
      .filter(field => !model.supportedRequestShape.includes(field));
    if (outside.length > 0) {
      refuse('provider_path_not_hard_boundable',
        `${model.modelId} capability does not cover request field(s): ` +
        `${outside.sort(compareCanonicalText).join(', ')}`);
    }
  }

  const perRequestInput = chargeForUnits(
    model.contextWindowTokens,
    entry.inputMicroUsdPerMillionTokens,
    'inputCharge'
  );
  const perRequestOutput = chargeForUnits(
    outputTokens,
    entry.outputMicroUsdPerMillionTokens,
    'outputCharge'
  );
  const perRequest = addMicroUsd(
    addMicroUsd(perRequestInput, perRequestOutput, 'perRequestUsage'),
    entry.requestMicroUsd,
    'perRequestTotal'
  );
  if (perRequest !== 0 && chargeableRequests > Math.floor(MAX_MICRO_USD / perRequest)) {
    refuse('pricing_arithmetic_overflow',
      'maximum liability exceeds the representable micro-USD range');
  }
  const maximumMicroUsd = perRequest * chargeableRequests;
  if (!Number.isSafeInteger(maximumMicroUsd)) {
    refuse('pricing_arithmetic_overflow', 'maximum liability is not representable');
  }
  return deepFreeze({
    unit: PRICING_UNIT,
    provider: entry.provider,
    model: entry.model,
    boundMethod: entry.boundMethod,
    boundProofIdentity: model.contextLimitSourceIdentity,
    modelCapabilityHash: modelCapabilityHash(model),
    contextWindowTokens: model.contextWindowTokens,
    maxInputTokens: model.contextWindowTokens,
    maxOutputTokens: outputTokens,
    maxProviderRequests: requests,
    fallbackRequestsAuthorized: fallbacks,
    chargeableRequests,
    inputMicroUsdPerRequest: perRequestInput,
    outputMicroUsdPerRequest: perRequestOutput,
    requestMicroUsdPerRequest: entry.requestMicroUsd,
    maximumMicroUsd
  });
}

function computeActualCost({ entry, inputTokens, outputTokens, requestCount = 1 }) {
  const requests = nonNegativeInteger(requestCount, 'requestCount');
  const input = chargeForUnits(
    nonNegativeInteger(inputTokens, 'inputTokens'),
    entry.inputMicroUsdPerMillionTokens,
    'actualInputCharge'
  );
  const output = chargeForUnits(
    nonNegativeInteger(outputTokens, 'outputTokens'),
    entry.outputMicroUsdPerMillionTokens,
    'actualOutputCharge'
  );
  const fixed = requests === 0 || entry.requestMicroUsd === 0
    ? 0
    : (requests > Math.floor(MAX_MICRO_USD / entry.requestMicroUsd)
      ? refuse('pricing_arithmetic_overflow', 'fixed request charge overflows')
      : requests * entry.requestMicroUsd);
  return addMicroUsd(addMicroUsd(input, output, 'actualUsage'), fixed, 'actualTotal');
}

module.exports = {
  CHARGING_UNITS,
  MICRO_USD_PER_USD,
  ModelPricingError,
  PRICING_CATALOG_FIELDS,
  PRICING_CATALOG_VERSION,
  PRICING_ENTRY_FIELDS,
  PRICING_REFUSALS,
  PRICING_UNIT,
  TOKENS_PER_RATE_UNIT,
  assertPricingEntryHardBoundable,
  buildPricingCatalog,
  chargeForUnits,
  classifyPricingEntry,
  computeActualCost,
  computeMaximumLiability,
  findPricingEntry,
  normalizePricingCatalog,
  refusePricing: refuse
};

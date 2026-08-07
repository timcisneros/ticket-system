'use strict';

// Tranche 6 — the ONE place the live evaluation learns what a request is worth.
//
// WHY THIS EXISTS. The live layer had grown its own pricing arithmetic:
//
//   (contextWindowTokens * inputRate + maxOutputTokens * outputRate) / 1e6
//
// That is a second pricing implementation, and it disagreed with the kernel in
// two ways rather than one. It never rounded, so it produced 20,428.8 — a
// fractional monetary authority in a contract whose first paragraph says every
// amount is an integer count of micro-USD and every division rounds UP. And it
// divided the SUMMED product once, where the kernel rounds each charge
// component separately. The two happen to agree after a ceiling here; they do
// not agree in general, and an evaluation must not depend on a coincidence of
// rates.
//
// So the live layer no longer computes prices. It asks
// `computeMaximumLiability` — the same function governed economics already
// trusts — and receives an integer. The live trial module answers only:
//
//   HOW MANY independently chargeable bounded requests can this trial authorize?
//
// It never answers what one request is worth.

const {
  buildPricingCatalog, computeMaximumLiability, findPricingEntry
} = require('../../runtime/model-pricing-catalog');
const { pricedCatalogValue } = require('../governed-structured-fixture');
const { ROLE_ECONOMICS, ADAPTER_ID, PROVIDER } =
  require('./governed-role-policy-container');

class LivePriceError extends Error {
  constructor(message, detail = {}) {
    super(message);
    this.name = 'LivePriceError';
    this.code = detail.code || 'LIVE_PRICE_INVALID';
    this.detail = detail;
  }
}

// FAIL-CLOSED MONETARY VALIDATION. Anything that is not a non-negative safe
// integer is refused rather than repaired: rounding belongs at the canonical
// calculation, and an amount that arrives here already malformed has escaped it.
function assertIntegerMicroUsd(value, label) {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    throw new LivePriceError(`${label} is not a number`,
      { code: 'LIVE_PRICE_NOT_A_NUMBER', label, value: String(value) });
  }
  if (!Number.isFinite(value)) {
    throw new LivePriceError(`${label} is not finite`,
      { code: 'LIVE_PRICE_NOT_FINITE', label, value: String(value) });
  }
  if (!Number.isInteger(value)) {
    throw new LivePriceError(
      `${label} is fractional (${value}); monetary authority is integer ` +
      'micro-USD, and rounding belongs to the canonical pricing calculation',
      { code: 'LIVE_PRICE_FRACTIONAL', label, value });
  }
  if (value < 0) {
    throw new LivePriceError(`${label} is negative (${value})`,
      { code: 'LIVE_PRICE_NEGATIVE', label, value });
  }
  if (!Number.isSafeInteger(value)) {
    throw new LivePriceError(`${label} exceeds the safe integer range`,
      { code: 'LIVE_PRICE_UNSAFE', label, value });
  }
  return value;
}

function multiplyMicroUsd(amount, count, label) {
  assertIntegerMicroUsd(amount, `${label}.amount`);
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new LivePriceError(`${label}.count must be a non-negative safe integer`,
      { code: 'LIVE_PRICE_COUNT_INVALID', label, count });
  }
  if (amount !== 0 && count > Math.floor(Number.MAX_SAFE_INTEGER / amount)) {
    throw new LivePriceError(`${label} overflows the safe integer range`,
      { code: 'LIVE_PRICE_UNSAFE', label, amount, count });
  }
  return assertIntegerMicroUsd(amount * count, label);
}

function addMicroUsd(left, right, label) {
  assertIntegerMicroUsd(left, `${label}.left`);
  assertIntegerMicroUsd(right, `${label}.right`);
  return assertIntegerMicroUsd(left + right, label);
}

// ── The canonical per-request maximum, per role ─────────────────────────────
//
// Both governed roles carry the SAME frozen output cap and the same catalog, so
// their per-request maximum is the same integer — but it is derived per role
// rather than shared, because equal values must not be expressed as one bound:
// that would erase the role identity the reservation binds against.
//
// The ungoverned worker has no economic policy of its own. Its live request
// carries the same model, the same 2,048-token cap and the same catalog entry
// (proved on the wire by the dispatch acceptance suite), so it is priced by the
// same canonical call with the leaf executor's output cap. That is what makes
// "no role uses a different bound method" a checkable statement.
function canonicalPerRequestMicroUsd({ role, catalogValue = null } = {}) {
  const economics = ROLE_ECONOMICS[role === 'ungoverned_worker'
    ? 'structured_leaf_executor' : role];
  if (!economics) {
    throw new LivePriceError(`no frozen economics for role ${String(role)}`,
      { code: 'LIVE_PRICE_ROLE_UNKNOWN', role });
  }
  const catalog = buildPricingCatalog(catalogValue || pricedCatalogValue());
  const entry = findPricingEntry(catalog, {
    provider: PROVIDER, model: catalog.entries[0].model, adapterId: ADAPTER_ID
  });
  if (!entry) {
    throw new LivePriceError('the frozen catalog carries no entry for the live route',
      { code: 'LIVE_PRICE_ENTRY_MISSING', provider: PROVIDER, adapterId: ADAPTER_ID });
  }
  // ONE REQUEST. The trial topology multiplies; the kernel prices.
  const liability = computeMaximumLiability({
    entry,
    maxOutputTokens: economics.maximumOutputTokensPerRequest,
    maxProviderRequests: 1
  });
  return Object.freeze({
    role,
    model: entry.model,
    provider: entry.provider,
    adapterId: entry.adapterId,
    pricingCatalogId: catalog.catalogId,
    pricingCatalogHash: catalog.catalogHash,
    boundMethod: entry.boundMethod,
    contextWindowTokens: liability.contextWindowTokens,
    maxOutputTokens: liability.maxOutputTokens,
    inputMicroUsdPerRequest: assertIntegerMicroUsd(
      liability.inputMicroUsdPerRequest, 'inputMicroUsdPerRequest'),
    outputMicroUsdPerRequest: assertIntegerMicroUsd(
      liability.outputMicroUsdPerRequest, 'outputMicroUsdPerRequest'),
    requestMicroUsdPerRequest: assertIntegerMicroUsd(
      liability.requestMicroUsdPerRequest, 'requestMicroUsdPerRequest'),
    perRequestMicroUsd: assertIntegerMicroUsd(
      liability.maximumMicroUsd, 'perRequestMicroUsd')
  });
}

module.exports = {
  LivePriceError,
  addMicroUsd,
  assertIntegerMicroUsd,
  canonicalPerRequestMicroUsd,
  multiplyMicroUsd
};

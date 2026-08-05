'use strict';

// Tranche 6 — ONE normalized cost method for all five arms.
//
// THE MEASUREMENT TRAP THIS AVOIDS.
//
// Only the governed structured arms (B and C) have durable money:
// `economic_request_reservations.settled_micro_usd` exists nowhere else. The
// direct and legacy arms (A, A2a, A2b) have no settled monetary authority at
// all — they never enter the economic ledger.
//
// Comparing B/C's durable settlement against a differently-derived number for
// A/A2 would compare two measurement METHODS and report the difference as a
// product difference. So every arm — including B and C — is scored with the
// SAME derived method here, and the durable governed figure is reported
// alongside as an accounting cross-check, never as the comparison value.
//
// THE NORMALIZED METHOD, identical for every arm:
//
//   canonical provider requests
//     x one immutable pricing-catalog snapshot
//     -> normalized derived cost
//
// Same model identity, same token accounting, same rounding (delegated to the
// catalog's own `computeActualCost`), same pricing snapshot, same request
// classification. Nothing here re-implements pricing arithmetic; doing so would
// be a second pricing authority, which is exactly what Tranche 4 forbade.
//
// NO INVENTED AUTHORITY. Normalized values are labelled `derived` in every
// record they appear in. This module never writes, never settles and never
// claims a settled figure for an arm that has none.

const crypto = require('node:crypto');
const {
  computeActualCost,
  findPricingEntry,
  normalizePricingCatalog
} = require('../../runtime/model-pricing-catalog');

class NormalizedCostError extends Error {
  constructor(message) {
    super(message);
    this.name = 'NormalizedCostError';
  }
}

// Canonical request roles. Planner cost is counted, never excluded: it is a
// real cost of the structured path and omitting it would flatter B and C.
const REQUEST_ROLES = Object.freeze(['planner', 'worker']);

// How a request's tokens became known. Recorded per request so a reader can
// see exactly how much of a total rests on a fallback rather than on metered
// usage — and so an arm cannot quietly get a better token source than another.
const TOKEN_SOURCES = Object.freeze([
  // Provider-reported usage, durably recorded for this request.
  'metered_usage',
  // No usage is durably recorded for this request. Priced at the authorized
  // maximum for the entry, exactly as the governed settlement path does when
  // usage is unproven. Applied IDENTICALLY on every arm.
  'authorized_maximum_assumed'
]);

// Freeze one pricing snapshot for a whole evaluation. Every trial in a
// comparison must use this same object, and its hash travels with every record
// so two results priced under different catalogs can never be pooled.
function freezePricingSnapshot(catalogValue) {
  const catalog = normalizePricingCatalog(catalogValue);
  const snapshotHash = crypto.createHash('sha256')
    .update(JSON.stringify(catalog)).digest('hex');
  return Object.freeze({ catalog, snapshotHash });
}

function resolveEntry(snapshot, { provider, model, adapterId }) {
  const entry = findPricingEntry(snapshot.catalog, { provider, model, adapterId });
  if (!entry) {
    throw new NormalizedCostError(
      `the frozen pricing snapshot has no entry for ${provider}/${model}`);
  }
  return entry;
}

// Price ONE canonical request. The same function is used for every arm; there
// is no per-arm branch anywhere in this module, and the accompanying suite
// asserts that identical inputs produce identical output regardless of the arm
// label carried alongside.
function priceRequest(snapshot, request) {
  if (!REQUEST_ROLES.includes(request.role)) {
    throw new NormalizedCostError(`unsupported request role: ${request.role}`);
  }
  const entry = resolveEntry(snapshot, request);
  const hasMeteredUsage = Number.isSafeInteger(request.inputTokens) &&
    Number.isSafeInteger(request.outputTokens) &&
    request.inputTokens >= 0 && request.outputTokens >= 0;

  if (hasMeteredUsage) {
    const microUsd = computeActualCost({
      entry,
      inputTokens: request.inputTokens,
      outputTokens: request.outputTokens,
      requestCount: 1
    });
    return Object.freeze({
      role: request.role,
      provider: entry.provider,
      model: entry.model,
      tokenSource: 'metered_usage',
      inputTokens: request.inputTokens,
      outputTokens: request.outputTokens,
      microUsd,
      measurement: 'derived'
    });
  }

  // Fail-closed fallback, identical on every arm: an unmetered request is
  // priced at the authorized maximum rather than at zero. Pricing it at zero
  // would make an arm that records less usage look cheaper, which is the
  // opposite of the truth.
  if (!Number.isSafeInteger(request.authorizedOutputTokens) ||
      !Number.isSafeInteger(request.boundInputTokens)) {
    throw new NormalizedCostError(
      'an unmetered request must supply authorizedOutputTokens and boundInputTokens ' +
      'so the authorized maximum can be computed the same way for every arm');
  }
  // THE SAME FUNCTION, applied to the authorized maximum instead of metered
  // usage. Using a different pricing routine for the fallback would make the
  // method differ exactly where an arm is least instrumented.
  const microUsd = computeActualCost({
    entry,
    inputTokens: request.boundInputTokens,
    outputTokens: request.authorizedOutputTokens,
    requestCount: 1
  });
  return Object.freeze({
    role: request.role,
    provider: entry.provider,
    model: entry.model,
    tokenSource: 'authorized_maximum_assumed',
    inputTokens: null,
    outputTokens: null,
    microUsd,
    measurement: 'derived'
  });
}

// The Ticket-scoped normalized cost for one trial.
//
// `durableGovernedMicroUsd` is optional and is ONLY supplied for arms that have
// an economic ledger. When present it is reported beside the normalized figure
// together with their difference — an accounting-integrity check, never a
// second product score, and never the value used for cross-arm comparison.
function buildNormalizedCost({
  snapshot,
  requests,
  truthfulCompletions,
  durableGovernedMicroUsd = null,
  releasedReservations = 0,
  retries = 0
}) {
  if (!snapshot || typeof snapshot.snapshotHash !== 'string') {
    throw new NormalizedCostError('a frozen pricing snapshot is required');
  }
  if (!Array.isArray(requests)) {
    throw new NormalizedCostError('requests must be an array');
  }
  const priced = requests.map(request => priceRequest(snapshot, request));
  const byRole = role => priced.filter(item => item.role === role);
  const sum = items => items.reduce((total, item) => total + item.microUsd, 0);

  const plannerRequests = byRole('planner');
  const workerRequests = byRole('worker');
  const totalMicroUsd = sum(priced);

  // Cost per truthfully completed objective. Zero truthful completions is not
  // "infinite cost" and is not zero either — it is undefined, and is reported
  // as null so no aggregation can silently treat it as a number.
  const perTruthfulCompletion = Number.isSafeInteger(truthfulCompletions) &&
    truthfulCompletions > 0
    ? Math.round(totalMicroUsd / truthfulCompletions)
    : null;

  const durable = Number.isSafeInteger(durableGovernedMicroUsd)
    ? durableGovernedMicroUsd
    : null;

  return Object.freeze({
    pricingSnapshotHash: snapshot.snapshotHash,
    measurement: 'derived',
    plannerRequestCount: plannerRequests.length,
    plannerMicroUsd: sum(plannerRequests),
    workerRequestCount: workerRequests.length,
    workerMicroUsd: sum(workerRequests),
    retries,
    releasedReservations,
    totalNormalizedMicroUsd: totalMicroUsd,
    truthfulCompletions: Number.isSafeInteger(truthfulCompletions)
      ? truthfulCompletions : 0,
    normalizedMicroUsdPerTruthfulCompletion: perTruthfulCompletion,
    unmeteredRequestCount: priced.filter(
      item => item.tokenSource === 'authorized_maximum_assumed').length,
    // Reported, never compared across arms.
    durableGovernedMicroUsd: durable,
    durableVersusNormalizedDeltaMicroUsd: durable === null
      ? null
      : durable - totalMicroUsd,
    requests: Object.freeze(priced)
  });
}

// Guard used by the runner: two trials may only be pooled when they were priced
// under the same frozen snapshot.
function assertComparablePricing(records) {
  const hashes = new Set(records.map(record => record.pricingSnapshotHash));
  if (hashes.size > 1) {
    throw new NormalizedCostError(
      `refusing to compare costs priced under ${hashes.size} different pricing snapshots`);
  }
}

module.exports = {
  REQUEST_ROLES,
  TOKEN_SOURCES,
  NormalizedCostError,
  freezePricingSnapshot,
  priceRequest,
  buildNormalizedCost,
  assertComparablePricing
};

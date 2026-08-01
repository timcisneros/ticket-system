'use strict';

// Tranche 4 — the immutable settlement receipt.
//
// AUTHORITY FLOWS ONE WAY, and this is the last hop:
//
//   routing decision ──▶ economic authority ──▶ prepared request ──▶ RECEIPT
//
// A receipt is written once, after a provider response has been persisted, and
// is never revised. It answers exactly one question:
//
//   For this one reserved request, what was actually owed, and against which
//   exact bytes, which exact response, and which exact authority?
//
// Every binding in a receipt is copied from a NORMALIZED upstream document —
// the prepared request, the economic authority, the pricing catalog — never
// from caller-supplied prose. The caller contributes only the response identity
// and hash and the reported usage; everything else is transcribed, and the
// settled amount is RECOMPUTED here rather than trusted.
//
// FAIL-CLOSED USAGE. A provider that reports no usage does not settle to zero.
// It settles to the FULL reserved maximum, under the explicit
// `authorized_maximum_assumed` source. Under-charging an unproven response
// would let an unmetered provider path drain an account silently, so the only
// safe assumption is that everything authorized was consumed.
//
// Every amount is integer MICRO-USD, and every division rounds UP.

const {
  compareCanonicalText,
  deepFreeze,
  hashCanonical
} = require('./declared-work-contract');
const {
  computeActualCost,
  findPricingEntry,
  normalizePricingCatalog
} = require('./model-pricing-catalog');
const {
  normalizeEconomicAuthority
} = require('./economic-authority-contract');
const {
  normalizeGovernedProviderRequest
} = require('./governed-provider-request-contract');
const { BOUND_METHODS } = require('./provider-adapter-capability');

const SETTLEMENT_RECEIPT_VERSION = 1;

const HASH_PATTERN = /^[0-9a-f]{64}$/;

// Closed usage vocabulary. There is no third option, and in particular there is
// no "unknown" that settles to zero.
const USAGE_SOURCES = Object.freeze([
  // The provider reported metered counts, which are bounded-checked below.
  'provider_reported',
  // No trustworthy counts exist; the whole authorized maximum is charged.
  'authorized_maximum_assumed'
]);

const SETTLEMENT_REFUSALS = Object.freeze([
  'settlement_receipt_malformed',
  'settlement_subject_mismatch',
  'settlement_request_mismatch',
  'settlement_authority_mismatch',
  'settlement_usage_unproven',
  'usage_exceeds_authorized_output',
  'usage_exceeds_bound_input',
  'settlement_exceeds_reservation',
  'settlement_amount_mismatch',
  'settlement_arithmetic_overflow'
]);

const SETTLEMENT_RECEIPT_FIELDS = Object.freeze([
  'version',
  // Subject — which ticket, role and unit of work this settles.
  'ticketId',
  'role',
  'subjectKind',
  'planningAttemptId',
  'runId',
  'modelRequestOrdinal',
  // Authority chain, transcribed from the normalized upstream documents.
  'routingDecisionHash',
  'economicAuthorityHash',
  'targetEvidenceHash',
  'adapterId',
  'provider',
  'dispatchTarget',
  'adapterCapabilityHash',
  'modelCapabilityHash',
  'pricingCatalogId',
  'pricingCatalogHash',
  'pricingEntryIdentity',
  'pricingEntryHash',
  // The exact bytes that were dispatched.
  'requestHash',
  'preparedRequestHash',
  'serializedByteCount',
  // The exact response that was persisted.
  'responseIdentity',
  'responseHash',
  // What was consumed, and on whose word.
  'usageSource',
  'inputTokens',
  'outputTokens',
  'requestCount',
  // The ceilings the usage was checked against.
  'boundMethod',
  'authorizedOutputTokens',
  'contextWindowTokens',
  // Money.
  'reservedMaximumMicroUsd',
  'settledMicroUsd',
  'unusedReservationMicroUsd',
  'settledAt',
  'receiptHash'
]);

// Fields the receipt DERIVES. A caller may present them, but they are always
// recomputed and compared, never adopted.
const DERIVED_RECEIPT_FIELDS = Object.freeze([
  'settledMicroUsd',
  'unusedReservationMicroUsd'
]);

class SettlementReceiptError extends Error {
  constructor(code, message, detail = {}) {
    super(message);
    this.name = 'SettlementReceiptError';
    this.code = code;
    this.detail = detail;
  }
}

function fail(message, code = 'SETTLEMENT_RECEIPT_INVALID', detail = {}) {
  throw new SettlementReceiptError(code, message, detail);
}

function refuse(reason, message = null) {
  if (!SETTLEMENT_REFUSALS.includes(reason)) {
    fail(`Unsupported settlement refusal reason: ${String(reason)}`);
  }
  fail(message || reason, 'SETTLEMENT_REFUSED', { reason });
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactFields(value, fields, label) {
  if (!isPlainObject(value)) {
    refuse('settlement_receipt_malformed', `${label} must be an object`);
  }
  const unknown = Object.keys(value).filter(field => !fields.includes(field));
  const missing = fields.filter(field => !Object.prototype.hasOwnProperty.call(value, field));
  if (unknown.length > 0) {
    refuse('settlement_receipt_malformed',
      `${label} contains unknown field(s): ${unknown.sort(compareCanonicalText).join(', ')}`);
  }
  if (missing.length > 0) {
    refuse('settlement_receipt_malformed',
      `${label} is missing field(s): ${missing.join(', ')}`);
  }
}

function requiredText(value, label, maximum = 512) {
  if (typeof value !== 'string') {
    refuse('settlement_receipt_malformed', `${label} must be a string`);
  }
  const text = value.trim();
  if (!text) refuse('settlement_receipt_malformed', `${label} must not be empty`);
  if (text.length > maximum) {
    refuse('settlement_receipt_malformed', `${label} exceeds ${maximum} characters`);
  }
  return text;
}

function hash(value, label) {
  if (typeof value !== 'string' || !HASH_PATTERN.test(value)) {
    refuse('settlement_receipt_malformed', `${label} must be a lowercase SHA-256`);
  }
  return value;
}

function nonNegativeInteger(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    refuse('settlement_receipt_malformed', `${label} must be a finite integer`);
  }
  if (!Number.isSafeInteger(value)) {
    refuse('settlement_arithmetic_overflow', `${label} is not a safe integer`);
  }
  if (value < 0) refuse('settlement_receipt_malformed', `${label} must not be negative`);
  return value;
}

function timestamp(value, label) {
  if (typeof value !== 'string') {
    refuse('settlement_receipt_malformed', `${label} must be an ISO timestamp`);
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime()) || date.toISOString() !== value) {
    refuse('settlement_receipt_malformed', `${label} must be a canonical ISO timestamp`);
  }
  return value;
}

function hashReceipt(fields) {
  const payload = {};
  for (const field of SETTLEMENT_RECEIPT_FIELDS) {
    if (field === 'receiptHash') continue;
    payload[field] = fields[field];
  }
  return hashCanonical(payload);
}

// ── Usage ───────────────────────────────────────────────────────────────────
//
// Normalizes the caller's usage claim into the closed vocabulary and proves it
// against the ceilings the authority already captured. A reported count that
// exceeds a ceiling is not clamped: clamping would silently accept a provider
// that ignored the transmitted cap, which is exactly the condition the cap
// exists to detect.

// The input ceiling is enforced from the CAPTURED bound method, never from a
// string literal spelled here: a literal that drifted from the vocabulary would
// silently disable this check. An unrecognized method refuses outright rather
// than falling through unchecked.
function assertBoundedInput(inputTokens, { boundMethod, contextWindowTokens }) {
  if (!BOUND_METHODS.includes(boundMethod)) {
    refuse('settlement_usage_unproven',
      `unrecognized bound method: ${String(boundMethod)}`);
  }
  // Whenever a finite window was captured, reported input above it means the
  // captured capability — and therefore the reservation built on it — was wrong.
  if (contextWindowTokens === null) return;
  const window = nonNegativeInteger(contextWindowTokens, 'contextWindowTokens');
  if (inputTokens > window) {
    refuse('usage_exceeds_bound_input',
      `reported input ${inputTokens} exceeds the bounded context window ${window}`);
  }
}

function normalizeUsage(usage, { authorizedOutputTokens, contextWindowTokens, boundMethod }) {
  if (!isPlainObject(usage)) {
    refuse('settlement_usage_unproven', 'usage must be an object');
  }
  const source = usage.source;
  if (!USAGE_SOURCES.includes(source)) {
    refuse('settlement_usage_unproven',
      `usage.source is not a recognized settlement usage source: ${String(source)}`);
  }

  if (source === 'authorized_maximum_assumed') {
    // No counts may accompany an assumed settlement: presenting numbers here
    // would imply the response was metered when it was not.
    if (usage.inputTokens !== null && usage.inputTokens !== undefined) {
      refuse('settlement_usage_unproven',
        'an assumed-maximum settlement must not carry an input token count');
    }
    if (usage.outputTokens !== null && usage.outputTokens !== undefined) {
      refuse('settlement_usage_unproven',
        'an assumed-maximum settlement must not carry an output token count');
    }
    return { source, inputTokens: null, outputTokens: null, requestCount: 1 };
  }

  const inputTokens = nonNegativeInteger(usage.inputTokens, 'usage.inputTokens');
  const outputTokens = nonNegativeInteger(usage.outputTokens, 'usage.outputTokens');
  const requestCount = usage.requestCount === undefined
    ? 1
    : nonNegativeInteger(usage.requestCount, 'usage.requestCount');
  if (requestCount !== 1) {
    // One receipt settles exactly one dispatched request. Multi-request
    // settlement would make the per-request output cap unprovable.
    refuse('settlement_usage_unproven', 'a receipt settles exactly one provider request');
  }

  if (outputTokens > authorizedOutputTokens) {
    refuse('usage_exceeds_authorized_output',
      `reported output ${outputTokens} exceeds the transmitted cap ${authorizedOutputTokens}`);
  }
  assertBoundedInput(inputTokens, { boundMethod, contextWindowTokens });

  return { source, inputTokens, outputTokens, requestCount };
}

// ── Build ───────────────────────────────────────────────────────────────────

// Settlement from the CAPTURED basis. Takes the exact pricing entry that was
// reserved against, not a catalog to look one up in — so no current, mutable,
// possibly-deleted configuration participates in pricing an old request.
function buildSettlementReceiptFromCapturedBasis({
  preparedRequest,
  authority,
  pricingEntry,
  reservedMaximumMicroUsd,
  responseIdentity,
  responseHash,
  usage,
  settledAt
}) {
  const request = normalizeGovernedProviderRequest(preparedRequest);
  const captured = normalizeEconomicAuthority(authority);
  const entry = normalizeCapturedPricingEntry(pricingEntry, captured);

  // The prepared request must be the one this authority authorized. Both
  // directions matter: a receipt bound to the wrong authority would settle real
  // money against ceilings that were never checked for these bytes.
  if (request.economicAuthorityHash !== captured.authorityHash) {
    refuse('settlement_authority_mismatch',
      'the prepared request was not prepared under this economic authority');
  }
  if (request.routingDecisionHash !== captured.routingDecisionHash) {
    refuse('settlement_authority_mismatch',
      'the prepared request and the authority cite different routing decisions');
  }
  if (request.ticketId !== captured.ticketId || request.role !== captured.role ||
      request.subjectKind !== captured.subjectKind ||
      request.planningAttemptId !== captured.planningAttemptId ||
      request.runId !== captured.runId) {
    refuse('settlement_subject_mismatch',
      'the prepared request and the authority describe different subjects');
  }

  const reserved = nonNegativeInteger(reservedMaximumMicroUsd, 'reservedMaximumMicroUsd');
  if (reserved > captured.maximumPerRequestMicroUsd) {
    refuse('settlement_exceeds_reservation',
      'the reservation exceeds the captured per-request maximum');
  }

  const normalizedUsage = normalizeUsage(usage, {
    authorizedOutputTokens: request.authorizedOutputTokens,
    contextWindowTokens: captured.contextWindowTokens,
    boundMethod: captured.boundMethod
  });

  // Recompute. The caller never supplies the amount.
  const settledMicroUsd = normalizedUsage.source === 'authorized_maximum_assumed'
    ? reserved
    : computeActualCost({
      entry,
      inputTokens: normalizedUsage.inputTokens,
      outputTokens: normalizedUsage.outputTokens,
      requestCount: normalizedUsage.requestCount
    });

  if (settledMicroUsd > reserved) {
    refuse('settlement_exceeds_reservation',
      `settled ${settledMicroUsd} exceeds reserved ${reserved} micro-USD`);
  }

  const fields = {
    version: SETTLEMENT_RECEIPT_VERSION,
    ticketId: captured.ticketId,
    role: captured.role,
    subjectKind: captured.subjectKind,
    planningAttemptId: captured.planningAttemptId,
    runId: captured.runId,
    modelRequestOrdinal: request.modelRequestOrdinal,
    routingDecisionHash: captured.routingDecisionHash,
    economicAuthorityHash: captured.authorityHash,
    targetEvidenceHash: captured.targetEvidenceHash,
    adapterId: captured.adapterId,
    provider: captured.provider,
    dispatchTarget: captured.dispatchTarget,
    adapterCapabilityHash: captured.adapterCapabilityHash,
    modelCapabilityHash: captured.modelCapabilityHash,
    pricingCatalogId: captured.pricingCatalogId,
    pricingCatalogHash: captured.pricingCatalogHash,
    pricingEntryIdentity: captured.pricingEntryIdentity,
    pricingEntryHash: captured.pricingEntryHash,
    requestHash: request.requestHash,
    preparedRequestHash: request.preparedRequestHash,
    serializedByteCount: request.serializedByteCount,
    responseIdentity: requiredText(responseIdentity, 'responseIdentity'),
    responseHash: hash(responseHash, 'responseHash'),
    usageSource: normalizedUsage.source,
    inputTokens: normalizedUsage.inputTokens,
    outputTokens: normalizedUsage.outputTokens,
    requestCount: normalizedUsage.requestCount,
    boundMethod: captured.boundMethod,
    authorizedOutputTokens: request.authorizedOutputTokens,
    contextWindowTokens: captured.contextWindowTokens,
    reservedMaximumMicroUsd: reserved,
    settledMicroUsd,
    unusedReservationMicroUsd: reserved - settledMicroUsd,
    settledAt: timestamp(settledAt, 'settledAt'),
    receiptHash: null
  };
  fields.receiptHash = hashReceipt(fields);
  return deepFreeze(fields);
}

// Convenience form for callers that still hold the catalog the authority was
// captured under. It resolves the entry and then settles from that captured
// entry, so both paths price identically.
function buildSettlementReceipt({ pricingCatalog, authority, ...rest }) {
  const captured = normalizeEconomicAuthority(authority);
  const catalog = normalizePricingCatalog(pricingCatalog);
  if (catalog.catalogId !== captured.pricingCatalogId ||
      catalog.catalogHash !== captured.pricingCatalogHash) {
    refuse('settlement_authority_mismatch',
      'the supplied pricing catalog is not the one the authority captured');
  }
  const entry = findPricingEntry(catalog, {
    provider: captured.provider,
    model: captured.dispatchTarget,
    adapterId: captured.adapterId
  });
  return buildSettlementReceiptFromCapturedBasis({
    ...rest, authority, pricingEntry: entry
  });
}

// A captured entry is trusted ONLY after it hashes to the identity the
// authority recorded. Tampered stored pricing therefore refuses rather than
// silently settling at rates nobody authorized.
function normalizeCapturedPricingEntry(pricingEntry, capturedAuthority) {
  if (!isPlainObject(pricingEntry)) {
    refuse('settlement_authority_mismatch', 'the captured pricing entry must be an object');
  }
  if (hashCanonical(pricingEntry) !== capturedAuthority.pricingEntryHash) {
    refuse('settlement_authority_mismatch',
      'the captured pricing entry does not match the authority pricing entry hash');
  }
  return deepFreeze({ ...pricingEntry });
}

// ── Normalize ───────────────────────────────────────────────────────────────
//
// Re-derives every derived field from the receipt's own bindings and compares.
// A receipt whose settled amount was edited to a smaller number still hashes
// consistently if the hash was recomputed over the edit, so the amount is
// checked against the pricing entry independently of the hash.

function normalizeSettlementReceipt(value, { pricingCatalog = null, pricingEntry = null } = {}) {
  exactFields(value, SETTLEMENT_RECEIPT_FIELDS, 'settlementReceipt');
  if (value.version !== SETTLEMENT_RECEIPT_VERSION) {
    refuse('settlement_receipt_malformed',
      `unsupported settlement receipt version: ${String(value.version)}`);
  }

  const reserved = nonNegativeInteger(value.reservedMaximumMicroUsd, 'reservedMaximumMicroUsd');
  const settled = nonNegativeInteger(value.settledMicroUsd, 'settledMicroUsd');
  const unused = nonNegativeInteger(value.unusedReservationMicroUsd, 'unusedReservationMicroUsd');
  if (settled > reserved) {
    refuse('settlement_exceeds_reservation',
      `settled ${settled} exceeds reserved ${reserved} micro-USD`);
  }
  if (unused !== reserved - settled) {
    refuse('settlement_amount_mismatch',
      'the unused reservation does not equal reserved minus settled');
  }
  if (!USAGE_SOURCES.includes(value.usageSource)) {
    refuse('settlement_usage_unproven',
      `unrecognized usage source: ${String(value.usageSource)}`);
  }

  if (value.usageSource === 'authorized_maximum_assumed') {
    if (value.inputTokens !== null || value.outputTokens !== null) {
      refuse('settlement_usage_unproven',
        'an assumed-maximum receipt must not carry token counts');
    }
    if (settled !== reserved) {
      refuse('settlement_amount_mismatch',
        'an assumed-maximum receipt must settle the full reserved maximum');
    }
  } else {
    const outputTokens = nonNegativeInteger(value.outputTokens, 'outputTokens');
    const inputTokens = nonNegativeInteger(value.inputTokens, 'inputTokens');
    const authorizedOutput = nonNegativeInteger(
      value.authorizedOutputTokens, 'authorizedOutputTokens');
    if (outputTokens > authorizedOutput) {
      refuse('usage_exceeds_authorized_output',
        `output ${outputTokens} exceeds the transmitted cap ${authorizedOutput}`);
    }
    assertBoundedInput(inputTokens, {
      boundMethod: value.boundMethod,
      contextWindowTokens: value.contextWindowTokens
    });
    // With the catalog in hand the amount is verifiable outright, not merely
    // internally consistent.
    let entry = null;
    if (pricingEntry !== null) {
      // The captured historical entry: the only basis that stays valid after
      // the catalog it came from has changed or been deleted.
      if (!isPlainObject(pricingEntry) ||
          hashCanonical(pricingEntry) !== value.pricingEntryHash) {
        refuse('settlement_authority_mismatch',
          'the captured pricing entry does not match the receipt entry hash');
      }
      entry = pricingEntry;
    } else if (pricingCatalog !== null) {
      const catalog = normalizePricingCatalog(pricingCatalog);
      if (catalog.catalogHash !== value.pricingCatalogHash) {
        refuse('settlement_authority_mismatch',
          'the supplied pricing catalog is not the receipt catalog');
      }
      entry = findPricingEntry(catalog, {
        provider: value.provider,
        model: value.dispatchTarget,
        adapterId: value.adapterId
      });
      if (hashCanonical(entry) !== value.pricingEntryHash) {
        refuse('settlement_authority_mismatch',
          'the resolved pricing entry does not match the receipt entry hash');
      }
    }
    if (entry !== null) {
      const recomputed = computeActualCost({
        entry,
        inputTokens,
        outputTokens,
        requestCount: nonNegativeInteger(value.requestCount, 'requestCount')
      });
      if (recomputed !== settled) {
        refuse('settlement_amount_mismatch',
          `receipt settles ${settled} but the catalog prices this usage at ${recomputed}`);
      }
    }
  }

  for (const field of ['routingDecisionHash', 'economicAuthorityHash', 'targetEvidenceHash',
    'adapterCapabilityHash', 'pricingCatalogHash', 'pricingEntryHash',
    'requestHash', 'preparedRequestHash', 'responseHash']) {
    hash(value[field], field);
  }
  if (value.modelCapabilityHash !== null) hash(value.modelCapabilityHash, 'modelCapabilityHash');
  requiredText(value.responseIdentity, 'responseIdentity');
  timestamp(value.settledAt, 'settledAt');
  nonNegativeInteger(value.serializedByteCount, 'serializedByteCount');

  const expected = hashReceipt(value);
  if (value.receiptHash !== expected) {
    refuse('settlement_receipt_malformed', 'the receipt hash does not cover its own fields');
  }

  const normalized = {};
  for (const field of SETTLEMENT_RECEIPT_FIELDS) normalized[field] = value[field];
  return deepFreeze(normalized);
}

// Binds a receipt to the exact bytes that were dispatched. The store calls this
// before recording settlement so a receipt can never be filed against a
// different request than the one whose reservation is being closed.
function assertReceiptMatchesPreparedRequest(receipt, preparedRequest) {
  const request = normalizeGovernedProviderRequest(preparedRequest);
  if (receipt.requestHash !== request.requestHash ||
      receipt.preparedRequestHash !== request.preparedRequestHash) {
    refuse('settlement_request_mismatch',
      'the receipt does not settle the prepared request it was presented with');
  }
  if (receipt.economicAuthorityHash !== request.economicAuthorityHash) {
    refuse('settlement_authority_mismatch',
      'the receipt and the prepared request cite different economic authorities');
  }
  if (receipt.modelRequestOrdinal !== request.modelRequestOrdinal) {
    refuse('settlement_request_mismatch',
      'the receipt settles a different model request ordinal');
  }
  return receipt;
}

module.exports = {
  DERIVED_RECEIPT_FIELDS,
  SETTLEMENT_RECEIPT_FIELDS,
  SETTLEMENT_RECEIPT_VERSION,
  SETTLEMENT_REFUSALS,
  SettlementReceiptError,
  USAGE_SOURCES,
  assertReceiptMatchesPreparedRequest,
  buildSettlementReceipt,
  buildSettlementReceiptFromCapturedBasis,
  normalizeSettlementReceipt,
  refuseSettlement: refuse
};

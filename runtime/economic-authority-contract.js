'use strict';

// Tranche 4 — economic policy and immutable economic authority.
//
// AUTHORITY FLOWS ONE WAY:
//
//   routing decision  ──consumed by──▶  economic authority
//
// This module reads a COMPLETED routing decision and never influences one. It
// selects no provider, no model, no adapter and no route: by the time it runs,
// the route is already captured and immutable. It answers only:
//
//   How much may this role spend on this exact captured route, and what
//   per-request ceilings bound that spend?
//
// Two separate closed documents live here, with independent versions, field
// lists, normalization and hashes:
//
//   economicPolicy    — administrator authority: how much, how many, how big.
//   economicAuthority — the immutable per-subject capture that a reservation
//                       will later be checked against.
//
// Every amount is integer MICRO-USD. No floating-point currency appears
// anywhere, and every division rounds UP, so a captured maximum can never
// understate liability.
//
// Mutable facts — account balances, reservations, request lifecycle, usage,
// settlement, receipts, recovery state — are deliberately OUTSIDE the authority
// hash. The authority says what MAY be spent; the account says what HAS been.

const {
  compareCanonicalText,
  deepFreeze,
  hashCanonical
} = require('./declared-work-contract');
const {
  CANONICAL_ROLES,
  normalizeRoleRoutingDecision
} = require('./role-routing-contract');
const {
  computeMaximumLiability,
  findPricingEntry,
  normalizePricingCatalog
} = require('./model-pricing-catalog');
const {
  getAdapterCapability,
  modelCapabilityHash,
  resolveModelCapability
} = require('./provider-adapter-capability');

const ECONOMIC_POLICY_VERSION = 1;
const ECONOMIC_AUTHORITY_VERSION = 1;

const ECONOMIC_UNIT = 'micro_usd';
const MAX_MICRO_USD = Number.MAX_SAFE_INTEGER;

const SUBJECT_KINDS = Object.freeze(['planning_attempt', 'run']);

// Closed refusals. Each names one distinct failure so the layers stay
// distinguishable: a route that cannot be captured is a ROUTING refusal and
// never reaches this module at all.
const ECONOMIC_REFUSALS = Object.freeze([
  'economic_policy_malformed',
  'economic_policy_role_mismatch',
  'economic_subject_shape_invalid',
  'routing_decision_mismatch',
  'pricing_entry_missing',
  'pricing_catalog_mismatch',
  'model_capability_unknown',
  'provider_path_not_hard_boundable',
  'economic_authority_exceeded',
  'economic_arithmetic_overflow',
  'fallback_liability_not_authorized'
]);

const ECONOMIC_POLICY_FIELDS = Object.freeze([
  'version',
  'policyId',
  'role',
  'authorizedMicroUsd',
  'maximumProviderRequests',
  'maximumOutputTokensPerRequest',
  'pricingCatalogId',
  'pricingCatalogHash',
  'fallbackLiabilityAuthorized',
  'fallbackProviderRequests',
  'capturedAt',
  'policyHash'
]);

const ECONOMIC_AUTHORITY_FIELDS = Object.freeze([
  'version',
  'economicPolicyId',
  'economicPolicyHash',
  'ticketId',
  'role',
  'subjectKind',
  'planningAttemptId',
  'runId',
  'routingDecisionHash',
  'dispatchTarget',
  'targetEvidenceIdentity',
  'targetEvidenceHash',
  'adapterId',
  'adapterCapabilityHash',
  'provider',
  'modelCapabilityHash',
  'pricingCatalogId',
  'pricingCatalogHash',
  'pricingEntryIdentity',
  'pricingEntryHash',
  'boundMethod',
  'contextWindowTokens',
  'maximumOutputTokensPerRequest',
  'maximumProviderRequests',
  'maximumPerRequestMicroUsd',
  'maximumTotalMicroUsd',
  'fallbackMaximumMicroUsd',
  'capturedAt',
  'authorityHash'
]);

const HASH_PATTERN = /^[0-9a-f]{64}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

class EconomicAuthorityError extends TypeError {
  constructor(code, message, detail = {}) {
    super(message);
    this.name = 'EconomicAuthorityError';
    this.code = code;
    this.reason = detail.reason || null;
  }
}

function fail(message, code = 'ECONOMIC_AUTHORITY_INVALID', detail = {}) {
  throw new EconomicAuthorityError(code, message, detail);
}

function refuse(reason, message = null) {
  if (!ECONOMIC_REFUSALS.includes(reason)) {
    fail(`Unsupported economic refusal reason: ${String(reason)}`);
  }
  fail(message || reason, 'ECONOMIC_AUTHORITY_REFUSED', { reason });
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

// Money and counts are safe non-negative integers, checked BEFORE any
// arithmetic so an unsafe value can never silently participate in a product.
function nonNegativeMicroUsd(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    fail(`${label} must be a finite integer count of micro-USD`);
  }
  if (!Number.isSafeInteger(value)) {
    refuse('economic_arithmetic_overflow', `${label} is not a safe integer`);
  }
  if (value < 0) fail(`${label} must not be negative`);
  return value;
}

function positiveSafeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    fail(`${label} must be a positive safe integer`);
  }
  return value;
}

function requiredText(value, label, maximum = 256) {
  if (typeof value !== 'string') fail(`${label} must be a string`);
  const text = value.trim();
  if (!text) fail(`${label} must not be empty`);
  if (text.length > maximum) fail(`${label} exceeds ${maximum} characters`);
  return text;
}

function hash(value, label) {
  if (typeof value !== 'string' || !HASH_PATTERN.test(value)) {
    fail(`${label} must be a lowercase SHA-256`);
  }
  return value;
}

function nullableHash(value, label) {
  return value === null ? null : hash(value, label);
}

function timestamp(value, label) {
  if (typeof value !== 'string') fail(`${label} must be an ISO timestamp`);
  const date = new Date(value);
  if (Number.isNaN(date.getTime()) || date.toISOString() !== value) {
    fail(`${label} must be a canonical ISO timestamp`);
  }
  return value;
}

function assertBoolean(value, label) {
  if (typeof value !== 'boolean') fail(`${label} must be a boolean`);
  return value;
}

function assertRole(value, label) {
  if (!CANONICAL_ROLES.includes(value)) {
    fail(`${label} is not a canonical execution role: ${String(value)}`);
  }
  return value;
}

function multiplyMicroUsd(amount, factor, label) {
  const left = nonNegativeMicroUsd(amount, `${label}.amount`);
  const right = nonNegativeMicroUsd(factor, `${label}.factor`);
  if (left === 0 || right === 0) return 0;
  if (left > Math.floor(MAX_MICRO_USD / right)) {
    refuse('economic_arithmetic_overflow', `${label} exceeds the representable micro-USD range`);
  }
  return left * right;
}

// ── Economic policy ─────────────────────────────────────────────────────────
//
// It answers HOW MUCH and HOW MANY. It deliberately contains no provider,
// model, adapter, acting agent, route precedence, availability, credential,
// balance, reservation or usage: the captured routing decision already owns the
// route, and the account already owns the balance.

function buildEconomicPolicy({
  policyId,
  role,
  authorizedMicroUsd,
  maximumProviderRequests,
  maximumOutputTokensPerRequest,
  pricingCatalogId,
  pricingCatalogHash,
  fallbackLiabilityAuthorized,
  fallbackProviderRequests,
  capturedAt
}) {
  const authorized = nonNegativeMicroUsd(authorizedMicroUsd, 'economicPolicy.authorizedMicroUsd');
  const requests = positiveSafeInteger(
    maximumProviderRequests,
    'economicPolicy.maximumProviderRequests'
  );
  const outputTokens = positiveSafeInteger(
    maximumOutputTokensPerRequest,
    'economicPolicy.maximumOutputTokensPerRequest'
  );
  const fallbackAuthorized = assertBoolean(
    fallbackLiabilityAuthorized,
    'economicPolicy.fallbackLiabilityAuthorized'
  );
  const fallbackRequests = nonNegativeMicroUsd(
    fallbackProviderRequests,
    'economicPolicy.fallbackProviderRequests'
  );
  // Fallback liability may only exist when it is explicitly authorized. An
  // unauthorized non-zero allowance is a malformed policy, never a silent grant.
  if (!fallbackAuthorized && fallbackRequests !== 0) {
    refuse('fallback_liability_not_authorized',
      'economicPolicy declares fallback requests without authorizing fallback liability');
  }
  const withoutHash = {
    version: ECONOMIC_POLICY_VERSION,
    policyId: requiredText(policyId, 'economicPolicy.policyId', 128),
    role: assertRole(role, 'economicPolicy.role'),
    authorizedMicroUsd: authorized,
    maximumProviderRequests: requests,
    maximumOutputTokensPerRequest: outputTokens,
    pricingCatalogId: requiredText(pricingCatalogId, 'economicPolicy.pricingCatalogId', 128),
    pricingCatalogHash: hash(pricingCatalogHash, 'economicPolicy.pricingCatalogHash'),
    fallbackLiabilityAuthorized: fallbackAuthorized,
    fallbackProviderRequests: fallbackRequests,
    capturedAt: timestamp(capturedAt, 'economicPolicy.capturedAt')
  };
  return deepFreeze({ ...withoutHash, policyHash: hashCanonical(withoutHash) });
}

function normalizeEconomicPolicy(value) {
  exactFields(value, ECONOMIC_POLICY_FIELDS, 'economicPolicy');
  if (value.version !== ECONOMIC_POLICY_VERSION) {
    fail(`economicPolicy.version must be ${ECONOMIC_POLICY_VERSION}`);
  }
  const rebuilt = buildEconomicPolicy(value);
  if (hash(value.policyHash, 'economicPolicy.policyHash') !== rebuilt.policyHash) {
    refuse('economic_policy_malformed', 'economicPolicy.policyHash does not match its fields');
  }
  return rebuilt;
}

// ── Immutable economic authority ────────────────────────────────────────────

function pricingEntryIdentityOf(entry) {
  return `${entry.provider}/${entry.model}`;
}

function buildEconomicAuthority({
  policy,
  routingDecision,
  pricingCatalog,
  capturedAt
}) {
  const economicPolicy = Object.prototype.hasOwnProperty.call(policy, 'policyHash')
    ? normalizeEconomicPolicy(policy)
    : buildEconomicPolicy(policy);
  // The routing decision is CONSUMED, never influenced. It must already verify
  // on its own terms before a single economic value is computed.
  const decision = normalizeRoleRoutingDecision(routingDecision);
  const catalog = Object.prototype.hasOwnProperty.call(pricingCatalog, 'catalogHash')
    ? normalizePricingCatalog(pricingCatalog)
    : pricingCatalog;

  if (decision.role !== economicPolicy.role) {
    refuse('economic_policy_role_mismatch',
      `economic policy governs ${economicPolicy.role}, but the routing decision is ` +
      `${decision.role}`);
  }
  // The policy is priced against exactly the catalog it names.
  if (catalog.catalogId !== economicPolicy.pricingCatalogId ||
      catalog.catalogHash !== economicPolicy.pricingCatalogHash) {
    refuse('pricing_catalog_mismatch',
      `economic policy names catalog ${economicPolicy.pricingCatalogId}, not ${catalog.catalogId}`);
  }

  // Subject shape: exactly one of planning attempt or Run, matching the role.
  const subjectKind = decision.subjectKind;
  if (!SUBJECT_KINDS.includes(subjectKind)) {
    refuse('economic_subject_shape_invalid', `unsupported subject kind ${String(subjectKind)}`);
  }
  const expectedKind = economicPolicy.role === 'structured_planner' ? 'planning_attempt' : 'run';
  if (subjectKind !== expectedKind) {
    refuse('economic_subject_shape_invalid',
      `${economicPolicy.role} authority requires a ${expectedKind} subject, not ${subjectKind}`);
  }
  const planningAttemptId = subjectKind === 'planning_attempt'
    ? (UUID_PATTERN.test(String(decision.subjectId))
      ? String(decision.subjectId)
      : fail('economicAuthority.planningAttemptId must be a lowercase UUID'))
    : null;
  const runId = subjectKind === 'run'
    ? positiveSafeInteger(decision.subjectId, 'economicAuthority.runId')
    : null;

  // Pricing is looked up against the IMMUTABLE dispatch target, never the
  // policy route reference — the target is what will actually execute.
  const entry = findPricingEntry(catalog, {
    provider: decision.provider,
    model: decision.dispatchTarget
  });
  const adapterCapability = getAdapterCapability(decision.adapterId);
  const zeroPriced = entry.boundMethod === 'catalog_maximum_exactly_zero';
  // A zero-priced route needs no model capability: its maximum is exactly zero
  // for any token count. The immutable target proof is still mandatory, and was
  // already enforced when the routing decision was captured.
  const modelCapability = zeroPriced
    ? null
    : resolveModelCapability({ adapterId: decision.adapterId, model: decision.dispatchTarget });

  const liability = computeMaximumLiability({
    entry,
    maxOutputTokens: economicPolicy.maximumOutputTokensPerRequest,
    maxProviderRequests: economicPolicy.maximumProviderRequests,
    fallbackRequestsAuthorized: economicPolicy.fallbackProviderRequests
  });
  // Per-request liability, derived without re-running the full calculation, so
  // the two can never disagree.
  const maximumPerRequestMicroUsd = liability.chargeableRequests === 0
    ? 0
    : Math.trunc(liability.maximumMicroUsd / liability.chargeableRequests);
  const fallbackMaximumMicroUsd = multiplyMicroUsd(
    maximumPerRequestMicroUsd,
    economicPolicy.fallbackProviderRequests,
    'fallbackMaximumMicroUsd'
  );
  const maximumTotalMicroUsd = nonNegativeMicroUsd(
    liability.maximumMicroUsd,
    'economicAuthority.maximumTotalMicroUsd'
  );
  // The captured maximum may never exceed what the policy authorized.
  if (maximumTotalMicroUsd > economicPolicy.authorizedMicroUsd) {
    refuse('economic_authority_exceeded',
      `maximum liability ${maximumTotalMicroUsd} exceeds the authorized ` +
      `${economicPolicy.authorizedMicroUsd} micro-USD for ${economicPolicy.role}`);
  }

  const withoutHash = {
    version: ECONOMIC_AUTHORITY_VERSION,
    economicPolicyId: economicPolicy.policyId,
    economicPolicyHash: economicPolicy.policyHash,
    ticketId: positiveSafeInteger(decision.ticketId, 'economicAuthority.ticketId'),
    role: economicPolicy.role,
    subjectKind,
    planningAttemptId,
    runId,
    // The one-way link. Economics binds routing; routing binds nothing back.
    routingDecisionHash: decision.decisionHash,
    dispatchTarget: decision.dispatchTarget,
    targetEvidenceIdentity: decision.targetEvidenceIdentity,
    targetEvidenceHash: decision.targetEvidenceHash,
    adapterId: decision.adapterId,
    adapterCapabilityHash: hashCanonical(adapterCapability),
    provider: decision.provider,
    modelCapabilityHash: modelCapability === null
      ? null
      : modelCapabilityHash(modelCapability),
    pricingCatalogId: catalog.catalogId,
    pricingCatalogHash: catalog.catalogHash,
    pricingEntryIdentity: pricingEntryIdentityOf(entry),
    pricingEntryHash: hashCanonical(entry),
    boundMethod: entry.boundMethod,
    contextWindowTokens: liability.contextWindowTokens,
    maximumOutputTokensPerRequest: economicPolicy.maximumOutputTokensPerRequest,
    maximumProviderRequests: economicPolicy.maximumProviderRequests,
    maximumPerRequestMicroUsd,
    maximumTotalMicroUsd,
    fallbackMaximumMicroUsd,
    capturedAt: timestamp(capturedAt, 'economicAuthority.capturedAt')
  };
  return deepFreeze({ ...withoutHash, authorityHash: hashCanonical(withoutHash) });
}

function normalizeEconomicAuthority(value, {
  expectedTicketId = null,
  expectedRole = null,
  expectedRoutingDecisionHash = null,
  expectedPolicyHash = null
} = {}) {
  exactFields(value, ECONOMIC_AUTHORITY_FIELDS, 'economicAuthority');
  if (value.version !== ECONOMIC_AUTHORITY_VERSION) {
    fail(`economicAuthority.version must be ${ECONOMIC_AUTHORITY_VERSION}`);
  }
  const authorityHash = hash(value.authorityHash, 'economicAuthority.authorityHash');
  const withoutHash = Object.fromEntries(
    ECONOMIC_AUTHORITY_FIELDS.filter(field => field !== 'authorityHash')
      .map(field => [field, value[field]])
  );
  if (hashCanonical(withoutHash) !== authorityHash) {
    fail('economicAuthority.authorityHash does not match its captured facts',
      'ECONOMIC_AUTHORITY_CONFLICT');
  }
  assertRole(value.role, 'economicAuthority.role');
  if (!SUBJECT_KINDS.includes(value.subjectKind)) {
    refuse('economic_subject_shape_invalid', 'unsupported subject kind');
  }
  // Exactly one subject, and it must match the role.
  const hasAttempt = value.planningAttemptId !== null;
  const hasRun = value.runId !== null;
  if (hasAttempt === hasRun) {
    refuse('economic_subject_shape_invalid',
      'economicAuthority must name exactly one of planningAttemptId or runId');
  }
  if ((value.role === 'structured_planner') !== hasAttempt) {
    refuse('economic_subject_shape_invalid',
      `${value.role} authority has the wrong subject shape`);
  }
  nullableHash(value.modelCapabilityHash, 'economicAuthority.modelCapabilityHash');
  const expectations = [
    ['ticketId', expectedTicketId, 'does not identify its ticket'],
    ['role', expectedRole, 'does not identify its role'],
    ['routingDecisionHash', expectedRoutingDecisionHash, 'does not identify its routing decision'],
    ['economicPolicyHash', expectedPolicyHash, 'does not identify its economic policy']
  ];
  for (const [field, expected, message] of expectations) {
    if (expected === null) continue;
    if (value[field] !== expected) {
      refuse('routing_decision_mismatch', `economicAuthority.${field} ${message}`);
    }
  }
  return deepFreeze({ ...withoutHash, authorityHash });
}

// Bind a captured authority to the routing decision it claims. Used wherever a
// reservation is about to be checked, so a transplanted pair fails closed.
function assertAuthorityMatchesRoutingDecision(authority, routingDecision) {
  const captured = normalizeEconomicAuthority(authority);
  const decision = normalizeRoleRoutingDecision(routingDecision);
  if (captured.routingDecisionHash !== decision.decisionHash) {
    refuse('routing_decision_mismatch',
      'economic authority does not bind this routing decision');
  }
  for (const field of ['ticketId', 'role', 'provider', 'adapterId', 'targetEvidenceHash']) {
    if (captured[field] !== decision[field]) {
      refuse('routing_decision_mismatch',
        `economic authority ${field} disagrees with its routing decision`);
    }
  }
  if (captured.dispatchTarget !== decision.dispatchTarget) {
    refuse('routing_decision_mismatch',
      'economic authority does not describe the captured dispatch target');
  }
  return captured;
}

module.exports = {
  ECONOMIC_AUTHORITY_FIELDS,
  ECONOMIC_AUTHORITY_VERSION,
  ECONOMIC_POLICY_FIELDS,
  ECONOMIC_POLICY_VERSION,
  ECONOMIC_REFUSALS,
  ECONOMIC_UNIT,
  EconomicAuthorityError,
  SUBJECT_KINDS,
  assertAuthorityMatchesRoutingDecision,
  buildEconomicAuthority,
  buildEconomicPolicy,
  normalizeEconomicAuthority,
  normalizeEconomicPolicy,
  refuseEconomic: refuse
};
